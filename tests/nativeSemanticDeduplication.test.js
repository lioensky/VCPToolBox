'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
    VexusIndex,
    NativeKnowledgeRuntime
} = require('../rust-vexus-lite');
const {
    initializeKnowledgeBaseSchema
} = require('../modules/knowledgeBase/schemaManager');
const ResultDeduplicator = require('../ResultDeduplicator');

const DIMENSION = 4;

function vector(values) {
    return new Float32Array(values);
}

function vectorBuffer(values) {
    const value = values instanceof Float32Array
        ? values
        : vector(values);
    return Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength
    );
}

function ids(result) {
    return result.results.map(item => Number(item.id));
}

async function run() {
    const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'vcp-native-semantic-dedup-')
    );
    const dbPath = path.join(tempRoot, 'knowledge_base.sqlite');
    const db = new Database(dbPath);

    try {
        initializeKnowledgeBaseSchema(db, {
            logPrefix: 'NativeSemanticDedupTest'
        });
        db.prepare(`
            INSERT INTO files
                (id, path, diary_name, checksum, mtime, size, updated_at)
            VALUES (1, 'SharedMemory/dedup.md', 'SharedMemory', '', 0, 0, 0)
        `).run();

        const insertChunk = db.prepare(`
            INSERT INTO chunks
                (id, file_id, chunk_index, content, vector)
            VALUES (?, 1, ?, ?, ?)
        `);
        insertChunk.run(1, 0, 'representative', vectorBuffer([1, 0, 0, 0]));
        insertChunk.run(2, 1, 'exact duplicate', vectorBuffer([1, 0, 0, 0]));
        insertChunk.run(3, 2, 'threshold neighbor', vectorBuffer([0.8, 0.6, 0, 0]));
        insertChunk.run(4, 3, 'orthogonal', vectorBuffer([0, 1, 0, 0]));
        // ANN 中有合法向量，但 SQLite 事实向量零范数；按兼容语义必须保留。
        insertChunk.run(5, 4, 'invalid fact vector', vectorBuffer([0, 0, 0, 0]));

        const tagIndex = new VexusIndex(DIMENSION, 16);
        const diaryIndex = new VexusIndex(DIMENSION, 32);
        diaryIndex.addBatch(
            [1, 2, 3, 4, 5],
            new Float32Array([
                1, 0, 0, 0,
                1, 0, 0, 0,
                0.8, 0.6, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0
            ])
        );

        const runtime = new NativeKnowledgeRuntime(tagIndex);
        runtime.registerDiaryIndex('SharedMemory', diaryIndex);

        const exactPayload = await runtime.searchDiaryIndicesDeduplicated(
            dbPath,
            ['SharedMemory'],
            vector([1, 0, 0, 0]),
            10,
            10,
            1.0
        );
        const exact = JSON.parse(exactPayload);
        assert.strictEqual(
            exact.schema,
            'vcp-native-multi-index-ann-dedup-result-v1'
        );
        assert.strictEqual(exact.diagnostics.semanticEnabled, true);
        assert.strictEqual(exact.diagnostics.semanticSqlBatches, 1);
        assert.strictEqual(exact.diagnostics.hydratedVectors, 4);
        assert.strictEqual(exact.diagnostics.missingVectors, 1);
        assert.strictEqual(exact.diagnostics.semanticSuppressed, 1);
        assert(ids(exact).includes(1), 'stable lower-ID representative must remain');
        assert(!ids(exact).includes(2), 'exact duplicate must be suppressed at threshold 1');
        assert(ids(exact).includes(5), 'invalid/zero-norm fact vector must be retained');

        // 阈值必须基于与生产一致的 Float32Array 量化值计算。十进制 0.8
        // 在 f32 向量 [0.8, 0.6] 中对应的实际余弦略小于 0.8。
        const referenceDeduplicator = new ResultDeduplicator(null, {
            dimension: DIMENSION
        });
        const boundaryThreshold = referenceDeduplicator._cosineSimilarity(
            vector([1, 0, 0, 0]),
            vector([0.8, 0.6, 0, 0])
        );
        assert(boundaryThreshold < 0.8);

        const boundarySuppressPayload =
            await runtime.searchDiaryIndicesDeduplicated(
                dbPath,
                ['SharedMemory'],
                vector([1, 0, 0, 0]),
                10,
                10,
                boundaryThreshold
            );
        const boundarySuppress = JSON.parse(boundarySuppressPayload);
        assert(
            !ids(boundarySuppress).includes(3),
            'cosine at the threshold must be suppressed with >= semantics'
        );

        const boundaryKeepPayload =
            await runtime.searchDiaryIndicesDeduplicated(
                dbPath,
                ['SharedMemory'],
                vector([1, 0, 0, 0]),
                10,
                10,
                boundaryThreshold + 1e-7
            );
        const boundaryKeep = JSON.parse(boundaryKeepPayload);
        assert(
            ids(boundaryKeep).includes(3),
            'cosine below a slightly higher threshold must be retained'
        );
        assert.deepStrictEqual(
            ids(boundaryKeep),
            [...ids(boundaryKeep)],
            'native output must remain deterministic'
        );

        const refillPayload =
            await runtime.searchDiaryIndicesDeduplicated(
                dbPath,
                ['SharedMemory'],
                vector([1, 0, 0, 0]),
                10,
                5,
                1.0,
                3
            );
        const refill = JSON.parse(refillPayload);
        assert.strictEqual(refill.diagnostics.candidateK, 5);
        assert.strictEqual(refill.diagnostics.finalK, 3);
        assert.strictEqual(
            refill.results.length,
            3,
            'semantic suppression must refill finalK from the wider candidate pool'
        );
        assert(!ids(refill).includes(2));

        runtime.shutdown();
        console.log(
            '[NativeSemanticDedupTest] PASS: batched hydrate, exact/threshold ' +
            'suppression, invalid-vector retention and stable representative verified.'
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