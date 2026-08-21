'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

class SqliteHealthManager {
    constructor(options = {}) {
        this.Database = options.Database || Database;
        this.onConnectionRebound = options.onConnectionRebound || (() => {});
        this.logPrefix = options.logPrefix || 'KnowledgeBase';
        this.platform = options.platform || process.platform;
        // Darwin 对已映射的 -shm 被缩短会直接发出不可恢复的 SIGBUS。
        // PASSIVE checkpoint 是保守防线；根本防线是 rusqlite keepalive 与
        // better-sqlite3 候选连接提交共同保证两个 SQLite runtime 的读写
        // 连接引用在运行期不因“先关后开”而归零。
        this.checkpointMode = this.platform === 'darwin' ? 'PASSIVE' : 'TRUNCATE';
        const configuredBusyTimeout = Number(options.busyTimeoutMs);
        this.busyTimeoutMs = Number.isFinite(configuredBusyTimeout)
            ? Math.max(0, Math.floor(configuredBusyTimeout))
            : 10000;
        this.dbPath = null;
        this.db = null;
        this.state = 'healthy';
        this.corruptionDetected = false;
        this.recovering = false;
    }

    configureConnection(db) {
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('foreign_keys = ON');
        if (this.platform === 'darwin') {
            // 只关闭主数据库文件的可选 mmap。WAL-index/SHM 仍由 SQLite
            // 按协议管理；该设置不能替代两套 runtime 的 nRef 生命周期保护。
            db.pragma('mmap_size = 0');
        }
        // SQLite 同一时刻只有一个写者。Rust/rusqlite、管理维护脚本或其他
        // better-sqlite3 连接短暂持锁时，在原生层等待锁释放，而不是立即把
        // 瞬态写竞争上抛成文件摄取失败。该配置属于连接级 PRAGMA，因此每次
        // 恢复/重开连接都必须重新设置。
        db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
    }

    assertIntegrity(db) {
        const row = db.prepare('PRAGMA quick_check').get();
        const result = row ? Object.values(row)[0] : 'ok';
        if (result !== 'ok') {
            const error = new Error(`SQLite quick_check failed: ${result}`);
            error.code = 'SQLITE_CORRUPT';
            throw error;
        }
    }

    checkpoint(db) {
        return db.pragma(`wal_checkpoint(${this.checkpointMode})`);
    }

    isCorruptionError(error) {
        const message = String(error?.message || error || '');
        return error?.code === 'SQLITE_CORRUPT'
            || error?.code === 'SQLITE_NOTADB'
            || /database disk image is malformed|file is not a database|database corruption|quick_check failed/i.test(message);
    }

    isBusyError(error) {
        const code = String(error?.code || '').toUpperCase();
        const message = String(error?.message || error || '');
        return code === 'SQLITE_BUSY'
            || code.startsWith('SQLITE_BUSY_')
            || code === 'SQLITE_LOCKED'
            || code.startsWith('SQLITE_LOCKED_')
            || /database (?:is )?locked|database table is locked/i.test(message);
    }

    openWithRecovery(dbPath) {
        this.dbPath = dbPath;
        let db = new this.Database(dbPath);
        try {
            this.configureConnection(db);
            this.assertIntegrity(db);
            this._publishConnection(db);
            return db;
        } catch (error) {
            if (!this.isCorruptionError(error)) {
                try { db.close(); } catch (_) {}
                throw error;
            }

            console.error(`[${this.logPrefix}] ❌ SQLite database corruption detected during startup.`);
            console.error(`[${this.logPrefix}] Corruption details: ${error.message || error}`);
            try { db.close(); } catch (_) {}

            const backupBase = this.quarantine(dbPath, 'startup-corrupt');
            console.warn(
                `[${this.logPrefix}] 🧯 Corrupt SQLite database quarantined as ` +
                `"${path.basename(backupBase)}*". A fresh database will be created and rebuilt from dailynote files.`
            );

            db = new this.Database(dbPath);
            this.configureConnection(db);
            this.assertIntegrity(db);
            this._publishConnection(db);
            return db;
        }
    }

    checkpointAndAssertHealthy(reason = 'manual-checkpoint') {
        if (!this.db) return false;
        try {
            this.checkpoint(this.db);
            this.assertIntegrity(this.db);
            this.state = 'healthy';
            return true;
        } catch (error) {
            if (!this.isCorruptionError(error)) {
                console.error(
                    `[${this.logPrefix}] 🚨 SQLite checkpoint/quick_check failed after ${reason}: ` +
                    `${error.message || error}`
                );
                return false;
            }

            console.warn(
                `[${this.logPrefix}] 🩺 SQLite checkpoint/quick_check reported suspect state after ` +
                `${reason}: ${error.message || error}`
            );
            this.state = 'suspect';
            return this.recoverSuspectConnection(reason, error);
        }
    }

    /**
     * Rust 使用独立 SQLite 运行时提交派生写后，长期存活的 better-sqlite3
     * 连接可能仍持有旧 pager/WAL/SHM read mark。候选连接先完成配置、
     * checkpoint 和 quick_check，发布成功后才关闭旧连接，确保本 runtime
     * 不出现会触发 readwrite first-attach 的 nRef 归零窗口。
     *
     * 该路径只用于低频 Rust 派生写屏障；普通 JS 写和手工健康检查仍复用现有连接。
     */
    reopenAndAssertHealthy(reason = 'rust-write-barrier') {
        if (!this.dbPath || this.recovering) return false;

        this.recovering = true;
        this.state = 'recovering';
        const oldDb = this.db;

        try {
            const reopened = new this.Database(this.dbPath);
            try {
                this.configureConnection(reopened);
                this.checkpoint(reopened);
                this.assertIntegrity(reopened);
            } catch (error) {
                // 候选连接未通过验证时，旧连接仍保持存活，确保调用方仍有
                // 可用连接且 better-sqlite3 的 nRef 不出现人为归零窗口。
                try { reopened.close(); } catch (_) {}
                throw error;
            }

            // 验证全部通过后才发布候选连接；发布回调同步重绑所有已知消费者。
            this._publishConnection(reopened);
            try {
                oldDb?.close();
            } catch (closeError) {
                console.warn(
                    `[${this.logPrefix}] ⚠️ Failed to close superseded SQLite connection cleanly: ` +
                    closeError.message
                );
            }
            this.state = 'healthy';
            this.corruptionDetected = false;
            return true;
        } catch (error) {
            console.warn(
                `[${this.logPrefix}] 🩺 Fresh SQLite connection verification failed after ${reason}: ` +
                `${error.message || error}. Retrying with second-stage reopen...`
            );
            this.state = 'suspect';
            this.recovering = false;
            return this.recoverSuspectConnection(reason, error);
        } finally {
            this.recovering = false;
        }
    }

    recoverSuspectConnection(reason, firstError) {
        if (!this.dbPath || this.recovering) return false;

        this.recovering = true;
        this.state = 'recovering';
        const oldDb = this.db;
        let reopened = null;

        try {
            console.warn(
                `[${this.logPrefix}] 🩺 SQLite suspect state after ${reason}; ` +
                'reopening connection for second-stage verification...'
            );

            reopened = new this.Database(this.dbPath);
            this.configureConnection(reopened);
            this.checkpoint(reopened);
            this.assertIntegrity(reopened);

            // 二阶段候选也必须先验证、再发布；失败时旧连接仍未关闭。
            this._publishConnection(reopened);
            reopened = null;
            try {
                oldDb?.close();
            } catch (closeError) {
                console.warn(
                    `[${this.logPrefix}] ⚠️ Failed to close superseded suspect SQLite connection cleanly: ` +
                    closeError.message
                );
            }
            this.state = 'healthy';
            this.corruptionDetected = false;
            console.warn(
                `[${this.logPrefix}] ✅ SQLite suspect verification passed after reopen; ` +
                'treating as transient WAL/SHM view issue.'
            );
            return true;
        } catch (secondError) {
            try { reopened?.close(); } catch (_) {}
            console.error(
                `[${this.logPrefix}] 🚨 SQLite second-stage verification failed after ${reason}: ` +
                `${secondError.message || secondError}`
            );
            console.error(
                `[${this.logPrefix}] First-stage failure was: ${firstError?.message || firstError}`
            );
            // 保留仍可能维持 SQLite runtime 映射的旧连接；业务层进入 corrupt
            // 状态后应停止继续使用数据库，而不是主动制造最后关闭窗口。
            this.state = 'corrupt';
            this.corruptionDetected = true;
            return false;
        } finally {
            this.recovering = false;
        }
    }

    quarantine(dbPath, reason = 'corrupt') {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupBase = `${dbPath}.${reason}.${timestamp}.bak`;

        for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
            if (!fs.existsSync(file)) continue;
            const suffix = file === dbPath
                ? ''
                : path.basename(file).slice(path.basename(dbPath).length);
            const target = `${backupBase}${suffix}`;
            try {
                fs.renameSync(file, target);
                console.warn(
                    `[${this.logPrefix}] 🧯 Quarantined "${path.basename(file)}" -> ` +
                    `"${path.basename(target)}"`
                );
            } catch (error) {
                console.error(
                    `[${this.logPrefix}] ❌ Failed to quarantine "${file}": ${error.message}`
                );
                throw error;
            }
        }
        return backupBase;
    }

    syncFromOwner(owner) {
        this.db = owner.db;
        this.dbPath = owner.dbPath;
        this.state = owner.dbHealthState;
        this.corruptionDetected = owner.databaseCorruptionDetected;
        this.recovering = owner._recoveringDatabaseConnection;
    }

    syncToOwner(owner) {
        owner.db = this.db;
        owner.dbPath = this.dbPath;
        owner.dbHealthState = this.state;
        owner.databaseCorruptionDetected = this.corruptionDetected;
        owner._recoveringDatabaseConnection = this.recovering;
    }

    _publishConnection(db) {
        this.db = db;
        this.onConnectionRebound(db);
    }
}

module.exports = SqliteHealthManager;