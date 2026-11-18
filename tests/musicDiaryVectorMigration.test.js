'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { inspect, build } = require('../scripts/musicdiary-vector-bundle');

test('offline bundle: equal titles have independent identities; FP32 survives reopen; missing vectors never repaired', t => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-music-test-'));
    t.after(() => fs.rmSync(repo, {recursive:true, force:true}));
    const config = {repo, sourceRoot:path.join(repo,'dailynote'), dbFile:path.join(repo,'hot.sqlite'), dimension:3072, model:'fixture'};
    const dir = path.join(config.sourceRoot,'MusicDiary');
    fs.mkdirSync(dir,{recursive:true});
    const hot = new Database(config.dbFile);
    t.after(() => { if (hot.open) hot.close(); });
    hot.exec('CREATE TABLE files(id INTEGER PRIMARY KEY,path TEXT,diary_name TEXT,size INTEGER,checksum TEXT);CREATE TABLE chunks(file_id INTEGER,chunk_index INTEGER,content TEXT,vector BLOB)');
    const text = 'Moonlight';
    const md5 = crypto.createHash('md5').update(text).digest('hex');
    for (const id of [1,2]) {
        const name = `Moonlight-Artist${id}-Album.txt`;
        fs.writeFileSync(path.join(dir,name),text);
        hot.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(id,path.join('MusicDiary',name),'MusicDiary',Buffer.byteLength(text),md5);
        const b = Buffer.alloc(4*config.dimension);
        b.writeFloatLE(0.625,id*4);
        b.writeFloatLE(-0.03125,0);
        hot.prepare('INSERT INTO chunks VALUES(?,?,?,?)').run(id,0,text,b);
    }
    hot.close();
    const before = fs.readFileSync(config.dbFile);
    assert.deepEqual(inspect(config),{files:2,chunks:2,errors:[]});
    const out = build(config);
    const summary = JSON.parse(fs.readFileSync(path.join(out,'verified.json'),'utf8'));
    assert.equal(summary.chunks,2);
    assert.deepEqual(fs.readFileSync(config.dbFile),before);
    const manifest = new Database(path.join(out,'bundle.sqlite'),{readonly:true,fileMustExist:true});
    try {
        const rows = manifest.prepare('SELECT path,node_id,vector_sha256 FROM chunks ORDER BY path').all();
        assert.equal(rows.length,2);
        for (const key of ['path','node_id','vector_sha256']) assert.notEqual(rows[0][key],rows[1][key]);
    } finally {manifest.close();}
    const writer = new Database(config.dbFile);
    try {writer.exec('UPDATE chunks SET vector=NULL WHERE file_id=2');} finally {writer.close();}
    const bad = inspect(config);
    assert.equal(bad.files,1);
    assert.equal(bad.errors.length,1);
    assert.match(bad.errors[0],/Artist2.*missing\/wrong dimension/);
});