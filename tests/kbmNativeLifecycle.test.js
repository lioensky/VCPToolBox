'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NativeKnowledgeRuntime, VexusIndex } = require('../rust-vexus-lite');

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;

test('native shutdown drains queued computations before resolving promises', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbm-native-drain-'));
    const runtime = new NativeKnowledgeRuntime(new VexusIndex(2, 16));
    let closed = false;
    try {
        runtime.openAndInitStore(path.join(root, 'test.sqlite'));
        const tasks = Array.from({ length: 32 }, () =>
            runtime.searchGlobalTags(new Float32Array([1, 0]), 10));
        runtime.shutdown();
        closed = true;
        fs.rmSync(root, { recursive: true });
        for (const result of await Promise.all(tasks)) {
            assert.deepEqual(parse(result), []);
        }
        assert.throws(() =>
            runtime.searchGlobalTags(new Float32Array([1, 0]), 10), /shutting down/);
    } finally {
        if (!closed) runtime.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('native replacement drains queued plans and preserves durable cancellation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbm-native-replace-'));
    const db = path.join(root, 'test.sqlite');
    const runtime = new NativeKnowledgeRuntime(new VexusIndex(2, 16));
    try {
        runtime.openAndInitStore(db, JSON.stringify({ readPoolSize: 2, mmapSize: 0 }));
        const pending = Array.from({ length: 32 }, () =>
            runtime.prepareTagConsistency(JSON.stringify({
                dbPath: db, rootPath: root, dimension: 2, modelSig: 'test'
            })));
        runtime.openAndInitStore(db);
        const plans = await Promise.all(pending);
        for (const raw of plans) {
            const plan = parse(raw);
            assert.equal(parse(await runtime.cancelPreparedPlan(plan.token)).cancelled, true);
            await assert.rejects(
                runtime.commitTagConsistency(db, JSON.stringify(plan), new Float32Array()),
                /EXPIRED_OR_CANCELLED/
            );
        }
        assert.equal(parse(await runtime.healthCheck()).healthy, true);
    } finally {
        runtime.shutdown();
        fs.rmSync(root, { recursive: true });
    }
});

test('index-owned tasks are drained by runtime shutdown and rejected afterward', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbm-index-drain-'));
    const index = new VexusIndex(2, 16);
    const runtime = new NativeKnowledgeRuntime(index);
    try {
        const db = path.join(root, 'test.sqlite');
        runtime.openAndInitStore(db);
        const pending = Array.from({ length: 24 }, () =>
            index.computePairwiseSimilarities(db, 'test', 0.05, false));
        runtime.shutdown();
        for (const result of await Promise.all(pending)) {
            assert.equal(result.pairCount, 0);
        }
        await assert.rejects(index.computePairwiseSimilarities(db, 'test'), /CLOSED/);
        fs.rmSync(root, { recursive: true });
    } finally {
        runtime.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('metadata-only refresh preserves fact generation and checks file version', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbm-metadata-'));
    const db = path.join(root, 'test.sqlite');
    const runtime = new NativeKnowledgeRuntime(new VexusIndex(2, 16));
    try {
        runtime.openAndInitStore(db);
        await runtime.commitIngestionBatch(db, JSON.stringify({
            operationId: 'metadata-fixture', batchId: 'metadata-fixture',
            dimension: 2, modelSig: 'test',
            files: [{
                path: 'note.txt', diaryName: 'test', checksum: 'same', mtime: 1, size: 1,
                expectedVersion: 0, chunkStart: 0, chunkCount: 1, tagStart: 0, tagCount: 0
            }],
            chunks: [{ content: 'same', chunkIndex: 0, vectorSlot: 0 }], tags: []
        }), new Float32Array([1, 0]), new Float32Array());
        const generation = runtime.databaseGeneration();
        await runtime.refreshFileMetadata(db, JSON.stringify({
            path: 'note.txt', checksum: 'same', version: 1, mtime: 500, size: 4
        }));
        const [row] = parse(await runtime.probeIngestionFiles(db, ['note.txt']));
        assert.equal(row.mtime, 500);
        assert.equal(row.size, 4);
        assert.equal(row.version, 1);
        assert.equal(runtime.databaseGeneration(), generation);
        await assert.rejects(runtime.refreshFileMetadata(db, JSON.stringify({
            path: 'note.txt', checksum: 'same', version: 0, mtime: 999, size: 4
        })), /FILE_VERSION_CONFLICT/);
    } finally {
        runtime.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});