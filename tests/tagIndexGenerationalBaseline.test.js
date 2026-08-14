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
const MODEL_SIG = 'tag-index-generational-test';

function vectorFor(id, salt = 0) {
    const vector = new Float32Array(DIMENSION);
    for (let index = 0; index < DIMENSION; index++) {
        vector[index] = ((id + salt) * (index + 3) % 17) / 17;
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

function insertTags(db, from, to, salt = 0) {
    const insert = db.prepare(
        'INSERT INTO tags (id, name, vector) VALUES (?, ?, ?)'
    );
    const transaction = db.transaction(() => {
        for (let id = from; id <= to; id++) {
            insert.run(
                id,
                `tag-${id}`,
                vectorBuffer(vectorFor(id, salt))
            );
        }
    });
    transaction();
}

function buildIndex(from, to) {
    const index = new VexusIndex(DIMENSION, 256);
    const ids = [];
    const flat = new Float32Array((to - from + 1) * DIMENSION);
    for (let id = from; id <= to; id++) {
        ids.push(id);
        flat.set(vectorFor(id), (id - from) * DIMENSION);
    }
    index.addBatch(ids, flat);
    return index;
}

function createRepository(db, storePath, mode = 'generational') {
    return new IndexRepository({
        config: {
            storePath,
            dimension: DIMENSION,
            modelSig: MODEL_SIG,
            persistTagIndex: true,
            persistFolders: new Set(),
            persistDefault: false,
            tagIndexPersistenceMode: mode,
            tagIndexBaselineDeltaRatio: 0.05,
            indexSaveDelay: 100,
            tagIndexSaveDelay: 100,
            indexIdleSweepInterval: 60000,
            indexIdleTTL: 60000
        },
        VexusIndex,
        getDbPath: () => db.name,
        getDb: () => db,
        waitForCoordinatorIdle: async () => {}
    });
}

function activeBaseline(db) {
    const raw = db.prepare(
        "SELECT value FROM kv_store WHERE key = 'tag_index_active_baseline'"
    ).get()?.value;
    return raw ? JSON.parse(raw) : null;
}

function run() {
    const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'vcp-tag-baseline-')
    );
    const dbPath = path.join(tempRoot, 'test.sqlite');
    const db = new Database(dbPath);

    try {
        initializeKnowledgeBaseSchema(db, {
            logPrefix: 'TagBaselineTest'
        });
        insertTags(db, 1, 100);

        const repository = createRepository(
            db,
            tempRoot,
            'generational'
        );
        repository.tagIndex = buildIndex(1, 100);

        assert.strictEqual(
            repository.publishGlobalTagBaseline({ force: true }),
            true,
            'first baseline must be published'
        );
        const first = activeBaseline(db);
        assert.deepStrictEqual(first, {
            generation: 1,
            slot: 'a'
        });
        assert.strictEqual(
            db.prepare(
                'SELECT COUNT(*) AS count FROM tag_index_baseline_entries WHERE generation = 1'
            ).get().count,
            100
        );

        // 4/104 < 5%：不应重写大 usearch 文件。
        insertTags(db, 101, 104);
        assert.strictEqual(
            repository.publishGlobalTagBaseline(),
            false,
            'sub-threshold delta must not publish a new generation'
        );
        assert.deepStrictEqual(activeBaseline(db), first);

        // 从旧基线加载，并只回放 4 个新增 Tag。
        const restored = repository.loadGlobalTagBaseline(256);
        assert(restored?.index, 'baseline restore must return an index');
        assert.strictEqual(restored.delta.upserts, 4);
        assert.strictEqual(restored.delta.deletes, 0);
        assert.strictEqual(restored.index.stats().totalVectors, 104);
        assert(
            restored.index.search(vectorFor(104), 1)
                .some(result => Number(result.id) === 104),
            'replayed Tag must be searchable'
        );

        // 更新一个基线 Tag，触发 vector_version 并验证回放为 upsert。
        db.prepare('UPDATE tags SET vector = ? WHERE id = 50').run(
            vectorBuffer(vectorFor(50, 99))
        );
        const version = db.prepare(
            'SELECT vector_version FROM tags WHERE id = 50'
        ).get().vector_version;
        assert.strictEqual(version, 2);

        const restoredAfterUpdate = repository.loadGlobalTagBaseline(256);
        assert.strictEqual(restoredAfterUpdate.delta.upserts, 5);
        assert.strictEqual(restoredAfterUpdate.index.stats().totalVectors, 104);

        // 6/106 > 5%：当前完整内存索引应发布到另一个槽。
        insertTags(db, 105, 106);
        restoredAfterUpdate.index.addBatch(
            [105, 106],
            new Float32Array([
                ...vectorFor(105),
                ...vectorFor(106)
            ])
        );
        repository.tagIndex = restoredAfterUpdate.index;
        assert.strictEqual(
            repository.publishGlobalTagBaseline(),
            true,
            'delta at or above 5% must publish a new generation'
        );
        const second = activeBaseline(db);
        assert.strictEqual(second.generation, 2);
        assert.strictEqual(second.slot, 'b');
        assert.strictEqual(
            db.prepare(
                'SELECT COUNT(*) AS count FROM tag_index_baselines'
            ).get().count,
            1,
            'only the active metadata generation should remain'
        );
        assert.strictEqual(
            db.prepare(
                'SELECT COUNT(*) AS count FROM tag_index_baseline_entries WHERE generation = 2'
            ).get().count,
            106
        );

        // always 模式即使零差分也必须重写并切换槽。
        const alwaysRepository = createRepository(
            db,
            tempRoot,
            'always'
        );
        alwaysRepository.tagIndex = repository.tagIndex;
        assert.strictEqual(
            alwaysRepository.saveToDisk('global_tags'),
            true
        );
        const third = activeBaseline(db);
        assert.strictEqual(third.generation, 3);
        assert.strictEqual(third.slot, 'a');

        console.log(
            '[TagBaselineTest] PASS: generational replay, 5% checkpoint, ' +
            'double-slot publication and always mode verified.'
        );
    } finally {
        db.close();
        fs.rmSync(tempRoot, {
            recursive: true,
            force: true
        });
    }
}

run();