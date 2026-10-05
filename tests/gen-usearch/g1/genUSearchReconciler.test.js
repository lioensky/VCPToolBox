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
const {
    hashExactChunkContent,
    hashCanonical,
    hashIdentitySnapshot,
    deriveInsertedChunkId,
    assertIdentityOnlyPlan,
    reconcileDocumentChunks
} = require('../../../modules/knowledgeBase/genUSearchReconciler');

function baseOptions(overrides = {}) {
    return {
        docId: 'doc-1',
        baseDocumentUri: 'diary/a.txt',
        observedSourceDigest: 'source-digest-1',
        observedSourceRevision: 'rev-2',
        targetRevision: 'rev-2',
        previousChunks: [],
        nextChunks: [],
        ...overrides
    };
}

function previous(chunkId, slotIndex, content) {
    return { chunkId, slotIndex, content };
}

function next(slotIndex, content) {
    return { slotIndex, content };
}

function createStoreFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-g1-reconcile-'));
    const db = new Database(path.join(root, 'knowledge.sqlite'));
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    initializeKnowledgeBaseSchema(db, { logPrefix: 'GenUSearchReconcileTest' });
    let now = 5000;
    const store = new GenUSearchMetadataStore({ db, now: () => now++ });
    store.createDocument({
        docId: 'doc-1',
        uri: 'diary/a.txt',
        visibilitySeq: '0'
    });
    return {
        root,
        db,
        store,
        cleanup() {
            try { db.close(); } catch (_) {}
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

function publishCurrent(fixture, options = {}) {
    const {
        chunkId,
        slotIndex,
        content,
        sourceRevision = 'rev-current'
    } = options;
    let head = fixture.store.getChunkHead(chunkId);
    if (!head) {
        fixture.store.createChunkIdentity({ chunkId, docId: 'doc-1' });
        head = fixture.store.getChunkHead(chunkId);
    }
    const version = fixture.store.prepareChunkVersion({
        chunkId,
        sourceRevision,
        slotIndex,
        contentHash: hashExactChunkContent(content)
    });
    fixture.store.markEmbedding({
        chunkVersionId: version.chunk_version_id,
        embeddingFingerprint: 'embed-v1'
    });
    const staged = fixture.store.stageVector({
        chunkVersionId: version.chunk_version_id,
        embeddingFingerprint: 'embed-v1',
        vectorBlob: new Float32Array([1, 2, 3, slotIndex + 4])
    });
    fixture.db.prepare(`
        INSERT INTO gen_usearch_vector_coverage (
            vector_id, source_kind, source_id, coverage_state,
            created_at, updated_at
        ) VALUES (?, 'MEMTABLE', ?, 'QUERY_VISIBLE', 5000, 5000)
    `).run(BigInt(staged.vector_id), `M-${staged.vector_id}`);
    return fixture.store.publishCurrentHead({
        chunkId,
        chunkVersionId: staged.chunk_version_id,
        expectedCurrentVersionId: head.current_version_id
    });
}

test('exact UTF-8 chunk hashing is byte exact and does not normalize content', () => {
    assert.notEqual(hashExactChunkContent('alpha'), hashExactChunkContent('alpha\n'));
    assert.notEqual(hashExactChunkContent('é'), hashExactChunkContent('e\u0301'));
    assert.equal(hashExactChunkContent('alpha'), hashExactChunkContent('alpha'));
});

test('deterministic inserted IDs are field-bound and delimiter-collision safe', () => {
    const hash = hashExactChunkContent('alpha');
    const first = deriveInsertedChunkId('a\0b', 'c', 0, hash);
    const second = deriveInsertedChunkId('a', 'b\0c', 0, hash);
    assert.notEqual(first, second);
    assert.equal(first, deriveInsertedChunkId('a\0b', 'c', 0, hash));
});

test('unique exact content preserves chunk identity as SAME or MOVE', () => {
    const same = reconcileDocumentChunks(baseOptions({
        previousChunks: [previous('c-a', 0, 'alpha')],
        nextChunks: [next(0, 'alpha')]
    }));
    assert.deepEqual(same.operations, [{
        kind: 'SAME',
        chunkId: 'c-a',
        fromSlot: 0,
        toSlot: 0,
        contentHash: hashExactChunkContent('alpha')
    }]);

    const moved = reconcileDocumentChunks(baseOptions({
        previousChunks: [
            previous('c-a', 0, 'alpha'),
            previous('c-b', 1, 'beta')
        ],
        nextChunks: [next(0, 'beta'), next(1, 'alpha')]
    }));
    assert.equal(moved.operations.filter(op => op.kind === 'MOVE').length, 2);
    assert.deepEqual(
        moved.operations.map(op => op.chunkId).sort(),
        ['c-a', 'c-b']
    );
});

test('one changed chunk between stable anchors is MODIFY and preserves chunk_id', () => {
    const plan = reconcileDocumentChunks(baseOptions({
        previousChunks: [
            previous('c-a', 0, 'anchor-left'),
            previous('c-b', 1, 'old body'),
            previous('c-c', 2, 'anchor-right')
        ],
        nextChunks: [
            next(0, 'anchor-left'),
            next(1, 'new body'),
            next(2, 'anchor-right')
        ]
    }));
    const modify = plan.operations.find(op => op.kind === 'MODIFY');
    assert.equal(modify.chunkId, 'c-b');
    assert.equal(modify.fromSlot, 1);
    assert.equal(modify.toSlot, 1);
});

test('split and merge are structural plans and do not guess inherited child identity', () => {
    const split = reconcileDocumentChunks(baseOptions({
        previousChunks: [
            previous('c-a', 0, 'left'),
            previous('c-parent', 1, 'one body'),
            previous('c-z', 2, 'right')
        ],
        nextChunks: [
            next(0, 'left'),
            next(1, 'body part 1'),
            next(2, 'body part 2'),
            next(3, 'right')
        ]
    }));
    const splitOp = split.operations.find(op => op.kind === 'SPLIT');
    assert.deepEqual(splitOp.oldChunkIds, ['c-parent']);
    assert.equal(splitOp.newChunks.length, 2);
    assert.equal(splitOp.newChunks.some(row => row.chunkId === 'c-parent'), false);

    const merge = reconcileDocumentChunks(baseOptions({
        previousChunks: [
            previous('c-a', 0, 'left'),
            previous('c-1', 1, 'part 1'),
            previous('c-2', 2, 'part 2'),
            previous('c-z', 3, 'right')
        ],
        nextChunks: [next(0, 'left'), next(1, 'merged body'), next(2, 'right')]
    }));
    const mergeOp = merge.operations.find(op => op.kind === 'MERGE');
    assert.deepEqual(mergeOp.oldChunkIds, ['c-1', 'c-2']);
    assert.equal(mergeOp.newChunks.length, 1);
    assert.equal(['c-1', 'c-2'].includes(mergeOp.newChunks[0].chunkId), false);
});

test('insert and delete are deterministic identity operations', () => {
    const insertPlan = reconcileDocumentChunks(baseOptions({
        previousChunks: [previous('c-a', 0, 'left'), previous('c-z', 1, 'right')],
        nextChunks: [next(0, 'left'), next(1, 'inserted'), next(2, 'right')]
    }));
    const insert = insertPlan.operations.find(op => op.kind === 'INSERT');
    assert.ok(insert.chunkId.startsWith('guc_'));

    const again = reconcileDocumentChunks(baseOptions({
        previousChunks: [previous('c-a', 0, 'left'), previous('c-z', 1, 'right')],
        nextChunks: [next(0, 'left'), next(1, 'inserted'), next(2, 'right')]
    }));
    assert.equal(insertPlan.planId, again.planId);
    assert.equal(insertPlan.planDigest, again.planDigest);
    assert.deepEqual(insertPlan.operations, again.operations);

    const deletePlan = reconcileDocumentChunks(baseOptions({
        previousChunks: [
            previous('c-a', 0, 'left'),
            previous('c-x', 1, 'remove me'),
            previous('c-z', 2, 'right')
        ],
        nextChunks: [next(0, 'left'), next(1, 'right')]
    }));
    assert.equal(deletePlan.operations.find(op => op.kind === 'DELETE').chunkId, 'c-x');
});

test('duplicate exact content and cross-anchor uncertainty fail closed to AMBIGUOUS', () => {
    const duplicate = reconcileDocumentChunks(baseOptions({
        previousChunks: [
            previous('c-1', 0, 'same'),
            previous('c-2', 1, 'same')
        ],
        nextChunks: [next(0, 'same'), next(1, 'same')]
    }));
    assert.equal(duplicate.operations.length, 1);
    assert.equal(duplicate.operations[0].kind, 'AMBIGUOUS');
    assert.equal(duplicate.operations[0].reason, 'DUPLICATE_EXACT_CONTENT');

    const crossing = reconcileDocumentChunks(baseOptions({
        previousChunks: [
            previous('c-a', 0, 'A'),
            previous('c-x', 1, 'old'),
            previous('c-b', 2, 'B')
        ],
        nextChunks: [next(0, 'B'), next(1, 'new'), next(2, 'A')]
    }));
    assert.ok(crossing.operations.some(op =>
        op.kind === 'AMBIGUOUS' && op.reason === 'NON_MONOTONIC_EXACT_ANCHORS'
    ));
});

test('current source hashing cannot be bypassed and target revision must equal observed revision', () => {
    assert.throws(
        () => reconcileDocumentChunks(baseOptions({
            nextChunks: [{ slotIndex: 0, contentHash: hashExactChunkContent('alpha') }]
        })),
        error => error?.code === 'CHUNK_HASH_CONTRACT_MISMATCH'
    );

    assert.throws(
        () => reconcileDocumentChunks(baseOptions({
            observedSourceRevision: 'rev-2',
            targetRevision: 'rev-3',
            nextChunks: [next(0, 'alpha')]
        })),
        error => error?.code === 'SOURCE_OBSERVATION_INVALID'
    );
});

test('identity-only plan validation rejects tampering and lifecycle fields', () => {
    const plan = reconcileDocumentChunks(baseOptions({
        previousChunks: [],
        nextChunks: [next(0, 'new chunk')]
    }));
    assert.equal(assertIdentityOnlyPlan(plan), plan);

    const lifecycleTamper = structuredClone(plan);
    lifecycleTamper.operations[0].state = 'ACTIVE';
    assert.throws(
        () => assertIdentityOnlyPlan(lifecycleTamper),
        error => error?.code === 'RECONCILER_AUTHORITY_VIOLATION'
    );

    const nestedLifecycleTamper = structuredClone(reconcileDocumentChunks(baseOptions({
        previousChunks: [
            previous('c-left', 0, 'left'),
            previous('c-parent', 1, 'parent'),
            previous('c-right', 2, 'right')
        ],
        nextChunks: [
            next(0, 'left'),
            next(1, 'child 1'),
            next(2, 'child 2'),
            next(3, 'right')
        ]
    })));
    nestedLifecycleTamper.operations.find(op => op.kind === 'SPLIT').newChunks[0].state = 'ACTIVE';
    assert.throws(
        () => assertIdentityOnlyPlan(nestedLifecycleTamper),
        error => error?.code === 'RECONCILER_AUTHORITY_VIOLATION'
    );

    const duplicateIdentity = structuredClone(plan);
    duplicateIdentity.operations.push(structuredClone(duplicateIdentity.operations[0]));
    duplicateIdentity.summary.INSERT += 1;
    assert.throws(
        () => assertIdentityOnlyPlan(duplicateIdentity),
        error => error?.code === 'CHUNK_IDENTITY_AMBIGUOUS'
    );

    const digestTamper = structuredClone(plan);
    digestTamper.operations[0].contentHash = '0'.repeat(64);
    assert.throws(
        () => assertIdentityOnlyPlan(digestTamper),
        error => error?.code === 'SOURCE_OBSERVATION_INVALID'
    );
});

test('source observation and reconciliation plan are admitted durably in one transaction', () => {
    const fixture = createStoreFixture();
    try {
        const plan = reconcileDocumentChunks(baseOptions({
            previousChunks: [],
            nextChunks: [next(0, 'alpha'), next(1, 'beta')]
        }));
        const admitted = fixture.store.admitReconciliationPlan(plan);
        assert.equal(admitted.planId, plan.planId);
        assert.equal(admitted.planDigest, plan.planDigest);
        assert.equal(admitted.state, 'ADMITTED');
        assert.deepEqual(admitted.operations, plan.operations);

        const document = fixture.store.getDocument('doc-1');
        assert.equal(document.observed_source_digest, plan.observedSourceDigest);
        assert.equal(document.observed_source_revision, plan.observedSourceRevision);
        assert.equal(document.reconcile_target_revision, plan.targetRevision);
        assert.equal(document.reconciliation_state, 'ADMITTED');

        const replay = fixture.store.admitReconciliationPlan(plan);
        assert.deepEqual(replay, admitted);

        const conflict = reconcileDocumentChunks(baseOptions({
            previousChunks: [],
            nextChunks: [next(0, 'different')]
        }));
        assert.throws(
            () => fixture.store.admitReconciliationPlan(conflict),
            error => error?.code === 'SOURCE_OBSERVATION_INVALID'
        );
        assert.equal(fixture.store.getReconciliationPlan(plan.planId).planDigest, plan.planDigest);
    } finally {
        fixture.cleanup();
    }
});

test('stale reconciliation plans are rejected if current-head authority changes before admission', () => {
    const fixture = createStoreFixture();
    try {
        publishCurrent(fixture, {
            chunkId: 'c-stale',
            slotIndex: 0,
            content: 'old'
        });
        const plan = reconcileDocumentChunks(baseOptions({
            previousChunks: fixture.store.getCurrentChunkIdentitySnapshot('doc-1'),
            nextChunks: [next(0, 'desired')]
        }));

        publishCurrent(fixture, {
            chunkId: 'c-stale',
            slotIndex: 0,
            content: 'concurrent',
            sourceRevision: 'rev-concurrent'
        });

        assert.throws(
            () => fixture.store.admitReconciliationPlan(plan),
            error => error?.code === 'STALE_DOCUMENT_WRITER'
        );
        assert.equal(fixture.store.getReconciliationPlan(plan.planId), null);
    } finally {
        fixture.cleanup();
    }
});

test('a pending observation from another revision blocks stale plan admission', () => {
    const fixture = createStoreFixture();
    try {
        const plan = reconcileDocumentChunks(baseOptions({
            previousChunks: [],
            nextChunks: [next(0, 'desired')]
        }));
        fixture.store.recordSourceObservation({
            docId: 'doc-1',
            digest: 'newer-digest',
            revision: 'rev-newer'
        });
        assert.throws(
            () => fixture.store.admitReconciliationPlan(plan),
            error => error?.code === 'STALE_DOCUMENT_WRITER'
        );
    } finally {
        fixture.cleanup();
    }
});

test('plan admission rejects forged old-side semantics even with the correct base snapshot digest', () => {
    const fixture = createStoreFixture();
    try {
        publishCurrent(fixture, {
            chunkId: 'c-forge',
            slotIndex: 0,
            content: 'real-old'
        });
        const snapshot = fixture.store.getCurrentChunkIdentitySnapshot('doc-1');
        const body = {
            planVersion: 1,
            identityOnly: true,
            docId: 'doc-1',
            baseDocumentUri: 'diary/a.txt',
            baseIdentityDigest: hashIdentitySnapshot(snapshot),
            observedSourceDigest: 'forge-digest',
            observedSourceRevision: 'rev-forge',
            targetRevision: 'rev-forge',
            operations: [{
                kind: 'MODIFY',
                chunkId: 'c-forge',
                fromSlot: 0,
                toSlot: 0,
                fromContentHash: hashExactChunkContent('FAKE-OLD'),
                toContentHash: hashExactChunkContent('new')
            }],
            summary: {
                SAME: 0,
                MODIFY: 1,
                MOVE: 0,
                INSERT: 0,
                DELETE: 0,
                SPLIT: 0,
                MERGE: 0,
                AMBIGUOUS: 0
            }
        };
        const planDigest = hashCanonical(body);
        const forged = {
            ...body,
            planDigest,
            planId: `g1r_${planDigest.slice(0, 40)}`
        };

        assert.throws(
            () => fixture.store.admitReconciliationPlan(forged),
            error => error?.code === 'RECONCILER_AUTHORITY_VIOLATION'
        );
        assert.equal(fixture.store.getReconciliationPlan(forged.planId), null);
    } finally {
        fixture.cleanup();
    }
});

test('plan admission rejects partial base-snapshot claims', () => {
    const fixture = createStoreFixture();
    try {
        publishCurrent(fixture, {
            chunkId: 'c-one',
            slotIndex: 0,
            content: 'one'
        });
        publishCurrent(fixture, {
            chunkId: 'c-two',
            slotIndex: 1,
            content: 'two'
        });
        const snapshot = fixture.store.getCurrentChunkIdentitySnapshot('doc-1');
        const body = {
            planVersion: 1,
            identityOnly: true,
            docId: 'doc-1',
            baseDocumentUri: 'diary/a.txt',
            baseIdentityDigest: hashIdentitySnapshot(snapshot),
            observedSourceDigest: 'partial-digest',
            observedSourceRevision: 'rev-partial',
            targetRevision: 'rev-partial',
            operations: [{
                kind: 'DELETE',
                chunkId: 'c-one',
                fromSlot: 0,
                contentHash: hashExactChunkContent('one')
            }],
            summary: {
                SAME: 0,
                MODIFY: 0,
                MOVE: 0,
                INSERT: 0,
                DELETE: 1,
                SPLIT: 0,
                MERGE: 0,
                AMBIGUOUS: 0
            }
        };
        const planDigest = hashCanonical(body);
        const forged = {
            ...body,
            planDigest,
            planId: `g1r_${planDigest.slice(0, 40)}`
        };
        assert.throws(
            () => fixture.store.admitReconciliationPlan(forged),
            error => error?.code === 'RECONCILER_AUTHORITY_VIOLATION'
        );
    } finally {
        fixture.cleanup();
    }
});

test('same durable plan replay is idempotent even after downstream identity materialization', () => {
    const fixture = createStoreFixture();
    try {
        const plan = reconcileDocumentChunks(baseOptions({
            previousChunks: [],
            nextChunks: [next(0, 'alpha')]
        }));
        const first = fixture.store.admitReconciliationPlan(plan);
        const inserted = plan.operations.find(op => op.kind === 'INSERT');
        fixture.store.createChunkIdentity({
            chunkId: inserted.chunkId,
            docId: 'doc-1'
        });

        const replay = fixture.store.admitReconciliationPlan(plan);
        assert.equal(replay.planId, first.planId);
        assert.equal(replay.planDigest, first.planDigest);
        assert.equal(replay.state, first.state);
    } finally {
        fixture.cleanup();
    }
});

test('admitted reconciliation cannot be regressed to PENDING by a newer observation', () => {
    const fixture = createStoreFixture();
    try {
        const plan = reconcileDocumentChunks(baseOptions({
            observedSourceDigest: 'digest-admitted',
            observedSourceRevision: 'rev-admitted',
            targetRevision: 'rev-admitted',
            previousChunks: [],
            nextChunks: [next(0, 'new')]
        }));
        const admitted = fixture.store.admitReconciliationPlan(plan);
        assert.equal(admitted.state, 'ADMITTED');

        const replay = fixture.store.recordSourceObservation({
            docId: 'doc-1',
            digest: 'digest-admitted',
            revision: 'rev-admitted'
        });
        assert.equal(replay.reconciliation_state, 'ADMITTED');
        assert.equal(replay.observed_source_revision, 'rev-admitted');

        assert.throws(
            () => fixture.store.recordSourceObservation({
                docId: 'doc-1',
                digest: 'digest-newer',
                revision: 'rev-newer'
            }),
            error => error?.code === 'SOURCE_OBSERVATION_INVALID'
        );

        const after = fixture.store.getDocument('doc-1');
        assert.equal(after.reconciliation_state, 'ADMITTED');
        assert.equal(after.observed_source_revision, 'rev-admitted');
        assert.equal(after.observed_source_digest, 'digest-admitted');
    } finally {
        fixture.cleanup();
    }
});

test('the same source revision cannot change digest while pending', () => {
    const fixture = createStoreFixture();
    try {
        fixture.store.recordSourceObservation({
            docId: 'doc-1',
            digest: 'digest-a',
            revision: 'rev-stable'
        });
        assert.throws(
            () => fixture.store.recordSourceObservation({
                docId: 'doc-1',
                digest: 'digest-b',
                revision: 'rev-stable'
            }),
            error => error?.code === 'SOURCE_COMMIT_UNVERIFIED'
        );
        const after = fixture.store.getDocument('doc-1');
        assert.equal(after.observed_source_digest, 'digest-a');
        assert.equal(after.observed_source_revision, 'rev-stable');
        assert.equal(after.reconciliation_state, 'PENDING');
    } finally {
        fixture.cleanup();
    }
});

test('AMBIGUOUS reconciliation is persisted as ERROR and never becomes publishable admission', () => {
    const fixture = createStoreFixture();
    try {
        publishCurrent(fixture, { chunkId: 'c-1', slotIndex: 0, content: 'same' });
        publishCurrent(fixture, { chunkId: 'c-2', slotIndex: 1, content: 'same' });
        const ambiguous = reconcileDocumentChunks(baseOptions({
            previousChunks: [
                previous('c-1', 0, 'same'),
                previous('c-2', 1, 'same')
            ],
            nextChunks: [next(0, 'same'), next(1, 'same')]
        }));
        assert.equal(ambiguous.summary.AMBIGUOUS, 1);

        const recorded = fixture.store.admitReconciliationPlan(ambiguous);
        assert.equal(recorded.state, 'ERROR');
        assert.equal(recorded.summary.AMBIGUOUS, 1);

        const document = fixture.store.getDocument('doc-1');
        assert.equal(document.reconciliation_state, 'ERROR');
        assert.equal(document.index_state, 'INDEX_ERROR');
    } finally {
        fixture.cleanup();
    }
});

test('a later committed source revision can supersede an errored ambiguous plan', () => {
    const fixture = createStoreFixture();
    try {
        publishCurrent(fixture, { chunkId: 'c-1', slotIndex: 0, content: 'same' });
        publishCurrent(fixture, { chunkId: 'c-2', slotIndex: 1, content: 'same' });
        const ambiguous = reconcileDocumentChunks(baseOptions({
            observedSourceDigest: 'digest-2',
            observedSourceRevision: 'rev-2',
            targetRevision: 'rev-2',
            previousChunks: [
                previous('c-1', 0, 'same'),
                previous('c-2', 1, 'same')
            ],
            nextChunks: [next(0, 'same'), next(1, 'same')]
        }));
        fixture.store.admitReconciliationPlan(ambiguous);

        const nextPlan = reconcileDocumentChunks(baseOptions({
            observedSourceDigest: 'digest-3',
            observedSourceRevision: 'rev-3',
            targetRevision: 'rev-3',
            previousChunks: fixture.store.getCurrentChunkIdentitySnapshot('doc-1'),
            nextChunks: [next(0, 'unique')]
        }));
        const admitted = fixture.store.admitReconciliationPlan(nextPlan);
        assert.equal(admitted.state, 'ADMITTED');
        assert.equal(
            fixture.store.getReconciliationPlan(ambiguous.planId).state,
            'SUPERSEDED'
        );
        const document = fixture.store.getDocument('doc-1');
        assert.equal(document.observed_source_revision, 'rev-3');
        assert.equal(document.reconciliation_state, 'ADMITTED');
    } finally {
        fixture.cleanup();
    }
});

test('plan admission enforces chunk ownership, fresh-ID collision safety and one unresolved plan per document', () => {
    const fixture = createStoreFixture();
    try {
        fixture.store.createDocument({
            docId: 'doc-2',
            uri: 'diary/b.txt',
            visibilitySeq: '0'
        });
        fixture.store.createChunkIdentity({ chunkId: 'foreign-chunk', docId: 'doc-2' });

        const foreign = reconcileDocumentChunks(baseOptions({
            previousChunks: [previous('foreign-chunk', 0, 'old')],
            nextChunks: [next(0, 'new')]
        }));
        assert.throws(
            () => fixture.store.admitReconciliationPlan(foreign),
            error => error?.code === 'CHUNK_IDENTITY_AMBIGUOUS'
        );

        const first = reconcileDocumentChunks(baseOptions({
            nextChunks: [next(0, 'first')]
        }));
        const plannedId = first.operations.find(op => op.kind === 'INSERT').chunkId;
        fixture.store.createChunkIdentity({ chunkId: plannedId, docId: 'doc-2' });
        assert.throws(
            () => fixture.store.admitReconciliationPlan(first),
            error => error?.code === 'CHUNK_IDENTITY_AMBIGUOUS'
        );

        const admitted = reconcileDocumentChunks(baseOptions({
            nextChunks: [next(0, 'safe')]
        }));
        fixture.store.admitReconciliationPlan(admitted);
        const concurrent = reconcileDocumentChunks(baseOptions({
            observedSourceDigest: 'digest-3',
            observedSourceRevision: 'rev-3',
            targetRevision: 'rev-3',
            nextChunks: [next(0, 'later')]
        }));
        assert.throws(
            () => fixture.store.admitReconciliationPlan(concurrent),
            error => error?.code === 'SOURCE_OBSERVATION_INVALID'
        );
    } finally {
        fixture.cleanup();
    }
});

test('failed plan-item persistence rolls back the source observation', () => {
    const fixture = createStoreFixture();
    try {
        const first = reconcileDocumentChunks(baseOptions({
            targetRevision: 'rev-2',
            observedSourceRevision: 'rev-2',
            observedSourceDigest: 'digest-2',
            nextChunks: [next(0, 'alpha')]
        }));
        fixture.store.admitReconciliationPlan(first);
        fixture.db.prepare(`
            UPDATE gen_usearch_reconciliation_plans
            SET state = 'COMPLETE'
            WHERE plan_id = ?
        `).run(first.planId);
        fixture.db.prepare(`
            UPDATE gen_usearch_documents
            SET reconciliation_state = 'COMPLETE', index_state = 'CURRENT'
            WHERE doc_id = 'doc-1'
        `).run();

        fixture.db.exec(`
            CREATE TRIGGER fail_reconciliation_item_insert
            BEFORE INSERT ON gen_usearch_reconciliation_items
            BEGIN
                SELECT RAISE(ABORT, 'forced reconciliation item failure');
            END;
        `);

        const second = reconcileDocumentChunks(baseOptions({
            targetRevision: 'rev-3',
            observedSourceRevision: 'rev-3',
            observedSourceDigest: 'digest-3',
            previousChunks: [],
            nextChunks: [next(0, 'beta')]
        }));
        assert.throws(() => fixture.store.admitReconciliationPlan(second));

        const document = fixture.store.getDocument('doc-1');
        assert.equal(document.observed_source_digest, 'digest-2');
        assert.equal(document.observed_source_revision, 'rev-2');
        assert.equal(document.reconcile_target_revision, 'rev-2');
        assert.equal(document.reconciliation_state, 'COMPLETE');
        assert.equal(document.index_state, 'CURRENT');
        assert.equal(fixture.store.getReconciliationPlan(second.planId), null);
    } finally {
        fixture.cleanup();
    }
});
