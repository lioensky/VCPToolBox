'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { VexusIndex } = require('../rust-vexus-lite');
const {
    initializeKnowledgeBaseSchema
} = require('../modules/knowledgeBase/schemaManager');

const DIMENSION = 8;
const MODEL_SIG = 'pairwise-incremental-test';
const MIN_SIMILARITY = -1;

function vectorFor(id, salt = 0) {
    const vector = new Float32Array(DIMENSION);
    for (let index = 0; index < DIMENSION; index++) {
        vector[index] = (
            ((id + salt) * (index + 5) % 23) + 1
        ) / 24;
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

function insertTag(db, id, salt = 0) {
    db.prepare(
        'INSERT INTO tags (id, name, vector) VALUES (?, ?, ?)'
    ).run(id, `tag-${id}`, vectorBuffer(vectorFor(id, salt)));
}

function insertFile(db, id, tagIds) {
    db.prepare(`
        INSERT INTO files
            (id, path, diary_name, checksum, mtime, size, updated_at)
        VALUES (?, ?, 'test', ?, 0, 0, 0)
    `).run(id, `file-${id}.txt`, `checksum-${id}`);

    const insertRelation = db.prepare(`
        INSERT INTO file_tags (file_id, tag_id, position)
        VALUES (?, ?, ?)
    `);
    tagIds.forEach((tagId, index) => {
        insertRelation.run(id, tagId, index + 1);
    });
}

async function run() {
    const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'vcp-pairwise-incremental-')
    );
    const dbPath = path.join(tempRoot, 'test.sqlite');
    const db = new Database(dbPath);

    try {
        initializeKnowledgeBaseSchema(db, {
            logPrefix: 'PairwiseIncrementalTest'
        });
        for (let id = 1; id <= 4; id++) insertTag(db, id);

        // 第一代图只有 (1,2)、(1,3)、(2,3) 三条无向 pair。
        insertFile(db, 1, [1, 2, 3]);

        const index = new VexusIndex(DIMENSION, 32);
        const first = await index.computePairwiseSimilarities(
            dbPath,
            MODEL_SIG,
            MIN_SIMILARITY,
            false
        );
        assert.strictEqual(first.pairCount, 3);
        assert.strictEqual(first.computedCount, 3);
        assert.strictEqual(first.skippedCount, 0);
        assert.strictEqual(first.storedCount, 3);

        const firstArtifact = db.prepare(`
            SELECT artifact_sig, graph_generation
            FROM tagmemo_artifacts
            WHERE asset_type = 'pairwise_similarity'
            ORDER BY updated_at DESC
            LIMIT 1
        `).get();
        assert(firstArtifact?.artifact_sig);

        // 第二代新增 file_tags，图签名必然改变；旧实现会因此重算全部 5 条。
        // 新实现应跨 graph_generation 复用前三条，只计算 (2,4)、(3,4)。
        insertFile(db, 2, [2, 3, 4]);
        const second = await index.computePairwiseSimilarities(
            dbPath,
            MODEL_SIG,
            MIN_SIMILARITY,
            false
        );
        assert.strictEqual(second.pairCount, 5);
        assert.strictEqual(
            second.computedCount,
            2,
            'only newly introduced pairs should be computed'
        );
        assert.strictEqual(
            second.skippedCount,
            3,
            'three compatible pairs from the previous graph must be reused'
        );
        assert.strictEqual(second.storedCount, 2);

        const secondArtifact = db.prepare(`
            SELECT artifact_sig, graph_generation
            FROM tagmemo_artifacts
            WHERE asset_type = 'pairwise_similarity'
            ORDER BY updated_at DESC
            LIMIT 1
        `).get();
        assert.notStrictEqual(
            secondArtifact.artifact_sig,
            firstArtifact.artifact_sig,
            'graph change must still produce a distinct artifact'
        );
        assert.notStrictEqual(
            secondArtifact.graph_generation,
            firstArtifact.graph_generation
        );
        assert.strictEqual(
            db.prepare(`
                SELECT COUNT(*) AS count
                FROM tag_pair_similarity
                WHERE model_sig = ?
            `).get(MODEL_SIG).count,
            5
        );

        // 完全不变的第三次调用应计算 0 条，全部命中跨代状态。
        const warm = await index.computePairwiseSimilarities(
            dbPath,
            MODEL_SIG,
            MIN_SIMILARITY,
            false
        );
        assert.strictEqual(warm.pairCount, 5);
        assert.strictEqual(warm.computedCount, 0);
        assert.strictEqual(warm.skippedCount, 5);
        assert.strictEqual(warm.storedCount, 0);

        // 模拟生产摄取事务：Tag 2 向量变化时必须同步失效其正值与状态。
        const invalidate = db.transaction(() => {
            db.prepare(
                'UPDATE tags SET vector = ? WHERE id = 2'
            ).run(vectorBuffer(vectorFor(2, 77)));
            db.prepare(`
                DELETE FROM tag_pair_similarity
                WHERE tag_a = 2 OR tag_b = 2
            `).run();
            db.prepare(`
                DELETE FROM tag_pair_similarity_status
                WHERE tag_a = 2 OR tag_b = 2
            `).run();
        });
        invalidate();

        const afterVectorChange =
            await index.computePairwiseSimilarities(
                dbPath,
                MODEL_SIG,
                MIN_SIMILARITY,
                false
            );
        assert.strictEqual(afterVectorChange.pairCount, 5);
        assert.strictEqual(
            afterVectorChange.computedCount,
            3,
            'only the three pairs touching changed Tag 2 should recompute'
        );
        assert.strictEqual(
            afterVectorChange.skippedCount,
            2,
            'unaffected pairs must remain reusable'
        );
        assert.strictEqual(afterVectorChange.storedCount, 3);

        console.log(
            '[PairwiseIncrementalTest] PASS: compatible pair states survive ' +
            'graph generations and vector invalidation remains precise.'
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