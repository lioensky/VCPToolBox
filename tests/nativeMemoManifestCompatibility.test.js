'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    VexusIndex,
    NativeKnowledgeRuntime
} = require('../rust-vexus-lite');
const {
    stableSerialize
} = require('../modules/tagmemoV10/immutable');

function vectorBuffer(values) {
    return Buffer.from(new Float32Array(values).buffer);
}

function sha256(value, length) {
    return crypto.createHash('sha256')
        .update(value)
        .digest('hex')
        .slice(0, length);
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-native-memo-manifest-'));
    const dbPath = path.join(root, 'knowledge_base.sqlite');
    const index = new VexusIndex(4, 16);
    const nativeKnowledgeRuntime = new NativeKnowledgeRuntime(index);
    nativeKnowledgeRuntime.openAndInitStore(dbPath);

    try {
        await nativeKnowledgeRuntime.commitIngestionBatch(dbPath, JSON.stringify({
            operationId: 'manifest-fixture', batchId: 'manifest-fixture',
            dimension: 4, modelSig: 'manifest-test-model',
            files: [{ path: 'memo.txt', diaryName: 'test', checksum: 'checksum',
                mtime: 1, size: 10, expectedVersion: 0,
                chunkStart: 0, chunkCount: 2, tagStart: 0, tagCount: 3 }],
            chunks: [
                { content: 'first shared-file candidate', chunkIndex: 0, vectorSlot: 0 },
                { content: 'second shared-file candidate', chunkIndex: 1, vectorSlot: 1 }
            ],
            tags: [1, 2, 3].map((id, slot) => ({ name: 'tag-' + id, position: id, vectorSlot: slot }))
        }), new Float32Array([1,0,0,0, 0.8,0.2,0,0]),
        new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0]));

        const effectiveConfig = {
            zeta: {
                second: 2,
                first: 1
            },
            orderedCooccurrence: {
                semanticGainSigma: 0.25,
                forwardGain: 1,
                reverseGain: 0.35,
                semanticGainEnabled: true
            },
            alpha: {
                nested: {
                    z: false,
                    a: true
                },
                list: [3, 2, 1]
            },
            v9: {
                wormholeGain: 1.35,
                outboundMass: 0.95
            }
        };
        const ordinaryJson = JSON.stringify(effectiveConfig);
        const canonicalJson = stableSerialize(effectiveConfig);
        assert.notStrictEqual(
            ordinaryJson,
            canonicalJson,
            'fixture must exercise an insertion-order difference'
        );

        const diaryIndex = new VexusIndex(4, 16);
        diaryIndex.addBatch(
            [1, 2],
            new Float32Array([
                1, 0, 0, 0,
                0.8, 0.2, 0, 0
            ])
        );
        nativeKnowledgeRuntime.registerDiaryIndex('test', diaryIndex);

        await index.computeMemoGeometry(dbPath, 'manifest-test-model', '{}');
        const result = await index.rebuildMemoArtifact(
            dbPath,
            JSON.stringify({
                modelSig: 'manifest-test-model',
                effectiveConfig
            })
        );
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.persisted, true);

        const pipelineResult = await index.runMemoPipeline(
            dbPath,
            result.artifactSig,
            JSON.stringify({
                queryId: 'typed-array-regression',
                queryText: 'typed array regression',
                coreTags: [],
                ghostTags: [],
                config: {
                    maxLevels: 1,
                    pyramidTopK: 3,
                    maxEmergentNodes: 8,
                    spikeRouting: {
                        maxSafeHops: 2,
                        maxPropagationStates: 100,
                        maxOutputNodes: 0,
                        maxOutputEdges: 0
                    }
                }
            }),
            new Float32Array([1, 0, 0, 0]),
            new Float32Array(0)
        );
        assert(
            pipelineResult.enhancedVector instanceof Float32Array,
            'Memo pipeline must return its high-dimensional result as Float32Array'
        );
        assert.strictEqual(pipelineResult.enhancedVector.length, 4);
        const pipelineMetadata = JSON.parse(pipelineResult.metadataJson);
        assert.strictEqual(pipelineMetadata.artifactSig, result.artifactSig);
        assert.strictEqual(
            typeof pipelineMetadata.observationHandle,
            'string',
            'Memo pipeline must return a reusable native observation handle'
        );
        for (const retiredField of [
            'observation',
            'localVector',
            'transferVector',
            'localField',
            'transferField',
            'localDomainIds',
            'transferDomainIds',
            'enhancedVector'
        ]) {
            assert.strictEqual(
                Object.hasOwn(pipelineMetadata, retiredField),
                false,
                `lightweight pipeline metadata must not expose ${retiredField}`
            );
        }

        const topologyPayload = await index.rerankRivermemoTopologyV3(
            dbPath,
            result.artifactSig,
            JSON.stringify({
                observationHandle: pipelineMetadata.observationHandle,
                dimension: 4,
                topK: 2,
                includeTrace: false,
                query: {
                    text: 'typed array regression',
                    vector: []
                },
                candidates: [
                    { id: 1, score: 0.9 },
                    { id: 2, score: 0.8 }
                ],
                queryState: {
                    queryId: 'typed-array-regression'
                },
                allowedFileIds: [1],
                config: {
                    queryK: 2,
                    denoisedK: 2,
                    localFieldK: 2,
                    transferFieldK: 2,
                    maxUnionCandidates: 2
                }
            })
        );
        const topology = JSON.parse(topologyPayload);
        assert.strictEqual(
            topology.schema,
            'rivermemo-topology-v3-native-result-v1'
        );
        assert.strictEqual(topology.diagnostics.offeredCandidates, 2);
        assert.strictEqual(topology.diagnostics.projectedCandidates, 2);
        assert.strictEqual(topology.diagnostics.returnedCandidates, 2);
        assert.deepStrictEqual(
            new Set(topology.results.map(item => Number(item.chunkId))),
            new Set([1, 2])
        );
        assert.strictEqual(
            topology.diagnostics.chunkSqlBatches,
            1,
            'two Chunk candidates must be loaded by one batched SQL query'
        );
        assert.strictEqual(
            topology.diagnostics.fileTagSqlBatches,
            1,
            'shared-file Tag curve must be loaded once'
        );
        assert.strictEqual(
            topology.diagnostics.queryTagSqlBatches,
            1,
            'River and Anchor Tag vectors must share one batched SQL query'
        );

        const jointPayload = await nativeKnowledgeRuntime.executeRiverQuery(
            dbPath,
            result.artifactSig,
            JSON.stringify({
                observationHandle: pipelineMetadata.observationHandle,
                dimension: 4,
                topK: 2,
                includeTrace: false,
                query: {
                    text: 'typed array regression',
                    vector: []
                },
                // 联合 ABI 必须忽略调用方候选，防止中间候选重新跨越 N-API。
                candidates: [{ id: 999999, score: 1 }],
                queryState: {
                    queryId: 'typed-array-regression'
                },
                allowedFileIds: [1],
                config: {
                    queryK: 2,
                    denoisedK: 2,
                    localFieldK: 2,
                    transferFieldK: 2,
                    maxUnionCandidates: 2
                }
            }),
            ['test'],
            new Float32Array([1, 0, 0, 0]),
            2,
            2,
            0.9999
        );
        const joint = JSON.parse(jointPayload);
        assert.strictEqual(
            joint.schema,
            'rivermemo-topology-v3-native-result-v1'
        );
        assert.deepStrictEqual(
            joint.results.map(item => Number(item.chunkId)),
            topology.results.map(item => Number(item.chunkId)),
            'joint native query and legacy native Topology must return the same Top-K'
        );
        assert.strictEqual(
            joint.diagnostics.nativeQuery.ffiTrips,
            1
        );
        assert.strictEqual(
            joint.diagnostics.nativeQuery.intermediateCandidatesCrossedNapi,
            false
        );
        assert.strictEqual(
            joint.diagnostics.nativeQuery.ann.semanticEnabled,
            true
        );
        assert.strictEqual(
            joint.diagnostics.nativeQuery.ann.semanticSqlBatches,
            1
        );
        assert.strictEqual(
            joint.diagnostics.offeredCandidates,
            2,
            'caller-provided fake candidates must be replaced by native ANN results'
        );

        assert.strictEqual(JSON.parse(nativeKnowledgeRuntime.lightMemoIndexStats()).resident, false);
        const lightPlan = {
            scope: { folders: ['test'] }, modelSig: 'manifest-test-model',
            engineMode: 'rivermemo', k: 2, candidateK: 16, abMode: true,
            artifactSig: result.artifactSig,
            riverInput: {
                observationHandle: pipelineMetadata.observationHandle,
                query: { text: 'shared-file candidate' },
                queryState: { queryId: 'typed-array-regression' },
                config: { queryK: 16, denoisedK: 16, localFieldK: 16,
                    transferFieldK: 16, maxUnionCandidates: 16 }
            }
        };
        const lightQuery = async (plan = lightPlan) => JSON.parse(
            await nativeKnowledgeRuntime.executeLightMemoQuery(
                JSON.stringify(plan), new Float32Array([1, 0, 0, 0])));
        const lightResults = await Promise.all(Array.from({ length: 4 }, () => lightQuery()));
        for (const light of lightResults) {
            assert.strictEqual(light.schema, 'vcp-lightmemo-result-v1');
            assert.strictEqual(light.comparisonPool.length, 2);
            assert.strictEqual(light.river.diagnostics.offeredCandidates, 2);
            assert.deepStrictEqual(light.tdbTopK.map(item => item.id), [1, 2]);
            assert(light.results.every(item => typeof item.text === 'string'));
            assert(light.comparisonPool.every(item => !Object.hasOwn(item, 'vector')));
        }
        assert.strictEqual(JSON.parse(nativeKnowledgeRuntime.lightMemoIndexStats()).resident, true);
        assert.strictEqual(nativeKnowledgeRuntime.evictIdleLightMemoIndex(600000), false);
        await new Promise(resolve => setTimeout(resolve, 15));
        assert.strictEqual(nativeKnowledgeRuntime.evictIdleLightMemoIndex(1), true);
        assert.strictEqual(JSON.parse(nativeKnowledgeRuntime.lightMemoIndexStats()).resident, false);
        const lightReloaded = await lightQuery();
        assert.deepStrictEqual(lightReloaded.tdbTopK, lightResults[0].tdbTopK);
        assert.strictEqual(lightReloaded.diagnostics.synchronizedRows, 2,
            'without an explicitly published baseline, reload rebuilds memory from SQL');
        assert(!fs.readdirSync(root).some(name => name.includes('.vec')),
            'queries and eviction must not implicitly create vector snapshots');
        const deniedCheckpoint = JSON.parse(await nativeKnowledgeRuntime.checkpointGlobalChunkIndex(
            'manifest-test-model', 0.05, false));
        assert.strictEqual(deniedCheckpoint.published, false);
        const publishedCheckpoint = JSON.parse(await nativeKnowledgeRuntime.checkpointGlobalChunkIndex(
            'manifest-test-model', 0.05, true));
        assert.strictEqual(publishedCheckpoint.published, true);
        const snapshotPath = path.join(root, 'index_global_chunks_a.vec');
        const snapshotBytes = fs.readFileSync(snapshotPath);
        const snapshotMtime = fs.statSync(snapshotPath).mtimeMs;
        await new Promise(resolve => setTimeout(resolve, 15));
        assert.strictEqual(nativeKnowledgeRuntime.evictIdleLightMemoIndex(1), true);
        const endorsedReload = await lightQuery();
        assert.deepStrictEqual(endorsedReload.tdbTopK, lightResults[0].tdbTopK);
        assert.strictEqual(endorsedReload.diagnostics.synchronizedRows, 0);
        assert.deepStrictEqual(fs.readFileSync(snapshotPath), snapshotBytes);
        assert.strictEqual(fs.statSync(snapshotPath).mtimeMs, snapshotMtime);
        assert.strictEqual(JSON.parse(await nativeKnowledgeRuntime.checkpointGlobalChunkIndex(
            'manifest-test-model', 0.05, true)).published, false);
        const noSignature = await lightQuery({
            ...lightPlan, engineMode: 'knn', abMode: false,
            scope: { maid: 'test' }
        });
        assert.strictEqual(noSignature.results.length, 0,
            'diary-name match does not bypass first-line signature filtering');

        // 并发冷加载回归：清空常驻 Arc 后，多条 Memo Pipeline 会同时从
        // SQLite 解码同一个 Artifact。后到的同签名发布不得清空先到查询
        // 已写入的 observationHandle。
        index.clearMemoRuntime();
        const concurrentPipelines = await Promise.all(
            Array.from({ length: 8 }, (_, queryIndex) =>
                index.runMemoPipeline(
                    dbPath,
                    result.artifactSig,
                    JSON.stringify({
                        queryId: `concurrent-cold-${queryIndex}`,
                        queryText: `concurrent cold query ${queryIndex}`,
                        coreTags: [],
                        ghostTags: [],
                        config: {
                            maxLevels: 1,
                            pyramidTopK: 3,
                            maxEmergentNodes: 8,
                            spikeRouting: {
                                maxSafeHops: 2,
                                maxPropagationStates: 100,
                                maxOutputNodes: 0,
                                maxOutputEdges: 0
                            }
                        }
                    }),
                    new Float32Array([1, 0, 0, 0]),
                    new Float32Array(0)
                )
            )
        );
        const concurrentHandles = concurrentPipelines.map(pipeline =>
            JSON.parse(pipeline.metadataJson).observationHandle
        );
        assert.strictEqual(new Set(concurrentHandles).size, 8);

        const concurrentJointResults = await Promise.all(
            concurrentHandles.map((observationHandle, queryIndex) =>
                nativeKnowledgeRuntime.executeRiverQuery(
                    dbPath,
                    result.artifactSig,
                    JSON.stringify({
                        observationHandle,
                        dimension: 4,
                        topK: 2,
                        includeTrace: false,
                        query: {
                            text: `concurrent cold query ${queryIndex}`,
                            vector: []
                        },
                        queryState: {
                            queryId: `concurrent-cold-${queryIndex}`
                        },
                        allowedFileIds: [1],
                        config: {
                            queryK: 2,
                            denoisedK: 2,
                            localFieldK: 2,
                            transferFieldK: 2,
                            maxUnionCandidates: 2
                        }
                    }),
                    ['test'],
                    new Float32Array([1, 0, 0, 0]),
                    2,
                    2,
                    0.9999
                )
            )
        );
        assert.strictEqual(concurrentJointResults.length, 8);
        for (const payload of concurrentJointResults) {
            const concurrentResult = JSON.parse(payload);
            assert.strictEqual(
                concurrentResult.schema,
                'rivermemo-topology-v3-native-result-v1'
            );
            assert.strictEqual(
                concurrentResult.diagnostics.nativeQuery
                    .intermediateCandidatesCrossedNapi,
                false
            );
        }

        const row = JSON.parse(await nativeKnowledgeRuntime.getNativeMemoManifest(
            dbPath, 'manifest-test-model', sha256(canonicalJson, 32)
        ));
        assert(row, 'native artifact manifest must be persisted');
        assert.strictEqual(row.artifactSig, result.artifactSig);
        assert.strictEqual(row.configHash, sha256(canonicalJson, 32));
        assert.notStrictEqual(row.configHash, sha256(ordinaryJson, 32));
        assert.strictEqual(row.databaseGeneration, String(nativeKnowledgeRuntime.databaseGeneration()));
        assert(joint.results.every(item => typeof item.hydratedChunk?.text === 'string'));

        const factGeneration = nativeKnowledgeRuntime.databaseGeneration();
        await index.computeMemoGeometry(dbPath, 'manifest-test-model', JSON.stringify({ forceRecompute: true }));
        assert.strictEqual(nativeKnowledgeRuntime.databaseGeneration(), factGeneration);
        assert.strictEqual(JSON.parse(await nativeKnowledgeRuntime.getNativeMemoManifest(
            dbPath, 'manifest-test-model', sha256(canonicalJson, 32)
        )).artifactSig, result.artifactSig, 'geometry staging must retain the published graph');
        await index.runMemoPipeline(
            dbPath, result.artifactSig,
            JSON.stringify({ queryText: 'stale', config: { maxLevels: 1 } }),
            new Float32Array([1, 0, 0, 0]), new Float32Array()
        );

        nativeKnowledgeRuntime.openAndInitStore(path.join(root, 'other.sqlite'));
        assert.strictEqual(JSON.parse(nativeKnowledgeRuntime.lightMemoIndexStats()).resident, false,
            'store replacement must discard the previous database table');
        const other = await lightQuery({
            ...lightPlan, engineMode: 'knn', abMode: false,
            scope: { searchAll: true }
        });
        assert.strictEqual(other.results.length, 0);
        nativeKnowledgeRuntime.shutdown();
        assert.strictEqual(JSON.parse(nativeKnowledgeRuntime.lightMemoIndexStats()).resident, false);
        console.log(
            '[NativeMemoManifestTest] PASS: canonical manifest, TypedArray/handle Memo ABI, ' +
            'batched RiverMemo SQL, one-call joint retrieval and concurrent cold handles are compatible.'
        );
    } finally {
        nativeKnowledgeRuntime.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error('[NativeMemoManifestTest] FAIL:', error);
    process.exitCode = 1;
});