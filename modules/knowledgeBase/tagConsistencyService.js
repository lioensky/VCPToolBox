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

    async _loadDatabaseState() {
        if (
            !this.owner.nativeKnowledgeRuntime
            || typeof this.owner.nativeKnowledgeRuntime.getTagConsistencySnapshot
                !== 'function'
        ) {
            throw this._createError(
                'NativeKnowledgeRuntime Tag 一致性快照 ABI 不可用',
                'NATIVE_STORAGE_ABI_UNAVAILABLE',
                503
            );
        }

        const raw = await this.owner.nativeKnowledgeRuntime
            .getTagConsistencySnapshot(this.owner.dbPath);
        const snapshot = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!snapshot || typeof snapshot !== 'object') {
            throw this._createError(
                'Rust Tag 一致性快照格式无效',
                'TAG_CONSISTENCY_SNAPSHOT_INVALID',
                500
            );
        }

        const files = (Array.isArray(snapshot.files) ? snapshot.files : [])
            .map(row => ({
                id: Number(row?.id),
                path: String(row?.path || ''),
                diary_name: String(row?.diary_name || ''),
                checksum: String(row?.checksum || ''),
                mtime: Number(row?.mtime) || 0,
                size: Number(row?.size) || 0
            }))
            .filter(row => Number.isSafeInteger(row.id) && row.id > 0);

        const tagRows = (Array.isArray(snapshot.tags) ? snapshot.tags : [])
            .map(row => ({
                id: Number(row?.id),
                name: String(row?.name || ''),
                vector: row?.hasVector === true ? true : null
            }))
            .filter(row => Number.isSafeInteger(row.id) && row.id > 0 && row.name);

        const relations = Array.isArray(snapshot.relations)
            ? snapshot.relations
            : [];
        const relationsByFile = new Map();
        for (const row of relations) {
            const fileId = Number(row?.fileId);
            const tagId = Number(row?.tagId);
            if (
                !Number.isSafeInteger(fileId)
                || fileId <= 0
                || !Number.isSafeInteger(tagId)
                || tagId <= 0
            ) {
                continue;
            }
            if (!relationsByFile.has(fileId)) relationsByFile.set(fileId, []);
            relationsByFile.get(fileId).push({
                tagId,
                name: String(row?.name || ''),
                position: Number(row?.position) || 0
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
        const state = await this._loadDatabaseState();
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
        if (
            !this.owner.nativeKnowledgeRuntime
            || typeof this.owner.nativeKnowledgeRuntime.commitTagConsistency !== 'function'
        ) {
            throw this._createError(
                'NativeKnowledgeRuntime Tag 一致性提交 ABI 不可用，请重新构建 rust-vexus-lite',
                'NATIVE_STORAGE_ABI_UNAVAILABLE',
                503
            );
        }
        this.running = true;
        try {
            const verifiedPlan = await this._buildPlan();
            if (verifiedPlan.digest !== snapshot.plan.digest) {
                this.snapshots.delete(snapshot.token);
                throw this._createError(
                    '文件、规则或数据库 Tag 状态在确认前已变化，请重新扫描',
                    'TAG_CONSISTENCY_SNAPSHOT_STALE',
                    409
                );
            }

            const vectorMap = await this._vectorize(verifiedPlan.vectorizeNames);
            const tagVectors = new Float32Array(
                verifiedPlan.vectorizeNames.length * this.owner.config.dimension
            );
            verifiedPlan.vectorizeNames.forEach((name, index) => {
                const vector = vectorMap.get(name);
                if (!vector || vector.length !== this.owner.config.dimension) {
                    throw this._createError(
                        `Tag「${name}」向量化结果无效，未应用任何修改`,
                        'TAG_CONSISTENCY_INVALID_VECTOR',
                        409
                    );
                }
                tagVectors.set(vector, index * this.owner.config.dimension);
            });

            const nativePlan = {
                digest: verifiedPlan.digest,
                dimension: this.owner.config.dimension,
                files: verifiedPlan.files.map(file => ({
                    fileId: Number(file.fileId),
                    expectedTags: Array.isArray(file.expectedTags)
                        ? file.expectedTags.map(String)
                        : []
                })),
                vectorizeNames: verifiedPlan.vectorizeNames.map(String),
                orphanTags: verifiedPlan.orphanTags.map(tag => ({
                    id: Number(tag.id)
                }))
            };
            const rawReceipt =
                await this.owner.nativeKnowledgeRuntime.commitTagConsistency(
                    this.owner.dbPath,
                    JSON.stringify(nativePlan),
                    tagVectors
                );
            const receipt = typeof rawReceipt === 'string'
                ? JSON.parse(rawReceipt)
                : rawReceipt;
            if (!receipt || receipt.factsCommitted !== true) {
                throw this._createError(
                    'Rust Tag 一致性提交返回无效事实回执',
                    'TAG_CONSISTENCY_COMMIT_INVALID_RECEIPT',
                    500
                );
            }

            const upsertedTagIds = Array.isArray(receipt.upsertedTagIds)
                ? receipt.upsertedTagIds.map(Number).filter(Number.isSafeInteger)
                : [];
            const removedTagIds = Array.isArray(receipt.removedTagIds)
                ? receipt.removedTagIds.map(Number).filter(Number.isSafeInteger)
                : [];
            if (receipt.indexReady !== true) {
                throw this._createError(
                    'Tag 事实已提交，但 Rust 活动索引差分未完成；索引需要由 Rust 生命周期管理器恢复',
                    'TAG_CONSISTENCY_INDEX_DELTA_FAILED',
                    500
                );
            }

            this.snapshots.delete(snapshot.token);
            if (this.latestPreviewTask?.preview?.token === snapshot.token) {
                this.latestPreviewTask = null;
            }

            return {
                applied: true,
                summary: verifiedPlan.summary,
                indexUpdate: {
                    mode: 'native-rust-delta',
                    requestedDeletes: removedTagIds.length,
                    requestedUpserts: upsertedTagIds.length,
                    totalVectors: Number(receipt.totalVectors) || 0
                },
                checkpointPublished: false,
                waveAssetsStale: true,
                recommendedAction: 'active-full-training',
                message: 'Tag 事实与活动索引差分均由 Rust 完成；持久化基线将由 Rust 索引生命周期管理器发布。'
            };
        } finally {
            this.running = false;
        }

        /* 旧 JS 事实事务保留为迁移参考，不得进入生产路径。
        this.running = true;
        try {
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
            // legacy transaction path intentionally removed

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
                // legacy index recovery path intentionally removed
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
            // Legacy JS transaction path removed; Rust owns fact generation and publication.
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
            this.running = false;
        }
        */
    }
}

module.exports = TagConsistencyService;