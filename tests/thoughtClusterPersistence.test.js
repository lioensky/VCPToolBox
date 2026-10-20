'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const IndexRepository = require('../modules/knowledgeBase/indexRepository');

test('cluster always policy is independent while ordinary diary whitelist and threshold remain intact', async () => {
    const calls = [];
    const config = {
        storePath: '.', modelSig: 'test', persistDefault: false,
        persistFolders: new Set(['a']), chunkIndexPersistenceMode: 'generational',
        chunkIndexAllowInitial: false, chunkIndexBaselineDeltaRatio: 0.05
    };
    const repo = new IndexRepository({
        config, getDbPath: () => 'fixture.sqlite',
        getNativeRuntime: () => ({
            async checkpointDiaryIndex(...args) {
                calls.push(args);
                return { factsCommitted: false, published: false };
            }
        })
    });
    for (const name of ['a', 'b', '测试簇']) repo.diaryIndices.set(name, {});
    assert.equal(repo.shouldPersist('a'), true);
    assert.equal(repo.shouldPersist('b'), false);
    await repo.publishDiaryBaseline('a');
    assert.deepEqual(calls.pop().slice(4), [0.05, false, false]);
    await repo.publishDiaryBaseline('b');
    assert.equal(calls.length, 0);
    await repo.publishDiaryBaseline('测试簇');
    assert.deepEqual(calls.pop().slice(4), [0, false, true]);
    repo.chunkIndexPersistenceMode = 'none';
    assert.equal(repo.shouldPersist('a'), false);
    assert.equal(repo.shouldPersist('测试簇'), true);
    await repo.publishDiaryBaseline('测试簇');
    assert.deepEqual(calls.pop().slice(4), [0, false, true]);
});

test('native cluster checkpoint publishes small changes but never rewrites unchanged assets', async () => {
    const Database = require('better-sqlite3');
    const { VexusIndex, NativeKnowledgeRuntime } = require('../rust-vexus-lite');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-cluster-policy-'));
    const dbPath = path.join(root, 'fixture.sqlite');
    const tags = new VexusIndex(2, 128);
    const runtime = new NativeKnowledgeRuntime(tags);
    let db;
    try {
        runtime.openAndInitStore(dbPath);
        db = new Database(dbPath);
        db.exec("INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES (1,'测试簇/a.txt','测试簇','x',0,1)");
        const insert = db.prepare('INSERT INTO chunks(id,file_id,chunk_index,content,vector) VALUES (?,1,?,?,?)');
        db.transaction(() => {
            for (let id = 1; id <= 100; id++) {
                insert.run(id, id - 1, 'body', Buffer.from(new Float32Array([1, 0]).buffer));
            }
        })();
        const repo = new IndexRepository({
            config: { storePath: root, dimension: 2, modelSig: 'test',
                persistDefault: false, persistFolders: new Set(),
                chunkIndexPersistenceMode: 'none', chunkIndexAllowInitial: false },
            getDbPath: () => dbPath, getNativeRuntime: () => runtime
        });
        const index = new VexusIndex(2, 128);
        await repo.restoreDiaryIndex('测试簇', index, 128);
        repo.diaryIndices.set('测试簇', index);
        runtime.registerDiaryIndex('测试簇', index);
        const stamp = () => fs.readdirSync(root).filter(name => name.endsWith('.vec')).sort().map(name => ({
            name, mtime: fs.statSync(path.join(root, name)).mtimeMs,
            bytes: fs.readFileSync(path.join(root, name)).toString('base64')
        }));
        assert.equal(await repo.publishDiaryBaseline('测试簇'), true);
        const first = stamp();
        assert.equal(await repo.publishDiaryBaseline('测试簇'), false);
        assert.deepEqual(stamp(), first);
        db.prepare('UPDATE chunks SET vector=? WHERE id=1').run(Buffer.from(new Float32Array([0, 1]).buffer));
        await repo.restoreDiaryIndex('测试簇', index, 128);
        assert.equal(await repo.publishDiaryBaseline('测试簇'), true, '1% change must publish despite ordinary 5% threshold');
        const second = stamp();
        assert.equal(second.length, 2);
        assert.equal(await repo.publishDiaryBaseline('测试簇'), false);
        assert.deepEqual(stamp(), second);
    } finally {
        db?.close();
        runtime.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});