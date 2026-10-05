'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

function rolloverRuntimeFence(db, runtimeId, now = Date.now()) {
    const row = db.prepare(
        'SELECT runtime_fence FROM gen_usearch_runtime_ownership WHERE singleton = 1'
    ).safeIntegers(true).get();
    assert.ok(row);
    const nextFence = BigInt(row.runtime_fence) + 1n;
    db.prepare(`
        UPDATE gen_usearch_runtime_ownership
        SET owner_id = ?,
            serving_state = 'DRAINING',
            runtime_fence = ?,
            acquired_at = ?,
            updated_at = ?
        WHERE singleton = 1
    `).run(runtimeId, nextFence, BigInt(now), BigInt(now));
    return nextFence;
}

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

test('failed writer construction does not poison later authority on the same DB', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g2-constructor-'));
    const db = new Database(path.join(root, 'knowledge.sqlite'));
    try {
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = FULL');
        assert.throws(
            () => new GenUSearchPhysicalCoverageWriter({
                db,
                runtimeId: 'runtime-constructor'
            })
        );

        initializeKnowledgeBaseSchema(db, { logPrefix: 'GenUSearchG2ConstructorTest' });
        const writer = new GenUSearchPhysicalCoverageWriter({
            db,
            runtimeId: 'runtime-constructor'
        });
        assert.equal(writer.runtimeId, 'runtime-constructor');
    } finally {
        try { db.close(); } catch (_) {}
        fs.rmSync(root, { recursive: true, force: true });
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

test('two SQLite connections to the same database file cannot split G2 writer authority', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g2-dual-db-'));
    const dbPath = path.join(root, 'knowledge.sqlite');
    const first = new Database(dbPath);
    const second = new Database(dbPath);
    try {
        for (const db of [first, second]) {
            db.pragma('journal_mode = WAL');
            db.pragma('synchronous = FULL');
            db.pragma('foreign_keys = ON');
        }
        initializeKnowledgeBaseSchema(first, { logPrefix: 'GenUSearchG2DualWriterTest' });

        const writer = new GenUSearchPhysicalCoverageWriter({
            db: first,
            runtimeId: 'runtime-primary'
        });
        assert.equal(writer.runtimeId, 'runtime-primary');

        assert.throws(
            () => new GenUSearchPhysicalCoverageWriter({
                db: second,
                runtimeId: 'runtime-secondary'
            }),
            error => error?.code === 'MEMTABLE_RUNTIME_ALREADY_OWNED'
        );
    } finally {
        try { first.close(); } catch (_) {}
        try { second.close(); } catch (_) {}
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('hard-link aliases cannot split G2 writer authority for one SQLite file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g2-hardlink-'));
    const original = path.join(root, 'knowledge.sqlite');
    const alias = path.join(root, 'knowledge-alias.sqlite');
    const first = new Database(original);
    let second;
    try {
        first.pragma('journal_mode = WAL');
        first.pragma('synchronous = FULL');
        first.pragma('foreign_keys = ON');
        initializeKnowledgeBaseSchema(first, { logPrefix: 'GenUSearchG2HardlinkTest' });
        first.pragma('wal_checkpoint(TRUNCATE)');
        fs.linkSync(original, alias);

        second = new Database(alias);
        second.pragma('journal_mode = WAL');
        second.pragma('synchronous = FULL');
        second.pragma('foreign_keys = ON');

        const firstStat = fs.statSync(original);
        const secondStat = fs.statSync(alias);
        assert.equal(firstStat.dev, secondStat.dev);
        assert.equal(firstStat.ino, secondStat.ino);

        const writer = new GenUSearchPhysicalCoverageWriter({
            db: first,
            runtimeId: 'runtime-hardlink-primary'
        });
        assert.equal(writer.runtimeId, 'runtime-hardlink-primary');

        assert.throws(
            () => new GenUSearchPhysicalCoverageWriter({
                db: second,
                runtimeId: 'runtime-hardlink-secondary'
            }),
            error => error?.code === 'MEMTABLE_RUNTIME_ALREADY_OWNED'
        );
    } finally {
        try { first.close(); } catch (_) {}
        try { second?.close(); } catch (_) {}
        fs.rmSync(root, { recursive: true, force: true });
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

test('native key64 membership ABI proves exact physical presence', () => {
    const index = new VexusIndex(4, 16);
    const id = '9007199254740993';
    const vector = new Float32Array([1, 0, 0, 0]);

    assert.equal(index.containsKey64(id), false);
    const before = index.revision;
    index.addKey64(id, vector);
    assert.equal(index.revision, before + 1);
    assert.equal(index.containsKey64(id), true);

    const beforeRemove = index.revision;
    index.removeKey64(id);
    assert.equal(index.revision, beforeRemove + 1);
    assert.equal(index.containsKey64(id), false);
});

test('forged JavaScript index cannot impersonate native physical authority', () => {
    const fixture = createFixture();
    try {
        class ForgedRevisionIndex {
            constructor() {
                this.revision = 0;
            }
            addKey64() {
                this.revision += 1;
            }
            removeKey64() {
                this.revision += 1;
            }
            containsKey64() {
                return true;
            }
        }

        assert.throws(
            () => fixture.writer.createMemTable({
                VexusIndex: ForgedRevisionIndex,
                dimension: 4,
                capacity: 16,
                generation: '97',
                embeddingFingerprint: 'embed-v1'
            }),
            error => error?.code === 'MEMTABLE_NATIVE_INDEX_UNTRUSTED'
        );
    } finally {
        fixture.cleanup();
    }
});

test('silent JavaScript no-op index is rejected before physical admission', () => {
    const fixture = createFixture();
    try {
        class NoopIndex {
            constructor() {
                this.revision = 0;
            }
            addKey64() {}
            removeKey64() {}
            containsKey64() {
                return false;
            }
        }

        assert.throws(
            () => fixture.writer.createMemTable({
                VexusIndex: NoopIndex,
                dimension: 4,
                capacity: 16,
                generation: '98',
                embeddingFingerprint: 'embed-v1'
            }),
            error => error?.code === 'MEMTABLE_NATIVE_INDEX_UNTRUSTED'
        );
    } finally {
        fixture.cleanup();
    }
});

test('startup recovery rehydrates ACTIVE current vectors before batch coverage publication', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g2-recover-'));
    const dbPath = path.join(root, 'knowledge.sqlite');
    let firstDb;
    let secondDb;
    try {
        firstDb = new Database(dbPath);
        firstDb.pragma('journal_mode = WAL');
        firstDb.pragma('synchronous = FULL');
        firstDb.pragma('foreign_keys = ON');
        initializeKnowledgeBaseSchema(firstDb, { logPrefix: 'GenUSearchG2RecoverSeed' });

        let now = 5000;
        const store = new GenUSearchMetadataStore({ db: firstDb, now: () => now++ });
        const seedWriter = new GenUSearchPhysicalCoverageWriter({
            db: firstDb,
            runtimeId: 'runtime-seed',
            now: () => now++
        });
        const seedMemtable = seedWriter.createMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 16,
            generation: '1',
            embeddingFingerprint: 'embed-v1'
        });

        store.createDocument({
            docId: 'doc-recover',
            uri: 'doc-recover.txt',
            visibilitySeq: store.readSequence('visibility_seq')
        });
        store.createChunkIdentity({
            chunkId: 'chunk-recover',
            docId: 'doc-recover'
        });
        const prepared = store.prepareChunkVersion({
            chunkId: 'chunk-recover',
            sourceRevision: 'rev-recover',
            slotIndex: 0,
            contentHash: 'e'.repeat(64)
        });
        store.markEmbedding({
            chunkVersionId: prepared.chunk_version_id,
            embeddingFingerprint: 'embed-v1'
        });
        const vector = new Float32Array([1, 0, 1, 0]);
        const staged = store.stageVector({
            chunkVersionId: prepared.chunk_version_id,
            embeddingFingerprint: 'embed-v1',
            vectorBlob: vector
        });

        seedWriter.bootstrapRuntime();
        seedWriter.admitVector({
            memtable: seedMemtable,
            vectorId: staged.vector_id,
            vector
        });
        store.publishCurrentHead({
            chunkId: 'chunk-recover',
            chunkVersionId: staged.chunk_version_id,
            expectedCurrentVersionId: null
        });

        firstDb.close();
        firstDb = null;

        secondDb = new Database(dbPath);
        secondDb.pragma('journal_mode = WAL');
        secondDb.pragma('synchronous = FULL');
        secondDb.pragma('foreign_keys = ON');
        rolloverRuntimeFence(secondDb, 'runtime-recovered', now++);

        const recoveryWriter = new GenUSearchPhysicalCoverageWriter({
            db: secondDb,
            runtimeId: 'runtime-recovered',
            now: () => now++
        });
        const recoveryMemtable = recoveryWriter.createMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 16,
            generation: '1',
            embeddingFingerprint: 'embed-v1'
        });

        const boot = recoveryWriter.bootstrapRuntime();
        assert.equal(boot.staleMemtableCoverageRemoved, 1);
        assert.equal(
            secondDb.prepare(`
                SELECT COUNT(*) AS count
                FROM gen_usearch_vector_coverage
                WHERE source_kind = 'MEMTABLE'
            `).get().count,
            0
        );

        const recovered = recoveryWriter.recoverCurrentVectors({
            memtable: recoveryMemtable
        });
        assert.deepEqual(recovered.vectorIds, [staged.vector_id]);
        assert.equal(recovered.recoveredVectorCount, 1);
        assert.equal(recoveryMemtable.hasVector(staged.vector_id), true);
        assert.deepEqual(
            recoveryWriter.getCoverage({
                memtable: recoveryMemtable,
                vectorId: staged.vector_id
            }),
            {
                vectorId: staged.vector_id,
                sourceKind: 'MEMTABLE',
                sourceId: recoveryMemtable.sourceId,
                coverageState: 'QUERY_VISIBLE'
            }
        );
    } finally {
        try { firstDb?.close(); } catch (_) {}
        try { secondDb?.close(); } catch (_) {}
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('startup recovery fails closed before coverage when current recovery material is incomplete', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g2-recover-bad-'));
    const dbPath = path.join(root, 'knowledge.sqlite');
    let firstDb;
    let secondDb;
    try {
        firstDb = new Database(dbPath);
        firstDb.pragma('journal_mode = WAL');
        firstDb.pragma('synchronous = FULL');
        firstDb.pragma('foreign_keys = ON');
        initializeKnowledgeBaseSchema(firstDb, { logPrefix: 'GenUSearchG2RecoverBadSeed' });

        let now = 6000;
        const store = new GenUSearchMetadataStore({ db: firstDb, now: () => now++ });
        const seedWriter = new GenUSearchPhysicalCoverageWriter({
            db: firstDb,
            runtimeId: 'runtime-bad-seed',
            now: () => now++
        });
        const seedMemtable = seedWriter.createMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 16,
            generation: '1',
            embeddingFingerprint: 'embed-v1'
        });

        store.createDocument({
            docId: 'doc-bad',
            uri: 'doc-bad.txt',
            visibilitySeq: store.readSequence('visibility_seq')
        });
        store.createChunkIdentity({ chunkId: 'chunk-bad', docId: 'doc-bad' });
        const prepared = store.prepareChunkVersion({
            chunkId: 'chunk-bad',
            sourceRevision: 'rev-bad',
            slotIndex: 0,
            contentHash: 'f'.repeat(64)
        });
        store.markEmbedding({
            chunkVersionId: prepared.chunk_version_id,
            embeddingFingerprint: 'embed-v1'
        });
        const vector = new Float32Array([0, 1, 0, 1]);
        const staged = store.stageVector({
            chunkVersionId: prepared.chunk_version_id,
            embeddingFingerprint: 'embed-v1',
            vectorBlob: vector
        });

        seedWriter.bootstrapRuntime();
        seedWriter.admitVector({
            memtable: seedMemtable,
            vectorId: staged.vector_id,
            vector
        });
        store.publishCurrentHead({
            chunkId: 'chunk-bad',
            chunkVersionId: staged.chunk_version_id,
            expectedCurrentVersionId: null
        });
        firstDb.prepare(`
            UPDATE gen_usearch_vector_recovery
            SET vector_blob = NULL
            WHERE vector_id = ?
        `).run(BigInt(staged.vector_id));

        firstDb.close();
        firstDb = null;

        secondDb = new Database(dbPath);
        secondDb.pragma('journal_mode = WAL');
        secondDb.pragma('synchronous = FULL');
        secondDb.pragma('foreign_keys = ON');
        rolloverRuntimeFence(secondDb, 'runtime-bad-recover', now++);

        const recoveryWriter = new GenUSearchPhysicalCoverageWriter({
            db: secondDb,
            runtimeId: 'runtime-bad-recover'
        });
        const recoveryMemtable = recoveryWriter.createMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 16,
            generation: '1',
            embeddingFingerprint: 'embed-v1'
        });
        recoveryWriter.bootstrapRuntime();

        assert.throws(
            () => recoveryWriter.recoverCurrentVectors({
                memtable: recoveryMemtable
            }),
            error => error?.code === 'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE'
        );
        assert.equal(recoveryMemtable.stats().vectorCount, 0);
        assert.equal(
            secondDb.prepare(`
                SELECT COUNT(*) AS count
                FROM gen_usearch_vector_coverage
                WHERE source_kind = 'MEMTABLE'
            `).get().count,
            0
        );
    } finally {
        try { firstDb?.close(); } catch (_) {}
        try { secondDb?.close(); } catch (_) {}
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('startup recovery rejects mixed embedding fingerprints before physical mutation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g2-recover-mixed-'));
    const dbPath = path.join(root, 'knowledge.sqlite');
    let firstDb;
    let secondDb;
    try {
        firstDb = new Database(dbPath);
        firstDb.pragma('journal_mode = WAL');
        firstDb.pragma('synchronous = FULL');
        firstDb.pragma('foreign_keys = ON');
        initializeKnowledgeBaseSchema(firstDb, { logPrefix: 'GenUSearchG2MixedSeed' });

        let now = 7000;
        const store = new GenUSearchMetadataStore({ db: firstDb, now: () => now++ });
        const seedWriter = new GenUSearchPhysicalCoverageWriter({
            db: firstDb,
            runtimeId: 'runtime-mixed-seed',
            now: () => now++
        });
        seedWriter.bootstrapRuntime();

        store.createDocument({
            docId: 'doc-mixed',
            uri: 'doc-mixed.txt',
            visibilitySeq: store.readSequence('visibility_seq')
        });

        for (const [ordinal, fingerprint] of [['a', 'embed-v1'], ['b', 'embed-v2']]) {
            const chunkId = `chunk-mixed-${ordinal}`;
            store.createChunkIdentity({ chunkId, docId: 'doc-mixed' });
            const prepared = store.prepareChunkVersion({
                chunkId,
                sourceRevision: `rev-${ordinal}`,
                slotIndex: ordinal === 'a' ? 0 : 1,
                contentHash: (ordinal === 'a' ? '1' : '2').repeat(64)
            });
            store.markEmbedding({
                chunkVersionId: prepared.chunk_version_id,
                embeddingFingerprint: fingerprint
            });
            const vector = ordinal === 'a'
                ? new Float32Array([1, 0, 0, 0])
                : new Float32Array([0, 1, 0, 0]);
            const staged = store.stageVector({
                chunkVersionId: prepared.chunk_version_id,
                embeddingFingerprint: fingerprint,
                vectorBlob: vector
            });
            const mt = seedWriter.createMemTable({
                VexusIndex,
                dimension: 4,
                capacity: 16,
                generation: ordinal === 'a' ? '1' : '2',
                embeddingFingerprint: fingerprint
            });
            if (ordinal === 'b') {
                // The first generation must be sealed before admitting another space.
                const firstCoverage = firstDb.prepare(`
                    SELECT source_id
                    FROM gen_usearch_vector_coverage
                    WHERE source_kind = 'MEMTABLE'
                    ORDER BY source_id
                    LIMIT 1
                `).get();
                assert.ok(firstCoverage);
            }
            if (ordinal === 'a') {
                seedWriter.admitVector({
                    memtable: mt,
                    vectorId: staged.vector_id,
                    vector
                });
                seedWriter.sealMemTable(mt);
            } else {
                seedWriter.admitVector({
                    memtable: mt,
                    vectorId: staged.vector_id,
                    vector
                });
            }
            store.publishCurrentHead({
                chunkId,
                chunkVersionId: staged.chunk_version_id,
                expectedCurrentVersionId: null
            });
        }

        firstDb.close();
        firstDb = null;

        secondDb = new Database(dbPath);
        secondDb.pragma('journal_mode = WAL');
        secondDb.pragma('synchronous = FULL');
        secondDb.pragma('foreign_keys = ON');
        rolloverRuntimeFence(secondDb, 'runtime-mixed-recover', now++);
        const recoveryWriter = new GenUSearchPhysicalCoverageWriter({
            db: secondDb,
            runtimeId: 'runtime-mixed-recover'
        });
        const recoveryMemtable = recoveryWriter.createMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 16,
            generation: '1',
            embeddingFingerprint: 'embed-v1'
        });
        recoveryWriter.bootstrapRuntime();

        assert.throws(
            () => recoveryWriter.recoverCurrentVectors({
                memtable: recoveryMemtable
            }),
            error => error?.code === 'MEMTABLE_EMBEDDING_FINGERPRINT_MISMATCH'
        );
        assert.equal(recoveryMemtable.stats().vectorCount, 0);
        assert.equal(
            secondDb.prepare(`
                SELECT COUNT(*) AS count
                FROM gen_usearch_vector_coverage
                WHERE source_kind = 'MEMTABLE'
            `).get().count,
            0
        );
    } finally {
        try { firstDb?.close(); } catch (_) {}
        try { secondDb?.close(); } catch (_) {}
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('physical add failure leaves no QUERY_VISIBLE coverage', () => {
    const fixture = createFixture();
    try {
        const { staged, vector } = createStagedVersion(fixture);
        fixture.writer.bootstrapRuntime();

        class WrongDimensionNativeFactory {
            constructor() {
                return new VexusIndex(5, 16);
            }
        }
        const failingMemtable = fixture.writer.createMemTable({
            VexusIndex: WrongDimensionNativeFactory,
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
            /Dimension mismatch/
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

test('bootstrap fails closed when SQLite silently ignores stale coverage deletion', () => {
    const fixture = createFixture();
    try {
        fixture.db.prepare(`
            INSERT INTO gen_usearch_vector_coverage (
                vector_id, source_kind, source_id, coverage_state, created_at, updated_at
            ) VALUES (999, 'MEMTABLE', 'gen0:stale:1', 'QUERY_VISIBLE', 1, 1)
        `).run();
        fixture.db.exec(`
            CREATE TRIGGER ignore_g2_bootstrap_delete
            BEFORE DELETE ON gen_usearch_vector_coverage
            WHEN OLD.source_kind = 'MEMTABLE'
            BEGIN
                SELECT RAISE(IGNORE);
            END;
        `);

        assert.throws(
            () => fixture.writer.bootstrapRuntime(),
            error => error?.code === 'PHYSICAL_COVERAGE_MISSING'
        );
        assert.equal(fixture.writer.bootstrapped, false);
        assert.equal(
            fixture.db.prepare(`
                SELECT COUNT(*) AS count
                FROM gen_usearch_vector_coverage
                WHERE source_kind = 'MEMTABLE'
            `).get().count,
            1
        );
    } finally {
        fixture.cleanup();
    }
});

test('single coverage publication fails closed when a trigger rewrites QUERY_VISIBLE state', () => {
    const fixture = createFixture();
    try {
        const { staged, vector } = createStagedVersion(fixture);
        fixture.writer.bootstrapRuntime();
        fixture.db.exec(`
            CREATE TRIGGER rewrite_g2_coverage_state
            AFTER INSERT ON gen_usearch_vector_coverage
            WHEN NEW.source_kind = 'MEMTABLE'
            BEGIN
                UPDATE gen_usearch_vector_coverage
                SET coverage_state = 'STAGED'
                WHERE vector_id = NEW.vector_id
                  AND source_kind = NEW.source_kind
                  AND source_id = NEW.source_id;
            END;
        `);

        assert.throws(
            () => fixture.writer.admitVector({
                memtable: fixture.memtable,
                vectorId: staged.vector_id,
                vector
            }),
            error => error?.code === 'PHYSICAL_COVERAGE_MISSING'
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

test('coverage hide fails closed before physical removal when SQLite ignores delete', () => {
    const fixture = createFixture();
    try {
        const { staged, vector } = createStagedVersion(fixture);
        fixture.writer.bootstrapRuntime();
        fixture.writer.admitVector({
            memtable: fixture.memtable,
            vectorId: staged.vector_id,
            vector
        });

        fixture.db.exec(`
            CREATE TRIGGER ignore_g2_hide_delete
            BEFORE DELETE ON gen_usearch_vector_coverage
            WHEN OLD.vector_id = ${staged.vector_id}
             AND OLD.source_kind = 'MEMTABLE'
            BEGIN
                SELECT RAISE(IGNORE);
            END;
        `);

        assert.throws(
            () => fixture.writer.hideAndRemoveVector({
                memtable: fixture.memtable,
                vectorId: staged.vector_id
            }),
            error => error?.code === 'PHYSICAL_COVERAGE_MISSING'
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


test('startup recovery accepts mixed RECOVERY_REQUIRED and SEGMENT_COVERED current vectors', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g2-recover-covered-'));
    const dbPath = path.join(root, 'knowledge.sqlite');
    let firstDb;
    let secondDb;
    try {
        firstDb = new Database(dbPath);
        firstDb.pragma('journal_mode = WAL');
        firstDb.pragma('synchronous = FULL');
        firstDb.pragma('foreign_keys = ON');
        initializeKnowledgeBaseSchema(firstDb, { logPrefix: 'GenUSearchG2RecoverCoveredSeed' });

        let now = 8000;
        const store = new GenUSearchMetadataStore({ db: firstDb, now: () => now++ });
        const seedWriter = new GenUSearchPhysicalCoverageWriter({
            db: firstDb,
            runtimeId: 'runtime-covered-seed',
            now: () => now++
        });
        seedWriter.bootstrapRuntime();
        const seedMemtable = seedWriter.createMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 16,
            generation: '1',
            embeddingFingerprint: 'embed-v1'
        });

        store.createDocument({
            docId: 'doc-covered-recover',
            uri: 'doc-covered-recover.txt',
            visibilitySeq: store.readSequence('visibility_seq')
        });

        const seeded = [];
        for (const [ordinal, vector] of [
            ['a', new Float32Array([1, 0, 0, 0])],
            ['b', new Float32Array([0, 1, 0, 0])]
        ]) {
            const chunkId = `chunk-covered-${ordinal}`;
            store.createChunkIdentity({
                chunkId,
                docId: 'doc-covered-recover'
            });
            const prepared = store.prepareChunkVersion({
                chunkId,
                sourceRevision: `rev-covered-${ordinal}`,
                slotIndex: ordinal === 'a' ? 0 : 1,
                contentHash: (ordinal === 'a' ? 'a' : 'b').repeat(64)
            });
            store.markEmbedding({
                chunkVersionId: prepared.chunk_version_id,
                embeddingFingerprint: 'embed-v1'
            });
            const staged = store.stageVector({
                chunkVersionId: prepared.chunk_version_id,
                embeddingFingerprint: 'embed-v1',
                vectorBlob: vector
            });
            seedWriter.admitVector({
                memtable: seedMemtable,
                vectorId: staged.vector_id,
                vector
            });
            store.publishCurrentHead({
                chunkId,
                chunkVersionId: staged.chunk_version_id,
                expectedCurrentVersionId: null
            });
            seeded.push({ staged, vector });
        }

        firstDb.prepare(`
            UPDATE gen_usearch_vector_recovery
            SET state = 'SEGMENT_COVERED'
            WHERE vector_id = ?
        `).run(BigInt(seeded[0].staged.vector_id));

        firstDb.close();
        firstDb = null;

        secondDb = new Database(dbPath);
        secondDb.pragma('journal_mode = WAL');
        secondDb.pragma('synchronous = FULL');
        secondDb.pragma('foreign_keys = ON');
        rolloverRuntimeFence(secondDb, 'runtime-covered-recover', now++);

        const recoveryWriter = new GenUSearchPhysicalCoverageWriter({
            db: secondDb,
            runtimeId: 'runtime-covered-recover',
            now: () => now++
        });
        const recoveryMemtable = recoveryWriter.createMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 16,
            generation: '1',
            embeddingFingerprint: 'embed-v1'
        });

        const boot = recoveryWriter.bootstrapRuntime();
        assert.equal(boot.staleMemtableCoverageRemoved, 2);

        const recovered = recoveryWriter.recoverCurrentVectors({
            memtable: recoveryMemtable
        });
        assert.equal(recovered.recoveredVectorCount, 2);
        assert.deepEqual(
            [...recovered.vectorIds].sort(),
            seeded.map(item => item.staged.vector_id).sort()
        );
        for (const item of seeded) {
            assert.equal(
                recoveryMemtable.hasVector(item.staged.vector_id),
                true
            );
            assert.ok(recoveryWriter.getCoverage({
                memtable: recoveryMemtable,
                vectorId: item.staged.vector_id
            }));
        }

        const states = secondDb.prepare(`
            SELECT vector_id, state
            FROM gen_usearch_vector_recovery
            WHERE vector_id IN (?, ?)
            ORDER BY vector_id
        `).safeIntegers(true).all(
            BigInt(seeded[0].staged.vector_id),
            BigInt(seeded[1].staged.vector_id)
        );
        assert.deepEqual(
            states.map(row => [row.vector_id.toString(), row.state]),
            [
                [seeded[0].staged.vector_id, 'SEGMENT_COVERED'],
                [seeded[1].staged.vector_id, 'RECOVERY_REQUIRED']
            ]
        );
    } finally {
        try { firstDb?.close(); } catch (_) {}
        try { secondDb?.close(); } catch (_) {}
        fs.rmSync(root, { recursive: true, force: true });
    }
});


test('G2 physical mutation rejects ambient SQLite transactions before native bytes can diverge from coverage', () => {
    const fixture = createFixture();
    try {
        const { staged, vector } = createStagedVersion(fixture);
        fixture.writer.bootstrapRuntime();
        fixture.writer.admitVector({
            memtable: fixture.memtable,
            vectorId: staged.vector_id,
            vector
        });

        const beforeCoverage = fixture.writer.getCoverage({
            memtable: fixture.memtable,
            vectorId: staged.vector_id
        });
        assert.ok(beforeCoverage);
        assert.equal(fixture.memtable.hasVector(staged.vector_id), true);

        const outer = fixture.db.transaction(() => {
            assert.throws(
                () => fixture.writer.hideAndRemoveVector({
                    memtable: fixture.memtable,
                    vectorId: staged.vector_id
                }),
                error => error?.code === 'DURABLE_COMMIT_UNCONFIRMED'
            );
        });
        outer();

        assert.equal(fixture.memtable.hasVector(staged.vector_id), true);
        assert.deepEqual(
            fixture.writer.getCoverage({
                memtable: fixture.memtable,
                vectorId: staged.vector_id
            }),
            beforeCoverage
        );
    } finally {
        fixture.cleanup();
    }
});


test('G2 ambient transaction is rejected before native admission begins', () => {
    const fixture = createFixture();
    try {
        const { staged, vector } = createStagedVersion(fixture);
        fixture.writer.bootstrapRuntime();

        const outer = fixture.db.transaction(() => {
            assert.throws(
                () => fixture.writer.admitVector({
                    memtable: fixture.memtable,
                    vectorId: staged.vector_id,
                    vector
                }),
                error => error?.code === 'DURABLE_COMMIT_UNCONFIRMED'
            );
        });
        outer();

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


test('ambient transaction cannot claim G2 writer authority or poison later construction', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g2-writer-tx-'));
    const db = new Database(path.join(root, 'knowledge.sqlite'));
    try {
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = FULL');
        db.pragma('foreign_keys = ON');
        initializeKnowledgeBaseSchema(db, { logPrefix: 'GenUSearchG2WriterTx' });

        const outer = db.transaction(() => {
            assert.throws(
                () => new GenUSearchPhysicalCoverageWriter({
                    db,
                    runtimeId: 'runtime-tx-writer'
                }),
                error => error?.code === 'DURABLE_COMMIT_UNCONFIRMED'
            );
        });
        outer();

        const writer = new GenUSearchPhysicalCoverageWriter({
            db,
            runtimeId: 'runtime-tx-writer'
        });
        assert.equal(writer.runtimeId, 'runtime-tx-writer');
    } finally {
        try { db.close(); } catch (_) {}
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('durable process lease blocks a second OS process on the same runtime fence', () => {
    const fixture = createFixture();
    try {
        const writerModule = path.resolve(
            __dirname,
            '../../../modules/knowledgeBase/genUSearchPhysicalCoverageWriter.js'
        );
        const childCode = [
            "const Database = require('better-sqlite3');",
            "const Writer = require(process.argv[2]);",
            "const db = new Database(process.argv[1]);",
            "db.pragma('journal_mode = WAL');",
            "db.pragma('synchronous = FULL');",
            "db.pragma('foreign_keys = ON');",
            "try {",
            "  new Writer({ db, runtimeId: 'runtime-child' });",
            "  console.log('UNEXPECTED_SUCCESS');",
            "  process.exitCode = 2;",
            "} catch (error) {",
            "  console.log(error && error.code ? error.code : String(error));",
            "  process.exitCode = error && error.code === 'MEMTABLE_RUNTIME_ALREADY_OWNED' ? 0 : 3;",
            "} finally {",
            "  try { db.close(); } catch (_) {}",
            "}"
        ].join('\n');
        const child = spawnSync(
            process.execPath,
            ['-e', childCode, fixture.db.name, writerModule],
            {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    NODE_PATH: path.resolve(__dirname, 'node_modules')
                }
            }
        );
        assert.equal(child.status, 0, child.stderr || child.stdout);
        assert.match(child.stdout, /MEMTABLE_RUNTIME_ALREADY_OWNED/);
    } finally {
        fixture.cleanup();
    }
});

test('runtime fence rollover allows a new process lease and fences the old writer', () => {
    const fixture = createFixture();
    try {
        const nextFence = rolloverRuntimeFence(
            fixture.db,
            'runtime-takeover',
            9000
        );
        assert.equal(nextFence, 1n);

        const second = new Database(fixture.db.name);
        try {
            second.pragma('journal_mode = WAL');
            second.pragma('synchronous = FULL');
            second.pragma('foreign_keys = ON');
            const takeover = new GenUSearchPhysicalCoverageWriter({
                db: second,
                runtimeId: 'runtime-takeover'
            });
            assert.equal(takeover.runtimeId, 'runtime-takeover');

            assert.throws(
                () => fixture.writer.createMemTable({
                    VexusIndex,
                    dimension: 4,
                    capacity: 16,
                    generation: '9',
                    embeddingFingerprint: 'embed-v1'
                }),
                error => error?.code === 'RUNTIME_FENCE_STALE'
            );
        } finally {
            try { second.close(); } catch (_) {}
        }
    } finally {
        fixture.cleanup();
    }
});


test('same owner with a new runtime fence cannot be adopted by the old G2 writer', () => {
    const fixture = createFixture();
    let second;
    try {
        const nextFence = rolloverRuntimeFence(
            fixture.db,
            fixture.writer.runtimeId,
            9100
        );
        assert.equal(nextFence, 1n);

        assert.throws(
            () => fixture.writer.createMemTable({
                VexusIndex,
                dimension: 4,
                capacity: 16,
                generation: '10',
                embeddingFingerprint: 'embed-v1'
            }),
            error => error?.code === 'RUNTIME_FENCE_STALE'
        );

        second = new Database(fixture.db.name);
        second.pragma('journal_mode = WAL');
        second.pragma('synchronous = FULL');
        second.pragma('foreign_keys = ON');
        const replacement = new GenUSearchPhysicalCoverageWriter({
            db: second,
            runtimeId: fixture.writer.runtimeId
        });
        assert.equal(replacement.runtimeId, fixture.writer.runtimeId);
        const replacementMemtable = replacement.createMemTable({
            VexusIndex,
            dimension: 4,
            capacity: 16,
            generation: '10',
            embeddingFingerprint: 'embed-v1'
        });
        assert.equal(replacementMemtable.runtimeId, fixture.writer.runtimeId);
    } finally {
        try { second?.close(); } catch (_) {}
        fixture.cleanup();
    }
});


test('IDLE runtime with an explicit different owner cannot be claimed by G2', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gen-usearch-g2-idle-owner-'));
    const db = new Database(path.join(root, 'knowledge.sqlite'));
    try {
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = FULL');
        db.pragma('foreign_keys = ON');
        initializeKnowledgeBaseSchema(db, { logPrefix: 'GenUSearchG2IdleOwner' });

        db.prepare(`
            UPDATE gen_usearch_runtime_ownership
            SET owner_id = 'runtime-owner-a',
                serving_state = 'IDLE',
                runtime_fence = 4,
                acquired_at = 4000,
                updated_at = 4000
            WHERE singleton = 1
        `).run();

        assert.throws(
            () => new GenUSearchPhysicalCoverageWriter({
                db,
                runtimeId: 'runtime-owner-b'
            }),
            error => error?.code === 'RUNTIME_FENCE_STALE'
        );
        assert.equal(
            db.prepare(
                'SELECT COUNT(*) AS count FROM gen_usearch_runtime_process_lease'
            ).get().count,
            0
        );

        const ownerWriter = new GenUSearchPhysicalCoverageWriter({
            db,
            runtimeId: 'runtime-owner-a'
        });
        assert.equal(ownerWriter.runtimeId, 'runtime-owner-a');
    } finally {
        try { db.close(); } catch (_) {}
        fs.rmSync(root, { recursive: true, force: true });
    }
});
