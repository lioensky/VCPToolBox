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
const GenUSearchMemTable = require(
    '../../../modules/knowledgeBase/genUSearchMemTable'
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
        assert.equal(segment.dimension, 4);
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


test('G3 ignores forged public MemTable state and vector-list views', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        const staged = fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: '4'.repeat(64)
        });

        Object.defineProperty(memtable, 'state', {
            value: 'SEALED_QUERY_VISIBLE',
            configurable: true
        });
        memtable.listVectorIds = () => ['999'];

        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable,
                expectedManifestEpoch: '0'
            }),
            error => error?.code === 'MEMTABLE_NOT_QUERY_VISIBLE'
        );

        delete memtable.state;
        fixture.writer.sealMemTable(memtable);
        memtable.listVectorIds = () => ['999'];

        const receipt = fixture.publisher.publishSealedMemTable({
            memtable,
            expectedManifestEpoch: '0'
        });
        assert.deepEqual(receipt.vectorIds, [staged.staged.vector_id]);
        assert.equal(receipt.vectorIds.includes('999'), false);
    } finally {
        fixture.cleanup();
    }
});

test('extra SEGMENT coverage injected by a trigger rolls the whole manifest publication back', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: '5'.repeat(64)
        });
        fixture.writer.sealMemTable(memtable);

        fixture.db.exec(`
            CREATE TRIGGER inject_extra_g3_segment_coverage
            AFTER INSERT ON gen_usearch_vector_coverage
            WHEN NEW.source_kind = 'SEGMENT' AND NEW.vector_id != 999
            BEGIN
                INSERT OR REPLACE INTO gen_usearch_vector_coverage (
                    vector_id, source_kind, source_id,
                    coverage_state, created_at, updated_at
                ) VALUES (
                    999, 'SEGMENT', NEW.source_id,
                    'QUERY_VISIBLE', NEW.created_at, NEW.updated_at
                );
            END;
        `);

        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable,
                expectedManifestEpoch: '0'
            }),
            error => error?.code === 'PHYSICAL_COVERAGE_MISSING'
        );

        assert.equal(fixture.publisher.captureManifestEpoch(), '0');
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
                FROM gen_usearch_segments
                ORDER BY created_at DESC
                LIMIT 1
            `).get().state,
            'FINALIZED_DURABLE'
        );
    } finally {
        fixture.cleanup();
    }
});

test('publishing a new epoch cannot mutate the previous manifest epoch', () => {
    const fixture = createFixture();
    try {
        const first = fixture.createMemtable(1);
        fixture.stageAndAdmit(first, {
            ordinal: 'a',
            contentHash: '6'.repeat(64)
        });
        fixture.writer.sealMemTable(first);
        const firstReceipt = fixture.publisher.publishSealedMemTable({
            memtable: first,
            expectedManifestEpoch: '0'
        });

        const second = fixture.createMemtable(2);
        fixture.stageAndAdmit(second, {
            ordinal: 'b',
            contentHash: '7'.repeat(64)
        });
        fixture.writer.sealMemTable(second);

        fixture.db.exec(`
            CREATE TRIGGER mutate_previous_g3_manifest
            AFTER INSERT ON gen_usearch_manifest_segments
            WHEN NEW.manifest_epoch = 2
            BEGIN
                DELETE FROM gen_usearch_manifest_segments
                WHERE manifest_epoch = 1;
            END;
        `);

        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable: second,
                expectedManifestEpoch: '1'
            }),
            error => error?.code === 'RECOVERY_MANIFEST_INVALID'
        );

        assert.equal(fixture.publisher.captureManifestEpoch(), '1');
        assert.deepEqual(
            manifestMembers(fixture.db, 1),
            [firstReceipt.segmentId]
        );
        assert.equal(
            fixture.db.prepare(`
                SELECT COUNT(*) AS count
                FROM gen_usearch_manifest_segments
                WHERE manifest_epoch = 2
            `).get().count,
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('publishing a new segment cannot silently retire an existing manifest member', () => {
    const fixture = createFixture();
    try {
        const first = fixture.createMemtable(1);
        fixture.stageAndAdmit(first, {
            ordinal: 'a',
            contentHash: '8'.repeat(64)
        });
        fixture.writer.sealMemTable(first);
        const firstReceipt = fixture.publisher.publishSealedMemTable({
            memtable: first,
            expectedManifestEpoch: '0'
        });

        const second = fixture.createMemtable(2);
        fixture.stageAndAdmit(second, {
            ordinal: 'b',
            contentHash: '9'.repeat(64)
        });
        fixture.writer.sealMemTable(second);

        fixture.db.exec(`
            CREATE TRIGGER retire_previous_g3_segment
            AFTER UPDATE OF state ON gen_usearch_segments
            WHEN NEW.state = 'PUBLISHED'
            BEGIN
                UPDATE gen_usearch_segments
                SET state = 'RETIRED'
                WHERE segment_id != NEW.segment_id
                  AND state = 'PUBLISHED';
            END;
        `);

        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable: second,
                expectedManifestEpoch: '1'
            }),
            error => error?.code === 'RECOVERY_MANIFEST_INVALID'
        );

        assert.equal(fixture.publisher.captureManifestEpoch(), '1');
        assert.equal(
            fixture.db.prepare(`
                SELECT state
                FROM gen_usearch_segments
                WHERE segment_id = ?
            `).get(firstReceipt.segmentId).state,
            'PUBLISHED'
        );
    } finally {
        fixture.cleanup();
    }
});

test('idempotent retry detects missing published SEGMENT coverage', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        const staged = fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: 'a1'.repeat(32)
        });
        fixture.writer.sealMemTable(memtable);
        const receipt = fixture.publisher.publishSealedMemTable({
            memtable,
            expectedManifestEpoch: '0'
        });

        fixture.db.prepare(`
            DELETE FROM gen_usearch_vector_coverage
            WHERE vector_id = ?
              AND source_kind = 'SEGMENT'
              AND source_id = ?
        `).run(BigInt(staged.staged.vector_id), receipt.segmentId);

        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable,
                expectedManifestEpoch: '1'
            }),
            error => error?.code === 'PHYSICAL_COVERAGE_MISSING'
        );
        assert.equal(fixture.publisher.captureManifestEpoch(), '1');
    } finally {
        fixture.cleanup();
    }
});

test('corruption of a current manifest artifact blocks publication of the next segment', () => {
    const fixture = createFixture();
    try {
        const first = fixture.createMemtable(1);
        fixture.stageAndAdmit(first, {
            ordinal: 'a',
            contentHash: 'b1'.repeat(32)
        });
        fixture.writer.sealMemTable(first);
        const firstReceipt = fixture.publisher.publishSealedMemTable({
            memtable: first,
            expectedManifestEpoch: '0'
        });
        fs.appendFileSync(firstReceipt.artifactPath, Buffer.from('corrupt-current'));

        const second = fixture.createMemtable(2);
        fixture.stageAndAdmit(second, {
            ordinal: 'b',
            contentHash: 'c1'.repeat(32)
        });
        fixture.writer.sealMemTable(second);

        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable: second,
                expectedManifestEpoch: '1'
            }),
            error => error?.code === 'RECOVERY_MANIFEST_INVALID'
        );

        assert.equal(fixture.publisher.captureManifestEpoch(), '1');
        assert.deepEqual(
            manifestMembers(fixture.db, 1),
            [firstReceipt.segmentId]
        );
        assert.equal(
            fixture.db.prepare(`
                SELECT COUNT(*) AS count
                FROM gen_usearch_vector_coverage
                WHERE source_kind = 'SEGMENT'
                  AND source_id != ?
            `).get(firstReceipt.segmentId).count,
            0
        );
    } finally {
        fixture.cleanup();
    }
});


test('G3 private Gen0 snapshot authority surface cannot be replaced', () => {
    assert.equal(Object.isFrozen(GenUSearchMemTable), true);
    assert.throws(
        () => {
            GenUSearchMemTable.snapshotForImmutableSegment = () => ({
                state: 'SEALED_QUERY_VISIBLE',
                vectorIds: ['999']
            });
        },
        TypeError
    );
});

test('different SQLite databases sharing one segment root cannot collide on segment identity', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g3-dbns-'));
    const sharedSegmentRoot = path.join(parent, 'segments');

    function createDb(name) {
        const dbPath = path.join(parent, name, 'knowledge.sqlite');
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = FULL');
        db.pragma('foreign_keys = ON');
        initializeKnowledgeBaseSchema(db, { logPrefix: 'GenUSearchG3DbNs' });
        let now = 20000;
        const store = new GenUSearchMetadataStore({ db, now: () => now++ });
        const writer = new GenUSearchPhysicalCoverageWriter({
            db,
            runtimeId: 'shared-runtime',
            now: () => now++
        });
        writer.bootstrapRuntime();
        const publisher = new GenUSearchSegmentPublisher({
            db,
            segmentRoot: sharedSegmentRoot,
            now: () => now++
        });
        const memtable = writer.createMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 16,
            generation: '1',
            embeddingFingerprint: 'embed-v1'
        });

        store.createDocument({
            docId: 'doc-shared',
            uri: 'doc-shared.txt',
            visibilitySeq: store.readSequence('visibility_seq')
        });
        store.createChunkIdentity({
            chunkId: 'chunk-shared',
            docId: 'doc-shared'
        });
        const prepared = store.prepareChunkVersion({
            chunkId: 'chunk-shared',
            sourceRevision: 'rev-shared',
            slotIndex: 0,
            contentHash: 'd1'.repeat(32)
        });
        store.markEmbedding({
            chunkVersionId: prepared.chunk_version_id,
            embeddingFingerprint: 'embed-v1'
        });
        const vector = new Float32Array([1, 2, 3, 4]);
        const staged = store.stageVector({
            chunkVersionId: prepared.chunk_version_id,
            embeddingFingerprint: 'embed-v1',
            vectorBlob: vector
        });
        writer.admitVector({
            memtable,
            vectorId: staged.vector_id,
            vector
        });
        store.publishCurrentHead({
            chunkId: 'chunk-shared',
            chunkVersionId: staged.chunk_version_id,
            expectedCurrentVersionId: null
        });
        writer.sealMemTable(memtable);
        return { db, publisher, memtable };
    }

    let first;
    let second;
    try {
        first = createDb('one');
        second = createDb('two');

        const one = first.publisher.publishSealedMemTable({
            memtable: first.memtable,
            expectedManifestEpoch: '0'
        });
        const two = second.publisher.publishSealedMemTable({
            memtable: second.memtable,
            expectedManifestEpoch: '0'
        });

        assert.notEqual(one.segmentId, two.segmentId);
        assert.notEqual(one.artifactPath, two.artifactPath);
        assert.equal(path.dirname(one.artifactPath), fs.realpathSync(sharedSegmentRoot));
        assert.equal(path.dirname(two.artifactPath), fs.realpathSync(sharedSegmentRoot));
    } finally {
        try { first?.db.close(); } catch (_) {}
        try { second?.db.close(); } catch (_) {}
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('trigger-injected extra SEGMENT_COVERED recovery transition rolls publication back', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        const included = fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: 'e1'.repeat(32)
        });

        fixture.store.createDocument({
            docId: 'doc-extra-recovery',
            uri: 'doc-extra-recovery.txt',
            visibilitySeq: fixture.store.readSequence('visibility_seq')
        });
        fixture.store.createChunkIdentity({
            chunkId: 'chunk-extra-recovery',
            docId: 'doc-extra-recovery'
        });
        const prepared = fixture.store.prepareChunkVersion({
            chunkId: 'chunk-extra-recovery',
            sourceRevision: 'rev-extra-recovery',
            slotIndex: 1,
            contentHash: 'e2'.repeat(32)
        });
        fixture.store.markEmbedding({
            chunkVersionId: prepared.chunk_version_id,
            embeddingFingerprint: 'embed-v1'
        });
        const extra = fixture.store.stageVector({
            chunkVersionId: prepared.chunk_version_id,
            embeddingFingerprint: 'embed-v1',
            vectorBlob: new Float32Array([4, 3, 2, 1])
        });

        fixture.writer.sealMemTable(memtable);

        fixture.db.exec(
            "CREATE TRIGGER inject_extra_g3_recovery " +
            "AFTER UPDATE OF state ON gen_usearch_vector_recovery " +
            "WHEN NEW.state = 'SEGMENT_COVERED' AND NEW.vector_id != " + extra.vector_id + " " +
            "BEGIN " +
            "UPDATE gen_usearch_vector_recovery " +
            "SET state = 'SEGMENT_COVERED', covered_segment_id = NEW.covered_segment_id " +
            "WHERE vector_id = " + extra.vector_id + "; " +
            "END;"
        );

        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable,
                expectedManifestEpoch: '0'
            }),
            error => error?.code === 'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE'
        );

        assert.equal(fixture.publisher.captureManifestEpoch(), '0');
        for (const vectorId of [included.staged.vector_id, extra.vector_id]) {
            assert.equal(
                fixture.db.prepare(`
                    SELECT state
                    FROM gen_usearch_vector_recovery
                    WHERE vector_id = ?
                `).get(BigInt(vectorId)).state,
                'RECOVERY_REQUIRED'
            );
        }
    } finally {
        fixture.cleanup();
    }
});

test('published artifact path cannot be redirected outside the configured segment root', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: 'f1'.repeat(32)
        });
        fixture.writer.sealMemTable(memtable);
        const receipt = fixture.publisher.publishSealedMemTable({
            memtable,
            expectedManifestEpoch: '0'
        });

        const outside = path.join(fixture.root, 'outside.usearch');
        fs.copyFileSync(receipt.artifactPath, outside);
        fixture.db.prepare(`
            UPDATE gen_usearch_segments
            SET artifact_path = ?
            WHERE segment_id = ?
        `).run(outside, receipt.segmentId);

        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable,
                expectedManifestEpoch: '1'
            }),
            error => error?.code === 'SEGMENT_ARTIFACT_INVALID'
        );
        assert.equal(fixture.publisher.captureManifestEpoch(), '1');
    } finally {
        fixture.cleanup();
    }
});


test('G3 additive migration adds segment dimension without rebuilding legacy metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g3-migrate-'));
    const db = new Database(path.join(root, 'knowledge.sqlite'));
    try {
        db.exec(`
            CREATE TABLE gen_usearch_segments (
                segment_id TEXT PRIMARY KEY,
                state TEXT NOT NULL,
                artifact_path TEXT,
                artifact_digest TEXT,
                embedding_fingerprint TEXT NOT NULL,
                vector_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                finalized_at INTEGER,
                published_at INTEGER,
                retired_at INTEGER
            );
            INSERT INTO gen_usearch_segments (
                segment_id, state, artifact_path, artifact_digest,
                embedding_fingerprint, vector_count, created_at
            ) VALUES (
                'legacy-segment', 'BUILDING', NULL, NULL,
                'legacy-fingerprint', 0, 1
            );
        `);

        initializeKnowledgeBaseSchema(db, {
            logPrefix: 'GenUSearchG3DimensionMigration'
        });

        const columns = new Set(
            db.prepare(`PRAGMA table_info(gen_usearch_segments)`)
                .all()
                .map(row => row.name)
        );
        assert.equal(columns.has('dimension'), true);

        const legacy = db.prepare(`
            SELECT segment_id, state, embedding_fingerprint, dimension
            FROM gen_usearch_segments
            WHERE segment_id = 'legacy-segment'
        `).get();
        assert.deepEqual(legacy, {
            segment_id: 'legacy-segment',
            state: 'BUILDING',
            embedding_fingerprint: 'legacy-fingerprint',
            dimension: null
        });
    } finally {
        try { db.close(); } catch (_) {}
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('tampered manifest dimension blocks native verification before next publication', () => {
    const fixture = createFixture();
    try {
        const first = fixture.createMemtable(1);
        fixture.stageAndAdmit(first, {
            ordinal: 'a',
            contentHash: 'd2'.repeat(32)
        });
        fixture.writer.sealMemTable(first);
        const firstReceipt = fixture.publisher.publishSealedMemTable({
            memtable: first,
            expectedManifestEpoch: '0'
        });

        fixture.db.prepare(`
            UPDATE gen_usearch_segments
            SET dimension = 5
            WHERE segment_id = ?
        `).run(firstReceipt.segmentId);

        const second = fixture.createMemtable(2);
        fixture.stageAndAdmit(second, {
            ordinal: 'b',
            contentHash: 'd3'.repeat(32)
        });
        fixture.writer.sealMemTable(second);

        assert.throws(
            () => fixture.publisher.publishSealedMemTable({
                memtable: second,
                expectedManifestEpoch: '1'
            }),
            error => [
                'RECOVERY_MANIFEST_INVALID',
                'PHYSICAL_COVERAGE_MISSING'
            ].includes(error?.code)
        );

        assert.equal(fixture.publisher.captureManifestEpoch(), '1');
        assert.deepEqual(
            manifestMembers(fixture.db, 1),
            [firstReceipt.segmentId]
        );
    } finally {
        fixture.cleanup();
    }
});


test('native Vexus load rejects an artifact dimension mismatch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g3-native-dim-'));
    try {
        const artifactPath = path.join(root, 'dimension.usearch');
        const index = new VexusIndex(4, 16);
        index.addKey64(
            '9007199254740993',
            new Float32Array([1, 0, 0, 0])
        );
        index.save(artifactPath);

        assert.throws(
            () => VexusIndex.load(
                artifactPath,
                null,
                5,
                16
            ),
            /Loaded index dimension mismatch/
        );

        const loaded = VexusIndex.load(
            artifactPath,
            null,
            4,
            16
        );
        assert.equal(loaded.stats().dimensions, 4);
        assert.equal(
            loaded.containsKey64('9007199254740993'),
            true
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});


test('ABORTED vector in a sealed generation is excluded without blocking unrelated flush members', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(101);
        const active = fixture.stageAndAdmit(memtable, {
            ordinal: 'flush-active',
            vector: new Float32Array([1, 0, 0, 0]),
            contentHash: '7'.repeat(64)
        });
        const cancelled = fixture.stageAndAdmit(memtable, {
            ordinal: 'flush-aborted',
            vector: new Float32Array([0, 1, 0, 0]),
            contentHash: '8'.repeat(64),
            publishCurrent: false
        });

        fixture.writer.sealMemTable(memtable);
        const aborted = fixture.store.abortChunkVersion({
            chunkVersionId: cancelled.staged.chunk_version_id
        });
        assert.equal(aborted.state, 'ABORTED');

        const abortedRecovery = fixture.db.prepare(`
            SELECT state, vector_blob
            FROM gen_usearch_vector_recovery
            WHERE vector_id = ?
        `).get(BigInt(cancelled.staged.vector_id));
        assert.equal(abortedRecovery.state, 'RECOVERY_RECLAIMABLE');
        assert.ok(Buffer.isBuffer(abortedRecovery.vector_blob));

        const receipt = fixture.publisher.publishSealedMemTable({
            memtable,
            expectedManifestEpoch: fixture.publisher.captureManifestEpoch()
        });
        assert.deepEqual(receipt.vectorIds, [active.staged.vector_id]);

        const segmentCoverage = fixture.db.prepare(`
            SELECT vector_id
            FROM gen_usearch_vector_coverage
            WHERE source_kind = 'SEGMENT' AND source_id = ?
            ORDER BY vector_id
        `).safeIntegers(true).all(receipt.segmentId);
        assert.deepEqual(
            segmentCoverage.map(row => row.vector_id.toString()),
            [active.staged.vector_id]
        );

        const abortedSegmentCoverage = fixture.db.prepare(`
            SELECT COUNT(*) AS count
            FROM gen_usearch_vector_coverage
            WHERE vector_id = ? AND source_kind = 'SEGMENT'
        `).get(BigInt(cancelled.staged.vector_id));
        assert.equal(abortedSegmentCoverage.count, 0);

        const retry = fixture.publisher.publishSealedMemTable({
            memtable,
            expectedManifestEpoch: fixture.publisher.captureManifestEpoch()
        });
        assert.equal(retry.alreadyPublished, true);
        assert.equal(retry.segmentId, receipt.segmentId);
        assert.deepEqual(retry.vectorIds, [active.staged.vector_id]);
    } finally {
        fixture.cleanup();
    }
});
