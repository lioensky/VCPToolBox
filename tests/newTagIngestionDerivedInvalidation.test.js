'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { VexusIndex, NativeKnowledgeRuntime } = require('../rust-vexus-lite');

test('new Tag facts invalidate Memo without pair tables or historical residual deletion', async () => {
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
        await assert.rejects(index.runMemoPipeline(db, built.artifactSig,
            JSON.stringify({ config: { maxLevels: 1 } }),
            new Float32Array([1, 0]), new Float32Array()), /DERIVED_DEPENDENCY_CONFLICT/);
    } finally {
        reader?.close();
        runtime.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});