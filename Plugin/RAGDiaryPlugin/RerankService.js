'use strict';

const axios = require('axios');

async function _rerankDocumentsWithJev(host, query, documents, originalK, rrfOptions = null, rankOptions = {}) {
    if (
        !host.jevClient
        || typeof host.jevClient.decide !== 'function'
        || host.jevClient.isConfigured?.() !== true
    ) {
        console.warn(
            '[RAGDiaryPlugin] Jev advanced rerank is enabled, but the shared JevClient is not configured. Keeping retrieval order.'
        );
        return documents.slice(0, originalK);
    }

    if (!Array.isArray(documents) || documents.length <= 1) {
        return (documents || []).slice(0, originalK);
    }

    const maxChoices = Math.max(
        2,
        Math.min(255, Number(host.rerankConfig.jevMaxChoices) || 255)
    );
    const maxDocumentChars = Math.max(
        200,
        Number(host.rerankConfig.jevMaxDocumentChars) || 6000
    );
    const eligibleDocuments = documents.slice(0, maxChoices);
    if (documents.length > eligibleDocuments.length) {
        console.warn(
            `[RAGDiaryPlugin] Jev rerank candidates truncated: ` +
            `${documents.length} -> ${eligibleDocuments.length} (Choice hard limit).`
        );
    }

    const criteria = {};
    const documentByChoice = new Map();
    eligibleDocuments.forEach((document, index) => {
        const choiceId = `doc_${String(index).padStart(3, '0')}`;
        const text = String(document?.text || '').trim();
        const boundedText = text.length > maxDocumentChars
            ? `${text.substring(0, maxDocumentChars)}…`
            : text;
        criteria[choiceId] = [
            `候选记忆 ${index + 1}`,
            document?.source ? `来源类型: ${document.source}` : null,
            document?.fullPath ? `路径: ${document.fullPath}` : null,
            `内容:\n${boundedText}`
        ].filter(Boolean).join('\n');
        documentByChoice.set(choiceId, document);
    });

    try {
        const response = await host.jevClient.decide(
            {
                task: 'rag_memory_rerank',
                query: String(query || ''),
                candidate_count: eligibleDocuments.length
            },
            {
                best_memory: {
                    type: 'choice',
                    instructions: rankOptions.jevPrompt || host.rerankConfig.jevPrompt,
                    criteria
                }
            }
        );
        const answer = response?.answers?.best_memory;
        const probabilities = answer?.probabilities;
        if (
            !answer
            || answer.type !== 'choice'
            || !probabilities
            || typeof probabilities !== 'object'
        ) {
            throw new Error('Jev choice response is missing probabilities.');
        }

        const rerankedDocuments = Array.from(documentByChoice.entries())
            .map(([choiceId, document], index) => ({
                ...document,
                rerank_score: Number(probabilities[choiceId]) || 0,
                jev_choice: choiceId,
                jev_selected: answer.choice === choiceId,
                jev_confidence: Number(answer.confidence) || 0,
                _jevStableIndex: index
            }))
            .sort((left, right) =>
                (right.rerank_score - left.rerank_score)
                || (Number(right.jev_selected) - Number(left.jev_selected))
                || (left._jevStableIndex - right._jevStableIndex)
            );

        rerankedDocuments.forEach((document, index) => {
            document.rerank_rank = index + 1;
            delete document._jevStableIndex;
        });

        if (rrfOptions) {
            const RRF_K = 60;
            const alpha = rrfOptions.alpha ?? 0.5;
            rerankedDocuments.forEach(document => {
                const retrievalRank = document.retrieval_rank
                    || rerankedDocuments.length;
                document.rrf_score =
                    alpha * (1 / (RRF_K + document.rerank_rank))
                    + (1 - alpha) * (1 / (RRF_K + retrievalRank));
            });
            rerankedDocuments.sort((left, right) =>
                right.rrf_score - left.rrf_score
            );
        }

        const finalDocuments = rerankedDocuments.slice(0, originalK);
        console.log(
            `[RAGDiaryPlugin] Jev${rrfOptions ? '+(RRF)' : ''} rerank completed: ` +
            `${eligibleDocuments.length} candidates -> ${finalDocuments.length}, ` +
            `selected=${answer.choice || 'unknown'}, ` +
            `confidence=${Number(answer.confidence || 0).toFixed(4)}.`
        );
        return finalDocuments;
    } catch (error) {
        console.error(
            '[RAGDiaryPlugin] Jev advanced rerank failed; keeping retrieval order:',
            error.message
        );
        return documents.slice(0, originalK);
    }
}

async function _rerankDocuments(host, query, documents, originalK, rrfOptions = null, rankOptions = {}) {
    if ((rankOptions.useJev ?? host.rerankConfig.useJev) === true) {
        return host._rerankDocumentsWithJev(
            query,
            documents,
            originalK,
            rrfOptions,
            rankOptions
        );
    }

    // JIT (Just-In-Time) check for configuration instead of relying on a startup flag
    if (!host.rerankConfig.url || !host.rerankConfig.apiKey || !host.rerankConfig.model) {
        console.warn('[RAGDiaryPlugin] Rerank called, but is not configured. Skipping.');
        return documents.slice(0, originalK);
    }

    // ✅ 新增：断路器模式防止循环调用
    const circuitBreakerKey = `rerank_${Date.now()}`;
    if (!host.rerankCircuitBreaker) {
        host.rerankCircuitBreaker = new Map();
    }

    // 检查是否在短时间内有太多失败
    const now = Date.now();
    const recentFailures = Array.from(host.rerankCircuitBreaker.entries())
        .filter(([key, timestamp]) => now - timestamp < 60000) // 1分钟内
        .length;

    if (recentFailures >= 5) {
        console.warn('[RAGDiaryPlugin] Rerank circuit breaker activated due to recent failures. Skipping rerank.');
        return documents.slice(0, originalK);
    }

    // ✅ 新增：查询截断机制防止"Query is too long"错误
    const maxQueryTokens = Math.floor(host.rerankConfig.maxTokens * 0.3); // 预留70%给文档
    let truncatedQuery = query;
    let queryTokens = host._estimateTokens(query);

    if (queryTokens > maxQueryTokens) {
        console.warn(`[RAGDiaryPlugin] Query too long (${queryTokens} tokens), truncating to ${maxQueryTokens} tokens`);
        // 简单截断：按字符比例截断
        const truncateRatio = maxQueryTokens / queryTokens;
        const targetLength = Math.floor(query.length * truncateRatio * 0.9); // 留10%安全边距
        truncatedQuery = query.substring(0, targetLength) + '...';
        queryTokens = host._estimateTokens(truncatedQuery);
        console.log(`[RAGDiaryPlugin] Query truncated to ${queryTokens} tokens`);
    }

    const rerankUrl = new URL('v1/rerank', host.rerankConfig.url).toString();
    const headers = {
        'Authorization': `Bearer ${host.rerankConfig.apiKey}`,
        'Content-Type': 'application/json',
    };
    const maxTokens = host.rerankConfig.maxTokens;
    const maxDocumentsPerRequest = Math.max(
        1,
        Math.min(25, parseInt(host.rerankConfig.maxDocumentsPerRequest, 10) || 25)
    );
    const maxConcurrentRequests = Math.max(
        1,
        Math.min(10, parseInt(host.rerankConfig.maxConcurrentRequests, 10) || 3)
    );

    // ✅ 双重批次限制：
    // 1. documents 数量不超过 25，保持服务商的小批量免费档；
    // 2. 同时遵守 Token 上限，避免超长文档导致请求失败。
    let batches = [];
    let currentBatch = [];
    let currentTokens = queryTokens;
    const minBatchSize = 1; // 确保每个批次至少有1个文档
    const maxBatchTokens = maxTokens - queryTokens - 1000; // 预留1000 tokens安全边距

    for (const doc of documents) {
        const docTokens = host._estimateTokens(doc.text);

        // 如果单个文档就超过限制，跳过该文档
        if (docTokens > maxBatchTokens) {
            console.warn(`[RAGDiaryPlugin] Document too large (${docTokens} tokens), skipping`);
            continue;
        }

        const exceedsDocumentLimit = currentBatch.length >= maxDocumentsPerRequest;
        const exceedsTokenLimit = currentTokens + docTokens > maxBatchTokens;
        if ((exceedsDocumentLimit || exceedsTokenLimit) && currentBatch.length >= minBatchSize) {
            // Current batch is full, push it and start a new one
            batches.push(currentBatch);
            currentBatch = [doc];
            currentTokens = queryTokens + docTokens;
        } else {
            // Add to current batch
            currentBatch.push(doc);
            currentTokens += docTokens;
        }
    }

    // Add the last batch if it's not empty
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    console.log(
        `[RAGDiaryPlugin] Rerank split into ${batches.length} free-tier batches ` +
        `(max ${maxDocumentsPerRequest} documents/request, token limit ${maxTokens}, ` +
        `concurrency ${Math.min(maxConcurrentRequests, batches.length)}).`
    );

    // 如果没有有效批次，直接返回原始文档
    if (batches.length === 0) {
        console.warn('[RAGDiaryPlugin] No valid batches for reranking, returning original documents');
        return documents.slice(0, originalK);
    }


    const batchResults = new Array(batches.length);
    let failedBatches = 0;
    let nextBatchIndex = 0;

    const rerankBatch = async (batch, batchIndex) => {
        const docTexts = batch.map(d => d.text);

        try {
            const body = {
                model: host.rerankConfig.model,
                query: truncatedQuery, // ✅ 使用截断后的查询
                documents: docTexts,
                top_n: docTexts.length // Rerank all documents within the batch
            };

            const response = await axios.post(rerankUrl, body, {
                headers,
                timeout: 30000, // 30秒超时
                maxRedirects: 0 // 禁用重定向防止循环
            });

            if (response.data && Array.isArray(response.data.results)) {
                return response.data.results
                    .map(result => {
                        const originalDoc = batch[result.index];
                        return originalDoc
                            ? { ...originalDoc, rerank_score: result.relevance_score }
                            : null;
                    })
                    .filter(Boolean);
            }

            failedBatches++;
            console.warn(`[RAGDiaryPlugin] Rerank for batch ${batchIndex + 1} returned invalid data. Appending original batch documents.`);
            return batch;
        } catch (error) {
            failedBatches++;
            console.error(`[RAGDiaryPlugin] Rerank API call failed for batch ${batchIndex + 1}. Appending original batch documents.`);

            // ✅ 详细错误分析和断路器触发
            if (error.response) {
                const status = error.response.status;
                const errorData = error.response.data;
                console.error(`[RAGDiaryPlugin] Rerank API Error - Status: ${status}, Data: ${JSON.stringify(errorData)}`);

                if (status === 400 && errorData?.error?.message?.includes('Query is too long')) {
                    console.error('[RAGDiaryPlugin] Query still too long after truncation, adding to circuit breaker');
                    host.rerankCircuitBreaker.set(`${circuitBreakerKey}_${batchIndex}`, now);
                } else if (status >= 500) {
                    host.rerankCircuitBreaker.set(`${circuitBreakerKey}_${batchIndex}`, now);
                }
            } else if (error.code === 'ECONNABORTED') {
                console.error('[RAGDiaryPlugin] Rerank API timeout');
                host.rerankCircuitBreaker.set(`${circuitBreakerKey}_${batchIndex}`, now);
            } else {
                console.error('[RAGDiaryPlugin] Rerank API Error - Message:', error.message);
                host.rerankCircuitBreaker.set(`${circuitBreakerKey}_${batchIndex}`, now);
            }

            return batch;
        }
    };

    // 有界 worker pool：并发发送小批量请求，避免无上限 Promise.all 压垮服务商。
    const workerCount = Math.min(maxConcurrentRequests, batches.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const batchIndex = nextBatchIndex++;
            if (batchIndex >= batches.length) return;
            batchResults[batchIndex] = await rerankBatch(batches[batchIndex], batchIndex);
        }
    });
    await Promise.all(workers);

    // 始终按原批次序合并，保证并发完成时序不会影响后续稳定排序。
    const allRerankedDocs = batchResults.flatMap(result => result || []);

    // ✅ 清理过期的断路器记录
    for (const [key, timestamp] of host.rerankCircuitBreaker.entries()) {
        if (now - timestamp > 300000) { // 5分钟后清理
            host.rerankCircuitBreaker.delete(key);
        }
    }

    // 🌟 Rerank+ (RRF Fusion) 或标准 Rerank 排序
    if (rrfOptions) {
        // --- Reciprocal Rank Fusion (RRF) ---
        // 核心思想：综合 TagMemo/向量检索的排位和 Reranker 精排的排位
        // 公式：RRF(d) = α * 1/(K + rerank_rank) + (1-α) * 1/(K + retrieval_rank)
        // K=60 是业界标准平滑常数，防止排位靠前的文档获得过大的分数优势
        const RRF_K = 60;
        const alpha = rrfOptions.alpha ?? 0.5;

        // Step 1: 按 rerank_score 降序排列，赋予 rerank_rank (1-based)
        allRerankedDocs.sort((a, b) => (b.rerank_score ?? -1) - (a.rerank_score ?? -1));
        allRerankedDocs.forEach((doc, idx) => { doc.rerank_rank = idx + 1; });

        // Step 2: 计算 RRF 融合分数
        allRerankedDocs.forEach(doc => {
            const retrievalRank = doc.retrieval_rank || allRerankedDocs.length; // 无排位则视为末尾
            const rerankRank = doc.rerank_rank;
            doc.rrf_score = alpha * (1 / (RRF_K + rerankRank))
                + (1 - alpha) * (1 / (RRF_K + retrievalRank));
        });

        // Step 3: 按 RRF 融合分数降序排列
        allRerankedDocs.sort((a, b) => b.rrf_score - a.rrf_score);

        const finalDocs = allRerankedDocs.slice(0, originalK);
        const successRate = ((batches.length - failedBatches) / batches.length * 100).toFixed(1);

        // 注意: RRF详细日志已精简
        console.log(`[RAGDiaryPlugin] Rerank+(RRF): ${finalDocs.length}篇 (α=${alpha}, 成功率${successRate}%)`);

        return finalDocs;
    } else {
        // --- 标准 Rerank 排序（原有逻辑，不变） ---
        allRerankedDocs.sort((a, b) => {
            const scoreA = b.rerank_score ?? b.score ?? -1;
            const scoreB = a.rerank_score ?? a.score ?? -1;
            return scoreA - scoreB;
        });

        const finalDocs = allRerankedDocs.slice(0, originalK);
        const successRate = ((batches.length - failedBatches) / batches.length * 100).toFixed(1);
        console.log(`[RAGDiaryPlugin] Rerank完成: ${finalDocs.length}篇文档 (成功率: ${successRate}%)`);
        return finalDocs;
    }
}

module.exports = { _rerankDocumentsWithJev, _rerankDocuments };
