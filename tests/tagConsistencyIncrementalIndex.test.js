'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { VexusIndex, NativeKnowledgeRuntime } = require('../rust-vexus-lite');
const IndexRepository = require('../modules/knowledgeBase/indexRepository');
const TagConsistencyService = require('../modules/knowledgeBase/tagConsistencyService');

test('native consistency preview commits facts and index before queuing derived training', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-tag-consistency-'));
    const rootPath = path.join(root, 'notes');
    fs.mkdirSync(rootPath);
    fs.writeFileSync(path.join(rootPath, 'note.md'), 'Tag: keep');
    const dbPath = path.join(root, 'test.sqlite');
    const index = new VexusIndex(4, 32);
    const runtime = new NativeKnowledgeRuntime(index);
    let db;
    try {
        runtime.openAndInitStore(dbPath);
        db = new Database(dbPath);
        db.prepare("INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES (1,'note.md','Root','',0,0)").run();
        const insert = db.prepare('INSERT INTO tags(id,name,vector) VALUES (?,?,?)');
        insert.run(1, 'keep', Buffer.from(new Float32Array([1, 0, 0, 0]).buffer));
        insert.run(2, 'orphan', Buffer.from(new Float32Array([0, 1, 0, 0]).buffer));
        db.prepare('INSERT INTO file_tags VALUES (1,2,1)').run();
        const config = { rootPath, storePath: root, dimension: 4, modelSig: 'consistency-test',
            ignoreFolders: [], ignorePrefixes: [], ignoreSuffixes: [],
            tagBlacklist: new Set(), tagBlacklistSuper: [], maxTagsPerFile: 50,
            persistTagIndex: true, tagIndexAllowInitial: true,
            persistFolders: new Set(), tagIndexBaselineDeltaRatio: 0.05 };
        const repository = new IndexRepository({ config, VexusIndex, getDbPath: () => dbPath,
            getNativeRuntime: () => runtime });
        repository.tagIndex = index;
        await runtime.restoreGlobalTagIndex(dbPath, repository._tagBaselinePath('a'), config.modelSig, 32);
        assert.equal(await repository.publishGlobalTagBaseline({ force: true }), true);
        let queued = 0;
        const owner = { initialized: true, config, dbPath, tagIndex: index,
            nativeKnowledgeRuntime: runtime, _scheduleIndexSave() {},
            tagMemoEngine: { async scheduleMatrixRebuildForNewTags() {
                assert.equal(index.stats().totalVectors, 1);
                queued++;
                return true;
            } } };
        const service = new TagConsistencyService(owner, { VexusIndex });
        const preview = await service.createPreview();
        assert.equal(preview.requiresConfirmation, true);
        assert.equal(preview.summary.relationsToAdd, 1);
        assert.equal(preview.summary.relationsToRemove, 1);
        assert.equal(preview.summary.orphanTagsToRemove, 1);
        const result = await service.applyPreview(preview.token);
        assert.equal(result.applied, true);
        assert.equal(result.indexReady, true);
        assert.equal(result.indexUpdate.mode, 'native-rust-delta');
        assert.equal(result.indexUpdate.requestedDeletes, 1);
        assert.equal(result.indexUpdate.totalVectors, 1);
        assert.equal(queued, 1);
        assert.deepEqual(db.prepare('SELECT id,name FROM tags ORDER BY id').all(), [{ id: 1, name: 'keep' }]);
        assert.deepEqual(db.prepare('SELECT * FROM file_tags').all(), [{ file_id: 1, tag_id: 1, position: 1 }]);
        const hits = JSON.parse(await runtime.searchGlobalTags(new Float32Array([1, 0, 0, 0]), 1));
        assert.equal(hits[0].tag, 'keep');
        const replay = JSON.parse(await runtime.restoreGlobalTagIndex(
            dbPath, repository._tagBaselinePath('a'), config.modelSig, 32));
        assert.equal(replay.replayed, true);
        assert.equal(replay.vectorCount, 1);
        assert.equal(await repository.publishGlobalTagBaseline({ force: true }), true);
        const baseline = JSON.parse(db.prepare("SELECT value FROM kv_store WHERE key='tag_index_active_baseline'").get().value);
        assert.deepEqual(baseline, { generation: 2, slot: 'b' });
        await service.drain();
    } finally {
        db?.close();
        runtime.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});