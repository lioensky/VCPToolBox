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
    _diarySafeName(diaryName) {
        return crypto.createHash('md5')
            .update(String(diaryName || '').trim())
            .digest('hex');
    }

    _diaryBaselinePath(diaryName, slot) {
        const safeName = this._diarySafeName(diaryName);
        return path.join(
            this.config.storePath,
            `index_diary_${safeName}_${slot}.usearch`
        );
    }

    _readActiveDiaryBaseline(diaryName) {
        const db = this.getDb?.();
        if (!db) return null;
        const normalized = String(diaryName || '').trim();
        if (!normalized) return null;
        const row = db.prepare(`
            SELECT generation, slot, dimension, model_sig, chunk_count, status
            FROM chunk_index_baselines
            WHERE diary_name = ? AND status = 'ready'
            ORDER BY generation DESC
            LIMIT 1
        `).get(normalized);
        if (!row || !Number.isInteger(Number(row.generation)) || !['a', 'b'].includes(row.slot)) {
            return null;
        }
        return {
            diaryName: normalized,
            generation: Number(row.generation),
            slot: row.slot,
            dimension: Number(row.dimension),
            modelSig: row.model_sig,
            chunkCount: Number(row.chunk_count)
        };
    }

    _countDiaryBaselineDelta(diaryName, generation) {
        const db = this.getDb?.();
        if (!db || !Number.isInteger(Number(generation))) return null;
        const normalized = String(diaryName || '').trim();
        if (!normalized) return null;

        // 集合对称差分统计：
        // 1. deletes：基线已记录但权威库里已被删除（或移到其他日记本）的 chunk_id 数量
        // 2. upserts：权威库里有效存在但基线未记录的新 chunk_id 数量
        const row = db.prepare(`
            SELECT
                (
                    SELECT COUNT(*)
                    FROM chunk_index_baseline_entries e
                    LEFT JOIN chunks c ON c.id = e.chunk_id
                    LEFT JOIN files f ON f.id = c.file_id AND f.diary_name = ?
                    WHERE e.diary_name = ? AND e.generation = ?
                      AND (c.id IS NULL OR f.id IS NULL OR c.vector IS NULL)
                ) AS deletes,
                (
                    SELECT COUNT(*)
                    FROM chunks c
                    JOIN files f ON f.id = c.file_id
                    LEFT JOIN chunk_index_baseline_entries e
                      ON e.diary_name = f.diary_name AND e.generation = ? AND e.chunk_id = c.id
                    WHERE f.diary_name = ? AND c.vector IS NOT NULL AND e.chunk_id IS NULL
                ) AS upserts,
                (
                    SELECT COUNT(*)
                    FROM chunks c
                    JOIN files f ON f.id = c.file_id
                    WHERE f.diary_name = ? AND c.vector IS NOT NULL
                ) AS current_count,
                (
                    SELECT COUNT(*)
                    FROM chunk_index_baseline_entries
                    WHERE diary_name = ? AND generation = ?
                ) AS baseline_count
        `).get(
            normalized, normalized, generation,
            generation, normalized,
            normalized,
            normalized, generation
        );

        const upserts = Number(row?.upserts) || 0;
        const deletes = Number(row?.deletes) || 0;
        const currentCount = Number(row?.current_count) || 0;
        const baselineCount = Number(row?.baseline_count) || 0;
        const delta = upserts + deletes;
        const ratio = delta / Math.max(1, currentCount, baselineCount);
        return { upserts, deletes, delta, ratio, currentCount, baselineCount };
    }

    /**
     * 加载落后的单 Agent usearch 双槽基线，并由 SQLite 在内存原子回放差分。
     */
    async loadDiaryBaseline(diaryName, capacity = 50000) {
        const startedAt = Date.now();
        const db = this.getDb?.();
        const normalized = String(diaryName || '').trim();
        const active = this._readActiveDiaryBaseline(normalized);
        if (!db || !active) return null;

        if (
            Number(active.dimension) !== Number(this.config.dimension)
            || active.modelSig !== this.config.modelSig
        ) {
            console.log(
                `[${this.logPrefix}] ⚠️ Diary baseline model signature mismatch for "${normalized}": ` +
                `stored=(${active.dimension}, ${active.modelSig}) vs config=(${this.config.dimension}, ${this.config.modelSig}).`
            );
            return null;
        }

        const indexPath = this._diaryBaselinePath(normalized, active.slot);
        if (!fs.existsSync(indexPath)) return null;

        let index;
        try {
            const loadStartedAt = Date.now();
            index = this.VexusIndex.load(
                indexPath,
                null,
                this.config.dimension,
                Math.max(capacity, Number(active.chunkCount) || 0)
            );
            const loadMs = Date.now() - loadStartedAt;

            const delta = this._countDiaryBaselineDelta(normalized, active.generation);
            if (!delta) {
                return { index, active, delta: null, loadMs, replayMs: 0, totalMs: loadMs };
            }

            const replayStartedAt = Date.now();

            // 1. 查找需剔除的旧 chunk_id
            const deletedRows = db.prepare(`
                SELECT e.chunk_id
                FROM chunk_index_baseline_entries e
                LEFT JOIN chunks c ON c.id = e.chunk_id
                LEFT JOIN files f ON f.id = c.file_id AND f.diary_name = ?
                WHERE e.diary_name = ? AND e.generation = ?
                  AND (c.id IS NULL OR f.id IS NULL OR c.vector IS NULL)
                ORDER BY e.chunk_id
            `).all(normalized, normalized, active.generation);
            const removeIds = deletedRows.map(r => Number(r.chunk_id)).filter(Number.isSafeInteger);

            // 2. 查找需增量灌入的新 chunk_id 与向量
            const addedRows = db.prepare(`
                SELECT c.id, c.vector
                FROM chunks c
                JOIN files f ON f.id = c.file_id
                LEFT JOIN chunk_index_baseline_entries e
                  ON e.diary_name = f.diary_name AND e.generation = ? AND e.chunk_id = c.id
                WHERE f.diary_name = ? AND c.vector IS NOT NULL AND e.chunk_id IS NULL
                ORDER BY c.id
            `).all(active.generation, normalized);

            const upsertIds = [];
            const flat = new Float32Array(addedRows.length * this.config.dimension);
            let valid = 0;
            for (const row of addedRows) {
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
                upsertIds.push(Number(row.id));
                flat.set(vector, valid * this.config.dimension);
                valid++;
            }

            if (removeIds.length > 0 || valid > 0) {
                if (typeof index.applyChunkDelta === 'function') {
                    const finalFlat = valid === upsertIds.length ? flat : flat.slice(0, valid * this.config.dimension);
                    await index.applyChunkDelta(removeIds, upsertIds, finalFlat);
                } else {
                    for (const id of removeIds) {
                        try { index.remove(id); } catch (_) {}
                    }
                    if (valid > 0) {
                        index.addBatch(upsertIds, valid === upsertIds.length ? flat : flat.slice(0, valid * this.config.dimension));
                    }
                }
            }

            const replayMs = Date.now() - replayStartedAt;
            const totalMs = Date.now() - startedAt;
            console.log(
                `[${this.logPrefix}] ⚡ Diary baseline restored: "${normalized}", generation=${active.generation}, ` +
                `slot=${active.slot}, baseline=${delta.baselineCount}, current=${delta.currentCount}, ` +
                `upserts=${delta.upserts}, deletes=${delta.deletes}, delta=${(delta.ratio * 100).toFixed(2)}%, ` +
                `load=${loadMs}ms, replay=${replayMs}ms, total=${totalMs}ms.`
            );
            return { index, active, delta, loadMs, replayMs, totalMs };
        } catch (error) {
            console.warn(
                `[${this.logPrefix}] ⚠️ Diary baseline load/replay failed for "${normalized}"; ` +
                `falling back to SQLite rebuild: ${error.message}`
            );
            return null;
        }
    }

    /**
     * 将当前内存索引写入非活动槽并原子发布为新代基线。
     */
    publishDiaryBaseline(diaryName, options = {}) {
        const normalized = String(diaryName || '').trim();
        if (!normalized) return false;
        const index = this.diaryIndices.get(normalized);
        if (!index?.save) return false;
        const db = this.getDb?.();
        if (!db) return false;

        const active = this._readActiveDiaryBaseline(normalized);
        const delta = active
            ? this._countDiaryBaselineDelta(normalized, active.generation)
            : null;

        if (
            options.force !== true
            && delta
            && delta.ratio < this.chunkBaselineDeltaRatio
        ) {
            console.log(
                `[${this.logPrefix}] 🛡️ Diary baseline checkpoint skipped for "${normalized}": ` +
                `delta=${delta.delta}/${Math.max(delta.currentCount, delta.baselineCount)} ` +
                `(${(delta.ratio * 100).toFixed(2)}%) < ${(this.chunkBaselineDeltaRatio * 100).toFixed(2)}%.`
            );
            return false;
        }

        const nextSlot = active?.slot === 'a' ? 'b' : 'a';
        const nextGeneration = Number(
            db.prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM chunk_index_baselines WHERE diary_name = ?')
                .get(normalized)?.generation
        ) || 1;
        const indexPath = this._diaryBaselinePath(normalized, nextSlot);
        const saveStartedAt = Date.now();
        index.save(indexPath);

        const publish = db.transaction(() => {
            db.prepare(`
                INSERT INTO chunk_index_baselines
                    (diary_name, generation, slot, dimension, model_sig, chunk_count, status, created_at)
                VALUES (?, ?, ?, ?, ?, (
                    SELECT COUNT(*)
                    FROM chunks c
                    JOIN files f ON f.id = c.file_id
                    WHERE f.diary_name = ? AND c.vector IS NOT NULL
                ), 'ready', ?)
            `).run(
                normalized,
                nextGeneration,
                nextSlot,
                this.config.dimension,
                this.config.modelSig,
                normalized,
                Date.now()
            );

            db.prepare(`
                INSERT INTO chunk_index_baseline_entries
                    (diary_name, generation, chunk_id)
                SELECT ?, ?, c.id
                FROM chunks c
                JOIN files f ON f.id = c.file_id
                WHERE f.diary_name = ? AND c.vector IS NOT NULL
            `).run(normalized, nextGeneration, normalized);

            db.prepare(
                'DELETE FROM chunk_index_baselines WHERE diary_name = ? AND generation != ?'
            ).run(normalized, nextGeneration);
        });
        publish();

        console.log(
            `[${this.logPrefix}] 💾 Diary baseline checkpoint published: "${normalized}", ` +
            `generation=${nextGeneration}, slot=${nextSlot}, ` +
            `threshold=${(this.chunkBaselineDeltaRatio * 100).toFixed(2)}%, ` +
            `elapsed=${Date.now() - saveStartedAt}ms.`
        );
        return true;
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
        if (name === 'global_tags') {
            return this.config.persistTagIndex
                || this.config.persistFolders.has('global_tags');
        }
        if (this.chunkIndexPersistenceMode === 'none') {
            return false;
        }
        return this.config.persistDefault
            || this.config.persistFolders.has(name)
            || name.endsWith('簇');
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
        if (persist) {
            if (this.chunkIndexPersistenceMode === 'generational') {
                const baselineRestore = await this.loadDiaryBaseline(diaryName, capacity);
                if (baselineRestore?.index) {
                    index = baselineRestore.index;
                } else {
                    console.log(
                        `[${this.logPrefix}] 🔄 No valid generational baseline for "${diaryName}", ` +
                        'rebuilding from SQLite and publishing initial baseline...'
                    );
                    index = new this.VexusIndex(this.config.dimension, capacity);
                    await this.recoverFromDb(index, 'chunks', diaryName);
                    this.diaryIndices.set(diaryName, index);
                    this.publishDiaryBaseline(diaryName, { force: true });
                }
            } else {
                index = await this.loadOrBuild(
                    fileName,
                    capacity,
                    'chunks',
                    diaryName
                );
            }
        } else {
            index = new this.VexusIndex(
                this.config.dimension,
                capacity
            );
            await this.recoverFromDb(index, 'chunks', diaryName);
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
                    try {
                        this.onDiaryIndexPublished(name, index);
                    } catch (error) {
                        if (this.diaryIndices.get(name) === index) {
                            this.diaryIndices.delete(name);
                        }
                        this.lastUsed.delete(name);
                        throw new Error(
                            `Diary index loaded but native publication failed for ` +
                            `"${name}": ${error.message}`
                        );
                    }
                    this.ensureDiaryDateIndex(name);
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

    /**
     * 将一个日记本的 Chunk 删除与 upsert 作为单个索引发布批次执行。
     *
     * 新原生 ABI 在同一 RwLock 写锁内完成整个差分；并发 search 只能看到批次前
     * 或批次后状态。旧二进制或原生部分应用失败时，禁止退回逐条 add/remove：
     * 直接丢弃当前实例，从 SQLite 权威事实层构建完整替代实例后再发布。
     */
    async applyChunkDelta(diaryName, removeIds = [], upserts = []) {
        const normalizedDiaryName = String(diaryName || '').trim();
        const deletes = [...new Set(
            (Array.isArray(removeIds) ? removeIds : [])
                .map(Number)
                .filter(id => Number.isSafeInteger(id) && id > 0)
        )];
        const normalizedUpserts = (Array.isArray(upserts) ? upserts : [])
            .map(entry => ({
                id: Number(entry?.id),
                vec: entry?.vec
            }))
            .filter(entry =>
                Number.isSafeInteger(entry.id)
                && entry.id > 0
                && entry.vec
                && typeof entry.vec.length === 'number'
                && entry.vec.length === this.config.dimension
            );

        if (deletes.length === 0 && normalizedUpserts.length === 0) {
            return {
                mode: 'noop',
                requestedDeletes: 0,
                requestedUpserts: 0
            };
        }
        if (!normalizedDiaryName) {
            throw new TypeError('applyChunkDelta requires a diary name');
        }

        let index = this.diaryIndices.get(normalizedDiaryName);
        if (!index) {
            index = await this.getOrLoad(normalizedDiaryName, {
                allowJsProcessing: true,
                allowJsDeleteProcessing: true,
                bypassCoordinator: true
            });
        }
        if (typeof index?.applyChunkDelta === 'function') {
            const ids = normalizedUpserts.map(entry => entry.id);
            const vectors = new Float32Array(ids.length * this.config.dimension);
            normalizedUpserts.forEach((entry, position) => {
                vectors.set(entry.vec, position * this.config.dimension);
            });

            try {
                const result = await index.applyChunkDelta(deletes, ids, vectors);
                this.scheduleSave(normalizedDiaryName);
                return {
                    mode: 'native-atomic-delta',
                    ...result
                };
            } catch (error) {
                console.error(
                    `[${this.logPrefix}] ❌ Atomic Chunk delta failed for ` +
                    `"${normalizedDiaryName}"; discarding the instance and rebuilding ` +
                    `from authoritative SQLite: ${error.message}`
                );
            }
        } else {
            console.warn(
                `[${this.logPrefix}] ⚠️ applyChunkDelta ABI unavailable for ` +
                `"${normalizedDiaryName}"; rebuilding the complete index instead of ` +
                `exposing a non-atomic per-item update.`
            );
        }

        // 失败的原生差分可能已经部分修改 usearch；旧实例绝不能重新发布。
        if (this.diaryIndices.get(normalizedDiaryName) === index) {
            this.diaryIndices.delete(normalizedDiaryName);
        }
        this.lastUsed.delete(normalizedDiaryName);
        this.deletePersisted(normalizedDiaryName);

        const replacement = new this.VexusIndex(this.config.dimension, 50000);
        const recovered = await this.recoverFromDb(
            replacement,
            'chunks',
            normalizedDiaryName
        );
        const expected = Number(
            this.getDb?.()?.prepare(`
                SELECT COUNT(*) AS count
                FROM chunks c
                JOIN files f ON f.id = c.file_id
                WHERE f.diary_name = ? AND c.vector IS NOT NULL
            `).get(normalizedDiaryName)?.count
        ) || 0;
        if (recovered !== expected) {
            throw new Error(
                `Chunk index recovery count mismatch for "${normalizedDiaryName}": ` +
                `expected ${expected}, recovered ${recovered}`
            );
        }

        this.diaryIndices.set(normalizedDiaryName, replacement);
        try {
            this.onDiaryIndexPublished(normalizedDiaryName, replacement);
        } catch (error) {
            if (this.diaryIndices.get(normalizedDiaryName) === replacement) {
                this.diaryIndices.delete(normalizedDiaryName);
            }
            this.lastUsed.delete(normalizedDiaryName);
            throw new Error(
                `Recovered diary index native publication failed for ` +
                `"${normalizedDiaryName}": ${error.message}`
            );
        }
        this.lastUsed.set(normalizedDiaryName, Date.now());
        this.ensureDiaryDateIndex(normalizedDiaryName);
        this.scheduleSave(normalizedDiaryName);
        console.warn(
            `[${this.logPrefix}] ♻️ Diary index rebuilt atomically after delta ` +
            `fallback: "${normalizedDiaryName}", vectors=${recovered}.`
        );
        return {
            mode: 'sqlite-full-recovery',
            requestedDeletes: deletes.length,
            requestedUpserts: normalizedUpserts.length,
            totalVectors: recovered
        };
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
            slotBPath, `${slotBPath}.tmp`
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

        // 清理数据库中的双槽基线元数据
        try {
            const db = this.getDb?.();
            if (db) {
                db.prepare('DELETE FROM chunk_index_baselines WHERE diary_name = ?').run(normalized);
            }
        } catch (error) {
            console.warn(
                `[${this.logPrefix}] ⚠️ Failed to delete chunk baseline records for "${normalized}": ${error.message}`
            );
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
                    !/^index_diary_[a-f0-9]{32}(?:_[ab]|_slot_[ab])?\.usearch(?:\.tmp)?$/i.test(file)
                ) {
                    continue;
                }
                fs.unlinkSync(path.join(this.config.storePath, file));
            }
            const db = this.getDb?.();
            if (db) {
                db.prepare('DELETE FROM chunk_index_baselines').run();
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

            if (this.chunkIndexPersistenceMode === 'generational') {
                return this.publishDiaryBaseline(name, options);
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
                    `index_diary_${this._diarySafeName(name)}.usearch`
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
        for (const [name, timer] of this.saveTimers) {
            clearTimeout(timer);
            this.saveToDisk(name);
        }
        this.saveTimers.clear();
    }
}

module.exports = IndexRepository;