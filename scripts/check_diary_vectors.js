require('dotenv').config({ path: './config.env' });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { chunkText } = require('../TextChunker');

const diary = process.argv[2] || '小克的学习';
const root = process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(__dirname, '..', 'dailynote');
const store = process.env.KNOWLEDGEBASE_STORE_PATH || path.join(__dirname, '..', 'VectorStore');
const dim = parseInt(process.env.VECTORDB_DIMENSION, 10) || 3072;
const expectedBytes = dim * Float32Array.BYTES_PER_ELEMENT;
const dir = path.join(root, diary);
const dbPath = path.join(store, 'knowledge_base.sqlite');

function prepareTextForEmbedding(text) {
    const decorativeEmojis = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
    const cleaned = text.replace(decorativeEmojis, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
    return cleaned.length === 0 ? '[EMPTY_CONTENT]' : cleaned;
}

function walk(d, out = []) {
    if (!fs.existsSync(d)) return out;

    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) {
            walk(p, out);
        } else if (ent.isFile() && /\.(md|txt)$/i.test(ent.name)) {
            out.push(p);
        }
    }

    return out;
}

if (!fs.existsSync(dbPath)) {
    console.error(`SQLite database not found: ${dbPath}`);
    process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

try {
    const fsFiles = walk(dir).map(p => path.relative(root, p));
    const dbFiles = db.prepare(`
        SELECT id, path, checksum, size, mtime
        FROM files
        WHERE diary_name = ?
        ORDER BY path
    `).all(diary);

    const chunkRows = db.prepare(`
        SELECT
            f.path,
            COUNT(c.id) AS chunks,
            SUM(CASE WHEN c.vector IS NOT NULL THEN 1 ELSE 0 END) AS vectors,
            SUM(CASE WHEN c.vector IS NOT NULL AND length(c.vector) = ? THEN 1 ELSE 0 END) AS valid_vectors,
            SUM(CASE WHEN c.vector IS NOT NULL AND length(c.vector) != ? THEN 1 ELSE 0 END) AS bad_vectors
        FROM files f
        LEFT JOIN chunks c ON c.file_id = f.id
        WHERE f.diary_name = ?
        GROUP BY f.id, f.path
        ORDER BY f.path
    `).all(expectedBytes, expectedBytes, diary);

    const chunkMap = new Map(chunkRows.map(r => [r.path, r]));
    const dbPathSet = new Set(dbFiles.map(f => f.path));
    const fsPathSet = new Set(fsFiles);

    let expectedChunks = 0;
    let dbChunks = 0;
    let dbVectors = 0;
    let validVectors = 0;
    let badVectors = 0;
    const mismatches = [];

    for (const rel of fsFiles) {
        const abs = path.join(root, rel);
        const content = fs.readFileSync(abs, 'utf8');
        const checksum = crypto.createHash('md5').update(content).digest('hex');
        const expected = chunkText(content)
            .map(prepareTextForEmbedding)
            .filter(c => c !== '[EMPTY_CONTENT]').length;

        expectedChunks += expected;

        const row = chunkMap.get(rel);
        const chunks = row?.chunks || 0;
        const vectors = row?.vectors || 0;
        const valid = row?.valid_vectors || 0;
        const bad = row?.bad_vectors || 0;

        dbChunks += chunks;
        dbVectors += vectors;
        validVectors += valid;
        badVectors += bad;

        const dbFile = dbFiles.find(f => f.path === rel);
        const checksumMismatch = dbFile ? dbFile.checksum !== checksum : true;

        if (!row || chunks !== expected || vectors !== chunks || valid !== vectors || bad > 0 || checksumMismatch) {
            mismatches.push({
                path: rel,
                expectedChunks: expected,
                dbChunks: chunks,
                vectors,
                validVectors: valid,
                badVectors: bad,
                checksumMismatch
            });
        }
    }

    const missingInDb = fsFiles.filter(p => !dbPathSet.has(p));
    const staleInDb = dbFiles.map(f => f.path).filter(p => !fsPathSet.has(p));

    const summary = {
        dbPath,
        root,
        diary,
        dimension: dim,
        expectedVectorBytes: expectedBytes,
        physicalFiles: fsFiles.length,
        dbFiles: dbFiles.length,
        expectedChunks,
        dbChunks,
        dbVectors,
        validVectors,
        badVectors,
        missingInDb: missingInDb.length,
        staleInDb: staleInDb.length,
        mismatchCount: mismatches.length,
        allGood: fsFiles.length === dbFiles.length &&
            expectedChunks === dbChunks &&
            dbChunks === dbVectors &&
            dbVectors === validVectors &&
            badVectors === 0 &&
            missingInDb.length === 0 &&
            staleInDb.length === 0 &&
            mismatches.length === 0,
        missingInDbSample: missingInDb.slice(0, 20),
        staleInDbSample: staleInDb.slice(0, 20),
        mismatches: mismatches.slice(0, 50)
    };

    console.log(JSON.stringify(summary, null, 2));
} finally {
    db.close();
}