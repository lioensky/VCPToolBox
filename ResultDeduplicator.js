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

const { performance } = require('perf_hooks');

class ResultDeduplicator {
    constructor(db, config = {}) {
        this.db = db;
        this.config = {
            dimension: 3072,
            semanticThreshold: 0.92,
            maxResults: 1000,
            minSemanticCandidates: 2,
            hydrationBatchSize: 500,
            slowLogMs: 25,
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
        if (Number.isFinite(Number(config.hydrationBatchSize)) && Number(config.hydrationBatchSize) > 0) {
            next.hydrationBatchSize = Math.min(900, Math.floor(Number(config.hydrationBatchSize)));
        }
        if (Number.isFinite(Number(config.slowLogMs)) && Number(config.slowLogMs) >= 0) {
            next.slowLogMs = Number(config.slowLogMs);
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

        const startedAt = performance.now();
        const stage = String(options.stage || 'candidate');
        const hardDeduplicated = this.hardDeduplicate(candidates);
        const exactFinishedAt = performance.now();
        const semanticEnabled = options.semantic !== false;
        const maxResults = this._resolveMaxResults(options.maxResults);

        if (!semanticEnabled || hardDeduplicated.length < this.config.minSemanticCandidates) {
            return hardDeduplicated.slice(0, maxResults);
        }

        try {
            const hydrated = this._hydrateMissingVectors(hardDeduplicated);
            const hydrationFinishedAt = performance.now();
            const semanticThreshold = this._resolveSemanticThreshold(options.semanticThreshold);
            const results = this._semanticDeduplicate(
                hydrated,
                queryVector,
                semanticThreshold,
                maxResults
            );
            const finishedAt = performance.now();
            const exactMs = exactFinishedAt - startedAt;
            const hydrateMs = hydrationFinishedAt - exactFinishedAt;
            const semanticMs = finishedAt - hydrationFinishedAt;
            const totalMs = finishedAt - startedAt;
            const timingSuffix = totalMs >= this.config.slowLogMs
                ? ` timings[exact=${exactMs.toFixed(1)}ms, hydrate=${hydrateMs.toFixed(1)}ms, ` +
                    `semantic=${semanticMs.toFixed(1)}ms, total=${totalMs.toFixed(1)}ms]`
                : '';

            console.log(
                `[ResultDeduplicator] stage=${stage}: ` +
                `${candidates.length} input -> ${hardDeduplicated.length} exact -> ` +
                `${results.length} semantic (threshold=${semanticThreshold.toFixed(3)}).` +
                timingSuffix
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
        // 向量有效性和范数都只计算一次。旧实现会在 sort 比较器和每一对
        // 候选比较中重复扫描 3072 维向量，候选池较大时会放大为主要 CPU 热点。
        const queryDescriptor = this._createVectorDescriptor(queryVector);
        const ranked = candidates
            .map((candidate, index) => {
                const descriptor = this._createVectorDescriptor(
                    candidate?.vector || candidate?._vector
                );
                return {
                    candidate,
                    index,
                    vector: descriptor?.vector || null,
                    vectorDescriptor: descriptor,
                    querySimilarity: queryDescriptor && descriptor
                        ? this._cosineSimilarityPrepared(descriptor, queryDescriptor)
                        : null
                };
            })
            .sort((a, b) => this._compareCandidates(a, b));

        const selected = [];
        const selectedDescriptors = [];

        for (const entry of ranked) {
            if (selected.length >= maxResults) break;

            // 无向量项无法可靠做语义判断，必须保留，不能静默丢失 BM25/外部候选。
            if (!entry.vectorDescriptor) {
                selected.push(entry);
                continue;
            }

            let redundant = false;
            for (const selectedDescriptor of selectedDescriptors) {
                if (
                    this._cosineSimilarityPrepared(
                        entry.vectorDescriptor,
                        selectedDescriptor
                    ) >= threshold
                ) {
                    redundant = true;
                    break;
                }
            }

            if (!redundant) {
                selected.push(entry);
                selectedDescriptors.push(entry.vectorDescriptor);
            }
        }

        // 语义比较时可能为挑选代表项调整次序；最终恢复来源优先、分数和原始次序的稳定排序。
        return selected
            .sort((a, b) => this._compareOutputOrder(a, b))
            .map(entry => entry.candidate);
    }

    _hydrateMissingVectors(candidates) {
        if (!this.db || typeof this.db.prepare !== 'function') return candidates;

        const missingChunkIds = [];
        const seenChunkIds = new Set();
        for (const candidate of candidates) {
            if (this._getCandidateVector(candidate)) continue;
            const chunkId = this._getChunkId(candidate);
            if (chunkId === null || seenChunkIds.has(chunkId)) continue;
            seenChunkIds.add(chunkId);
            missingChunkIds.push(chunkId);
        }
        if (missingChunkIds.length === 0) return candidates;

        const vectorByChunkId = new Map();
        const batchSize = Math.max(
            1,
            Math.min(900, Number(this.config.hydrationBatchSize) || 500)
        );

        try {
            for (let offset = 0; offset < missingChunkIds.length; offset += batchSize) {
                const batch = missingChunkIds.slice(offset, offset + batchSize);
                const placeholders = batch.map(() => '?').join(',');
                const rows = this.db.prepare(
                    `SELECT id, vector FROM chunks WHERE id IN (${placeholders})`
                ).all(...batch);
                for (const row of rows || []) {
                    const vector = this._decodeStoredVector(row?.vector);
                    if (vector) vectorByChunkId.set(Number(row.id), vector);
                }
            }
        } catch (error) {
            // 非 better-sqlite3 的兼容适配器可能只实现单行 get；生产路径始终走上面的批量查询。
            try {
                const statement = this.db.prepare(
                    'SELECT vector FROM chunks WHERE id = ? LIMIT 1'
                );
                for (const chunkId of missingChunkIds) {
                    const vector = this._decodeStoredVector(
                        statement.get(chunkId)?.vector
                    );
                    if (vector) vectorByChunkId.set(chunkId, vector);
                }
            } catch (fallbackError) {
                return candidates;
            }
        }

        return candidates.map(candidate => {
            if (this._getCandidateVector(candidate)) return candidate;
            const chunkId = this._getChunkId(candidate);
            const vector = chunkId === null
                ? null
                : vectorByChunkId.get(chunkId);
            return vector ? { ...candidate, _vector: vector } : candidate;
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

    _compareCandidates(a, b) {
        if (a.querySimilarity !== null || b.querySimilarity !== null) {
            const safeA = a.querySimilarity ?? -Infinity;
            const safeB = b.querySimilarity ?? -Infinity;
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
        return this._createVectorDescriptor(value)?.vector || null;
    }

    _createVectorDescriptor(value) {
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
        if (magnitudeSquared <= 1e-12) return null;
        return {
            vector,
            inverseMagnitude: 1 / Math.sqrt(magnitudeSquared)
        };
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
        const descriptor1 = this._createVectorDescriptor(v1);
        const descriptor2 = this._createVectorDescriptor(v2);
        if (!descriptor1 || !descriptor2) return -1;
        return this._cosineSimilarityPrepared(descriptor1, descriptor2);
    }

    _cosineSimilarityPrepared(descriptor1, descriptor2) {
        const v1 = descriptor1?.vector;
        const v2 = descriptor2?.vector;
        if (!v1 || !v2 || v1.length !== v2.length) return -1;

        let dot = 0;
        // 四路展开可减少 3072 维热循环中的边界判断与循环控制开销。
        let i = 0;
        const unrolledLength = v1.length - (v1.length % 4);
        for (; i < unrolledLength; i += 4) {
            dot += v1[i] * v2[i]
                + v1[i + 1] * v2[i + 1]
                + v1[i + 2] * v2[i + 2]
                + v1[i + 3] * v2[i + 3];
        }
        for (; i < v1.length; i++) {
            dot += v1[i] * v2[i];
        }
        return dot *
            descriptor1.inverseMagnitude *
            descriptor2.inverseMagnitude;
    }
}

module.exports = ResultDeduplicator;
