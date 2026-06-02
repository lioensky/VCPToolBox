const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP = 'false';
process.env.VECTORDB_DIMENSION = '3';

const knowledgeBaseManager = require('../KnowledgeBaseManager.js');

function vectorBuffer(values) {
    const vector = new Float32Array(values);
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function createDb() {
    const db = new Database(':memory:');
    db.exec(`
        CREATE TABLE files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            diary_name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            mtime INTEGER NOT NULL,
            size INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            vector BLOB
        );
    `);
    return db;
}

function insertFile(db, { path, checksum = 'same', size = 10, updatedAt = 1 }) {
    return db.prepare(`
        INSERT INTO files (path, diary_name, checksum, mtime, size, updated_at)
        VALUES (?, 'Diary', ?, 1, ?, ?)
    `).run(path, checksum, size, updatedAt).lastInsertRowid;
}

function insertChunk(db, fileId, chunkIndex, vector) {
    db.prepare(`
        INSERT INTO chunks (file_id, chunk_index, content, vector)
        VALUES (?, ?, ?, ?)
    `).run(fileId, chunkIndex, `chunk-${chunkIndex}`, vector);
}

async function withManagerDb(fn) {
    const previousDb = knowledgeBaseManager.db;
    const previousConfig = { ...knowledgeBaseManager.config };
    const db = createDb();

    knowledgeBaseManager.db = db;
    knowledgeBaseManager.config = {
        ...knowledgeBaseManager.config,
        dimension: 3,
        reuseChunkVectors: false
    };

    try {
        await fn(db);
    } finally {
        knowledgeBaseManager.db = previousDb;
        knowledgeBaseManager.config = previousConfig;
        db.close();
    }
}

test('_hasCompleteStoredVectorsForFile requires every chunk vector to have the expected byte length', async () => {
    await withManagerDb(async (db) => {
        const completeFileId = insertFile(db, { path: 'Diary/complete.txt' });
        insertChunk(db, completeFileId, 0, vectorBuffer([1, 2, 3]));
        insertChunk(db, completeFileId, 1, vectorBuffer([4, 5, 6]));

        const missingFileId = insertFile(db, { path: 'Diary/missing-vector.txt' });
        insertChunk(db, missingFileId, 0, null);

        const badLengthFileId = insertFile(db, { path: 'Diary/bad-length.txt' });
        insertChunk(db, badLengthFileId, 0, Buffer.from([1, 2, 3, 4]));

        assert.equal(knowledgeBaseManager._hasCompleteStoredVectorsForFile('Diary/complete.txt'), true);
        assert.equal(knowledgeBaseManager._hasCompleteStoredVectorsForFile('Diary/missing-vector.txt'), false);
        assert.equal(knowledgeBaseManager._hasCompleteStoredVectorsForFile('Diary/bad-length.txt'), false);
        assert.equal(knowledgeBaseManager._hasCompleteStoredVectorsForFile('Diary/not-indexed.txt'), false);
    });
});

test('_shouldSkipStoredFileAfterContentRead skips same-checksum files with zero embeddable chunks', async () => {
    await withManagerDb(async (db) => {
        insertFile(db, { path: 'Diary/empty.txt', checksum: 'empty-checksum' });
        const row = db.prepare('SELECT checksum, mtime, size FROM files WHERE path = ?').get('Diary/empty.txt');

        assert.deepEqual(knowledgeBaseManager._prepareChunksForEmbedding(['   ', '\u{1F642}']), []);
        assert.equal(
            knowledgeBaseManager._shouldSkipStoredFileAfterContentRead(row, 'Diary/empty.txt', 'empty-checksum', []),
            true
        );
        assert.equal(
            knowledgeBaseManager._shouldSkipStoredFileAfterContentRead(row, 'Diary/empty.txt', 'empty-checksum', ['text']),
            false
        );
        assert.equal(
            knowledgeBaseManager._shouldSkipStoredFileAfterContentRead(row, 'Diary/empty.txt', 'changed-checksum', []),
            false
        );
    });
});

test('_findReusableChunkVectors requires opt-in and skips invalid matching checksum candidates', async () => {
    await withManagerDb(async (db) => {
        const invalidCandidateId = insertFile(db, {
            path: 'Diary/invalid-copy.txt',
            checksum: 'copy-checksum',
            size: 42,
            updatedAt: 20
        });
        insertChunk(db, invalidCandidateId, 0, vectorBuffer([9, 9, 9]));

        const validCandidateId = insertFile(db, {
            path: 'Diary/original.txt',
            checksum: 'copy-checksum',
            size: 42,
            updatedAt: 10
        });
        insertChunk(db, validCandidateId, 0, vectorBuffer([1, 2, 3]));
        insertChunk(db, validCandidateId, 1, vectorBuffer([4, 5, 6]));

        const vectors = knowledgeBaseManager._findReusableChunkVectors({
            relPath: 'Diary/moved.txt',
            checksum: 'copy-checksum',
            size: 42,
            chunks: ['first', 'second']
        });

        assert.equal(vectors, null);

        knowledgeBaseManager.config.reuseChunkVectors = true;
        const optedInVectors = knowledgeBaseManager._findReusableChunkVectors({
            relPath: 'Diary/moved.txt',
            checksum: 'copy-checksum',
            size: 42,
            chunks: ['first', 'second']
        });

        assert.equal(optedInVectors.length, 2);
        assert.deepEqual(Array.from(optedInVectors[0]), [1, 2, 3]);
        assert.deepEqual(Array.from(optedInVectors[1]), [4, 5, 6]);
        assert.equal(optedInVectors[0] instanceof Float32Array, true);

        const noMatch = knowledgeBaseManager._findReusableChunkVectors({
            relPath: 'Diary/new.txt',
            checksum: 'other-checksum',
            size: 42,
            chunks: ['first', 'second']
        });

        assert.equal(noMatch, null);
    });
});
