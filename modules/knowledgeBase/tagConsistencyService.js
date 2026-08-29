'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { getEmbeddingsBatch } = require('../../EmbeddingUtils');

const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const DETAIL_LIMIT = 200;
const BUILTIN_IGNORED_DIRECTORIES = new Set([
    'node_modules',
    '.git',
    'dist',
    'target',
    'image'
]);

class TagConsistencyService {
    constructor(owner, options = {}) {
        if (!owner) throw new TypeError('TagConsistencyService requires an owner');
        this.owner = owner;
        this.VexusIndex = options.VexusIndex;
        this.snapshots = new Map();
        this.running = false;
        this.latestPreviewTask = null;
        this.previewTaskPromise = null;
    }

    _createError(message, code, statusCode = 500) {
        const error = new Error(message);
        error.code = code;
        error.statusCode = statusCode;
        return error;
    }

    _isIgnored(relativePath) {
        const config = this.owner.config;
        const parts = relativePath.split(/[\\/]+/).filter(Boolean);
        const diaryName = parts.length > 1 ? parts[0] : 'Root';
        const fileName = parts[parts.length - 1] || '';
        const directoryParts = parts.slice(0, -1);

        if (directoryParts.some(part =>
            BUILTIN_IGNORED_DIRECTORIES.has(part)
            || part.startsWith('.')
            || config.ignoreFolders.includes(part)
        )) {
            return true;
        }
        if (config.ignoreFolders.includes(diaryName)) return true;
        if (config.ignorePrefixes.some(prefix =>
            diaryName.startsWith(prefix) || fileName.startsWith(prefix)
        )) {
            return true;
        }
        return config.ignoreSuffixes.some(suffix =>
            diaryName.endsWith(suffix) || fileName.endsWith(suffix)
        );
    }

    _cleanupSnapshots(now = Date.now()) {
        for (const [token, snapshot] of this.snapshots) {
            if (snapshot.expiresAt <= now) this.snapshots.delete(token);
        }
    }

    _loadDatabaseState() {
        const files = this.owner.db.prepare(
            'SELECT id, path, diary_name, checksum, mtime, size FROM files ORDER BY id'
        ).all();
        const tagRows = this.owner.db.prepare(
            'SELECT id, name, vector FROM tags ORDER BY id'
        ).all();
        const relationRows = this.owner.db.prepare(`
            SELECT ft.file_id, ft.tag_id, ft.position, t.name
            FROM file_tags ft
            JOIN tags t ON t.id = ft.tag_id
            ORDER BY ft.file_id, ft.position, ft.tag_id
        `).all();

        const relationsByFile = new Map();
        for (const row of relationRows) {
            if (!relationsByFile.has(row.file_id)) relationsByFile.set(row.file_id, []);
            relationsByFile.get(row.file_id).push({
                tagId: Number(row.tag_id),
                name: row.name,
                position: Number(row.position) || 0
            });
        }

        return { files, tagRows, relationsByFile };
    }

    async _readExpectedTags(fileRow) {
        const relativePath = String(fileRow.path || '');
        if (
            this._isIgnored(relativePath)
            || !/\.(md|txt)$/i.test(relativePath)
        ) {
            return { tags: [], status: 'ignored' };
        }

        const absolutePath = path.resolve(this.owner.config.rootPath, relativePath);
        const rootPath = path.resolve(this.owner.config.rootPath);
        const relativeGuard = path.relative(rootPath, absolutePath);
        if (relativeGuard.startsWith('..') || path.isAbsolute(relativeGuard)) {
            return { tags: [], status: 'outside-root' };
        }

        try {
            const before = await fs.stat(absolutePath);
            const content = await fs.readFile(absolutePath, 'utf8');
            const after = await fs.stat(absolutePath);
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
                throw this._createError(
                    `文件在一致性扫描期间发生变化：${relativePath}`,
                    'TAG_CONSISTENCY_UNSTABLE_FILE',
                    409
                );
            }
            return {
                tags: this.owner._extractTags(content),
                status: 'scanned'
            };
        } catch (error) {
            if (error.code === 'ENOENT') return { tags: [], status: 'missing' };
            throw error;
        }
    }

    _digestPlan(plan) {
        const canonical = {
            rulesSignature: plan.rulesSignature,
            files: plan.files.map(file => ({
                fileId: file.fileId,
                path: file.path,
                status: file.status,
                expectedTags: file.expectedTags,
                currentTags: file.currentTags.map(tag => [tag.name, tag.position])
            })),
            vectorizeNames: plan.vectorizeNames,
            orphanTagIds: plan.orphanTags.map(tag => tag.id)
        };
        return crypto.createHash('sha256')
            .update(JSON.stringify(canonical))
            .digest('hex');
    }

    _rulesSignature() {
        const config = this.owner.config;
        return crypto.createHash('sha256').update(JSON.stringify({
            ignoreFolders: config.ignoreFolders,
            ignorePrefixes: config.ignorePrefixes,
            ignoreSuffixes: config.ignoreSuffixes,
            tagBlacklist: [...config.tagBlacklist].sort(),
            tagBlacklistSuper: config.tagBlacklistSuper,
            maxTagsPerFile: config.maxTagsPerFile,
            dimension: config.dimension,
            modelSig: config.modelSig
        })).digest('hex').slice(0, 24);
    }

    async _buildPlan() {
        const state = this._loadDatabaseState();
        const existingTagByName = new Map(state.tagRows.map(row => [row.name, row]));
        const expectedReferenceCounts = new Map();
        const filePlans = [];

        let scannedFiles = 0;
        let ignoredFiles = 0;
        let missingFiles = 0;
        let relationsToAdd = 0;
        let relationsToRemove = 0;
        let positionsToUpdate = 0;

        for (const fileRow of state.files) {
            const expected = await this._readExpectedTags(fileRow);
            if (expected.status === 'scanned') scannedFiles++;
            else if (expected.status === 'ignored') ignoredFiles++;
            else missingFiles++;

            const expectedTags = expected.tags;
            const expectedSet = new Set(expectedTags);
            const currentTags = state.relationsByFile.get(fileRow.id) || [];
            const currentByName = new Map(currentTags.map(tag => [tag.name, tag]));
            const added = [];
            const removed = [];
            const positionUpdates = [];

            expectedTags.forEach((name, index) => {
                expectedReferenceCounts.set(
                    name,
                    (expectedReferenceCounts.get(name) || 0) + 1
                );
                const current = currentByName.get(name);
                if (!current) {
                    added.push(name);
                } else if (current.position !== index + 1) {
                    positionUpdates.push({
                        name,
                        from: current.position,
                        to: index + 1
                    });
                }
            });
            for (const current of currentTags) {
                if (!expectedSet.has(current.name)) removed.push(current.name);
            }

            relationsToAdd += added.length;
            relationsToRemove += removed.length;
            positionsToUpdate += positionUpdates.length;
            filePlans.push({
                fileId: Number(fileRow.id),
                path: fileRow.path,
                status: expected.status,
                expectedTags,
                currentTags,
                added,
                removed,
                positionUpdates
            });
        }

        const vectorizeNames = [...expectedReferenceCounts.keys()]
            .filter(name => {
                const row = existingTagByName.get(name);
                return !row || !row.vector;
            })
            .sort((left, right) => left.localeCompare(right));

        const orphanTags = state.tagRows
            .filter(row => !expectedReferenceCounts.has(row.name))
            .map(row => ({
                id: Number(row.id),
                name: row.name,
                hasVector: !!row.vector
            }));

        const affectedFiles = filePlans.filter(file =>
            file.added.length > 0
            || file.removed.length > 0
            || file.positionUpdates.length > 0
        );

        const plan = {
            createdAt: Date.now(),
            rulesSignature: this._rulesSignature(),
            files: filePlans,
            tagRows: state.tagRows,
            expectedTagNames: [...expectedReferenceCounts.keys()]
                .sort((left, right) => left.localeCompare(right)),
            vectorizeNames,
            orphanTags,
            summary: {
                totalDatabaseFiles: state.files.length,
                scannedFiles,
                ignoredFiles,
                missingFiles,
                affectedFiles: affectedFiles.length,
                relationsToAdd,
                relationsToRemove,
                positionsToUpdate,
                vectorsToCreate: vectorizeNames.length,
                vectorsToRemove: orphanTags.filter(tag => tag.hasVector).length,
                orphanTagsToRemove: orphanTags.length,
                finalTagCount: expectedReferenceCounts.size
            }
        };
        plan.digest = this._digestPlan(plan);
        return plan;
    }

    _toPublicSnapshot(snapshot) {
        const plan = snapshot.plan;
        return {
            token: snapshot.token,
            digest: plan.digest,
            createdAt: snapshot.createdAt,
            expiresAt: snapshot.expiresAt,
            summary: plan.summary,
            additions: plan.vectorizeNames.slice(0, DETAIL_LIMIT),
            removals: plan.orphanTags.slice(0, DETAIL_LIMIT).map(tag => tag.name),
            affectedFileDetails: plan.files
                .filter(file =>
                    file.added.length > 0
                    || file.removed.length > 0
                    || file.positionUpdates.length > 0
                )
                .slice(0, DETAIL_LIMIT)
                .map(file => ({
                    path: file.path,
                    status: file.status,
                    added: file.added,
                    removed: file.removed,
                    positionUpdates: file.positionUpdates.length
                })),
            detailTruncated: (
                plan.vectorizeNames.length > DETAIL_LIMIT
                || plan.orphanTags.length > DETAIL_LIMIT
                || plan.summary.affectedFiles > DETAIL_LIMIT
            ),
            requiresConfirmation: (
                plan.summary.relationsToAdd > 0
                || plan.summary.relationsToRemove > 0
                || plan.summary.positionsToUpdate > 0
                || plan.summary.vectorsToCreate > 0
                || plan.summary.orphanTagsToRemove > 0
            )
        };
    }

    _toPublicPreviewTask(task = this.latestPreviewTask) {
        if (!task) {
            return {
                taskId: null,
                status: 'idle',
                startedAt: null,
                finishedAt: null,
                preview: null,
                error: null
            };
        }

        let status = task.status;
        let preview = task.preview;
        if (
            status === 'completed'
            && preview
            && preview.expiresAt <= Date.now()
        ) {
            status = 'expired';
            preview = null;
        }

        return {
            taskId: task.taskId,
            status,
            startedAt: task.startedAt,
            finishedAt: task.finishedAt,
            preview,
            error: task.error
        };
    }

    getPreviewTaskStatus() {
        this._cleanupSnapshots();
        return this._toPublicPreviewTask();
    }

    startPreviewTask() {
        if (!this.owner.initialized) {
            throw this._createError(
                'KnowledgeBase 尚未初始化完成',
                'TAG_CONSISTENCY_UNAVAILABLE',
                503
            );
        }
        if (this.running) {
            throw this._createError(
                'Tag 一致性修复任务正在执行',
                'TAG_CONSISTENCY_BUSY',
                409
            );
        }
        if (this.latestPreviewTask?.status === 'running') {
            return this._toPublicPreviewTask();
        }

        this._cleanupSnapshots();
        const task = {
            taskId: crypto.randomBytes(16).toString('hex'),
            status: 'running',
            startedAt: Date.now(),
            finishedAt: null,
            preview: null,
            error: null
        };
        this.latestPreviewTask = task;

        this.previewTaskPromise = this._buildPlan()
            .then(plan => {
                const token = crypto.randomBytes(24).toString('hex');
                const snapshot = {
                    token,
                    createdAt: Date.now(),
                    expiresAt: Date.now() + SNAPSHOT_TTL_MS,
                    plan
                };
                this.snapshots.clear();
                this.snapshots.set(token, snapshot);
                task.preview = this._toPublicSnapshot(snapshot);
                task.status = 'completed';
                task.finishedAt = Date.now();
                console.log(
                    `[KnowledgeBase] Tag consistency preview task ${task.taskId} completed: ` +
                    `scanned=${plan.summary.scannedFiles}, affected=${plan.summary.affectedFiles}.`
                );
            })
            .catch(error => {
                task.status = 'failed';
                task.finishedAt = Date.now();
                task.error = {
                    code: error.code || 'TAG_CONSISTENCY_PREVIEW_FAILED',
                    message: error.message || 'Failed to preview Tag consistency'
                };
                console.error(
                    `[KnowledgeBase] Tag consistency preview task ${task.taskId} failed:`,
                    error.message || error
                );
            })
            .finally(() => {
                if (this.latestPreviewTask === task) {
                    this.previewTaskPromise = null;
                }
            });

        return this._toPublicPreviewTask(task);
    }

    async createPreview() {
        const task = this.startPreviewTask();
        if (task.status === 'running' && this.previewTaskPromise) {
            await this.previewTaskPromise;
        }
        const completed = this.getPreviewTaskStatus();
        if (completed.status === 'completed' && completed.preview) {
            return completed.preview;
        }
        throw this._createError(
            completed.error?.message || 'Tag 一致性预检失败',
            completed.error?.code || 'TAG_CONSISTENCY_PREVIEW_FAILED',
            500
        );
    }

    async _vectorize(names) {
        if (names.length === 0) return new Map();
        const embeddingConfig = {
            apiKey: this.owner.config.apiKey,
            apiUrl: this.owner.config.apiUrl,
            model: this.owner.config.model
        };
        const vectors = await getEmbeddingsBatch(names, embeddingConfig);
        const result = new Map();
        names.forEach((name, index) => {
            const raw = vectors[index];
            if (!raw || raw.length !== this.owner.config.dimension) {
                throw this._createError(
                    `Tag「${name}」向量化失败或维度不匹配，未应用任何修改`,
                    'TAG_CONSISTENCY_EMBEDDING_FAILED',
                    502
                );
            }
            result.set(name, raw instanceof Float32Array ? raw : new Float32Array(raw));
        });
        return result;
    }

    _allocateFinalTags(plan, vectorMap) {
        const existingByName = new Map(plan.tagRows.map(row => [row.name, row]));
        let nextId = plan.tagRows.reduce(
            (max, row) => Math.max(max, Number(row.id) || 0),
            0
        ) + 1;

        return plan.expectedTagNames.map(name => {
            const existing = existingByName.get(name);
            const vector = vectorMap.get(name);
            return {
                id: existing ? Number(existing.id) : nextId++,
                name,
                vector: vector || existing?.vector
            };
        });
    }

    _buildIndexDelta(plan, finalTags, vectorMap) {
        const finalByName = new Map(finalTags.map(tag => [tag.name, tag]));
        const removeIds = plan.orphanTags.map(tag => Number(tag.id));
        const upsertIds = [];
        const vectors = new Float32Array(
            vectorMap.size * this.owner.config.dimension
        );
        let position = 0;

        for (const [name, rawVector] of vectorMap) {
            const tag = finalByName.get(name);
            if (!tag || !Number.isInteger(tag.id) || tag.id <= 0) {
                throw this._createError(
                    `Tag「${name}」没有可用的最终 ID，无法构造索引差分`,
                    'TAG_CONSISTENCY_INVALID_DELTA',
                    409
                );
            }
            const vector = rawVector instanceof Float32Array
                ? rawVector
                : new Float32Array(rawVector || []);
            if (vector.length !== this.owner.config.dimension) {
                throw this._createError(
                    `Tag「${name}」向量维度无效，无法构造索引差分`,
                    'TAG_CONSISTENCY_INVALID_VECTOR',
                    409
                );
            }
            upsertIds.push(tag.id);
            vectors.set(vector, position * this.owner.config.dimension);
            position++;
        }

        return { removeIds, upsertIds, vectors };
    }

    _bindActiveTagIndex(index) {
        this.owner.tagIndex = index;
        this.owner.indexRepository.tagIndex = index;
        if (this.owner.tagMemoEngine) {
            this.owner.tagMemoEngine.tagIndex = index;
            this.owner.tagMemoEngine.tagPairSimilarities = new Map();
            this.owner.tagMemoEngine.tagIntrinsicResiduals = new Map();
            this.owner.tagMemoEngine.tagRawResidualRatios = new Map();
            this.owner.tagMemoEngine.intrinsicResidualArtifact = null;
        }
    }

    async _recoverActiveTagIndex() {
        if (!this.VexusIndex) {
            throw this._createError(
                'VexusIndex 不可用，无法恢复全局 Tag 索引',
                'TAG_CONSISTENCY_INDEX_UNAVAILABLE',
                503
            );
        }

        const expectedCount = Number(this.owner.db.prepare(
            'SELECT COUNT(*) AS count FROM tags WHERE vector IS NOT NULL'
        ).get()?.count) || 0;
        const capacity = Math.max(
            50000,
            Math.ceil(expectedCount * 1.2) + 100
        );

        // 首选正常冷启动路径：健康旧 checkpoint + 修复后 SQLite 差分。
        const baseline = this.owner.indexRepository.loadGlobalTagBaseline(
            capacity
        );
        let recoveredIndex = baseline?.index || null;
        let recoveryMode = recoveredIndex
            ? 'baseline-plus-sqlite-delta'
            : 'sqlite-full-rebuild';

        if (!recoveredIndex) {
            recoveredIndex = new this.VexusIndex(
                this.owner.config.dimension,
                capacity
            );
            const recoveredCount = await recoveredIndex.recoverFromSqlite(
                this.owner.dbPath,
                'tags',
                null
            );
            if (Number(recoveredCount) !== expectedCount) {
                throw this._createError(
                    `全局 Tag 索引恢复不完整：expected=${expectedCount}, recovered=${recoveredCount}`,
                    'TAG_CONSISTENCY_INDEX_RECOVERY_INCOMPLETE',
                    500
                );
            }
        }

        const actualCount = Number(
            recoveredIndex.stats?.().totalVectors
        ) || 0;
        if (actualCount !== expectedCount) {
            throw this._createError(
                `全局 Tag 索引恢复校验失败：expected=${expectedCount}, actual=${actualCount}`,
                'TAG_CONSISTENCY_INDEX_RECOVERY_INCOMPLETE',
                500
            );
        }

        this._bindActiveTagIndex(recoveredIndex);
        console.warn(
            `[KnowledgeBase] ♻️ Active Tag index recovered after delta failure: ` +
            `mode=${recoveryMode}, vectors=${actualCount}.`
        );
        return { index: recoveredIndex, mode: recoveryMode };
    }

    _applyTransaction(plan, finalTags, vectorMap) {
        const tagByName = new Map(finalTags.map(tag => [tag.name, tag]));
        const existingTagNames = new Set(plan.tagRows.map(row => row.name));
        const insertTag = this.owner.db.prepare(
            'INSERT INTO tags (id, name, vector) VALUES (?, ?, ?)'
        );
        const updateTagVector = this.owner.db.prepare(
            'UPDATE tags SET vector = ? WHERE id = ?'
        );
        const deleteRelations = this.owner.db.prepare(
            'DELETE FROM file_tags WHERE file_id = ?'
        );
        const addRelation = this.owner.db.prepare(
            'INSERT INTO file_tags (file_id, tag_id, position) VALUES (?, ?, ?)'
        );

        const transaction = this.owner.db.transaction(() => {
            for (const tag of finalTags) {
                if (!existingTagNames.has(tag.name)) {
                    const vector = vectorMap.get(tag.name);
                    const buffer = Buffer.from(
                        vector.buffer,
                        vector.byteOffset,
                        vector.byteLength
                    );
                    insertTag.run(tag.id, tag.name, buffer);
                } else if (vectorMap.has(tag.name)) {
                    const vector = vectorMap.get(tag.name);
                    const buffer = Buffer.from(
                        vector.buffer,
                        vector.byteOffset,
                        vector.byteLength
                    );
                    updateTagVector.run(buffer, tag.id);
                }
            }

            for (const file of plan.files) {
                if (
                    file.added.length === 0
                    && file.removed.length === 0
                    && file.positionUpdates.length === 0
                ) {
                    continue;
                }
                deleteRelations.run(file.fileId);
                file.expectedTags.forEach((name, index) => {
                    addRelation.run(file.fileId, tagByName.get(name).id, index + 1);
                });
            }

            this.owner.db.exec(`
                DELETE FROM tag_pair_similarity;
                DELETE FROM tag_pair_similarity_status;
                DELETE FROM tag_intrinsic_residuals;
                DELETE FROM tag_intrinsic_residual_status;
                DELETE FROM tagmemo_artifacts;
                DELETE FROM tags
                WHERE id NOT IN (SELECT DISTINCT tag_id FROM file_tags);
            `);
        });
        transaction();
    }

    async applyPreview(token) {
        if (this.running || this.latestPreviewTask?.status === 'running') {
            throw this._createError(
                'Tag 一致性维护任务正在执行',
                'TAG_CONSISTENCY_BUSY',
                409
            );
        }
        this._cleanupSnapshots();
        const snapshot = this.snapshots.get(String(token || ''));
        if (!snapshot) {
            throw this._createError(
                '预检快照不存在或已过期，请重新扫描',
                'TAG_CONSISTENCY_SNAPSHOT_EXPIRED',
                409
            );
        }

        this.running = true;
        let lease = null;
        try {
            lease = await this.owner.requestRustWriteLease(
                'tag-consistency-reconcile',
                {
                    pendingThreshold: 0,
                    allowDuringStartupCooldown: true
                }
            );
            if (!lease) {
                throw this._createError(
                    '无法取得知识库维护窗口，请稍后重试',
                    'TAG_CONSISTENCY_LEASE_UNAVAILABLE',
                    503
                );
            }

            const verifiedPlan = await this._buildPlan();
            if (verifiedPlan.digest !== snapshot.plan.digest) {
                this.snapshots.delete(snapshot.token);
                throw this._createError(
                    '文件、规则或数据库 Tag 状态在确认前已变化，请重新扫描',
                    'TAG_CONSISTENCY_SNAPSHOT_STALE',
                    409
                );
            }

            if (
                !this.owner.tagIndex
                || typeof this.owner.tagIndex.applyTagDelta !== 'function'
            ) {
                throw this._createError(
                    '活动 Tag 索引缺少 applyTagDelta ABI，请先重新构建 rust-vexus-lite',
                    'TAG_CONSISTENCY_DELTA_ABI_UNAVAILABLE',
                    503
                );
            }

            const vectorMap = await this._vectorize(
                verifiedPlan.vectorizeNames
            );
            const finalTags = this._allocateFinalTags(
                verifiedPlan,
                vectorMap
            );
            const delta = this._buildIndexDelta(
                verifiedPlan,
                finalTags,
                vectorMap
            );

            // SQLite 是唯一权威事实。提交后若活动 usearch 差分失败，不回滚
            // 文件事实，而是判废该实例并走冷启动同款基线回放恢复。
            this._applyTransaction(verifiedPlan, finalTags, vectorMap);

            let deltaResult = null;
            let recoveryMode = null;
            try {
                deltaResult = await this.owner.tagIndex.applyTagDelta(
                    delta.removeIds,
                    delta.upsertIds,
                    delta.vectors
                );
                this._bindActiveTagIndex(this.owner.tagIndex);
            } catch (deltaError) {
                console.error(
                    '[KnowledgeBase] ❌ Active Tag index delta failed; ' +
                    'discarding the instance and recovering from authoritative SQLite:',
                    deltaError.message || deltaError
                );
                const recovered = await this._recoverActiveTagIndex();
                recoveryMode = recovered.mode;
            }

            // 用户确认修复是明确的健康维护边界，不受 generational 5% 阈值限制。
            // 发布失败不损坏旧 checkpoint，但本次接口必须明确报告未完成落盘。
            const checkpointPublished =
                this.owner.indexRepository.publishGlobalTagBaseline({
                    force: true
                });
            if (!checkpointPublished) {
                throw this._createError(
                    'Tag 数据与内存索引已修复，但新 Usearch 代际 checkpoint 未能发布',
                    'TAG_CONSISTENCY_CHECKPOINT_FAILED',
                    500
                );
            }

            this.snapshots.delete(snapshot.token);
            if (this.latestPreviewTask?.preview?.token === snapshot.token) {
                this.latestPreviewTask = null;
            }
            this.owner.lastJsWriteFinishedAt = Date.now();
            console.warn(
                `[KnowledgeBase] 🧹 Tag consistency reconciliation complete: `
                + `vectorsCreated=${verifiedPlan.summary.vectorsToCreate}, `
                + `vectorsRemoved=${verifiedPlan.summary.vectorsToRemove}, `
                + `relationsAdded=${verifiedPlan.summary.relationsToAdd}, `
                + `relationsRemoved=${verifiedPlan.summary.relationsToRemove}, `
                + `indexMode=${recoveryMode || 'active-rust-delta'}, `
                + 'checkpoint=forced-generational. '
                + 'TagMemo derived assets are stale and must be rebuilt.'
            );

            return {
                applied: true,
                summary: verifiedPlan.summary,
                indexUpdate: {
                    mode: recoveryMode || 'active-rust-delta',
                    requestedDeletes: delta.removeIds.length,
                    requestedUpserts: delta.upsertIds.length,
                    totalVectors: Number(
                        deltaResult?.totalVectors
                        ?? this.owner.tagIndex.stats?.().totalVectors
                    ) || 0
                },
                checkpointPublished: true,
                waveAssetsStale: true,
                recommendedAction: 'active-full-training',
                message: 'Tag 差分修复、活动内存索引增量更新与新 Usearch 代际落盘已完成；请继续重建 V9.1 浪潮矩阵资产。'
            };
        } finally {
            if (lease) lease.release();
            this.running = false;
        }
    }
}

module.exports = TagConsistencyService;