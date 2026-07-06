// TDBKnowledge.js
// 冷知识库管理器：面向 knowledge/ 下低频变动、大规模资料库的 TriviumDB 入库与检索层。

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const chokidar = require('chokidar');
const { chunkText } = require('./TextChunker');
const { getEmbeddingsBatch } = require('./EmbeddingUtils');

let TriviumDB = null;
try {
    const triviumModule = require('triviumdb');
    TriviumDB = triviumModule.TriviumDB || triviumModule.default || triviumModule;
    console.log('[TDBKnowledge] 🧊 TriviumDB module loaded.');
} catch (e) {
    console.warn('[TDBKnowledge] ⚠️ TriviumDB module not found. Cold knowledge DB will stay disabled until installed.');
}

let VexusWatcher = null;
try {
    const vexusModule = require('./rust-vexus-lite');
    VexusWatcher = vexusModule.VexusWatcher || null;
} catch (e) {
    VexusWatcher = null;
}

function splitList(value, fallback = []) {
    const raw = value == null || value === '' ? fallback.join(',') : String(value);
    return raw.split(/[,，]/).map(v => v.trim()).filter(Boolean);
}

function normalizeExt(ext) {
    const lowered = String(ext || '').trim().toLowerCase();
    if (!lowered) return '';
    return lowered.startsWith('.') ? lowered : `.${lowered}`;
}

function safeLibraryName(name) {
    return String(name || 'Root').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'Root';
}

class TDBKnowledgeManager {
    constructor(config = {}) {
        const configuredRootPath = config.rootPath || process.env.TDB_KNOWLEDGE_ROOT_PATH || path.join(__dirname, 'knowledge');
        const configuredStorePath = config.storePath || process.env.TDB_KNOWLEDGE_STORE_PATH || path.join(__dirname, 'VectorStoreTDB');

        this.config = {
            enabled: (process.env.TDB_KNOWLEDGE_ENABLED || 'false').toLowerCase() === 'true',
            rootPath: path.resolve(configuredRootPath),
            storePath: path.resolve(configuredStorePath),
            apiKey: process.env.API_Key,
            apiUrl: process.env.API_URL,
            model: config.model || process.env.TDB_KNOWLEDGE_MODEL || process.env.WhitelistEmbeddingModel || 'google/gemini-embedding-001',
            dimension: parseInt(config.dimension || process.env.TDB_KNOWLEDGE_DIMENSION || process.env.VECTORDB_DIMENSION, 10) || 3072,
            fullScanOnStartup: (process.env.TDB_KNOWLEDGE_FULL_SCAN_ON_STARTUP || 'true').toLowerCase() === 'true',
            batchWindow: parseInt(process.env.TDB_KNOWLEDGE_BATCH_WINDOW_MS, 10) || 3000,
            maxBatchSize: parseInt(process.env.TDB_KNOWLEDGE_MAX_BATCH_SIZE, 10) || 20,
            queuePollIntervalMs: parseInt(process.env.TDB_KNOWLEDGE_QUEUE_POLL_INTERVAL_MS, 10) || 2000,
            queueLeaseMs: parseInt(process.env.TDB_KNOWLEDGE_QUEUE_LEASE_MS, 10) || 10 * 60 * 1000,
            queueMaxRetries: parseInt(process.env.TDB_KNOWLEDGE_QUEUE_MAX_RETRIES, 10) || 5,
            embeddingBatchSize: parseInt(process.env.TDB_KNOWLEDGE_EMBEDDING_BATCH_SIZE, 10) || 16,
            flushEveryFiles: parseInt(process.env.TDB_KNOWLEDGE_FLUSH_EVERY_FILES, 10) || 10,
            buildTextIndexEveryFiles: parseInt(process.env.TDB_KNOWLEDGE_BUILD_TEXT_INDEX_EVERY_FILES, 10) || 25,
            extensions: splitList(process.env.TDB_KNOWLEDGE_EXTENSIONS, ['.md', '.txt', '.json', '.html']).map(normalizeExt).filter(Boolean),
            excludeFolders: splitList(process.env.TDB_KNOWLEDGE_EXCLUDE_FOLDERS, ['TDBdocs']),
            ignorePrefixes: splitList(process.env.TDB_KNOWLEDGE_IGNORE_PREFIXES, []),
            ignoreSuffixes: splitList(process.env.TDB_KNOWLEDGE_IGNORE_SUFFIXES, []),
            syncMode: process.env.TDB_KNOWLEDGE_SYNC_MODE || 'normal',
            idleUnloadHours: parseFloat(process.env.TDB_KNOWLEDGE_IDLE_UNLOAD_HOURS || '0') || 0,
            idleSweepIntervalMs: parseInt(process.env.TDB_KNOWLEDGE_IDLE_SWEEP_INTERVAL_MS, 10) || 15 * 60 * 1000,
            ...config
        };

        this.initialized = false;
        this.metaDb = null;
        this.libs = new Map();
        this.pendingFiles = new Set(); // 兼容旧字段：可靠队列启用后不再承载大规模扫描任务
        this.fileRetryCount = new Map(); // 兼容旧字段：重试状态已迁移到 ingest_queue
        this.batchTimer = null;
        this.queueTimer = null;
        this.isProcessing = false;
        this.isQueueWorkerRunning = false;
        this.processedSinceFlush = 0;
        this.processedSinceTextIndexBuild = 0;
        this.watcher = null;
        this.watcherType = null;
        this.safetyWatcher = null;
        this.idleEvictor = null;
        this.libraryQueues = new Map();
        this.fileEventVersions = new Map();
        this.pendingFileVersions = new Map();
    }

    async initialize() {
        if (this.initialized) return;
        if (!this.config.enabled) {
            console.log('[TDBKnowledge] Disabled by TDB_KNOWLEDGE_ENABLED=false.');
            return;
        }
        if (!TriviumDB) {
            console.warn('[TDBKnowledge] Disabled because triviumdb package is unavailable.');
            return;
        }

        await fs.mkdir(this.config.rootPath, { recursive: true });
        await fs.mkdir(this.config.storePath, { recursive: true });

        const metaPath = path.join(this.config.storePath, 'tdb_knowledge_meta.sqlite');
        this.metaDb = new Database(metaPath);
        this.metaDb.pragma('journal_mode = WAL');
        this.metaDb.pragma('synchronous = NORMAL');
        this._initSchema();
        this._recoverStaleQueueJobs();

        this._startWatcher();
        if (this.config.fullScanOnStartup) this._scanInitialFiles();
        this._startQueueWorker();
        this._startIdleEvictor();

        this.initialized = true;
        console.log(`[TDBKnowledge] ✅ Ready. root=${this.config.rootPath}, dim=${this.config.dimension}`);
    }

    _initSchema() {
        this.metaDb.exec(`
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                library TEXT NOT NULL,
                path TEXT NOT NULL,
                checksum TEXT NOT NULL,
                mtime REAL NOT NULL,
                size INTEGER NOT NULL,
                doc_node_id INTEGER,
                updated_at INTEGER NOT NULL,
                UNIQUE(library, path)
            );
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                library TEXT NOT NULL,
                path TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                node_id INTEGER NOT NULL,
                checksum TEXT NOT NULL,
                UNIQUE(library, path, chunk_index)
            );
            CREATE TABLE IF NOT EXISTS ingest_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL DEFAULT 'upsert',
                library TEXT NOT NULL,
                path TEXT NOT NULL,
                abs_path TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                priority INTEGER NOT NULL DEFAULT 0,
                retry_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                locked_at INTEGER,
                next_attempt_at INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(action, library, path)
            );
            CREATE INDEX IF NOT EXISTS idx_tdb_files_library ON files(library);
            CREATE INDEX IF NOT EXISTS idx_tdb_chunks_file ON chunks(library, path);
            CREATE INDEX IF NOT EXISTS idx_tdb_chunks_node ON chunks(node_id);
            CREATE INDEX IF NOT EXISTS idx_tdb_ingest_queue_status ON ingest_queue(status, next_attempt_at, priority, id);
            CREATE INDEX IF NOT EXISTS idx_tdb_ingest_queue_file ON ingest_queue(library, path);
        `);
    }

    _recoverStaleQueueJobs() {
        const now = Date.now();
        const staleBefore = now - this.config.queueLeaseMs;
        const result = this.metaDb.prepare(`
            UPDATE ingest_queue
            SET status = 'pending',
                locked_at = NULL,
                next_attempt_at = ?,
                updated_at = ?
            WHERE status = 'processing'
              AND (locked_at IS NULL OR locked_at < ?)
        `).run(now, now, staleBefore);
        if (result.changes > 0) {
            console.warn(`[TDBKnowledge] ♻️ Recovered ${result.changes} stale ingest job(s).`);
        }
    }

    _resolveLibrary(absPath) {
        const relPath = path.relative(this.config.rootPath, absPath);
        const parts = relPath.split(path.sep).filter(Boolean);
        const library = safeLibraryName(parts.length > 1 ? parts[0] : 'Root');
        return { library, relPath };
    }

    _isIndexable(filePath) {
        const ext = normalizeExt(path.extname(filePath));
        if (!this.config.extensions.includes(ext)) return false;

        const { library } = this._resolveLibrary(filePath);
        const fileName = path.basename(filePath);

        if (this.config.excludeFolders.includes(library)) return false;
        if (this.config.ignorePrefixes.some(prefix => library.startsWith(prefix) || fileName.startsWith(prefix))) return false;
        if (this.config.ignoreSuffixes.some(suffix => library.endsWith(suffix) || fileName.endsWith(suffix))) return false;

        return true;
    }

    _getDbPath(library) {
        const safeName = safeLibraryName(library);
        return path.join(this.config.storePath, `${safeName}.tdb`);
    }

    getOrOpenLibrary(library) {
        const safeName = safeLibraryName(library);
        if (this.libs.has(safeName)) {
            const existing = this.libs.get(safeName);
            existing.lastUsedAt = Date.now();
            return existing;
        }

        const dbPath = this._getDbPath(safeName);
        const db = this._openTriviumDb(dbPath);
        const handle = {
            name: safeName,
            path: dbPath,
            db,
            openedAt: Date.now(),
            lastUsedAt: Date.now(),
            busyCount: 0
        };
        this.libs.set(safeName, handle);
        return handle;
    }

    _beginLibraryUse(handle) {
        if (!handle) return;
        handle.busyCount = (handle.busyCount || 0) + 1;
        handle.lastUsedAt = Date.now();
    }

    _endLibraryUse(handle) {
        if (!handle) return;
        handle.busyCount = Math.max(0, (handle.busyCount || 0) - 1);
        handle.lastUsedAt = Date.now();
    }

    _withLibraryQueue(library, task) {
        const safeName = safeLibraryName(library);
        const previous = this.libraryQueues.get(safeName) || Promise.resolve();
        const run = previous.catch(() => undefined).then(task);
        this.libraryQueues.set(safeName, run.catch(() => undefined));
        return run.finally(() => {
            if (this.libraryQueues.get(safeName) === run) {
                this.libraryQueues.delete(safeName);
            }
        });
    }

    _getFileEventKey(filePath) {
        return this._normalizeFilePath(filePath);
    }

    _bumpFileEventVersion(filePath) {
        const key = this._getFileEventKey(filePath);
        const version = (this.fileEventVersions.get(key) || 0) + 1;
        this.fileEventVersions.set(key, version);
        return version;
    }

    _getFileEventVersion(filePath) {
        return this.fileEventVersions.get(this._getFileEventKey(filePath)) || 0;
    }

    _isCurrentFileEvent(filePath, eventVersion) {
        return !eventVersion || this._getFileEventVersion(filePath) === eventVersion;
    }

    async closeLibrary(library, options = {}) {
        const safeName = safeLibraryName(library);
        return this._withLibraryQueue(safeName, async () => this._closeLibraryUnlocked(safeName, options));
    }

    async _closeLibraryUnlocked(library, options = {}) {
        const safeName = safeLibraryName(library);
        const handle = this.libs.get(safeName);
        if (!handle) return false;

        if ((handle.busyCount || 0) > 0) {
            return false;
        }

        const shouldFlush = options.flush !== false;
        try {
            if (shouldFlush) this._safeFlush(handle.db);
        } catch (e) {
            console.warn(`[TDBKnowledge] Flush before close failed for "${safeName}":`, e.message);
        }

        try {
            if (typeof handle.db?.close === 'function') {
                handle.db.close();
            }
        } catch (e) {
            console.warn(`[TDBKnowledge] Close failed for "${safeName}":`, e.message);
        }

        this.libs.delete(safeName);
        console.log(`[TDBKnowledge] 💤 Closed idle library "${safeName}".`);
        return true;
    }

    _openTriviumDb(dbPath) {
        const lockPath = dbPath + '.lock';
        if (fsSync.existsSync(lockPath)) {
            console.warn(`[TDBKnowledge] ⚠️ Found TriviumDB lock, trying cleanup: ${lockPath}`);
            try {
                fsSync.unlinkSync(lockPath);
                console.log('[TDBKnowledge] 🧹 TriviumDB lock removed.');
            } catch (e) {
                console.warn(`[TDBKnowledge] Lock cleanup skipped: ${e.message}`);
            }
        }

        try {
            return new TriviumDB(dbPath, this.config.dimension, 'f32', this.config.syncMode);
        } catch (e1) {
            try {
                return new TriviumDB(dbPath, { dim: this.config.dimension, dtype: 'f32', syncMode: this.config.syncMode });
            } catch (e2) {
                try {
                    return new TriviumDB(dbPath, this.config.dimension);
                } catch (e3) {
                    throw new Error(`Failed to open TriviumDB at ${dbPath}: ${e3.message}`);
                }
            }
        }
    }
    _callDb(db, methodNames, args = [], fallback = undefined) {
        for (const name of methodNames) {
            if (typeof db[name] === 'function') return db[name](...args);
        }
        if (fallback !== undefined) return fallback;
        throw new Error(`TriviumDB method not found: ${methodNames.join('/')}`);
    }

    _normalizeFilePath(filePath) {
        return path.resolve(String(filePath || ''));
    }

    _queueFile(filePath, eventVersion = null) {
        const normalizedPath = this._normalizeFilePath(filePath);
        if (!this._isIndexable(normalizedPath)) return;
        if (eventVersion && !this._isCurrentFileEvent(normalizedPath, eventVersion)) return;
        this._enqueueIngestJob('upsert', normalizedPath);
    }

    _queueDeleteFile(filePath, eventVersion = null) {
        const normalizedPath = this._normalizeFilePath(filePath);
        if (!this._isIndexable(normalizedPath)) return;
        if (eventVersion && !this._isCurrentFileEvent(normalizedPath, eventVersion)) return;
        this._enqueueIngestJob('delete', normalizedPath, { priority: 10 });
    }

    _enqueueIngestJob(action, filePath, options = {}) {
        if (!this.metaDb) return;
        const normalizedPath = this._normalizeFilePath(filePath);
        const { library, relPath } = this._resolveLibrary(normalizedPath);
        const now = Date.now();
        const priority = Number.isFinite(options.priority) ? options.priority : 0;

        this.metaDb.prepare(`
            INSERT INTO ingest_queue (
                action, library, path, abs_path, status, priority, retry_count,
                last_error, locked_at, next_attempt_at, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, 'pending', ?, 0, NULL, NULL, ?, ?, ?)
            ON CONFLICT(action, library, path) DO UPDATE SET
                abs_path = excluded.abs_path,
                status = 'pending',
                priority = MAX(priority, excluded.priority),
                last_error = NULL,
                locked_at = NULL,
                next_attempt_at = excluded.next_attempt_at,
                updated_at = excluded.updated_at
        `).run(action, library, relPath, normalizedPath, priority, now, now, now);

        this._scheduleBatch();
    }

    _scheduleBatch(delayMs = this.config.batchWindow) {
        if (this.batchTimer) clearTimeout(this.batchTimer);
        this.batchTimer = setTimeout(() => this._flushBatch(), Math.max(0, delayMs));
        if (this.batchTimer.unref) this.batchTimer.unref();
    }

    async _flushBatch() {
        return this._runQueueWorker();
    }

    _startQueueWorker() {
        if (this.queueTimer) return;
        this.queueTimer = setInterval(() => {
            this._runQueueWorker().catch(e => {
                console.warn('[TDBKnowledge] Queue worker tick failed:', e.message);
            });
        }, Math.max(500, this.config.queuePollIntervalMs));
        if (typeof this.queueTimer.unref === 'function') this.queueTimer.unref();
        this._scheduleBatch(0);
        console.log(`[TDBKnowledge] 📦 Reliable ingest queue enabled. batch=${this.config.maxBatchSize}, poll=${this.config.queuePollIntervalMs}ms`);
    }

    _claimQueueJobs() {
        const now = Date.now();
        const staleBefore = now - this.config.queueLeaseMs;
        return this.metaDb.transaction(() => {
            this.metaDb.prepare(`
                UPDATE ingest_queue
                SET status = 'pending',
                    locked_at = NULL,
                    next_attempt_at = ?,
                    updated_at = ?
                WHERE status = 'processing'
                  AND (locked_at IS NULL OR locked_at < ?)
            `).run(now, now, staleBefore);

            const jobs = this.metaDb.prepare(`
                SELECT *
                FROM ingest_queue
                WHERE (status = 'pending' OR status = 'retry')
                  AND next_attempt_at <= ?
                ORDER BY priority DESC, updated_at ASC, id ASC
                LIMIT ?
            `).all(now, this.config.maxBatchSize);

            const mark = this.metaDb.prepare(`
                UPDATE ingest_queue
                SET status = 'processing',
                    locked_at = ?,
                    updated_at = ?
                WHERE id = ?
            `);
            for (const job of jobs) mark.run(now, now, job.id);
            return jobs;
        })();
    }

    _completeQueueJob(job) {
        this.metaDb.prepare('DELETE FROM ingest_queue WHERE id = ?').run(job.id);
    }

    _failQueueJob(job, error) {
        const retryCount = (job.retry_count || 0) + 1;
        const now = Date.now();
        const message = String(error?.message || error || 'Unknown error').slice(0, 1000);
        if (retryCount >= this.config.queueMaxRetries) {
            this.metaDb.prepare(`
                UPDATE ingest_queue
                SET status = 'failed',
                    retry_count = ?,
                    last_error = ?,
                    locked_at = NULL,
                    updated_at = ?
                WHERE id = ?
            `).run(retryCount, message, now, job.id);
            console.error(`[TDBKnowledge] ⛔ Ingest job failed permanently (${job.action} ${job.path}): ${message}`);
            return;
        }

        const delay = Math.min(60 * 60 * 1000, 1000 * Math.pow(2, retryCount));
        this.metaDb.prepare(`
            UPDATE ingest_queue
            SET status = 'retry',
                retry_count = ?,
                last_error = ?,
                locked_at = NULL,
                next_attempt_at = ?,
                updated_at = ?
            WHERE id = ?
        `).run(retryCount, message, now + delay, now, job.id);
        console.warn(`[TDBKnowledge] ⚠️ Ingest job retry ${retryCount}/${this.config.queueMaxRetries}: ${job.action} ${job.path} (${message})`);
    }

    async _runQueueWorker() {
        if (!this.metaDb || this.isQueueWorkerRunning) return;
        this.isQueueWorkerRunning = true;
        this.isProcessing = true;
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }

        try {
            while (true) {
                const jobs = this._claimQueueJobs();
                if (jobs.length === 0) break;

                for (const job of jobs) {
                    try {
                        if (job.action === 'delete') {
                            await this._processDeleteJob(job);
                        } else {
                            await this._processUpsertJob(job);
                        }
                        this._completeQueueJob(job);
                    } catch (e) {
                        this._failQueueJob(job, e);
                    }
                }

                if (jobs.length < this.config.maxBatchSize) break;
            }
        } finally {
            this.isProcessing = false;
            this.isQueueWorkerRunning = false;
        }
    }

    async _processUpsertJob(job) {
        const normalizedPath = this._normalizeFilePath(job.abs_path);
        try {
            await fs.access(normalizedPath);
        } catch (e) {
            await this._deleteFileUnlocked(normalizedPath);
            return;
        }
        await this.upsertFile(normalizedPath);
        this._afterSuccessfulIngest(job.library);
    }

    async _processDeleteJob(job) {
        await this._deleteFileUnlocked(this._normalizeFilePath(job.abs_path));
        this._afterSuccessfulIngest(job.library);
    }

    _afterSuccessfulIngest(library) {
        const safeName = safeLibraryName(library);
        const handle = this.libs.get(safeName);
        if (!handle) return;

        this.processedSinceFlush++;
        this.processedSinceTextIndexBuild++;

        if (this.config.buildTextIndexEveryFiles > 0 && this.processedSinceTextIndexBuild >= this.config.buildTextIndexEveryFiles) {
            this._safeBuildTextIndex(handle.db);
            this.processedSinceTextIndexBuild = 0;
        }

        if (this.config.flushEveryFiles > 0 && this.processedSinceFlush >= this.config.flushEveryFiles) {
            this._safeFlush(handle.db);
            this.processedSinceFlush = 0;
        }
    }

    async upsertFile(filePath, options = {}) {
        if (!this._isIndexable(filePath)) return;
        const normalizedPath = this._normalizeFilePath(filePath);
        const { library } = this._resolveLibrary(normalizedPath);
        const eventVersion = options.eventVersion || this._getFileEventVersion(normalizedPath) || this._bumpFileEventVersion(normalizedPath);
        return this._withLibraryQueue(library, async () => this._upsertFileUnlocked(normalizedPath, { eventVersion }));
    }

    async _upsertFileUnlocked(filePath, options = {}) {
        if (!this._isIndexable(filePath)) return;
        const normalizedPath = this._normalizeFilePath(filePath);
        const eventVersion = options.eventVersion || this._getFileEventVersion(normalizedPath);
        if (!this._isCurrentFileEvent(normalizedPath, eventVersion)) return;

        const stats = await fs.stat(normalizedPath);
        const { library, relPath } = this._resolveLibrary(normalizedPath);
        const content = await fs.readFile(normalizedPath, 'utf-8');
        const checksum = crypto.createHash('sha256').update(content).digest('hex');

        if (!this._isCurrentFileEvent(normalizedPath, eventVersion)) return;

        const old = this.metaDb.prepare('SELECT checksum, mtime, size FROM files WHERE library = ? AND path = ?').get(library, relPath);
        // 内容去重：checksum + size 一致即认为文件未改变，跳过昂贵的重新 Embedding。
        // 当 mtime 因 git pull / 文件复制等操作被刷新但内容未变时，仅同步 metaDb 中的时间戳。
        // 与 KnowledgeBaseManager（热记忆系统）的增量判断逻辑对齐。
        if (old && old.checksum === checksum && old.size === stats.size) {
            if (old.mtime !== stats.mtimeMs) {
                this.metaDb.prepare('UPDATE files SET mtime = ?, updated_at = ? WHERE library = ? AND path = ?')
                    .run(stats.mtimeMs, Math.floor(Date.now() / 1000), library, relPath);
            }
            return;
        }

        const handle = this.getOrOpenLibrary(library);
        this._beginLibraryUse(handle);

        try {
            await this._deleteExistingFileNodes(handle, library, relPath);

            const chunks = chunkText(content).filter(Boolean);
            if (chunks.length === 0) return;

            const now = Math.floor(Date.now() / 1000);
            const [docVector] = await getEmbeddingsBatch([path.basename(relPath)], {
                apiKey: this.config.apiKey,
                apiUrl: this.config.apiUrl,
                model: this.config.model
            });

            if (!this._isCurrentFileEvent(normalizedPath, eventVersion)) return;

            const latestStats = await fs.stat(normalizedPath);
            const latestContent = await fs.readFile(normalizedPath, 'utf-8');
            const latestChecksum = crypto.createHash('sha256').update(latestContent).digest('hex');
            if (
                latestStats.size !== stats.size ||
                latestStats.mtimeMs !== stats.mtimeMs ||
                latestChecksum !== checksum
            ) {
                const latestVersion = this._bumpFileEventVersion(normalizedPath);
                this._queueFile(normalizedPath, latestVersion);
                return;
            }

            let docNodeId = null;
            if (docVector) {
                docNodeId = this._insertNode(handle.db, docVector, {
                    type: 'document',
                    library,
                    source_path: relPath,
                    title: path.basename(relPath),
                    checksum,
                    chunk_count: chunks.length,
                    mtime: stats.mtimeMs,
                    size: stats.size,
                    updated_at: now
                });
            }

            const chunkRows = [];
            const embeddingBatchSize = Math.max(1, this.config.embeddingBatchSize);
            for (let start = 0; start < chunks.length; start += embeddingBatchSize) {
                const batchChunks = chunks.slice(start, start + embeddingBatchSize);
                const vectors = await getEmbeddingsBatch(batchChunks, {
                    apiKey: this.config.apiKey,
                    apiUrl: this.config.apiUrl,
                    model: this.config.model
                });

                for (let offset = 0; offset < batchChunks.length; offset++) {
                    const i = start + offset;
                    const vector = vectors[offset];
                    if (!vector) continue;

                    const text = chunks[i];
                    const chunkChecksum = crypto.createHash('sha256').update(text).digest('hex');
                    const nodeId = this._insertNode(handle.db, vector, {
                        type: 'chunk',
                        library,
                        source_path: relPath,
                        chunk_index: i,
                        text_preview: text.slice(0, 500),
                        checksum: chunkChecksum,
                        updated_at: now
                    });

                    chunkRows.push({ index: i, nodeId, checksum: chunkChecksum });

                    if (docNodeId != null) this._safeLink(handle.db, docNodeId, nodeId, 'contains', 1.0);
                    if (chunkRows.length > 1) {
                        const prev = chunkRows[chunkRows.length - 2];
                        this._safeLink(handle.db, prev.nodeId, nodeId, 'next', 0.7);
                        this._safeLink(handle.db, nodeId, prev.nodeId, 'prev', 0.7);
                    }

                    this._safeIndexText(handle.db, nodeId, text);
                }
            }

            const tx = this.metaDb.transaction(() => {
                this.metaDb.prepare(`
                    INSERT INTO files (library, path, checksum, mtime, size, doc_node_id, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(library, path) DO UPDATE SET
                        checksum = excluded.checksum,
                        mtime = excluded.mtime,
                        size = excluded.size,
                        doc_node_id = excluded.doc_node_id,
                        updated_at = excluded.updated_at
                `).run(library, relPath, checksum, stats.mtimeMs, stats.size, docNodeId, now);

                this.metaDb.prepare('DELETE FROM chunks WHERE library = ? AND path = ?').run(library, relPath);
                const insertChunk = this.metaDb.prepare('INSERT INTO chunks (library, path, chunk_index, node_id, checksum) VALUES (?, ?, ?, ?, ?)');
                for (const row of chunkRows) insertChunk.run(library, relPath, row.index, row.nodeId, row.checksum);
            });
            tx();

            console.log(`[TDBKnowledge] ✅ Indexed ${relPath} into "${library}" (${chunkRows.length}/${chunks.length} chunks).`);
        } finally {
            this._endLibraryUse(handle);
        }
    }

    _insertNode(db, vector, payload) {
        return this._callDb(db, ['insert', 'insertNode'], [Array.from(vector), payload]);
    }

    async _deleteExistingFileNodes(handle, library, relPath) {
        const db = handle.db;
        const fileRow = this.metaDb.prepare('SELECT doc_node_id FROM files WHERE library = ? AND path = ?').get(library, relPath);
        const chunkRows = this.metaDb.prepare('SELECT node_id FROM chunks WHERE library = ? AND path = ?').all(library, relPath);

        for (const row of chunkRows) this._safeDelete(db, row.node_id);
        if (fileRow?.doc_node_id != null) this._safeDelete(db, fileRow.doc_node_id);

        this.metaDb.prepare('DELETE FROM chunks WHERE library = ? AND path = ?').run(library, relPath);
        this.metaDb.prepare('DELETE FROM files WHERE library = ? AND path = ?').run(library, relPath);
    }

    async deleteFile(filePath, options = {}) {
        const normalizedPath = this._normalizeFilePath(filePath);
        if (!this._isIndexable(normalizedPath)) return;
        const { library } = this._resolveLibrary(normalizedPath);
        const eventVersion = options.eventVersion || this._bumpFileEventVersion(normalizedPath);
        return this._withLibraryQueue(library, async () => this._deleteFileUnlocked(normalizedPath, { eventVersion }));
    }

    async _deleteFileUnlocked(filePath, options = {}) {
        const normalizedPath = this._normalizeFilePath(filePath);
        if (!this._isIndexable(normalizedPath)) return;
        const eventVersion = options.eventVersion || this._getFileEventVersion(normalizedPath);
        if (!this._isCurrentFileEvent(normalizedPath, eventVersion)) return;

        const { library, relPath } = this._resolveLibrary(normalizedPath);
        const handle = this.getOrOpenLibrary(library);
        this._beginLibraryUse(handle);
        try {
            await this._deleteExistingFileNodes(handle, library, relPath);
            this._safeFlush(handle.db);
            console.log(`[TDBKnowledge] 🧹 Removed ${relPath} from "${library}".`);
        } finally {
            this._endLibraryUse(handle);
        }
    }

    _safeDelete(db, nodeId) {
        try {
            this._callDb(db, ['delete', 'deleteNode'], [nodeId], null);
        } catch (e) {
            if (!/not found|missing|absent/i.test(e.message || '')) {
                console.warn(`[TDBKnowledge] Failed to delete node ${nodeId}:`, e.message);
            }
        }
    }

    _safeLink(db, src, dst, label, weight) {
        try {
            this._callDb(db, ['link'], [src, dst, label, weight], null);
        } catch (e) {
            console.warn(`[TDBKnowledge] Failed to link ${src} -> ${dst}:`, e.message);
        }
    }

    _safeIndexText(db, nodeId, text) {
        try {
            this._callDb(db, ['indexText', 'index_text'], [nodeId, text], null);
        } catch (e) {
            // 旧版绑定可能未暴露文本索引，忽略即可退化为纯向量检索。
        }
    }

    _safeBuildTextIndex(db) {
        try {
            this._callDb(db, ['buildTextIndex', 'build_text_index'], [], null);
        } catch (e) {
            // 同上，保持兼容。
        }
    }

    _safeFlush(db) {
        try {
            this._callDb(db, ['flush'], [], null);
        } catch (e) {
            console.warn('[TDBKnowledge] Flush failed:', e.message);
        }
    }

    async search(queryText, options = {}) {
        if (!this.initialized || !TriviumDB) return [];
        const [queryVector] = await getEmbeddingsBatch([queryText], {
            apiKey: this.config.apiKey,
            apiUrl: this.config.apiUrl,
            model: this.config.model
        });
        if (!queryVector) return [];
        return this.searchWithVector(queryVector, queryText, options);
    }

    /**
     * 🌟 复用已有查询向量进行检索，避免占位符链路（已持有 queryVector）重复 Embedding。
     * 供 RAGDiaryPlugin 的 [[xx知识库]] / 《《xx知识库》》 占位符管线调用。
     * @param {Array<number>|Float32Array} queryVector - 已计算好的查询向量
     * @param {string} queryText - 原始查询文本（用于 BM25 稀疏检索）
     * @param {object} options - { libraries, topK, expandDepth, minScore, hybridAlpha, expand }
     */
    async searchWithVector(queryVector, queryText, options = {}) {
        if (!this.initialized || !TriviumDB || !queryVector) return [];

        const libraries = Array.isArray(options.libraries) && options.libraries.length > 0
            ? options.libraries.map(safeLibraryName)
            : this.listLibraries();

        const safeQueryText = typeof queryText === 'string' ? queryText : '';
        const results = [];
        for (const library of libraries) {
            results.push(...await this.searchLibrary(library, safeQueryText, queryVector, options));
        }

        let sorted = results
            .sort((a, b) => (b.score || 0) - (a.score || 0))
            .slice(0, options.topK || 10);

        // 🌟 ::Expand 父文档展开：将命中片段替换为其所属完整文档内容（按文件去重，保留最高分）
        if (options.expand) {
            sorted = await this._expandHits(sorted);
        }

        return sorted;
    }

    /**
     * 🌟 父文档展开：把命中 chunk 的 text 替换为其所属源文件全文。
     * hits 已按分数降序，同一文件只保留首个（最高分）命中并展开一次。
     */
    async _expandHits(hits) {
        const fileCache = new Map();
        const seenFiles = new Set();
        const out = [];

        for (const hit of hits) {
            const relPath = hit.sourceFile || hit.payload?.source_path;
            if (!relPath) {
                out.push(hit);
                continue;
            }
            if (seenFiles.has(relPath)) continue;
            seenFiles.add(relPath);

            try {
                let full = fileCache.get(relPath);
                if (full === undefined) {
                    const abs = path.join(this.config.rootPath, relPath);
                    full = await fs.readFile(abs, 'utf-8');
                    fileCache.set(relPath, full);
                }
                out.push({ ...hit, text: full, _expanded: true });
            } catch (e) {
                console.warn(`[TDBKnowledge] Expand failed for "${relPath}": ${e.message}, fallback to chunk.`);
                out.push(hit);
            }
        }

        return out;
    }

    async searchLibrary(library, queryText, queryVector, options = {}) {
        const safeName = safeLibraryName(library);
        return this._withLibraryQueue(safeName, async () => this._searchLibraryUnlocked(safeName, queryText, queryVector, options));
    }

    async _searchLibraryUnlocked(library, queryText, queryVector, options = {}) {
        const handle = this.getOrOpenLibrary(library);
        this._beginLibraryUse(handle);

        try {
            const topK = options.topK || 10;
            const expandDepth = options.expandDepth ?? 1;
            const minScore = options.minScore ?? 0.1;
            const hybridAlpha = options.hybridAlpha ?? 0.7;

            let hits;
            try {
                hits = this._callDb(handle.db, ['searchHybrid', 'search_hybrid'], [
                    Array.from(queryVector),
                    queryText,
                    topK,
                    expandDepth,
                    minScore,
                    hybridAlpha
                ]);
            } catch (e) {
                hits = this._callDb(handle.db, ['search'], [Array.from(queryVector), topK, expandDepth, minScore], []);
            }

            return (hits || []).map(hit => ({
                library,
                id: hit.id,
                score: hit.score,
                payload: hit.payload || {},
                text: hit.payload?.text_preview || '',
                sourceFile: hit.payload?.source_path || '',
                chunkIndex: hit.payload?.chunk_index
            }));
        } finally {
            this._endLibraryUse(handle);
        }
    }

    listLibraries() {
        if (!fsSync.existsSync(this.config.storePath)) return [];
        const fromMeta = this.metaDb
            ? this.metaDb.prepare('SELECT DISTINCT library FROM files').all().map(r => r.library)
            : [];

        const fromDisk = fsSync.readdirSync(this.config.storePath)
            .filter(file => file.toLowerCase().endsWith('.tdb'))
            .map(file => path.basename(file, '.tdb'));

        return [...new Set([...fromMeta, ...fromDisk])];
    }

    _scanInitialFiles() {
        let queued = 0;
        const walk = (dir) => {
            let entries;
            try {
                entries = fsSync.readdirSync(dir, { withFileTypes: true });
            } catch (e) {
                console.warn(`[TDBKnowledge] Initial scan skipped unreadable directory "${dir}": ${e.message}`);
                return;
            }

            for (const entry of entries) {
                const absPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.') || this.config.excludeFolders.includes(entry.name)) continue;
                    walk(absPath);
                    continue;
                }
                if (!entry.isFile()) continue;
                if (!this._isIndexable(absPath)) continue;
                this._queueFile(absPath);
                queued++;
            }
        };

        walk(this.config.rootPath);
        console.log(`[TDBKnowledge] 🔍 Initial scan queued ${queued} file(s).`);
    }

    _startIdleEvictor() {
        if (this.idleEvictor) return;
        if (!Number.isFinite(this.config.idleUnloadHours) || this.config.idleUnloadHours <= 0) {
            console.log('[TDBKnowledge] Idle auto-unload disabled.');
            return;
        }

        const sweepMs = Math.max(60 * 1000, this.config.idleSweepIntervalMs || 15 * 60 * 1000);
        this.idleEvictor = setInterval(() => {
            this._evictIdleLibraries().catch(e => {
                console.warn('[TDBKnowledge] Idle eviction sweep failed:', e.message);
            });
        }, sweepMs);

        if (typeof this.idleEvictor.unref === 'function') this.idleEvictor.unref();
        console.log(`[TDBKnowledge] 🧹 Idle auto-unload enabled: ${this.config.idleUnloadHours}h, sweep=${Math.round(sweepMs / 1000)}s`);
    }

    async _evictIdleLibraries() {
        if (!this.initialized || !this.libs || this.libs.size === 0) return;
        const idleMs = this.config.idleUnloadHours * 3600 * 1000;
        if (!Number.isFinite(idleMs) || idleMs <= 0) return;
        if (this.isProcessing) return;

        const now = Date.now();
        const candidates = [];
        for (const [name, handle] of this.libs.entries()) {
            const lastUsedAt = handle.lastUsedAt || handle.openedAt || now;
            if ((handle.busyCount || 0) > 0) continue;
            if (now - lastUsedAt >= idleMs) candidates.push(name);
        }

        for (const name of candidates) {
            await this.closeLibrary(name, { flush: true });
        }
    }

    _startWatcher() {
        if (this.watcher) return;

        const handleRustEvent = (...args) => {
            try {
                const jsonPayload = args.find(arg => typeof arg === 'string');
                if (!jsonPayload) return;
                const { event, path: filePath } = JSON.parse(jsonPayload);
                const normalizedPath = this._normalizeFilePath(filePath);
                this._handleWatcherEvent(event, normalizedPath);
            } catch (e) {
                console.error('[TDBKnowledge] Failed to parse watcher event:', e.message);
            }
        };

        if (VexusWatcher) {
            try {
                const rustWatcher = new VexusWatcher();
                const startWatch = rustWatcher.startWatch || rustWatcher.start_watch;
                if (typeof startWatch !== 'function') {
                    throw new Error('VexusWatcher startWatch/start_watch method not found');
                }

                startWatch.call(rustWatcher, {
                    rootPath: this.config.rootPath,
                    ignoreFolders: this.config.excludeFolders,
                    ignorePrefixes: this.config.ignorePrefixes,
                    ignoreSuffixes: this.config.ignoreSuffixes,
                    extensions: this.config.extensions
                }, handleRustEvent);

                this.watcher = rustWatcher;
                this.watcherType = 'rust';
                this._startSafetyWatcher();
                console.log('[TDBKnowledge] 🦀 Using Rust native watcher.');
                return;
            } catch (e) {
                console.warn('[TDBKnowledge] ⚠️ Failed to initialize Rust watcher, falling back to Chokidar:', e.message);
            }
        }

        const ignored = [
            '**/node_modules/**',
            '**/.git/**',
            '**/.*',
            ...this.config.excludeFolders.map(folder => `**/${folder}/**`)
        ];

        this.watcher = chokidar.watch(this.config.rootPath, {
            ignored,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100
            }
        });
        this.watcher
            .on('add', fp => this._handleWatcherEvent('add', this._normalizeFilePath(fp)))
            .on('change', fp => this._handleWatcherEvent('change', this._normalizeFilePath(fp)))
            .on('unlink', fp => this._handleWatcherEvent('unlink', this._normalizeFilePath(fp)));
        this.watcherType = 'chokidar';
        console.log('[TDBKnowledge] 🔄 Using Chokidar watcher fallback.');
    }

    _startSafetyWatcher() {
        if (this.safetyWatcher) return;
        if ((process.env.TDB_KNOWLEDGE_SAFETY_WATCHER || 'true').toLowerCase() === 'false') return;

        const ignored = [
            '**/node_modules/**',
            '**/.git/**',
            '**/.*',
            ...this.config.excludeFolders.map(folder => `**/${folder}/**`)
        ];

        this.safetyWatcher = chokidar.watch(this.config.rootPath, {
            ignored,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100
            }
        });

        this.safetyWatcher
            .on('add', fp => this._handleWatcherEvent('add', this._normalizeFilePath(fp)))
            .on('change', fp => this._handleWatcherEvent('change', this._normalizeFilePath(fp)))
            .on('unlink', fp => this._handleWatcherEvent('unlink', this._normalizeFilePath(fp)));

        console.log('[TDBKnowledge] 🛡️ Chokidar safety watcher enabled for cold knowledge files.');
    }

    _handleWatcherEvent(event, filePath) {
        const normalizedPath = this._normalizeFilePath(filePath);
        if (!this._isIndexable(normalizedPath)) return;

        const eventVersion = this._bumpFileEventVersion(normalizedPath);
        if (event === 'unlink') {
            this._queueDeleteFile(normalizedPath, eventVersion);
            return;
        }

        this._queueStableFile(normalizedPath, eventVersion);
    }

    async _queueStableFile(filePath, eventVersion = null) {
        const normalizedPath = this._normalizeFilePath(filePath);
        const version = eventVersion || this._getFileEventVersion(normalizedPath) || this._bumpFileEventVersion(normalizedPath);
        try {
            const stat1 = await fs.stat(normalizedPath);
            await new Promise(resolve => setTimeout(resolve, 500));
            if (!this._isCurrentFileEvent(normalizedPath, version)) return;

            const stat2 = await fs.stat(normalizedPath);
            if (!this._isCurrentFileEvent(normalizedPath, version)) return;

            if (stat1.size === stat2.size && stat1.mtimeMs === stat2.mtimeMs) {
                this._queueFile(normalizedPath, version);
            } else {
                setTimeout(() => this._queueStableFile(normalizedPath, version), 1000);
            }
        } catch (e) {
            if (e.code !== 'ENOENT') console.warn('[TDBKnowledge] Stability check failed:', e.message);
        }
    }

    async shutdown() {
        console.log('[TDBKnowledge] shutting down...');
        if (this.batchTimer) clearTimeout(this.batchTimer);
        if (this.queueTimer) {
            clearInterval(this.queueTimer);
            this.queueTimer = null;
        }
        if (this.idleEvictor) {
            clearInterval(this.idleEvictor);
            this.idleEvictor = null;
        }

        if (this.safetyWatcher) {
            if (typeof this.safetyWatcher.close === 'function') await this.safetyWatcher.close();
            this.safetyWatcher = null;
        }

        if (this.watcher) {
            if (this.watcherType === 'rust') {
                const stopWatch = this.watcher.stopWatch || this.watcher.stop_watch;
                if (typeof stopWatch === 'function') stopWatch.call(this.watcher);
            } else if (typeof this.watcher.close === 'function') {
                await this.watcher.close();
            }
            this.watcher = null;
        }

        for (const name of Array.from(this.libs.keys())) {
            await this.closeLibrary(name, { flush: true });
        }
        this.libs.clear();
        this.libraryQueues.clear();
        this.fileEventVersions.clear();
        this.pendingFileVersions.clear();

        if (this.metaDb) {
            this.metaDb.close();
            this.metaDb = null;
        }
        console.log('[TDBKnowledge] Shutdown complete.');
    }
}

module.exports = new TDBKnowledgeManager();