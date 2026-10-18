'use strict';

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

    _rulesSignature() {
        const config = this.owner.config;
        return crypto.createHash('sha256').update(JSON.stringify({
            ignoreFolders: config.ignoreFolders,
            ignorePrefixes: config.ignorePrefixes,
            ignoreSuffixes: config.ignoreSuffixes,
            tagBlacklist: [...(config.tagBlacklist || [])].sort(),
            tagBlacklistSuper: config.tagBlacklistSuper,
            maxTagsPerFile: config.maxTagsPerFile,
            dimension: config.dimension,
            modelSig: config.modelSig
        })).digest('hex').slice(0, 24);
    }

    async _buildPlan() {
        if (
            !this.owner.nativeKnowledgeRuntime
            || typeof this.owner.nativeKnowledgeRuntime.prepareTagConsistency
                !== 'function'
        ) {
            throw this._createError(
                'NativeKnowledgeRuntime Tag 一致性计划 ABI 不可用',
                'NATIVE_STORAGE_ABI_UNAVAILABLE',
                503
            );
        }

        const config = this.owner.config;
        const raw = await this.owner.nativeKnowledgeRuntime.prepareTagConsistency(
            JSON.stringify({
                dbPath: this.owner.dbPath,
                rootPath: config.rootPath,
                ignoreFolders: config.ignoreFolders,
                ignorePrefixes: config.ignorePrefixes,
                ignoreSuffixes: config.ignoreSuffixes,
                tagBlacklist: config.tagBlacklist instanceof Set
                    ? [...config.tagBlacklist]
                    : [],
                tagBlacklistSuper: Array.isArray(config.tagBlacklistSuper)
                    ? config.tagBlacklistSuper
                    : [],
                maxTags: config.maxTagsPerFile,
                dimension: config.dimension,
                modelSig: config.modelSig,
                ttlMs: SNAPSHOT_TTL_MS
            })
        );
        const nativePlan = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (
            !nativePlan
            || nativePlan.schema !== 'vcp-native-tag-consistency-plan-v1'
            || typeof nativePlan.token !== 'string'
            || !nativePlan.token
            || typeof nativePlan.digest !== 'string'
            || !nativePlan.digest
            || !Array.isArray(nativePlan.files)
            || !Array.isArray(nativePlan.vectorizeNames)
            || !Array.isArray(nativePlan.orphanTags)
        ) {
            throw this._createError(
                'Rust Tag 一致性计划格式无效',
                'TAG_CONSISTENCY_PLAN_INVALID',
                500
            );
        }

        const filePlans = nativePlan.files.map(file => {
            const expectedTags = Array.isArray(file.expectedTags)
                ? file.expectedTags.map(String)
                : [];
            const currentTags = Array.isArray(file.currentTags)
                ? file.currentTags.map(tag => ({
                    name: String(tag?.name || ''),
                    position: Number(tag?.position) || 0
                })).filter(tag => tag.name)
                : [];
            const currentByName = new Map(currentTags.map(tag => [tag.name, tag]));
            const expectedSet = new Set(expectedTags);
            const added = expectedTags.filter(name => !currentByName.has(name));
            const removed = currentTags
                .filter(tag => !expectedSet.has(tag.name))
                .map(tag => tag.name);
            const positionUpdates = expectedTags
                .map((name, index) => {
                    const current = currentByName.get(name);
                    return current && current.position !== index + 1
                        ? { name, from: current.position, to: index + 1 }
                        : null;
                })
                .filter(Boolean);
            return {
                fileId: Number(file.fileId),
                path: String(file.path || ''),
                sourcePath: file.sourcePath ?? null,
                sourceHash: file.sourceHash ?? null,
                status: String(file.status || 'scanned'),
                expectedTags,
                currentTags,
                added,
                removed,
                positionUpdates
            };
        });

        const expectedTagNames = [...new Set(
            filePlans.flatMap(file => file.expectedTags)
        )].sort((left, right) => left.localeCompare(right));

        return {
            ...nativePlan,
            createdAt: Number(nativePlan.createdAt) || Date.now(),
            files: filePlans,
            tagRows: [],
            expectedTagNames,
            vectorizeNames: nativePlan.vectorizeNames.map(String),
            orphanTags: nativePlan.orphanTags.map(tag => ({
                id: Number(tag?.id),
                name: String(tag?.name || ''),
                hasVector: tag?.hasVector === true
            })),
            summary: nativePlan.summary && typeof nativePlan.summary === 'object'
                ? nativePlan.summary
                : {}
        };
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
        if (this.owner._shuttingDown || !this.owner.initialized) {
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

        const rulesSignature = this._rulesSignature();
        this.previewTaskPromise = this._buildPlan()
            .then(async plan => {
                const snapshot = {
                    token: plan.token,
                    createdAt: Number(plan.createdAt) || Date.now(),
                    expiresAt: Number(plan.expiresAt)
                        || Date.now() + SNAPSHOT_TTL_MS,
                    plan,
                    rulesSignature
                };
                for (const old of this.snapshots.values()) {
                    await this.owner.nativeKnowledgeRuntime.cancelPreparedPlan(old.plan.token);
                }
                this.snapshots.clear();
                this.snapshots.set(snapshot.token, snapshot);
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

    applyPreview(token) {
        if (this.owner._shuttingDown) {
            return Promise.reject(this._createError(
                'KnowledgeBase 正在关闭', 'KNOWLEDGE_STORE_CLOSED', 503
            ));
        }
        const pending = this._applyPreview(token);
        this.applyTaskPromise = pending;
        pending.then(
            () => { if (this.applyTaskPromise === pending) this.applyTaskPromise = null; },
            () => { if (this.applyTaskPromise === pending) this.applyTaskPromise = null; }
        );
        return pending;
    }

    async drain() {
        await Promise.allSettled([
            this.previewTaskPromise,
            this.applyTaskPromise
        ].filter(Boolean));
    }

    async _applyPreview(token) {
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
            // Rust 已保存权威计划，提交时校验事实代际和源文件哈希。
            // 确认阶段不再扫描全库或分配新的 prepared token。
            const verifiedPlan = snapshot.plan;
            if (verifiedPlan.dimension !== this.owner.config.dimension
                || verifiedPlan.modelSig !== this.owner.config.modelSig
                || (snapshot.rulesSignature && snapshot.rulesSignature !== this._rulesSignature())) {
                throw this._createError(
                    '向量模型配置已变化，请重新扫描',
                    'TAG_CONSISTENCY_SNAPSHOT_STALE', 409
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
                token: snapshot.plan.token,
                digest: snapshot.plan.digest,
                createdAt: snapshot.plan.createdAt,
                expiresAt: snapshot.plan.expiresAt,
                modelSig: snapshot.plan.modelSig,
                dimension: snapshot.plan.dimension,
                files: snapshot.plan.files.map(file => ({
                    fileId: Number(file.fileId),
                    sourcePath: file.sourcePath ?? null,
                    sourceHash: file.sourceHash ?? null,
                    expectedTags: Array.isArray(file.expectedTags)
                        ? file.expectedTags.map(String)
                        : []
                })),
                vectorizeNames: verifiedPlan.vectorizeNames.map(String),
                orphanTags: verifiedPlan.orphanTags.map(tag => ({
                    id: Number(tag.id)
                }))
            };
            if (this.owner._shuttingDown) {
                throw this._createError(
                    'KnowledgeBase 正在关闭，未提交维护计划', 'KNOWLEDGE_STORE_CLOSED', 503
                );
            }
            if (snapshot.rulesSignature && snapshot.rulesSignature !== this._rulesSignature()) {
                throw this._createError(
                    '规则或模型配置在向量化期间发生变化，请重新扫描',
                    'TAG_CONSISTENCY_SNAPSHOT_STALE', 409
                );
            }
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

            this.owner._scheduleIndexSave?.('global_tags');

            const upsertedTagIds = Array.isArray(receipt.upsertedTagIds)
                ? receipt.upsertedTagIds.map(Number).filter(Number.isSafeInteger)
                : [];
            const removedTagIds = Array.isArray(receipt.removedTagIds)
                ? receipt.removedTagIds.map(Number).filter(Number.isSafeInteger)
                : [];
            if (receipt.indexReady !== true) {
                console.warn('[KnowledgeBase] Tag facts committed; native index recovery required.');
            }

            // Published graphs remain available while durable unique-Tag changes
            // accumulate toward 1%; explicit administrator full training stays separate.
            let training;
            try {
                const queued = await this.owner.tagMemoEngine?.scheduleMatrixRebuildForNewTags([]);
                training = { queued: queued === true, policy: 'changed-tags-1-percent' };
            } catch (error) {
                console.error('[KnowledgeBase] Tag facts committed, but Memo training could not be queued:', error);
                training = { queued: false, error: String(error.message || error) };
            }
            this.snapshots.delete(snapshot.token);
            if (this.latestPreviewTask?.preview?.token === snapshot.token) {
                this.latestPreviewTask = null;
            }

            return {
                applied: true,
                factsCommitted: true,
                indexReady: receipt.indexReady === true,
                summary: verifiedPlan.summary,
                indexUpdate: {
                    mode: 'native-rust-delta',
                    requestedDeletes: removedTagIds.length,
                    requestedUpserts: upsertedTagIds.length,
                    totalVectors: Number(receipt.totalVectors) || 0
                },
                checkpointPublished: false,
                training: training || { queued: false },
                waveAssetsStale: true,
                recommendedAction: 'automatic-threshold-refresh',
                message: 'Tag 事实与活动索引差分均由 Rust 完成；持久化基线将由 Rust 索引生命周期管理器发布。'
            };
        } finally {
            this.running = false;
        }


    }
}

module.exports = TagConsistencyService;