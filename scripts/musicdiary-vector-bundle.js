'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const library = 'MusicDiary';
const hash = (data, algorithm = 'sha256') => crypto.createHash(algorithm).update(data).digest('hex');
const check = (ok, msg) => { if (!ok) throw new Error(msg); };

function inspect({ dbFile, sourceRoot, dimension }, visit = () => {}) {
    const dir = path.join(sourceRoot, library);
    check(fs.lstatSync(dir).isDirectory(), `Expected directory: ${dir}`);
    const names = new Set();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        check(e.isFile() && /\.txt$/i.test(e.name), `Unexpected entry: ${e.name}`);
        names.add(e.name);
    }
    check(names.size > 0, 'Empty music source');
    const hot = new Database(dbFile, { readonly: true, fileMustExist: true });
    const report = { files: 0, chunks: 0, errors: [] };
    try {
        hot.pragma('query_only = ON');
        hot.transaction(() => {
            const chunks = hot.prepare('SELECT chunk_index, content, vector FROM chunks WHERE file_id=? ORDER BY chunk_index');
            const files = hot.prepare('SELECT id,path,size,checksum FROM files WHERE diary_name=? ORDER BY path');
            for (const f of files.iterate(library)) {
                let record;
                try {
                    const parts = f.path.split(/[\\/]/);
                    check(parts.length === 2 && parts[0] === library && names.delete(parts[1]), 'Missing, duplicate or unexpected path');
                    const name = parts[1];
                    const bytes = fs.readFileSync(path.join(dir, name));
                    const content = bytes.toString('utf8');
                    check(bytes.length === f.size && hash(content, 'md5') === f.checksum, 'File differs from hot snapshot');
                    // Migrate the stored text/vector pairs, not a reconstruction with today's chunker.
                    const rows = chunks.all(f.id);
                    check(rows.length > 0, 'No stored chunks');
                    for (const [i, r] of rows.entries()) {
                        check(r.chunk_index === i, `Unexpected stored chunk index ${r.chunk_index}; expected ${i}`);
                        check(typeof r.content === 'string' && r.content.trim().length > 0, `Chunk ${i} missing stored text`);
                        check(Buffer.isBuffer(r.vector) && r.vector.length === 4 * dimension, `Chunk ${i} missing/wrong dimension`);
                        let nonzero = false;
                        for (let j = 0; j < r.vector.length; j += 4) {
                            const v = r.vector.readFloatLE(j);
                            check(Number.isFinite(v), `Chunk ${i} nonfinite`);
                            if (v !== 0) nonzero = true;
                        }
                        check(nonzero, `Chunk ${i} zero vector`);
                    }
                    record = { name, bytes, rows, rel: path.join(library, name), checksum: hash(content) };
                } catch (e) { report.errors.push(`${f.path}: ${e.message}`); continue; }
                visit(record); // Output errors are fatal, not source mismatches.
                report.files++;
                report.chunks += record.rows.length;
            }
            for (const name of names) report.errors.push(`${name}: no hot file record`);
        })();
    } finally { hot.close(); }
    return report;
}

function build(config) {
    const { TriviumDB } = require('triviumdb');
    // Only create a NEW sibling under the repository root; no caller-chosen output path.
    const out = fs.mkdtempSync(path.join(config.repo, '.musicdiary-stage-'));
    console.log(`Private staging directory: ${out}`);
    const source = path.join(out, library);
    fs.mkdirSync(source);
    const manifest = new Database(path.join(out, 'bundle.sqlite'));
    const tdb = path.join(out, library + '.tdb');
    const options = { dim: config.dimension, dtype: 'f32', storageMode: 'mmap', syncMode: 'normal', loadTextIndex: true, autoBuildQuiver: true };
    let db;
    try {
        manifest.exec(`CREATE TABLE files(path TEXT PRIMARY KEY,checksum TEXT NOT NULL,size INTEGER NOT NULL);
            CREATE TABLE chunks(path TEXT NOT NULL,chunk_index INTEGER NOT NULL,node_id INTEGER UNIQUE NOT NULL,checksum TEXT NOT NULL,vector_sha256 TEXT NOT NULL,PRIMARY KEY(path,chunk_index));`);
        const file = manifest.prepare('INSERT INTO files VALUES(?,?,?)');
        const chunk = manifest.prepare('INSERT INTO chunks VALUES(?,?,?,?,?)');
        db = new TriviumDB(tdb, options);
        const report = manifest.transaction(() => inspect(config, r => {
            fs.writeFileSync(path.join(source, r.name), r.bytes, { flag: 'wx' });
            file.run(r.rel, r.checksum, r.bytes.length);
            let previous = null;
            for (const row of r.rows) {
                const vector = Array.from({length: config.dimension}, (_, j) => row.vector.readFloatLE(j * 4));
                const checksum = hash(row.content);
                const [id] = db.batchInsert([vector], [{ type: 'chunk', library, source_path: r.rel,
                    chunk_index: row.chunk_index, text_preview: row.content.slice(0, 500), checksum,
                    updated_at: Math.floor(Date.now()/1000) }]);
                db.indexText(id, row.content);
                const title = path.parse(r.name).name;
                if (title.length >= 2) db.indexKeyword(id, title);
                if (previous !== null) { db.link(previous, id, 'next', 0.7); db.link(id, previous, 'prev', 0.7); }
                previous = id;
                chunk.run(r.rel, row.chunk_index, id, checksum, hash(row.vector));
            }
        }))();
        check(!report.errors.length, JSON.stringify(report.errors));
        db.buildTextIndex();
        db.flush();
        db.close(); db = null;
        db = new TriviumDB(tdb, options);
        assert.equal(db.nodeCount(), report.chunks);
        for (const row of manifest.prepare('SELECT * FROM chunks').iterate()) {
            const node = db.get(row.node_id);
            assert.equal(node.payload.source_path, row.path);
            assert.equal(node.payload.chunk_index, row.chunk_index);
            assert.equal(node.payload.checksum, row.checksum);
            assert.equal(node.vector.length, config.dimension);
            const raw = Buffer.allocUnsafe(config.dimension * 4);
            for (let i = 0; i < config.dimension; i++) raw.writeFloatLE(node.vector[i], i * 4);
            assert.equal(hash(raw), row.vector_sha256, `FP32 verification failed: ${row.path}`);
        }
        db.close(); db = null;
        manifest.close();
        fs.writeFileSync(path.join(out, 'verified.json'), JSON.stringify({ ...report, dimension: config.dimension,
            model: config.model, modelSig: config.modelSig, platform: process.platform }, null, 2), {flag:'wx'});
        return out;
    } finally { try { db?.close(); } finally { if (manifest.open) manifest.close(); } }
}

function configuration(repo) {
    const env = process.env;
    const model = env.WhitelistEmbeddingModel || 'google/gemini-embedding-001';
    check(model === (env.TDB_KNOWLEDGE_MODEL || model), 'Hot/cold configured models differ');
    const dimension = Number(env.VECTORDB_DIMENSION || 3072);
    check(Number.isSafeInteger(dimension) && dimension > 0 &&
        dimension === Number(env.TDB_KNOWLEDGE_DIMENSION || dimension), 'Hot/cold dimensions differ');
    const abs = (v, d) => path.resolve(repo, v || d);
    return {repo, model, modelSig: env.EmbeddingModelSig || null, dimension,
        dbFile: path.join(abs(env.KNOWLEDGEBASE_STORE_PATH, 'VectorStore'), 'knowledge_base.sqlite'),
        sourceRoot: abs(env.KNOWLEDGEBASE_ROOT_PATH, 'dailynote')};
}

if (require.main === module) {
    try {
        const repo = path.resolve(__dirname, '..');
        process.chdir(repo);
        const loaded = require('dotenv').config({path:path.join(repo, 'config.env')});
        if (loaded.error) throw loaded.error;
        const args = process.argv.slice(2);
        check(args.length <= 1 && (!args.length || ['--dry-run','--build'].includes(args[0])), 'Usage: node scripts/musicdiary-vector-bundle.js [--dry-run|--build]');
        const config = configuration(repo);
        const report = inspect(config);
        console.log(JSON.stringify({ ...report, model:config.model, modelSig:config.modelSig, dimension:config.dimension }, null, 2));
        check(!report.errors.length, 'Source verification failed; nothing published');
        if (args[0] === '--build') console.log(`Verified bundle: ${build(config)}`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { inspect, build, configuration };