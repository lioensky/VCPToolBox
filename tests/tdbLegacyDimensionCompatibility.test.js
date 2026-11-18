'use strict';

// Each fixture represents a separate single-dimension server/database.
// Legacy JS-owned SQL facts are authoritative; old usearch assets are not read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { VexusIndex, NativeKnowledgeRuntime } = process.env.TDB_NATIVE_BINDING
    ? require(path.resolve(process.env.TDB_NATIVE_BINDING))
    : require('../rust-vexus-lite');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const bytes = vector => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

for (const dimension of [3072, 4096]) {
    test(`legacy ${dimension}D SQL loads, accepts native writes and restarts independently`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `vcp-legacy-${dimension}-`));
        const dbPath = path.join(root, 'knowledge_base.sqlite');
        const tagPath = path.join(root, 'index_global_tags_a.vec');
        const diaryPath = path.join(root, 'index_diary_fixture_a.vec');
        const model = `unchanged-model-${dimension}`;
        const oldVector = new Float32Array(dimension);
        const newVector = new Float32Array(dimension);
        oldVector[dimension - 1] = 1;
        newVector[dimension - 2] = 1;
        let db;
        let runtime;
        try {
            // Deliberately omit Rust-era metadata/version columns.
            db = new Database(dbPath);
            db.exec(`
                CREATE TABLE files (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL,
                    diary_name TEXT NOT NULL, checksum TEXT NOT NULL,
                    mtime INTEGER NOT NULL, size INTEGER NOT NULL, updated_at INTEGER
                );
                CREATE TABLE chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL,
                    chunk_index INTEGER NOT NULL, content TEXT NOT NULL, vector BLOB
                );
                CREATE TABLE tags (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, vector BLOB
                );
                CREATE TABLE file_tags (
                    file_id INTEGER NOT NULL, tag_id INTEGER NOT NULL,
                    PRIMARY KEY(file_id, tag_id)
                );
                INSERT INTO files VALUES (1,'Diary/old.txt','Diary','old',1,3,1);
                INSERT INTO file_tags VALUES (1,1);
            `);
            db.prepare('INSERT INTO chunks VALUES (1,1,0,?,?)').run('old', bytes(oldVector));
            db.prepare('INSERT INTO tags VALUES (1,?,?)').run('old-tag', bytes(oldVector));
            db.close();
            db = null;

            const open = async expectedCount => {
                const tagIndex = new VexusIndex(dimension, 16);
                const diaryIndex = new VexusIndex(dimension, 16);
                runtime = new NativeKnowledgeRuntime(tagIndex);
                runtime.openAndInitStore(dbPath);
                const tags = parse(await runtime.restoreGlobalTagIndex(dbPath, tagPath, model, 16));
                const diary = parse(await runtime.restoreDiaryIndex(
                    dbPath, 'Diary', diaryPath, model, 16, diaryIndex));
                runtime.registerDiaryIndex('Diary', diaryIndex);
                assert.equal(tags.vectorCount, expectedCount);
                assert.equal(diary.vectorCount, expectedCount);
                assert.equal(parse(await runtime.searchGlobalTags(oldVector, 1))[0].tag, 'old-tag');
                assert.equal(parse(await runtime.searchDiaryIndices(['Diary'], oldVector, 1, 1)).results[0].id, 1);
                return { tagIndex, diaryIndex };
            };

            const initial = await open(1);
            assert.equal(initial.tagIndex.stats().totalVectors, 1);
            const receipt = parse(await runtime.commitIngestionBatch(dbPath, JSON.stringify({
                operationId: 'native-append', batchId: 'native-append',
                dimension, modelSig: model,
                files: [{
                    path: 'Diary/new.txt', diaryName: 'Diary', checksum: 'new',
                    mtime: 2, size: 3, expectedVersion: 0,
                    chunkStart: 0, chunkCount: 1, tagStart: 0, tagCount: 1
                }],
                chunks: [{ content: 'new', chunkIndex: 0, vectorSlot: 0 }],
                tags: [{ name: 'new-tag', position: 1, vectorSlot: 0 }]
            }), newVector, newVector));
            assert.equal(receipt.factsCommitted, true);
            assert.equal(initial.tagIndex.stats().totalVectors, 2);
            assert.equal(initial.diaryIndex.stats().totalVectors, 2);
            const chunkId = parse(await runtime.searchDiaryIndices(['Diary'], newVector, 1, 1)).results[0].id;
            const tagHits = parse(await runtime.searchGlobalTags(newVector, 1));
            assert.equal(tagHits[0].tag, 'new-tag');
            const lookup = new Database(dbPath, { readonly: true });
            const tagId = lookup.prepare("SELECT id FROM tags WHERE name='new-tag'").get().id;
            lookup.close();
            assert.notEqual(chunkId, 1);
            assert.notEqual(tagId, 1);
            assert.equal(parse(await runtime.checkpointGlobalTagIndex(
                dbPath, tagPath, model, 0.05, false, true)).published, true);
            assert.equal(parse(await runtime.checkpointDiaryIndex(
                dbPath, 'Diary', diaryPath, model, 0.05, false, true)).published, true);
            runtime.shutdown();
            runtime = null;

            const restarted = await open(2);
            assert.equal(parse(await runtime.searchDiaryIndices(['Diary'], newVector, 1, 1)).results[0].id, chunkId);
            assert.equal(parse(await runtime.searchGlobalTags(newVector, 1))[0].tag, 'new-tag');
            assert.equal(restarted.diaryIndex.stats().mmapBytes, 0);
            assert.equal(restarted.tagIndex.stats().mmapBytes, 0);
            runtime.shutdown();
            runtime = null;

            db = new Database(dbPath, { readonly: true });
            assert.deepEqual(db.prepare('SELECT vector FROM chunks WHERE id=1').get().vector, bytes(oldVector));
            assert.deepEqual(db.prepare('SELECT vector FROM tags WHERE id=1').get().vector, bytes(oldVector));
            assert.deepEqual(db.prepare('SELECT vector FROM chunks WHERE id=?').get(chunkId).vector, bytes(newVector));
            assert.deepEqual(db.prepare('SELECT vector FROM tags WHERE id=?').get(tagId).vector, bytes(newVector));
            assert.equal(db.prepare('SELECT COUNT(*) n FROM chunks WHERE length(vector)!=?')
                .get(dimension * 4).n, 0);
        } finally {
            db?.close();
            runtime?.shutdown();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

test('native index retains the upper dimension boundary', () => {
    assert.throws(() => new VexusIndex(4097, 1), /dimension.*4096/);
    assert.throws(() => new VexusIndex(0, 1), /dimension/);
});