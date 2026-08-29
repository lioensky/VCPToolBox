'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { VexusIndex } = require('../rust-vexus-lite');
const IndexRepository = require('../modules/knowledgeBase/indexRepository');
const TagConsistencyService = require(
    '../modules/knowledgeBase/tagConsistencyService'
);
const {
    initializeKnowledgeBaseSchema
} = require('../modules/knowledgeBase/schemaManager');

const DIMENSION = 4;
const MODEL_SIG = 'tag-consistency-incremental-test';

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

async function run() {
    const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'vcp-tag-consistency-')
    );
    const rootPath = path.join(tempRoot, 'dailynote');
    const storePath = path.join(tempRoot, 'store');
    fs.mkdirSync(rootPath, { recursive: true });
    fs.mkdirSync(storePath, { recursive: true });

    const notePath = path.join(rootPath, 'note.md');
    fs.writeFileSync(notePath, 'Tags: keep', 'utf8');

    const dbPath = path.join(storePath, 'knowledge_base.sqlite');
    const db = new Database(dbPath);

    try {
        initializeKnowledgeBaseSchema(db, {
            logPrefix: 'TagConsistencyIncrementalTest'
        });

        db.prepare(`
            INSERT INTO files
                (id, path, diary_name, checksum, mtime, size, updated_at)
            VALUES (1, 'note.md', 'Root', '', 0, 0, 0)
        `).run();
        db.prepare(
            'INSERT INTO tags (id, name, vector) VALUES (?, ?, ?)'
        ).run(1, 'keep', vectorBuffer([1, 0, 0, 0]));
        db.prepare(
            'INSERT INTO tags (id, name, vector) VALUES (?, ?, ?)'
        ).run(2, 'orphan', vectorBuffer([0, 1, 0, 0]));
        db.prepare(
            'INSERT INTO file_tags (file_id, tag_id, position) VALUES (1, 2, 1)'
        ).run();

        const config = {
            rootPath,
            storePath,
            dimension: DIMENSION,
            modelSig: MODEL_SIG,
            model: 'test-model',
            apiKey: '',
            apiUrl: '',
            ignoreFolders: [],
            ignorePrefixes: [],
            ignoreSuffixes: [],
            tagBlacklist: new Set(),
            tagBlacklistSuper: [],
            maxTagsPerFile: 50,
            persistTagIndex: true,
            persistFolders: new Set(),
            persistDefault: false,
            tagIndexPersistenceMode: 'generational',
            tagIndexBaselineDeltaRatio: 0.05,
            indexSaveDelay: 100,
            tagIndexSaveDelay: 100,
            indexIdleSweepInterval: 60000,
            indexIdleTTL: 60000
        };

        const activeIndex = new VexusIndex(DIMENSION, 32);
        activeIndex.addBatch(
            [1, 2],
            new Float32Array([
                1, 0, 0, 0,
                0, 1, 0, 0
            ])
        );

        const owner = {
            initialized: true,
            config,
            db,
            dbPath,
            tagIndex: activeIndex,
            tagMemoEngine: null,
            lastJsWriteFinishedAt: 0,
            _extractTags: () => ['keep'],
            requestRustWriteLease: async () => ({
                release() {}
            })
        };
        owner.indexRepository = new IndexRepository({
            config,
            VexusIndex,
            getDbPath: () => dbPath,
            getDb: () => db,
            waitForCoordinatorIdle: async () => {}
        });
        owner.indexRepository.tagIndex = activeIndex;

        assert.strictEqual(
            owner.indexRepository.publishGlobalTagBaseline({ force: true }),
            true
        );

        const service = new TagConsistencyService(owner, { VexusIndex });
        const preview = await service.createPreview();
        assert.strictEqual(preview.requiresConfirmation, true);
        assert.strictEqual(preview.summary.relationsToAdd, 1);
        assert.strictEqual(preview.summary.relationsToRemove, 1);
        assert.strictEqual(preview.summary.orphanTagsToRemove, 1);
        assert.deepStrictEqual(preview.removals, ['orphan']);

        const originalApplyTagDelta =
            owner.tagIndex.applyTagDelta.bind(owner.tagIndex);
        let deltaCallCount = 0;
        owner.tagIndex.applyTagDelta = (...args) => {
            deltaCallCount++;
            return originalApplyTagDelta(...args);
        };

        const result = await service.applyPreview(preview.token);
        assert.strictEqual(result.applied, true);
        assert.strictEqual(deltaCallCount, 1);
        assert.strictEqual(result.indexUpdate.mode, 'active-rust-delta');
        assert.strictEqual(result.indexUpdate.requestedDeletes, 1);
        assert.strictEqual(result.indexUpdate.requestedUpserts, 0);
        assert.strictEqual(result.indexUpdate.totalVectors, 1);
        assert.strictEqual(result.checkpointPublished, true);

        assert.deepStrictEqual(
            db.prepare('SELECT id, name FROM tags ORDER BY id').all(),
            [{ id: 1, name: 'keep' }]
        );
        assert.deepStrictEqual(
            db.prepare(`
                SELECT file_id, tag_id, position
                FROM file_tags
                ORDER BY file_id, position
            `).all(),
            [{ file_id: 1, tag_id: 1, position: 1 }]
        );
        assert.strictEqual(owner.tagIndex.stats().totalVectors, 1);
        assert.strictEqual(
            owner.tagIndex.search(vector([1, 0, 0, 0]), 1)[0].id,
            1
        );

        const activeBaseline = JSON.parse(
            db.prepare(`
                SELECT value
                FROM kv_store
                WHERE key = 'tag_index_active_baseline'
            `).get().value
        );
        assert.strictEqual(activeBaseline.generation, 2);
        assert.strictEqual(activeBaseline.slot, 'b');
        assert.strictEqual(
            db.prepare(`
                SELECT COUNT(*) AS count
                FROM tag_index_baseline_entries
                WHERE generation = 2
            `).get().count,
            1
        );

        // 第二轮制造一个新的孤儿 Tag，并让活动 ABI 在 SQLite 提交后失败。
        // 服务必须丢弃该实例，从 generation=2 基线回放修复后的 SQLite 删除，
        // 再强制发布 generation=3，不能继续使用部分应用实例。
        db.prepare(
            'INSERT INTO tags (id, name, vector) VALUES (?, ?, ?)'
        ).run(3, 'recovery-orphan', vectorBuffer([0, 0, 1, 0]));
        db.prepare(
            'INSERT INTO file_tags (file_id, tag_id, position) VALUES (1, 3, 1)'
        ).run();
        db.prepare(
            'DELETE FROM file_tags WHERE file_id = 1 AND tag_id = 1'
        ).run();
        owner.tagIndex.add(3, vector([0, 0, 1, 0]));

        const recoveryPreview = await service.createPreview();
        assert.strictEqual(recoveryPreview.requiresConfirmation, true);
        owner.tagIndex.applyTagDelta = () => {
            throw new Error('injected delta failure');
        };

        const recoveredResult = await service.applyPreview(
            recoveryPreview.token
        );
        assert.strictEqual(recoveredResult.applied, true);
        assert.strictEqual(
            recoveredResult.indexUpdate.mode,
            'baseline-plus-sqlite-delta'
        );
        assert.strictEqual(recoveredResult.indexUpdate.totalVectors, 1);
        assert.strictEqual(owner.tagIndex.stats().totalVectors, 1);
        assert.strictEqual(
            owner.tagIndex.search(vector([1, 0, 0, 0]), 1)[0].id,
            1
        );
        const recoveredBaseline = JSON.parse(
            db.prepare(`
                SELECT value
                FROM kv_store
                WHERE key = 'tag_index_active_baseline'
            `).get().value
        );
        assert.strictEqual(recoveredBaseline.generation, 3);
        assert.strictEqual(recoveredBaseline.slot, 'a');

        console.log(
            '[TagConsistencyIncrementalTest] PASS: preview confirmation, ' +
            'active Rust delta, failure recovery, SQLite repair and forced ' +
            'checkpoint verified.'
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