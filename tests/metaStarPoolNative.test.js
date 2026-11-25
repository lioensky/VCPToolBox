'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const MetaThinkingManager = require('../Plugin/RAGDiaryPlugin/MetaThinkingManager');

test('Vexus star-pool snapshot hydrates vectors and EPA, without a JS SQLite connection', async (t) => {
    const { VexusIndex, NativeKnowledgeRuntime } = process.env.VCP_TEST_NATIVE_BINDING
        ? require(path.resolve(process.env.VCP_TEST_NATIVE_BINDING))
        : require('../rust-vexus-lite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-meta-native-'));
    const dbPath = path.join(dir, 'knowledge_base.sqlite');
    const vector = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
    const mean = Buffer.from(new Float32Array([0, 1, 0, 0]).buffer).toString('base64');
    const payload = JSON.stringify({ artifactSig: 'fixture', mean });
    let runtime;
    t.after(() => {
        runtime?.shutdown();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // Bootstrap schema first, then seed only while Vexus is closed.
    const bootstrap = new NativeKnowledgeRuntime(new VexusIndex(4, 32));
    try {
        bootstrap.openAndInitStore(dbPath);
    } finally {
        bootstrap.shutdown();
    }
    const seed = new Database(dbPath);
    try {
        seed.exec(`
            INSERT INTO files(id,path,diary_name,checksum,mtime,size,updated_at) VALUES
                (1,'星甲.md','星池','x',0,0,1), (2,'别池.md','其他','y',0,0,1);
        `);
        const insert = seed.prepare('INSERT INTO chunks(id,file_id,chunk_index,content,vector) VALUES (?,?,0,?,?)');
        insert.run(8, 1, '星甲', vector);
        insert.run(9, 2, '别池', vector);
        seed.prepare("INSERT INTO kv_store(key,value) VALUES ('epa_basis_cache',?)").run(payload);
    } finally {
        seed.close();
    }

    runtime = new NativeKnowledgeRuntime(new VexusIndex(4, 32));
    runtime.openAndInitStore(dbPath);
    const vdb = { dbPath, readMetaStarPool: (names, fp) => runtime.readMetaStarPool(dbPath, names, fp) };
    const snapshot = await vdb.readMetaStarPool(['星池']);
    assert.equal(snapshot.epaDigest, createHash('sha256').update(payload).digest('hex').slice(0, 16));
    assert.equal(snapshot.epaMean, mean);
    assert.deepEqual(snapshot.rows.map(row => [row.chunkId, row.fileId, row.sourceFile, row.vector]), [[8, 1, '星甲.md', vector]]);
    const unchanged = await vdb.readMetaStarPool(['星池'], snapshot.fingerprint);
    assert.equal(unchanged.fingerprint, snapshot.fingerprint);
    assert.equal(unchanged.rows ?? null, null);
    assert.deepEqual((await vdb.readMetaStarPool(['不存在'])).rows, []);

    const manager = new MetaThinkingManager({});
    const first = await manager._v3LoadStarPoolCache(vdb, ['星池'], null, { ttlMs: 0 });
    assert.deepEqual(Array.from(first.epaMean), [0, 1, 0, 0]);
    assert.strictEqual(await manager._v3LoadStarPoolCache(vdb, ['星池'], null, { ttlMs: 0 }), first);
    assert.equal(await manager._v3LoadStarPoolCache({ dbPath }, ['其他'], null, { ttlMs: 0 }), null);
});

test('concurrent refreshes of the same scope do not duplicate the initial read', async () => {
    const manager = new MetaThinkingManager({});
    const dbPath = path.join(os.tmpdir(), 'vcp-mock-meta.sqlite');
    let reads = 0;
    const vdb = {
        dbPath,
        async readMetaStarPool() {
            reads++;
            await new Promise(resolve => setImmediate(resolve));
            return {
                fingerprint: '1',
                rows: [{
                    chunkId: 1, fileId: 1, vectorVersion: 1,
                    text: '星甲', sourceFile: '星甲.md', diaryName: '星池',
                    vector: Buffer.from(new Float32Array([1, 0, 0, 0]).buffer)
                }]
            };
        }
    };
    const [first, second] = await Promise.all([
        manager._v3LoadStarPoolCache(vdb, ['星池'], null),
        manager._v3LoadStarPoolCache(vdb, ['星池'], null)
    ]);
    assert.ok(first);
    assert.strictEqual(first, second);
    assert.equal(reads, 1);
    assert.equal(manager._v3StarPoolReads.size, 0);
});