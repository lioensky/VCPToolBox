'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rag = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

function host(results) {
    const instance = Object.create(rag);
    instance.queryCacheEnabled = false;
    instance.ragParams = {};
    instance.rerankConfig = { multiplier: 2 };
    instance.pushVcpInfo = null;
    instance.vectorDBManager = {
        config: { nativeRiverQueryEnabled: true },
        async executeNativeRiverQuery() { return { results }; },
        async deduplicateResults(items) { return items; }
    };
    return instance;
}

test('::TimeDecay whitelist accepts Chinese tags and stops before a K multiplier', async () => {
    const results = [
        { chunkId: 1, text: '[2020-01-01] - Nova\nTag: 动态进展, 项目', score: 0.9 },
        { chunkId: 2, text: '[2020-01-01] - Nova\nTag: 其他', score: 0.8 },
        { chunkId: 3, text: '[2020-01-01] - Nova\nTag: box审计', score: 0.7 }
    ];
    const run = modifiers => host(results)._processRAGPlaceholder({
        dbName: 'A', modifiers, queryVector: [1, 0], userContent: 'query',
        dynamicK: 3, timeRanges: [], returnRawResults: true
    });
    const decayed = docs => docs.filter(doc => doc.decay_factor !== undefined)
        .map(doc => doc.chunkId).sort();

    assert.deepEqual(decayed(await run('::TimeDecay30/0/动态进展')), [1]);
    assert.deepEqual(decayed(await run('::TimeDecay30/0/动态进展:1.5')), [1]);
    assert.deepEqual(decayed(await run('::TimeDecay30/0/box归档::Truncate0')), []);
    assert.deepEqual(decayed(await run('::TimeDecay30/0/其他,box审计')), [2, 3]);
});
