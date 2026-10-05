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
const GenUSearchMetadataStore = require(
    '../../../modules/knowledgeBase/genUSearchMetadataStore'
);

function createFixture(options = {}) {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'vcp-gen-usearch-g1-')
    );
    const dbPath = path.join(root, 'knowledge.sqlite');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma(`synchronous = ${options.synchronous || 'FULL'}`);
    db.pragma('foreign_keys = ON');
    initializeKnowledgeBaseSchema(db, {
        logPrefix: 'GenUSearchG1Test'
    });
    let now = 1000;
    const store = new GenUSearchMetadataStore({
        db,
        now: () => now++
    });
    return {
        root,
        dbPath,
        db,
        store,
        cleanup() {
            try { db.close(); } catch (_) {}
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

test('G1 metadata schema is additive, idempotent and seeded', () => {
    const fixture = createFixture();
    try {
        initializeKnowledgeBaseSchema(fixture.db, {
            logPrefix: 'GenUSearchG1Test'
        });

        const tables = new Set(
            fixture.db.prepare(`
                SELECT name
                FROM sqlite_master
                WHERE type = 'table'
                  AND name LIKE 'gen_usearch_%'
            `).all().map(row => row.name)
        );

        for (const table of [
            'gen_usearch_documents',
            'gen_usearch_document_uri_history',
            'gen_usearch_chunk_heads',
            'gen_usearch_chunk_versions',
            'gen_usearch_segments',
            'gen_usearch_manifest_state',
            'gen_usearch_manifest_segments',
            'gen_usearch_vector_recovery',
            'gen_usearch_sequences',
            'gen_usearch_vector_allocator',
            'gen_usearch_runtime_ownership',
            'gen_usearch_engine_state'
        ]) {
            assert.equal(tables.has(table), true, table);
        }

        assert.equal(fixture.store.readAllocatorHighWater(), '0');
        assert.equal(fixture.store.readSequence('visibility_seq'), '0');
        assert.equal(fixture.store.readManifestEpoch(), '0');

        const engine = fixture.db.prepare(`
            SELECT mode
            FROM gen_usearch_engine_state
            WHERE singleton = 1
        `).get();
        assert.equal(engine.mode, 'LEGACY');

        const ownership = fixture.db.prepare(`
            SELECT serving_state, runtime_fence, owner_id
            FROM gen_usearch_runtime_ownership
            WHERE singleton = 1
        `).get();
        assert.equal(ownership.serving_state, 'IDLE');
        assert.equal(ownership.runtime_fence, 0);
        assert.equal(ownership.owner_id, null);
    } finally {
        fixture.cleanup();
    }
});

test('vector allocator is durable, monotonic and never reuses IDs across store recreation', () => {
    const fixture = createFixture();
    try {
        assert.deepEqual(
            fixture.store.allocateVectorIds(2),
            ['1', '2']
        );
        assert.equal(fixture.store.readAllocatorHighWater(), '2');

        const reopenedStore = new GenUSearchMetadataStore({
            db: fixture.db,
            now: () => 2000
        });
        assert.deepEqual(reopenedStore.allocateVectorIds(2), ['3', '4']);
        assert.equal(reopenedStore.readAllocatorHighWater(), '4');

        fixture.db.prepare(`
            UPDATE gen_usearch_vector_allocator
            SET high_water = ?
            WHERE singleton = 1
        `).run(GenUSearchMetadataStore.MAX_SIGNED_INT64);

        assert.throws(
            () => reopenedStore.allocateVectorIds(1),
            error => error?.code === 'VECTOR_ID_EXHAUSTED'
        );
    } finally {
        fixture.cleanup();
    }
});

test('visibility_seq and manifest_epoch advance independently and manifest mirrors its sequence', () => {
    const fixture = createFixture();
    try {
        assert.equal(fixture.store.nextVisibilitySeq(), '1');
        assert.equal(fixture.store.nextVisibilitySeq(), '2');
        assert.equal(fixture.store.readSequence('manifest_epoch'), '0');

        assert.equal(fixture.store.nextManifestEpoch(), '1');
        assert.equal(fixture.store.readManifestEpoch(), '1');
        assert.equal(fixture.store.readSequence('visibility_seq'), '2');

        const manifestRow = fixture.db.prepare(`
            SELECT manifest_epoch
            FROM gen_usearch_manifest_state
            WHERE singleton = 1
        `).safeIntegers(true).get();
        assert.equal(manifestRow.manifest_epoch, 1n);
    } finally {
        fixture.cleanup();
    }
});

test('critical writes fail closed unless SQLite is WAL + FULL/EXTRA', () => {
    const fixture = createFixture();
    try {
        fixture.db.pragma('synchronous = NORMAL');

        assert.throws(
            () => fixture.store.allocateVectorIds(1),
            error => error?.code === 'UNSUPPORTED_DURABILITY_PROFILE'
        );
        assert.equal(fixture.store.readAllocatorHighWater(), '0');

        fixture.db.pragma('synchronous = FULL');
        assert.deepEqual(fixture.store.allocateVectorIds(1), ['1']);
    } finally {
        fixture.cleanup();
    }
});

test('document identity is stable across URI moves and active URI ownership is unique', () => {
    const fixture = createFixture();
    try {
        const first = fixture.store.createDocument({
            docId: 'doc-alpha',
            uri: 'diary/a.txt',
            visibilitySeq: '0'
        });
        assert.equal(first.doc_id, 'doc-alpha');
        assert.equal(first.current_uri, 'diary/a.txt');

        assert.throws(
            () => fixture.store.createDocument({
                docId: 'doc-beta',
                uri: 'diary/a.txt',
                visibilitySeq: '0'
            }),
            error => error?.code === 'DOCUMENT_ACTIVE_URI_CONFLICT'
        );

        fixture.store.nextVisibilitySeq();
        const moved = fixture.store.moveDocument({
            docId: 'doc-alpha',
            uri: 'archive/a.txt',
            visibilitySeq: '1'
        });
        assert.equal(moved.doc_id, 'doc-alpha');
        assert.equal(moved.current_uri, 'archive/a.txt');

        const history = fixture.db.prepare(`
            SELECT uri, valid_from_visibility_seq, valid_to_visibility_seq
            FROM gen_usearch_document_uri_history
            WHERE doc_id = ?
            ORDER BY valid_from_visibility_seq, uri
        `).safeIntegers(true).all('doc-alpha');

        assert.deepEqual(history, [
            {
                uri: 'diary/a.txt',
                valid_from_visibility_seq: 0n,
                valid_to_visibility_seq: 1n
            },
            {
                uri: 'archive/a.txt',
                valid_from_visibility_seq: 1n,
                valid_to_visibility_seq: null
            }
        ]);
    } finally {
        fixture.cleanup();
    }
});

test('source observation and reconciliation intent are committed atomically', () => {
    const fixture = createFixture();
    try {
        fixture.store.createDocument({
            docId: 'doc-observed',
            uri: 'diary/observed.txt',
            visibilitySeq: '0'
        });

        const row = fixture.store.recordSourceObservation({
            docId: 'doc-observed',
            digest: 'sha256:abc',
            revision: 'rev-7'
        });

        assert.equal(row.observed_source_digest, 'sha256:abc');
        assert.equal(row.observed_source_revision, 'rev-7');
        assert.equal(row.reconcile_target_revision, 'rev-7');
        assert.equal(row.reconciliation_state, 'PENDING');
        assert.equal(row.index_state, 'INDEX_LAGGING');

        fixture.db.exec(`
            CREATE TRIGGER reject_gen_usearch_test_revision
            BEFORE UPDATE ON gen_usearch_documents
            WHEN NEW.reconcile_target_revision = 'rev-rejected'
            BEGIN
                SELECT RAISE(ABORT, 'test-rejected-revision');
            END;
        `);

        assert.throws(
            () => fixture.store.recordSourceObservation({
                docId: 'doc-observed',
                digest: 'sha256:def',
                revision: 'rev-rejected'
            }),
            /test-rejected-revision/
        );

        const after = fixture.store.getDocument('doc-observed');
        assert.equal(after.observed_source_digest, 'sha256:abc');
        assert.equal(after.observed_source_revision, 'rev-7');
        assert.equal(after.reconcile_target_revision, 'rev-7');
        assert.equal(after.reconciliation_state, 'PENDING');
    } finally {
        fixture.cleanup();
    }
});

test('unsafe JavaScript numbers are rejected before SQLite identity writes', () => {
    const fixture = createFixture();
    try {
        assert.throws(
            () => fixture.store.createDocument({
                docId: 'doc-unsafe',
                uri: 'unsafe.txt',
                visibilitySeq: Number.MAX_SAFE_INTEGER + 1
            }),
            error => error?.code === 'GEN_USEARCH_INTEGER_UNSAFE'
        );
    } finally {
        fixture.cleanup();
    }
});
