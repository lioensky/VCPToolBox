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
        this.tagBaselineDeltaRatio = Number.isFinite(Number(this.config.tagIndexBaselineDeltaRatio))
            ? Math.max(0.001, Math.min(1, Number(this.config.tagIndexBaselineDeltaRatio)))
            : 0.05;
    }

    _tagBaselinePath(slot) {
        return path.join(
            this.config.storePath,
            `index_global_tags_${slot}.usearch`
        );
    }

    _readActiveTagBaseline() {
        const db = this.getDb?.();
        if (!db) return null;
        const raw = db.prepare(
            "SELECT value FROM kv_store WHERE key = 'tag_index_active_baseline'"
        ).get()?.value;
        if (!raw) return null;
        try {
            const value = JSON.parse(raw);
            if (
                !Number.isInteger(Number(value.generation))
                || !['a', 'b'].includes(value.slot)
            ) {
                return null;
            }
            return {
                generation: Number(value.generation),
                slot: value.slot
            };
        } catch (_) {
            return null;
        }
    }

    _countTagBaselineDelta(generation) {
        const db = this.getDb?.();
        if (!db || !Number.isInteger(Number(generation))) return null;
        const row = db.prepare(`
            SELECT
                (SELECT COUNT(*)
                 FROM tags t
                 LEFT JOIN tag_index_baseline_entries e
                   ON e.generation = ? AND e.tag_id = t.id
                 WHERE t.vector IS NOT NULL
                   AND (e.tag_id IS NULL OR e.vector_version != t.vector_version)
                ) AS upserts,
                (SELECT COUNT(*)
                 FROM tag_index_baseline_entries e
                 LEFT JOIN tags t ON t.id = e.tag_id AND t.vector IS NOT NULL
                 WHERE e.generation = ? AND t.id IS NULL
                ) AS deletes,
                (SELECT COUNT(*) FROM tags WHERE vector IS NOT NULL) AS current_count,
                (SELECT COUNT(*) FROM tag_index_baseline_entries WHERE generation = ?) AS baseline_count
        `).get(generation, generation, generation);
        const upserts = Number(row?.upserts) || 0;
        const deletes = Number(row?.deletes) || 0;
        const currentCount = Number(row?.current_count) || 0;
        const baselineCount = Number(row?.baseline_count) || 0;
        const delta = upserts + deletes;
        const ratio = delta / Math.max(1, currentCount, baselineCount);
        return { upserts, deletes, delta, ratio, currentCount, baselineCount };
    }

    /**
     * 加载允许落后的 usearch 基线，并按 SQLite 权威 tags 表回放差分。
     * 未变化 Tag 的高维 BLOB 不会离开 SQLite。
     */
    loadGlobalTagBaseline(capacity = 50000) {
        const startedAt = Date.now();
        const db = this.getDb?.();
        const active = this._readActiveTagBaseline();
        if (!db || !active) return null;

        const manifest = db.prepare(`
            SELECT generation, slot, dimension, model_sig, tag_count, status
            FROM tag_index_baselines
            WHERE generation = ? AND slot = ? AND status = 'ready'
        `).get(active.generation, active.slot);
        if (
            !manifest
            || Number(manifest.dimension) !== Number(this.config.dimension)
            || manifest.model_sig !== this.config.modelSig
        ) {
            return null;
        }

        const indexPath = this._tagBaselinePath(active.slot);
        if (!fs.existsSync(indexPath)) return null;

        let index;
        try {
            const loadStartedAt = Date.now();
            index = this.VexusIndex.load(
                indexPath,
                null,
                this.config.dimension,
                Math.max(capacity, Number(manifest.tag_count) || 0)
            );
            const loadMs = Date.now() - loadStartedAt;

            const delta = this._countTagBaselineDelta(active.generation);
            const changedRows = db.prepare(`
                SELECT t.id, t.vector
                FROM tags t
                LEFT JOIN tag_index_baseline_entries e
                  ON e.generation = ? AND e.tag_id = t.id
                WHERE t.vector IS NOT NULL
                  AND (e.tag_id IS NULL OR e.vector_version != t.vector_version)
                ORDER BY t.id
            `).all(active.generation);
            const deletedRows = db.prepare(`
                SELECT e.tag_id
                FROM tag_index_baseline_entries e
                LEFT JOIN tags t ON t.id = e.tag_id AND t.vector IS NOT NULL
                WHERE e.generation = ? AND t.id IS NULL
                ORDER BY e.tag_id
            `).all(active.generation);

            const replayStartedAt = Date.now();
            for (const row of deletedRows) {
                try { index.remove(Number(row.tag_id)); } catch (_) {}
            }

            const ids = [];
            const flat = new Float32Array(changedRows.length * this.config.dimension);
            let valid = 0;
            for (const row of changedRows) {
                const bytes = row.vector;
                if (!bytes || bytes.length !== this.config.dimension * 4) continue;
                let vector;
                if (bytes.byteOffset % 4 === 0) {
                    vector = new Float32Array(
                        bytes.buffer,
                        bytes.byteOffset,
                        this.config.dimension
                    );
                } else {
                    const aligned = Buffer.from(bytes);
                    vector = new Float32Array(
                        aligned.buffer,
                        aligned.byteOffset,
                        this.config.dimension
                    );
                }
                ids.push(Number(row.id));
                flat.set(vector, valid * this.config.dimension);
                valid++;
            }
            if (valid > 0) {
                index.addBatch(ids, valid === ids.length ? flat : flat.slice(0, valid * this.config.dimension));
            }
            const replayMs = Date.now() - replayStartedAt;
            const totalMs = Date.now() - startedAt;
            console.log(
                `[${this.logPrefix}] ⚡ Global Tag baseline restored: generation=${active.generation}, ` +
                `slot=${active.slot}, baseline=${delta.baselineCount}, current=${delta.currentCount}, ` +
                `upserts=${delta.upserts}, deletes=${delta.deletes}, delta=${(delta.ratio * 100).toFixed(2)}%, ` +
                `load=${loadMs}ms, replay=${replayMs}ms, total=${totalMs}ms.`
            );
            return { index, active, delta, loadMs, replayMs, totalMs };
        } catch (error) {
            console.warn(
                `[${this.logPrefix}] ⚠️ Global Tag baseline load/replay failed; ` +
                `falling back to SQLite rebuild: ${error.message}`
            );
            return null;
        }
    }

    /**
     * 将当前完整内存索引压缩成新的双槽基线。
     * 先写非活动 usearch 槽，文件发布成功后才在单个 SQLite 事务中切换成员页。
     */
    publishGlobalTagBaseline(options = {}) {
        if (!this.tagIndex?.save) return false;
        const db = this.getDb?.();
        if (!db) return false;

        const active = this._readActiveTagBaseline();
        const delta = active
            ? this._countTagBaselineDelta(active.generation)
            : null;
        if (
            options.force !== true
            && delta
            && delta.ratio < this.tagBaselineDeltaRatio
        ) {
            console.log(
                `[${this.logPrefix}] 🛡️ Global Tag baseline checkpoint skipped: ` +
                `delta=${delta.delta}/${Math.max(delta.currentCount, delta.baselineCount)} ` +
                `(${(delta.ratio * 100).toFixed(2)}%) < ${(this.tagBaselineDeltaRatio * 100).toFixed(2)}%.`
            );
            return false;
        }

        const nextSlot = active?.slot === 'a' ? 'b' : 'a';
        const nextGeneration = Number(
            db.prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM tag_index_baselines').get()?.generation
        ) || 1;
        const indexPath = this._tagBaselinePath(nextSlot);
        const saveStartedAt = Date.now();
        this.tagIndex.save(indexPath);

        const publish = db.transaction(() => {
            db.prepare(`
                INSERT INTO tag_index_baselines
                    (generation, slot, dimension, model_sig, tag_count, status, created_at)
                VALUES (?, ?, ?, ?, (SELECT COUNT(*) FROM tags WHERE vector IS NOT NULL), 'ready', ?)
            `).run(
                nextGeneration,
                nextSlot,
                this.config.dimension,
                this.config.modelSig,
                Date.now()
            );
            db.prepare(`
                INSERT INTO tag_index_baseline_entries
                    (generation, tag_id, vector_version)
                SELECT ?, id, vector_version
                FROM tags
                WHERE vector IS NOT NULL
            `).run(nextGeneration);
            db.prepare(`
                INSERT INTO kv_store (key, value)
                VALUES ('tag_index_active_baseline', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            `).run(JSON.stringify({
                generation: nextGeneration,
                slot: nextSlot
            }));
            db.prepare(
                'DELETE FROM tag_index_baselines WHERE generation != ?'
            ).run(nextGeneration);
        });
        publish();

        console.log(
            `[${this.logPrefix}] 💾 Global Tag baseline checkpoint published: ` +
            `generation=${nextGeneration}, slot=${nextSlot}, ` +
            `threshold=${(this.tagBaselineDeltaRatio * 100).toFixed(2)}%, ` +
            `elapsed=${Date.now() - saveStartedAt}ms.`
        );
        return true;
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
        if (!this.shouldPersist(name)) return;

        // 全局 Tag 是允许落后的加速基线：每次热变动只重置静默窗口，
        // 窗口结束后仍须达到实际差分 5% 才会重写 usearch。
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
            this.saveToDisk(name);
        }, delay);
        timer.unref?.();
        this.saveTimers.set(name, timer);
    }

    saveToDisk(name, options = {}) {
        if (!this.shouldPersist(name)) return;
        const startedAt = Date.now();
        try {
            if (name === 'global_tags') {
                return this.publishGlobalTagBaseline({
                    ...options,
                    force: options.force === true
                        || this.config.tagIndexPersistenceMode === 'always'
                });
            }
            const index = this.diaryIndices.get(name);
            if (index?.save) {
                let stats = null;
                try { stats = index.stats ? index.stats() : null; } catch (_) {}
                console.log(
                    `[${this.logPrefix}] 💾 Saving index start: ${name}, ` +
                    `vectors=${stats?.totalVectors ?? 'unknown'}`
                );
                const filePath = path.join(
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