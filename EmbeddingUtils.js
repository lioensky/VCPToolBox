const fs = require("fs");
const path = require("path");
const { get_encoding } = require("@dqbd/tiktoken");

const encoding = get_encoding("cl100k_base");

const embeddingMaxToken = parseInt(process.env.WhitelistEmbeddingModelMaxToken, 10) || 8000;
const safeMaxTokens = Math.floor(embeddingMaxToken * 0.85);
const MAX_BATCH_ITEMS = 100;
const DEFAULT_CONCURRENCY = Math.max(1, parseInt(process.env.TAG_VECTORIZE_CONCURRENCY, 10) || 5);
const REQUEST_TIMEOUT_MS = Math.max(1000, parseInt(process.env.EMBEDDING_REQUEST_TIMEOUT_MS, 10) || 30000);
const FALLBACK_STATS_PATH = path.join(__dirname, "state", "embedding-fallback-stats.json");

const fallbackStats = {
    totalFallbackHits: 0,
    recentFallbackHitCount: 0,
    lastFallbackAt: null,
    lastPrimaryError: null,
    lastFallbackBackend: null,
    lastFallbackModel: null,
};

function hydrateFallbackStatsFromDisk() {
    try {
        if (!fs.existsSync(FALLBACK_STATS_PATH)) return;
        const raw = fs.readFileSync(FALLBACK_STATS_PATH, "utf8");
        if (!raw.trim()) return;
        const parsed = JSON.parse(raw);
        Object.assign(fallbackStats, {
            totalFallbackHits: parsed.totalFallbackHits || 0,
            recentFallbackHitCount: parsed.recentFallbackHitCount || 0,
            lastFallbackAt: parsed.lastFallbackAt || null,
            lastPrimaryError: parsed.lastPrimaryError || null,
            lastFallbackBackend: parsed.lastFallbackBackend === "fallback" ? "fallback" : null,
            lastFallbackModel: parsed.lastFallbackModel || null,
        });
    } catch (error) {
        console.warn(`[Embedding] Failed to hydrate fallback stats: ${error.message}`);
    }
}

function persistFallbackStats() {
    try {
        fs.mkdirSync(path.dirname(FALLBACK_STATS_PATH), { recursive: true });
        fs.writeFileSync(FALLBACK_STATS_PATH, JSON.stringify(fallbackStats, null, 2));
    } catch (error) {
        console.warn(`[Embedding] Failed to persist fallback stats: ${error.message}`);
    }
}

function recordFallbackHit(backend, primaryError) {
    fallbackStats.totalFallbackHits += 1;
    fallbackStats.recentFallbackHitCount += 1;
    fallbackStats.lastFallbackAt = new Date().toISOString();
    fallbackStats.lastPrimaryError = primaryError ? primaryError.message : null;
    fallbackStats.lastFallbackBackend = backend?.name === "fallback" ? "fallback" : null;
    fallbackStats.lastFallbackModel = backend?.model || null;
    persistFallbackStats();
}

function getEmbeddingFallbackStats() {
    return {
        ...fallbackStats,
        statsFile: path.join("state", "embedding-fallback-stats.json"),
    };
}

hydrateFallbackStatsFromDisk();

function trimTrailingSlashes(url) {
    return typeof url === "string" ? url.replace(/\/+$/, "") : url;
}

function splitModelList(value) {
    return String(value || "")
        .split(/[,，]/)
        .map((model) => model.trim())
        .filter(Boolean);
}

function getEmbeddingModelCandidates(config = {}) {
    const candidates = [];
    const addModel = (model) => {
        const normalized = String(model || "").trim();
        if (normalized && !candidates.includes(normalized)) {
            candidates.push(normalized);
        }
    };

    addModel(config.model);

    if (Array.isArray(config.modelBackups)) {
        config.modelBackups.forEach(addModel);
    } else if (config.modelBackups) {
        splitModelList(config.modelBackups).forEach(addModel);
    }

    splitModelList(process.env.EmbeddingModelBackups).forEach(addModel);
    for (let i = 1; i <= 9; i += 1) {
        addModel(process.env[`EmbeddingModelBackup${i}`]);
    }
    splitModelList(process.env.EmbeddingModelBackup).forEach(addModel);

    return candidates.length > 0 ? candidates : ["google/gemini-embedding-001"];
}

function buildEmbeddingBackends(config) {
    const backends = [];
    const primaryUrl = trimTrailingSlashes(config.apiUrl);
    const primaryModelCandidates = getEmbeddingModelCandidates(config);

    if (primaryUrl) {
        backends.push({
            name: "primary",
            apiUrl: primaryUrl,
            apiKey: config.apiKey,
            model: primaryModelCandidates[0],
            modelCandidates: primaryModelCandidates,
        });
    }

    const fallbackUrl = trimTrailingSlashes(process.env.EMBEDDING_FALLBACK_API_URL);
    if (fallbackUrl) {
        const fallbackModel = process.env.EMBEDDING_FALLBACK_MODEL || config.model || primaryModelCandidates[0];
        const fallbackKey = process.env.EMBEDDING_FALLBACK_API_KEY || config.apiKey;
        const fallbackModelCandidates = splitModelList(process.env.EMBEDDING_FALLBACK_MODEL_BACKUPS);
        if (fallbackModel && !fallbackModelCandidates.includes(fallbackModel)) {
            fallbackModelCandidates.unshift(fallbackModel);
        }
        const duplicate = backends.some((item) => {
            const itemModels = item.modelCandidates || [item.model];
            return item.apiUrl === fallbackUrl && fallbackModelCandidates.some((model) => itemModels.includes(model));
        });
        if (!duplicate) {
            backends.push({
                name: "fallback",
                apiUrl: fallbackUrl,
                apiKey: fallbackKey,
                model: fallbackModelCandidates[0],
                modelCandidates: fallbackModelCandidates,
            });
        }
    }

    return backends;
}

function hasEmbeddingBackend(config) {
    return buildEmbeddingBackends(config).length > 0;
}

async function _sendBatch(batchTexts, config, batchNumber) {
    const { default: fetch } = await import("node-fetch");
    const modelCandidates = Array.isArray(config.modelCandidates) && config.modelCandidates.length > 0
        ? config.modelCandidates
        : getEmbeddingModelCandidates({ model: config.model, modelBackups: config.modelBackups });
    const retryAttempts = modelCandidates.length > 1 ? 1 : 3;
    const baseDelay = 1000;
    let lastError = null;

    for (let modelIndex = 0; modelIndex < modelCandidates.length; modelIndex += 1) {
        const model = modelCandidates[modelIndex];

        for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
            try {
                const requestUrl = `${config.apiUrl}/v1/embeddings`;
                const requestBody = { model, input: batchTexts };
                const requestHeaders = { "Content-Type": "application/json" };
                if (config.apiKey) {
                    requestHeaders.Authorization = `Bearer ${config.apiKey}`;
                }

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

                let response;
                try {
                    response = await fetch(requestUrl, {
                        method: "POST",
                        headers: requestHeaders,
                        body: JSON.stringify(requestBody),
                        signal: controller.signal,
                    });
                } finally {
                    clearTimeout(timeout);
                }

                const responseBodyText = await response.text();

                if (!response.ok) {
                    if (response.status === 429) {
                        const waitTime = Math.min(5000 * (modelIndex + 1), 15000);
                        lastError = new Error(`API Error 429: ${responseBodyText.substring(0, 500)}`);
                        console.warn(`[Embedding] Batch ${batchNumber} model "${model}" rate limited (429). Switching fallback in ${waitTime / 1000}s...`);
                        await new Promise((resolve) => setTimeout(resolve, waitTime));
                        break;
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

                if (!data) {
                    throw new Error("API returned empty/null response");
                }

                if (data.error) {
                    const errorMsg = data.error.message || JSON.stringify(data.error);
                    const errorCode = data.error.code || response.status;
                    console.error(`[Embedding] API Error for Batch ${batchNumber}:`);
                    console.error(`  Error Code: ${errorCode}`);
                    console.error(`  Error Message: ${errorMsg}`);
                    console.error(`  Hint: Check if embedding model "${model}" is available on your API server`);
                    throw new Error(`API Error ${errorCode}: ${errorMsg}`);
                }

                if (!data.data) {
                    console.error(`[Embedding] Missing 'data' field in response for Batch ${batchNumber}`);
                    console.error(`Response keys: ${Object.keys(data).join(", ")}`);
                    console.error(`Response preview: ${JSON.stringify(data).substring(0, 500)}`);
                    throw new Error("Invalid API response structure: missing 'data' field");
                }

                if (!Array.isArray(data.data)) {
                    console.error(`[Embedding] 'data' field is not an array for Batch ${batchNumber}`);
                    console.error(`data type: ${typeof data.data}`);
                    console.error(`data value: ${JSON.stringify(data.data).substring(0, 200)}`);
                    throw new Error("Invalid API response structure: 'data' is not an array");
                }

                if (data.data.length === 0) {
                    console.warn(`[Embedding] Warning: Batch ${batchNumber} returned empty embeddings array`);
                }

                return data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
            } catch (error) {
                lastError = error;
                if (error.name === "AbortError") {
                    console.warn(`[Embedding] Batch ${batchNumber}, Model "${model}" timed out after ${REQUEST_TIMEOUT_MS}ms`);
                }
                console.warn(`[Embedding] Batch ${batchNumber}, Model "${model}" failed (${modelIndex + 1}/${modelCandidates.length}): ${error.message}`);
                if (attempt === retryAttempts) break;
                await new Promise((resolve) => setTimeout(resolve, baseDelay * Math.pow(2, attempt)));
            }
        }
    }

    throw lastError || new Error("all embedding model candidates failed");
}

async function getEmbeddingsBatch(texts, config) {
    if (!texts || texts.length === 0) return [];

    const embeddingBackends = buildEmbeddingBackends(config);
    if (embeddingBackends.length === 0) {
        throw new Error("No embedding backend configured");
    }

    const batches = [];
    let currentBatchTexts = [];
    let currentBatchIndices = [];
    let currentBatchTokens = 0;
    const oversizeIndices = new Set();

    for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        const textTokens = encoding.encode(text).length;
        if (textTokens > safeMaxTokens) {
            console.warn(`[Embedding] Text at index ${i} exceeds token limit (${textTokens} > ${safeMaxTokens}), skipping.`);
            oversizeIndices.add(i);
            continue;
        }

        const isTokenFull = currentBatchTexts.length > 0 && currentBatchTokens + textTokens > safeMaxTokens;
        const isItemFull = currentBatchTexts.length >= MAX_BATCH_ITEMS;

        if (isTokenFull || isItemFull) {
            batches.push({ texts: currentBatchTexts, originalIndices: currentBatchIndices });
            currentBatchTexts = [text];
            currentBatchIndices = [i];
            currentBatchTokens = textTokens;
        } else {
            currentBatchTexts.push(text);
            currentBatchIndices.push(i);
            currentBatchTokens += textTokens;
        }
    }

    if (currentBatchTexts.length > 0) {
        batches.push({ texts: currentBatchTexts, originalIndices: currentBatchIndices });
    }

    if (oversizeIndices.size > 0) {
        console.warn(`[Embedding] ${oversizeIndices.size} texts skipped due to token limit.`);
    }
    console.log(`[Embedding] Prepared ${batches.length} batches from ${texts.length} texts. Executing with concurrency: ${DEFAULT_CONCURRENCY}...`);

    const batchResults = new Array(batches.length);
    let cursor = 0;

    const worker = async () => {
        while (true) {
            const batchIndex = cursor++;
            if (batchIndex >= batches.length) break;

            const batch = batches[batchIndex];
            try {
                let vectors = null;
                let lastError = null;

                for (const backend of embeddingBackends) {
                    try {
                        if (backend.name !== "primary") {
                            console.warn(`[Embedding] Batch ${batchIndex + 1} switching to fallback backend (${backend.model})`);
                        }
                        vectors = await _sendBatch(batch.texts, backend, batchIndex + 1);
                        if (backend.name !== "primary") {
                            recordFallbackHit(backend, lastError);
                        }
                        break;
                    } catch (error) {
                        lastError = error;
                        console.warn(`[Embedding] Batch ${batchIndex + 1} ${backend.name} backend failed: ${error.message}`);
                    }
                }

                if (!vectors) throw lastError || new Error("all embedding backends failed");

                batchResults[batchIndex] = {
                    vectors,
                    originalIndices: batch.originalIndices,
                };
            } catch (error) {
                console.error(`[Embedding] Batch ${batchIndex + 1} failed permanently: ${error.message}`);
                batchResults[batchIndex] = {
                    vectors: null,
                    originalIndices: batch.originalIndices,
                    error: error.message,
                };
            }
        }
    };

    const workers = [];
    for (let i = 0; i < DEFAULT_CONCURRENCY; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    const finalResults = new Array(texts.length).fill(null);
    let successCount = 0;
    let failCount = 0;

    for (const result of batchResults) {
        if (!result || !result.vectors) {
            if (result) failCount += result.originalIndices.length;
            continue;
        }
        result.originalIndices.forEach((origIdx, vecIdx) => {
            finalResults[origIdx] = result.vectors[vecIdx] || null;
            if (result.vectors[vecIdx]) successCount++;
            else failCount++;
        });
    }

    failCount += oversizeIndices.size;
    if (failCount > 0) {
        console.warn(`[Embedding] Results: ${successCount} succeeded, ${failCount} failed/skipped out of ${texts.length} total.`);
    }

    return finalResults;
}

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

module.exports = { getEmbeddingsBatch, cosineSimilarity, getEmbeddingFallbackStats, hasEmbeddingBackend };
