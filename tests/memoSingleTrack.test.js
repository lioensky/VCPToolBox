'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SearchService = require('../modules/knowledgeBase/searchService');
const DreamWaveEngine = require('../Plugin/AgentDream/DreamWaveEngine');
const rag = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
const kb = require('../KnowledgeBaseManager');

test('pure KNN merges selected indices and hydrates without Memo processing', async () => {
    const owner = {
        config: { dimension: 2 },
        _isVectorLike: value => Array.isArray(value) || value instanceof Float32Array,
        async listDistinctDiaries() { return []; },
        nativeKnowledgeRuntime: {
            async searchDiaryIndices(names, vector) {
                assert.deepEqual(names, ['A', 'B']);
                assert(vector instanceof Float32Array);
                return { results: [{ id: 3, score: 1 }, { id: 2, score: 0.9 }, { id: 1, score: 0.8 }],
                    hydratedChunks: [
                        { id: 1, text: 'a', sourceFile: 'A/a.md', diaryName: 'A', fileId: 10 },
                        { id: 2, text: 'b', sourceFile: 'B/b.md', diaryName: 'B', fileId: 20 },
                        { id: 3, text: 'outside', sourceFile: 'C/c.md', diaryName: 'C', fileId: 30 }
                    ] };
            }
        },
        async _getOrLoadDiaryIndex(name) {
            return { search: () => name === 'A'
                ? [{ id: 1, score: 0.8 }, { id: 3, score: 1 }]
                : [{ id: 2, score: 0.9 }, { id: 1, score: 0.7 }] };
        },
        _queryByChunks: () => [
            { id: 1, text: 'a', sourceFile: 'A/a.md', diaryName: 'A', fileId: 10 },
            { id: 2, text: 'b', sourceFile: 'B/b.md', diaryName: 'B', fileId: 20 },
            { id: 3, text: 'outside', sourceFile: 'C/c.md', diaryName: 'C', fileId: 30 }
        ],
        prepareUnifiedMemoObservation() { throw new Error('must not sense'); },
        executeNativeRiverQuery() { throw new Error('must not rerank'); }
    };
    const service = new SearchService(owner);
    const results = await service.searchKnnMany(['A', 'B'], [1, 0], 2);
    assert.deepEqual(results.map(item => item.chunkId), [2, 1]);
    assert.equal(results[0].fullPath, 'B/b.md');
    assert.equal(results[0].retrievalEngine, 'knn');
    assert.deepEqual(await service.searchKnn([], [1, 0], 2), []);
});

test('generic search delegates once to RiverMemo and forwards text and Core anchors', async () => {
    let calls = 0;
    const owner = {
        _isVectorLike: value => Array.isArray(value),
        async executeNativeRiverQuery(query, options) {
            calls++;
            assert.equal(query.text, 'query');
            assert.deepEqual(options.diaryNames, ['A', 'B']);
            assert.deepEqual(options.coreTags, ['anchor']);
            return { results: [{ chunkId: 1 }] };
        }
    };
    const service = new SearchService(owner);
    assert.equal((await service.searchMany(['A', 'B'], [1, 0], 2,
        { queryText: 'query', coreTags: ['anchor'] })).length, 1);
    assert.equal(calls, 1);
    await assert.rejects(service.search('A', [1, 0], 2, '0.6+'), /retired|退休/);
});

test('native joint disabled uses pure candidates, one observation and RiverMemo readout', async () => {
    let sensing = 0;
    let readout = 0;
    let candidates = 0;
    const prepared = { artifact: { artifactSig: 'test' }, nativePreparedQuery: {}, observationHandle: 'q' };
    let releases = 0;
    const owner = {
        releaseMemoObservation(value) {
            assert.equal(value, prepared);
            releases++;
        },
        config: { dimension: 2, nativeRiverQueryEnabled: false, nativeRiverQueryCandidateK: 8 },
        async getFileIdsByDiaries(names) {
            assert.deepEqual(names, ['A']);
            return [10];
        },
        async _getOrLoadDiaryIndex() {},
        async prepareUnifiedMemoObservation() { sensing++; return prepared; },
        async search() { throw new Error('recursive generic search'); },
        async searchKnn() { candidates++; return [{ id: 1, chunkId: 1, score: 0.8 }]; },
        async deduplicateResults(items) { return items; },
        riverMemoEngine: {
            async rerank(query, items, context, options) {
                readout++;
                assert.equal(options.nativeJointQuery, false);
                assert.equal(options.observationHandle, 'q');
                assert.deepEqual(context.allowedFileIds, [10]);
                return { results: items };
            }
        }
    };
    const result = await kb.executeNativeRiverQuery.call(owner,
        { text: 'test', vector: [1, 0] }, { diaryNames: ['A'], topK: 1 });
    assert.equal(result.results.length, 1);
    assert.equal(sensing, 1);
    assert.equal(readout, 1);
    assert.equal(candidates, 1);
    assert.equal(releases, 1);

    await kb.executeNativeRiverQuery.call(owner,
        { text: 'borrowed', vector: [1, 0] },
        { diaryNames: ['A'], topK: 1, preparedMemoObservation: prepared });
    assert.equal(releases, 1, 'borrowed observations remain caller-owned');

    owner.riverMemoEngine.rerank = async () => { throw new Error('injected readout failure'); };
    await assert.rejects(kb.executeNativeRiverQuery.call(owner,
        { text: 'failure', vector: [1, 0] }, { diaryNames: ['A'], topK: 1 }),
        /injected readout failure/);
    assert.equal(releases, 2, 'failed readout releases its owned observation');
});

test('Dream normal empty RiverMemo does not recall KNN; exceptions do', async () => {
    let knnCalls = 0;
    const owner = {
        async executeNativeRiverQuery() { return { results: [] }; },
        async searchKnn() { knnCalls++; return []; }
    };
    const engine = new DreamWaveEngine(owner);
    engine._getSearchableIndexNames = () => ['A'];
    assert.deepEqual(await engine._recallForVector('A', [1, 0], 2), []);
    assert.equal(knnCalls, 0);
    owner.executeNativeRiverQuery = async () => { throw new Error('artifact unavailable'); };
    assert.deepEqual(await engine._recallForVector('A', [1, 0], 2), []);
    assert.equal(knnCalls, 1);
});

test('ContextBridge empty success stays empty, explicit KNN fallback never senses', async () => {
    const original = rag.vectorDBManager;
    let knnCalls = 0;
    rag.vectorDBManager = {
        async executeNativeRiverQuery() { return { results: [] }; },
        async searchKnn() { knnCalls++; return []; },
        async applyTagBoostAsync() { throw new Error('must not enhance fallback'); }
    };
    try {
        const bridge = rag.getContextBridge();
        const options = { diaryNames: ['A'], queryVector: [1, 0], engine: 'rivermemo', fallback: 'knn' };
        assert.equal((await bridge.retrieveDiary(options)).meta.engine, 'rivermemo');
        assert.equal(knnCalls, 0);
        rag.vectorDBManager.executeNativeRiverQuery = async () => { throw new Error('unavailable'); };
        assert.equal((await bridge.retrieveDiary(options)).meta.engine, 'knn');
        assert.equal(knnCalls, 1);
        await assert.rejects(bridge.retrieveDiary({ ...options, fallback: 'none' }), /unavailable/);
    } finally {
        rag.vectorDBManager = original;
    }
});

test('LightMemo rejects retired modes and plus suffix in both search and A/B', async () => {
    const light = require('../Plugin/LightMemo/LightMemo');
    for (const mode of ['tagmemo', 'tagmemo_v9', 'v9']) {
        assert.throws(() => light._parseEngineMode(mode), /retired|退休/);
    }
    assert.equal(light._parseEngineMode(), 'rivermemo');
    assert.equal(light._parseEngineMode('knn'), 'knn');
    await assert.rejects(light.handleSearch({ query: 'test', folder: 'A', tag_boost: '0.6+' }), /退休/);
    await assert.rejects(light.handleMemoryAB({ query: 'test', folder: 'A', tag_boost: '0.6+ ' }), /退休/);
});

test('LightMemo accepts explicit all-library scope without maid or folder', async () => {
    const light = require('../Plugin/LightMemo/LightMemo');
    const owner = Object.create(light);
    let gathered = false;
    owner.getSingleEmbedding = async () => [1, 0];
    owner.vectorDBManager = {
        async executeLightMemoQuery(query, options) {
            gathered = true;
            assert.equal(options.scope.searchAll, true);
            return { results: [] };
        }
    };
    await owner.handleSearch({ query: 'test', search_all_knowledge_bases: 'true', enginemode: 'knn' });
    assert.equal(gathered, true);
    await assert.rejects(owner.handleSearch({
        query: 'test', search_all_knowledge_bases: 'false', enginemode: 'knn'
    }), /显式开启全库搜索/);
});

test('Memory A/B excludes fallback scores and isolates external scoring fields', async () => {
    const light = require('../Plugin/LightMemo/LightMemo');
    const owner = Object.create(light);
    owner.rerankConfig = { url: 'https://example.invalid/', apiKey: 'test', model: 'test' };
    owner.getSingleEmbedding = async () => [1, 0];
    owner.vectorDBManager = {
        async executeLightMemoQuery(query, options) {
            assert.equal(options.abMode, true);
            const baseline = { id: 1, label: 1, text: 'memory', vectorScore: 0.62 };
            return {
                comparisonPool: [baseline], tdbTopK: [baseline],
                river: { results: [{ ...baseline, score: 0.6773 }] }
            };
        }
    };
    owner._rerankDocuments = async () => [{
        id: 1, text: 'memory', score: 0.6773, rerank_score: 0.6773, rerank_failed: true
    }];
    let report = await owner.handleMemoryAB({ query: 'test', folder: 'A', k: 1 });
    assert.match(report, /不冒充回退评分/);
    assert.match(report, /\| 1 \| memory \| #1 \/ 0\.6200 \| — \| #1 \/ 0\.6773 \|/);

    owner._rerankDocuments = async () => [{
        id: 1, text: 'memory', score: 0.6773, rerank_score: 0.91, jev_score: 0.12
    }];
    report = await owner.handleMemoryAB({ query: 'test', folder: 'A', k: 1 });
    assert.match(report, /\| 1 \| memory \| #1 \/ 0\.6200 \| #1 \/ 0\.9100 \| #1 \/ 0\.6773 \|/);

    owner._rerankDocuments = async () => [{ id: 1, text: 'memory', score: 0.6773 }];
    report = await owner.handleMemoryAB({ query: 'test', folder: 'A', k: 1 });
    assert.match(report, /不冒充回退评分/);
    assert.match(report, /0\.6200 \| — \| #1 \/ 0\.6773 \|/);
});

test('LightMemo releases its observation on success and native failure', async () => {
    const prepared = { observationHandle: 'light-owned', artifact: { artifactSig: 'a' } };
    let released = 0;
    const owner = {
        config: { dimension: 2, modelSig: 'model', rootPath: '.' },
        async prepareUnifiedMemoObservation() { return prepared; },
        releaseMemoObservation(value) { assert.equal(value, prepared); released++; },
        riverMemoEngine: { _nativeConfig() { return {}; } },
        nativeKnowledgeRuntime: {
            async executeLightMemoQuery() {
                return { schema: 'vcp-lightmemo-result-v1', results: [] };
            }
        }
    };
    await kb.executeLightMemoQuery.call(owner, { vector: [1, 0] }, { engineMode: 'rivermemo' });
    assert.equal(released, 1);
    owner.nativeKnowledgeRuntime.executeLightMemoQuery = async () => { throw new Error('native failure'); };
    await assert.rejects(kb.executeLightMemoQuery.call(owner,
        { vector: [1, 0] }, { engineMode: 'rivermemo' }), /native failure/);
    assert.equal(released, 2);
});