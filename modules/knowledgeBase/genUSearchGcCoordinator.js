'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
    GenUSearchQueryReadViewCoordinator
} = require('./genUSearchQueryReadView');
const { VexusIndex } = require('../../rust-vexus-lite');

const MAX_SIGNED_INT64 = 9223372036854775807n;

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function canonicalInteger(value, field, min = 0n) {
    const text = typeof value === 'bigint'
        ? value.toString()
        : typeof value === 'number' && Number.isSafeInteger(value)
            ? String(value)
            : value;
    if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)$/.test(text)) {
        throw codedError('QUERY_READ_VIEW_INVALID', field + ' must be a canonical integer');
    }
    const parsed = BigInt(text);
    if (parsed < min || parsed > MAX_SIGNED_INT64) {
        throw codedError('QUERY_READ_VIEW_INVALID', field + ' is outside signed-int64 range');
    }
    return { text, parsed };
}

function canonicalVectorId(value) {
    return canonicalInteger(value, 'vector_id', 1n);
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let offset = 0;
        while (true) {
            const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
            if (read === 0) break;
            hash.update(buffer.subarray(0, read));
            offset += read;
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function exactSegmentPath(segmentRoot, segmentId, artifactPath) {
    if (!/^seg-[a-f0-9]{64}$/.test(segmentId)) {
        throw codedError(
            'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
            'covered segment identity is invalid'
        );
    }
    const expected = path.join(segmentRoot, segmentId + '.usearch');
    if (path.resolve(String(artifactPath || '')) !== expected) {
        throw codedError(
            'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
            'covered segment path is not publisher-owned'
        );
    }
    let stat;
    try {
        stat = fs.lstatSync(expected);
    } catch (_) {
        throw codedError(
            'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
            'covered segment artifact is missing'
        );
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw codedError(
            'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
            'covered segment artifact must be a regular non-symlink file'
        );
    }
    const real = fs.realpathSync(expected);
    if (real !== expected) {
        throw codedError(
            'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
            'covered segment canonical path diverged from its identity'
        );
    }
    return real;
}

class GenUSearchGcCoordinator {
    constructor(options = {}) {
        const db = options.db;
        if (!db?.prepare || !db?.transaction || !db?.pragma) {
            throw new TypeError('GenUSearchGcCoordinator requires better-sqlite3');
        }
        const runtimeId = String(options.runtimeId || '').trim();
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(runtimeId)) {
            throw new TypeError('G5 runtimeId must match [A-Za-z0-9._-]{1,128}');
        }
        const segmentRoot = path.resolve(String(options.segmentRoot || '').trim());
        if (!fs.existsSync(segmentRoot)) {
            throw new TypeError('G5 requires an existing segmentRoot');
        }

        this.db = db;
        this.runtimeId = runtimeId;
        this.segmentRoot = fs.realpathSync(segmentRoot);
        this.now = typeof options.now === 'function' ? options.now : () => Date.now();

        this._getRuntime = db.prepare(
            "SELECT owner_id, serving_state, runtime_fence FROM gen_usearch_runtime_ownership WHERE singleton = 1"
        ).safeIntegers(true);
        this._getSequence = db.prepare(
            "SELECT value FROM gen_usearch_sequences WHERE name = ?"
        ).safeIntegers(true);
        this._getManifestState = db.prepare(
            "SELECT manifest_epoch FROM gen_usearch_manifest_state WHERE singleton = 1"
        ).safeIntegers(true);
        this._getVersionAuthority = db.prepare(`
            SELECT
                cv.chunk_version_id,
                cv.chunk_id,
                cv.state AS version_state,
                cv.vector_id,
                cv.retired_visibility_seq,
                cv.embedding_fingerprint AS version_fingerprint,
                h.current_version_id,
                current_cv.chunk_id AS current_chunk_id,
                current_cv.state AS current_version_state,
                current_cv.vector_id AS current_vector_id,
                vr.state AS recovery_state,
                vr.embedding_fingerprint AS recovery_fingerprint,
                vr.vector_blob,
                vr.covered_segment_id
            FROM gen_usearch_chunk_versions cv
            LEFT JOIN gen_usearch_chunk_heads h
              ON h.chunk_id = cv.chunk_id
            LEFT JOIN gen_usearch_chunk_versions current_cv
              ON current_cv.chunk_version_id = h.current_version_id
            LEFT JOIN gen_usearch_vector_recovery vr
              ON vr.vector_id = cv.vector_id
            WHERE cv.chunk_version_id = ?
        `).safeIntegers(true);
        this._getRecoveryAuthority = db.prepare(`
            SELECT
                cv.chunk_version_id,
                cv.chunk_id,
                cv.state AS version_state,
                cv.vector_id,
                cv.retired_visibility_seq,
                cv.embedding_fingerprint AS version_fingerprint,
                h.current_version_id,
                current_cv.chunk_id AS current_chunk_id,
                current_cv.state AS current_version_state,
                current_cv.vector_id AS current_vector_id,
                vr.state AS recovery_state,
                vr.embedding_fingerprint AS recovery_fingerprint,
                vr.vector_blob,
                vr.covered_segment_id
            FROM gen_usearch_vector_recovery vr
            JOIN gen_usearch_chunk_versions cv
              ON cv.chunk_version_id = vr.chunk_version_id
             AND cv.vector_id = vr.vector_id
            LEFT JOIN gen_usearch_chunk_heads h
              ON h.chunk_id = cv.chunk_id
            LEFT JOIN gen_usearch_chunk_versions current_cv
              ON current_cv.chunk_version_id = h.current_version_id
            WHERE vr.vector_id = ?
        `).safeIntegers(true);
        this._getSegment = db.prepare(`
            SELECT
                segment_id,
                state,
                artifact_path,
                artifact_digest,
                embedding_fingerprint,
                dimension,
                vector_count
            FROM gen_usearch_segments
            WHERE segment_id = ?
        `);
        this._getManifestMember = db.prepare(`
            SELECT 1 AS present
            FROM gen_usearch_manifest_segments
            WHERE manifest_epoch = ? AND segment_id = ?
        `);
        this._listSegmentCoverage = db.prepare(`
            SELECT vector_id, coverage_state
            FROM gen_usearch_vector_coverage
            WHERE source_kind = 'SEGMENT' AND source_id = ?
            ORDER BY vector_id
        `).safeIntegers(true);

        const runtimeAtConstruction = this._getRuntime.get();
        if (
            !runtimeAtConstruction
            || runtimeAtConstruction.owner_id !== this.runtimeId
            || runtimeAtConstruction.serving_state !== 'SERVING'
        ) {
            throw codedError(
                'RUNTIME_FENCE_STALE',
                'G5 construction requires the requested runtime to be the current SERVING owner'
            );
        }
        this.runtimeFence = canonicalInteger(
            runtimeAtConstruction.runtime_fence,
            'runtime_fence'
        ).text;

        this._markRecoveryReclaimable = db.prepare(`
            UPDATE gen_usearch_vector_recovery
            SET state = 'RECOVERY_RECLAIMABLE',
                updated_at = ?
            WHERE vector_id = ?
              AND state = 'SEGMENT_COVERED'
        `);
        this._releaseRecovery = db.prepare(`
            UPDATE gen_usearch_vector_recovery
            SET state = 'RECOVERY_RELEASED',
                vector_blob = NULL,
                updated_at = ?
            WHERE vector_id = ?
              AND state = 'RECOVERY_RECLAIMABLE'
        `);
        this._markGcEligible = db.prepare(`
            UPDATE gen_usearch_chunk_versions
            SET state = 'GC_ELIGIBLE',
                updated_at = ?
            WHERE chunk_version_id = ?
              AND state = 'RETIRED'
        `);

        this._certifyRecoveryTransaction = db.transaction((vectorId, now) => {
            this._assertServingRuntime();
            let row = this._getRecoveryAuthority.get(vectorId);
            this._assertRetiredRecoveryAuthority(row);

            if (row.recovery_state === 'RECOVERY_RELEASED') {
                if (row.vector_blob != null) {
                    throw codedError(
                        'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                        'RECOVERY_RELEASED still contains recovery bytes'
                    );
                }
                this._verifyDurableSegmentCoverage(row);
                return row;
            }
            if (!['SEGMENT_COVERED', 'RECOVERY_RECLAIMABLE'].includes(row.recovery_state)) {
                throw codedError(
                    'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                    'recovery must be SEGMENT_COVERED before G5 reclaim certification'
                );
            }

            this._verifyDurableSegmentCoverage(row);
            if (row.recovery_state === 'SEGMENT_COVERED') {
                const changed = this._markRecoveryReclaimable.run(now, vectorId).changes;
                if (changed !== 1) {
                    throw codedError(
                        'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                        'recovery reclaim certification CAS failed'
                    );
                }
            }
            row = this._getRecoveryAuthority.get(vectorId);
            if (!row || !['RECOVERY_RECLAIMABLE', 'RECOVERY_RELEASED'].includes(row.recovery_state)) {
                throw codedError(
                    'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                    'recovery reclaim certification postcondition failed'
                );
            }
            return row;
        });

        this._releaseRecoveryTransaction = db.transaction((vectorId, now) => {
            this._assertServingRuntime();
            let row = this._getRecoveryAuthority.get(vectorId);
            this._assertRetiredRecoveryAuthority(row);

            if (row.recovery_state === 'RECOVERY_RELEASED') {
                if (row.vector_blob != null) {
                    throw codedError(
                        'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                        'RECOVERY_RELEASED still contains recovery bytes'
                    );
                }
                this._verifyDurableSegmentCoverage(row);
                return row;
            }
            if (row.recovery_state !== 'RECOVERY_RECLAIMABLE') {
                throw codedError(
                    'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                    'recovery must be RECOVERY_RECLAIMABLE before release'
                );
            }

            this._verifyDurableSegmentCoverage(row);
            const changed = this._releaseRecovery.run(now, vectorId).changes;
            if (changed !== 1) {
                throw codedError(
                    'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                    'recovery release CAS failed'
                );
            }
            row = this._getRecoveryAuthority.get(vectorId);
            if (
                !row
                || row.recovery_state !== 'RECOVERY_RELEASED'
                || row.vector_blob != null
                || !row.covered_segment_id
            ) {
                throw codedError(
                    'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                    'recovery release postcondition failed'
                );
            }
            return row;
        });

        this._markGcEligibleTransaction = db.transaction((chunkVersionId, now) => {
            this._assertServingRuntime();
            let row = this._getVersionAuthority.get(chunkVersionId);
            if (!row) {
                throw codedError('UNSAFE_GC_ATTEMPT', 'chunk version is unavailable');
            }
            if (
                row.current_version_id == null
                || row.current_chunk_id !== row.chunk_id
                || row.current_version_state !== 'ACTIVE'
                || row.current_vector_id == null
            ) {
                throw codedError(
                    'UNSAFE_GC_ATTEMPT',
                    'current chunk-head authority is missing, non-ACTIVE, or identity-mismatched'
                );
            }
            if (row.current_version_id === row.chunk_version_id) {
                throw codedError(
                    'UNSAFE_GC_ATTEMPT',
                    'current chunk head cannot become GC_ELIGIBLE'
                );
            }
            if (!row.vector_id || row.retired_visibility_seq == null) {
                throw codedError(
                    'UNSAFE_GC_ATTEMPT',
                    'retired vector authority is incomplete'
                );
            }
            if (!['RETIRED', 'GC_ELIGIBLE'].includes(row.version_state)) {
                throw codedError(
                    'UNSAFE_GC_ATTEMPT',
                    'only RETIRED chunk versions may become GC_ELIGIBLE'
                );
            }
            if (row.recovery_state !== 'RECOVERY_RELEASED' || row.vector_blob != null) {
                throw codedError(
                    'UNSAFE_GC_ATTEMPT',
                    'GC requires RECOVERY_RELEASED material state'
                );
            }

            const retiredSeq = canonicalInteger(
                row.retired_visibility_seq,
                'retired_visibility_seq'
            );
            const liveViews = this._assertNoBlockingReaders(retiredSeq);
            if (row.version_state === 'GC_ELIGIBLE') {
                return this._gcCertificate(row, liveViews.length);
            }
            if (row.version_state !== 'RETIRED') {
                throw codedError(
                    'UNSAFE_GC_ATTEMPT',
                    'only RETIRED chunk versions may become GC_ELIGIBLE'
                );
            }
            const changed = this._markGcEligible.run(now, chunkVersionId).changes;
            if (changed !== 1) {
                throw codedError('UNSAFE_GC_ATTEMPT', 'GC eligibility CAS failed');
            }
            row = this._getVersionAuthority.get(chunkVersionId);
            if (!row || row.version_state !== 'GC_ELIGIBLE') {
                throw codedError(
                    'UNSAFE_GC_ATTEMPT',
                    'GC eligibility postcondition failed'
                );
            }
            return this._gcCertificate(row, liveViews.length);
        });
    }

    _assertNoAmbientTransaction() {
        if (this.db.inTransaction === true) {
            throw codedError(
                'QUERY_READ_VIEW_INVALID',
                'G5 authority transition requires SQLite autocommit state'
            );
        }
    }

    assertCrashDurableProfile() {
        const journalMode = String(
            this.db.pragma('journal_mode', { simple: true }) || ''
        ).toLowerCase();
        const synchronous = Number(
            this.db.pragma('synchronous', { simple: true })
        );
        if (journalMode !== 'wal' || !Number.isFinite(synchronous) || synchronous < 2) {
            throw codedError(
                'UNSUPPORTED_DURABILITY_PROFILE',
                'G5 critical writes require SQLite WAL + FULL/EXTRA'
            );
        }
        return true;
    }

    _criticalWrite(operation) {
        this._assertNoAmbientTransaction();
        this.assertCrashDurableProfile();
        return operation();
    }

    _nowInteger() {
        return canonicalInteger(this.now(), 'now').parsed;
    }

    _assertServingRuntime() {
        const runtime = this._getRuntime.get();
        if (
            !runtime
            || runtime.owner_id !== this.runtimeId
            || runtime.serving_state !== 'SERVING'
            || canonicalInteger(runtime.runtime_fence, 'runtime_fence').text !== this.runtimeFence
        ) {
            throw codedError(
                'RUNTIME_FENCE_STALE',
                'G5 requires the requested runtime to remain the current SERVING owner'
            );
        }
        return runtime;
    }

    _assertNoBlockingReaders(retiredSeq) {
        const liveViews = GenUSearchQueryReadViewCoordinator.snapshotGcSafety(this.db);
        const blockers = [];
        for (const view of liveViews) {
            if (
                view.pins_released === true
                || !['ACTIVE', 'CANCEL_REQUESTED', 'QUIESCING'].includes(view.state)
            ) {
                throw codedError(
                    'QUERY_READ_VIEW_INVALID',
                    'live QueryReadView has invalid GC safety state'
                );
            }
            const visibility = canonicalInteger(
                view.visibility_seq,
                'read_view.visibility_seq'
            );
            if (visibility.parsed < retiredSeq.parsed) {
                blockers.push(view.read_view_id);
            }
        }
        if (blockers.length > 0) {
            throw codedError(
                'UNSAFE_GC_ATTEMPT',
                'older unreleased QueryReadView blocks GC: ' + blockers.join(',')
            );
        }
        return liveViews;
    }

    _assertRetiredRecoveryAuthority(row) {
        if (!row || row.vector_id == null || row.chunk_version_id == null) {
            throw codedError(
                'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                'recovery authority is unavailable'
            );
        }
        if (
            row.version_state !== 'RETIRED'
            || row.current_version_id == null
            || row.current_version_id === row.chunk_version_id
            || row.current_chunk_id !== row.chunk_id
            || row.current_version_state !== 'ACTIVE'
            || row.current_vector_id == null
            || row.retired_visibility_seq == null
        ) {
            throw codedError(
                'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                'G5 releases recovery only for a non-current RETIRED vector'
            );
        }
        if (
            !row.version_fingerprint
            || !row.recovery_fingerprint
            || row.version_fingerprint !== row.recovery_fingerprint
            || !row.covered_segment_id
        ) {
            throw codedError(
                'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                'retired recovery fingerprint or covered segment authority is incomplete'
            );
        }
        canonicalVectorId(row.vector_id);
        canonicalInteger(row.retired_visibility_seq, 'retired_visibility_seq');
        return true;
    }

    _currentManifestEpoch() {
        const sequence = this._getSequence.get('manifest_epoch');
        const state = this._getManifestState.get();
        if (!sequence || !state) {
            throw codedError(
                'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                'manifest authority is unavailable'
            );
        }
        const seq = canonicalInteger(sequence.value, 'manifest_epoch');
        const manifest = canonicalInteger(state.manifest_epoch, 'manifest_state.manifest_epoch');
        if (seq.text !== manifest.text) {
            throw codedError(
                'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                'manifest sequence/state diverged during G5 recovery proof'
            );
        }
        return seq;
    }

    _verifyDurableSegmentCoverage(row) {
        const vectorId = canonicalVectorId(row.vector_id);
        const segmentId = String(row.covered_segment_id || '');
        const manifestEpoch = this._currentManifestEpoch();
        if (!this._getManifestMember.get(manifestEpoch.parsed, segmentId)) {
            throw codedError(
                'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                'covered segment is not a current manifest member'
            );
        }

        const segment = this._getSegment.get(segmentId);
        const dimension = Number(segment?.dimension);
        const vectorCount = Number(segment?.vector_count);
        if (
            !segment
            || segment.state !== 'PUBLISHED'
            || !Number.isSafeInteger(dimension)
            || dimension <= 0
            || !Number.isSafeInteger(vectorCount)
            || vectorCount <= 0
            || vectorCount > 0xffffffff
            || !/^[a-f0-9]{64}$/.test(String(segment.artifact_digest || ''))
            || String(segment.embedding_fingerprint || '') !== row.recovery_fingerprint
        ) {
            throw codedError(
                'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                'covered segment metadata is not durable authority'
            );
        }

        const artifactPath = exactSegmentPath(
            this.segmentRoot,
            segmentId,
            segment.artifact_path
        );
        if (sha256File(artifactPath) !== segment.artifact_digest) {
            throw codedError(
                'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                'covered segment digest mismatch'
            );
        }

        const coverage = this._listSegmentCoverage.all(segmentId);
        if (coverage.length !== vectorCount) {
            throw codedError(
                'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                'covered segment exact coverage count mismatch'
            );
        }
        const ids = [];
        const seen = new Set();
        for (const item of coverage) {
            if (item.coverage_state !== 'QUERY_VISIBLE') {
                throw codedError(
                    'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                    'covered segment includes non-query-visible coverage'
                );
            }
            const id = canonicalVectorId(item.vector_id).text;
            if (seen.has(id)) {
                throw codedError(
                    'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                    'covered segment contains duplicate coverage identity'
                );
            }
            seen.add(id);
            ids.push(id);
        }
        if (!seen.has(vectorId.text)) {
            throw codedError(
                'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                'target vector lacks durable SEGMENT coverage'
            );
        }

        const index = VexusIndex.load(
            artifactPath,
            null,
            dimension,
            Math.max(16, vectorCount + 1)
        );
        const postLoadPath = exactSegmentPath(
            this.segmentRoot,
            segmentId,
            segment.artifact_path
        );
        if (
            postLoadPath !== artifactPath
            || sha256File(postLoadPath) !== segment.artifact_digest
        ) {
            throw codedError(
                'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                'covered segment changed during native verification'
            );
        }
        const stats = index.stats();
        if (
            Number(stats.dimensions) !== dimension
            || Number(stats.totalVectors) !== vectorCount
        ) {
            throw codedError(
                'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                'covered segment native shape mismatch'
            );
        }
        for (const id of ids) {
            if (!index.containsKey64(id)) {
                throw codedError(
                    'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                    'covered segment native index is missing vector ' + id
                );
            }
        }

        return Object.freeze({
            vectorId: vectorId.text,
            segmentId,
            manifestEpoch: manifestEpoch.text,
            artifactDigest: segment.artifact_digest,
            vectorCount
        });
    }

    _normalizeRecovery(row) {
        return Object.freeze({
            vectorId: row.vector_id.toString(),
            chunkVersionId: row.chunk_version_id.toString(),
            state: row.recovery_state,
            coveredSegmentId: row.covered_segment_id,
            hasRecoveryBytes: row.vector_blob != null
        });
    }

    _gcCertificate(row, liveViewCount = 0) {
        return Object.freeze({
            chunkVersionId: row.chunk_version_id.toString(),
            vectorId: row.vector_id.toString(),
            state: row.version_state,
            retiredVisibilitySeq: row.retired_visibility_seq.toString(),
            recoveryState: row.recovery_state,
            liveViewCount
        });
    }

    certifyRecoveryReclaimable(vectorId) {
        const parsed = canonicalVectorId(vectorId);
        return this._normalizeRecovery(
            this._criticalWrite(
                () => this._certifyRecoveryTransaction(parsed.parsed, this._nowInteger())
            )
        );
    }

    releaseRecoveryMaterial(vectorId) {
        const parsed = canonicalVectorId(vectorId);
        return this._normalizeRecovery(
            this._criticalWrite(
                () => this._releaseRecoveryTransaction(parsed.parsed, this._nowInteger())
            )
        );
    }

    markGcEligible(chunkVersionId) {
        const parsed = canonicalInteger(chunkVersionId, 'chunk_version_id', 1n);
        return this._criticalWrite(
            () => this._markGcEligibleTransaction(parsed.parsed, this._nowInteger())
        );
    }

    inspectLiveReadViews() {
        this._assertNoAmbientTransaction();
        return GenUSearchQueryReadViewCoordinator.snapshotGcSafety(this.db);
    }
}

module.exports = GenUSearchGcCoordinator;
