// KnowledgeBaseManager.js
// 🌟 架构重构修复版：多路独立索引 + 稳健的 Buffer 处理 + 同步缓存回退 + TagMemo 逻辑回归

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

// 单轮请求拥有共享观测；异步读出只借用句柄，不得提前释放。
const memoObservationScope = new AsyncLocalStorage();
const { getEmbeddingsBatch } = require('./EmbeddingUtils');
const ResultDeduplicator = require('./ResultDeduplicator'); // ✅ Tagmemo v4 requirement
const TagMemoEngine = require('./TagMemoEngine');
const TagMemoV10Engine = require('./TagMemoV10Engine');
const RiverMemoEngine = require('./RiverMemoEngine');
const { decodeVectorBlob } = require('./modules/knowledgeBase/vectorCodec');
const { stableSerialize } = require('./modules/tagmemoV10/immutable');
const {
    prepareTextForEmbedding,
    extractTags
} = require('./modules/knowledgeBase/textPreprocessor');
const {
    estimateVexusIndexBytes,
    safeIndexStats,
    buildMemoryProfile,
    captureMemoryStage
} = require('./modules/knowledgeBase/memoryProfiler');
const DiaryMetadataCache = require('./modules/knowledgeBase/diaryMetadataCache');
const IndexRepository = require('./modules/knowledgeBase/indexRepository');
const DatabaseCoordinator = require('./modules/knowledgeBase/databaseCoordinator');
const KnowledgeBaseFileWatcher = require('./modules/knowledgeBase/fileWatcher');
const IngestionPipeline = require('./modules/knowledgeBase/ingestionPipeline');
const SearchService = require('./modules/knowledgeBase/searchService');
const TagConsistencyService = require('./modules/knowledgeBase/tagConsistencyService');

// 尝试加载 Rust Vexus 引擎
let VexusIndex = null;
let NativeKnowledgeRuntime = null;
try {
    const vexusModule = require('./rust-vexus-lite');
    VexusIndex = vexusModule.VexusIndex;
    NativeKnowledgeRuntime = vexusModule.NativeKnowledgeRuntime || null;
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
            migrationCacheTtlMs: parseInt(process.env.KNOWLEDGEBASE_MIGRATION_CACHE_TTL_MS, 10) || 2 * 60 * 1000,
            derivedStartupCooldownMs: parseInt(process.env.KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS, 10) || 5 * 60 * 1000,
            // 🌟 索引空闲自动卸载：默认 2 小时未使用则从内存中卸载
            indexIdleTTL: parseInt(process.env.KNOWLEDGEBASE_INDEX_IDLE_TTL_MS, 10) || 2 * 60 * 60 * 1000,
            lightMemoIndexIdleTTL: Math.max(1, Math.min(0xffffffff,
                parseInt(process.env.KNOWLEDGEBASE_LIGHTMEMO_IDLE_TTL_MS, 10) || 10 * 60 * 1000)),
            indexIdleSweepInterval: parseInt(process.env.KNOWLEDGEBASE_INDEX_IDLE_SWEEP_MS, 10) || 10 * 60 * 1000,
            ignoreFolders: (process.env.IGNORE_FOLDERS ?? 'VCP论坛').split(/[,，]/).map(f => f.trim()).filter(Boolean),
            ignorePrefixes: (process.env.IGNORE_PREFIXES ?? process.env.IGNORE_PREFIX ?? '已整理').split(/[,，]/).map(p => p.trim()).filter(Boolean),
            ignoreSuffixes: (process.env.IGNORE_SUFFIXES ?? process.env.IGNORE_SUFFIX ?? '夜伽').split(/[,，]/).map(s => s.trim()).filter(Boolean),

            tagBlacklist: new Set((process.env.TAG_BLACKLIST || '').split(',').map(t => t.trim()).filter(Boolean)),
            tagBlacklistSuper: (process.env.TAG_BLACKLIST_SUPER || '').split(',').map(t => t.trim()).filter(Boolean),
            maxTagsPerFile: (() => {
                const value = parseInt(process.env.KNOWLEDGEBASE_MAX_TAGS_PER_FILE, 10);
                return Number.isFinite(value) && value > 0 ? value : 50;
            })(),
            fullScanOnStartup: (process.env.KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP || 'true').trim().toLowerCase() === 'true',
            // 语言置信度补偿配置
            langConfidenceEnabled: (process.env.LANG_CONFIDENCE_GATING_ENABLED || 'true').toLowerCase() === 'true',
            // Undefined means inherit hot parameters; explicit zero is valid.
            langPenaltyUnknown: this._readOptionalPenalty(process.env.LANG_PENALTY_UNKNOWN),
            langPenaltyCrossDomain: this._readOptionalPenalty(process.env.LANG_PENALTY_CROSS_DOMAIN),
            // Native River 联合查询是 RiverMemo 的默认生产范式。Memo observation
            // 仍由统一管线生成，ANN/合并/向量 hydrate/语义去重/Topology V3
            // 收敛为一次 NativeKnowledgeRuntime 调用。仅显式 false 时紧急关闭。
            nativeRiverQueryEnabled:
                (process.env.KNOWLEDGEBASE_NATIVE_RIVER_QUERY_ENABLED || 'true')
                    .toLowerCase() !== 'false',
            nativeRiverQueryFallbackToLegacy:
                (process.env.KNOWLEDGEBASE_NATIVE_RIVER_QUERY_FALLBACK_TO_LEGACY || 'true')
                    .toLowerCase() !== 'false',
            nativeRiverQueryPerIndexK: (() => {
                const value = Number(
                    process.env.KNOWLEDGEBASE_NATIVE_RIVER_QUERY_PER_INDEX_K
                );
                return Number.isFinite(value) && value > 0
                    ? Math.floor(value)
                    : 300;
            })(),
            nativeRiverQueryCandidateK: (() => {
                const value = Number(
                    process.env.KNOWLEDGEBASE_NATIVE_RIVER_QUERY_CANDIDATE_K
                );
                return Number.isFinite(value) && value > 0
                    ? Math.floor(value)
                    : 300;
            })(),
            nativeRiverQuerySemanticThreshold: (() => {
                const value = Number(
                    process.env.KNOWLEDGEBASE_NATIVE_RIVER_QUERY_SEMANTIC_THRESHOLD
                );
                return Number.isFinite(value)
                    ? Math.max(-1, Math.min(1, value))
                    : 0.92;
            })(),
            // Tag 快照只用于加速恢复，原向量始终以 SQLite 为准。
            // 历史 always/布尔值仅兼容解析，不能绕过累计差异阈值；
            // 只有显式 generational 授予无文件、无 SQL 签名时的首代创建许可。
            tagIndexPersistenceMode: (() => {
                const raw = String(
                    process.env.KNOWLEDGEBASE_PERSIST_TAG_INDEX
                    || 'generational'
                ).trim().toLowerCase();
                if (raw === 'always' || raw === 'true') return 'always';
                if (raw === 'generational' || raw === 'false') {
                    return 'generational';
                }
                console.warn(
                    `[KnowledgeBase] Invalid KNOWLEDGEBASE_PERSIST_TAG_INDEX="${raw}"; ` +
                    'falling back to recommended mode "generational".'
                );
                return 'generational';
            })(),
            tagIndexAllowInitial:
                String(process.env.KNOWLEDGEBASE_PERSIST_TAG_INDEX || '').trim().toLowerCase() === 'generational',
            chunkIndexAllowInitial:
                String(process.env.KNOWLEDGEBASE_PERSIST_CHUNK_INDEX || '').trim().toLowerCase() === 'generational',
            tagIndexBaselineDeltaRatio: (() => {
                const value = Number(
                    process.env.KNOWLEDGEBASE_TAG_INDEX_BASELINE_DELTA_RATIO
                );
                return Number.isFinite(value) && value > 0 && value <= 1
                    ? value
                    : 0.05;
            })(),
            // 兼容仍读取该字段的旧代码；两种枚举模式都表示启用 Tag 索引落地。
            // Agent/日记与全局 Chunk 快照共用发布策略：
            // 累计差异达到阈值才发布，显式 generational 才授权首代；
            // none/off 禁止发布。全局 Chunk 另须默认范围或 global_chunks 白名单。
            chunkIndexPersistenceMode: (() => {
                const raw = String(
                    process.env.KNOWLEDGEBASE_PERSIST_CHUNK_INDEX
                    || 'generational'
                ).trim().toLowerCase();
                if (raw === 'always' || raw === 'true') return 'always';
                if (raw === 'none' || raw === 'off') return 'none';
                if (raw === 'generational' || raw === 'false' || !raw) {
                    return 'generational';
                }
                console.warn(
                    `[KnowledgeBase] Invalid KNOWLEDGEBASE_PERSIST_CHUNK_INDEX="${raw}"; ` +
                    'falling back to recommended mode "generational".'
                );
                return 'generational';
            })(),
            chunkIndexBaselineDeltaRatio: (() => {
                const value = Number(
                    process.env.KNOWLEDGEBASE_CHUNK_INDEX_BASELINE_DELTA_RATIO
                );
                return Number.isFinite(value) && value > 0 && value <= 1
                    ? value
                    : 0.05;
            })(),
            persistTagIndex: true,
            // 🌟 是否默认持久化索引（建议 false，仅在内存重建以保证原子性）
            persistDefault: (process.env.KNOWLEDGEBASE_PERSIST_DEFAULT || 'false').toLowerCase() === 'true',
            // 🌟 强制开启持久化的文件夹白名单 (支持中英文逗号)
            persistFolders: new Set((process.env.KNOWLEDGEBASE_PERSIST_FOLDERS || '').split(/[,，]/).map(f => f.trim()).filter(Boolean)),
            ...config
        };

        this.dbPath = null;
        this.databaseCorruptionDetected = false;
        this.dbHealthState = 'healthy'; // healthy | suspect | recovering | corrupt
        this._recoveringDatabaseConnection = false;
        this.startupCompletedAt = 0;
        this.diaryIndices = new Map();
        this.diaryIndexLastUsed = new Map(); // 🌟 记录每个索引的最后使用时间
        this.idleSweepTimer = null;
        this.tagIndex = null;
        this.nativeKnowledgeRuntime = null;
        this.nativeDiaryIndexGenerations = new Map();
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
        this.ragParamsWatcherPoller = null;
        this.ragParamsWatcherType = null;

        this.lastActivityAt = Date.now();

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

        // 中央库健康状态由 NativeKnowledgeRuntime 管理。摄取链路只依赖
        // 下方稳定的错误分类门面，不再通过 JS 健康管理器重绑数据库连接。
        this.diaryMetadataCache = new DiaryMetadataCache({
            getNativeRuntime: () => this.nativeKnowledgeRuntime,
            getDbPath: () => this.dbPath,
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
            getNativeRuntime: () => this.nativeKnowledgeRuntime,
            waitForCoordinatorIdle: options => this._waitForDatabaseCoordinatorIdle(options),
            ensureDiaryDateIndex: diaryName => this._ensureDiaryDateIndexCached(diaryName),
            invalidateDiaryDateIndex: diaryName => this.invalidateDiaryDateIndex(diaryName),
            onDiaryIndexPublished: (diaryName, index) =>
                this._registerNativeDiaryIndex(diaryName, index),
            onDiaryIndexRemoved: diaryName =>
                this._unregisterNativeDiaryIndex(diaryName),
            onRecoveryStateChange: active => {
                this.indexRecoveryActive = active;
                if (active) {
                    this.touchActivity();
                }
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

    _readOptionalPenalty(raw) {
        if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
        const value = Number(raw);
        return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
    }

    async initialize() {
        if (this.initialized) return;
        this._captureMemoryStage('initialize:begin');
        console.log(`[KnowledgeBase] Initializing Multi-Index System (Dim: ${this.config.dimension})...`);

        await fs.mkdir(this.config.storePath, { recursive: true });

        const dbPath = path.join(this.config.storePath, 'knowledge_base.sqlite');
        this.dbPath = dbPath;

        console.log(
            '[KnowledgeBaseProbe] Central SQLite ownership is delegated to ' +
            'NativeKnowledgeRuntime; JavaScript does not open or initialize the database.'
        );

        // 1. 先创建空的全局 Tag 索引作为 MemoRuntime 所有权根。
        // 基线恢复必须在 Rust Store 和启动清理之后执行，避免把已删除事实
        // 发布到活动索引；此处的空索引只用于构造 NativeKnowledgeRuntime。
        const tagCapacity = 50000;
        this.tagIndex = new VexusIndex(
            this.config.dimension,
            tagCapacity
        );
        this.indexRepository.tagIndex = this.tagIndex;

        // 2. 先打开 Rust Store，再执行所有启动期中央库清理。
        if (!NativeKnowledgeRuntime) {
            throw new Error(
                '[KnowledgeBase] NativeKnowledgeRuntime ABI unavailable; ' +
                'rebuild rust-vexus-lite before starting KBM.'
            );
        }

        try {
            this.nativeKnowledgeRuntime = new NativeKnowledgeRuntime(
                this.tagIndex
            );
            if (typeof this.nativeKnowledgeRuntime.capabilities !== 'function') {
                const error = new Error(
                    'NativeKnowledgeRuntime capability handshake is unavailable; ' +
                    'rebuild rust-vexus-lite before starting KBM.'
                );
                error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
                throw error;
            }
            const capabilities = this.nativeKnowledgeRuntime.capabilities();
            const requiredCapabilities = [
                'sqlite.storage-engine.v1',
                'sqlite.write-actor.v1',
                'sqlite.read-pool.v1',
                'sqlite.schema-init.v1',
                'sqlite.ingestion-commit.v1',
                'sqlite.delete-commit.v1',
                'sqlite.tag-consistency.v1',
                'text.preparation.v1',
                'index.async-restore.v1',
                'index.dual-slot-checkpoint.v1',
                'index.tdb-vec.v1',
                'index.sql-authoritative-generational.v1',
                'index.cosine-score.v1',
                'watcher.runtime-owned.v1',
                'memo.native-artifact.v1',
                'river.native-query.v1'
            ];
            const missingCapabilities = requiredCapabilities.filter(
                capability => !Array.isArray(capabilities?.capabilities)
                    || !capabilities.capabilities.includes(capability)
            );
            if (
                Number(capabilities?.abiVersion) !== 2
                || Number(capabilities?.dimension) !== this.config.dimension
                || missingCapabilities.length > 0
            ) {
                const error = new Error(
                    'NativeKnowledgeRuntime capability handshake failed: '
                    + JSON.stringify({
                        expectedAbiVersion: 2,
                        actualAbiVersion: capabilities?.abiVersion ?? null,
                        expectedDimension: this.config.dimension,
                        actualDimension: capabilities?.dimension ?? null,
                        missingCapabilities
                    })
                );
                error.code = 'NATIVE_STORAGE_ABI_MISMATCH';
                throw error;
            }
            if (
                typeof this.nativeKnowledgeRuntime.openAndInitStore !== 'function'
                || typeof this.nativeKnowledgeRuntime.storeState !== 'function'
                || typeof this.nativeKnowledgeRuntime.healthCheck !== 'function'
                || typeof this.nativeKnowledgeRuntime.cleanupDatabaseOrphans !== 'function'
                || typeof this.nativeKnowledgeRuntime.getKvVector !== 'function'
                || typeof this.nativeKnowledgeRuntime.setKvVector !== 'function'
                || typeof this.nativeKnowledgeRuntime.listKvVectors !== 'function'
                || typeof this.nativeKnowledgeRuntime.getDiaryChunkCount !== 'function'
                || typeof this.nativeKnowledgeRuntime.prepareText !== 'function'
                || typeof this.nativeKnowledgeRuntime.getTagVectorByName !== 'function'
                || typeof this.nativeKnowledgeRuntime.getTagConsistencySnapshot !== 'function'
                || typeof this.nativeKnowledgeRuntime.commitTagConsistency !== 'function'
                || typeof this.nativeKnowledgeRuntime.getNativeMemoManifest !== 'function'
                || typeof this.nativeKnowledgeRuntime.pruneNativeMemoArtifacts !== 'function'
                || typeof this.nativeKnowledgeRuntime.searchGlobalTags !== 'function'
                || typeof this.nativeKnowledgeRuntime.cancelPreparedPlan !== 'function'
                || typeof this.nativeKnowledgeRuntime.listIndexedFilePaths !== 'function'
                || typeof this.nativeKnowledgeRuntime.reconcileWatchWithPaths !== 'function'
                || typeof this.nativeKnowledgeRuntime.restoreGlobalTagIndex !== 'function'
                || typeof this.nativeKnowledgeRuntime.restoreDiaryIndex !== 'function'
                || typeof this.nativeKnowledgeRuntime.checkpointGlobalTagIndex !== 'function'
                || typeof this.nativeKnowledgeRuntime.checkpointDiaryIndex !== 'function'
                || typeof this.nativeKnowledgeRuntime.checkpointGlobalChunkIndex !== 'function'
            ) {
                throw new Error(
                    'NativeKnowledgeRuntime storage ABI unavailable; rebuild rust-vexus-lite'
                );
            }
            const storeState = this.nativeKnowledgeRuntime.openAndInitStore(
                dbPath,
                JSON.stringify({
                 readPoolSize: Number(
                     process.env.KNOWLEDGEBASE_RUST_READ_POOL_SIZE
                 ) || 4,
                 mmapSize: (() => {
                     const raw = process.env.KNOWLEDGEBASE_RUST_MMAP_SIZE;
                     const value = Number(raw);
                     return raw !== undefined && raw.trim() !== ''
                         && Number.isSafeInteger(value) && value >= 0
                         ? value
                         : 64 * 1024 * 1024;
                 })(),
                 busyTimeoutMs: this.config.sqliteBusyTimeoutMs,
                 schemaVersion: 2
             })
            );
            console.log(
                '[KnowledgeBase] 🦀 NativeKnowledgeRuntime ready; ' +
                `Rust Store opened at generation=${storeState.databaseGeneration}.`
            );
        } catch (error) {
            try {
                this.nativeKnowledgeRuntime?.shutdown?.();
            } catch (_) {}
            this.nativeKnowledgeRuntime = null;
            throw new Error(
                '[KnowledgeBase] NativeKnowledgeRuntime storage initialization failed: '
                + (error.message || error)
            );
        }

        this._captureMemoryStage('store:opened');
        const tOrphan0 = Date.now();
        await this._cleanupDatabaseOrphansNative();
        console.log(
            `[KnowledgeBaseProbe] ⏱️ Rust orphan cleanup complete in ` +
            `${Date.now() - tOrphan0}ms.`
        );

        this._captureMemoryStage('store:orphans-cleaned');
        // 3. 初始化全局 Tag 索引。
        // tags 是唯一权威真相；磁盘 .vec 只是经 SQL 背书、允许落后的双槽基线。
        // 活动槽加载、成员差分回放和无基线重建全部由 Rust Runtime 后台执行。
        let indexReady = false;
        console.log(
            '[KnowledgeBase] 🚀 Restoring Global Tag Index through NativeKnowledgeRuntime...'
        );
        try {
            const restored = await this.nativeKnowledgeRuntime.restoreGlobalTagIndex(
                dbPath,
                path.join(this.config.storePath, 'index_global_tags_a.vec'),
                this.config.modelSig,
                tagCapacity
            );
            const parsed = typeof restored === 'string'
                ? JSON.parse(restored)
                : restored;
            if (!parsed || parsed.restored !== true) {
                throw new Error('Invalid Rust global Tag restore receipt');
            }
            console.log(
                `[KnowledgeBase] ✅ Global Tag Index ready. ` +
                `${Number(parsed.vectorCount) || 0} vectors indexed, ` +
                `generation=${Number(parsed.generation) || 0}, ` +
                `slot=${parsed.slot || 'none'}.`
            );
            indexReady = true;
        } catch (e) {
            console.error(
                `[KnowledgeBase] ❌ Global Tag Index recovery failed: ` +
                e.message
            );
        }

        if (!indexReady) {
            throw new Error(
                '[KnowledgeBase] Global Tag Index recovery failed after startup cleanup.'
            );
        }

        this._captureMemoryStage('tags:restored');
        // 3. 通过 Rust Read Pool 异步预热日记本名称向量缓存。
        // 启动阶段不再在 Node.js 主线程直接扫描中央 kv_store。
        await this._hydrateDiaryNameCache();

        // 🧹 初始化 KBM 通用结果去重器。
        // 向量补水统一通过 NativeKnowledgeRuntime，生产路径不持有中央数据库连接。
        this.resultDeduplicator = new ResultDeduplicator({
            dimension: this.config.dimension,
            hydrateChunksByIds: chunkIds => this.hydrateChunksByIds(chunkIds)
        });

        await this.loadRagParams();

        // 初始化生产 V9.2 控制面；中央数据库所有权归 Rust Runtime。
        this.tagMemoEngine = new TagMemoEngine(
            null,
            this.tagIndex,
            this.config,
            this.ragParams,
            this
        );
        await this.tagMemoEngine.initialize();
// V10/RiverMemo 仅保留轻量控制面；完整图、CSR 与 Provenance 归属
// VexusIndex.memoRuntime，不再从 V9 JavaScript Map 编译或读取中央 SQL。
this.tagMemoV10Engine = new TagMemoV10Engine(
    null,
    this.tagIndex,
    this.config,
    this.ragParams,
    {
        v9Engine: this.tagMemoEngine,
        getNativeRuntime: () => this.nativeKnowledgeRuntime
    }
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
            const restored = await this._restoreNativeMemoControlHandles();
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

        this._captureMemoryStage('memo:manifest-checked');
        this._startWatcher();
        this._startRagParamsWatcher();
        this._startIdleSweep(); // 🌟 启动空闲索引自动卸载
        this._startEventLoopWatchdog(); // 🛡️ 运行期无日志卡死定位：记录主线程长阻塞

        this.initialized = true;
        this.startupCompletedAt = Date.now();
        this._captureMemoryStage('initialize:ready');
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
            this.ragParams = require('./modules/knowledgeBase/memoConfig').cleanRagParams(parsed);
            console.log('[KnowledgeBase] ✅ RAG 热调控参数已加载');
            if (this.resultDeduplicator) {
                this.resultDeduplicator.updateConfig(
                    this.ragParams.KnowledgeBaseManager?.resultDeduplication || {}
                );
            }
            if (this.tagMemoEngine) this.tagMemoEngine.updateRagParams(this.ragParams);
            if (this.tagMemoV10Engine) this.tagMemoV10Engine.updateRagParams(this.ragParams);
            if (this.riverMemoEngine) {
                this.riverMemoEngine.updateConfig(
                    this.ragParams.KnowledgeBaseManager?.riverMemo || {}
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
     * 启动参数监听器。
     *
     * KBM 生产路径统一使用 Rust notify；这里单独创建一个原生 watcher
     * 监听项目根目录中的 JSON 事件，再精确筛选 rag_params.json。
     */
    _startRagParamsWatcher() {
        const paramsPath = path.resolve(__dirname, 'rag_params.json');
        if (this.ragParamsWatcher) return;

        const vexusModule = require('./rust-vexus-lite');
        if (typeof vexusModule.VexusWatcher !== 'function') {
            throw new Error(
                'VexusWatcher native class is unavailable; rebuild rust-vexus-lite'
            );
        }

        const watcher = new vexusModule.VexusWatcher();
        const startWatch = watcher.startWatch || watcher.start_watch;
        const drainEvents = watcher.drainEvents || watcher.drain_events;
        if (
            typeof startWatch !== 'function'
            || typeof drainEvents !== 'function'
        ) {
            throw new Error(
                'VexusWatcher queue ABI is unavailable; rebuild rust-vexus-lite'
            );
        }

        let refreshInFlight = false;
        let refreshQueued = false;
        const refresh = async () => {
            if (refreshInFlight) {
                refreshQueued = true;
                return;
            }
            refreshInFlight = true;
            try {
                console.log(
                    '[KnowledgeBase] 🔄 检测到 rag_params.json 变更，正在重新加载...'
                );
                await this.loadRagParams();
            } catch (error) {
                console.error(
                    '[KnowledgeBase] Failed to reload rag_params.json:',
                    error
                );
            } finally {
                refreshInFlight = false;
                if (refreshQueued) {
                    refreshQueued = false;
                    void refresh();
                }
            }
        };

        startWatch.call(watcher, {
            rootPath: __dirname,
            ignoreFolders: ['node_modules', '.git', 'dist', 'target', 'image'],
            ignorePrefixes: [],
            ignoreSuffixes: [],
            extensions: ['json'],
            debounceMs: parseInt(
                process.env.KNOWLEDGEBASE_RAG_PARAMS_WATCH_DEBOUNCE_MS,
                10
            ) || 350,
            stabilityMs: parseInt(
                process.env.KNOWLEDGEBASE_RAG_PARAMS_WATCH_STABILITY_MS,
                10
            ) || 150,
            stabilityRetries: parseInt(
                process.env.KNOWLEDGEBASE_RAG_PARAMS_WATCH_STABILITY_RETRIES,
                10
            ) || 6,
            initialScan: false
        });

        const poller = setInterval(() => {
            let events;
            try {
                events = drainEvents.call(watcher, 128) || [];
            } catch (error) {
                console.warn(
                    '[KnowledgeBase] Failed to drain rag_params watcher events:',
                    error.message || error
                );
                return;
            }

            for (const payload of events) {
                const eventPath = path.resolve(String(payload?.path || ''));
                if (
                    eventPath === paramsPath
                    && ['add', 'change'].includes(payload?.event)
                    && payload?.stable === true
                ) {
                    void refresh();
                }
            }
        }, 100);
        if (typeof poller.unref === 'function') poller.unref();

        this.ragParamsWatcher = watcher;
        this.ragParamsWatcherPoller = poller;
        this.ragParamsWatcherType = 'rust-queue';
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

    _computeNativeMemoConfigHash(effectiveConfig) {
        // 跨语言持久化契约必须使用规范 JSON。Rust 的 serde_json::Map 在当前
        // 构建中按键有序序列化；普通 JSON.stringify 依赖 JS 对象插入顺序，
        // 会让同一配置在重启恢复时产生不同 hash 并错误拒绝健康资产。
        return crypto.createHash('sha256')
            .update(stableSerialize(effectiveConfig))
            .digest('hex')
            .slice(0, 32);
    }

    async _restoreNativeMemoControlHandles() {
        if (!this.tagMemoEngine || !this.tagMemoV10Engine) return null;
        if (
            !this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.getNativeMemoManifest !== 'function'
        ) {
            const error = new Error(
                'NativeKnowledgeRuntime Memo manifest ABI is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }

        const effectiveConfig = this._buildNativeMemoEffectiveConfig();
        const configHash = this._computeNativeMemoConfigHash(effectiveConfig);
        const raw = await this.nativeKnowledgeRuntime.getNativeMemoManifest(
            this.dbPath,
            this.tagMemoEngine.modelSig,
            configHash
        );
        const row = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!row || typeof row !== 'object') return null;

        const nativeResult = {
            success: true,
            artifactSig: String(row.artifactSig || ''),
            sourceArtifactSig: String(row.sourceArtifactSig || ''),
            graphGeneration: String(row.sourceGraphGeneration || ''),
            sourceGraphGeneration: String(row.sourceGraphGeneration || ''),
            databaseGeneration: String(row.databaseGeneration || ''),
            provenanceGeneration: String(row.provenanceGeneration || ''),
            modelSig: String(row.modelSig || ''),
            configHash: String(row.configHash || ''),
            algorithmVersion: String(row.algorithmVersion || ''),
            generation: null,
            nodeCount: Math.max(0, Number(row.nodeCount) || 0),
            edgeCount: Math.max(0, Number(row.edgeCount) || 0),
            persisted: true,
            resident: false
        };
        if (
            !nativeResult.artifactSig
            || nativeResult.algorithmVersion !== 'memo.native-artifact-v2-binary'
            || nativeResult.modelSig !== this.tagMemoEngine.modelSig
            || nativeResult.configHash !== configHash
            || !/^(?:0|[1-9]\d*)$/.test(nativeResult.databaseGeneration)
        ) {
            return null;
        }

        const v9Handle = this.tagMemoEngine.publishNativeArtifactHandle(
            nativeResult,
            effectiveConfig
        );
        const artifact = this.tagMemoV10Engine.publishNativeArtifactHandle(
            nativeResult,
            {
                effectiveConfig,
                publishedAt: Math.max(0, Number(row.publishedAt) || Date.now())
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
    async onNativeMemoArtifactPublished(nativeResult, v9Handle = null) {
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

        try {
            if (
                !this.nativeKnowledgeRuntime
                || typeof this.nativeKnowledgeRuntime.pruneNativeMemoArtifacts
                    !== 'function'
            ) {
                throw new Error(
                    'NativeKnowledgeRuntime Memo artifact prune ABI is unavailable'
                );
            }
            const rawPruneResult =
                await this.nativeKnowledgeRuntime.pruneNativeMemoArtifacts(
                    this.dbPath,
                    2,
                    7 * 24 * 60 * 60 * 1000
                );
            const pruneResult = typeof rawPruneResult === 'string'
                ? JSON.parse(rawPruneResult)
                : rawPruneResult;
            if (
                pruneResult
                && (
                    Number(pruneResult.retired) > 0
                    || Number(pruneResult.deleted) > 0
                )
            ) {
                console.log(
                    `[KnowledgeBase] 🧹 Native Memo lifecycle prune complete: ` +
                    `retired=${Number(pruneResult.retired) || 0}, ` +
                    `deleted=${Number(pruneResult.deleted) || 0}.`
                );
            }
        } catch (pruneError) {
            console.warn(
                '[KnowledgeBase] ⚠️ Native Memo artifact prune warning:',
                pruneError.message || pruneError
            );
        }
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


    _isSqliteCorruptionError(error) {
        const code = String(error?.code || '').toUpperCase();
        const message = String(error?.message || error || '');
        return code === 'SQLITE_CORRUPT'
            || code === 'SQLITE_NOTADB'
            || code === 'KNOWLEDGE_STORE_CORRUPT'
            || /database disk image is malformed|file is not a database|database corruption|SQLite quick_check returned|KNOWLEDGE_STORE_CORRUPT/i
                .test(message);
    }

    _isSqliteBusyError(error) {
        const code = String(error?.code || '').toUpperCase();
        const message = String(error?.message || error || '');
        return code === 'SQLITE_BUSY'
            || code.startsWith('SQLITE_BUSY_')
            || code === 'SQLITE_LOCKED'
            || code.startsWith('SQLITE_LOCKED_')
            || code === 'KNOWLEDGE_STORE_BUSY'
            || /database (?:is )?locked|database table is locked|KNOWLEDGE_STORE_BUSY/i
                .test(message);
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
    touchActivity() {
        this.lastActivityAt = Date.now();
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
                    `loadedIndices=${this.diaryIndices.size}, saveTimers=${this.saveTimers.size}, ` +
                    `dbHealth=${this.dbHealthState}`
                );
            }
        }, intervalMs);

        if (this.eventLoopWatchdogTimer.unref) this.eventLoopWatchdogTimer.unref();
        console.log(`[KnowledgeBase] 🧯 Event loop watchdog started (interval=${intervalMs}ms, warnLag=${warnLagMs}ms).`);
    }

    _decodeVectorBlob(blob, dim, label = 'vector') {
        return decodeVectorBlob(blob, dim, label);
    }

    _isVectorLike(value) {
        return Array.isArray(value) ||
            value instanceof Float32Array ||
            (ArrayBuffer.isView(value) && typeof value.length === 'number');
    }

    /**
     * 通过 NativeKnowledgeRuntime 执行启动期事实清理。
     *
     * 文件扫描与 SQL 删除都在 Rust 数据面完成；Node.js 只处理轻量回执
     * 和持久化索引失效通知，不再直接访问中央库。
     */
    async _cleanupDatabaseOrphansNative() {
        if (
            !this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.cleanupDatabaseOrphans !== 'function'
        ) {
            const error = new Error(
                'NativeKnowledgeRuntime orphan cleanup API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }

        const raw = await this.nativeKnowledgeRuntime.cleanupDatabaseOrphans(
            this.dbPath,
            this.config.rootPath
        );
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const affectedDiaries = Array.isArray(result?.affectedDiaries)
            ? [...new Set(
                result.affectedDiaries
                    .map(value => String(value || '').trim())
                    .filter(Boolean)
            )]
            : [];

        // SQL cleanup invalidates affected runtime scopes atomically. Preserve
        // endorsed disk baselines; restore replays authoritative deletions in memory.
        for (const diaryName of affectedDiaries) {
            this.diaryDateIndexCache.delete(diaryName);
        }

        const missingFiles = Math.max(
            0,
            Math.floor(Number(result?.missingFiles) || 0)
        );
        const orphanChunks = Math.max(
            0,
            Math.floor(Number(result?.orphanChunks) || 0)
        );
        const orphanFileTags = Math.max(
            0,
            Math.floor(Number(result?.orphanFileTags) || 0)
        );

        if (
            missingFiles > 0
            || orphanChunks > 0
            || orphanFileTags > 0
            || affectedDiaries.length > 0
        ) {
            console.warn(
                `[KnowledgeBase] 🧹 Rust startup cleanup complete. ` +
                `Removed ${missingFiles} missing file record(s), ` +
                `${orphanChunks} orphan chunk(s), ` +
                `${orphanFileTags} orphan file-tag relation(s), ` +
                `touched ${affectedDiaries.length} diary index(es).`
            );
        }

        return {
            missingFiles,
            orphanChunks,
            orphanFileTags,
            affectedDiaries
        };
    }

    _deletePersistedDiaryIndex(diaryName) {
        return this.indexRepository.deletePersisted(diaryName);
    }

    _deleteAllPersistedDiaryIndexes() {
        return this.indexRepository.deleteAllPersisted();
    }

    _registerNativeDiaryIndex(diaryName, index) {
        if (!this.nativeKnowledgeRuntime) return null;
        const state = this.nativeKnowledgeRuntime.registerDiaryIndex(
            String(diaryName),
            index
        );
        this.nativeDiaryIndexGenerations.set(
            String(diaryName),
            Number(state.generation)
        );
        return state;
    }

    _unregisterNativeDiaryIndex(diaryName) {
        const normalized = String(diaryName || '').trim();
        const generation = this.nativeDiaryIndexGenerations.get(normalized);
        if (
            !this.nativeKnowledgeRuntime
            || !Number.isSafeInteger(generation)
            || generation <= 0
        ) {
            this.nativeDiaryIndexGenerations.delete(normalized);
            return false;
        }
        const removed = this.nativeKnowledgeRuntime.unregisterDiaryIndex(
            normalized,
            generation
        );
        if (removed) this.nativeDiaryIndexGenerations.delete(normalized);
        return removed;
    }

    async prepareIngestionText(text) {
        if (
            !this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.prepareText !== 'function'
        ) {
            const error = new Error(
                'NativeKnowledgeRuntime text preparation API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }

        const embeddingMaxToken = Math.max(
            1,
            Math.floor(Number(process.env.WhitelistEmbeddingModelMaxToken) || 8000)
        );
        const maxTokens = Math.max(
            1,
            Math.floor(embeddingMaxToken * 0.85)
        );
        const overlapTokens = Math.min(
            Math.max(0, Math.floor(maxTokens * 0.1)),
            Math.max(0, maxTokens - 1)
        );
        const raw = await this.nativeKnowledgeRuntime.prepareText(
            JSON.stringify({
                text: typeof text === 'string' ? text : '',
                tagBlacklistSuper: Array.isArray(this.config.tagBlacklistSuper)
                    ? this.config.tagBlacklistSuper
                    : [],
                tagBlacklist: this.config.tagBlacklist instanceof Set
                    ? [...this.config.tagBlacklist]
                    : [],
                maxTags: this.config.maxTagsPerFile,
                maxTokens,
                overlapTokens
            })
        );
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!result || typeof result !== 'object') {
            throw new Error('Native text preparation returned an invalid result');
        }
        return {
            preparedText: String(result.preparedText || ''),
            tags: Array.isArray(result.tags)
                ? result.tags.map(String).filter(Boolean)
                : [],
            chunks: Array.isArray(result.chunks)
                ? result.chunks.map(String).filter(Boolean)
                : [],
            tokenCount: Math.max(0, Math.floor(Number(result.tokenCount) || 0)),
            rulesVersion: String(result.rulesVersion || '')
        };
    }

    async probeIngestionFiles(filePaths) {
        if (!this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.probeIngestionFiles !== 'function') {
            const error = new Error(
                'NativeKnowledgeRuntime ingestion probe API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }

        const paths = [...new Set(
            (Array.isArray(filePaths) ? filePaths : [filePaths])
                .map(filePath => String(filePath || '').trim())
                .filter(Boolean)
        )];
        if (paths.length === 0) return [];

        const raw = await this.nativeKnowledgeRuntime.probeIngestionFiles(
            this.dbPath,
            paths
        );
        const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return (Array.isArray(rows) ? rows : []).map(row => ({
            path: String(row?.path || ''),
            exists: row?.exists === true,
            checksum: typeof row?.checksum === 'string'
                ? row.checksum
                : null,
            mtime: Number.isFinite(Number(row?.mtime))
                ? Number(row.mtime)
                : null,
            size: Number.isFinite(Number(row?.size))
                ? Number(row.size)
                : null,
            version: Number.isSafeInteger(Number(row?.version))
                && Number(row.version) >= 0
                ? Number(row.version)
                : 0,
            chunkCount: Math.max(0, Math.floor(Number(row?.chunkCount) || 0)),
            validVectorCount: Math.max(
                0,
                Math.floor(Number(row?.validVectorCount) || 0)
            ),
            completeVectors: row?.completeVectors === true,
            tagCount: Math.max(0, Math.floor(Number(row?.tagCount) || 0)),
            validTagVectorCount: Math.max(
                0,
                Math.floor(Number(row?.validTagVectorCount) || 0)
            ),
            completeTags: row?.completeTags === true
        })).filter(row => row.path);
    }

    async probeIngestionTags(tagNames) {
        if (!this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.probeIngestionTags !== 'function') {
            const error = new Error(
                'NativeKnowledgeRuntime Tag probe API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }

        const names = [...new Set(
            (Array.isArray(tagNames) ? tagNames : [tagNames])
                .map(name => String(name || '').trim())
                .filter(Boolean)
        )];
        if (names.length === 0) return [];

        const raw = await this.nativeKnowledgeRuntime.probeIngestionTags(
            this.dbPath,
            names
        );
        const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return (Array.isArray(rows) ? rows : [])
            .map(row => ({
                name: String(row?.name || ''),
                id: Number.isSafeInteger(Number(row?.id))
                    ? Number(row.id)
                    : null,
                hasVector: row?.hasVector === true
            }))
            .filter(row => row.name);
    }

    async probeMigrationReuse(requests) {
        if (!this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.probeMigrationReuse !== 'function') {
            const error = new Error(
                'NativeKnowledgeRuntime migration reuse API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }

        const normalized = (Array.isArray(requests) ? requests : [])
            .map(request => ({
                path: String(request?.path || '').trim(),
                checksum: String(request?.checksum || '').trim(),
                size: Math.floor(Number(request?.size) || 0),
                chunkCount: Math.floor(Number(request?.chunkCount) || 0)
            }))
            .filter(request =>
                request.path
                && request.checksum
                && request.size >= 0
                && request.chunkCount > 0
            );

        if (normalized.length === 0) return [];

        const raw = await this.nativeKnowledgeRuntime.probeMigrationReuse(
            this.dbPath,
            JSON.stringify(normalized)
        );
        const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return (Array.isArray(rows) ? rows : [])
            .map(row => ({
                path: String(row?.path || ''),
                liveFileId: Number.isSafeInteger(Number(row?.liveFileId))
                    ? Number(row.liveFileId)
                    : null,
                migrationCacheId: Number.isSafeInteger(Number(row?.migrationCacheId))
                    ? Number(row.migrationCacheId)
                    : null
            }))
            .filter(row => row.path && (row.liveFileId > 0 || row.migrationCacheId > 0));
    }

    async commitDeleteBatch(filePaths, ttlMs = this.config.migrationCacheTtlMs) {
        if (!this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.commitDeleteBatch !== 'function') {
            const error = new Error(
                'NativeKnowledgeRuntime delete commit API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }

        const paths = [...new Set(
            (Array.isArray(filePaths) ? filePaths : [filePaths])
                .map(filePath => String(filePath || '').trim())
                .filter(Boolean)
        )];
        if (paths.length === 0) return {
            affectedFiles: [],
            removedChunkIds: [],
            diaryIndexDeltas: {},
            databaseGeneration: 0,
            factsCommitted: true,
            indexReady: true
        };

        const raw = await this.nativeKnowledgeRuntime.commitDeleteBatch(
            this.dbPath,
            paths,
            Math.max(0, Math.floor(Number(ttlMs) || 0)),
            path.resolve(this.config.rootPath)
        );
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!result || result.factsCommitted !== true) {
            throw new Error('Native delete commit returned an invalid receipt');
        }
        const diaryIndexDeltas = result.diaryIndexDeltas
            && typeof result.diaryIndexDeltas === 'object'
            ? Object.fromEntries(
                Object.entries(result.diaryIndexDeltas).map(([diaryName, delta]) => [
                    String(diaryName),
                    {
                        removedChunkIds: Array.isArray(delta?.removedChunkIds)
                            ? delta.removedChunkIds.map(Number).filter(Number.isSafeInteger)
                            : [],
                        upsertedChunkIds: []
                    }
                ])
            )
            : {};
        return {
            ...result,
            affectedFiles: Array.isArray(result.affectedFiles)
                ? result.affectedFiles.map(Number).filter(Number.isSafeInteger)
                : [],
            removedChunkIds: Array.isArray(result.removedChunkIds)
                ? result.removedChunkIds.map(Number).filter(Number.isSafeInteger)
                : [],
            diaryIndexDeltas
        };
    }

    async commitIngestionBatch(plan, chunkVectors = [], tagVectors = []) {
        if (!this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.commitIngestionBatch !== 'function') {
            const error = new Error(
                'NativeKnowledgeRuntime ingestion commit API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }
        if (!plan || typeof plan !== 'object') {
            throw new TypeError('commitIngestionBatch requires a plan object');
        }
        const dimension = Number(plan.dimension) || this.config.dimension;
        const normalizeVectors = (vectors, label) => {
            const value = vectors instanceof Float32Array
                ? vectors
                : new Float32Array(vectors || []);
            if (value.length % dimension !== 0) {
                throw new RangeError(
                    `${label} length must be divisible by dimension ${dimension}`
                );
            }
            for (const item of value) {
                if (!Number.isFinite(item)) {
                    throw new TypeError(`${label} contains a non-finite value`);
                }
            }
            return value;
        };
        const normalizedPlan = {
            ...plan,
            dimension,
            operationId: String(plan.operationId || '').trim(),
            batchId: String(plan.batchId || '').trim(),
            modelSig: String(plan.modelSig || this.config.modelSig).trim()
        };
        if (!normalizedPlan.operationId || !normalizedPlan.batchId) {
            throw new TypeError('commitIngestionBatch requires operationId and batchId');
        }
        const chunkPayload = normalizeVectors(chunkVectors, 'chunkVectors');
        const tagPayload = normalizeVectors(tagVectors, 'tagVectors');
        const raw = await this.nativeKnowledgeRuntime.commitIngestionBatch(
            this.dbPath,
            JSON.stringify(normalizedPlan),
            chunkPayload,
            tagPayload
        );
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!result || result.factsCommitted !== true) {
            throw new Error('Native ingestion commit returned an invalid receipt');
        }
        return {
            ...result,
            databaseGeneration: Number(result.databaseGeneration) || 0,
            affectedFiles: Array.isArray(result.affectedFiles)
                ? result.affectedFiles.map(Number).filter(Number.isSafeInteger)
                : [],
            removedChunkIds: Array.isArray(result.removedChunkIds)
                ? result.removedChunkIds.map(Number).filter(Number.isSafeInteger)
                : [],
            upsertedChunkIds: Array.isArray(result.upsertedChunkIds)
                ? result.upsertedChunkIds.map(Number).filter(Number.isSafeInteger)
                : [],
            upsertedChunks: Array.isArray(result.upsertedChunks)
                ? result.upsertedChunks
                    .map(entry => ({
                        chunkId: Number(entry?.chunkId),
                        diaryName: String(entry?.diaryName || ''),
                        vectorSlot: Number.isSafeInteger(Number(entry?.vectorSlot))
                            ? Number(entry.vectorSlot)
                            : null
                    }))
                    .filter(entry =>
                        Number.isSafeInteger(entry.chunkId)
                        && entry.chunkId > 0
                        && entry.diaryName
                    )
                : [],
            affectedDiaries: Array.isArray(result.affectedDiaries)
                ? result.affectedDiaries.map(String).filter(Boolean)
                : [],
            diaryIndexDeltas: result.diaryIndexDeltas
                && typeof result.diaryIndexDeltas === 'object'
                ? Object.fromEntries(
                    Object.entries(result.diaryIndexDeltas).map(([diaryName, delta]) => [
                        String(diaryName),
                        {
                            removedChunkIds: Array.isArray(delta?.removedChunkIds)
                                ? delta.removedChunkIds
                                    .map(Number)
                                    .filter(Number.isSafeInteger)
                                : [],
                            upsertedChunkIds: Array.isArray(delta?.upsertedChunkIds)
                                ? delta.upsertedChunkIds
                                    .map(Number)
                                    .filter(Number.isSafeInteger)
                                : []
                        }
                    ])
                )
                : {},
            newTagIds: Array.isArray(result.newTagIds)
                ? result.newTagIds.map(Number).filter(Number.isSafeInteger)
                : []
        };
    }

    async getFileIdsByDiaries(diaryNames) {
        if (!this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.getFileIdsByDiaries !== 'function') {
            const error = new Error(
                'NativeKnowledgeRuntime file scope API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }
        const names = [...new Set(
            (Array.isArray(diaryNames) ? diaryNames : [diaryNames])
                .map(name => String(name || '').trim())
                .filter(Boolean)
        )];
        if (names.length === 0) return [];
        const raw = await this.nativeKnowledgeRuntime.getFileIdsByDiaries(
            this.dbPath,
            names
        );
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return (Array.isArray(result) ? result : [])
            .map(id => Number(id))
            .filter(id => Number.isSafeInteger(id) && id > 0);
    }

    async hydrateTagNamesByIds(tagIds) {
        if (!this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.hydrateTagNamesByIds !== 'function') {
            const error = new Error(
                'NativeKnowledgeRuntime Tag name hydrate API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }
        const ids = [...new Set(
            (Array.isArray(tagIds) ? tagIds : [tagIds])
                .map(id => Number(id))
                .filter(id => Number.isSafeInteger(id) && id > 0)
        )];
        if (ids.length === 0) return [];

        const raw = await this.nativeKnowledgeRuntime.hydrateTagNamesByIds(
            this.dbPath,
            ids
        );
        const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return (Array.isArray(rows) ? rows : [])
            .map(row => ({
                id: Number(row?.id),
                name: typeof row?.name === 'string' ? row.name : ''
            }))
            .filter(row => Number.isSafeInteger(row.id) && row.id > 0 && row.name);
    }

    async hydrateChunksByIds(chunkIds) {
        if (!this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.hydrateChunksByIds !== 'function') {
            const error = new Error(
                'NativeKnowledgeRuntime chunk hydrate API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }
        const ids = [...new Set(
            (Array.isArray(chunkIds) ? chunkIds : [chunkIds])
                .map(id => Number(id))
                .filter(id => Number.isSafeInteger(id) && id > 0)
        )];
        if (ids.length === 0) return [];

        const raw = await this.nativeKnowledgeRuntime.hydrateChunksByIds(
            this.dbPath,
            ids
        );
        const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return (Array.isArray(rows) ? rows : []).map(row => {
            let vector = null;
            if (typeof row?.vector === 'string' && row.vector) {
                const bytes = Buffer.from(row.vector, 'base64');
                if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT === 0) {
                    const view = new Float32Array(
                        bytes.buffer,
                        bytes.byteOffset,
                        bytes.byteLength / Float32Array.BYTES_PER_ELEMENT
                    );
                    if (view.length === this.config.dimension) {
                        vector = new Float32Array(view);
                    }
                }
            }
            return {
                ...row,
                id: Number(row?.id),
                chunkId: Number(row?.id),
                vector
            };
        }).filter(row => Number.isSafeInteger(row.id) && row.id > 0);
    }

    async hydrateChunksByFilePaths(filePaths) {
        if (!this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.hydrateChunksByFilePaths !== 'function') {
            const error = new Error(
                'NativeKnowledgeRuntime path hydrate API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }
        const paths = [...new Set(
            (Array.isArray(filePaths) ? filePaths : [filePaths])
                .map(filePath => String(filePath || '').trim())
                .filter(Boolean)
        )];
        if (paths.length === 0) return [];

        const raw = await this.nativeKnowledgeRuntime.hydrateChunksByFilePaths(
            this.dbPath,
            paths
        );
        const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return (Array.isArray(rows) ? rows : []).map(row => {
            let vector = null;
            if (typeof row?.vector === 'string' && row.vector) {
                const bytes = Buffer.from(row.vector, 'base64');
                if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT === 0) {
                    const view = new Float32Array(
                        bytes.buffer,
                        bytes.byteOffset,
                        bytes.byteLength / Float32Array.BYTES_PER_ELEMENT
                    );
                    if (view.length === this.config.dimension) {
                        vector = new Float32Array(view);
                    }
                }
            }
            return {
                ...row,
                id: Number(row?.id),
                chunkId: Number(row?.id),
                vector
            };
        }).filter(row => Number.isSafeInteger(row.id) && row.id > 0);
    }

    async listDistinctDiaries() {
        if (!this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.listDistinctDiaries !== 'function') {
            const error = new Error(
                'NativeKnowledgeRuntime diary metadata API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }
        const raw = await this.nativeKnowledgeRuntime.listDistinctDiaries(
            this.dbPath
        );
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(result)
            ? result.map(name => String(name)).filter(Boolean)
            : [];
    }

    async getDiaryChunkCount(diaryName) {
        const normalized = String(diaryName || '').trim();
        if (!normalized) return 0;
        if (!this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.getDiaryChunkCount !== 'function') {
            const error = new Error(
                'NativeKnowledgeRuntime diary Chunk count API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }

        const raw = await this.nativeKnowledgeRuntime.getDiaryChunkCount(
            this.dbPath,
            normalized
        );
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Math.max(0, Math.floor(Number(result?.count) || 0));
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

    async executeLightMemoQuery(query, options = {}) {
        const runtime = this.nativeKnowledgeRuntime;
        if (typeof runtime?.executeLightMemoQuery !== 'function') {
            const error = new Error('LIGHTMEMO_NATIVE_QUERY_UNAVAILABLE: rebuild rust-vexus-lite');
            error.code = 'LIGHTMEMO_NATIVE_QUERY_UNAVAILABLE';
            throw error;
        }
        const vector = query.vector instanceof Float32Array
            ? query.vector : new Float32Array(query.vector || []);
        let prepared = null;
        if (options.engineMode === 'rivermemo' || options.abMode === true) {
            prepared = await this.prepareUnifiedMemoObservation(query, options);
        }
        try {
        const raw = await runtime.executeLightMemoQuery(JSON.stringify({
            ...options,
            modelSig: this.config.modelSig,
            artifactSig: prepared?.artifact?.artifactSig || '',
            riverInput: prepared ? {
                observationHandle: prepared.observationHandle,
                query: { text: String(query.text || '') },
                queryState: { queryId: prepared.observation?.queryId || null },
                config: this.riverMemoEngine._nativeConfig(prepared.artifact, options)
            } : null
        }), vector);
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (result?.schema !== 'vcp-lightmemo-result-v1' || !Array.isArray(result.results)) {
            throw new Error('LIGHTMEMO_INVALID_NATIVE_RESULT');
        }
        const normalize = item => ({
            ...item,
            label: Number(item.label ?? item.chunkId ?? item.id),
            sourceFile: item.sourceFile && !path.isAbsolute(item.sourceFile)
                ? path.join(this.config.rootPath, item.sourceFile) : item.sourceFile
        });
        result.results = result.results.map(normalize);
        result.tdbTopK = (result.tdbTopK || []).map(normalize);
        result.comparisonPool = (result.comparisonPool || []).map(normalize);
        if (Array.isArray(result.river?.results)) result.river.results = result.river.results.map(normalize);
        return result;
        } finally {
            if (prepared) this.releaseMemoObservation(prepared);
        }
    }

    async search(...args) {
        return await this.searchService.search(...args);
    }

    async searchMany(...args) {
        return this.searchService.searchMany(...args);
    }

    async searchKnn(...args) {
        return this.searchService.searchKnn(...args);
    }

    async searchKnnMany(...args) {
        return this.searchService.searchKnnMany(...args);
    }

    /**
     * 公共接口：应用请求级固定的 V9.1 TagMemo 增强向量。
     * options.tagMemoVersion 仅接受 "v9"；显式旧版本会返回 TAGMEMO_VERSION_RETIRED。
     */
    /**
     * TagMemo 原生异步增强兼容门面。
     *
     * 返回旧 applyTagBoost 的主要字段形状，同时附带 preparedMemoObservation，
     * 供后续 RiverMemo Topology 读出复用同一次 Rust 感应，禁止重复构造河网。
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

    async withMemoObservationScope(operation) {
        const current = memoObservationScope.getStore();
        if (current?.owner === this) return operation();
        const scope = { owner: this, tasks: new Map(), handles: new Set() };
        return memoObservationScope.run(scope, async () => {
            try {
                return await operation();
            } finally {
                await Promise.allSettled(scope.tasks.values());
                for (const handle of scope.handles) {
                    try {
                        this.tagIndex?.releaseMemoObservation?.(handle);
                    } catch (error) {
                        console.warn(`[KnowledgeBase] Shared Memo release failed: ${error.message}`);
                    }
                }
                scope.tasks.clear();
                scope.handles.clear();
            }
        });
    }

    _runMemoPipelineShared(dbPath, artifactSig, inputJson, queryVector, ghostVectors) {
        const scope = memoObservationScope.getStore();
        if (!scope || scope.owner !== this) {
            return this.tagIndex.runMemoPipeline(
                dbPath, artifactSig, inputJson, queryVector, ghostVectors
            );
        }
        // 使用实际 ABI 输入：包含完整 FP32 向量、所有有效配置和资产身份，
        // 不包含候选索引、权限、K 或排序选项。
        const key = crypto.createHash('sha256')
            .update(stableSerialize([dbPath, artifactSig, JSON.parse(inputJson)]))
            .update(Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength))
            .update(Buffer.from(ghostVectors.buffer, ghostVectors.byteOffset, ghostVectors.byteLength))
            .digest('hex');
        if (!scope.tasks.has(key)) {
            const task = Promise.resolve().then(async () => {
                const result = await this.tagIndex.runMemoPipeline(
                    dbPath, artifactSig, inputJson, queryVector, ghostVectors
                );
                const metadata = JSON.parse(result.metadataJson);
                if (metadata.observationHandle) scope.handles.add(metadata.observationHandle);
                return result;
            });
            // 在启动原生任务前登记 Promise；失败也共享，避免同轮失败风暴。
            scope.tasks.set(key, task);
        }
        return scope.tasks.get(key);
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
            ...(riverConfig.effectiveSupport || {}),
            ...(nativeMemoConfig.effectiveSupport || {}),
            ...(options.effectiveSupport || {})
        };
        const maxFieldProjectionNodes = options.maxFieldProjectionNodes
            ?? effectiveSupportConfig.maxProjectionNodes ?? 256;
        if (!Number.isSafeInteger(maxFieldProjectionNodes) || maxFieldProjectionNodes < 0) {
            throw new RangeError('maxFieldProjectionNodes must be a non-negative safe integer');
        }
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
                && tag.vector.length === this.config.dimension
            )
            .map(tag => ({
                name: tag.name.trim(),
                isCore: tag.isCore === true,
                vector: tag.vector instanceof Float32Array
                    ? tag.vector
                    : new Float32Array(tag.vector)
            }));
        const ghostVectors = new Float32Array(
            ghostTags.length * this.config.dimension
        );
        ghostTags.forEach((tag, index) => {
            ghostVectors.set(tag.vector, index * this.config.dimension);
        });
        const ghostMetadata = ghostTags.map(tag => ({
            name: tag.name,
            isCore: tag.isCore
        }));

        const nativeResult = await this._runMemoPipelineShared(
            dbPath,
            artifact.artifactSig,
            JSON.stringify({
                queryId: options.queryId || null,
                queryText: String(query?.text || options.queryText || ''),
                coreTags: stringCoreTags,
                ghostTags: ghostMetadata,
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
                    maxFieldProjectionNodes,
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
                    epaGateMode: String(
                        options.epaGateMode ?? kbConfig.epaGateMode ?? 'backgroundRelative'
                    ),
                    activationMultiplier:
                        kbConfig.activationMultiplier || [0.5, 1.5],
                    dynamicBoostRange:
                        kbConfig.dynamicBoostRange || [0.3, 2.0],
                    coreBoostRange:
                        kbConfig.coreBoostRange || [1.2, 1.4],
                    langConfidenceEnabled:
                        this.config.langConfidenceEnabled !== false,
                    langPenaltyUnknown:
                        this._readOptionalPenalty(this.config.langPenaltyUnknown)
                        ?? this._readOptionalPenalty(language.penaltyUnknown)
                        ?? 0.05,
                    langPenaltyCrossDomain:
                        this._readOptionalPenalty(this.config.langPenaltyCrossDomain)
                        ?? this._readOptionalPenalty(language.penaltyCrossDomain)
                        ?? 0.1,
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
                            options.maxObservationEdges ?? 0,
                        maxTransitionRecords: Math.max(
                            0,
                            Math.min(16000, Math.floor(
                                Number(options.maxTransitionRecords) || 0
                            ))
                        )
                    }
                }
            }),
            queryVector,
            ghostVectors
        );
        const pipeline = nativeResult?.metadataJson
            ? JSON.parse(nativeResult.metadataJson)
            : null;
        const enhancedVector = nativeResult?.enhancedVector;
        const observationHandle = typeof pipeline?.observationHandle === 'string'
            && pipeline.observationHandle
            ? pipeline.observationHandle
            : null;
        if (
            pipeline?.artifactSig !== artifact.artifactSig
            || !observationHandle
            || !(enhancedVector instanceof Float32Array)
            || enhancedVector.length !== this.config.dimension
        ) {
            if (observationHandle) this.releaseMemoObservation({ observationHandle });
            const error = new Error(
                'Unified native Memo pipeline failed artifact/schema validation'
            );
            error.code = 'MEMO_PIPELINE_INVALID';
            throw error;
        }

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
        const nativeFusion = pipeline.diagnostics?.fusion || null;
        const emptyField = Object.freeze([]);
        const queryRiverGraph = Object.freeze({
            schema: 'vexus-unified-memo-river-handle-v1',
            nodes: emptyField,
            edges: emptyField,
            diagnostics: Object.freeze({
                reachedNodes:
                    Number(pipeline.diagnostics?.sensing?.reachedNodes) || 0,
                activeEdges:
                    Number(pipeline.diagnostics?.sensing?.activeEdges) || 0
            })
        });
        const sourceObservationResult = Object.freeze({
            schema: pipeline.schema,
            sourceMode: 'rust_unified_memo_pipeline_handle',
            sourceField: emptyField,
            enhancedVector,
            fieldProvenance: emptyField,
            queryRiverGraph,
            epa: Object.freeze({ ...(pipeline.epa || {}) }),
            pyramid,
            propagation: Object.freeze({ native: null }),
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
                completeObservation: true,
                nativeSensing: null,
                nativeFusion: nativeFusion
                    ? Object.freeze({ ...nativeFusion })
                    : null,
                nativePipeline: Object.freeze({
                    ...(pipeline.diagnostics || {})
                }),
                runtimeOwnership: 'vexus-index-instance'
            })
        });
        const observation = Object.freeze({
            schema: 'vexus-unified-memo-observation-handle-v1',
            artifactSig: artifact.artifactSig,
            queryId: pipeline.queryId || options.queryId || null,
            sourceField: emptyField,
            nodes: emptyField,
            edges: emptyField,
            diagnostics: null
        });
        const emptyVector = new Float32Array(0);

        return Object.freeze({
            artifact,
            observationHandle,
            observation,
            sourceObservationResult,
            sourceField: emptyField,
            queryVector,
            enhancedVector,
            nativePreparedQuery: Object.freeze({
                queryState: Object.freeze({
                    queryId: observation.queryId,
                    sourceField: emptyField,
                    localField: emptyField,
                    transferField: emptyField,
                    localDomain: Object.freeze({ ids: emptyField }),
                    transferDomain: Object.freeze({ ids: emptyField }),
                    queryRiverGraph,
                    sourceObservation: sourceObservationResult,
                    fieldDiagnostics: Object.freeze({
                        backend: 'rust-unified-memo-pipeline-handle',
                        ...(pipeline.diagnostics?.dualField || {})
                    })
                }),
                denoisedVector: enhancedVector,
                localVector: emptyVector,
                transferVector: emptyVector,
                fieldProjectionDiagnostics: Object.freeze({
                    backend: 'rust-unified-memo-pipeline-handle'
                }),
                preparationTimings: Object.freeze({
                    nativePipelineTotalMs:
                        Number(pipeline.diagnostics?.totalMs) || 0
                })
            })
        });
    }

    releaseMemoObservation(prepared) {
        const handle = prepared?.observationHandle;
        if (!handle || typeof this.tagIndex?.releaseMemoObservation !== 'function') return false;
        const scope = memoObservationScope.getStore();
        if (scope?.owner === this && scope.handles.has(handle)) return false;
        try {
            return this.tagIndex.releaseMemoObservation(handle);
        } catch (error) {
            console.warn(`[KnowledgeBase] Memo observation release failed: ${error.message}`);
            return false;
        }
    }

    /**
     * 统一 Memo 单轨读出门面。readoutMode 只允许 topology_v3；
     * RiverMemo 复用原生 QueryObservation 和统一活动图代际。
     */
    async rerankWithMemo(
        readoutMode,
        query,
        candidates,
        agentContext = {},
        options = {}
    ) {
        const mode = String(readoutMode || '').trim().toLowerCase();
        if (mode !== 'topology_v3') {
            const error = new Error(
                `Unsupported Memo readout mode: ${readoutMode}`
            );
            error.code = 'MEMO_READOUT_MODE_UNSUPPORTED';
            throw error;
        }
        const prepared = options.preparedMemoObservation
            || await this.prepareUnifiedMemoObservation(query, options);
        const { artifact, sourceObservationResult } = prepared;

        try {
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
                    hydrateChunksByIds: ids => this.hydrateChunksByIds(ids),
                    nativePreparedQuery: prepared.nativePreparedQuery,
                    observationHandle: prepared.observationHandle,
                    sourceObservationResult,
                    sourceField: prepared.sourceField,
                    nativeKnowledgeRuntime: this.nativeKnowledgeRuntime,
                    // 只有 executeNativeRiverQuery 或显式调用方可以触发联合重搜。
                    // 普通 rerankWithRiverMemoAsync 必须尊重调用方已构造的
                    // BM25/Time/LightMemo 候选，不能因全局开关而覆盖它们。
                    nativeJointQuery:
                        options.nativeJointQuery === true,
                    nativeJointFallbackToLegacy:
                        options.nativeJointFallbackToLegacy
                        ?? this.config.nativeRiverQueryFallbackToLegacy,
                    nativePerIndexK:
                        options.nativePerIndexK
                        ?? this.config.nativeRiverQueryPerIndexK,
                    nativeCandidateK:
                        options.nativeCandidateK
                        ?? this.config.nativeRiverQueryCandidateK,
                    nativeSemanticThreshold:
                        options.nativeSemanticThreshold
                        ?? this.config.nativeRiverQuerySemanticThreshold,
                    sourceObservationConfig: {
                        ...(artifact.effectiveConfig
                            ?.sourceObservation || {}),
                        ...(options.sourceObservationConfig || {})
                    },
                    includeTrace: options.includeTrace === true
                }
            );
        }
        } finally {
            if (!options.preparedMemoObservation) this.releaseMemoObservation(prepared);
        }
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
     * Rust 原生联合 River 查询公共代理。
     *
     * 调用方无需先执行 search() 或 hydrate 候选；这里只准备控制面、
     * observationHandle 和权限作用域，随后由 NativeKnowledgeRuntime 完成
     * ANN→合并→向量 hydrate→语义去重→Topology V3。
     */
    async executeNativeRiverQuery(query, options = {}) {
        const rawVector = query?.vector || options.queryVector;
        const queryVector = rawVector instanceof Float32Array
            ? rawVector
            : new Float32Array(rawVector || []);
        if (queryVector.length !== this.config.dimension) {
            throw new RangeError(
                `Native River query vector must be ${this.config.dimension}, ` +
                `got ${queryVector.length}`
            );
        }

        const diaryNames = [...new Set(
            (Array.isArray(options.diaryNames)
                ? options.diaryNames
                : [options.diaryNames]
            ).map(name => String(name || '').trim()).filter(Boolean)
        )];
        if (diaryNames.length === 0) {
            const error = new Error(
                'Native River query requires an explicit diary scope'
            );
            error.code = 'NATIVE_RIVER_QUERY_EMPTY_DIARY_SCOPE';
            throw error;
        }

        await Promise.all(
            diaryNames.map(name => this._getOrLoadDiaryIndex(name))
        );

        const allowedFileIds = await this.getFileIdsByDiaries(diaryNames);
        if (allowedFileIds.length === 0) {
            return {
                results: [],
                diagnostics: { reason: 'empty-permission-scope' }
            };
        }

        const finalK = Math.max(
            1,
            Math.floor(Number(options.topK) || 8)
        );
        const candidateK = Math.max(
            finalK,
            Math.floor(Number(
                options.candidateK
                ?? this.config.nativeRiverQueryCandidateK
            ) || 300)
        );
        const supplementalQueryVectors = (Array.isArray(options.supplementalQueryVectors)
            ? options.supplementalQueryVectors
            : []
        ).map((entry, index) => {
            const rawVector = entry?.vector ?? entry;
            const vector = rawVector instanceof Float32Array
                ? rawVector
                : new Float32Array(rawVector || []);
            if (vector.length !== this.config.dimension) {
                throw new RangeError(
                    `Native supplemental query vector ${index} must be ` +
                    `${this.config.dimension}, got ${vector.length}`
                );
            }
            const weight = Math.max(
                0,
                Math.min(1, Number(entry?.weight ?? 1) || 0)
            );
            return { vector, weight };
        });
        const nativeSupplementalVectors = new Float32Array(
            supplementalQueryVectors.length * this.config.dimension
        );
        supplementalQueryVectors.forEach((entry, index) => {
            nativeSupplementalVectors.set(
                entry.vector,
                index * this.config.dimension
            );
        });
        const rawHybridPlan = options.hybridPlan
            && typeof options.hybridPlan === 'object'
            ? options.hybridPlan
            : null;
        const nativeHybridPlan = (
            rawHybridPlan
            || supplementalQueryVectors.length > 0
        ) ? {
            schema: 'vcp-native-hybrid-query-plan-v2',
            supplemental: {
                weights: supplementalQueryVectors.map(entry => entry.weight),
                perIndexK: Math.max(
                    1,
                    Math.floor(Number(
                        rawHybridPlan?.supplemental?.perIndexK
                        ?? Math.max(2, Math.round(candidateK / 2))
                    ) || 2)
                )
            },
            fileCandidates: Array.isArray(rawHybridPlan?.fileCandidates)
                ? rawHybridPlan.fileCandidates
                    .map(candidate => ({
                        path: String(candidate?.path || '').trim().replace(/\\/g, '/'),
                        bm25Score: Math.max(
                            0,
                            Number(candidate?.bm25Score) || 0
                        ),
                        normalizedBM25Score: Math.max(
                            0,
                            Math.min(
                                1,
                                Number(candidate?.normalizedBM25Score) || 0
                            )
                        ),
                        timeScore: Math.max(
                            0,
                            Number(candidate?.timeScore) || 0
                        ),
                        source: String(candidate?.source || '').trim()
                    }))
                    .filter(candidate => candidate.path)
                : [],
            bm25Weight: Math.max(
                0,
                Math.min(1, Number(rawHybridPlan?.bm25Weight ?? 0.6))
            ),
            bm25Mode: rawHybridPlan?.bm25Mode === 'body'
                ? 'body'
                : 'tag',
            // JS 配置先规范化，Rust ABI 内再次执行硬夹逼，防止错误热参数
            // 将宽时间范围扩展为无界 Chunk 候选池。
            timePerDiaryLimit: Math.max(
                1,
                Math.min(
                    50,
                    Math.floor(
                        Number(rawHybridPlan?.timePerDiaryLimit) || 10
                    )
                )
            ),
            timeGlobalLimit: Math.max(
                1,
                Math.min(
                    500,
                    Math.floor(
                        Number(rawHybridPlan?.timeGlobalLimit) || 50
                    )
                )
            )
        } : null;

        const degradedKnn = async () => ({
            results: nativeHybridPlan
                ? (await collectCandidates.call(this)).slice(0, finalK).map(result => ({
                    ...result, retrievalEngine: 'knn'
                }))
                : await this.searchKnn(diaryNames, queryVector, finalK, {
                ...options,
                allowedFileIds: Array.isArray(options.allowedFileIds)
                    ? allowedFileIds.filter(id => options.allowedFileIds.map(Number).includes(Number(id)))
                    : allowedFileIds,
                globalK: finalK
            }),
            diagnostics: { reason: 'memo-artifact-unavailable', retrievalEngine: 'knn', degraded: true }
        });
        const isStaleMemo = error => /(?:MEMO_ARTIFACT_UNAVAILABLE|TAGMEMO_ARTIFACT_UNAVAILABLE|KNOWLEDGE_STORE_DERIVED_DEPENDENCY_CONFLICT|observation.*(?:not found|expired|unavailable|mismatch))/i
            .test(String(error.code || '') + ' ' + String(error.message || ''));
        let prepared;
        try {
            prepared = options.preparedMemoObservation
                || await this.prepareUnifiedMemoObservation(
                    { text: String(query?.text || ''), vector: queryVector },
                    { ...options, queryText: String(query?.text || ''), vector: queryVector }
                );
        } catch (error) {
            if (!isStaleMemo(error)) throw error;
            return degradedKnn();
        }
        try {
        const agentContext = {
            agentId: options.agentId || null,
            diaryNames,
            allowedFileIds,
            deniedFileIds: [],
            visibilityMode: 'explicit_sql_scope',
            permissions: {
                allowPublic: false,
                allowOwn: false,
                allowAuthorized: true,
                allowOtherAgentPublic: false,
                allowUnknownProvenance: false
            }
        };
        const jointEnabled = options.enabled
            ?? this.config.nativeRiverQueryEnabled;
        const fallbackEnabled = options.fallbackToLegacy
            ?? this.config.nativeRiverQueryFallbackToLegacy;

        if (jointEnabled) {
            try {
                // 非空哨兵只通过 RiverMemoEngine 公共输入校验；联合 Runtime
                // 会在 Rust 内覆盖 candidates，哨兵不会参与任何计算。
                return await this.riverMemoEngine.rerank(
                    {
                        text: String(query?.text || ''),
                        vector: queryVector
                    },
                    [{ id: 1, chunkId: 1, score: 0 }],
                    agentContext,
                    {
                        ...options,
                        artifact: prepared.artifact,
                        dbPath: this.dbPath,
                        hydrateChunksByIds: ids => this.hydrateChunksByIds(ids),
                        nativePreparedQuery: prepared.nativePreparedQuery,
                        observationHandle: prepared.observationHandle,
                        sourceObservationResult:
                            prepared.sourceObservationResult,
                        sourceField: prepared.sourceField,
                        topK: finalK,
                        nativeKnowledgeRuntime:
                            this.nativeKnowledgeRuntime,
                        nativeJointQuery: true,
                        nativeHybridPlan,
                        nativeSupplementalVectors,
                        nativeJointFallbackToLegacy: false,
                        nativePerIndexK:
                            options.perIndexK
                            ?? this.config.nativeRiverQueryPerIndexK,
                        nativeCandidateK: candidateK,
                        nativeSemanticThreshold:
                            options.semanticThreshold
                            ?? this.config
                                .nativeRiverQuerySemanticThreshold
                    }
                );
            } catch (error) {
                if (isStaleMemo(error)) return degradedKnn();
                if (!fallbackEnabled) throw error;
                console.warn(
                    `[KnowledgeBase][NativeRiverQuery] joint execution failed; ` +
                    `running complete legacy fallback: ${error.message}`
                );
            }
        }
// 完整旧链路回退：复刻 Query Plan V2 的当前 ANN、历史多向量、
// BM25/Time 文件展开和 Time 双重限流，再交给原生 Topology V3。
// 此路径只在联合 ABI 不可用/失败时执行，保留正确性优先于性能。
        const candidates = await collectCandidates.call(this);
        return await this.riverMemoEngine.rerank(
            { text: String(query?.text || ''), vector: queryVector },
            candidates,
            agentContext,
            {
                ...options,
                artifact: prepared.artifact,
                dbPath: this.dbPath,
                hydrateChunksByIds: ids => this.hydrateChunksByIds(ids),
                nativePreparedQuery: prepared.nativePreparedQuery,
                observationHandle: prepared.observationHandle,
                sourceObservationResult: prepared.sourceObservationResult,
                sourceField: prepared.sourceField,
                topK: finalK,
                nativeJointQuery: false
            }
        );
        } finally {
            if (!options.preparedMemoObservation) this.releaseMemoObservation(prepared);
        }

        async function collectCandidates() {
            const searchOptions = {
                ...options,
                allowedFileIds: Array.isArray(options.allowedFileIds)
                    ? allowedFileIds.filter(id => options.allowedFileIds.map(Number).includes(Number(id)))
                    : allowedFileIds,
                deniedFileIds: options.deniedFileIds || []
            };
            const perIndexK = options.perIndexK
                ?? this.config.nativeRiverQueryPerIndexK;
            const currentSearchPromise = this.searchKnn(
                diaryNames,
                queryVector,
                candidateK,
                0,
                [],
                undefined,
                {
                    ...searchOptions,
                    perIndexK,
                    globalK: candidateK
                }
            );
            const supplementalSearchPromises = supplementalQueryVectors.map(
                async entry => {
                    const results = await this.searchKnn(
                        diaryNames,
                        entry.vector,
                        Math.max(2, Math.round(candidateK / 2)),
                        0,
                        [],
                        undefined,
                        {
                            ...searchOptions,
                            perIndexK: Math.max(
                                2,
                                Math.round(Number(perIndexK) / 2)
                            ),
                            globalK: Math.max(
                                2,
                                Math.round(candidateK / 2)
                            )
                        }
                    );
                    return results.map(result => ({
                        ...result,
                        score: (Number(result.score) || 0) * entry.weight,
                        vectorScore: Number(result.score) || 0,
                        source: 'history'
                    }));
                }
            );
            const [currentCandidates, ...supplementalCandidates] =
                await Promise.all([
                    currentSearchPromise,
                    ...supplementalSearchPromises
                ]);
            let candidates = [
                ...currentCandidates.map(result => ({
                    ...result,
                    vectorScore: Number(result.score) || 0,
                    source: result.source || 'rag'
                })),
                ...supplementalCandidates.flat()
            ];

            const fileCandidates = nativeHybridPlan?.fileCandidates || [];
            if (fileCandidates.length > 0) {
                const filePlanByPath = new Map(
                    fileCandidates.map(candidate => [candidate.path, candidate])
                );
                const allowed = new Set(searchOptions.allowedFileIds.map(Number));
                const denied = new Set(searchOptions.deniedFileIds.map(Number));
                const chunks = (await this.getChunksByFilePaths(
                    fileCandidates.map(candidate => candidate.path)
                )).filter(chunk => allowed.has(Number(chunk.fileId)) && !denied.has(Number(chunk.fileId)));
                const queryMagnitude = Math.sqrt(
                    Array.from(queryVector).reduce(
                        (sum, value) => sum + value * value,
                        0
                    )
                );
                const cosineToQuery = vector => {
                    if (
                        !vector
                        || vector.length !== queryVector.length
                        || queryMagnitude <= 1e-12
                    ) {
                        return 0;
                    }
                    let dot = 0;
                    let magnitude = 0;
                    for (let index = 0; index < vector.length; index++) {
                        const value = Number(vector[index]) || 0;
                        dot += queryVector[index] * value;
                        magnitude += value * value;
                    }
                    return magnitude > 1e-12
                        ? dot / (queryMagnitude * Math.sqrt(magnitude))
                        : 0;
                };
                const timeByDiary = new Map();
                const sparseWeight = nativeHybridPlan.bm25Weight;
                for (const chunk of chunks) {
                    const chunkPath = String(chunk.fullPath || chunk.sourceFile || '').replace(/\\/g, '/');
                    const filePlan = filePlanByPath.get(chunkPath);
                    if (!filePlan) continue;
                    const vectorScore = cosineToQuery(chunk.vector);
                    const isTime = filePlan.source === 'time'
                        || filePlan.timeScore > 0;
                    const score = filePlan.bm25Score > 0
                        ? filePlan.normalizedBM25Score * sparseWeight
                            + vectorScore * (1 - sparseWeight)
                        : vectorScore;
                    const candidate = {
                        ...chunk,
                        score,
                        vectorScore,
                        bm25Score: filePlan.bm25Score,
                        normalizedBM25Score:
                            filePlan.normalizedBM25Score,
                        timeScore: filePlan.timeScore,
                        source: isTime
                            ? 'time'
                            : (filePlan.source || 'rag')
                    };
                    if (isTime) {
                        const normalizedPath = String(chunkPath)
                            .replace(/\\/g, '/');
                        const diaryName = normalizedPath.split('/')[0]
                            || chunk.diaryName
                            || 'unknown';
                        if (!timeByDiary.has(diaryName)) {
                            timeByDiary.set(diaryName, new Map());
                        }
                        const diaryPool = timeByDiary.get(diaryName);
                        const chunkId = Number(chunk.chunkId ?? chunk.id);
                        const existing = diaryPool.get(chunkId);
                        if (!existing || score > existing.score) {
                            diaryPool.set(chunkId, candidate);
                        }
                    } else {
                        candidates.push(candidate);
                    }
                }

                const limitedTime = [];
                const perDiaryLimit = nativeHybridPlan.timePerDiaryLimit;
                const globalLimit = nativeHybridPlan.timeGlobalLimit;
                for (const diaryName of [...timeByDiary.keys()].sort()) {
                    const diaryCandidates = Array.from(
                        timeByDiary.get(diaryName).values()
                    ).sort((left, right) =>
                        (right.vectorScore || 0) - (left.vectorScore || 0)
                        || Number(left.chunkId ?? left.id)
                            - Number(right.chunkId ?? right.id)
                    );
                    limitedTime.push(
                        ...diaryCandidates.slice(0, perDiaryLimit)
                    );
                }
                limitedTime.sort((left, right) =>
                    (right.vectorScore || 0) - (left.vectorScore || 0)
                    || Number(left.chunkId ?? left.id)
                        - Number(right.chunkId ?? right.id)
                );
                candidates.push(...limitedTime.slice(0, globalLimit));
            }

            // 先按 Chunk 身份合并多路候选，保留最高主分并合并稀疏/时间证据。
            const mergedByChunk = new Map();
            for (const candidate of candidates) {
                const id = Number(candidate?.chunkId ?? candidate?.id);
                if (!Number.isSafeInteger(id) || id <= 0) continue;
                const existing = mergedByChunk.get(id);
                if (!existing) {
                    mergedByChunk.set(id, { ...candidate, id, chunkId: id });
                    continue;
                }
                if ((candidate.score || 0) > (existing.score || 0)) {
                    Object.assign(existing, candidate, { id, chunkId: id });
                }
                existing.vectorScore = Math.max(
                    Number(existing.vectorScore) || 0,
                    Number(candidate.vectorScore) || 0
                );
                existing.bm25Score = Math.max(
                    Number(existing.bm25Score) || 0,
                    Number(candidate.bm25Score) || 0
                );
                existing.timeScore = Math.max(
                    Number(existing.timeScore) || 0,
                    Number(candidate.timeScore) || 0
                );
                if (candidate.source === 'time') existing.source = 'time';
            }
            candidates = await this.deduplicateResults(
                Array.from(mergedByChunk.values())
                    .sort((left, right) =>
                        (right.score || 0) - (left.score || 0)
                        || left.chunkId - right.chunkId
                    )
                    .slice(0, candidateK),
                queryVector,
                {
                    stage: 'native-river-query-v2-fallback',
                    semantic: true,
                    semanticThreshold:
                        options.semanticThreshold
                        ?? this.config.nativeRiverQuerySemanticThreshold,
                    maxResults: candidateK
                }
            );
            return candidates;
        }
    }

    /**
     * 元思考无 Sense 时的原生并发候选召回。
     * 仅执行 NativeKnowledgeRuntime 的多日记索引 ANN，不伪造河网、
     * 不触发二次 JS search，也不需要 observationHandle。
     */
    async searchNativeDiaryCandidates(diaryName, queryVector, options = {}) {
        const names = [...new Set(
            (Array.isArray(diaryName) ? diaryName : [diaryName])
                .map(name => String(name || '').trim())
                .filter(Boolean)
        )];
        const vector = queryVector instanceof Float32Array
            ? queryVector
            : new Float32Array(queryVector || []);
        if (
            names.length === 0
            || vector.length !== this.config.dimension
            || !this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.searchDiaryIndices !== 'function'
        ) {
            return [];
        }

        await Promise.all(names.map(name => this._getOrLoadDiaryIndex(name)));
        const perIndexK = Math.max(
            1,
            Math.min(1000, Math.floor(Number(options.perIndexK) || 64))
        );
        const globalK = Math.max(
            1,
            Math.min(2000, Math.floor(Number(options.globalK) || perIndexK))
        );
        const payload = await this.nativeKnowledgeRuntime.searchDiaryIndices(
            names,
            vector,
            perIndexK,
            globalK
        );
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
        const ids = (Array.isArray(parsed?.results) ? parsed.results : [])
            .map(item => Number(item?.id))
            .filter(id => Number.isSafeInteger(id) && id > 0);
        if (ids.length === 0) return [];

        const rows = await this.hydrateChunksByIds(ids);
        const byId = new Map(rows.map(row => [Number(row.id), row]));
        return ids.map(id => {
            const row = byId.get(id);
            const native = parsed.results.find(item => Number(item?.id) === id) || {};
            return row ? {
                ...row,
                id,
                chunkId: id,
                fullPath: row.sourceFile,
                score: Number(native.score) || 0,
                vectorScore: Number(native.vectorScore) || Number(native.score) || 0,
                source: 'native_ann'
            } : null;
        }).filter(Boolean);
    }

    /**
     * 元思考只读构链：消费调用方的同一次 Sense，不创建第二份查询观测。
     * Rust 对每个候选再次检查其所属思维簇；正文仅按已验证 ID 回填。
     */
    async planRiverThinking(prepared, stages, options = {}) {
        if (
            !prepared?.observationHandle
            || !prepared?.artifact?.artifactSig
            || typeof this.tagIndex?.planMemoThinking !== 'function'
        ) {
            throw new Error('River thinking native ABI or observation unavailable');
        }
        if (!Array.isArray(stages) || stages.length === 0 || stages.length > 32) {
            throw new Error('Invalid River thinking stages');
        }
        const normalized = stages.map(stage => {
            const k = Number(stage.k);
            if (!Number.isSafeInteger(k) || k < 0 || k > 32) {
                throw new Error('River thinking K outside native budget');
            }
            return {
                diaryName: String(stage.diaryName || '').trim(),
                k,
                candidateIds: [...new Set((stage.candidates || [])
                    .map(item => Number(item.chunkId ?? item.id))
                    .filter(id => Number.isSafeInteger(id) && id > 0))]
                    .slice(0, 256)
            };
        });
        const payload = await this.tagIndex.planMemoThinking(
            this.dbPath,
            prepared.artifact.artifactSig,
            JSON.stringify({
                observationHandle: prepared.observationHandle,
                stages: normalized,
                minClosure: options.minClosure ?? 0.2
            })
        );
        const plan = JSON.parse(payload);
        if (
            plan.schema !== 'vcp-river-thinking-plan-v1'
            || plan.artifactSig !== prepared.artifact.artifactSig
            || plan.observationHandle !== prepared.observationHandle
            || !Array.isArray(plan.stages)
            || plan.stages.length !== stages.length
        ) {
            throw new Error('Invalid River thinking result');
        }
        const selectedIds = new Set();
        plan.stages.forEach((stage, index) => {
            const requested = normalized[index];
            const originals = new Map(stages[index].candidates.map(item => [
                Number(item.chunkId ?? item.id), item
            ]));
            if (
                stage.diaryName !== requested.diaryName
                || stage.k !== requested.k
                || !Array.isArray(stage.results)
                || stage.results.length > requested.k
            ) throw new Error('Invalid River thinking stage result');
            stage.results = stage.results.map(item => {
                const id = Number(item.chunkId);
                if (!originals.has(id) || selectedIds.has(id)) {
                    throw new Error('River thinking returned an unexpected candidate');
                }
                if (!Array.isArray(item.parents)
                    || item.parents.some(parent => !selectedIds.has(parent))) {
                    throw new Error('River thinking returned an invalid dependency');
                }
                selectedIds.add(id);
                return { ...originals.get(id), riverThinking: item };
            });
        });
        return plan;
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
     * 启动只读 Tag 一致性扫描任务并立即返回任务状态。
     * 扫描归属主服务进程，管理页面关闭或请求断开不会中止任务。
     */
    startTagConsistencyPreview() {
        return this.tagConsistencyService.startPreviewTask();
    }

    /**
     * 查询最近一次 Tag 一致性扫描任务，可用于页面重开后的状态恢复。
     */
    getTagConsistencyPreviewStatus() {
        return this.tagConsistencyService.getPreviewTaskStatus();
    }

    /**
     * 同步兼容入口：等待当前规则的一致性快照生成完成。
     * 新管理面板应使用 startTagConsistencyPreview + getTagConsistencyPreviewStatus。
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
     * 主动触发共享 Memo 底座全量自学习训练。
     * 重建 RiverMemo 依赖的派生资产并保留原有发布、调度及退休状态清理机制。
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

    async _ensureDiaryDateIndexCached(diaryName) {
        return await this.diaryMetadataCache.ensureDateIndex(diaryName);
    }

    async getDiaryDateIndex(diaryName) {
        return await this.diaryMetadataCache.getDateIndex(diaryName);
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

    async _hydrateDiaryNameCache() {
        return await this.diaryMetadataCache.hydrateNameCache();
    }

    // 保留旧方法名作为异步兼容门面，禁止恢复同步 SQL 预热。
    async _hydrateDiaryNameCacheSync() {
        return await this._hydrateDiaryNameCache();
    }

    async _fetchAndCacheDiaryNameVector(name) {
        return this.diaryMetadataCache.fetchAndCacheNameVector(name);
    }

        // 🌟 基于 Rust SqliteStorageEngine 的持久化插件描述向量缓存。
        async getPluginDescriptionVector(descText, getEmbeddingFn) {
            let hash;
            try {
                hash = crypto.createHash('sha256').update(String(descText)).digest('hex');
                const key = `plugin_desc_hash:${hash}`;

                if (
                    !this.nativeKnowledgeRuntime
                    || typeof this.nativeKnowledgeRuntime.getKvVector !== 'function'
                    || typeof this.nativeKnowledgeRuntime.setKvVector !== 'function'
                ) {
                    const error = new Error(
                        'NativeKnowledgeRuntime KV vector ABI is unavailable'
                    );
                    error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
                    throw error;
                }

                const raw = await this.nativeKnowledgeRuntime.getKvVector(
                    this.dbPath,
                    key
                );
                const encoded = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (typeof encoded === 'string' && encoded.length > 0) {
                    const decoded = this._decodeVectorBlob(
                        Buffer.from(encoded, 'base64'),
                        this.config.dimension,
                        key
                    );
                    if (decoded) return Array.from(decoded);
                }

                if (typeof getEmbeddingFn !== 'function') {
                    return null;
                }

                console.log(`[KnowledgeBase] Cache MISS for plugin description. Fetching API...`);
                const vec = await getEmbeddingFn(descText);
                if (!vec) return null;
    
                const vector = vec instanceof Float32Array
                    ? vec
                    : new Float32Array(vec);
                if (vector.length !== this.config.dimension) {
                    throw new RangeError(
                        `Plugin description vector dimension mismatch: expected ` +
                        `${this.config.dimension}, got ${vector.length}`
                    );
                }
                const receipt = await this.nativeKnowledgeRuntime.setKvVector(
                    this.dbPath,
                    key,
                    vector
                );
                if (typeof receipt === 'string') JSON.parse(receipt);
                return Array.from(vector);
            } catch (e) {
                console.error(
                    `[KnowledgeBase] Failed to process plugin description vector:`,
                    e.message || e
                );
                return null;
            }
        }

    // 兼容性 API: getVectorByText
    async getVectorByText(diaryName, text) {
        if (
            !this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.getChunkVectorByText !== 'function'
        ) {
            const error = new Error(
                'NativeKnowledgeRuntime Chunk text vector API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }

        const raw = await this.nativeKnowledgeRuntime.getChunkVectorByText(
            this.dbPath,
            String(diaryName || ''),
            String(text || '')
        );
        const encoded = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (typeof encoded !== 'string' || encoded.length === 0) {
            return null;
        }

        let bytes;
        try {
            bytes = Buffer.from(encoded, 'base64');
        } catch (_) {
            return null;
        }
        const expectedBytes =
            this.config.dimension * Float32Array.BYTES_PER_ELEMENT;
        if (bytes.byteLength !== expectedBytes) {
            return null;
        }

        const vector = new Float32Array(
            bytes.buffer,
            bytes.byteOffset,
            this.config.dimension
        );
        for (const value of vector) {
            if (!Number.isFinite(value)) return null;
        }
        return new Float32Array(vector);
    }

    async getTagVectorByName(tagName) {
        const normalizedName = String(tagName || '').trim();
        if (!normalizedName) return null;
        if (
            !this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.getTagVectorByName !== 'function'
        ) {
            const error = new Error(
                'NativeKnowledgeRuntime Tag vector by name API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }

        const raw = await this.nativeKnowledgeRuntime.getTagVectorByName(
            this.dbPath,
            normalizedName
        );
        const encoded = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (typeof encoded !== 'string' || encoded.length === 0) return null;

        let bytes;
        try {
            bytes = Buffer.from(encoded, 'base64');
        } catch (_) {
            return null;
        }

        const expectedBytes = this.config.dimension * Float32Array.BYTES_PER_ELEMENT;
        if (bytes.byteLength !== expectedBytes) return null;

        const vector = new Float32Array(
            bytes.buffer,
            bytes.byteOffset,
            this.config.dimension
        );
        for (const value of vector) {
            if (!Number.isFinite(value)) return null;
        }
        return new Float32Array(vector);
    }

    async getVectorByChunkId(chunkId) {
        const numericChunkId = Number(chunkId);
        if (!Number.isSafeInteger(numericChunkId) || numericChunkId <= 0) {
            return null;
        }
        if (
            !this.nativeKnowledgeRuntime
            || typeof this.nativeKnowledgeRuntime.getChunkVector !== 'function'
        ) {
            const error = new Error(
                'NativeKnowledgeRuntime Chunk vector API is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }

        const raw = await this.nativeKnowledgeRuntime.getChunkVector(
            this.dbPath,
            numericChunkId
        );
        const encoded = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (typeof encoded !== 'string' || encoded.length === 0) {
            return null;
        }

        let bytes;
        try {
            bytes = Buffer.from(encoded, 'base64');
        } catch (_) {
            return null;
        }
        const expectedBytes =
            this.config.dimension * Float32Array.BYTES_PER_ELEMENT;
        if (bytes.byteLength !== expectedBytes) {
            return null;
        }

        const vector = new Float32Array(
            bytes.buffer,
            bytes.byteOffset,
            this.config.dimension
        );
        for (const value of vector) {
            if (!Number.isFinite(value)) return null;
        }
        return new Float32Array(vector);
    }

    /**
     * 🛡️ 启动全量扫描补洞：判断一个文件在 SQLite 中是否已有完整可用的 chunk 向量。
     * 旧逻辑只看 mtime/size，若上次 API 失败但 files 记录已写入，会在开机全扫时被误判为“无需处理”。
     */
    async _hasCompleteStoredVectorsForFile(filePath) {
        const relativePath = path.isAbsolute(String(filePath))
            ? path.relative(this.config.rootPath, filePath).replace(/\\/g, '/')
            : String(filePath).replace(/\\/g, '/');
        const [row] = await this.probeIngestionFiles([relativePath]);
        return row?.completeVectors === true;
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
        const allDiaries = await this.listDistinctDiaries();

        for (const diaryName of allDiaries) {
            try {
                const idx = await this._getOrLoadDiaryIndex(diaryName);
                if (!idx) continue;
                // 兼容维护入口直接交由 Rust 执行权威恢复和状态发布，
                // 不在主线程等待索引锁，也不依赖向量数量差猜测一致性。
                await this.indexRepository.restoreDiaryIndex(diaryName, idx);
            } catch (e) {
                console.warn(
                    `[KnowledgeBase] Ghost check failed for ${diaryName}:`,
                    e.message
                );
            }
        }
        console.log('[KnowledgeBase] 🛡️ Ghost Index self-check complete.');
    }


    // 🌟 TagMemo V7: 触发 Rust 预计算内生残差
    async recomputeGeometry() {
        if (!this.tagMemoEngine) return;
        await this.tagMemoEngine.recomputeGeometry();
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

    _captureMemoryStage(stage) {
        try {
            const sample = captureMemoryStage(this, stage);
            console.log('[KnowledgeBaseMemory] ' + JSON.stringify(sample));
            return sample;
        } catch (error) {
            console.warn('[KnowledgeBaseMemory] Sample failed:', error.message || error);
            return null;
        }
    }

    getMemoryProfile() {
        return buildMemoryProfile(this);
    }

    async shutdown() {
        if (this._shutdownPromise) return this._shutdownPromise;

        this._shutdownPromise = (async () => {
            console.log('[KnowledgeBase] shutting down...');
            this._shuttingDown = true;

            // 先停止文件事件和新一轮批处理，保持 NativeKnowledgeRuntime 可用，
            // 让已接纳的外部变更、删除提交和索引恢复能够正常完成。
            await this.fileWatcher.stop();
            if (this.ragParamsWatcherPoller) {
                clearInterval(this.ragParamsWatcherPoller);
                this.ragParamsWatcherPoller = null;
            }
            if (this.ragParamsWatcher) {
                const stopWatch = this.ragParamsWatcher.stopWatch
                    || this.ragParamsWatcher.stop_watch;
                if (typeof stopWatch === 'function') {
                    stopWatch.call(this.ragParamsWatcher);
                }
                this.ragParamsWatcher = null;
                this.ragParamsWatcherType = null;
            }
            if (this.batchTimer) {
                clearTimeout(this.batchTimer);
                this.batchTimer = null;
            }
            if (this.deleteBatchTimer) {
                clearTimeout(this.deleteBatchTimer);
                this.deleteBatchTimer = null;
            }

            await this.databaseCoordinator.waitForExternalMutations();
            await this.ingestionPipeline.drain();
            await this.tagConsistencyService.drain();
            await this._indexRecoveryTail;

            if (this.pendingDeletes.size > 0 && !this.databaseCorruptionDetected) {
                await this._flushDeleteBatch();
            }

            // 索引仓储先排空恢复任务和 checkpoint，再释放其内存索引。
            this.indexRepository.tagIndex = this.tagIndex;
            await this.indexRepository.flushAndStop();
            this.idleSweepTimer = null;

            // 停止 TagMemo 新任务和计时器。此时其 Rust 依赖仍然有效，
            // 因此在途派生任务不会因 Runtime 提前置空而失去提交通道。
            if (this.tagMemoEngine && typeof this.tagMemoEngine.shutdown === 'function') {
                await this.tagMemoEngine.shutdown();
            }

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

            if (this.eventLoopWatchdogTimer) {
                clearInterval(this.eventLoopWatchdogTimer);
                this.eventLoopWatchdogTimer = null;
            }

            // 所有 JS 控制面任务、索引发布和派生提交完成后，最后关闭 Rust
            // StorageEngine，确保 Writer Actor、Read Pool 和 Windows 文件句柄排空。
            if (this.nativeKnowledgeRuntime) {
                try {
                    this.nativeKnowledgeRuntime.shutdown();
                } catch (error) {
                    console.warn(
                        '[KnowledgeBase] Failed to shutdown NativeKnowledgeRuntime:',
                        error.message || error
                    );
                }
                this.nativeKnowledgeRuntime = null;
            }
            this.nativeDiaryIndexGenerations.clear();
            this.initialized = false;

            console.log('[KnowledgeBase] Shutdown complete.');
        })();

        return this._shutdownPromise;
    }
}

module.exports = new KnowledgeBaseManager();