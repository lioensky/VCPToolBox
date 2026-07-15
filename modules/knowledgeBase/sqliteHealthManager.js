'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

class SqliteHealthManager {
    constructor(options = {}) {
        this.Database = options.Database || Database;
        this.onConnectionRebound = options.onConnectionRebound || (() => {});
        this.logPrefix = options.logPrefix || 'KnowledgeBase';
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

    isCorruptionError(error) {
        const message = String(error?.message || error || '');
        return error?.code === 'SQLITE_CORRUPT'
            || error?.code === 'SQLITE_NOTADB'
            || /database disk image is malformed|file is not a database|database corruption|quick_check failed/i.test(message);
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
            this.db.pragma('wal_checkpoint(TRUNCATE)');
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

    recoverSuspectConnection(reason, firstError) {
        if (!this.dbPath || this.recovering) return false;

        this.recovering = true;
        this.state = 'recovering';
        const oldDb = this.db;

        try {
            console.warn(
                `[${this.logPrefix}] 🩺 SQLite suspect state after ${reason}; ` +
                'reopening connection for second-stage verification...'
            );
            try {
                oldDb?.close();
            } catch (closeError) {
                console.warn(
                    `[${this.logPrefix}] ⚠️ Failed to close suspect SQLite connection cleanly: ` +
                    closeError.message
                );
            }
            if (this.db === oldDb) this.db = null;

            const reopened = new this.Database(this.dbPath);
            this.configureConnection(reopened);
            reopened.pragma('wal_checkpoint(TRUNCATE)');
            this.assertIntegrity(reopened);
            this._publishConnection(reopened);
            this.state = 'healthy';
            this.corruptionDetected = false;
            console.warn(
                `[${this.logPrefix}] ✅ SQLite suspect verification passed after reopen; ` +
                'treating as transient WAL/SHM view issue.'
            );
            return true;
        } catch (secondError) {
            console.error(
                `[${this.logPrefix}] 🚨 SQLite second-stage verification failed after ${reason}: ` +
                `${secondError.message || secondError}`
            );
            console.error(
                `[${this.logPrefix}] First-stage failure was: ${firstError?.message || firstError}`
            );
            this.db = null;
            this.state = 'corrupt';
            this.corruptionDetected = true;
            this.onConnectionRebound(null);
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