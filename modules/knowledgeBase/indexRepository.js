'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class IndexRepository {
    constructor(options = {}) {
        this.config = options.config;
        this.VexusIndex = options.VexusIndex;
        this.getDbPath = options.getDbPath;
        this.waitForCoordinatorIdle = options.waitForCoordinatorIdle;
        this.ensureDiaryDateIndex = options.ensureDiaryDateIndex || (() => {});
        this.invalidateDiaryDateIndex = options.invalidateDiaryDateIndex || (() => {});
        this.onRecoveryStateChange = options.onRecoveryStateChange || (() => {});
        this.onRecoveryTailChange = options.onRecoveryTailChange || (() => {});
        this.diaryIndices = options.diaryIndices || new Map();
        this.lastUsed = options.lastUsed || new Map();
        this.loadPromises = options.loadPromises || new Map();
        this.saveTimers = options.saveTimers || new Map();
        this.recoveryActive = false;
        this.recoveryTail = Promise.resolve();
        this.idleSweepTimer = null;
        this.tagIndex = null;
        this.logPrefix = options.logPrefix || 'KnowledgeBase';
    }

    shouldPersist(name) {
        return name === 'global_tags'
            ? this.config.persistTagIndex
                || this.config.persistFolders.has('global_tags')
            : this.config.persistDefault
                || this.config.persistFolders.has(name)
                || name.endsWith('簇');
    }

    async getOrLoad(diaryName, options = {}) {
        this.lastUsed.set(diaryName, Date.now());
        if (this.diaryIndices.has(diaryName)) {
            return this.diaryIndices.get(diaryName);
        }
        if (this.loadPromises.has(diaryName)) {
            return this.loadPromises.get(diaryName);
        }

        const load = async () => {
            await this.waitForCoordinatorIdle(options);
            this.recoveryActive = true;
            this.onRecoveryStateChange(true);
            try {
                if (this.diaryIndices.has(diaryName)) {
                    return this.diaryIndices.get(diaryName);
                }
                const persist = this.shouldPersist(diaryName);
                console.log(
                    `[${this.logPrefix}] 📂 Loading index for diary: ` +
                    `"${diaryName}" (Persist: ${persist})`
                );
                const safeName = crypto.createHash('md5')
                    .update(diaryName)
                    .digest('hex');
                const fileName = `diary_${safeName}`;
                const capacity = 50000;
                let index;
                if (persist) {
                    index = await this.loadOrBuild(
                        fileName,
                        capacity,
                        'chunks',
                        diaryName
                    );
                } else {
                    index = new this.VexusIndex(
                        this.config.dimension,
                        capacity
                    );
                    await this.recoverFromDb(index, 'chunks', diaryName);
                }
                this.diaryIndices.set(diaryName, index);
                this.ensureDiaryDateIndex(diaryName);
                return index;
            } finally {
                this.recoveryActive = false;
                this.onRecoveryStateChange(false);
            }
        };

        const queued = this.recoveryTail.then(load);
        this.recoveryTail = queued.catch(error => {
            console.error(
                `[${this.logPrefix}] Serialized index load failed for ` +
                `"${diaryName}":`,
                error
            );
        });
        this.onRecoveryTailChange(this.recoveryTail);
        this.loadPromises.set(diaryName, queued);
        try {
            return await queued;
        } finally {
            if (this.loadPromises.get(diaryName) === queued) {
                this.loadPromises.delete(diaryName);
            }
        }
    }

    async loadOrBuild(fileName, capacity, tableType, diaryName = null) {
        const indexPath = path.join(
            this.config.storePath,
            `index_${fileName}.usearch`
        );
        let index;
        try {
            if (fs.existsSync(indexPath)) {
                index = this.VexusIndex.load(
                    indexPath,
                    null,
                    this.config.dimension,
                    capacity
                );
            } else {
                console.log(
                    `[${this.logPrefix}] Index file not found for ${fileName}, ` +
                    'rebuilding from SQLite when possible.'
                );
                index = new this.VexusIndex(this.config.dimension, capacity);
                if (diaryName) {
                    await this.recoverFromDb(index, tableType, diaryName);
                }
            }
        } catch (error) {
            console.error(
                `[${this.logPrefix}] Index load error (${fileName}): ` +
                error.message
            );
            console.warn(
                `[${this.logPrefix}] Rebuilding index ${fileName} from DB ` +
                'as a fallback...'
            );
            index = new this.VexusIndex(this.config.dimension, capacity);
            await this.recoverFromDb(index, tableType, diaryName);
        }
        return index;
    }

    async recoverFromDb(index, table, diaryName) {
        console.log(
            `[${this.logPrefix}] 🔄 Recovering ${table} ` +
            `(Filter: ${diaryName || 'None'}) via Rust...`
        );
        try {
            const count = await index.recoverFromSqlite(
                this.getDbPath(),
                table,
                diaryName || null
            );
            console.log(
                `[${this.logPrefix}] ✅ Recovered ${count} vectors via Rust.`
            );
            return count;
        } catch (error) {
            console.error(
                `[${this.logPrefix}] ❌ Rust recovery failed for ${table}:`,
                error
            );
            return 0;
        }
    }

    deletePersisted(diaryName) {
        if (!this.shouldPersist(diaryName)) return;
        const safeName = crypto.createHash('md5')
            .update(diaryName)
            .digest('hex');
        const indexPath = path.join(
            this.config.storePath,
            `index_diary_${safeName}.usearch`
        );
        try {
            if (fs.existsSync(indexPath)) {
                fs.unlinkSync(indexPath);
                console.warn(
                    `[${this.logPrefix}] 🧹 Removed stale persisted index for ` +
                    `diary "${diaryName}". It will be rebuilt from SQLite.`
                );
            }
            if (fs.existsSync(`${indexPath}.tmp`)) {
                fs.unlinkSync(`${indexPath}.tmp`);
            }
        } catch (error) {
            console.warn(
                `[${this.logPrefix}] ⚠️ Failed to remove stale persisted index ` +
                `for "${diaryName}": ${error.message}`
            );
        }
    }

    deleteAllPersisted() {
        try {
            for (const file of fs.readdirSync(this.config.storePath)) {
                if (!/^index_diary_[a-f0-9]{32}\.usearch(?:\.tmp)?$/i.test(file)) {
                    continue;
                }
                fs.unlinkSync(path.join(this.config.storePath, file));
            }
            console.warn(
                `[${this.logPrefix}] 🧹 Removed all persisted diary indexes ` +
                'because orphan chunks had lost diary ownership metadata.'
            );
        } catch (error) {
            console.warn(
                `[${this.logPrefix}] ⚠️ Failed to remove all persisted diary ` +
                `indexes: ${error.message}`
            );
        }
    }

    scheduleSave(name) {
        if (!this.shouldPersist(name) || this.saveTimers.has(name)) return;
        const timer = setTimeout(() => {
            console.log(`[${this.logPrefix}] 💾 Save timer fired: ${name}`);
            this.saveToDisk(name);
            this.saveTimers.delete(name);
        }, this.config.indexSaveDelay);
        this.saveTimers.set(name, timer);
    }

    saveToDisk(name) {
        if (!this.shouldPersist(name)) return;
        const startedAt = Date.now();
        try {
            const index = name === 'global_tags'
                ? this.tagIndex
                : this.diaryIndices.get(name);
            if (index?.save) {
                let stats = null;
                try { stats = index.stats ? index.stats() : null; } catch (_) {}
                console.log(
                    `[${this.logPrefix}] 💾 Saving index start: ${name}, ` +
                    `vectors=${stats?.totalVectors ?? 'unknown'}`
                );
                const filePath = name === 'global_tags'
                    ? path.join(
                        this.config.storePath,
                        'index_global_tags.usearch'
                    )
                    : path.join(
                        this.config.storePath,
                        `index_diary_${crypto.createHash('md5').update(name).digest('hex')}.usearch`
                    );
                index.save(filePath);
            }
            const elapsed = Date.now() - startedAt;
            console.log(
                `[${this.logPrefix}] 💾 Saved index: ${name}, elapsed=${elapsed}ms`
            );
            if (elapsed > 5000) {
                console.warn(
                    `[${this.logPrefix}] 🧯 Slow synchronous index save ` +
                    `detected: ${name}, elapsed=${elapsed}ms`
                );
            }
        } catch (error) {
            console.error(
                `[${this.logPrefix}] Save failed for ${name}:`,
                error
            );
        }
    }

    startIdleSweep() {
        if (this.idleSweepTimer) return;
        this.idleSweepTimer = setInterval(
            () => this.evictIdle(),
            this.config.indexIdleSweepInterval
        );
        this.idleSweepTimer.unref?.();
        console.log(
            `[${this.logPrefix}] 🧹 Idle index sweep started ` +
            `(TTL: ${Math.round(this.config.indexIdleTTL / 60000)}min, ` +
            `interval: ${Math.round(this.config.indexIdleSweepInterval / 60000)}min)`
        );
    }

    evictIdle() {
        const startedAt = Date.now();
        const now = Date.now();
        let evicted = 0;
        for (const [name, lastUsed] of this.lastUsed) {
            if (now - lastUsed < this.config.indexIdleTTL) continue;
            if (!this.diaryIndices.has(name)) {
                this.lastUsed.delete(name);
                continue;
            }
            try {
                if (this.saveTimers.has(name)) {
                    clearTimeout(this.saveTimers.get(name));
                    this.saveTimers.delete(name);
                }
                this.saveToDisk(name);
                this.diaryIndices.delete(name);
                this.lastUsed.delete(name);
                this.invalidateDiaryDateIndex(name);
                evicted++;
                console.log(
                    `[${this.logPrefix}] 🧹 Evicted idle index: "${name}" ` +
                    `(idle ${Math.round((now - lastUsed) / 60000)}min)`
                );
            } catch (error) {
                console.error(
                    `[${this.logPrefix}] ❌ Failed to evict index "${name}":`,
                    error.message
                );
            }
        }
        if (evicted > 0) {
            console.log(
                `[${this.logPrefix}] 🧹 Idle sweep complete: evicted ${evicted} ` +
                `index(es), ${this.diaryIndices.size} remaining in memory, ` +
                `elapsed=${Date.now() - startedAt}ms.`
            );
        }
    }

    stopIdleSweep() {
        if (this.idleSweepTimer) clearInterval(this.idleSweepTimer);
        this.idleSweepTimer = null;
    }

    async flushAndStop() {
        this.stopIdleSweep();
        await this.recoveryTail;
        for (const [name, timer] of this.saveTimers) {
            clearTimeout(timer);
            this.saveToDisk(name);
        }
        this.saveTimers.clear();
    }
}

module.exports = IndexRepository;