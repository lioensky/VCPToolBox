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

function greenHost(riverResults, externalResults) {
    const instance = host(riverResults);
    instance._rerankDocuments = async () => { throw new Error('serial HTTP used'); };
    instance.vectorDBManager.nativeKnowledgeRuntime = { executeExternalRerank() {} };
    instance.vectorDBManager.executeExternalRerank = async () => ({ results: externalResults });
    return instance;
}

test('::Time with ::Rerank+ keeps the Time quota through GreenLane fusion', async () => {
    const river = [
        ...[1, 2, 3, 4, 5, 6, 7, 8].map(id => ({ chunkId: id, text: `semantic ${id}`, score: 1 - id / 100 })),
        { chunkId: 90, text: 'time 90', score: 0.5, source: 'time' },
        { chunkId: 91, text: 'time 91', score: 0.4, source: 'time' }
    ];
    const external = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59]
        .map(id => ({ chunkId: id, text: `external ${id}`, rerank_score: 1 - id / 100 }));
    const results = await greenHost(river, external)._processRAGPlaceholder({
        dbName: 'A', modifiers: '::Time::Rerank+', queryVector: [1, 0], userContent: 'last week',
        dynamicK: 5, timeRanges: [{ start: new Date(0), end: new Date() }], returnRawResults: true
    });
    assert.equal(results.length, 5);
    // finalK=5, ratio 0.2 -> one Time slot, the best Time entry in River order.
    assert.deepEqual(results.filter(doc => doc.source === 'time').map(doc => doc.chunkId), [90]);
    assert.equal(new Set(results.map(doc => doc.chunkId)).size, 5);
});

test('GreenLane fusion without Time entries is unchanged by the Time quota', () => {
    const instance = Object.create(rag);
    const river = [1, 2, 3, 4].map(id => ({ chunkId: id, text: `r${id}` }));
    const external = [3, 5, 1, 6].map(id => ({ chunkId: id, text: `e${id}`, rerank_score: 1 / id }));
    for (const alpha of [0, 0.3, 0.5, 1]) {
        const plain = instance._fuseIndependentRankings(river, external, alpha, 3);
        assert.deepEqual(instance._fuseIndependentRankings(river, external, alpha, 3, 1), plain);
    }
    const withTime = [...river, { chunkId: 9, text: 't9', source: 'time' }];
    assert.deepEqual(
        instance._fuseIndependentRankings(withTime, external, 0.5, 3, 0),
        instance._fuseIndependentRankings(withTime, external, 0.5, 3)
    );
});

test('time-aware block prints the range in the configured timezone', () => {
    const dayjs = require('dayjs');
    dayjs.extend(require('dayjs/plugin/utc'));
    dayjs.extend(require('dayjs/plugin/timezone'));
    const formatter = require('../Plugin/RAGDiaryPlugin/RAGResultFormatter');
    const zone = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';
    const day = dayjs.tz('2026-05-02', zone);
    const block = formatter.formatCombinedTimeAwareResults(
        [], [{ start: day.startOf('day').toDate(), end: day.endOf('day').toDate() }], 'Nova', {}
    );
    assert.match(block, /\[合并查询的时间范围: "2026-05-02 ~ 2026-05-02"\]/);
});
