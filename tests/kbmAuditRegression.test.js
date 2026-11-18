'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const embeddingPath = require.resolve('../EmbeddingUtils');
let embed = async texts => texts.map(() => [1, 0]);
require.cache[embeddingPath] = {
    id: embeddingPath, filename: embeddingPath, loaded: true,
    exports: { getEmbeddingsBatch: (...args) => embed(...args) }
};
const IngestionPipeline = require('../modules/knowledgeBase/ingestionPipeline');
const TagConsistencyService = require('../modules/knowledgeBase/tagConsistencyService');

for (const mutation of ['change', 'delete']) {
    test(`one ${mutation} during embedding does not abort healthy files`, async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kbm-audit-'));
        const good = path.join(root, 'good.txt');
        const bad = path.join(root, 'bad.txt');
        await fs.writeFile(good, 'good');
        await fs.writeFile(bad, 'bad');
        let submitted;
        const saves = [];
        const owner = {
            config: { rootPath: root, dimension: 2, modelSig: 'test', maxBatchSize: 50,
                sqliteBusyRetryDelayMs: 1 },
            pendingFiles: new Set([good, bad]), pendingDeletes: new Set(),
            watcherPathGenerations: new Map(), fileRetryCount: new Map(),
            diaryIndices: new Map([['Root', {}]]),
            _scheduleIndexSave(name) { saves.push(name); },
            async _ensureDiaryDateIndexCached() {},
            probeIngestionFiles: async names => names.map(name => ({ path: name, version: 0 })),
            prepareIngestionText: async text => ({ chunks: [text], tags: [text] }),
            probeMigrationReuse: async () => [],
            probeIngestionTags: async () => [],
            _prepareTextForEmbedding: text => text,
            _queueDelete: name => owner.pendingDeletes.add(name),
            _isSqliteBusyError: () => false, _isSqliteCorruptionError: () => false,
            invalidateDiaryDateIndex() {},
            async commitIngestionBatch(plan, chunks, tags) {
                submitted = { plan, chunks, tags };
                owner._shuttingDown = true;
                return { factsCommitted: true, indexReady: true, newTagIds: [1], affectedDiaries: ['Root'] };
            }
        };
        let changed = false;
        embed = async texts => {
            if (!changed) {
                changed = true;
                if (mutation === 'delete') await fs.unlink(bad);
                else await fs.writeFile(bad, 'changed length');
            }
            return texts.map(() => [1, 0]);
        };
        try {
            await new IngestionPipeline(owner)._flushBatch();
            assert.deepEqual(saves, ['Root', 'global_tags']);
            assert.equal(submitted.plan.files.length, 1);
            assert.equal(submitted.plan.files[0].path, 'good.txt');
            assert.equal(submitted.plan.chunks.length, 1);
            assert.equal(submitted.plan.tags.length, 1);
            assert.equal(submitted.chunks.length, 2);
            assert.equal(submitted.tags.length, 2);
            assert.equal(owner.pendingFiles.has(good), false);
            assert.equal(owner.fileRetryCount.size, 0);
            if (mutation === 'delete') assert.equal(owner.pendingDeletes.has(bad), true);
            else assert.equal(owner.pendingFiles.has(bad), true);
        } finally {
            owner._shuttingDown = true;
            await fs.rm(root, { recursive: true, force: true });
        }
    });
}

test('confirmation consumes original prepared plan without preparing again', async () => {
    const plan = {
        token: 'original', digest: 'digest', createdAt: Date.now(),
        expiresAt: Date.now() + 10000, modelSig: 'test', dimension: 2,
        files: [], vectorizeNames: [], orphanTags: [], summary: {}
    };
    const saves = [];
    const owner = {
        dbPath: 'unused', config: { modelSig: 'test', dimension: 2 },
        _scheduleIndexSave(name) { saves.push(name); },
        nativeKnowledgeRuntime: {
            async commitTagConsistency(_db, raw) {
                assert.equal(JSON.parse(raw).token, 'original');
                return { factsCommitted: true, indexReady: true };
            }
        }
    };
    const service = new TagConsistencyService(owner);
    service._buildPlan = () => { throw new Error('must not prepare during confirmation'); };
    service.snapshots.set(plan.token, { token: plan.token, expiresAt: plan.expiresAt, plan });
    assert.equal((await service.applyPreview(plan.token)).applied, true);
    assert.deepEqual(saves, ['global_tags']);
});

test('new preview cancels the previous prepared token', async () => {
    const cancelled = [];
    const owner = {
        initialized: true,
        config: {},
        nativeKnowledgeRuntime: { async cancelPreparedPlan(token) { cancelled.push(token); } }
    };
    const service = new TagConsistencyService(owner);
    service.snapshots.set('old', {
        expiresAt: Date.now() + 10000, plan: { token: 'old' }
    });
    service._buildPlan = async () => ({
        token: 'new', digest: 'digest', createdAt: Date.now(),
        expiresAt: Date.now() + 10000, vectorizeNames: [], orphanTags: [],
        files: [], summary: {}
    });
    service.startPreviewTask();
    await service.previewTaskPromise;
    assert.deepEqual(cancelled, ['old']);
    assert.equal(service.snapshots.size, 1);
});

test('changed migration source retries only that file using normal embedding without retry budget', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kbm-migration-retry-'));
    const good = path.join(root, 'good.txt');
    const retry = path.join(root, 'retry.txt');
    await fs.writeFile(good, 'good');
    await fs.writeFile(retry, 'retry');
    let round = 0;
    const embedded = [];
    embed = async texts => {
        embedded.push(...texts);
        return texts.map(() => [1, 0]);
    };
    const owner = {
        config: { rootPath: root, dimension: 2, modelSig: 'test', maxBatchSize: 50, sqliteBusyRetryDelayMs: 1 },
        pendingFiles: new Set([good, retry]), watcherPathGenerations: new Map(),
        fileRetryCount: new Map(), diaryIndices: new Map(),
        probeIngestionFiles: async names => names.map(name => ({ path: name, version: 0 })),
        prepareIngestionText: async text => ({ chunks: [text], tags: [] }),
        probeMigrationReuse: async () => [{ path: 'retry.txt', liveFileId: 1 }],
        probeIngestionTags: async () => [],
        _isSqliteBusyError: () => false, _isSqliteCorruptionError: () => false,
        invalidateDiaryDateIndex() {},
        async commitIngestionBatch(plan, chunks) {
            owner._shuttingDown = true;
            round++;
            if (round === 1) {
                assert.equal(plan.files.length, 2);
                assert.equal(chunks.length, 2);
                return { indexReady: true, retryableFiles: [
                    { path: 'retry.txt', code: 'KNOWLEDGE_STORE_MIGRATION_SOURCE_CHANGED' }
                ] };
            }
            assert.equal(plan.files.length, 1);
            assert.equal(plan.files[0].path, 'retry.txt');
            assert.equal(plan.files[0].migrationSourceFileId, null);
            assert.equal(chunks.length, 2);
            return { indexReady: true };
        }
    };
    try {
        const pipeline = new IngestionPipeline(owner);
        await pipeline._flushBatch();
        assert.deepEqual([...owner.pendingFiles], [retry]);
        assert.equal(owner.fileRetryCount.size, 0);
        owner._shuttingDown = false;
        await pipeline._flushBatch();
        assert.deepEqual(embedded, ['good', 'retry']);
        assert.equal(owner.pendingFiles.size, 0);
        assert.equal(owner._migrationEmbeddingFallbacks.size, 0);
    } finally {
        owner._shuttingDown = true;
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('tag consistency checks refresh threshold only after successful commit', async () => {
    const events = [];
    const plan = {
        token: 'train', digest: 'digest', createdAt: Date.now(),
        expiresAt: Date.now() + 10000, modelSig: 'test', dimension: 2,
        files: [], vectorizeNames: [], orphanTags: [], summary: {}
    };
    const owner = {
        dbPath: 'unused', config: { modelSig: 'test', dimension: 2 },
        nativeKnowledgeRuntime: {
            async commitTagConsistency() {
                events.push('commit');
                return { factsCommitted: true, indexReady: true };
            }
        },
        tagMemoEngine: {
            async scheduleMatrixRebuildForNewTags(ids) {
                assert.deepEqual(ids, []);
                events.push('threshold-check');
                return true;
            }
        }
    };
    const service = new TagConsistencyService(owner);
    service.snapshots.set(plan.token, { token: plan.token, expiresAt: plan.expiresAt, plan });
    const result = await service.applyPreview(plan.token);
    assert.deepEqual(events, ['commit', 'threshold-check']);
    assert.equal(result.training.queued, true);
});

test('Memo unavailability degrades to scoped KNN but unrelated errors remain visible', async () => {
    const kb = require('../KnowledgeBaseManager');
    const execute = Object.getPrototypeOf(kb).executeNativeRiverQuery;
    for (const stage of ['prepare', 'joint']) {
        const owner = {
            config: { dimension: 2, nativeRiverQueryEnabled: true },
            async _getOrLoadDiaryIndex() {},
            async getFileIdsByDiaries() { return [1, 2]; },
            async prepareUnifiedMemoObservation() {
                if (stage === 'prepare') {
                    throw Object.assign(new Error('stale'), { code: 'MEMO_ARTIFACT_UNAVAILABLE' });
                }
                return { artifact: { artifactSig: 'old' } };
            },
            riverMemoEngine: { async rerank() {
                throw new Error('KNOWLEDGE_STORE_DERIVED_DEPENDENCY_CONFLICT');
            } },
            async searchKnn(names, vector, k, options) {
                assert.deepEqual(names, ['test']);
                assert.equal(k, 2);
                assert.deepEqual(options.allowedFileIds, [2]);
                assert.deepEqual(options.deniedFileIds, [3]);
                return [{ id: 2, retrievalEngine: 'knn' }];
            }
        };
        const result = await execute.call(owner, { vector: [1, 0] }, {
            diaryNames: ['test'], topK: 2, allowedFileIds: [2], deniedFileIds: [3]
        });
        assert.equal(result.diagnostics.degraded, true);
        assert.equal(result.results[0].retrievalEngine, 'knn');
        owner.prepareUnifiedMemoObservation = async () => { throw new Error('database corrupt'); };
        await assert.rejects(execute.call(owner, { vector: [1, 0] }, {
            diaryNames: ['test']
        }), /database corrupt/);
    }
});

test('Tag-only repair embeds missing Tags without replacing complete stored chunks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kbm-tag-only-'));
    const file = path.join(root, 'repair.txt');
    const content = 'existing body';
    await fs.writeFile(file, content);
    const checksum = require('node:crypto').createHash('md5').update(content).digest('hex');
    const embedded = [];
    embed = async texts => {
        embedded.push(...texts);
        return texts.map(() => [1, 0]);
    };
    const owner = {
        config: { rootPath: root, dimension: 2, modelSig: 'test', maxBatchSize: 50 },
        pendingFiles: new Set([file]), watcherPathGenerations: new Map(),
        fileRetryCount: new Map(), diaryIndices: new Map(),
        probeIngestionFiles: async () => [{
            path: 'repair.txt', exists: true, checksum, size: Buffer.byteLength(content),
            completeVectors: true, chunkCount: 1, validVectorCount: 1,
            completeTags: false, version: 3
        }],
        prepareIngestionText: async () => ({ chunks: [content], tags: ['good', 'missing'] }),
        probeMigrationReuse: async requests => {
            assert.deepEqual(requests, []);
            return [];
        },
        probeIngestionTags: async () => [
            { name: 'good', hasVector: true }, { name: 'missing', hasVector: false }
        ],
        _prepareTextForEmbedding: text => text,
        _isSqliteBusyError: () => false, _isSqliteCorruptionError: () => false,
        invalidateDiaryDateIndex() {},
        async commitIngestionBatch(plan, chunks, tags) {
            owner._shuttingDown = true;
            assert.equal(plan.files[0].tagsOnly, true);
            assert.equal(plan.files[0].expectedVersion, 3);
            assert.equal(plan.files[0].chunkCount, 0);
            assert.deepEqual(plan.chunks, []);
            assert.equal(chunks.length, 0);
            assert.equal(tags.length, 2);
            assert.equal(plan.tags[0].vectorSlot, null);
            assert.equal(plan.tags[1].vectorSlot, 0);
            return { indexReady: true };
        }
    };
    try {
        await new IngestionPipeline(owner)._flushBatch();
        assert.deepEqual(embedded, ['missing']);
        assert.equal(owner.pendingFiles.size, 0);
        assert.equal(owner.fileRetryCount.size, 0);
    } finally {
        owner._shuttingDown = true;
        await fs.rm(root, { recursive: true, force: true });
    }
});