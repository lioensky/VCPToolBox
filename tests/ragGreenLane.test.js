'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rag = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
const kb = require('../KnowledgeBaseManager');

function host() {
    const instance = Object.create(rag);
    instance.queryCacheEnabled = false;
    instance.ragParams = {};
    instance.rerankConfig = { multiplier: 3, useJev: true };
    instance.pushVcpInfo = null;
    instance._rerankDocuments = async () => { throw new Error('serial HTTP used'); };
    return instance;
}

test('independent RRF includes exclusive candidates and respects weight endpoints', () => {
    const instance = host();
    const river = [{ chunkId: 1, text: 'river' }, { chunkId: 3, text: 'shared' }];
    const external = [{ chunkId: 2, text: 'external' }, { chunkId: 3, text: 'shared', rerank_score: 0.8 }];
    assert.deepEqual(instance._fuseIndependentRankings(river, external, 1, 3)
        .map(doc => doc.chunkId), [2, 3]);
    assert.deepEqual(instance._fuseIndependentRankings(river, external, 0, 3)
        .map(doc => doc.chunkId), [1, 3]);
    const merged = instance._fuseIndependentRankings(river, external, 0.5, 3);
    assert.equal(merged[0].chunkId, 3);
    assert.equal(merged[0].rerank_score, 0.8);
    assert.equal(merged.length, 3);
});

test('green proxy does not prepare Sense and passes sparse scope', async () => {
    const owner = Object.create(kb);
    owner._getOrLoadDiaryIndex = async () => {};
    owner.prepareUnifiedMemoObservation = async () => { throw new Error('Sense used'); };
    owner.nativeKnowledgeRuntime = {
        async executeExternalRerank(payload, vector) {
            const plan = JSON.parse(payload);
            assert.equal(plan.externalOnly, true);
            assert.deepEqual(plan.diaryNames, ['A']);
            assert.equal(plan.fileCandidates[0].path, 'A/a.txt');
            assert(vector instanceof Float32Array);
            return JSON.stringify({ results: [] });
        }
    };
    await owner.executeExternalRerank({ text: 'last week', vector: [1, 0] }, {
        diaryNames: ['A', 'A'], fileCandidates: [{ path: 'A/a.txt' }]
    });
});

test('Time and River thinking never block green HTTP startup or trigger serial rerank', async () => {
    const instance = host();
    const events = [];
    let finishExternal;
    const externalDone = new Promise(resolve => { finishExternal = resolve; });
    instance.vectorDBManager = {
        config: { nativeRiverQueryEnabled: true },
        nativeKnowledgeRuntime: { executeExternalRerank() {} },
        async executeExternalRerank() {
            events.push('external');
            await externalDone;
            return { results: [{ chunkId: 2, text: 'external', rerank_score: 0.9 }] };
        },
        tagIndex: { planMemoThinking() {} },
        async prepareUnifiedMemoObservation() {
            assert.deepEqual(events, ['external']);
            events.push('sense');
            return { observationHandle: 'fixture' };
        },
        async executeNativeRiverQuery(query, options) {
            assert.equal(options.enhancedAnn, true);
            events.push('river');
            finishExternal();
            return { results: [{ chunkId: 1, text: 'river', score: 0.8 }] };
        },
        async deduplicateResults(results) { return results; }
    };
    const requestCache = {
        ownedMemoObservations: new Set(),
        riverThinking: {
            config: { maxTransitionRecords: 10 }, observations: [],
            ready: [{ resolve() {} }, { resolve() {} }]
        }
    };
    const results = await instance._processRAGPlaceholder({
        dbName: 'A', modifiers: '::Time::Jev+1', queryVector: [1, 0],
        userContent: 'last week', dynamicK: 1, timeRanges: [],
        returnRawResults: true, requestCache
    });
    assert.deepEqual(events, ['external', 'sense', 'river']);
    assert.deepEqual(results.map(doc => doc.chunkId), [2]);
});

test('failed green HTTP preserves River results', async () => {
    const instance = host();
    instance.vectorDBManager = {
        config: { nativeRiverQueryEnabled: true },
        nativeKnowledgeRuntime: { executeExternalRerank() {} },
        async executeExternalRerank() { throw new Error('fixture timeout'); },
        async executeNativeRiverQuery() {
            return { results: [{ chunkId: 1, text: 'river', score: 0.8 }] };
        },
        async deduplicateResults(results) { return results; }
    };
    const results = await instance._processRAGPlaceholder({
        dbName: 'A', modifiers: '::Rerank+', queryVector: [1, 0],
        userContent: 'query', dynamicK: 1, timeRanges: [], returnRawResults: true
    });
    assert.deepEqual(results.map(doc => doc.chunkId), [1]);
});

test('Group and BM25 share a sparse plan while Time only feeds the River pool', async () => {
    const instance = host();
    let sparseCalls = 0;
    const groupVector = [0, 1];
    instance.semanticGroups = {
        detectAndActivateGroups: () => new Map([['fixture', {}]]),
        getEnhancedVector: async () => groupVector
    };
    instance._getBM25FileCandidates = async () => {
        sparseCalls++;
        return { files: [{ path: 'A/a.txt', normalizedBM25Score: 1 }], matchedCount: 1 };
    };
    instance._getTimeRangeFilePathsCached = async () => ['A/time.txt'];
    instance.vectorDBManager = {
        config: { nativeRiverQueryEnabled: true },
        nativeKnowledgeRuntime: { executeExternalRerank() {} },
        async executeExternalRerank(query, options) {
            assert.equal(query.vector, groupVector);
            assert.deepEqual(options.fileCandidates.map(file => file.path), ['A/a.txt']);
            return { results: [{ chunkId: 9, text: 'external exclusive', rerank_score: 1 }] };
        },
        async executeNativeRiverQuery(query, options) {
            assert.equal(options.enhancedAnn, true);
            assert(options.hybridPlan.fileCandidates.some(file => file.source === 'time'));
            return { results: [
                { chunkId: 1, text: 'semantic', score: 0.9 },
                { chunkId: 2, text: 'time', score: 0.8, source: 'time' }
            ] };
        },
        async deduplicateResults(results) { return results; }
    };
    const results = await instance._processRAGPlaceholder({
        dbName: 'A', modifiers: '::Group::BM25::Time::Jev+1',
        queryVector: [1, 0], userContent: 'last week', dynamicK: 1,
        timeRanges: [{ start: new Date(0), end: new Date() }], returnRawResults: true
    });
    assert.equal(sparseCalls, 1);
    assert.deepEqual(results.map(doc => doc.chunkId), [9]);
});

test('Omega mapping uses conservative endpoints and neutral invalid fallback', () => {
    const instance = host();
    for (const [omega, expected] of [[0, 0.7], [0.4, 0.7], [0.65, 0.5], [0.9, 0.3], [1, 0.3]]) {
        assert(Math.abs(instance._omegaRrfAlpha(omega) - expected) < 1e-12);
    }
    for (const invalid of [undefined, null, NaN, Infinity, '0.9', -1, 2]) {
        assert.equal(instance._omegaRrfAlpha(invalid), 0.5);
    }
});

test('only bare plus uses native Omega; explicit weights and missing Omega stay unchanged', async () => {
    for (const [suffix, omega, expected] of [
        ['::Rerank+', 0.9, 0.3],
        ['::Jev2+', 0.4, 0.7],
        ['::Jev+', undefined, 0.5],
        ['::Jev+', null, 0.5],
        ['::Rerank+0.5', 0.9, 0.5],
        ['::Jev+0', 0.4, 0],
        ['::Jev+1', 0.9, 1]
    ]) {
        const instance = host();
        let actual;
        instance._fuseIndependentRankings = (river, external, alpha) => {
            actual = alpha;
            return river;
        };
        instance.vectorDBManager = {
            config: { nativeRiverQueryEnabled: true },
            nativeKnowledgeRuntime: { executeExternalRerank() {} },
            async executeExternalRerank() { return { results: [] }; },
            async executeNativeRiverQuery() {
                return { omega: { omega }, results: [{ chunkId: 1, text: 'river', score: 0.8 }] };
            },
            async deduplicateResults(results) { return results; }
        };
        await instance._processRAGPlaceholder({
            dbName: 'A', modifiers: suffix, queryVector: [1, 0],
            userContent: 'query', dynamicK: 1, timeRanges: [], returnRawResults: true
        });
        assert(Math.abs(actual - expected) < 1e-12, suffix);
    }
});

test('bare plus requests native automatic fusion and publishes the resolved weight', async () => {
    const instance = host();
    let broadcast;
    instance.pushVcpInfo = info => { broadcast = info; };
    instance.vectorDBManager = {
        config: { nativeRiverQueryEnabled: true },
        nativeKnowledgeRuntime: { executeParallelRerank() {} },
        async executeNativeRiverQuery() { throw new Error('serial path used'); },
        async executeParallelRerank(query, options) {
            assert.equal(options.autoRrfAlpha, true);
            return {
                omega: { omega: 0.9 },
                results: [{ chunkId: 1, text: 'river', score: 0.8 }],
                diagnostics: { nativeRerank: { alpha: 0.3, riverWeight: 0.7, weightMode: 'omega-v1' } }
            };
        },
        async deduplicateResults(results) { return results; }
    };
    await instance._processRAGPlaceholder({
        dbName: 'A', modifiers: '::Jev+', queryVector: [1, 0],
        userContent: 'query', dynamicK: 1, timeRanges: []
    });
    assert.equal(broadcast.rrfAlpha, 0.3);
});