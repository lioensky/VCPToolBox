// KnowledgeBaseManager.js
// 🌟 架构重构修复版：多路独立索引 + 稳健的 Buffer 处理 + 同步缓存回退 + TagMemo 逻辑回归

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const chokidar = require('chokidar');
const { chunkText } = require('./TextChunker');
const { getEmbeddingsBatch } = require('./EmbeddingUtils');
const ResultDeduplicator = require('./ResultDeduplicator'); // ✅ Tagmemo v4 requirement
const TagMemoEngine = require('./TagMemoEngine');

// 尝试加载 Rust Vexus 引擎
let VexusIndex = null;
try {
    const vexusModule = require('./rust-vexus-lite');
    VexusIndex = vexusModule.VexusIndex;
    console.log('[KnowledgeBase] 🦀 Vexus-Lite Rust engine loaded');
} catch (e) {
    console.error('[KnowledgeBase] ❌ Critical: Vexus-Lite not found.');
    process.exit(1);
}

class KnowledgeBaseManager {
    constructor(config = {}) {
        this.config = {
            rootPath: config.rootPath || process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(__dirname, 'dailynote'),
            storePath: config.storePath || process.env.KNOWLEDGEBASE_STORE_PATH || path.join(__dirname, 'VectorStore'),
            apiKey: process.env.API_Key,
            apiUrl: process.env.API_URL,
            model: process.env.WhitelistEmbeddingModel || 'google/gemini-embedding-001',
            // ⚠️ 务必确认环境变量 VECTORDB_DIMENSION 与模型一致 (3-small通常为1536)
            dimension: parseInt(process.env.VECTORDB_DIMENSION) || 3072,

            batchWindow: parseInt(process.env.KNOWLEDGEBASE_BATCH_WINDOW_MS, 10) || 2000,
            maxBatchSize: parseInt(process.env.KNOWLEDGEBASE_MAX_BATCH_SIZE, 10) || 50,
            indexSaveDelay: parseInt(process.env.KNOWLEDGEBASE_INDEX_SAVE_DELAY, 10) || 120000,
            tagIndexSaveDelay: parseInt(process.env.KNOWLEDGEBASE_TAG_INDEX_SAVE_DELAY, 10) || 300000,
            // 🌟 索引空闲自动卸载：默认 2 小时未使用则从内存中卸载
            indexIdleTTL: parseInt(process.env.KNOWLEDGEBASE_INDEX_IDLE_TTL_MS, 10) || 2 * 60 * 60 * 1000,
            indexIdleSweepInterval: parseInt(process.env.KNOWLEDGEBASE_INDEX_IDLE_SWEEP_MS, 10) || 10 * 60 * 1000,

            ignoreFolders: (process.env.IGNORE_FOLDERS || 'VCP论坛').split(',').map(f => f.trim()).filter(Boolean),
            ignorePrefixes: (process.env.IGNORE_PREFIXES || process.env.IGNORE_PREFIX || '已整理').split(',').map(p => p.trim()).filter(Boolean),
            ignoreSuffixes: (process.env.IGNORE_SUFFIXES || process.env.IGNORE_SUFFIX || '夜伽').split(',').map(s => s.trim()).filter(Boolean),

            tagBlacklist: new Set((process.env.TAG_BLACKLIST || '').split(',').map(t => t.trim()).filter(Boolean)),
            tagBlacklistSuper: (process.env.TAG_BLACKLIST_SUPER || '').split(',').map(t => t.trim()).filter(Boolean),
            tagExpandMaxCount: parseInt(process.env.TAG_EXPAND_MAX_COUNT, 10) || 30,
            fullScanOnStartup: (process.env.KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP || 'true').toLowerCase() === 'true',
            // 语言置信度补偿配置
            langConfidenceEnabled: (process.env.LANG_CONFIDENCE_GATING_ENABLED || 'true').toLowerCase() === 'true',
            langPenaltyUnknown: parseFloat(process.env.LANG_PENALTY_UNKNOWN) || 0.05,
            // 🌟 是否默认持久化索引（建议 false，仅在内存重建以保证原子性）
            // 🌟 是否持久化全局 Tag 索引
            persistTagIndex: (process.env.KNOWLEDGEBASE_PERSIST_TAG_INDEX || 'false').toLowerCase() === 'true',
            // 🌟 是否默认持久化索引（建议 false，仅在内存重建以保证原子性）
            persistDefault: (process.env.KNOWLEDGEBASE_PERSIST_DEFAULT || 'false').toLowerCase() === 'true',
            // 🌟 强制开启持久化的文件夹白名单 (支持中英文逗号)
            persistFolders: new Set((process.env.KNOWLEDGEBASE_PERSIST_FOLDERS || '').split(/[,，]/).map(f => f.trim()).filter(Boolean)),
            ...config
        };

        this.db = null;
        this.diaryIndices = new Map();
        this.diaryIndexLastUsed = new Map(); // 🌟 记录每个索引的最后使用时间
        this.idleSweepTimer = null;
        this.tagIndex = null;
        this.watcher = null;
        this.initialized = false;
        this.diaryNameVectorCache = new Map();
        this.pendingFiles = new Set();
        this.fileRetryCount = new Map(); // 🛡️ 文件重试计数器，防止无限循环
        this.batchTimer = null;
        this.isProcessing = false;
        this.saveTimers = new Map();
        this.tagMemoEngine = null;
        this.resultDeduplicator = null; // ✅ Tagmemo v4
        this.ragParams = {}; // ✅ 新增：用于存储热调控参数
        this.ragParamsWatcher = null;

    }

    async initialize() {
        if (this.initialized) return;
        console.log(`[KnowledgeBase] Initializing Multi-Index System (Dim: ${this.config.dimension})...`);

        await fs.mkdir(this.config.storePath, { recursive: true });

        const dbPath = path.join(this.config.storePath, 'knowledge_base.sqlite');
        this.db = new Database(dbPath); // 同步连接
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');

        this._initSchema();

        // 1. 初始化全局 Tag 索引 (优先从磁盘加载或从 SQLite 重建)
        const tagCapacity = 50000;
        const tagIdxPath = path.join(this.config.storePath, 'index_global_tags.usearch');
        let indexReady = false;

        // 全局 Tag 索引持久化判定：显式开关 OR 白名单包含 'global_tags'
        const shouldPersistTags = this.config.persistTagIndex || this.config.persistFolders.has('global_tags');

        if (shouldPersistTags && fsSync.existsSync(tagIdxPath)) {
            try {
                this.tagIndex = VexusIndex.load(tagIdxPath, null, this.config.dimension, tagCapacity);
                console.log('[KnowledgeBase] ✅ Global Tag Index loaded from disk.');
                indexReady = true;
            } catch (e) {
                console.warn(`[KnowledgeBase] ⚠️ Failed to load tag index from disk: ${e.message}. Rebuilding...`);
            }
        }

        if (!indexReady) {
            console.log('[KnowledgeBase] 🚀 Building Global Tag Index from SQLite...');
            this.tagIndex = new VexusIndex(this.config.dimension, tagCapacity);
            try {
                const count = await this.tagIndex.recoverFromSqlite(dbPath, 'tags', null);
                console.log(`[KnowledgeBase] ✅ Global Tag Index ready. ${count} vectors indexed.`);
                // 如果开启了持久化但文件不存在，则保存一次
                if (shouldPersistTags) this._saveIndexToDisk('global_tags');
            } catch (e) {
                console.error(`[KnowledgeBase] ❌ Global Tag Index recovery failed: ${e.message}`);
            }
        }

        // 2. 预热日记本名称向量缓存（同步阻塞，确保 RAG 插件启动即可用）
        this._hydrateDiaryNameCacheSync();

        // ✅ Tagmemo v4: 初始化结果去重器
        this.resultDeduplicator = new ResultDeduplicator(this.db, {
            dimension: this.config.dimension
        });

        await this.loadRagParams();

        // 初始化浪潮引擎
        this.tagMemoEngine = new TagMemoEngine(this.db, this.tagIndex, this.config, this.ragParams);
        await this.tagMemoEngine.initialize();

        this._startWatcher();
        this._startRagParamsWatcher();
        this._startIdleSweep(); // 🌟 启动空闲索引自动卸载

        this.initialized = true;
        console.log('[KnowledgeBase] ✅ System Ready');
    }

    /**
     * ✅ 新增：加载 RAG 热调控参数
     */
    async loadRagParams() {
        const paramsPath = path.join(__dirname, 'rag_params.json');
        try {
            const data = await fs.readFile(paramsPath, 'utf-8');
            this.ragParams = JSON.parse(data);
            console.log('[KnowledgeBase] ✅ RAG 热调控参数已加载');
            if (this.tagMemoEngine) this.tagMemoEngine.updateRagParams(this.ragParams);
        } catch (e) {
            console.error('[KnowledgeBase] ❌ 加载 rag_params.json 失败:', e.message);
            this.ragParams = { KnowledgeBaseManager: {} };
        }
    }

    /**
     * ✅ 新增：启动参数监听器
     */
    _startRagParamsWatcher() {
        const paramsPath = path.join(__dirname, 'rag_params.json');
        if (this.ragParamsWatcher) return;

        this.ragParamsWatcher = chokidar.watch(paramsPath);
        this.ragParamsWatcher.on('change', async () => {
            console.log('[KnowledgeBase] 🔄 检测到 rag_params.json 变更，正在重新加载...');
            await this.loadRagParams();
        });
    }

    _initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT UNIQUE NOT NULL,
                diary_name TEXT NOT NULL,
                checksum TEXT NOT NULL,
                mtime INTEGER NOT NULL,
                size INTEGER NOT NULL,
                updated_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id INTEGER NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                vector BLOB,
                FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                vector BLOB
            );
            CREATE TABLE IF NOT EXISTS file_tags (
                file_id INTEGER NOT NULL,
                tag_id INTEGER NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (file_id, tag_id),
                FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE,
                FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS tag_intrinsic_residuals (
                tag_id INTEGER PRIMARY KEY,
                residual_energy REAL NOT NULL,
                neighbor_count INTEGER NOT NULL,
                computed_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS kv_store (
                key TEXT PRIMARY KEY,
                value TEXT,
                vector BLOB
            );
            CREATE INDEX IF NOT EXISTS idx_files_diary ON files(diary_name);
            CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
            CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);
            CREATE INDEX IF NOT EXISTS idx_file_tags_composite ON file_tags(tag_id, file_id);
            
            -- TagMemo V7: 检查并添加 position 列（针对现有数据库）
            BEGIN;
            SELECT CASE WHEN count(*) = 0 THEN 
                'ALTER TABLE file_tags ADD COLUMN position INTEGER NOT NULL DEFAULT 0' 
            ELSE 
                'SELECT 1' 
            END FROM pragma_table_info('file_tags') WHERE name='position';
            COMMIT;
        `);
        
        // 🛠️ 核心修复：由于 db.exec 不支持动态执行 SELECT 返回的 SQL，我们手动补丁
        try {
            this.db.prepare("ALTER TABLE file_tags ADD COLUMN position INTEGER NOT NULL DEFAULT 0").run();
        } catch (e) {
            // 如果列已存在，SQLite 会报错，忽略即可
        }
    }

    // 🏭 索引工厂
    async _getOrLoadDiaryIndex(diaryName) {
        // 🌟 每次访问都刷新最后使用时间
        this.diaryIndexLastUsed.set(diaryName, Date.now());
        if (this.diaryIndices.has(diaryName)) {
            return this.diaryIndices.get(diaryName);
        }

        const shouldPersist = this.config.persistDefault || this.config.persistFolders.has(diaryName) || diaryName.endsWith('簇');
        console.log(`[KnowledgeBase] 📂 Loading index for diary: "${diaryName}" (Persist: ${shouldPersist})`);
        
        const safeName = crypto.createHash('md5').update(diaryName).digest('hex');
        const fileName = `diary_${safeName}`;
        const capacity = 50000;

        let idx;
        if (shouldPersist) {
            idx = await this._loadOrBuildIndex(fileName, capacity, 'chunks', diaryName);
        } else {
            // 🚀 核心改动：非持久化文件夹直接在内存重建
            idx = new VexusIndex(this.config.dimension, capacity);
            await this._recoverIndexFromDB(idx, 'chunks', diaryName);
        }

        this.diaryIndices.set(diaryName, idx);
        return idx;
    }

    async _loadOrBuildIndex(fileName, capacity, tableType, filterDiaryName = null) {
        const idxPath = path.join(this.config.storePath, `index_${fileName}.usearch`);
        let idx;
        try {
            if (fsSync.existsSync(idxPath)) {
                idx = VexusIndex.load(idxPath, null, this.config.dimension, capacity);
            } else {
                // 💡 核心修复：如果索引文件不存在，说明是首次创建。
                // 此时不应从数据库恢复，因为调用者（_flushBatch）正准备写入初始数据。
                // 从数据库恢复的逻辑只适用于启动时加载或文件损坏后的重建。
                console.log(`[KnowledgeBase] Index file not found for ${fileName}, creating a new empty one.`);
                idx = new VexusIndex(this.config.dimension, capacity);
            }
        } catch (e) {
            console.error(`[KnowledgeBase] Index load error (${fileName}): ${e.message}`);
            console.warn(`[KnowledgeBase] Rebuilding index ${fileName} from DB as a fallback...`);
            idx = new VexusIndex(this.config.dimension, capacity);
            await this._recoverIndexFromDB(idx, tableType, filterDiaryName);
        }
        return idx;
    }

    async _recoverIndexFromDB(vexusIdx, table, diaryName) {
        console.log(`[KnowledgeBase] 🔄 Recovering ${table} (Filter: ${diaryName || 'None'}) via Rust...`);
        try {
            const dbPath = path.join(this.config.storePath, 'knowledge_base.sqlite');
            // 注意：NAPI-RS 暴露的函数名是驼峰式
            const count = await vexusIdx.recoverFromSqlite(dbPath, table, diaryName || null);
            console.log(`[KnowledgeBase] ✅ Recovered ${count} vectors via Rust.`);
        } catch (e) {
            console.error(`[KnowledgeBase] ❌ Rust recovery failed for ${table}:`, e);
        }
    }


    // =========================================================================
    // 核心搜索接口 (修复版)
    // =========================================================================

    async search(arg1, arg2, arg3, arg4, arg5, arg6) {
        try {
            let diaryName = null;
            let queryVec = null;
            let k = 5;
            let tagBoost = 0;
            let coreTags = [];
            let coreBoostFactor = 1.33; // 默认 33% 提升

            if (typeof arg1 === 'string' && Array.isArray(arg2)) {
                diaryName = arg1;
                queryVec = arg2;
                k = arg3 || 5;
                tagBoost = arg4 || 0;
                coreTags = arg5 || [];
                coreBoostFactor = arg6 || 1.33;
            } else if (typeof arg1 === 'string') {
                // 纯文本搜索暂略，通常插件会先向量化
                return [];
            } else if (Array.isArray(arg1)) {
                queryVec = arg1;
                k = arg2 || 5;
                tagBoost = arg3 || 0;
            }

            if (!queryVec) return [];

            if (diaryName) {
                return await this._searchSpecificIndex(diaryName, queryVec, k, tagBoost, coreTags, coreBoostFactor);
            } else {
                return await this._searchAllIndices(queryVec, k, tagBoost, coreTags, coreBoostFactor);
            }
        } catch (e) {
            console.error('[KnowledgeBase] Search Error:', e);
            return [];
        }
    }

    async _searchSpecificIndex(diaryName, vector, k, tagBoost, coreTags = [], coreBoostFactor = 1.33) {
        const idx = await this._getOrLoadDiaryIndex(diaryName);

        // 如果索引为空，直接返回
        // 注意：vexus-lite-js 可能没有 size() 方法，用 catch 捕获
        try {
            const stats = idx.stats ? idx.stats() : { totalVectors: 1 };
            if (stats.totalVectors === 0) return [];
        } catch (e) { }

        // 🛠️ 修复 1: 安全的 Float32Array 转换
        let searchVecFloat;
        let tagInfo = null;

        try {
            if (tagBoost > 0 && this.tagMemoEngine) {
                // 🌟 TagMemo 逻辑回归：应用 Tag 增强 (强制使用 V6)
                const boostResult = this.tagMemoEngine.applyTagBoost(new Float32Array(vector), tagBoost, coreTags, coreBoostFactor);
                searchVecFloat = boostResult.vector;
                tagInfo = boostResult.info;
            } else {
                searchVecFloat = vector instanceof Float32Array ? vector : new Float32Array(vector);
            }

            // ⚠️ 维度检查
            if (searchVecFloat.length !== this.config.dimension) {
                console.error(`[KnowledgeBase] Dimension mismatch! Expected ${this.config.dimension}, got ${searchVecFloat.length}`);
                return [];
            }
        } catch (err) {
            console.error(`[KnowledgeBase] Vector processing failed: ${err.message}`);
            return [];
        }

        let results = [];
        try {
            results = idx.search(searchVecFloat, k);
        } catch (e) {
            // 🛠️ 修复 2: 详细的错误日志
            console.error(`[KnowledgeBase] Vexus search failed for "${diaryName}":`, e.message || e);
            return [];
        }

        // Hydrate results
        const hydrate = this.db.prepare(`
            SELECT c.content as text, f.path as sourceFile, f.updated_at
            FROM chunks c
            JOIN files f ON c.file_id = f.id
            WHERE c.id = ?
        `);

        return results.map(res => {
            // 🛠️ 修复：res.id 现在是 BigInt (i64)，需要转换为 Number 以匹配 SQLite 查询
            const chunkId = Number(res.id);
            const row = hydrate.get(chunkId);
            if (!row) {
                // 🛡️ BUG 1 修复：发现幽灵索引（数据库无记录但索引有），异步清理
                console.warn(`[KnowledgeBase] 👻 Ghost Index detected for ID ${chunkId} in "${diaryName}". Cleaning up...`);
                if (idx.remove) idx.remove(res.id);
                return null;
            }
            return {
                text: row.text,
                score: res.score, // 确保 Vexus 返回的是 score (或 distance，需自行反转)
                sourceFile: path.basename(row.sourceFile),
                fullPath: row.sourceFile,
                matchedTags: tagInfo ? tagInfo.matchedTags : [],
                boostFactor: tagInfo ? tagInfo.boostFactor : 0,
                tagMatchScore: tagInfo ? tagInfo.totalSpikeScore : 0, // ✅ 新增
                tagMatchCount: tagInfo ? tagInfo.matchedTags.length : 0, // ✅ 新增
                coreTagsMatched: tagInfo ? tagInfo.coreTagsMatched : [] // 🌟 新增：标记哪些核心 Tag 命中了
            };
        }).filter(Boolean);
    }

    async _searchAllIndices(vector, k, tagBoost, coreTags = [], coreBoostFactor = 1.33) {
        // 优化2：使用 Promise.all 并行搜索
        let searchVecFloat;
        let tagInfo = null;

        if (tagBoost > 0 && this.tagMemoEngine) {
            const boostResult = this.tagMemoEngine.applyTagBoost(new Float32Array(vector), tagBoost, coreTags, coreBoostFactor);
            searchVecFloat = boostResult.vector;
            tagInfo = boostResult.info;
        } else {
            searchVecFloat = vector instanceof Float32Array ? vector : new Float32Array(vector);
        }

        const allDiaries = this.db.prepare('SELECT DISTINCT diary_name FROM files').all();

        const searchPromises = allDiaries.map(async ({ diary_name }) => {
            try {
                const idx = await this._getOrLoadDiaryIndex(diary_name);
                const stats = idx.stats ? idx.stats() : { totalVectors: 1 };
                if (stats.totalVectors === 0) return [];
                return idx.search(searchVecFloat, k);
            } catch (e) {
                console.error(`[KnowledgeBase] Vexus search error in parallel global search (${diary_name}):`, e);
                return [];
            }
        });

        const resultsPerIndex = await Promise.all(searchPromises);
        let allResults = resultsPerIndex.flat();

        allResults.sort((a, b) => b.score - a.score);

        const topK = allResults.slice(0, k);

        const hydrate = this.db.prepare(`
            SELECT c.content as text, f.path as sourceFile
            FROM chunks c JOIN files f ON c.file_id = f.id WHERE c.id = ?
        `);

        return topK.map(res => {
            const chunkId = Number(res.id);
            const row = hydrate.get(chunkId);
            return row ? {
                text: row.text,
                score: res.score,
                sourceFile: path.basename(row.sourceFile),
                matchedTags: tagInfo ? tagInfo.matchedTags : [],
                boostFactor: tagInfo ? tagInfo.boostFactor : 0,
                tagMatchScore: tagInfo ? tagInfo.totalSpikeScore : 0,
                tagMatchCount: tagInfo ? tagInfo.matchedTags.length : 0,
                coreTagsMatched: tagInfo ? tagInfo.coreTagsMatched : []
            } : null;
        }).filter(Boolean);
    }

    /**
     * 公共接口：应用 TagMemo 增强向量
     * @param {Float32Array|Array<number>} vector - 原始查询向量
     * @param {number} tagBoost - 增强因子 (0 到 1)
     * @returns {{vector: Float32Array, info: object|null}} - 返回增强后的向量和调试信息
     */
    applyTagBoost(vector, tagBoost, coreTags = [], coreBoostFactor = 1.33) {
        if (!this.tagMemoEngine) return { vector: vector instanceof Float32Array ? vector : new Float32Array(vector), info: null };
        return this.tagMemoEngine.applyTagBoost(vector, tagBoost, coreTags, coreBoostFactor);
    }

    /**
     * 获取向量的 EPA 分析数据（逻辑深度、共振等）
     */
    getEPAAnalysis(vector) {
        if (!this.tagMemoEngine) {
            return { logicDepth: 0.5, resonance: 0, entropy: 0.5, dominantAxes: [] };
        }
        return this.tagMemoEngine.getEPAAnalysis(vector);
    }

    /**
     * 🌟 Tagmemo V4: 对结果集进行智能去重 (SVD + Residual)
     * @param {Array} candidates - 候选结果数组
     * @param {Float32Array|Array} queryVector - 查询向量
     * @returns {Promise<Array>} 去重后的结果
     */
    async deduplicateResults(candidates, queryVector) {
        if (!this.resultDeduplicator) return candidates;
        return await this.resultDeduplicator.deduplicate(candidates, queryVector);
    }

    // =========================================================================
    // 兼容性 API (修复版)
    // =========================================================================

    // 🛠️ 修复 3: 同步回退 + 缓存预热
    async getDiaryNameVector(diaryName) {
        if (!diaryName) return null;

        // 1. 查内存缓存
        if (this.diaryNameVectorCache.has(diaryName)) {
            return this.diaryNameVectorCache.get(diaryName);
        }

        // 2. 查数据库 (同步)
        try {
            const row = this.db.prepare("SELECT vector FROM kv_store WHERE key = ?").get(`diary_name:${diaryName}`);
            if (row && row.vector) {
                const vec = Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, this.config.dimension));
                this.diaryNameVectorCache.set(diaryName, vec);
                return vec;
            }
        } catch (e) {
            console.warn(`[KnowledgeBase] DB lookup failed for diary name: ${diaryName}`);
        }

        // 3. 缓存未命中，同步等待向量化
        console.warn(`[KnowledgeBase] Cache MISS for diary name vector: "${diaryName}". Fetching now...`);
        return await this._fetchAndCacheDiaryNameVector(diaryName);
    }

    // 强制同步预热缓存
    _hydrateDiaryNameCacheSync() {
        console.log('[KnowledgeBase] Hydrating diary name vectors (Sync)...');
        const stmt = this.db.prepare("SELECT key, vector FROM kv_store WHERE key LIKE 'diary_name:%'");
        let count = 0;
        for (const row of stmt.iterate()) {
            const name = row.key.split(':')[1];
            if (row.vector.length === this.config.dimension * 4) {
                const vec = Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, this.config.dimension));
                this.diaryNameVectorCache.set(name, vec);
                count++;
            }
        }
        console.log(`[KnowledgeBase] Hydrated ${count} diary name vectors.`);
    }

    async _fetchAndCacheDiaryNameVector(name) {
        try {
            const [vec] = await getEmbeddingsBatch([name], {
                apiKey: this.config.apiKey, apiUrl: this.config.apiUrl, model: this.config.model
            });
            if (vec) {
                this.diaryNameVectorCache.set(name, vec);
                const vecBuf = Buffer.from(new Float32Array(vec).buffer);
                this.db.prepare("INSERT OR REPLACE INTO kv_store (key, vector) VALUES (?, ?)").run(`diary_name:${name}`, vecBuf);
                return vec; // 返回向量
            }
        } catch (e) {
            console.error(`Failed to vectorize diary name ${name}`);
        }
        return null; // 失败时返回 null
    }

    // 🌟 新增：基于 SQLite kv_store 的持久化插件描述向量缓存
    async getPluginDescriptionVector(descText, getEmbeddingFn) {
        let hash;
        try {
            hash = crypto.createHash('sha256').update(descText).digest('hex');
            const key = `plugin_desc_hash:${hash}`;

            // 1. 查 SQLite
            const stmt = this.db.prepare("SELECT vector FROM kv_store WHERE key = ?");
            const row = stmt.get(key);

            if (row && row.vector) {
                return Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, this.config.dimension));
            }

            // 2. 未命中，去查 Embedding API
            if (typeof getEmbeddingFn !== 'function') {
                return null;
            }

            console.log(`[KnowledgeBase] Cache MISS for plugin description. Fetching API...`);
            const vec = await getEmbeddingFn(descText);

            if (vec) {
                // 3. 存入 SQLite
                const vecBuf = Buffer.from(new Float32Array(vec).buffer);
                this.db.prepare("INSERT OR REPLACE INTO kv_store (key, vector) VALUES (?, ?)").run(key, vecBuf);
                return vec;
            }

        } catch (e) {
            console.error(`[KnowledgeBase] Failed to process plugin description vector:`, e.message);
        }
        return null;
    }

    // 兼容性 API: getVectorByText
    async getVectorByText(diaryName, text) {
        const stmt = this.db.prepare('SELECT vector FROM chunks WHERE content = ? LIMIT 1');
        const row = stmt.get(text);
        if (row && row.vector) {
            return Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, this.config.dimension));
        }
        return null;
    }

    /**
     * 🌟 新增：按文件路径列表获取所有分块及其向量
     * 用于 Time 模式下的二次相关性排序
     */
    async getChunksByFilePaths(filePaths) {
        if (!filePaths || filePaths.length === 0) return [];

        // 考虑到 SQLite 参数限制（通常为 999），如果路径过多需要分批
        const batchSize = 500;
        let allResults = [];

        for (let i = 0; i < filePaths.length; i += batchSize) {
            const batch = filePaths.slice(i, i + batchSize);
            const placeholders = batch.map(() => '?').join(',');
            const stmt = this.db.prepare(`
                SELECT c.id, c.content as text, c.vector, f.path as sourceFile
                FROM chunks c
                JOIN files f ON c.file_id = f.id
                WHERE f.path IN (${placeholders})
            `);

            const rows = stmt.all(...batch);
            const processed = rows.map(r => ({
                id: r.id,
                text: r.text,
                vector: r.vector ? new Float32Array(r.vector.buffer, r.vector.byteOffset, this.config.dimension) : null,
                sourceFile: r.sourceFile
            }));
            allResults.push(...processed);
        }

        return allResults;
    }

    // 兼容性 API: searchSimilarTags
    async searchSimilarTags(input, k = 10) {
        // 兼容旧接口
        let queryVec;
        if (typeof input === 'string') {
            try {
                const [vec] = await getEmbeddingsBatch([input], {
                    apiKey: this.config.apiKey, apiUrl: this.config.apiUrl, model: this.config.model
                });
                queryVec = vec;
            } catch (e) { return []; }
        } else {
            queryVec = input;
        }

        if (!queryVec) return [];

        try {
            const searchVecFloat = queryVec instanceof Float32Array ? queryVec : new Float32Array(queryVec);
            const results = this.tagIndex.search(searchVecFloat, k);

            // 需要 hydrate tag 名称
            const hydrate = this.db.prepare("SELECT name FROM tags WHERE id = ?");
            return results.map(r => {
                const tagId = Number(r.id);
                const row = hydrate.get(tagId);
                return row ? { tag: row.name, score: r.score } : null;
            }).filter(Boolean);
        } catch (e) {
            return [];
        }
    }

    _startWatcher() {
        if (!this.watcher) {
            const handleFile = (filePath) => {
                const relPath = path.relative(this.config.rootPath, filePath);
                // 提取第一级目录作为日记本名称
                const parts = relPath.split(path.sep);
                const diaryName = parts.length > 1 ? parts[0] : 'Root';

                if (this.config.ignoreFolders.includes(diaryName)) return;
                const fileName = path.basename(relPath);
                if (this.config.ignorePrefixes.some(prefix => fileName.startsWith(prefix))) return;
                if (this.config.ignoreSuffixes.some(suffix => fileName.endsWith(suffix))) return;
                if (!filePath.match(/\.(md|txt)$/i)) return;

                this.pendingFiles.add(filePath);
                if (this.pendingFiles.size >= this.config.maxBatchSize) {
                    this._flushBatch();
                } else {
                    this._scheduleBatch();
                }
            };

            const handleFileWithLock = async (filePath) => {
                // 🛡️ BUG 2 修复：文件系统竞态保护
                // 如果文件正在被快速修改，等待其稳定后再处理
                try {
                    const stats1 = await fs.stat(filePath);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    const stats2 = await fs.stat(filePath);

                    if (stats1.size === stats2.size && stats1.mtimeMs === stats2.mtimeMs) {
                        handleFile(filePath);
                    } else {
                        // 如果还在变动，推迟 1 秒再试
                        // console.log(`[KnowledgeBase] ⏳ File "${path.basename(filePath)}" is still being written, deferring...`);
                        setTimeout(() => handleFileWithLock(filePath), 1000);
                    }
                } catch (e) {
                    // 如果文件在检查期间被删除了，忽略即可
                    if (e.code !== 'ENOENT') console.warn(`[KnowledgeBase] Stability check error:`, e.message);
                }
            };

            const ignoredPatterns = [
                '**/node_modules/**',
                '**/.git/**',
                '**/dist/**',
                '**/target/**',
                '**/image/**',
                '**/.*'
            ];
            if (Array.isArray(this.config.ignoreFolders)) {
                this.config.ignoreFolders.forEach(folder => {
                    if (folder) ignoredPatterns.push(`**/${folder}/**`);
                });
            }

            this.watcher = chokidar.watch(this.config.rootPath, {
                ignored: ignoredPatterns,
                ignoreInitial: !this.config.fullScanOnStartup
            });
            this.watcher.on('add', handleFileWithLock).on('change', handleFileWithLock).on('unlink', fp => this._handleDelete(fp));
        }
    }

    _scheduleBatch() {
        if (this.batchTimer) clearTimeout(this.batchTimer);
        this.batchTimer = setTimeout(() => this._flushBatch(), this.config.batchWindow);
    }

    async _flushBatch() {
        if (this.isProcessing || this.pendingFiles.size === 0) return;
        this.isProcessing = true;

        // 1. 📋 准备批次：先从队列中取出，但不立即永久删除
        const batchFiles = Array.from(this.pendingFiles).slice(0, this.config.maxBatchSize);
        if (this.batchTimer) clearTimeout(this.batchTimer);

        console.log(`[KnowledgeBase] 🚌 Processing ${batchFiles.length} files...`);

        try {
            // 1. 解析文件并按日记本分组
            const docsByDiary = new Map(); // Map<DiaryName, Array<Doc>>
            const checkFile = this.db.prepare('SELECT checksum, mtime, size FROM files WHERE path = ?');

            await Promise.all(batchFiles.map(async (filePath) => {
                try {
                    const stats = await fs.stat(filePath);
                    const relPath = path.relative(this.config.rootPath, filePath);
                    const parts = relPath.split(path.sep);
                    const diaryName = parts.length > 1 ? parts[0] : 'Root';

                    const row = checkFile.get(relPath);
                    if (row && row.mtime === stats.mtimeMs && row.size === stats.size) return;

                    const content = await fs.readFile(filePath, 'utf-8');
                    const checksum = crypto.createHash('md5').update(content).digest('hex');

                    if (row && row.checksum === checksum) {
                        this.db.prepare('UPDATE files SET mtime = ?, size = ? WHERE path = ?').run(stats.mtimeMs, stats.size, relPath);
                        return;
                    }

                    if (!docsByDiary.has(diaryName)) docsByDiary.set(diaryName, []);
                    docsByDiary.get(diaryName).push({
                        relPath, diaryName, checksum, mtime: stats.mtimeMs, size: stats.size,
                        chunks: chunkText(content),
                        tags: this._extractTags(content)
                    });
                } catch (e) { if (e.code !== 'ENOENT') console.warn(`Read error ${filePath}:`, e.message); }
            }));

            if (docsByDiary.size === 0) {
                // 🛡️ 所有文件均无变更，安全移出队列，防止无限自检循环
                batchFiles.forEach(f => {
                    this.pendingFiles.delete(f);
                    this.fileRetryCount.delete(f);
                });
                this.isProcessing = false;
                return;
            }

            // 2. 收集所有文本进行 Embedding
            const allChunksWithMeta = [];
            const uniqueTags = new Set();

            for (const [dName, docs] of docsByDiary) {
                docs.forEach((doc, dIdx) => {
                    const validChunks = doc.chunks.map(c => this._prepareTextForEmbedding(c)).filter(c => c !== '[EMPTY_CONTENT]');
                    doc.chunks = validChunks;
                    validChunks.forEach((txt, cIdx) => {
                        allChunksWithMeta.push({ text: txt, diaryName: dName, doc: doc, chunkIdx: cIdx });
                    });
                    doc.tags.forEach(t => uniqueTags.add(t));
                });
            }

            // Tag 处理
            const newTagsSet = new Set();
            const tagCache = new Map();
            const checkTag = this.db.prepare('SELECT id, vector FROM tags WHERE name = ?');
            for (const t of uniqueTags) {
                const row = checkTag.get(t);
                if (row && row.vector) tagCache.set(t, { id: row.id, vector: row.vector });
                else {
                    const cleanedTag = this._prepareTextForEmbedding(t);
                    if (cleanedTag !== '[EMPTY_CONTENT]') newTagsSet.add(cleanedTag);
                }
            }

            const newTags = Array.from(newTagsSet);
            // 3. Embedding API Calls
            const embeddingConfig = { apiKey: this.config.apiKey, apiUrl: this.config.apiUrl, model: this.config.model };

            let chunkVectors = [];
            if (allChunksWithMeta.length > 0) {
                const texts = allChunksWithMeta.map(i => i.text);
                chunkVectors = await getEmbeddingsBatch(texts, embeddingConfig);
                // 🛡️ getEmbeddingsBatch 现在保证 chunkVectors.length === texts.length
                // 失败/超长的位置为 null，后续写入 DB 时会跳过这些 null 向量
            }

            let tagVectors = [];
            if (newTags.length > 0) {
                const tagLimit = 100;
                for (let i = 0; i < newTags.length; i += tagLimit) {
                    const batch = newTags.slice(i, i + tagLimit);
                    const batchVectors = await getEmbeddingsBatch(batch, embeddingConfig);
                    // 同样保证长度对齐，null 表示失败
                    tagVectors.push(...batchVectors);
                }
            }

            // 4. 写入 DB 和 索引
            const transaction = this.db.transaction(() => {
                const updates = new Map();
                const deletions = new Map(); // 💡 新增：记录待删除的 chunk ID
                const tagUpdates = [];
                let actualTagChanges = 0;

                const insertTag = this.db.prepare('INSERT INTO tags (name, vector) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET vector = excluded.vector');
                const getTagId = this.db.prepare('SELECT id FROM tags WHERE name = ?');

                newTags.forEach((t, i) => {
                    if (!tagVectors[i]) return; // 🛡️ 跳过向量化失败的 tag
                    const vecFloat = new Float32Array(tagVectors[i]);
                    const vecBuf = Buffer.from(vecFloat.buffer, vecFloat.byteOffset, vecFloat.byteLength);
                    insertTag.run(t, vecBuf);
                    const id = getTagId.get(t).id;
                    tagCache.set(t, { id, vector: vecBuf });
                    tagUpdates.push({ id, vec: vecFloat });
                });

                const insertFile = this.db.prepare('INSERT INTO files (path, diary_name, checksum, mtime, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
                const updateFile = this.db.prepare('UPDATE files SET checksum = ?, mtime = ?, size = ?, updated_at = ? WHERE id = ?');
                const getFile = this.db.prepare('SELECT id FROM files WHERE path = ?');
                const getOldChunkIds = this.db.prepare('SELECT id FROM chunks WHERE file_id = ?'); // 💡 新增
                const delChunks = this.db.prepare('DELETE FROM chunks WHERE file_id = ?');
                const delRels = this.db.prepare('DELETE FROM file_tags WHERE file_id = ?');
                const addChunk = this.db.prepare('INSERT INTO chunks (file_id, chunk_index, content, vector) VALUES (?, ?, ?, ?)');
                const addRel = this.db.prepare('INSERT OR IGNORE INTO file_tags (file_id, tag_id, position) VALUES (?, ?, ?)');

                // 在事务前构建索引
                const metaMap = new Map();
                allChunksWithMeta.forEach((meta, i) => {
                    meta.vector = chunkVectors[i];
                    // meta.doc 和 root meta.chunkIdx 是唯一标识一个 chunk的特征属性
                    const key = `${meta.doc.relPath}:${meta.chunkIdx}`;
                    metaMap.set(key, meta);
                });

                for (const [dName, docs] of docsByDiary) {
                    if (!updates.has(dName)) updates.set(dName, []);

                    docs.forEach(doc => {
                        let fileId;
                        const fRow = getFile.get(doc.relPath);
                        const now = Math.floor(Date.now() / 1000);

                        if (fRow) {
                            fileId = fRow.id;

                            // 💡 核心修复：在删除数据库记录前，先收集旧 chunk ID 用于后续的索引清理
                            const oldChunkIds = getOldChunkIds.all(fileId).map(c => c.id);
                            if (oldChunkIds.length > 0) {
                                if (!deletions.has(dName)) deletions.set(dName, []);
                                deletions.get(dName).push(...oldChunkIds);
                            }

                            updateFile.run(doc.checksum, doc.mtime, doc.size, now, fileId);
                            delChunks.run(fileId);
                            delRels.run(fileId);
                        } else {
                            const res = insertFile.run(doc.relPath, doc.diaryName, doc.checksum, doc.mtime, doc.size, now);
                            fileId = res.lastInsertRowid;
                        }

                        doc.chunks.forEach((txt, i) => {
                            const meta = metaMap.get(`${doc.relPath}:${i}`);
                            if (meta && meta.vector) { // 🛡️ null 向量的 chunk 自然被跳过，不会写入错误数据
                                const vecFloat = new Float32Array(meta.vector);
                                const vecBuf = Buffer.from(vecFloat.buffer, vecFloat.byteOffset, vecFloat.byteLength);
                                const r = addChunk.run(fileId, i, txt, vecBuf);
                                updates.get(dName).push({ id: r.lastInsertRowid, vec: vecFloat });
                            }
                        });

                        doc.tags.forEach((t, index) => {
                            const tInfo = tagCache.get(t);
                            if (tInfo) {
                                addRel.run(fileId, tInfo.id, index + 1);
                                actualTagChanges++;
                            }
                        });
                    });
                }

                return { updates, tagUpdates, deletions, actualTagChanges };
            });

            const { updates, tagUpdates, deletions, actualTagChanges } = transaction();

            // 💡 核心修复：在添加新向量之前，先从 Vexus 索引中移除所有旧的向量
            if (deletions && deletions.size > 0) {
                for (const [dName, chunkIds] of deletions) {
                    const idx = await this._getOrLoadDiaryIndex(dName);
                    if (idx && idx.remove) {
                        chunkIds.forEach(id => idx.remove(id));
                    }
                }
            }

            // 🛠️ 修复：针对 Tag Index 的安全写入
            tagUpdates.forEach(u => {
                try {
                    this.tagIndex.add(u.id, u.vec);
                } catch (e) {
                    if (e.message && e.message.includes('Duplicate')) {
                        try {
                            if (this.tagIndex.remove) this.tagIndex.remove(u.id);
                            this.tagIndex.add(u.id, u.vec);
                        } catch (retryErr) {
                            console.error(`[KnowledgeBase] ❌ Failed to upsert tag ${u.id}:`, retryErr.message);
                        }
                    }
                }
            });
            this._scheduleIndexSave('global_tags');

            // 🛠️ 修复：针对 Diary Index 的安全写入
            for (const [dName, chunks] of updates) {
                const idx = await this._getOrLoadDiaryIndex(dName);

                chunks.forEach(u => {
                    try {
                        // 尝试直接添加
                        idx.add(u.id, u.vec);
                    } catch (e) {
                        // 捕获 "Duplicate keys" 错误
                        if (e.message && e.message.includes('Duplicate')) {
                            // console.warn(`[KnowledgeBase] ⚠️ ID Collision detected for ${u.id} in ${dName}. Performing upsert.`);
                            try {
                                // 策略：先移除冲突的 ID，再重新添加 (Upsert)
                                if (idx.remove) idx.remove(u.id);
                                idx.add(u.id, u.vec);
                            } catch (retryErr) {
                                console.error(`[KnowledgeBase] ❌ Failed to upsert vector ${u.id} in ${dName}:`, retryErr.message);
                            }
                        } else {
                            // 如果是其他错误（如维度不对），则抛出
                            console.error(`[KnowledgeBase] ❌ Vector add error detected:`, e);
                        }
                    }
                });

                this._scheduleIndexSave(dName);
            }

            // 5. ✅ 成功处理后，移除文件并清空重试计数
            batchFiles.forEach(f => {
                this.pendingFiles.delete(f);
                this.fileRetryCount.delete(f); // 清空重试计数
            });

            console.log(`[KnowledgeBase] ✅ Batch complete. Updated ${updates.size} diary indices.`);

            // 优化1：数据更新后，检查是否需要重建矩阵（防抖 + 阈值）
            // 🌟 V7.2: 使用实际生成的 tag 共现对变动（以写入 file_tags 的行数为准）进行触发
            if (this.tagMemoEngine) this.tagMemoEngine.scheduleMatrixRebuild(actualTagChanges);

        } catch (e) {
            console.error('[KnowledgeBase] ❌ Batch processing failed catastrophically.');
            console.error('Error Details:', e);
            if (e.stack) {
                console.error('Stack Trace:', e.stack);
            }

            // 🛡️ 核心修复：重试计数，防止确定性失败导致无限循环
            const MAX_FILE_RETRIES = 3;
            batchFiles.forEach(f => {
                const count = (this.fileRetryCount.get(f) || 0) + 1;
                if (count >= MAX_FILE_RETRIES) {
                    console.error(`[KnowledgeBase] ⛔ File "${f}" failed ${MAX_FILE_RETRIES} times. Removing from queue permanently.`);
                    this.pendingFiles.delete(f);
                    this.fileRetryCount.delete(f);
                } else {
                    this.fileRetryCount.set(f, count);
                    console.warn(`[KnowledgeBase] ⚠️ File "${f}" retry ${count}/${MAX_FILE_RETRIES}.`);
                }
            });
        }
        finally {
            this.isProcessing = false;
            if (this.pendingFiles.size > 0) setImmediate(() => this._flushBatch());
        }
    }

    _prepareTextForEmbedding(text) {
        const decorativeEmojis = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
        // 1. 移除表情符号, 2. 合并水平空格, 3. 移除换行符周围的空格, 4. 合并多个换行符, 5. 清理首尾
        let cleaned = text.replace(decorativeEmojis, ' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/ *\n */g, '\n')
            .replace(/\n{2,}/g, '\n')
            .trim();
        return cleaned.length === 0 ? '[EMPTY_CONTENT]' : cleaned;
    }

    async _handleDelete(filePath) {
        const relPath = path.relative(this.config.rootPath, filePath);
        try {
            const row = this.db.prepare('SELECT id, diary_name FROM files WHERE path = ?').get(relPath);
            if (!row) return;
            const chunkIds = this.db.prepare('SELECT id FROM chunks WHERE file_id = ?').all(row.id);
            this.db.prepare('DELETE FROM files WHERE id = ?').run(row.id);

            const idx = await this._getOrLoadDiaryIndex(row.diary_name);
            if (idx && idx.remove) {
                chunkIds.forEach(c => idx.remove(c.id));
                this._scheduleIndexSave(row.diary_name);
            }
        } catch (e) { console.error(`[KnowledgeBase] Delete error:`, e); }
    }

    _scheduleIndexSave(name) {
        // 判定该索引是否允许持久化
        const shouldPersist = name === 'global_tags' 
            ? (this.config.persistTagIndex || this.config.persistFolders.has('global_tags'))
            : (this.config.persistDefault || this.config.persistFolders.has(name) || name.endsWith('簇'));

        if (!shouldPersist) return; 
        if (this.saveTimers.has(name)) return;
        const delay = this.config.indexSaveDelay;
        const timer = setTimeout(() => {
            this._saveIndexToDisk(name);
            this.saveTimers.delete(name);
        }, delay);
        this.saveTimers.set(name, timer);
    }

    _saveIndexToDisk(name) {
        const shouldPersist = name === 'global_tags' 
            ? (this.config.persistTagIndex || this.config.persistFolders.has('global_tags'))
            : (this.config.persistDefault || this.config.persistFolders.has(name) || name.endsWith('簇'));

        if (!shouldPersist) return;
        try {
            if (name === 'global_tags') {
                if (this.tagIndex) this.tagIndex.save(path.join(this.config.storePath, 'index_global_tags.usearch'));
            } else {
                const safeName = crypto.createHash('md5').update(name).digest('hex');
                const idx = this.diaryIndices.get(name);
                if (idx && idx.save) {
                    idx.save(path.join(this.config.storePath, `index_diary_${safeName}.usearch`));
                }
            }
            console.log(`[KnowledgeBase] 💾 Saved index: ${name}`);
        } catch (e) { console.error(`[KnowledgeBase] Save failed for ${name}:`, e); }
    }

    _extractTags(content) {
        // 增强型正则：支持多行 Tag 提取，并兼容多种分隔符 (中英文逗号、分号、顿号、竖线)
        const tagLines = content.match(/Tag:\s*(.+)$/gim);
        if (!tagLines) return [];

        let allTags = [];
        tagLines.forEach(line => {
            const tagContent = line.replace(/Tag:\s*/i, '');
            const splitTags = tagContent.split(/[,，、;|｜]/).map(t => t.trim()).filter(Boolean);
            allTags.push(...splitTags);
        });

        // 🔧 修复：清理每个tag末尾的句号，并应用统一的 Embedding 预处理（处理多余空格、表情等）
        let tags = allTags.map(t => {
            let cleaned = t.replace(/[。.]+$/g, '').trim();
            return this._prepareTextForEmbedding(cleaned);
        }).filter(t => t !== '[EMPTY_CONTENT]');

        if (this.config.tagBlacklistSuper.length > 0) {
            const superRegex = new RegExp(this.config.tagBlacklistSuper.join('|'), 'g');
            tags = tags.map(t => t.replace(superRegex, '').trim());
        }
        tags = tags.filter(t => !this.config.tagBlacklist.has(t) && t.length > 0);

        // 🌟 Future-Proofing: 增强标签清洗
        tags = tags.filter(t => {
            // 1. 长度拦截 (中文>15, 英文>30)
            const isChinese = /[\u4e00-\u9fa5]/.test(t);
            if (isChinese && t.length > 15) return false;
            if (!isChinese && t.length > 30) return false;

            // 2. 日期噪音拦截 (正则表达式)
            // 拦截包含 X年X月X日, X月X日, YYYY-MM-DD, YYYY.MM.DD 等模式的标签
            const dateRegex = /(\d{4}年\d{1,2}月\d{1,2}日|\d{4}年\d{1,2}月|\d{1,2}月\d{1,2}日|\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{2}[-./]\d{1,2}[-./]\d{1,2}|\d{4}[-./]\d{1,2})/;
            if (dateRegex.test(t)) return false;

            return true;
        });

        const uniqueTags = [...new Set(tags)];

        // 🛡️ BUG 3 修复：引入硬性数量截断 (Tag 核弹防御)
        // 单篇日记最多允许 50 个 Tag，防止共现矩阵计算资源爆炸
        if (uniqueTags.length > 50) {
            console.warn(`[KnowledgeBase] ⚠️ File has too many tags (${uniqueTags.length}). Truncating to top 50.`);
            return uniqueTags.slice(0, 50);
        }
        return uniqueTags;
    }

    /**
     * 🛡️ BUG 1 修复：幽灵索引自检与修复
     * 随机抽取样本 ID 检查数据库，如果缺失则认为索引与 DB 发生了“非原子性撕裂”
     */
    async _cleanupGhostIndexes() {
        console.log('[KnowledgeBase] 🛡️ Starting Ghost Index self-check...');
        const allDiaries = this.db.prepare('SELECT DISTINCT diary_name FROM files').all();
        
        for (const { diary_name } of allDiaries) {
            try {
                const idx = await this._getOrLoadDiaryIndex(diary_name);
                if (!idx || !idx.stats) continue;

                const stats = idx.stats();
                if (stats.totalVectors === 0) continue;

                // 随机抽取 20 个 ID 进行验证
                // 注意：usearch 本身不直接暴露所有 ID 遍历，但我们可以根据 stats 决定是否重建
                // 如果 SQLite 中的 chunks 数量与索引数量差异过大，则可能存在问题
                const dbCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks JOIN files ON chunks.file_id = files.id WHERE files.diary_name = ?')
                    .get(diary_name).count;

                // 容差范围：如果索引比 DB 多出太多（幽灵），或者少太多（由于崩溃丢失），触发异步补齐/清理
                // 这里的策略是：如果差异超过 5% 或绝对值超过 10，则标记为可疑
                const diff = Math.abs(stats.totalVectors - dbCount);
                if (diff > 10 && diff / (dbCount || 1) > 0.05) {
                    console.warn(`[KnowledgeBase] ⚠️ Index/DB mismatch for "${diary_name}" (Index: ${stats.totalVectors}, DB: ${dbCount}). Rebuilding...`);
                    // 标记为需要重建
                    await this._recoverIndexFromDB(idx, 'chunks', diary_name);
                    this._saveIndexToDisk(diary_name);
                }
            } catch (e) {
                console.warn(`[KnowledgeBase] Ghost check failed for ${diary_name}:`, e.message);
            }
        }
        console.log('[KnowledgeBase] 🛡️ Ghost Index self-check complete.');
    }


    // 🌟 TagMemo V7: 触发 Rust 预计算内生残差
    async recomputeIntrinsicResiduals() {
        if (!this.tagMemoEngine) return;
        await this.tagMemoEngine.recomputeIntrinsicResiduals();
    }

    // 🌟 启动空闲索引定期扫描
    _startIdleSweep() {
        if (this.idleSweepTimer) return;
        this.idleSweepTimer = setInterval(() => {
            this._evictIdleIndices();
        }, this.config.indexIdleSweepInterval);
        // 允许 Node 进程在没有其他活跃事件时自然退出
        if (this.idleSweepTimer.unref) this.idleSweepTimer.unref();
        console.log(`[KnowledgeBase] 🧹 Idle index sweep started (TTL: ${Math.round(this.config.indexIdleTTL / 60000)}min, interval: ${Math.round(this.config.indexIdleSweepInterval / 60000)}min)`);
    }

    // 🌟 扫描并卸载空闲超时的索引
    _evictIdleIndices() {
        const now = Date.now();
        const ttl = this.config.indexIdleTTL;
        let evictedCount = 0;

        for (const [diaryName, lastUsed] of this.diaryIndexLastUsed) {
            if (now - lastUsed < ttl) continue;
            if (!this.diaryIndices.has(diaryName)) {
                // 时间戳残留（索引已不在内存中），清理即可
                this.diaryIndexLastUsed.delete(diaryName);
                continue;
            }

            // 先保存到磁盘，再从内存中移除
            try {
                // 如果有待保存的计时器，先取消它并立即保存
                if (this.saveTimers.has(diaryName)) {
                    clearTimeout(this.saveTimers.get(diaryName));
                    this.saveTimers.delete(diaryName);
                }
                this._saveIndexToDisk(diaryName);
                this.diaryIndices.delete(diaryName);
                this.diaryIndexLastUsed.delete(diaryName);
                evictedCount++;
                console.log(`[KnowledgeBase] 🧹 Evicted idle index: "${diaryName}" (idle ${Math.round((now - lastUsed) / 60000)}min)`);
            } catch (e) {
                console.error(`[KnowledgeBase] ❌ Failed to evict index "${diaryName}":`, e.message);
            }
        }

        if (evictedCount > 0) {
            console.log(`[KnowledgeBase] 🧹 Idle sweep complete: evicted ${evictedCount} index(es), ${this.diaryIndices.size} remaining in memory.`);
        }
    }

    async shutdown() {
        console.log('[KnowledgeBase] shutting down...');
        await this.watcher?.close();
        if (this.ragParamsWatcher) {
            this.ragParamsWatcher.close();
            this.ragParamsWatcher = null;
        }
        // 🌟 停止空闲扫描
        if (this.idleSweepTimer) {
            clearInterval(this.idleSweepTimer);
            this.idleSweepTimer = null;
        }

        // 确保所有待保存的索引都被写入磁盘
        for (const [name, timer] of this.saveTimers) {
            clearTimeout(timer);
            this._saveIndexToDisk(name);
        }
        this.saveTimers.clear();

        this.db?.close();
        console.log('[KnowledgeBase] Shutdown complete.');
    }
}

module.exports = new KnowledgeBaseManager();