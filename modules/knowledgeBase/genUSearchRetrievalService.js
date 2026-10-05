'use strict';

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function requireK(value) {
    const k = Number(value);
    if (!Number.isSafeInteger(k) || k <= 0 || k > 10000) {
        throw new RangeError('G4 retrieval k must be an integer in [1, 10000]');
    }
    return k;
}

function compareVectorIds(left, right) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
}

class GenUSearchRetrievalService {
    constructor(options = {}) {
        const coordinator = options.coordinator;
        if (
            !coordinator
            || typeof coordinator.collectPhysicalCandidates !== 'function'
            || typeof coordinator.assertResponseFence !== 'function'
        ) {
            throw new TypeError('GenUSearchRetrievalService requires a G4 QueryReadView coordinator');
        }
        this.coordinator = coordinator;
    }

    search(options = {}) {
        const view = options.view;
        const query = options.query;
        const fingerprint = String(options.embeddingFingerprint || '').trim();
        const k = requireK(options.k ?? 10);
        if (!fingerprint) {
            throw codedError('QUERY_READ_VIEW_INVALID', 'embeddingFingerprint is required');
        }

        const currentByVector = new Map();
        for (const row of view?.metadata_snapshot || []) {
            if (currentByVector.has(row.vector_id)) {
                throw codedError(
                    'CANDIDATE_DEDUP_VIOLATION',
                    'QueryReadView contains duplicate current vector identity'
                );
            }
            currentByVector.set(row.vector_id, row);
        }

        const physical = this.coordinator.collectPhysicalCandidates(
            view,
            query,
            fingerprint
        );
        const dedup = new Map();
        for (const candidate of physical) {
            const current = currentByVector.get(candidate.vectorId);
            if (!current || current.embedding_fingerprint !== fingerprint) {
                continue;
            }
            const score = Number(candidate.score);
            if (!Number.isFinite(score)) {
                throw codedError(
                    'QUERY_READ_VIEW_INVALID',
                    'physical candidate returned a non-finite score'
                );
            }
            const existing = dedup.get(candidate.vectorId);
            if (!existing) {
                dedup.set(candidate.vectorId, {
                    vector_id: candidate.vectorId,
                    score,
                    chunk_id: current.chunk_id,
                    doc_id: current.doc_id,
                    chunk_version_id: current.chunk_version_id,
                    embedding_fingerprint: fingerprint,
                    sources: new Set([
                        candidate.sourceKind + ':' + candidate.sourceId
                    ])
                });
            } else {
                existing.score = Math.max(existing.score, score);
                existing.sources.add(candidate.sourceKind + ':' + candidate.sourceId);
            }
        }

        const hits = [...dedup.values()]
            .sort((left, right) => (
                right.score - left.score
                || compareVectorIds(left.vector_id, right.vector_id)
            ))
            .slice(0, k)
            .map(hit => Object.freeze({
                vector_id: hit.vector_id,
                score: hit.score,
                chunk_id: hit.chunk_id,
                doc_id: hit.doc_id,
                chunk_version_id: hit.chunk_version_id,
                embedding_fingerprint: hit.embedding_fingerprint,
                physical_sources: Object.freeze([...hit.sources].sort())
            }));

        this.coordinator.assertResponseFence(view);

        return Object.freeze({
            read_view_id: view.read_view_id,
            visibility_seq: view.visibility_seq,
            manifest_epoch: view.manifest_snapshot.manifest_epoch,
            runtime_fence: view.runtime_fence.runtime_fence,
            hits: Object.freeze(hits)
        });
    }
}

module.exports = GenUSearchRetrievalService;
