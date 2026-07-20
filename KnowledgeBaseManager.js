// KnowledgeBaseManager.js
// 🌟 架构重构修复版：多路独立索引 + 稳健的 Buffer 处理 + 同步缓存回退 + TagMemo 逻辑回归

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');
const { getEmbeddingsBatch } = require('./EmbeddingUtils');
const ResultDeduplicator = require('./ResultDeduplicator'); // ✅ Tagmemo v4 requirement
const TagMemoEngine = require('./TagMemoEngine');
const { decodeVectorBlob } = require('./modules/knowledgeBase/vectorCodec');
const { queryByChunks } = require('./modules/knowledgeBase/sqliteQueryUtils');
const {
    prepareTextForEmbedding,
    extractTags
} = require('./modules/knowledgeBase/textPreprocessor');
const {
    initializeKnowledgeBaseSchema
} = require('./modules/knowledgeBase/schemaManager');
const SqliteHealthManager = require('./modules/knowledgeBase/sqliteHealthManager');
const {
    estimateVexusIndexBytes,
    safeIndexStats,
    buildMemoryProfile
} = require('./modules/knowledgeBase/memoryProfiler');
const MigrationVectorCache = require('./modules/knowledgeBase/migrationVectorCache');
const DiaryMetadataCache = require('./modules/knowledgeBase/diaryMetadataCache');
const IndexRepository = require('./modules/knowledgeBase/indexRepository');
const DatabaseCoordinator = require('./modules/knowledgeBase/databaseCoordinator');
const KnowledgeBaseFileWatcher = require('./modules/knowledgeBase/fileWatcher');
const IngestionPipeline = require('./modules/knowledgeBase/ingestionPipeline');
const SearchService = require('./modules/knowledgeBase/searchService');

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
            // 向量语义空间签名：用于缓存/派生数据失效；未配置时回退到主模型名，避免破坏旧行为。
            modelSig: process.env.EmbeddingModelSig || process.env.WhitelistEmbeddingModel || 'gemini-embedding-2-preview',
            // ⚠️ 务必确认环境变量 VECTORDB_DIMENSION 与模型一致 (3-small通常为1536)
            dimension: parseInt(process.env.VECTORDB_DIMENSION) || 3072,

            batchWindow: parseInt(process.env.KNOWLEDGEBASE_BATCH_WINDOW_MS, 10) || 1000,
            maxBatchSize: parseInt(process.env.KNOWLEDGEBASE_MAX_BATCH_SIZE, 10) || 50,
            indexSaveDelay: parseInt(process.env.KNOWLEDGEBASE_INDEX_SAVE_DELAY, 10) || 120000,
            tagIndexSaveDelay: parseInt(process.env.KNOWLEDGEBASE_TAG_INDEX_SAVE_DELAY, 10) || 300000,
            deleteBatchWindow: parseInt(process.env.KNOWLEDGEBASE_DELETE_BATCH_WINDOW_MS, 10) || 1000,
            maxDeleteBatchSize: parseInt(process.env.KNOWLEDGEBASE_MAX_DELETE_BATCH_SIZE, 10) || 2000,
            deleteRebuildThreshold: parseInt(process.env.KNOWLEDGEBASE_DELETE_REBUILD_THRESHOLD, 10) || 5000,
            migrationCacheTtlMs: parseInt(process.env.KNOWLEDGEBASE_MIGRATION_CACHE_TTL_MS, 10) || 2 * 60 * 1000,
            // 🛡️ Rust 派生表写入租约：避免 rusqlite 与 better-sqlite3 双写 WAL 竞态
            rustWriteLeaseGraceMs: parseInt(process.env.KNOWLEDGEBASE_RUST_WRITE_LEASE_GRACE_MS, 10) || 30000,
            rustWriteLeaseCooldownMs: parseInt(process.env.KNOWLEDGEBASE_RUST_WRITE_LEASE_COOLDOWN_MS, 10) || 10000,
            rustWriteLeaseCheckpointBeforeGrant: (process.env.KNOWLEDGEBASE_RUST_WRITE_LEASE_CHECKPOINT_BEFORE_GRANT || 'true').toLowerCase() === 'true',
            rustWriteLeaseRetryMs: parseInt(process.env.KNOWLEDGEBASE_RUST_WRITE_LEASE_RETRY_MS, 10) || 1000,
            rustWriteLeaseTtlMs: parseInt(process.env.KNOWLEDGEBASE_RUST_WRITE_LEASE_TTL_MS, 10) || 10 * 60 * 1000,
            rustWriteLeaseMaxWaitMs: parseInt(process.env.KNOWLEDGEBASE_RUST_WRITE_LEASE_MAX_WAIT_MS, 10) || 30 * 60 * 1000,
            rustWriteLeasePendingThreshold: parseInt(process.env.KNOWLEDGEBASE_RUST_WRITE_LEASE_PENDING_THRESHOLD, 10) || 0,
            derivedStartupCooldownMs: parseInt(process.env.KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS, 10) || 5 * 60 * 1000,
            // 🌟 索引空闲自动卸载：默认 2 小时未使用则从内存中卸载
            indexIdleTTL: parseInt(process.env.KNOWLEDGEBASE_INDEX_IDLE_TTL_MS, 10) || 2 * 60 * 60 * 1000,
            indexIdleSweepInterval: parseInt(process.env.KNOWLEDGEBASE_INDEX_IDLE_SWEEP_MS, 10) || 10 * 60 * 1000,
            idleSweepLogTick: (process.env.KNOWLEDGEBASE_IDLE_SWEEP_LOG_TICK || 'false').toLowerCase() === 'true',

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
        this.dbPath = null;
        this.databaseCorruptionDetected = false;
        this.dbHealthState = 'healthy'; // healthy | suspect | recovering | corrupt
        this._recoveringDatabaseConnection = false;
        this.startupCompletedAt = 0;
        this.diaryIndices = new Map();
        this.diaryIndexLastUsed = new Map(); // 🌟 记录每个索引的最后使用时间
        this.idleSweepTimer = null;
        this.tagIndex = null;
        this.watcher = null;
        this.initialized = false;
        this.eventLoopWatchdogTimer = null;
        this._lastEventLoopWatchdogAt = 0;
        this.diaryNameVectorCache = new Map();
        // 🌟 日记时间索引缓存：随日记本向量索引加载/卸载生命周期维护，供 RAG ::Time 直接查询。
        // diaryName -> [{ relativePath, date }]
        this.diaryDateIndexCache = new Map();
        this.pendingFiles = new Set();
        this.fileRetryCount = new Map(); // 🛡️ 文件重试计数器，防止无限循环
        // Rust watcher 稳定事件代际：同一路径只接受严格更新的 generation。
        this.watcherPathGenerations = new Map();
        this.staleWatcherEventsDropped = 0;
        this.batchTimer = null;
        this.isProcessing = false;
        this.saveTimers = new Map();
        this.pendingDeletes = new Set();
        this.deleteBatchTimer = null;
        this.isProcessingDeletes = false;
        this.tagMemoEngine = null;
        this.resultDeduplicator = null; // ✅ Tagmemo v4
        this.ragParams = {}; // ✅ 新增：用于存储热调控参数
        this.ragParamsWatcher = null;

        // 🛡️ SQLite Rust 写租约门控：Rust 派生表写入前必须向 JS 主调度器申请窗口。
        this.rustWriteLease = null;
        this.lastJsWriteFinishedAt = 0;
        this.lastRustWriteFinishedAt = 0;
        this._rustLeaseWaitLogAt = 0;

        // 🧭 外部文件写入协调器（DailyNote 等常驻服务使用）
        // 文件变更本身不直接写 SQLite，但必须与 watcher 批处理、Rust SQLite 恢复形成单一时序。
        this.externalMutationActive = false;
        this.externalMutationOwner = null;
        this.externalMutationQueueLength = 0;
        // 索引收集窗口在长耗时外部变更期间到期时，只设置闩锁；
        // 变更提交后立即补刷，避免复用 Rust 冷却时间或创建重复定时器。
        this.externalMutationBatchDeferred = false;
        this.externalMutationDeleteBatchDeferred = false;
        this._externalMutationTail = Promise.resolve();

        // 🛡️ 同一时刻只允许一个 Rust recoverFromSqlite 打开知识库。
        // diaryIndexLoadPromises 去重同一日记本；_indexRecoveryTail 串行化不同日记本。
        this.diaryIndexLoadPromises = new Map();
        this.indexRecoveryActive = false;
        this._indexRecoveryTail = Promise.resolve();

        this.sqliteHealthManager = new SqliteHealthManager({
            onConnectionRebound: db => this._rebindDatabaseConnection(db)
        });
        this.migrationVectorCache = new MigrationVectorCache({
            getDb: () => this.db,
            dimension: this.config.dimension,
            ttlMs: this.config.migrationCacheTtlMs
        });
        this.diaryMetadataCache = new DiaryMetadataCache({
            getDb: () => this.db,
            dimension: this.config.dimension,
            getEmbeddingsBatch,
            getEmbeddingConfig: () => ({
                apiKey: this.config.apiKey,
                apiUrl: this.config.apiUrl,
                model: this.config.model
            }),
            nameVectorCache: this.diaryNameVectorCache,
            dateIndexCache: this.diaryDateIndexCache
        });
        this.indexRepository = new IndexRepository({
            config: this.config,
            VexusIndex,
            getDbPath: () => this.dbPath,
            waitForCoordinatorIdle: options => this._waitForDatabaseCoordinatorIdle(options),
            ensureDiaryDateIndex: diaryName => this._ensureDiaryDateIndexCached(diaryName),
            invalidateDiaryDateIndex: diaryName => this.invalidateDiaryDateIndex(diaryName),
            onRecoveryStateChange: active => {
                this.indexRecoveryActive = active;
            },
            onRecoveryTailChange: tail => {
                this._indexRecoveryTail = tail;
            },
            diaryIndices: this.diaryIndices,
            lastUsed: this.diaryIndexLastUsed,
            loadPromises: this.diaryIndexLoadPromises,
            saveTimers: this.saveTimers
        });
        this.databaseCoordinator = new DatabaseCoordinator({
            owner: this
        });
        this.fileWatcher = new KnowledgeBaseFileWatcher({
            owner: this,
            VexusIndex,
            loadVexusModule: () => require('./rust-vexus-lite')
        });
        this.ingestionPipeline = new IngestionPipeline(this);
        this.searchService = new SearchService(this);
    }

    async initialize() {
        if (this.initialized) return;
        console.log(`[KnowledgeBase] Initializing Multi-Index System (Dim: ${this.config.dimension})...`);

        await fs.mkdir(this.config.storePath, { recursive: true });

        const dbPath = path.join(this.config.storePath, 'knowledge_base.sqlite');
        this.dbPath = dbPath;
        this.db = this._openDatabaseWithRecovery(dbPath); // 同步连接

        this._initSchema();
        this._cleanupDatabaseOrphans();

        // 1. 初始化全局 Tag 索引 (优先从磁盘加载或从 SQLite 重建)
        const tagCapacity = 50000;
        const tagIdxPath = path.join(this.config.storePath, 'index_global_tags.usearch');
        let indexReady = false;

        // 全局 Tag 索引持久化判定：显式开关 OR 白名单包含 'global_tags'
        const shouldPersistTags = this.config.persistTagIndex || this.config.persistFolders.has('global_tags');

        if (shouldPersistTags && fsSync.existsSync(tagIdxPath)) {
            try {
                this.tagIndex = VexusIndex.load(tagIdxPath, null, this.config.dimension, tagCapacity);
                this.indexRepository.tagIndex = this.tagIndex;
                console.log('[KnowledgeBase] ✅ Global Tag Index loaded from disk.');
                indexReady = true;
            } catch (e) {
                console.warn(`[KnowledgeBase] ⚠️ Failed to load tag index from disk: ${e.message}. Rebuilding...`);
            }
        }

        if (!indexReady) {
            console.log('[KnowledgeBase] 🚀 Building Global Tag Index from SQLite...');
            this.tagIndex = new VexusIndex(this.config.dimension, tagCapacity);
            this.indexRepository.tagIndex = this.tagIndex;
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
        this.tagMemoEngine = new TagMemoEngine(this.db, this.tagIndex, this.config, this.ragParams, this);
        await this.tagMemoEngine.initialize();
        this._cleanupStalePairwiseSimilarityModels();

        this._startWatcher();
        this._startRagParamsWatcher();
        this._startIdleSweep(); // 🌟 启动空闲索引自动卸载
        this._startEventLoopWatchdog(); // 🛡️ 运行期无日志卡死定位：记录主线程长阻塞

        this.initialized = true;
        this.startupCompletedAt = Date.now();
        console.log('[KnowledgeBase] ✅ System Ready');

        if (this.tagMemoEngine && typeof this.tagMemoEngine.schedulePostStartupDerivedRefresh === 'function') {
            this.tagMemoEngine.schedulePostStartupDerivedRefresh(this.config.derivedStartupCooldownMs);
        }
    }

    /**
     * ✅ 新增：加载 RAG 热调控参数
     */
    async loadRagParams() {
        const paramsPath = path.join(__dirname, 'rag_params.json');
        try {
            const data = await fs.readFile(paramsPath, 'utf-8');
            const parsed = JSON.parse(data);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new TypeError('rag_params.json root must be a JSON object');
            }
            if (
                parsed.KnowledgeBaseManager !== undefined
                && (
                    !parsed.KnowledgeBaseManager
                    || typeof parsed.KnowledgeBaseManager !== 'object'
                    || Array.isArray(parsed.KnowledgeBaseManager)
                )
            ) {
                throw new TypeError('rag_params.json KnowledgeBaseManager must be an object');
            }

            // 解析和基础结构校验全部通过后再一次性发布，避免编辑中的短暂坏 JSON
            // 覆盖仍在工作的最后健康配置。
            this.ragParams = parsed;
            console.log('[KnowledgeBase] ✅ RAG 热调控参数已加载');
            if (this.tagMemoEngine) this.tagMemoEngine.updateRagParams(parsed);
            return true;
        } catch (e) {
            console.error('[KnowledgeBase] ❌ 加载 rag_params.json 失败，继续使用最后健康配置:', e.message);
            if (!this.ragParams || typeof this.ragParams !== 'object') {
                this.ragParams = { KnowledgeBaseManager: {} };
            }
            return false;
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
        initializeKnowledgeBaseSchema(this.db);
        this._cleanupExpiredMigrationCache();
    }

    _openDatabaseWithRecovery(dbPath) {
        this.sqliteHealthManager.syncFromOwner(this);
        const db = this.sqliteHealthManager.openWithRecovery(dbPath);
        this.sqliteHealthManager.syncToOwner(this);
        return db;
    }

    _configureDatabaseConnection(db) {
        return this.sqliteHealthManager.configureConnection(db);
    }

    _assertDatabaseIntegrity(db) {
        return this.sqliteHealthManager.assertIntegrity(db);
    }

    checkpointAndAssertDatabaseHealthy(reason = 'manual-checkpoint') {
        this.sqliteHealthManager.syncFromOwner(this);
        const healthy = this.sqliteHealthManager.checkpointAndAssertHealthy(reason);
        this.sqliteHealthManager.syncToOwner(this);
        return healthy;
    }

    _rebindDatabaseConnection(db) {
        this.db = db;

        if (this.tagMemoEngine) {
            this.tagMemoEngine.db = db;
            if (this.tagMemoEngine.epa) this.tagMemoEngine.epa.db = db;
            if (this.tagMemoEngine.residualPyramid) this.tagMemoEngine.residualPyramid.db = db;
        }

        if (this.resultDeduplicator) {
            this.resultDeduplicator.db = db;
            if (this.resultDeduplicator.epa) this.resultDeduplicator.epa.db = db;
            if (this.resultDeduplicator.residualCalculator) this.resultDeduplicator.residualCalculator.db = db;
        }
    }

    _recoverSuspectDatabaseConnection(reason, firstError) {
        this.sqliteHealthManager.syncFromOwner(this);
        const recovered = this.sqliteHealthManager.recoverSuspectConnection(reason, firstError);
        this.sqliteHealthManager.syncToOwner(this);
        return recovered;
    }

    _isSqliteCorruptionError(error) {
        return this.sqliteHealthManager.isCorruptionError(error);
    }

    _quarantineSqliteDatabase(dbPath, reason = 'corrupt') {
        return this.sqliteHealthManager.quarantine(dbPath, reason);
    }

    async _handleRuntimeSqliteCorruption(error, batchFiles = []) {
        if (this.databaseCorruptionDetected) return;
        this.databaseCorruptionDetected = true;

        console.error('[KnowledgeBase] 🚨 SQLite database corruption detected at runtime; batch processing is paused.');
        console.error(`[KnowledgeBase] Runtime corruption details: ${error?.message || error}`);
        console.error(
            '[KnowledgeBase] Recovery: stop the process, backup VectorStore, then restart. ' +
            'On restart the corrupt knowledge_base.sqlite will be quarantined and rebuilt from dailynote files.'
        );

        if (batchFiles.length > 0) {
            console.error(
                `[KnowledgeBase] 🛡️ ${batchFiles.length} file(s) were NOT marked as permanently failed because the failure is database-level, not file-level.`
            );
        }

        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }
        this.pendingFiles.clear();
        this.fileRetryCount.clear();

        try {
            if (this.watcher) {
                await this.fileWatcher.stop();
                console.error('[KnowledgeBase] 🛑 File watcher stopped to prevent retry storms against a corrupt SQLite database.');
            }
        } catch (watchErr) {
            console.warn(`[KnowledgeBase] ⚠️ Failed to stop watcher after SQLite corruption: ${watchErr.message}`);
        }
    }

    _delay(ms) {
        return this.databaseCoordinator.delay(ms);
    }

    async _waitForDatabaseCoordinatorIdle(options = {}) {
        return this.databaseCoordinator.waitForIdle(options);
    }

    _extractMutationPaths(result) {
        return this.databaseCoordinator.extractMutationPaths(result);
    }

    async _awaitIndexedFilePaths(filePaths, options = {}) {
        return this.databaseCoordinator.awaitIndexedFilePaths(filePaths, options);
    }

    async _awaitDeletedFilePaths(filePaths, options = {}) {
        return this.databaseCoordinator.awaitDeletedFilePaths(filePaths, options);
    }

    runExternalFileMutation(owner, operation, options = {}) {
        return this.databaseCoordinator.runExternalFileMutation(
            owner,
            operation,
            options
        );
    }

    _startEventLoopWatchdog() {
        if (this.eventLoopWatchdogTimer) return;

        const intervalMs = parseInt(process.env.KNOWLEDGEBASE_EVENT_LOOP_WATCHDOG_MS, 10) || 5000;
        const warnLagMs = parseInt(process.env.KNOWLEDGEBASE_EVENT_LOOP_WATCHDOG_WARN_LAG_MS, 10) || 2000;
        this._lastEventLoopWatchdogAt = Date.now();

        this.eventLoopWatchdogTimer = setInterval(() => {
            const now = Date.now();
            const expected = this._lastEventLoopWatchdogAt + intervalMs;
            const lag = now - expected;
            this._lastEventLoopWatchdogAt = now;

            if (lag >= warnLagMs) {
                console.warn(
                    `[KnowledgeBase] 🧯 Event loop lag detected: ${lag}ms. ` +
                    `state: pendingFiles=${this.pendingFiles.size}, pendingDeletes=${this.pendingDeletes.size}, ` +
                    `isProcessing=${this.isProcessing}, isProcessingDeletes=${this.isProcessingDeletes}, ` +
                    `rustLease=${this.rustWriteLease?.owner || 'none'}, loadedIndices=${this.diaryIndices.size}, ` +
                    `saveTimers=${this.saveTimers.size}, dbHealth=${this.dbHealthState}`
                );
            }
        }, intervalMs);

        if (this.eventLoopWatchdogTimer.unref) this.eventLoopWatchdogTimer.unref();
        console.log(`[KnowledgeBase] 🧯 Event loop watchdog started (interval=${intervalMs}ms, warnLag=${warnLagMs}ms).`);
    }

    _isRustWriteLeaseExpired(now = Date.now()) {
        return this.databaseCoordinator.isRustWriteLeaseExpired(now);
    }

    _canGrantRustWriteLease(options = {}) {
        return this.databaseCoordinator.canGrantRustWriteLease(options);
    }

    async requestRustWriteLease(owner, options = {}) {
        return this.databaseCoordinator.requestRustWriteLease(owner, options);
    }

    releaseRustWriteLease(owner) {
        return this.databaseCoordinator.releaseRustWriteLease(owner);
    }

    _deferBatchForRustLease(type = 'batch') {
        return this.databaseCoordinator.deferBatchForRustLease(type);
    }

    _decodeVectorBlob(blob, dim, label = 'vector') {
        return decodeVectorBlob(blob, dim, label);
    }

    _queryByChunks(sqlPrefix, values, sqlSuffix = '', chunkSize = 500) {
        return queryByChunks(this.db, sqlPrefix, values, sqlSuffix, chunkSize);
    }

    _isVectorLike(value) {
        return Array.isArray(value) ||
            value instanceof Float32Array ||
            (ArrayBuffer.isView(value) && typeof value.length === 'number');
    }

    _cleanupStalePairwiseSimilarityModels() {
        try {
            if (!this.tagMemoEngine?.modelSig) return;

            // 单模型缓存策略下也不能在冷启动/空库/新签名尚未产出数据时清掉旧缓存。
            // 否则部分用户在模型签名变化但当前 tags 尚未恢复/尚未计算完成时，会出现“旧数据被删、新数据为 0”的真空窗口。
            const currentRows = this.db.prepare(
                'SELECT COUNT(*) as count FROM tag_pair_similarity WHERE model_sig = ?'
            ).get(this.tagMemoEngine.modelSig)?.count || 0;

            if (currentRows <= 0) {
                const staleRows = this.db.prepare(
                    'SELECT COUNT(*) as count FROM tag_pair_similarity WHERE model_sig != ?'
                ).get(this.tagMemoEngine.modelSig)?.count || 0;

                if (staleRows > 0) {
                    console.warn(
                        `[KnowledgeBase] 🛡️ Preserved ${staleRows} stale pairwise similarity row(s): ` +
                        `current model_sig=${this.tagMemoEngine.modelSig} has no cached rows yet.`
                    );
                }
                return;
            }

            const result = this.db.prepare(
                'DELETE FROM tag_pair_similarity WHERE model_sig != ?'
            ).run(this.tagMemoEngine.modelSig);

            if (result.changes > 0) {
                console.warn(`[KnowledgeBase] 🧹 Removed ${result.changes} stale pairwise similarity row(s) from old embedding model signatures.`);
            }
        } catch (e) {
            console.warn('[KnowledgeBase] ⚠️ Failed to cleanup stale pairwise similarity model rows:', e.message);
        }
    }

    /**
     * 🧹 启动期数据库修复：
     * - 清理旧版本在 foreign_keys 未开启时遗留的 chunks/file_tags 孤儿记录
     * - 清理服务器关闭/重启期间漏掉 unlink 事件造成的已不存在文件记录
     * - 若清理影响到持久化日记索引，删除旧索引文件，避免 stale chunk id 被再次加载
     */
    _cleanupDatabaseOrphans() {
        try {
            const affectedDiaries = new Set();

            const missingFiles = this.db.prepare('SELECT id, path, diary_name FROM files').all()
                .filter(row => !fsSync.existsSync(path.join(this.config.rootPath, row.path)));

            missingFiles.forEach(row => affectedDiaries.add(row.diary_name));

            const orphanChunkCount = this.db.prepare(`
                SELECT COUNT(*) as count
                FROM chunks c
                LEFT JOIN files f ON c.file_id = f.id
                WHERE f.id IS NULL
            `).get().count || 0;

            const cleanupTransaction = this.db.transaction(() => {
                for (const row of missingFiles) {
                    this.db.prepare('DELETE FROM file_tags WHERE file_id = ?').run(row.id);
                    this.db.prepare('DELETE FROM chunks WHERE file_id = ?').run(row.id);
                    this.db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
                }

                this.db.prepare(`
                    DELETE FROM file_tags
                    WHERE file_id NOT IN (SELECT id FROM files)
                       OR tag_id NOT IN (SELECT id FROM tags)
                `).run();

                this.db.prepare(`
                    DELETE FROM chunks
                    WHERE file_id NOT IN (SELECT id FROM files)
                `).run();
            });

            cleanupTransaction();

            for (const diaryName of affectedDiaries) {
                this._deletePersistedDiaryIndex(diaryName);
            }
            if (orphanChunkCount > 0) {
                // 孤儿 chunks 已经丢失 diary_name，只能保守删除全部持久化日记索引，后续从 SQLite 重建。
                this._deleteAllPersistedDiaryIndexes();
            }

            if (missingFiles.length > 0 || orphanChunkCount > 0 || affectedDiaries.size > 0) {
                console.warn(`[KnowledgeBase] 🧹 Startup cleanup complete. Removed ${missingFiles.length} missing file record(s), ${orphanChunkCount} orphan chunk(s), touched ${affectedDiaries.size} diary index(es).`);
            }
        } catch (e) {
            console.error('[KnowledgeBase] ❌ Startup database cleanup failed:', e.message || e);
        }
    }

    _deletePersistedDiaryIndex(diaryName) {
        return this.indexRepository.deletePersisted(diaryName);
    }

    _deleteAllPersistedDiaryIndexes() {
        return this.indexRepository.deleteAllPersisted();
    }

    async _getOrLoadDiaryIndex(diaryName, options = {}) {
        return this.indexRepository.getOrLoad(diaryName, options);
    }

    async _loadOrBuildIndex(fileName, capacity, tableType, filterDiaryName = null) {
        return this.indexRepository.loadOrBuild(
            fileName,
            capacity,
            tableType,
            filterDiaryName
        );
    }

    async _recoverIndexFromDB(vexusIdx, table, diaryName) {
        return this.indexRepository.recoverFromDb(vexusIdx, table, diaryName);
    }


    // =========================================================================
    // 核心搜索接口 (修复版)
    // =========================================================================

    async search(...args) {
        return await this.searchService.search(...args);
    }

    _resolveTagMemoRequest(...args) {
        return this.searchService._resolveTagMemoRequest(...args);
    }

    _resolveGeodesicCandidateK(...args) {
        return this.searchService._resolveGeodesicCandidateK(...args);
    }

    async _searchSpecificIndex(...args) {
        return await this.searchService._searchSpecificIndex(...args);
    }

    async _searchAllIndices(...args) {
        return await this.searchService._searchAllIndices(...args);
    }

    /**
     * 在指定日记本集合上执行一次逻辑联合搜索。
     * 各物理 Vexus 索引只负责返回候选；TagMemo 增强、测地线重排、全局 Top-K 与 SQLite hydrate
     * 均在联合层只执行一次，使该集合在调用方看来等价于一个请求级虚拟索引。
     */
    async _searchSelectedIndices(...args) {
        return await this.searchService._searchSelectedIndices(...args);
    }

    /**
     * 公共接口：应用请求级固定的 V9.1 TagMemo 增强向量。
     * options.tagMemoVersion 仅接受 "v9"；显式旧版本会返回 TAGMEMO_VERSION_RETIRED。
     */
    applyTagBoost(vector, tagBoost, coreTags = [], coreBoostFactor = 1.33, options = {}) {
        if (!this.tagMemoEngine) {
            if (options.strictVersion === true) {
                const error = new Error('TagMemoEngine is not available');
                error.code = 'TAGMEMO_ARTIFACT_UNAVAILABLE';
                throw error;
            }
            return {
                vector: vector instanceof Float32Array ? vector : new Float32Array(vector),
                info: null,
                energyField: null,
                energyFieldProvenance: null,
                artifactBundle: null
            };
        }
        const resolution = options.artifactBundle
            ? null
            : this.tagMemoEngine.resolveArtifactBundle({
                version: options.tagMemoVersion ?? options.version ?? null,
                strictVersion: true
            });
        return this.tagMemoEngine.applyTagBoost(
            vector,
            tagBoost,
            coreTags,
            coreBoostFactor,
            {
                ...options,
                artifactBundle: options.artifactBundle || resolution?.bundle,
                version: resolution?.requestedVersion || options.tagMemoVersion || options.version
            }
        );
    }

    getTagMemoArtifactSnapshot(version = null, options = {}) {
        if (!this.tagMemoEngine) return null;
        const resolution = this.tagMemoEngine.resolveArtifactBundle({
            version,
            strictVersion: true
        });
        return {
            bundle: resolution.bundle,
            requestedVersion: resolution.requestedVersion,
            effectiveVersion: resolution.effectiveVersion,
            fallbackUsed: resolution.fallbackUsed,
            fallbackReason: resolution.fallbackReason
        };
    }

    /**
     * 主动触发 TagMemo V9.1 全量自学习训练。
     * 该入口会清空 1% 阈值累计计数、重建 V9.1 派生资产，并清理退休的 V8.3 预计算。
     */
    requestActiveFullTraining(options = {}) {
        if (!this.tagMemoEngine || typeof this.tagMemoEngine.requestActiveFullTraining !== 'function') {
            return {
                queued: false,
                reason: options.reason || 'admin-active-full-training',
                error: 'TagMemoEngine is not available'
            };
        }

        return this.tagMemoEngine.requestActiveFullTraining(options);
    }

    /**
     * V9.1 公共接口 — 势能场重排
     * 代理到 TagMemoEngine.geodesicRerank()，供外部直接调用或测试
     * @param {Array} candidates - 候选结果
     * @param {object} options - { alpha, minGeoSamples }
     * @returns {Array} 重排后的结果
     */
    geodesicRerank(candidates, options = {}) {
        if (!this.tagMemoEngine) return candidates;
        const bundle = options.artifactBundle
            || this.tagMemoEngine.resolveArtifactBundle({
                version: options.tagMemoVersion || options.version || null,
                strictVersion: true
            }).bundle;
        // 显式请求配置最高；实时热参数覆盖 Bundle 创建时固化的旧值。
        // Bundle 配置仅提供热参数文件尚未声明的新字段默认值。
        const geoConfig = {
            ...(bundle?.potentialFieldConfig || {}),
            ...(this.ragParams?.KnowledgeBaseManager?.geodesicRerank || {}),
            ...(options.config || {})
        };
        return this.tagMemoEngine.geodesicRerank(candidates, {
            alpha: options.alpha ?? options.geoAlpha ?? geoConfig.alpha,
            minGeoSamples: options.minGeoSamples ?? geoConfig.minGeoSamples,
            energyField: options.energyField,
            energyFieldProvenance: options.energyFieldProvenance,
            originalQueryVector: options.originalQueryVector,
            enhancedQueryVector: options.enhancedQueryVector,
            queryGeometryState: options.queryGeometryState || options.queryState,
            config: geoConfig,
            version: bundle?.version,
            artifactBundle: bundle
        });
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
    // 日记日期索引 API
    // =========================================================================

    _extractDiaryDateFromText(text) {
        return this.diaryMetadataCache.extractDateFromText(text);
    }

    _buildDiaryDateIndexFromSqlite(diaryName) {
        return this.diaryMetadataCache.buildDateIndex(diaryName);
    }

    _ensureDiaryDateIndexCached(diaryName) {
        return this.diaryMetadataCache.ensureDateIndex(diaryName);
    }

    getDiaryDateIndex(diaryName) {
        return this.diaryMetadataCache.getDateIndex(diaryName);
    }

    invalidateDiaryDateIndex(diaryName) {
        return this.diaryMetadataCache.invalidateDateIndex(diaryName);
    }

    // =========================================================================
    // 兼容性 API (修复版)
    // =========================================================================

    // 🛠️ 修复 3: 同步回退 + 缓存预热
    async getDiaryNameVector(diaryName) {
        return this.diaryMetadataCache.getNameVector(diaryName);
    }

    _hydrateDiaryNameCacheSync() {
        return this.diaryMetadataCache.hydrateNameCacheSync();
    }

    async _fetchAndCacheDiaryNameVector(name) {
        return this.diaryMetadataCache.fetchAndCacheNameVector(name);
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
                const decoded = this._decodeVectorBlob(row.vector, this.config.dimension, key);
                return decoded ? Array.from(decoded) : null;
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
            return this._decodeVectorBlob(row.vector, this.config.dimension, 'chunk:content_lookup');
        }
        return null;
    }

    async getVectorByChunkId(chunkId) {
        const numericChunkId = Number(chunkId);
        if (!Number.isFinite(numericChunkId)) return null;

        const row = this.db.prepare('SELECT vector FROM chunks WHERE id = ? LIMIT 1').get(numericChunkId);
        if (row && row.vector) {
            return this._decodeVectorBlob(row.vector, this.config.dimension, `chunk:${numericChunkId}`);
        }
        return null;
    }

    /**
     * 🛡️ 启动全量扫描补洞：判断一个文件在 SQLite 中是否已有完整可用的 chunk 向量。
     * 旧逻辑只看 mtime/size，若上次 API 失败但 files 记录已写入，会在开机全扫时被误判为“无需处理”。
     */
    _hasCompleteStoredVectorsForFile(...args) {
        return this.ingestionPipeline._hasCompleteStoredVectorsForFile(...args);
    }

    _decodeReusableChunkRows(rows, expectedChunkCount, labelPrefix) {
        return this.migrationVectorCache.decodeReusableRows(
            rows,
            expectedChunkCount,
            labelPrefix
        );
    }

    _cleanupExpiredMigrationCache(now = Date.now()) {
        return this.migrationVectorCache.cleanupExpired(now);
    }

    _findReusableChunkVectors(doc) {
        return this.migrationVectorCache.findReusableVectors(doc);
    }

    /**
     * 🌟 新增：按文件路径列表获取所有分块及其向量
     * 用于 Time 模式下的二次相关性排序
     */
    async getChunksByFilePaths(...args) {
        return await this.searchService.getChunksByFilePaths(...args);
    }

    // 兼容性 API: searchSimilarTags
    async searchSimilarTags(...args) {
        return await this.searchService.searchSimilarTags(...args);
    }

    _startWatcher() {
        return this.fileWatcher.start();
    }


    _queueDelete(...args) {
        return this.ingestionPipeline._queueDelete(...args);
    }

    _scheduleDeleteBatch(...args) {
        return this.ingestionPipeline._scheduleDeleteBatch(...args);
    }

    async _flushDeleteBatch(...args) {
        return await this.ingestionPipeline._flushDeleteBatch(...args);
    }

    _scheduleBatch(...args) {
        return this.ingestionPipeline._scheduleBatch(...args);
    }

    async _flushBatch(...args) {
        return await this.ingestionPipeline._flushBatch(...args);
    }

    _prepareTextForEmbedding(text) {
        return prepareTextForEmbedding(text);
    }

    async _handleDelete(...args) {
        return await this.ingestionPipeline._handleDelete(...args);
    }

    async _handleDeleteBatch(...args) {
        return await this.ingestionPipeline._handleDeleteBatch(...args);
    }

    _scheduleIndexSave(name) {
        return this.indexRepository.scheduleSave(name);
    }

    _saveIndexToDisk(name) {
        this.indexRepository.tagIndex = this.tagIndex;
        return this.indexRepository.saveToDisk(name);
    }

    _extractTags(content) {
        return extractTags(content, this.config);
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
        this.indexRepository.startIdleSweep();
        this.idleSweepTimer = this.indexRepository.idleSweepTimer;
    }

    // 🌟 扫描并卸载空闲超时的索引
    _evictIdleIndices() {
        return this.indexRepository.evictIdle();
    }

    _estimateVexusIndexBytes(totalVectors = 0) {
        return estimateVexusIndexBytes(totalVectors, this.config.dimension);
    }

    _safeIndexStats(index) {
        return safeIndexStats(index);
    }

    getMemoryProfile() {
        return buildMemoryProfile(this);
    }

    async shutdown() {
        console.log('[KnowledgeBase] shutting down...');

        // 先停止 TagMemo 新任务/计时器，并等待正在运行的派生任务释放 Rust 写租约；
        // 数据库连接必须在它结束后才能关闭。
        if (this.tagMemoEngine && typeof this.tagMemoEngine.shutdown === 'function') {
            await this.tagMemoEngine.shutdown({
                timeoutMs: this.config.rustWriteLeaseMaxWaitMs
            });
        }

        await this.databaseCoordinator.waitForExternalMutations();
        await this._indexRecoveryTail;
        await this.fileWatcher.stop();
        if (this.ragParamsWatcher) {
            this.ragParamsWatcher.close();
            this.ragParamsWatcher = null;
        }
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }
        if (this.deleteBatchTimer) {
            clearTimeout(this.deleteBatchTimer);
            this.deleteBatchTimer = null;
        }
        if (this.pendingDeletes.size > 0 && !this.databaseCorruptionDetected) {
            await this._flushDeleteBatch();
        }

        // 索引仓储统一等待恢复尾队列、停止空闲扫描并刷写待保存索引。
        this.indexRepository.tagIndex = this.tagIndex;
        await this.indexRepository.flushAndStop();
        this.idleSweepTimer = null;

        if (this.eventLoopWatchdogTimer) {
            clearInterval(this.eventLoopWatchdogTimer);
            this.eventLoopWatchdogTimer = null;
        }

        this.db?.close();
        console.log('[KnowledgeBase] Shutdown complete.');
    }
}

module.exports = new KnowledgeBaseManager();