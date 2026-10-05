'use strict';

const {
    assertIdentityOnlyPlan,
    hashIdentitySnapshot,
    stableStringify
} = require('./genUSearchReconciler');

const MAX_SIGNED_INT64 = 9223372036854775807n;
const SEQUENCE_NAMES = new Set(['visibility_seq', 'manifest_epoch']);

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function parseInteger(value, label, options = {}) {
    const min = options.min ?? 0n;
    const max = options.max ?? MAX_SIGNED_INT64;
    let parsed;

    if (typeof value === 'bigint') {
        parsed = value;
    } else if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) {
            throw codedError(
                'GEN_USEARCH_INTEGER_UNSAFE',
                `${label} must not be supplied as an unsafe JavaScript number`
            );
        }
        parsed = BigInt(value);
    } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
        parsed = BigInt(value);
    } else {
        throw codedError(
            'GEN_USEARCH_INTEGER_INVALID',
            `${label} must be a canonical non-negative integer`
        );
    }

    if (parsed < min || parsed > max) {
        throw codedError(
            'GEN_USEARCH_INTEGER_OUT_OF_RANGE',
            `${label} is outside the admitted signed-int64 range`
        );
    }
    return parsed;
}

function requireSha256(value, label = 'contentHash') {
    const normalized = requireString(value, label).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
        throw new TypeError(`${label} must be a 64-character SHA-256 hex digest`);
    }
    return normalized;
}

function exactBuffer(value, label = 'vectorBlob') {
    if (Buffer.isBuffer(value)) {
        if (value.length === 0) throw new TypeError(`${label} must not be empty`);
        return Buffer.from(value);
    }
    if (ArrayBuffer.isView(value)) {
        if (value.byteLength === 0) throw new TypeError(`${label} must not be empty`);
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError(`${label} must be a Buffer or ArrayBuffer view`);
}

function decimalOrNull(value, label) {
    if (value == null) return null;
    return parseInteger(value, label).toString();
}

function requireString(value, label, options = {}) {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string`);
    }
    const normalized = options.trim === false ? value : value.trim();
    if (!normalized) {
        throw new TypeError(`${label} must not be empty`);
    }
    return normalized;
}

class GenUSearchMetadataStore {
    constructor(options = {}) {
        const db = options.db;
        if (!db?.prepare || !db?.transaction || !db?.pragma) {
            throw new TypeError(
                'GenUSearchMetadataStore requires a better-sqlite3 compatible database'
            );
        }
        this.db = db;
        this.now = typeof options.now === 'function'
            ? options.now
            : () => Date.now();
        this.requireCrashDurability = options.requireCrashDurability !== false;

        this._getAllocator = db.prepare(`
            SELECT high_water
            FROM gen_usearch_vector_allocator
            WHERE singleton = 1
        `);
        this._updateAllocator = db.prepare(`
            UPDATE gen_usearch_vector_allocator
            SET high_water = ?, updated_at = ?
            WHERE singleton = 1
        `);
        this._getSequence = db.prepare(`
            SELECT value
            FROM gen_usearch_sequences
            WHERE name = ?
        `);
        this._updateSequence = db.prepare(`
            UPDATE gen_usearch_sequences
            SET value = ?, updated_at = ?
            WHERE name = ?
        `);
        this._updateManifestState = db.prepare(`
            UPDATE gen_usearch_manifest_state
            SET manifest_epoch = ?, updated_at = ?
            WHERE singleton = 1
        `);
        this._getManifestState = db.prepare(`
            SELECT manifest_epoch
            FROM gen_usearch_manifest_state
            WHERE singleton = 1
        `);
        this._getDocument = db.prepare(`
            SELECT *
            FROM gen_usearch_documents
            WHERE doc_id = ?
        `);
        this._insertDocument = db.prepare(`
            INSERT INTO gen_usearch_documents (
                doc_id,
                state,
                index_state,
                current_uri,
                observed_source_digest,
                observed_source_revision,
                reconcile_target_revision,
                reconciliation_state,
                created_at,
                updated_at
            ) VALUES (?, 'ACTIVE', 'INDEX_LAGGING', ?, NULL, NULL, NULL, 'COMPLETE', ?, ?)
        `);
        this._updateDocumentUri = db.prepare(`
            UPDATE gen_usearch_documents
            SET current_uri = ?,
                updated_at = ?
            WHERE doc_id = ?
              AND state = 'ACTIVE'
        `);
        this._insertUriHistory = db.prepare(`
            INSERT INTO gen_usearch_document_uri_history (
                doc_id,
                uri,
                valid_from_visibility_seq,
                valid_to_visibility_seq
            ) VALUES (?, ?, ?, NULL)
        `);
        this._closeUriHistory = db.prepare(`
            UPDATE gen_usearch_document_uri_history
            SET valid_to_visibility_seq = ?
            WHERE doc_id = ?
              AND valid_to_visibility_seq IS NULL
        `);
        this._recordObservation = db.prepare(`
            UPDATE gen_usearch_documents
            SET observed_source_digest = ?,
                observed_source_revision = ?,
                reconcile_target_revision = ?,
                reconciliation_state = 'PENDING',
                index_state = 'INDEX_LAGGING',
                updated_at = ?
            WHERE doc_id = ?
              AND state = 'ACTIVE'
        `);

        this._recordPlanObservation = db.prepare(`
            UPDATE gen_usearch_documents
            SET observed_source_digest = ?,
                observed_source_revision = ?,
                reconcile_target_revision = ?,
                reconciliation_state = ?,
                index_state = ?,
                updated_at = ?
            WHERE doc_id = ?
              AND state = 'ACTIVE'
        `);
        this._getReconciliationPlan = db.prepare(`
            SELECT *
            FROM gen_usearch_reconciliation_plans
            WHERE plan_id = ?
        `);
        this._getReconciliationPlanByDocumentRevision = db.prepare(`
            SELECT *
            FROM gen_usearch_reconciliation_plans
            WHERE doc_id = ? AND target_revision = ?
        `);
        this._getOpenReconciliationPlanByDocument = db.prepare(`
            SELECT *
            FROM gen_usearch_reconciliation_plans
            WHERE doc_id = ?
              AND state IN ('PENDING', 'ADMITTED', 'ERROR')
            ORDER BY created_at, plan_id
            LIMIT 1
        `);
        this._supersedeErrorReconciliationPlan = db.prepare(`
            UPDATE gen_usearch_reconciliation_plans
            SET state = 'SUPERSEDED', updated_at = ?
            WHERE plan_id = ?
              AND state = 'ERROR'
        `);
        this._insertReconciliationPlan = db.prepare(`
            INSERT INTO gen_usearch_reconciliation_plans (
                plan_id,
                doc_id,
                base_document_uri,
                base_identity_digest,
                observed_source_digest,
                observed_source_revision,
                target_revision,
                plan_digest,
                state,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        this._insertReconciliationItem = db.prepare(`
            INSERT INTO gen_usearch_reconciliation_items (
                plan_id, ordinal, kind, payload_json
            ) VALUES (?, ?, ?, ?)
        `);
        this._getReconciliationItems = db.prepare(`
            SELECT ordinal, kind, payload_json
            FROM gen_usearch_reconciliation_items
            WHERE plan_id = ?
            ORDER BY ordinal
        `);

        this._getChunkHead = db.prepare(`
            SELECT *
            FROM gen_usearch_chunk_heads
            WHERE chunk_id = ?
        `);
        this._listCurrentChunkIdentitySnapshot = db.prepare(`
            SELECT
                h.chunk_id,
                h.current_version_id,
                v.chunk_version_id,
                v.slot_index,
                v.content_hash,
                v.state
            FROM gen_usearch_chunk_heads h
            LEFT JOIN gen_usearch_chunk_versions v
              ON v.chunk_version_id = h.current_version_id
            WHERE h.doc_id = ?
            ORDER BY v.slot_index, h.chunk_id
        `);
        this._insertChunkHead = db.prepare(`
            INSERT INTO gen_usearch_chunk_heads (
                chunk_id, doc_id, current_version_id, created_at, updated_at
            ) VALUES (?, ?, NULL, ?, ?)
        `);
        this._getChunkVersion = db.prepare(`
            SELECT *
            FROM gen_usearch_chunk_versions
            WHERE chunk_version_id = ?
        `);
        this._insertChunkVersion = db.prepare(`
            INSERT INTO gen_usearch_chunk_versions (
                chunk_id,
                source_revision,
                slot_index,
                content_hash,
                state,
                vector_id,
                visibility_seq,
                retired_visibility_seq,
                embedding_fingerprint,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, 'PREPARED', NULL, NULL, NULL, NULL, ?, ?)
        `);
        this._markEmbedding = db.prepare(`
            UPDATE gen_usearch_chunk_versions
            SET state = 'EMBEDDING',
                embedding_fingerprint = ?,
                updated_at = ?
            WHERE chunk_version_id = ?
              AND state = 'PREPARED'
        `);
        this._stageChunkVersion = db.prepare(`
            UPDATE gen_usearch_chunk_versions
            SET state = 'VECTOR_STAGED',
                vector_id = ?,
                embedding_fingerprint = ?,
                updated_at = ?
            WHERE chunk_version_id = ?
              AND state = 'EMBEDDING'
        `);
        this._insertRecovery = db.prepare(`
            INSERT INTO gen_usearch_vector_recovery (
                vector_id,
                chunk_version_id,
                state,
                embedding_fingerprint,
                vector_blob,
                covered_segment_id,
                created_at,
                updated_at
            ) VALUES (?, ?, 'RECOVERY_REQUIRED', ?, ?, NULL, ?, ?)
        `);
        this._getRecovery = db.prepare(`
            SELECT *
            FROM gen_usearch_vector_recovery
            WHERE vector_id = ?
        `);
        this._countQueryCoverage = db.prepare(`
            SELECT COUNT(*) AS count
            FROM gen_usearch_vector_coverage
            WHERE vector_id = ?
              AND coverage_state = 'QUERY_VISIBLE'
        `);
        this._retireActiveVersion = db.prepare(`
            UPDATE gen_usearch_chunk_versions
            SET state = 'RETIRED',
                retired_visibility_seq = ?,
                updated_at = ?
            WHERE chunk_version_id = ?
              AND state = 'ACTIVE'
        `);
        this._activateStagedVersion = db.prepare(`
            UPDATE gen_usearch_chunk_versions
            SET state = 'ACTIVE',
                visibility_seq = ?,
                updated_at = ?
            WHERE chunk_version_id = ?
              AND state = 'VECTOR_STAGED'
        `);
        this._casCurrentHead = db.prepare(`
            UPDATE gen_usearch_chunk_heads
            SET current_version_id = ?,
                updated_at = ?
            WHERE chunk_id = ?
              AND current_version_id IS ?
        `);
        this._abortChunkVersion = db.prepare(`
            UPDATE gen_usearch_chunk_versions
            SET state = 'ABORTED',
                updated_at = ?
            WHERE chunk_version_id = ?
              AND state IN ('PREPARED', 'EMBEDDING', 'VECTOR_STAGED')
        `);
        this._reclaimAbortedRecovery = db.prepare(`
            UPDATE gen_usearch_vector_recovery
            SET state = 'RECOVERY_RECLAIMABLE',
                updated_at = ?
            WHERE vector_id = ?
              AND state = 'RECOVERY_REQUIRED'
        `);

        for (const statement of [
            this._getAllocator,
            this._getSequence,
            this._getManifestState,
            this._getChunkHead,
            this._listCurrentChunkIdentitySnapshot,
            this._getChunkVersion,
            this._getRecovery,
            this._countQueryCoverage,
            this._insertChunkVersion
        ]) {
            if (typeof statement.safeIntegers !== 'function') {
                throw codedError(
                    'GEN_USEARCH_SAFE_INTEGER_MODE_UNAVAILABLE',
                    'better-sqlite3 safeIntegers() support is required'
                );
            }
            statement.safeIntegers(true);
        }

        this._allocateTransaction = db.transaction((count, now) => {
            const row = this._getAllocator.get();
            if (!row) {
                throw codedError(
                    'VECTOR_ID_ALLOCATOR_CORRUPT',
                    'Gen-USearch vector allocator row is missing'
                );
            }
            const highWater = parseInteger(
                row.high_water,
                'vector allocator high_water'
            );
            const end = highWater + BigInt(count);
            if (end > MAX_SIGNED_INT64) {
                throw codedError(
                    'VECTOR_ID_EXHAUSTED',
                    'Gen-USearch vector ID allocator exhausted signed-int64 space'
                );
            }
            this._updateAllocator.run(end, now);

            const ids = [];
            for (let value = highWater + 1n; value <= end; value++) {
                ids.push(value.toString());
            }
            return Object.freeze(ids);
        });

        this._nextSequenceTransaction = db.transaction((name, now) => {
            const row = this._getSequence.get(name);
            if (!row) {
                throw codedError(
                    'GEN_USEARCH_SEQUENCE_CORRUPT',
                    `Gen-USearch sequence "${name}" is missing`
                );
            }
            const previous = parseInteger(row.value, name);
            if (previous >= MAX_SIGNED_INT64) {
                throw codedError(
                    'GEN_USEARCH_SEQUENCE_EXHAUSTED',
                    `Gen-USearch sequence "${name}" exhausted signed-int64 space`
                );
            }
            const next = previous + 1n;
            this._updateSequence.run(next, now, name);
            if (name === 'manifest_epoch') {
                this._updateManifestState.run(next, now);
            }
            return next.toString();
        });

        this._createDocumentTransaction = db.transaction(
            (docId, uri, visibilitySeq, now) => {
                this._insertDocument.run(docId, uri, now, now);
                if (uri) {
                    this._insertUriHistory.run(
                        docId,
                        uri,
                        visibilitySeq
                    );
                }
                return this._getDocument.get(docId);
            }
        );

        this._moveDocumentTransaction = db.transaction(
            (docId, nextUri, now) => {
                const existing = this._getDocument.get(docId);
                if (!existing || existing.state !== 'ACTIVE') {
                    throw codedError(
                        'DOCUMENT_IDENTITY_AMBIGUOUS',
                        `Active Gen-USearch document "${docId}" is unavailable`
                    );
                }
                if (existing.current_uri === nextUri) return existing;

                const sequenceRow = this._getSequence.get('visibility_seq');
                if (!sequenceRow) {
                    throw codedError(
                        'GEN_USEARCH_SEQUENCE_CORRUPT',
                        'visibility_seq is missing'
                    );
                }
                const previousSeq = parseInteger(
                    sequenceRow.value,
                    'visibility_seq'
                );
                if (previousSeq >= MAX_SIGNED_INT64) {
                    throw codedError(
                        'GEN_USEARCH_SEQUENCE_EXHAUSTED',
                        'visibility_seq exhausted signed-int64 space'
                    );
                }
                const visibilitySeq = previousSeq + 1n;
                this._updateSequence.run(
                    visibilitySeq,
                    now,
                    'visibility_seq'
                );

                const closedHistory = this._closeUriHistory.run(
                    visibilitySeq,
                    docId
                ).changes;
                const expectedOpenHistory = existing.current_uri == null ? 0 : 1;
                if (closedHistory !== expectedOpenHistory) {
                    throw codedError(
                        'METADATA_INTEGRITY_FAILURE',
                        `Document "${docId}" has ${closedHistory} open URI history rows; expected ${expectedOpenHistory}`
                    );
                }

                const changed = this._updateDocumentUri.run(
                    nextUri,
                    now,
                    docId
                ).changes;
                if (changed !== 1) {
                    throw codedError(
                        'DOCUMENT_IDENTITY_AMBIGUOUS',
                        `Failed to move active document "${docId}"`
                    );
                }
                this._insertUriHistory.run(
                    docId,
                    nextUri,
                    visibilitySeq
                );
                return this._getDocument.get(docId);
            }
        );

        this._observationTransaction = db.transaction(
            (docId, digest, revision, now) => {
                const changed = this._recordObservation.run(
                    digest,
                    revision,
                    revision,
                    now,
                    docId
                ).changes;
                if (changed !== 1) {
                    throw codedError(
                        'DOCUMENT_IDENTITY_AMBIGUOUS',
                        `Active Gen-USearch document "${docId}" is unavailable`
                    );
                }
                const row = this._getDocument.get(docId);
                if (
                    row.observed_source_revision !== revision
                    || row.reconcile_target_revision !== revision
                    || row.reconciliation_state !== 'PENDING'
                ) {
                    throw codedError(
                        'SOURCE_OBSERVATION_INVALID',
                        'Source observation and reconciliation intent diverged'
                    );
                }
                return row;
            }
        );

        this._admitReconciliationPlanTransaction = db.transaction(
            (plan, now) => {
                const existing = this._getReconciliationPlanByDocumentRevision.get(
                    plan.docId,
                    plan.targetRevision
                );
                if (existing) {
                    if (
                        existing.plan_id !== plan.planId
                        || existing.plan_digest !== plan.planDigest
                    ) {
                        throw codedError(
                            'SOURCE_OBSERVATION_INVALID',
                            `Conflicting reconciliation plan for ${plan.docId}@${plan.targetRevision}`
                        );
                    }
                    return existing;
                }
                const documentBefore = this._getDocument.get(plan.docId);
                if (!documentBefore || documentBefore.state !== 'ACTIVE') {
                    throw codedError(
                        'DOCUMENT_IDENTITY_AMBIGUOUS',
                        `Active Gen-USearch document "${plan.docId}" is unavailable`
                    );
                }
                if ((documentBefore.current_uri ?? null) !== plan.baseDocumentUri) {
                    throw codedError(
                        'STALE_DOCUMENT_WRITER',
                        'Document URI changed after reconciliation plan generation'
                    );
                }
                if (
                    documentBefore.reconciliation_state === 'PENDING'
                    && documentBefore.reconcile_target_revision != null
                    && (
                        documentBefore.reconcile_target_revision !== plan.targetRevision
                        || documentBefore.observed_source_digest !== plan.observedSourceDigest
                    )
                ) {
                    throw codedError(
                        'STALE_DOCUMENT_WRITER',
                        'A newer pending source observation already owns reconciliation'
                    );
                }
                const hasAmbiguity = plan.summary.AMBIGUOUS > 0;
                const planState = hasAmbiguity ? 'ERROR' : 'ADMITTED';
                const documentState = hasAmbiguity ? 'ERROR' : 'ADMITTED';
                const indexState = hasAmbiguity ? 'INDEX_ERROR' : 'INDEX_LAGGING';

                const oldChunkIds = new Set();
                const freshChunkIds = new Set();
                for (const operation of plan.operations) {
                    if (['SAME', 'MOVE', 'MODIFY', 'DELETE'].includes(operation.kind)) {
                        oldChunkIds.add(operation.chunkId);
                    } else if (operation.kind === 'SPLIT' || operation.kind === 'MERGE') {
                        operation.oldChunkIds.forEach(id => oldChunkIds.add(id));
                        operation.newChunks.forEach(row => freshChunkIds.add(row.chunkId));
                    } else if (operation.kind === 'INSERT') {
                        freshChunkIds.add(operation.chunkId);
                    } else if (operation.kind === 'AMBIGUOUS') {
                        operation.oldChunkIds.forEach(id => oldChunkIds.add(id));
                    }
                }
                for (const chunkId of oldChunkIds) {
                    const head = this._getChunkHead.get(chunkId);
                    if (!head || head.doc_id !== plan.docId) {
                        throw codedError(
                            'CHUNK_IDENTITY_AMBIGUOUS',
                            `Chunk identity "${chunkId}" is not owned by document "${plan.docId}"`
                        );
                    }
                }
                for (const chunkId of freshChunkIds) {
                    if (this._getChunkHead.get(chunkId)) {
                        throw codedError(
                            'CHUNK_IDENTITY_AMBIGUOUS',
                            `Planned new chunk identity already exists: ${chunkId}`
                        );
                    }
                }

                const currentIdentityDigest = hashIdentitySnapshot(
                    this.getCurrentChunkIdentitySnapshot(plan.docId)
                );
                if (currentIdentityDigest !== plan.baseIdentityDigest) {
                    throw codedError(
                        'STALE_DOCUMENT_WRITER',
                        'Current chunk identity snapshot changed after plan generation'
                    );
                }

                const openPlan = this._getOpenReconciliationPlanByDocument.get(plan.docId);
                if (openPlan) {
                    if (
                        openPlan.state === 'ERROR'
                        && openPlan.target_revision !== plan.targetRevision
                    ) {
                        const superseded = this._supersedeErrorReconciliationPlan.run(
                            now,
                            openPlan.plan_id
                        ).changes;
                        if (superseded !== 1) {
                            throw codedError(
                                'SOURCE_OBSERVATION_INVALID',
                                `Failed to supersede errored reconciliation plan ${openPlan.plan_id}`
                            );
                        }
                    } else {
                        throw codedError(
                            'SOURCE_OBSERVATION_INVALID',
                            `Document "${plan.docId}" already has unresolved reconciliation plan ${openPlan.plan_id}`
                        );
                    }
                }

                const changed = this._recordPlanObservation.run(
                    plan.observedSourceDigest,
                    plan.observedSourceRevision,
                    plan.targetRevision,
                    documentState,
                    indexState,
                    now,
                    plan.docId
                ).changes;
                if (changed !== 1) {
                    throw codedError(
                        'DOCUMENT_IDENTITY_AMBIGUOUS',
                        `Active Gen-USearch document "${plan.docId}" is unavailable`
                    );
                }

                this._insertReconciliationPlan.run(
                    plan.planId,
                    plan.docId,
                    plan.baseDocumentUri,
                    plan.baseIdentityDigest,
                    plan.observedSourceDigest,
                    plan.observedSourceRevision,
                    plan.targetRevision,
                    plan.planDigest,
                    planState,
                    now,
                    now
                );
                plan.operations.forEach((operation, ordinal) => {
                    this._insertReconciliationItem.run(
                        plan.planId,
                        ordinal,
                        operation.kind,
                        stableStringify(operation)
                    );
                });

                const document = this._getDocument.get(plan.docId);
                if (
                    !document
                    || document.observed_source_digest !== plan.observedSourceDigest
                    || document.observed_source_revision !== plan.observedSourceRevision
                    || document.reconcile_target_revision !== plan.targetRevision
                    || document.reconciliation_state !== documentState
                    || document.index_state !== indexState
                ) {
                    throw codedError(
                        'SOURCE_OBSERVATION_INVALID',
                        'Source observation and durable reconciliation plan diverged'
                    );
                }
                return this._getReconciliationPlan.get(plan.planId);
            }
        );

        this._createChunkTransaction = db.transaction(
            (chunkId, docId, now) => {
                const document = this._getDocument.get(docId);
                if (!document || document.state !== 'ACTIVE') {
                    throw codedError(
                        'DOCUMENT_IDENTITY_AMBIGUOUS',
                        `Active document "${docId}" is unavailable for chunk identity`
                    );
                }
                this._insertChunkHead.run(chunkId, docId, now, now);
                return this._getChunkHead.get(chunkId);
            }
        );

        this._prepareChunkVersionTransaction = db.transaction(
            (chunkId, sourceRevision, slotIndex, contentHash, now) => {
                const head = this._getChunkHead.get(chunkId);
                if (!head) {
                    throw codedError(
                        'CHUNK_IDENTITY_AMBIGUOUS',
                        `Chunk identity "${chunkId}" is unavailable`
                    );
                }
                const inserted = this._insertChunkVersion.run(
                    chunkId,
                    sourceRevision,
                    slotIndex,
                    contentHash,
                    now,
                    now
                );
                return this._getChunkVersion.get(inserted.lastInsertRowid);
            }
        );

        this._markEmbeddingTransaction = db.transaction(
            (chunkVersionId, embeddingFingerprint, now) => {
                const changed = this._markEmbedding.run(
                    embeddingFingerprint,
                    now,
                    chunkVersionId
                ).changes;
                if (changed !== 1) {
                    throw codedError(
                        'INVALID_MVCC_TRANSITION',
                        'Chunk version must be PREPARED before EMBEDDING'
                    );
                }
                return this._getChunkVersion.get(chunkVersionId);
            }
        );

        this._stageVectorTransaction = db.transaction(
            (chunkVersionId, embeddingFingerprint, vectorBlob, now) => {
                const version = this._getChunkVersion.get(chunkVersionId);
                if (!version || version.state !== 'EMBEDDING') {
                    throw codedError(
                        'INVALID_MVCC_TRANSITION',
                        'Chunk version must be EMBEDDING before VECTOR_STAGED'
                    );
                }
                if (
                    version.embedding_fingerprint
                    && version.embedding_fingerprint !== embeddingFingerprint
                ) {
                    throw codedError(
                        'STALE_EMBEDDING_RESULT',
                        'Embedding fingerprint changed while vectorization was in flight'
                    );
                }

                const allocator = this._getAllocator.get();
                if (!allocator) {
                    throw codedError(
                        'VECTOR_ID_ALLOCATOR_CORRUPT',
                        'Gen-USearch vector allocator row is missing'
                    );
                }
                const highWater = parseInteger(
                    allocator.high_water,
                    'vector allocator high_water'
                );
                if (highWater >= MAX_SIGNED_INT64) {
                    throw codedError(
                        'VECTOR_ID_EXHAUSTED',
                        'Gen-USearch vector ID allocator exhausted signed-int64 space'
                    );
                }
                const vectorId = highWater + 1n;
                this._updateAllocator.run(vectorId, now);

                const changed = this._stageChunkVersion.run(
                    vectorId,
                    embeddingFingerprint,
                    now,
                    chunkVersionId
                ).changes;
                if (changed !== 1) {
                    throw codedError(
                        'INVALID_MVCC_TRANSITION',
                        'Failed to transition EMBEDDING version to VECTOR_STAGED'
                    );
                }
                this._insertRecovery.run(
                    vectorId,
                    chunkVersionId,
                    embeddingFingerprint,
                    vectorBlob,
                    now,
                    now
                );
                return this._getChunkVersion.get(chunkVersionId);
            }
        );

        this._publishCurrentHeadTransaction = db.transaction(
            (chunkId, chunkVersionId, expectedCurrentVersionId, now) => {
                const head = this._getChunkHead.get(chunkId);
                if (!head) {
                    throw codedError(
                        'CHUNK_IDENTITY_AMBIGUOUS',
                        `Chunk identity "${chunkId}" is unavailable`
                    );
                }

                const currentVersionId = head.current_version_id ?? null;
                if (
                    (currentVersionId === null) !== (expectedCurrentVersionId === null)
                    || (
                        currentVersionId !== null
                        && parseInteger(currentVersionId, 'current_version_id')
                            !== parseInteger(expectedCurrentVersionId, 'expectedCurrentVersionId')
                    )
                ) {
                    throw codedError(
                        'STALE_VECTOR_PUBLICATION',
                        'Current-head CAS expectation does not match SQLite authority'
                    );
                }

                const nextVersion = this._getChunkVersion.get(chunkVersionId);
                if (
                    !nextVersion
                    || nextVersion.chunk_id !== chunkId
                    || nextVersion.state !== 'VECTOR_STAGED'
                    || nextVersion.vector_id == null
                ) {
                    throw codedError(
                        'INVALID_CURRENT_VECTOR_HEAD',
                        'Only a VECTOR_STAGED version for the same chunk can become current'
                    );
                }

                const document = this._getDocument.get(head.doc_id);
                if (!document || document.state !== 'ACTIVE') {
                    throw codedError(
                        'DOCUMENT_IDENTITY_AMBIGUOUS',
                        `Active document "${head.doc_id}" is unavailable for current-head publication`
                    );
                }
                if (document.reconcile_target_revision != null) {
                    if (
                        nextVersion.source_revision !== document.reconcile_target_revision
                        || !['ADMITTED', 'COMPLETE'].includes(document.reconciliation_state)
                    ) {
                        throw codedError(
                            'STALE_VECTOR_PUBLICATION',
                            'Staged vector does not match the publishable reconciliation authority'
                        );
                    }
                }

                const recovery = this._getRecovery.get(nextVersion.vector_id);
                if (
                    !recovery
                    || recovery.state === 'RECOVERY_RELEASED'
                    || !recovery.vector_blob
                ) {
                    throw codedError(
                        'VECTOR_RECOVERY_MATERIAL_MISSING',
                        'Staged vector lacks exact durable recovery material'
                    );
                }

                const coverage = this._countQueryCoverage.get(
                    nextVersion.vector_id
                );
                if (Number(coverage?.count || 0n) < 1) {
                    throw codedError(
                        'PHYSICAL_COVERAGE_MISSING',
                        'Staged vector has no QUERY_VISIBLE physical source'
                    );
                }

                const sequenceRow = this._getSequence.get('visibility_seq');
                if (!sequenceRow) {
                    throw codedError(
                        'GEN_USEARCH_SEQUENCE_CORRUPT',
                        'visibility_seq is missing'
                    );
                }
                const previousSeq = parseInteger(
                    sequenceRow.value,
                    'visibility_seq'
                );
                if (previousSeq >= MAX_SIGNED_INT64) {
                    throw codedError(
                        'GEN_USEARCH_SEQUENCE_EXHAUSTED',
                        'visibility_seq exhausted signed-int64 space'
                    );
                }
                const visibilitySeq = previousSeq + 1n;
                this._updateSequence.run(
                    visibilitySeq,
                    now,
                    'visibility_seq'
                );

                if (currentVersionId !== null) {
                    const currentVersion = this._getChunkVersion.get(
                        currentVersionId
                    );
                    if (
                        !currentVersion
                        || currentVersion.chunk_id !== chunkId
                        || currentVersion.state !== 'ACTIVE'
                    ) {
                        throw codedError(
                            'INVALID_CURRENT_VECTOR_HEAD',
                            'SQLite current head does not reference an ACTIVE version'
                        );
                    }
                    const retired = this._retireActiveVersion.run(
                        visibilitySeq,
                        now,
                        currentVersionId
                    ).changes;
                    if (retired !== 1) {
                        throw codedError(
                            'STALE_VECTOR_PUBLICATION',
                            'Failed to retire the expected current version'
                        );
                    }
                }

                const activated = this._activateStagedVersion.run(
                    visibilitySeq,
                    now,
                    chunkVersionId
                ).changes;
                if (activated !== 1) {
                    throw codedError(
                        'STALE_VECTOR_PUBLICATION',
                        'Failed to activate the staged version'
                    );
                }

                const updated = this._casCurrentHead.run(
                    chunkVersionId,
                    now,
                    chunkId,
                    currentVersionId
                ).changes;
                if (updated !== 1) {
                    throw codedError(
                        'STALE_VECTOR_PUBLICATION',
                        'Current-head CAS failed'
                    );
                }

                return Object.freeze({
                    chunkId,
                    currentVersionId: parseInteger(
                        chunkVersionId,
                        'chunkVersionId'
                    ).toString(),
                    previousVersionId: currentVersionId == null
                        ? null
                        : parseInteger(
                            currentVersionId,
                            'previousVersionId'
                        ).toString(),
                    vectorId: parseInteger(
                        nextVersion.vector_id,
                        'vectorId'
                    ).toString(),
                    visibilitySeq: visibilitySeq.toString()
                });
            }
        );

        this._abortChunkVersionTransaction = db.transaction(
            (chunkVersionId, now) => {
                const version = this._getChunkVersion.get(chunkVersionId);
                if (!version) {
                    throw codedError(
                        'INVALID_MVCC_TRANSITION',
                        'Chunk version is unavailable'
                    );
                }
                const changed = this._abortChunkVersion.run(
                    now,
                    chunkVersionId
                ).changes;
                if (changed !== 1) {
                    throw codedError(
                        'INVALID_MVCC_TRANSITION',
                        `Cannot abort chunk version from state ${version.state}`
                    );
                }
                if (version.vector_id != null) {
                    this._reclaimAbortedRecovery.run(
                        now,
                        version.vector_id
                    );
                }
                return this._getChunkVersion.get(chunkVersionId);
            }
        );
    }

    _durabilityProfile() {
        const journalMode = String(
            this.db.pragma('journal_mode', { simple: true }) || ''
        ).toLowerCase();
        const synchronous = Number(
            this.db.pragma('synchronous', { simple: true })
        );
        return Object.freeze({
            journalMode,
            synchronous
        });
    }

    assertCrashDurableProfile() {
        if (!this.requireCrashDurability) return this._durabilityProfile();

        const profile = this._durabilityProfile();
        if (
            profile.journalMode !== 'wal'
            || !Number.isFinite(profile.synchronous)
            || profile.synchronous < 2
        ) {
            throw codedError(
                'UNSUPPORTED_DURABILITY_PROFILE',
                'Gen-USearch critical writes require SQLite WAL + synchronous=FULL or EXTRA'
            );
        }
        return profile;
    }

    _criticalWrite(operation) {
        this.assertCrashDurableProfile();
        const result = operation();

        // A critical write is acknowledged only after the synchronous transaction
        // call has returned from SQLite. With WAL + FULL/EXTRA this is the durable
        // commit boundary admitted by the frozen G0 contract.
        return result;
    }

    readAllocatorHighWater() {
        const row = this._getAllocator.get();
        if (!row) {
            throw codedError(
                'VECTOR_ID_ALLOCATOR_CORRUPT',
                'Gen-USearch vector allocator row is missing'
            );
        }
        return parseInteger(row.high_water, 'vector allocator high_water')
            .toString();
    }

    allocateVectorIds(count = 1) {
        if (!Number.isSafeInteger(count) || count < 1 || count > 100000) {
            throw new RangeError(
                'count must be a safe integer between 1 and 100000'
            );
        }
        const now = parseInteger(this.now(), 'now', {
            max: MAX_SIGNED_INT64
        });
        return this._criticalWrite(
            () => this._allocateTransaction(count, now)
        );
    }

    readSequence(name) {
        if (!SEQUENCE_NAMES.has(name)) {
            throw new RangeError(`Unknown Gen-USearch sequence: ${name}`);
        }
        const row = this._getSequence.get(name);
        if (!row) {
            throw codedError(
                'GEN_USEARCH_SEQUENCE_CORRUPT',
                `Gen-USearch sequence "${name}" is missing`
            );
        }
        return parseInteger(row.value, name).toString();
    }

    nextSequence(name) {
        if (!SEQUENCE_NAMES.has(name)) {
            throw new RangeError(`Unknown Gen-USearch sequence: ${name}`);
        }
        const now = parseInteger(this.now(), 'now');
        return this._criticalWrite(
            () => this._nextSequenceTransaction(name, now)
        );
    }

    nextVisibilitySeq() {
        return this.nextSequence('visibility_seq');
    }

    nextManifestEpoch() {
        return this.nextSequence('manifest_epoch');
    }

    readManifestEpoch() {
        const sequence = this.readSequence('manifest_epoch');
        const row = this._getManifestState.get();
        if (!row) {
            throw codedError(
                'RECOVERY_MANIFEST_INVALID',
                'Gen-USearch manifest state row is missing'
            );
        }
        const manifest = parseInteger(
            row.manifest_epoch,
            'manifest_state.manifest_epoch'
        ).toString();
        if (manifest !== sequence) {
            throw codedError(
                'MANIFEST_METADATA_CONFLICT',
                'Manifest epoch diverged from the authoritative sequence'
            );
        }
        return manifest;
    }

    getDocument(docId) {
        return this._getDocument.get(
            requireString(docId, 'docId')
        ) || null;
    }

    createDocument(options = {}) {
        const docId = requireString(options.docId, 'docId');
        const uri = options.uri == null
            ? null
            : requireString(options.uri, 'uri');
        const currentVisibilitySeq = parseInteger(
            this.readSequence('visibility_seq'),
            'visibilitySeq'
        );
        if (options.visibilitySeq != null) {
            const suppliedVisibilitySeq = parseInteger(
                options.visibilitySeq,
                'visibilitySeq'
            );
            if (suppliedVisibilitySeq !== currentVisibilitySeq) {
                throw codedError(
                    'VISIBILITY_SEQUENCE_INVALID',
                    'Document creation cannot override the current visibility_seq'
                );
            }
        }
        const visibilitySeq = currentVisibilitySeq;
        const now = parseInteger(this.now(), 'now');

        return this._criticalWrite(() => {
            try {
                return this._createDocumentTransaction(
                    docId,
                    uri,
                    visibilitySeq,
                    now
                );
            } catch (error) {
                if (
                    error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
                    || error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
                ) {
                    throw codedError(
                        'DOCUMENT_ACTIVE_URI_CONFLICT',
                        `Document identity or active URI already exists: ${uri || docId}`
                    );
                }
                throw error;
            }
        });
    }

    moveDocument(options = {}) {
        const docId = requireString(options.docId, 'docId');
        const uri = requireString(options.uri, 'uri');
        if (Object.prototype.hasOwnProperty.call(options, 'visibilitySeq')) {
            throw codedError(
                'VISIBILITY_SEQUENCE_INVALID',
                'moveDocument owns visibility_seq allocation internally'
            );
        }
        const now = parseInteger(this.now(), 'now');

        return this._criticalWrite(() => {
            try {
                return this._moveDocumentTransaction(
                    docId,
                    uri,
                    now
                );
            } catch (error) {
                if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                    throw codedError(
                        'DOCUMENT_ACTIVE_URI_CONFLICT',
                        `Active URI already belongs to another document: ${uri}`
                    );
                }
                throw error;
            }
        });
    }

    recordSourceObservation(options = {}) {
        const docId = requireString(options.docId, 'docId');
        const digest = requireString(options.digest, 'digest');
        const revision = requireString(
            options.revision,
            'revision',
            { trim: false }
        );
        const now = parseInteger(this.now(), 'now');

        return this._criticalWrite(
            () => this._observationTransaction(
                docId,
                digest,
                revision,
                now
            )
        );
    }

    _normalizeReconciliationPlan(row) {
        if (!row) return null;
        const items = this._getReconciliationItems.all(row.plan_id).map(item => {
            let operation;
            try {
                operation = JSON.parse(item.payload_json);
            } catch (error) {
                throw codedError(
                    'METADATA_INTEGRITY_FAILURE',
                    `Invalid reconciliation payload JSON for ${row.plan_id}#${item.ordinal}`
                );
            }
            if (operation.kind !== item.kind) {
                throw codedError(
                    'METADATA_INTEGRITY_FAILURE',
                    `Reconciliation kind mismatch for ${row.plan_id}#${item.ordinal}`
                );
            }
            return operation;
        });
        const summary = {
            SAME: 0,
            MODIFY: 0,
            MOVE: 0,
            INSERT: 0,
            DELETE: 0,
            SPLIT: 0,
            MERGE: 0,
            AMBIGUOUS: 0
        };
        for (const operation of items) {
            if (!Object.prototype.hasOwnProperty.call(summary, operation.kind)) {
                throw codedError(
                    'METADATA_INTEGRITY_FAILURE',
                    `Unknown persisted reconciliation kind: ${operation.kind}`
                );
            }
            summary[operation.kind] += 1;
        }
        const canonicalPlan = {
            planVersion: 1,
            identityOnly: true,
            docId: row.doc_id,
            baseDocumentUri: row.base_document_uri,
            baseIdentityDigest: row.base_identity_digest,
            observedSourceDigest: row.observed_source_digest,
            observedSourceRevision: row.observed_source_revision,
            targetRevision: row.target_revision,
            operations: items,
            summary,
            planDigest: row.plan_digest,
            planId: row.plan_id
        };
        try {
            assertIdentityOnlyPlan(canonicalPlan);
        } catch (error) {
            throw codedError(
                'METADATA_INTEGRITY_FAILURE',
                `Persisted reconciliation plan failed canonical verification: ${error.message}`
            );
        }
        return Object.freeze({
            ...canonicalPlan,
            state: row.state,
            operations: Object.freeze(items),
            summary: Object.freeze(summary)
        });
    }

    getReconciliationPlan(planId) {
        return this._normalizeReconciliationPlan(
            this._getReconciliationPlan.get(
                requireString(planId, 'planId')
            )
        );
    }

    admitReconciliationPlan(plan) {
        assertIdentityOnlyPlan(plan);
        const now = parseInteger(this.now(), 'now');
        return this._criticalWrite(() => this._normalizeReconciliationPlan(
            this._admitReconciliationPlanTransaction(plan, now)
        ));
    }

    _normalizeChunkHead(row) {
        if (!row) return null;
        return Object.freeze({
            ...row,
            current_version_id: decimalOrNull(
                row.current_version_id,
                'current_version_id'
            )
        });
    }

    _normalizeChunkVersion(row) {
        if (!row) return null;
        return Object.freeze({
            ...row,
            chunk_version_id: decimalOrNull(
                row.chunk_version_id,
                'chunk_version_id'
            ),
            vector_id: decimalOrNull(row.vector_id, 'vector_id'),
            visibility_seq: decimalOrNull(
                row.visibility_seq,
                'visibility_seq'
            ),
            retired_visibility_seq: decimalOrNull(
                row.retired_visibility_seq,
                'retired_visibility_seq'
            )
        });
    }

    getCurrentChunkIdentitySnapshot(docId) {
        const normalizedDocId = requireString(docId, 'docId');
        const document = this._getDocument.get(normalizedDocId);
        if (!document || document.state !== 'ACTIVE') {
            throw codedError(
                'DOCUMENT_IDENTITY_AMBIGUOUS',
                `Active Gen-USearch document "${normalizedDocId}" is unavailable`
            );
        }

        const rows = this._listCurrentChunkIdentitySnapshot.all(normalizedDocId);
        const seenSlots = new Set();
        return Object.freeze(rows.map((row, index) => {
            if (
                row.current_version_id == null
                || row.chunk_version_id == null
                || row.current_version_id !== row.chunk_version_id
                || row.state !== 'ACTIVE'
                || row.slot_index == null
            ) {
                throw codedError(
                    'METADATA_INTEGRITY_FAILURE',
                    `Chunk identity snapshot is incomplete for ${row.chunk_id}`
                );
            }
            const slotBigInt = parseInteger(
                row.slot_index,
                `chunk identity slot_index[${index}]`
            );
            if (slotBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw codedError(
                    'METADATA_INTEGRITY_FAILURE',
                    `Chunk identity slot_index exceeds JavaScript safe range: ${slotBigInt}`
                );
            }
            const slotIndex = Number(slotBigInt);
            if (seenSlots.has(slotIndex)) {
                throw codedError(
                    'CHUNK_IDENTITY_AMBIGUOUS',
                    `Document "${normalizedDocId}" has duplicate current slot_index ${slotIndex}`
                );
            }
            seenSlots.add(slotIndex);
            return Object.freeze({
                chunkId: requireString(row.chunk_id, `chunk_id[${index}]`),
                slotIndex,
                contentHash: requireSha256(
                    row.content_hash,
                    `content_hash[${index}]`
                )
            });
        }));
    }

    getChunkHead(chunkId) {
        return this._normalizeChunkHead(
            this._getChunkHead.get(
                requireString(chunkId, 'chunkId')
            )
        );
    }

    getChunkVersion(chunkVersionId) {
        const id = parseInteger(
            chunkVersionId,
            'chunkVersionId',
            { min: 1n }
        );
        return this._normalizeChunkVersion(
            this._getChunkVersion.get(id)
        );
    }

    createChunkIdentity(options = {}) {
        const chunkId = requireString(options.chunkId, 'chunkId');
        const docId = requireString(options.docId, 'docId');
        const now = parseInteger(this.now(), 'now');

        return this._criticalWrite(() => {
            try {
                return this._normalizeChunkHead(
                    this._createChunkTransaction(
                        chunkId,
                        docId,
                        now
                    )
                );
            } catch (error) {
                if (
                    error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
                    || error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
                ) {
                    throw codedError(
                        'CHUNK_IDENTITY_AMBIGUOUS',
                        `Chunk identity already exists: ${chunkId}`
                    );
                }
                throw error;
            }
        });
    }

    prepareChunkVersion(options = {}) {
        const chunkId = requireString(options.chunkId, 'chunkId');
        const sourceRevision = requireString(
            options.sourceRevision,
            'sourceRevision',
            { trim: false }
        );
        const contentHash = requireSha256(
            options.contentHash,
            'contentHash'
        );
        const slotIndex = options.slotIndex == null
            ? null
            : parseInteger(
                options.slotIndex,
                'slotIndex'
            );
        const now = parseInteger(this.now(), 'now');

        return this._criticalWrite(() => this._normalizeChunkVersion(
            this._prepareChunkVersionTransaction(
                chunkId,
                sourceRevision,
                slotIndex,
                contentHash,
                now
            )
        ));
    }

    markEmbedding(options = {}) {
        const chunkVersionId = parseInteger(
            options.chunkVersionId,
            'chunkVersionId',
            { min: 1n }
        );
        const embeddingFingerprint = requireString(
            options.embeddingFingerprint,
            'embeddingFingerprint'
        );
        const now = parseInteger(this.now(), 'now');

        return this._criticalWrite(() => this._normalizeChunkVersion(
            this._markEmbeddingTransaction(
                chunkVersionId,
                embeddingFingerprint,
                now
            )
        ));
    }

    stageVector(options = {}) {
        const chunkVersionId = parseInteger(
            options.chunkVersionId,
            'chunkVersionId',
            { min: 1n }
        );
        const embeddingFingerprint = requireString(
            options.embeddingFingerprint,
            'embeddingFingerprint'
        );
        const vectorBlob = exactBuffer(
            options.vectorBlob,
            'vectorBlob'
        );
        const now = parseInteger(this.now(), 'now');

        return this._criticalWrite(() => this._normalizeChunkVersion(
            this._stageVectorTransaction(
                chunkVersionId,
                embeddingFingerprint,
                vectorBlob,
                now
            )
        ));
    }

    publishCurrentHead(options = {}) {
        const chunkId = requireString(options.chunkId, 'chunkId');
        const chunkVersionId = parseInteger(
            options.chunkVersionId,
            'chunkVersionId',
            { min: 1n }
        );
        const expectedCurrentVersionId = options.expectedCurrentVersionId == null
            ? null
            : parseInteger(
                options.expectedCurrentVersionId,
                'expectedCurrentVersionId',
                { min: 1n }
            );
        const now = parseInteger(this.now(), 'now');

        return this._criticalWrite(
            () => this._publishCurrentHeadTransaction(
                chunkId,
                chunkVersionId,
                expectedCurrentVersionId,
                now
            )
        );
    }

    abortChunkVersion(options = {}) {
        const chunkVersionId = parseInteger(
            options.chunkVersionId,
            'chunkVersionId',
            { min: 1n }
        );
        const now = parseInteger(this.now(), 'now');
        return this._criticalWrite(() => this._normalizeChunkVersion(
            this._abortChunkVersionTransaction(
                chunkVersionId,
                now
            )
        ));
    }
}

GenUSearchMetadataStore.MAX_SIGNED_INT64 = MAX_SIGNED_INT64;

module.exports = GenUSearchMetadataStore;
