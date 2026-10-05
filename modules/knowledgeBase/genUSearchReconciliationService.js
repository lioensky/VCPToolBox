'use strict';

const {
    reconcileDocumentChunks
} = require('./genUSearchReconciler');

const COMMITTED_SOURCE_STATES = new Set(['OLD_COMPLETE', 'NEW_COMPLETE']);

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function requireString(value, label, options = {}) {
    if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
    const normalized = options.trim === false ? value : value.trim();
    if (!normalized) throw new TypeError(`${label} must not be empty`);
    return normalized;
}

function validateCommittedSourceView(view) {
    if (!view || typeof view !== 'object' || Array.isArray(view)) {
        throw new TypeError('canonical source provider must return a CommittedSourceView object');
    }
    const allowed = new Set([
        'state', 'commitVerified', 'bytesStable',
        'sourceDigest', 'sourceRevision', 'chunks'
    ]);
    for (const key of Object.keys(view)) {
        if (!allowed.has(key)) {
            throw codedError(
                'SOURCE_COMMIT_UNVERIFIED',
                `CommittedSourceView contains unsupported field: ${key}`
            );
        }
    }
    if (
        !COMMITTED_SOURCE_STATES.has(view.state)
        || view.commitVerified !== true
        || view.bytesStable !== true
    ) {
        throw codedError(
            'SOURCE_COMMIT_UNVERIFIED',
            'Gen-USearch reconciliation requires a committed complete source view'
        );
    }
    const sourceDigest = requireString(view.sourceDigest, 'committedSourceView.sourceDigest');
    const sourceRevision = requireString(
        view.sourceRevision,
        'committedSourceView.sourceRevision',
        { trim: false }
    );
    if (!Array.isArray(view.chunks)) {
        throw new TypeError('committedSourceView.chunks must be an array');
    }
    const chunks = Object.freeze(view.chunks.map((chunk, index) => {
        if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
            throw new TypeError(`committedSourceView.chunks[${index}] must be an object`);
        }
        const keys = Object.keys(chunk).sort();
        const allowedChunkKeys = ['content', 'contentHash', 'slotIndex'];
        if (keys.some(key => !allowedChunkKeys.includes(key))) {
            throw codedError(
                'SOURCE_COMMIT_UNVERIFIED',
                `CommittedSourceView chunk contains unsupported field at index ${index}`
            );
        }
        return Object.freeze({ ...chunk });
    }));
    return Object.freeze({
        state: view.state,
        commitVerified: true,
        bytesStable: true,
        sourceDigest,
        sourceRevision,
        chunks
    });
}

class GenUSearchReconciliationService {
    constructor(options = {}) {
        const store = options.store;
        const sourceViewProvider = options.sourceViewProvider;
        if (
            !store
            || typeof store.getDocument !== 'function'
            || typeof store.getCurrentChunkIdentitySnapshot !== 'function'
            || typeof store.admitReconciliationPlan !== 'function'
        ) {
            throw new TypeError(
                'GenUSearchReconciliationService requires a GenUSearchMetadataStore-compatible store'
            );
        }
        if (
            !sourceViewProvider
            || typeof sourceViewProvider.readCommittedSourceView !== 'function'
            || typeof sourceViewProvider.withCommittedSourceView !== 'function'
        ) {
            throw new TypeError(
                'GenUSearchReconciliationService requires a canonical sourceViewProvider with readCommittedSourceView() and withCommittedSourceView()'
            );
        }
        this.store = store;
        this.sourceViewProvider = sourceViewProvider;
    }

    #normalizeRequest(options) {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('reconciliation request must be an object');
        }
        const keys = Object.keys(options);
        if (keys.length !== 1 || keys[0] !== 'docId') {
            throw codedError(
                'RECONCILER_AUTHORITY_VIOLATION',
                'Public G1 reconciliation requests may contain only docId'
            );
        }
        return requireString(options.docId, 'docId');
    }

    async #readAuthoritativeSource(docId, document) {
        const rawView = await this.sourceViewProvider.readCommittedSourceView({
            docId,
            currentUri: document.current_uri
        });
        return validateCommittedSourceView(rawView);
    }

    async #withCommittedSourceLease(docId, callback) {
        const document = this.store.getDocument(docId);
        if (!document || document.state !== 'ACTIVE') {
            throw codedError(
                'DOCUMENT_IDENTITY_AMBIGUOUS',
                `Active Gen-USearch document "${docId}" is unavailable`
            );
        }
        const request = Object.freeze({
            docId,
            currentUri: document.current_uri
        });
        let callbackCount = 0;
        let callbackResult;
        const result = await this.sourceViewProvider.withCommittedSourceView(
            request,
            async rawView => {
                callbackCount += 1;
                if (callbackCount !== 1) {
                    throw codedError(
                        'SOURCE_COMMIT_UNVERIFIED',
                        'canonical source lease callback must execute exactly once'
                    );
                }
                const source = validateCommittedSourceView(rawView);
                const currentDocument = this.store.getDocument(docId);
                if (
                    !currentDocument
                    || currentDocument.state !== 'ACTIVE'
                    || (currentDocument.current_uri ?? null) !== (document.current_uri ?? null)
                ) {
                    throw codedError(
                        'STALE_DOCUMENT_WRITER',
                        'Document URI changed while the committed source lease was held'
                    );
                }
                callbackResult = await callback(
                    source,
                    currentDocument.current_uri ?? null
                );
                return callbackResult;
            }
        );
        if (callbackCount !== 1) {
            throw codedError(
                'SOURCE_COMMIT_UNVERIFIED',
                'canonical source provider did not execute the committed source lease callback exactly once'
            );
        }
        if (result !== callbackResult) {
            throw codedError(
                'SOURCE_COMMIT_UNVERIFIED',
                'canonical source provider altered the committed source lease result'
            );
        }
        return callbackResult;
    }

    #buildPlan(docId, source, baseDocumentUri) {
        const previousChunks = this.store.getCurrentChunkIdentitySnapshot(docId);
        return reconcileDocumentChunks({
            docId,
            baseDocumentUri,
            observedSourceDigest: source.sourceDigest,
            observedSourceRevision: source.sourceRevision,
            targetRevision: source.sourceRevision,
            previousChunks,
            nextChunks: source.chunks
        });
    }

    async planCurrentSource(options = {}) {
        const docId = this.#normalizeRequest(options);
        const document = this.store.getDocument(docId);
        if (!document || document.state !== 'ACTIVE') {
            throw codedError(
                'DOCUMENT_IDENTITY_AMBIGUOUS',
                `Active Gen-USearch document "${docId}" is unavailable`
            );
        }
        const source = await this.#readAuthoritativeSource(docId, document);
        const afterRead = this.store.getDocument(docId);
        if (
            !afterRead
            || afterRead.state !== 'ACTIVE'
            || (afterRead.current_uri ?? null) !== (document.current_uri ?? null)
        ) {
            throw codedError(
                'STALE_DOCUMENT_WRITER',
                'Document URI changed while reading the committed source view'
            );
        }
        return this.#buildPlan(docId, source, document.current_uri ?? null);
    }

    async planAndAdmitCurrentSource(options = {}) {
        const docId = this.#normalizeRequest(options);
        return this.#withCommittedSourceLease(
            docId,
            async (source, baseDocumentUri) => {
                const plan = this.#buildPlan(
                    docId,
                    source,
                    baseDocumentUri
                );
                const admitted = this.store.admitReconciliationPlan(plan);
                return Object.freeze({ plan, admitted });
            }
        );
    }
}

GenUSearchReconciliationService.validateCommittedSourceView = validateCommittedSourceView;

module.exports = GenUSearchReconciliationService;
