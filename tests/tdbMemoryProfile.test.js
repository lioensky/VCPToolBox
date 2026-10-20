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

test('stage samples are bounded scalar diagnostics and profiles return copies', () => {
    const { captureMemoryStage } = require('../modules/knowledgeBase/memoryProfiler');
    const state = fixture({ totalVectors: 7, hotBytes: 1024, mmapBytes: 8000 });
    state.tagIndex.memoRuntimeStats = () => { throw new Error('must not load Memo'); };
    for (let i = 0; i < 40; i++) captureMemoryStage(state, `stage-${i}`);
    assert.equal(state.memoryStageSamples.length, 32);
    assert.equal(state.memoryStageSamples[0].stage, 'stage-8');
    const sample = state.memoryStageSamples[31];
    assert.equal(sample.tagHotBytes, 1024);
    assert.equal(sample.tagMappedBytes, 8000);
    assert.equal(sample.diaryHotBytes, 1024);
    assert.ok(sample.rss > 0);
    const profile = buildMemoryProfile(state);
    profile.memoryStageSamples[0].stage = 'changed';
    assert.equal(state.memoryStageSamples[0].stage, 'stage-8');
});

test('River memory profile exposes retained observation capacities without clearing them', () => {
    const state = fixture({ totalVectors: 3, hotBytes: 1024 });
    let reads = 0;
    state.tagMemoV10Engine = { getArtifactSnapshot: () => ({ artifactSig: 'a' }) };
    state.tagIndex.memoRuntimeStats = () => ({
        activeArtifactSig: 'a', generation: 1, nodeCount: 3, edgeCount: 4
    });
    state.tagIndex.memoObservationMemoryStats = () => {
        reads++;
        return JSON.stringify({ entries: 5, expiredEntries: 3, payloadCapacityBytes: 123456 });
    };
    const profile = buildMemoryProfile(state);
    assert.equal(profile.riverMemo.observationMemory.entries, 5);
    assert.equal(profile.riverMemo.observationMemory.expiredEntries, 3);
    assert.equal(profile.riverMemo.observationMemory.payloadCapacityBytes, 123456);
    assert.equal(reads, 1);
});