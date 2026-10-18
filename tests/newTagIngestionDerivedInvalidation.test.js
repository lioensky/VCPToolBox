'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { VexusIndex, NativeKnowledgeRuntime } = require('../rust-vexus-lite');

test('new Tag facts retain published Memo until successful replacement', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-ingestion-'));
    const db = path.join(root, 'test.sqlite');
    const index = new VexusIndex(2, 32);
    const runtime = new NativeKnowledgeRuntime(index);
    let reader;
    try {
        runtime.openAndInitStore(db);
        const ingest = async (name, count) => runtime.commitIngestionBatch(db, JSON.stringify({
            operationId: name, batchId: name, dimension: 2, modelSig: 'test',
            files: [{ path: `${name}.txt`, diaryName: 'test', checksum: name,
                mtime: 1, size: 1, expectedVersion: 0, chunkStart: 0, chunkCount: 1,
                tagStart: 0, tagCount: count }],
            chunks: [{ content: name, chunkIndex: 0, vectorSlot: 0 }],
            tags: Array.from({ length: count }, (_, i) => ({
                name: `${name}-${i}`, position: i + 1, vectorSlot: i
            }))
        }), new Float32Array([1, 0]),
        new Float32Array(Array.from({ length: count }, (_, i) => [Math.cos(i), Math.sin(i)]).flat()));
        await ingest('first', 4);
        await index.computeMemoGeometry(db, 'test', '{}');
        const built = await index.rebuildMemoArtifact(db, JSON.stringify({ modelSig: 'test' }));
        reader = new Database(db, { readonly: true });
        const facts = () => Number(reader.prepare(
            "SELECT value FROM kbm_runtime_meta WHERE key='memo_tag_facts'"
        ).get().value);
        const before = facts();
        const residuals = reader.prepare('SELECT COUNT(*) n FROM tag_intrinsic_residuals').get().n;
        assert.equal(reader.prepare(
            "SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('tag_pair_similarity','tag_pair_similarity_status')"
        ).get().n, 0);
        await ingest('new', 1);
        assert(facts() > before);
        assert.equal(reader.prepare('SELECT COUNT(*) n FROM tag_intrinsic_residuals').get().n, residuals);
        const query = () => index.runMemoPipeline(db, built.artifactSig,
            JSON.stringify({ config: { maxLevels: 1 } }),
            new Float32Array([1, 0]), new Float32Array());
        await query();
        index.clearMemoRuntime();
        await query();
        assert.equal(reader.prepare('SELECT COUNT(*) n FROM kbm_memo_changed_tags').get().n, 1);
        await assert.rejects(index.rebuildMemoArtifact(db,
            JSON.stringify({ modelSig: 'test' })), /geometry facts are stale/);
        await query();
        await index.computeMemoGeometry(db, 'test', '{}');
        await query(); // Geometry publication alone must not withdraw the graph.
        const replacement = await index.rebuildMemoArtifact(db, JSON.stringify({ modelSig: 'test' }));
        assert.notEqual(replacement.artifactSig, built.artifactSig);
        assert.equal(reader.prepare('SELECT COUNT(*) n FROM kbm_memo_changed_tags').get().n, 0);
        assert.equal(Number(reader.prepare(
            "SELECT value FROM kbm_runtime_meta WHERE key='memo_training_tag_count'"
        ).get().value), 5);
    } finally {
        reader?.close();
        runtime.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});