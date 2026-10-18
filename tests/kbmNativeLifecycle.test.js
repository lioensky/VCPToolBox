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