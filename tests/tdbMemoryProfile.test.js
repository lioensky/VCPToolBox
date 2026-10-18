'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildMemoryProfile } = require('../modules/knowledgeBase/memoryProfiler');

function fixture(stats) {
    return {
        config: { dimension: 3072, indexIdleTTL: 600000 },
        diaryIndices: new Map([['fixture', { stats: () => stats }]]),
        diaryIndexLastUsed: new Map(),
        diaryDateIndexCache: new Map(),
        diaryNameVectorCache: new Map(),
        tagIndex: { stats: () => stats },
        pendingFiles: new Set(),
        pendingDeletes: new Set(),
        saveTimers: new Map(),
        diaryIndexLoadPromises: new Map(),
        watcherPathGenerations: new Map()
    };
}

test('TDB memory profile separates hot heap from mapped asset length', () => {
    const result = buildMemoryProfile(fixture({
        totalVectors: 2304, hotBytes: 4096, mmapBytes: 32_000_000, tombstones: 7
    }));
    assert.equal(result.tagIndex.estimatedBytes, 4096);
    assert.equal(result.tagIndex.mmapBytes, 32_000_000);
    assert.equal(result.tagIndex.tombstones, 7);
    assert.equal(result.diaryIndices.estimatedBytes, 4096);
    assert.equal(result.diaryIndices.items[0].mmapBytes, 32_000_000);
    assert.equal(result.estimatedBytes, 8192);
});

test('TDB memory profile accepts zero hot bytes and legacy statistics', () => {
    assert.equal(buildMemoryProfile(fixture({
        totalVectors: 5, hotBytes: 0, mmapBytes: 5000
    })).estimatedBytes, 0);
    const legacy = buildMemoryProfile(fixture({ totalVectors: 5 }));
    assert.equal(legacy.tagIndex.estimatedBytes, Math.round(5 * 3072 * 4 * 1.6));
    assert.equal(legacy.tagIndex.mmapBytes, 0);
    assert.equal(legacy.tagIndex.tombstones, 0);
});