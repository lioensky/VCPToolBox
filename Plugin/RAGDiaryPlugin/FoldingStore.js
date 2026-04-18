// Plugin/RAGDiaryPlugin/FoldingStore.js
// 上下文折叠迷你数据库 - 基于 better-sqlite3
// 由 RAGDiaryPlugin 初始化和管理，通过 ContextBridge 暴露给 ContextFoldingV2

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class FoldingStore {
    /**
     * @param {string} dbPath - SQLite 数据库文件路径
     * @param {object} options
     * @param {number} options.maxEntries - 最大条目数（默认 200）
     * @param {number} options.evictCount - 超限时淘汰数量（默认 20）
     */
    constructor(dbPath, options = {}) {
        this.maxEntries = options.maxEntries || 200;
        this.evictCount = options.evictCount || 20;
        this.db = null;

        // 预编译语句缓存
        this._stmts = {};

        try {
            const dbDir = path.dirname(dbPath);
            console.log(`[FoldingStore] 初始化开始: dbPath=${dbPath}, dbDir=${dbDir}, cwd=${process.cwd()}, maxEntries=${this.maxEntries}, evictCount=${this.evictCount}`);

            try {
                fs.mkdirSync(dbDir, { recursive: true });
                const probePath = path.join(dbDir, '.folding_store.write_test');
                fs.writeFileSync(probePath, 'ok');
                fs.unlinkSync(probePath);
                console.log(`[FoldingStore] 目录写入探测成功: ${dbDir}`);
            } catch (probeErr) {
                console.error(`[FoldingStore] 目录写入探测失败: dir=${dbDir}, error=${probeErr.message}`);
                throw probeErr;
            }

            this.db = new Database(dbPath);
            console.log('[FoldingStore] SQLite 连接已建立，开始配置 PRAGMA...');
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = NORMAL');
            this._initSchema();
            this._prepareStatements();

            const count = this.db.prepare('SELECT COUNT(*) as cnt FROM folding_entries').get().cnt;
            console.log(`[FoldingStore] 数据库已就绪: dbPath=${dbPath}, count=${count}, journal_mode=WAL, synchronous=NORMAL`);
        } catch (e) {
            console.error(`[FoldingStore] 数据库初始化失败: dbPath=${dbPath}, error=${e.message}`);
            if (e.stack) {
                console.error(`[FoldingStore] 数据库初始化失败堆栈:\n${e.stack}`);
            }

            // 尝试删除损坏的数据库并重建
            try {
                if (fs.existsSync(dbPath)) {
                    fs.unlinkSync(dbPath);
                    console.log(`[FoldingStore] 已删除旧数据库文件，准备重建: ${dbPath}`);
                } else {
                    console.log(`[FoldingStore] 初始化失败时未发现现有数据库文件，将直接尝试重建: ${dbPath}`);
                }
                this.db = new Database(dbPath);
                console.log('[FoldingStore] 重建阶段 SQLite 连接已建立，开始配置 PRAGMA...');
                this.db.pragma('journal_mode = WAL');
                this.db.pragma('synchronous = NORMAL');
                this._initSchema();
                this._prepareStatements();

                const rebuiltCount = this.db.prepare('SELECT COUNT(*) as cnt FROM folding_entries').get().cnt;
                console.log(`[FoldingStore] 数据库已重建: dbPath=${dbPath}, count=${rebuiltCount}`);
            } catch (rebuildErr) {
                console.error(`[FoldingStore] 数据库重建也失败: dbPath=${dbPath}, error=${rebuildErr.message}`);
                if (rebuildErr.stack) {
                    console.error(`[FoldingStore] 数据库重建失败堆栈:\n${rebuildErr.stack}`);
                }
                this.db = null;
            }
        }
    }

    _initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS folding_entries (
                content_hash    TEXT PRIMARY KEY,
                text_preview    TEXT NOT NULL,
                vector          BLOB,
                summary         TEXT DEFAULT '',
                summary_status  TEXT DEFAULT 'none',
                retry_count     INTEGER DEFAULT 0,
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_folding_updated ON folding_entries(updated_at);
        `);
    }

    _prepareStatements() {
        if (!this.db) return;

        this._stmts.get = this.db.prepare(
            'SELECT * FROM folding_entries WHERE content_hash = ?'
        );

        this._stmts.upsertVector = this.db.prepare(`
            INSERT INTO folding_entries (content_hash, text_preview, vector, summary_status, created_at, updated_at)
            VALUES (@hash, @preview, @vector, 'none', @now, @now)
            ON CONFLICT(content_hash) DO UPDATE SET
                vector = COALESCE(@vector, vector),
                updated_at = @now
        `);

        this._stmts.upsertSummary = this.db.prepare(`
            UPDATE folding_entries
            SET summary = @summary,
                summary_status = @status,
                retry_count = CASE WHEN @status = 'failed' THEN retry_count + 1 ELSE retry_count END,
                updated_at = @now
            WHERE content_hash = @hash
        `);

        this._stmts.markPending = this.db.prepare(`
            UPDATE folding_entries
            SET summary_status = 'pending', updated_at = @now
            WHERE content_hash = @hash
        `);

        this._stmts.count = this.db.prepare(
            'SELECT COUNT(*) as cnt FROM folding_entries'
        );

        this._stmts.evict = this.db.prepare(`
            DELETE FROM folding_entries
            WHERE content_hash IN (
                SELECT content_hash FROM folding_entries
                ORDER BY updated_at ASC
                LIMIT ?
            )
        `);

        this._stmts.touchUpdated = this.db.prepare(`
            UPDATE folding_entries SET updated_at = ? WHERE content_hash = ?
        `);
    }

    /**
     * 生成内容哈希
     * @param {string} sanitizedContent - 已净化的内容文本
     * @returns {string} SHA-256 hex
     */
    static hashContent(sanitizedContent) {
        return crypto.createHash('sha256').update(sanitizedContent).digest('hex');
    }

    /**
     * 将 Float32Array 转换为 Buffer 用于 BLOB 存储
     */
    static vectorToBuffer(vector) {
        if (!vector) return null;
        const f32 = vector instanceof Float32Array ? vector : new Float32Array(vector);
        return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
    }

    /**
     * 将 BLOB Buffer 还原为 Float32Array（安全复制）
     */
    static bufferToVector(buf) {
        if (!buf || !(buf instanceof Buffer)) return null;
        // 安全复制：避免 ArrayBuffer 对齐问题
        const copy = new ArrayBuffer(buf.length);
        const view = new Uint8Array(copy);
        for (let i = 0; i < buf.length; i++) {
            view[i] = buf[i];
        }
        return new Float32Array(copy);
    }

    // ═══════════════════════════════════════════════════
    // 公共读写接口（通过 ContextBridge 暴露）
    // ═══════════════════════════════════════════════════

    /**
     * 获取条目
     * @param {string} contentHash
     * @returns {object|null} { content_hash, text_preview, vector: Float32Array|null, summary, summary_status, retry_count, created_at, updated_at }
     */
    getEntry(contentHash) {
        if (!this.db) return null;
        try {
            const row = this._stmts.get.get(contentHash);
            if (!row) return null;

            // 触摸 updated_at 以维持 LRU
            this._stmts.touchUpdated.run(Date.now(), contentHash);

            return {
                ...row,
                vector: FoldingStore.bufferToVector(row.vector)
            };
        } catch (e) {
            console.error(`[FoldingStore] getEntry 错误: ${e.message}`);
            return null;
        }
    }

    /**
     * 写入/更新向量（不覆盖已有摘要）
     * @param {string} contentHash
     * @param {object} data - { textPreview: string, vector: Float32Array|Array<number> }
     */
    upsertVector(contentHash, data) {
        if (!this.db) return;
        try {
            this._evictIfNeeded();
            this._stmts.upsertVector.run({
                hash: contentHash,
                preview: (data.textPreview || '').substring(0, 80),
                vector: FoldingStore.vectorToBuffer(data.vector),
                now: Date.now()
            });
        } catch (e) {
            console.error(`[FoldingStore] upsertVector 错误: ${e.message}`);
        }
    }

    /**
     * 写入摘要结果
     * @param {string} contentHash
     * @param {string} summary - 摘要文本（包含完整格式标记）
     * @param {string} status - 'ready' | 'failed'
     */
    upsertSummary(contentHash, summary, status) {
        if (!this.db) return;
        try {
            this._stmts.upsertSummary.run({
                hash: contentHash,
                summary: summary || '',
                status: status,
                now: Date.now()
            });
        } catch (e) {
            console.error(`[FoldingStore] upsertSummary 错误: ${e.message}`);
        }
    }

    /**
     * 标记为摘要生成中
     * @param {string} contentHash
     */
    markPending(contentHash) {
        if (!this.db) return;
        try {
            this._stmts.markPending.run({
                hash: contentHash,
                now: Date.now()
            });
        } catch (e) {
            console.error(`[FoldingStore] markPending 错误: ${e.message}`);
        }
    }

    /**
     * 获取统计信息
     */
    getStats() {
        if (!this.db) return { count: 0, maxEntries: this.maxEntries, available: false };
        try {
            const cnt = this._stmts.count.get().cnt;
            return { count: cnt, maxEntries: this.maxEntries, available: true };
        } catch (e) {
            return { count: 0, maxEntries: this.maxEntries, available: false };
        }
    }

    // ═══════════════════════════════════════════════════
    // 内部方法
    // ═══════════════════════════════════════════════════

    /**
     * LRU 淘汰：超过 maxEntries 时删除最旧的 evictCount 条
     */
    _evictIfNeeded() {
        try {
            const cnt = this._stmts.count.get().cnt;
            if (cnt >= this.maxEntries) {
                const result = this._stmts.evict.run(this.evictCount);
                console.log(`[FoldingStore] LRU 淘汰: 删除了 ${result.changes} 条最旧记录`);
            }
        } catch (e) {
            console.error(`[FoldingStore] 淘汰失败: ${e.message}`);
        }
    }

    /**
     * 关闭数据库连接
     */
    shutdown() {
        if (this.db) {
            try {
                this.db.close();
                console.log('[FoldingStore] 数据库已关闭');
            } catch (e) {
                console.error(`[FoldingStore] 关闭数据库失败: ${e.message}`);
            }
            this.db = null;
        }
    }
}

module.exports = FoldingStore;