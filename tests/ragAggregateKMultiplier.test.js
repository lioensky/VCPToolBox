'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ragSingleton = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js');

function createFixture() {
    const rag = new ragSingleton.constructor();
    rag.getSingleEmbeddingCached = async () => [1, 0];
    rag.vectorDBManager = {
        config: { nativeRiverQueryEnabled: true },
        executeNativeRiverQuery: async () => ({ results: [{ text: 'fixture', score: 1 }] }),
        deduplicateResults: async rows => rows
    };
    return rag;
}

function readMetadata(content) {
    const match = content.match(/<!-- VCP_RAG_BLOCK_START (.+?) -->/);
    assert.ok(match, 'retrieval should emit block metadata');
    return JSON.parse(match[1]);
}

async function aggregate(rag, modifiers, processedDiaries = new Set()) {
    const parsed = rag._parseAggregateSyntax('A|B', modifiers);
    return readMetadata(await rag._processAggregateRetrieval({
        ...parsed,
        modifiers,
        dynamicK: 10,
        queryVector: [1, 0],
        userContent: 'fixture',
        processedDiaries
    }));
}

test('aggregate K multiplier applies exactly once at either end of the modifiers', async () => {
    const rag = createFixture();
    for (const modifiers of [':0.6::Expand', '::Expand:0.6']) {
        const metadata = await aggregate(rag, modifiers);
        assert.equal(metadata.k, 6, modifiers);
        assert.equal(metadata.modifiers, modifiers);
        assert.deepEqual(metadata.diaryNames, ['A', 'B']);
    }
});

test('aggregate refresh keeps the resolved K with new and legacy metadata', async () => {
    const rag = createFixture();
    const metadata = await aggregate(rag, '::Expand:0.6');
    const { kMultiplierApplied, ...legacyMetadata } = metadata;
    assert.equal(kMultiplierApplied, true);
    const singleRemaining = await aggregate(rag, '::Expand:0.6', new Set(['B']));
    assert.equal(singleRemaining.virtualIndex, undefined);

    for (const block of [metadata, legacyMetadata, singleRemaining]) {
        const refreshed = await rag.refreshRagBlock(block, {}, 'fixture');
        assert.equal(readMetadata(refreshed).k, 6);
    }
});

test('resolved aggregate K does not share a cache key with unscaled base K', () => {
    const rag = createFixture();
    const params = { dbName: 'A|B', dynamicK: 6, modifiers: '::Expand:0.6' };
    assert.notEqual(
        rag._generateCacheKey({ ...params, kMultiplierApplied: true }),
        rag._generateCacheKey(params)
    );
});