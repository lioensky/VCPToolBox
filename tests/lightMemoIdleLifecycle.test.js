'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const IndexRepository = require('../modules/knowledgeBase/indexRepository');

test('LightMemo idle sweep delegates TTL and tolerates a busy native table', async () => {
    const received = [];
    const repo = new IndexRepository({
        config: { lightMemoIndexIdleTTL: 1234, indexIdleTTL: 10000,
            indexIdleSweepInterval: 60000, persistFolders: new Set() },
        getNativeRuntime: () => ({
            evictIdleLightMemoIndex(ttl) { received.push(ttl); return false; }
        })
    });
    await repo.evictIdle();
    assert.deepEqual(received, [1234]);
    repo.startIdleSweep();
    assert.equal(repo.idleSweepTimer.hasRef(), false);
    repo.stopIdleSweep();
    assert.equal(repo.idleSweepTimer, null);
});

test('LightMemo idle sweep defaults to ten minutes and survives eviction errors', async () => {
    const received = [];
    const repo = new IndexRepository({
        config: { persistFolders: new Set() },
        getNativeRuntime: () => ({
            evictIdleLightMemoIndex(ttl) {
                received.push(ttl);
                throw new Error('injected lifecycle failure');
            }
        })
    });
    await repo.evictIdle();
    assert.deepEqual(received, [600000]);
});

test('global Chunk checkpoints respect scope, disabled mode and explicit initial permission', async () => {
    const calls = [];
    const config = {
        persistFolders: new Set(), persistDefault: false,
        chunkIndexPersistenceMode: 'generational',
        chunkIndexAllowInitial: false, chunkIndexBaselineDeltaRatio: 0.08,
        modelSig: 'local-model'
    };
    const repo = new IndexRepository({
        config,
        getNativeRuntime: () => ({
            async checkpointGlobalChunkIndex(...args) {
                calls.push(args);
                return JSON.stringify({ published: true, factsCommitted: false });
            }
        })
    });
    assert.equal(await repo.publishGlobalChunkBaseline(), false);
    config.persistFolders.add('SomeDiary');
    assert.equal(await repo.publishGlobalChunkBaseline(), false);
    config.persistFolders.add('global_chunks');
    assert.equal(await repo.publishGlobalChunkBaseline(), true);
    assert.deepEqual(calls.pop(), ['local-model', 0.08, false]);
    config.chunkIndexAllowInitial = true;
    assert.equal(await repo.publishGlobalChunkBaseline(), true);
    assert.deepEqual(calls.pop(), ['local-model', 0.08, true]);
    repo.chunkIndexPersistenceMode = 'none';
    config.persistDefault = true;
    assert.equal(await repo.publishGlobalChunkBaseline(), false);
    assert.equal(calls.length, 0);
});