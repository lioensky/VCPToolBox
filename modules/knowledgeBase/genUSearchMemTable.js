'use strict';

const MAX_SIGNED_INT64 = 9223372036854775807n;
const RUNTIME_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function canonicalVectorId(value) {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
        throw codedError(
            'VECTOR_ID_INVALID',
            'Gen0 MemTable vectorId must be a canonical positive decimal string'
        );
    }
    const parsed = BigInt(value);
    if (parsed > MAX_SIGNED_INT64) {
        throw codedError(
            'VECTOR_ID_INVALID',
            'Gen0 MemTable vectorId exceeds signed-int64 range'
        );
    }
    return value;
}

function canonicalGeneration(value) {
    const normalized = typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : value;
    if (typeof normalized !== 'string' || !/^[1-9][0-9]*$/.test(normalized)) {
        throw new TypeError(
            'Gen0 MemTable generation must be a canonical positive integer'
        );
    }
    return normalized;
}

function requireVector(vector, dimension) {
    if (!(vector instanceof Float32Array)) {
        throw new TypeError('Gen0 MemTable vector must be a Float32Array');
    }
    if (vector.length !== dimension) {
        throw new TypeError(
            `Gen0 MemTable vector dimension mismatch: expected ${dimension}, got ${vector.length}`
        );
    }
    for (const value of vector) {
        if (!Number.isFinite(value)) {
            throw new TypeError('Gen0 MemTable vector values must be finite f32 numbers');
        }
    }
    return vector;
}

class GenUSearchMemTable {
    #index;
    #vectorIds = new Set();
    #state = 'ACTIVE';
    #mutationToken;

    constructor(options = {}) {
        const VexusIndex = options.VexusIndex;
        if (typeof VexusIndex !== 'function') {
            throw new TypeError('GenUSearchMemTable requires VexusIndex');
        }
        if (
            (typeof options.mutationToken !== 'object' || options.mutationToken === null)
            && typeof options.mutationToken !== 'function'
        ) {
            throw new TypeError(
                'GenUSearchMemTable requires a private mutation authority token'
            );
        }

        const dimension = Number(options.dimension);
        const capacity = Number(options.capacity ?? 50000);
        if (!Number.isSafeInteger(dimension) || dimension <= 0) {
            throw new TypeError('Gen0 MemTable dimension must be a positive safe integer');
        }
        if (!Number.isSafeInteger(capacity) || capacity <= 0) {
            throw new TypeError('Gen0 MemTable capacity must be a positive safe integer');
        }

        const runtimeId = String(options.runtimeId || '').trim();
        if (!RUNTIME_ID_RE.test(runtimeId)) {
            throw new TypeError(
                'Gen0 MemTable runtimeId must match [A-Za-z0-9._-]{1,128}'
            );
        }
        const generation = canonicalGeneration(options.generation);
        const embeddingFingerprint = String(options.embeddingFingerprint || '').trim();
        if (!embeddingFingerprint) {
            throw new TypeError('Gen0 MemTable embeddingFingerprint must not be empty');
        }
        const sourceId = `gen0:${runtimeId}:${generation}`;

        Object.defineProperties(this, {
            dimension: { value: dimension, enumerable: true },
            capacity: { value: capacity, enumerable: true },
            runtimeId: { value: runtimeId, enumerable: true },
            generation: { value: generation, enumerable: true },
            embeddingFingerprint: { value: embeddingFingerprint, enumerable: true },
            sourceKind: { value: 'MEMTABLE', enumerable: true },
            sourceId: { value: sourceId, enumerable: true }
        });

        this.#mutationToken = options.mutationToken;
        this.#index = new VexusIndex(dimension, capacity);
    }

    get state() {
        return this.#state;
    }

    _assertMutationAuthority(token) {
        if (token !== this.#mutationToken) {
            throw codedError(
                'MEMTABLE_MUTATION_AUTHORITY_REQUIRED',
                'Gen0 MemTable mutation requires its bound physical coverage writer'
            );
        }
    }

    _assertActive() {
        if (this.#state !== 'ACTIVE') {
            throw codedError(
                'MEMTABLE_NOT_ACTIVE',
                `Gen0 MemTable ${this.sourceId} is ${this.#state}`
            );
        }
    }

    addVector(options = {}, mutationToken) {
        this._assertMutationAuthority(mutationToken);
        this._assertActive();
        const vectorId = canonicalVectorId(options.vectorId);
        const vector = requireVector(options.vector, this.dimension);

        if (this.#vectorIds.has(vectorId)) {
            throw codedError(
                'MEMTABLE_VECTOR_ALREADY_PRESENT',
                `Vector ${vectorId} already exists in ${this.sourceId}`
            );
        }

        this.#index.addKey64(vectorId, vector);
        this.#vectorIds.add(vectorId);
        return Object.freeze({
            vectorId,
            sourceId: this.sourceId,
            state: this.#state
        });
    }

    removeVector(vectorId, mutationToken) {
        this._assertMutationAuthority(mutationToken);
        this._assertActive();
        const normalized = canonicalVectorId(vectorId);
        if (!this.#vectorIds.has(normalized)) return false;

        this.#index.removeKey64(normalized);
        this.#vectorIds.delete(normalized);
        return true;
    }

    seal(mutationToken) {
        this._assertMutationAuthority(mutationToken);
        if (this.#state === 'SEALED_QUERY_VISIBLE') {
            return this.#state;
        }
        this._assertActive();
        this.#state = 'SEALED_QUERY_VISIBLE';
        return this.#state;
    }

    hasVector(vectorId) {
        const normalized = canonicalVectorId(vectorId);
        return this.#vectorIds.has(normalized);
    }

    listVectorIds() {
        return Object.freeze([...this.#vectorIds]);
    }

    stats() {
        return Object.freeze({
            sourceKind: this.sourceKind,
            sourceId: this.sourceId,
            runtimeId: this.runtimeId,
            generation: this.generation,
            embeddingFingerprint: this.embeddingFingerprint,
            state: this.#state,
            dimension: this.dimension,
            capacity: this.capacity,
            vectorCount: this.#vectorIds.size,
            nativeRevision: this.#index.revision
        });
    }

    static assertContains(memtable, vectorId) {
        if (!(memtable instanceof GenUSearchMemTable)) {
            throw new TypeError('expected GenUSearchMemTable');
        }
        const normalized = canonicalVectorId(vectorId);
        if (!memtable.#vectorIds.has(normalized)) {
            throw codedError(
                'PHYSICAL_COVERAGE_MISSING',
                `Vector ${normalized} is absent from ${memtable.sourceId}`
            );
        }
        return true;
    }
}

GenUSearchMemTable.MAX_SIGNED_INT64 = MAX_SIGNED_INT64;

module.exports = GenUSearchMemTable;
