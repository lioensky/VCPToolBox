'use strict';

const { chunkText, getTokenCount } = require('../../TextChunker.js');
const { projectContextEmbeddingInput } = require('../../modules/contextEmbeddingInput');
const { getEmbeddingsBatch } = require('../../EmbeddingUtils.js');
const VectorMathUtils = require('./VectorMathUtils.js');

async function getSingleEmbedding(host, text, options = {}) {
    if (options?.signal?.aborted) {
        const abortErr = new Error('Embedding request aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
    }
    if (!text) {
        console.error('[RAGDiaryPlugin] getSingleEmbedding was called with no text.');
        return null;
    }

    const apiKey = process.env.API_Key;
    const apiUrl = process.env.API_URL;

    if (!apiKey || !apiUrl) {
        console.error('[RAGDiaryPlugin] Embedding API credentials not configured (API_Key / API_URL).');
        return null;
    }

    try {
        const normalizedText = String(text).trim();
        const chunks = chunkText(normalizedText);
        if (chunks.length === 0) {
            console.error('[RAGDiaryPlugin] getSingleEmbedding: text became empty after chunking.');
            return null;
        }

        if (chunks.length > 1) {
            console.warn(
                `[RAGDiaryPlugin] getSingleEmbedding: input exceeds safe embedding window; ` +
                `split into ${chunks.length} chunks and will merge by token-weighted average.`
            );
        }

        // 🌟 统一调用 EmbeddingUtils：自动享受模型容灾链、并发批量、token 精确切分、429 退避。
        // 对超长用户/AI 上下文，先按 TextChunker 的 safeMaxTokens 切分，再对各 chunk 向量做 token 加权平均，
        // 避免单条 6800+ token 文本被 EmbeddingUtils 直接跳过导致 RAG 查询向量为 null。
        const results = await getEmbeddingsBatch(chunks, {
            apiUrl,
            apiKey,
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(typeof options?.onBatchComplete === 'function' ? { onBatchComplete: options.onBatchComplete } : {})
        });
        const weights = chunks.map(chunk => Math.max(
            1,
            typeof getTokenCount === 'function' ? getTokenCount(chunk) : host._estimateTokens(chunk)
        ));
        const vector = host._getWeightedAverageVector(results, weights);

        if (!vector) {
            console.error('[RAGDiaryPlugin] getSingleEmbedding: EmbeddingUtils returned no usable vectors for the input text/chunks.');
        }
        return vector || null;
    } catch (error) {
        if (error?.name === 'AbortError' || options?.signal?.aborted) {
            const abortErr = error instanceof Error ? error : new Error('Embedding request aborted');
            abortErr.name = 'AbortError';
            throw abortErr;
        }
        console.error('[RAGDiaryPlugin] getSingleEmbedding failed via EmbeddingUtils:', error.message);
        return null;
    }
}

async function getBatchEmbeddings(host, texts, options = {}) {
    if (options?.signal?.aborted) {
        const abortErr = new Error('Batch embedding request aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
    }
    if (!texts || !Array.isArray(texts) || texts.length === 0) return [];

    const apiKey = process.env.API_Key;
    const apiUrl = process.env.API_URL;

    if (!apiKey || !apiUrl) {
        console.error('[RAGDiaryPlugin] Embedding API credentials not configured (API_Key / API_URL).');
        return new Array(texts.length).fill(null);
    }

    try {
        // 🌟 统一调用 EmbeddingUtils：自动享受模型容灾链、并发批量、token 精确切分、429 退避
        return await getEmbeddingsBatch(texts, {
            apiUrl,
            apiKey,
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(typeof options?.onBatchComplete === 'function' ? { onBatchComplete: options.onBatchComplete } : {})
        });
    } catch (error) {
        if (error?.name === 'AbortError' || options?.signal?.aborted) {
            const abortErr = error instanceof Error ? error : new Error('Batch embedding request aborted');
            abortErr.name = 'AbortError';
            throw abortErr;
        }
        console.error('[RAGDiaryPlugin] getBatchEmbeddings failed via EmbeddingUtils:', error.message);
        return new Array(texts.length).fill(null);
    }
}

async function getBatchEmbeddingsCached(host, texts, options = {}) {
    if (options?.signal?.aborted) {
        const abortErr = new Error('Batch embedding request aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
    }
    if (!texts || !Array.isArray(texts) || texts.length === 0) return [];

    const results = new Array(texts.length).fill(null);
    const missingIndices = [];
    const missingTexts = [];

    texts.forEach((text, index) => {
        if (!text || !text.trim()) return;
        const normalized = text.trim();
        const cacheKey = host.cacheManager.generateKey({ text: normalized });
        const vector = host.cacheManager.get('embedding', cacheKey);
        if (vector) {
            host._rememberEmbeddingText(cacheKey, normalized);
            results[index] = vector;
        } else {
            missingIndices.push(index);
            missingTexts.push(text);
        }
    });

    if (missingTexts.length > 0) {
        console.log(`[RAGDiaryPlugin] Batch cache miss: ${missingTexts.length}/${texts.length} texts. Requesting API...`);
        const persistCompletedItem = (text, vec) => {
            if (!vec || !text || !text.trim()) return;
            const normalized = text.trim();
            const cacheKey = host.cacheManager.generateKey({ text: normalized });
            host.cacheManager.set('embedding', cacheKey, vec);
            host._rememberEmbeddingText(cacheKey, normalized);
        };
        const newEmbeddings = await host.getBatchEmbeddings(missingTexts, {
            ...(options?.signal ? { signal: options.signal } : {}),
            onBatchComplete: ({ texts: batchTexts, vectors: batchVectors }) => {
                if (!Array.isArray(batchTexts) || !Array.isArray(batchVectors)) return;
                batchVectors.forEach((vec, idx) => persistCompletedItem(batchTexts[idx], vec));
            }
        });
        newEmbeddings.forEach((vec, i) => {
            if (vec) {
                const originalIndex = missingIndices[i];
                results[originalIndex] = vec;
                persistCompletedItem(missingTexts[i], vec);
            }
        });
    }

    return results;
}

async function getSingleEmbeddingCached(host, text, options = {}) {
    const signal = options?.signal || null;
    if (signal?.aborted) {
        const abortErr = new Error('Embedding request aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
    }
    if (!text || !text.trim()) return null;

    const awaitWithSignal = (promise) => {
        if (!signal) return promise;
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                promise.catch(() => {});
                const abortErr = new Error('Embedding request aborted');
                abortErr.name = 'AbortError';
                reject(abortErr);
                return;
            }
            const onAbort = () => {
                promise.catch(() => {});
                const abortErr = new Error('Embedding request aborted');
                abortErr.name = 'AbortError';
                reject(abortErr);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            promise.then(
                value => {
                    signal.removeEventListener('abort', onAbort);
                    resolve(value);
                },
                err => {
                    signal.removeEventListener('abort', onAbort);
                    reject(err);
                }
            );
        });
    };

    const normalizedText = projectContextEmbeddingInput(text, options?.contextRole);
    if (!normalizedText) return null;
    const cacheKey = host.cacheManager.generateKey({ text: normalizedText });
    const cached = host.cacheManager.get('embedding', cacheKey);
    if (cached) {
        host._rememberEmbeddingText(cacheKey, normalizedText);
        return cached;
    }

    if (host.pendingEmbeddingRequests.has(cacheKey)) {
        return await awaitWithSignal(host.pendingEmbeddingRequests.get(cacheKey));
    }

    // 🌟 最小修复：精确缓存未命中时，在 API 前尝试高阈值 fuzzy 复用。
    // 目的：兼容 superDetectors / 占位符处理导致的极小文本差异（如 “……” -> “…”），
    // 避免 RAG 主链路与 DynamicFold 对同一段 AI 发言重复向量化。
    const fuzzyMatch = host._findFuzzyEmbeddingFromCache(normalizedText);
    if (fuzzyMatch && fuzzyMatch.vector) {
        host.cacheManager.set('embedding', cacheKey, fuzzyMatch.vector);
        host._rememberEmbeddingText(cacheKey, normalizedText);
        console.log(
            `[RAGDiaryPlugin] Fuzzy embedding cache hit: ` +
            `sim=${fuzzyMatch.similarity.toFixed(4)}, len=${normalizedText.length}/${fuzzyMatch.length}`
        );
        return fuzzyMatch.vector;
    }

    // 共享单飞请求不绑定单个调用方的取消信号：调用侧通过 awaitWithSignal 0ms 脱钩，
    // 在途向量请求继续静默收割入库供重发/模糊匹配复用，同时避免误杀搭便车的并发请求。
    const requestPromise = (async () => {
        try {
            const vector = await host.getSingleEmbedding(normalizedText);
            if (vector) {
                host.cacheManager.set('embedding', cacheKey, vector);
                host._rememberEmbeddingText(cacheKey, normalizedText);
            }
            return vector;
        } finally {
            host.pendingEmbeddingRequests.delete(cacheKey);
        }
    })();

    host.pendingEmbeddingRequests.set(cacheKey, requestPromise);
    return await awaitWithSignal(requestPromise);
}

function _rememberEmbeddingText(host, cacheKey, normalizedText) {
    if (!cacheKey || !normalizedText) return;
    if (host.embeddingTextIndex.has(cacheKey)) {
        host.embeddingTextIndex.delete(cacheKey);
    }
    host.embeddingTextIndex.set(cacheKey, normalizedText);

    while (host.embeddingTextIndex.size > host.embeddingTextIndexMaxSize) {
        const oldestKey = host.embeddingTextIndex.keys().next().value;
        host.embeddingTextIndex.delete(oldestKey);
    }
}

function _textDiceSimilarity(host, textA, textB) {
    return VectorMathUtils.textDiceSimilarity(textA, textB);
}

function _getFuzzyEmbeddingOptions(host, options = {}) {
    const hotConfig = host.ragParams?.ContextFoldingV2?.fuzzyEmbedding || {};
    const defaults = {
        threshold: 0.985,
        minLength: 80,
        maxScan: 200,
        maxLengthDiffRatio: 0.02,
        maxLengthDiffAbs: 80
    };

    const readNumber = (key) => {
        const optionValue = options[key];
        if (Number.isFinite(Number(optionValue))) return Number(optionValue);
        const hotValue = hotConfig[key];
        if (Number.isFinite(Number(hotValue))) return Number(hotValue);
        return defaults[key];
    };

    return {
        threshold: readNumber('threshold'),
        minLength: readNumber('minLength'),
        maxScan: readNumber('maxScan'),
        maxLengthDiffRatio: readNumber('maxLengthDiffRatio'),
        maxLengthDiffAbs: readNumber('maxLengthDiffAbs')
    };
}

function _findFuzzyEmbeddingFromCache(host, text, options = {}) {
    if (!text || typeof text !== 'string') return null;

    const normalizedText = text.trim();
    const fuzzyOptions = host._getFuzzyEmbeddingOptions(options);
    const threshold = fuzzyOptions.threshold;
    const minLength = fuzzyOptions.minLength;
    const maxScan = fuzzyOptions.maxScan;
    const maxLengthDiffRatio = fuzzyOptions.maxLengthDiffRatio;
    const maxLengthDiffAbs = fuzzyOptions.maxLengthDiffAbs;

    if (normalizedText.length < minLength || host.embeddingTextIndex.size === 0) {
        return null;
    }

    const entries = Array.from(host.embeddingTextIndex.entries()).slice(-maxScan);
    let best = null;

    for (const [cacheKey, cachedText] of entries) {
        if (!cachedText || cachedText.length < minLength) continue;

        const lengthDiff = Math.abs(normalizedText.length - cachedText.length);
        const allowedLengthDiff = Math.max(maxLengthDiffAbs, normalizedText.length * maxLengthDiffRatio);
        if (lengthDiff > allowedLengthDiff) continue;

        const similarity = host._textDiceSimilarity(normalizedText, cachedText);
        if (similarity < threshold) continue;

        const vector = host.cacheManager.get('embedding', cacheKey);
        if (!vector) continue;

        if (!best || similarity > best.similarity) {
            best = {
                cacheKey,
                vector,
                textPreview: cachedText.substring(0, 80),
                similarity,
                length: cachedText.length
            };
        }
    }

    return best;
}

function _getEmbeddingFromCacheOnly(host, text, contextRole) {
    const normalizedText = projectContextEmbeddingInput(text, contextRole);
    if (!normalizedText) return null;
    const cacheKey = host.cacheManager.generateKey({ text: normalizedText });
    const vector = host.cacheManager.get('embedding', cacheKey);
    if (vector) {
        host._rememberEmbeddingText(cacheKey, normalizedText);
    }
    return vector;
}

module.exports = { getSingleEmbedding, getBatchEmbeddings, getBatchEmbeddingsCached, getSingleEmbeddingCached, _rememberEmbeddingText, _textDiceSimilarity, _getFuzzyEmbeddingOptions, _findFuzzyEmbeddingFromCache, _getEmbeddingFromCacheOnly };
