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

    async createPreview() {
        if (!this.owner.initialized) {
            throw this._createError(
                'KnowledgeBase 尚未初始化完成',
                'TAG_CONSISTENCY_UNAVAILABLE',
                503
            );
        }
        if (this.running) {
            throw this._createError(
                'Tag 一致性维护任务正在执行',
                'TAG_CONSISTENCY_BUSY',
                409
            );
        }

        this._cleanupSnapshots();
        const plan = await this._buildPlan();
        const token = crypto.randomBytes(24).toString('hex');
        const snapshot = {
            token,
            createdAt: Date.now(),
            expiresAt: Date.now() + SNAPSHOT_TTL_MS,
            plan
        };
        this.snapshots.clear();
        this.snapshots.set(token, snapshot);
        return this._toPublicSnapshot(snapshot);
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

    _buildStagingIndex(finalTags) {
        if (!this.VexusIndex) {
            throw this._createError(
                'VexusIndex 不可用，无法安全重建全局 Tag 索引',
                'TAG_CONSISTENCY_INDEX_UNAVAILABLE',
                503
            );
        }
        const capacity = Math.max(50000, Math.ceil(finalTags.length * 1.2) + 100);
        const index = new this.VexusIndex(this.owner.config.dimension, capacity);
        for (const tag of finalTags) {
            const vector = tag.vector instanceof Float32Array
                ? tag.vector
                : this.owner._decodeVectorBlob(
                    tag.vector,
                    this.owner.config.dimension,
                    `tag-consistency:${tag.id}`
                );
            if (!vector) {
                throw this._createError(
                    `Tag「${tag.name}」缺少有效向量，无法发布一致性索引`,
                    'TAG_CONSISTENCY_INVALID_VECTOR',
                    409
                );
            }
            index.add(tag.id, vector);
        }
        return index;
    }

    _applyTransaction(plan, finalTags, vectorMap) {
        const tagByName = new Map(finalTags.map(tag => [tag.name, tag]));
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
                if (!plan.tagRows.some(row => row.name === tag.name)) {
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
        if (this.running) {
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

            const vectorMap = await this._vectorize(verifiedPlan.vectorizeNames);
            const finalTags = this._allocateFinalTags(verifiedPlan, vectorMap);
            const stagingIndex = this._buildStagingIndex(finalTags);

            this._applyTransaction(verifiedPlan, finalTags, vectorMap);

            this.owner.tagIndex = stagingIndex;
            this.owner.indexRepository.tagIndex = stagingIndex;
            if (this.owner.tagMemoEngine) {
                this.owner.tagMemoEngine.tagIndex = stagingIndex;
                this.owner.tagMemoEngine.tagPairSimilarities = new Map();
                this.owner.tagMemoEngine.tagIntrinsicResiduals = new Map();
                this.owner.tagMemoEngine.tagRawResidualRatios = new Map();
                this.owner.tagMemoEngine.intrinsicResidualArtifact = null;
            }

            if (this.owner.indexRepository.shouldPersist('global_tags')) {
                this.owner._saveIndexToDisk('global_tags');
            }

            this.snapshots.delete(snapshot.token);
            this.owner.lastJsWriteFinishedAt = Date.now();
            console.warn(
                `[KnowledgeBase] 🧹 Tag consistency reconciliation complete: `
                + `vectorsCreated=${verifiedPlan.summary.vectorsToCreate}, `
                + `vectorsRemoved=${verifiedPlan.summary.vectorsToRemove}, `
                + `relationsAdded=${verifiedPlan.summary.relationsToAdd}, `
                + `relationsRemoved=${verifiedPlan.summary.relationsToRemove}. `
                + 'TagMemo derived assets are stale and must be rebuilt.'
            );

            return {
                applied: true,
                summary: verifiedPlan.summary,
                waveAssetsStale: true,
                recommendedAction: 'active-full-training',
                message: 'Tag 差分修复与全局内存索引重建已完成；请继续重建 V9.1 浪潮矩阵资产。'
            };
        } finally {
            if (lease) lease.release();
            this.running = false;
        }
    }
}

module.exports = TagConsistencyService;