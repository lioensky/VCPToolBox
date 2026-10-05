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
const GenUSearchReconciliationService = require(
    '../../../modules/knowledgeBase/genUSearchReconciliationService'
);
const {
    hashExactChunkContent
} = require('../../../modules/knowledgeBase/genUSearchReconciler');

function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-g1-service-'));
    const db = new Database(path.join(root, 'knowledge.sqlite'));
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    initializeKnowledgeBaseSchema(db, { logPrefix: 'GenUSearchServiceTest' });
    let now = 9000;
    const store = new GenUSearchMetadataStore({ db, now: () => now++ });
    store.createDocument({
        docId: 'doc-1',
        uri: 'diary/a.txt',
        visibilitySeq: '0'
    });
    let sourceView = committedView([]);
    const sourceViewProvider = {
        async readCommittedSourceView(request) {
            assert.deepEqual(request, {
                docId: 'doc-1',
                currentUri: 'diary/a.txt'
            });
            return sourceView;
        },
        async withCommittedSourceView(request, callback) {
            assert.deepEqual(request, {
                docId: 'doc-1',
                currentUri: 'diary/a.txt'
            });
            return callback(sourceView);
        }
    };
    const service = new GenUSearchReconciliationService({
        store,
        sourceViewProvider
    });
    return {
        root,
        db,
        store,
        service,
        setSourceView(view) {
            sourceView = view;
        },
        cleanup() {
            try { db.close(); } catch (_) {}
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

function publishCurrent(fixture, options) {
    const {
        chunkId,
        slotIndex,
        content,
        sourceRevision = 'rev-1',
        sourceId = `M-${chunkId}`
    } = options;
    fixture.store.createChunkIdentity({ chunkId, docId: 'doc-1' });
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
        ) VALUES (?, 'MEMTABLE', ?, 'QUERY_VISIBLE', 9000, 9000)
    `).run(BigInt(staged.vector_id), sourceId);
    fixture.store.publishCurrentHead({
        chunkId,
        chunkVersionId: staged.chunk_version_id,
        expectedCurrentVersionId: null
    });
}

function committedView(chunks, overrides = {}) {
    return {
        state: 'NEW_COMPLETE',
        commitVerified: true,
        bytesStable: true,
        sourceDigest: 'source-digest-v2',
        sourceRevision: 'rev-2',
        chunks,
        ...overrides
    };
}

test('service refuses construction without a canonical source provider', () => {
    const fixture = createFixture();
    try {
        assert.throws(
            () => new GenUSearchReconciliationService({ store: fixture.store }),
            /sourceViewProvider/
        );
    } finally {
        fixture.cleanup();
    }
});

test('production service derives previous identity snapshot only from SQLite current heads', async () => {
    const fixture = createFixture();
    try {
        publishCurrent(fixture, { chunkId: 'c-alpha', slotIndex: 0, content: 'alpha' });
        publishCurrent(fixture, { chunkId: 'c-beta', slotIndex: 1, content: 'beta' });

        assert.deepEqual(fixture.store.getCurrentChunkIdentitySnapshot('doc-1'), [
            {
                chunkId: 'c-alpha',
                slotIndex: 0,
                contentHash: hashExactChunkContent('alpha')
            },
            {
                chunkId: 'c-beta',
                slotIndex: 1,
                contentHash: hashExactChunkContent('beta')
            }
        ]);

        fixture.setSourceView(committedView([
            { slotIndex: 0, content: 'alpha' },
            { slotIndex: 1, content: 'beta changed' }
        ]));
        const { plan, admitted } = await fixture.service.planAndAdmitCurrentSource({
            docId: 'doc-1'
        });

        assert.equal(plan.operations.find(op => op.kind === 'SAME').chunkId, 'c-alpha');
        assert.equal(plan.operations.find(op => op.kind === 'MODIFY').chunkId, 'c-beta');
        assert.equal(admitted.state, 'ADMITTED');
        assert.deepEqual(admitted.operations, plan.operations);
    } finally {
        fixture.cleanup();
    }
});

test('document URI changes while reading source make the reconciliation plan stale', async () => {
    const fixture = createFixture();
    try {
        let releaseSource;
        const sourcePromise = new Promise(resolve => { releaseSource = resolve; });
        const service = new GenUSearchReconciliationService({
            store: fixture.store,
            sourceViewProvider: {
                async readCommittedSourceView(request) {
                    assert.deepEqual(request, {
                        docId: 'doc-1',
                        currentUri: 'diary/a.txt'
                    });
                    return sourcePromise;
                },
                async withCommittedSourceView(request, callback) {
                    assert.deepEqual(request, {
                        docId: 'doc-1',
                        currentUri: 'diary/a.txt'
                    });
                    return callback(await sourcePromise);
                }
            }
        });

        const pendingPlan = service.planCurrentSource({ docId: 'doc-1' });
        fixture.store.moveDocument({
            docId: 'doc-1',
            uri: 'diary/moved.txt'
        });
        releaseSource(committedView([]));

        await assert.rejects(
            () => pendingPlan,
            error => error?.code === 'STALE_DOCUMENT_WRITER'
        );
    } finally {
        fixture.cleanup();
    }
});

test('caller cannot override source or previous identity authority per request', async () => {
    const fixture = createFixture();
    try {
        await assert.rejects(
            () => fixture.service.planCurrentSource({
                docId: 'doc-1',
                previousChunks: [{ chunkId: 'fake', slotIndex: 0, content: 'fake' }]
            }),
            error => error?.code === 'RECONCILER_AUTHORITY_VIOLATION'
        );
        await assert.rejects(
            () => fixture.service.planCurrentSource({
                docId: 'doc-1',
                committedSourceView: committedView([{ slotIndex: 0, content: 'alpha' }])
            }),
            error => error?.code === 'RECONCILER_AUTHORITY_VIOLATION'
        );
    } finally {
        fixture.cleanup();
    }
});

test('only verified stable complete source views from the bound provider may enter reconciliation', async () => {
    const fixture = createFixture();
    try {
        for (const view of [
            committedView([], { state: 'PARTIAL' }),
            committedView([], { commitVerified: false }),
            committedView([], { bytesStable: false })
        ]) {
            fixture.setSourceView(view);
            await assert.rejects(
                () => fixture.service.planCurrentSource({ docId: 'doc-1' }),
                error => error?.code === 'SOURCE_COMMIT_UNVERIFIED'
            );
        }
    } finally {
        fixture.cleanup();
    }
});

test('provider cannot smuggle lifecycle fields inside committed chunks', async () => {
    const fixture = createFixture();
    try {
        fixture.setSourceView(committedView([
            { slotIndex: 0, content: 'alpha', state: 'ACTIVE' }
        ]));
        await assert.rejects(
            () => fixture.service.planCurrentSource({ docId: 'doc-1' }),
            error => error?.code === 'SOURCE_COMMIT_UNVERIFIED'
        );
    } finally {
        fixture.cleanup();
    }
});

test('incomplete or corrupt SQLite current-head snapshots fail closed', async () => {
    const fixture = createFixture();
    try {
        fixture.store.createChunkIdentity({ chunkId: 'orphan-head', docId: 'doc-1' });
        fixture.setSourceView(committedView([{ slotIndex: 0, content: 'alpha' }]));
        await assert.rejects(
            () => fixture.service.planCurrentSource({ docId: 'doc-1' }),
            error => error?.code === 'METADATA_INTEGRITY_FAILURE'
        );
    } finally {
        fixture.cleanup();
    }
});

test('duplicate current slots in metadata authority are rejected as ambiguous', () => {
    const fixture = createFixture();
    try {
        publishCurrent(fixture, { chunkId: 'c-1', slotIndex: 0, content: 'one' });
        publishCurrent(fixture, { chunkId: 'c-2', slotIndex: 0, content: 'two' });
        assert.throws(
            () => fixture.store.getCurrentChunkIdentitySnapshot('doc-1'),
            error => error?.code === 'CHUNK_IDENTITY_AMBIGUOUS'
        );
    } finally {
        fixture.cleanup();
    }
});

test('new documents reconcile from an empty authoritative snapshot without caller identity hints', async () => {
    const fixture = createFixture();
    try {
        fixture.setSourceView(committedView([
            { slotIndex: 0, content: 'first' },
            { slotIndex: 1, content: 'second' }
        ]));
        const plan = await fixture.service.planCurrentSource({ docId: 'doc-1' });
        assert.equal(plan.summary.INSERT, 2);
        assert.equal(plan.summary.AMBIGUOUS, 0);
    } finally {
        fixture.cleanup();
    }
});

test('plan-and-admit uses one committed source lease instead of a stale pre-admission snapshot', async () => {
    const fixture = createFixture();
    try {
        const stale = committedView([
            { slotIndex: 0, content: 'stale-a' }
        ], {
            sourceDigest: 'source-digest-a',
            sourceRevision: 'rev-a'
        });
        const fresh = committedView([
            { slotIndex: 0, content: 'fresh-b' }
        ], {
            sourceDigest: 'source-digest-b',
            sourceRevision: 'rev-b'
        });
        let readCalls = 0;
        let leaseCalls = 0;
        const service = new GenUSearchReconciliationService({
            store: fixture.store,
            sourceViewProvider: {
                async readCommittedSourceView() {
                    readCalls += 1;
                    return stale;
                },
                async withCommittedSourceView(request, callback) {
                    leaseCalls += 1;
                    assert.deepEqual(request, {
                        docId: 'doc-1',
                        currentUri: 'diary/a.txt'
                    });
                    return callback(fresh);
                }
            }
        });

        const result = await service.planAndAdmitCurrentSource({
            docId: 'doc-1'
        });
        assert.equal(readCalls, 0);
        assert.equal(leaseCalls, 1);
        assert.equal(result.plan.observedSourceRevision, 'rev-b');
        assert.equal(result.plan.observedSourceDigest, 'source-digest-b');
        assert.equal(result.admitted.targetRevision, 'rev-b');
        assert.equal(result.admitted.observedSourceDigest, 'source-digest-b');
    } finally {
        fixture.cleanup();
    }
});

test('committed source lease provider must invoke callback exactly once and preserve its result', async () => {
    const fixture = createFixture();
    try {
        const view = committedView([]);
        const duplicate = new GenUSearchReconciliationService({
            store: fixture.store,
            sourceViewProvider: {
                async readCommittedSourceView() {
                    return view;
                },
                async withCommittedSourceView(request, callback) {
                    await callback(view);
                    return callback(view);
                }
            }
        });
        await assert.rejects(
            () => duplicate.planAndAdmitCurrentSource({ docId: 'doc-1' }),
            error => error?.code === 'SOURCE_COMMIT_UNVERIFIED'
        );

        const altered = new GenUSearchReconciliationService({
            store: fixture.store,
            sourceViewProvider: {
                async readCommittedSourceView() {
                    return view;
                },
                async withCommittedSourceView(request, callback) {
                    await callback(view);
                    return Object.freeze({ forged: true });
                }
            }
        });
        await assert.rejects(
            () => altered.planAndAdmitCurrentSource({ docId: 'doc-1' }),
            error => error?.code === 'SOURCE_COMMIT_UNVERIFIED'
        );
    } finally {
        fixture.cleanup();
    }
});
