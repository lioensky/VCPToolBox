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
            'gen_usearch_reconciliation_plans',
            'gen_usearch_reconciliation_items',
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


function createStagedVersion(fixture, options = {}) {
    const docId = options.docId || 'doc-mvcc';
    const chunkId = options.chunkId || 'chunk-mvcc';

    if (!fixture.store.getDocument(docId)) {
        fixture.store.createDocument({
            docId,
            uri: `${docId}.txt`,
            visibilitySeq: fixture.store.readSequence('visibility_seq')
        });
    }
    if (!fixture.store.getChunkHead(chunkId)) {
        fixture.store.createChunkIdentity({
            chunkId,
            docId
        });
    }

    const version = fixture.store.prepareChunkVersion({
        chunkId,
        sourceRevision: options.sourceRevision || 'rev-1',
        slotIndex: options.slotIndex ?? 0,
        contentHash: options.contentHash || 'a'.repeat(64)
    });
    fixture.store.markEmbedding({
        chunkVersionId: version.chunk_version_id,
        embeddingFingerprint: options.embeddingFingerprint || 'embed-v1'
    });
    return fixture.store.stageVector({
        chunkVersionId: version.chunk_version_id,
        embeddingFingerprint: options.embeddingFingerprint || 'embed-v1',
        vectorBlob: options.vectorBlob || new Float32Array([1, 2, 3, 4])
    });
}

function publishCoverage(fixture, staged, sourceId = 'M1') {
    fixture.db.prepare(`
        INSERT INTO gen_usearch_vector_coverage (
            vector_id,
            source_kind,
            source_id,
            coverage_state,
            created_at,
            updated_at
        ) VALUES (?, 'MEMTABLE', ?, 'QUERY_VISIBLE', ?, ?)
    `).run(
        BigInt(staged.vector_id),
        sourceId,
        5000,
        5000
    );
}

test('staged vectors are not logically visible until physical coverage exists', () => {
    const fixture = createFixture();
    try {
        const staged = createStagedVersion(fixture);
        assert.equal(staged.state, 'VECTOR_STAGED');
        assert.equal(staged.vector_id, '1');
        assert.equal(
            fixture.store.getChunkHead('chunk-mvcc').current_version_id,
            null
        );
        assert.equal(fixture.store.readSequence('visibility_seq'), '0');

        const recovery = fixture.db.prepare(`
            SELECT state, embedding_fingerprint, vector_blob
            FROM gen_usearch_vector_recovery
            WHERE vector_id = ?
        `).get(BigInt(staged.vector_id));
        assert.equal(recovery.state, 'RECOVERY_REQUIRED');
        assert.equal(recovery.embedding_fingerprint, 'embed-v1');
        assert.deepEqual(
            Buffer.from(recovery.vector_blob),
            Buffer.from(
                new Float32Array([1, 2, 3, 4]).buffer
            )
        );

        assert.throws(
            () => fixture.store.publishCurrentHead({
                chunkId: 'chunk-mvcc',
                chunkVersionId: staged.chunk_version_id,
                expectedCurrentVersionId: null
            }),
            error => error?.code === 'PHYSICAL_COVERAGE_MISSING'
        );

        assert.equal(fixture.store.readSequence('visibility_seq'), '0');
        assert.equal(
            fixture.store.getChunkVersion(staged.chunk_version_id).state,
            'VECTOR_STAGED'
        );

        publishCoverage(fixture, staged);

        const published = fixture.store.publishCurrentHead({
            chunkId: 'chunk-mvcc',
            chunkVersionId: staged.chunk_version_id,
            expectedCurrentVersionId: null
        });
        assert.deepEqual(published, {
            chunkId: 'chunk-mvcc',
            currentVersionId: staged.chunk_version_id,
            previousVersionId: null,
            vectorId: staged.vector_id,
            visibilitySeq: '1'
        });

        assert.equal(
            fixture.store.getChunkHead('chunk-mvcc').current_version_id,
            staged.chunk_version_id
        );
        const active = fixture.store.getChunkVersion(
            staged.chunk_version_id
        );
        assert.equal(active.state, 'ACTIVE');
        assert.equal(active.visibility_seq, '1');
    } finally {
        fixture.cleanup();
    }
});

test('source reconciliation authority blocks stale or premature current-head publication', () => {
    const fixture = createFixture();
    try {
        const stale = createStagedVersion(fixture, {
            sourceRevision: 'rev-1',
            contentHash: '9'.repeat(64)
        });
        publishCoverage(fixture, stale, 'M-stale');

        fixture.store.recordSourceObservation({
            docId: 'doc-mvcc',
            digest: 'digest-rev-2',
            revision: 'rev-2'
        });

        assert.throws(
            () => fixture.store.publishCurrentHead({
                chunkId: 'chunk-mvcc',
                chunkVersionId: stale.chunk_version_id,
                expectedCurrentVersionId: null
            }),
            error => error?.code === 'STALE_VECTOR_PUBLICATION'
        );
        assert.equal(fixture.store.readSequence('visibility_seq'), '0');
        assert.equal(
            fixture.store.getChunkVersion(stale.chunk_version_id).state,
            'VECTOR_STAGED'
        );

        const currentRevision = createStagedVersion(fixture, {
            sourceRevision: 'rev-2',
            contentHash: '8'.repeat(64),
            embeddingFingerprint: 'embed-v2',
            vectorBlob: new Float32Array([4, 3, 2, 1])
        });
        publishCoverage(fixture, currentRevision, 'M-current');

        assert.throws(
            () => fixture.store.publishCurrentHead({
                chunkId: 'chunk-mvcc',
                chunkVersionId: currentRevision.chunk_version_id,
                expectedCurrentVersionId: null
            }),
            error => error?.code === 'STALE_VECTOR_PUBLICATION'
        );

        fixture.db.prepare(`
            UPDATE gen_usearch_documents
            SET reconciliation_state = 'ADMITTED'
            WHERE doc_id = 'doc-mvcc'
        `).run();

        const published = fixture.store.publishCurrentHead({
            chunkId: 'chunk-mvcc',
            chunkVersionId: currentRevision.chunk_version_id,
            expectedCurrentVersionId: null
        });
        assert.equal(published.currentVersionId, currentRevision.chunk_version_id);
        assert.equal(published.visibilitySeq, '1');
    } finally {
        fixture.cleanup();
    }
});

test('current-head publication retires the old ACTIVE version in the same visibility commit', () => {
    const fixture = createFixture();
    try {
        const first = createStagedVersion(fixture, {
            sourceRevision: 'rev-1',
            contentHash: '1'.repeat(64)
        });
        publishCoverage(fixture, first, 'M1');
        fixture.store.publishCurrentHead({
            chunkId: 'chunk-mvcc',
            chunkVersionId: first.chunk_version_id,
            expectedCurrentVersionId: null
        });

        const second = createStagedVersion(fixture, {
            sourceRevision: 'rev-2',
            contentHash: '2'.repeat(64),
            embeddingFingerprint: 'embed-v2',
            vectorBlob: new Float32Array([4, 3, 2, 1])
        });
        publishCoverage(fixture, second, 'M2');

        const published = fixture.store.publishCurrentHead({
            chunkId: 'chunk-mvcc',
            chunkVersionId: second.chunk_version_id,
            expectedCurrentVersionId: first.chunk_version_id
        });
        assert.equal(published.visibilitySeq, '2');
        assert.equal(published.previousVersionId, first.chunk_version_id);

        const retired = fixture.store.getChunkVersion(
            first.chunk_version_id
        );
        const active = fixture.store.getChunkVersion(
            second.chunk_version_id
        );
        assert.equal(retired.state, 'RETIRED');
        assert.equal(retired.retired_visibility_seq, '2');
        assert.equal(active.state, 'ACTIVE');
        assert.equal(active.visibility_seq, '2');
        assert.equal(
            fixture.store.getChunkHead('chunk-mvcc').current_version_id,
            second.chunk_version_id
        );

        const activeCount = fixture.db.prepare(`
            SELECT COUNT(*) AS count
            FROM gen_usearch_chunk_versions
            WHERE chunk_id = ?
              AND state = 'ACTIVE'
        `).get('chunk-mvcc').count;
        assert.equal(activeCount, 1);
    } finally {
        fixture.cleanup();
    }
});

test('stale current-head CAS fails without advancing visibility or mutating MVCC states', () => {
    const fixture = createFixture();
    try {
        const first = createStagedVersion(fixture, {
            contentHash: '3'.repeat(64)
        });
        publishCoverage(fixture, first, 'M1');
        fixture.store.publishCurrentHead({
            chunkId: 'chunk-mvcc',
            chunkVersionId: first.chunk_version_id,
            expectedCurrentVersionId: null
        });

        const second = createStagedVersion(fixture, {
            sourceRevision: 'rev-2',
            contentHash: '4'.repeat(64),
            embeddingFingerprint: 'embed-v2'
        });
        publishCoverage(fixture, second, 'M2');

        assert.throws(
            () => fixture.store.publishCurrentHead({
                chunkId: 'chunk-mvcc',
                chunkVersionId: second.chunk_version_id,
                expectedCurrentVersionId: null
            }),
            error => error?.code === 'STALE_VECTOR_PUBLICATION'
        );

        assert.equal(fixture.store.readSequence('visibility_seq'), '1');
        assert.equal(
            fixture.store.getChunkVersion(first.chunk_version_id).state,
            'ACTIVE'
        );
        assert.equal(
            fixture.store.getChunkVersion(second.chunk_version_id).state,
            'VECTOR_STAGED'
        );
        assert.equal(
            fixture.store.getChunkHead('chunk-mvcc').current_version_id,
            first.chunk_version_id
        );
    } finally {
        fixture.cleanup();
    }
});

test('publication failure after retirement attempt rolls back visibility and both version states', () => {
    const fixture = createFixture();
    try {
        const first = createStagedVersion(fixture, {
            contentHash: '5'.repeat(64)
        });
        publishCoverage(fixture, first, 'M1');
        fixture.store.publishCurrentHead({
            chunkId: 'chunk-mvcc',
            chunkVersionId: first.chunk_version_id,
            expectedCurrentVersionId: null
        });

        const second = createStagedVersion(fixture, {
            sourceRevision: 'rev-2',
            contentHash: '6'.repeat(64),
            embeddingFingerprint: 'embed-v2'
        });
        publishCoverage(fixture, second, 'M2');

        fixture.db.exec(`
            CREATE TRIGGER reject_gen_usearch_head_swap
            BEFORE UPDATE OF current_version_id
            ON gen_usearch_chunk_heads
            WHEN NEW.current_version_id = ${BigInt(second.chunk_version_id)}
            BEGIN
                SELECT RAISE(ABORT, 'test-head-swap-crash');
            END;
        `);

        assert.throws(
            () => fixture.store.publishCurrentHead({
                chunkId: 'chunk-mvcc',
                chunkVersionId: second.chunk_version_id,
                expectedCurrentVersionId: first.chunk_version_id
            }),
            /test-head-swap-crash/
        );

        assert.equal(fixture.store.readSequence('visibility_seq'), '1');
        const oldVersion = fixture.store.getChunkVersion(
            first.chunk_version_id
        );
        const newVersion = fixture.store.getChunkVersion(
            second.chunk_version_id
        );
        assert.equal(oldVersion.state, 'ACTIVE');
        assert.equal(oldVersion.retired_visibility_seq, null);
        assert.equal(newVersion.state, 'VECTOR_STAGED');
        assert.equal(newVersion.visibility_seq, null);
        assert.equal(
            fixture.store.getChunkHead('chunk-mvcc').current_version_id,
            first.chunk_version_id
        );
    } finally {
        fixture.cleanup();
    }
});

test('embedding and abort transitions are fail-closed and staged recovery becomes reclaimable', () => {
    const fixture = createFixture();
    try {
        fixture.store.createDocument({
            docId: 'doc-transitions',
            uri: 'transitions.txt',
            visibilitySeq: '0'
        });
        fixture.store.createChunkIdentity({
            chunkId: 'chunk-transitions',
            docId: 'doc-transitions'
        });
        const prepared = fixture.store.prepareChunkVersion({
            chunkId: 'chunk-transitions',
            sourceRevision: 'rev-1',
            slotIndex: 0,
            contentHash: '7'.repeat(64)
        });

        assert.throws(
            () => fixture.store.stageVector({
                chunkVersionId: prepared.chunk_version_id,
                embeddingFingerprint: 'embed-v1',
                vectorBlob: Buffer.from([1, 2, 3, 4])
            }),
            error => error?.code === 'INVALID_MVCC_TRANSITION'
        );

        fixture.store.markEmbedding({
            chunkVersionId: prepared.chunk_version_id,
            embeddingFingerprint: 'embed-v1'
        });

        assert.throws(
            () => fixture.store.stageVector({
                chunkVersionId: prepared.chunk_version_id,
                embeddingFingerprint: 'embed-v2',
                vectorBlob: Buffer.from([1, 2, 3, 4])
            }),
            error => error?.code === 'STALE_EMBEDDING_RESULT'
        );

        const staged = fixture.store.stageVector({
            chunkVersionId: prepared.chunk_version_id,
            embeddingFingerprint: 'embed-v1',
            vectorBlob: Buffer.from([1, 2, 3, 4])
        });
        const aborted = fixture.store.abortChunkVersion({
            chunkVersionId: staged.chunk_version_id
        });
        assert.equal(aborted.state, 'ABORTED');

        const recovery = fixture.db.prepare(`
            SELECT state
            FROM gen_usearch_vector_recovery
            WHERE vector_id = ?
        `).get(BigInt(staged.vector_id));
        assert.equal(recovery.state, 'RECOVERY_RECLAIMABLE');

        assert.throws(
            () => fixture.store.abortChunkVersion({
                chunkVersionId: staged.chunk_version_id
            }),
            error => error?.code === 'INVALID_MVCC_TRANSITION'
        );
    } finally {
        fixture.cleanup();
    }
});
