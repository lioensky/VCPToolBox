'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { initializeKnowledgeBaseSchema } = require(
    '../../../modules/knowledgeBase/schemaManager'
);
const GenUSearchMetadataStore = require(
    '../../../modules/knowledgeBase/genUSearchMetadataStore'
);
const GenUSearchPhysicalCoverageWriter = require(
    '../../../modules/knowledgeBase/genUSearchPhysicalCoverageWriter'
);
const GenUSearchSegmentPublisher = require(
    '../../../modules/knowledgeBase/genUSearchSegmentPublisher'
);
const { VexusIndex } = require('../../../rust-vexus-lite');

function sha256File(filePath) {
    return crypto.createHash('sha256')
        .update(fs.readFileSync(filePath))
        .digest('hex');
}

function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g3-'));
    const dbPath = path.join(root, 'knowledge.sqlite');
    const segmentRoot = path.join(root, 'segments');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    initializeKnowledgeBaseSchema(db, { logPrefix: 'GenUSearchG3Test' });

    let now = 10000;
    const store = new GenUSearchMetadataStore({ db, now: () => now++ });
    const writer = new GenUSearchPhysicalCoverageWriter({
        db,
        runtimeId: 'runtime-g3',
        now: () => now++
    });
    writer.bootstrapRuntime();

    const publisher = new GenUSearchSegmentPublisher({
        db,
        segmentRoot,
        now: () => now++
    });

    return {
        root,
        db,
        store,
        writer,
        publisher,
        segmentRoot,
        createMemtable(generation, embeddingFingerprint = 'embed-v1') {
            return writer.createMemTable({
                VexusIndex,
                dimension: 4,
                capacity: 64,
                generation: String(generation),
                embeddingFingerprint
            });
        },
        stageAndAdmit(memtable, options = {}) {
            const ordinal = options.ordinal || 'a';
            const docId = options.docId || `doc-${ordinal}`;
            const chunkId = options.chunkId || `chunk-${ordinal}`;
            const fingerprint = options.embeddingFingerprint || memtable.embeddingFingerprint;
            const vector = options.vector || new Float32Array([1, 2, 3, 4]);

            if (!store.getDocument(docId)) {
                store.createDocument({
                    docId,
                    uri: `${docId}.txt`,
                    visibilitySeq: store.readSequence('visibility_seq')
                });
            }
            if (!store.getChunkHead(chunkId)) {
                store.createChunkIdentity({ chunkId, docId });
            }
            const prepared = store.prepareChunkVersion({
                chunkId,
                sourceRevision: options.sourceRevision || `rev-${ordinal}`,
                slotIndex: options.slotIndex ?? 0,
                contentHash: options.contentHash || (
                    ordinal.charCodeAt(0).toString(16).padStart(2, '0').repeat(32)
                )
            });
            store.markEmbedding({
                chunkVersionId: prepared.chunk_version_id,
                embeddingFingerprint: fingerprint
            });
            const staged = store.stageVector({
                chunkVersionId: prepared.chunk_version_id,
                embeddingFingerprint: fingerprint,
                vectorBlob: vector
            });
            writer.admitVector({
                memtable,
                vectorId: staged.vector_id,
                vector
            });
            if (options.publishCurrent !== false) {
                store.publishCurrentHead({
                    chunkId,
                    chunkVersionId: staged.chunk_version_id,
                    expectedCurrentVersionId: null
                });
            }
            return { staged, vector, chunkId, docId };
        },
        cleanup() {
            try { db.close(); } catch (_) {}
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

function manifestMembers(db, epoch) {
    return db.prepare(`
        SELECT segment_id
        FROM gen_usearch_manifest_segments
        WHERE manifest_epoch = ?
        ORDER BY segment_id
    `).all(BigInt(epoch)).map(row => row.segment_id);
}

test('G3 publishes one verified immutable segment and preserves MemTable overlap', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        const a = fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            vector: new Float32Array([1, 0, 0, 0]),
            contentHash: 'a'.repeat(64)
        });
        const b = fixture.stageAndAdmit(memtable, {
            ordinal: 'b',
            vector: new Float32Array([0, 1, 0, 0]),
            contentHash: 'b'.repeat(64)
        });
        fixture.writer.sealMemTable(memtable);

        assert.equal(fixture.publisher.captureManifestEpoch(), '0');
        const receipt = fixture.publisher.publishSealedMemTable({
            memtable,
            expectedManifestEpoch: '0'
        });

        assert.equal(receipt.manifestEpoch, '1');
        assert.equal(receipt.alreadyPublished, false);
        assert.equal(fs.existsSync(receipt.artifactPath), true);
        assert.equal(sha256File(receipt.artifactPath), receipt.artifactDigest);
        assert.deepEqual(receipt.vectorIds, [a.staged.vector_id, b.staged.vector_id]);

        const segment = fixture.db.prepare(`
            SELECT *
            FROM gen_usearch_segments
            WHERE segment_id = ?
        `).get(receipt.segmentId);
        assert.equal(segment.state, 'PUBLISHED');
        assert.equal(segment.artifact_path, receipt.artifactPath);
        assert.equal(segment.artifact_digest, receipt.artifactDigest);
        assert.equal(segment.vector_count, 2);

        assert.equal(fixture.publisher.captureManifestEpoch(), '1');
        assert.deepEqual(manifestMembers(fixture.db, 1), [receipt.segmentId]);

        const segmentCoverage = fixture.db.prepare(`
            SELECT vector_id, coverage_state
            FROM gen_usearch_vector_coverage
            WHERE source_kind = 'SEGMENT' AND source_id = ?
            ORDER BY vector_id
        `).safeIntegers(true).all(receipt.segmentId);
        assert.deepEqual(
            segmentCoverage.map(row => [row.vector_id.toString(), row.coverage_state]),
            [
                [a.staged.vector_id, 'QUERY_VISIBLE'],
                [b.staged.vector_id, 'QUERY_VISIBLE']
            ]
        );

        const memtableCoverage = fixture.db.prepare(`
            SELECT COUNT(*) AS count
            FROM gen_usearch_vector_coverage
            WHERE source_kind = 'MEMTABLE' AND source_id = ?
              AND coverage_state = 'QUERY_VISIBLE'
        `).get(memtable.sourceId);
        assert.equal(memtableCoverage.count, 2);

        for (const vectorId of receipt.vectorIds) {
            const recovery = fixture.db.prepare(`
                SELECT state, covered_segment_id
                FROM gen_usearch_vector_recovery
                WHERE vector_id = ?
            `).get(BigInt(vectorId));
            assert.deepEqual(recovery, {
                state: 'SEGMENT_COVERED',
                covered_segment_id: receipt.segmentId
            });
        }

        const retry = fixture.publisher.publishSealedMemTable({
            memtable,
            expectedManifestEpoch: '1'
        });
        assert.equal(retry.alreadyPublished, true);
        assert.equal(retry.segmentId, receipt.segmentId);
        assert.equal(retry.artifactDigest, receipt.artifactDigest);
        assert.equal(fixture.publisher.captureManifestEpoch(), '1');
    } finally {
        fixture.cleanup();
    }
});

test('stale manifest CAS leaves finalized artifact unpublished and retryable', () => {
    const fixture = createFixture();
    try {
        const first = fixture.createMemtable(1);
        fixture.stageAndAdmit(first, {
            ordinal: 'a',
            vector: new Float32Array([1, 0, 0, 0]),
            contentHash: 'c'.repeat(64)
        });
        fixture.writer.sealMemTable(first);
        const firstReceipt = fixture.publisher.publishSealedMemTable({
            memtable: first,
            expectedManifestEpoch: '0'
        });
        assert.equal(firstReceipt.manifestEpoch, '1');

        const second = fixture.createMemtable(2);
        const staged = fixture.stageAndAdmit(second, {
            ordinal: 'b',
            vector: new Float32Array([0, 1, 0, 0]),
            contentHash: 'd'.repeat(64)
        });
        fixture.writer.sealMemTable(second);

        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable: second,
                expectedManifestEpoch: '0'
            }),
            error => error?.code === 'COMPACTION_PUBLICATION_STALE'
        );

        assert.equal(fixture.publisher.captureManifestEpoch(), '1');
        assert.deepEqual(manifestMembers(fixture.db, 1), [firstReceipt.segmentId]);

        const pending = fixture.db.prepare(`
            SELECT *
            FROM gen_usearch_segments
            WHERE state = 'FINALIZED_DURABLE'
        `).get();
        assert.ok(pending);
        assert.equal(fs.existsSync(pending.artifact_path), true);
        assert.equal(sha256File(pending.artifact_path), pending.artifact_digest);

        const noCoverage = fixture.db.prepare(`
            SELECT COUNT(*) AS count
            FROM gen_usearch_vector_coverage
            WHERE source_kind = 'SEGMENT' AND source_id = ?
        `).get(pending.segment_id);
        assert.equal(noCoverage.count, 0);

        const recoveryBeforeRetry = fixture.db.prepare(`
            SELECT state
            FROM gen_usearch_vector_recovery
            WHERE vector_id = ?
        `).get(BigInt(staged.staged.vector_id));
        assert.equal(recoveryBeforeRetry.state, 'RECOVERY_REQUIRED');

        const retry = fixture.publisher.publishSealedMemTable({
            memtable: second,
            expectedManifestEpoch: '1'
        });
        assert.equal(retry.manifestEpoch, '2');
        assert.deepEqual(
            retry.manifestSegmentIds,
            [firstReceipt.segmentId, retry.segmentId].sort()
        );
        assert.deepEqual(
            manifestMembers(fixture.db, 2),
            [firstReceipt.segmentId, retry.segmentId].sort()
        );
    } finally {
        fixture.cleanup();
    }
});

test('corrupted finalized artifact cannot enter the manifest on retry', () => {
    const fixture = createFixture();
    try {
        const first = fixture.createMemtable(1);
        fixture.stageAndAdmit(first, {
            ordinal: 'a',
            contentHash: 'e'.repeat(64)
        });
        fixture.writer.sealMemTable(first);
        fixture.publisher.publishSealedMemTable({
            memtable: first,
            expectedManifestEpoch: '0'
        });

        const second = fixture.createMemtable(2);
        fixture.stageAndAdmit(second, {
            ordinal: 'b',
            contentHash: 'f'.repeat(64)
        });
        fixture.writer.sealMemTable(second);
        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable: second,
                expectedManifestEpoch: '0'
            }),
            error => error?.code === 'COMPACTION_PUBLICATION_STALE'
        );

        const pending = fixture.db.prepare(`
            SELECT *
            FROM gen_usearch_segments
            WHERE state = 'FINALIZED_DURABLE'
        `).get();
        fs.appendFileSync(pending.artifact_path, Buffer.from('corrupt'));

        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable: second,
                expectedManifestEpoch: '1'
            }),
            error => error?.code === 'SEGMENT_ARTIFACT_INVALID'
        );
        assert.equal(fixture.publisher.captureManifestEpoch(), '1');
        assert.equal(
            fixture.db.prepare(`
                SELECT COUNT(*) AS count
                FROM gen_usearch_vector_coverage
                WHERE source_kind = 'SEGMENT' AND source_id = ?
            `).get(pending.segment_id).count,
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('manifest publication fails closed when SQLite silently ignores a manifest member', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        const staged = fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: '1'.repeat(64)
        });
        fixture.writer.sealMemTable(memtable);

        fixture.db.exec(`
            CREATE TRIGGER ignore_g3_manifest_member
            BEFORE INSERT ON gen_usearch_manifest_segments
            BEGIN
                SELECT RAISE(IGNORE);
            END;
        `);

        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable,
                expectedManifestEpoch: '0'
            }),
            error => error?.code === 'RECOVERY_MANIFEST_INVALID'
        );

        assert.equal(fixture.publisher.captureManifestEpoch(), '0');
        assert.deepEqual(manifestMembers(fixture.db, 0), []);

        const segment = fixture.db.prepare(`
            SELECT *
            FROM gen_usearch_segments
            ORDER BY created_at DESC
            LIMIT 1
        `).get();
        assert.equal(segment.state, 'FINALIZED_DURABLE');

        assert.equal(
            fixture.db.prepare(`
                SELECT COUNT(*) AS count
                FROM gen_usearch_vector_coverage
                WHERE source_kind = 'SEGMENT'
            `).get().count,
            0
        );
        assert.equal(
            fixture.db.prepare(`
                SELECT state
                FROM gen_usearch_vector_recovery
                WHERE vector_id = ?
            `).get(BigInt(staged.staged.vector_id)).state,
            'RECOVERY_REQUIRED'
        );
    } finally {
        fixture.cleanup();
    }
});

test('mixed or incomplete recovery authority fails before segment finalization', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        const staged = fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: '2'.repeat(64)
        });
        fixture.writer.sealMemTable(memtable);

        fixture.db.prepare(`
            UPDATE gen_usearch_vector_recovery
            SET embedding_fingerprint = 'embed-v2'
            WHERE vector_id = ?
        `).run(BigInt(staged.staged.vector_id));

        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable,
                expectedManifestEpoch: '0'
            }),
            error => error?.code === 'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE'
        );

        const segment = fixture.db.prepare(`
            SELECT *
            FROM gen_usearch_segments
            ORDER BY created_at DESC
            LIMIT 1
        `).get();
        assert.equal(segment.state, 'BUILDING');
        assert.equal(segment.artifact_path, null);
        assert.equal(segment.artifact_digest, null);
        assert.equal(fixture.publisher.captureManifestEpoch(), '0');
        assert.equal(
            fixture.db.prepare(`
                SELECT COUNT(*) AS count
                FROM gen_usearch_vector_coverage
                WHERE source_kind = 'SEGMENT'
            `).get().count,
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('G3 refuses ACTIVE or empty Gen0 sources', () => {
    const fixture = createFixture();
    try {
        const active = fixture.createMemtable(1);
        fixture.stageAndAdmit(active, {
            ordinal: 'a',
            contentHash: '3'.repeat(64)
        });
        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable: active,
                expectedManifestEpoch: '0'
            }),
            error => error?.code === 'MEMTABLE_NOT_QUERY_VISIBLE'
        );

        fixture.writer.sealMemTable(active);
        const empty = fixture.createMemtable(2);
        fixture.writer.sealMemTable(empty);
        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable: empty,
                expectedManifestEpoch: '0'
            }),
            error => error?.code === 'SEGMENT_ARTIFACT_INVALID'
        );
    } finally {
        fixture.cleanup();
    }
});
