'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GenUSearchMemTable = require('./genUSearchMemTable');
const { VexusIndex } = require('../../rust-vexus-lite');

const MAX_SIGNED_INT64 = 9223372036854775807n;
const SHA256_RE = /^[a-f0-9]{64}$/;

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function canonicalVectorId(value) {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
        throw codedError(
            'VECTOR_ID_INVALID',
            'segment vectorId must be a canonical positive decimal string'
        );
    }
    const parsed = BigInt(value);
    if (parsed > MAX_SIGNED_INT64) {
        throw codedError(
            'VECTOR_ID_INVALID',
            'segment vectorId exceeds signed-int64 range'
        );
    }
    return { text: value, bigint: parsed };
}

function canonicalEpoch(value, field = 'manifestEpoch') {
    const text = typeof value === 'bigint'
        ? value.toString()
        : typeof value === 'number' && Number.isSafeInteger(value)
            ? String(value)
            : value;
    if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)$/.test(text)) {
        throw codedError(
            'MANIFEST_EPOCH_REGRESSION',
            `${field} must be a canonical non-negative integer`
        );
    }
    const parsed = BigInt(text);
    if (parsed > MAX_SIGNED_INT64) {
        throw codedError(
            'MANIFEST_EPOCH_REGRESSION',
            `${field} exceeds signed-int64 range`
        );
    }
    return parsed;
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

function recoveryBlobToVector(blob, dimension) {
    if (!Buffer.isBuffer(blob) || blob.length !== dimension * 4) {
        throw codedError(
            'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
            'segment recovery bytes have the wrong dimension'
        );
    }
    const arrayBuffer = new ArrayBuffer(blob.length);
    blob.copy(Buffer.from(arrayBuffer));
    const vector = new Float32Array(arrayBuffer);
    for (const value of vector) {
        if (!Number.isFinite(value)) {
            throw codedError(
                'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                'segment recovery bytes contain non-finite f32 values'
            );
        }
    }
    return vector;
}

function exactSetEquals(left, right) {
    if (left.length !== right.length) return false;
    const a = [...left].sort();
    const b = [...right].sort();
    return a.every((value, index) => value === b[index]);
}

function databaseIdentity(db) {
    const name = String(db?.name || '').trim();
    if (!name || name === ':memory:' || name.startsWith('file::memory:')) {
        return `memory:${name || 'anonymous'}`;
    }
    const absolute = path.resolve(name);
    try {
        const stat = fs.statSync(absolute, { bigint: true });
        if (stat.isFile() && stat.ino !== 0n) {
            return `inode:${stat.dev.toString()}:${stat.ino.toString()}`;
        }
    } catch (_) {
        // Fall back to canonical path if stable file identity is unavailable.
    }
    try {
        const resolved = fs.realpathSync.native
            ? fs.realpathSync.native(absolute)
            : fs.realpathSync(absolute);
        return `path:${resolved}`;
    } catch (_) {
        return `path:${absolute}`;
    }
}

class GenUSearchSegmentPublisher {
    constructor(options = {}) {
        const db = options.db;
        if (!db?.prepare || !db?.transaction || !db?.pragma) {
            throw new TypeError(
                'GenUSearchSegmentPublisher requires a better-sqlite3 compatible database'
            );
        }
        if (typeof VexusIndex !== 'function') {
            throw new TypeError('GenUSearchSegmentPublisher requires native VexusIndex');
        }

        const segmentRoot = path.resolve(
            String(options.segmentRoot || '').trim()
        );
        if (!segmentRoot || segmentRoot === path.parse(segmentRoot).root) {
            throw new TypeError('G3 segmentRoot must be a dedicated non-root directory');
        }
        fs.mkdirSync(segmentRoot, { recursive: true });
        this.segmentRoot = fs.realpathSync(segmentRoot);
        this.databaseIdentity = databaseIdentity(db);
        this.db = db;
        this.now = typeof options.now === 'function'
            ? options.now
            : () => Date.now();

        this._getSequence = db.prepare(`
            SELECT value
            FROM gen_usearch_sequences
            WHERE name = 'manifest_epoch'
        `).safeIntegers(true);
        this._getManifestState = db.prepare(`
            SELECT manifest_epoch
            FROM gen_usearch_manifest_state
            WHERE singleton = 1
        `).safeIntegers(true);
        this._listManifestSegments = db.prepare(`
            SELECT segment_id
            FROM gen_usearch_manifest_segments
            WHERE manifest_epoch = ?
            ORDER BY segment_id
        `);
        this._getSegment = db.prepare(`
            SELECT *
            FROM gen_usearch_segments
            WHERE segment_id = ?
        `).safeIntegers(true);
        this._insertBuildingSegment = db.prepare(`
            INSERT INTO gen_usearch_segments (
                segment_id, state, artifact_path, artifact_digest,
                embedding_fingerprint, vector_count,
                created_at, finalized_at, published_at, retired_at
            ) VALUES (?, 'BUILDING', NULL, NULL, ?, ?, ?, NULL, NULL, NULL)
        `);
        this._finalizeSegment = db.prepare(`
            UPDATE gen_usearch_segments
            SET state = 'FINALIZED_DURABLE',
                artifact_path = ?,
                artifact_digest = ?,
                vector_count = ?,
                finalized_at = ?
            WHERE segment_id = ?
              AND state = 'BUILDING'
        `);
        this._publishSegment = db.prepare(`
            UPDATE gen_usearch_segments
            SET state = 'PUBLISHED',
                published_at = ?
            WHERE segment_id = ?
              AND state = 'FINALIZED_DURABLE'
        `);
        this._getRecovery = db.prepare(`
            SELECT
                cv.vector_id,
                cv.state AS version_state,
                cv.embedding_fingerprint,
                vr.state AS recovery_state,
                vr.embedding_fingerprint AS recovery_fingerprint,
                vr.vector_blob,
                vr.covered_segment_id
            FROM gen_usearch_chunk_versions cv
            LEFT JOIN gen_usearch_vector_recovery vr
              ON vr.vector_id = cv.vector_id
            WHERE cv.vector_id = ?
        `).safeIntegers(true);
        this._insertManifestMember = db.prepare(`
            INSERT INTO gen_usearch_manifest_segments (
                manifest_epoch, segment_id
            ) VALUES (?, ?)
        `);
        this._updateSequenceCas = db.prepare(`
            UPDATE gen_usearch_sequences
            SET value = ?, updated_at = ?
            WHERE name = 'manifest_epoch'
              AND value = ?
        `);
        this._updateManifestStateCas = db.prepare(`
            UPDATE gen_usearch_manifest_state
            SET manifest_epoch = ?, updated_at = ?
            WHERE singleton = 1
              AND manifest_epoch = ?
        `);
        this._upsertSegmentCoverage = db.prepare(`
            INSERT INTO gen_usearch_vector_coverage (
                vector_id, source_kind, source_id,
                coverage_state, created_at, updated_at
            ) VALUES (?, 'SEGMENT', ?, 'QUERY_VISIBLE', ?, ?)
            ON CONFLICT(vector_id, source_kind, source_id)
            DO UPDATE SET
                coverage_state = 'QUERY_VISIBLE',
                updated_at = excluded.updated_at
        `);
        this._getSegmentCoverage = db.prepare(`
            SELECT coverage_state
            FROM gen_usearch_vector_coverage
            WHERE vector_id = ?
              AND source_kind = 'SEGMENT'
              AND source_id = ?
        `);
        this._listSegmentCoverage = db.prepare(`
            SELECT vector_id, coverage_state
            FROM gen_usearch_vector_coverage
            WHERE source_kind = 'SEGMENT'
              AND source_id = ?
            ORDER BY vector_id
        `).safeIntegers(true);
        this._markRecoverySegmentCovered = db.prepare(`
            UPDATE gen_usearch_vector_recovery
            SET state = 'SEGMENT_COVERED',
                covered_segment_id = ?,
                updated_at = ?
            WHERE vector_id = ?
              AND state = 'RECOVERY_REQUIRED'
        `);
        this._getRecoveryState = db.prepare(`
            SELECT state, covered_segment_id
            FROM gen_usearch_vector_recovery
            WHERE vector_id = ?
        `);
        this._listRecoveryByCoveredSegment = db.prepare(`
            SELECT vector_id
            FROM gen_usearch_vector_recovery
            WHERE covered_segment_id = ?
            ORDER BY vector_id
        `).safeIntegers(true);
        this._getPublishedManifestEpochForSegment = db.prepare(`
            SELECT MAX(manifest_epoch) AS manifest_epoch
            FROM gen_usearch_manifest_segments
            WHERE segment_id = ?
        `).safeIntegers(true);

        this._finalizeTransaction = db.transaction(receipt => {
            const row = this._getSegment.get(receipt.segmentId);
            if (!row || row.state !== 'BUILDING') {
                throw codedError(
                    'SEGMENT_ARTIFACT_INVALID',
                    `Segment ${receipt.segmentId} is not BUILDING`
                );
            }
            this._finalizeSegment.run(
                receipt.artifactPath,
                receipt.artifactDigest,
                receipt.vectorCount,
                receipt.now,
                receipt.segmentId
            );
            const finalized = this._getSegment.get(receipt.segmentId);
            if (
                !finalized
                || finalized.state !== 'FINALIZED_DURABLE'
                || finalized.artifact_path !== receipt.artifactPath
                || finalized.artifact_digest !== receipt.artifactDigest
                || BigInt(finalized.vector_count) !== BigInt(receipt.vectorCount)
            ) {
                throw codedError(
                    'SEGMENT_ARTIFACT_INVALID',
                    'FINALIZED_DURABLE segment postcondition failed'
                );
            }
            return finalized;
        });

        this._publishTransaction = db.transaction(input => {
            const currentSequence = this._getSequence.get()?.value;
            const currentManifest = this._getManifestState.get()?.manifest_epoch;
            if (
                currentSequence == null
                || currentManifest == null
                || currentSequence !== input.expectedEpoch
                || currentManifest !== input.expectedEpoch
            ) {
                throw codedError(
                    'COMPACTION_PUBLICATION_STALE',
                    'captured manifest_epoch is stale'
                );
            }

            const segment = this._getSegment.get(input.segmentId);
            if (!segment || segment.state !== 'FINALIZED_DURABLE') {
                throw codedError(
                    'SEGMENT_ARTIFACT_INVALID',
                    'manifest may publish only FINALIZED_DURABLE segments'
                );
            }
            if (
                segment.artifact_path !== input.artifactPath
                || segment.artifact_digest !== input.artifactDigest
                || segment.embedding_fingerprint !== input.embeddingFingerprint
                || BigInt(segment.vector_count) !== BigInt(input.vectorIds.length)
            ) {
                throw codedError(
                    'SEGMENT_ARTIFACT_INVALID',
                    'segment metadata diverged before manifest publication'
                );
            }

            const previous = this._listManifestSegments
                .all(input.expectedEpoch)
                .map(row => row.segment_id);
            for (const previousSegmentId of previous) {
                const previousRow = this._getSegment.get(previousSegmentId);
                if (
                    !previousRow
                    || previousRow.state !== 'PUBLISHED'
                    || !SHA256_RE.test(previousRow.artifact_digest || '')
                    || !previousRow.artifact_path
                ) {
                    throw codedError(
                        'RECOVERY_MANIFEST_INVALID',
                        `manifest references invalid segment ${previousSegmentId}`
                    );
                }
            }

            const nextEpoch = input.expectedEpoch + 1n;
            if (nextEpoch > MAX_SIGNED_INT64) {
                throw codedError(
                    'MANIFEST_EPOCH_REGRESSION',
                    'manifest_epoch exhausted signed-int64 range'
                );
            }
            const now = input.now;

            if (
                this._updateSequenceCas.run(
                    nextEpoch,
                    now,
                    input.expectedEpoch
                ).changes !== 1
                || this._updateManifestStateCas.run(
                    nextEpoch,
                    now,
                    input.expectedEpoch
                ).changes !== 1
            ) {
                throw codedError(
                    'COMPACTION_PUBLICATION_STALE',
                    'manifest CAS failed'
                );
            }

            const manifestSet = [...new Set([...previous, input.segmentId])].sort();
            for (const segmentId of manifestSet) {
                this._insertManifestMember.run(nextEpoch, segmentId);
            }

            if (this._publishSegment.run(now, input.segmentId).changes !== 1) {
                throw codedError(
                    'SEGMENT_ARTIFACT_INVALID',
                    'segment publish state transition failed'
                );
            }

            for (const vectorId of input.vectorIds) {
                const parsed = canonicalVectorId(vectorId);
                this._upsertSegmentCoverage.run(
                    parsed.bigint,
                    input.segmentId,
                    now,
                    now
                );
                const coverage = this._getSegmentCoverage.get(
                    parsed.bigint,
                    input.segmentId
                );
                if (!coverage || coverage.coverage_state !== 'QUERY_VISIBLE') {
                    throw codedError(
                        'PHYSICAL_COVERAGE_MISSING',
                        `SEGMENT coverage postcondition failed for vector ${vectorId}`
                    );
                }

                const recovery = this._getRecoveryState.get(parsed.bigint);
                if (!recovery) {
                    throw codedError(
                        'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                        `recovery authority missing for vector ${vectorId}`
                    );
                }
                if (recovery.state === 'RECOVERY_REQUIRED') {
                    this._markRecoverySegmentCovered.run(
                        input.segmentId,
                        now,
                        parsed.bigint
                    );
                    const updated = this._getRecoveryState.get(parsed.bigint);
                    if (
                        !updated
                        || updated.state !== 'SEGMENT_COVERED'
                        || updated.covered_segment_id !== input.segmentId
                    ) {
                        throw codedError(
                            'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                            `SEGMENT_COVERED postcondition failed for vector ${vectorId}`
                        );
                    }
                } else if (
                    !['SEGMENT_COVERED', 'RECOVERY_RECLAIMABLE'].includes(recovery.state)
                ) {
                    throw codedError(
                        'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                        `invalid recovery state ${recovery.state} for vector ${vectorId}`
                    );
                }
            }

            const afterSequence = this._getSequence.get()?.value;
            const afterManifest = this._getManifestState.get()?.manifest_epoch;
            const afterMembers = this._listManifestSegments
                .all(nextEpoch)
                .map(row => row.segment_id);
            const published = this._getSegment.get(input.segmentId);

            if (
                afterSequence !== nextEpoch
                || afterManifest !== nextEpoch
                || !published
                || published.state !== 'PUBLISHED'
                || !exactSetEquals(afterMembers, manifestSet)
            ) {
                throw codedError(
                    'RECOVERY_MANIFEST_INVALID',
                    'manifest publication postcondition failed'
                );
            }

            return {
                manifestEpoch: nextEpoch,
                manifestSegmentIds: manifestSet
            };
        });
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
                'G3 publication requires SQLite WAL + FULL/EXTRA durability'
            );
        }
        return true;
    }

    captureManifestEpoch() {
        const sequence = this._getSequence.get()?.value;
        const manifest = this._getManifestState.get()?.manifest_epoch;
        if (sequence == null || manifest == null || sequence !== manifest) {
            throw codedError(
                'MANIFEST_METADATA_CONFLICT',
                'manifest sequence and manifest state diverged'
            );
        }
        return sequence.toString();
    }

    _assertSealedMemTable(memtable) {
        const snapshot = GenUSearchMemTable.snapshotForImmutableSegment(memtable);
        if (snapshot.state !== 'SEALED_QUERY_VISIBLE') {
            throw codedError(
                'MEMTABLE_NOT_QUERY_VISIBLE',
                'G3 flush requires SEALED_QUERY_VISIBLE Gen0 source'
            );
        }
        const vectorIds = snapshot.vectorIds.map(
            id => canonicalVectorId(id).text
        );
        if (vectorIds.length === 0) {
            throw codedError(
                'SEGMENT_ARTIFACT_INVALID',
                'G3 does not publish empty segments'
            );
        }
        return Object.freeze({
            ...snapshot,
            vectorIds: Object.freeze(vectorIds)
        });
    }

    _segmentIdentity(source) {
        const digest = crypto.createHash('sha256')
            .update(JSON.stringify({
                databaseIdentity: this.databaseIdentity,
                sourceId: source.sourceId,
                embeddingFingerprint: source.embeddingFingerprint,
                vectorIds: source.vectorIds
            }))
            .digest('hex');
        return `seg-${digest}`;
    }

    _artifactPath(segmentId) {
        if (!/^seg-[a-f0-9]{64}$/.test(segmentId)) {
            throw codedError('SEGMENT_ARTIFACT_INVALID', 'invalid segment identity');
        }
        const artifactPath = path.join(
            this.segmentRoot,
            `${segmentId}.usearch`
        );
        const parent = path.dirname(artifactPath);
        if (fs.realpathSync(parent) !== this.segmentRoot) {
            throw codedError(
                'SEGMENT_ARTIFACT_INVALID',
                'segment artifact escaped configured root'
            );
        }
        return artifactPath;
    }

    _readBuildRows(vectorIds, source) {
        return vectorIds.map(vectorId => {
            const parsed = canonicalVectorId(vectorId);
            const row = this._getRecovery.get(parsed.bigint);
            if (
                !row
                || row.vector_id == null
                || !['VECTOR_STAGED', 'ACTIVE', 'RETIRED'].includes(row.version_state)
                || !row.vector_blob
                || !['RECOVERY_REQUIRED', 'SEGMENT_COVERED', 'RECOVERY_RECLAIMABLE'].includes(row.recovery_state)
                || !row.embedding_fingerprint
                || row.embedding_fingerprint !== row.recovery_fingerprint
                || row.embedding_fingerprint !== source.embeddingFingerprint
            ) {
                throw codedError(
                    'RECOVERY_ACTIVE_VECTOR_UNRECOVERABLE',
                    `vector ${vectorId} lacks exact G3 build authority`
                );
            }
            return {
                vectorId,
                vectorIdBigInt: parsed.bigint,
                vector: recoveryBlobToVector(row.vector_blob, source.dimension)
            };
        });
    }

    _ensureBuildingRecord(segmentId, source, vectorCount) {
        const existing = this._getSegment.get(segmentId);
        if (existing) return existing;

        const now = BigInt(this.now());
        try {
            this._insertBuildingSegment.run(
                segmentId,
                source.embeddingFingerprint,
                vectorCount,
                now
            );
        } catch (error) {
            if (!/UNIQUE|constraint/i.test(String(error?.message || ''))) {
                throw error;
            }
        }
        const created = this._getSegment.get(segmentId);
        if (
            !created
            || created.embedding_fingerprint !== source.embeddingFingerprint
            || BigInt(created.vector_count) !== BigInt(vectorCount)
        ) {
            throw codedError(
                'SEGMENT_ARTIFACT_INVALID',
                'BUILDING segment postcondition failed'
            );
        }
        return created;
    }

    _buildAndVerifyArtifact(segmentId, source, vectorIds) {
        const artifactPath = this._artifactPath(segmentId);
        const rows = this._readBuildRows(vectorIds, source);
        const index = new VexusIndex(
            source.dimension,
            Math.max(16, rows.length + 1)
        );
        for (const row of rows) {
            index.addKey64(row.vectorId, row.vector);
            if (!index.containsKey64(row.vectorId)) {
                throw codedError(
                    'SEGMENT_ARTIFACT_INVALID',
                    `native build lost vector ${row.vectorId}`
                );
            }
        }
        index.save(artifactPath);

        if (!fs.statSync(artifactPath).isFile()) {
            throw codedError(
                'SEGMENT_ARTIFACT_INVALID',
                'native save did not publish a regular artifact file'
            );
        }
        const artifactDigest = sha256File(artifactPath);
        if (!SHA256_RE.test(artifactDigest)) {
            throw codedError(
                'SEGMENT_ARTIFACT_INVALID',
                'segment artifact SHA-256 invalid'
            );
        }

        const loaded = VexusIndex.load(
            artifactPath,
            null,
            source.dimension,
            Math.max(16, rows.length + 1)
        );
        const stats = loaded.stats();
        if (Number(stats.totalVectors) !== rows.length) {
            throw codedError(
                'SEGMENT_ARTIFACT_INVALID',
                'reloaded segment vector count mismatch'
            );
        }
        for (const row of rows) {
            if (!loaded.containsKey64(row.vectorId)) {
                throw codedError(
                    'SEGMENT_ARTIFACT_INVALID',
                    `reloaded segment missing vector ${row.vectorId}`
                );
            }
        }

        return {
            segmentId,
            artifactPath,
            artifactDigest,
            vectorCount: rows.length,
            vectorIds
        };
    }

    _verifyExistingArtifact(segment, source, vectorIds) {
        if (
            !segment.artifact_path
            || !segment.artifact_digest
            || !SHA256_RE.test(segment.artifact_digest)
            || segment.embedding_fingerprint !== source.embeddingFingerprint
            || BigInt(segment.vector_count) !== BigInt(vectorIds.length)
            || !fs.existsSync(segment.artifact_path)
            || !fs.statSync(segment.artifact_path).isFile()
        ) {
            throw codedError(
                'SEGMENT_ARTIFACT_INVALID',
                'existing segment artifact metadata is incomplete'
            );
        }
        if (sha256File(segment.artifact_path) !== segment.artifact_digest) {
            throw codedError(
                'SEGMENT_ARTIFACT_INVALID',
                'existing segment artifact digest mismatch'
            );
        }
        const loaded = VexusIndex.load(
            segment.artifact_path,
            null,
            source.dimension,
            Math.max(16, vectorIds.length + 1)
        );
        if (Number(loaded.stats().totalVectors) !== vectorIds.length) {
            throw codedError(
                'SEGMENT_ARTIFACT_INVALID',
                'existing segment vector count mismatch'
            );
        }
        for (const vectorId of vectorIds) {
            if (!loaded.containsKey64(vectorId)) {
                throw codedError(
                    'SEGMENT_ARTIFACT_INVALID',
                    `existing segment missing vector ${vectorId}`
                );
            }
        }
        return {
            segmentId: segment.segment_id,
            artifactPath: segment.artifact_path,
            artifactDigest: segment.artifact_digest,
            vectorCount: vectorIds.length,
            vectorIds
        };
    }

    publishSealedMemTable(options = {}) {
        this.assertCrashDurableProfile();
        const source = this._assertSealedMemTable(options.memtable);
        const vectorIds = [...source.vectorIds];
        const expectedEpoch = canonicalEpoch(
            options.expectedManifestEpoch,
            'expectedManifestEpoch'
        );
        const segmentId = this._segmentIdentity(source);
        let segment = this._ensureBuildingRecord(
            segmentId,
            source,
            vectorIds.length
        );

        if (segment.state === 'PUBLISHED') {
            const verified = this._verifyExistingArtifact(
                segment,
                source,
                vectorIds
            );
            const epoch = this._getPublishedManifestEpochForSegment
                .get(segmentId)?.manifest_epoch;
            if (epoch == null) {
                throw codedError(
                    'RECOVERY_MANIFEST_INVALID',
                    'PUBLISHED segment is absent from manifest history'
                );
            }
            this._verifyPublishedTopology(
                segmentId,
                vectorIds,
                epoch
            );
            return Object.freeze({
                segmentId,
                manifestEpoch: epoch.toString(),
                artifactPath: verified.artifactPath,
                artifactDigest: verified.artifactDigest,
                vectorIds: Object.freeze([...vectorIds]),
                alreadyPublished: true
            });
        }

        let receipt;
        if (segment.state === 'BUILDING') {
            receipt = this._buildAndVerifyArtifact(
                segmentId,
                source,
                vectorIds
            );
            const now = BigInt(this.now());
            this._finalizeTransaction({
                ...receipt,
                now
            });
            segment = this._getSegment.get(segmentId);
        } else if (segment.state === 'FINALIZED_DURABLE') {
            receipt = this._verifyExistingArtifact(
                segment,
                source,
                vectorIds
            );
        } else {
            throw codedError(
                'SEGMENT_ARTIFACT_INVALID',
                `segment ${segmentId} is in unsupported state ${segment.state}`
            );
        }

        // Re-verify final bytes and the current manifest's durable members
        // immediately before topology publication.
        receipt = this._verifyExistingArtifact(
            this._getSegment.get(segmentId),
            source,
            vectorIds
        );
        this._assertManifestArtifactSet(expectedEpoch);

        const publication = this._publishTransaction({
            ...receipt,
            expectedEpoch,
            embeddingFingerprint: source.embeddingFingerprint,
            now: BigInt(this.now())
        });

        return Object.freeze({
            segmentId,
            manifestEpoch: publication.manifestEpoch.toString(),
            manifestSegmentIds: Object.freeze([
                ...publication.manifestSegmentIds
            ]),
            artifactPath: receipt.artifactPath,
            artifactDigest: receipt.artifactDigest,
            vectorIds: Object.freeze([...vectorIds]),
            alreadyPublished: false
        });
    }
}

module.exports = GenUSearchSegmentPublisher;
