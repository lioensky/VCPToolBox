'use strict';

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

        for (const statement of [
            this._getAllocator,
            this._getSequence,
            this._getManifestState
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
                        visibilitySeq,
                        null
                    );
                }
                return this._getDocument.get(docId);
            }
        );

        this._moveDocumentTransaction = db.transaction(
            (docId, nextUri, visibilitySeq, now) => {
                const existing = this._getDocument.get(docId);
                if (!existing || existing.state !== 'ACTIVE') {
                    throw codedError(
                        'DOCUMENT_IDENTITY_AMBIGUOUS',
                        `Active Gen-USearch document "${docId}" is unavailable`
                    );
                }
                if (existing.current_uri === nextUri) return existing;

                this._closeUriHistory.run(
                    parseInteger(visibilitySeq, 'visibility_seq'),
                    docId
                );
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
                    parseInteger(visibilitySeq, 'visibility_seq'),
                    null
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
        const visibilitySeq = parseInteger(
            options.visibilitySeq ?? this.readSequence('visibility_seq'),
            'visibilitySeq'
        );
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
        const visibilitySeq = parseInteger(
            options.visibilitySeq,
            'visibilitySeq'
        );
        const now = parseInteger(this.now(), 'now');

        return this._criticalWrite(() => {
            try {
                return this._moveDocumentTransaction(
                    docId,
                    uri,
                    visibilitySeq,
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
}

GenUSearchMetadataStore.MAX_SIGNED_INT64 = MAX_SIGNED_INT64;

module.exports = GenUSearchMetadataStore;
