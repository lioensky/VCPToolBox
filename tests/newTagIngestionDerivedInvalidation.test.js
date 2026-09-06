'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
    initializeKnowledgeBaseSchema
} = require('../modules/knowledgeBase/schemaManager');

const DIMENSION = 8;

function vectorFor(seed) {
    const vector = new Float32Array(DIMENSION);
    for (let index = 0; index < DIMENSION; index++) {
        vector[index] = ((seed + 1) * (index + 3) % 17 + 1) / 18;
    }
    return vector;
}

function vectorBuffer(vector) {
    return Buffer.from(
        vector.buffer,
        vector.byteOffset,
        vector.byteLength
    );
}

function createDatabaseProxy(db, preparedSql) {
    return new Proxy(db, {
        get(target, property) {
            if (property === 'prepare') {
                return sql => {
                    preparedSql.push(String(sql).replace(/\s+/g, ' ').trim());
                    return target.prepare(sql);
                };
            }
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
}

async function run() {
    const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'vcp-new-tag-ingestion-')
    );
    const diaryRoot = path.join(tempRoot, 'dailynote');
    const diaryDir = path.join(diaryRoot, 'test-diary');
    const filePath = path.join(diaryDir, 'memory.md');
    const dbPath = path.join(tempRoot, 'knowledge_base.sqlite');
    fs.mkdirSync(diaryDir, { recursive: true });
    fs.writeFileSync(
        filePath,
        'A new memory body.\n\nTag: brand-new-tag',
        'utf8'
    );

    const db = new Database(dbPath);
    try {
        initializeKnowledgeBaseSchema(db, {
            logPrefix: 'NewTagIngestionTest'
        });

        const insertTag = db.prepare(
            'INSERT INTO tags (id, name, vector) VALUES (?, ?, ?)'
        );
        insertTag.run(1, 'existing-a', vectorBuffer(vectorFor(1)));
        insertTag.run(2, 'existing-b', vectorBuffer(vectorFor(2)));
        db.prepare(`
            INSERT INTO tag_pair_similarity
                (tag_a, tag_b, similarity, model_sig, computed_at)
            VALUES (1, 2, 0.75, 'test-model', 1)
        `).run();

        const artifactSig = 'existing-pair-artifact';
        db.prepare(`
            INSERT INTO tagmemo_artifacts
                (artifact_sig, asset_type, model_sig, graph_generation,
                 algorithm_version, config_hash, effective_config, status,
                 created_at, updated_at)
            VALUES (?, 'pairwise_similarity', 'test-model', 'generation-1',
                    'test-algorithm', 'test-config', '{}', 'ready', 1, 1)
        `).run(artifactSig);
        db.prepare(`
            INSERT INTO tag_pair_similarity_status
                (tag_a, tag_b, model_sig, artifact_sig, status, similarity,
                 min_similarity, computed_at)
            VALUES (1, 2, 'test-model', ?, 'computed', 0.75, 0.05, 1)
        `).run(artifactSig);

        const pairPlan = db.prepare(`
            EXPLAIN QUERY PLAN
            DELETE FROM tag_pair_similarity
            WHERE tag_a = ? OR tag_b = ?
        `).all(999999, 999999);
        const statusPlan = db.prepare(`
            EXPLAIN QUERY PLAN
            DELETE FROM tag_pair_similarity_status
            WHERE tag_a = ? OR tag_b = ?
        `).all(999999, 999999);
        assert(
            pairPlan.every(row => !/\bSCAN tag_pair_similarity\b/i.test(row.detail)),
            `pairwise endpoint invalidation must be indexed: ${JSON.stringify(pairPlan)}`
        );
        assert(
            statusPlan.every(row => !/\bSCAN tag_pair_similarity_status\b/i.test(row.detail)),
            `pairwise status endpoint invalidation must be indexed: ${JSON.stringify(statusPlan)}`
        );

        const embeddingPath = require.resolve('../EmbeddingUtils');
        const originalEmbeddingModule = require.cache[embeddingPath];
        require.cache[embeddingPath] = {
            id: embeddingPath,
            filename: embeddingPath,
            loaded: true,
            exports: {
                getEmbeddingsBatch: async texts =>
                    texts.map((_, index) => vectorFor(index + 10))
            }
        };

        const ingestionPath = require.resolve(
            '../modules/knowledgeBase/ingestionPipeline'
        );
        delete require.cache[ingestionPath];
        const IngestionPipeline = require(ingestionPath);

        const preparedSql = [];
        const owner = {
            db: createDatabaseProxy(db, preparedSql),
            config: {
                rootPath: diaryRoot,
                dimension: DIMENSION,
                maxBatchSize: 50,
                batchWindow: 1,
                apiKey: 'test',
                apiUrl: 'http://localhost.invalid',
                model: 'test-model'
            },
            pendingFiles: new Set([filePath]),
            pendingDeletes: new Set(),
            fileRetryCount: new Map(),
            diaryIndices: new Map(),
            isProcessing: false,
            externalMutationActive: false,
            rustWriteLease: null,
            indexRecoveryActive: false,
            databaseCorruptionDetected: false,
            tagIndex: {
                add() {}
            },
            indexRepository: {
                async applyChunkDelta(_diaryName, deletes, upserts) {
                    return {
                        mode: 'test-native-delta',
                        requestedDeletes: deletes.length,
                        requestedUpserts: upserts.length,
                        revision: 1
                    };
                }
            },
            tagMemoEngine: {
                scheduleMatrixRebuildForNewTags(ids) {
                    owner.scheduledNewTagIds = ids.slice();
                }
            },
            _extractTags() {
                return ['brand-new-tag'];
            },
            _prepareTextForEmbedding(text) {
                return String(text || '').trim() || '[EMPTY_CONTENT]';
            },
            _findReusableChunkVectors() {
                return null;
            },
            _scheduleIndexSave() {},
            invalidateDiaryDateIndex() {},
            _ensureDiaryDateIndexCached() {},
            _deferBatchForRustLease() {},
            _isSqliteBusyError() {
                return false;
            },
            _isSqliteCorruptionError() {
                return false;
            }
        };

        try {
            const pipeline = new IngestionPipeline(owner);
            await pipeline._flushBatch();
        } finally {
            delete require.cache[ingestionPath];
            if (originalEmbeddingModule) {
                require.cache[embeddingPath] = originalEmbeddingModule;
            } else {
                delete require.cache[embeddingPath];
            }
        }

        const inserted = db.prepare(
            'SELECT id, vector FROM tags WHERE name = ?'
        ).get('brand-new-tag');
        assert(inserted?.id > 2, 'new Tag must be inserted with a fresh ID');
        assert.strictEqual(
            inserted.vector.length,
            DIMENSION * Float32Array.BYTES_PER_ELEMENT
        );
        assert.deepStrictEqual(owner.scheduledNewTagIds, [inserted.id]);

        const forbiddenInvalidation = preparedSql.filter(sql =>
            /^DELETE FROM tag_pair_similarity(?:_status)? WHERE tag_a = \? OR tag_b = \?$/i.test(sql)
            || /^DELETE FROM tag_intrinsic_residuals WHERE tag_id = \?$/i.test(sql)
            || /^DELETE FROM tag_intrinsic_residual_status WHERE tag_id = \?$/i.test(sql)
        );
        assert.deepStrictEqual(
            forbiddenInvalidation,
            [],
            `new Tag ingestion must not touch historical derived rows: ${forbiddenInvalidation.join('; ')}`
        );
        assert.strictEqual(
            db.prepare('SELECT COUNT(*) AS count FROM tag_pair_similarity').get().count,
            1
        );
        assert.strictEqual(
            db.prepare('SELECT COUNT(*) AS count FROM tag_pair_similarity_status').get().count,
            1
        );

        console.log(
            '[NewTagIngestionTest] PASS: fresh Tag ingestion avoids derived-table ' +
            'invalidation and reverse endpoint plans are indexed.'
        );
    } finally {
        db.close();
        fs.rmSync(tempRoot, {
            recursive: true,
            force: true
        });
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});