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
        throw new TypeError('committedSourceView must be an object');
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
    return Object.freeze({
        state: view.state,
        commitVerified: true,
        bytesStable: true,
        sourceDigest,
        sourceRevision,
        chunks: view.chunks
    });
}

class GenUSearchReconciliationService {
    constructor(options = {}) {
        const store = options.store;
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
        this.store = store;
    }

    planCommittedSource(options = {}) {
        if (Object.prototype.hasOwnProperty.call(options, 'previousChunks')) {
            throw codedError(
                'RECONCILER_AUTHORITY_VIOLATION',
                'Callers cannot supply previousChunks; SQLite current-head metadata is authoritative'
            );
        }
        const docId = requireString(options.docId, 'docId');
        const document = this.store.getDocument(docId);
        if (!document || document.state !== 'ACTIVE') {
            throw codedError(
                'DOCUMENT_IDENTITY_AMBIGUOUS',
                `Active Gen-USearch document "${docId}" is unavailable`
            );
        }
        const source = validateCommittedSourceView(options.committedSourceView);
        const previousChunks = this.store.getCurrentChunkIdentitySnapshot(docId);
        return reconcileDocumentChunks({
            docId,
            observedSourceDigest: source.sourceDigest,
            observedSourceRevision: source.sourceRevision,
            targetRevision: source.sourceRevision,
            previousChunks,
            nextChunks: source.chunks
        });
    }

    planAndAdmitCommittedSource(options = {}) {
        const plan = this.planCommittedSource(options);
        const admitted = this.store.admitReconciliationPlan(plan);
        return Object.freeze({ plan, admitted });
    }
}

GenUSearchReconciliationService.validateCommittedSourceView = validateCommittedSourceView;

module.exports = GenUSearchReconciliationService;
