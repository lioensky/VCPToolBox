'use strict';

/**
 * RiverMemo V9 Dual-Ledger Geometry — Reproducible Audit & Regression Suite
 *
 * Run via Node test runner:
 *   node --test tests/v9DualLedgerBenchmarkAndAudit.test.js
 *
 * Covers:
 *   1. PR #521 Audit P1-2: Hot-state resident bipartite index live fact refresh on file_tags mutation.
 *   2. PR #521 Audit P1-3: Disconnected river branches (1->2 and 4->3) never fabricate transitive edges.
 *   3. One-Click Experiment Decoupling Preset (`experimentPreset: "upstream" | "v1" | "v2"`):
 *      Verifies bit-for-bit fallback parity with upstream baseline (`6167e64`) without manually toggling flags.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const { VexusIndex, NativeKnowledgeRuntime } = require('../rust-vexus-lite');

function f32Buf(arr) {
    return Buffer.from(new Float32Array(arr).buffer);
}

function unitVec(arr) {
    const norm = Math.sqrt(arr.reduce((s, x) => s + x * x, 0)) || 1;
    return arr.map(x => x / norm);
}

function buildPersistedArtifactPayload(nodeIds, rowOffsets, targetIndices, weights, provenanceEdges = []) {
    const jsonObj = {
        schema: 'rivermemo-persisted-artifact-v2',
        algorithmVersion: 'memo.native-artifact-v2-binary',
        artifact: { maxInbound: 1.0 },
        sharedTransport: {
            nodeIds,
            rowOffsets,
            targetIndices,
            weights,
        },
        inboundMassView: nodeIds.map(id => [id, 0.5]),
        anchorGainView: nodeIds.map(id => [id, 1.0]),
        wormholeView: [],
        provenanceView: { edges: provenanceEdges },
    };
    const raw = Buffer.from(JSON.stringify(jsonObj), 'utf8');
    const checksum = crypto.createHash('sha256').update(raw).digest('hex');
    const compressed = zlib.gzipSync(raw);
    return { compressed, checksum };
}

function seedFixtureStore(dbPath, dim = 4) {
    const runtime = new NativeKnowledgeRuntime(new VexusIndex(dim, 32));
    runtime.openAndInitStore(dbPath);
    const db = new DatabaseSync(dbPath);
    const { compressed, checksum } = buildPersistedArtifactPayload(
        [1, 2, 3, 4],
        [0, 1, 2, 2, 3],
        [1, 2, 2], // 1->2, 2->3, 4->3
        [0.85, 0.80, 0.75],
        [['1:2', [[1, 0.8]]], ['2:3', [[1, 0.8]]]]
    );

    db.exec(`
        INSERT OR REPLACE INTO kbm_runtime_meta(key, value) VALUES
            ('memo_tag_facts', '1'),
            ('derived_geometry', '1');
        INSERT INTO rivermemo_artifacts(
            artifact_sig, schema_version, algorithm_version, source_v9_artifact_sig,
            source_graph_generation, model_sig, config_hash, database_generation,
            provenance_generation, status, payload_codec, payload_checksum, payload,
            created_at, updated_at
        ) VALUES (
            'sig-audit', 'rivermemo-persisted-artifact-v2', 'memo.native-artifact-v2-binary',
            'src', '1', 'm', 'c', '0', '1', 'ready', 'gzip-json-v1', '${checksum}',
            X'00', 0, 0
        );
    `);
    db.prepare('UPDATE rivermemo_artifacts SET payload = ? WHERE artifact_sig = ?').run(compressed, 'sig-audit');
    db.exec(`
        INSERT INTO kbm_artifact_dependencies(artifact_sig, dependency_key, dependency_version)
        SELECT 'sig-audit', key, value FROM kbm_runtime_meta WHERE key IN ('memo_tag_facts', 'derived_geometry');
    `);

    const insTag = db.prepare('INSERT INTO tags(id, name, vector) VALUES (?, ?, ?)');
    insTag.run(1, 'Tag1_Seed', f32Buf(unitVec([1.0, 0.0, 0.0, 0.0])));
    insTag.run(2, 'Tag2_Ferry', f32Buf(unitVec([0.0, 1.0, 0.0, 0.0])));
    insTag.run(3, 'Tag3_Target', f32Buf(unitVec([0.2, 0.0, 0.98, 0.0])));
    insTag.run(4, 'Tag4_OtherBranch', f32Buf(unitVec([0.0, 0.0, 0.0, 1.0])));

    const insFile = db.prepare('INSERT INTO files(id, path, diary_name, checksum, mtime, size) VALUES (?, ?, ?, ?, 0, 1)');
    insFile.run(1, 'A/bridge.md', 'A', 'c1');
    insFile.run(2, 'A/direct.md', 'A', 'c2');

    const insChunk = db.prepare('INSERT INTO chunks(id, file_id, chunk_index, content, vector) VALUES (?, ?, 0, ?, ?)');
    insChunk.run(101, 1, 'bridge chunk', f32Buf(unitVec([0.45, 0.15, 0.88, 0.0])));
    insChunk.run(201, 2, 'direct chunk', f32Buf(unitVec([0.92, 0.35, 0.05, 0.0])));

    const insFt = db.prepare('INSERT INTO file_tags(file_id, tag_id, position) VALUES (?, ?, ?)');
    // File 1 has ordered tags (1, pos 1), (3, pos 2)
    insFt.run(1, 1, 1);
    insFt.run(1, 3, 2);
    // File 2 has (1, pos 1), (2, pos 2)
    insFt.run(2, 1, 1);
    insFt.run(2, 2, 2);

    db.close();
    return runtime;
}

test('PR #521 Spec 2 (P1-2, P1-3 & One-Click Preset Decoupling): isolated counterexamples & preset fallback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-v9-audit-'));
    const dbPath = path.join(root, 'audit.sqlite');
    const runtime = seedFixtureStore(dbPath, 4);
    const idx = new VexusIndex(4, 32);

    try {
        const qVec = unitVec([0.85, 0.10, 0.51, 0.0]);
        const dVec = unitVec([0.65, 0.15, 0.74, 0.0]);
        const lVec = unitVec([1.0, 0.0, 0.0, 0.0]);
        const tVec = unitVec([0.2, 0.2, 0.96, 0.0]);

        // 1. P1-3 Counterexample: Disconnected branches A (1 -> 2) and B (4 -> 3)
        // Candidate 101 has ordered tags [1, 3], but no directed path 1 ->* 3 exists!
        const disconnectedInput = {
            dimension: 4,
            topK: 5,
            includeTrace: true,
            query: { text: 'p1_3_disconnected', vector: qVec },
            denoisedVector: dVec,
            localVector: lVec,
            transferVector: tVec,
            candidates: [
                { id: 101, score: 0.65, vectorScore: 0.65, hybridScore: 0.65 },
            ],
            queryState: {
                queryId: 'p1_3',
                sourceField: [[1, 1.0], [4, 0.9]],
                localField: [[1, 1.0], [2, 0.7]],
                transferField: [[4, 0.8], [3, 0.9]],
                localDomainIds: [1, 2],
                transferDomainIds: [4, 3],
                riverNodes: [
                    { id: 1, energy: 1.0, normalizedEnergy: 1.0, hop: 0 },
                    { id: 2, energy: 0.7, normalizedEnergy: 0.7, hop: 1 },
                    { id: 4, energy: 0.8, normalizedEnergy: 0.8, hop: 0 },
                    { id: 3, energy: 0.9, normalizedEnergy: 0.9, hop: 1 },
                ],
                riverEdges: [
                    { sourceId: 1, targetId: 2, flow: 0.7, normalizedFlow: 0.9 },
                    { sourceId: 4, targetId: 3, flow: 0.6, normalizedFlow: 0.8 },
                ],
                fieldProvenance: [{ id: 1, hop: 0, sourceType: 'seed' }],
                completeObservation: true,
            },
            config: {},
        };

        const discOut = JSON.parse(await idx.rerankRivermemoTopologyV3(dbPath, 'sig-audit', JSON.stringify(disconnectedInput)));
        const c101Disc = discOut.results.find(r => r.id === 101);
        assert.equal(c101Disc.relativeTopology.matchedEdges, 0, 'Disconnected branches 1->2 and 4->3 must NEVER fabricate a matched edge');
        assert.equal(c101Disc.relativeTopology.matchedEdgeCoverage, 0);
        assert.notEqual(c101Disc.relativeTopology.reliabilityMode, 'edge_topology');

        // 2. Connected 2-hop corridor (1 -> 2 -> 3) with V9 v2 vs One-Click Preset ("upstream" / "v1") vs Manual flags OFF
        const connectedInput = {
            ...disconnectedInput,
            queryState: {
                queryId: 'connected_2hop',
                sourceField: [[1, 1.0]],
                localField: [[1, 1.0], [2, 0.7]],
                transferField: [[2, 0.6], [3, 0.95]],
                localDomainIds: [1, 2],
                transferDomainIds: [2, 3],
                riverNodes: [
                    { id: 1, energy: 1.0, normalizedEnergy: 1.0, hop: 0 },
                    { id: 2, energy: 0.7, normalizedEnergy: 0.7, hop: 1 },
                    { id: 3, energy: 0.6, normalizedEnergy: 0.6, hop: 2 },
                ],
                riverEdges: [
                    { sourceId: 1, targetId: 2, flow: 0.7, normalizedFlow: 0.9 },
                    { sourceId: 2, targetId: 3, flow: 0.6, normalizedFlow: 0.8 },
                ],
                fieldProvenance: [{ id: 1, hop: 0, sourceType: 'seed' }],
                completeObservation: true,
            },
        };

        const outV2 = JSON.parse(await idx.rerankRivermemoTopologyV3(
            dbPath,
            'sig-audit',
            JSON.stringify({ ...connectedInput, config: { experimentPreset: 'v2' } })
        ));
        const c101V2 = outV2.results.find(r => r.id === 101);
        assert.ok(c101V2 && c101V2.relativeTopology.matchedEdges >= 1, 'Connected 2-hop corridor 1->2->3 must match under v2');

        const outPresetUpstream = JSON.parse(await idx.rerankRivermemoTopologyV3(
            dbPath,
            'sig-audit',
            JSON.stringify({ ...connectedInput, config: { experimentPreset: 'upstream' } })
        ));
        const outPresetV1 = JSON.parse(await idx.rerankRivermemoTopologyV3(
            dbPath,
            'sig-audit',
            JSON.stringify({ ...connectedInput, config: { experimentPreset: 'v1' } })
        ));
        const outManualUpstream = JSON.parse(await idx.rerankRivermemoTopologyV3(
            dbPath,
            'sig-audit',
            JSON.stringify({
                ...connectedInput,
                config: {
                    enableV8Extensions: false,
                    enableSubspacePeerKernel: false,
                    enableBipartiteBridgePullback: false,
                    enableGrassmannSubspaceReadout: false,
                    enableCellularSheafEnvelope: false,
                },
            })
        ));
        assert.equal(outPresetUpstream.results[0].relativeTopology.matchedEdges, 0);
        assert.equal(
            outPresetUpstream.results[0].score,
            outPresetV1.results[0].score,
            'experimentPreset="upstream" and "v1" must be bit-for-bit identical'
        );
        assert.equal(
            outPresetUpstream.results[0].score,
            outManualUpstream.results[0].score,
            'One-click experimentPreset="upstream" must be bit-for-bit identical to manual rollback flags'
        );

        // 3. P1-2 Counterexample: Mutate file_tags on File 2 (delete tag 1, move tag 2 to position 3)
        // while keeping the exact same active resident artifact ('sig-audit') in `idx`!
        const db = new DatabaseSync(dbPath);
        db.prepare('DELETE FROM file_tags WHERE file_id = 2 AND tag_id = 1').run();
        db.prepare('UPDATE file_tags SET position = 3 WHERE file_id = 2 AND tag_id = 2').run();
        db.close();

        const hotMutatedInput = {
            ...connectedInput,
            candidates: [{ id: 201, score: 0.80, vectorScore: 0.80, hybridScore: 0.80 }],
        };
        const outHot = JSON.parse(await idx.rerankRivermemoTopologyV3(dbPath, 'sig-audit', JSON.stringify(hotMutatedInput)));
        const c201Hot = outHot.results.find(r => r.id === 201);
        assert.ok(c201Hot, 'Candidate 201 must be present in rerank results');
        assert.deepEqual(c201Hot.matchedTags, ['Tag2_Ferry'], 'Hot resident bipartite index must immediately reflect deleted tag 1');
        assert.equal(c201Hot.relativeTopology.matchedEdges, 0, 'Deleted tag 1 must no longer form edge 1->2 in hot state');
    } finally {
        runtime.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});