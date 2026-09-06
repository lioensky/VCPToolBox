'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const RiverMemoEngine = require('../RiverMemoEngine');

function nativePayload(id, diagnostics = {}) {
    return JSON.stringify({
        schema: 'rivermemo-topology-v3-native-result-v1',
        algorithmVersion: 'rivermemo.topology-v3.1-rust',
        artifactSig: 'artifact-test',
        queryId: 'query-test',
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
            candidateSources: ['query_knn'],
            role: 'direct_answer',
            omega: 0.5,
            riverRegime: 'dense'
        }],
        diagnostics: {
            offeredCandidates: 1,
            projectedCandidates: 1,
            selectedCandidates: 1,
            rankedCandidates: 1,
            returnedCandidates: 1,
            totalMs: 1,
            ...diagnostics
        }
    });
}

function createFixture() {
    const calls = {
        joint: 0,
        legacy: 0
    };
    const rows = new Map([
        [101, {
            id: 101,
            text: 'joint final text',
            sourceFile: 'Joint/test.md',
            diaryName: 'Joint',
            fileId: 1
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
            return nativePayload(7);
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
        artifactSig: 'artifact-test',
        generation: 1,
        effectiveConfig: {}
    };
    const prepared = {
        queryState: {
            queryId: 'query-test',
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
        observationHandle: 'memoq-test',
        dbPath: 'fixture.sqlite',
        topK: 1,
        nativeJointQuery: true,
        nativePerIndexK: 10,
        nativeCandidateK: 10,
        nativeSemanticThreshold: 0.92
    };
}

test('joint River query hydrates only native final IDs and preserves public result shape', async () => {
    const fixture = createFixture();
    const nativeKnowledgeRuntime = {
        async executeRiverQuery() {
            fixture.calls.joint++;
            return nativePayload(101, {
                nativeQuery: {
                    ffiTrips: 1,
                    intermediateCandidatesCrossedNapi: false
                }
            });
        }
    };

    const result = await fixture.engine.rerank(
        {
            text: 'query',
            vector: new Float32Array([1, 0, 0, 0])
        },
        [{
            id: 999,
            chunkId: 999,
            text: 'caller candidate must be ignored',
            score: 1
        }],
        {
            diaryNames: ['Joint'],
            allowedFileIds: [1]
        },
        {
            ...baseOptions(fixture),
            nativeKnowledgeRuntime,
            nativeJointFallbackToLegacy: true
        }
    );

    assert.equal(fixture.calls.joint, 1);
    assert.equal(fixture.calls.legacy, 0);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].chunkId, 101);
    assert.equal(result.results[0].text, 'joint final text');
    assert.equal(result.diagnostics.nativeTopologyV3.jointUsed, true);
    assert.equal(
        result.diagnostics.nativeTopologyV3.runtimeOwnership,
        'native-knowledge-runtime-joint'
    );
});

test('joint River query failure falls back to existing native Topology candidate path', async () => {
    const fixture = createFixture();
    const nativeKnowledgeRuntime = {
        async executeRiverQuery() {
            fixture.calls.joint++;
            const error = new Error('injected joint failure');
            error.code = 'INJECTED_JOINT_FAILURE';
            throw error;
        }
    };

    const result = await fixture.engine.rerank(
        {
            text: 'query',
            vector: new Float32Array([1, 0, 0, 0])
        },
        [{
            id: 7,
            chunkId: 7,
            text: 'legacy candidate',
            score: 0.7
        }],
        {
            diaryNames: ['Joint'],
            allowedFileIds: [1]
        },
        {
            ...baseOptions(fixture),
            nativeKnowledgeRuntime,
            nativeJointFallbackToLegacy: true
        }
    );

    assert.equal(fixture.calls.joint, 1);
    assert.equal(fixture.calls.legacy, 1);
    assert.equal(result.results[0].chunkId, 7);
    assert.equal(result.results[0].text, 'legacy candidate');
    assert.equal(result.diagnostics.nativeTopologyV3.jointUsed, false);
    assert.equal(
        result.diagnostics.nativeTopologyV3.jointFallbackReason,
        'INJECTED_JOINT_FAILURE'
    );
});

test('strict joint River query surfaces native failure without legacy execution', async () => {
    const fixture = createFixture();
    const nativeKnowledgeRuntime = {
        async executeRiverQuery() {
            fixture.calls.joint++;
            throw new Error('strict joint failure');
        }
    };

    await assert.rejects(
        fixture.engine.rerank(
            {
                text: 'query',
                vector: new Float32Array([1, 0, 0, 0])
            },
            [{
                id: 7,
                chunkId: 7,
                text: 'legacy candidate',
                score: 0.7
            }],
            {
                diaryNames: ['Joint'],
                allowedFileIds: [1]
            },
            {
                ...baseOptions(fixture),
                nativeKnowledgeRuntime,
                nativeJointFallbackToLegacy: false
            }
        ),
        /strict joint failure/
    );
    assert.equal(fixture.calls.joint, 1);
    assert.equal(fixture.calls.legacy, 0);
});