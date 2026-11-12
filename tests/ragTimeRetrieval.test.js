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

function dateIndexHost(indexes) {
    const instance = Object.create(rag);
    instance.vectorDBManager = {
        async getDiaryDateIndex(name) { return (indexes[name] || []).map(row => ({ ...row })); },
        async getChunksByFilePaths(paths) {
            return paths.map(fullPath => ({ text: `body of ${fullPath}`, fullPath }));
        }
    };
    return instance;
}

test('recent continuity across several diaries takes the newest files of all of them', async () => {
    const indexes = {
        A: ['2024-01-05', '2024-01-04', '2024-01-03', '2024-01-02', '2024-01-01']
            .map(date => ({ relativePath: `A/${date}.txt`, date })),
        B: [{ relativePath: 'B/2026-11-12.txt', date: '2026-11-12' }]
    };
    const recent = await dateIndexHost(indexes)._getRecentDiaryChunks(['A', 'B'], 3);
    assert.deepEqual(recent.map(doc => doc.fullPath),
        ['B/2026-11-12.txt', 'A/2024-01-05.txt', 'A/2024-01-04.txt']);
    assert.deepEqual(recent.map(doc => doc.date), ['2026-11-12', '2024-01-05', '2024-01-04']);

    const single = await dateIndexHost(indexes)._getRecentDiaryChunks('A', 3);
    assert.deepEqual(single.map(doc => doc.fullPath),
        ['A/2024-01-05.txt', 'A/2024-01-04.txt', 'A/2024-01-03.txt']);
});

test('time-route chunks without a date get it from the diary date index', async () => {
    const index = [
        { relativePath: 'A/2026-05-03.txt', date: '2026-05-03' },
        { relativePath: 'A/2026-05-02.txt', date: '2026-05-02' }
    ];
    const timeRanges = [{ start: new Date('2026-05-01T00:00:00Z'), end: new Date('2026-05-04T00:00:00Z') }];
    const nativeChunks = [
        { chunkId: 1, text: 'semantic', score: 0.9, fullPath: 'B/x.txt' },
        { chunkId: 2, text: 'second chunk, no date header', score: 0.5, source: 'time', fullPath: 'A/2026-05-02.txt' },
        { chunkId: 3, text: 'kept', score: 0.4, source: 'time', fullPath: 'A/2026-05-03.txt', date: '1999-01-01' }
    ];
    const native = host(nativeChunks);
    native.vectorDBManager.getDiaryDateIndex = async () => index.map(row => ({ ...row }));
    const nativeResults = await native._processRAGPlaceholder({
        dbName: 'A', modifiers: '::Time0.5', queryVector: [1, 0], userContent: 'q',
        dynamicK: 4, timeRanges, returnRawResults: true, requestCache: native._createRequestCache()
    });
    const byId = new Map(nativeResults.map(doc => [doc.chunkId, doc]));
    assert.equal(byId.get(2).date, '2026-05-02');
    assert.equal(byId.get(3).date, '1999-01-01');
    assert.equal(byId.get(1).date, undefined);

    const fallback = Object.create(rag);
    fallback.queryCacheEnabled = false;
    fallback.ragParams = {};
    fallback.rerankConfig = { multiplier: 2 };
    fallback.pushVcpInfo = null;
    fallback._rerankRAGCandidatesWithRiverMemo = async ({ candidates }) => ({ results: candidates, meta: null });
    fallback.vectorDBManager = {
        config: {},
        async getDiaryDateIndex() { return index.map(row => ({ ...row })); },
        async searchKnn() { return []; },
        async getChunksByFilePaths(paths) {
            return paths.map((fullPath, i) => ({ chunkId: 10 + i, text: `chunk ${i}`, fullPath }));
        },
        async deduplicateResults(items) { return items; }
    };
    const fallbackResults = await fallback._processRAGPlaceholder({
        dbName: 'A', modifiers: '::Time1', queryVector: [1, 0], userContent: 'q',
        dynamicK: 2, timeRanges, returnRawResults: true, requestCache: fallback._createRequestCache()
    });
    assert.deepEqual(fallbackResults.map(doc => [doc.fullPath, doc.date]).sort(),
        [['A/2026-05-02.txt', '2026-05-02'], ['A/2026-05-03.txt', '2026-05-03']]);
});

test('Time quota follows the non-GreenLane rule and survives a GreenLane failure', () => {
    const river = [
        { id: 1, source: 'rag' }, { id: 2, source: 'rag' },
        { id: 3, source: 'time' }, { id: 4, source: 'time' }
    ];
    // External rerank failed: River order, Time entries kept instead of cut by slice(0, finalK).
    assert.deepEqual(rag._applyTimeQuota(river, river, 2, 1).map(doc => doc.id), [1, 3]);
    // finalK = 1: at least one semantic slot plus the Time slot, as the non-GreenLane split gives.
    assert.deepEqual(rag._applyTimeQuota(river, river, 1, 1).map(doc => doc.id), [1, 3]);
    // No ::Time: plain truncation.
    assert.deepEqual(rag._applyTimeQuota(river, river, 2, 0).map(doc => doc.id), [1, 2]);
});
