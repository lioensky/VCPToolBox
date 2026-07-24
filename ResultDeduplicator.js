/**
 * ResultDeduplicator.js
 *
 * KnowledgeBaseManager 通用结果去重器。
 *
 * 去重分为两层：
 * 1. 硬去重：按 chunkId、规范化正文和稳定路径身份消除完全重复项；
 * 2. 语义去重：对有向量的候选执行余弦近重复抑制，无向量候选始终安全保留。
 *
 * 本组件不属于 TagMemo/RiverMemo 的 Rust 查询主链。它只处理各召回引擎已经返回的候选，
 * 为霰弹枪查询、多路 BM25/Time 合并和最终输出提供统一的后处理能力。
 */

class ResultDeduplicator {
    constructor(db, config = {}) {
        this.db = db;
        this.config = {
            dimension: 3072,
            semanticThreshold: 0.92,
            maxResults: 1000,
            minSemanticCandidates: 2,
            sourcePriority: {
                rag: 50,
                time: 45,
                bm25_body: 40,
                bm25_tag: 40,
                continuity: 35,
                associate: 10,
                unknown: 0
            },
            ...config
        };
    }

    updateConfig(config = {}) {
        if (!config || typeof config !== 'object' || Array.isArray(config)) return;
        const next = { ...this.config };

        if (Number.isFinite(Number(config.dimension)) && Number(config.dimension) > 0) {
            next.dimension = Math.floor(Number(config.dimension));
        }
        if (Number.isFinite(Number(config.semanticThreshold))) {
            next.semanticThreshold = Math.max(-1, Math.min(1, Number(config.semanticThreshold)));
        }
        if (Number.isFinite(Number(config.maxResults)) && Number(config.maxResults) > 0) {
            next.maxResults = Math.floor(Number(config.maxResults));
        }
        if (Number.isFinite(Number(config.minSemanticCandidates)) && Number(config.minSemanticCandidates) >= 0) {
            next.minSemanticCandidates = Math.floor(Number(config.minSemanticCandidates));
        }
        if (config.sourcePriority && typeof config.sourcePriority === 'object' && !Array.isArray(config.sourcePriority)) {
            next.sourcePriority = {
                ...next.sourcePriority,
                ...config.sourcePriority
            };
        }

        this.config = next;
    }

    /**
     * 对候选结果执行硬去重和可选的语义去重。
     *
     * @param {Array<object>} candidates
     * @param {Float32Array|Array<number>|null} queryVector
     * @param {object} options
     * @param {boolean} [options.semantic=true] 是否执行向量语义去重
     * @param {number} [options.semanticThreshold] 语义近重复阈值
     * @param {number} [options.maxResults] 最大保留数
     * @param {string} [options.stage='candidate'] 日志阶段名
     * @returns {Promise<Array<object>>}
     */
    async deduplicate(candidates, queryVector = null, options = {}) {
        if (!Array.isArray(candidates) || candidates.length === 0) return [];

        const stage = String(options.stage || 'candidate');
        const hardDeduplicated = this.hardDeduplicate(candidates);
        const semanticEnabled = options.semantic !== false;
        const maxResults = this._resolveMaxResults(options.maxResults);

        if (!semanticEnabled || hardDeduplicated.length < this.config.minSemanticCandidates) {
            return hardDeduplicated.slice(0, maxResults);
        }

        try {
            const hydrated = this._hydrateMissingVectors(hardDeduplicated);
            const semanticThreshold = this._resolveSemanticThreshold(options.semanticThreshold);
            const results = this._semanticDeduplicate(
                hydrated,
                queryVector,
                semanticThreshold,
                maxResults
            );

            console.log(
                `[ResultDeduplicator] stage=${stage}: ` +
                `${candidates.length} input -> ${hardDeduplicated.length} exact -> ` +
                `${results.length} semantic (threshold=${semanticThreshold.toFixed(3)}).`
            );
            return results;
        } catch (error) {
            console.warn(
                `[ResultDeduplicator] stage=${stage}: semantic deduplication failed; ` +
                `falling back to exact results: ${error.message}`
            );
            return hardDeduplicated.slice(0, maxResults);
        }
    }

    /**
     * 无副作用的确定性硬去重。
     * 同一身份出现多个版本时，优先保留来源等级高、分数高、信息更完整的结果。
     */
    hardDeduplicate(candidates) {
        if (!Array.isArray(candidates) || candidates.length === 0) return [];

        const selected = [];
        const identityOwner = new Map();

        for (let index = 0; index < candidates.length; index++) {
            const candidate = candidates[index];
            if (!candidate || typeof candidate !== 'object') continue;

            const identities = this._getExactIdentities(candidate);

            // 没有稳定身份的候选无法证明相同，必须各自保留。
            if (identities.length === 0) {
                selected.push(candidate);
                continue;
            }

            let existingIndex = -1;
            for (const identity of identities) {
                if (identityOwner.has(identity)) {
                    existingIndex = identityOwner.get(identity);
                    break;
                }
            }

            if (existingIndex === -1) {
                const nextIndex = selected.length;
                selected.push(candidate);
                for (const identity of identities) identityOwner.set(identity, nextIndex);
                continue;
            }

            const existing = selected[existingIndex];
            if (this._isPreferredCandidate(candidate, existing)) {
                selected[existingIndex] = candidate;
            }

            // 将两个版本暴露的全部身份都归并到同一槽位，防止传递性重复漏网。
            const mergedIdentities = [
                ...this._getExactIdentities(existing),
                ...identities
            ];
            for (const identity of mergedIdentities) identityOwner.set(identity, existingIndex);
        }

        return selected;
    }

    _semanticDeduplicate(candidates, queryVector, threshold, maxResults) {
        const query = this._toValidVector(queryVector);
        const ranked = candidates
            .map((candidate, index) => ({
                candidate,
                index,
                vector: this._getCandidateVector(candidate)
            }))
            .sort((a, b) => this._compareCandidates(a, b, query));

        const selected = [];
        const selectedVectors = [];

        for (const entry of ranked) {
            if (selected.length >= maxResults) break;

            // 无向量项无法可靠做语义判断，必须保留，不能静默丢失 BM25/外部候选。
            if (!entry.vector) {
                selected.push(entry);
                selectedVectors.push(null);
                continue;
            }

            let redundant = false;
            for (const selectedVector of selectedVectors) {
                if (!selectedVector) continue;
                if (this._cosineSimilarity(entry.vector, selectedVector) >= threshold) {
                    redundant = true;
                    break;
                }
            }

            if (!redundant) {
                selected.push(entry);
                selectedVectors.push(entry.vector);
            }
        }

        // 语义比较时可能为挑选代表项调整次序；最终恢复来源优先、分数和原始次序的稳定排序。
        return selected
            .sort((a, b) => this._compareOutputOrder(a, b))
            .map(entry => entry.candidate);
    }

    _hydrateMissingVectors(candidates) {
        if (!this.db || typeof this.db.prepare !== 'function') return candidates;

        let statement;
        try {
            statement = this.db.prepare('SELECT vector FROM chunks WHERE id = ? LIMIT 1');
        } catch (error) {
            return candidates;
        }

        return candidates.map(candidate => {
            if (this._getCandidateVector(candidate)) return candidate;

            const chunkId = this._getChunkId(candidate);
            if (chunkId === null) return candidate;

            try {
                const row = statement.get(chunkId);
                const vector = this._decodeStoredVector(row?.vector);
                if (!vector) return candidate;
                return { ...candidate, _vector: vector };
            } catch (error) {
                return candidate;
            }
        });
    }

    _getExactIdentities(candidate) {
        const identities = [];
        const chunkId = this._getChunkId(candidate);
        if (chunkId !== null) identities.push(`chunk:${chunkId}`);

        const normalizedText = this._normalizeText(candidate.text ?? candidate.content);
        if (normalizedText) identities.push(`text:${normalizedText}`);

        const fullPath = String(
            candidate.fullPath || candidate.sourceFile || candidate._expandedFilePath || ''
        ).trim().replace(/\\/g, '/').toLowerCase();
        const chunkIndex = candidate.chunkIndex ?? candidate.chunk_index ?? candidate.offset;
        if (fullPath && chunkIndex !== undefined && chunkIndex !== null) {
            identities.push(`path-chunk:${fullPath}:${chunkIndex}`);
        }

        return identities;
    }

    _isPreferredCandidate(candidate, existing) {
        const candidatePriority = this._getSourcePriority(candidate);
        const existingPriority = this._getSourcePriority(existing);
        if (candidatePriority !== existingPriority) return candidatePriority > existingPriority;

        const candidateScore = this._getScore(candidate);
        const existingScore = this._getScore(existing);
        if (candidateScore !== existingScore) return candidateScore > existingScore;

        return this._candidateCompleteness(candidate) > this._candidateCompleteness(existing);
    }

    _compareCandidates(a, b, queryVector) {
        const aQuerySimilarity = queryVector && a.vector
            ? this._cosineSimilarity(a.vector, queryVector)
            : null;
        const bQuerySimilarity = queryVector && b.vector
            ? this._cosineSimilarity(b.vector, queryVector)
            : null;

        if (aQuerySimilarity !== null || bQuerySimilarity !== null) {
            const safeA = aQuerySimilarity ?? -Infinity;
            const safeB = bQuerySimilarity ?? -Infinity;
            if (safeA !== safeB) return safeB - safeA;
        }

        const scoreDiff = this._getScore(b.candidate) - this._getScore(a.candidate);
        if (scoreDiff !== 0) return scoreDiff;

        const priorityDiff = this._getSourcePriority(b.candidate) - this._getSourcePriority(a.candidate);
        if (priorityDiff !== 0) return priorityDiff;
        return a.index - b.index;
    }

    _compareOutputOrder(a, b) {
        const priorityDiff = this._getSourcePriority(b.candidate) - this._getSourcePriority(a.candidate);
        if (priorityDiff !== 0) return priorityDiff;

        const scoreDiff = this._getScore(b.candidate) - this._getScore(a.candidate);
        if (scoreDiff !== 0) return scoreDiff;
        return a.index - b.index;
    }

    _getSourcePriority(candidate) {
        const source = String(candidate?.source || 'unknown').toLowerCase();
        const configured = Number(this.config.sourcePriority?.[source]);
        if (Number.isFinite(configured)) return configured;
        if (source.startsWith('bm25')) {
            const bm25Priority = Number(this.config.sourcePriority?.bm25_body);
            return Number.isFinite(bm25Priority) ? bm25Priority : 40;
        }
        return Number(this.config.sourcePriority?.unknown) || 0;
    }

    _getScore(candidate) {
        const score = Number(
            candidate?.rerank_score ??
            candidate?.rrf_score ??
            candidate?.score ??
            candidate?.original_score ??
            0
        );
        return Number.isFinite(score) ? score : 0;
    }

    _candidateCompleteness(candidate) {
        let score = 0;
        if (this._getChunkId(candidate) !== null) score += 4;
        if (candidate.fullPath || candidate.sourceFile) score += 2;
        if (candidate.text || candidate.content) score += 2;
        if (candidate.vector || candidate._vector) score += 1;
        if (candidate.matchedTags) score += 1;
        return score;
    }

    _getChunkId(candidate) {
        const value = candidate?.chunkId ?? candidate?.id ?? candidate?.label;
        if (typeof value === 'bigint') {
            const converted = Number(value);
            return Number.isSafeInteger(converted) && converted > 0 ? converted : null;
        }
        const numeric = Number(value);
        return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
    }

    _getCandidateVector(candidate) {
        return this._toValidVector(candidate?.vector || candidate?._vector);
    }

    _toValidVector(value) {
        if (!value || typeof value.length !== 'number') return null;
        if (value.length !== this.config.dimension) return null;

        const vector = value instanceof Float32Array
            ? value
            : new Float32Array(value);
        let magnitudeSquared = 0;
        for (let i = 0; i < vector.length; i++) {
            const component = vector[i];
            if (!Number.isFinite(component)) return null;
            magnitudeSquared += component * component;
        }
        return magnitudeSquared > 1e-12 ? vector : null;
    }

    _decodeStoredVector(value) {
        if (!value) return null;
        if (value instanceof Float32Array) return this._toValidVector(value);

        if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
            const expectedBytes = this.config.dimension * Float32Array.BYTES_PER_ELEMENT;
            if (value.byteLength !== expectedBytes) return null;
            const copied = Buffer.from(value);
            const vector = new Float32Array(
                copied.buffer,
                copied.byteOffset,
                this.config.dimension
            );
            return this._toValidVector(new Float32Array(vector));
        }

        return this._toValidVector(value);
    }

    _normalizeText(value) {
        return String(value || '')
            .normalize('NFKC')
            .replace(/\r\n?/g, '\n')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
            .toLowerCase();
    }

    _resolveSemanticThreshold(value) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return Math.max(-1, Math.min(1, parsed));
        return Math.max(-1, Math.min(1, Number(this.config.semanticThreshold) || 0.92));
    }

    _resolveMaxResults(value) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
        const configured = Number(this.config.maxResults);
        return Number.isFinite(configured) && configured > 0
            ? Math.floor(configured)
            : Number.MAX_SAFE_INTEGER;
    }

    _cosineSimilarity(v1, v2) {
        if (!v1 || !v2 || v1.length !== v2.length) return -1;
        let dot = 0;
        let mag1 = 0;
        let mag2 = 0;
        for (let i = 0; i < v1.length; i++) {
            dot += v1[i] * v2[i];
            mag1 += v1[i] * v1[i];
            mag2 += v2[i] * v2[i];
        }
        if (mag1 <= 1e-12 || mag2 <= 1e-12) return -1;
        return dot / Math.sqrt(mag1 * mag2);
    }
}

module.exports = ResultDeduplicator;
