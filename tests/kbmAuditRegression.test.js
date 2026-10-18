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
        const owner = {
            config: { rootPath: root, dimension: 2, modelSig: 'test', maxBatchSize: 50,
                sqliteBusyRetryDelayMs: 1 },
            pendingFiles: new Set([good, bad]), pendingDeletes: new Set(),
            watcherPathGenerations: new Map(), fileRetryCount: new Map(),
            diaryIndices: new Map(),
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
                return { factsCommitted: true, indexReady: true, newTagIds: [], affectedDiaries: [] };
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
    const owner = {
        dbPath: 'unused', config: { modelSig: 'test', dimension: 2 },
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