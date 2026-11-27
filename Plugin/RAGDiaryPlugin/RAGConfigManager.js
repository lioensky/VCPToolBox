'use strict';

const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const crypto = require('crypto');
const dotenv = require('dotenv');

function loadEnvironment(host) {
    // --- 加载插件独立的 .env 文件 ---
    const envPath = path.join(__dirname, 'config.env');
    dotenv.config({ path: envPath });

    // 元思考扩散构链配置仅属于本插件，不修改全局 rag_params。
    const riverNumber = (name, fallback, min, max) => {
        const raw = process.env[name];
        const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
        return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    };
    host.riverThinkingConfig = Object.freeze({
        enabled: String(process.env.RAG_RIVER_THINKING_ENABLED || 'false').trim().toLowerCase() === 'true',
        candidateK: Math.floor(riverNumber('RAG_RIVER_THINKING_CANDIDATE_K', 48, 1, 256)),
        maxTransitionRecords: Math.floor(riverNumber('RAG_RIVER_THINKING_MAX_TRANSITIONS', 8000, 1, 16000)),
        minClosure: riverNumber('RAG_RIVER_THINKING_MIN_CLOSURE', 0.2, 0, 1)
    });

    // 🌟 初始化缓存系统
    host.queryCacheEnabled = (process.env.RAG_QUERY_CACHE_ENABLED || 'true').toLowerCase() === 'true';
    host.contextVectorAllowApi = (process.env.CONTEXT_VECTOR_ALLOW_API_HISTORY || 'false').toLowerCase() === 'true';
    host.shotgunHistoryEnabled = String(process.env.RAG_SHOTGUN_HISTORY_ENABLED || 'true')
        .trim().toLowerCase() !== 'false';

    if (host.queryCacheEnabled) {
        host.cacheManager.createCache('query', {
            maxSize: parseInt(process.env.RAG_CACHE_MAX_SIZE) || 200,
            ttl: parseInt(process.env.RAG_CACHE_TTL_MS) || 3600000
        });
    }

    host.cacheManager.createCache('embedding', {
        maxSize: parseInt(process.env.EMBEDDING_CACHE_MAX_SIZE) || 500,
        ttl: parseInt(process.env.EMBEDDING_CACHE_TTL_MS) || 7200000
    });

    host.cacheManager.createCache('aimemo', {
        maxSize: parseInt(process.env.AIMEMO_CACHE_MAX_SIZE) || 50,
        ttl: parseInt(process.env.AIMEMO_CACHE_TTL_MS) || 1800000
    });

    // --- 加载 Rerank 配置 ---
    // 单次最多 25 个 documents 可保持在服务商的小批量免费档。
    // 环境变量允许进一步调低，但硬上限固定为 25，避免误配置进入按 Token 计费的大批量档。
    const configuredRerankMaxDocuments = parseInt(process.env.RerankMaxDocumentsPerRequest, 10);
    const rerankMaxDocuments = Number.isFinite(configuredRerankMaxDocuments)
        ? Math.max(1, Math.min(25, configuredRerankMaxDocuments))
        : 25;
    const configuredRerankConcurrency = parseInt(process.env.RerankMaxConcurrentRequests, 10);
    const rerankMaxConcurrentRequests = Number.isFinite(configuredRerankConcurrency)
        ? Math.max(1, Math.min(10, configuredRerankConcurrency))
        : 3;
    const jevAdvancedRerank = String(
        process.env.JevAdvancedRerank || 'false'
    ).toLowerCase() === 'true';
    const configuredJevMaxChoices = parseInt(
        process.env.JevRerankMaxChoices,
        10
    );
    const configuredJevMaxDocumentChars = parseInt(
        process.env.JevRerankMaxDocumentChars,
        10
    );
    host.rerankConfig = {
        url: process.env.RerankUrl || '',
        apiKey: process.env.RerankApi || '',
        model: process.env.RerankModel || '',
        multiplier: parseFloat(process.env.RerankMultiplier) || 2.0,
        maxTokens: parseInt(process.env.RerankMaxTokensPerBatch) || 30000,
        maxDocumentsPerRequest: rerankMaxDocuments,
        maxConcurrentRequests: rerankMaxConcurrentRequests,
        useJev: jevAdvancedRerank,
        jevPrompt: process.env.JevRerankPrompt
            || '请选择最值得用于回答当前查询的记忆。请从逻辑关联、记忆叙事连续性、信息解释力三个层面综合判断；优先保留能直接解释当前问题、补足关键背景或维持人物与事件连续性的内容，压低仅有表面词汇重合、重复、跑题或缺乏上下文价值的内容。',
        jevPrompts: Object.fromEntries([1, 2, 3, 4].map(number => [
            number, String(process.env[`JevRerankPrompt${number}`] || '').trim()
        ])),
        jevMaxChoices: Number.isFinite(configuredJevMaxChoices)
            ? Math.max(2, Math.min(255, configuredJevMaxChoices))
            : 255,
        jevMaxDocumentChars: Number.isFinite(configuredJevMaxDocumentChars)
            ? Math.max(200, Math.min(50000, configuredJevMaxDocumentChars))
            : 6000
    };
    // 移除启动时检查，改为在调用时实时检查
    if (host.rerankConfig.useJev) {
        const jevConfigured = host.jevClient?.isConfigured?.() === true;
        console.log(
            `[RAGDiaryPlugin] Jev advanced rerank is enabled ` +
            `(configured=${jevConfigured}, maxChoices=${host.rerankConfig.jevMaxChoices}).`
        );
    } else if (
        host.rerankConfig.url
        && host.rerankConfig.apiKey
        && host.rerankConfig.model
    ) {
        console.log('[RAGDiaryPlugin] Rerank feature is configured.');
    }
}

async function loadTagVectors(host) {
    const configPath = path.join(__dirname, 'rag_tags.json');
    const cachePath = path.join(__dirname, 'vector_cache.json');

    try {
        const currentConfigHash = await host._getFileHash(configPath);

        // 如果配置哈希变化，清空查询缓存
        if (host.lastConfigHash && host.lastConfigHash !== currentConfigHash) {
            console.log('[RAGDiaryPlugin] 配置文件已更新，清空查询缓存');
            if (host.queryCacheEnabled) {
                host.cacheManager.clear('query');
            }
        }
        host.lastConfigHash = currentConfigHash;

        if (!currentConfigHash) {
            console.log('[RAGDiaryPlugin] 未找到 rag_tags.json 文件：跳过 RAG 标签缓存加载，但继续初始化 AIMemo / MetaThinking / FoldingStore 等子系统。');
            host.ragConfig = {};
        } else {
            let cache = null;
            try {
                cache = await host._readJsonFileStable(cachePath, null, {
                    label: 'vector_cache.json',
                    maxAttempts: 3,
                    retryDelayMs: 100
                });
            } catch (e) {
                console.log('[RAGDiaryPlugin] 缓存文件不存在或已损坏，将重新构建。');
            }

            if (cache && cache.sourceHash === currentConfigHash) {
                // --- 缓存命中 ---
                console.log('[RAGDiaryPlugin] 缓存有效，从磁盘加载向量...');
                host.ragConfig = await host._readJsonFileStable(configPath, {}, { label: 'rag_tags.json' });
                host.enhancedVectorCache = cache.vectors;
                console.log(`[RAGDiaryPlugin] 成功从缓存加载 ${Object.keys(host.enhancedVectorCache).length} 个向量。`);
            } else {
                // --- 缓存失效或未命中 ---
                if (cache) {
                    console.log('[RAGDiaryPlugin] rag_tags.json 已更新，正在重建缓存...');
                } else {
                    console.log('[RAGDiaryPlugin] 未找到有效缓存，首次构建向量缓存...');
                }

                host.ragConfig = await host._readJsonFileStable(configPath, {}, { label: 'rag_tags.json' });

                // 调用 _buildAndSaveCache 来生成向量
                await host._buildAndSaveCache(currentConfigHash, cachePath);
            }
        }


    } catch (error) {
        console.error('[RAGDiaryPlugin] 加载配置文件或处理缓存时发生严重错误:', error);
        host.ragConfig = {};
    }
}

function stopWatchers(host) {
    if (host.ragParamsReloadTimer) {
        clearTimeout(host.ragParamsReloadTimer);
        host.ragParamsReloadTimer = null;
    }
    if (host.ragTagsReloadTimer) {
        clearTimeout(host.ragTagsReloadTimer);
        host.ragTagsReloadTimer = null;
    }
    if (host.ragParamsWatcher) {
        host.ragParamsWatcher.close();
        host.ragParamsWatcher = null;
    }
    if (host.ragTagsWatcher) {
        host.ragTagsWatcher.close();
        host.ragTagsWatcher = null;
    }
}

async function loadRagParams(host, projectBasePath) {
    const paramsPath = path.join(projectBasePath || path.join(__dirname, '../../'), 'rag_params.json');
    try {
        const previousParams = JSON.stringify(host.ragParams || {});
        const nextParams = await host._readJsonFileStable(
            paramsPath,
            { RAGDiaryPlugin: {} },
            { label: 'rag_params.json' }
        );
        host.ragParams = nextParams;
        if (
            previousParams !== JSON.stringify(nextParams)
            && host.queryCacheEnabled
        ) {
            host.cacheManager.clear('query');
            console.log('[RAGDiaryPlugin] RAG 热调控参数已变更，查询缓存已清空。');
        }
        console.log('[RAGDiaryPlugin] ✅ RAG 热调控参数已加载');
    } catch (e) {
        console.error('[RAGDiaryPlugin] ❌ 加载 rag_params.json 失败:', e.message);
        host.ragParams = host.ragParams && Object.keys(host.ragParams).length > 0
            ? host.ragParams
            : { RAGDiaryPlugin: {} };
    }
}

function _startRagParamsWatcher(host, projectBasePath) {
    const paramsPath = path.join(projectBasePath || path.join(__dirname, '../../'), 'rag_params.json');
    if (host.ragParamsWatcher) return;

    host.ragParamsWatcher = chokidar.watch(paramsPath, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    });
    host.ragParamsWatcher.on('change', () => {
        console.log('[RAGDiaryPlugin] 🔄 检测到 rag_params.json 变更，准备防抖重新加载...');
        clearTimeout(host.ragParamsReloadTimer);
        host.ragParamsReloadTimer = setTimeout(() => {
            host.ragParamsReloadPromise = host.ragParamsReloadPromise
                .catch(() => { })
                .then(() => host.loadRagParams());
        }, 250);
    });
}

function _startRagTagsWatcher(host) {
    const configPath = path.join(__dirname, 'rag_tags.json');
    if (host.ragTagsWatcher) return;

    host.ragTagsWatcher = chokidar.watch(configPath, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 700, pollInterval: 100 }
    });
    host.ragTagsWatcher.on('change', () => {
        console.log('[RAGDiaryPlugin] 🔄 检测到 rag_tags.json 变更，准备防抖热重载配置与向量缓存...');
        clearTimeout(host.ragTagsReloadTimer);
        host.ragTagsReloadTimer = setTimeout(() => {
            host.ragTagsReloadPromise = host.ragTagsReloadPromise
                .catch(() => { })
                .then(() => host._reloadRagTagsConfig(configPath));
        }, 300);
    });
}

async function _buildAndSaveCache(host, configHash, cachePath) {
    console.log('[RAGDiaryPlugin] 正在为所有日记本请求 Embedding API (Batch Mode)...');
    host.enhancedVectorCache = {}; // 清空旧的内存缓存

    const dbNames = Object.keys(host.ragConfig);
    const enhancedTexts = [];
    const validDbNames = [];

    for (const dbName of dbNames) {
        const diaryConfig = host.ragConfig[dbName];
        const tagsConfig = diaryConfig.tags;

        if (Array.isArray(tagsConfig) && tagsConfig.length > 0) {
            let weightedTags = [];
            tagsConfig.forEach(tagInfo => {
                const parts = tagInfo.split(':');
                const tagName = parts[0].trim();
                let weight = 1.0;
                if (parts.length > 1) {
                    const parsedWeight = parseFloat(parts[1]);
                    if (!isNaN(parsedWeight)) weight = parsedWeight;
                }
                if (tagName) {
                    const repetitions = Math.max(1, Math.round(weight));
                    for (let i = 0; i < repetitions; i++) weightedTags.push(tagName);
                }
            });

            enhancedTexts.push(`${dbName} 的相关主题：${weightedTags.join(', ')}`);
            validDbNames.push(dbName);
        }
    }

    if (enhancedTexts.length > 0) {
        const vectors = await host.getBatchEmbeddings(enhancedTexts);
        vectors.forEach((vec, i) => {
            const dbName = validDbNames[i];
            if (vec) {
                host.enhancedVectorCache[dbName] = vec;
                console.log(`[RAGDiaryPlugin] -> 已为 "${dbName}" 成功获取向量。`);
            } else {
                console.error(`[RAGDiaryPlugin] -> 为 "${dbName}" 获取向量失败。`);
            }
        });
    }

    // 构建新的缓存对象并保存到磁盘
    const newCache = {
        sourceHash: configHash,
        createdAt: new Date().toISOString(),
        vectors: host.enhancedVectorCache,
    };

    try {
        await host._writeJsonFileAtomic(cachePath, newCache);
        console.log(`[RAGDiaryPlugin] 向量缓存已成功写入到 ${cachePath}`);
    } catch (writeError) {
        console.error('[RAGDiaryPlugin] 写入缓存文件失败:', writeError);
    }
}

async function _getFileHash(host, filePath) {
    try {
        const fileContent = await host._readTextFileStable(filePath, {
            label: path.basename(filePath),
            maxAttempts: 3,
            retryDelayMs: 100,
            allowEmpty: false
        });
        return crypto.createHash('sha256').update(fileContent).digest('hex');
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EMPTY_FILE') {
            return null; // 文件不存在或写入暂态空文件则没有哈希
        }
        throw error; // 其他错误则抛出
    }
}

function _sleep(host, ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function _readTextFileStable(host, filePath, options = {}) {
    const {
        label = path.basename(filePath),
        maxAttempts = 6,
        retryDelayMs = 150,
        allowEmpty = false
    } = options;

    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            if (!allowEmpty && content.trim().length === 0) {
                const emptyError = new Error(`${label} is empty while being written`);
                emptyError.code = 'EMPTY_FILE';
                throw emptyError;
            }
            return content;
        } catch (error) {
            lastError = error;
            if (error.code === 'ENOENT') throw error;

            if (attempt < maxAttempts) {
                console.warn(`[RAGDiaryPlugin] ${label} 读取暂不可用 (${error.message})，${retryDelayMs}ms 后重试 ${attempt}/${maxAttempts}...`);
                await host._sleep(retryDelayMs);
                continue;
            }
        }
    }

    throw lastError;
}

async function _readJsonFileStable(host, filePath, fallback = null, options = {}) {
    const {
        label = path.basename(filePath),
        maxAttempts = 6,
        retryDelayMs = 150
    } = options;

    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const content = await host._readTextFileStable(filePath, {
                label,
                maxAttempts: 1,
                retryDelayMs,
                allowEmpty: false
            });
            return JSON.parse(content);
        } catch (error) {
            lastError = error;
            if (error.code === 'ENOENT') {
                if (fallback !== null) return fallback;
                throw error;
            }

            if (attempt < maxAttempts) {
                console.warn(`[RAGDiaryPlugin] ${label} JSON 解析暂失败 (${error.message})，${retryDelayMs}ms 后重试 ${attempt}/${maxAttempts}...`);
                await host._sleep(retryDelayMs);
                continue;
            }
        }
    }

    if (fallback !== null) return fallback;
    throw lastError;
}

async function _writeJsonFileAtomic(host, filePath, data) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const tempPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
    const json = JSON.stringify(data, null, 2);

    await fs.writeFile(tempPath, json, 'utf-8');
    await fs.rename(tempPath, filePath);
}

async function _reloadRagTagsConfig(host, configPath) {
    console.log('[RAGDiaryPlugin] 🔄 正在热重载 rag_tags.json 配置与向量缓存...');
    try {
        const cachePath = path.join(__dirname, 'vector_cache.json');
        const nextConfig = await host._readJsonFileStable(configPath, {}, { label: 'rag_tags.json' });
        const currentConfigHash = crypto.createHash('sha256')
            .update(JSON.stringify(nextConfig, null, 2))
            .digest('hex');

        if (!currentConfigHash) {
            console.warn('[RAGDiaryPlugin] 热重载: rag_tags.json 文件不存在或为空，跳过。');
            return;
        }

        // 哈希未变则跳过（防止编辑器保存但内容未变的情况）
        if (host.lastConfigHash === currentConfigHash) {
            console.log('[RAGDiaryPlugin] 热重载: 文件哈希未变，跳过重建。');
            return;
        }

        host.lastConfigHash = currentConfigHash;
        host.ragConfig = nextConfig;

        // 重建向量缓存
        await host._buildAndSaveCache(currentConfigHash, cachePath);

        // 清空查询缓存（配置变了，旧缓存结果可能不准确）
        if (host.queryCacheEnabled) {
            host.cacheManager.clear('query');
            console.log('[RAGDiaryPlugin] 热重载: 查询缓存已清空。');
        }

        console.log('[RAGDiaryPlugin] ✅ rag_tags.json 热重载完成。');
    } catch (error) {
        console.error('[RAGDiaryPlugin] ❌ rag_tags.json 热重载失败:', error.message);
    }
}

module.exports = {
    loadEnvironment,
    loadTagVectors,
    stopWatchers,
    loadRagParams,
    _startRagParamsWatcher,
    _startRagTagsWatcher,
    _buildAndSaveCache,
    _getFileHash,
    _sleep,
    _readTextFileStable,
    _readJsonFileStable,
    _writeJsonFileAtomic,
    _reloadRagTagsConfig,
};
