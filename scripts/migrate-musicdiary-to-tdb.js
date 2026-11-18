'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { configuration, inspect, build } = require('./musicdiary-vector-bundle');
const library = 'MusicDiary';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function publish(config, root, store) {
    // The operator must keep backends using these stores stopped while publishing.
    assert.equal(process.platform, 'win32', 'Publisher currently supports the Windows backend only');
    // Require an initialized cold store: never accidentally create a second production manifest.
    const meta = new Database(path.join(store,'tdb_knowledge_meta.sqlite'), {fileMustExist:true});
    let staged;
    const target = path.join(root, library);
    function emptyTarget() {
        assert(!fs.existsSync(target), `Target exists: ${target}`);
        assert(!fs.readdirSync(store).some(n => /^musicdiary\.tdb(?:\.|$)/i.test(n)), 'Existing cold database or sidecar');
        for (const t of ['files','chunks','ingest_queue'])
            assert(!meta.prepare(`SELECT 1 FROM ${t} WHERE library=? COLLATE NOCASE LIMIT 1`).get(library), `Existing ${t} rows for ${library}`);
    }
    try {
        emptyTarget();
        const real = p => fs.realpathSync.native(p).toLowerCase();
        assert.notEqual(real(root), real(config.sourceRoot), 'Cold and hot roots coincide');
        // Never stage under any watched root, even with custom paths.
        for (const watched of [root,config.sourceRoot]) {
            const rel = path.relative(real(watched),real(config.repo));
            assert(rel.startsWith('..'+path.sep) || rel==='..' || path.isAbsolute(rel), 'Repository staging location is under a watched root');
        }
        const out = build(config);
        staged = new Database(path.join(out,'bundle.sqlite'), {readonly:true,fileMustExist:true});
        const members = fs.readdirSync(out).filter(n => /^MusicDiary\.tdb(?:\.|$)/.test(n));
        assert(members.includes('MusicDiary.tdb'));
        const files = staged.prepare('SELECT * FROM files ORDER BY path');
        const chunks = staged.prepare('SELECT * FROM chunks ORDER BY path,chunk_index');
        // Track ONLY objects created by this invocation. A hard crash may leave an unpublished
        // target: next run refuses it, and the original hot store remains authoritative.
        const owned = [];
        let dirOwned = false;
        try {
            meta.transaction(() => {
                emptyTarget();
                fs.mkdirSync(target); dirOwned = true;
                const addFile = meta.prepare('INSERT INTO files(library,path,checksum,mtime,size,doc_node_id,updated_at) VALUES(?,?,?,?,?,NULL,?)');
                const addChunk = meta.prepare('INSERT INTO chunks(library,path,chunk_index,node_id,checksum) VALUES(?,?,?,?,?)');
                const now = Math.floor(Date.now()/1000);
                function copy(src,dst) {
                    fs.copyFileSync(src,dst,fs.constants.COPYFILE_EXCL);
                    owned.push(dst);
                }
                for (const n of members) copy(path.join(out,n), path.join(store,n));
                for (const f of files.iterate()) {
                    const dst = path.join(root,f.path);
                    assert.equal(path.dirname(dst),target);
                    copy(path.join(out,f.path), dst);
                    assert.equal(sha(fs.readFileSync(dst)), f.checksum);
                    const stat = fs.statSync(dst);
                    assert.equal(stat.size,f.size);
                    addFile.run(library,f.path,f.checksum,stat.mtimeMs,f.size,now);
                }
                for (const r of chunks.iterate()) addChunk.run(library,r.path,r.chunk_index,r.node_id,r.checksum);
            }).immediate();
        } catch (error) {
            for (const p of owned.reverse()) fs.unlinkSync(p);
            if (dirOwned) fs.rmdirSync(target);
            throw error;
        }
        console.log(`Published cold copy. Verified staging and hot source retained. Stage: ${out}`);
    } finally { try { staged?.close(); } finally { meta.close(); } }
}

if (require.main === module) {
    try {
        const repo = path.resolve(__dirname,'..');
        process.chdir(repo);
        const loaded = require('dotenv').config({path:path.join(repo,'config.env')});
        if (loaded.error) throw loaded.error;
        const args = process.argv.slice(2);
        assert(args.length <= 1 && (!args.length || ['--apply','--dry-run'].includes(args[0])), 'Expected --dry-run (default) or --apply');
        const config = configuration(repo);
        if (args[0] === '--apply') {
            assert.equal(String(process.env.TDB_KNOWLEDGE_ENABLED).toLowerCase(),'true','Cold store disabled');
            publish(config, path.resolve(process.env.TDB_KNOWLEDGE_ROOT_PATH || 'knowledge'), path.resolve(process.env.TDB_KNOWLEDGE_STORE_PATH || 'VectorStoreTDB'));
        } else {
            const report = inspect(config);
            console.log(JSON.stringify({...report, model:config.model, modelSig:config.modelSig, dimension:config.dimension},null,2));
            if (report.errors.length) process.exitCode=1;
        }
    } catch (e) { console.error(e.message); process.exitCode=1; }
}