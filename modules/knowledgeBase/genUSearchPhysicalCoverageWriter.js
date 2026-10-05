'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const GenUSearchMemTable = require('./genUSearchMemTable');
const ReadPins = require('./genUSearchReadPins');

const MAX_SIGNED_INT64 = 9223372036854775807n;
const LIVE_WRITER_BY_DB = new WeakMap();
const LIVE_WRITER_BY_DATABASE = new Map();
const WRITER_RUNTIME_FENCE = new WeakMap();
const MEMTABLE_DATABASE_AUTHORITY = new WeakMap();

function databaseAuthorityKey(db) {
    const name = String(db?.name || '').trim();
    if (!name || name === ':memory:' || name.startsWith('file::memory:')) {
        return null;
    }
    const absolute = path.resolve(name);
    try {
        const stat = fs.statSync(absolute, { bigint: true });
        if (stat.isFile() && stat.ino !== 0n) {
            return `inode:${stat.dev.toString()}:${stat.ino.toString()}`;
        }
    } catch (_) {
        // Fall back to canonical path when stable file identity is unavailable.
    }
    try {
        return fs.realpathSync.native
            ? fs.realpathSync.native(absolute)
            : fs.realpathSync(absolute);
    } catch (_) {
        return absolute;
    }
}

function databaseAuthorityIdentity(db) {
    return databaseAuthorityKey(db) ?? db;
}

function readRuntimeFenceForWriterGuard(db) {
    try {
        const row = db.prepare(
            'SELECT runtime_fence FROM gen_usearch_runtime_ownership WHERE singleton = 1'
        ).safeIntegers(true).get();
        return row?.runtime_fence == null ? null : BigInt(row.runtime_fence).toString();
    } catch (_) {
        return null;
    }
}

function localWriterStillOwnsCurrentFence(existing, db) {
    if (!existing || existing.db?.open === false) return false;
    const writerFence = WRITER_RUNTIME_FENCE.get(existing);
    const currentFence = readRuntimeFenceForWriterGuard(db);
    if (writerFence == null || currentFence == null) {
        return true;
    }
    return writerFence === currentFence;
}

function assertDatabaseWriterAvailable(db) {
    const sameConnection = LIVE_WRITER_BY_DB.get(db);
    if (sameConnection) {
        if (localWriterStillOwnsCurrentFence(sameConnection, db)) {
            throw codedError(
                'MEMTABLE_RUNTIME_ALREADY_OWNED',
                'this database connection already has a live G2 physical coverage writer'
            );
        }
        LIVE_WRITER_BY_DB.delete(db);
    }

    const key = databaseAuthorityKey(db);
    if (!key) return null;
    const ref = LIVE_WRITER_BY_DATABASE.get(key);
    const existing = ref?.deref?.();
    if (existing && localWriterStillOwnsCurrentFence(existing, db)) {
        throw codedError(
            'MEMTABLE_RUNTIME_ALREADY_OWNED',
            `database already has a live G2 physical coverage writer: ${key}`
        );
    }
    if (ref) LIVE_WRITER_BY_DATABASE.delete(key);
    return key;
}

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function canonicalVectorId(value) {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
        throw codedError(
            'VECTOR_ID_INVALID',
            'physical coverage vectorId must be a canonical positive decimal string'
        );
    }
    const parsed = BigInt(value);
    if (parsed > MAX_SIGNED_INT64) {
        throw codedError(
            'VECTOR_ID_INVALID',
            'physical coverage vectorId exceeds signed-int64 range'
        );
    }
    return { text: value, bigint: parsed };
}

function exactVectorBytes(vector) {
    if (!(vector instanceof Float32Array) || vector.length === 0) {
        throw new TypeError('physical admission vector must be a non-empty Float32Array');
    }
    for (const value of vector) {
        if (!Number.isFinite(value)) {
            throw new TypeError('physical admission vector values must be finite f32 numbers');
        }
    }
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function recoveryBlobToVector(blob, dimension) {
    if (!Buffer.isBuffer(blob) || blob.length !== dimension * 4) {
        throw codedError(
            'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
            'ACTIVE current vector recovery bytes have the wrong dimension'
        );
    }
    const arrayBuffer = new ArrayBuffer(blob.length);
    const target = Buffer.from(arrayBuffer);
    blob.copy(target);
    const vector = new Float32Array(arrayBuffer);
    for (const value of vector) {
        if (!Number.isFinite(value)) {
            throw codedError(
                'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                'ACTIVE current vector recovery bytes contain non-finite f32 values'
            );
        }
    }
    return vector;
}

class GenUSearchPhysicalCoverageWriter {
    #bootstrapped = false;
    #activeMemtable = null;
    #mutationTokens = new WeakMap();
    #sourceIds = new Set();
    #processToken;
    #runtimeFence;

    constructor(options = {}) {
        const db = options.db;
        if (!db?.prepare || !db?.transaction || !db?.pragma) {
            throw new TypeError(
                'GenUSearchPhysicalCoverageWriter requires a better-sqlite3 compatible database'
            );
        }
        if (db.inTransaction === true) {
            throw codedError(
                'DURABLE_COMMIT_UNCONFIRMED',
                'G2 physical writer authority requires SQLite autocommit state'
            );
        }
        const databaseAuthority = assertDatabaseWriterAvailable(db);

        const runtimeId = String(options.runtimeId || '').trim();
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(runtimeId)) {
            throw new TypeError(
                'physical coverage runtimeId must match [A-Za-z0-9._-]{1,128}'
            );
        }

        Object.defineProperty(this, 'runtimeId', {
            value: runtimeId,
            enumerable: true
        });
        this.db = db;
        this.now = typeof options.now === 'function' ? options.now : () => Date.now();
        this.#processToken = crypto.randomUUID();

        this._getRuntimeOwnership = db.prepare(
            "SELECT owner_id, serving_state, runtime_fence FROM gen_usearch_runtime_ownership WHERE singleton = 1"
        ).safeIntegers(true);
        this._getProcessLease = db.prepare(`
            SELECT owner_id, runtime_fence, process_token, acquired_at, updated_at
            FROM gen_usearch_runtime_process_lease
            WHERE singleton = 1
        `).safeIntegers(true);
        this._insertProcessLease = db.prepare(`
            INSERT INTO gen_usearch_runtime_process_lease(
                singleton, owner_id, runtime_fence, process_token, acquired_at, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?)
        `);
        this._replaceProcessLease = db.prepare(`
            UPDATE gen_usearch_runtime_process_lease
            SET owner_id = ?,
                runtime_fence = ?,
                process_token = ?,
                acquired_at = ?,
                updated_at = ?
            WHERE singleton = 1
        `);

        this._getVector = db.prepare(`
            SELECT
                cv.vector_id,
                cv.state,
                cv.embedding_fingerprint,
                vr.state AS recovery_state,
                vr.embedding_fingerprint AS recovery_fingerprint,
                vr.vector_blob
            FROM gen_usearch_chunk_versions cv
            LEFT JOIN gen_usearch_vector_recovery vr
              ON vr.vector_id = cv.vector_id
            WHERE cv.vector_id = ?
        `).safeIntegers(true);

        this._getCoverage = db.prepare(`
            SELECT vector_id, source_kind, source_id, coverage_state, created_at, updated_at
            FROM gen_usearch_vector_coverage
            WHERE vector_id = ? AND source_kind = 'MEMTABLE' AND source_id = ?
        `).safeIntegers(true);

        this._listCoverageForSource = db.prepare(`
            SELECT vector_id, source_kind, source_id, coverage_state, created_at, updated_at
            FROM gen_usearch_vector_coverage
            WHERE source_kind = 'MEMTABLE' AND source_id = ?
            ORDER BY vector_id
        `).safeIntegers(true);

        this._listCurrentRecovery = db.prepare(`
            SELECT
                h.chunk_id,
                h.current_version_id,
                cv.vector_id,
                cv.state AS version_state,
                cv.embedding_fingerprint,
                vr.state AS recovery_state,
                vr.embedding_fingerprint AS recovery_fingerprint,
                vr.vector_blob
            FROM gen_usearch_chunk_heads h
            LEFT JOIN gen_usearch_chunk_versions cv
              ON cv.chunk_version_id = h.current_version_id
            LEFT JOIN gen_usearch_vector_recovery vr
              ON vr.vector_id = cv.vector_id
            WHERE h.current_version_id IS NOT NULL
            ORDER BY h.chunk_id
        `).safeIntegers(true);

        this._deleteAllMemtableCoverage = db.prepare(`
            DELETE FROM gen_usearch_vector_coverage
            WHERE source_kind = 'MEMTABLE'
        `);
        this._countAllMemtableCoverage = db.prepare(`
            SELECT COUNT(*) AS count
            FROM gen_usearch_vector_coverage
            WHERE source_kind = 'MEMTABLE'
        `).safeIntegers(true);

        this._upsertVisibleCoverage = db.prepare(`
            INSERT INTO gen_usearch_vector_coverage (
                vector_id, source_kind, source_id, coverage_state, created_at, updated_at
            ) VALUES (?, 'MEMTABLE', ?, 'QUERY_VISIBLE', ?, ?)
            ON CONFLICT(vector_id, source_kind, source_id)
            DO UPDATE SET
                coverage_state = 'QUERY_VISIBLE',
                updated_at = excluded.updated_at
        `);

        this._deleteCoverage = db.prepare(`
            DELETE FROM gen_usearch_vector_coverage
            WHERE vector_id = ? AND source_kind = 'MEMTABLE' AND source_id = ?
        `);

        this._claimProcessLeaseTransaction = db.transaction((processToken, now) => {
            const runtime = this._getRuntimeOwnership.get();
            if (!runtime) {
                throw codedError(
                    'RUNTIME_FENCE_STALE',
                    'G2 runtime ownership authority is unavailable'
                );
            }
            const fence = BigInt(runtime.runtime_fence);
            if (
                runtime.serving_state !== 'IDLE'
                && runtime.owner_id !== this.runtimeId
            ) {
                throw codedError(
                    'RUNTIME_FENCE_STALE',
                    'G2 writer does not own the current runtime fence'
                );
            }

            const existing = this._getProcessLease.get();
            if (existing && BigInt(existing.runtime_fence) === fence) {
                throw codedError(
                    'MEMTABLE_RUNTIME_ALREADY_OWNED',
                    'current runtime fence already has a live G2 process lease'
                );
            }
            if (existing) {
                this._replaceProcessLease.run(
                    this.runtimeId,
                    fence,
                    processToken,
                    now,
                    now
                );
            } else {
                this._insertProcessLease.run(
                    this.runtimeId,
                    fence,
                    processToken,
                    now,
                    now
                );
            }

            const claimed = this._getProcessLease.get();
            if (
                !claimed
                || claimed.owner_id !== this.runtimeId
                || BigInt(claimed.runtime_fence) !== fence
                || claimed.process_token !== processToken
            ) {
                throw codedError(
                    'MEMTABLE_RUNTIME_ALREADY_OWNED',
                    'G2 process lease claim postcondition failed'
                );
            }
            return fence;
        });

        this._bootstrapTransaction = db.transaction(() => {
            this._assertProcessAuthority();
            const removed = this._deleteAllMemtableCoverage.run().changes;
            const remaining = this._countAllMemtableCoverage.get()?.count ?? 0n;
            if (remaining !== 0n) {
                throw codedError(
                    'PHYSICAL_COVERAGE_MISSING',
                    'runtime bootstrap could not durably purge stale MEMTABLE coverage'
                );
            }
            return removed;
        });
        this._publishCoverageTransaction = db.transaction(
            (vectorId, sourceId, now) => {
                this._assertProcessAuthority();
                this._upsertVisibleCoverage.run(vectorId, sourceId, now, now);
                const coverage = this._getCoverage.get(vectorId, sourceId);
                if (!coverage || coverage.coverage_state !== 'QUERY_VISIBLE') {
                    throw codedError(
                        'PHYSICAL_COVERAGE_MISSING',
                        'MEMTABLE coverage publication postcondition failed'
                    );
                }
                return coverage;
            }
        );
        this._publishCoverageBatchTransaction = db.transaction(
            (vectorIds, sourceId, now) => {
                this._assertProcessAuthority();
                for (const vectorId of vectorIds) {
                    this._upsertVisibleCoverage.run(
                        vectorId,
                        sourceId,
                        now,
                        now
                    );
                }
                for (const vectorId of vectorIds) {
                    const coverage = this._getCoverage.get(vectorId, sourceId);
                    if (!coverage || coverage.coverage_state !== 'QUERY_VISIBLE') {
                        throw codedError(
                            'PHYSICAL_COVERAGE_MISSING',
                            'MEMTABLE batch coverage publication postcondition failed'
                        );
                    }
                }
                return vectorIds.length;
            }
        );
        this._hideCoverageTransaction = db.transaction(
            (vectorId, sourceId) => {
                this._assertProcessAuthority();
                const removed = this._deleteCoverage.run(vectorId, sourceId).changes;
                if (this._getCoverage.get(vectorId, sourceId)) {
                    throw codedError(
                        'PHYSICAL_COVERAGE_MISSING',
                        'MEMTABLE coverage hide postcondition failed'
                    );
                }
                return removed;
            }
        );

        // Durable cross-process lease is authoritative. Process-local registries
        // remain a fast duplicate guard only.
        this.#runtimeFence = this._claimProcessLeaseTransaction(
            this.#processToken,
            BigInt(Date.now())
        ).toString();
        WRITER_RUNTIME_FENCE.set(this, this.#runtimeFence);

        LIVE_WRITER_BY_DB.set(db, this);
        if (databaseAuthority) {
            LIVE_WRITER_BY_DATABASE.set(databaseAuthority, new WeakRef(this));
        }
    }

    get bootstrapped() {
        return this.#bootstrapped;
    }

    createMemTable(options = {}) {
        this._assertNoAmbientTransaction();
        this._assertProcessAuthority();
        const token = Object.freeze({});
        const memtable = new GenUSearchMemTable({
            VexusIndex: options.VexusIndex,
            dimension: options.dimension,
            capacity: options.capacity,
            runtimeId: this.runtimeId,
            generation: options.generation,
            embeddingFingerprint: options.embeddingFingerprint,
            mutationToken: token
        });
        if (this.#sourceIds.has(memtable.sourceId)) {
            throw codedError(
                'MEMTABLE_SOURCE_ID_COLLISION',
                `Gen0 MemTable source identity already exists: ${memtable.sourceId}`
            );
        }
        MEMTABLE_DATABASE_AUTHORITY.set(
            memtable,
            databaseAuthorityIdentity(this.db)
        );
        this.#sourceIds.add(memtable.sourceId);
        this.#mutationTokens.set(memtable, token);
        return memtable;
    }

    static assertMemtableDatabaseAuthority(memtable, db) {
        if (!(memtable instanceof GenUSearchMemTable)) {
            throw codedError(
                'QUERY_READ_VIEW_INVALID',
                'G4 database authority requires a GenUSearchMemTable'
            );
        }
        const actual = MEMTABLE_DATABASE_AUTHORITY.get(memtable);
        const expected = databaseAuthorityIdentity(db);
        if (!actual || actual !== expected) {
            throw codedError(
                'QUERY_READ_VIEW_INVALID',
                'MemTable is not writer-bound to the QueryReadView SQLite authority'
            );
        }
        return true;
    }

    _assertProcessAuthority() {
        const runtime = this._getRuntimeOwnership.get();
        const lease = this._getProcessLease.get();
        if (!runtime || !lease || lease.process_token !== this.#processToken) {
            throw codedError(
                'RUNTIME_FENCE_STALE',
                'G2 process lease is no longer authoritative'
            );
        }
        const currentFence = BigInt(runtime.runtime_fence);
        const leaseFence = BigInt(lease.runtime_fence);
        if (
            runtime.serving_state !== 'IDLE'
            && runtime.owner_id !== this.runtimeId
        ) {
            throw codedError(
                'RUNTIME_FENCE_STALE',
                'G2 runtime ownership moved to another owner'
            );
        }
        if (
            lease.owner_id !== this.runtimeId
            || leaseFence !== currentFence
            || this.#runtimeFence !== currentFence.toString()
        ) {
            throw codedError(
                'RUNTIME_FENCE_STALE',
                'G2 process lease fence is stale; a new runtime incarnation must claim a new process lease'
            );
        }
        return true;
    }

    _assertNoAmbientTransaction() {
        if (this.db.inTransaction === true) {
            throw codedError(
                'DURABLE_COMMIT_UNCONFIRMED',
                'G2 physical mutations require SQLite autocommit state'
            );
        }
        return true;
    }

    assertCrashDurableProfile() {
        const journalMode = String(
            this.db.pragma('journal_mode', { simple: true }) || ''
        ).toLowerCase();
        const synchronous = Number(
            this.db.pragma('synchronous', { simple: true })
        );
        if (journalMode !== 'wal' || synchronous < 2) {
            throw codedError(
                'UNSUPPORTED_DURABILITY_PROFILE',
                'G2 coverage writes require SQLite WAL + FULL/EXTRA synchronous durability'
            );
        }
        return true;
    }

    _criticalWrite(fn) {
        this._assertNoAmbientTransaction();
        this._assertProcessAuthority();
        this.assertCrashDurableProfile();
        return fn();
    }

    _assertBootstrapped() {
        this._assertProcessAuthority();
        if (!this.#bootstrapped) {
            throw codedError(
                'MEMTABLE_RUNTIME_NOT_BOOTSTRAPPED',
                'runtime must purge stale MEMTABLE coverage before physical admission'
            );
        }
    }

    _assertBoundMemTable(memtable) {
        if (!(memtable instanceof GenUSearchMemTable)) {
            throw new TypeError('physical coverage requires a GenUSearchMemTable');
        }
        if (!this.#mutationTokens.has(memtable)) {
            throw codedError(
                'MEMTABLE_NOT_BOUND_TO_WRITER',
                'MemTable was not created by this physical coverage writer'
            );
        }
        if (memtable.runtimeId !== this.runtimeId) {
            throw codedError(
                'MEMTABLE_RUNTIME_MISMATCH',
                'MemTable belongs to a different runtime'
            );
        }
        if (!['ACTIVE', 'SEALED_QUERY_VISIBLE'].includes(memtable.state)) {
            throw codedError(
                'MEMTABLE_NOT_QUERY_VISIBLE',
                `MemTable ${memtable.sourceId} is not query-visible`
            );
        }
        return memtable;
    }

    _tokenFor(memtable) {
        this._assertBoundMemTable(memtable);
        return this.#mutationTokens.get(memtable);
    }

    _readStagedVector(vectorId) {
        const parsed = canonicalVectorId(vectorId);
        const row = this._getVector.get(parsed.bigint);
        if (!row || row.vector_id == null) {
            throw codedError(
                'VECTOR_METADATA_MISSING',
                `Vector ${parsed.text} is not present in Gen-USearch metadata`
            );
        }
        if (row.state !== 'VECTOR_STAGED') {
            throw codedError(
                'INVALID_MVCC_TRANSITION',
                `Vector ${parsed.text} must be VECTOR_STAGED before G2 physical admission`
            );
        }
        if (
            !row.vector_blob
            || row.recovery_state !== 'RECOVERY_REQUIRED'
            || row.embedding_fingerprint !== row.recovery_fingerprint
        ) {
            throw codedError(
                'VECTOR_RECOVERY_MATERIAL_MISSING',
                `Vector ${parsed.text} lacks exact recovery material`
            );
        }
        return { parsed, row };
    }

    bootstrapRuntime() {
        if (this.#bootstrapped) {
            throw codedError(
                'MEMTABLE_RUNTIME_ALREADY_BOOTSTRAPPED',
                'runtime bootstrap is one-shot and cannot purge live coverage twice'
            );
        }
        const removed = this._criticalWrite(
            () => this._bootstrapTransaction()
        );
        this.#bootstrapped = true;
        return Object.freeze({
            runtimeId: this.runtimeId,
            staleMemtableCoverageRemoved: Number(removed)
        });
    }

    sealMemTable(memtable) {
        this._assertNoAmbientTransaction();
        this._assertProcessAuthority();
        const token = this._tokenFor(memtable);
        return memtable.seal(token);
    }

    admitVector(options = {}) {
        this._assertNoAmbientTransaction();
        this._assertBootstrapped();
        const memtable = this._assertBoundMemTable(options.memtable);
        if (memtable.state !== 'ACTIVE') {
            throw codedError(
                'MEMTABLE_NOT_ACTIVE',
                'new vectors may only be admitted into the ACTIVE Gen0 MemTable'
            );
        }

        const { parsed, row } = this._readStagedVector(options.vectorId);
        if (memtable.embeddingFingerprint !== row.embedding_fingerprint) {
            throw codedError(
                'MEMTABLE_EMBEDDING_FINGERPRINT_MISMATCH',
                'staged vector embedding fingerprint does not match the active Gen0 MemTable'
            );
        }
        if (
            this.#activeMemtable
            && this.#activeMemtable !== memtable
            && this.#activeMemtable.state !== 'SEALED_QUERY_VISIBLE'
        ) {
            throw codedError(
                'MEMTABLE_ACTIVE_GENERATION_CONFLICT',
                'another Gen0 MemTable generation is still ACTIVE'
            );
        }

        const bytes = exactVectorBytes(options.vector);
        if (bytes.length !== row.vector_blob.length || !bytes.equals(row.vector_blob)) {
            throw codedError(
                'VECTOR_RECOVERY_MATERIAL_MISMATCH',
                'physical admission bytes differ from exact staged recovery bytes'
            );
        }

        const token = this._tokenFor(memtable);
        const previousActive = this.#activeMemtable;
        memtable.addVector({
            vectorId: parsed.text,
            vector: options.vector
        }, token);
        GenUSearchMemTable.assertContains(memtable, parsed.text);

        if (
            !this.#activeMemtable
            || this.#activeMemtable.state === 'SEALED_QUERY_VISIBLE'
        ) {
            this.#activeMemtable = memtable;
        }

        try {
            const now = BigInt(this.now());
            const coverage = this._criticalWrite(
                () => this._publishCoverageTransaction(
                    parsed.bigint,
                    memtable.sourceId,
                    now
                )
            );
            return Object.freeze({
                vectorId: parsed.text,
                sourceKind: 'MEMTABLE',
                sourceId: memtable.sourceId,
                coverageState: coverage.coverage_state
            });
        } catch (error) {
            try {
                memtable.removeVector(parsed.text, token);
            } catch (_) {
                // Extra hidden bytes are safe because durable coverage was not published.
            }
            if (
                previousActive !== memtable
                && memtable.stats().vectorCount === 0
            ) {
                this.#activeMemtable = previousActive;
            }
            throw error;
        }
    }

    recoverCurrentVectors(options = {}) {
        this._assertNoAmbientTransaction();
        this._assertBootstrapped();
        const memtable = this._assertBoundMemTable(options.memtable);
        if (memtable.state !== 'ACTIVE') {
            throw codedError(
                'MEMTABLE_NOT_ACTIVE',
                'startup recovery requires an ACTIVE Gen0 MemTable'
            );
        }
        if (
            this.#activeMemtable
            && this.#activeMemtable !== memtable
            && this.#activeMemtable.state !== 'SEALED_QUERY_VISIBLE'
        ) {
            throw codedError(
                'MEMTABLE_ACTIVE_GENERATION_CONFLICT',
                'another Gen0 MemTable generation is still ACTIVE'
            );
        }
        if (memtable.stats().vectorCount !== 0) {
            throw codedError(
                'MEMTABLE_RECOVERY_TARGET_NOT_EMPTY',
                'startup recovery requires an empty Gen0 MemTable'
            );
        }

        const rows = this._listCurrentRecovery.all();
        const prepared = rows.map(row => {
            if (
                row.current_version_id == null
                || row.version_state !== 'ACTIVE'
                || row.vector_id == null
                || !['RECOVERY_REQUIRED', 'SEGMENT_COVERED'].includes(row.recovery_state)
                || !row.vector_blob
                || !row.embedding_fingerprint
                || row.embedding_fingerprint !== row.recovery_fingerprint
            ) {
                throw codedError(
                    'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                    `Current chunk "${row.chunk_id}" lacks exact ACTIVE recovery authority`
                );
            }
            if (row.embedding_fingerprint !== memtable.embeddingFingerprint) {
                throw codedError(
                    'MEMTABLE_EMBEDDING_FINGERPRINT_MISMATCH',
                    `Current chunk "${row.chunk_id}" belongs to a different embedding space`
                );
            }
            const vectorId = row.vector_id.toString();
            canonicalVectorId(vectorId);
            return {
                vectorId,
                vectorIdBigInt: row.vector_id,
                vector: recoveryBlobToVector(
                    row.vector_blob,
                    memtable.dimension
                )
            };
        });

        const token = this._tokenFor(memtable);
        const added = [];
        const previousActive = this.#activeMemtable;
        try {
            for (const row of prepared) {
                memtable.addVector({
                    vectorId: row.vectorId,
                    vector: row.vector
                }, token);
                GenUSearchMemTable.assertContains(
                    memtable,
                    row.vectorId
                );
                added.push(row.vectorId);
            }

            if (prepared.length > 0) {
                const now = BigInt(this.now());
                this._criticalWrite(
                    () => this._publishCoverageBatchTransaction(
                        prepared.map(row => row.vectorIdBigInt),
                        memtable.sourceId,
                        now
                    )
                );
                this.#activeMemtable = memtable;
            }

            return Object.freeze({
                sourceId: memtable.sourceId,
                recoveredVectorCount: prepared.length,
                vectorIds: Object.freeze(
                    prepared.map(row => row.vectorId)
                )
            });
        } catch (error) {
            for (const vectorId of added.reverse()) {
                try {
                    memtable.removeVector(vectorId, token);
                } catch (_) {
                    // Hidden physical bytes are safe because batch coverage
                    // publication has not succeeded.
                }
            }
            if (
                previousActive !== memtable
                && memtable.stats().vectorCount === 0
            ) {
                this.#activeMemtable = previousActive;
            }
            throw error;
        }
    }

    hideAndRemoveVector(options = {}) {
        this._assertNoAmbientTransaction();
        this._assertBootstrapped();
        const memtable = this._assertBoundMemTable(options.memtable);
        if (memtable.state !== 'ACTIVE') {
            throw codedError(
                'MEMTABLE_NOT_ACTIVE',
                'physical removal is allowed only from the ACTIVE Gen0 MemTable'
            );
        }
        const parsed = canonicalVectorId(options.vectorId);
        const row = this._getVector.get(parsed.bigint);
        if (!row || row.vector_id == null) {
            throw codedError(
                'VECTOR_METADATA_MISSING',
                `Vector ${parsed.text} is not present in Gen-USearch metadata`
            );
        }
        if (this.#activeMemtable !== memtable) {
            throw codedError(
                'MEMTABLE_ACTIVE_GENERATION_CONFLICT',
                'physical removal requires the writer-bound ACTIVE Gen0 MemTable'
            );
        }
        ReadPins.assertMemtableRemovalAllowed(memtable);
        if (row.state === 'ACTIVE') {
            throw codedError(
                'INVALID_CURRENT_VECTOR_HEAD',
                'G2 must not remove physical coverage for an ACTIVE logical vector'
            );
        }

        const removedCoverage = this._criticalWrite(
            () => this._hideCoverageTransaction(
                parsed.bigint,
                memtable.sourceId
            )
        );
        const physicalRemoved = memtable.removeVector(
            parsed.text,
            this._tokenFor(memtable)
        );

        return Object.freeze({
            vectorId: parsed.text,
            sourceId: memtable.sourceId,
            coverageRowsRemoved: Number(removedCoverage),
            physicalRemoved
        });
    }

    getCoverage(options = {}) {
        const memtable = this._assertBoundMemTable(options.memtable);
        const parsed = canonicalVectorId(options.vectorId);
        const row = this._getCoverage.get(parsed.bigint, memtable.sourceId);
        if (!row) return null;
        return Object.freeze({
            vectorId: row.vector_id.toString(),
            sourceKind: row.source_kind,
            sourceId: row.source_id,
            coverageState: row.coverage_state
        });
    }

    listCoverage(memtable) {
        const bound = this._assertBoundMemTable(memtable);
        return Object.freeze(
            this._listCoverageForSource.all(bound.sourceId).map(row => Object.freeze({
                vectorId: row.vector_id.toString(),
                sourceKind: row.source_kind,
                sourceId: row.source_id,
                coverageState: row.coverage_state
            }))
        );
    }
}

module.exports = GenUSearchPhysicalCoverageWriter;
