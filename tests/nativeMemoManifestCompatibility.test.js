'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
    VexusIndex,
    NativeKnowledgeRuntime
} = require('../rust-vexus-lite');
const {
    initializeKnowledgeBaseSchema
} = require('../modules/knowledgeBase/schemaManager');
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
    const db = new Database(dbPath);

    try {
        initializeKnowledgeBaseSchema(db, {
            logPrefix: 'NativeMemoManifestTest'
        });

        db.prepare(`
            INSERT INTO files (
                id, path, diary_name, checksum, mtime, size, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(1, 'memo.txt', 'test', 'checksum', 1, 10, 1);

        const insertTag = db.prepare(
            'INSERT INTO tags (id, name, vector) VALUES (?, ?, ?)'
        );
        insertTag.run(1, 'tag-1', vectorBuffer([1, 0, 0, 0]));
        insertTag.run(2, 'tag-2', vectorBuffer([0, 1, 0, 0]));
        insertTag.run(3, 'tag-3', vectorBuffer([0, 0, 1, 0]));

        const insertRelation = db.prepare(`
            INSERT INTO file_tags (file_id, tag_id, position)
            VALUES (?, ?, ?)
        `);
        insertRelation.run(1, 1, 1);
        insertRelation.run(1, 2, 2);
        insertRelation.run(1, 3, 3);

        const insertChunk = db.prepare(`
            INSERT INTO chunks (id, file_id, chunk_index, content, vector)
            VALUES (?, 1, ?, ?, ?)
        `);
        insertChunk.run(
            101,
            0,
            'first shared-file candidate',
            vectorBuffer([1, 0, 0, 0])
        );
        insertChunk.run(
            102,
            1,
            'second shared-file candidate',
            vectorBuffer([0.8, 0.2, 0, 0])
        );

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

        const index = new VexusIndex(4, 16);
        const diaryIndex = new VexusIndex(4, 16);
        diaryIndex.addBatch(
            [101, 102],
            new Float32Array([
                1, 0, 0, 0,
                0.8, 0.2, 0, 0
            ])
        );
        const nativeKnowledgeRuntime = new NativeKnowledgeRuntime(index);
        nativeKnowledgeRuntime.registerDiaryIndex('test', diaryIndex);

        const result = await index.rebuildMemoArtifact(
            dbPath,
            JSON.stringify({
                modelSig: 'manifest-test-model',
                effectiveConfig
            })
        );
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.persisted, true);

        index.add(1, new Float32Array([1, 0, 0, 0]));
        index.add(2, new Float32Array([0, 1, 0, 0]));
        index.add(3, new Float32Array([0, 0, 1, 0]));
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
                    { id: 101, score: 0.9 },
                    { id: 102, score: 0.8 }
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
            new Set([101, 102])
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

        const row = db.prepare(`
            SELECT config_hash, database_generation, status
            FROM rivermemo_artifacts
            WHERE artifact_sig = ?
        `).get(result.artifactSig);
        assert(row, 'native artifact manifest must be persisted');
        assert.strictEqual(row.status, 'ready');
        assert.strictEqual(
            row.config_hash,
            sha256(canonicalJson, 32),
            'Rust and JS must hash the same canonical JSON'
        );
        assert.notStrictEqual(
            row.config_hash,
            sha256(ordinaryJson, 32),
            'test must detect the retired insertion-order hash'
        );

        const facts = ['files', 'chunks', 'tags', 'file_tags'].map(table => {
            const value = db.prepare(
                `SELECT COUNT(*) AS count,
                        COALESCE(MAX(rowid), 0) AS maxRowId
                 FROM ${table}`
            ).get();
            return `${table}:${value.count}:${value.maxRowId}`;
        });
        assert.strictEqual(
            row.database_generation,
            sha256(facts.join('|'), 40),
            'Rust and JS database-generation contracts must remain identical'
        );

        nativeKnowledgeRuntime.shutdown();
        console.log(
            '[NativeMemoManifestTest] PASS: canonical manifest, TypedArray/handle Memo ABI, ' +
            'batched RiverMemo SQL, one-call joint retrieval and concurrent cold handles are compatible.'
        );
    } finally {
        db.close();
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch (error) {
            // Rust SQLite keepalive 与进程同生命周期；Windows 在当前测试进程
            // 退出前会拒绝删除仍被 keepalive 持有的临时数据库。
            if (process.platform !== 'win32' || error?.code !== 'EBUSY') {
                throw error;
            }
        }
    }
}

main().catch(error => {
    console.error('[NativeMemoManifestTest] FAIL:', error);
    process.exitCode = 1;
});