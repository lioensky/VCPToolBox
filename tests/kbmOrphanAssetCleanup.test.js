'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { VexusIndex, NativeKnowledgeRuntime } = require('../rust-vexus-lite');
const IndexRepository = require('../modules/knowledgeBase/indexRepository');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbm-orphan-assets-'));
    const notes = path.join(root, 'notes');
    fs.mkdirSync(notes);
    const dbPath = path.join(root, 'test.sqlite');
    let runtime;
    let db;
    const open = () => {
        runtime = new NativeKnowledgeRuntime(new VexusIndex(2, 32));
        runtime.openAndInitStore(dbPath);
        db = new Database(dbPath);
    };
    const close = () => { db.close(); runtime.shutdown(); };
    open();
    const repo = new IndexRepository({
        config: { storePath: root, dimension: 2, modelSig: 'test',
            persistFolders: new Set(['Gone']), chunkIndexAllowInitial: true },
        getDbPath: () => dbPath, getNativeRuntime: () => runtime
    });
    return {
        root, notes, dbPath, repo,
        get db() { return db; },
        get runtime() { return runtime; },
        seed(name = 'Gone') {
            db.prepare(`INSERT INTO chunk_index_baselines
                (diary_name,generation,slot,dimension,model_sig,chunk_count,status,created_at)
                VALUES (?,1,'a',2,'test',0,'ready',0)`).run(name);
            db.prepare(`INSERT INTO kbm_index_states
                (scope,state,facts_generation,applied_generation,updated_at)
                VALUES (?,'ready',0,0,0)`).run(`diary:${name}`);
        },
        async cleanup(withStore = true) {
            return JSON.parse(await runtime.cleanupDatabaseOrphans(
                dbPath, notes, withStore ? root : undefined
            ));
        },
        pending() {
            return db.prepare('SELECT diary_name FROM kbm_pending_diary_asset_cleanup ORDER BY diary_name')
                .all().map(row => row.diary_name);
        },
        restart() { close(); open(); },
        dispose() { close(); fs.rmSync(root, { recursive: true, force: true }); }
    };
}

test('failed native unlink survives restart and recreated diary can publish again', async () => {
    const f = fixture();
    try {
        f.seed();
        const asset = f.repo._diaryBaselinePath('Gone', 'a');
        // A directory at a file target reliably rejects remove_file on every platform.
        fs.mkdirSync(asset);
        const legacy = asset.replace('_a.vec', '_slot_b.usearch.tmp');
        fs.writeFileSync(legacy, 'legacy');
        const first = await f.cleanup();
        assert.deepEqual(first.emptyDiaries, ['Gone']);
        assert.deepEqual(first.pendingAssetCleanup, ['Gone']);
        assert.deepEqual(f.pending(), ['Gone']);
        assert.equal(f.db.prepare('SELECT count(*) n FROM chunk_index_baselines').get().n, 0);
        assert.equal(fs.existsSync(legacy), false);
        f.restart();
        assert.deepEqual(f.pending(), ['Gone']);
        fs.rmdirSync(asset);
        fs.writeFileSync(asset, 'stale');
        const second = await f.cleanup();
        assert.deepEqual(second.emptyDiaries, []);
        assert.deepEqual(second.pendingAssetCleanup, []);
        assert.deepEqual(f.pending(), []);
        assert.equal(fs.existsSync(asset), false);

        fs.writeFileSync(path.join(f.notes, 'new.txt'), 'new');
        f.db.exec(`INSERT INTO files(id,path,diary_name,checksum,mtime,size)
            VALUES (1,'new.txt','Gone','hash',0,3)`);
        f.db.prepare(`INSERT INTO chunks(file_id,chunk_index,content,vector)
            VALUES (1,0,'new',?)`).run(Buffer.from(new Float32Array([1, 0]).buffer));
        const index = new VexusIndex(2, 32);
        await f.repo.restoreDiaryIndex('Gone', index, 32);
        f.repo.diaryIndices.set('Gone', index);
        f.runtime.registerDiaryIndex('Gone', index);
        assert.equal(await f.repo.publishDiaryBaseline('Gone'), true);
    } finally { f.dispose(); }
});

test('SQL-only retirement is durable and missing assets are acknowledged idempotently', async () => {
    const f = fixture();
    try {
        f.seed();
        const asset = f.repo._diaryBaselinePath('Gone', 'b');
        fs.writeFileSync(asset, 'stale');
        assert.deepEqual((await f.cleanup(false)).pendingAssetCleanup, ['Gone']);
        f.restart();
        assert.deepEqual(f.pending(), ['Gone']);
        // Simulate removal followed by process exit before acknowledgement.
        fs.unlinkSync(asset);
        assert.deepEqual((await f.cleanup()).pendingAssetCleanup, []);
        assert.deepEqual(f.pending(), []);
        assert.deepEqual((await f.cleanup()).pendingAssetCleanup, []);
    } finally { f.dispose(); }
});

test('pending retirement never removes a newly endorsed baseline or active diary assets', async () => {
    const f = fixture();
    try {
        f.seed();
        await f.cleanup(false);
        fs.writeFileSync(path.join(f.notes, 'live.txt'), 'live');
        f.db.exec(`INSERT INTO files(path,diary_name,checksum,mtime,size)
            VALUES ('live.txt','Gone','hash',0,4)`);
        f.seed();
        const asset = f.repo._diaryBaselinePath('Gone', 'a');
        fs.writeFileSync(asset, 'new endorsed asset');
        const result = await f.cleanup();
        assert.deepEqual(result.emptyDiaries, []);
        assert.deepEqual(f.pending(), []);
        assert.equal(fs.readFileSync(asset, 'utf8'), 'new endorsed asset');
        assert.equal(f.db.prepare('SELECT count(*) n FROM chunk_index_baselines').get().n, 1);
    } finally { f.dispose(); }
});

test('startup facade delegates disk cleanup to native runtime with store path', async () => {
    const kb = require('../KnowledgeBaseManager');
    const cleanup = Object.getPrototypeOf(kb)._cleanupDatabaseOrphansNative;
    const owner = {
        dbPath: 'fixture.sqlite',
        config: { rootPath: 'notes', storePath: 'vectors' },
        diaryDateIndexCache: new Map([['Gone', {}]]),
        nativeKnowledgeRuntime: {
            async cleanupDatabaseOrphans(...args) {
                assert.deepEqual(args, ['fixture.sqlite', 'notes', 'vectors']);
                return { emptyDiaries: ['Gone'], pendingAssetCleanup: ['Gone'] };
            }
        },
        _deletePersistedDiaryIndex() { assert.fail('JS must not delete outside native publication gate'); }
    };
    const receipt = await cleanup.call(owner);
    assert.deepEqual(receipt.pendingAssetCleanup, ['Gone']);
    assert.equal(owner.diaryDateIndexCache.size, 0);
});