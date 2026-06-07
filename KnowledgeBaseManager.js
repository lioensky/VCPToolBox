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
            // 向量语义空间签名：用于缓存/派生数据失效；未配置时回退到主模型名，避免破坏旧行为。
            modelSig: process.env.EmbeddingModelSig || process.env.WhitelistEmbeddingModel || 'gemini-embedding-2-preview',
            // ⚠️ 务必确认环境变量 VECTORDB_DIMENSION 与模型一致 (3-small通常为1536)
            dimension: parseInt(process.env.VECTORDB_DIMENSION) || 3072,

            batchWindow: parseInt(process.env.KNOWLEDGEBASE_BATCH_WINDOW_MS, 10) || 2000,
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
        this.pendingFiles = new Set();
        this.fileRetryCount = new Map(); // 🛡️ 文件重试计数器，防止无限循环
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
            -- 🌟 TagMemo V8.2: 持久化的 Tag 对语义距离 (Pairwise Cosine Similarity)
            -- 与 tag_intrinsic_residuals 平级，构成"节点质量 + 边距离"的物理量底座。
            CREATE TABLE IF NOT EXISTS tag_pair_similarity (
                tag_a INTEGER NOT NULL,
                tag_b INTEGER NOT NULL,           -- 约定 tag_a < tag_b，消除重复
                similarity REAL NOT NULL,         -- [-1, 1] 余弦，不预归一化
                model_sig TEXT NOT NULL,          -- embedding 模型签名 (含维度)，跨模型自动失效
                computed_at INTEGER NOT NULL,
                PRIMARY KEY (tag_a, tag_b),
                FOREIGN KEY (tag_a) REFERENCES tags(id) ON DELETE CASCADE,
                FOREIGN KEY (tag_b) REFERENCES tags(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_pair_sim_model ON tag_pair_similarity(model_sig);
            CREATE TABLE IF NOT EXISTS kv_store (
                key TEXT PRIMARY KEY,
                value TEXT,
                vector BLOB
            );
            -- 🧳 文件移动墓碑缓存：删除事件先到时，短期保留 chunk 向量供新路径复用。
            CREATE TABLE IF NOT EXISTS migration_deleted_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                old_path TEXT NOT NULL,
                old_diary_name TEXT NOT NULL,
                checksum TEXT NOT NULL,
                size INTEGER NOT NULL,
                chunk_count INTEGER NOT NULL,
                deleted_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS migration_deleted_chunks (
                cache_file_id INTEGER NOT NULL,
                chunk_index INTEGER NOT NULL,
                vector BLOB NOT NULL,
                PRIMARY KEY (cache_file_id, chunk_index),
                FOREIGN KEY(cache_file_id) REFERENCES migration_deleted_files(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_files_diary ON files(diary_name);
            CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
            CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);
            CREATE INDEX IF NOT EXISTS idx_file_tags_composite ON file_tags(tag_id, file_id);
            CREATE INDEX IF NOT EXISTS idx_migration_deleted_lookup ON migration_deleted_files(checksum, size, expires_at);
            CREATE INDEX IF NOT EXISTS idx_migration_deleted_expiry ON migration_deleted_files(expires_at);
            
        `);
        
        // 🛠️ 核心修复：由于 db.exec 不支持动态执行 SELECT 返回的 SQL，我们手动补丁
        try {
            this.db.prepare("ALTER TABLE file_tags ADD COLUMN position INTEGER NOT NULL DEFAULT 0").run();
        } catch (e) {
            // 如果列已存在，SQLite 会报错，忽略即可
        }

        this._cleanupExpiredMigrationCache();
    }

    _openDatabaseWithRecovery(dbPath) {
        let db = new Database(dbPath);
        try {
            this._configureDatabaseConnection(db);
            this._assertDatabaseIntegrity(db);
            return db;
        } catch (e) {
            if (!this._isSqliteCorruptionError(e)) {
                try { db.close(); } catch (_) { }
                throw e;
            }

            console.error('[KnowledgeBase] ❌ SQLite database corruption detected during startup.');
            console.error(`[KnowledgeBase] Corruption details: ${e.message || e}`);
            try { db.close(); } catch (_) { }

            const backupBase = this._quarantineSqliteDatabase(dbPath, 'startup-corrupt');
            console.warn(
                `[KnowledgeBase] 🧯 Corrupt SQLite database quarantined as "${path.basename(backupBase)}*". ` +
                'A fresh database will be created and rebuilt from dailynote files.'
            );

            db = new Database(dbPath);
            this._configureDatabaseConnection(db);
            this._assertDatabaseIntegrity(db);
            return db;
        }
    }

    _configureDatabaseConnection(db) {
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        // 🛡️ SQLite 默认不启用外键；必须显式开启，避免文件删除后 chunks/file_tags 残留。
        db.pragma('foreign_keys = ON');
    }

    _assertDatabaseIntegrity(db) {
        const row = db.prepare('PRAGMA quick_check').get();
        const result = row ? Object.values(row)[0] : 'ok';
        if (result !== 'ok') {
            const error = new Error(`SQLite quick_check failed: ${result}`);
            error.code = 'SQLITE_CORRUPT';
            throw error;
        }
    }

    checkpointAndAssertDatabaseHealthy(reason = 'manual-checkpoint') {
        if (!this.db) return false;
        try {
            this.db.pragma('wal_checkpoint(TRUNCATE)');
            this._assertDatabaseIntegrity(this.db);
            this.dbHealthState = 'healthy';
            return true;
        } catch (e) {
            if (!this._isSqliteCorruptionError(e)) {
                console.error(`[KnowledgeBase] 🚨 SQLite checkpoint/quick_check failed after ${reason}: ${e.message || e}`);
                return false;
            }

            // 🛡️ better-sqlite3 与 rusqlite 跨连接 WAL/SHM 交接后，旧连接偶发看到
            // "database disk image is malformed" 的瞬态视图；先按 suspect 处理，只有二阶段
            // 重开连接复检失败才升级为真正 corruption，避免把可恢复误报打成 ERROR。
            console.warn(`[KnowledgeBase] 🩺 SQLite checkpoint/quick_check reported suspect state after ${reason}: ${e.message || e}`);
            this.dbHealthState = 'suspect';
            return this._recoverSuspectDatabaseConnection(reason, e);
        }
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
        if (!this.dbPath || this._recoveringDatabaseConnection) return false;

        this._recoveringDatabaseConnection = true;
        this.dbHealthState = 'recovering';

        const oldDb = this.db;
        try {
            console.warn(`[KnowledgeBase] 🩺 SQLite suspect state after ${reason}; reopening connection for second-stage verification...`);
            try { oldDb?.close(); } catch (closeErr) {
                console.warn(`[KnowledgeBase] ⚠️ Failed to close suspect SQLite connection cleanly: ${closeErr.message}`);
            }

            const reopened = new Database(this.dbPath);
            this._configureDatabaseConnection(reopened);
            reopened.pragma('wal_checkpoint(TRUNCATE)');
            this._assertDatabaseIntegrity(reopened);

            this._rebindDatabaseConnection(reopened);
            this.dbHealthState = 'healthy';
            this.databaseCorruptionDetected = false;
            console.warn('[KnowledgeBase] ✅ SQLite suspect verification passed after reopen; treating as transient WAL/SHM view issue.');
            return true;
        } catch (secondError) {
            console.error(`[KnowledgeBase] 🚨 SQLite second-stage verification failed after ${reason}: ${secondError.message || secondError}`);
            console.error(`[KnowledgeBase] First-stage failure was: ${firstError?.message || firstError}`);
            this.dbHealthState = 'corrupt';
            this.databaseCorruptionDetected = true;
            return false;
        } finally {
            this._recoveringDatabaseConnection = false;
        }
    }

    _isSqliteCorruptionError(e) {
        const message = String(e?.message || e || '');
        return e?.code === 'SQLITE_CORRUPT' ||
            e?.code === 'SQLITE_NOTADB' ||
            /database disk image is malformed|file is not a database|database corruption|quick_check failed/i.test(message);
    }

    _quarantineSqliteDatabase(dbPath, reason = 'corrupt') {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupBase = `${dbPath}.${reason}.${timestamp}.bak`;
        const relatedFiles = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];

        for (const file of relatedFiles) {
            if (!fsSync.existsSync(file)) continue;
            const suffix = file === dbPath ? '' : path.basename(file).slice(path.basename(dbPath).length);
            const target = `${backupBase}${suffix}`;
            try {
                fsSync.renameSync(file, target);
                console.warn(`[KnowledgeBase] 🧯 Quarantined "${path.basename(file)}" -> "${path.basename(target)}"`);
            } catch (err) {
                console.error(`[KnowledgeBase] ❌ Failed to quarantine "${file}": ${err.message}`);
                throw err;
            }
        }

        return backupBase;
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
                if (this.watcherType === 'rust') {
                    const stopWatch = this.watcher.stopWatch || this.watcher.stop_watch;
                    if (typeof stopWatch === 'function') stopWatch.call(this.watcher);
                } else if (typeof this.watcher.close === 'function') {
                    await this.watcher.close();
                }
                this.watcher = null;
                console.error('[KnowledgeBase] 🛑 File watcher stopped to prevent retry storms against a corrupt SQLite database.');
            }
        } catch (watchErr) {
            console.warn(`[KnowledgeBase] ⚠️ Failed to stop watcher after SQLite corruption: ${watchErr.message}`);
        }
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
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
        return this.rustWriteLease &&
            now - this.rustWriteLease.startedAt > (this.rustWriteLease.ttlMs || this.config.rustWriteLeaseTtlMs);
    }

    _canGrantRustWriteLease(options = {}) {
        if (this.databaseCorruptionDetected || this.dbHealthState === 'corrupt') return { ok: false, reason: 'database-corruption' };
        if (this.dbHealthState !== 'healthy') return { ok: false, reason: `database-${this.dbHealthState}` };

        const now = Date.now();
        if (this.startupCompletedAt > 0) {
            const sinceStartupReady = now - this.startupCompletedAt;
            if (sinceStartupReady < this.config.derivedStartupCooldownMs) {
                return { ok: false, reason: `startup-cooldown:${this.config.derivedStartupCooldownMs - sinceStartupReady}ms` };
            }
        }
        if (this._isRustWriteLeaseExpired(now)) {
            console.error(
                `[KnowledgeBase] 🚨 Rust write lease "${this.rustWriteLease.owner}" exceeded TTL; force-releasing stale lease.`
            );
            this.rustWriteLease = null;
            this.lastRustWriteFinishedAt = now;
        }

        if (this.rustWriteLease) return { ok: false, reason: `rust-lease-active:${this.rustWriteLease.owner}` };
        if (this.isProcessing) return { ok: false, reason: 'js-batch-processing' };
        if (this.isProcessingDeletes) return { ok: false, reason: 'js-delete-processing' };
        if (this.pendingDeletes.size > 0) return { ok: false, reason: `pending-deletes:${this.pendingDeletes.size}` };

        const threshold = options.pendingThreshold ?? this.config.rustWriteLeasePendingThreshold;
        if (threshold >= 0 && this.pendingFiles.size > threshold) {
            return { ok: false, reason: `pending-files:${this.pendingFiles.size}>${threshold}` };
        }

        const graceMs = options.graceMs ?? this.config.rustWriteLeaseGraceMs;
        const sinceJsWrite = now - this.lastJsWriteFinishedAt;
        if (this.lastJsWriteFinishedAt > 0 && sinceJsWrite < graceMs) {
            return { ok: false, reason: `js-write-cooldown:${graceMs - sinceJsWrite}ms` };
        }

        const sinceRustWrite = now - this.lastRustWriteFinishedAt;
        if (this.lastRustWriteFinishedAt > 0 && sinceRustWrite < this.config.rustWriteLeaseCooldownMs) {
            return { ok: false, reason: `rust-write-cooldown:${this.config.rustWriteLeaseCooldownMs - sinceRustWrite}ms` };
        }

        return { ok: true, reason: 'ok' };
    }

    async requestRustWriteLease(owner, options = {}) {
        const startedWaitAt = Date.now();
        const retryMs = options.retryMs ?? this.config.rustWriteLeaseRetryMs;
        const maxWaitMs = options.maxWaitMs ?? this.config.rustWriteLeaseMaxWaitMs;
        const ttlMs = options.ttlMs ?? this.config.rustWriteLeaseTtlMs;

        while (true) {
            const decision = this._canGrantRustWriteLease(options);
            if (decision.ok) {
                if (this.config.rustWriteLeaseCheckpointBeforeGrant) {
                    const healthy = this.checkpointAndAssertDatabaseHealthy(`granting Rust lease "${owner}"`);
                    if (!healthy) {
                        console.error(`[KnowledgeBase] 🦀🚫 Rust SQLite write lease "${owner}" denied because database health check failed.`);
                        return null;
                    }
                }

                this.rustWriteLease = {
                    owner,
                    startedAt: Date.now(),
                    ttlMs
                };
                console.log(`[KnowledgeBase] 🦀🔐 Rust SQLite write lease granted to "${owner}".`);
                return {
                    owner,
                    release: () => this.releaseRustWriteLease(owner)
                };
            }

            if (Date.now() - startedWaitAt >= maxWaitMs) {
                console.warn(
                    `[KnowledgeBase] 🦀⏳ Rust SQLite write lease "${owner}" timed out after ${maxWaitMs}ms; last reason=${decision.reason}.`
                );
                return null;
            }

            const now = Date.now();
            if (now - this._rustLeaseWaitLogAt > 30000) {
                this._rustLeaseWaitLogAt = now;
                console.log(
                    `[KnowledgeBase] 🦀⏳ Rust SQLite write lease "${owner}" waiting: ${decision.reason}. ` +
                    `pendingFiles=${this.pendingFiles.size}, pendingDeletes=${this.pendingDeletes.size}`
                );
            }

            await this._delay(retryMs);
        }
    }

    releaseRustWriteLease(owner) {
        if (!this.rustWriteLease) return;
        if (this.rustWriteLease.owner !== owner) {
            console.warn(
                `[KnowledgeBase] ⚠️ Ignored Rust write lease release from "${owner}"; active owner is "${this.rustWriteLease.owner}".`
            );
            return;
        }

        this.rustWriteLease = null;
        this.lastRustWriteFinishedAt = Date.now();
        console.log(`[KnowledgeBase] 🦀🔓 Rust SQLite write lease released by "${owner}".`);

        if (!this.databaseCorruptionDetected) {
            if (this.pendingDeletes.size > 0) {
                setTimeout(() => this._flushDeleteBatch(), this.config.rustWriteLeaseCooldownMs);
            }
            if (this.pendingFiles.size > 0) {
                setTimeout(() => this._flushBatch(), this.config.rustWriteLeaseCooldownMs);
            }
        }
    }

    _deferBatchForRustLease(type = 'batch') {
        const owner = this.rustWriteLease?.owner || 'unknown';
        const delay = this.config.rustWriteLeaseCooldownMs;
        console.log(`[KnowledgeBase] 🦀⏸️ Deferring ${type} while Rust SQLite write lease is active (${owner}).`);
        setTimeout(() => {
            if (type === 'delete') this._flushDeleteBatch();
            else this._flushBatch();
        }, delay);
    }

    _decodeVectorBlob(blob, dim, label = 'vector') {
        if (blob instanceof Float32Array) {
            return blob.length === dim ? blob : null;
        }
        if (!blob || typeof blob.length !== 'number') {
            return null;
        }

        const expectedBytes = dim * Float32Array.BYTES_PER_ELEMENT;
        if (blob.length !== expectedBytes) {
            console.warn(`[KnowledgeBase] ⚠️ Invalid ${label} blob length: expected ${expectedBytes}, got ${blob.length}`);
            return null;
        }

        if (blob.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
            return new Float32Array(blob.buffer, blob.byteOffset, dim);
        }

        const copied = Buffer.from(blob);
        return new Float32Array(copied.buffer, copied.byteOffset, dim);
    }

    _queryByChunks(sqlPrefix, values, sqlSuffix = '', chunkSize = 500) {
        if (!Array.isArray(values) || values.length === 0) return [];
        const rows = [];

        for (let i = 0; i < values.length; i += chunkSize) {
            const batch = values.slice(i, i + chunkSize);
            const placeholders = batch.map(() => '?').join(',');
            rows.push(...this.db.prepare(`${sqlPrefix} IN (${placeholders})${sqlSuffix}`).all(...batch));
        }

        return rows;
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
        const shouldPersist = this.config.persistDefault || this.config.persistFolders.has(diaryName) || diaryName.endsWith('簇');
        if (!shouldPersist) return;

        const safeName = crypto.createHash('md5').update(diaryName).digest('hex');
        const idxPath = path.join(this.config.storePath, `index_diary_${safeName}.usearch`);
        const tmpPath = `${idxPath}.tmp`;

        try {
            if (fsSync.existsSync(idxPath)) {
                fsSync.unlinkSync(idxPath);
                console.warn(`[KnowledgeBase] 🧹 Removed stale persisted index for diary "${diaryName}". It will be rebuilt from SQLite.`);
            }
            if (fsSync.existsSync(tmpPath)) fsSync.unlinkSync(tmpPath);
        } catch (e) {
            console.warn(`[KnowledgeBase] ⚠️ Failed to remove stale persisted index for "${diaryName}": ${e.message}`);
        }
    }

    _deleteAllPersistedDiaryIndexes() {
        try {
            const files = fsSync.readdirSync(this.config.storePath);
            for (const file of files) {
                if (!/^index_diary_[a-f0-9]{32}\.usearch(?:\.tmp)?$/i.test(file)) continue;
                fsSync.unlinkSync(path.join(this.config.storePath, file));
            }
            console.warn('[KnowledgeBase] 🧹 Removed all persisted diary indexes because orphan chunks had lost diary ownership metadata.');
        } catch (e) {
            console.warn(`[KnowledgeBase] ⚠️ Failed to remove all persisted diary indexes: ${e.message}`);
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
                console.log(`[KnowledgeBase] Index file not found for ${fileName}, rebuilding from SQLite when possible.`);
                idx = new VexusIndex(this.config.dimension, capacity);
                if (filterDiaryName) {
                    await this._recoverIndexFromDB(idx, tableType, filterDiaryName);
                }
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

    async search(arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
        try {
            let diaryName = null;
            let queryVec = null;
            let k = 5;
            let tagBoost = 0;
            let coreTags = [];
            let coreBoostFactor = 1.33; // 默认 33% 提升
            let options = null; // 🌟 V8: 扩展选项（geodesicRerank 等）

            if (typeof arg1 === 'string' && Array.isArray(arg2)) {
                diaryName = arg1;
                queryVec = arg2;
                k = arg3 || 5;
                tagBoost = arg4 || 0;
                coreTags = arg5 || [];

                // 🌟 Wave v8: 解析 tagBoost 增强语法 (兼容字符串 "0.6+")
                if (typeof tagBoost === 'string' && tagBoost.endsWith('+')) {
                    tagBoost = parseFloat(tagBoost.slice(0, -1)) || 0;
                    if (!options) options = {};
                    options.geodesicRerank = true;
                } else {
                    tagBoost = parseFloat(tagBoost) || 0;
                }

                // 🌟 V8: arg6 可以是 coreBoostFactor (number) 或 options (object)
                if (typeof arg6 === 'object' && arg6 !== null && !Array.isArray(arg6)) {
                    options = { ...options, ...arg6 };
                } else {
                    coreBoostFactor = arg6 || 1.33;
                    options = (typeof arg7 === 'object' && arg7 !== null) ? { ...options, ...arg7 } : options;
                }
            } else if (typeof arg1 === 'string') {
                // 纯文本搜索暂略，通常插件会先向量化
                return [];
            } else if (Array.isArray(arg1)) {
                queryVec = arg1;
                k = arg2 || 5;
                tagBoost = arg3 || 0;

                // 🌟 Wave v8: 全局搜索路径也解析 "0.6+" 语法
                if (typeof tagBoost === 'string' && tagBoost.endsWith('+')) {
                    tagBoost = parseFloat(tagBoost.slice(0, -1)) || 0;
                    if (!options) options = {};
                    options.geodesicRerank = true;
                } else {
                    tagBoost = parseFloat(tagBoost) || 0;
                }
            }

            if (!queryVec) return [];

            if (diaryName) {
                return await this._searchSpecificIndex(diaryName, queryVec, k, tagBoost, coreTags, coreBoostFactor, options);
            } else {
                return await this._searchAllIndices(queryVec, k, tagBoost, coreTags, coreBoostFactor, options);
            }
        } catch (e) {
            console.error('[KnowledgeBase] Search Error:', e);
            return [];
        }
    }

    async _searchSpecificIndex(diaryName, vector, k, tagBoost, coreTags = [], coreBoostFactor = 1.33, options = null) {
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
        let energyField = null;

        try {
            if (tagBoost > 0 && this.tagMemoEngine) {
                // 🌟 TagMemo 逻辑回归：应用 Tag 增强 (强制使用 V6)
                const boostResult = this.tagMemoEngine.applyTagBoost(new Float32Array(vector), tagBoost, coreTags, coreBoostFactor);
                searchVecFloat = boostResult.vector;
                tagInfo = boostResult.info;
                energyField = boostResult.energyField || null;
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

        // 🌟 V8: 测地线重排（只重排，不截断）— 在 hydrate 之前执行
        // 使用查询级 energyField，避免全局 lastEnergyField 在 await 间隙被并发搜索覆盖。
        if (options?.geodesicRerank && energyField) {
            const geoConfig = this.ragParams?.KnowledgeBaseManager?.geodesicRerank || {};
            results = this.tagMemoEngine.geodesicRerank(results, {
                alpha: options.geoAlpha ?? options.alpha ?? geoConfig.alpha,
                minGeoSamples: options.minGeoSamples ?? geoConfig.minGeoSamples,
                energyField
            });
        }

        // Hydrate results
        const hydrate = this.db.prepare(`
            SELECT c.content as text, f.path as sourceFile, f.updated_at, f.id as file_id
            FROM chunks c
            JOIN files f ON c.file_id = f.id
            WHERE c.id = ?
        `);

        // 🛠️ V8.1 修复：per-chunk 标签关联（替代全局 tagInfo 覆盖）
        const hydratedResults = [];
        const fileIdsForTagLookup = new Map(); // chunkId → file_id

        for (const res of results) {
            const chunkId = Number(res.id);
            const row = hydrate.get(chunkId);
            if (!row) {
                console.warn(`[KnowledgeBase] 👻 Ghost Index detected for ID ${chunkId} in "${diaryName}". Cleaning up...`);
                if (idx.remove) idx.remove(res.id);
                continue;
            }
            fileIdsForTagLookup.set(chunkId, row.file_id);
            hydratedResults.push({
                _chunkId: chunkId,
                _fileId: row.file_id,
                text: row.text,
                score: res.score,
                original_knn_score: res.original_knn_score,
                geo_score: res.geo_score,
                normalized_geo: res.normalized_geo,
                geo_hit_count: res.geo_hit_count,
                sourceFile: path.basename(row.sourceFile),
                fullPath: row.sourceFile,
                // 🌟 V8.1: 查询级元数据保持不变
                boostFactor: tagInfo ? tagInfo.boostFactor : 0,
                tagMatchScore: tagInfo ? tagInfo.totalSpikeScore : 0,
            });
        }

        // 🌟 V8.1: 批量查询 per-chunk 真实标签
        if (hydratedResults.length > 0 && tagInfo) {
            const uniqueFileIds = [...new Set(hydratedResults.map(r => r._fileId))];
            if (uniqueFileIds.length > 0) {
                const fileTagRows = this._queryByChunks(
                    'SELECT ft.file_id, t.name FROM file_tags ft JOIN tags t ON ft.tag_id = t.id WHERE ft.file_id',
                    uniqueFileIds
                );

                // 构建 file_id → [tagName, ...] 映射
                const fileTagNameMap = new Map();
                for (const row of fileTagRows) {
                    if (!fileTagNameMap.has(row.file_id)) fileTagNameMap.set(row.file_id, []);
                    fileTagNameMap.get(row.file_id).push(row.name);
                }

                // 将查询级 coreTags 转为 Set（用于交叉匹配）
                const queryCoreTags = new Set((tagInfo.coreTagsMatched || []).map(t => t.toLowerCase()));
                const queryAllTags = new Set((tagInfo.matchedTags || []).map(t => t.toLowerCase()));

                for (const r of hydratedResults) {
                    const chunkRealTags = fileTagNameMap.get(r._fileId) || [];
                    // 🌟 V8.1: per-chunk matchedTags = 该 chunk 文件的全部真实标签
                    r.matchedTags = chunkRealTags;
                    r.tagMatchCount = chunkRealTags.length;
                    // per-chunk coreTagsMatched = 该 chunk 的标签 ∩ 查询的核心标签
                    r.coreTagsMatched = chunkRealTags.filter(t => queryCoreTags.has(t.toLowerCase()));
                }
            }
        } else {
            // 无 TagMemo 模式：标签字段为空
            for (const r of hydratedResults) {
                r.matchedTags = [];
                r.tagMatchCount = 0;
                r.coreTagsMatched = [];
            }
        }

        // 清理内部字段
        for (const r of hydratedResults) {
            delete r._chunkId;
            delete r._fileId;
        }

        return hydratedResults;
    }

    async _searchAllIndices(vector, k, tagBoost, coreTags = [], coreBoostFactor = 1.33, options = null) {
        // 优化2：使用 Promise.all 并行搜索
        let searchVecFloat;
        let tagInfo = null;
        let energyField = null;

        if (tagBoost > 0 && this.tagMemoEngine) {
            const boostResult = this.tagMemoEngine.applyTagBoost(new Float32Array(vector), tagBoost, coreTags, coreBoostFactor);
            searchVecFloat = boostResult.vector;
            tagInfo = boostResult.info;
            energyField = boostResult.energyField || null;
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

        // 🌟 V8: 测地线重排（只重排，不截断）— 对合并后的全局结果执行
        // 使用查询级 energyField，避免 _getOrLoadDiaryIndex / Promise.all 期间并发搜索覆盖 lastEnergyField。
        if (options?.geodesicRerank && energyField) {
            const geoConfig = this.ragParams?.KnowledgeBaseManager?.geodesicRerank || {};
            allResults = this.tagMemoEngine.geodesicRerank(allResults, {
                alpha: options.geoAlpha ?? options.alpha ?? geoConfig.alpha,
                minGeoSamples: options.minGeoSamples ?? geoConfig.minGeoSamples,
                energyField
            });
        }

        const topK = allResults.slice(0, k);

        const hydrate = this.db.prepare(`
            SELECT c.content as text, f.path as sourceFile, f.id as file_id
            FROM chunks c JOIN files f ON c.file_id = f.id WHERE c.id = ?
        `);

        // 🛠️ V8.1 修复：per-chunk 标签关联（与 _searchSpecificIndex 对称）
        const hydratedResults = [];
        for (const res of topK) {
            const chunkId = Number(res.id);
            const row = hydrate.get(chunkId);
            if (!row) continue;
            hydratedResults.push({
                _fileId: row.file_id,
                text: row.text,
                score: res.score,
                sourceFile: path.basename(row.sourceFile),
                boostFactor: tagInfo ? tagInfo.boostFactor : 0,
                tagMatchScore: tagInfo ? tagInfo.totalSpikeScore : 0,
            });
        }

        // 🌟 V8.1: 批量查询 per-chunk 真实标签
        if (hydratedResults.length > 0 && tagInfo) {
            const uniqueFileIds = [...new Set(hydratedResults.map(r => r._fileId))];
            if (uniqueFileIds.length > 0) {
                const fileTagRows = this._queryByChunks(
                    'SELECT ft.file_id, t.name FROM file_tags ft JOIN tags t ON ft.tag_id = t.id WHERE ft.file_id',
                    uniqueFileIds
                );

                const fileTagNameMap = new Map();
                for (const row of fileTagRows) {
                    if (!fileTagNameMap.has(row.file_id)) fileTagNameMap.set(row.file_id, []);
                    fileTagNameMap.get(row.file_id).push(row.name);
                }

                const queryCoreTags = new Set((tagInfo.coreTagsMatched || []).map(t => t.toLowerCase()));
                const queryAllTags = new Set((tagInfo.matchedTags || []).map(t => t.toLowerCase()));

                for (const r of hydratedResults) {
                    const chunkRealTags = fileTagNameMap.get(r._fileId) || [];
                    // 🌟 V8.1: per-chunk matchedTags = 该 chunk 文件的全部真实标签
                    r.matchedTags = chunkRealTags;
                    r.tagMatchCount = chunkRealTags.length;
                    r.coreTagsMatched = chunkRealTags.filter(t => queryCoreTags.has(t.toLowerCase()));
                }
            }
        } else {
            for (const r of hydratedResults) {
                r.matchedTags = [];
                r.tagMatchCount = 0;
                r.coreTagsMatched = [];
            }
        }

        for (const r of hydratedResults) { delete r._fileId; }
        return hydratedResults;
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
     * 🌟 V8: 公共接口 — 测地线重排
     * 代理到 TagMemoEngine.geodesicRerank()，供外部直接调用或测试
     * @param {Array} candidates - 候选结果
     * @param {object} options - { alpha, minGeoSamples }
     * @returns {Array} 重排后的结果
     */
    geodesicRerank(candidates, options = {}) {
        if (!this.tagMemoEngine) return candidates;
        const geoConfig = this.ragParams?.KnowledgeBaseManager?.geodesicRerank || {};
        return this.tagMemoEngine.geodesicRerank(candidates, {
            alpha: options.alpha ?? options.geoAlpha ?? geoConfig.alpha,
            minGeoSamples: options.minGeoSamples ?? geoConfig.minGeoSamples,
            energyField: options.energyField
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
                const decoded = this._decodeVectorBlob(row.vector, this.config.dimension, `diary_name:${diaryName}`);
                if (decoded) {
                    const vec = Array.from(decoded);
                    this.diaryNameVectorCache.set(diaryName, vec);
                    return vec;
                }
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
            const decoded = this._decodeVectorBlob(row.vector, this.config.dimension, row.key);
            if (decoded) {
                const vec = Array.from(decoded);
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
            const decoded = this._decodeVectorBlob(row.vector, this.config.dimension, 'chunk:content_lookup');
            return decoded ? Array.from(decoded) : null;
        }
        return null;
    }

    /**
     * 🛡️ 启动全量扫描补洞：判断一个文件在 SQLite 中是否已有完整可用的 chunk 向量。
     * 旧逻辑只看 mtime/size，若上次 API 失败但 files 记录已写入，会在开机全扫时被误判为“无需处理”。
     */
    _hasCompleteStoredVectorsForFile(relPath) {
        try {
            const expectedBytes = this.config.dimension * Float32Array.BYTES_PER_ELEMENT;
            const row = this.db.prepare(`
                SELECT
                    COUNT(c.id) AS chunks,
                    SUM(CASE WHEN c.vector IS NOT NULL THEN 1 ELSE 0 END) AS vectors,
                    SUM(CASE WHEN c.vector IS NOT NULL AND length(c.vector) = ? THEN 1 ELSE 0 END) AS valid_vectors,
                    SUM(CASE WHEN c.vector IS NOT NULL AND length(c.vector) != ? THEN 1 ELSE 0 END) AS bad_vectors
                FROM files f
                LEFT JOIN chunks c ON c.file_id = f.id
                WHERE f.path = ?
                GROUP BY f.id
            `).get(expectedBytes, expectedBytes, relPath);

            if (!row) return false;
            const chunks = row.chunks || 0;
            const vectors = row.vectors || 0;
            const validVectors = row.valid_vectors || 0;
            const badVectors = row.bad_vectors || 0;

            return chunks > 0 && chunks === vectors && vectors === validVectors && badVectors === 0;
        } catch (e) {
            console.warn(`[KnowledgeBase] ⚠️ Failed to check stored vectors for "${relPath}": ${e.message}`);
            return false;
        }
    }

    _decodeReusableChunkRows(rows, expectedChunkCount, labelPrefix) {
        if (!rows || rows.length !== expectedChunkCount) return null;

        const vectors = [];
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].chunk_index !== i || !rows[i].vector) return null;

            const decoded = this._decodeVectorBlob(
                rows[i].vector,
                this.config.dimension,
                `${labelPrefix}:${i}`
            );

            if (!decoded) return null;

            // 复制一份，避免底层 SQLite Buffer 生命周期/复用导致的隐性别名问题。
            vectors.push(new Float32Array(decoded));
        }

        return vectors;
    }

    _cleanupExpiredMigrationCache(now = Date.now()) {
        try {
            const result = this.db.prepare('DELETE FROM migration_deleted_files WHERE expires_at < ?').run(now);
            if (result.changes > 0) {
                console.log(`[KnowledgeBase] 🧹 Cleaned ${result.changes} expired migration cache file tombstone(s).`);
            }
        } catch (e) {
            console.warn(`[KnowledgeBase] ⚠️ Failed to cleanup migration cache: ${e.message}`);
        }
    }

    /**
     * 🧳 文件搬家/复制优化：按 checksum 在 SQLite 中查找可复用的 chunk 向量。
     * 优先查仍存在的活文件；如果删除事件先到，再查短期 migration_deleted_* 墓碑缓存。
     * 只在 chunk 数量完全一致且所有向量维度有效时命中，避免复用半成品或旧模型残留数据。
     */
    _findReusableChunkVectors(doc) {
        try {
            if (!doc || !doc.checksum || !Array.isArray(doc.chunks) || doc.chunks.length === 0) return null;

            const candidates = this.db.prepare(`
                SELECT id, path, diary_name
                FROM files
                WHERE checksum = ?
                  AND size = ?
                  AND path != ?
                ORDER BY updated_at DESC, id DESC
                LIMIT 5
            `).all(doc.checksum, doc.size, doc.relPath);

            const getChunks = this.db.prepare(`
                SELECT chunk_index, vector
                FROM chunks
                WHERE file_id = ?
                ORDER BY chunk_index ASC
            `);

            for (const candidate of candidates) {
                const rows = getChunks.all(candidate.id);
                const vectors = this._decodeReusableChunkRows(rows, doc.chunks.length, `reuse:${candidate.path}`);

                if (vectors) {
                    console.log(`[KnowledgeBase] ♻️ Reusing ${vectors.length} cached chunk vector(s) for moved/copied file "${doc.relPath}" from live record "${candidate.path}".`);
                    return vectors;
                }
            }

            const now = Date.now();
            this._cleanupExpiredMigrationCache(now);

            const tombstones = this.db.prepare(`
                SELECT id, old_path, old_diary_name
                FROM migration_deleted_files
                WHERE checksum = ?
                  AND size = ?
                  AND old_path != ?
                  AND chunk_count = ?
                  AND expires_at >= ?
                ORDER BY deleted_at DESC, id DESC
                LIMIT 5
            `).all(doc.checksum, doc.size, doc.relPath, doc.chunks.length, now);

            if (!tombstones || tombstones.length === 0) return null;

            const getCachedChunks = this.db.prepare(`
                SELECT chunk_index, vector
                FROM migration_deleted_chunks
                WHERE cache_file_id = ?
                ORDER BY chunk_index ASC
            `);

            for (const tombstone of tombstones) {
                const rows = getCachedChunks.all(tombstone.id);
                const vectors = this._decodeReusableChunkRows(rows, doc.chunks.length, `migration:${tombstone.old_path}`);

                if (vectors) {
                    vectors._migrationCacheId = tombstone.id;
                    console.log(`[KnowledgeBase] ♻️ Reusing ${vectors.length} cached chunk vector(s) for moved file "${doc.relPath}" from recently deleted "${tombstone.old_path}".`);
                    return vectors;
                }
            }
        } catch (e) {
            console.warn(`[KnowledgeBase] ⚠️ Failed to lookup reusable vectors for "${doc?.relPath || 'unknown'}": ${e.message}`);
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
                vector: this._decodeVectorBlob(r.vector, this.config.dimension, `chunk:${r.id}`),
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
        if (this.watcher) return;

        const handleFile = (filePath) => {
            this.pendingFiles.add(filePath);
            if (this.pendingFiles.size >= this.config.maxBatchSize) {
                this._flushBatch();
            } else {
                this._scheduleBatch();
            }
        };

        const scanInitialFiles = () => {
            if (!this.config.fullScanOnStartup) return;

            let queued = 0;
            const walk = (dir) => {
                let entries;
                try {
                    entries = fsSync.readdirSync(dir, { withFileTypes: true });
                } catch (e) {
                    console.warn(`[KnowledgeBase] Initial scan skipped unreadable directory "${dir}": ${e.message}`);
                    return;
                }

                for (const entry of entries) {
                    const absPath = path.join(dir, entry.name);
                    const relPath = path.relative(this.config.rootPath, absPath);
                    const parts = relPath.split(path.sep);
                    const diaryName = parts.length > 1 ? parts[0] : 'Root';

                    if (entry.isDirectory()) {
                        if (
                            entry.name === 'node_modules' ||
                            entry.name === '.git' ||
                            entry.name === 'dist' ||
                            entry.name === 'target' ||
                            entry.name === 'image' ||
                            entry.name.startsWith('.') ||
                            this.config.ignoreFolders.includes(entry.name) ||
                            this.config.ignoreFolders.includes(diaryName) ||
                            this.config.ignorePrefixes.some(prefix => entry.name.startsWith(prefix)) ||
                            this.config.ignoreSuffixes.some(suffix => entry.name.endsWith(suffix))
                        ) {
                            continue;
                        }
                        walk(absPath);
                        continue;
                    }

                    if (!entry.isFile()) continue;
                    if (!absPath.match(/\.(md|txt)$/i)) continue;

                    const fileName = path.basename(absPath);
                    if (this.config.ignoreFolders.includes(diaryName)) continue;
                    if (this.config.ignorePrefixes.some(prefix => diaryName.startsWith(prefix) || fileName.startsWith(prefix))) continue;
                    if (this.config.ignoreSuffixes.some(suffix => diaryName.endsWith(suffix) || fileName.endsWith(suffix))) continue;

                    handleFile(absPath);
                    queued++;
                }
            };

            walk(this.config.rootPath);
            if (queued > 0) {
                console.log(`[KnowledgeBase] 🔍 Initial full scan queued ${queued} file(s).`);
            } else {
                console.log('[KnowledgeBase] 🔍 Initial full scan found no indexable files.');
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
                    setTimeout(() => handleFileWithLock(filePath), 1000);
                }
            } catch (e) {
                if (e.code !== 'ENOENT') console.warn(`[KnowledgeBase] Stability check error:`, e.message);
            }
        };

        // 尝试加载并启动 Rust 高性能原生监听器
        if (VexusIndex && VexusIndex.prototype && typeof VexusIndex.prototype.start_watch === 'undefined') {
            // 动态获取导出的 VexusWatcher 类
            try {
                const vexusModule = require('./rust-vexus-lite');
                if (vexusModule.VexusWatcher) {
                    const rustWatcher = new vexusModule.VexusWatcher();
                    
                    const handleRustEvent = (...args) => {
                        try {
                            // napi-rs ThreadsafeFunction 在不同签名/版本下可能以
                            // (payload) 或 (error, payload) 形式调用 JS 回调。
                            // 因此这里从所有参数中选取第一个字符串作为事件载荷。
                            const jsonPayload = args.find(arg => typeof arg === 'string');
                            if (!jsonPayload) {
                                console.warn('[KnowledgeBase] Ignored Rust watcher callback without string payload:', args);
                                return;
                            }

                            const { event, path: filePath } = JSON.parse(jsonPayload);
                            if (event === 'unlink') {
                                this._queueDelete(filePath);
                            } else {
                                handleFileWithLock(filePath);
                            }
                        } catch (err) {
                            console.error('[KnowledgeBase] Failed to parse Rust watcher event:', err);
                        }
                    };

                    const startWatch = rustWatcher.startWatch || rustWatcher.start_watch;
                    if (typeof startWatch !== 'function') {
                        throw new Error('VexusWatcher startWatch/start_watch method not found');
                    }

                    startWatch.call(rustWatcher, {
                        rootPath: this.config.rootPath,
                        ignoreFolders: this.config.ignoreFolders || [],
                        ignorePrefixes: this.config.ignorePrefixes || [],
                        ignoreSuffixes: this.config.ignoreSuffixes || [],
                    }, handleRustEvent);

                    this.watcher = rustWatcher;
                    this.watcherType = 'rust';
                    console.log('[KnowledgeBase] 🦀 Using Rust native watcher.');
                    scanInitialFiles();
                    return;
                }
            } catch (e) {
                console.warn('[KnowledgeBase] ⚠️ Failed to initialize Rust Watcher, falling back to Chokidar:', e.message);
            }
        }

        // 降级方案：使用 Chokidar 监听
        console.log('[KnowledgeBase] 🔄 Using Chokidar watcher fallback...');
        const handleChokidarFile = (filePath) => {
            const relPath = path.relative(this.config.rootPath, filePath);
            const parts = relPath.split(path.sep);
            const diaryName = parts.length > 1 ? parts[0] : 'Root';

            if (this.config.ignoreFolders.includes(diaryName)) return;
            if (this.config.ignorePrefixes.some(prefix => diaryName.startsWith(prefix))) return;
            if (this.config.ignoreSuffixes.some(suffix => diaryName.endsWith(suffix))) return;
            const fileName = path.basename(relPath);
            if (this.config.ignorePrefixes.some(prefix => fileName.startsWith(prefix))) return;
            if (this.config.ignoreSuffixes.some(suffix => fileName.endsWith(suffix))) return;
            if (!filePath.match(/\.(md|txt)$/i)) return;

            handleFileWithLock(filePath);
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
        this.watcher.on('add', handleChokidarFile).on('change', handleChokidarFile).on('unlink', fp => this._queueDelete(fp));
        this.watcherType = 'chokidar';
    }

    _queueDelete(filePath) {
        this.pendingDeletes.add(filePath);
        if (this.pendingDeletes.size >= this.config.maxDeleteBatchSize) {
            this._flushDeleteBatch();
        } else {
            this._scheduleDeleteBatch();
        }
    }

    _scheduleDeleteBatch() {
        if (this.deleteBatchTimer) clearTimeout(this.deleteBatchTimer);
        this.deleteBatchTimer = setTimeout(() => this._flushDeleteBatch(), this.config.deleteBatchWindow);
    }

    async _flushDeleteBatch() {
        if (this.isProcessingDeletes || this.pendingDeletes.size === 0 || this.databaseCorruptionDetected) return;
        if (this.rustWriteLease) {
            this._deferBatchForRustLease('delete');
            return;
        }
        this.isProcessingDeletes = true;

        const batchFiles = Array.from(this.pendingDeletes).slice(0, this.config.maxDeleteBatchSize);
        if (this.deleteBatchTimer) {
            clearTimeout(this.deleteBatchTimer);
            this.deleteBatchTimer = null;
        }

        try {
            await this._handleDeleteBatch(batchFiles);
            batchFiles.forEach(f => this.pendingDeletes.delete(f));
        } catch (e) {
            console.error('[KnowledgeBase] ❌ Delete batch failed:', e);
            if (this._isSqliteCorruptionError(e)) {
                await this._handleRuntimeSqliteCorruption(e, []);
            }
        } finally {
            this.isProcessingDeletes = false;
            this.lastJsWriteFinishedAt = Date.now();
            if (!this.databaseCorruptionDetected && this.pendingDeletes.size > 0) {
                setImmediate(() => this._flushDeleteBatch());
            }
        }
    }

    _scheduleBatch() {
        if (this.batchTimer) clearTimeout(this.batchTimer);
        this.batchTimer = setTimeout(() => this._flushBatch(), this.config.batchWindow);
    }

    async _flushBatch() {
        if (this.isProcessing || this.pendingFiles.size === 0) return;
        if (this.rustWriteLease) {
            this._deferBatchForRustLease('batch');
            return;
        }
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
                    if (row && row.mtime === stats.mtimeMs && row.size === stats.size && this._hasCompleteStoredVectorsForFile(relPath)) return;

                    const content = await fs.readFile(filePath, 'utf-8');
                    const checksum = crypto.createHash('md5').update(content).digest('hex');

                    if (row && row.checksum === checksum && this._hasCompleteStoredVectorsForFile(relPath)) {
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

            let reusedChunkVectorCount = 0;
            for (const [dName, docs] of docsByDiary) {
                docs.forEach((doc, dIdx) => {
                    const validChunks = doc.chunks.map(c => this._prepareTextForEmbedding(c)).filter(c => c !== '[EMPTY_CONTENT]');
                    doc.chunks = validChunks;

                    const reusableVectors = this._findReusableChunkVectors(doc);
                    if (reusableVectors) {
                        doc.reusedChunkVectors = reusableVectors;
                        doc.migrationCacheId = reusableVectors._migrationCacheId || null;
                        reusedChunkVectorCount += reusableVectors.length;
                    } else {
                        validChunks.forEach((txt, cIdx) => {
                            allChunksWithMeta.push({ text: txt, diaryName: dName, doc: doc, chunkIdx: cIdx });
                        });
                    }

                    doc.tags.forEach(t => uniqueTags.add(t));
                });
            }

            if (reusedChunkVectorCount > 0) {
                console.log(`[KnowledgeBase] ♻️ Reused ${reusedChunkVectorCount} chunk vector(s) from SQLite cache; skipped embedding for matching moved/copied content.`);
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
                // 🌟 V8.2: 向量更新失效钩子 — tag 向量被(重)写入时，删除涉及该 tag 的 sim 行，
                // 由 Rust 增量补回，防止陈旧缓存污染。
                const invalidatePairSim = this.db.prepare(
                    'DELETE FROM tag_pair_similarity WHERE tag_a = ? OR tag_b = ?'
                );
                const invalidateIntrinsicResidual = this.db.prepare(
                    'DELETE FROM tag_intrinsic_residuals WHERE tag_id = ?'
                );

                newTags.forEach((t, i) => {
                    if (!tagVectors[i]) return; // 🛡️ 跳过向量化失败的 tag
                    const vecFloat = new Float32Array(tagVectors[i]);
                    const vecBuf = Buffer.from(vecFloat.buffer, vecFloat.byteOffset, vecFloat.byteLength);
                    insertTag.run(t, vecBuf);
                    const id = getTagId.get(t).id;
                    tagCache.set(t, { id, vector: vecBuf });
                    tagUpdates.push({ id, vec: vecFloat });
                    // 失效旧的 pairwise similarity / intrinsic residual 记录
                    invalidatePairSim.run(id, id);
                    invalidateIntrinsicResidual.run(id);
                });

                const insertFile = this.db.prepare('INSERT INTO files (path, diary_name, checksum, mtime, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
                const updateFile = this.db.prepare('UPDATE files SET checksum = ?, mtime = ?, size = ?, updated_at = ?, diary_name = ? WHERE id = ?');
                const getFile = this.db.prepare('SELECT id, diary_name FROM files WHERE path = ?');
                const getOldChunkIds = this.db.prepare('SELECT id FROM chunks WHERE file_id = ?'); // 💡 新增
                const delChunks = this.db.prepare('DELETE FROM chunks WHERE file_id = ?');
                const delRels = this.db.prepare('DELETE FROM file_tags WHERE file_id = ?');
                const addChunk = this.db.prepare('INSERT INTO chunks (file_id, chunk_index, content, vector) VALUES (?, ?, ?, ?)');
                const addRel = this.db.prepare('INSERT OR IGNORE INTO file_tags (file_id, tag_id, position) VALUES (?, ?, ?)');
                const consumeMigrationCache = this.db.prepare('DELETE FROM migration_deleted_files WHERE id = ?');

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

                            if (fRow.diary_name !== doc.diaryName) {
                                if (!deletions.has(fRow.diary_name)) deletions.set(fRow.diary_name, []);
                                deletions.get(fRow.diary_name).push(...oldChunkIds);
                            }

                            updateFile.run(doc.checksum, doc.mtime, doc.size, now, doc.diaryName, fileId);
                            delChunks.run(fileId);
                            delRels.run(fileId);
                        } else {
                            const res = insertFile.run(doc.relPath, doc.diaryName, doc.checksum, doc.mtime, doc.size, now);
                            fileId = res.lastInsertRowid;
                        }

                        doc.chunks.forEach((txt, i) => {
                            const meta = metaMap.get(`${doc.relPath}:${i}`);
                            const vectorSource = doc.reusedChunkVectors?.[i] || meta?.vector;
                            if (vectorSource) { // 🛡️ null 向量的 chunk 自然被跳过，不会写入错误数据
                                const vecFloat = vectorSource instanceof Float32Array ? vectorSource : new Float32Array(vectorSource);
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

                        if (doc.migrationCacheId) {
                            consumeMigrationCache.run(doc.migrationCacheId);
                        }
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
                        chunkIds.forEach(id => {
                            try {
                                idx.remove(id);
                            } catch (e) {
                                // usearch 对不存在的 id 可能抛错；删除路径必须保持幂等，避免批处理重试循环。
                                if (e.message && !/not found|missing|absent/i.test(e.message)) {
                                    console.warn(`[KnowledgeBase] ⚠️ Failed to remove stale vector ${id} from "${dName}": ${e.message}`);
                                }
                            }
                        });
                        this._scheduleIndexSave(dName);
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

            if (this._isSqliteCorruptionError(e)) {
                await this._handleRuntimeSqliteCorruption(e, batchFiles);
            } else {
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
        }
        finally {
            this.isProcessing = false;
            this.lastJsWriteFinishedAt = Date.now();
            if (!this.databaseCorruptionDetected && this.pendingFiles.size > 0) setImmediate(() => this._flushBatch());
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
        await this._handleDeleteBatch([filePath]);
    }

    async _handleDeleteBatch(filePaths) {
        const relPaths = [...new Set(filePaths.map(filePath => path.relative(this.config.rootPath, filePath)))];
        if (relPaths.length === 0) return;

        try {
            const rows = this._queryByChunks(
                'SELECT id, path, diary_name, checksum, size FROM files WHERE path',
                relPaths
            );
            if (rows.length === 0) return;

            const fileIds = rows.map(row => row.id);
            const diaryByFileId = new Map(rows.map(row => [row.id, row.diary_name]));
            const chunkRows = this._queryByChunks(
                'SELECT c.id, c.file_id, c.chunk_index, c.vector, f.diary_name FROM chunks c JOIN files f ON c.file_id = f.id WHERE c.file_id',
                fileIds
            );

            const chunkIdsByDiary = new Map();
            for (const row of chunkRows) {
                const diaryName = row.diary_name || diaryByFileId.get(row.file_id);
                if (!diaryName) continue;
                if (!chunkIdsByDiary.has(diaryName)) chunkIdsByDiary.set(diaryName, []);
                chunkIdsByDiary.get(diaryName).push(row.id);
            }

            const deleteTransaction = this.db.transaction(() => {
                const nowMs = Date.now();
                const expiresAt = nowMs + this.config.migrationCacheTtlMs;
                const insertMigrationFile = this.db.prepare(`
                    INSERT INTO migration_deleted_files
                    (old_path, old_diary_name, checksum, size, chunk_count, deleted_at, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `);
                const insertMigrationChunk = this.db.prepare(`
                    INSERT INTO migration_deleted_chunks (cache_file_id, chunk_index, vector)
                    VALUES (?, ?, ?)
                `);

                for (const row of rows) {
                    const chunks = chunkRows
                        .filter(c => c.file_id === row.id && c.vector)
                        .sort((a, b) => a.chunk_index - b.chunk_index);

                    if (chunks.length === 0) continue;
                    const cacheRes = insertMigrationFile.run(
                        row.path,
                        row.diary_name,
                        row.checksum,
                        row.size,
                        chunks.length,
                        nowMs,
                        expiresAt
                    );

                    for (const chunk of chunks) {
                        insertMigrationChunk.run(cacheRes.lastInsertRowid, chunk.chunk_index, chunk.vector);
                    }
                }

                const deleteFileTags = (ids) => {
                    if (ids.length === 0) return;
                    const placeholders = ids.map(() => '?').join(',');
                    this.db.prepare(`DELETE FROM file_tags WHERE file_id IN (${placeholders})`).run(...ids);
                };
                const deleteChunks = (ids) => {
                    if (ids.length === 0) return;
                    const placeholders = ids.map(() => '?').join(',');
                    this.db.prepare(`DELETE FROM chunks WHERE file_id IN (${placeholders})`).run(...ids);
                };
                const deleteFiles = (ids) => {
                    if (ids.length === 0) return;
                    const placeholders = ids.map(() => '?').join(',');
                    this.db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...ids);
                };

                for (let i = 0; i < fileIds.length; i += 500) {
                    const batch = fileIds.slice(i, i + 500);
                    // 🛡️ 不依赖 SQLite 外键级联：历史数据库/连接若未开启 foreign_keys，会留下 file_tags/chunks 垃圾。
                    deleteFileTags(batch);
                    deleteChunks(batch);
                    deleteFiles(batch);
                }
            });
            deleteTransaction();

            let totalChunks = 0;
            for (const chunkIds of chunkIdsByDiary.values()) totalChunks += chunkIds.length;

            if (rows.length > 1) {
                console.warn(`[KnowledgeBase] 🧹 Batched delete removed ${rows.length} file record(s), ${totalChunks} chunk vector(s).`);
            }

            for (const [diaryName, chunkIds] of chunkIdsByDiary) {
                if (chunkIds.length >= this.config.deleteRebuildThreshold) {
                    // 大目录删除时逐个 remove 上万向量会长时间阻塞事件循环；直接丢弃该日记索引，后续从 SQLite 干净重建。
                    this.diaryIndices.delete(diaryName);
                    this.diaryIndexLastUsed.delete(diaryName);
                    this._deletePersistedDiaryIndex(diaryName);
                    console.warn(
                        `[KnowledgeBase] 🧹 Large delete in "${diaryName}" (${chunkIds.length} vectors). ` +
                        'Dropped in-memory/persisted diary index; it will be rebuilt from SQLite on next search.'
                    );
                    continue;
                }

                const idx = await this._getOrLoadDiaryIndex(diaryName);
                if (idx && idx.remove) {
                    chunkIds.forEach(id => {
                        try {
                            idx.remove(id);
                        } catch (e) {
                            // 删除事件可能乱序/重复；向量不存在不应导致错误风暴或后续处理停滞。
                            if (e.message && !/not found|missing|absent/i.test(e.message)) {
                                console.warn(`[KnowledgeBase] ⚠️ Failed to remove vector ${id} from "${diaryName}": ${e.message}`);
                            }
                        }
                    });
                    this._scheduleIndexSave(diaryName);
                }
            }
        } catch (e) {
            console.error(`[KnowledgeBase] Delete error:`, e);
            if (this._isSqliteCorruptionError(e)) throw e;
        }
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
            console.log(`[KnowledgeBase] 💾 Save timer fired: ${name}`);
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
        const startedAt = Date.now();
        try {
            if (name === 'global_tags') {
                let stats = null;
                try { stats = this.tagIndex?.stats ? this.tagIndex.stats() : null; } catch (_) { }
                console.log(`[KnowledgeBase] 💾 Saving index start: ${name}, vectors=${stats?.totalVectors ?? 'unknown'}`);
                if (this.tagIndex) this.tagIndex.save(path.join(this.config.storePath, 'index_global_tags.usearch'));
            } else {
                const safeName = crypto.createHash('md5').update(name).digest('hex');
                const idx = this.diaryIndices.get(name);
                if (idx && idx.save) {
                    let stats = null;
                    try { stats = idx.stats ? idx.stats() : null; } catch (_) { }
                    console.log(`[KnowledgeBase] 💾 Saving index start: ${name}, vectors=${stats?.totalVectors ?? 'unknown'}`);
                    idx.save(path.join(this.config.storePath, `index_diary_${safeName}.usearch`));
                }
            }
            const elapsed = Date.now() - startedAt;
            console.log(`[KnowledgeBase] 💾 Saved index: ${name}, elapsed=${elapsed}ms`);
            if (elapsed > 5000) {
                console.warn(`[KnowledgeBase] 🧯 Slow synchronous index save detected: ${name}, elapsed=${elapsed}ms`);
            }
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
        const sweepStartedAt = Date.now();
        const now = Date.now();
        const ttl = this.config.indexIdleTTL;
        let evictedCount = 0;
        if (this.config.idleSweepLogTick && this.diaryIndexLastUsed.size > 0) {
            console.debug(`[KnowledgeBase] 🧹 Idle sweep tick: tracked=${this.diaryIndexLastUsed.size}, loaded=${this.diaryIndices.size}`);
        }

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
            console.log(`[KnowledgeBase] 🧹 Idle sweep complete: evicted ${evictedCount} index(es), ${this.diaryIndices.size} remaining in memory, elapsed=${Date.now() - sweepStartedAt}ms.`);
        }
    }

    async shutdown() {
        console.log('[KnowledgeBase] shutting down...');
        if (this.watcher) {
            if (this.watcherType === 'rust') {
                const stopWatch = this.watcher.stopWatch || this.watcher.stop_watch;
                if (typeof stopWatch === 'function') {
                    stopWatch.call(this.watcher);
                }
            } else if (typeof this.watcher.close === 'function') {
                await this.watcher.close();
            }
            this.watcher = null;
        }
        if (this.ragParamsWatcher) {
            this.ragParamsWatcher.close();
            this.ragParamsWatcher = null;
        }
        if (this.deleteBatchTimer) {
            clearTimeout(this.deleteBatchTimer);
            this.deleteBatchTimer = null;
        }
        if (this.pendingDeletes.size > 0 && !this.databaseCorruptionDetected) {
            await this._flushDeleteBatch();
        }

        // 🌟 停止空闲扫描
        if (this.idleSweepTimer) {
            clearInterval(this.idleSweepTimer);
            this.idleSweepTimer = null;
        }

        if (this.eventLoopWatchdogTimer) {
            clearInterval(this.eventLoopWatchdogTimer);
            this.eventLoopWatchdogTimer = null;
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