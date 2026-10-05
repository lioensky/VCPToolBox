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
const GenUSearchMemTable = require(
    '../../../modules/knowledgeBase/genUSearchMemTable'
);
const GenUSearchSegmentPublisher = require(
    '../../../modules/knowledgeBase/genUSearchSegmentPublisher'
);
const {
    GenUSearchQueryReadViewCoordinator
} = require('../../../modules/knowledgeBase/genUSearchQueryReadView');
const GenUSearchRetrievalService = require(
    '../../../modules/knowledgeBase/genUSearchRetrievalService'
);
const ReadPins = require(
    '../../../modules/knowledgeBase/genUSearchReadPins'
);
const { VexusIndex } = require('../../../rust-vexus-lite');

function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g4-'));
    const dbPath = path.join(root, 'knowledge.sqlite');
    const segmentRoot = path.join(root, 'segments');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    initializeKnowledgeBaseSchema(db, { logPrefix: 'GenUSearchG4Test' });

    let clock = 20000;
    const now = () => clock;
    const tick = (amount = 1) => {
        clock += amount;
        return clock;
    };

    const store = new GenUSearchMetadataStore({ db, now: () => tick() });
    const writer = new GenUSearchPhysicalCoverageWriter({
        db,
        runtimeId: 'runtime-g4',
        now: () => tick()
    });
    writer.bootstrapRuntime();

    const publisher = new GenUSearchSegmentPublisher({
        db,
        segmentRoot,
        now: () => tick()
    });

    db.prepare(
        "UPDATE gen_usearch_runtime_ownership SET owner_id = ?, serving_state = 'SERVING', runtime_fence = ?, acquired_at = ?, updated_at = ? WHERE singleton = 1"
    ).run('runtime-g4', 7n, BigInt(tick()), BigInt(tick()));

    const coordinator = new GenUSearchQueryReadViewCoordinator({
        db,
        runtimeId: 'runtime-g4',
        segmentRoot,
        now,
        maxReadViewMs: 1000
    });
    const retrieval = new GenUSearchRetrievalService({ coordinator });

    function createMemtable(generation, fingerprint = 'embed-v1') {
        return writer.createMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 64,
            generation: String(generation),
            embeddingFingerprint: fingerprint
        });
    }

    function stageAndAdmit(memtable, options = {}) {
        const ordinal = options.ordinal || 'a';
        const docId = options.docId || 'doc-' + ordinal;
        const chunkId = options.chunkId || 'chunk-' + ordinal;
        const fingerprint = options.embeddingFingerprint || memtable.embeddingFingerprint;
        const vector = options.vector || new Float32Array([1, 0, 0, 0]);

        if (!store.getDocument(docId)) {
            store.createDocument({
                docId,
                uri: docId + '.txt',
                visibilitySeq: store.readSequence('visibility_seq')
            });
        }
        if (!store.getChunkHead(chunkId)) {
            store.createChunkIdentity({ chunkId, docId });
        }
        const prepared = store.prepareChunkVersion({
            chunkId,
            sourceRevision: options.sourceRevision || 'rev-' + ordinal + '-' + tick(),
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
                expectedCurrentVersionId: options.expectedCurrentVersionId ?? null
            });
        }
        return { staged, vector, chunkId, docId };
    }

    function publishMemtable(memtable) {
        writer.sealMemTable(memtable);
        return publisher.publishSealedMemTable({
            memtable,
            expectedManifestEpoch: publisher.captureManifestEpoch()
        });
    }

    return {
        root,
        db,
        store,
        writer,
        publisher,
        coordinator,
        retrieval,
        segmentRoot,
        now,
        tick,
        createMemtable,
        stageAndAdmit,
        publishMemtable,
        cleanup() {
            try { db.close(); } catch (_) {}
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

test('G4 acquires complete immutable QueryReadView and releases pins only after quiescence', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            vector: new Float32Array([1, 0, 0, 0]),
            contentHash: 'a'.repeat(64)
        });

        const view = fixture.coordinator.acquire({
            memtables: [memtable],
            deadline: fixture.now() + 500
        });

        for (const field of [
            'read_view_id',
            'visibility_seq',
            'metadata_snapshot',
            'manifest_snapshot',
            'memtable_generation_set',
            'runtime_fence',
            'created_at',
            'deadline'
        ]) {
            assert.ok(Object.prototype.hasOwnProperty.call(view, field), field);
        }
        assert.equal(Object.isFrozen(view.metadata_snapshot), true);
        assert.equal(Object.isFrozen(view.manifest_snapshot), true);
        assert.equal(Object.isFrozen(view.memtable_generation_set), true);
        assert.equal(view.state, 'ACTIVE');
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            1
        );

        assert.throws(
            () => fixture.coordinator.release(view),
            error => error?.code === 'READER_PIN_VIOLATION'
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            1
        );

        assert.equal(
            fixture.coordinator.release(view, { workerQuiescent: true }),
            true
        );
        assert.equal(view.state, 'RELEASED');
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            0
        );
        assert.equal(
            fixture.coordinator.release(view, { workerQuiescent: true }),
            false
        );
    } finally {
        fixture.cleanup();
    }
});

test('deadline requests cancellation without releasing pins', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: 'b'.repeat(64)
        });
        const view = fixture.coordinator.acquire({
            memtables: [memtable],
            deadline: fixture.now() + 10
        });

        fixture.tick(10);
        assert.throws(
            () => fixture.coordinator.assertUsable(view),
            error => error?.code === 'QUERY_READ_VIEW_EXPIRED'
        );
        assert.equal(view.state, 'CANCEL_REQUESTED');
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            1
        );

        fixture.coordinator.release(view, { workerQuiescent: true });
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('current vector without a pinned physical source fails all-or-nothing acquisition', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: 'c'.repeat(64)
        });

        assert.throws(
            () => fixture.coordinator.acquire({
                memtables: [],
                deadline: fixture.now() + 500
            }),
            error => error?.code === 'QUERY_READ_VIEW_PHYSICAL_GAP'
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('failed manifest verification cleans MemTable and segment provisional pins', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: 'd'.repeat(64)
        });
        const receipt = fixture.publishMemtable(memtable);
        fs.appendFileSync(receipt.artifactPath, Buffer.from([1, 2, 3]));

        assert.throws(
            () => fixture.coordinator.acquire({
                memtables: [memtable],
                deadline: fixture.now() + 500
            }),
            error => error?.code === 'RECOVERY_MANIFEST_INVALID'
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            0
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.segmentPinCount(receipt.segmentId),
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('G4 retrieval deduplicates MEMTABLE and SEGMENT overlap to one logical candidate', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        const current = fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            vector: new Float32Array([1, 0, 0, 0]),
            contentHash: 'e'.repeat(64)
        });
        const receipt = fixture.publishMemtable(memtable);

        const view = fixture.coordinator.acquire({
            memtables: [memtable],
            deadline: fixture.now() + 500
        });
        const result = fixture.retrieval.search({
            view,
            query: new Float32Array([1, 0, 0, 0]),
            embeddingFingerprint: 'embed-v1',
            k: 10
        });

        assert.equal(result.hits.length, 1);
        assert.equal(result.hits[0].vector_id, current.staged.vector_id);
        assert.deepEqual(result.hits[0].physical_sources, [
            'MEMTABLE:' + memtable.sourceId,
            'SEGMENT:' + receipt.segmentId
        ].sort());
        fixture.coordinator.release(view, { workerQuiescent: true });
    } finally {
        fixture.cleanup();
    }
});

test('snapshot-current filtering drops stale segment hit after logical head moves', () => {
    const fixture = createFixture();
    try {
        const firstMemtable = fixture.createMemtable(1);
        const first = fixture.stageAndAdmit(firstMemtable, {
            ordinal: 'a',
            docId: 'doc-shift',
            chunkId: 'chunk-shift',
            vector: new Float32Array([1, 0, 0, 0]),
            contentHash: 'f'.repeat(64)
        });
        fixture.publishMemtable(firstMemtable);

        const secondMemtable = fixture.createMemtable(2);
        const second = fixture.stageAndAdmit(secondMemtable, {
            ordinal: 'b',
            docId: 'doc-shift',
            chunkId: 'chunk-shift',
            slotIndex: 0,
            vector: new Float32Array([0, 1, 0, 0]),
            contentHash: '1'.repeat(64),
            expectedCurrentVersionId: first.staged.chunk_version_id
        });

        const view = fixture.coordinator.acquire({
            memtables: [firstMemtable, secondMemtable],
            deadline: fixture.now() + 500
        });
        const result = fixture.retrieval.search({
            view,
            query: new Float32Array([1, 0, 0, 0]),
            embeddingFingerprint: 'embed-v1',
            k: 10
        });

        assert.equal(result.hits.length, 1);
        assert.equal(result.hits[0].vector_id, second.staged.vector_id);
        assert.notEqual(result.hits[0].vector_id, first.staged.vector_id);
        fixture.coordinator.release(view, { workerQuiescent: true });
    } finally {
        fixture.cleanup();
    }
});

test('runtime fence change after acquisition blocks query response without releasing pins', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: '2'.repeat(64)
        });
        const view = fixture.coordinator.acquire({
            memtables: [memtable],
            deadline: fixture.now() + 500
        });

        fixture.db.prepare(
            "UPDATE gen_usearch_runtime_ownership SET runtime_fence = runtime_fence + 1, updated_at = ? WHERE singleton = 1"
        ).run(BigInt(fixture.tick()));

        assert.throws(
            () => fixture.retrieval.search({
                view,
                query: new Float32Array([1, 0, 0, 0]),
                embeddingFingerprint: 'embed-v1',
                k: 5
            }),
            error => error?.code === 'QUERY_FENCE_STALE'
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            1
        );
        fixture.coordinator.release(view, { workerQuiescent: true });
    } finally {
        fixture.cleanup();
    }
});

test('manifest metadata divergence blocks acquisition before a usable view exists', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: '3'.repeat(64)
        });

        fixture.db.prepare(
            "UPDATE gen_usearch_manifest_state SET manifest_epoch = manifest_epoch + 1 WHERE singleton = 1"
        ).run();

        assert.throws(
            () => fixture.coordinator.acquire({
                memtables: [memtable],
                deadline: fixture.now() + 500
            }),
            error => error?.code === 'MANIFEST_METADATA_CONFLICT'
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('missing current-version authority cannot disappear from the metadata snapshot', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: 'ca'.repeat(32)
        });
        fixture.db.prepare(
            'UPDATE gen_usearch_chunk_heads SET current_version_id = ? WHERE chunk_id = ?'
        ).run(999999n, 'chunk-a');

        assert.throws(
            () => fixture.coordinator.acquire({
                memtables: [memtable],
                deadline: fixture.now() + 500
            }),
            error => error?.code === 'QUERY_READ_VIEW_INVALID'
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('current head cannot impersonate an ACTIVE version owned by another chunk', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        const first = fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            docId: 'doc-cross-head',
            chunkId: 'chunk-cross-a',
            slotIndex: 0,
            contentHash: 'cb'.repeat(32)
        });
        const second = fixture.stageAndAdmit(memtable, {
            ordinal: 'b',
            docId: 'doc-cross-head',
            chunkId: 'chunk-cross-b',
            slotIndex: 1,
            vector: new Float32Array([0, 1, 0, 0]),
            contentHash: 'cc'.repeat(32)
        });

        fixture.db.prepare(
            'UPDATE gen_usearch_chunk_heads SET current_version_id = NULL WHERE chunk_id = ?'
        ).run('chunk-cross-b');
        fixture.db.prepare(
            'UPDATE gen_usearch_chunk_heads SET current_version_id = ? WHERE chunk_id = ?'
        ).run(BigInt(second.staged.chunk_version_id), 'chunk-cross-a');

        assert.notEqual(first.staged.chunk_version_id, second.staged.chunk_version_id);
        assert.throws(
            () => fixture.coordinator.acquire({
                memtables: [memtable],
                deadline: fixture.now() + 500
            }),
            error => error?.code === 'QUERY_READ_VIEW_INVALID'
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('manifest membership cannot disappear when segment metadata is missing', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: 'cd'.repeat(32)
        });
        const receipt = fixture.publishMemtable(memtable);

        fixture.db.pragma('foreign_keys = OFF');
        fixture.db.prepare(
            'DELETE FROM gen_usearch_segments WHERE segment_id = ?'
        ).run(receipt.segmentId);

        assert.equal(
            fixture.db.prepare(
                'SELECT COUNT(*) AS count FROM gen_usearch_manifest_segments WHERE segment_id = ?'
            ).get(receipt.segmentId).count,
            1
        );
        assert.throws(
            () => fixture.coordinator.acquire({
                memtables: [memtable],
                deadline: fixture.now() + 500
            }),
            error => error?.code === 'RECOVERY_MANIFEST_INVALID'
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            0
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.segmentPinCount(receipt.segmentId),
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('embedding fingerprint and query dimension are fail-closed', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1, 'embed-v1');
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: '4'.repeat(64)
        });
        const view = fixture.coordinator.acquire({
            memtables: [memtable],
            deadline: fixture.now() + 500
        });

        const noHits = fixture.retrieval.search({
            view,
            query: new Float32Array([1, 0, 0, 0]),
            embeddingFingerprint: 'embed-v2',
            k: 5
        });
        assert.deepEqual(noHits.hits, []);

        assert.throws(
            () => fixture.retrieval.search({
                view,
                query: new Float32Array([1, 0, 0]),
                embeddingFingerprint: 'embed-v1',
                k: 5
            }),
            error => error?.code === 'MANIFEST_INDEX_FINGERPRINT_MISMATCH'
        );
        fixture.coordinator.release(view, { workerQuiescent: true });
    } finally {
        fixture.cleanup();
    }
});


test('reader pin release authority is lease-scoped and raw unpin is not exported', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: 'ce'.repeat(32)
        });
        const receipt = fixture.publishMemtable(memtable);
        const view = fixture.coordinator.acquire({
            memtables: [memtable],
            deadline: fixture.now() + 500
        });

        assert.equal(ReadPins.unpinMemtable, undefined);
        assert.equal(ReadPins.unpinSegment, undefined);
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            1
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.segmentPinCount(receipt.segmentId),
            1
        );

        const extraMemtableLease = ReadPins.acquireMemtablePin(memtable);
        const extraSegmentLease = ReadPins.acquireSegmentPin(receipt.segmentId);
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            2
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.segmentPinCount(receipt.segmentId),
            2
        );

        assert.equal(extraMemtableLease.release(), true);
        assert.equal(extraSegmentLease.release(), true);
        assert.equal(extraMemtableLease.release(), false);
        assert.equal(extraSegmentLease.release(), false);

        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            1
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.segmentPinCount(receipt.segmentId),
            1
        );

        fixture.coordinator.release(view, { workerQuiescent: true });
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            0
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.segmentPinCount(receipt.segmentId),
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('active reader pin blocks G2 physical removal until the worker is quiescent', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        const first = fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            docId: 'doc-pin',
            chunkId: 'chunk-pin',
            slotIndex: 0,
            vector: new Float32Array([1, 0, 0, 0]),
            contentHash: '5'.repeat(64)
        });
        const view = fixture.coordinator.acquire({
            memtables: [memtable],
            deadline: fixture.now() + 500
        });

        const second = fixture.stageAndAdmit(memtable, {
            ordinal: 'b',
            docId: 'doc-pin',
            chunkId: 'chunk-pin',
            slotIndex: 0,
            vector: new Float32Array([0, 1, 0, 0]),
            contentHash: '6'.repeat(64),
            expectedCurrentVersionId: first.staged.chunk_version_id
        });
        assert.equal(
            fixture.store.getChunkVersion(first.staged.chunk_version_id).state,
            'RETIRED'
        );
        assert.equal(
            fixture.store.getChunkVersion(second.staged.chunk_version_id).state,
            'ACTIVE'
        );

        assert.throws(
            () => fixture.writer.hideAndRemoveVector({
                memtable,
                vectorId: first.staged.vector_id
            }),
            error => error?.code === 'READER_PIN_VIOLATION'
        );

        const snapshotResult = fixture.retrieval.search({
            view,
            query: new Float32Array([1, 0, 0, 0]),
            embeddingFingerprint: 'embed-v1',
            k: 5
        });
        assert.equal(snapshotResult.hits.length, 1);
        assert.equal(snapshotResult.hits[0].vector_id, first.staged.vector_id);

        fixture.coordinator.release(view, { workerQuiescent: true });
        const removed = fixture.writer.hideAndRemoveVector({
            memtable,
            vectorId: first.staged.vector_id
        });
        assert.equal(removed.physicalRemoved, true);
    } finally {
        fixture.cleanup();
    }
});

test('hidden MEMTABLE coverage cannot contribute a candidate when SEGMENT coverage remains', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        const current = fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            vector: new Float32Array([1, 0, 0, 0]),
            contentHash: '7'.repeat(64)
        });
        const receipt = fixture.publishMemtable(memtable);

        fixture.db.prepare(
            "DELETE FROM gen_usearch_vector_coverage WHERE vector_id = ? AND source_kind = 'MEMTABLE' AND source_id = ?"
        ).run(BigInt(current.staged.vector_id), memtable.sourceId);

        const view = fixture.coordinator.acquire({
            memtables: [memtable],
            deadline: fixture.now() + 500
        });
        const result = fixture.retrieval.search({
            view,
            query: new Float32Array([1, 0, 0, 0]),
            embeddingFingerprint: 'embed-v1',
            k: 5
        });

        assert.equal(result.hits.length, 1);
        assert.deepEqual(result.hits[0].physical_sources, [
            'SEGMENT:' + receipt.segmentId
        ]);
        fixture.coordinator.release(view, { workerQuiescent: true });
    } finally {
        fixture.cleanup();
    }
});

test('artifact path alias inside segment root cannot impersonate the publisher-owned segment path', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: '8'.repeat(64)
        });
        const receipt = fixture.publishMemtable(memtable);
        const aliasPath = path.join(fixture.segmentRoot, 'alias.usearch');
        fs.copyFileSync(receipt.artifactPath, aliasPath);
        fixture.db.prepare(
            "UPDATE gen_usearch_segments SET artifact_path = ? WHERE segment_id = ?"
        ).run(aliasPath, receipt.segmentId);

        assert.throws(
            () => fixture.coordinator.acquire({
                memtables: [memtable],
                deadline: fixture.now() + 500
            }),
            error => error?.code === 'RECOVERY_MANIFEST_INVALID'
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            0
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.segmentPinCount(receipt.segmentId),
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('acquisition that exceeds its deadline returns no view and cleans provisional pins', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: '9'.repeat(64)
        });

        let calls = 0;
        const coordinator = new GenUSearchQueryReadViewCoordinator({
            db: fixture.db,
            runtimeId: 'runtime-g4',
            segmentRoot: fixture.segmentRoot,
            maxReadViewMs: 500,
            now: () => {
                calls += 1;
                return calls === 1 ? 1000 : 2000;
            }
        });

        assert.throws(
            () => coordinator.acquire({ memtables: [memtable] }),
            error => error?.code === 'QUERY_READ_VIEW_EXPIRED'
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            0
        );
    } finally {
        fixture.cleanup();
    }
});


test('non-SERVING runtime fails acquisition and cleans in-transaction segment pins', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: 'a1'.repeat(32)
        });
        const receipt = fixture.publishMemtable(memtable);
        fixture.db.prepare(
            "UPDATE gen_usearch_runtime_ownership SET serving_state = 'DRAINING', updated_at = ? WHERE singleton = 1"
        ).run(BigInt(fixture.tick()));

        assert.throws(
            () => fixture.coordinator.acquire({
                memtables: [memtable],
                deadline: fixture.now() + 500
            }),
            error => error?.code === 'RUNTIME_FENCE_STALE'
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            0
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.segmentPinCount(receipt.segmentId),
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('QueryReadView acquisition rejects ambient SQLite transactions before pinning', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: 'aa'.repeat(32)
        });

        fixture.db.exec('BEGIN IMMEDIATE');
        try {
            assert.equal(fixture.db.inTransaction, true);
            assert.throws(
                () => fixture.coordinator.acquire({
                    memtables: [memtable],
                    deadline: fixture.now() + 500
                }),
                error => error?.code === 'QUERY_READ_VIEW_INVALID'
            );
            assert.equal(
                GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
                0
            );
        } finally {
            fixture.db.exec('ROLLBACK');
        }
    } finally {
        fixture.cleanup();
    }
});

test('final response fence rejects ambient stale SQLite snapshots', () => {
    const fixture = createFixture();
    let secondDb;
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: 'bb'.repeat(32)
        });
        const view = fixture.coordinator.acquire({
            memtables: [memtable],
            deadline: fixture.now() + 500
        });

        fixture.db.exec('BEGIN');
        try {
            const frozen = fixture.db.prepare(
                'SELECT runtime_fence FROM gen_usearch_runtime_ownership WHERE singleton = 1'
            ).get();
            assert.equal(Number(frozen.runtime_fence), 7);

            secondDb = new Database(fixture.db.name);
            secondDb.pragma('journal_mode = WAL');
            secondDb.pragma('synchronous = FULL');
            secondDb.prepare(
                "UPDATE gen_usearch_runtime_ownership SET owner_id = ?, serving_state = 'SERVING', runtime_fence = ?, updated_at = ? WHERE singleton = 1"
            ).run('runtime-other', 8n, BigInt(fixture.tick()));

            assert.throws(
                () => fixture.retrieval.search({
                    view,
                    query: new Float32Array([1, 0, 0, 0]),
                    embeddingFingerprint: 'embed-v1',
                    k: 5
                }),
                error => error?.code === 'QUERY_FENCE_STALE'
            );
            assert.equal(
                GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
                1
            );
        } finally {
            fixture.db.exec('ROLLBACK');
        }

        fixture.coordinator.release(view, { workerQuiescent: true });
    } finally {
        try { secondDb?.close(); } catch (_) {}
        fixture.cleanup();
    }
});

test('QueryReadView cannot be forged, transferred to another coordinator, or publicly mutated', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: 'b1'.repeat(32)
        });
        const view = fixture.coordinator.acquire({
            memtables: [memtable],
            deadline: fixture.now() + 500
        });

        const secondCoordinator = new GenUSearchQueryReadViewCoordinator({
            db: fixture.db,
            runtimeId: 'runtime-g4',
            segmentRoot: fixture.segmentRoot,
            now: fixture.now,
            maxReadViewMs: 1000
        });

        assert.throws(
            () => secondCoordinator.release(view, { workerQuiescent: true }),
            error => error?.code === 'QUERY_READ_VIEW_INVALID'
        );
        assert.throws(
            () => fixture.retrieval.search({
                view: {
                    ...view,
                    metadata_snapshot: view.metadata_snapshot
                },
                query: new Float32Array([1, 0, 0, 0]),
                embeddingFingerprint: 'embed-v1',
                k: 5
            }),
            error => error?.code === 'QUERY_READ_VIEW_INVALID'
        );
        assert.throws(
            () => {
                view.visibility_seq = '999';
            },
            TypeError
        );
        assert.throws(
            () => view.metadata_snapshot.push({}),
            TypeError
        );
        assert.equal(view.visibility_seq !== '999', true);
        fixture.coordinator.release(view, { workerQuiescent: true });
    } finally {
        fixture.cleanup();
    }
});

test('runtime owner change with unchanged fence still blocks the response', () => {
    const fixture = createFixture();
    try {
        const memtable = fixture.createMemtable(1);
        fixture.stageAndAdmit(memtable, {
            ordinal: 'a',
            contentHash: 'c1'.repeat(32)
        });
        const view = fixture.coordinator.acquire({
            memtables: [memtable],
            deadline: fixture.now() + 500
        });

        fixture.db.prepare(
            "UPDATE gen_usearch_runtime_ownership SET owner_id = ?, updated_at = ? WHERE singleton = 1"
        ).run('runtime-other', BigInt(fixture.tick()));

        assert.throws(
            () => fixture.retrieval.search({
                view,
                query: new Float32Array([1, 0, 0, 0]),
                embeddingFingerprint: 'embed-v1',
                k: 5
            }),
            error => error?.code === 'QUERY_FENCE_STALE'
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(memtable),
            1
        );
        fixture.coordinator.release(view, { workerQuiescent: true });
    } finally {
        fixture.cleanup();
    }
});


test('detached MemTable cannot self-bind and impersonate writer-owned physical authority', () => {
    const fixture = createFixture();
    try {
        const real = fixture.createMemtable(1);
        const current = fixture.stageAndAdmit(real, {
            ordinal: 'a',
            vector: new Float32Array([1, 0, 0, 0]),
            contentHash: 'cf'.repeat(32)
        });

        const attackerToken = {};
        const detached = new GenUSearchMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 64,
            runtimeId: 'runtime-g4',
            generation: '1',
            embeddingFingerprint: 'embed-v1',
            mutationToken: attackerToken
        });
        detached.addVector({
            vectorId: current.staged.vector_id,
            vector: current.vector
        }, attackerToken);

        assert.equal(detached.sourceId, real.sourceId);
        assert.equal(ReadPins.bindMemtableDatabase, undefined);
        assert.equal(ReadPins.assertMemtableDatabase, undefined);
        assert.throws(
            () => GenUSearchPhysicalCoverageWriter.assertMemtableDatabaseAuthority(
                detached,
                fixture.db
            ),
            error => error?.code === 'QUERY_READ_VIEW_INVALID'
        );
        assert.throws(
            () => fixture.coordinator.acquire({
                memtables: [detached],
                deadline: fixture.now() + 500
            }),
            error => error?.code === 'QUERY_READ_VIEW_INVALID'
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(detached),
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('MemTable from another SQLite database cannot impersonate the same runtime generation', () => {
    const first = createFixture();
    const second = createFixture();
    try {
        const local = first.createMemtable(1);
        const foreign = second.createMemtable(1);

        const localVector = first.stageAndAdmit(local, {
            ordinal: 'a',
            docId: 'doc-cross-db',
            chunkId: 'chunk-cross-db',
            vector: new Float32Array([1, 0, 0, 0]),
            contentHash: 'd1'.repeat(32)
        });
        const foreignVector = second.stageAndAdmit(foreign, {
            ordinal: 'a',
            docId: 'doc-cross-db',
            chunkId: 'chunk-cross-db',
            vector: new Float32Array([0, 1, 0, 0]),
            contentHash: 'e1'.repeat(32)
        });

        assert.equal(local.sourceId, foreign.sourceId);
        assert.equal(localVector.staged.vector_id, foreignVector.staged.vector_id);

        assert.throws(
            () => first.coordinator.acquire({
                memtables: [foreign],
                deadline: first.now() + 500
            }),
            error => error?.code === 'QUERY_READ_VIEW_INVALID'
        );
        assert.equal(
            GenUSearchQueryReadViewCoordinator.memtablePinCount(foreign),
            0
        );
    } finally {
        first.cleanup();
        second.cleanup();
    }
});
