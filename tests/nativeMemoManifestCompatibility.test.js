'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { VexusIndex } = require('../rust-vexus-lite');
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

        console.log(
            '[NativeMemoManifestTest] PASS: canonical manifest and TypedArray/handle Memo ABI are compatible.'
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