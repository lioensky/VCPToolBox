'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
    initializeKnowledgeBaseSchema
} = require('../../../modules/knowledgeBase/schemaManager');

test('G1 additive schema preserves existing Tag generational baseline metadata', () => {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'vcp-gen-usearch-tag-baseline-')
    );
    const db = new Database(path.join(root, 'knowledge.sqlite'));
    try {
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = FULL');
        db.pragma('foreign_keys = ON');

        initializeKnowledgeBaseSchema(db, {
            logPrefix: 'GenUSearchTagCompat'
        });

        db.prepare(
            'INSERT INTO tags (id, name, vector) VALUES (?, ?, ?)'
        ).run(1, 'tag-1', Buffer.alloc(32));

        const initialVersion = db.prepare(
            'SELECT vector_version FROM tags WHERE id = 1'
        ).get().vector_version;
        assert.equal(initialVersion, 1);

        db.prepare(`
            INSERT INTO tag_index_baselines (
                generation, slot, dimension, model_sig,
                tag_count, status, created_at
            ) VALUES (1, 'a', 8, 'compat-model', 1, 'ready', 1000)
        `).run();
        db.prepare(`
            INSERT INTO tag_index_baseline_entries (
                generation, tag_id, vector_version
            ) VALUES (1, 1, 1)
        `).run();
        db.prepare(`
            INSERT INTO kv_store(key, value)
            VALUES ('tag_index_active_baseline', ?)
        `).run(JSON.stringify({ generation: 1, slot: 'a' }));

        db.prepare(
            'UPDATE tags SET vector = ? WHERE id = 1'
        ).run(Buffer.alloc(32, 1));

        const updatedVersion = db.prepare(
            'SELECT vector_version FROM tags WHERE id = 1'
        ).get().vector_version;
        assert.equal(updatedVersion, 2);

        initializeKnowledgeBaseSchema(db, {
            logPrefix: 'GenUSearchTagCompat'
        });

        const baseline = db.prepare(`
            SELECT generation, slot, dimension, model_sig, tag_count, status
            FROM tag_index_baselines
            WHERE generation = 1
        `).get();
        assert.deepEqual(baseline, {
            generation: 1,
            slot: 'a',
            dimension: 8,
            model_sig: 'compat-model',
            tag_count: 1,
            status: 'ready'
        });

        const entry = db.prepare(`
            SELECT generation, tag_id, vector_version
            FROM tag_index_baseline_entries
            WHERE generation = 1 AND tag_id = 1
        `).get();
        assert.deepEqual(entry, {
            generation: 1,
            tag_id: 1,
            vector_version: 1
        });

        const active = JSON.parse(
            db.prepare(`
                SELECT value
                FROM kv_store
                WHERE key = 'tag_index_active_baseline'
            `).get().value
        );
        assert.deepEqual(active, {
            generation: 1,
            slot: 'a'
        });

        const genTables = db.prepare(`
            SELECT COUNT(*) AS count
            FROM sqlite_master
            WHERE type = 'table'
              AND name LIKE 'gen_usearch_%'
        `).get().count;
        assert.ok(genTables >= 12);

        console.log(
            '[GenUSearchTagCompat] PASS: existing Tag baseline metadata, ' +
            'vector_version trigger, and active checkpoint survived G1 schema init.'
        );
    } finally {
        db.close();
        fs.rmSync(root, {
            recursive: true,
            force: true
        });
    }
});
