'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { VexusIndex } = require('../rust-vexus-lite');
const IndexRepository = require('../modules/knowledgeBase/indexRepository');
const {
    initializeKnowledgeBaseSchema
} = require('../modules/knowledgeBase/schemaManager');

const DIMENSION = 8;
const OLD_COUNT = 1200;

function vectorFor(id) {
    const output = new Float32Array(DIMENSION);
    output[0] = 1;
    output[1] = (id % 97) / 9700;
    output[2] = (id % 53) / 5300;
    return output;
}

function flatten(ids) {
    const output = new Float32Array(ids.length * DIMENSION);
    ids.forEach((id, position) => {
        output.set(vectorFor(id), position * DIMENSION);
    });
    return output;
}

function vectorBuffer(vector) {
    return Buffer.from(
        vector.buffer,
        vector.byteOffset,
        vector.byteLength
    );
}

function assertSingleGeneration(results, oldMaximum) {
    if (!Array.isArray(results) || results.length === 0) return;
    const oldIds = results.filter(item => Number(item.id) <= oldMaximum);
    const newIds = results.filter(item => Number(item.id) > oldMaximum);
    assert(
        oldIds.length === 0 || newIds.length === 0,
        `search observed a partial batch: old=${oldIds.length}, new=${newIds.length}`
    );
}

async function testNativeAtomicDelta() {
    const oldIds = Array.from({ length: OLD_COUNT }, (_, index) => index + 1);
    const newIds = Array.from(
        { length: OLD_COUNT },
        (_, index) => OLD_COUNT + index + 1
    );
    const index = new VexusIndex(DIMENSION, OLD_COUNT * 3);
    index.addBatch(oldIds, flatten(oldIds));

    const baselineRevision = index.revision;
    assert.strictEqual(baselineRevision, 1);
    assert.strictEqual(index.stats().totalVectors, OLD_COUNT);

    const deltaPromise = index.applyChunkDelta(
        oldIds,
        newIds,
        flatten(newIds)
    );

    // AsyncTask 已进入 libuv 工作线程；同步 search 与其竞争同一 Rust RwLock。
    // 每次搜索允许命中完整旧代或完整新代，但绝不能混合半批状态。
    for (let attempt = 0; attempt < 24; attempt++) {
        assertSingleGeneration(
            index.search(vectorFor(1), 64),
            OLD_COUNT
        );
    }

    const result = await deltaPromise;
    assert.strictEqual(result.requestedDeletes, OLD_COUNT);
    assert.strictEqual(result.requestedUpserts, OLD_COUNT);
    assert.strictEqual(result.appliedDeletes, OLD_COUNT);
    assert.strictEqual(result.appliedUpserts, OLD_COUNT);
    assert.strictEqual(result.previousRevision, baselineRevision);
    assert.strictEqual(result.revision, baselineRevision + 1);
    assert.strictEqual(index.revision, baselineRevision + 1);
    assert.strictEqual(index.stats().totalVectors, OLD_COUNT);
    assert(
        index.search(vectorFor(newIds[0]), 64)
            .every(item => Number(item.id) > OLD_COUNT),
        'post-commit search must only observe the new generation'
    );

    const beforeInvalidRevision = index.revision;
    await assert.rejects(
        index.applyChunkDelta(
            [],
            [newIds[0]],
            new Float32Array(DIMENSION - 1)
        ),
        /size mismatch/i
    );
    assert.strictEqual(
        index.revision,
        beforeInvalidRevision,
        'validation failure must not publish a new revision'
    );
    assert.strictEqual(index.stats().totalVectors, OLD_COUNT);
}

async function testRepositoryRecoveryFallback() {
    const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'vcp-diary-atomic-delta-')
    );
    const dbPath = path.join(tempRoot, 'knowledge_base.sqlite');
    const db = new Database(dbPath);

    try {
        initializeKnowledgeBaseSchema(db, {
            logPrefix: 'DiaryAtomicDeltaTest'
        });
        db.prepare(`
            INSERT INTO files
                (id, path, diary_name, checksum, mtime, size, updated_at)
            VALUES (1, 'SharedMemory/note.md', 'SharedMemory', '', 0, 0, 0)
        `).run();
        db.prepare(`
            INSERT INTO chunks
                (id, file_id, chunk_index, content, vector)
            VALUES (?, 1, 0, 'new authoritative memory', ?)
        `).run(2, vectorBuffer(vectorFor(2)));

        const staleIndex = new VexusIndex(DIMENSION, 32);
        staleIndex.add(1, vectorFor(1));
        staleIndex.applyChunkDelta = () => {
            throw new Error('injected partial apply failure');
        };

        const diaryIndices = new Map([['SharedMemory', staleIndex]]);
        const repository = new IndexRepository({
            config: {
                storePath: tempRoot,
                dimension: DIMENSION,
                modelSig: 'diary-atomic-delta-test',
                persistTagIndex: false,
                persistFolders: new Set(),
                persistDefault: false,
                indexSaveDelay: 100,
                tagIndexSaveDelay: 100,
                indexIdleSweepInterval: 60000,
                indexIdleTTL: 60000
            },
            VexusIndex,
            getDbPath: () => dbPath,
            getDb: () => db,
            waitForCoordinatorIdle: async () => {},
            diaryIndices,
            lastUsed: new Map([['SharedMemory', Date.now()]]),
            loadPromises: new Map(),
            saveTimers: new Map()
        });

        const result = await repository.applyChunkDelta(
            'SharedMemory',
            [1],
            [{ id: 2, vec: vectorFor(2) }]
        );
        assert.strictEqual(result.mode, 'sqlite-full-recovery');

        const replacement = diaryIndices.get('SharedMemory');
        assert(replacement, 'replacement index must be published');
        assert.notStrictEqual(
            replacement,
            staleIndex,
            'failed/possibly partial instance must never be republished'
        );
        assert.strictEqual(replacement.stats().totalVectors, 1);
        assert.strictEqual(
            Number(replacement.search(vectorFor(2), 1)[0].id),
            2
        );
    } finally {
        db.close();
        fs.rmSync(tempRoot, {
            recursive: true,
            force: true
        });
    }
}

async function run() {
    await testNativeAtomicDelta();
    await testRepositoryRecoveryFallback();
    console.log(
        '[DiaryAtomicDeltaTest] PASS: atomic read/write visibility, one-revision ' +
        'publication, validation safety and SQLite recovery fallback verified.'
    );
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});