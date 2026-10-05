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
const GenUSearchMemTable = require(
    '../../../modules/knowledgeBase/genUSearchMemTable'
);
const GenUSearchPhysicalCoverageWriter = require(
    '../../../modules/knowledgeBase/genUSearchPhysicalCoverageWriter'
);
const { VexusIndex } = require('../../../rust-vexus-lite');

function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g2-'));
    const dbPath = path.join(root, 'knowledge.sqlite');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    initializeKnowledgeBaseSchema(db, { logPrefix: 'GenUSearchG2Test' });

    let now = 1000;
    const store = new GenUSearchMetadataStore({ db, now: () => now++ });
    const writer = new GenUSearchPhysicalCoverageWriter({
        db,
        runtimeId: 'runtime-a',
        now: () => now++
    });
    const memtable = writer.createMemTable({
        VexusIndex,
        dimension: 4,
        capacity: 32,
        generation: '1',
        embeddingFingerprint: 'embed-v1'
    });

    return {
        root,
        db,
        store,
        writer,
        memtable,
        cleanup() {
            try { db.close(); } catch (_) {}
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

function createStagedVersion(fixture, options = {}) {
    const docId = options.docId || 'doc-g2';
    const chunkId = options.chunkId || 'chunk-g2';
    const vector = options.vector || new Float32Array([1, 2, 3, 4]);

    if (!fixture.store.getDocument(docId)) {
        fixture.store.createDocument({
            docId,
            uri: `${docId}.txt`,
            visibilitySeq: fixture.store.readSequence('visibility_seq')
        });
    }
    if (!fixture.store.getChunkHead(chunkId)) {
        fixture.store.createChunkIdentity({ chunkId, docId });
    }

    const prepared = fixture.store.prepareChunkVersion({
        chunkId,
        sourceRevision: options.sourceRevision || 'rev-1',
        slotIndex: options.slotIndex ?? 0,
        contentHash: options.contentHash || 'a'.repeat(64)
    });
    fixture.store.markEmbedding({
        chunkVersionId: prepared.chunk_version_id,
        embeddingFingerprint: options.embeddingFingerprint || 'embed-v1'
    });
    const staged = fixture.store.stageVector({
        chunkVersionId: prepared.chunk_version_id,
        embeddingFingerprint: options.embeddingFingerprint || 'embed-v1',
        vectorBlob: vector
    });
    return { staged, vector, chunkId };
}

test('Gen0 MemTable mutation requires its bound writer capability and seals fail-closed', () => {
    const fixture = createFixture();
    try {
        assert.equal(fixture.memtable.sourceId, 'gen0:runtime-a:1');
        assert.equal(fixture.memtable.state, 'ACTIVE');

        assert.throws(
            () => fixture.memtable.addVector({
                vectorId: '9007199254740993',
                vector: new Float32Array([1, 0, 0, 0])
            }),
            error => error?.code === 'MEMTABLE_MUTATION_AUTHORITY_REQUIRED'
        );
        assert.throws(
            () => fixture.memtable.removeVector('9007199254740993'),
            error => error?.code === 'MEMTABLE_MUTATION_AUTHORITY_REQUIRED'
        );
        assert.throws(
            () => fixture.memtable.seal(),
            error => error?.code === 'MEMTABLE_MUTATION_AUTHORITY_REQUIRED'
        );

        assert.equal(fixture.writer.sealMemTable(fixture.memtable), 'SEALED_QUERY_VISIBLE');
        assert.equal(fixture.memtable.state, 'SEALED_QUERY_VISIBLE');
    } finally {
        fixture.cleanup();
    }
});

test('a database admits only one live G2 physical coverage writer', () => {
    const fixture = createFixture();
    try {
        assert.throws(
            () => new GenUSearchPhysicalCoverageWriter({
                db: fixture.db,
                runtimeId: 'runtime-b'
            }),
            error => error?.code === 'MEMTABLE_RUNTIME_ALREADY_OWNED'
        );
    } finally {
        fixture.cleanup();
    }
});

test('writer rejects duplicate or detached MemTable source identities', () => {
    const fixture = createFixture();
    try {
        assert.throws(
            () => fixture.writer.createMemTable({
                VexusIndex,
                dimension: 4,
                capacity: 16,
                generation: '1',
                embeddingFingerprint: 'embed-v1'
            }),
            error => error?.code === 'MEMTABLE_SOURCE_ID_COLLISION'
        );

        const detached = new GenUSearchMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 16,
            runtimeId: 'runtime-a',
            generation: '77',
            embeddingFingerprint: 'embed-v1',
            mutationToken: {}
        });
        fixture.writer.bootstrapRuntime();
        const { staged, vector } = createStagedVersion(fixture, {
            chunkId: 'chunk-detached',
            contentHash: 'e'.repeat(64)
        });
        assert.throws(
            () => fixture.writer.admitVector({
                memtable: detached,
                vectorId: staged.vector_id,
                vector
            }),
            error => error?.code === 'MEMTABLE_NOT_BOUND_TO_WRITER'
        );
    } finally {
        fixture.cleanup();
    }
});

test('runtime bootstrap purges stale MEMTABLE coverage but preserves SEGMENT facts', () => {
    const fixture = createFixture();
    try {
        fixture.db.prepare(`
            INSERT INTO gen_usearch_vector_coverage (
                vector_id, source_kind, source_id, coverage_state, created_at, updated_at
            ) VALUES
                (101, 'MEMTABLE', 'gen0:old:1', 'QUERY_VISIBLE', 1, 1),
                (102, 'SEGMENT', 'S1', 'QUERY_VISIBLE', 1, 1)
        `).run();

        const result = fixture.writer.bootstrapRuntime();
        assert.deepEqual(result, {
            runtimeId: 'runtime-a',
            staleMemtableCoverageRemoved: 1
        });

        const rows = fixture.db.prepare(`
            SELECT source_kind, source_id
            FROM gen_usearch_vector_coverage
            ORDER BY source_kind, source_id
        `).all();
        assert.deepEqual(rows, [{ source_kind: 'SEGMENT', source_id: 'S1' }]);
    } finally {
        fixture.cleanup();
    }
});

test('physical admission is blocked until runtime bootstrap', () => {
    const fixture = createFixture();
    try {
        const { staged, vector } = createStagedVersion(fixture);
        assert.throws(
            () => fixture.writer.admitVector({
                memtable: fixture.memtable,
                vectorId: staged.vector_id,
                vector
            }),
            error => error?.code === 'MEMTABLE_RUNTIME_NOT_BOOTSTRAPPED'
        );
        assert.equal(fixture.memtable.hasVector(staged.vector_id), false);
    } finally {
        fixture.cleanup();
    }
});

test('bootstrap gate cannot be forged or repeated after live coverage exists', () => {
    const fixture = createFixture();
    try {
        const { staged, vector } = createStagedVersion(fixture);

        fixture.writer._bootstrapped = true;
        assert.equal(fixture.writer.bootstrapped, false);
        assert.throws(
            () => fixture.writer.admitVector({
                memtable: fixture.memtable,
                vectorId: staged.vector_id,
                vector
            }),
            error => error?.code === 'MEMTABLE_RUNTIME_NOT_BOOTSTRAPPED'
        );

        fixture.writer.bootstrapRuntime();
        fixture.writer.admitVector({
            memtable: fixture.memtable,
            vectorId: staged.vector_id,
            vector
        });
        assert.ok(fixture.writer.getCoverage({
            memtable: fixture.memtable,
            vectorId: staged.vector_id
        }));

        assert.throws(
            () => fixture.writer.bootstrapRuntime(),
            error => error?.code === 'MEMTABLE_RUNTIME_ALREADY_BOOTSTRAPPED'
        );
        assert.ok(fixture.writer.getCoverage({
            memtable: fixture.memtable,
            vectorId: staged.vector_id
        }));
    } finally {
        fixture.cleanup();
    }
});

test('authoritative G2 coverage enables the existing G1 current-head CAS', () => {
    const fixture = createFixture();
    try {
        const { staged, vector, chunkId } = createStagedVersion(fixture);
        fixture.writer.bootstrapRuntime();

        assert.throws(
            () => fixture.store.publishCurrentHead({
                chunkId,
                chunkVersionId: staged.chunk_version_id,
                expectedCurrentVersionId: null
            }),
            error => error?.code === 'PHYSICAL_COVERAGE_MISSING'
        );

        const coverage = fixture.writer.admitVector({
            memtable: fixture.memtable,
            vectorId: staged.vector_id,
            vector
        });
        assert.deepEqual(coverage, {
            vectorId: staged.vector_id,
            sourceKind: 'MEMTABLE',
            sourceId: fixture.memtable.sourceId,
            coverageState: 'QUERY_VISIBLE'
        });
        assert.equal(fixture.memtable.hasVector(staged.vector_id), true);

        const published = fixture.store.publishCurrentHead({
            chunkId,
            chunkVersionId: staged.chunk_version_id,
            expectedCurrentVersionId: null
        });
        assert.equal(published.vectorId, staged.vector_id);
        assert.equal(
            fixture.store.getChunkVersion(staged.chunk_version_id).state,
            'ACTIVE'
        );
    } finally {
        fixture.cleanup();
    }
});

test('coverage cannot be forged for an unknown, non-staged, absent, or mismatched vector', () => {
    const fixture = createFixture();
    try {
        fixture.writer.bootstrapRuntime();

        assert.throws(
            () => fixture.writer.admitVector({
                memtable: fixture.memtable,
                vectorId: '999',
                vector: new Float32Array([1, 2, 3, 4])
            }),
            error => error?.code === 'VECTOR_METADATA_MISSING'
        );

        const { staged, vector, chunkId } = createStagedVersion(fixture);
        assert.throws(
            () => fixture.writer.admitVector({
                memtable: fixture.memtable,
                vectorId: staged.vector_id,
                vector: new Float32Array([4, 3, 2, 1])
            }),
            error => error?.code === 'VECTOR_RECOVERY_MATERIAL_MISMATCH'
        );
        assert.equal(fixture.memtable.hasVector(staged.vector_id), false);

        fixture.writer.admitVector({
            memtable: fixture.memtable,
            vectorId: staged.vector_id,
            vector
        });
        fixture.store.publishCurrentHead({
            chunkId,
            chunkVersionId: staged.chunk_version_id,
            expectedCurrentVersionId: null
        });

        const otherMemtable = fixture.writer.createMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 16,
            generation: '2',
            embeddingFingerprint: 'embed-v1'
        });
        assert.throws(
            () => fixture.writer.admitVector({
                memtable: otherMemtable,
                vectorId: staged.vector_id,
                vector
            }),
            error => error?.code === 'INVALID_MVCC_TRANSITION'
        );
        assert.equal(otherMemtable.hasVector(staged.vector_id), false);
    } finally {
        fixture.cleanup();
    }
});

test('G2 isolates embedding spaces and permits generation handoff only after seal', () => {
    const fixture = createFixture();
    try {
        fixture.writer.bootstrapRuntime();

        const first = createStagedVersion(fixture, {
            docId: 'doc-gen',
            chunkId: 'chunk-gen-a',
            contentHash: 'b'.repeat(64),
            vector: new Float32Array([1, 0, 0, 0])
        });
        const second = createStagedVersion(fixture, {
            docId: 'doc-gen',
            chunkId: 'chunk-gen-b',
            contentHash: 'c'.repeat(64),
            vector: new Float32Array([0, 1, 0, 0])
        });

        fixture.writer.admitVector({
            memtable: fixture.memtable,
            vectorId: first.staged.vector_id,
            vector: first.vector
        });

        const next = fixture.writer.createMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 16,
            generation: '2',
            embeddingFingerprint: 'embed-v1'
        });
        assert.throws(
            () => fixture.writer.admitVector({
                memtable: next,
                vectorId: second.staged.vector_id,
                vector: second.vector
            }),
            error => error?.code === 'MEMTABLE_ACTIVE_GENERATION_CONFLICT'
        );
        assert.equal(next.hasVector(second.staged.vector_id), false);

        fixture.writer.sealMemTable(fixture.memtable);
        const admitted = fixture.writer.admitVector({
            memtable: next,
            vectorId: second.staged.vector_id,
            vector: second.vector
        });
        assert.equal(admitted.sourceId, next.sourceId);

        const wrongSpace = fixture.writer.createMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 16,
            generation: '3',
            embeddingFingerprint: 'embed-v2'
        });
        fixture.writer.sealMemTable(next);

        const third = createStagedVersion(fixture, {
            docId: 'doc-gen',
            chunkId: 'chunk-gen-c',
            contentHash: 'd'.repeat(64),
            vector: new Float32Array([0, 0, 1, 0]),
            embeddingFingerprint: 'embed-v1'
        });
        assert.throws(
            () => fixture.writer.admitVector({
                memtable: wrongSpace,
                vectorId: third.staged.vector_id,
                vector: third.vector
            }),
            error => error?.code === 'MEMTABLE_EMBEDDING_FINGERPRINT_MISMATCH'
        );
        assert.equal(wrongSpace.hasVector(third.staged.vector_id), false);
    } finally {
        fixture.cleanup();
    }
});

test('physical add failure leaves no QUERY_VISIBLE coverage', () => {
    const fixture = createFixture();
    try {
        const { staged, vector } = createStagedVersion(fixture);
        fixture.writer.bootstrapRuntime();

        class FailingIndex {
            constructor() {
                this.revision = 0;
            }
            addKey64() {
                throw new Error('simulated-native-add-failure');
            }
            removeKey64() {}
        }
        const failingMemtable = fixture.writer.createMemTable({
            VexusIndex: FailingIndex,
            dimension: 4,
            capacity: 16,
            generation: '99',
            embeddingFingerprint: 'embed-v1'
        });

        assert.throws(
            () => fixture.writer.admitVector({
                memtable: failingMemtable,
                vectorId: staged.vector_id,
                vector
            }),
            /simulated-native-add-failure/
        );

        assert.equal(failingMemtable.hasVector(staged.vector_id), false);
        assert.equal(
            fixture.writer.getCoverage({
                memtable: failingMemtable,
                vectorId: staged.vector_id
            }),
            null
        );
    } finally {
        fixture.cleanup();
    }
});

test('coverage commit failure rolls physical admission back to hidden state', () => {
    const fixture = createFixture();
    try {
        const { staged, vector } = createStagedVersion(fixture);
        fixture.writer.bootstrapRuntime();

        fixture.db.exec(`
            CREATE TRIGGER reject_g2_coverage_test
            BEFORE INSERT ON gen_usearch_vector_coverage
            BEGIN
                SELECT RAISE(ABORT, 'coverage-rejected');
            END;
        `);

        assert.throws(
            () => fixture.writer.admitVector({
                memtable: fixture.memtable,
                vectorId: staged.vector_id,
                vector
            }),
            /coverage-rejected/
        );
        assert.equal(fixture.memtable.hasVector(staged.vector_id), false);
        assert.equal(
            fixture.db.prepare(`
                SELECT COUNT(*) AS count
                FROM gen_usearch_vector_coverage
                WHERE vector_id = ?
            `).get(BigInt(staged.vector_id)).count,
            0
        );
    } finally {
        fixture.cleanup();
    }
});

test('direct MemTable mutation cannot invalidate published coverage out of band', () => {
    const fixture = createFixture();
    try {
        const { staged, vector } = createStagedVersion(fixture);
        fixture.writer.bootstrapRuntime();
        fixture.writer.admitVector({
            memtable: fixture.memtable,
            vectorId: staged.vector_id,
            vector
        });

        assert.throws(
            () => fixture.memtable.removeVector(staged.vector_id),
            error => error?.code === 'MEMTABLE_MUTATION_AUTHORITY_REQUIRED'
        );
        assert.equal(fixture.memtable.hasVector(staged.vector_id), true);
        assert.ok(fixture.writer.getCoverage({
            memtable: fixture.memtable,
            vectorId: staged.vector_id
        }));
    } finally {
        fixture.cleanup();
    }
});

test('removal hides durable coverage before deleting volatile bytes', () => {
    const fixture = createFixture();
    try {
        const { staged, vector } = createStagedVersion(fixture);
        fixture.writer.bootstrapRuntime();
        fixture.writer.admitVector({
            memtable: fixture.memtable,
            vectorId: staged.vector_id,
            vector
        });

        const result = fixture.writer.hideAndRemoveVector({
            memtable: fixture.memtable,
            vectorId: staged.vector_id
        });
        assert.equal(result.coverageRowsRemoved, 1);
        assert.equal(result.physicalRemoved, true);
        assert.equal(fixture.memtable.hasVector(staged.vector_id), false);
        assert.equal(
            fixture.writer.getCoverage({
                memtable: fixture.memtable,
                vectorId: staged.vector_id
            }),
            null
        );
    } finally {
        fixture.cleanup();
    }
});

test('removal rejects unknown and ACTIVE logical vectors before hiding coverage', () => {
    const fixture = createFixture();
    try {
        const { staged, vector, chunkId } = createStagedVersion(fixture);
        fixture.writer.bootstrapRuntime();

        assert.throws(
            () => fixture.writer.hideAndRemoveVector({
                memtable: fixture.memtable,
                vectorId: '999'
            }),
            error => error?.code === 'VECTOR_METADATA_MISSING'
        );

        fixture.writer.admitVector({
            memtable: fixture.memtable,
            vectorId: staged.vector_id,
            vector
        });
        fixture.store.publishCurrentHead({
            chunkId,
            chunkVersionId: staged.chunk_version_id,
            expectedCurrentVersionId: null
        });

        assert.throws(
            () => fixture.writer.hideAndRemoveVector({
                memtable: fixture.memtable,
                vectorId: staged.vector_id
            }),
            error => error?.code === 'INVALID_CURRENT_VECTOR_HEAD'
        );
        assert.ok(fixture.writer.getCoverage({
            memtable: fixture.memtable,
            vectorId: staged.vector_id
        }));
        assert.equal(fixture.memtable.hasVector(staged.vector_id), true);
    } finally {
        fixture.cleanup();
    }
});

test('G2 coverage writes require crash-durable SQLite profile', () => {
    const fixture = createFixture();
    try {
        fixture.db.pragma('synchronous = NORMAL');
        assert.throws(
            () => fixture.writer.bootstrapRuntime(),
            error => error?.code === 'UNSUPPORTED_DURABILITY_PROFILE'
        );
        fixture.db.pragma('synchronous = FULL');
        assert.equal(
            fixture.writer.bootstrapRuntime().staleMemtableCoverageRemoved,
            0
        );
    } finally {
        fixture.cleanup();
    }
});
