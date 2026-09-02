'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const RiverMemoEngine = require('../RiverMemoEngine');

function nativePayload(id, candidateSources = ['time']) {
    return JSON.stringify({
        schema: 'rivermemo-topology-v3-native-result-v1',
        algorithmVersion: 'rivermemo.topology-v3.1-rust',
        artifactSig: 'artifact-hybrid-test',
        queryId: 'query-hybrid-test',
        omega: {
            omega: 0.5,
            regime: 'dense'
        },
        queryMode: 'propositional',
        results: [{
            id,
            chunkId: id,
            rank: 1,
            score: 0.8,
            originalScore: 0.7,
            baseScore: 0.75,
            topologyBonus: 0.03,
            anchorBonus: 0.02,
            matchedTags: [],
            coreTagsMatched: [],
            candidateSources,
            role: 'direct_answer',
            omega: 0.5,
            riverRegime: 'dense'
        }],
        diagnostics: {
            offeredCandidates: 12,
            projectedCandidates: 12,
            selectedCandidates: 8,
            rankedCandidates: 8,
            returnedCandidates: 1,
            totalMs: 1,
            nativeQuery: {
                schema: 'vcp-native-river-query-v2',
                ann: {
                    queryVectorCount: 2,
                    supplementalVectorCount: 1,
                    fileCandidateCount: 2,
                    timeChunkCandidates: 1,
                    bm25ChunkCandidates: 1
                },
                ffiTrips: 1,
                intermediateCandidatesCrossedNapi: false
            }
        }
    });
}

function createFixture() {
    const calls = {
        hybrid: 0,
        legacy: 0,
        hybridArgs: null
    };
    const rows = new Map([
        [101, {
            id: 101,
            text: 'time final text',
            sourceFile: 'Diary/time.md',
            diaryName: 'Diary',
            fileId: 1
        }],
        [102, {
            id: 102,
            text: 'bm25 final text',
            sourceFile: 'Diary/bm25.md',
            diaryName: 'Diary',
            fileId: 2
        }]
    ]);
    const db = {
        name: 'fixture.sqlite',
        prepare() {
            return {
                all(...ids) {
                    return ids.map(id => rows.get(Number(id))).filter(Boolean);
                }
            };
        }
    };
    const tagIndex = {
        async rerankRivermemoTopologyV3() {
            calls.legacy++;
            return nativePayload(102, ['query_knn']);
        },
        memoRuntimeStats() {
            return {
                resident: true,
                generation: 1
            };
        }
    };
    const runtime = {
        db,
        tagIndex,
        config: {
            dimension: 4
        },
        getDerivedAssetDiagnostics() {
            return null;
        }
    };
    const engine = new RiverMemoEngine(runtime);
    const artifact = {
        artifactSig: 'artifact-hybrid-test',
        generation: 1,
        effectiveConfig: {}
    };
    const prepared = {
        queryState: {
            queryId: 'query-hybrid-test',
            queryRiverGraph: {
                nodes: [],
                edges: []
            },
            sourceObservation: {
                matchedTags: [],
                coreTagsMatched: [],
                sourceMode: 'test',
                diagnostics: {
                    completeObservation: true
                }
            },
            sourceField: [],
            localField: [],
            transferField: [],
            localDomain: {
                ids: []
            },
            transferDomain: {
                ids: []
            },
            fieldDiagnostics: {}
        },
        denoisedVector: new Float32Array(4),
        localVector: new Float32Array(4),
        transferVector: new Float32Array(4),
        fieldProjectionDiagnostics: {},
        preparationTimings: {}
    };
    return {
        calls,
        engine,
        artifact,
        prepared
    };
}

function baseOptions(fixture) {
    return {
        artifact: fixture.artifact,
        nativePreparedQuery: fixture.prepared,
        observationHandle: 'memoq-hybrid-test',
        dbPath: 'fixture.sqlite',
        topK: 4,
        nativeJointQuery: true,
        nativePerIndexK: 20,
        nativeCandidateK: 50,
        nativeSemanticThreshold: 0.92,
        nativeHybridPlan: {
            schema: 'vcp-native-hybrid-query-plan-v2',
            supplemental: {
                weights: [0.75],
                perIndexK: 25
            },
            fileCandidates: [{
                path: 'Diary/time.md',
                timeScore: 1,
                source: 'time'
            }, {
                path: 'Diary/bm25.md',
                bm25Score: 3,
                normalizedBM25Score: 1,
                source: 'bm25_body'
            }],
            bm25Weight: 0.6,
            bm25Mode: 'body',
            timePerDiaryLimit: 10,
            timeGlobalLimit: 50
        },
        nativeSupplementalVectors: new Float32Array([0, 1, 0, 0])
    };
}

function query() {
    return {
        text: 'query',
        vector: new Float32Array([1, 0, 0, 0])
    };
}

function sentinel() {
    return [{
        id: 999,
        chunkId: 999,
        text: 'sentinel',
        score: 0
    }];
}

function agentContext() {
    return {
        diaryNames: ['Diary'],
        allowedFileIds: [1, 2]
    };
}

test('hybrid River ABI receives flattened vectors and structured plan', async () => {
    const fixture = createFixture();
    const nativeKnowledgeRuntime = {
        async executeRiverQueryHybrid(...args) {
            fixture.calls.hybrid++;
            fixture.calls.hybridArgs = args;
            return nativePayload(101, ['time', 'query_knn']);
        }
    };

    const result = await fixture.engine.rerank(
        query(),
        sentinel(),
        agentContext(),
        {
            ...baseOptions(fixture),
            nativeKnowledgeRuntime,
            nativeJointFallbackToLegacy: true
        }
    );

    assert.equal(fixture.calls.hybrid, 1);
    assert.equal(fixture.calls.legacy, 0);
    assert.equal(fixture.calls.hybridArgs.length, 10);
    assert(fixture.calls.hybridArgs[5] instanceof Float32Array);
    assert.deepEqual(Array.from(fixture.calls.hybridArgs[5]), [0, 1, 0, 0]);

    const plan = JSON.parse(fixture.calls.hybridArgs[6]);
    assert.equal(plan.schema, 'vcp-native-hybrid-query-plan-v2');
    assert.equal(plan.timePerDiaryLimit, 10);
    assert.equal(plan.timeGlobalLimit, 50);
    assert.equal(plan.fileCandidates.length, 2);

    assert.equal(result.results[0].chunkId, 101);
    assert.equal(result.results[0].source, 'time');
    assert.equal(result.results[0].text, 'time final text');
    assert.equal(result.diagnostics.nativeTopologyV3.hybridPlanUsed, true);
});

test('BM25 native source remains distinguishable from Time output', async () => {
    const fixture = createFixture();
    const nativeKnowledgeRuntime = {
        async executeRiverQueryHybrid() {
            fixture.calls.hybrid++;
            return nativePayload(102, ['bm25', 'query_knn']);
        }
    };

    const result = await fixture.engine.rerank(
        query(),
        sentinel(),
        agentContext(),
        {
            ...baseOptions(fixture),
            nativeKnowledgeRuntime,
            nativeJointFallbackToLegacy: true
        }
    );

    assert.equal(result.results[0].chunkId, 102);
    assert.equal(result.results[0].source, 'bm25_body');
    assert.equal(result.results[0].text, 'bm25 final text');
});

test('hybrid ABI failure falls back to existing native Topology path', async () => {
    const fixture = createFixture();
    const nativeKnowledgeRuntime = {
        async executeRiverQueryHybrid() {
            fixture.calls.hybrid++;
            const error = new Error('injected hybrid failure');
            error.code = 'INJECTED_HYBRID_FAILURE';
            throw error;
        }
    };

    const result = await fixture.engine.rerank(
        query(),
        [{
            id: 102,
            chunkId: 102,
            text: 'legacy candidate',
            score: 0.7,
            bm25Score: 2,
            timeScore: 0
        }],
        agentContext(),
        {
            ...baseOptions(fixture),
            nativeKnowledgeRuntime,
            nativeJointFallbackToLegacy: true
        }
    );

    assert.equal(fixture.calls.hybrid, 1);
    assert.equal(fixture.calls.legacy, 1);
    assert.equal(result.results[0].chunkId, 102);
    assert.equal(
        result.diagnostics.nativeTopologyV3.jointFallbackReason,
        'INJECTED_HYBRID_FAILURE'
    );
});