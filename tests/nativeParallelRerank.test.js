'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kb = require('../KnowledgeBaseManager');
const rag = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
const ResultDeduplicator = require('../ResultDeduplicator');

test('parallel proxy sends a plan, not a prepared Sense or candidate bodies', async () => {
    const owner = Object.create(kb);
    const vector = new Float32Array([1, 0]);
    let received;
    owner._getOrLoadDiaryIndex = async () => {};
    owner.prepareUnifiedMemoObservation = async (query, options) => {
        assert.equal(options.nativePlanOnly, true);
        return {
            artifact: { artifactSig: 'fixture' },
            pipeline: { config: { baseTagBoost: 0.2 } },
            queryVector: query.vector, ghostVectors: new Float32Array()
        };
    };
    owner.riverMemoEngine = { _nativeConfig: () => ({ queryK: 20 }) };
    owner.nativeKnowledgeRuntime = {
        async executeParallelRerank(plan, query, ghosts) {
            received = JSON.parse(plan);
            assert.equal(query, vector);
            assert(ghosts instanceof Float32Array);
            return JSON.stringify({ results: [{ chunkId: 1, text: 'final', rrf_score: 0.01 }] });
        }
    };
    const result = await owner.executeParallelRerank({ text: 'query', vector }, {
        diaryNames: ['Diary', 'Diary'], topK: 3, externalK: 6, alpha: 0.7,
        useJev: true, jevPrompt: 'numbered prompt',
        supplementalQueryVectors: [{ vector: [0, 1], weight: 0.8 }]
    });
    assert.deepEqual(received.diaryNames, ['Diary']);
    assert.equal(received.alpha, 0.7);
    assert.equal(received.useJev, true);
    assert.equal(received.jevPrompt, 'numbered prompt');
    assert.equal(received.candidates, undefined);
    assert.equal(received.observationHandle, undefined);
    assert.equal(received.supplementalQueries[0].weight, 0.8);
    assert.equal(result.results[0].text, 'final');
});

test('native Rerank+ bypasses JS HTTP and preserves fusion ordering', async () => {
    const host = Object.create(rag);
    host.queryCacheEnabled = false;
    host.ragParams = {};
    host.rerankConfig = { multiplier: 2, useJev: true };
    host.pushVcpInfo = null;
    host.vectorDBManager = {
        config: { nativeRiverQueryEnabled: true },
        nativeKnowledgeRuntime: { executeParallelRerank() {} },
        async executeNativeRiverQuery() { throw new Error('serial path used'); },
        async executeParallelRerank(query, options) {
            assert.equal(options.useJev, true);
            return {
                results: [
                    { chunkId: 2, text: 'second', score: 0.4, rrf_score: 0.02 },
                    { chunkId: 1, text: 'first', score: 0.9, rrf_score: 0.01 }
                ],
                diagnostics: { nativeRerank: { parallel: true } }
            };
        },
        async deduplicateResults(results) { return results; }
    };
    host._rerankDocuments = async () => { throw new Error('JS HTTP used'); };
    const result = await host._processRAGPlaceholder({
        dbName: 'Diary', modifiers: '::Rerank+', queryVector: [1, 0],
        userContent: 'query', dynamicK: 2, timeRanges: [], returnRawResults: true
    });
    assert.deepEqual(result.map(item => item.chunkId), [2, 1]);
});

test('shotgun history switch changes cache identity', () => {
    const host = Object.create(rag);
    host.shotgunHistoryEnabled = true;
    const enabled = host._generateCacheKey({ dbName: 'Diary' });
    host.shotgunHistoryEnabled = false;
    assert.notEqual(host._generateCacheKey({ dbName: 'Diary' }), enabled);
});

test('final dedup respects RRF rather than external score', async () => {
    const dedup = new ResultDeduplicator(null, { dimension: 2 });
    const results = await dedup.deduplicate([
        { chunkId: 2, text: 'b', source: 'rag', rrf_score: 0.02, rerank_score: 0.2 },
        { chunkId: 1, text: 'a', source: 'rag', rrf_score: 0.01, rerank_score: 0.9 }
    ]);
    assert.deepEqual(results.map(item => item.chunkId), [2, 1]);
});