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