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
        const coldStart = JSON.parse(await nativeKnowledgeRuntime.restoreGlobalTagIndex(
            dbPath, path.join(root, 'tags_a.vec'), 'manifest-test-model', 16, true));
        assert.strictEqual(coldStart.restored, true);
        assert.strictEqual(index.stats().hotBytes, 0);
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
        new Float32Array([1,0,0,0, 0.8,0.2,0,0, 0.7,0,0.3,0]));

        assert.strictEqual(index.stats().totalVectors, 3);
        assert.strictEqual(index.stats().hotBytes, 0,
            'production ingestion must not wake legacy Tag routing');
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
        // Production joint queries must not require a registered old diary TDB index.

        await index.computeMemoGeometry(dbPath, 'manifest-test-model',
            JSON.stringify({ local: { minNeighbors: 1 } }));
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
        assert(index.stats().hotBytes > 0,
            'explicit cosine pipeline restores compatibility routing on demand');
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
                modelSig: 'manifest-test-model',
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
            0,
            'River and Anchor Tag vectors reuse the request pool without SQL'
        );

        assert.strictEqual(topology.diagnostics.candidateTagVectorSqlBatches, 0,
            'candidate Tags already loaded by Pyramid must not fetch vector BLOBs again');
        assert.strictEqual(topology.diagnostics.candidateTagVectorFetchedNodes, 0);
        assert.strictEqual(pipelineMetadata.diagnostics.dualField.sqlFetchedNodes, 0);
        const fieldGrowth = pipelineMetadata.diagnostics.dualField.growth;
        assert.strictEqual(fieldGrowth.budget, 256);
        assert(fieldGrowth.unionNodes <= 256, 'both fields share one union hard cap');
        assert.strictEqual(fieldGrowth.unionNodes,
            pipelineMetadata.diagnostics.dualField.selectedProjectionNodes);
        assert.strictEqual(fieldGrowth.coreNodes,
            pipelineMetadata.diagnostics.sensing.reachedNodes);
        assert(fieldGrowth.settledStates <= 8192);
        assert(fieldGrowth.scannedEdges <= 65536);
        assert(fieldGrowth.lanes.length > 0, 'seed basins must reach the production pipeline');
        for (const lane of fieldGrowth.lanes) {
            assert(lane.innerNodes > 0);
            assert(lane.reservedNodes <= 8);
            assert(lane.reservedNodes <= lane.outerNodes);
            assert(Number.isFinite(lane.radius));
        }
        assert(Number.isFinite(pipelineMetadata.diagnostics.dualFieldSolveMs));
        assert(Number.isFinite(pipelineMetadata.diagnostics.dualFieldProjectMs));

        const jointPayload = await nativeKnowledgeRuntime.executeRiverQuery(
            dbPath,
            result.artifactSig,
            JSON.stringify({
                modelSig: 'manifest-test-model',
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

        assert.strictEqual(JSON.parse(nativeKnowledgeRuntime.lightMemoIndexStats()).legacyResident, false);
        const lightPlan = {
            scope: { folders: ['test'] }, modelSig: 'manifest-test-model',
            engineMode: 'rivermemo', k: 2, candidateK: 16, abMode: true,
            artifactSig: result.artifactSig,
            riverInput: {
                modelSig: 'manifest-test-model',
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
        const warpedPipeline = await index.runMemoPipeline(
            dbPath, result.artifactSig,
            JSON.stringify({ queryText: 'shared-file candidate', config: {
                maxLevels: 1, pyramidTopK: 3, tagRoutingMode: 'warped_ags',
                warpedPreset: 'locked_2', warpedRadiusStrategy: 'epa_guided'
            } }), new Float32Array([1,0,0,0]), new Float32Array()
        );
        const warpedMetadata = JSON.parse(warpedPipeline.metadataJson);
        assert.strictEqual(warpedMetadata.diagnostics.tagRouting.used, 'warped_ags',
            'the successful fixture must exercise a real warped Tag observation');
        assert.strictEqual(warpedMetadata.diagnostics.tagRouting.fallback, false);
        assert.strictEqual(index.stats().hotBytes, 0,
            'warped production pipeline releases legacy routing without clearing MemoRuntime');
        assert.strictEqual(index.memoRuntimeStats().resident, true);
        assert(JSON.parse(index.memoObservationMemoryStats()).entries >= 2,
            'reclaiming routing must preserve both independent query observations');
        const forcedTag = JSON.parse(await index.warmupWarpedTagField(
            dbPath, result.artifactSig, 'locked_2', true));
        assert.strictEqual(forcedTag.forced, true);
        assert.strictEqual(forcedTag.source, 'built');
        assert(forcedTag.nodes > 0);
        const warpedPlan = { ...lightPlan, warpedAb: true,
            warpedRiverInput: {
                ...lightPlan.riverInput,
                observationHandle: warpedMetadata.observationHandle,
                tagRouting: warpedMetadata.diagnostics.tagRouting
            }
        };
        await new Promise(resolve => setTimeout(resolve, 15));
        assert.strictEqual(nativeKnowledgeRuntime.evictIdleLightMemoIndex(1), true);
        const productionPlan = { ...warpedPlan, abMode: false };
        const production = await lightQuery(productionPlan);
        assert.strictEqual(production.diagnostics.legacyResident, false);
        assert.strictEqual(production.diagnostics.retrievalEngine, 'rivermemo_v5');
        assert.strictEqual(production.river.pipelineVersion, 'rivermemo-v5-warped');
        assert.strictEqual(production.tdbTopK.length, 0);
        assert.strictEqual(production.results.length, 2);
        assert(production.results.every(item => item.retrievalEngine === 'rivermemo_v5'));
        assert.strictEqual(JSON.parse(nativeKnowledgeRuntime.lightMemoIndexStats()).legacyResident, false);
        const partitionBefore = JSON.parse(nativeKnowledgeRuntime.lightMemoIndexStats());
        assert.strictEqual(partitionBefore.partitions.hotPartitions, 1);
        assert(partitionBefore.partitions.firstLineBytes > 0);
        const emptyPartition = await lightQuery({
            modelSig: 'manifest-test-model', engineMode: 'knn', abMode: false,
            k: 2, candidateK: 16, scope: { exactDiaryNames: ['missing-diary'] }
        });
        assert.strictEqual(emptyPartition.results.length, 0);
        const partitionCold = JSON.parse(nativeKnowledgeRuntime.lightMemoIndexStats());
        assert.strictEqual(partitionCold.partitions.hotPartitions, 0);
        assert.strictEqual(partitionCold.partitions.firstLineBytes, 0);
        assert.strictEqual(partitionCold.warpedChunks.resident, true);
        const partitionReload = await lightQuery(productionPlan);
        assert.deepStrictEqual(partitionReload.results, production.results);
        assert.strictEqual(partitionReload.diagnostics.warpedChunks.source, 'memory');
        assert.strictEqual(partitionReload.diagnostics.warpedChunks.geometryFacts,
            production.diagnostics.warpedChunks.geometryFacts);
        const productionFallback = await lightQuery({ ...productionPlan,
            warpedRiverInput: { ...productionPlan.warpedRiverInput,
                tagRouting: { used: 'cosine', fallback: true } } });
        assert.strictEqual(productionFallback.diagnostics.degraded, true);
        assert.strictEqual(productionFallback.diagnostics.retrievalEngine, 'warped_ann');
        assert(productionFallback.results.every(item => item.retrievalEngine === 'warped_chunks'));
        const permissionEmpty = await lightQuery({ ...productionPlan, engineMode: 'knn',
            scope: { exactDiaryNames: ['test'], allowedFileIds: [] } });
        assert.strictEqual(permissionEmpty.results.length, 0);
        const warpedResult = await lightQuery(warpedPlan);
        assert.strictEqual(warpedResult.diagnostics.legacyResident, true);
        const productionAgain = await lightQuery(productionPlan);
        assert.strictEqual(productionAgain.diagnostics.legacyResident, false);
        assert.deepStrictEqual(warpedResult.tdbTopK, lightResults[0].tdbTopK,
            'enabling warped experiments must not alter the TDB baseline');
        assert.strictEqual(warpedResult.warpedTopK.length, 2);
        assert(warpedResult.warpedTopK.every(item => Number.isFinite(item.warpedDistance)));
        assert(warpedResult.warpedTopK.every(item => item.warpedScore === -item.warpedDistance));
        assert.strictEqual(warpedResult.diagnostics.warpedChunks.used, 'warped_chunks');
        assert.strictEqual(warpedResult.diagnostics.warpedChunks.fallback, false);
        assert.strictEqual(warpedResult.recallPools.overlap, 2);
        assert.strictEqual(warpedResult.comparisonPool.length, 2, 'union must deduplicate IDs');
        if (warpedMetadata.diagnostics.tagRouting.used === 'warped_ags') {
            assert.strictEqual(warpedResult.warpedRiver.results.length, 2);
            assert.strictEqual(warpedResult.warpedRiver.algorithmVersion,
                warpedResult.river.algorithmVersion, 'V5 must not forge a new readout algorithm');
            assert.strictEqual(warpedResult.warpedRiver.pipelineVersion,
                'rivermemo-v5-warped');
            assert(warpedResult.warpedRiver.results.every(item =>
                warpedResult.recallPools.warped.includes(item.chunkId)));
        } else {
            assert.strictEqual(warpedResult.warpedRiver.diagnostics.available, false);
            assert.deepStrictEqual(warpedResult.warpedRiver.results, []);
        }
        const unavailable = await lightQuery({ ...warpedPlan,
            warpedRiverInput: { ...warpedPlan.warpedRiverInput,
                tagRouting: { used: 'cosine', fallback: true } } });
        assert.strictEqual(unavailable.warpedRiver.diagnostics.available, false);
        assert.deepStrictEqual(unavailable.warpedRiver.results, []);
        const emptyV5 = await lightQuery({ ...warpedPlan, scope: { maid: 'test' } });
        assert.strictEqual(emptyV5.warpedRiver.diagnostics.reason, 'empty_chunk_candidates');
        assert.strictEqual(emptyV5.diagnostics.scope.emptyReason, 'maid_signature_filter_empty');
        assert.strictEqual(emptyV5.diagnostics.scope.globalValidChunks, 2);
        assert.deepStrictEqual(emptyV5.warpedRiver.results, []);
        index.releaseMemoObservation(warpedMetadata.observationHandle);
        const forcedChunks = JSON.parse(await nativeKnowledgeRuntime.prepareGlobalWarpedChunkIndex(
            'manifest-test-model', true));
        assert.strictEqual(forcedChunks.ready, true);
        assert.strictEqual(forcedChunks.forced, true);
        assert.strictEqual(forcedChunks.source, 'built');
        assert.strictEqual(forcedChunks.nodes, 2);
        const warmedChunks = JSON.parse(await nativeKnowledgeRuntime.prepareGlobalWarpedChunkIndex(
            'manifest-test-model'));
        assert.strictEqual(warmedChunks.source, 'memory');
        const residentStats = JSON.parse(nativeKnowledgeRuntime.lightMemoIndexStats());
        assert.strictEqual(residentStats.resident, true);
        assert.strictEqual(residentStats.warpedChunks.resident, true);
        assert(residentStats.warpedChunks.hotBytes > 0);
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
        assert.strictEqual(noSignature.diagnostics.scope.emptyReason, 'maid_signature_filter_empty');
        assert.strictEqual(noSignature.diagnostics.scope.globalValidChunks, 2);
        assert.strictEqual(noSignature.diagnostics.scope.diaryChunks, 2);

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
                        modelSig: 'manifest-test-model',
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

        const retained = JSON.parse(index.memoObservationMemoryStats());
        assert.strictEqual(retained.entries, 8,
            'raw ABI caller owns handles until all internal consumers finish');
        assert(retained.payloadCapacityBytes > 0);
        assert(retained.tagVectorNodes > 0);
        assert(retained.tagVectorBytes > 0);
        assert.strictEqual(JSON.parse(index.memoObservationMemoryStats()).entries, 8,
            'memory diagnostics must not evict observations');
        for (const handle of concurrentHandles) {
            assert.strictEqual(index.releaseMemoObservation(handle), true);
            assert.strictEqual(index.releaseMemoObservation(handle), false,
                'request release must be idempotent');
        }
        const released = JSON.parse(index.memoObservationMemoryStats());
        assert.strictEqual(released.entries, 0);
        assert.strictEqual(released.payloadCapacityBytes, 0);
        assert.strictEqual(released.tagVectorNodes, 0);
        assert.strictEqual(released.tagVectorBytes, 0);
        assert.strictEqual(index.memoRuntimeStats().resident, true,
            'releasing requests must retain the shared background graph');

        for (let round = 0; round < 32; round++) {
            const pipeline = await index.runMemoPipeline(
                dbPath, result.artifactSig,
                JSON.stringify({ queryText: `memory-round-${round}`,
                    config: { maxLevels: 1, pyramidTopK: 3 } }),
                new Float32Array([1, 0, 0, 0]), new Float32Array()
            );
            const handle = JSON.parse(pipeline.metadataJson).observationHandle;
            assert.strictEqual(JSON.parse(index.memoObservationMemoryStats()).entries, 1);
            assert.strictEqual(index.releaseMemoObservation(handle), true);
            assert.strictEqual(JSON.parse(index.memoObservationMemoryStats()).payloadCapacityBytes, 0,
                `round ${round} must not retain completed request payloads`);
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

        // Daily ingestion must update live Chunk recall without rebuilding the
        // trained geometry or rewriting either the warped or A/B-slot baseline.
        const generationPipelines = await Promise.all([false, true].map(warped =>
            index.runMemoPipeline(dbPath, result.artifactSig, JSON.stringify({
                queryText: 'generation window',
                config: { maxLevels: 1, pyramidTopK: 3,
                    ...(warped ? { tagRoutingMode: 'warped_ags' } : {}) }
            }), new Float32Array([1,0,0,0]), new Float32Array())
        ));
        const generationMetadata = generationPipelines.map(p => JSON.parse(p.metadataJson));
        const generationPlan = {
            ...lightPlan, k: 3, warpedAb: true,
            riverInput: { ...lightPlan.riverInput,
                observationHandle: generationMetadata[0].observationHandle },
            warpedRiverInput: { ...lightPlan.riverInput,
                observationHandle: generationMetadata[1].observationHandle,
                tagRouting: generationMetadata[1].diagnostics.tagRouting }
        };
        try {
            const beforeWrite = await lightQuery(generationPlan);
            const geometryFacts = beforeWrite.diagnostics.warpedChunks.geometryFacts;
            const warpedPath = path.join(root, fs.readdirSync(root).find(name => name.endsWith('.vcpwc')));
            const warpedBytes = fs.readFileSync(warpedPath);
            const warpedMtime = fs.statSync(warpedPath).mtimeMs;
            await nativeKnowledgeRuntime.commitIngestionBatch(dbPath, JSON.stringify({
                operationId: 'daily-generation-window', batchId: 'daily-generation-window',
                dimension: 4, modelSig: 'manifest-test-model',
                files: [{ path: 'new-diary.txt', diaryName: 'test', checksum: 'new',
                    mtime: 2, size: 10, expectedVersion: 0,
                    chunkStart: 0, chunkCount: 1, tagStart: 0, tagCount: 0 }],
                chunks: [{ content: 'new daily candidate', chunkIndex: 0, vectorSlot: 0 }],
                tags: []
            }), new Float32Array([1,0,0,0]), new Float32Array());
            // Query observations are request snapshots, unlike the shared
            // trained field: a fact commit requires fresh per-query handles.
            for (const metadata of generationMetadata) {
                index.releaseMemoObservation(metadata.observationHandle);
            }
            generationMetadata.length = 0;
            for (const warped of [false, true]) {
                const pipeline = await index.runMemoPipeline(dbPath, result.artifactSig, JSON.stringify({
                    queryText: 'generation window after ingestion',
                    config: { maxLevels: 1, pyramidTopK: 3,
                        ...(warped ? { tagRoutingMode: 'warped_ags' } : {}) }
                }), new Float32Array([1,0,0,0]), new Float32Array());
                generationMetadata.push(JSON.parse(pipeline.metadataJson));
            }
            generationPlan.riverInput.observationHandle = generationMetadata[0].observationHandle;
            generationPlan.warpedRiverInput.observationHandle = generationMetadata[1].observationHandle;
            generationPlan.warpedRiverInput.tagRouting = generationMetadata[1].diagnostics.tagRouting;
            const afterWrite = await lightQuery(generationPlan);
            assert.strictEqual(afterWrite.diagnostics.warpedChunks.source, 'memory');
            assert.strictEqual(afterWrite.diagnostics.warpedChunks.geometryFacts, geometryFacts);
            assert.strictEqual(afterWrite.diagnostics.warpedChunks.deltaChunks, 1);
            assert.strictEqual(afterWrite.diagnostics.warpedChunks.liveNodes, 3);
            assert(afterWrite.tdbTopK.some(item => item.text === 'new daily candidate'));
            assert(afterWrite.warpedTopK.some(item => item.text === 'new daily candidate'));
            assert.deepStrictEqual(fs.readFileSync(warpedPath), warpedBytes);
            assert.strictEqual(fs.statSync(warpedPath).mtimeMs, warpedMtime);
            assert.deepStrictEqual(fs.readFileSync(snapshotPath), snapshotBytes);
            assert.strictEqual(fs.statSync(snapshotPath).mtimeMs, snapshotMtime);
            await new Promise(resolve => setTimeout(resolve, 15));
            assert.strictEqual(nativeKnowledgeRuntime.evictIdleLightMemoIndex(1), true);
            const restoredGeneration = await lightQuery(generationPlan);
            assert.strictEqual(restoredGeneration.diagnostics.warpedChunks.source, 'snapshot');
            assert.strictEqual(restoredGeneration.diagnostics.warpedChunks.geometryFacts, geometryFacts);
            assert.deepStrictEqual(restoredGeneration.warpedTopK, afterWrite.warpedTopK);
            assert.deepStrictEqual(fs.readFileSync(warpedPath), warpedBytes);
            assert.strictEqual(fs.statSync(warpedPath).mtimeMs, warpedMtime);
            const nextGeneration = JSON.parse(
                await nativeKnowledgeRuntime.prepareGlobalWarpedChunkIndex('manifest-test-model', true));
            assert.strictEqual(nextGeneration.source, 'built');
            assert.strictEqual(nextGeneration.nodes, 3);
            assert.notStrictEqual(nextGeneration.geometryFacts, geometryFacts);
            const trainedResult = await lightQuery(generationPlan);
            assert.strictEqual(trainedResult.diagnostics.warpedChunks.deltaChunks, 0);
            assert.notDeepStrictEqual(fs.readFileSync(warpedPath), warpedBytes);
            // Geometry training is not permission to publish the normal A/B slots.
            assert.deepStrictEqual(fs.readFileSync(snapshotPath), snapshotBytes);
            assert.strictEqual(fs.statSync(snapshotPath).mtimeMs, snapshotMtime);
        } finally {
            for (const metadata of generationMetadata) {
                index.releaseMemoObservation(metadata.observationHandle);
            }
        }

        nativeKnowledgeRuntime.openAndInitStore(path.join(root, 'other.sqlite'));
        assert.strictEqual(JSON.parse(nativeKnowledgeRuntime.lightMemoIndexStats()).resident, false,
            'store replacement must discard the previous database table');
        await assert.rejects(
            () => lightQuery({
                ...lightPlan, engineMode: 'knn', abMode: false,
                scope: { searchAll: true }
            }),
            /observation handle .* is unavailable/,
            'store replacement must invalidate explicitly supplied old handles'
        );
        const other = await lightQuery({
            modelSig: 'manifest-test-model',
            engineMode: 'knn', abMode: false,
            k: 2, candidateK: 16,
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