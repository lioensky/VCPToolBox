// Plugin/MessagePreprocessor/RAGDiaryPlugin/RAGDiaryPlugin.js

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const crypto = require('crypto');
const dotenv = require('dotenv');
const cheerio = require('cheerio');
const mime = require('mime-types');
const TimeExpressionParser = require('./TimeExpressionParser.js');
const MetaThinkingManager = require('./MetaThinkingManager.js');
const SemanticGroupManager = require('./SemanticGroupManager.js');
const AIMemoHandler = require('./AIMemoHandler.js');
const ContextVectorManager = require('./ContextVectorManager.js');
const FoldingStore = require('./FoldingStore.js'); // 🌟 V2折叠：SQLite 迷你数据库
const CacheManager = require('./CacheManager.js'); // 🌟 新增：统一缓存管理器
const { chunkText } = require('../../TextChunker.js');


const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';
// 从 DailyNoteGet 插件借鉴的常量和路径逻辑
const projectBasePath = process.env.PROJECT_BASE_PATH;
const dailyNoteRootPath = process.env.KNOWLEDGEBASE_ROOT_PATH || (projectBasePath ? path.join(projectBasePath, 'dailynote') : path.join(__dirname, '..', '..', 'dailynote'));

const GLOBAL_SIMILARITY_THRESHOLD = 0.6; // 全局默认余弦相似度阈值

//####################################################################################
//## TimeExpressionParser - 时间表达式解析器
//####################################################################################


class RAGDiaryPlugin {
    constructor() {
        this.name = 'RAGDiaryPlugin';
        this.vectorDBManager = null;
        this.ragConfig = {};
        this.rerankConfig = {};
        this.pushVcpInfo = null;
        this.enhancedVectorCache = {};
        this.timeParser = new TimeExpressionParser('zh-CN', DEFAULT_TIMEZONE);
        this.semanticGroups = new SemanticGroupManager(this);
        this.contextVectorManager = new ContextVectorManager(this);
        this.metaThinkingManager = new MetaThinkingManager(this);
        this.aiMemoHandler = null;
        this.isInitialized = false;
        this.lastConfigHash = null;
        this.ragParams = {};
        this.ragParamsWatcher = null;

        // 🌟 统一缓存管理器
        this.cacheManager = new CacheManager();
        this.queryCacheEnabled = true;

        // 🌟 V2折叠：FoldingStore 迷你数据库
        this.foldingStore = null;
    }

    async loadConfig() {
        // --- 加载插件独立的 .env 文件 ---
        const envPath = path.join(__dirname, 'config.env');
        dotenv.config({ path: envPath });

        // 🌟 初始化缓存系统
        this.queryCacheEnabled = (process.env.RAG_QUERY_CACHE_ENABLED || 'true').toLowerCase() === 'true';
        this.contextVectorAllowApi = (process.env.CONTEXT_VECTOR_ALLOW_API_HISTORY || 'false').toLowerCase() === 'true';

        if (this.queryCacheEnabled) {
            this.cacheManager.createCache('query', {
                maxSize: parseInt(process.env.RAG_CACHE_MAX_SIZE) || 200,
                ttl: parseInt(process.env.RAG_CACHE_TTL_MS) || 3600000
            });
        }

        this.cacheManager.createCache('embedding', {
            maxSize: parseInt(process.env.EMBEDDING_CACHE_MAX_SIZE) || 500,
            ttl: parseInt(process.env.EMBEDDING_CACHE_TTL_MS) || 7200000
        });

        this.cacheManager.createCache('aimemo', {
            maxSize: parseInt(process.env.AIMEMO_CACHE_MAX_SIZE) || 50,
            ttl: parseInt(process.env.AIMEMO_CACHE_TTL_MS) || 1800000
        });

        // --- 加载 Rerank 配置 ---
        this.rerankConfig = {
            url: process.env.RerankUrl || '',
            apiKey: process.env.RerankApi || '',
            model: process.env.RerankModel || '',
            multiplier: parseFloat(process.env.RerankMultiplier) || 2.0,
            maxTokens: parseInt(process.env.RerankMaxTokensPerBatch) || 30000
        };
        // 移除启动时检查，改为在调用时实时检查
        if (this.rerankConfig.url && this.rerankConfig.apiKey && this.rerankConfig.model) {
            console.log('[RAGDiaryPlugin] Rerank feature is configured.');
        }

        // --- 初始化并加载 AIMemo 配置 ---
        console.log('[RAGDiaryPlugin] Initializing AIMemo handler...');
        this.aiMemoHandler = new AIMemoHandler(this, this.cacheManager.caches.get('aimemo').data);
        await this.aiMemoHandler.loadConfig();
        console.log('[RAGDiaryPlugin] AIMemo handler initialized.');

        const configPath = path.join(__dirname, 'rag_tags.json');
        const cachePath = path.join(__dirname, 'vector_cache.json');

        try {
            const currentConfigHash = await this._getFileHash(configPath);

            // 如果配置哈希变化，清空查询缓存
            if (this.lastConfigHash && this.lastConfigHash !== currentConfigHash) {
                console.log('[RAGDiaryPlugin] 配置文件已更新，清空查询缓存');
                if (this.queryCacheEnabled) {
                    this.cacheManager.clear('query');
                }
            }
            this.lastConfigHash = currentConfigHash;

            if (!currentConfigHash) {
                console.log('[RAGDiaryPlugin] 未找到 rag_tags.json 文件：跳过 RAG 标签缓存加载，但继续初始化 AIMemo / MetaThinking / FoldingStore 等子系统。');
                this.ragConfig = {};
            } else {
                let cache = null;
                try {
                    const cacheData = await fs.readFile(cachePath, 'utf-8');
                    cache = JSON.parse(cacheData);
                } catch (e) {
                    console.log('[RAGDiaryPlugin] 缓存文件不存在或已损坏，将重新构建。');
                }

                if (cache && cache.sourceHash === currentConfigHash) {
                    // --- 缓存命中 ---
                    console.log('[RAGDiaryPlugin] 缓存有效，从磁盘加载向量...');
                    this.ragConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
                    this.enhancedVectorCache = cache.vectors;
                    console.log(`[RAGDiaryPlugin] 成功从缓存加载 ${Object.keys(this.enhancedVectorCache).length} 个向量。`);
                } else {
                    // --- 缓存失效或未命中 ---
                    if (cache) {
                        console.log('[RAGDiaryPlugin] rag_tags.json 已更新，正在重建缓存...');
                    } else {
                        console.log('[RAGDiaryPlugin] 未找到有效缓存，首次构建向量缓存...');
                    }

                    const configData = await fs.readFile(configPath, 'utf-8');
                    this.ragConfig = JSON.parse(configData);

                    // 调用 _buildAndSaveCache 来生成向量
                    await this._buildAndSaveCache(currentConfigHash, cachePath);
                }
            }


        } catch (error) {
            console.error('[RAGDiaryPlugin] 加载配置文件或处理缓存时发生严重错误:', error);
            this.ragConfig = {};
        }

        // --- 加载元思考链配置 ---
        await this.metaThinkingManager.loadConfig();

        // --- 🌟 V2折叠：初始化 FoldingStore（热重载安全：先关旧实例再开新实例） ---
        try {
            const foldingDbPath = path.join(__dirname, 'folding_store.db');
            const foldingStoreOptions = {
                maxEntries: parseInt(process.env.FOLDING_STORE_MAX_ENTRIES) || 200,
                evictCount: parseInt(process.env.FOLDING_STORE_EVICT_COUNT) || 20
            };

            console.log(
                `[RAGDiaryPlugin] FoldingStore 初始化开始: ` +
                `dbPath=${foldingDbPath}, ` +
                `cwd=${process.cwd()}, ` +
                `pluginDir=${__dirname}, ` +
                `options=${JSON.stringify(foldingStoreOptions)}`
            );

            // 防止热重载时产生幽灵实例：如果旧 store 存在，先优雅关闭
            if (this.foldingStore) {
                console.log('[RAGDiaryPlugin] 检测到 FoldingStore 旧实例，正在关闭以防竞态...');
                this.foldingStore.shutdown();
                this.foldingStore = null;
                console.log('[RAGDiaryPlugin] FoldingStore 旧实例已关闭。');
            }

            this.foldingStore = new FoldingStore(foldingDbPath, foldingStoreOptions);

            if (this.foldingStore) {
                const stats = this.foldingStore.getStats();
                console.log(
                    `[RAGDiaryPlugin] FoldingStore 初始化完成: ` +
                    `available=${stats.available}, count=${stats.count}, maxEntries=${stats.maxEntries}`
                );
            } else {
                console.warn('[RAGDiaryPlugin] FoldingStore 初始化结束，但实例为空，折叠功能将不可用。');
            }
        } catch (e) {
            console.error('[RAGDiaryPlugin] FoldingStore 初始化失败，折叠功能将不可用。');
            console.error(`[RAGDiaryPlugin] FoldingStore 初始化失败详情: dbPath=${path.join(__dirname, 'folding_store.db')}, cwd=${process.cwd()}, pluginDir=${__dirname}`);
            console.error('[RAGDiaryPlugin] FoldingStore 初始化错误消息:', e.message);
            if (e.stack) {
                console.error('[RAGDiaryPlugin] FoldingStore 初始化错误堆栈:', e.stack);
            }
            this.foldingStore = null;
        }
    }

    /**
     * ✅ 新增：加载 RAG 热调控参数
     */
    async loadRagParams() {
        const paramsPath = path.join(projectBasePath || path.join(__dirname, '../../'), 'rag_params.json');
        try {
            const data = await fs.readFile(paramsPath, 'utf-8');
            this.ragParams = JSON.parse(data);
            console.log('[RAGDiaryPlugin] ✅ RAG 热调控参数已加载');
        } catch (e) {
            console.error('[RAGDiaryPlugin] ❌ 加载 rag_params.json 失败:', e.message);
            this.ragParams = { RAGDiaryPlugin: {} };
        }
    }

    /**
     * ✅ 新增：启动参数监听器
     */
    _startRagParamsWatcher() {
        const paramsPath = path.join(projectBasePath || path.join(__dirname, '../../'), 'rag_params.json');
        if (this.ragParamsWatcher) return;

        this.ragParamsWatcher = chokidar.watch(paramsPath);
        this.ragParamsWatcher.on('change', async () => {
            console.log('[RAGDiaryPlugin] 🔄 检测到 rag_params.json 变更，正在重新加载...');
            await this.loadRagParams();
        });
    }

    async _buildAndSaveCache(configHash, cachePath) {
        console.log('[RAGDiaryPlugin] 正在为所有日记本请求 Embedding API (Batch Mode)...');
        this.enhancedVectorCache = {}; // 清空旧的内存缓存

        const dbNames = Object.keys(this.ragConfig);
        const enhancedTexts = [];
        const validDbNames = [];

        for (const dbName of dbNames) {
            const diaryConfig = this.ragConfig[dbName];
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
            const vectors = await this.getBatchEmbeddings(enhancedTexts);
            vectors.forEach((vec, i) => {
                const dbName = validDbNames[i];
                if (vec) {
                    this.enhancedVectorCache[dbName] = vec;
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
            vectors: this.enhancedVectorCache,
        };

        try {
            await fs.writeFile(cachePath, JSON.stringify(newCache, null, 2), 'utf-8');
            console.log(`[RAGDiaryPlugin] 向量缓存已成功写入到 ${cachePath}`);
        } catch (writeError) {
            console.error('[RAGDiaryPlugin] 写入缓存文件失败:', writeError);
        }
    }


    async _getFileHash(filePath) {
        try {
            const fileContent = await fs.readFile(filePath, 'utf-8');
            return crypto.createHash('sha256').update(fileContent).digest('hex');
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null; // 文件不存在则没有哈希
            }
            throw error; // 其他错误则抛出
        }
    }

    async initialize(config, dependencies) {
        if (dependencies.vectorDBManager) {
            this.vectorDBManager = dependencies.vectorDBManager;
            console.log('[RAGDiaryPlugin] VectorDBManager 依赖已注入。');
        }
        if (dependencies.vcpLogFunctions && typeof dependencies.vcpLogFunctions.pushVcpInfo === 'function') {
            this.pushVcpInfo = dependencies.vcpLogFunctions.pushVcpInfo;
            console.log('[RAGDiaryPlugin] pushVcpInfo 依赖已成功注入。');
        } else {
            console.error('[RAGDiaryPlugin] 警告：pushVcpInfo 依赖注入失败或未提供。');
        }

        // ✅ 关键修复：确保配置加载完成后再处理消息
        console.log('[RAGDiaryPlugin] 开始加载配置...');
        await this.loadConfig();
        await this.loadRagParams();
        this._startRagParamsWatcher();

        // 启动缓存清理任务
        if (this.queryCacheEnabled) {
            this.cacheManager.startCleanup('query');
        }
        this.cacheManager.startCleanup('embedding');
        this.cacheManager.startCleanup('aimemo');

        console.log('[RAGDiaryPlugin] 插件初始化完成，统一缓存系统已启动');
    }

    /**
     * 🌟 新增：内存级幽灵节点获取器（只读 DB 或查 API，绝不 Insert）
     * 🌟 优化：支持批量向量化，减少 API 请求次数
     */
    async _resolveGhostAnchors(tags, isCore) {
        const ghostTags = [];
        if (!tags || tags.length === 0) return ghostTags;

        const db = this.vectorDBManager?.db;
        const checkStmt = db ? db.prepare('SELECT vector FROM tags WHERE name = ?') : null;
        const dim = this.vectorDBManager?.config?.dimension || 3072;

        const tagsToEmbed = [];
        const tagResults = new Array(tags.length).fill(null);

        // 1. 先查数据库（看是否是已有正规军）
        tags.forEach((tagName, index) => {
            if (checkStmt) {
                try {
                    const row = checkStmt.get(tagName);
                    if (row && row.vector) {
                        tagResults[index] = new Float32Array(row.vector.buffer, row.vector.byteOffset, dim);
                    }
                } catch (e) { /* ignore */ }
            }
            if (!tagResults[index]) {
                tagsToEmbed.push({ name: tagName, index });
            }
        });

        // 2. 数据库没有的，批量调 API 动态向量化（依赖内存缓存）
        if (tagsToEmbed.length > 0) {
            const apiVecs = await this.getBatchEmbeddingsCached(tagsToEmbed.map(t => t.name));
            apiVecs.forEach((vec, i) => {
                if (vec) {
                    const originalIndex = tagsToEmbed[i].index;
                    tagResults[originalIndex] = new Float32Array(vec);
                }
            });
        }

        // 3. 组装成带有本体向量的幽灵对象
        tags.forEach((tagName, index) => {
            if (tagResults[index]) {
                ghostTags.push({
                    name: tagName,
                    vector: tagResults[index],
                    isCore: isCore // 标记它是强引力还是弱引力
                });
            }
        });

        return ghostTags;
    }

    cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) {
            return 0;
        }
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) {
            return 0;
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    _getWeightedAverageVector(vectors, weights) {
        // 1. 过滤掉无效的向量及其对应的权重
        const validVectors = [];
        const validWeights = [];
        for (let i = 0; i < vectors.length; i++) {
            if (vectors[i] && vectors[i].length > 0) {
                validVectors.push(vectors[i]);
                validWeights.push(weights[i] || 0);
            }
        }

        if (validVectors.length === 0) return null;
        if (validVectors.length === 1) return validVectors[0];

        // 2. 归一化权重
        let weightSum = validWeights.reduce((sum, w) => sum + w, 0);
        if (weightSum === 0) {
            console.warn('[RAGDiaryPlugin] Weight sum is zero, using equal weights.');
            validWeights.fill(1 / validVectors.length);
            weightSum = 1;
        }

        const normalizedWeights = validWeights.map(w => w / weightSum);
        const dimension = validVectors[0].length;
        const result = new Array(dimension).fill(0);

        // 3. 计算加权平均值
        for (let i = 0; i < validVectors.length; i++) {
            const vector = validVectors[i];
            const weight = normalizedWeights[i];
            if (vector.length !== dimension) {
                console.error('[RAGDiaryPlugin] Vector dimensions do not match. Skipping mismatched vector.');
                continue;
            }
            for (let j = 0; j < dimension; j++) {
                result[j] += vector[j] * weight;
            }
        }

        return result;
    }

    /**
     * 计算多个向量的平均值
     */
    _getAverageVector(vectors) {
        if (!vectors || vectors.length === 0) return null;
        if (vectors.length === 1) return vectors[0];

        const dimension = vectors[0].length;
        const result = new Array(dimension).fill(0);

        for (const vector of vectors) {
            if (!vector || vector.length !== dimension) continue;
            for (let i = 0; i < dimension; i++) {
                result[i] += vector[i];
            }
        }

        for (let i = 0; i < dimension; i++) {
            result[i] /= vectors.length;
        }

        return result;
    }

    async getDiaryContent(characterName) {
        const characterDirPath = path.join(dailyNoteRootPath, characterName);
        let characterDiaryContent = `[${characterName}日记本内容为空]`;
        try {
            const files = await fs.readdir(characterDirPath);
            const relevantFiles = files.filter(file => {
                const lowerCaseFile = file.toLowerCase();
                return lowerCaseFile.endsWith('.txt') || lowerCaseFile.endsWith('.md');
            }).sort();

            if (relevantFiles.length > 0) {
                const fileContents = await Promise.all(
                    relevantFiles.map(async (file) => {
                        const filePath = path.join(characterDirPath, file);
                        try {
                            return await fs.readFile(filePath, 'utf-8');
                        } catch (readErr) {
                            return `[Error reading file: ${file}]`;
                        }
                    })
                );
                characterDiaryContent = fileContents.join('\n\n---\n\n');
            }
        } catch (charDirError) {
            if (charDirError.code !== 'ENOENT') {
                console.error(`[RAGDiaryPlugin] Error reading character directory ${characterDirPath}:`, charDirError.message);
            }
            characterDiaryContent = `[无法读取“${characterName}”的日记本，可能不存在]`;
        }
        return characterDiaryContent;
    }

    _sigmoid(x) {
        return 1 / (1 + Math.exp(-x));
    }

    /**
     * V3 动态参数计算：结合逻辑深度 (L)、共振 (R) 和语义宽度 (S)
     */
    async _calculateDynamicParams(queryVector, userText, aiText) {
        // 1. 基础 K 值计算 (基于文本长度)
        const userLen = userText ? userText.length : 0;
        let k_base = 3;
        if (userLen > 100) k_base = 6;
        else if (userLen > 30) k_base = 4;

        if (aiText) {
            const tokens = aiText.match(/[a-zA-Z0-9]+|[^\s\x00-\xff]/g) || [];
            const uniqueTokens = new Set(tokens).size;
            if (uniqueTokens > 100) k_base = Math.max(k_base, 6);
            else if (uniqueTokens > 40) k_base = Math.max(k_base, 4);
        }

        // 2. 获取 EPA 指标 (L, R)
        const epa = await this.vectorDBManager.getEPAAnalysis(queryVector);
        const L = epa.logicDepth;
        const R = epa.resonance;

        // 3. 获取语义宽度 (S)
        const S = this.contextVectorManager.computeSemanticWidth(queryVector);

        // 4. 计算动态 Beta (TagWeight)
        // β = σ(L · log(1 + R) - S · noise_penalty)
        const config = this.ragParams?.RAGDiaryPlugin || {};
        const noise_penalty = config.noise_penalty ?? 0.05;
        const betaInput = L * Math.log(1 + R + 1) - S * noise_penalty;
        const beta = this._sigmoid(betaInput);

        // 将 beta 映射到合理的 RAG 权重范围，例如 [0.05, 0.45]，默认基准 0.15
        const weightRange = config.tagWeightRange || [0.05, 0.45];
        const finalTagWeight = weightRange[0] + beta * (weightRange[1] - weightRange[0]);

        // 5. 计算动态 K
        // 逻辑越深(L)且共振越强(R)，说明信息量越大，需要更高的 K 来覆盖
        const kAdjustment = Math.round(L * 3 + Math.log1p(R) * 2);
        const finalK = Math.max(3, Math.min(10, k_base + kAdjustment));

        console.log(`[RAGDiaryPlugin][V3] L=${L.toFixed(3)}, R=${R.toFixed(3)}, S=${S.toFixed(3)} => Beta=${beta.toFixed(3)}, TagWeight=${finalTagWeight.toFixed(3)}, K=${finalK}`);

        // 6. 计算动态 Tag 截断比例 (Truncation Ratio)
        // 逻辑：逻辑越深(L)说明意图越明确，可以保留更多 Tag；语义宽度(S)越大说明噪音或干扰越多，应收紧截断。
        // 基础比例 0.6，范围 [0.5, 0.9] (调优：防止截断过于激进)
        let tagTruncationRatio = (config.tagTruncationBase ?? 0.6) + (L * 0.3) - (S * 0.2) + (Math.min(R, 1) * 0.1);
        const truncationRange = config.tagTruncationRange || [0.5, 0.9];
        tagTruncationRatio = Math.max(truncationRange[0], Math.min(truncationRange[1], tagTruncationRatio));

        return {
            k: finalK,
            tagWeight: finalTagWeight,
            tagTruncationRatio: tagTruncationRatio,
            metrics: { L, R, S, beta }
        };
    }

    // 保留旧方法作为回退或基础参考
    _calculateDynamicK(userText, aiText = null) {
        const userLen = userText ? userText.length : 0;
        let k_user = 3;
        if (userLen > 100) k_user = 7;
        else if (userLen > 30) k_user = 5;
        if (!aiText) return k_user;
        const tokens = aiText.match(/[a-zA-Z0-9]+|[^\s\x00-\xff]/g) || [];
        const uniqueTokens = new Set(tokens).size;
        let k_ai = 3;
        if (uniqueTokens > 100) k_ai = 7;
        else if (uniqueTokens > 40) k_ai = 5;
        return Math.round((k_user + k_ai) / 2);
    }

    /**
     * 核心标签截断技术：规避尾部噪音
     * 基于动态比例保留最重要的标签
     */
    _truncateCoreTags(tags, ratio, metrics) {
        // 如果标签较少（<=5个），不进行截断，保留原始语义
        if (!tags || tags.length <= 5) return tags;

        // 动态计算保留数量，最小保留 5 个（除非原始数量不足）
        const targetCount = Math.max(5, Math.ceil(tags.length * ratio));
        const truncated = tags.slice(0, targetCount);

        if (truncated.length < tags.length) {
            console.log(`[RAGDiaryPlugin][Truncation] ${tags.length} -> ${truncated.length} tags (Ratio: ${ratio.toFixed(2)}, L:${(metrics?.L ?? 0).toFixed(2)}, S:${(metrics?.S ?? 0).toFixed(2)})`);
        }
        return truncated;
    }

    _stripHtml(html) {
        if (!html) return ''; // 确保返回空字符串而不是 null/undefined

        // 如果不是字符串，尝试强制转换，避免 cheerio 或后续 trim 报错
        if (typeof html !== 'string') {
            return String(html);
        }

        // 1. 使用 cheerio 加载 HTML 并提取纯文本
        try {
            const $ = cheerio.load(html);
            // 关键修复：在提取文本之前，显式移除 style 和 script 标签
            $('style, script').remove();
            const plainText = $.text();

            // 3. 移除每行开头的空格，并将多个连续换行符压缩为最多两个
            return plainText
                .replace(/^[ \t]+/gm, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        } catch (e) {
            console.error('[RAGDiaryPlugin] _stripHtml error:', e);
            return html; // 解析失败则返回原始内容
        }
    }

    _stripEmoji(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }
        // 移除所有 emoji 和特殊符号
        // 这个正则表达式匹配大部分 emoji 范围
        return text.replace(/[\u{1F600}-\u{1F64F}]/gu, '') // 表情符号
            .replace(/[\u{1F300}-\u{1F5FF}]/gu, '') // 杂项符号和象形文字
            .replace(/[\u{1F680}-\u{1F6FF}]/gu, '') // 交通和地图符号
            .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '') // 旗帜
            .replace(/[\u{2600}-\u{26FF}]/gu, '')   // 杂项符号
            .replace(/[\u{2700}-\u{27BF}]/gu, '')   // 装饰符号
            .replace(/[\u{1F900}-\u{1F9FF}]/gu, '') // 补充符号和象形文字
            .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '') // 扩展-A
            .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '') // 扩展-B
            .replace(/[\u{FE00}-\u{FE0F}]/gu, '')   // 变体选择器
            .replace(/[\u{200D}]/gu, '')            // 零宽连接符
            .trim();
    }

    /**
     * 🌟 V3.7 新增：工具调用净化器 (Tool Call Sanitizer)
     * 移除 AI 工具调用的技术标记，防止其作为“英文偏好”噪音干扰向量搜索
     */
    _stripToolMarkers(text) {
        if (!text || typeof text !== 'string') return text;

        // 1. 识别完整的工具调用块 <<<[TOOL_REQUEST]>>> ... <<<[END_TOOL_REQUEST]>>>
        let processed = text.replace(/<<<\[?TOOL_REQUEST\]?>>>([\s\S]*?)<<<\[?END_TOOL_REQUEST\]?>>>/gi, (match, block) => {
            // 2. 提取并过滤键值对，支持 key:「始」value「末」 格式
            const blacklistedKeys = ['tool_name', 'command', 'archery', 'maid'];
            const blacklistedValues = ['dailynote', 'update', 'create', 'no_reply'];

            const results = [];
            // 🌟 关键修复：匹配完整的 「始」...「末」 容器，防止内容截断
            const regex = /(\w+):\s*[「『]始[」』]([\s\S]*?)[「『]末[」』]/g;
            let m;
            while ((m = regex.exec(block)) !== null) {
                const key = m[1].toLowerCase();
                const val = m[2].trim();
                const valLower = val.toLowerCase();

                const isTechKey = blacklistedKeys.includes(key);
                const isTechVal = blacklistedValues.some(bv => valLower.includes(bv));

                if (!isTechKey && !isTechVal && val.length > 1) {
                    results.push(val);
                }
            }

            // 如果正则没匹配到（可能是旧格式或非标准格式），回退到行处理
            if (results.length === 0) {
                return block.split('\n')
                    .map(line => {
                        const cleanLine = line.replace(/\w+:\s*[「『]始[」』]/g, '').replace(/[「『]末[」』]/g, '').trim();
                        const lower = cleanLine.toLowerCase();
                        if (blacklistedValues.some(bv => lower.includes(bv))) return '';
                        return cleanLine;
                    })
                    .filter(l => l.length > 0)
                    .join('\n');
            }

            return results.join('\n');
        });

        // 3. 移除起止符和残余标记
        return processed
            .replace(/<<<\[?TOOL_REQUEST\]?>>>/gi, '')
            .replace(/<<<\[?END_TOOL_REQUEST\]?>>>/gi, '')
            .replace(/[「」『』]始[「」『』]/g, '')
            .replace(/[「」『』]末[「」『』]/g, '')
            .replace(/[「」『』]/g, '')
            .replace(/[ \t]+/g, ' ') // 仅压缩水平空格，保留换行
            .replace(/\n{3,}/g, '\n\n') // 压缩过多换行
            .trim();
    }

    /**
     * 移除系统追加在用户消息末尾的“系统通知”部分，避免将其混入向量化。
     */
    _stripSystemNotification(text) {
        if (!text || typeof text !== 'string') return text;
        // 匹配从[系统通知]到[系统通知结束]的整个块，可能包含前后空白
        return text.replace(/\[系统通知\][\s\S]*?\[系统通知结束\]/g, '').trim();
    }

    /**
     * 🌟 统一内容净化器 - 确保 RAGDiaryPlugin 和 messageProcessor 向量化请求完全一致
     * @param {string} content 原始文本
     * @param {string} role 角色 ('user' 或 'assistant')
     * @returns {string} 净化后的文本
     */
    sanitizeForEmbedding(content, role) {
        if (!content || typeof content !== 'string') return '';

        let processed = content;

        // 1. 角色特定预处理
        if (role === 'user') {
            processed = this._stripSystemNotification(processed);
        } else if (role === 'assistant') {
            // 🌟 V4.3 修改：不再从向量化文本中剔除 @tag，将其视为正常上下文语义的一部分
            // const anchorRegex = /\[@(!)?([^\]]+)\]/g;
            // processed = processed.replace(anchorRegex, '');
        }

        // 2. 通用净化流程 (顺序必须严格一致)
        processed = this._stripHtml(processed);
        processed = this._stripEmoji(processed);
        processed = this._stripToolMarkers(processed);

        return processed.trim();
    }

    /**
     * 🌟 V4.1 新增：上下文日记去重 - 提取前缀索引
     * 扫描所有 assistant 消息中的 DailyNote create 工具调用，
     * 提取 Content 字段的前 80 个字符作为去重索引。
     * @param {Array} messages - 完整的消息数组
     * @returns {Set<string>} 去重前缀索引集合
     */
    _extractContextDiaryPrefixes(messages) {
        const prefixes = new Set();
        const PREFIX_LEN = 80;

        for (const msg of messages) {
            if (msg.role !== 'assistant') continue;

            const content = typeof msg.content === 'string'
                ? msg.content
                : (Array.isArray(msg.content) ? msg.content.find(p => p.type === 'text')?.text : '') || '';

            if (!content.includes('TOOL_REQUEST')) continue;

            // 匹配所有工具调用块
            const blockRegex = /<<<\[?TOOL_REQUEST\]?>>>([\s\S]*?)<<<\[?END_TOOL_REQUEST\]?>>>/gi;
            let blockMatch;
            while ((blockMatch = blockRegex.exec(content)) !== null) {
                const block = blockMatch[1];

                // 提取键值对（「始」...「末」格式）
                const kvRegex = /(\w+):\s*[「『]始[」』]([\s\S]*?)[「『]末[」』]/g;
                const fields = {};
                let kvMatch;
                while ((kvMatch = kvRegex.exec(block)) !== null) {
                    fields[kvMatch[1].toLowerCase()] = kvMatch[2].trim();
                }

                // 仅处理 DailyNote create 指令
                if (fields.tool_name?.toLowerCase() === 'dailynote' &&
                    fields.command?.toLowerCase() === 'create' &&
                    fields.content) {
                    const prefix = fields.content.substring(0, PREFIX_LEN).trim();
                    if (prefix.length > 0) {
                        prefixes.add(prefix);
                    }
                }
            }
        }

        if (prefixes.size > 0) {
            console.log(`[RAGDiaryPlugin] 🧹 Context Dedup: 从上下文提取了 ${prefixes.size} 条日记写入前缀索引`);
        }
        return prefixes;
    }

    /**
     * 🌟 V4.1 新增：上下文日记去重 - 过滤已在上下文中的召回结果
     * @param {Array} results - RAG 搜索结果数组 [{text, score, ...}]
     * @param {Set<string>} prefixes - 上下文日记前缀索引
     * @returns {Array} 过滤后的结果
     */
    _filterContextDuplicates(results, prefixes) {
        if (!prefixes || prefixes.size === 0 || !results || results.length === 0) {
            return results;
        }

        const PREFIX_LEN = 80;
        const before = results.length;

        const filtered = results.filter(r => {
            if (!r.text) return true;

            // 日记条目格式: "[2026-02-15] - 角色名\n[14:00] 内容..."
            // 需要跳过日期头 "[yyyy-MM-dd] - name\n" 来匹配 Content 字段
            let body = r.text.trim();
            const headerMatch = body.match(/^\[\d{4}-\d{2}-\d{2}\]\s*-\s*.*?\n/);
            if (headerMatch) {
                body = body.substring(headerMatch[0].length);
            }

            const resultPrefix = body.substring(0, PREFIX_LEN).trim();
            if (resultPrefix.length === 0) return true;

            // 前缀匹配：检查 resultPrefix 是否与任一上下文前缀的开头相同
            for (const ctxPrefix of prefixes) {
                // 取两者较短长度进行比较
                const compareLen = Math.min(resultPrefix.length, ctxPrefix.length);
                if (compareLen > 10 && resultPrefix.substring(0, compareLen) === ctxPrefix.substring(0, compareLen)) {
                    return false; // 命中去重，过滤掉
                }
            }
            return true;
        });

        const removed = before - filtered.length;
        if (removed > 0) {
            console.log(`[RAGDiaryPlugin] 🧹 Context Dedup: 过滤了 ${removed} 条与上下文工具调用重复的召回结果`);
        }
        return filtered;
    }

    /**
     * 更精确的 Base64 检测函数
     * @param {string} str - 要检测的字符串
     * @returns {boolean} 是否可能是 Base64 数据
     */
    _isLikelyBase64(str) {
        if (!str || str.length < 100) return false;

        // Base64 特征检测
        const sample = str.substring(0, 200);

        // 1. 检查是否只包含 Base64 字符
        if (!/^[A-Za-z0-9+/=]+$/.test(sample)) return false;

        // 2. 检查长度是否合理（Base64 通常是 4 的倍数）
        if (str.length % 4 !== 0 && str.length % 4 !== 2 && str.length % 4 !== 3) return false;

        // 3. 检查字符多样性（真正的文本不太可能有这么高的字符密度）
        const uniqueChars = new Set(sample).size;
        if (uniqueChars > 50) return true; // Base64 通常有 60+ 种不同字符

        // 4. 长度超过 500 且符合格式，大概率是 Base64
        return str.length > 500;
    }

    /**
     * 将 JSON 对象转换为 Markdown 文本，减少向量噪音
     * @param {any} obj - 要转换的对象
     * @param {number} depth - 当前递归深度
     * @returns {string}
     */
    _jsonToMarkdown(obj, depth = 0) {
        if (obj === null || obj === undefined) return '';
        if (typeof obj !== 'object') return String(obj);

        let md = '';
        const indent = '  '.repeat(depth);

        if (Array.isArray(obj)) {
            for (const item of obj) {
                // 特殊处理 VCP 的 content part 格式: [{"type":"text", "text":"..."}]
                if (item && typeof item === 'object' && item.type === 'text' && item.text) {
                    // ✅ 新增：检查 text 内容是否包含嵌套 JSON
                    let textContent = item.text;

                    // 尝试提取并解析嵌套的 JSON - 改进的正则表达式
                    const jsonMatch = textContent.match(/:\s*\n(\{[\s\S]*?\}|\[[\s\S]*?\])\s*$/);
                    if (jsonMatch) {
                        try {
                            const nestedJson = JSON.parse(jsonMatch[1]);
                            // 将前缀文字 + 递归解析的 JSON 内容合并
                            const prefix = textContent.substring(0, jsonMatch.index + 1).trim();
                            const nestedMd = this._jsonToMarkdown(nestedJson, depth + 1);
                            md += `${prefix}\n${nestedMd}\n`;
                            continue;
                        } catch (e) {
                            // 解析失败，使用原始文本
                            console.debug('[RAGDiaryPlugin] Failed to parse nested JSON in text content:', e.message);
                        }
                    }

                    // ✅ 新增：检查是否有内联 JSON（不在行尾的情况）
                    const inlineJsonMatch = textContent.match(/(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}|\[[^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*\])/);
                    if (inlineJsonMatch && inlineJsonMatch[0].length > 50) {
                        try {
                            const inlineJson = JSON.parse(inlineJsonMatch[0]);
                            const beforeJson = textContent.substring(0, inlineJsonMatch.index).trim();
                            const afterJson = textContent.substring(inlineJsonMatch.index + inlineJsonMatch[0].length).trim();
                            const inlineMd = this._jsonToMarkdown(inlineJson, depth + 1);

                            md += `${beforeJson}\n${inlineMd}`;
                            if (afterJson) md += `\n${afterJson}`;
                            md += '\n';
                            continue;
                        } catch (e) {
                            // 解析失败，使用原始文本
                            console.debug('[RAGDiaryPlugin] Failed to parse inline JSON in text content:', e.message);
                        }
                    }

                    md += `${textContent}\n`;
                } else if (typeof item !== 'object') {
                    md += `${indent}- ${item}\n`;
                } else {
                    md += `${this._jsonToMarkdown(item, depth)}\n`;
                }
            }
        } else {
            for (const [key, value] of Object.entries(obj)) {
                if (value === null || value === undefined) continue;

                if (typeof value === 'object') {
                    const subContent = this._jsonToMarkdown(value, depth + 1);
                    if (subContent.trim()) {
                        md += `${indent}# ${key}:\n${subContent}`;
                    }
                } else {
                    // ✅ 改进：检查字符串值是否包含嵌套 JSON
                    const valStr = String(value);

                    // 先检查是否是 Base64 数据
                    if (valStr.length > 200 && (valStr.includes('base64') || this._isLikelyBase64(valStr))) {
                        md += `${indent}* **${key}**: [Data Omitted]\n`;
                        continue;
                    }

                    // 检查是否包含 JSON 结构
                    if (valStr.length > 100 && (valStr.includes('{') || valStr.includes('['))) {
                        const nestedJsonMatch = valStr.match(/^(.*?)(\{[\s\S]*\}|\[[\s\S]*\])(.*)$/);
                        if (nestedJsonMatch) {
                            try {
                                const nestedJson = JSON.parse(nestedJsonMatch[2]);
                                const prefix = nestedJsonMatch[1].trim();
                                const suffix = nestedJsonMatch[3].trim();
                                const nestedMd = this._jsonToMarkdown(nestedJson, depth + 1);

                                md += `${indent}* **${key}**: `;
                                if (prefix) md += `${prefix} `;
                                md += `\n${nestedMd}`;
                                if (suffix) md += `${indent}  ${suffix}\n`;
                                continue;
                            } catch (e) {
                                // 解析失败，使用原始文本
                                console.debug(`[RAGDiaryPlugin] Failed to parse nested JSON in field "${key}":`, e.message);
                            }
                        }
                    }

                    // 默认处理
                    md += `${indent}* **${key}**: ${valStr}\n`;
                }
            }
        }
        return md;
    }

    /**
     * 🌟 V4.2 新增：RoleValve 语义解析与逻辑判断
     * 基于上下文消息角色数量判断是否激活
     */
    _evaluateRoleValve(modifiers, messages) {
        if (!modifiers.includes('::RoleValve')) return true;

        const valveMatch = modifiers.match(/::RoleValve(@[\w|&@<>=!]+)/);
        if (!valveMatch) return true;

        const fullExpression = valveMatch[1];

        // 1. 统计各角色消息数量
        const counts = messages.reduce((acc, msg) => {
            let role = 'User';
            const rawRole = String(msg.role).toLowerCase();
            if (rawRole === 'assistant') role = 'Assistant';
            else if (rawRole === 'system') role = 'System';

            acc[role] = (acc[role] || 0) + 1;
            return acc;
        }, { User: 0, Assistant: 0, System: 0 });

        // 2. 解析与求值
        // 支持逻辑：& (AND), | (OR)
        // 优先级：单个条件 > & > |

        const evaluateCondition = (cond) => {
            const match = cond.trim().match(/^@?(User|Assistant|System)(?:([<>]=?|=)(\d+))?$/i);
            if (!match) return true;

            let [_, roleName, op, value] = match;
            roleName = roleName.charAt(0).toUpperCase() + roleName.slice(1).toLowerCase();
            const currentCount = counts[roleName] || 0;

            if (!op) return currentCount > 0;

            const targetValue = parseInt(value);
            switch (op) {
                case '<': return currentCount < targetValue;
                case '>': return currentCount > targetValue;
                case '<=': return currentCount <= targetValue;
                case '>=': return currentCount >= targetValue;
                case '=': return currentCount === targetValue;
                default: return true;
            }
        };

        // 处理 OR 组
        const orGroups = fullExpression.split('|');
        return orGroups.some(group => {
            // 处理 AND 组
            const andConditions = group.split('&');
            return andConditions.every(cond => evaluateCondition(cond));
        });
    }

    // processMessages 是 messagePreprocessor 的标准接口
    async processMessages(messages, pluginConfig) {
        try {
            // ✅ 新增：更新上下文向量映射（为后续衰减聚合做准备）
            // 🌟 修复：传递 allowApi 配置，控制是否允许向量化历史消息
            await this.contextVectorManager.updateContext(messages, { allowApi: this.contextVectorAllowApi });

            // 🌟 V2折叠：将上下文中的消息 hash+vector 同步写入 FoldingStore
            if (this.foldingStore) {
                this._syncContextToFoldingStore(messages);
            }

            const collectedAttachments = []; // 🌟 V7: 用于收集 ::Base64Memo 触发的附件

            // V3.0: 支持多system消息处理
            // 1. 识别所有需要处理的 system 消息（包括日记本、元思考和全局AIMemo开关）
            let isAIMemoLicensed = false; // <--- AIMemo许可证 [[AIMemo=True]] 检测标志
            const targetSystemMessageIndices = messages.reduce((acc, m, index) => {
                if (m.role === 'system' && typeof m.content === 'string') {
                    // 检查全局 AIMemo 开关
                    if (m.content.includes('[[AIMemo=True]]')) {
                        isAIMemoLicensed = true;
                        console.log('[RAGDiaryPlugin] AIMemo license [[AIMemo=True]] detected. ::AIMemo modifier is now active.');
                    }

                    // 检查 RAG/Meta/AIMemo 占位符
                    if (/\[\[.*日记本.*\]\]|<<.*日记本.*>>|《《.*日记本.*》》|\{\{.*日记本.*\}\}|\[\[VCP元思考.*\]\]|\[\[AIMemo=True\]\]/.test(m.content)) {
                        // 确保每个包含占位符的 system 消息都被处理
                        if (!acc.includes(index)) {
                            acc.push(index);
                        }
                    }
                }
                return acc;
            }, []);

            // 如果没有找到任何需要处理的 system 消息，则直接返回
            if (targetSystemMessageIndices.length === 0) {
                return messages;
            }

            // 2. 准备共享资源 (V3.3: 精准上下文提取)
            // 始终寻找最后一个用户消息和最后一个AI消息，以避免注入污染。
            // V3.4: 跳过特殊的 "系统邀请指令" user 消息
            const lastUserMessageIndex = messages.findLastIndex(m => {
                if (m.role !== 'user') {
                    return false;
                }
                const content = typeof m.content === 'string'
                    ? m.content
                    : (Array.isArray(m.content) ? m.content.find(p => p.type === 'text')?.text : '') || '';
                return !content.startsWith('[系统邀请指令:]') && !content.trim().startsWith('[系统提示:]无内容');
            });
            const lastAiMessageIndex = messages.findLastIndex(m => m.role === 'assistant');

            let userContent = '';
            let aiContent = null;

            if (lastUserMessageIndex > -1) {
                const lastUserMessage = messages[lastUserMessageIndex];
                userContent = typeof lastUserMessage.content === 'string'
                    ? lastUserMessage.content
                    : (Array.isArray(lastUserMessage.content) ? lastUserMessage.content.find(p => p.type === 'text')?.text : '') || '';
            }

            if (lastAiMessageIndex > -1) {
                const lastAiMessage = messages[lastAiMessageIndex];
                aiContent = typeof lastAiMessage.content === 'string'
                    ? lastAiMessage.content
                    : (Array.isArray(lastAiMessage.content) ? lastAiMessage.content.find(p => p.type === 'text')?.text : '') || '';
            }

            // V3.1: 在向量化之前，清理userContent和aiContent中的HTML标签和emoji
            if (userContent) {
                const originalUserContent = userContent;
                userContent = this.sanitizeForEmbedding(userContent, 'user');
                if (originalUserContent.length !== userContent.length) {
                    console.log('[RAGDiaryPlugin] User content was sanitized (SystemNotification + HTML + Emoji removed).');
                }
            }
            // 🌟 V6: 解析并剥离 AI 锚点 (Ghost Nodes)
            const anchorRegex = /\[@(!)?([^\]]+)\]/g;
            const hardTagNames = [];
            const softTagNames = [];
            let anchorMatch;

            if (aiContent) {
                // 在净化之前提取锚点信息
                let tempAiContent = aiContent;
                while ((anchorMatch = anchorRegex.exec(tempAiContent)) !== null) {
                    const tagName = anchorMatch[2].trim();
                    if (Array.from(tagName).length > 25) continue; // 防幻觉截断

                    // 🌟 屏蔽示例标签
                    if (tagName === 'tag' || tagName === 'tag名称') continue;

                    if (anchorMatch[1]) hardTagNames.push(tagName);
                    else softTagNames.push(tagName);
                }

                // 🌟 V4.3 修改：不再从原始消息中擦除 @tag，允许 AI 在后续上下文中看到自己生成的标签以维持思想连贯性
                /*
                if (lastAiMessageIndex > -1) {
                    const aiMsg = messages[lastAiMessageIndex];
                    if (typeof aiMsg.content === 'string') {
                        aiMsg.content = aiMsg.content.replace(anchorRegex, '').trim();
                    } else if (Array.isArray(aiMsg.content)) {
                        const textPart = aiMsg.content.find(p => p.type === 'text');
                        if (textPart) textPart.text = textPart.text.replace(anchorRegex, '').trim();
                    }
                }
                */

                const originalAiContent = aiContent;
                aiContent = this.sanitizeForEmbedding(aiContent, 'assistant');
                if (originalAiContent.length !== aiContent.length) {
                    console.log('[RAGDiaryPlugin] AI content was sanitized (HTML + Emoji removed).');
                }
            }

            // 准备幽灵节点（并发请求，提升速度）
            const [hardGhostObjects, softGhostObjects] = await Promise.all([
                this._resolveGhostAnchors(hardTagNames, true),
                this._resolveGhostAnchors(softTagNames, false)
            ]);
            const ghostTags = [...hardGhostObjects, ...softGhostObjects];

            // V3.5: 为 VCP Info 创建一个更清晰的组合查询字符串
            const combinedQueryForDisplay = aiContent
                ? `[AI]: ${aiContent}\n[User]: ${userContent}`
                : userContent;

            console.log(`[RAGDiaryPlugin] 🌟 恢复加权平均向量逻辑：分别向量化用户和AI意图...`);
            // 🌟 恢复加权平均逻辑，并支持从 rag_params 动态读取权重
            const config = this.ragParams?.RAGDiaryPlugin || {};
            const mainWeights = config.mainSearchWeights || [0.7, 0.3]; // 默认 用户0.7 : AI 0.3

            const [userVector, aiVector] = await Promise.all([
                userContent ? this.getSingleEmbeddingCached(userContent) : Promise.resolve(null),
                aiContent ? this.getSingleEmbeddingCached(aiContent) : Promise.resolve(null)
            ]);

            const queryVector = this._getWeightedAverageVector([userVector, aiVector], mainWeights);

            if (!queryVector) {
                // 检查是否是系统提示导致的空内容（这是正常情况）
                const isSystemPrompt = !userContent || userContent.length === 0;
                if (isSystemPrompt) {
                    console.log('[RAGDiaryPlugin] 检测到系统提示消息，无需向量化，跳过RAG处理。');
                } else {
                    console.error('[RAGDiaryPlugin] 查询向量化失败，跳过RAG处理。');
                    console.error('[RAGDiaryPlugin] userContent length:', userContent?.length);
                    console.error('[RAGDiaryPlugin] aiContent length:', aiContent?.length);
                }
                // 安全起见，移除所有占位符
                const newMessages = JSON.parse(JSON.stringify(messages));
                for (const index of targetSystemMessageIndices) {
                    newMessages[index].content = newMessages[index].content
                        .replace(/\[\[.*日记本.*\]\]/g, '')
                        .replace(/<<.*日记本>>/g, '')
                        .replace(/《《.*日记本.*》》/g, '');
                }
                return newMessages;
            }

            // 🌟 V3 增强：计算动态参数 (K, TagWeight)
            const dynamicParams = await this._calculateDynamicParams(queryVector, userContent, aiContent);

            // 🌟 Tagmemo V4: 获取上下文分段 (Segments)
            // 结合当前查询向量和历史主题分段，形成"霰弹枪"查询阵列
            const historySegments = this.contextVectorManager.segmentContext(messages);
            if (historySegments.length > 0) {
                console.log(`[RAGDiaryPlugin] Tagmemo V4: Detected ${historySegments.length} history segments.`);
            }

            const combinedTextForTimeParsing = [userContent, aiContent].filter(Boolean).join('\n');
            const timeRanges = this.timeParser.parse(combinedTextForTimeParsing);

            // 🌟 V4.1: 上下文日记去重 - 提取当前上下文中所有 DailyNote create 的 Content 前缀
            const contextDiaryPrefixes = this._extractContextDiaryPrefixes(messages);

            // 3. 循环处理每个识别到的 system 消息
            const newMessages = JSON.parse(JSON.stringify(messages));
            const globalProcessedDiaries = new Set(); // 在最外层维护一个 Set
            // 🌟 优化：并发处理所有目标 system 消息，显著提升多日记本场景下的 Rerank 速度
            await Promise.all(targetSystemMessageIndices.map(async (index) => {
                console.log(`[RAGDiaryPlugin] Processing system message at index: ${index}`);
                const systemMessage = newMessages[index];

                // 调用新的辅助函数处理单个消息
                const processedContent = await this._processSingleSystemMessage(
                    systemMessage.content,
                    queryVector,
                    userContent, // 传递 userContent 用于语义组和时间解析
                    aiContent, // 传递 aiContent 用于 AIMemo
                    combinedQueryForDisplay, // V3.5: 传递组合后的查询字符串用于广播
                    dynamicParams.k,
                    timeRanges,
                    globalProcessedDiaries, // 传递全局 Set
                    isAIMemoLicensed, // 新增：AIMemo许可证
                    dynamicParams.tagWeight, // 🌟 传递动态 Tag 权重
                    dynamicParams.tagTruncationRatio, // 🌟 传递动态截断比例
                    dynamicParams.metrics, // 传递指标用于日志
                    historySegments, // 🌟 Tagmemo V4: 传递历史分段
                    contextDiaryPrefixes, // 🌟 V4.1: 传递上下文日记去重前缀
                    messages, // 🌟 V4.2: 传递完整消息用于 RoleValve
                    ghostTags, // 🌟 V6: 传递幽灵节点
                    collectedAttachments // 🌟 V7: 传递附件收集器
                );

                newMessages[index].content = processedContent;
            }));

            // 🌟 V7: 处理收集到的多模态附件
            if (collectedAttachments.length > 0) {
                // 限制数量，优先最近的（collectedAttachments 是按召回顺序添加的，通常 RAG 结果已经按相关性/时间排序）
                const limit = parseInt(process.env.BASE64_MEMO_LIMIT) || this.ragParams?.RAGDiaryPlugin?.base64MemoLimit || 5;
                const uniqueAttachments = [...new Set(collectedAttachments)].slice(0, limit);
                const base64DataArray = [];

                console.log(`[RAGDiaryPlugin] 🌟 V7: 开始处理 ${uniqueAttachments.length} 个多模态附件 (限制: ${limit})`);

                for (const url of uniqueAttachments) {
                    const b64 = await this._fetchAsBase64(url);
                    if (b64) {
                        base64DataArray.push(b64);
                    }
                }

                if (base64DataArray.length > 0) {
                    // 找到第一个用户消息（楼层最上面那个）
                    const firstUserMsg = newMessages.find(m => m.role === 'user');
                    if (firstUserMsg) {
                        const note = `[召回${base64DataArray.length}个日记多模态数据]`;

                        if (typeof firstUserMsg.content === 'string') {
                            const originalText = firstUserMsg.content;
                            firstUserMsg.content = [
                                { type: 'text', text: originalText + ' ' + note }
                            ];
                        } else if (Array.isArray(firstUserMsg.content)) {
                            const textPart = firstUserMsg.content.find(p => p.type === 'text');
                            if (textPart) {
                                textPart.text += ' ' + note;
                            } else {
                                firstUserMsg.content.push({ type: 'text', text: note });
                            }
                        }

                        // 添加 base64 数据到 content 数组
                        for (const b64 of base64DataArray) {
                            firstUserMsg.content.push({
                                type: 'image_url',
                                image_url: { url: b64 }
                            });
                        }
                        console.log(`[RAGDiaryPlugin] 🌟 V7: 已向首条用户消息注入 ${base64DataArray.length} 个多模态附件`);
                    }
                }
            }

            return newMessages;
        } catch (error) {
            console.error('[RAGDiaryPlugin] processMessages 发生严重错误:', error);
            console.error('[RAGDiaryPlugin] Error stack:', error.stack);
            console.error('[RAGDiaryPlugin] Error name:', error.name);
            console.error('[RAGDiaryPlugin] Error message:', error.message);
            // 返回原始消息，移除占位符以避免二次错误
            const safeMessages = JSON.parse(JSON.stringify(messages));
            safeMessages.forEach(msg => {
                if (msg.role === 'system' && typeof msg.content === 'string') {
                    msg.content = msg.content
                        .replace(/\[\[.*日记本.*\]\]/g, '[RAG处理失败]')
                        .replace(/<<.*日记本>>/g, '[RAG处理失败]')
                        .replace(/《《.*日记本.*》》/g, '[RAG处理失败]')
                        .replace(/\{\{.*日记本\}\}/g, '[RAG处理失败]');
                }
            });
            return safeMessages;
        }
    }

    // V3.0 新增: 处理单条 system 消息内容的辅助函数
    async _processSingleSystemMessage(content, queryVector, userContent, aiContent, combinedQueryForDisplay, dynamicK, timeRanges, processedDiaries, isAIMemoLicensed, dynamicTagWeight = 0.15, tagTruncationRatio = 0.5, metrics = {}, historySegments = [], contextDiaryPrefixes = new Set(), messages = [], ghostTags = [], collectedAttachments = []) {
        if (!this.pushVcpInfo) {
            console.warn('[RAGDiaryPlugin] _processSingleSystemMessage: pushVcpInfo is null. Cannot broadcast RAG details.');
        }
        let processedContent = content;

        // 移除全局 AIMemo 开关占位符，因为它只作为许可证，不应出现在最终输出中
        processedContent = processedContent.replace(/\[\[AIMemo=True\]\]/g, '');

        const ragDeclarations = [...processedContent.matchAll(/\[\[(.*?)日记本(.*?)\]\]/g)];
        const fullTextDeclarations = [...processedContent.matchAll(/<<(.*?)日记本(.*?)>>/g)];
        const hybridDeclarations = [...processedContent.matchAll(/《《(.*?)日记本(.*?)》》/g)];
        const metaThinkingDeclarations = [...processedContent.matchAll(/\[\[VCP元思考(.*?)\]\]/g)];
        const directDiariesDeclarations = [...processedContent.matchAll(/\{\{(.*?)日记本(.*?)\}\}/g)];
        console.log(`[RAGDiaryPlugin] Found ${directDiariesDeclarations.length} {{...}} declarations`);
        // --- 1. 处理 [[VCP元思考...]] 元思考链 ---
        for (const match of metaThinkingDeclarations) {
            const placeholder = match[0];
            const modifiersAndParams = match[1] || '';

            // 静默处理元思考占位符

            // 解析参数：链名称和修饰符
            // 格式: [[VCP元思考:<链名称>::<修饰符>]]
            // 示例: [[VCP元思考:creative_writing::Group]]
            //      [[VCP元思考::Group]]  (使用默认链)
            //      [[VCP元思考::Auto::Group]]  (自动模式)

            let chainName = 'default';
            let useGroup = false;
            let isAutoMode = false;
            let autoThreshold = 0.65; // 默认自动切换阈值

            // 分析修饰符字符串
            if (modifiersAndParams) {
                // 移除开头的所有冒号，然后按 :: 分割
                const parts = modifiersAndParams.replace(/^:+/, '').split('::').map(p => p.trim()).filter(Boolean);

                for (const part of parts) {
                    const lowerPart = part.toLowerCase();

                    if (lowerPart.startsWith('auto')) {
                        isAutoMode = true;
                        const thresholdMatch = part.match(/:(\d+\.?\d*)/);
                        if (thresholdMatch) {
                            const parsedThreshold = parseFloat(thresholdMatch[1]);
                            if (!isNaN(parsedThreshold)) {
                                autoThreshold = parsedThreshold;
                            }
                        }
                        // 在自动模式下，链名称将由auto逻辑决定
                        chainName = 'default';
                    } else if (lowerPart === 'group') {
                        useGroup = true;
                    } else if (part) {
                        // 如果不是 Auto 模式，才接受指定的链名称
                        if (!isAutoMode) {
                            chainName = part;
                        }
                    }
                }
            }

            // 参数已解析，开始处理

            try {
                const metaResult = await this.metaThinkingManager.processMetaThinkingChain(
                    chainName,
                    queryVector,
                    userContent,
                    aiContent,
                    combinedQueryForDisplay,
                    null, // kSequence现在从JSON配置中获取，不再从占位符传递
                    useGroup,
                    isAutoMode,
                    autoThreshold
                );

                processedContent = processedContent.replace(placeholder, metaResult);
                // 元思考链处理完成（静默）
            } catch (error) {
                console.error(`[RAGDiaryPlugin] 处理VCP元思考链时发生错误:`, error);
                processedContent = processedContent.replace(
                    placeholder,
                    `[VCP元思考链处理失败: ${error.message}]`
                );
            }
        }

        // --- 收集所有 AIMemo 请求以便聚合处理 ---
        const aiMemoRequests = [];
        const processingPromises = [];

        // --- 1. 收集 [[...]] 中的 AIMemo 请求 ---
        for (const match of ragDeclarations) {
            const placeholder = match[0];
            const rawName = match[1];
            const modifiers = match[2] || '';

            // 🌟 V5: 解析聚合语法
            const aggregateInfo = this._parseAggregateSyntax(rawName, modifiers);

            if (aggregateInfo.isAggregate) {
                // --- 聚合模式 ---
                // 核心逻辑：只有在许可证存在的情况下，::AIMemo才生效
                const aiMemoMatch = modifiers.match(/::AIMemo(?::([\w-]+))?/);
                const shouldUseAIMemo = isAIMemoLicensed && !!aiMemoMatch;
                const presetName = aiMemoMatch ? aiMemoMatch[1] : null;

                // 🌟 V4.2: RoleValve 检查
                if (!this._evaluateRoleValve(modifiers, messages)) {
                    console.log(`[RAGDiaryPlugin] RoleValve blocked aggregate retrieval for: ${aggregateInfo.diaryNames.join('|')}`);
                    processingPromises.push(Promise.resolve({ placeholder, content: '' }));
                    continue;
                }

                if (shouldUseAIMemo) {
                    // AIMemo 聚合模式：将所有日记本名收集到 aiMemoRequests
                    console.log(`[RAGDiaryPlugin] 🌟 聚合AIMemo模式: ${aggregateInfo.diaryNames.join(', ')}${presetName ? ` (预设: ${presetName})` : ''}`);
                    for (const name of aggregateInfo.diaryNames) {
                        if (!processedDiaries.has(name)) {
                            aiMemoRequests.push({ placeholder: placeholder, dbName: name, presetName });
                        }
                    }
                } else {
                    // 标准聚合 RAG
                    processingPromises.push((async () => {
                        try {
                            const retrievedContent = await this._processAggregateRetrieval({
                                diaryNames: aggregateInfo.diaryNames,
                                kMultiplier: aggregateInfo.kMultiplier,
                                modifiers, queryVector, userContent, aiContent, combinedQueryForDisplay,
                                dynamicK, timeRanges,
                                defaultTagWeight: dynamicTagWeight,
                                tagTruncationRatio: tagTruncationRatio,
                                metrics: metrics,
                                historySegments: historySegments,
                                processedDiaries: processedDiaries,
                                contextDiaryPrefixes, // 🌟 V4.1
                                ghostTags, // 🌟 修复 3：补齐漏传的幽灵节点参数！
                                collectedAttachments // 🌟 V7
                            });
                            return { placeholder, content: retrievedContent };
                        } catch (error) {
                            console.error(`[RAGDiaryPlugin] 聚合检索处理失败:`, error);
                            return { placeholder, content: `[聚合检索处理失败: ${error.message}]` };
                        }
                    })());
                }
                continue; // 聚合模式处理完毕，跳过下面的单日记本逻辑
            }

            // --- 单日记本模式（原有逻辑） ---
            const dbName = aggregateInfo.diaryNames[0];

            if (processedDiaries.has(dbName)) {
                console.warn(`[RAGDiaryPlugin] Detected circular reference to "${dbName}" in [[...]]. Skipping.`);
                processingPromises.push(Promise.resolve({ placeholder, content: `[检测到循环引用，已跳过"${dbName}日记本"的解析]` }));
                continue;
            }
            processedDiaries.add(dbName);

            // 核心逻辑：只有在许可证存在的情况下，::AIMemo才生效
            const aiMemoMatch = modifiers.match(/::AIMemo(?::([\w-]+))?/);
            const shouldUseAIMemo = isAIMemoLicensed && !!aiMemoMatch;
            const presetName = aiMemoMatch ? aiMemoMatch[1] : null;

            // 🌟 V4.2: RoleValve 检查
            if (!this._evaluateRoleValve(modifiers, messages)) {
                console.log(`[RAGDiaryPlugin] RoleValve blocked [[${dbName}]] retrieval.`);
                processingPromises.push(Promise.resolve({ placeholder, content: '' }));
                continue;
            }

            if (shouldUseAIMemo) {
                console.log(`[RAGDiaryPlugin] AIMemo licensed and activated for "${dbName}"${presetName ? ` (预设: ${presetName})` : ''}. Overriding other RAG modes.`);
                aiMemoRequests.push({ placeholder, dbName, presetName });
            } else {
                // 标准 RAG 立即处理
                processingPromises.push((async () => {
                    try {
                        const retrievedContent = await this._processRAGPlaceholder({
                            dbName, modifiers, queryVector, userContent, aiContent, combinedQueryForDisplay,
                            dynamicK, timeRanges, allowTimeAndGroup: true,
                            defaultTagWeight: dynamicTagWeight, // 🌟 传入动态权重
                            tagTruncationRatio: tagTruncationRatio, // 🌟 传入截断比例
                            metrics: metrics,
                            historySegments: historySegments, // 🌟 传入历史分段
                            contextDiaryPrefixes, // 🌟 V4.1: 传入上下文日记去重前缀
                            ghostTags, // 🌟 V6: 传入幽灵节点
                            collectedAttachments // 🌟 V7
                        });
                        return { placeholder, content: retrievedContent };
                    } catch (error) {
                        console.error(`[RAGDiaryPlugin] 处理占位符时出错 (${dbName}):`, error);
                        return { placeholder, content: `[处理失败: ${error.message}]` };
                    }
                })());
            }
        }

        // --- 2. 准备 <<...>> RAG 全文检索任务 ---
        for (const match of fullTextDeclarations) {
            const placeholder = match[0];
            const dbName = match[1];
            const modifiers = match[2] || '';

            // 🌟 V4.2: RoleValve 检查 - 无论判定结果如何，都必须替换占位符
            if (!this._evaluateRoleValve(modifiers, messages)) {
                console.log(`[RAGDiaryPlugin] RoleValve blocked <<${dbName}>> retrieval.`);
                // 关键修复：将空内容加入处理队列，确保占位符被替换
                processingPromises.push(Promise.resolve({ placeholder, content: '' }));
                continue;
            }

            if (processedDiaries.has(dbName)) {
                console.warn(`[RAGDiaryPlugin] Detected circular reference to "${dbName}" in <<...>>. Skipping.`);
                processingPromises.push(Promise.resolve({ placeholder, content: `[检测到循环引用，已跳过"${dbName}日记本"的解析]` }));
                continue;
            }
            processedDiaries.add(dbName);

            // ✅ 新增：为<<>>模式生成缓存键
            const cacheKey = this._generateCacheKey({
                userContent,
                aiContent: aiContent || '',
                dbName,
                modifiers: '', // 全文模式无修饰符
                dynamicK
            });

            // ✅ 尝试从缓存获取
            const cachedResult = this._getCachedResult(cacheKey);
            if (cachedResult) {
                processingPromises.push(Promise.resolve({ placeholder, content: cachedResult.content }));
                continue; // ⭐ 跳过后续的阈值判断和内容读取
            }

            processingPromises.push((async () => {
                const diaryConfig = this.ragConfig[dbName] || {};
                const localThreshold = diaryConfig.threshold || GLOBAL_SIMILARITY_THRESHOLD;
                const dbNameVector = await this.vectorDBManager.getDiaryNameVector(dbName); // <--- 使用缓存
                if (!dbNameVector) {
                    console.warn(`[RAGDiaryPlugin] Could not find cached vector for diary name: "${dbName}". Skipping.`);
                    const emptyResult = '';
                    this._setCachedResult(cacheKey, { content: emptyResult }); // ✅ 缓存空结果
                    return { placeholder, content: emptyResult };
                }

                const baseSimilarity = this.cosineSimilarity(queryVector, dbNameVector);
                const enhancedVector = this.enhancedVectorCache[dbName];
                const enhancedSimilarity = enhancedVector ? this.cosineSimilarity(queryVector, enhancedVector) : 0;
                const finalSimilarity = Math.max(baseSimilarity, enhancedSimilarity);

                if (finalSimilarity >= localThreshold) {
                    const diaryContent = await this.getDiaryContent(dbName);
                    const safeContent = diaryContent
                        .replace(/\[\[.*日记本.*\]\]/g, '[循环占位符已移除]')
                        .replace(/<<.*日记本>>/g, '[循环占位符已移除]')
                        .replace(/《《.*日记本.*》》/g, '[循环占位符已移除]')
                        .replace(/\{\{.*日记本\}\}/g, '[循环占位符已移除]');

                    if (this.pushVcpInfo) {
                        this.pushVcpInfo({
                            type: 'DailyNote',
                            action: 'FullTextRecall',
                            dbName: dbName,
                            message: `[RAGDiary] 已全文召回日记本：${dbName}，共 1 条全量记录`
                        });
                    }

                    // ✅ 缓存结果
                    this._setCachedResult(cacheKey, { content: safeContent });
                    return { placeholder, content: safeContent };
                }

                // ✅ 缓存空结果（阈值不匹配）
                const emptyResult = '';
                this._setCachedResult(cacheKey, { content: emptyResult });
                return { placeholder, content: emptyResult };
            })());
        }

        // --- 3. 收集 《《...》》 混合模式中的 AIMemo 请求 ---
        for (const match of hybridDeclarations) {
            const placeholder = match[0];
            const rawName = match[1];
            const modifiers = match[2] || '';

            // 🌟 V5: 解析聚合语法
            const aggregateInfo = this._parseAggregateSyntax(rawName, modifiers);

            if (aggregateInfo.isAggregate) {
                // --- 《《》》聚合模式 ---
                processingPromises.push((async () => {
                    try {
                        // 使用平均阈值进行相似度门控
                        const avgThreshold = this._getAverageThreshold(aggregateInfo.diaryNames);

                        // 计算聚合整体的相似度：取所有日记本的最大相似度
                        let maxSimilarity = 0;
                        // 🌟 V4.2: RoleValve 检查
                        if (!this._evaluateRoleValve(modifiers, messages)) {
                            console.log(`[RAGDiaryPlugin] RoleValve blocked hybrid aggregate retrieval for: ${aggregateInfo.diaryNames.join('|')}`);
                            return { placeholder, content: '' };
                        }

                        for (const name of aggregateInfo.diaryNames) {
                            try {
                                let diaryVec = this.enhancedVectorCache[name] || null;
                                if (!diaryVec) {
                                    diaryVec = await this.vectorDBManager.getDiaryNameVector(name);
                                }
                                if (diaryVec) {
                                    const sim = this.cosineSimilarity(queryVector, diaryVec);
                                    maxSimilarity = Math.max(maxSimilarity, sim);
                                }
                            } catch (e) {
                                console.warn(`[RAGDiaryPlugin] 《《》》聚合阈值检查: "${name}" 向量获取失败, 跳过`);
                            }
                        }

                        if (maxSimilarity < avgThreshold) {
                            console.log(`[RAGDiaryPlugin] 《《》》聚合模式: 最高相似度 (${maxSimilarity.toFixed(4)}) 低于平均阈值 (${avgThreshold.toFixed(4)})，跳过`);
                            return { placeholder, content: '' };
                        }

                        // 🌟 解析 Truncate 阈值并应用到聚合判断
                        const truncateThreshold = this._extractTruncateThreshold(modifiers);
                        if (truncateThreshold > 0 && maxSimilarity < truncateThreshold) {
                            console.log(`[RAGDiaryPlugin] 《《》》聚合模式: 最高相似度 (${maxSimilarity.toFixed(4)}) 低于 Truncate 阈值 (${truncateThreshold.toFixed(4)})，跳过召回`);
                            return { placeholder, content: '' };
                        }

                        console.log(`[RAGDiaryPlugin] 🌟 《《》》聚合模式: 通过阈值 (${maxSimilarity.toFixed(4)} >= ${Math.max(avgThreshold, truncateThreshold).toFixed(4)})，开始检索...`);

                        // AIMemo 检查
                        const aiMemoMatch = modifiers.match(/::AIMemo(?::([\w-]+))?/);
                        const shouldUseAIMemo = isAIMemoLicensed && !!aiMemoMatch;
                        const presetName = aiMemoMatch ? aiMemoMatch[1] : null;

                        if (shouldUseAIMemo) {
                            console.log(`[RAGDiaryPlugin] 🌟 《《》》聚合AIMemo模式: ${aggregateInfo.diaryNames.join(', ')}${presetName ? ` (预设: ${presetName})` : ''}`);
                            for (const name of aggregateInfo.diaryNames) {
                                if (!processedDiaries.has(name)) {
                                    aiMemoRequests.push({ placeholder: placeholder, dbName: name, presetName });
                                }
                            }
                            return { placeholder, content: '' };
                        }

                        // 标准聚合 RAG
                        const retrievedContent = await this._processAggregateRetrieval({
                            diaryNames: aggregateInfo.diaryNames,
                            kMultiplier: aggregateInfo.kMultiplier,
                            modifiers, queryVector, userContent, aiContent, combinedQueryForDisplay,
                            dynamicK, timeRanges,
                            defaultTagWeight: dynamicTagWeight,
                            tagTruncationRatio: tagTruncationRatio,
                            metrics: metrics,
                            historySegments: historySegments,
                            processedDiaries: processedDiaries,
                            contextDiaryPrefixes, // 🌟 V4.1
                            ghostTags, // 🌟 修复 3：补齐漏传的幽灵节点参数！
                            collectedAttachments // 🌟 V7
                        });
                        return { placeholder, content: retrievedContent };
                    } catch (error) {
                        console.error(`[RAGDiaryPlugin] 《《》》聚合检索处理失败:`, error);
                        return { placeholder, content: `[聚合检索处理失败: ${error.message}]` };
                    }
                })());
                continue; // 聚合模式处理完毕
            }

            // --- 单日记本模式（原有逻辑） ---
            const dbName = aggregateInfo.diaryNames[0];

            if (processedDiaries.has(dbName)) {
                console.warn(`[RAGDiaryPlugin] Detected circular reference to "${dbName}" in 《《...》》. Skipping.`);
                processingPromises.push(Promise.resolve({ placeholder, content: `[检测到循环引用，已跳过"${dbName}日记本"的解析]` }));
                continue;
            }
            processedDiaries.add(dbName);

            // ✅ 新增：为《《》》模式生成缓存键
            const cacheKey = this._generateCacheKey({
                userContent,
                aiContent: aiContent || '',
                dbName,
                modifiers,
                dynamicK
            });

            // ✅ 尝试从缓存获取
            const cachedResult = this._getCachedResult(cacheKey);
            if (cachedResult) {
                processingPromises.push(Promise.resolve({ placeholder, content: cachedResult.content }));
                continue; // ⭐ 跳过后续的阈值判断
            }

            processingPromises.push((async () => {
                try {
                    const diaryConfig = this.ragConfig[dbName] || {};
                    const localThreshold = diaryConfig.threshold || GLOBAL_SIMILARITY_THRESHOLD;
                    const dbNameVector = await this.vectorDBManager.getDiaryNameVector(dbName);
                    if (!dbNameVector) {
                        console.warn(`[RAGDiaryPlugin] Could not find cached vector for diary name: "${dbName}". Skipping.`);
                        const emptyResult = '';
                        this._setCachedResult(cacheKey, { content: emptyResult });
                        return { placeholder, content: emptyResult };
                    }

                    const baseSimilarity = this.cosineSimilarity(queryVector, dbNameVector);
                    const enhancedVector = this.enhancedVectorCache[dbName];
                    const enhancedSimilarity = enhancedVector ? this.cosineSimilarity(queryVector, enhancedVector) : 0;
                    const finalSimilarity = Math.max(baseSimilarity, enhancedSimilarity);

                    // 🌟 解析 Truncate 阈值
                    const truncateThreshold = this._extractTruncateThreshold(modifiers);

                    if (finalSimilarity >= localThreshold && finalSimilarity >= truncateThreshold) {
                        // 核心逻辑：只有在许可证存在的情况下，::AIMemo才生效
                        const aiMemoMatch = modifiers.match(/::AIMemo(?::([\w-]+))?/);
                        const shouldUseAIMemo = isAIMemoLicensed && !!aiMemoMatch;
                        const presetName = aiMemoMatch ? aiMemoMatch[1] : null;

                        // 🌟 V4.2: RoleValve 检查
                        if (!this._evaluateRoleValve(modifiers, messages)) {
                            console.log(`[RAGDiaryPlugin] RoleValve blocked hybrid [[${dbName}]] retrieval (threshold met).`);
                            return { placeholder, content: '' };
                        }

                        if (shouldUseAIMemo) {
                            console.log(`[RAGDiaryPlugin] AIMemo licensed and activated for "${dbName}" in hybrid mode${presetName ? ` (预设: ${presetName})` : ''}. Similarity: ${finalSimilarity.toFixed(4)} >= ${localThreshold}`);
                            // ✅ 修复：只有在阈值匹配时才收集 AIMemo 请求
                            aiMemoRequests.push({ placeholder, dbName, presetName });
                            return { placeholder, content: '' }; // ⚠️ AIMemo不缓存，因为聚合处理
                        } else {
                            // ✅ 混合模式也传递TagMemo参数
                            const retrievedContent = await this._processRAGPlaceholder({
                                dbName, modifiers, queryVector, userContent, aiContent, combinedQueryForDisplay,
                                dynamicK, timeRanges, allowTimeAndGroup: true,
                                defaultTagWeight: dynamicTagWeight, // 🌟 传入动态权重
                                tagTruncationRatio: tagTruncationRatio, // 🌟 传入截断比例
                                metrics: metrics,
                                historySegments: historySegments, // 🌟 传入历史分段
                                contextDiaryPrefixes, // 🌟 V4.1: 传入上下文日记去重前缀
                                ghostTags, // 🌟 V6: 传入幽灵节点
                                collectedAttachments // 🌟 V7
                            });

                            // ✅ 缓存结果（RAG已在内部缓存，这里是额外保险）
                            this._setCachedResult(cacheKey, { content: retrievedContent });
                            return { placeholder, content: retrievedContent };
                        }
                    } else {
                        // ✅ 修复：阈值不匹配时，即使有 ::AIMemo 修饰符也不处理
                        console.log(`[RAGDiaryPlugin] "${dbName}" similarity (${finalSimilarity.toFixed(4)}) below threshold (${localThreshold}). Skipping ${modifiers.includes('::AIMemo') ? 'AIMemo' : 'RAG'}.`);
                        const emptyResult = '';
                        this._setCachedResult(cacheKey, { content: emptyResult }); // ✅ 缓存空结果
                        return { placeholder, content: emptyResult };
                    }
                } catch (error) {
                    console.error(`[RAGDiaryPlugin] 处理混合模式占位符时出错 (${dbName}):`, error);
                    const errorResult = `[处理失败: ${error.message}]`;
                    this._setCachedResult(cacheKey, { content: errorResult }); // ✅ 缓存错误结果
                    return { placeholder, content: errorResult };
                }
            })());
        }

        // --- 4. 聚合处理所有 AIMemo 请求 ---
        if (aiMemoRequests.length > 0) {
            console.log(`[RAGDiaryPlugin] 检测到 ${aiMemoRequests.length} 个 AIMemo 请求，开始聚合处理...`);

            if (!this.aiMemoHandler) {
                console.error(`[RAGDiaryPlugin] AIMemoHandler未初始化`);
                aiMemoRequests.forEach(req => {
                    processingPromises.push(Promise.resolve({
                        placeholder: req.placeholder,
                        content: '[AIMemo功能未初始化，请检查配置]'
                    }));
                });
            } else {
                try {
                    // 聚合所有日记本名称
                    const dbNames = aiMemoRequests.map(r => r.dbName);
                    // 提取预设名称（假设同一批次使用相同的预设，或者取第一个）
                    const presetName = aiMemoRequests[0].presetName;
                    console.log(`[RAGDiaryPlugin] 聚合处理日记本: ${dbNames.join(', ')}${presetName ? ` (预设: ${presetName})` : ''}`);

                    // 调用聚合处理方法
                    const aggregatedResult = await this.aiMemoHandler.processAIMemoAggregated(
                        dbNames, userContent, aiContent, combinedQueryForDisplay, presetName
                    );

                    // 第一个返回完整结果，后续返回引用提示
                    aiMemoRequests.forEach((req, index) => {
                        if (index === 0) {
                            processingPromises.push(Promise.resolve({
                                placeholder: req.placeholder,
                                content: aggregatedResult
                            }));
                        } else {
                            processingPromises.push(Promise.resolve({
                                placeholder: req.placeholder,
                                content: `[AIMemo语义推理检索模式] 检索结果已在"${dbNames[0]}"日记本中合并展示，本次为跨库联合检索。`
                            }));
                        }
                    });
                } catch (error) {
                    console.error(`[RAGDiaryPlugin] AIMemo聚合处理失败:`, error);
                    aiMemoRequests.forEach(req => {
                        processingPromises.push(Promise.resolve({
                            placeholder: req.placeholder,
                            content: `[AIMemo处理失败: ${error.message}]`
                        }));
                    });
                }
            }
        }

        // --- 5. 处理 {{...日记本}} 直接引入模式 ---
        for (const match of directDiariesDeclarations) {
            const placeholder = match[0];
            const dbName = match[1];
            const modifiers = match[2] || '';

            console.log(`[RAGDiaryPlugin] Processing {{...}} placeholder: "${placeholder}", dbName: "${dbName}", modifiers: "${modifiers}"`);

            // 🌟 V4.2: RoleValve 检查 - 必须在所有其他检查之前执行
            const roleValveResult = this._evaluateRoleValve(modifiers, messages);
            console.log(`[RAGDiaryPlugin] RoleValve result for {{${dbName}}}: ${roleValveResult}`);

            if (!roleValveResult) {
                console.log(`[RAGDiaryPlugin] RoleValve blocked {{${dbName}}} retrieval. Adding empty content to processing queue.`);
                // 关键修复：将空内容加入处理队列，确保占位符被替换
                processingPromises.push(Promise.resolve({ placeholder, content: '' }));
                console.log(`[RAGDiaryPlugin] processingPromises length after adding: ${processingPromises.length}`);
                continue;
            }

            if (processedDiaries.has(dbName)) {
                console.warn(`[RAGDiaryPlugin] Detected circular reference to "${dbName}" in {{...}}. Skipping.`);
                processingPromises.push(Promise.resolve({ placeholder, content: `[检测到循环引用，已跳过"${dbName}日记本"的解析]` }));
                continue;
            }
            // 标记以防其他模式循环
            processedDiaries.add(dbName);

            // 直接获取内容，跳过阈值判断
            processingPromises.push((async () => {
                try {
                    const diaryContent = await this.getDiaryContent(dbName);
                    const safeContent = diaryContent
                        .replace(/\[\[.*日记本.*\]\]/g, '[循环占位符已移除]')
                        .replace(/<<.*日记本>>/g, '[循环占位符已移除]')
                        .replace(/《《.*日记本.*》》/g, '[循环占位符已移除]')
                        .replace(/\{\{.*日记本\}\}/g, '[循环占位符已移除]');

                    if (this.pushVcpInfo) {
                        this.pushVcpInfo({
                            type: 'DailyNote',
                            action: 'DirectRecall',
                            dbName: dbName,
                            message: `[RAGDiary] 已直接引入日记本：${dbName}，共 1 条全量记录`
                        });
                    }

                    return { placeholder, content: safeContent };
                } catch (error) {
                    console.error(`[RAGDiaryPlugin] 处理 {{...日记本}} 直接引入模式出错 (${dbName}):`, error);
                    return { placeholder, content: `[处理失败: ${error.message}]` };
                }
            })());
        }

        // --- 执行所有任务并替换内容 ---
        console.log(`[RAGDiaryPlugin] Total processing promises: ${processingPromises.length}`);
        const results = await Promise.all(processingPromises);
        console.log(`[RAGDiaryPlugin] Total results to replace: ${results.length}`);

        for (const result of results) {
            const beforeLength = processedContent.length;
            processedContent = processedContent.replace(result.placeholder, result.content);
            const afterLength = processedContent.length;

            if (beforeLength === afterLength && result.placeholder.length > 0) {
                console.warn(`[RAGDiaryPlugin] ⚠️ Placeholder not found in content: "${result.placeholder.substring(0, 50)}..."`);
            } else {
                console.log(`[RAGDiaryPlugin] ✓ Replaced placeholder: "${result.placeholder.substring(0, 50)}..." with ${result.content.length} chars`);
            }
        }

        return processedContent;
    }

    _extractTruncateThreshold(modifiers) {
        if (!modifiers) return 0;
        const truncateMatch = modifiers.match(/::Truncate(\d+\.?\d*)/);
        return truncateMatch ? parseFloat(truncateMatch[1]) : 0;
    }

    _extractKMultiplier(modifiers) {
        const kMultiplierMatch = modifiers.match(/:(\d+\.?\d*)/);
        return kMultiplierMatch ? parseFloat(kMultiplierMatch[1]) : 1.0;
    }

    //####################################################################################
    //## 🌟 V5 日记聚合检索 (Diary Aggregate Retrieval)
    //####################################################################################

    /**
     * 解析聚合语法：从 rawName 中拆分多日记本名列表和 kMultiplier
     * 语法: "物理|政治|python:1.2" → { diaryNames: ['物理','政治','python'], kMultiplier: 1.2, isAggregate: true }
     * 单日记本: "物理" → { diaryNames: ['物理'], kMultiplier: 1.0, isAggregate: false }
     * @param {string} rawName - 日记本名部分（`日记本`关键字前的所有内容）
     * @param {string} modifiers - 修饰符部分（`日记本`关键字后的所有内容）
     * @returns {{ diaryNames: string[], kMultiplier: number, isAggregate: boolean, cleanedModifiers: string }}
     */
    _parseAggregateSyntax(rawName, modifiers) {
        // 检查是否包含 | 分隔符 → 聚合模式
        if (!rawName.includes('|')) {
            return {
                diaryNames: [rawName],
                kMultiplier: this._extractKMultiplier(modifiers),
                isAggregate: false,
                cleanedModifiers: modifiers
            };
        }

        // 聚合模式: 按 | 拆分，所有部分都是日记本名
        const diaryNames = rawName.split('|').map(p => p.trim()).filter(Boolean);
        // kMultiplier 统一从 modifiers 的 :1.5 提取，保持与单日记本语法一致
        const kMultiplier = this._extractKMultiplier(modifiers);

        // 至少需要 2 个日记本名才算聚合
        if (diaryNames.length < 2) {
            return {
                diaryNames: diaryNames,
                kMultiplier: kMultiplier,
                isAggregate: false,
                cleanedModifiers: modifiers
            };
        }

        console.log(`[RAGDiaryPlugin] 🌟 聚合检索语法解析成功: 日记本=[${diaryNames.join(', ')}], K倍率=${kMultiplier}`);

        return {
            diaryNames: diaryNames,
            kMultiplier: kMultiplier,
            isAggregate: true,
            cleanedModifiers: modifiers
        };
    }

    /**
     * 🌟 聚合检索核心调度器
     * 根据上下文向量与各日记本向量的余弦相似度，通过 Softmax 归一化动态分配 K 值，
     * 然后并行调用各子日记本的 _processRAGPlaceholder，最后聚合结果。
     *
     * @param {object} options - 包含所有必要参数
     * @returns {Promise<string>} 聚合后的检索结果
     */
    async _processAggregateRetrieval(options) {
        const {
            diaryNames,
            kMultiplier,
            modifiers,
            queryVector,
            userContent,
            aiContent,
            combinedQueryForDisplay,
            dynamicK,
            timeRanges,
            defaultTagWeight,
            tagTruncationRatio,
            metrics,
            historySegments,
            processedDiaries, // 🛡️ 循环引用检测
            contextDiaryPrefixes = new Set(), // 🌟 V4.1: 上下文日记去重前缀
            ghostTags = [], // 🌟 修复 4.1：接收幽灵节点
            collectedAttachments = [] // 🌟 V7
        } = options;

        const totalK = Math.max(1, Math.round(dynamicK * kMultiplier));
        const config = this.ragParams?.RAGDiaryPlugin || {};
        const temperature = config.aggregateTemperature ?? 3.0;
        const minKPerDiary = config.aggregateMinK ?? 1;

        // 🌟 解析 Truncate 阈值
        const truncateThreshold = this._extractTruncateThreshold(modifiers);

        console.log(`[RAGDiaryPlugin] 🌟 聚合检索启动: ${diaryNames.length} 个日记本, 总K=${totalK}, 温度=${temperature}${truncateThreshold > 0 ? `, Truncate=${truncateThreshold}` : ''}`);

        // --- Step 1: 获取各日记本的代表向量并计算相似度 ---
        const diaryScores = [];
        for (const name of diaryNames) {
            // 循环引用检测
            if (processedDiaries && processedDiaries.has(name)) {
                console.warn(`[RAGDiaryPlugin] 聚合模式: 检测到循环引用 "${name}"，跳过`);
                continue;
            }

            try {
                // 优先使用标签组网向量 (enhancedVectorCache)，回退到纯名字向量
                let diaryVec = this.enhancedVectorCache[name] || null;
                if (!diaryVec) {
                    diaryVec = await this.vectorDBManager.getDiaryNameVector(name);
                }

                if (!diaryVec) {
                    console.warn(`[RAGDiaryPlugin] 聚合模式: 无法获取 "${name}" 的向量，跳过`);
                    continue;
                }

                const sim = this.cosineSimilarity(queryVector, diaryVec);
                diaryScores.push({ name, similarity: sim });
            } catch (e) {
                console.error(`[RAGDiaryPlugin] 聚合模式: 获取 "${name}" 向量时出错:`, e.message);
                // 不崩溃，继续处理其他日记本
            }
        }

        // 🛡️ 如果没有任何有效的日记本，返回空
        if (diaryScores.length === 0) {
            console.warn('[RAGDiaryPlugin] 聚合检索: 没有有效的日记本可供检索。');
            return '';
        }

        // --- Step 2: Softmax 归一化分配 K 值 ---
        // 计算 exp(sim * temperature) 用于 softmax
        const expScores = diaryScores.map(d => Math.exp(d.similarity * temperature));
        const expSum = expScores.reduce((sum, v) => sum + v, 0);
        const weights = expScores.map(v => v / expSum);

        // 分配 K 值，确保每个日记本至少获得 minKPerDiary
        const reservedK = minKPerDiary * diaryScores.length;
        const distributableK = Math.max(0, totalK - reservedK);

        const kAllocations = weights.map((w, i) => {
            const allocated = minKPerDiary + Math.round(distributableK * w);
            return {
                name: diaryScores[i].name,
                similarity: diaryScores[i].similarity,
                weight: w,
                k: Math.max(minKPerDiary, allocated)
            };
        });

        // 日志输出分配结果（简化）
        console.log(`[RAGDiaryPlugin] K分配: ${kAllocations.map(a => `"${a.name}"(k=${a.k})`).join(', ')}`);


        // --- Step 3: 并行调用各日记本的检索 ---
        // 🛡️ 去除 modifiers 中的 kMultiplier，防止 _processRAGPlaceholder 内部再次乘以 kMultiplier
        const cleanedModifiers = modifiers.replace(/^:\d+\.?\d*/, '');

        const retrievalPromises = kAllocations.map(async (allocation) => {
            // 标记为已处理，防止循环引用
            if (processedDiaries) processedDiaries.add(allocation.name);

            try {
                const content = await this._processRAGPlaceholder({
                    dbName: allocation.name,
                    modifiers: cleanedModifiers,
                    queryVector,
                    userContent,
                    aiContent,
                    combinedQueryForDisplay,
                    dynamicK: allocation.k, // 🌟 使用分配后的 K 值（直接作为 dynamicK，kMultiplier 在聚合层已经处理）
                    timeRanges,
                    allowTimeAndGroup: true,
                    defaultTagWeight,
                    tagTruncationRatio,
                    metrics,
                    historySegments,
                    contextDiaryPrefixes, // 🌟 V4.1: 透传上下文日记去重前缀
                    ghostTags, // 🌟 修复 4.2：透传给底层具体执行的日记本！
                    collectedAttachments // 🌟 V7
                });
                return { name: allocation.name, content, k: allocation.k, success: true };
            } catch (e) {
                console.error(`[RAGDiaryPlugin] 聚合模式: "${allocation.name}" 检索失败:`, e.message);
                return { name: allocation.name, content: '', k: allocation.k, success: false };
            }
        });

        const results = await Promise.all(retrievalPromises);

        // --- Step 4: 聚合各日记本的检索结果 ---
        // 保持与现有多日记本显示格式一致：每个日记本独立展示
        const aggregatedContent = results
            .filter(r => r.content && r.content.trim().length > 0)
            .map(r => r.content)
            .join('\n');

        if (!aggregatedContent) {
            console.log('[RAGDiaryPlugin] 聚合检索: 所有日记本均未返回结果。');
            return '';
        }

        // 🛡️ 再一次全局截断检查（如果聚合结果的分数在底层已经被过滤，这里 aggregatedContent 已经会受影响）
        // 但聚合结果是由多个单日记本检索组成的，单日记本内部已经应用了 Truncate

        console.log(`[RAGDiaryPlugin] 🌟 聚合检索完成: ${results.filter(r => r.success && r.content).length}/${diaryNames.length} 个日记本返回了结果`);
        return aggregatedContent;
    }

    /**
     * 🌟 聚合检索: 《《》》全文模式的阈值计算
     * 使用各日记本单独阈值的平均值
     * @param {string[]} diaryNames - 日记本名列表
     * @returns {number} 平均阈值
     */
    _getAverageThreshold(diaryNames) {
        let totalThreshold = 0;
        let count = 0;
        for (const name of diaryNames) {
            const diaryConfig = this.ragConfig[name] || {};
            totalThreshold += diaryConfig.threshold || GLOBAL_SIMILARITY_THRESHOLD;
            count++;
        }
        return count > 0 ? totalThreshold / count : GLOBAL_SIMILARITY_THRESHOLD;
    }

    /**
     * 刷新一个RAG区块
     * @param {object} metadata - 从HTML注释中解析出的元数据 {dbName, modifiers, k}
     * @param {object} contextData - 包含最新上下文的对象 { lastAiMessage, toolResultsText }
     * @param {string} originalUserQuery - 从 chatCompletionHandler 回溯找到的真实用户查询
     * @returns {Promise<string>} 返回完整的、带有新元数据的新区块文本
     */
    async refreshRagBlock(metadata, contextData, originalUserQuery) {
        console.log(`[VCP Refresh] 正在刷新 "${metadata.dbName}" 的记忆区块 (U:0.5, A:0.35, T:0.15 权重)...`);
        const { lastAiMessage, toolResultsText } = contextData;

        // 1. 分别净化用户、AI 和工具的内容
        const sanitizedUserContent = this.sanitizeForEmbedding(originalUserQuery || '', 'user');
        const sanitizedAiContent = this.sanitizeForEmbedding(lastAiMessage || '', 'assistant');

        // [优化] 处理工具结果：先清理 Base64，再将 JSON 转换为 Markdown 以减少向量噪音
        let toolContentForVector = '';
        try {
            let rawText = typeof toolResultsText === 'string' ? toolResultsText : JSON.stringify(toolResultsText);

            // 1. 预清理：移除各种 Base64 模式
            const preCleanedText = rawText
                // Data URI 格式
                .replace(/"data:[^;]+;base64,[^"]+"/g, '"[Image Base64 Omitted]"')
                // 纯 Base64 长字符串（超过300字符）
                .replace(/"([A-Za-z0-9+/]{300,}={0,2})"/g, '"[Long Base64 Omitted]"');

            // 2. 解析 JSON
            const parsedTool = JSON.parse(preCleanedText);

            // 3. 转换为 Markdown (内部还会进行二次长度/特征过滤)
            toolContentForVector = this._jsonToMarkdown(parsedTool);
        } catch (e) {
            console.warn('[RAGDiaryPlugin] Tool result JSON parse failed, using fallback cleanup');
            toolContentForVector = String(toolResultsText || '')
                // 移除 Data URI
                .replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, '[Base64 Omitted]')
                // 移除可能的长 Base64 块
                .replace(/[A-Za-z0-9+/]{300,}={0,2}/g, '[Long Data Omitted]');
        }

        const sanitizedToolContent = this._stripEmoji(this._stripHtml(toolContentForVector));

        // 2. 并行获取所有向量
        const [userVector, aiVector, toolVector] = await Promise.all([
            sanitizedUserContent ? this.getSingleEmbeddingCached(sanitizedUserContent) : null,
            sanitizedAiContent ? this.getSingleEmbeddingCached(sanitizedAiContent) : null,
            sanitizedToolContent ? this.getSingleEmbeddingCached(sanitizedToolContent) : null
        ]);

        // 3. 按动态权重合并向量
        const config = this.ragParams?.RAGDiaryPlugin || {};
        const weights = config.refreshWeights || [0.5, 0.35, 0.15];
        const vectors = [userVector, aiVector, toolVector];
        console.log(`[VCP Refresh] 合并用户、AI意图和工具结果向量 (权重 ${weights.join(' : ')})`);
        const queryVector = this._getWeightedAverageVector(vectors, weights);

        if (!queryVector) {
            const combinedForError = `${sanitizedUserContent} ${sanitizedAiContent} ${sanitizedToolContent}`;
            console.error(`[VCP Refresh] 记忆刷新失败: 无法向量化新的上下文: "${combinedForError.substring(0, 100)}..."`);
            return `[记忆刷新失败: 无法向量化新的上下文]`;
        }

        // 4. 准备用于日志记录和时间解析的组合文本
        const combinedSanitizedContext = `[User]: ${sanitizedUserContent}\n[AI]: ${sanitizedAiContent}\n[Tool]: ${sanitizedToolContent}`;

        // 5. 复用 _processRAGPlaceholder 的逻辑来获取刷新后的内容
        const refreshedContent = await this._processRAGPlaceholder({
            dbName: metadata.dbName,
            modifiers: metadata.modifiers,
            queryVector: queryVector, // ✅ 使用加权后的向量
            userContent: combinedSanitizedContext, // ✅ 使用组合后的上下文进行内容处理
            aiContent: null,
            combinedQueryForDisplay: combinedSanitizedContext, // ✅ 使用组合后的上下文进行显示
            dynamicK: metadata.k || 5,
            timeRanges: this.timeParser.parse(combinedSanitizedContext), // ✅ 基于组合后的上下文重新解析时间
        });

        // 6. 返回完整的、带有新元数据的新区块文本
        return refreshedContent;
    }

    async _processRAGPlaceholder(options) {
        const {
            dbName,
            modifiers,
            queryVector,
            userContent,
            aiContent,
            combinedQueryForDisplay,
            dynamicK,
            timeRanges,
            allowTimeAndGroup = true,
            defaultTagWeight = 0.15, // 🌟 新增默认权重参数
            tagTruncationRatio = 0.5, // 🌟 新增截断比例
            metrics = {},
            historySegments = [], // 🌟 Tagmemo V4
            contextDiaryPrefixes = new Set(), // 🌟 V4.1: 上下文日记去重前缀
            ghostTags = [], // 🌟 V6: 幽灵节点
            collectedAttachments = [] // 🌟 V7
        } = options;

        // 1️⃣ 生成缓存键
        const cacheKey = this._generateCacheKey({
            userContent,
            aiContent: aiContent || '',
            dbName,
            modifiers,
            dynamicK,
            ghostTags // 🌟 修复 2.4：将外部的 ghostTags 传入生成器
        });

        // 2️⃣ 尝试从缓存获取
        const cachedResult = this._getCachedResult(cacheKey);
        if (cachedResult) {
            // 缓存命中时，仍需广播VCP Info（可选）
            if (this.pushVcpInfo && cachedResult.vcpInfo) {
                try {
                    this.pushVcpInfo({
                        ...cachedResult.vcpInfo,
                        fromCache: true // 标记为缓存结果
                    });
                } catch (e) {
                    console.error('[RAGDiaryPlugin] Cache hit broadcast failed:', e.message || e);
                }
            }
            return cachedResult.content;
        }

        // 3️⃣ 缓存未命中，执行原有逻辑

        const kMultiplier = this._extractKMultiplier(modifiers);
        const useTime = allowTimeAndGroup && modifiers.includes('::Time');
        const useGroup = allowTimeAndGroup && modifiers.includes('::Group');
        // 🌟 Rerank+ (RRF): 解析 ::Rerank+ 修饰符
        // 语法: ::Rerank+ (默认α=0.5) 或 ::Rerank+0.7 (α=0.7, Reranker占70%权重)
        const rerankPlusMatch = modifiers.match(/::Rerank\+(\d+\.?\d*)?/);
        const useRerankPlus = !!rerankPlusMatch;
        const rrfAlpha = useRerankPlus ? (rerankPlusMatch[1] ? Math.min(1.0, Math.max(0.0, parseFloat(rerankPlusMatch[1]))) : 0.5) : null;
        const useRerank = modifiers.includes('::Rerank'); // 匹配 ::Rerank 和 ::Rerank+

        // ✅ 解析 TimeDecay 参数：::TimeDecay[halfLife]/[minScore]/[whitelistTags]
        // 示例：::TimeDecay30/0.5/box归档
        // 统一使用 / 分隔符
        const timeDecayMatch = modifiers.match(/::TimeDecay(\d+)?(?:\/(\d+\.?\d*))?(?:\/([\w,]+))?/);
        const useTimeDecay = !!timeDecayMatch;

        // 🌟 V8: 解析 TagMemo/TagMemo+ 修饰符
        // ::TagMemo+  → 激活 TagMemo + 测地线重排（动态权重）
        // ::TagMemo+0.3 → 激活 TagMemo(权重0.3) + 测地线重排
        // ::TagMemo0.3 → 激活 TagMemo(权重0.3)，无测地线
        // ::TagMemo → 激活 TagMemo（动态权重），无测地线
        const useGeodesicRerank = /::TagMemo\+/.test(modifiers);
        const tagMemoWeightMatch = modifiers.match(/::TagMemo\+?([\d.]+)/);
        let tagWeight = tagMemoWeightMatch ? parseFloat(tagMemoWeightMatch[1]) : (modifiers.includes('::TagMemo') ? defaultTagWeight : null);

        // 🌟 V8: 构建 geodesicRerank 选项（传递给 search 的第 7 参数）
        const geoConfig = this.ragParams?.KnowledgeBaseManager?.geodesicRerank || {};
        const geoOptions = useGeodesicRerank ? {
            geodesicRerank: true,
            geoAlpha: geoConfig.alpha ?? 0.3,
            minGeoSamples: geoConfig.minGeoSamples ?? 4
        } : undefined;

        // 🌟 解析 Truncate 阈值
        const truncateThreshold = this._extractTruncateThreshold(modifiers);

        // TagMemo修饰符检测（静默）

        const displayName = dbName + '日记本';
        const finalK = Math.max(1, Math.round(dynamicK * kMultiplier));
        // 🧹 V4.1: 多取 contextDiaryPrefixes.size 条作为去重补偿缓冲
        const dedupBuffer = contextDiaryPrefixes.size;
        const kForSearch = useRerank
            ? Math.max(1, Math.round(finalK * this.rerankConfig.multiplier) + dedupBuffer)
            : finalK + dedupBuffer;

        // 准备元数据用于生成自描述区块
        const metadata = {
            dbName: dbName,
            modifiers: modifiers,
            k: finalK
            // V4.0: originalQuery has been removed to save tokens.
        };

        let retrievedContent = '';
        let finalQueryVector = queryVector;
        let activatedGroups = null;
        let finalResultsForBroadcast = null;
        let vcpInfoData = null;

        if (useGroup) {
            activatedGroups = this.semanticGroups.detectAndActivateGroups(userContent);
            if (activatedGroups.size > 0) {
                const enhancedVector = await this.semanticGroups.getEnhancedVector(userContent, activatedGroups, queryVector);
                if (enhancedVector) finalQueryVector = enhancedVector;
            }
        }

        // ✅ 🌟 原子级复刻 LightMemo 流程：利用 applyTagBoost 预先感应语义 Tag
        // 逻辑：不再使用 Jieba 提取关键词，也不使用简单的 searchSimilarTags。
        // 而是直接调用 V6 (Spike) 引擎的 applyTagBoost，让残差金字塔（ResidualPyramid）从向量中感应出最匹配的标签。
        // 这才是 LightMemo 能够返回“完美标签”的真正原因。
        let coreTagsForSearch = [];
        if (tagWeight !== null && this.vectorDBManager.applyTagBoost) {
            try {
                // 🌟 V6: 巧妙合并：把字符串和幽灵对象全塞进同一个 coreTagsForSearch 数组里！
                // 底层引擎会自动把它们分流
                const initialCoreTags = ghostTags.length > 0 ? [...ghostTags] : [];
                if (ghostTags.length > 0) {
                    console.log(`[RAGDiaryPlugin] 注入幽灵节点: ${ghostTags.length} 个`);
                }

                // 模拟 LightMemo 的第一次“感应”过程，获取 ResidualPyramid 识别出的语义标签
                const boostResult = this.vectorDBManager.applyTagBoost(new Float32Array(queryVector), tagWeight, initialCoreTags);
                if (boostResult && boostResult.info && boostResult.info.matchedTags) {
                    const rawTags = boostResult.info.matchedTags;
                    // 🌟 应用截断技术规避尾部噪音
                    coreTagsForSearch = this._truncateCoreTags(rawTags, tagTruncationRatio, metrics);

                    // 重新混入幽灵节点（因为 _truncateCoreTags 可能会把它们择出去，或者它们本身就是 Object）
                    // 实际上 applyTagBoost 返回的 matchedTags 主要是字符串 ID。
                    // 我们需要确保 ghostTags 始终在 coreTagsForSearch 中。
                    if (ghostTags.length > 0) {
                        coreTagsForSearch = [...coreTagsForSearch, ...ghostTags];
                    }

                    console.log(`[RAGDiaryPlugin] TagBoost: ${coreTagsForSearch.length}个核心Tag (含${ghostTags.length}个幽灵)`);
                } else if (ghostTags.length > 0) {
                    // 如果 boost 没结果，至少保留幽灵节点
                    coreTagsForSearch = ghostTags;
                }
            } catch (e) {
                console.warn('[RAGDiaryPlugin] Failed to sense tags via applyTagBoost:', e.message);
                if (ghostTags.length > 0) coreTagsForSearch = ghostTags;
            }
        }

        // 🌟 修复：将混合了对象和字符串的数组“脱水”为纯字符串，防止 VCP Info 爆出 [object Object]
        const coreTagsForDisplay = coreTagsForSearch.map(tag => {
            if (typeof tag === 'string') return tag;
            if (tag && tag.name) return tag.isCore ? `!${tag.name}` : tag.name; // 还原出带感叹号的核心标识
            return String(tag);
        });

        let candidates = [];

        if (useTime && timeRanges && timeRanges.length > 0) {
            // --- 🌟 V5: 平衡双路召回 (Balanced Dual-Path Retrieval) ---
            // 目标：语义召回占 60%，时间召回占 40%，且时间召回也进行相关性排序
            const kSemantic = Math.max(1, Math.ceil(finalK * 0.6));
            const kTime = Math.max(1, finalK - kSemantic);

            // 1. 语义路召回 (多取一些用于后续衰减/重排)
            const searchK = useRerank ? Math.max(kSemantic * 2, 20) : kSemantic + 10;
            let ragResults = await this.vectorDBManager.search(dbName, finalQueryVector, searchK + dedupBuffer, tagWeight, coreTagsForSearch, undefined, geoOptions);
            ragResults = this._filterContextDuplicates(ragResults, contextDiaryPrefixes);
            ragResults = ragResults.map(r => ({ ...r, source: 'rag' }));

            // 2. 时间路召回 (带相关性排序)
            let timeFilePaths = [];
            for (const timeRange of timeRanges) {
                const files = await this._getTimeRangeFilePaths(dbName, timeRange);
                timeFilePaths.push(...files);
            }
            timeFilePaths = [...new Set(timeFilePaths)];

            let timeResults = [];
            if (timeFilePaths.length > 0) {
                const timeChunks = await this.vectorDBManager.getChunksByFilePaths(timeFilePaths);
                timeResults = timeChunks.map(chunk => {
                    const sim = chunk.vector ? this.cosineSimilarity(finalQueryVector, Array.from(chunk.vector)) : 0;
                    return { ...chunk, score: sim, source: 'time' };
                });
                console.log(`[RAGDiaryPlugin] Time path: Found ${timeChunks.length} chunks in range.`);
            }

            // 3. 合并与初步去重
            const allEntries = new Map();
            ragResults.forEach(r => allEntries.set(r.text.trim(), r));
            timeResults.forEach(r => {
                const trimmedText = r.text.trim();
                if (!allEntries.has(trimmedText)) {
                    allEntries.set(trimmedText, r);
                }
            });
            candidates = Array.from(allEntries.values());

        } else {
            // --- Standard path (no time filter) ---
            // 🌟 Tagmemo V4: Shotgun Query Implementation
            let searchVectors = [{ vector: finalQueryVector, type: 'current', weight: 1.0 }];

            if (historySegments && historySegments.length > 0) {
                const recentSegments = historySegments.slice(-3);
                const decayFactor = 0.85;
                recentSegments.forEach((seg, idx) => {
                    const distance = recentSegments.length - idx;
                    const weightMultiplier = Math.pow(decayFactor, distance);
                    searchVectors.push({ vector: seg.vector, type: `history_${idx}`, weight: weightMultiplier });
                });
            }

            console.log(`[RAGDiaryPlugin] Shotgun Query: Executing ${searchVectors.length} parallel searches...`);

            const searchPromises = searchVectors.map(async (qv) => {
                try {
                    const k = qv.type === 'current' ? kForSearch : Math.max(2, Math.round(kForSearch / 2));
                    let results = await this.vectorDBManager.search(dbName, qv.vector, k, tagWeight, coreTagsForSearch, undefined, geoOptions);
                    if (qv.weight !== 1.0) {
                        results = results.map(r => ({ ...r, score: r.score * qv.weight, original_score: r.score }));
                    }
                    return results;
                } catch (e) {
                    console.error(`[RAGDiaryPlugin] Shotgun search failed for ${qv.type}:`, e.message);
                    return [];
                }
            });

            const resultsArrays = await Promise.all(searchPromises);
            let flattenedResults = resultsArrays.flat();
            flattenedResults = this._filterContextDuplicates(flattenedResults, contextDiaryPrefixes);
            candidates = await this.vectorDBManager.deduplicateResults(flattenedResults, finalQueryVector);
        }

        // --- 🌟 统一后置处理 (TimeDecay -> Rerank -> Truncate) ---

        // 1. TimeDecay: 在截断前对全量结果应用衰减并重排
        if (useTimeDecay && candidates.length > 0) {
            const globalDecayConfig = this.ragParams?.RAGDiaryPlugin?.timeDecay || {};
            candidates = this._applyTimeDecay(candidates, timeDecayMatch, globalDecayConfig);
        }

        // 2. Rerank & Merge: 对处理后的结果进行最终精排与合并
        if (useTime && timeRanges && timeRanges.length > 0) {
            // 🌟 V5.4: 在 Time 模式下，强制执行 60/40 分配，防止 TimeDecay 或高分语义结果导致时间轴逻辑失效
            const kSemantic = Math.max(1, Math.ceil(finalK * 0.6));
            const kTime = Math.max(1, finalK - kSemantic);

            const semanticCandidates = candidates.filter(c => c.source === 'rag');
            const timeCandidates = candidates.filter(c => c.source === 'time');

            let finalSemantic = [];
            let finalTime = [];

            if (useRerank) {
                // 分别对两路进行 Rerank（如果样本足够）
                const rrfOpts = useRerankPlus ? { alpha: rrfAlpha } : null;
                // 语义路重排
                if (semanticCandidates.length > 0) {
                    finalSemantic = await this._rerankDocuments(userContent, semanticCandidates, kSemantic, rrfOpts);
                }
                // 时间路重排（时间路通常较少，如果不足 kTime 则全取）
                if (timeCandidates.length > 0) {
                    finalTime = await this._rerankDocuments(userContent, timeCandidates, kTime, rrfOpts);
                }
            } else {
                semanticCandidates.sort((a, b) => (b.score || 0) - (a.score || 0));
                timeCandidates.sort((a, b) => (b.score || 0) - (a.score || 0));
                finalSemantic = semanticCandidates.slice(0, kSemantic);
                finalTime = timeCandidates.slice(0, kTime);
            }
            finalResultsForBroadcast = [...finalSemantic, ...finalTime];
        } else if (useRerank && candidates.length > 0) {
            candidates.forEach((doc, idx) => { doc.retrieval_rank = idx + 1; });
            const rrfOpts = useRerankPlus ? { alpha: rrfAlpha } : null;
            finalResultsForBroadcast = await this._rerankDocuments(userContent, candidates, finalK, rrfOpts);
        } else {
            // 默认按 score 排序并截断
            candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
            finalResultsForBroadcast = candidates.slice(0, finalK);
        }

        // 统一添加 source 标识并格式化
        finalResultsForBroadcast = finalResultsForBroadcast.map(r => ({ ...r, source: r.source || 'rag' }));

        if (useTime && timeRanges && timeRanges.length > 0) {
            retrievedContent = this.formatCombinedTimeAwareResults(finalResultsForBroadcast, timeRanges, dbName, metadata);
        } else if (useGroup) {
            retrievedContent = this.formatGroupRAGResults(finalResultsForBroadcast, displayName, activatedGroups, metadata);
        } else {
            retrievedContent = this.formatStandardResults(finalResultsForBroadcast, displayName, metadata);
        }

        // 🌟 应用 Truncate 过滤逻辑
        if (truncateThreshold > 0 && finalResultsForBroadcast && finalResultsForBroadcast.length > 0) {
            const beforeCount = finalResultsForBroadcast.length;
            finalResultsForBroadcast = finalResultsForBroadcast.filter(r => {
                const score = r.rerank_score ?? r.score ?? 0;
                return score >= truncateThreshold;
            });
            const afterCount = finalResultsForBroadcast.length;

            if (beforeCount !== afterCount) {
                console.log(`[RAGDiaryPlugin] Truncate applied: ${beforeCount} -> ${afterCount} items (Threshold: ${truncateThreshold})`);

                // 如果过滤后变为空，且原本有内容，需要重新生成内容
                if (afterCount === 0) {
                    retrievedContent = '';
                } else if (useGroup) {
                    retrievedContent = this.formatGroupRAGResults(finalResultsForBroadcast, displayName, activatedGroups, metadata);
                } else {
                    retrievedContent = this.formatStandardResults(finalResultsForBroadcast, displayName, metadata);
                }
            }
        }

        // 🌟 V7: Base64Memo 附件提取逻辑
        if (modifiers.includes('::Base64Memo') && retrievedContent) {
            const attachments = this._extractAttachments(retrievedContent);
            if (attachments.length > 0) {
                collectedAttachments.push(...attachments);
                console.log(`[RAGDiaryPlugin] 🌟 V7: 从召回内容中提取了 ${attachments.length} 个附件链接`);
            }
        }

        if (this.pushVcpInfo && finalResultsForBroadcast) {
            try {
                // ✅ 新增：根据相关度分数对结果进行排序
                finalResultsForBroadcast.sort((a, b) => {
                    const scoreA = a.rerank_score ?? a.score ?? -1;
                    const scoreB = b.rerank_score ?? b.score ?? -1;
                    return scoreB - scoreA;
                });

                const cleanedResults = this._cleanResultsForBroadcast(finalResultsForBroadcast);
                vcpInfoData = {
                    type: 'RAG_RETRIEVAL_DETAILS',
                    dbName: dbName,
                    query: combinedQueryForDisplay,
                    k: finalK,
                    useTime: useTime,
                    useGroup: useGroup,
                    useRerank: useRerank,
                    useRerankPlus: useRerankPlus, // 🌟 Rerank+ (RRF) 模式标识
                    rrfAlpha: rrfAlpha, // 🌟 RRF 权重参数
                    useGeodesicRerank: useGeodesicRerank, // 🌟 V8: 测地线重排标识
                    geoAlpha: geoOptions?.geoAlpha, // 🌟 V8: 测地线混合权重
                    useTagMemo: tagWeight !== null, // ✅ 添加Tag模式标识
                    tagWeight: tagWeight, // ✅ 添加Tag权重
                    coreTags: coreTagsForDisplay, // 🌟 广播中依然显示提取到的标签，方便观察
                    timeRanges: (useTime && Array.isArray(timeRanges)) ? timeRanges.map(r => {
                        try {
                            return {
                                start: (r.start && typeof r.start.toISOString === 'function') ? r.start.toISOString() : String(r.start),
                                end: (r.end && typeof r.end.toISOString === 'function') ? r.end.toISOString() : String(r.end)
                            };
                        } catch (e) {
                            return { error: 'Invalid date format', raw: String(r) };
                        }
                    }) : undefined,
                    // 🌟 限制广播结果数量和长度，防止 payload 过大导致广播失败
                    results: cleanedResults.slice(0, 10),
                    // ✅ 新增：汇总Tag统计信息
                    tagStats: tagWeight !== null ? this._aggregateTagStats(cleanedResults) : undefined
                };

                // 🛡️ 优化：移除冗余的 JSON 序列化，直接推送对象以减少 CPU 阻塞
                try {
                    this.pushVcpInfo(vcpInfoData);
                } catch (innerError) {
                    console.error('[RAGDiaryPlugin] VCPInfo broadcast failed:', innerError.message || innerError);
                    // 降级广播：只发送核心元数据
                    try {
                        this.pushVcpInfo({
                            type: 'RAG_RETRIEVAL_DETAILS',
                            dbName: dbName,
                            error: 'Detailed stats broadcast failed: ' + (innerError.message || 'Unknown error')
                        });
                    } catch (e) { }
                }
            } catch (broadcastError) {
                console.error(`[RAGDiaryPlugin] Critical error during VCPInfo preparation:`, broadcastError.message || broadcastError);
            }
        }

        // 4️⃣ 保存到缓存
        this._setCachedResult(cacheKey, {
            content: retrievedContent,
            vcpInfo: vcpInfoData
        });

        return retrievedContent;
    }


    //####################################################################################
    //## Time-Aware RAG Logic - 时间感知RAG逻辑
    //####################################################################################

    /**
     * 🌟 新增：仅获取时间范围内的文件路径列表
     * 用于 V5 平衡召回逻辑
     */
    async _getTimeRangeFilePaths(dbName, timeRange) {
        const characterDirPath = path.join(dailyNoteRootPath, dbName);
        let filePathsInRange = [];

        if (!timeRange || !timeRange.start || !timeRange.end) return filePathsInRange;

        try {
            const files = await fs.readdir(characterDirPath);
            const diaryFiles = files.filter(file => file.toLowerCase().endsWith('.txt') || file.toLowerCase().endsWith('.md'));

            for (const file of diaryFiles) {
                const filePath = path.join(characterDirPath, file);
                try {
                    // 优化：只读取前 100 个字符来解析日期，不读取全文
                    const fd = await fs.open(filePath, 'r');
                    const buffer = Buffer.alloc(100);
                    await fd.read(buffer, 0, 100, 0);
                    await fd.close();

                    const content = buffer.toString('utf-8');
                    const firstLine = content.split('\n')[0];
                    const match = firstLine.match(/^\[?(\d{4}[-.]\d{2}[-.]\d{2})\]?/);

                    if (match) {
                        const dateStr = match[1];
                        const normalizedDateStr = dateStr.replace(/\./g, '-');
                        const diaryDate = dayjs.tz(normalizedDateStr, DEFAULT_TIMEZONE).startOf('day').toDate();

                        if (diaryDate >= timeRange.start && diaryDate <= timeRange.end) {
                            // 存储相对于知识库根目录的路径，以便 KnowledgeBaseManager 查询
                            filePathsInRange.push(path.join(dbName, file));
                        }
                    }
                } catch (readErr) { }
            }
        } catch (dirError) { }
        return filePathsInRange;
    }

    async getTimeRangeDiaries(dbName, timeRange) {
        // 此方法保留用于兼容旧逻辑，但 V5 逻辑已转向 _getTimeRangeFilePaths + getChunksByFilePaths
        const characterDirPath = path.join(dailyNoteRootPath, dbName);
        let diariesInRange = [];

        // 确保时间范围有效
        if (!timeRange || !timeRange.start || !timeRange.end) {
            console.error('[RAGDiaryPlugin] Invalid time range provided');
            return diariesInRange;
        }

        try {
            const files = await fs.readdir(characterDirPath);
            const diaryFiles = files.filter(file => file.toLowerCase().endsWith('.txt'));

            for (const file of diaryFiles) {
                const filePath = path.join(characterDirPath, file);
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    const firstLine = content.split('\n')[0];
                    // V2.6: 兼容 [YYYY-MM-DD] 和 YYYY.MM.DD 两种日记时间戳格式
                    const match = firstLine.match(/^\[?(\d{4}[-.]\d{2}[-.]\d{2})\]?/);
                    if (match) {
                        const dateStr = match[1];
                        // 将 YYYY.MM.DD 格式规范化为 YYYY-MM-DD
                        const normalizedDateStr = dateStr.replace(/\./g, '-');

                        // 使用 dayjs 在配置的时区中解析日期，并获取该日期在配置时区下的开始时间
                        const diaryDate = dayjs.tz(normalizedDateStr, DEFAULT_TIMEZONE).startOf('day').toDate();

                        if (diaryDate >= timeRange.start && diaryDate <= timeRange.end) {
                            diariesInRange.push({
                                date: normalizedDateStr, // 使用规范化后的日期
                                text: content,
                                source: 'time'
                            });
                        }
                    }
                } catch (readErr) {
                    // ignore individual file read errors
                }
            }
        } catch (dirError) {
            if (dirError.code !== 'ENOENT') {
                console.error(`[RAGDiaryPlugin] Error reading character directory for time filter ${characterDirPath}:`, dirError.message);
            }
        }
        return diariesInRange;
    }

    formatStandardResults(searchResults, displayName, metadata) {
        let innerContent = `\n[--- 从"${displayName}"中检索到的相关记忆片段 ---]\n`;
        if (searchResults && searchResults.length > 0) {
            innerContent += searchResults.map(r => `* ${r.text.trim()}`).join('\n');
        } else {
            innerContent += "没有找到直接相关的记忆片段。";
        }
        innerContent += `\n[--- 记忆片段结束 ---]\n`;

        const metadataString = JSON.stringify(metadata).replace(/-->/g, '--\\>');
        return `<!-- VCP_RAG_BLOCK_START ${metadataString} -->${innerContent}<!-- VCP_RAG_BLOCK_END -->`;
    }

    formatCombinedTimeAwareResults(results, timeRanges, dbName, metadata) {
        const displayName = dbName + '日记本';
        const formatDate = (date) => {
            const d = new Date(date);
            return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        }

        let innerContent = `\n[--- "${displayName}" 多时间感知检索结果 ---]\n`;

        const formattedRanges = timeRanges.map(tr => `"${formatDate(tr.start)} ~ ${formatDate(tr.end)}"`).join(' 和 ');
        innerContent += `[合并查询的时间范围: ${formattedRanges}]\n`;

        const ragEntries = results.filter(e => e.source === 'rag');
        const timeEntries = results.filter(e => e.source === 'time');

        innerContent += `[统计: 共找到 ${results.length} 条不重复记忆 (语义相关 ${ragEntries.length}条, 时间范围 ${timeEntries.length}条)]\n\n`;

        if (ragEntries.length > 0) {
            innerContent += '【语义相关记忆】\n';
            ragEntries.forEach(entry => {
                const dateMatch = entry.text.match(/^\[(\d{4}-\d{2}-\d{2})\]/);
                const datePrefix = dateMatch ? `[${dateMatch[1]}] ` : '';
                innerContent += `* ${datePrefix}${entry.text.replace(/^\[.*?\]\s*-\s*.*?\n?/, '').trim()}\n`;
            });
        }

        if (timeEntries.length > 0) {
            innerContent += '\n【时间范围记忆】\n';
            // 按日期从新到旧排序
            timeEntries.sort((a, b) => new Date(b.date) - new Date(a.date));
            timeEntries.forEach(entry => {
                innerContent += `* [${entry.date}] ${entry.text.replace(/^\[.*?\]\s*-\s*.*?\n?/, '').trim()}\n`;
            });
        }

        innerContent += `[--- 检索结束 ---]\n`;

        const metadataString = JSON.stringify(metadata).replace(/-->/g, '--\\>');
        return `<!-- VCP_RAG_BLOCK_START ${metadataString} -->${innerContent}<!-- VCP_RAG_BLOCK_END -->`;
    }

    formatGroupRAGResults(searchResults, displayName, activatedGroups, metadata) {
        let innerContent = `\n[--- "${displayName}" 语义组增强检索结果 ---]\n`;

        if (activatedGroups && activatedGroups.size > 0) {
            innerContent += `[激活的语义组:]\n`;
            for (const [groupName, data] of activatedGroups) {
                innerContent += `  • ${groupName} (${(data.strength * 100).toFixed(0)}%激活): 匹配到 "${data.matchedWords.join(', ')}"\n`;
            }
            innerContent += '\n';
        } else {
            innerContent += `[未激活特定语义组]\n\n`;
        }

        innerContent += `[检索到 ${searchResults ? searchResults.length : 0} 条相关记忆]\n`;
        if (searchResults && searchResults.length > 0) {
            innerContent += searchResults.map(r => `* ${r.text.trim()}`).join('\n');
        } else {
            innerContent += "没有找到直接相关的记忆片段。";
        }
        innerContent += `\n[--- 检索结束 ---]\n`;

        const metadataString = JSON.stringify(metadata).replace(/-->/g, '--\\>');
        return `<!-- VCP_RAG_BLOCK_START ${metadataString} -->${innerContent}<!-- VCP_RAG_BLOCK_END -->`;
    }

    /**
     * 🌟 V5.3: 时间衰减重排 (Time Decay Reranking) - 独立方法
     * 前置执行：在截断前对全量结果应用衰减并重排，确保新鲜记录能顶替旧记录。
     *
     * 日期提取优先级：
     *   1. Tag: 行中的日期（AI 写日记时通常在 Tag 行附上日期，最可靠）
     *   2. 文本中的 [YYYY-MM-DD] 括号日期
     *   3. 文本首行的裸日期
     *   4. 文件名/路径中的日期（最后回退）
     *
     * 目标标签匹配：精准匹配 Tag: 行，而非扫全文，避免误伤。
     *
     * @param {Array} results - 去重后的全量结果（未截断）
     * @param {RegExpMatchArray} timeDecayMatch - ::TimeDecay 修饰符的正则匹配结果
     * @param {object} globalDecayConfig - rag_params.json 中的全局衰减配置
     * @returns {Array} 衰减并重排后的结果（已过滤低分，但未截断到 finalK）
     */
    _applyTimeDecay(results, timeDecayMatch, globalDecayConfig) {
        if (!results || results.length === 0) return results;

        const localHalfLife = timeDecayMatch[1] ? parseInt(timeDecayMatch[1]) : null;
        const localMinScore = timeDecayMatch[2] ? parseFloat(timeDecayMatch[2]) : null;
        const localTargets = timeDecayMatch[3]
            ? timeDecayMatch[3].split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
            : [];

        const halfLife = localHalfLife ?? globalDecayConfig?.halfLifeDays ?? 30;
        const minScore = localMinScore ?? globalDecayConfig?.minScore ?? 0.5;
        const now = dayjs();

        console.log(`[RAGDiaryPlugin] ⏳ TimeDecay (前置): halfLife=${halfLife}d, minScore=${minScore}, targets=${localTargets.length > 0 ? localTargets.join(',') : 'ALL'}, 输入=${results.length}条`);

        let decayCount = 0;
        const decayed = results.map(result => {
            // 🌟 如果是来自 ::Time 模式的时间路结果，跳过衰减，确保显式时间查询不失效
            if (result.source === 'time') return result;

            // --- 0. 目标标签匹配：精准匹配 Tag: 行 ---
            if (localTargets.length > 0) {
                let isTarget = false;

                // 首要：从 Tag: 行精准匹配（AI 写日记时标签在此行）
                const tagLineMatch = result.text.match(/Tag:\s*([^\n]+)/i);
                if (tagLineMatch) {
                    const tagLine = tagLineMatch[1].toLowerCase();
                    isTarget = localTargets.some(tag => tagLine.includes(tag));
                }

                // 回退：匹配向量库结构化标签（支持部分匹配，如 "box" 匹配 "Box审计"）
                if (!isTarget && result.matchedTags && Array.isArray(result.matchedTags)) {
                    isTarget = localTargets.some(tag =>
                        result.matchedTags.some(t => t.toLowerCase().includes(tag))
                    );
                }

                if (!isTarget) return result; // 不在衰减名单，保持原分
            }

            // --- 1. 日期提取（优先级：Tag行 > [括号] > 首行 > 文件名）---
            let dateStr = null;

            // 首要：从 Tag: 行提取日期（格式如 "Tag: 2026-03-12, boxDecay"）
            const tagLineForDate = result.text.match(/Tag:\s*([^\n]+)/i);
            if (tagLineForDate) {
                const tagDateMatch = tagLineForDate[1].match(/(\d{4}[-./]\d{2}[-./]\d{2})/);
                if (tagDateMatch) {
                    dateStr = tagDateMatch[1].replace(/[./]/g, '-');
                }
            }

            // 次要：文本中的 [YYYY-MM-DD] 括号日期
            if (!dateStr) {
                const bracketMatch = result.text.match(/\[(\d{4}[-./]\d{2}[-./]\d{2})\]/);
                if (bracketMatch) {
                    dateStr = bracketMatch[1].replace(/[./]/g, '-');
                }
            }

            // 再次：文本首行的裸日期
            if (!dateStr) {
                const firstLineMatch = result.text.split('\n')[0].match(/^\[?(\d{4}[-./]\d{2}[-./]\d{2})\]?/);
                if (firstLineMatch) {
                    dateStr = firstLineMatch[1].replace(/[./]/g, '-');
                }
            }

            // 最后：文件名/路径中的日期
            if (!dateStr) {
                const pathSource = result.sourceFile || result.fullPath || '';
                const pathDateMatch = pathSource.match(/(\d{4}[-.]\d{2}[-.]\d{2})/);
                if (pathDateMatch) {
                    dateStr = pathDateMatch[1].replace(/\./g, '-');
                }
            }

            if (!dateStr) return result;

            const entryDate = dayjs(dateStr);
            if (!entryDate.isValid()) return result;

            const diffDays = Math.max(0, now.diff(entryDate, 'day'));
            const decayFactor = Math.pow(0.5, diffDays / halfLife);
            const originalScore = result.rerank_score ?? result.score ?? 0;
            const newScore = originalScore * decayFactor;

            decayCount++;
            if (decayCount <= 5) {
                console.log(`[RAGDiaryPlugin][Decay] Date: ${dateStr}, Age: ${diffDays}d, Factor: ${decayFactor.toFixed(4)}, Score: ${originalScore.toFixed(4)} -> ${newScore.toFixed(4)}`);
            }

            return {
                ...result,
                score: newScore,
                original_score: originalScore,
                decay_factor: decayFactor,
                diff_days: diffDays
            };
        });

        console.log(`[RAGDiaryPlugin] ⏳ TimeDecay 完成: ${decayCount}条被衰减，重新排序中...`);

        // 按衰减后的分数重新排序（这是关键：让新鲜记录自然浮上来）
        decayed.sort((a, b) => (b.score || 0) - (a.score || 0));

        // 过滤低分（在截断之前过滤，确保最终 finalK 条都是高质量的）
        if (minScore > 0) {
            const filtered = decayed.filter(r => (r.score || 0) >= minScore);
            console.log(`[RAGDiaryPlugin] ⏳ TimeDecay minScore过滤: ${decayed.length} -> ${filtered.length}条`);
            return filtered;
        }

        return decayed;
    }

    // Helper for token estimation
    _estimateTokens(text) {
        if (!text) return 0;
        // 更准确的中英文混合估算
        const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
        const otherChars = text.length - chineseChars;
        // 中文: ~1.5 token/char, 英文: ~0.25 token/char (1 word ≈ 4 chars)
        return Math.ceil(chineseChars * 1.5 + otherChars * 0.25);
    }

    async _rerankDocuments(query, documents, originalK, rrfOptions = null) {
        // JIT (Just-In-Time) check for configuration instead of relying on a startup flag
        if (!this.rerankConfig.url || !this.rerankConfig.apiKey || !this.rerankConfig.model) {
            console.warn('[RAGDiaryPlugin] Rerank called, but is not configured. Skipping.');
            return documents.slice(0, originalK);
        }

        // ✅ 新增：断路器模式防止循环调用
        const circuitBreakerKey = `rerank_${Date.now()}`;
        if (!this.rerankCircuitBreaker) {
            this.rerankCircuitBreaker = new Map();
        }

        // 检查是否在短时间内有太多失败
        const now = Date.now();
        const recentFailures = Array.from(this.rerankCircuitBreaker.entries())
            .filter(([key, timestamp]) => now - timestamp < 60000) // 1分钟内
            .length;

        if (recentFailures >= 5) {
            console.warn('[RAGDiaryPlugin] Rerank circuit breaker activated due to recent failures. Skipping rerank.');
            return documents.slice(0, originalK);
        }

        // ✅ 新增：查询截断机制防止"Query is too long"错误
        const maxQueryTokens = Math.floor(this.rerankConfig.maxTokens * 0.3); // 预留70%给文档
        let truncatedQuery = query;
        let queryTokens = this._estimateTokens(query);

        if (queryTokens > maxQueryTokens) {
            console.warn(`[RAGDiaryPlugin] Query too long (${queryTokens} tokens), truncating to ${maxQueryTokens} tokens`);
            // 简单截断：按字符比例截断
            const truncateRatio = maxQueryTokens / queryTokens;
            const targetLength = Math.floor(query.length * truncateRatio * 0.9); // 留10%安全边距
            truncatedQuery = query.substring(0, targetLength) + '...';
            queryTokens = this._estimateTokens(truncatedQuery);
            console.log(`[RAGDiaryPlugin] Query truncated to ${queryTokens} tokens`);
        }

        const rerankUrl = new URL('v1/rerank', this.rerankConfig.url).toString();
        const headers = {
            'Authorization': `Bearer ${this.rerankConfig.apiKey}`,
            'Content-Type': 'application/json',
        };
        const maxTokens = this.rerankConfig.maxTokens;

        // ✅ 优化批次处理逻辑
        let batches = [];
        let currentBatch = [];
        let currentTokens = queryTokens;
        const minBatchSize = 1; // 确保每个批次至少有1个文档
        const maxBatchTokens = maxTokens - queryTokens - 1000; // 预留1000 tokens安全边距

        for (const doc of documents) {
            const docTokens = this._estimateTokens(doc.text);

            // 如果单个文档就超过限制，跳过该文档
            if (docTokens > maxBatchTokens) {
                console.warn(`[RAGDiaryPlugin] Document too large (${docTokens} tokens), skipping`);
                continue;
            }

            if (currentTokens + docTokens > maxBatchTokens && currentBatch.length >= minBatchSize) {
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

        // 如果没有有效批次，直接返回原始文档
        if (batches.length === 0) {
            console.warn('[RAGDiaryPlugin] No valid batches for reranking, returning original documents');
            return documents.slice(0, originalK);
        }


        let allRerankedDocs = [];
        let failedBatches = 0;

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const docTexts = batch.map(d => d.text);

            try {
                const body = {
                    model: this.rerankConfig.model,
                    query: truncatedQuery, // ✅ 使用截断后的查询
                    documents: docTexts,
                    top_n: docTexts.length // Rerank all documents within the batch
                };

                // ✅ 添加请求超时和重试机制
                const response = await axios.post(rerankUrl, body, {
                    headers,
                    timeout: 30000, // 30秒超时
                    maxRedirects: 0 // 禁用重定向防止循环
                });

                if (response.data && Array.isArray(response.data.results)) {
                    const rerankedResults = response.data.results;
                    const orderedBatch = rerankedResults
                        .map(result => {
                            const originalDoc = batch[result.index];
                            // 关键：将 rerank score 赋给原始文档
                            return { ...originalDoc, rerank_score: result.relevance_score };
                        })
                        .filter(Boolean);

                    allRerankedDocs.push(...orderedBatch);
                } else {
                    console.warn(`[RAGDiaryPlugin] Rerank for batch ${i + 1} returned invalid data. Appending original batch documents.`);
                    allRerankedDocs.push(...batch); // Fallback: use original order for this batch
                    failedBatches++;
                }
            } catch (error) {
                failedBatches++;
                console.error(`[RAGDiaryPlugin] Rerank API call failed for batch ${i + 1}. Appending original batch documents.`);

                // ✅ 详细错误分析和断路器触发
                if (error.response) {
                    const status = error.response.status;
                    const errorData = error.response.data;
                    console.error(`[RAGDiaryPlugin] Rerank API Error - Status: ${status}, Data: ${JSON.stringify(errorData)}`);

                    // 特定错误处理
                    if (status === 400 && errorData?.error?.message?.includes('Query is too long')) {
                        console.error('[RAGDiaryPlugin] Query still too long after truncation, adding to circuit breaker');
                        this.rerankCircuitBreaker.set(`${circuitBreakerKey}_${i}`, now);
                    } else if (status >= 500) {
                        // 服务器错误，添加到断路器
                        this.rerankCircuitBreaker.set(`${circuitBreakerKey}_${i}`, now);
                    }
                } else if (error.code === 'ECONNABORTED') {
                    console.error('[RAGDiaryPlugin] Rerank API timeout');
                    this.rerankCircuitBreaker.set(`${circuitBreakerKey}_${i}`, now);
                } else {
                    console.error('[RAGDiaryPlugin] Rerank API Error - Message:', error.message);
                    this.rerankCircuitBreaker.set(`${circuitBreakerKey}_${i}`, now);
                }

                allRerankedDocs.push(...batch); // Fallback: use original order for this batch

                // ✅ 如果失败率过高，提前终止
                if (failedBatches / (i + 1) > 0.5 && i > 2) {
                    console.warn('[RAGDiaryPlugin] Too many rerank failures, terminating early');
                    // 添加剩余批次的原始文档
                    for (let j = i + 1; j < batches.length; j++) {
                        allRerankedDocs.push(...batches[j]);
                    }
                    break;
                }
            }
        }

        // ✅ 清理过期的断路器记录
        for (const [key, timestamp] of this.rerankCircuitBreaker.entries()) {
            if (now - timestamp > 300000) { // 5分钟后清理
                this.rerankCircuitBreaker.delete(key);
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

    _cleanResultsForBroadcast(results) {
        if (!Array.isArray(results)) return [];
        return results.map(r => {
            // 仅保留可序列化的关键属性
            const cleaned = {
                text: r.text || '',
                score: r.score || undefined,
                source: r.source || undefined,
                date: r.date || undefined,
            };

            // ✅ 新增：包含Tag相关信息（如果存在）
            if (r.originalScore !== undefined) cleaned.originalScore = r.originalScore;
            if (r.tagMatchScore !== undefined) cleaned.tagMatchScore = r.tagMatchScore;
            
            let finalTags = [];
            if (r.matchedTags && Array.isArray(r.matchedTags)) {
                finalTags = r.matchedTags.map(t => {
                    if (typeof t === 'string') return t;
                    if (t && t.name) return t.name;
                    return String(t);
                });
            }
            if (r.source === 'time' && !finalTags.includes('time')) {
                finalTags.push('time');
            }
            if (finalTags.length > 0) {
                cleaned.matchedTags = finalTags;
            }
            
            if (r.tagMatchCount !== undefined) cleaned.tagMatchCount = r.tagMatchCount;
            if (r.boostFactor !== undefined) cleaned.boostFactor = r.boostFactor;
            // 🛡️ 确保 coreTagsMatched 是纯字符串数组 (脱水处理)
            if (r.coreTagsMatched && Array.isArray(r.coreTagsMatched)) {
                cleaned.coreTagsMatched = r.coreTagsMatched.map(t => {
                    if (typeof t === 'string') return t;
                    if (t && t.name) return t.isCore ? `!${t.name}` : t.name;
                    return String(t);
                });
            }

            return cleaned;
        });
    }

    /**
     * ✅ 新增：汇总Tag统计信息
     */
    _aggregateTagStats(results) {
        const allMatchedTags = new Set();
        let totalBoostFactor = 0;
        let resultsWithTags = 0;

        for (const r of results) {
            if (r.matchedTags && r.matchedTags.length > 0) {
                r.matchedTags.forEach(tag => allMatchedTags.add(tag));
                resultsWithTags++;
                if (r.boostFactor) totalBoostFactor += r.boostFactor;
            }
        }

        return {
            uniqueMatchedTags: Array.from(allMatchedTags),
            totalTagMatches: allMatchedTags.size,
            resultsWithTags: resultsWithTags,
            avgBoostFactor: resultsWithTags > 0 ? (totalBoostFactor / resultsWithTags).toFixed(3) : 1.0
        };
    }

    async getSingleEmbedding(text) {
        if (!text) {
            console.error('[RAGDiaryPlugin] getSingleEmbedding was called with no text.');
            return null;
        }

        const apiKey = process.env.API_Key;
        const apiUrl = process.env.API_URL;
        const embeddingModel = process.env.WhitelistEmbeddingModel;

        if (!apiKey || !apiUrl || !embeddingModel) {
            console.error('[RAGDiaryPlugin] Embedding API credentials or model is not configured in environment variables.');
            return null;
        }

        // 1. 使用 TextChunker 分割文本以避免超长
        const textChunks = chunkText(text);
        if (!textChunks || textChunks.length === 0) {
            console.log('[RAGDiaryPlugin] Text chunking resulted in no chunks.');
            return null;
        }

        if (textChunks.length > 1) {
            console.log(`[RAGDiaryPlugin] Text is too long, split into ${textChunks.length} chunks for embedding.`);
        }

        const maxRetries = 3;
        const retryDelay = 1000; // 1 second

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await axios.post(`${apiUrl}/v1/embeddings`, {
                    model: embeddingModel,
                    input: textChunks // 传入所有文本块
                }, {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    }
                });

                const embeddings = response.data?.data;
                if (!embeddings || embeddings.length === 0) {
                    console.error('[RAGDiaryPlugin] No embeddings found in the API response.');
                    return null;
                }

                const vectors = embeddings.map(e => e.embedding).filter(Boolean);
                if (vectors.length === 0) {
                    console.error('[RAGDiaryPlugin] No valid embedding vectors in the API response data.');
                    return null;
                }

                // 如果只有一个向量，直接返回；否则，计算平均向量
                if (vectors.length === 1) {
                    return vectors[0];
                } else {
                    console.log(`[RAGDiaryPlugin] Averaging ${vectors.length} vectors into one.`);
                    return this._getAverageVector(vectors);
                }
            } catch (error) {
                const status = error.response ? error.response.status : null;

                if ((status === 500 || status === 503) && attempt < maxRetries) {
                    console.warn(`[RAGDiaryPlugin] Embedding API call failed with status ${status}. Attempt ${attempt} of ${maxRetries}. Retrying in ${retryDelay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                }

                if (error.response) {
                    console.error(`[RAGDiaryPlugin] Embedding API Error: ${error.message} (Status: ${error.response.status})`);
                } else {
                    console.error('[RAGDiaryPlugin] An error occurred while setting up the embedding request:', error.message);
                }
                return null; // Return null after final attempt or for non-retriable errors
            }
        }
        return null; // Should not be reached, but as a fallback
    }

    //####################################################################################
    //## Cache System - 缓存系统（使用 CacheManager）
    //####################################################################################

    _generateCacheKey(params) {
        const {
            userContent = '',
            aiContent = '',
            dbName = '',
            modifiers = '',
            chainName = '',
            kSequence = [],
            dynamicK = null,
            useGroup = false,
            isAutoMode = false,
            ghostTags = []
        } = params;

        const currentDate = modifiers.includes('::Time')
            ? dayjs().tz(DEFAULT_TIMEZONE).format('YYYY-MM-DD')
            : 'static';

        const ghostTagString = ghostTags.map(t => `${t.isCore ? '!' : ''}${t.name}`).sort().join(',');

        return this.cacheManager.generateKey({
            user: userContent.trim(),
            ai: aiContent ? aiContent.trim() : null,
            db: dbName,
            mod: modifiers,
            chain: chainName,
            k_seq: kSequence.join('-'),
            k_dyn: dynamicK,
            group: useGroup,
            auto: isAutoMode,
            date: currentDate,
            ghosts: ghostTagString
        });
    }

    _getCachedResult(cacheKey) {
        if (!this.queryCacheEnabled) return null;
        return this.cacheManager.get('query', cacheKey);
    }

    _setCachedResult(cacheKey, result) {
        if (!this.queryCacheEnabled) return;
        this.cacheManager.set('query', cacheKey, result);
    }

    getCacheStats() {
        return this.cacheManager.getStats('query');
    }

    //####################################################################################
    //## Embedding Cache - 向量缓存系统（使用 CacheManager）
    //####################################################################################

    /**
     * ✅ 批量向量化方法（支持 OpenAI 兼容接口）
     */
    async getBatchEmbeddings(texts) {
        if (!texts || !Array.isArray(texts) || texts.length === 0) return [];

        const apiKey = process.env.API_Key;
        const apiUrl = process.env.API_URL;
        const embeddingModel = process.env.WhitelistEmbeddingModel;

        if (!apiKey || !apiUrl || !embeddingModel) {
            console.error('[RAGDiaryPlugin] Embedding API credentials or model is not configured.');
            return new Array(texts.length).fill(null);
        }

        const validTasks = texts.map((text, index) => ({ text, index })).filter(t => t.text && t.text.trim());
        if (validTasks.length === 0) return new Array(texts.length).fill(null);

        const results = new Array(texts.length).fill(null);
        const maxRetries = 3;
        const retryDelay = 1000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await axios.post(`${apiUrl}/v1/embeddings`, {
                    model: embeddingModel,
                    input: validTasks.map(t => t.text)
                }, {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000 // 批量请求可能需要更长时间
                });

                const embeddings = response.data?.data;
                if (embeddings && Array.isArray(embeddings)) {
                    embeddings.forEach((e, i) => {
                        const originalIndex = validTasks[i].index;
                        results[originalIndex] = e.embedding;
                    });
                    return results;
                } else {
                    console.error('[RAGDiaryPlugin] No embeddings found in batch response.');
                    if (attempt === maxRetries) return results;
                }
            } catch (error) {
                const status = error.response ? error.response.status : null;
                if ((status === 500 || status === 503 || status === 429) && attempt < maxRetries) {
                    console.warn(`[RAGDiaryPlugin] Batch Embedding API failed (${status}). Attempt ${attempt}/${maxRetries}. Retrying...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                }
                console.error('[RAGDiaryPlugin] Batch embedding API error:', error.message);
                return results;
            }
        }
        return results;
    }

    async getBatchEmbeddingsCached(texts) {
        if (!texts || !Array.isArray(texts) || texts.length === 0) return [];

        const results = new Array(texts.length).fill(null);
        const missingIndices = [];
        const missingTexts = [];

        texts.forEach((text, index) => {
            if (!text || !text.trim()) return;
            const cacheKey = this.cacheManager.generateKey({ text: text.trim() });
            const vector = this.cacheManager.get('embedding', cacheKey);
            if (vector) {
                results[index] = vector;
            } else {
                missingIndices.push(index);
                missingTexts.push(text);
            }
        });

        if (missingTexts.length > 0) {
            console.log(`[RAGDiaryPlugin] Batch cache miss: ${missingTexts.length}/${texts.length} texts. Requesting API...`);
            const newEmbeddings = await this.getBatchEmbeddings(missingTexts);
            newEmbeddings.forEach((vec, i) => {
                if (vec) {
                    const originalIndex = missingIndices[i];
                    results[originalIndex] = vec;
                    const text = missingTexts[i];
                    const cacheKey = this.cacheManager.generateKey({ text: text.trim() });
                    this.cacheManager.set('embedding', cacheKey, vec);
                }
            });
        }

        return results;
    }

    async getSingleEmbeddingCached(text) {
        if (!text || !text.trim()) return null;

        const cacheKey = this.cacheManager.generateKey({ text: text.trim() });
        const cached = this.cacheManager.get('embedding', cacheKey);
        if (cached) return cached;

        const vector = await this.getSingleEmbedding(text);
        if (vector) {
            this.cacheManager.set('embedding', cacheKey, vector);
        }

        return vector;
    }

    /**
     * ✅ 仅从缓存获取向量（不触发 API）
     * 恢复此方法以保持与 ContextVectorManager 等模块的兼容性
     */
    _getEmbeddingFromCacheOnly(text) {
        if (!text) return null;
        const cacheKey = this.cacheManager.generateKey({ text: text.trim() });
        return this.cacheManager.get('embedding', cacheKey);
    }

    /**
     * ✅ 关闭插件，清理定时器
     */
    /**
     * 🌟 V7 新增：从文本中提取附件链接
     * 支持 http, https, file 协议
     * 排除表情包路径
     */
    _extractAttachments(text) {
        if (!text) return [];
        // 匹配 http, https, file 协议的链接
        const regex = /(https?:\/\/[^\s\)\"\'\>]+|file:\/\/[^\s\)\"\'\>]+)/gi;
        const matches = text.match(regex) || [];
        
        return matches.filter(url => {
            const lowerUrl = url.toLowerCase();
            // 排除表情包路径
            if (lowerUrl.includes('表情包') || lowerUrl.includes('emoji') || lowerUrl.includes('sticker')) {
                return false;
            }
            // 检查常见的媒体后缀
            return /\.(jpg|jpeg|png|gif|webp|mp3|wav|ogg|mp4|webm|pdf)$/i.test(lowerUrl);
        });
    }

    /**
     * 🌟 V7 新增：获取链接内容的 Base64
     */
    async _fetchAsBase64(url) {
        try {
            let buffer;
            let mimeType;

            if (url.startsWith('file://')) {
                // 处理本地文件
                let filePath = url.replace(/^file:\/\/\/?/, '');
                // Windows 路径处理：如果路径以 H: 这种开头，确保格式正确
                if (/^[a-zA-Z]:/.test(filePath)) {
                    // 保持原样
                } else if (filePath.startsWith('/')) {
                    // 可能需要根据系统调整
                }
                
                // 尝试解码 URL 编码的路径
                try {
                    filePath = decodeURIComponent(filePath);
                } catch (e) {}

                buffer = await fs.readFile(filePath);
                mimeType = mime.lookup(filePath) || 'application/octet-stream';
            } else {
                // 处理网络链接
                const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
                buffer = Buffer.from(response.data);
                mimeType = response.headers['content-type'] || mime.lookup(url) || 'application/octet-stream';
            }

            if (buffer) {
                const base64 = buffer.toString('base64');
                return `data:${mimeType};base64,${base64}`;
            }
        } catch (e) {
            console.error(`[RAGDiaryPlugin] 🌟 V7: 获取附件 Base64 失败 (${url}):`, e.message);
        }
        return null;
    }

    //####################################################################################
    //## 🌟 V2折叠：上下文同步到 FoldingStore
    //####################################################################################

    /**
     * 将当前上下文中的 assistant 消息同步到 FoldingStore
     * 仅在 vectorMap 中已有向量的消息才会被写入（不触发额外 API 调用）
     */
    _syncContextToFoldingStore(messages) {
        if (!this.foldingStore) return;

        let syncCount = 0;
        for (const msg of messages) {
            if (msg.role !== 'assistant') continue;

            const content = typeof msg.content === 'string'
                ? msg.content
                : (Array.isArray(msg.content) ? msg.content.find(p => p.type === 'text')?.text : '') || '';

            if (!content || content.length < 10) continue;
            // 跳过已折叠的内容
            if (content.startsWith('[VCP上下文语义折叠-')) continue;

            const sanitized = this.sanitizeForEmbedding(content, 'assistant');
            if (!sanitized) continue;

            const hash = FoldingStore.hashContent(sanitized);

            // 查 store 是否已有此条目（含持久化向量）
            const existing = this.foldingStore.getEntry(hash);
            if (existing && existing.vector) continue; // 已有完整条目，跳过

            // 尝试从内存缓存获取向量（不触发 API）
            let vector = this._getEmbeddingFromCacheOnly(sanitized);

            // 重启恢复：如果内存缓存为空但 store 中已有旧条目（无向量），保留旧条目等待 V2 补充
            if (!vector && existing) continue;

            this.foldingStore.upsertVector(hash, {
                textPreview: sanitized.substring(0, 80),
                vector: vector // 可能为 null，后续由 ContextFoldingV2 的 embedText 补充
            });
            syncCount++;
        }

        if (syncCount > 0) {
            console.log(`[RAGDiaryPlugin] V2折叠: 同步了 ${syncCount} 个新 assistant 块到 FoldingStore`);
        }
    }

    //####################################################################################
    //## 🌟 ContextBridge - 上下文向量引力场公开只读接口
    //####################################################################################

    /**
     * 🌟 ContextBridge: 暴露上下文向量引力场的只读查询接口
     * 供其他插件通过 PluginManager 依赖注入使用
     *
     * 设计原则：
     * 1. 只读 — Object.freeze 防止外部修改内部状态
     * 2. 懒计算 — 聚合向量按需计算，不预先生成
     * 3. 安全 — 所有方法都有空值保护，不会因调用方传入无效参数而崩溃
     *
     * 使用方式：
     *   在 plugin-manifest.json 中声明 "requiresContextBridge": true
     *   然后在 initialize(config, dependencies) 中通过 dependencies.contextBridge 获取
     *
     * @returns {Readonly<Object>} 冻结的只读接口对象
     */
    getContextBridge() {
        const self = this;
        const BRIDGE_VERSION = '1.0';

        return Object.freeze({
            /** 接口版本号，用于未来兼容性检查 */
            version: BRIDGE_VERSION,

            // ═══════════════════════════════════════════════════
            // 上下文向量查询
            // ═══════════════════════════════════════════════════

            /**
             * 获取当前会话的衰减聚合上下文向量
             * 近期楼层权重更高，远期楼层指数衰减
             * @param {string} [role='assistant'] - 'assistant' 或 'user'
             * @returns {Float32Array|null} 聚合后的向量，无数据时返回 null
             */
            getAggregatedVector(role = 'assistant') {
                return self.contextVectorManager.aggregateContext(role);
            },

            /**
             * 获取所有历史 AI 输出的向量列表（按时间顺序）
             * @returns {Array<Float32Array>} 向量数组，可能为空
             */
            getHistoryAssistantVectors() {
                return self.contextVectorManager.getHistoryAssistantVectors();
            },

            /**
             * 获取所有历史用户输入的向量列表（按时间顺序）
             * @returns {Array<Float32Array>} 向量数组，可能为空
             */
            getHistoryUserVectors() {
                return self.contextVectorManager.getHistoryUserVectors();
            },

            /**
             * 获取语义分段后的主题向量列表
             * 将连续的、高相似度的消息归并为一个段落 (Segment/Topic)
             * @param {Array} messages - 消息列表
             * @param {number} [similarityThreshold=0.70] - 分段阈值
             * @returns {Array<{vector: Float32Array, text: string, roles: string[], range: [number, number], count: number}>}
             */
            getContextSegments(messages, similarityThreshold) {
                if (!Array.isArray(messages)) return [];
                return self.contextVectorManager.segmentContext(messages, similarityThreshold);
            },

            // ═══════════════════════════════════════════════════
            // EPA 指标计算
            // ═══════════════════════════════════════════════════

            /**
             * 计算向量的逻辑深度指数 L
             * L ≈ 1 → 能量集中在少数维度，逻辑聚焦
             * L ≈ 0 → 能量分散，逻辑模糊
             * @param {Array|Float32Array} vector - 输入向量
             * @returns {number} L ∈ [0, 1]
             */
            computeLogicDepth(vector) {
                if (!vector) return 0;
                return self.contextVectorManager.computeLogicDepth(vector);
            },

            /**
             * 计算向量的语义宽度指数 S
             * S ≈ 1 → 能量均匀分布，语义宽泛
             * S ≈ 0 → 能量集中少数维度，语义精准
             * @param {Array|Float32Array} vector - L2归一化向量
             * @returns {number} S ∈ [0, 1]
             */
            computeSemanticWidth(vector) {
                if (!vector) return 0;
                return self.contextVectorManager.computeSemanticWidth(vector);
            },

            // ═══════════════════════════════════════════════════
            // 向量化工具
            // ═══════════════════════════════════════════════════

            /**
             * 带缓存的单文本向量化（缓存未命中时会触发 Embedding API）
             * @param {string} text - 要向量化的文本
             * @returns {Promise<Array<number>|null>} 向量数组或 null
             */
            async embedText(text) {
                if (!text || typeof text !== 'string' || !text.trim()) return null;
                return self.getSingleEmbeddingCached(text);
            },

            /**
             * 带缓存的批量向量化（缓存未命中时会触发 Embedding API）
             * @param {string[]} texts - 要向量化的文本数组
             * @returns {Promise<Array<Array<number>|null>>} 向量数组，失败位置为 null
             */
            async embedBatch(texts) {
                if (!Array.isArray(texts) || texts.length === 0) return [];
                return self.getBatchEmbeddingsCached(texts);
            },

            /**
             * 仅从内存缓存获取向量（不触发 API，适合高频调用场景）
             * @param {string} text - 要查询的文本
             * @returns {Array<number>|null} 缓存中的向量或 null
             */
            getEmbeddingFromCache(text) {
                if (!text || typeof text !== 'string') return null;
                return self._getEmbeddingFromCacheOnly(text);
            },

            // ═══════════════════════════════════════════════════
            // 文本处理工具
            // ═══════════════════════════════════════════════════

            /**
             * 统一内容净化器 - 移除 HTML、Emoji、工具调用标记等噪音
             * 确保向量化输入的一致性
             * @param {string} content - 原始文本
             * @param {string} role - 角色 ('user' 或 'assistant')
             * @returns {string} 净化后的文本
             */
            sanitize(content, role) {
                return self.sanitizeForEmbedding(content, role);
            },

            // ═══════════════════════════════════════════════════
            // 向量数学工具
            // ═══════════════════════════════════════════════════

            /**
             * 余弦相似度计算
             * @param {Array|Float32Array} vecA - 向量 A
             * @param {Array|Float32Array} vecB - 向量 B
             * @returns {number} 相似度 ∈ [-1, 1]，无效输入返回 0
             */
            cosineSimilarity(vecA, vecB) {
                return self.cosineSimilarity(vecA, vecB);
            },

            /**
             * 加权平均向量计算
             * @param {Array<Array<number>>} vectors - 向量数组
             * @param {Array<number>} weights - 对应权重数组
             * @returns {Array<number>|null} 加权平均向量或 null
             */
            weightedAverage(vectors, weights) {
                if (!Array.isArray(vectors) || !Array.isArray(weights)) return null;
                return self._getWeightedAverageVector(vectors, weights);
            },

            /**
             * 多向量平均值计算
             * @param {Array<Array<number>>} vectors - 向量数组
             * @returns {Array<number>|null} 平均向量或 null
             */
            averageVector(vectors) {
                if (!Array.isArray(vectors)) return null;
                return self._getAverageVector(vectors);
            },

            // ═══════════════════════════════════════════════════
            // 🌟 V2折叠：FoldingStore 接口（动态 Getter，解决初始化时序竞态）
            // ═══════════════════════════════════════════════════

            /** FoldingStore 读写接口，供 ContextFoldingV2 使用
             *  使用 getter 动态获取，避免静态快照导致的初始化竞态：
             *  即使 getContextBridge() 被调用时 foldingStore 尚为 null，
             *  后续访问时仍能拿到正确的实例。
             */
            get foldingStore() {
                if (!self.foldingStore) return null;
                return Object.freeze({
                    /**
                     * 获取条目
                     * @param {string} contentHash - SHA-256 哈希
                     * @returns {object|null} 条目数据
                     */
                    getEntry(contentHash) {
                        return self.foldingStore.getEntry(contentHash);
                    },

                    /**
                     * 写入/更新向量
                     * @param {string} contentHash
                     * @param {object} data - { textPreview, vector }
                     */
                    upsertVector(contentHash, data) {
                        self.foldingStore.upsertVector(contentHash, data);
                    },

                    /**
                     * 写入摘要结果
                     * @param {string} contentHash
                     * @param {string} summary
                     * @param {string} status - 'ready' | 'failed'
                     */
                    upsertSummary(contentHash, summary, status) {
                        self.foldingStore.upsertSummary(contentHash, summary, status);
                    },

                    /**
                     * 标记为摘要生成中
                     * @param {string} contentHash
                     */
                    markPending(contentHash) {
                        self.foldingStore.markPending(contentHash);
                    },

                    /**
                     * 获取统计信息
                     * @returns {{ count, maxEntries, available }}
                     */
                    getStats() {
                        return self.foldingStore.getStats();
                    },

                    /**
                     * 生成内容哈希的静态工具方法
                     * @param {string} sanitizedContent
                     * @returns {string}
                     */
                    hashContent(sanitizedContent) {
                        return FoldingStore.hashContent(sanitizedContent);
                    }
                });
            }
        });
    }

    shutdown() {
        if (this.ragParamsWatcher) {
            this.ragParamsWatcher.close();
            this.ragParamsWatcher = null;
        }
        this.cacheManager.shutdown();

        // 🌟 V2折叠：关闭 FoldingStore
        if (this.foldingStore) {
            this.foldingStore.shutdown();
            this.foldingStore = null;
        }

        console.log(`[RAGDiaryPlugin] 插件已关闭`);
    }
}

// 导出实例以供 Plugin.js 加载
module.exports = new RAGDiaryPlugin();