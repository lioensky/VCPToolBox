'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
const {
    GenUSearchQueryReadViewCoordinator
} = require('../../../modules/knowledgeBase/genUSearchQueryReadView');
const GenUSearchGcCoordinator = require(
    '../../../modules/knowledgeBase/genUSearchGcCoordinator'
);
const { VexusIndex } = require('../../../rust-vexus-lite');

function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g5-'));
    const dbPath = path.join(root, 'knowledge.sqlite');
    const segmentRoot = path.join(root, 'segments');
    fs.mkdirSync(segmentRoot, { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    initializeKnowledgeBaseSchema(db, { logPrefix: 'GenUSearchG5Test' });

    let clock = 30000;
    const now = () => clock;
    const tick = (amount = 1) => {
        clock += amount;
        return clock;
    };

    const store = new GenUSearchMetadataStore({ db, now: () => tick() });
    db.prepare(
        "UPDATE gen_usearch_runtime_ownership SET owner_id = ?, serving_state = 'SERVING', runtime_fence = ?, acquired_at = ?, updated_at = ? WHERE singleton = 1"
    ).run('runtime-g5', 11n, BigInt(tick()), BigInt(tick()));

    const writer = new GenUSearchPhysicalCoverageWriter({
        db,
        runtimeId: 'runtime-g5',
        now: () => tick()
    });
    writer.bootstrapRuntime();
    const publisher = new GenUSearchSegmentPublisher({
        db,
        segmentRoot,
        now: () => tick()
    });

    const query = new GenUSearchQueryReadViewCoordinator({
        db,
        runtimeId: 'runtime-g5',
        segmentRoot,
        now,
        maxReadViewMs: 10000
    });
    const gc = new GenUSearchGcCoordinator({
        db,
        runtimeId: 'runtime-g5',
        segmentRoot,
        now: () => tick()
    });

    function createMemtable(generation, fingerprint = 'embed-v1') {
        return writer.createMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 64,
            generation: String(generation),
            embeddingFingerprint: fingerprint
        });
    }

    function ensureChunk() {
        if (!store.getDocument('doc-g5')) {
            store.createDocument({
                docId: 'doc-g5',
                uri: 'doc-g5.txt',
                visibilitySeq: store.readSequence('visibility_seq')
            });
        }
        if (!store.getChunkHead('chunk-g5')) {
            store.createChunkIdentity({
                chunkId: 'chunk-g5',
                docId: 'doc-g5'
            });
        }
    }

    function stageVersion(memtable, options = {}) {
        ensureChunk();
        const vector = options.vector || new Float32Array([1, 0, 0, 0]);
        const prepared = store.prepareChunkVersion({
            chunkId: 'chunk-g5',
            sourceRevision: options.sourceRevision || 'rev-' + tick(),
            slotIndex: options.slotIndex ?? 0,
            contentHash: options.contentHash || 'a'.repeat(64)
        });
        store.markEmbedding({
            chunkVersionId: prepared.chunk_version_id,
            embeddingFingerprint: memtable.embeddingFingerprint
        });
        const staged = store.stageVector({
            chunkVersionId: prepared.chunk_version_id,
            embeddingFingerprint: memtable.embeddingFingerprint,
            vectorBlob: vector
        });
        writer.admitVector({
            memtable,
            vectorId: staged.vector_id,
            vector
        });
        if (options.publishCurrent !== false) {
            store.publishCurrentHead({
                chunkId: 'chunk-g5',
                chunkVersionId: staged.chunk_version_id,
                expectedCurrentVersionId: options.expectedCurrentVersionId ?? null
            });
        }
        return { staged, vector };
    }

    function publishMemtable(memtable) {
        writer.sealMemTable(memtable);
        return publisher.publishSealedMemTable({
            memtable,
            expectedManifestEpoch: publisher.captureManifestEpoch()
        });
    }

    function seedRetiredSegmented(options = {}) {
        const firstMemtable = createMemtable(options.firstGeneration || 1);
        const first = stageVersion(firstMemtable, {
            vector: new Float32Array([1, 0, 0, 0]),
            contentHash: '1'.repeat(64)
        });
        const receipt = publishMemtable(firstMemtable);

        const oldView = options.acquireOldView === false
            ? null
            : query.acquire({
                memtables: [firstMemtable],
                deadline: now() + 5000
            });

        const secondMemtable = createMemtable(options.secondGeneration || 2);
        const second = stageVersion(secondMemtable, {
            vector: new Float32Array([0, 1, 0, 0]),
            contentHash: '2'.repeat(64),
            expectedCurrentVersionId: first.staged.chunk_version_id
        });

        return {
            firstMemtable,
            secondMemtable,
            first,
            second,
            receipt,
            oldView
        };
    }

    function recovery(vectorId) {
        return db.prepare(
            'SELECT state, vector_blob, covered_segment_id FROM gen_usearch_vector_recovery WHERE vector_id = ?'
        ).get(BigInt(vectorId));
    }

    return {
        root,
        dbPath,
        segmentRoot,
        db,
        store,
        writer,
        publisher,
        query,
        gc,
        now,
        tick,
        createMemtable,
        stageVersion,
        publishMemtable,
        seedRetiredSegmented,
        recovery,
        cleanup() {
            try { db.close(); } catch (_) {}
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

function releaseRecoveryForRetired(fixture, seeded) {
    const vectorId = seeded.first.staged.vector_id;
    const reclaimable = fixture.gc.certifyRecoveryReclaimable(vectorId);
    assert.equal(reclaimable.state, 'RECOVERY_RECLAIMABLE');
    assert.equal(reclaimable.hasRecoveryBytes, true);

    const released = fixture.gc.releaseRecoveryMaterial(vectorId);
    assert.equal(released.state, 'RECOVERY_RELEASED');
    assert.equal(released.hasRecoveryBytes, false);
    assert.equal(released.coveredSegmentId, seeded.receipt.segmentId);

    const row = fixture.recovery(vectorId);
    assert.equal(row.state, 'RECOVERY_RELEASED');
    assert.equal(row.vector_blob, null);
    assert.equal(row.covered_segment_id, seeded.receipt.segmentId);
}

test('older ACTIVE QueryReadView blocks GC until quiescent release', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented();
        const retired = fixture.store.getChunkVersion(
            seeded.first.staged.chunk_version_id
        );
        assert.equal(retired.state, 'RETIRED');
        assert.ok(BigInt(seeded.oldView.visibility_seq) < BigInt(retired.retired_visibility_seq));

        releaseRecoveryForRetired(fixture, seeded);

        assert.throws(
            () => fixture.gc.markGcEligible(seeded.first.staged.chunk_version_id),
            error => error?.code === 'UNSAFE_GC_ATTEMPT'
        );
        assert.equal(
            fixture.store.getChunkVersion(seeded.first.staged.chunk_version_id).state,
            'RETIRED'
        );

        fixture.query.release(seeded.oldView, { workerQuiescent: true });
        const cert = fixture.gc.markGcEligible(
            seeded.first.staged.chunk_version_id
        );
        assert.equal(cert.state, 'GC_ELIGIBLE');
        assert.equal(cert.recoveryState, 'RECOVERY_RELEASED');
        assert.equal(
            fixture.store.getChunkVersion(seeded.first.staged.chunk_version_id).state,
            'GC_ELIGIBLE'
        );
    } finally {
        fixture.cleanup();
    }
});

test('CANCEL_REQUESTED older QueryReadView still blocks GC', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented();
        releaseRecoveryForRetired(fixture, seeded);

        assert.equal(
            fixture.query.requestCancellation(seeded.oldView),
            'CANCEL_REQUESTED'
        );
        assert.throws(
            () => fixture.gc.markGcEligible(seeded.first.staged.chunk_version_id),
            error => error?.code === 'UNSAFE_GC_ATTEMPT'
        );

        fixture.query.release(seeded.oldView, { workerQuiescent: true });
        assert.equal(
            fixture.gc.markGcEligible(seeded.first.staged.chunk_version_id).state,
            'GC_ELIGIBLE'
        );
    } finally {
        fixture.cleanup();
    }
});

test('QUIESCING older QueryReadView still blocks GC', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented();
        releaseRecoveryForRetired(fixture, seeded);

        assert.equal(
            fixture.query.beginQuiescing(seeded.oldView),
            'QUIESCING'
        );
        assert.throws(
            () => fixture.gc.markGcEligible(seeded.first.staged.chunk_version_id),
            error => error?.code === 'UNSAFE_GC_ATTEMPT'
        );

        fixture.query.release(seeded.oldView, { workerQuiescent: true });
        assert.equal(
            fixture.gc.markGcEligible(seeded.first.staged.chunk_version_id).state,
            'GC_ELIGIBLE'
        );
    } finally {
        fixture.cleanup();
    }
});

test('reader acquired at retirement visibility does not block retired logical GC', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented({ acquireOldView: false });
        releaseRecoveryForRetired(fixture, seeded);

        const retired = fixture.store.getChunkVersion(
            seeded.first.staged.chunk_version_id
        );
        const newerView = fixture.query.acquire({
            memtables: [seeded.secondMemtable],
            deadline: fixture.now() + 5000
        });
        assert.ok(
            BigInt(newerView.visibility_seq) >= BigInt(retired.retired_visibility_seq)
        );

        const cert = fixture.gc.markGcEligible(
            seeded.first.staged.chunk_version_id
        );
        assert.equal(cert.state, 'GC_ELIGIBLE');
        assert.equal(cert.liveViewCount, 1);

        fixture.query.release(newerView, { workerQuiescent: true });
    } finally {
        fixture.cleanup();
    }
});

test('G5 cannot release recovery bytes for the ACTIVE current head', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        const current = fixture.stageVersion(memtable, {
            vector: new Float32Array([1, 0, 0, 0]),
            contentHash: '3'.repeat(64)
        });
        fixture.publishMemtable(memtable);

        assert.equal(
            fixture.store.getChunkVersion(current.staged.chunk_version_id).state,
            'ACTIVE'
        );
        assert.throws(
            () => fixture.gc.certifyRecoveryReclaimable(current.staged.vector_id),
            error => error?.code === 'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE'
        );
        assert.equal(fixture.recovery(current.staged.vector_id).state, 'SEGMENT_COVERED');
    } finally {
        fixture.cleanup();
    }
});

test('corrupt segment after reclaim certification blocks final recovery release', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented({ acquireOldView: false });
        const vectorId = seeded.first.staged.vector_id;
        assert.equal(
            fixture.gc.certifyRecoveryReclaimable(vectorId).state,
            'RECOVERY_RECLAIMABLE'
        );

        fs.appendFileSync(seeded.receipt.artifactPath, Buffer.from([0x00]));
        assert.throws(
            () => fixture.gc.releaseRecoveryMaterial(vectorId),
            error => error?.code === 'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE'
        );

        const row = fixture.recovery(vectorId);
        assert.equal(row.state, 'RECOVERY_RECLAIMABLE');
        assert.ok(Buffer.isBuffer(row.vector_blob));
    } finally {
        fixture.cleanup();
    }
});

test('missing current manifest membership blocks recovery reclaim certification', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented({ acquireOldView: false });
        fixture.db.prepare(
            'DELETE FROM gen_usearch_manifest_segments WHERE manifest_epoch = ? AND segment_id = ?'
        ).run(BigInt(fixture.publisher.captureManifestEpoch()), seeded.receipt.segmentId);

        assert.throws(
            () => fixture.gc.certifyRecoveryReclaimable(
                seeded.first.staged.vector_id
            ),
            error => error?.code === 'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE'
        );
        assert.equal(
            fixture.recovery(seeded.first.staged.vector_id).state,
            'SEGMENT_COVERED'
        );
    } finally {
        fixture.cleanup();
    }
});

test('GC requires RECOVERY_RELEASED and cannot certify current ACTIVE version', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented({ acquireOldView: false });

        assert.throws(
            () => fixture.gc.markGcEligible(seeded.first.staged.chunk_version_id),
            error => error?.code === 'UNSAFE_GC_ATTEMPT'
        );
        assert.throws(
            () => fixture.gc.markGcEligible(seeded.second.staged.chunk_version_id),
            error => error?.code === 'UNSAFE_GC_ATTEMPT'
        );
    } finally {
        fixture.cleanup();
    }
});

test('G5 authority transitions reject ambient SQLite transactions', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented({ acquireOldView: false });
        const tx = fixture.db.transaction(() => {
            fixture.gc.certifyRecoveryReclaimable(
                seeded.first.staged.vector_id
            );
        });
        assert.throws(
            () => tx(),
            error => error?.code === 'QUERY_READ_VIEW_INVALID'
        );
        assert.equal(
            fixture.recovery(seeded.first.staged.vector_id).state,
            'SEGMENT_COVERED'
        );
    } finally {
        fixture.cleanup();
    }
});

test('G5 authority writes require WAL + FULL or EXTRA durability', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented({ acquireOldView: false });
        fixture.db.pragma('synchronous = NORMAL');
        assert.throws(
            () => fixture.gc.certifyRecoveryReclaimable(
                seeded.first.staged.vector_id
            ),
            error => error?.code === 'UNSUPPORTED_DURABILITY_PROFILE'
        );
        fixture.db.pragma('synchronous = FULL');
        assert.equal(
            fixture.gc.certifyRecoveryReclaimable(
                seeded.first.staged.vector_id
            ).state,
            'RECOVERY_RECLAIMABLE'
        );
    } finally {
        fixture.cleanup();
    }
});

test('live reader safety is scoped by underlying SQLite file identity across connections', () => {
    const fixture = createFixture();
    let secondDb;
    try {
        const seeded = fixture.seedRetiredSegmented();
        releaseRecoveryForRetired(fixture, seeded);

        secondDb = new Database(fixture.dbPath);
        secondDb.pragma('journal_mode = WAL');
        secondDb.pragma('synchronous = FULL');
        secondDb.pragma('foreign_keys = ON');
        const secondGc = new GenUSearchGcCoordinator({
            db: secondDb,
            runtimeId: 'runtime-g5',
            segmentRoot: fixture.segmentRoot,
            now: () => fixture.tick()
        });

        const live = secondGc.inspectLiveReadViews();
        assert.equal(live.length, 1);
        assert.equal(live[0].read_view_id, seeded.oldView.read_view_id);

        assert.throws(
            () => secondGc.markGcEligible(
                seeded.first.staged.chunk_version_id
            ),
            error => error?.code === 'UNSAFE_GC_ATTEMPT'
        );

        fixture.query.release(seeded.oldView, { workerQuiescent: true });
        assert.equal(
            secondGc.markGcEligible(
                seeded.first.staged.chunk_version_id
            ).state,
            'GC_ELIGIBLE'
        );
    } finally {
        try { secondDb?.close(); } catch (_) {}
        fixture.cleanup();
    }
});

test('cross-chunk current-head substitution fails closed for recovery and GC authority', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented({ acquireOldView: false });

        fixture.store.createDocument({
            docId: 'doc-foreign-g5',
            uri: 'doc-foreign-g5.txt',
            visibilitySeq: fixture.store.readSequence('visibility_seq')
        });
        fixture.store.createChunkIdentity({
            chunkId: 'chunk-foreign-g5',
            docId: 'doc-foreign-g5'
        });
        const prepared = fixture.store.prepareChunkVersion({
            chunkId: 'chunk-foreign-g5',
            sourceRevision: 'foreign-rev',
            slotIndex: 0,
            contentHash: 'f'.repeat(64)
        });
        fixture.store.markEmbedding({
            chunkVersionId: prepared.chunk_version_id,
            embeddingFingerprint: seeded.secondMemtable.embeddingFingerprint
        });
        const vector = new Float32Array([0, 0, 1, 0]);
        const staged = fixture.store.stageVector({
            chunkVersionId: prepared.chunk_version_id,
            embeddingFingerprint: seeded.secondMemtable.embeddingFingerprint,
            vectorBlob: vector
        });
        fixture.writer.admitVector({
            memtable: seeded.secondMemtable,
            vectorId: staged.vector_id,
            vector
        });
        fixture.store.publishCurrentHead({
            chunkId: 'chunk-foreign-g5',
            chunkVersionId: staged.chunk_version_id,
            expectedCurrentVersionId: null
        });

        fixture.db.prepare(
            'UPDATE gen_usearch_chunk_heads SET current_version_id = ? WHERE chunk_id = ?'
        ).run(BigInt(staged.chunk_version_id), 'chunk-g5');

        assert.throws(
            () => fixture.gc.certifyRecoveryReclaimable(
                seeded.first.staged.vector_id
            ),
            error => error?.code === 'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE'
        );
        assert.equal(
            fixture.recovery(seeded.first.staged.vector_id).state,
            'SEGMENT_COVERED'
        );
    } finally {
        fixture.cleanup();
    }
});

test('runtime fence rollover invalidates an existing G5 coordinator', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented({ acquireOldView: false });
        fixture.db.prepare(
            'UPDATE gen_usearch_runtime_ownership SET runtime_fence = runtime_fence + 1, updated_at = ? WHERE singleton = 1'
        ).run(BigInt(fixture.tick()));

        assert.throws(
            () => fixture.gc.certifyRecoveryReclaimable(
                seeded.first.staged.vector_id
            ),
            error => error?.code === 'RUNTIME_FENCE_STALE'
        );
        assert.equal(
            fixture.recovery(seeded.first.staged.vector_id).state,
            'SEGMENT_COVERED'
        );
    } finally {
        fixture.cleanup();
    }
});

test('silent recovery release rewrite is caught by transactional postcondition', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented({ acquireOldView: false });
        const vectorId = seeded.first.staged.vector_id;
        assert.equal(
            fixture.gc.certifyRecoveryReclaimable(vectorId).state,
            'RECOVERY_RECLAIMABLE'
        );

        fixture.db.exec(`
            CREATE TRIGGER sabotage_g5_release
            AFTER UPDATE OF state ON gen_usearch_vector_recovery
            WHEN NEW.state = 'RECOVERY_RELEASED'
            BEGIN
                UPDATE gen_usearch_vector_recovery
                SET state = 'RECOVERY_RECLAIMABLE',
                    vector_blob = OLD.vector_blob
                WHERE vector_id = NEW.vector_id;
            END;
        `);

        assert.throws(
            () => fixture.gc.releaseRecoveryMaterial(vectorId),
            error => error?.code === 'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE'
        );
        const row = fixture.recovery(vectorId);
        assert.equal(row.state, 'RECOVERY_RECLAIMABLE');
        assert.ok(Buffer.isBuffer(row.vector_blob));
    } finally {
        fixture.cleanup();
    }
});

test('silent GC eligibility rewrite is caught and rolled back', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented({ acquireOldView: false });
        releaseRecoveryForRetired(fixture, seeded);

        fixture.db.exec(`
            CREATE TRIGGER sabotage_g5_gc
            AFTER UPDATE OF state ON gen_usearch_chunk_versions
            WHEN NEW.state = 'GC_ELIGIBLE'
            BEGIN
                UPDATE gen_usearch_chunk_versions
                SET state = 'RETIRED'
                WHERE chunk_version_id = NEW.chunk_version_id;
            END;
        `);

        assert.throws(
            () => fixture.gc.markGcEligible(
                seeded.first.staged.chunk_version_id
            ),
            error => error?.code === 'UNSAFE_GC_ATTEMPT'
        );
        assert.equal(
            fixture.store.getChunkVersion(
                seeded.first.staged.chunk_version_id
            ).state,
            'RETIRED'
        );
    } finally {
        fixture.cleanup();
    }
});

test('forged pre-existing GC_ELIGIBLE state is revalidated against live reader safety', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented();
        releaseRecoveryForRetired(fixture, seeded);

        fixture.db.prepare(
            "UPDATE gen_usearch_chunk_versions SET state = 'GC_ELIGIBLE' WHERE chunk_version_id = ?"
        ).run(BigInt(seeded.first.staged.chunk_version_id));

        assert.throws(
            () => fixture.gc.markGcEligible(
                seeded.first.staged.chunk_version_id
            ),
            error => error?.code === 'UNSAFE_GC_ATTEMPT'
        );

        fixture.query.release(seeded.oldView, { workerQuiescent: true });
        const cert = fixture.gc.markGcEligible(
            seeded.first.staged.chunk_version_id
        );
        assert.equal(cert.state, 'GC_ELIGIBLE');
    } finally {
        fixture.cleanup();
    }
});

test('G5 now callback cannot open an ambient transaction after the durability check', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented({ acquireOldView: false });
        let opened = false;
        const malicious = new GenUSearchGcCoordinator({
            db: fixture.db,
            runtimeId: 'runtime-g5',
            segmentRoot: fixture.segmentRoot,
            now: () => {
                if (!opened) {
                    opened = true;
                    fixture.db.exec('BEGIN');
                }
                return fixture.tick();
            }
        });

        assert.throws(
            () => malicious.certifyRecoveryReclaimable(
                seeded.first.staged.vector_id
            ),
            error => error?.code === 'QUERY_READ_VIEW_INVALID'
        );
        if (fixture.db.inTransaction) fixture.db.exec('ROLLBACK');
        assert.equal(
            fixture.recovery(seeded.first.staged.vector_id).state,
            'SEGMENT_COVERED'
        );
    } finally {
        if (fixture.db.inTransaction) {
            try { fixture.db.exec('ROLLBACK'); } catch (_) {}
        }
        fixture.cleanup();
    }
});

test('durable reader lease from another process blocks GC even when absent from local registry', () => {
    const fixture = createFixture();
    try {
        const seeded = fixture.seedRetiredSegmented({ acquireOldView: false });
        releaseRecoveryForRetired(fixture, seeded);
        const retired = fixture.store.getChunkVersion(
            seeded.first.staged.chunk_version_id
        );
        const blockingVisibility = BigInt(retired.retired_visibility_seq) - 1n;

        fixture.db.prepare(
            "INSERT INTO gen_usearch_read_view_leases(read_view_id, owner_id, runtime_fence, visibility_seq, state, cancellation_requested, worker_quiescent, pins_released, created_at, deadline, updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', 0, 0, 0, ?, ?, ?)"
        ).run(
            'external-process-view',
            'runtime-g5',
            11n,
            blockingVisibility,
            1n,
            999999n,
            1n
        );

        assert.equal(fixture.gc.inspectLiveReadViews().length, 0);
        assert.throws(
            () => fixture.gc.markGcEligible(
                seeded.first.staged.chunk_version_id
            ),
            error => error?.code === 'UNSAFE_GC_ATTEMPT'
        );

        fixture.db.prepare(
            "UPDATE gen_usearch_read_view_leases SET state = 'RELEASED', worker_quiescent = 1, pins_released = 1 WHERE read_view_id = ?"
        ).run('external-process-view');

        assert.equal(
            fixture.gc.markGcEligible(
                seeded.first.staged.chunk_version_id
            ).state,
            'GC_ELIGIBLE'
        );
    } finally {
        fixture.cleanup();
    }
});
