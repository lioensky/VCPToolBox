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
const TagMemoV10Engine = require('./TagMemoV10Engine');
const RiverMemoEngine = require('./RiverMemoEngine');
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
const TagConsistencyService = require('./modules/knowledgeBase/tagConsistencyService');

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
            sqliteBusyTimeoutMs: (() => {
                const value = Number(process.env.KNOWLEDGEBASE_SQLITE_BUSY_TIMEOUT_MS);
                return Number.isFinite(value) && value >= 0
                    ? Math.floor(value)
                    : 10000;
            })(),
            sqliteBusyRetryDelayMs: (() => {
                const value = Number(process.env.KNOWLEDGEBASE_SQLITE_BUSY_RETRY_DELAY_MS);
                return Number.isFinite(value) && value >= 0
                    ? Math.floor(value)
                    : 1000;
            })(),
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
            maxTagsPerFile: (() => {
                const value = parseInt(process.env.KNOWLEDGEBASE_MAX_TAGS_PER_FILE, 10);
                return Number.isFinite(value) && value > 0 ? value : 50;
            })(),
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
        this.tagMemoV10Engine = null;
        this.riverMemoEngine = null;
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
            onConnectionRebound: db => this._rebindDatabaseConnection(db),
            busyTimeoutMs: this.config.sqliteBusyTimeoutMs
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
        this.tagConsistencyService = new TagConsistencyService(this, {
            VexusIndex
        });
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

        // 🧹 初始化 KBM 通用结果去重器。
        // 它是召回后的独立后处理层，不属于已经下沉 Rust 的 TagMemo 查询主链。
        this.resultDeduplicator = new ResultDeduplicator(this.db, {
            dimension: this.config.dimension
        });

        await this.loadRagParams();

        // 初始化生产 V9.2 浪潮引擎。
        this.tagMemoEngine = new TagMemoEngine(this.db, this.tagIndex, this.config, this.ragParams, this);
        await this.tagMemoEngine.initialize();

        // V10/RiverMemo 仅保留轻量控制面；完整图、CSR 与 Provenance 归属
        // VexusIndex.memoRuntime，不再从 V9 JavaScript Map 编译。
        this.tagMemoV10Engine = new TagMemoV10Engine(
            this.db,
            this.tagIndex,
            this.config,
            this.ragParams,
            { v9Engine: this.tagMemoEngine }
        );
        // 已停用旧 JS exact derived asset 启动审计。
        // RiverMemo Topology V3 现由 Rust 从原始向量计算并按 artifact 签名持有
        // 原生运行时缓存；v10_vector_metrics / v10_chunk_tag_geometry 仅供已退休的
        // JS 路径使用。保留下方旧入口注释，便于兼容性回滚，不再在启动时重建。
        // try {
        //     this.tagMemoV10Engine.ensureExactDerivedAssets();
        // } catch (error) {
        //     console.error(
        //         '[KnowledgeBase] ⚠️ Legacy V10 exact derived asset audit failed:',
        //         error.message || error
        //     );
        // }

        const riverMemoConfig =
            this.ragParams?.KnowledgeBaseManager?.riverMemo || {};
        this.riverMemoEngine = new RiverMemoEngine(
            this.tagMemoV10Engine,
            { config: riverMemoConfig }
        );

        // 冷启动只读取 SQLite 清单元数据，绝不在 JS 解压/恢复完整资产。
        // 命中严格兼容清单后，首次查询由 Rust 懒加载并原子发布 Arc；
        // 未命中则由 post-startup 原生 bootstrap 构建。
        let nativeMemoRestored = false;
        try {
            const restored = this._restoreNativeMemoControlHandles();
            nativeMemoRestored = !!restored;
            if (!nativeMemoRestored) {
                console.warn(
                    '[KnowledgeBase] 🧊 No compatible native Memo artifact manifest; ' +
                    'native bootstrap will be queued immediately after System Ready.'
                );
            }
        } catch (error) {
            console.error(
                '[KnowledgeBase] ⚠️ Native Memo control-handle restore failed; ' +
                'native bootstrap will be queued immediately after System Ready:',
                error.message || error
            );
        }
        this._cleanupStalePairwiseSimilarityModels();

        this._startWatcher();
        this._startRagParamsWatcher();
        this._startIdleSweep(); // 🌟 启动空闲索引自动卸载
        this._startEventLoopWatchdog(); // 🛡️ 运行期无日志卡死定位：记录主线程长阻塞

        this.initialized = true;
        this.startupCompletedAt = Date.now();
        console.log('[KnowledgeBase] ✅ System Ready');

        if (this.tagMemoEngine && typeof this.tagMemoEngine.schedulePostStartupDerivedRefresh === 'function') {
            // 原生资产存在时，5 分钟窗口仅执行可选热自检；首次查询可由 Rust
            // 从 SQLite payload 懒加载 MemoRuntime Arc。若清单缺失，则必需资产
            // 必须立即进入 bootstrap 队列，不能让查询在冷却期内持续失败。
            const derivedRefreshDelayMs = nativeMemoRestored
                ? this.config.derivedStartupCooldownMs
                : 0;
            this.tagMemoEngine.schedulePostStartupDerivedRefresh(derivedRefreshDelayMs);
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
            if (this.resultDeduplicator) {
                this.resultDeduplicator.updateConfig(
                    parsed.KnowledgeBaseManager?.resultDeduplication || {}
                );
            }
            if (this.tagMemoEngine) this.tagMemoEngine.updateRagParams(parsed);
            if (this.tagMemoV10Engine) this.tagMemoV10Engine.updateRagParams(parsed);
            if (this.riverMemoEngine) {
                this.riverMemoEngine.updateConfig(
                    parsed.KnowledgeBaseManager?.riverMemo || {}
                );
            }
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

    _buildNativeMemoEffectiveConfig() {
        const kbConfig = JSON.parse(JSON.stringify(
            this.ragParams?.KnowledgeBaseManager || {}
        ));
        const memoControlConfig =
            this.tagMemoV10Engine?.getEffectiveConfig?.() || {};
        return JSON.parse(JSON.stringify({
            ...kbConfig,
            ...memoControlConfig,
            orderedCooccurrence: kbConfig.orderedCooccurrence || {},
            v9: kbConfig.v9 || {},
            spikeRouting: kbConfig.spikeRouting || {}
        }));
    }

    _computeNativeMemoDatabaseGeneration() {
        const facts = ['files', 'chunks', 'tags', 'file_tags'].map(table => {
            const row = this.db.prepare(
                `SELECT COUNT(*) AS count, COALESCE(MAX(rowid), 0) AS maxRowId FROM ${table}`
            ).get();
            return `${table}:${Number(row?.count) || 0}:${Number(row?.maxRowId) || 0}`;
        });
        return crypto.createHash('sha256')
            .update(facts.join('|'))
            .digest('hex')
            .slice(0, 40);
    }

    _restoreNativeMemoControlHandles() {
        if (!this.tagMemoEngine || !this.tagMemoV10Engine) return null;
        const effectiveConfig = this._buildNativeMemoEffectiveConfig();
        const configHash = crypto.createHash('sha256')
            .update(JSON.stringify(effectiveConfig))
            .digest('hex')
            .slice(0, 32);
        const databaseGeneration =
            this._computeNativeMemoDatabaseGeneration();
        const row = this.db.prepare(`
            SELECT
                artifact_sig,
                algorithm_version,
                source_v9_artifact_sig,
                source_graph_generation,
                model_sig,
                config_hash,
                database_generation,
                provenance_generation,
                node_count,
                edge_count,
                published_at
            FROM rivermemo_artifacts
            WHERE model_sig = ?
              AND config_hash = ?
              AND database_generation = ?
              AND algorithm_version = 'memo.native-artifact-v1'
              AND status = 'ready'
              AND payload IS NOT NULL
            ORDER BY published_at DESC, updated_at DESC
            LIMIT 1
        `).get(
            this.tagMemoEngine.modelSig,
            configHash,
            databaseGeneration
        );
        if (!row) return null;

        const nativeResult = {
            success: true,
            artifactSig: row.artifact_sig,
            sourceArtifactSig: row.source_v9_artifact_sig,
            graphGeneration: row.source_graph_generation,
            sourceGraphGeneration: row.source_graph_generation,
            databaseGeneration: row.database_generation,
            provenanceGeneration: row.provenance_generation,
            modelSig: row.model_sig,
            configHash: row.config_hash,
            algorithmVersion: row.algorithm_version,
            generation: null,
            nodeCount: Number(row.node_count) || 0,
            edgeCount: Number(row.edge_count) || 0,
            persisted: true,
            resident: false
        };
        const v9Handle = this.tagMemoEngine.publishNativeArtifactHandle(
            nativeResult,
            effectiveConfig
        );
        const artifact = this.tagMemoV10Engine.publishNativeArtifactHandle(
            nativeResult,
            {
                effectiveConfig,
                publishedAt: Number(row.published_at) || Date.now()
            }
        );
        console.log(
            `[KnowledgeBase] ♻️ Native Memo manifest restored without JS payload decode: ` +
            `artifact=${artifact.artifactSig}, sourceV9=${v9Handle.artifactSig}, ` +
            `nodes=${artifact.nodeCount}, edges=${artifact.edgeCount}.`
        );
        return artifact;
    }

    /**
     * Rust 已完成构建、持久化与 MemoRuntime Arc 发布后的控制面回调。
     * 本方法只发布轻量句柄，禁止编译 JS CSR、解压 payload 或清空原生 runtime。
     */
    onNativeMemoArtifactPublished(nativeResult, v9Handle = null) {
        if (!this.tagMemoV10Engine) return null;
        const effectiveConfig = this._buildNativeMemoEffectiveConfig();
        const artifact = this.tagMemoV10Engine.publishNativeArtifactHandle(
            nativeResult,
            { effectiveConfig }
        );
        console.log(
            `[KnowledgeBase] 🌊 Native Memo generation ready: ` +
            `artifact=${artifact.artifactSig}, sourceV9=` +
            `${v9Handle?.artifactSig || artifact.sourceArtifactSig}, ` +
            `nativeGeneration=${artifact.nativeGeneration ?? 'unknown'}.`
        );
        return artifact;
    }

    /**
     * 退休兼容入口：旧 JS 图发布不得再触发生产伴生编译。
     */
    onTagMemoArtifactPublished(sourceBundle) {
        console.warn(
            `[KnowledgeBase] Ignored retired JS Memo artifact publication ` +
            `${sourceBundle?.artifactSig || 'unknown'}; native rebuild is required.`
        );
        return null;
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

    /**
     * Rust/rusqlite 派生写完成后的专用屏障。
     * 先淘汰长期存活的 better-sqlite3 连接及其 pager/WAL/SHM 视图，
     * 再由新连接执行 checkpoint + quick_check；普通 JS 写不走此低频路径。
     */
    reopenAndAssertDatabaseHealthy(reason = 'rust-write-barrier') {
        this.sqliteHealthManager.syncFromOwner(this);
        const healthy = this.sqliteHealthManager.reopenAndAssertHealthy(reason);
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
        if (this.tagMemoV10Engine) {
            this.tagMemoV10Engine.rebindDatabase(db);
        }
        if (this.riverMemoEngine) {
            this.riverMemoEngine.rebindDatabase(db);
        }

        if (this.resultDeduplicator) {
            this.resultDeduplicator.db = db;
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

    _isSqliteBusyError(error) {
        return this.sqliteHealthManager.isBusyError(error);
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
    /**
     * TagMemo 原生异步增强兼容门面。
     *
     * 返回旧 applyTagBoost 的主要字段形状，同时附带 preparedMemoObservation，
     * 供后续 DTSC/Topology 读出复用同一次 Rust 感应，禁止重复构造河网。
     */
    async applyTagBoostAsync(
        vector,
        tagBoost,
        coreTags = [],
        coreBoostFactor = 1.33,
        options = {}
    ) {
        const source = vector instanceof Float32Array
            ? vector
            : new Float32Array(vector || []);
        const prepared = options.preparedMemoObservation
            || await this.prepareUnifiedMemoObservation(
                {
                    text: String(options.queryText || ''),
                    vector: source
                },
                {
                    ...options,
                    vector: source,
                    coreTags,
                    sourceObservationConfig: {
                        ...(options.sourceObservationConfig || {}),
                        baseTagBoost: Math.max(
                            0,
                            Number(tagBoost) || 0
                        ),
                        coreBoostFactor: Math.max(
                            0,
                            Number(coreBoostFactor) || 1.33
                        )
                    }
                }
            );
        const observation = prepared.observation;
        const sourceObservation = prepared.sourceObservationResult;
        const energyField = new Map(
            (Array.isArray(observation?.nodes)
                ? observation.nodes
                : []
            ).map(node => [
                Number(node.id),
                Math.max(0, Number(node.energy) || 0)
            ])
        );
        const energyFieldProvenance = new Map(
            Array.isArray(sourceObservation?.fieldProvenance)
                ? sourceObservation.fieldProvenance
                : []
        );
        const v9Bundle =
            this.tagMemoEngine?.getArtifactBundleSnapshot?.('v9')
            || null;

        return {
            vector: prepared.enhancedVector,
            energyField,
            energyFieldProvenance,
            artifactBundle: v9Bundle,
            preparedMemoObservation: prepared,
            info: {
                coreTagsMatched:
                    sourceObservation.coreTagsMatched || [],
                matchedTags:
                    sourceObservation.matchedTags || [],
                boostFactor: Number.isFinite(
                    Number(sourceObservation.effectiveTagBoost)
                )
                    ? Math.max(
                        0,
                        Number(sourceObservation.effectiveTagBoost)
                    )
                    : Math.max(0, Number(tagBoost) || 0),
                requestedVersion: 'v9',
                effectiveVersion: 'v9',
                versionFallbackUsed: false,
                versionFallbackReason: null,
                artifactSig: v9Bundle?.artifactSig || null,
                graphGeneration:
                    v9Bundle?.graphGeneration || null,
                artifactGeneration:
                    v9Bundle?.generation || null,
                nativeArtifactSig:
                    prepared.artifact?.artifactSig || null,
                nativeArtifactGeneration:
                    prepared.artifact?.generation || null,
                epa: sourceObservation.epa || {},
                pyramid: sourceObservation.pyramid || {},
                propagation:
                    sourceObservation.propagation || {},
                queryRiverGraph:
                    sourceObservation.queryRiverGraph || null,
                algorithmVersion:
                    observation?.algorithmVersion
                    || 'tagmemo.spike-v9.1-rust-shared',
                runtimeOwnership: 'vexus-index-instance',
                nativeFusion:
                    sourceObservation.diagnostics?.nativeFusion || null
            }
        };
    }

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

    getTagMemoV10ArtifactSnapshot(options = {}) {
        if (!this.tagMemoV10Engine) return null;
        const forceRebuild = options.forceRebuild === true;
        const bundle = forceRebuild
            ? this.tagMemoV10Engine.buildAndPublishArtifact(options)
            : this.tagMemoV10Engine.getArtifactSnapshot(options);
        return {
            bundle,
            requestedVersion: 'v10_alpha',
            effectiveVersion: 'v10_alpha',
            fallbackUsed: false,
            fallbackReason: null
        };
    }

    prepareTagMemoV10Query(query, agentContext = {}, options = {}) {
        if (!this.tagMemoV10Engine) {
            const error = new Error('TagMemo V10 Alpha engine is not available');
            error.code = 'TAGMEMO_V10_ARTIFACT_UNAVAILABLE';
            throw error;
        }
        return this.tagMemoV10Engine.prepareQuery(query, agentContext, options);
    }

    buildTagMemoV10CandidateSuperset(sourceCandidates, options = {}) {
        if (!this.tagMemoV10Engine) {
            throw new Error('TagMemo V10 Alpha engine is not available');
        }
        return this.tagMemoV10Engine.buildCandidateSuperset(sourceCandidates, options);
    }

    projectTagMemoV10CandidateCurves(candidates, options = {}) {
        if (!this.tagMemoV10Engine) {
            throw new Error('TagMemo V10 Alpha engine is not available');
        }
        return this.tagMemoV10Engine.projectCandidateCurves(candidates, options);
    }

    evaluateTagMemoV10CandidateCurves(curves, queryState, options = {}) {
        if (!this.tagMemoV10Engine) {
            throw new Error('TagMemo V10 Alpha engine is not available');
        }
        return this.tagMemoV10Engine.evaluateCandidateCurves(
            curves,
            queryState,
            options
        );
    }

    computeTagMemoV10Dstc(pathBatch, queryState, options = {}) {
        if (!this.tagMemoV10Engine) {
            throw new Error('TagMemo V10 Alpha engine is not available');
        }
        return this.tagMemoV10Engine.computeDstcObservables(
            pathBatch,
            queryState,
            options
        );
    }

    runTagMemoV10ExperimentArms(dstcBatch, options = {}) {
        if (!this.tagMemoV10Engine) {
            throw new Error('TagMemo V10 Alpha engine is not available');
        }
        return this.tagMemoV10Engine.runExperimentArms(dstcBatch, options);
    }

    scoreTagMemoV10ExperimentArm(dstcBatch, arm, options = {}) {
        if (!this.tagMemoV10Engine) {
            throw new Error('TagMemo V10 Alpha engine is not available');
        }
        return this.tagMemoV10Engine.scoreExperimentArm(
            dstcBatch,
            arm,
            options
        );
    }

    _resolveUnifiedMemoRuntime() {
        if (!this.tagIndex || !this.tagMemoEngine || !this.tagMemoV10Engine) {
            const error = new Error('Unified native Memo runtime is unavailable');
            error.code = 'MEMO_RUNTIME_UNAVAILABLE';
            throw error;
        }
        if (
            typeof this.tagIndex.runMemoPipeline !== 'function'
            || typeof this.tagIndex.rerankMemoDtsc !== 'function'
            || typeof this.tagIndex.rerankRivermemoTopologyV3 !== 'function'
        ) {
            const error = new Error(
                'Unified native Memo ABI is unavailable; rebuild rust-vexus-lite'
            );
            error.code = 'MEMO_NATIVE_ABI_UNAVAILABLE';
            throw error;
        }
        if (!this.dbPath) {
            const error = new Error('Unified native Memo runtime has no SQLite path');
            error.code = 'MEMO_DB_PATH_UNAVAILABLE';
            throw error;
        }

        const artifact = this.tagMemoV10Engine.getArtifactSnapshot({
            buildIfMissing: false
        });
        if (!artifact?.artifactSig) {
            const error = new Error('Unified native Memo artifact is unavailable');
            error.code = 'MEMO_ARTIFACT_UNAVAILABLE';
            throw error;
        }
        return { artifact, dbPath: this.dbPath };
    }

    /**
     * 统一原生感应入口。
     *
     * JavaScript 只冻结并透传请求配置；EPA、Residual Pyramid、语言/Core/
     * 层级门控、Spike 河网和向量融合由同一个 VexusIndex 后台任务一次完成。
     * 返回对象继续兼容 V10 prepareQuery 与旧 BoostResult 消费契约。
     */
    async prepareUnifiedMemoObservation(query, options = {}) {
        const { artifact, dbPath } = this._resolveUnifiedMemoRuntime();
        const queryVectorRaw = query?.vector || options.vector;
        const queryVector = queryVectorRaw instanceof Float32Array
            ? queryVectorRaw
            : new Float32Array(queryVectorRaw || []);
        if (queryVector.length !== this.config.dimension) {
            throw new RangeError(
                `Unified Memo query vector must be ${this.config.dimension}, ` +
                `got ${queryVector.length}`
            );
        }

        const kbConfig = this.ragParams?.KnowledgeBaseManager || {};
        const riverConfig = kbConfig.riverMemo || {};
        const sourceObservationConfig = {
            ...(riverConfig.sourceObservation || {}),
            ...(artifact.effectiveConfig?.sourceObservation || {}),
            ...(options.sourceObservation || {}),
            ...(options.sourceObservationConfig || {})
        };
        const spike = {
            ...(kbConfig.spikeRouting || {}),
            ...(options.spikeRouting || {})
        };
        const nativeMemoConfig = artifact.effectiveConfig || {};
        const localFieldConfig = {
            ...(nativeMemoConfig.localField || {}),
            ...(options.localField || {})
        };
        const transferFieldConfig = {
            ...(nativeMemoConfig.transferField || {}),
            ...(options.transferField || {})
        };
        const effectiveSupportConfig = {
            ...(nativeMemoConfig.effectiveSupport || {}),
            ...(options.effectiveSupport || {})
        };
        const language = kbConfig.languageCompensator || {};
        const requestedCoreTags = Array.isArray(options.coreTags)
            ? options.coreTags
            : [];
        const stringCoreTags = requestedCoreTags
            .filter(tag => typeof tag === 'string' && tag.trim())
            // JS SOTA 的 coreTagSet 以小写名称工作，后补 SQL 也消费该规范值。
            .map(tag => tag.trim().toLowerCase());
        // 旧 JS SOTA 接受 { name, vector, isCore } 幽灵节点。它们不是图传播
        // 种子：脉冲传播结束后才参与 Core/Soft 权重融合。必须把向量和强弱语义
        // 原样传给 Rust，不能再像早期统一管线一样静默过滤对象 Core。
        const ghostTags = requestedCoreTags
            .filter(tag =>
                tag
                && typeof tag === 'object'
                && typeof tag.name === 'string'
                && tag.name.trim()
                && tag.vector
                && typeof tag.vector.length === 'number'
            )
            .map(tag => ({
                name: tag.name.trim(),
                vector: Array.from(tag.vector, value => Number(value) || 0),
                isCore: tag.isCore === true
            }));

        const nativePayload = await this.tagIndex.runMemoPipeline(
            dbPath,
            artifact.artifactSig,
            JSON.stringify({
                queryId: options.queryId || null,
                queryText: String(query?.text || options.queryText || ''),
                queryVector: Array.from(queryVector),
                coreTags: stringCoreTags,
                ghostTags,
                config: {
                    baseTagBoost: Math.max(
                        0,
                        Number(sourceObservationConfig.baseTagBoost ?? 0.6)
                    ),
                    coreBoostFactor: Math.max(
                        0,
                        Number(sourceObservationConfig.coreBoostFactor ?? 1.33)
                    ),
                    localAlpha: Number(localFieldConfig.alpha ?? 0.15),
                    transferAlpha: Number(transferFieldConfig.alpha ?? 0.55),
                    fieldMaxIterations: Math.max(
                        1,
                        Math.floor(Math.max(
                            Number(localFieldConfig.maxIterations) || 80,
                            Number(transferFieldConfig.maxIterations) || 80
                        ))
                    ),
                    localTolerance: Math.max(
                        1e-15,
                        Number(localFieldConfig.tolerance) || 1e-9
                    ),
                    transferTolerance: Math.max(
                        1e-15,
                        Number(transferFieldConfig.tolerance) || 1e-9
                    ),
                    localMassRatio: Math.max(
                        0.01,
                        Math.min(
                            1,
                            Number(effectiveSupportConfig.localMassRatio ?? 0.8)
                        )
                    ),
                    transferMassRatio: Math.max(
                        0.01,
                        Math.min(
                            1,
                            Number(effectiveSupportConfig.transferMassRatio ?? 0.9)
                        )
                    ),
                    maxLevels: Math.max(
                        1,
                        Math.floor(Number(options.maxPyramidLevels) || 3)
                    ),
                    pyramidTopK: Math.max(
                        1,
                        Math.floor(Number(options.pyramidTopK) || 10)
                    ),
                    minEnergyRatio: Math.max(
                        0,
                        Math.min(
                            1,
                            Number(options.minPyramidEnergyRatio ?? 0.1)
                        )
                    ),
                    layerDecay: Math.max(
                        0,
                        Math.min(1, Number(options.layerDecay ?? 0.7))
                    ),
                    activationMultiplier:
                        kbConfig.activationMultiplier || [0.5, 1.5],
                    dynamicBoostRange:
                        kbConfig.dynamicBoostRange || [0.3, 2.0],
                    coreBoostRange:
                        kbConfig.coreBoostRange || [1.2, 1.4],
                    langConfidenceEnabled:
                        this.config.langConfidenceEnabled !== false,
                    langPenaltyUnknown: Number(
                        language.penaltyUnknown
                        ?? this.config.langPenaltyUnknown
                        ?? 0.05
                    ),
                    langPenaltyCrossDomain: Number(
                        language.penaltyCrossDomain
                        ?? this.config.langPenaltyCrossDomain
                        ?? 0.1
                    ),
                    deduplicationThreshold: Number(
                        kbConfig.deduplicationThreshold ?? 0.88
                    ),
                    maxFusionTags: Math.max(
                        1,
                        Math.floor(Number(options.maxFusionTags) || 128)
                    ),
                    maxEmergentNodes: Math.max(
                        0,
                        Math.floor(Number(
                            options.maxEmergentNodes
                            ?? spike.maxEmergentNodes
                            ?? 50
                        ))
                    ),
                    techTagThreshold: Number(
                        kbConfig.techTagThreshold ?? 0.08
                    ),
                    normalTagThreshold: Number(
                        kbConfig.normalTagThreshold ?? 0.015
                    ),
                    spikeRouting: {
                        maxSafeHops: spike.maxSafeHops,
                        baseMomentum: spike.baseMomentum,
                        firingThreshold: spike.firingThreshold,
                        baseDecay: spike.baseDecay,
                        wormholeDecay: spike.wormholeDecay,
                        tensionThreshold: spike.tensionThreshold,
                        maxNeighborsPerNode: spike.maxNeighborsPerNode,
                        returnFlowFactor: spike.v91ReturnFlowFactor,
                        firGamma: spike.v91FirGamma,
                        maxPropagationStates:
                            spike.v91MaxPropagationStates,
                        minimumInjectedCurrent:
                            spike.minimumInjectedCurrent,
                        // 0 表示不截断。旧 JS SOTA 的 query river graph 完整保留
                        // reached nodes/edges；只在最终融合时截断 emergent 节点。
                        maxOutputNodes:
                            options.maxObservationNodes ?? 0,
                        maxOutputEdges:
                            options.maxObservationEdges ?? 0
                    }
                }
            })
        );
        const pipeline = JSON.parse(nativePayload);
        const observation = pipeline?.observation;
        if (
            pipeline?.artifactSig !== artifact.artifactSig
            || observation?.artifactSig !== artifact.artifactSig
            || !Array.isArray(observation?.nodes)
            || !Array.isArray(observation?.edges)
            || !Array.isArray(pipeline?.enhancedVector)
            || pipeline.enhancedVector.length !== this.config.dimension
            || !Array.isArray(pipeline?.localVector)
            || pipeline.localVector.length !== this.config.dimension
            || !Array.isArray(pipeline?.transferVector)
            || pipeline.transferVector.length !== this.config.dimension
            || !Array.isArray(pipeline?.localField)
            || !Array.isArray(pipeline?.transferField)
            || !Array.isArray(pipeline?.localDomainIds)
            || !Array.isArray(pipeline?.transferDomainIds)
        ) {
            const error = new Error(
                'Unified native Memo pipeline failed artifact/schema validation'
            );
            error.code = 'MEMO_PIPELINE_INVALID';
            throw error;
        }

        const fieldProvenance = observation.nodes.map(node => Object.freeze([
            Number(node.id),
            Object.freeze({
                sourceType: node.sourceType || 'unknown',
                originType: node.originType || null,
                hop: Number(node.hop) || 0,
                seedId: Number.isFinite(Number(node.seedId))
                    ? Number(node.seedId)
                    : null
            })
        ]));
        const sourceField = (Array.isArray(observation.sourceField)
            ? observation.sourceField
            : []
        ).map(entry => Object.freeze([
            Number(entry?.[0]),
            Math.max(0, Number(entry?.[1]) || 0)
        ]));
        const pyramidRaw = pipeline.pyramid || {};
        const pyramidFeatures = pyramidRaw.features || {};
        const pyramid = Object.freeze({
            coverage: Number(pyramidFeatures.coverage) || 0,
            novelty: Number(pyramidFeatures.novelty) || 0,
            coherence: Number(pyramidFeatures.coherence) || 0,
            activation: Number(pyramidFeatures.activation) || 0,
            depth: Number(pyramidFeatures.depth) || 0,
            totalExplainedEnergy:
                Number(pyramidRaw.totalExplainedEnergy) || 0,
            levels: Object.freeze(
                Array.isArray(pyramidRaw.levels)
                    ? pyramidRaw.levels
                    : []
            )
        });
        const enhancedVector = Object.freeze(
            pipeline.enhancedVector.map(value => Number(value) || 0)
        );
        const observationHandle = typeof pipeline.observationHandle === 'string'
            && pipeline.observationHandle
            ? pipeline.observationHandle
            : null;
        const nativeFusion = pipeline.diagnostics?.fusion || null;

        const sourceObservationResult = Object.freeze({
            schema: pipeline.schema,
            sourceMode: 'rust_unified_memo_pipeline',
            sourceField: Object.freeze(sourceField),
            enhancedVector,
            fieldProvenance: Object.freeze(fieldProvenance),
            queryRiverGraph: Object.freeze({
                schema: 'vexus-unified-memo-river-v1',
                nodes: Object.freeze(observation.nodes),
                edges: Object.freeze(observation.edges),
                diagnostics: Object.freeze({
                    reachedNodes:
                        observation.diagnostics?.reachedNodes || 0,
                    activeEdges:
                        observation.diagnostics?.activeEdges || 0,
                    maximumNodeEnergy:
                        observation.diagnostics?.maximumNodeEnergy || 0,
                    maximumEdgeFlow:
                        observation.diagnostics?.maximumEdgeFlow || 0
                })
            }),
            epa: Object.freeze({ ...(pipeline.epa || {}) }),
            pyramid,
            propagation: Object.freeze({
                native: observation.diagnostics || null
            }),
            matchedTags: Object.freeze(
                Array.isArray(pipeline.matchedTags)
                    ? pipeline.matchedTags.slice()
                    : []
            ),
            coreTagsMatched: Object.freeze(
                Array.isArray(pipeline.coreTagsMatched)
                    ? pipeline.coreTagsMatched.slice()
                    : []
            ),
            v9ArtifactSig:
                this.tagMemoEngine
                    ?.getArtifactBundleSnapshot?.('v9')
                    ?.artifactSig || null,
            nativeArtifactSig: artifact.artifactSig,
            observationHandle,
            effectiveTagBoost:
                Math.max(0, Number(pipeline.effectiveTagBoost) || 0),
            diagnostics: Object.freeze({
                completeObservation: sourceField.length > 0,
                nativeSensing: observation.diagnostics || null,
                nativeFusion: nativeFusion
                    ? Object.freeze({ ...nativeFusion })
                    : null,
                nativePipeline: Object.freeze({
                    ...(pipeline.diagnostics || {})
                }),
                runtimeOwnership: 'vexus-index-instance'
            })
        });

        const normalizeNativeField = entries => Object.freeze(
            entries.map(entry => Object.freeze([
                Number(entry?.[0]),
                Math.max(0, Number(entry?.[1]) || 0)
            ])).filter(entry =>
                Number.isFinite(entry[0]) && entry[0] > 0 && entry[1] > 0
            )
        );
        const localField = normalizeNativeField(pipeline.localField);
        const transferField = normalizeNativeField(pipeline.transferField);
        const localDomainIds = Object.freeze(
            pipeline.localDomainIds.map(Number).filter(Number.isFinite)
        );
        const transferDomainIds = Object.freeze(
            pipeline.transferDomainIds.map(Number).filter(Number.isFinite)
        );

        return Object.freeze({
            artifact,
            observationHandle,
            observation: Object.freeze(observation),
            sourceObservationResult,
            sourceField: Object.freeze(sourceField),
            queryVector,
            enhancedVector: new Float32Array(enhancedVector),
            nativePreparedQuery: Object.freeze({
                queryState: Object.freeze({
                    queryId: observation.queryId || options.queryId || null,
                    sourceField: Object.freeze(sourceField),
                    localField,
                    transferField,
                    localDomain: Object.freeze({ ids: localDomainIds }),
                    transferDomain: Object.freeze({ ids: transferDomainIds }),
                    queryRiverGraph: sourceObservationResult.queryRiverGraph,
                    sourceObservation: sourceObservationResult,
                    fieldDiagnostics: Object.freeze({
                        backend: 'rust-unified-memo-pipeline',
                        ...(pipeline.diagnostics?.dualField || {})
                    })
                }),
                denoisedVector: new Float32Array(enhancedVector),
                localVector: new Float32Array(pipeline.localVector),
                transferVector: new Float32Array(pipeline.transferVector),
                fieldProjectionDiagnostics: Object.freeze({
                    backend: 'rust-unified-memo-pipeline'
                }),
                preparationTimings: Object.freeze({
                    nativePipelineTotalMs:
                        Number(pipeline.diagnostics?.totalMs) || 0
                })
            })
        });
    }

    /**
     * 统一 Memo 双读出门面。readoutMode 只允许 dtsc / topology_v3；
     * 二者共享同一次原生 QueryObservation 和同一个活动图代际。
     */
    async rerankWithMemo(
        readoutMode,
        query,
        candidates,
        agentContext = {},
        options = {}
    ) {
        const mode = String(readoutMode || '').trim().toLowerCase();
        if (mode !== 'dtsc' && mode !== 'topology_v3') {
            const error = new Error(
                `Unsupported Memo readout mode: ${readoutMode}`
            );
            error.code = 'MEMO_READOUT_MODE_UNSUPPORTED';
            throw error;
        }
        const prepared = options.preparedMemoObservation
            || await this.prepareUnifiedMemoObservation(query, options);
        const { artifact, observation, sourceObservationResult } = prepared;

        if (mode === 'topology_v3') {
            if (!this.riverMemoEngine) {
                const error = new Error('RiverMemo engine is unavailable');
                error.code = 'RIVERMEMO_UNAVAILABLE';
                throw error;
            }
            return await this.riverMemoEngine.rerank(
                {
                    text: String(query?.text || ''),
                    vector: prepared.queryVector
                },
                Array.isArray(candidates) ? candidates : [],
                agentContext,
                {
                    ...options,
                    artifact,
                    dbPath: this.dbPath,
                    nativePreparedQuery: prepared.nativePreparedQuery,
                    observationHandle: prepared.observationHandle,
                    sourceObservationResult,
                    sourceField: prepared.sourceField,
                    sourceObservationConfig: {
                        ...(artifact.effectiveConfig
                            ?.sourceObservation || {}),
                        ...(options.sourceObservationConfig || {})
                    },
                    includeTrace: options.includeTrace === true
                }
            );
        }

        const geoConfig = {
            ...(artifact.effectiveConfig
                ?.potentialFieldRerank || {}),
            ...(artifact.effectiveConfig
                ?.geodesicRerank || {}),
            ...(this.ragParams?.KnowledgeBaseManager
                ?.potentialFieldRerank || {}),
            ...(this.ragParams?.KnowledgeBaseManager
                ?.geodesicRerank || {}),
            ...(options.config || {})
        };
        const resolvedMinGeoSamples = Math.max(
            1,
            Math.floor(Number(
                options.minGeoSamples
                ?? geoConfig.minGeoSamples
                ?? 3
            ))
        );
        const nativePayload = await this.tagIndex.rerankMemoDtsc(
            this.dbPath,
            artifact.artifactSig,
            JSON.stringify({
                dimension: this.config.dimension,
                observationHandle: prepared.observationHandle,
                queryGeometryState: {
                    epa: sourceObservationResult.epa || {},
                    pyramid: sourceObservationResult.pyramid || {}
                },
                topK: Math.max(
                    1,
                    Math.floor(
                        Number(options.topK)
                        || (Array.isArray(candidates)
                            ? candidates.length
                            : 1)
                    )
                ),
                candidates: (Array.isArray(candidates)
                    ? candidates
                    : []
                ).map(candidate => ({
                    id: Number(
                        candidate?.id
                        ?? candidate?.chunkId
                        ?? candidate?.label
                    ),
                    score: Number(candidate?.score) || 0
                })).filter(candidate =>
                    Number.isFinite(candidate.id)
                    && candidate.id > 0
                ),
                ...(prepared.observationHandle
                    ? {}
                    : {
                        observation,
                        originalQueryVector:
                            Array.from(prepared.queryVector),
                        enhancedQueryVector:
                            Array.from(prepared.enhancedVector)
                    }),
                config: {
                    ...geoConfig,
                    alpha:
                        options.alpha
                        ?? options.geoAlpha
                        ?? geoConfig.alpha,
                    minGeoSamples: resolvedMinGeoSamples,
                    // JS SOTA 默认 minFieldTags 跟随 minGeoSamples，而不是固定常量。
                    minFieldTags:
                        geoConfig.minFieldTags
                        ?? resolvedMinGeoSamples,
                    fallbackToKnnOnLowTrust:
                        geoConfig.fallbackToKnnOnLowTrust !== false
                        && geoConfig.fallbackToKnnOnLowTrust !== 0,
                    sparseAssociationEnabled:
                        geoConfig.sparseAssociationEnabled !== false
                        && geoConfig.sparseAssociationEnabled !== 0,
                    geometryAuxiliary: {
                        ...(geoConfig.geometryAuxiliary || {}),
                        enabled:
                            geoConfig.geometryAuxiliary?.enabled === true
                            || geoConfig.geometryAuxiliary?.enabled === 1,
                        identityAnchor: {
                            ...(geoConfig.geometryAuxiliary
                                ?.identityAnchor || {}),
                            enabled:
                                geoConfig.geometryAuxiliary
                                    ?.identityAnchor?.enabled === true
                                || geoConfig.geometryAuxiliary
                                    ?.identityAnchor?.enabled === 1
                        }
                    }
                }
            })
        );
        const nativeResult = JSON.parse(nativePayload);
        const originalById = new Map(
            (Array.isArray(candidates) ? candidates : [])
                .map(candidate => [
                    Number(
                        candidate?.id
                        ?? candidate?.chunkId
                        ?? candidate?.label
                    ),
                    candidate
                ])
                .filter(([id]) => Number.isFinite(id) && id > 0)
        );
        const results = (Array.isArray(nativeResult.results)
            ? nativeResult.results
            : []
        ).map(item => Object.freeze({
            ...(originalById.get(Number(item.id)) || {}),
            ...item,
            id: Number(item.id),
            // 保持旧 TagMemo geodesicRerank 公共字段契约；Rust JSON 使用
            // camelCase，兼容调用方仍读取历史 snake_case 字段。
            original_knn_score:
                Number(item.originalKnnScore) || 0,
            geo_score:
                Number(item.geoScore) || 0,
            normalized_geo:
                Number(item.normalizedGeo) || 0,
            geo_bonus:
                Number(item.geoBonus) || 0,
            geo_base_bonus:
                Number(item.geoBaseBonus) || 0,
            geo_aux_bonus:
                Number(item.geoAuxBonus) || 0,
            geo_effect:
                item.geoEffect || 'neutral',
            geo_evidence_class:
                item.geoEvidenceClass || 'neutral',
            geo_reward_eligible:
                item.geoRewardEligible === true,
            geo_confidence:
                Number(item.geoConfidence) || 0,
            geo_exact_hits:
                Number(item.geoExactHits) || 0,
            geo_direct_exact_hits:
                Number(item.geoDirectExactHits) || 0,
            geo_emergent_exact_hits:
                Number(item.geoEmergentExactHits) || 0,
            geo_direct_semantic_hits:
                Number(item.geoDirectSemanticHits) || 0,
            geo_direct_semantic_strength:
                Number(item.geoDirectSemanticStrength) || 0,
            geo_strong_hits:
                Number(item.geoStrongHits) || 0,
            geo_hit_count:
                Number(item.geoHitCount) || 0,
            geo_weighted_coverage:
                Number(item.geoWeightedCoverage) || 0,
            geo_mean_potential:
                Number(item.geoMeanPotential) || 0,
            geo_max_potential:
                Number(item.geoMaxPotential) || 0,
            geo_continuity:
                Number(item.geoContinuity) || 0,
            geo_isolated_ratio:
                Number(item.geoIsolatedRatio) || 0,
            geo_raw_isolated_ratio:
                Number(item.geoRawIsolatedRatio) || 0,
            geo_sparse_association_confidence:
                Number(item.geoSparseAssociationConfidence) || 0,
            geo_sparse_association_pairs:
                Number(item.geoSparseAssociationPairs) || 0,
            geo_action_quality:
                Number(item.geoActionQuality) || 0,
            geo_closure_quality:
                Number(item.geoClosureQuality) || 0,
            geo_direction_consistency:
                Number(item.geoDirectionConsistency) || 0,
            geo_vector_lift:
                Number(item.geoVectorLift) || 0,
            geo_direct_score:
                Number(item.geoDirectScore) || 0,
            geo_structural_score:
                Number(item.geoStructuralScore) || 0,
            geo_thematic_score:
                Number(item.geoThematicScore) || 0,
            geo_closure_score:
                Number(item.geoClosureScore) || 0,
            geo_fused_shadow_score:
                Number(item.geoFusedShadowScore) || 0
        }));

        return Object.freeze({
            schema: nativeResult.schema,
            version: 'tagmemo_v9_dtsc_native',
            algorithmVersion: nativeResult.algorithmVersion,
            artifactSig: artifact.artifactSig,
            artifactGeneration: artifact.generation,
            readoutMode: 'dtsc',
            queryTags: Object.freeze({
                matchedTags:
                    sourceObservationResult.matchedTags,
                coreTagsMatched:
                    sourceObservationResult.coreTagsMatched,
                sourceMode:
                    sourceObservationResult.sourceMode
            }),
            results: Object.freeze(results),
            diagnostics: Object.freeze({
                ...(nativeResult.diagnostics || {}),
                sensing:
                    sourceObservationResult.diagnostics
                        ?.nativeSensing || null,
                runtimeOwnership: 'vexus-index-instance',
                memoRuntime:
                    typeof this.tagIndex.memoRuntimeStats === 'function'
                        ? this.tagIndex.memoRuntimeStats()
                        : null
            })
        });
    }

    /**
     * RiverMemo 生产接口：固定执行 Topology V3 与其绑定的 Ω 河网测量器。
     * 调用方只提供查询、候选 Chunk 和权限作用域，不得选择实验臂。
     */
    rerankWithRiverMemo(query, candidates, agentContext = {}, options = {}) {
        return this.rerankWithMemo(
            'topology_v3',
            query,
            candidates,
            agentContext,
            options
        );
    }

    /**
     * RiverMemo 生产异步门面。
     *
     * 不再启动 Node Worker 或在 Worker 中复制 V10/Artifact/SQLite 运行时。
     * 查询观测与双场准备完成后，通过唯一 N-API 边界直接进入 Rust Topology V3；
     * 候选投影和排序并发由 Rust/Rayon 自行管理。
     */
    async rerankWithRiverMemoAsync(query, candidates, agentContext = {}, options = {}) {
        return await this.rerankWithMemo(
            'topology_v3',
            query,
            candidates,
            agentContext,
            options
        );
    }

    /**
     * TagMemo DTSC 原生异步兼容入口。旧同步 geodesicRerank 保留给尚未
     * 异步化的插件；新调用应使用本接口以共享原生感应和 MemoRuntime。
     */
    async rerankWithTagMemoAsync(query, candidates, agentContext = {}, options = {}) {
        return await this.rerankWithMemo(
            'dtsc',
            query,
            candidates,
            agentContext,
            options
        );
    }

    /**
     * 对已求解的 RiverMemo/V10 Query State 计算只读 Ω 观测。
     */
    measureRiverMemoOmega(queryState, options = {}) {
        if (!this.riverMemoEngine) {
            const error = new Error('RiverMemo engine is not available');
            error.code = 'RIVERMEMO_UNAVAILABLE';
            throw error;
        }
        return this.riverMemoEngine.measureOmega(queryState, options);
    }

    getRiverMemoArtifactSnapshot(options = {}) {
        if (!this.riverMemoEngine) return null;
        const bundle = this.riverMemoEngine.getArtifactSnapshot(options);
        return {
            bundle,
            requestedVersion: 'rivermemo_v1',
            effectiveVersion: 'rivermemo_v1',
            fallbackUsed: false,
            fallbackReason: null
        };
    }

    /**
     * 使用当前文件过滤与 Tag 清洗规则生成只读一致性快照。
     * 此阶段不请求 Embedding，也不修改 SQLite / Vexus 索引。
     */
    async previewTagConsistency() {
        return await this.tagConsistencyService.createPreview();
    }

    /**
     * 确认并应用先前的 Tag 一致性快照。
     * 执行前会在排他维护窗口内重算摘要；快照过期或真相变化时拒绝执行。
     */
    async applyTagConsistencyPreview(token) {
        return await this.tagConsistencyService.applyPreview(token);
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
     * 对召回结果执行统一去重。
     * 先做稳定身份/正文硬去重，再按 options.semantic 决定是否抑制语义近重复。
     * 任意内部异常都回退到硬去重结果，不允许去重故障拖垮整次 RAG。
     *
     * @param {Array} candidates - 候选结果数组
     * @param {Float32Array|Array|null} queryVector - 查询向量
     * @param {object} options - { semantic, semanticThreshold, maxResults, stage }
     * @returns {Promise<Array>}
     */
    async deduplicateResults(candidates, queryVector = null, options = {}) {
        if (!Array.isArray(candidates) || candidates.length === 0) return [];
        if (!this.resultDeduplicator) return candidates;

        try {
            return await this.resultDeduplicator.deduplicate(
                candidates,
                queryVector,
                options
            );
        } catch (error) {
            console.warn(
                `[KnowledgeBase] Result deduplication failed at stage=${options.stage || 'unknown'}; ` +
                `falling back to exact deduplication: ${error.message}`
            );
            try {
                return this.resultDeduplicator.hardDeduplicate(candidates);
            } catch (fallbackError) {
                console.warn(
                    `[KnowledgeBase] Exact deduplication fallback also failed: ${fallbackError.message}`
                );
                return candidates;
            }
        }
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
        return extractTags(content, this.config, {
            maxTags: this.config.maxTagsPerFile
        });
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

        // 统一 MemoRuntime 归属全局 Tag VexusIndex；关闭前显式释放活动图快照。
        // 若仍有原生查询持有 Arc，实际内存会在最后一个查询结束后安全回收。
        if (typeof this.tagIndex?.clearMemoRuntime === 'function') {
            try {
                this.tagIndex.clearMemoRuntime();
            } catch (error) {
                console.warn(
                    '[KnowledgeBase] Failed to clear unified Memo runtime during shutdown:',
                    error.message || error
                );
            }
        }
        this.riverMemoEngine = null;
        this.tagMemoV10Engine = null;

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