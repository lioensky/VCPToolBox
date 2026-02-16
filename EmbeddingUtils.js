// EmbeddingUtils.js
const { get_encoding } = require("@dqbd/tiktoken");
const encoding = get_encoding("cl100k_base");

// 配置
const embeddingMaxToken = parseInt(process.env.WhitelistEmbeddingModelMaxToken, 10) || 8000;
const safeMaxTokens = Math.floor(embeddingMaxToken * 0.85);
const MAX_BATCH_ITEMS = 100; // Gemini/OpenAI 限制
const DEFAULT_CONCURRENCY = parseInt(process.env.TAG_VECTORIZE_CONCURRENCY) || 5; // 🌟 读取并发配置

/**
 * 内部函数：发送单个批次
 */
async function _sendBatch(batchTexts, config, batchNumber) {
    const { default: fetch } = await import('node-fetch');
    const retryAttempts = 3;
    const baseDelay = 1000;

    for (let attempt = 1; attempt <= retryAttempts; attempt++) {
        try {
            // 检测是否为字节跳动 Ark 平台
            const isArkPlatform = config.apiUrl.toLowerCase().includes('volces') && config.apiUrl.toLowerCase().includes('ark');

            let requestUrl;
            let requestBody;

            if (isArkPlatform) {
                // 字节跳动 Ark 格式
                requestUrl = `${config.apiUrl}/embeddings/multimodal`;
                requestBody = {
                    model: config.model,
                    input: batchTexts.map(text => ({
                        type: "text",
                        text: text
                    })),
                    dimensions: 2048, // 嵌入模型的维度
                    multi_embedding: {
                        type: "enabled"
                    },
                    sparse_embedding: {
                        type: "enabled"
                    },
                    encoding_format: "float"
                };
            } else {
                // 标准 OpenAI 格式
                requestUrl = `${config.apiUrl}/v1/embeddings`;
                requestBody = { model: config.model, input: batchTexts };
            }

            const requestHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` };

            const response = await fetch(requestUrl, {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify(requestBody)
            });

            const responseBodyText = await response.text();

            if (!response.ok) {
                if (response.status === 429) {
                    // 429 限流时，增加等待时间
                    const waitTime = 5000 * attempt;
                    console.warn(`[Embedding] Batch ${batchNumber} rate limited (429). Retrying in ${waitTime / 1000}s...`);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }
                throw new Error(`API Error ${response.status}: ${responseBodyText.substring(0, 500)}`);
            }

            let data;
            try {
                data = JSON.parse(responseBodyText);
            } catch (parseError) {
                console.error(`[Embedding] JSON Parse Error for Batch ${batchNumber}:`);
                console.error(`Response (first 500 chars): ${responseBodyText.substring(0, 500)}`);
                throw new Error(`Failed to parse API response as JSON: ${parseError.message}`);
            }

            // 增强的响应结构验证和详细错误信息
            if (!data) {
                throw new Error(`API returned empty/null response`);
            }

            // 检查是否是错误响应
            if (data.error) {
                const errorMsg = data.error.message || JSON.stringify(data.error);
                const errorCode = data.error.code || response.status;
                console.error(`[Embedding] API Error for Batch ${batchNumber}:`);
                console.error(`  Error Code: ${errorCode}`);
                console.error(`  Error Message: ${errorMsg}`);
                console.error(`  Hint: Check if embedding model "${config.model}" is available on your API server`);
                throw new Error(`API Error ${errorCode}: ${errorMsg}`);
            }

            if (!data.data) {
                console.error(`[Embedding] Missing 'data' field in response for Batch ${batchNumber}`);
                console.error(`Response keys: ${Object.keys(data).join(', ')}`);
                console.error(`Response preview: ${JSON.stringify(data).substring(0, 500)}`);
                throw new Error(`Invalid API response structure: missing 'data' field`);
            }

            // 处理不同 API 响应格式
            let embeddingsData;
            if (Array.isArray(data.data)) {
                // 标准格式：data.data 是数组
                embeddingsData = data.data;
                if (embeddingsData.length === 0) {
                    console.warn(`[Embedding] Warning: Batch ${batchNumber} returned empty embeddings array`);
                }
            } else if (data.data && data.data.embedding) {
                // 字节跳动 Ark 格式：data.data 是对象，直接包含 embedding 字段
                embeddingsData = [data.data];
            } else {
                console.error(`[Embedding] Invalid 'data' field structure for Batch ${batchNumber}`);
                console.error(`data type: ${typeof data.data}`);
                console.error(`data value: ${JSON.stringify(data.data).substring(0, 200)}`);
                throw new Error(`Invalid API response structure: 'data' field has unexpected format`);
            }

            // 简单的 Log，证明并发正在跑
            // console.log(`[Embedding] ✅ Batch ${batchNumber} completed (${batchTexts.length} items).`);

            return embeddingsData.map(item => item.embedding);

        } catch (e) {
            console.warn(`[Embedding] Batch ${batchNumber}, Attempt ${attempt} failed: ${e.message}`);
            if (attempt === retryAttempts) throw e;
            await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
        }
    }
}

/**
 * 🚀 终极版：并发批量获取 Embeddings
 */
async function getEmbeddingsBatch(texts, config) {
    if (!texts || texts.length === 0) return [];

    // 1. ⚡️ 第一步：纯 CPU 操作，先把所有文本切分成 Batches
    const batches = [];
    let currentBatch = [];
    let currentBatchTokens = 0;

    for (const text of texts) {
        const textTokens = encoding.encode(text).length;
        if (textTokens > safeMaxTokens) continue; // Skip oversize

        const isTokenFull = currentBatch.length > 0 && (currentBatchTokens + textTokens > safeMaxTokens);
        const isItemFull = currentBatch.length >= MAX_BATCH_ITEMS;

        if (isTokenFull || isItemFull) {
            batches.push(currentBatch);
            currentBatch = [text];
            currentBatchTokens = textTokens;
        } else {
            currentBatch.push(text);
            currentBatchTokens += textTokens;
        }
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    console.log(`[Embedding] Prepared ${batches.length} batches. Executing with concurrency: ${DEFAULT_CONCURRENCY}...`);

    // 2. 🌊 第二步：并发执行器
    const results = new Array(batches.length); // 预分配结果数组，保证顺序
    let cursor = 0; // 当前处理到的批次索引

    // 定义 Worker：只要队列里还有任务，就不断抢任务做
    const worker = async (workerId) => {
        while (true) {
            // 🔒 获取任务索引 (原子操作模拟)
            const batchIndex = cursor++;
            if (batchIndex >= batches.length) break; // 没任务了，下班

            const batchTexts = batches[batchIndex];
            // 执行请求 (Batch ID 从 1 开始显示)
            results[batchIndex] = await _sendBatch(batchTexts, config, batchIndex + 1);
        }
    };

    // 启动 N 个 Worker
    const workers = [];
    for (let i = 0; i < DEFAULT_CONCURRENCY; i++) {
        workers.push(worker(i));
    }

    // 等待所有 Worker 下班
    await Promise.all(workers);

    // 3. 📦 第三步：展平结果
    // results 数组里可能包含 undefined (如果某个 batch 最终失败)，filter 掉保平安
    return results.filter(r => r).flat();
}

module.exports = { getEmbeddingsBatch };