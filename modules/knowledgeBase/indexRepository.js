'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class IndexRepository {
    constructor(options = {}) {
        this.config = options.config;
        this.VexusIndex = options.VexusIndex;
        this.getDbPath = options.getDbPath;
        this.getDb = options.getDb;
        this.getNativeRuntime = options.getNativeRuntime || (() => null);
        this.waitForCoordinatorIdle = options.waitForCoordinatorIdle;
        this.ensureDiaryDateIndex = options.ensureDiaryDateIndex || (() => {});
        this.invalidateDiaryDateIndex = options.invalidateDiaryDateIndex || (() => {});
        this.onDiaryIndexPublished = options.onDiaryIndexPublished || (() => null);
        this.onDiaryIndexRemoved = options.onDiaryIndexRemoved || (() => false);
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
        this.tagBaselineDeltaRatio = Number.isFinite(Number(this.config.tagIndexBaselineDeltaRatio))
            ? Math.max(0.001, Math.min(1, Number(this.config.tagIndexBaselineDeltaRatio)))
            : 0.05;
        this.chunkBaselineDeltaRatio = Number.isFinite(Number(this.config.chunkIndexBaselineDeltaRatio))
            ? Math.max(0.001, Math.min(1, Number(this.config.chunkIndexBaselineDeltaRatio)))
            : 0.05;
        this.chunkIndexPersistenceMode = this.config.chunkIndexPersistenceMode || 'generational';
    }

    _tagBaselinePath(slot) {
        return path.join(
            this.config.storePath,
            `index_global_tags_${slot}.vec`
        );
    }

    _diarySafeName(diaryName) {
        return crypto.createHash('md5')
            .update(String(diaryName || '').trim())
            .digest('hex');
    }

    _diaryBaselinePath(diaryName, slot) {
        const safeName = this._diarySafeName(diaryName);
        return path.join(
            this.config.storePath,
            `index_diary_${safeName}_${slot}.vec`
        );
    }


    /**
     * 通过 NativeKnowledgeRuntime 在 Rust 后台恢复日记索引。
     *
     * Rust 负责 SQL 背书校验、TDB 派生资产加载、成员差分回放和无基线重建；
     * 该门面不读取中央数据库，也不接收 Vector BLOB。
     */
    async restoreDiaryIndex(diaryName, index, capacity = 50000) {
        const normalized = String(diaryName || '').trim();
        if (!normalized || !index) return null;

        const runtime = this.getNativeRuntime?.();
        if (!runtime?.restoreDiaryIndex) {
            throw new Error('NativeKnowledgeRuntime restoreDiaryIndex ABI is unavailable');
        }

        const raw = await runtime.restoreDiaryIndex(
            this.getDbPath(),
            normalized,
            this._diaryBaselinePath(normalized, 'a'),
            String(this.config.modelSig || ''),
            Math.max(1, Number(capacity) || 1),
            index
        );
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!result || result.restored !== true) {
            throw new Error(
                `Invalid Rust diary restore receipt for "${normalized}"`
            );
        }

        console.log(
            `[${this.logPrefix}] ⚡ Rust diary index restored: "${normalized}", ` +
            `generation=${Number(result.generation) || 0}, slot=${result.slot || 'none'}, ` +
            `vectors=${Number(result.vectorCount) || 0}, ` +
            `replayed=${result.replayed === true}, rebuilt=${result.rebuilt === true}.`
        );
        return result;
    }

    /**
     * 将当前内存索引交给 Rust Runtime 执行阈值判断、双槽保存和基线发布。
     */
    async publishDiaryBaseline(diaryName, options = {}) {
        const normalized = String(diaryName || '').trim();
        if (!normalized || !this.shouldPersist(normalized)) return false;
        const runtime = this.getNativeRuntime?.();
        if (!runtime?.checkpointDiaryIndex) {
            throw new Error('NativeKnowledgeRuntime checkpointDiaryIndex ABI is unavailable');
        }
        const index = this.diaryIndices.get(normalized);
        if (!index) return false;

        // 思维簇独立采用 notify-always；Rust 仍拒绝零差异重复发布。
        const isThoughtCluster = normalized.endsWith('簇');
        const threshold = isThoughtCluster ? 0 : this.chunkBaselineDeltaRatio;
        const startedAt = Date.now();
        const result = await runtime.checkpointDiaryIndex(
            this.getDbPath(),
            normalized,
            this._diaryBaselinePath(normalized, 'a'),
            String(this.config.modelSig || ''),
            threshold,
            false,
            isThoughtCluster || this.config.chunkIndexAllowInitial === true
        );
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        if (!parsed || parsed.factsCommitted !== false) {
            throw new Error(`Invalid Rust diary checkpoint receipt for "${normalized}"`);
        }

        console.log(
            `[${this.logPrefix}] ${parsed.published ? '💾' : '🛡️'} Diary baseline checkpoint ` +
            `${parsed.published ? 'published' : 'skipped'}: "${normalized}", ` +
            `generation=${parsed.generation}, slot=${parsed.slot}, ` +
            `delta=${(Number(parsed.ratio || 0) * 100).toFixed(2)}%, ` +
            `threshold=${(threshold * 100).toFixed(2)}%, ` +
            `elapsed=${Date.now() - startedAt}ms.`
        );
        return parsed.published === true;
    }

    /**
     * 将全局 Tag 索引交给 Rust Runtime 执行阈值判断、双槽保存和基线发布。
     */
    async publishGlobalTagBaseline(options = {}) {
        if (!this.shouldPersist('global_tags')) return false;
        const runtime = this.getNativeRuntime?.();
        if (!runtime?.checkpointGlobalTagIndex) {
            throw new Error('NativeKnowledgeRuntime checkpointGlobalTagIndex ABI is unavailable');
        }
        if (!this.tagIndex) return false;

        const startedAt = Date.now();
        const result = await runtime.checkpointGlobalTagIndex(
            this.getDbPath(),
            this._tagBaselinePath('a'),
            String(this.config.modelSig || ''),
            this.tagBaselineDeltaRatio,
            false,
            this.config.tagIndexAllowInitial === true
        );
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        if (!parsed || parsed.factsCommitted !== false) {
            throw new Error('Invalid Rust global Tag checkpoint receipt');
        }

        console.log(
            `[${this.logPrefix}] ${parsed.published ? '💾' : '🛡️'} Global Tag baseline checkpoint ` +
            `${parsed.published ? 'published' : 'skipped'}, ` +
            `generation=${parsed.generation}, slot=${parsed.slot}, ` +
            `delta=${(Number(parsed.ratio || 0) * 100).toFixed(2)}%, ` +
            `threshold=${(this.tagBaselineDeltaRatio * 100).toFixed(2)}%, ` +
            `elapsed=${Date.now() - startedAt}ms.`
        );
        return parsed.published === true;
    }

    async publishGlobalChunkBaseline() {
        if (this.chunkIndexPersistenceMode === 'none'
            || !(this.config.persistDefault
                || this.config.persistFolders.has('global_chunks'))) return false;
        const runtime = this.getNativeRuntime?.();
        if (typeof runtime?.checkpointGlobalChunkIndex !== 'function') return false;
        const raw = await runtime.checkpointGlobalChunkIndex(
            String(this.config.modelSig || ''),
            this.chunkBaselineDeltaRatio,
            this.config.chunkIndexAllowInitial === true
        );
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!result || result.factsCommitted !== false) {
            throw new Error('Invalid Rust global Chunk checkpoint receipt');
        }
        return result.published === true;
    }

    shouldPersist(name) {
        if (name === 'global_tags') {
            return this.config.persistTagIndex
                || this.config.persistFolders.has('global_tags');
        }
        // 思维簇的保存策略独立于普通日记的模式及白名单。
        if (name.endsWith('簇')) return true;
        if (this.chunkIndexPersistenceMode === 'none') {
            return false;
        }
        return this.config.persistDefault
            || this.config.persistFolders.has(name);
    }

    async _executeLoadIndex(diaryName) {
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
        index = new this.VexusIndex(
            this.config.dimension,
            capacity
        );
        await this.restoreDiaryIndex(diaryName, index, capacity);

        try {
            this.diaryIndices.set(diaryName, index);
            this.onDiaryIndexPublished(diaryName, index);
            if (persist) {
                await this.publishDiaryBaseline(diaryName);
            }
        } catch (error) {
            if (this.diaryIndices.get(diaryName) === index) {
                this.diaryIndices.delete(diaryName);
            }
            try {
                this.onDiaryIndexRemoved(diaryName);
            } catch (unregisterError) {
                console.warn(
                    `[${this.logPrefix}] Failed to unregister diary index "${diaryName}" after load failure:`,
                    unregisterError.message || unregisterError
                );
            }
            throw new Error(
                `Diary index native publication failed for ` +
                `"${diaryName}": ${error.message}`
            );
        }
        return index;
    }

    async getOrLoad(diaryName, options = {}) {
        const name = String(diaryName || '').trim();
        this.lastUsed.set(name, Date.now());
        if (this.diaryIndices.has(name)) {
            return this.diaryIndices.get(name);
        }
        if (this.loadPromises.has(name)) {
            return this.loadPromises.get(name);
        }

        const execute = async () => {
            if (!options.bypassCoordinator) {
                await this.waitForCoordinatorIdle(options);
            }
            if (this.diaryIndices.has(name)) {
                return this.diaryIndices.get(name);
            }

            const load = async () => {
                this.recoveryActive = true;
                this.onRecoveryStateChange(true);
                try {
                    if (this.diaryIndices.has(name)) {
                        return this.diaryIndices.get(name);
                    }
                    const index = await this._executeLoadIndex(name);
                    this.diaryIndices.set(name, index);
                    await this.ensureDiaryDateIndex(name);
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
                    `"${name}":`,
                    error
                );
            });
            this.onRecoveryTailChange(this.recoveryTail);
            return await queued;
        };

        const task = execute();
        this.loadPromises.set(name, task);
        try {
            return await task;
        } finally {
            if (this.loadPromises.get(name) === task) {
                this.loadPromises.delete(name);
            }
        }
    }

    async loadOrBuild(fileName, capacity, tableType, diaryName = null) {
        const index = new this.VexusIndex(this.config.dimension, capacity);
        if (!diaryName) return index;

        const normalized = String(diaryName).trim();
        try {
            await this.restoreDiaryIndex(normalized, index, capacity);
            this.diaryIndices.set(normalized, index);
            this.onDiaryIndexPublished(normalized, index);
            return index;
        } catch (error) {
            if (this.diaryIndices.get(normalized) === index) {
                this.diaryIndices.delete(normalized);
            }
            try {
                this.onDiaryIndexRemoved(normalized);
            } catch (unregisterError) {
                console.warn(
                    `[${this.logPrefix}] Failed to unregister diary index "${normalized}" after load failure:`,
                    unregisterError.message || unregisterError
                );
            }
            throw error;
        }
    }

    async recoverFromDb(index, table, diaryName) {
        if (table !== 'chunks' || !diaryName) {
            throw new Error(
                'Rust Runtime recovery requires a diary name and chunk scope'
            );
        }
        const normalized = String(diaryName).trim();
        try {
            const receipt = await this.restoreDiaryIndex(normalized, index);
            this.diaryIndices.set(normalized, index);
            this.onDiaryIndexPublished(normalized, index);
            return Number(receipt?.vectorCount) || 0;
        } catch (error) {
            if (this.diaryIndices.get(normalized) === index) {
                this.diaryIndices.delete(normalized);
            }
            try {
                this.onDiaryIndexRemoved(normalized);
            } catch (unregisterError) {
                console.warn(
                    `[${this.logPrefix}] Failed to unregister diary index "${normalized}" after recovery failure:`,
                    unregisterError.message || unregisterError
                );
            }
            throw error;
        }
    }

    unregisterDiaryIndex(diaryName) {
        return this.onDiaryIndexRemoved(String(diaryName || '').trim());
    }

    deletePersisted(diaryName) {
        if (!this.shouldPersist(diaryName)) return;
        const normalized = String(diaryName || '').trim();
        const safeName = this._diarySafeName(normalized);
        const legacyPath = path.join(
            this.config.storePath,
            `index_diary_${safeName}.usearch`
        );
        const slotAPath = this._diaryBaselinePath(normalized, 'a');
        const slotBPath = this._diaryBaselinePath(normalized, 'b');

        const targets = [
            legacyPath, `${legacyPath}.tmp`,
            slotAPath, `${slotAPath}.tmp`,
            slotBPath, `${slotBPath}.tmp`,
            path.join(this.config.storePath, `index_diary_${safeName}_a.usearch`),
            path.join(this.config.storePath, `index_diary_${safeName}_b.usearch`)
        ];

        for (const filePath of targets) {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (error) {
                console.warn(
                    `[${this.logPrefix}] ⚠️ Failed to unlink "${filePath}": ${error.message}`
                );
            }
        }

        console.warn(
            `[${this.logPrefix}] 🧹 Removed persisted index and baselines for ` +
            `diary "${normalized}". It will be rebuilt from SQLite.`
        );
    }

    deleteAllPersisted() {
        try {
            for (const file of fs.readdirSync(this.config.storePath)) {
                if (
                    !/^index_diary_[a-f0-9]{32}(?:_[ab]|_slot_[ab])?\.(?:vec|usearch)(?:\.tmp)?$/i.test(file)
                ) {
                    continue;
                }
                fs.unlinkSync(path.join(this.config.storePath, file));
            }
            console.warn(
                `[${this.logPrefix}] 🧹 Removed all persisted diary indexes and baseline records ` +
                'because orphan chunks had lost diary ownership metadata.'
            );
        } catch (error) {
            console.warn(
                `[${this.logPrefix}] ⚠️ Failed to remove all persisted diary indexes: ${error.message}`
            );
        }
    }

    scheduleSave(name) {
        if (!this.shouldPersist(name)) return;

        // 全局 Tag 是允许落后的加速基线：每次热变动只重置静默窗口，
        // 窗口结束后由 Rust 判断差分阈值及格式兼容性，再发布双槽派生资产。
        if (name === 'global_tags' && this.saveTimers.has(name)) {
            clearTimeout(this.saveTimers.get(name));
            this.saveTimers.delete(name);
        } else if (this.saveTimers.has(name)) {
            return;
        }

        const delay = name === 'global_tags'
            ? this.config.tagIndexSaveDelay
            : this.config.indexSaveDelay;
        const timer = setTimeout(() => {
            this.saveTimers.delete(name);
            console.log(`[${this.logPrefix}] 💾 Save timer fired: ${name}`);
            Promise.resolve(this.saveToDisk(name)).catch(error => {
                console.error(
                    `[${this.logPrefix}] Save timer failed for ${name}:`,
                    error
                );
            });
        }, delay);
        timer.unref?.();
        this.saveTimers.set(name, timer);
    }

    async saveToDisk(name, options = {}) {
        if (!this.shouldPersist(name)) return false;
        const startedAt = Date.now();

        try {
            if (name === 'global_tags') {
                return await this.publishGlobalTagBaseline();
            }

            const published = await this.publishDiaryBaseline(name);
            console.log(
                `[${this.logPrefix}] ${published ? '💾' : '🛡️'} Rust diary checkpoint finished: ` +
                `${name}, elapsed=${Date.now() - startedAt}ms`
            );
            return published;
        } catch (error) {
            console.error(
                `[${this.logPrefix}] Rust checkpoint failed for ${name}:`,
                error
            );
            throw error;
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

    async evictIdle() {
        const startedAt = Date.now();
        const now = Date.now();
        let evicted = 0;
        const runtime = this.getNativeRuntime?.();
        try {
            await this.publishGlobalChunkBaseline();
        } catch (error) {
            console.warn(`[${this.logPrefix}] Global Chunk checkpoint failed: ${error.message}`);
        }
        if (typeof runtime?.evictIdleLightMemoIndex === 'function') {
            const configuredTTL = Number(this.config.lightMemoIndexIdleTTL);
            const ttl = Number.isFinite(configuredTTL) && configuredTTL > 0
                ? Math.min(0xffffffff, Math.floor(configuredTTL))
                : 10 * 60 * 1000;
            try {
                if (runtime.evictIdleLightMemoIndex(ttl)) {
                    console.log(`[${this.logPrefix}] 🧹 Evicted idle LightMemo global Chunk index.`);
                }
            } catch (error) {
                console.warn(`[${this.logPrefix}] LightMemo idle eviction failed: ${error.message}`);
            }
        }
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
                const index = this.diaryIndices.get(name);
                await this.saveToDisk(name);
                if (this.diaryIndices.get(name) !== index
                    || this.lastUsed.get(name) !== lastUsed
                    || Date.now() - (this.lastUsed.get(name) || 0) < this.config.indexIdleTTL) {
                    continue;
                }
                this.unregisterDiaryIndex(name);
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
        const names = new Set([...this.saveTimers.keys(), ...this.diaryIndices.keys()]);
        if (this.tagIndex) names.add('global_tags');
        for (const timer of this.saveTimers.values()) clearTimeout(timer);
        this.saveTimers.clear();
        for (const name of names) await this.saveToDisk(name);
        await this.publishGlobalChunkBaseline();
    }
}

module.exports = IndexRepository;