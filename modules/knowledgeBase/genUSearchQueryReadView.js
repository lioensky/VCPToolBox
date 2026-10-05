'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GenUSearchMemTable = require('./genUSearchMemTable');
const ReadPins = require('./genUSearchReadPins');
const { VexusIndex } = require('../../rust-vexus-lite');

const MAX_SIGNED_INT64 = 9223372036854775807n;
const VIEW_INTERNAL = new WeakMap();
const VIEW_LIFECYCLE = new WeakMap();

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function integerText(value, field, min = 0n) {
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

function vectorIdText(value) {
    const parsed = integerText(value, 'vector_id', 1n);
    return parsed.text;
}

function safeMillis(value, field) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw codedError('QUERY_READ_VIEW_INVALID', field + ' must be a non-negative safe integer');
    }
    return number;
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

function exactRootPath(root, segmentId, artifactPath) {
    const rootReal = fs.realpathSync(root);
    if (!/^seg-[a-f0-9]{64}$/.test(segmentId)) {
        throw codedError(
            'RECOVERY_MANIFEST_INVALID',
            'manifest segment identity is invalid'
        );
    }
    const expected = path.join(rootReal, segmentId + '.usearch');
    if (path.resolve(artifactPath) !== expected) {
        throw codedError(
            'RECOVERY_MANIFEST_INVALID',
            'manifest artifact path is not bound to segment identity'
        );
    }
    const stat = fs.lstatSync(artifactPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw codedError(
            'RECOVERY_MANIFEST_INVALID',
            'manifest artifact must be a regular non-symlink file'
        );
    }
    const artifactReal = fs.realpathSync(artifactPath);
    if (artifactReal !== expected) {
        throw codedError(
            'RECOVERY_MANIFEST_INVALID',
            'manifest artifact canonical path diverged from segment identity'
        );
    }
    return artifactReal;
}

function incMemtablePin(memtable) {
    ReadPins.pinMemtable(memtable);
}

function decMemtablePin(memtable) {
    ReadPins.unpinMemtable(memtable);
}

function incSegmentPin(segmentId) {
    ReadPins.pinSegment(segmentId);
}

function decSegmentPin(segmentId) {
    ReadPins.unpinSegment(segmentId);
}

function recoveryBlobToVector(blob, dimension) {
    if (!Buffer.isBuffer(blob) || blob.length !== dimension * 4) {
        throw codedError(
            'QUERY_READ_VIEW_PHYSICAL_GAP',
            'snapshot recovery bytes do not match the pinned source dimension'
        );
    }
    const arrayBuffer = new ArrayBuffer(blob.length);
    blob.copy(Buffer.from(arrayBuffer));
    const vector = new Float32Array(arrayBuffer);
    for (const value of vector) {
        if (!Number.isFinite(value)) {
            throw codedError(
                'QUERY_READ_VIEW_PHYSICAL_GAP',
                'snapshot recovery vector contains non-finite values'
            );
        }
    }
    return vector;
}

function l2Score(query, vector) {
    let distance = 0;
    for (let i = 0; i < query.length; i += 1) {
        const delta = query[i] - vector[i];
        distance += delta * delta;
    }
    return 1 / (1 + distance);
}

class QueryReadView {
    constructor(fields) {
        Object.defineProperties(this, {
            read_view_id: { value: fields.read_view_id, enumerable: true },
            visibility_seq: { value: fields.visibility_seq, enumerable: true },
            metadata_snapshot: { value: fields.metadata_snapshot, enumerable: true },
            manifest_snapshot: { value: fields.manifest_snapshot, enumerable: true },
            memtable_generation_set: { value: fields.memtable_generation_set, enumerable: true },
            runtime_fence: { value: fields.runtime_fence, enumerable: true },
            created_at: { value: fields.created_at, enumerable: true },
            deadline: { value: fields.deadline, enumerable: true }
        });
        VIEW_LIFECYCLE.set(this, { state: 'ACTIVE' });
        Object.preventExtensions(this);
    }

    get state() {
        return VIEW_LIFECYCLE.get(this)?.state || 'INVALID';
    }

    get cancellation_requested() {
        return this.state === 'CANCEL_REQUESTED';
    }
}

class GenUSearchQueryReadViewCoordinator {
    constructor(options = {}) {
        const db = options.db;
        if (!db?.prepare || !db?.transaction) {
            throw new TypeError('GenUSearchQueryReadViewCoordinator requires better-sqlite3');
        }
        const runtimeId = String(options.runtimeId || '').trim();
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(runtimeId)) {
            throw new TypeError('G4 runtimeId must match [A-Za-z0-9._-]{1,128}');
        }
        const segmentRoot = path.resolve(String(options.segmentRoot || '').trim());
        if (!segmentRoot || !fs.existsSync(segmentRoot)) {
            throw new TypeError('G4 requires an existing segmentRoot');
        }

        this.db = db;
        this.runtimeId = runtimeId;
        this.segmentRoot = fs.realpathSync(segmentRoot);
        this.now = typeof options.now === 'function' ? options.now : () => Date.now();
        this.maxReadViewMs = safeMillis(options.maxReadViewMs ?? 30000, 'maxReadViewMs');
        if (this.maxReadViewMs < 1) {
            throw new RangeError('maxReadViewMs must be positive');
        }

        this._getSequence = db.prepare(
            "SELECT value FROM gen_usearch_sequences WHERE name = ?"
        ).safeIntegers(true);
        this._getManifestState = db.prepare(
            "SELECT manifest_epoch FROM gen_usearch_manifest_state WHERE singleton = 1"
        ).safeIntegers(true);
        this._getRuntime = db.prepare(
            "SELECT owner_id, serving_state, runtime_fence FROM gen_usearch_runtime_ownership WHERE singleton = 1"
        ).safeIntegers(true);
        this._listCurrent = db.prepare(
            "SELECT h.chunk_id, h.doc_id, h.current_version_id, v.vector_id, v.state AS version_state, v.visibility_seq, v.embedding_fingerprint, vr.state AS recovery_state, vr.embedding_fingerprint AS recovery_fingerprint, vr.vector_blob FROM gen_usearch_chunk_heads h JOIN gen_usearch_documents d ON d.doc_id = h.doc_id JOIN gen_usearch_chunk_versions v ON v.chunk_version_id = h.current_version_id LEFT JOIN gen_usearch_vector_recovery vr ON vr.vector_id = v.vector_id WHERE h.current_version_id IS NOT NULL AND d.state = 'ACTIVE' ORDER BY h.chunk_id"
        ).safeIntegers(true);
        this._listCoverage = db.prepare(
            "SELECT vector_id, source_kind, source_id, coverage_state FROM gen_usearch_vector_coverage WHERE coverage_state = 'QUERY_VISIBLE' ORDER BY vector_id, source_kind, source_id"
        ).safeIntegers(true);
        this._listManifest = db.prepare(
            "SELECT ms.segment_id, s.state, s.artifact_path, s.artifact_digest, s.embedding_fingerprint, s.dimension, s.vector_count FROM gen_usearch_manifest_segments ms JOIN gen_usearch_segments s ON s.segment_id = ms.segment_id WHERE ms.manifest_epoch = ? ORDER BY ms.segment_id"
        ).safeIntegers(true);
        this._listSegmentCoverage = db.prepare(
            "SELECT vector_id, coverage_state FROM gen_usearch_vector_coverage WHERE source_kind = 'SEGMENT' AND source_id = ? ORDER BY vector_id"
        ).safeIntegers(true);

        this._readSnapshot = db.transaction(() => {
            const visibilityRow = this._getSequence.get('visibility_seq');
            const manifestSeqRow = this._getSequence.get('manifest_epoch');
            const manifestStateRow = this._getManifestState.get();
            const runtime = this._getRuntime.get();
            if (!visibilityRow || !manifestSeqRow || !manifestStateRow || !runtime) {
                throw codedError('QUERY_READ_VIEW_INVALID', 'required snapshot authority row is missing');
            }
            const visibility = integerText(visibilityRow.value, 'visibility_seq');
            const manifestSeq = integerText(manifestSeqRow.value, 'manifest_epoch');
            const manifestState = integerText(
                manifestStateRow.manifest_epoch,
                'manifest_state.manifest_epoch'
            );
            if (manifestSeq.text !== manifestState.text) {
                throw codedError(
                    'MANIFEST_METADATA_CONFLICT',
                    'manifest sequence and manifest state diverged during QueryReadView acquisition'
                );
            }
            const runtimeFence = integerText(runtime.runtime_fence, 'runtime_fence');
            const metadataRows = this._listCurrent.all();
            const coverageRows = this._listCoverage.all();
            const manifestRows = this._listManifest.all(manifestSeq.parsed).map(row => ({
                ...row,
                coverageRows: this._listSegmentCoverage.all(row.segment_id)
            }));
            return {
                visibility,
                manifestSeq,
                runtime: {
                    owner_id: runtime.owner_id,
                    serving_state: runtime.serving_state,
                    runtime_fence: runtimeFence.text
                },
                metadataRows,
                coverageRows,
                manifestRows
            };
        });
    }

    _assertServingRuntime(runtime) {
        if (
            runtime.owner_id !== this.runtimeId
            || runtime.serving_state !== 'SERVING'
        ) {
            throw codedError(
                'RUNTIME_FENCE_STALE',
                'G4 requires the requested runtime to be the current SERVING owner'
            );
        }
    }

    _verifySegment(row) {
        const segmentId = String(row.segment_id || '');
        if (!segmentId || row.state !== 'PUBLISHED') {
            throw codedError('RECOVERY_MANIFEST_INVALID', 'manifest references a non-PUBLISHED segment');
        }
        const dimension = Number(row.dimension);
        const vectorCount = Number(row.vector_count);
        if (
            !Number.isSafeInteger(dimension) || dimension <= 0
            || !Number.isSafeInteger(vectorCount) || vectorCount <= 0
            || vectorCount > 0xffffffff
            || !/^[a-f0-9]{64}$/.test(String(row.artifact_digest || ''))
            || !row.artifact_path
        ) {
            throw codedError('RECOVERY_MANIFEST_INVALID', 'manifest segment metadata is invalid');
        }

        try {
            const artifactPath = exactRootPath(
                this.segmentRoot,
                segmentId,
                row.artifact_path
            );
            if (sha256File(artifactPath) !== row.artifact_digest) {
                throw codedError('RECOVERY_MANIFEST_INVALID', 'manifest segment digest mismatch');
            }
            const coverageVectorIds = row.coverageRows.map(item => {
                if (item.coverage_state !== 'QUERY_VISIBLE') {
                    throw codedError('PHYSICAL_COVERAGE_MISSING', 'segment coverage is not query-visible');
                }
                return vectorIdText(item.vector_id);
            });
            if (coverageVectorIds.length !== vectorCount) {
                throw codedError('PHYSICAL_COVERAGE_MISSING', 'segment coverage count mismatch');
            }
            const index = VexusIndex.load(
                artifactPath,
                null,
                dimension,
                Math.max(16, vectorCount + 1)
            );
            const stats = index.stats();
            if (
                Number(stats.dimensions) !== dimension
                || Number(stats.totalVectors) !== vectorCount
            ) {
                throw codedError('RECOVERY_MANIFEST_INVALID', 'native segment shape mismatch');
            }
            for (const vectorId of coverageVectorIds) {
                if (!index.containsKey64(vectorId)) {
                    throw codedError(
                        'RECOVERY_MANIFEST_INVALID',
                        'native segment is missing covered vector ' + vectorId
                    );
                }
            }
            return {
                segmentId,
                embeddingFingerprint: String(row.embedding_fingerprint || ''),
                dimension,
                vectorCount,
                vectorIds: Object.freeze([...coverageVectorIds]),
                vectorIdSet: new Set(coverageVectorIds),
                artifactPath,
                artifactDigest: row.artifact_digest,
                index
            };
        } catch (error) {
            throw error;
        }
    }

    acquire(options = {}) {
        const createdAt = safeMillis(this.now(), 'created_at');
        const deadline = options.deadline == null
            ? createdAt + this.maxReadViewMs
            : safeMillis(options.deadline, 'deadline');
        if (deadline <= createdAt || deadline - createdAt > this.maxReadViewMs) {
            throw codedError(
                'QUERY_READ_VIEW_INVALID',
                'QueryReadView deadline must be future-bounded by maxReadViewMs'
            );
        }

        const memtables = Array.isArray(options.memtables) ? options.memtables : [];
        const provisionalMemtables = [];
        const provisionalSegments = [];
        try {
            const memtableSources = [];
            const seenMemtableSourceIds = new Set();
            for (const memtable of memtables) {
                if (!(memtable instanceof GenUSearchMemTable)) {
                    throw codedError('QUERY_READ_VIEW_INVALID', 'invalid MemTable candidate source');
                }
                incMemtablePin(memtable);
                provisionalMemtables.push(memtable);
                const snapshot = GenUSearchMemTable.snapshotForImmutableSegment(memtable);
                if (!['ACTIVE', 'SEALED_QUERY_VISIBLE'].includes(snapshot.state)) {
                    throw codedError('MEMTABLE_GENERATION_MISSING', 'MemTable is not query-visible');
                }
                if (seenMemtableSourceIds.has(snapshot.sourceId)) {
                    throw codedError('QUERY_READ_VIEW_INVALID', 'duplicate MemTable source identity');
                }
                seenMemtableSourceIds.add(snapshot.sourceId);
                memtableSources.push({
                    memtable,
                    snapshot,
                    vectorIdSet: new Set(snapshot.vectorIds)
                });
            }

            const snapshot = this._readSnapshot();
            for (const row of snapshot.manifestRows) {
                const segmentId = String(row.segment_id || '');
                if (!segmentId) {
                    throw codedError(
                        'RECOVERY_MANIFEST_INVALID',
                        'captured manifest member is missing segment identity'
                    );
                }
                incSegmentPin(segmentId);
                provisionalSegments.push(segmentId);
            }
            this._assertServingRuntime(snapshot.runtime);

            if (safeMillis(this.now(), 'now') >= deadline) {
                throw codedError(
                    'QUERY_READ_VIEW_EXPIRED',
                    'QueryReadView acquisition exceeded its deadline'
                );
            }

            const metadata = [];
            const currentByVector = new Map();
            const recoveryByVector = new Map();
            for (const row of snapshot.metadataRows) {
                if (
                    row.version_state !== 'ACTIVE'
                    || row.vector_id == null
                    || row.visibility_seq == null
                    || !row.embedding_fingerprint
                ) {
                    throw codedError(
                        'QUERY_READ_VIEW_INVALID',
                        'current-head metadata row is incomplete'
                    );
                }
                const vectorId = vectorIdText(row.vector_id);
                const visibility = integerText(row.visibility_seq, 'vector.visibility_seq');
                if (visibility.parsed > snapshot.visibility.parsed) {
                    throw codedError(
                        'QUERY_READ_VIEW_INVALID',
                        'current vector visibility exceeds QueryReadView cut'
                    );
                }
                if (currentByVector.has(vectorId)) {
                    throw codedError('CANDIDATE_DEDUP_VIOLATION', 'one vector maps to multiple current heads');
                }
                const item = Object.freeze({
                    chunk_id: String(row.chunk_id),
                    doc_id: String(row.doc_id),
                    chunk_version_id: integerText(
                        row.current_version_id,
                        'current_version_id',
                        1n
                    ).text,
                    vector_id: vectorId,
                    visibility_seq: visibility.text,
                    embedding_fingerprint: String(row.embedding_fingerprint)
                });
                metadata.push(item);
                currentByVector.set(vectorId, item);
                recoveryByVector.set(vectorId, {
                    state: row.recovery_state,
                    fingerprint: row.recovery_fingerprint,
                    blob: Buffer.isBuffer(row.vector_blob)
                        ? Buffer.from(row.vector_blob)
                        : null
                });
            }

            const segments = [];
            for (const row of snapshot.manifestRows) {
                const source = this._verifySegment(row);
                segments.push(source);
                if (safeMillis(this.now(), 'now') >= deadline) {
                    throw codedError(
                        'QUERY_READ_VIEW_EXPIRED',
                        'QueryReadView acquisition exceeded its deadline'
                    );
                }
            }

            const coverageByVector = new Map();
            for (const row of snapshot.coverageRows) {
                const vectorId = vectorIdText(row.vector_id);
                const entry = Object.freeze({
                    vector_id: vectorId,
                    source_kind: row.source_kind,
                    source_id: String(row.source_id),
                    coverage_state: row.coverage_state
                });
                if (!coverageByVector.has(vectorId)) coverageByVector.set(vectorId, []);
                coverageByVector.get(vectorId).push(entry);
            }

            for (const item of metadata) {
                const coverages = coverageByVector.get(item.vector_id) || [];
                let proven = false;
                for (const coverage of coverages) {
                    if (coverage.source_kind === 'MEMTABLE') {
                        const source = memtableSources.find(
                            candidate => candidate.snapshot.sourceId === coverage.source_id
                        );
                        if (
                            source
                            && source.snapshot.embeddingFingerprint === item.embedding_fingerprint
                            && source.vectorIdSet.has(item.vector_id)
                        ) {
                            const recovery = recoveryByVector.get(item.vector_id);
                            if (
                                recovery?.blob
                                && recovery.fingerprint === item.embedding_fingerprint
                            ) {
                                proven = true;
                                break;
                            }
                        }
                    } else if (coverage.source_kind === 'SEGMENT') {
                        const source = segments.find(
                            candidate => candidate.segmentId === coverage.source_id
                        );
                        if (
                            source
                            && source.embeddingFingerprint === item.embedding_fingerprint
                            && source.vectorIdSet.has(item.vector_id)
                        ) {
                            proven = true;
                            break;
                        }
                    }
                }
                if (!proven) {
                    throw codedError(
                        'QUERY_READ_VIEW_PHYSICAL_GAP',
                        'current vector lacks pinned physical coverage: ' + item.vector_id
                    );
                }
            }

            if (safeMillis(this.now(), 'now') >= deadline) {
                throw codedError(
                    'QUERY_READ_VIEW_EXPIRED',
                    'QueryReadView acquisition exceeded its deadline'
                );
            }

            const publicMemtables = Object.freeze(memtableSources.map(source => Object.freeze({
                source_id: source.snapshot.sourceId,
                generation: source.snapshot.generation,
                state: source.snapshot.state,
                embedding_fingerprint: source.snapshot.embeddingFingerprint,
                dimension: source.snapshot.dimension,
                vector_ids: Object.freeze([...source.snapshot.vectorIds])
            })));
            const publicSegments = Object.freeze(segments.map(source => Object.freeze({
                segment_id: source.segmentId,
                embedding_fingerprint: source.embeddingFingerprint,
                dimension: source.dimension,
                vector_count: source.vectorCount,
                artifact_digest: source.artifactDigest
            })));

            const view = new QueryReadView({
                read_view_id: crypto.randomUUID(),
                visibility_seq: snapshot.visibility.text,
                metadata_snapshot: Object.freeze(metadata),
                manifest_snapshot: Object.freeze({
                    manifest_epoch: snapshot.manifestSeq.text,
                    segments: publicSegments
                }),
                memtable_generation_set: publicMemtables,
                runtime_fence: Object.freeze({
                    owner_id: snapshot.runtime.owner_id,
                    runtime_fence: snapshot.runtime.runtime_fence
                }),
                created_at: createdAt,
                deadline
            });

            VIEW_INTERNAL.set(view, {
                coordinator: this,
                memtableSources,
                segments,
                currentByVector,
                recoveryByVector,
                coverageByVector
            });
            provisionalMemtables.length = 0;
            provisionalSegments.length = 0;
            return view;
        } catch (error) {
            for (const memtable of provisionalMemtables.reverse()) {
                decMemtablePin(memtable);
            }
            for (const segmentId of provisionalSegments.reverse()) {
                decSegmentPin(segmentId);
            }
            throw error;
        }
    }

    _internal(view) {
        const internal = VIEW_INTERNAL.get(view);
        if (!internal || internal.coordinator !== this) {
            throw codedError('QUERY_READ_VIEW_INVALID', 'QueryReadView does not belong to this coordinator');
        }
        return internal;
    }

    assertUsable(view) {
        this._internal(view);
        const lifecycle = VIEW_LIFECYCLE.get(view);
        if (!lifecycle || lifecycle.state === 'RELEASED') {
            throw codedError('QUERY_READ_VIEW_INVALID', 'QueryReadView is released');
        }
        const now = safeMillis(this.now(), 'now');
        if (now >= view.deadline || lifecycle.state === 'CANCEL_REQUESTED') {
            lifecycle.state = 'CANCEL_REQUESTED';
            throw codedError('QUERY_READ_VIEW_EXPIRED', 'QueryReadView deadline expired');
        }
        return true;
    }

    requestCancellation(view) {
        this._internal(view);
        const lifecycle = VIEW_LIFECYCLE.get(view);
        if (lifecycle.state !== 'RELEASED') lifecycle.state = 'CANCEL_REQUESTED';
        return lifecycle.state;
    }

    release(view, options = {}) {
        const internal = this._internal(view);
        const lifecycle = VIEW_LIFECYCLE.get(view);
        if (lifecycle.state === 'RELEASED') return false;
        if (options.workerQuiescent !== true) {
            throw codedError(
                'READER_PIN_VIOLATION',
                'QueryReadView pins release only after worker quiescence'
            );
        }
        for (const source of internal.memtableSources) {
            decMemtablePin(source.memtable);
        }
        for (const source of internal.segments) {
            decSegmentPin(source.segmentId);
        }
        lifecycle.state = 'RELEASED';
        return true;
    }

    assertResponseFence(view) {
        this.assertUsable(view);
        const runtime = this._getRuntime.get();
        if (!runtime) {
            throw codedError('QUERY_FENCE_STALE', 'runtime ownership row disappeared');
        }
        const fence = integerText(runtime.runtime_fence, 'runtime_fence');
        if (
            runtime.owner_id !== view.runtime_fence.owner_id
            || runtime.owner_id !== this.runtimeId
            || runtime.serving_state !== 'SERVING'
            || fence.text !== view.runtime_fence.runtime_fence
        ) {
            throw codedError(
                'QUERY_FENCE_STALE',
                'runtime ownership/fence changed before query response'
            );
        }
        return true;
    }

    collectPhysicalCandidates(view, query, embeddingFingerprint) {
        this.assertUsable(view);
        const internal = this._internal(view);
        if (!(query instanceof Float32Array) || query.length === 0) {
            throw new TypeError('G4 query must be a non-empty Float32Array');
        }
        for (const value of query) {
            if (!Number.isFinite(value)) {
                throw new TypeError('G4 query vector values must be finite');
            }
        }
        const fingerprint = String(embeddingFingerprint || '').trim();
        if (!fingerprint) {
            throw codedError('QUERY_READ_VIEW_INVALID', 'embeddingFingerprint is required');
        }

        const candidates = [];
        for (const source of internal.segments) {
            if (source.embeddingFingerprint !== fingerprint) continue;
            if (source.dimension !== query.length) {
                throw codedError(
                    'MANIFEST_INDEX_FINGERPRINT_MISMATCH',
                    'query dimension does not match pinned segment dimension'
                );
            }
            this.assertUsable(view);
            for (const hit of source.index.searchKey64(query, source.vectorCount)) {
                candidates.push({
                    vectorId: vectorIdText(hit.id),
                    score: Number(hit.score),
                    sourceKind: 'SEGMENT',
                    sourceId: source.segmentId
                });
            }
        }

        for (const source of internal.memtableSources) {
            if (source.snapshot.embeddingFingerprint !== fingerprint) continue;
            if (source.snapshot.dimension !== query.length) {
                throw codedError(
                    'MANIFEST_INDEX_FINGERPRINT_MISMATCH',
                    'query dimension does not match pinned MemTable dimension'
                );
            }
            this.assertUsable(view);
            for (const vectorId of source.snapshot.vectorIds) {
                const current = internal.currentByVector.get(vectorId);
                if (!current || current.embedding_fingerprint !== fingerprint) continue;
                const coverages = internal.coverageByVector.get(vectorId) || [];
                const memtableVisible = coverages.some(coverage => (
                    coverage.source_kind === 'MEMTABLE'
                    && coverage.source_id === source.snapshot.sourceId
                    && coverage.coverage_state === 'QUERY_VISIBLE'
                ));
                if (!memtableVisible) continue;
                const recovery = internal.recoveryByVector.get(vectorId);
                if (
                    !recovery?.blob
                    || recovery.fingerprint !== fingerprint
                ) {
                    continue;
                }
                const vector = recoveryBlobToVector(recovery.blob, source.snapshot.dimension);
                candidates.push({
                    vectorId,
                    score: l2Score(query, vector),
                    sourceKind: 'MEMTABLE',
                    sourceId: source.snapshot.sourceId
                });
            }
        }
        return candidates;
    }

    static memtablePinCount(memtable) {
        return ReadPins.memtablePinCount(memtable);
    }

    static segmentPinCount(segmentId) {
        return ReadPins.segmentPinCount(segmentId);
    }
}

module.exports = {
    GenUSearchQueryReadViewCoordinator,
    QueryReadView
};
