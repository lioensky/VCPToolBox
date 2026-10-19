'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { VexusIndex, NativeKnowledgeRuntime } = require('../rust-vexus-lite');
const IndexRepository = require('../modules/knowledgeBase/indexRepository');

const DIMENSION = 8;
const MODEL_SIG = 'tag-index-generational-test';
function vectorFor(id, salt = 0) {
    const v = new Float32Array(DIMENSION);
    for (let d = 0; d < DIMENSION; d++) v[d] = Math.sin((id + salt) * (d + 1) * 0.137);
    return v;
}

test('native Tag baseline replays facts, enforces threshold and alternates slots', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-tag-baseline-'));
    const dbPath = path.join(root, 'test.sqlite');
    const index = new VexusIndex(DIMENSION, 256);
    const runtime = new NativeKnowledgeRuntime(index);
    let db;
    try {
        runtime.openAndInitStore(dbPath);
        db = new Database(dbPath);
        const insert = db.prepare('INSERT INTO tags(id,name,vector) VALUES (?,?,?)');
        const add = (from, to) => db.transaction(() => {
            for (let id = from; id <= to; id++) insert.run(id, `tag-${id}`, Buffer.from(vectorFor(id).buffer));
        })();
        const config = { storePath: root, dimension: DIMENSION, modelSig: MODEL_SIG,
            persistTagIndex: true, tagIndexAllowInitial: true,
            persistFolders: new Set(), tagIndexBaselineDeltaRatio: 0.05 };
        const repository = new IndexRepository({ config, VexusIndex,
            getDbPath: () => dbPath, getNativeRuntime: () => runtime });
        repository.tagIndex = index;
        const baseline = () => JSON.parse(db.prepare(
            "SELECT value FROM kv_store WHERE key='tag_index_active_baseline'").get().value);
        const restore = async () => JSON.parse(await runtime.restoreGlobalTagIndex(
            dbPath, repository._tagBaselinePath('a'), MODEL_SIG, 256));
        add(1, 100);
        await restore();
        assert.equal(await repository.publishGlobalTagBaseline({ force: true }), true);
        assert.deepEqual(baseline(), { generation: 1, slot: 'a' });
        add(101, 104);
        assert.equal(await repository.publishGlobalTagBaseline(), false);
        const replay = await restore();
        assert.equal(replay.replayed, true);
        assert.equal(replay.vectorCount, 104);
        assert.equal(index.stats().totalVectors, 104);
        const hits = JSON.parse(await runtime.searchGlobalTags(vectorFor(104), 4));
        assert(hits.some(r => r.tag === 'tag-104'));
        db.prepare('UPDATE tags SET vector=? WHERE id=50').run(Buffer.from(vectorFor(50, 99).buffer));
        assert.equal(db.prepare('SELECT vector_version FROM tags WHERE id=50').get().vector_version, 2);
        assert.equal((await restore()).replayed, true);
        add(105, 106);
        await restore();
        assert.equal(await repository.publishGlobalTagBaseline(), true);
        assert.deepEqual(baseline(), { generation: 2, slot: 'b' });
        assert.equal(db.prepare('SELECT COUNT(*) n FROM tag_index_baselines').get().n, 1);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM tag_index_baseline_entries WHERE generation=2').get().n, 106);
        config.tagIndexPersistenceMode = 'always';
        assert.equal(await repository.saveToDisk('global_tags', { force: true }), false);
        assert.deepEqual(baseline(), { generation: 2, slot: 'b' });
    } finally {
        db?.close();
        runtime.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('restart preserves cumulative SQL drift and unchanged snapshots remain untouched', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-generation-restart-'));
    const dbPath = path.join(root, 'test.sqlite');
    const baselinePath = path.join(root, 'index_global_tags_a.vec');
    let runtime;
    let db;
    const open = async () => {
        const index = new VexusIndex(DIMENSION, 256);
        runtime = new NativeKnowledgeRuntime(index);
        runtime.openAndInitStore(dbPath);
        db = new Database(dbPath);
        const restored = JSON.parse(await runtime.restoreGlobalTagIndex(
            dbPath, baselinePath, MODEL_SIG, 256));
        return { index, restored };
    };
    const add = (from, to) => db.transaction(() => {
        const insert = db.prepare('INSERT INTO tags(id,name,vector) VALUES (?,?,?)');
        for (let id = from; id <= to; id++) {
            insert.run(id, `tag-${id}`, Buffer.from(vectorFor(id).buffer));
        }
    })();
    const checkpoint = () => runtime.checkpointGlobalTagIndex(
        dbPath, baselinePath, MODEL_SIG, 0.05, true, true
    ).then(JSON.parse);
    const stamp = () => fs.readdirSync(root).filter(name => name.endsWith('.vec'))
        .sort().map(name => {
            const file = path.join(root, name);
            return { name, modified: fs.statSync(file).mtimeMs,
                bytes: fs.readFileSync(file).toString('base64') };
        });
    const close = () => {
        db?.close();
        db = null;
        runtime?.shutdown();
        runtime = null;
    };
    try {
        await open();
        add(1, 100);
        await runtime.restoreGlobalTagIndex(dbPath, baselinePath, MODEL_SIG, 256);
        assert.equal((await checkpoint()).generation, 1);
        const published = stamp();
        add(101, 104);
        assert.equal((await checkpoint()).published, false);
        close();

        const restarted = await open();
        assert.equal(restarted.restored.generation, 1);
        assert.equal(restarted.restored.vectorCount, 104);
        assert.equal(restarted.index.stats().mmapBytes, 0);
        assert.equal((await checkpoint()).published, false);
        for (let attempt = 0; attempt < 3; attempt++) {
            const hits = JSON.parse(await runtime.searchGlobalTags(vectorFor(104), 4));
            assert(hits.some(hit => hit.tag === 'tag-104'));
        }
        assert.deepEqual(stamp(), published, 'restart, queries and sub-threshold checks must not rewrite assets');
        assert(!fs.readdirSync(root).some(name => /restore-source|checkpoint-source|maintenance\.vec/.test(name)));

        add(105, 106);
        await runtime.restoreGlobalTagIndex(dbPath, baselinePath, MODEL_SIG, 256);
        const next = await checkpoint();
        assert.equal(next.published, true);
        assert.equal(next.generation, 2);
        assert.equal(next.slot, 'b');
        assert.equal(next.delta, 6, 'restart must not reset the four earlier changes');
        const second = stamp();
        assert.equal((await checkpoint()).published, false, 'force must not publish zero drift');
        assert.deepEqual(stamp(), second);
    } finally {
        close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});