const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

process.env.KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP = 'false';
process.env.VECTORDB_DIMENSION = '3';

const knowledgeBaseManager = require('../KnowledgeBaseManager.js');
const TagMemoEngine = require('../TagMemoEngine.js');

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

test('KnowledgeBaseManager geodesicRerank uses configured defaults and explicit overrides', async () => {
    const previousTagMemoEngine = knowledgeBaseManager.tagMemoEngine;
    const previousRagParams = knowledgeBaseManager.ragParams;

    const calls = [];
    knowledgeBaseManager.ragParams = {
        KnowledgeBaseManager: {
            geodesicRerank: {
                alpha: 0.62,
                minGeoSamples: 7
            }
        }
    };
    knowledgeBaseManager.tagMemoEngine = {
        geodesicRerank(candidates, options) {
            calls.push({ candidates, options });
            return candidates;
        }
    };

    try {
        const candidates = [{ id: 1, score: 0.4 }];

        knowledgeBaseManager.geodesicRerank(candidates);
        assert.deepEqual(calls.at(-1).options, { alpha: 0.62, minGeoSamples: 7 });

        knowledgeBaseManager.geodesicRerank(candidates, { geoAlpha: 0.25 });
        assert.deepEqual(calls.at(-1).options, { alpha: 0.25, minGeoSamples: 7 });

        knowledgeBaseManager.geodesicRerank(candidates, { alpha: 0.33, minGeoSamples: 3 });
        assert.deepEqual(calls.at(-1).options, { alpha: 0.33, minGeoSamples: 3 });
    } finally {
        knowledgeBaseManager.tagMemoEngine = previousTagMemoEngine;
        knowledgeBaseManager.ragParams = previousRagParams;
    }
});

test('KnowledgeBaseManager search path passes geodesic tuning from ragParams when options omit it', async () => {
    const previousGetOrLoadDiaryIndex = knowledgeBaseManager._getOrLoadDiaryIndex;
    const previousTagMemoEngine = knowledgeBaseManager.tagMemoEngine;
    const previousRagParams = knowledgeBaseManager.ragParams;
    const previousDb = knowledgeBaseManager.db;
    const previousConfig = { ...knowledgeBaseManager.config };

    let capturedOptions = null;
    knowledgeBaseManager.config = { ...knowledgeBaseManager.config, dimension: 3 };
    knowledgeBaseManager.ragParams = {
        KnowledgeBaseManager: {
            geodesicRerank: {
                alpha: 0.71,
                minGeoSamples: 6
            }
        }
    };
    knowledgeBaseManager.tagMemoEngine = {
        lastEnergyField: new Map([[1, 1]]),
        geodesicRerank(candidates, options) {
            capturedOptions = options;
            return [];
        }
    };
    knowledgeBaseManager._getOrLoadDiaryIndex = async () => ({
        stats: () => ({ totalVectors: 1 }),
        search: () => [{ id: 1, score: 0.5 }]
    });
    knowledgeBaseManager.db = {
        prepare() {
            return {
                get: () => null,
                all: () => []
            };
        }
    };

    try {
        await knowledgeBaseManager._searchSpecificIndex(
            'Diary',
            [1, 0, 0],
            3,
            0,
            [],
            1.33,
            { geodesicRerank: true }
        );

        assert.deepEqual(capturedOptions, { alpha: 0.71, minGeoSamples: 6 });
    } finally {
        knowledgeBaseManager._getOrLoadDiaryIndex = previousGetOrLoadDiaryIndex;
        knowledgeBaseManager.tagMemoEngine = previousTagMemoEngine;
        knowledgeBaseManager.ragParams = previousRagParams;
        knowledgeBaseManager.db = previousDb;
        knowledgeBaseManager.config = previousConfig;
    }
});

test('TagMemoEngine geodesicRerank preserves legacy defaults when geodesic tuning is missing', () => {
    const engine = new TagMemoEngine(null, null, { dimension: 3 }, { KnowledgeBaseManager: {} });
    engine.lastEnergyField = new Map([
        [100, 1],
        [101, 1],
        [102, 1],
        [103, 1],
        [200, 0.1],
        [201, 0.1],
        [202, 0.1],
        [203, 0.1]
    ]);
    engine._queryByChunks = (sqlPrefix, values) => {
        if (sqlPrefix.includes('SELECT id, file_id FROM chunks')) {
            return values.map(id => ({ id, file_id: id + 10 }));
        }
        if (sqlPrefix.includes('SELECT file_id, tag_id FROM file_tags')) {
            return [
                { file_id: 11, tag_id: 100 },
                { file_id: 11, tag_id: 101 },
                { file_id: 11, tag_id: 102 },
                { file_id: 11, tag_id: 103 },
                { file_id: 12, tag_id: 200 },
                { file_id: 12, tag_id: 201 },
                { file_id: 12, tag_id: 202 },
                { file_id: 12, tag_id: 203 }
            ];
        }
        return [];
    };

    const reranked = engine.geodesicRerank([
        { id: 1, score: 0.2 },
        { id: 2, score: 0.3 }
    ]);

    assert.equal(reranked[0].id, 1);
    assert.ok(Math.abs(reranked[0].score - 0.44) < 1e-12);
    assert.equal(reranked[0].geo_hit_count, 4);
    assert.equal(reranked[1].id, 2);
});

test('TagMemoEngine geodesicRerank falls back when geodesic tuning is invalid', () => {
    const engine = new TagMemoEngine(null, null, { dimension: 3 }, {
        KnowledgeBaseManager: {
            geodesicRerank: {
                alpha: 'not-a-number',
                minGeoSamples: 4
            }
        }
    });
    const candidates = [{ id: 1, score: 0.4 }];
    engine.lastEnergyField = new Map([[1, 1]]);

    assert.equal(engine.geodesicRerank(candidates), candidates);
});

test('TagMemoEngine geodesicRerank clamps alpha and floors minGeoSamples from ragParams', () => {
    const engine = new TagMemoEngine(null, null, { dimension: 3 }, {
        KnowledgeBaseManager: {
            geodesicRerank: {
                alpha: 2,
                minGeoSamples: 1.8
            }
        }
    });
    engine.lastEnergyField = new Map([
        [100, 1],
        [200, 0.1]
    ]);
    engine._queryByChunks = (sqlPrefix, values) => {
        if (sqlPrefix.includes('SELECT id, file_id FROM chunks')) {
            return values.map(id => ({ id, file_id: id + 10 }));
        }
        if (sqlPrefix.includes('SELECT file_id, tag_id FROM file_tags')) {
            return [
                { file_id: 11, tag_id: 100 },
                { file_id: 12, tag_id: 200 }
            ];
        }
        return [];
    };

    const reranked = engine.geodesicRerank([
        { id: 1, score: 0.2 },
        { id: 2, score: 0.9 }
    ]);

    assert.equal(reranked[0].id, 1);
    assert.equal(reranked[0].score, 1);
    assert.equal(reranked[0].original_knn_score, 0.2);
    assert.equal(reranked[0].geo_hit_count, 1);
});

test('RAGDiary and LightMemo pass geodesic tuning without hardcoded defaults', () => {
    const repoRoot = path.join(__dirname, '..');
    const ragSource = fs.readFileSync(path.join(repoRoot, 'Plugin', 'RAGDiaryPlugin', 'RAGDiaryPlugin.js'), 'utf8');
    const lightMemoSource = fs.readFileSync(path.join(repoRoot, 'Plugin', 'LightMemo', 'LightMemo.js'), 'utf8');

    assert.match(ragSource, /geoAlpha:\s*geoConfig\.alpha/);
    assert.match(ragSource, /minGeoSamples:\s*geoConfig\.minGeoSamples/);
    assert.doesNotMatch(ragSource, /geoConfig\.alpha\s*\?\?\s*0\.3/);
    assert.doesNotMatch(ragSource, /geoConfig\.minGeoSamples\s*\?\?\s*4/);

    assert.match(lightMemoSource, /alpha:\s*geoConfig\.alpha/);
    assert.match(lightMemoSource, /minGeoSamples:\s*geoConfig\.minGeoSamples/);
    assert.doesNotMatch(lightMemoSource, /geoConfig\.alpha\s*\?\?\s*0\.3/);
    assert.doesNotMatch(lightMemoSource, /geoConfig\.minGeoSamples\s*\?\?\s*4/);
});
