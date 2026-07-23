'use strict';

const {
    computeRiverObservability
} = require('./modules/tagmemoV10/riverObservability');

let nativeTopologyV3 = null;

function getNativeTopologyV3() {
    if (nativeTopologyV3) return nativeTopologyV3;
    const native = require('./rust-vexus-lite');
    if (typeof native.rerankRivermemoTopologyV3 !== 'function') {
        const error = new Error(
            'RiverMemo Topology V3 native kernel is unavailable; rebuild rust-vexus-lite.'
        );
        error.code = 'RIVERMEMO_NATIVE_TOPOLOGY_V3_UNAVAILABLE';
        throw error;
    }
    nativeTopologyV3 = native.rerankRivermemoTopologyV3;
    return nativeTopologyV3;
}

const VERSION = 'rivermemo_v1';
const ALGORITHM_VERSION = 'rivermemo.topology-v3.1';
const RESULT_SCHEMA = 'rivermemo-topology-v3-result-v1';

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function candidateId(candidate) {
    const id = Number(candidate?.id ?? candidate?.chunkId ?? candidate?.label);
    return Number.isFinite(id) && id > 0 ? id : null;
}

function cosine(left, right) {
    if (!left || !right || left.length !== right.length) return 0;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index++) {
        const leftValue = Number(left[index]) || 0;
        const rightValue = Number(right[index]) || 0;
        dot += leftValue * rightValue;
        leftNorm += leftValue * leftValue;
        rightNorm += rightValue * rightValue;
    }
    return leftNorm > 1e-12 && rightNorm > 1e-12
        ? dot / Math.sqrt(leftNorm * rightNorm)
        : 0;
}

class RiverMemoEngine {
    constructor(v10Engine, options = {}) {
        if (!v10Engine) {
            throw new TypeError('RiverMemoEngine requires a TagMemoV10Engine runtime');
        }
        this.runtime = v10Engine;
        this.config = options.config || {};
    }

    updateConfig(config = {}) {
        this.config = config || {};
    }

    rebindDatabase(db) {
        this.runtime.rebindDatabase(db);
    }

    getArtifactSnapshot(options = {}) {
        return this.runtime.getArtifactSnapshot(options);
    }

    _computeAnchorScores(localDomain, curves) {
        const tagIds = Array.isArray(localDomain?.ids)
            ? [...new Set(localDomain.ids
                .map(Number)
                .filter(id => Number.isFinite(id) && id > 0))]
            : [];
        const chunkIds = [...new Set(
            (Array.isArray(curves) ? curves : [])
                .map(curve => Number(curve?.chunkId))
                .filter(id => Number.isFinite(id) && id > 0)
        )];
        const scores = new Map();
        if (tagIds.length === 0 || chunkIds.length === 0 || !this.runtime.db?.prepare) {
            return scores;
        }

        // 两组 IN 参数同时存在，使用保守的双层分块以兼容 SQLite 参数上限。
        // Tag 批次互不重叠，因此各批 COUNT(DISTINCT tag_id) 可以安全相加。
        const hitsByChunkId = new Map();
        const batchSize = 200;
        for (let tagOffset = 0; tagOffset < tagIds.length; tagOffset += batchSize) {
            const tagBatch = tagIds.slice(tagOffset, tagOffset + batchSize);
            const tagPlaceholders = tagBatch.map(() => '?').join(',');
            for (
                let chunkOffset = 0;
                chunkOffset < chunkIds.length;
                chunkOffset += batchSize
            ) {
                const chunkBatch = chunkIds.slice(
                    chunkOffset,
                    chunkOffset + batchSize
                );
                const chunkPlaceholders = chunkBatch.map(() => '?').join(',');
                const rows = this.runtime.db.prepare(`
                    SELECT c.id AS chunk_id,
                           COUNT(DISTINCT ft.tag_id) AS hits
                    FROM chunks c
                    JOIN file_tags ft ON ft.file_id = c.file_id
                    WHERE ft.tag_id IN (${tagPlaceholders})
                      AND c.id IN (${chunkPlaceholders})
                    GROUP BY c.id
                `).all(...tagBatch, ...chunkBatch);
                for (const row of rows) {
                    const chunkId = Number(row.chunk_id);
                    const hits = Math.max(0, Number(row.hits) || 0);
                    hitsByChunkId.set(
                        chunkId,
                        (hitsByChunkId.get(chunkId) || 0) + hits
                    );
                }
            }
        }

        const maximumHits = Math.max(0, ...hitsByChunkId.values());
        if (maximumHits <= 0) return scores;
        for (const [chunkId, hits] of hitsByChunkId.entries()) {
            scores.set(chunkId, hits / maximumHits);
        }
        return scores;
    }

    measureOmega(queryState, options = {}) {
        const artifact = options.artifact
            || this.runtime.getArtifactSnapshot({ buildIfMissing: false });
        const config = {
            ...(artifact?.effectiveConfig?.riverObservability || {}),
            ...(this.config?.riverObservability || {}),
            ...(options.config || {})
        };
        return computeRiverObservability(queryState, {
            ...config,
            structRoleMinOmega:
                options.structRoleMinOmega
                ?? artifact?.effectiveConfig?.dstc?.topologyV3StructRoleMinOmega
        });
    }

    _nativeConfig(artifact, options = {}) {
        const candidate = {
            ...(artifact.effectiveConfig?.candidateSuperset || {}),
            ...(this.config?.candidateSuperset || {}),
            ...(options.candidateSuperset || {})
        };
        const path = {
            ...(artifact.effectiveConfig?.pathGeometry || {}),
            ...(options.pathEvaluation || {})
        };
        const relative = {
            ...(artifact.effectiveConfig?.relativeTopology || {}),
            ...(options.pathEvaluation?.relativeTopology || {})
        };
        const omega = {
            ...(artifact.effectiveConfig?.riverObservability || {}),
            ...(this.config?.riverObservability || {}),
            ...(options.riverObservability || {})
        };
        const anchor = {
            ...(artifact.effectiveConfig?.directAnchor || {}),
            ...(this.config?.directAnchor || {})
        };
        const dstc = {
            ...(artifact.effectiveConfig?.dstc || {}),
            ...(options.dstc || {})
        };
        return {
            queryK: candidate.queryK,
            denoisedK: candidate.denoisedK ?? candidate.queryK,
            localFieldK: candidate.localFieldK,
            transferFieldK: candidate.transferFieldK,
            bm25K: candidate.bm25K,
            anchorK: candidate.anchorK,
            maxUnionCandidates: candidate.maxUnionCandidates,
            localWeight: path.localWeight,
            transferWeight: path.transferWeight,
            directionFloor: path.directionFloor,
            closureFloor: path.closureFloor,
            semanticNodeThreshold: relative.semanticNodeThreshold,
            relativeDistanceTemperature: relative.relativeDistanceTemperature,
            reverseDirectionCredit: relative.reverseDirectionCredit,
            minimumRiverEdgeFlow: relative.minimumRiverEdgeFlow,
            maximumRiverEdges: relative.maximumRiverEdges,
            nodeOnlyReliabilityCap: relative.nodeOnlyReliabilityCap,
            kappaEdge: omega.kappaEdge,
            kappaRatio: omega.kappaRatio,
            omegaEpsilon: omega.epsilon,
            collapsedThreshold: omega.collapsedThreshold,
            sparseThreshold: omega.sparseThreshold,
            semanticAnchorThreshold: anchor.semanticThreshold,
            semanticAnchorDiscount: anchor.semanticDiscount,
            specificityFloor: anchor.specificityFloor,
            rarityFloor: anchor.rarityFloor,
            reliabilitySeedSaturation: anchor.reliabilitySeedSaturation,
            fallbackReliabilityCap: anchor.fallbackReliabilityCap,
            topologyBonusCap: dstc.topologyBonusCap,
            topologyPathSaturation: dstc.topologyPathSaturation,
            conditionalBandwidth: dstc.topologyV2ConditionalBandwidth,
            conditionalClosureBandwidth: dstc.topologyV2ClosureBandwidth,
            conditionalDirectBandwidth: dstc.topologyV2DirectBandwidth,
            minimumPeers: dstc.topologyV2MinimumPeers,
            minimumEffectivePeers: dstc.topologyV2MinimumEffectivePeers,
            innovationConfidenceZ: dstc.topologyV2InnovationConfidenceZ,
            innovationScale: dstc.topologyV2InnovationScale,
            omegaGamma: dstc.topologyV3OmegaGamma,
            structRoleMinOmega: dstc.topologyV3StructRoleMinOmega,
            anchorBonusCap: dstc.topologyV3AnchorBonusCap,
            anchorActivationZ: dstc.topologyV3AnchorActivationZ,
            anchorActivationFloor: dstc.topologyV3AnchorActivationFloor,
            anchorSaturation: dstc.topologyV3AnchorSaturation,
            anchorFrontierContrast: dstc.topologyV3AnchorFrontierContrast,
            anchorFrontierAbsFloor: dstc.topologyV3AnchorFrontierAbsFloor
        };
    }

    async _rerankNative(query, inputCandidates, agentContext, options, artifact, prepared) {
        const queryState = prepared.queryState;
        const river = queryState.queryRiverGraph || {};
        const fieldProvenance = (
            Array.isArray(queryState.sourceObservation?.fieldProvenance)
                ? queryState.sourceObservation.fieldProvenance
                : []
        ).map(entry => ({
            id: Number(entry?.[0]),
            hop: Number(entry?.[1]?.hop) || 0,
            sourceType: String(entry?.[1]?.sourceType || '')
        }));
        const dbPath = String(
            options.dbPath
            || this.runtime.db?.name
            || this.runtime.db?.path
            || ''
        );
        if (!dbPath || dbPath === ':memory:') {
            const error = new Error(
                'RiverMemo native Topology V3 requires a file-backed SQLite database path.'
            );
            error.code = 'RIVERMEMO_NATIVE_DB_PATH_UNAVAILABLE';
            throw error;
        }

        const payload = {
            dimension: Number(this.runtime.config.dimension),
            topK: Math.max(
                1,
                Math.floor(Number(options.topK) || inputCandidates.length)
            ),
            includeTrace: options.includeTrace === true,
            query: {
                text: String(query?.text || ''),
                vector: Array.from(query?.vector || options.vector || [])
            },
            denoisedVector: Array.from(prepared.denoisedVector),
            localVector: Array.from(prepared.localVector),
            transferVector: Array.from(prepared.transferVector),
            candidates: inputCandidates.map(candidate => ({
                id: candidateId(candidate),
                score: Number(candidate.score) || 0,
                hybridScore: Number(candidate.hybridScore) || 0,
                vectorScore: Number(candidate.vectorScore) || 0,
                bm25Score: Number(candidate.bm25Score) || 0,
                anchorScore: Number(candidate.anchorScore) || 0
            })).filter(candidate => candidate.id !== null),
            queryState: {
                queryId: queryState.queryId,
                sourceField: queryState.sourceField || [],
                localField: queryState.localField || [],
                transferField: queryState.transferField || [],
                localDomainIds: queryState.localDomain?.ids || [],
                transferDomainIds: queryState.transferDomain?.ids || [],
                riverNodes: Array.isArray(river.nodes) ? river.nodes : [],
                riverEdges: Array.isArray(river.edges) ? river.edges : [],
                fieldProvenance,
                completeObservation:
                    queryState.sourceObservation?.diagnostics
                        ?.completeObservation === true
            },
            allowedFileIds: Array.isArray(agentContext.allowedFileIds)
                ? agentContext.allowedFileIds.map(Number).filter(Number.isFinite)
                : [],
            config: this._nativeConfig(artifact, options)
        };
        const nativeStartedAt = Date.now();
        const nativePayload = await getNativeTopologyV3()(
            dbPath,
            artifact.artifactSig,
            JSON.stringify(payload)
        );
        const nativeResult = JSON.parse(nativePayload);
        const inputById = new Map(
            inputCandidates
                .map(candidate => [candidateId(candidate), candidate])
                .filter(([id]) => id !== null)
        );
        const sourceObservation = queryState.sourceObservation || {};
        const queryMatchedTags = Object.freeze(
            [...new Set(
                (Array.isArray(sourceObservation.matchedTags)
                    ? sourceObservation.matchedTags
                    : [])
                    .map(tag => String(tag || '').trim())
                    .filter(Boolean)
            )]
        );
        const queryCoreTagsMatched = Object.freeze(
            [...new Set(
                (Array.isArray(sourceObservation.coreTagsMatched)
                    ? sourceObservation.coreTagsMatched
                    : [])
                    .map(tag => String(tag || '').trim())
                    .filter(Boolean)
            )]
        );
        const queryCoreTagSet = new Set(
            queryCoreTagsMatched.map(tag => tag.toLowerCase())
        );
        const includeTrace = options.includeTrace === true;
        const results = (Array.isArray(nativeResult.results)
            ? nativeResult.results
            : []
        ).map(item => {
            const original = inputById.get(Number(item.chunkId)) || {};
            const matchedTags = Object.freeze(
                [...new Set(
                    (Array.isArray(item.matchedTags) ? item.matchedTags : [])
                        .map(tag => String(tag || '').trim())
                        .filter(Boolean)
                )]
            );
            const stable = {
                ...original,
                id: Number(item.chunkId),
                chunkId: Number(item.chunkId),
                rank: Number(item.rank),
                score: clamp01(item.score),
                originalScore: Number(item.originalScore) || 0,
                baseScore: clamp01(item.baseScore),
                topologyBonus: clamp01(item.topologyBonus),
                anchorBonus: clamp01(item.anchorBonus),
                matchedTags,
                coreTagsMatched: Object.freeze(
                    matchedTags.filter(tag =>
                        queryCoreTagSet.has(tag.toLowerCase())
                    )
                ),
                tagMatchCount: matchedTags.length,
                role: item.role || 'thematic_neighbor',
                omega: clamp01(item.omega),
                riverRegime:
                    item.riverRegime
                    || nativeResult.omega?.regime
                    || 'collapsed',
                candidateSources: Object.freeze(
                    (Array.isArray(item.candidateSources)
                        ? item.candidateSources
                        : [])
                        .map(source => typeof source === 'string'
                            ? Object.freeze({ source })
                            : Object.freeze({ ...source }))
                )
            };
            if (!includeTrace) return Object.freeze(stable);
            return Object.freeze({
                ...stable,
                topologyV3: item.topologyV3 || null,
                topologyV2: null,
                relativeTopology: item.relativeTopology || null,
                geometry: item.geometry || null,
                observables: item.observables || null
            });
        });

        return Object.freeze({
            schema: RESULT_SCHEMA,
            version: VERSION,
            algorithmVersion: ALGORITHM_VERSION,
            artifactSig: artifact.artifactSig,
            artifactGeneration: artifact.generation,
            queryId: queryState.queryId,
            omega: Object.freeze(nativeResult.omega || {}),
            queryTags: Object.freeze({
                matchedTags: queryMatchedTags,
                coreTagsMatched: queryCoreTagsMatched,
                sourceMode: sourceObservation.sourceMode || null
            }),
            results: Object.freeze(results),
            diagnostics: Object.freeze({
                offeredCandidates: inputCandidates.length,
                projectedCandidates:
                    nativeResult.diagnostics?.projectedCandidates || 0,
                selectedCandidates:
                    nativeResult.diagnostics?.selectedCandidates || 0,
                rankedCandidates:
                    nativeResult.diagnostics?.rankedCandidates || 0,
                returnedCandidates: results.length,
                nativeTopologyV3: Object.freeze({
                    ...(nativeResult.diagnostics || {}),
                    ffiTotalMs: Date.now() - nativeStartedAt
                }),
                exactDerivedAssets:
                    this.runtime.getDerivedAssetDiagnostics?.() || null,
                fieldProjection: prepared.fieldProjectionDiagnostics || null,
                preparationTimings: prepared.preparationTimings || null,
                field: queryState.fieldDiagnostics,
                queryProfile: Object.freeze({
                    mode: nativeResult.queryMode || null,
                    backend: 'rust-rayon'
                }),
                anchorBatchAvailable: true
            })
        });
    }

    async rerank(query, candidates, agentContext = {}, options = {}) {
        const rerankStartedAt = Date.now();
        const stageTimings = {};
        let stageStartedAt = rerankStartedAt;
        const markStage = name => {
            const now = Date.now();
            stageTimings[name] = now - stageStartedAt;
            stageStartedAt = now;
        };
        const inputCandidates = Array.isArray(candidates) ? candidates : [];
        if (inputCandidates.length === 0) {
            return Object.freeze({
                schema: RESULT_SCHEMA,
                version: VERSION,
                algorithmVersion: ALGORITHM_VERSION,
                artifactSig: null,
                queryId: null,
                omega: null,
                results: Object.freeze([]),
                diagnostics: Object.freeze({
                    offeredCandidates: 0,
                    rankedCandidates: 0,
                    reason: 'empty-candidate-set'
                })
            });
        }

        const artifact = options.artifact || this.runtime.getArtifactSnapshot();
        if (!artifact) {
            const error = new Error('RiverMemo artifact is unavailable');
            error.code = 'RIVERMEMO_ARTIFACT_UNAVAILABLE';
            throw error;
        }

        const queryVectorRaw = query?.vector || options.vector;
        const queryVector = queryVectorRaw instanceof Float32Array
            ? queryVectorRaw
            : new Float32Array(queryVectorRaw || []);
        if (queryVector.length !== Number(this.runtime.config.dimension)) {
            throw new RangeError(
                `RiverMemo query vector dimension must be ${this.runtime.config.dimension}, got ${queryVector.length}`
            );
        }

        const prepared = this.runtime.prepareQuery(
            query,
            agentContext,
            {
                ...options,
                artifact
            }
        );
        markStage('prepareQueryMs');
        if (
            !prepared?.queryState
            || !prepared.denoisedVector
            || !prepared.localVector
            || !prepared.transferVector
        ) {
            const error = new Error('RiverMemo could not construct the continuous query fields');
            error.code = 'RIVERMEMO_QUERY_FIELD_UNAVAILABLE';
            throw error;
        }

        // Topology V3 的候选投影、路径几何、相对拓扑、DSTC、Direct Anchor、
        // 批级条件创新和最终排序全部由 Rust/Rayon 在一个 N-API 调用内完成。
        // JS 仅准备查询连续场并消费稳定结果，禁止再进入旧的逐候选计算链。
        return await this._rerankNative(
            query,
            inputCandidates,
            agentContext,
            options,
            artifact,
            prepared
        );

        /* istanbul ignore next -- retired JS Topology V3 implementation */
        const fieldWorkspace = this.runtime.createFieldWorkspace(
            prepared.queryState
        );
        const semanticSimilarityCache = new Map();

        // 一次投影取得 Chunk/Tag 向量及权限判定所需的 fileId。
        const projected = this.runtime.projectCandidateCurves(
            inputCandidates,
            { artifact }
        );
        markStage('projectCandidatesMs');
        const inputById = new Map(
            inputCandidates
                .map(candidate => [candidateId(candidate), candidate])
                .filter(([id]) => id !== null)
        );
        const computedAnchorScores = this._computeAnchorScores(
            prepared.queryState.localDomain,
            projected.curves
        );
        markStage('anchorSqlMs');
        const enrichedById = new Map();

        for (const curve of projected.curves) {
            if (!curve.chunkVector) continue;
            const source = inputById.get(Number(curve.chunkId)) || {};
            const id = Number(curve.chunkId);
            enrichedById.set(id, {
                ...source,
                id,
                chunkId: id,
                queryScore: cosine(queryVector, curve.chunkVector),
                denoisedFieldScore: cosine(
                    prepared.denoisedVector,
                    curve.chunkVector
                ),
                localFieldScore: cosine(
                    prepared.localVector,
                    curve.chunkVector
                ),
                transferFieldScore: cosine(
                    prepared.transferVector,
                    curve.chunkVector
                ),
                bm25Score: Math.max(0, Number(source.bm25Score) || 0),
                anchorScore: Math.max(
                    Math.max(0, Number(source.anchorScore) || 0),
                    computedAnchorScores.get(id) || 0
                )
            });
        }

        const candidateConfig = {
            ...(artifact.effectiveConfig?.candidateSuperset || {}),
            ...(this.config?.candidateSuperset || {}),
            ...(options.candidateSuperset || {})
        };
        const rank = (field, limit) => [...enrichedById.values()]
            // 与 LightMemo 已验证管线保持一致：零分/负分不是该地图的有效激活，
            // 尤其不能让缺失的 BM25/Anchor 伪装成额外候选来源。
            .filter(candidate =>
                Number.isFinite(candidate[field]) && candidate[field] > 0
            )
            .sort((left, right) =>
                (right[field] - left[field]) || (left.id - right.id)
            )
            .slice(0, Math.max(1, Math.floor(Number(limit) || 100)))
            .map(candidate => ({
                ...candidate,
                score: candidate[field]
            }));
        const sourceCandidates = {
            query_knn: rank('queryScore', candidateConfig.queryK),
            denoised_field_knn: rank(
                'denoisedFieldScore',
                candidateConfig.denoisedK ?? candidateConfig.queryK
            ),
            local_field_knn: rank(
                'localFieldScore',
                candidateConfig.localFieldK
            ),
            transfer_field_knn: rank(
                'transferFieldScore',
                candidateConfig.transferFieldK
            ),
            bm25: rank('bm25Score', candidateConfig.bm25K),
            anchor_direct: rank('anchorScore', candidateConfig.anchorK)
        };
        const superset = this.runtime.buildCandidateSuperset(
            sourceCandidates,
            {
                artifact,
                config: candidateConfig
            }
        );
        markStage('candidateSupersetMs');
        const selectedById = new Map(
            superset.candidates.map(candidate => [Number(candidate.chunkId), candidate])
        );

        // 复用第一次投影的向量，避免候选超集形成后再次访问 SQLite。
        const selectedCurves = projected.curves
            .filter(curve => selectedById.has(Number(curve.chunkId)))
            .map(curve => {
                const candidate = selectedById.get(Number(curve.chunkId));
                return Object.freeze({
                    ...curve,
                    candidateSources: candidate.candidateSources,
                    candidateUnionScore: candidate.candidateUnionScore,
                    candidateUnionRank: candidate.candidateUnionRank,
                    queryScore: candidate.queryScore,
                    denoisedFieldScore: candidate.denoisedFieldScore,
                    localFieldScore: candidate.localFieldScore,
                    transferFieldScore: candidate.transferFieldScore,
                    bm25Score: candidate.bm25Score,
                    anchorScore: candidate.anchorScore
                });
            });

        const pathBatch = this.runtime.evaluateCandidateCurves(
            selectedCurves,
            prepared.queryState,
            {
                artifact,
                fieldWorkspace,
                semanticSimilarityCache,
                ...(options.pathEvaluation || {})
            }
        );
        markStage('pathAndRelativeTopologyMs');
        const allowedFileIds = new Set(
            Array.isArray(agentContext.allowedFileIds)
                ? agentContext.allowedFileIds.map(Number).filter(Number.isFinite)
                : []
        );
        const explicitScope = allowedFileIds.size > 0;
        const visibilityEligibility =
            typeof options.visibilityEligibility === 'function'
                ? options.visibilityEligibility
                : curve => !explicitScope
                    || allowedFileIds.has(Number(curve.fileId));
        const dstcBatch = this.runtime.computeDstcObservables(
            pathBatch,
            prepared.queryState,
            {
                artifact,
                fieldWorkspace,
                identityEligibility: options.identityEligibility,
                visibilityEligibility,
                ...(options.dstc || {})
            }
        );
        markStage('dstcMs');
        const omega = this.measureOmega(prepared.queryState, {
            artifact,
            config: options.riverObservability
        });
        const scored = this.runtime.scoreExperimentArm(
            dstcBatch,
            'topology_v3',
            {
                artifact,
                queryState: prepared.queryState,
                queryText: String(query?.text || ''),
                riverObservability: omega,
                semanticSimilarityCache
            }
        );
        markStage('topologyV3ScoreMs');
        const requestedK = Math.max(
            1,
            Math.floor(Number(options.topK) || scored.results.length)
        );
        const sourceObservation = prepared.queryState.sourceObservation || {};
        const queryMatchedTags = Object.freeze(
            Array.isArray(sourceObservation.matchedTags)
                ? [...new Set(sourceObservation.matchedTags
                    .map(tag => String(tag || '').trim())
                    .filter(Boolean))]
                : []
        );
        const queryCoreTagsMatched = Object.freeze(
            Array.isArray(sourceObservation.coreTagsMatched)
                ? [...new Set(sourceObservation.coreTagsMatched
                    .map(tag => String(tag || '').trim())
                    .filter(Boolean))]
                : []
        );
        const queryCoreTagSet = new Set(
            queryCoreTagsMatched.map(tag => tag.toLowerCase())
        );
        const includeTrace = options.includeTrace === true;
        const results = scored.results
            .slice(0, requestedK)
            .map((item, index) => {
                const v3 = item.armResult.topologyV3 || {};
                const original = inputById.get(Number(item.curve.chunkId)) || {};
                // projectCandidateCurves 已经批量读取了所有候选文件的 Tag；
                // 在此直接复用曲线数据，禁止为了 Info 再次访问 SQLite。
                const matchedTags = Object.freeze(
                    [...new Set(
                        (Array.isArray(item.curve.tagCurve)
                            ? item.curve.tagCurve
                            : [])
                            .map(tag => String(tag?.name || '').trim())
                            .filter(Boolean)
                    )]
                );
                const coreTagsMatched = Object.freeze(
                    matchedTags.filter(tag =>
                        queryCoreTagSet.has(tag.toLowerCase())
                    )
                );
                const stable = {
                    ...original,
                    id: Number(item.curve.chunkId),
                    chunkId: Number(item.curve.chunkId),
                    rank: index + 1,
                    score: clamp01(item.armResult.score),
                    originalScore: Number(
                        original.score
                        ?? original.hybridScore
                        ?? original.vectorScore
                        ?? 0
                    ) || 0,
                    baseScore: clamp01(item.armResult.baseScore),
                    topologyBonus: clamp01(v3.gatedV2Bonus),
                    anchorBonus: clamp01(v3.anchorBonus),
                    matchedTags,
                    coreTagsMatched,
                    tagMatchCount: matchedTags.length,
                    role: v3.role || 'thematic_neighbor',
                    omega: clamp01(v3.omega),
                    riverRegime: v3.regime || omega.regime,
                    candidateSources: item.curve.candidateSources
                };
                if (!includeTrace) return Object.freeze(stable);
                return Object.freeze({
                    ...stable,
                    topologyV3: v3,
                    topologyV2: item.armResult.topologyV2 || null,
                    relativeTopology: item.relativeTopology || null,
                    geometry: item.geometry || null,
                    observables: item.observables || null
                });
            });

        return Object.freeze({
            schema: RESULT_SCHEMA,
            version: VERSION,
            algorithmVersion: ALGORITHM_VERSION,
            artifactSig: artifact.artifactSig,
            artifactGeneration: artifact.generation,
            queryId: prepared.queryState.queryId,
            omega,
            queryTags: Object.freeze({
                matchedTags: queryMatchedTags,
                coreTagsMatched: queryCoreTagsMatched,
                sourceMode: sourceObservation.sourceMode || null
            }),
            results: Object.freeze(results),
            diagnostics: Object.freeze({
                offeredCandidates: inputCandidates.length,
                projectedCandidates: projected.curves.length,
                selectedCandidates: selectedCurves.length,
                rankedCandidates: scored.results.length,
                returnedCandidates: results.length,
                candidateSuperset: superset.diagnostics,
                projection: projected.diagnostics,
                anchorActivatedCandidates: computedAnchorScores.size,
                semanticSimilarityCacheEntries:
                    semanticSimilarityCache.size,
                exactDerivedAssets:
                    this.runtime.getDerivedAssetDiagnostics?.() || null,
                fieldProjection: prepared.fieldProjectionDiagnostics || null,
                preparationTimings: prepared.preparationTimings || null,
                stageTimings: Object.freeze({
                    ...stageTimings,
                    totalMs: Date.now() - rerankStartedAt
                }),
                field: prepared.queryState.fieldDiagnostics,
                queryProfile: scored.diagnostics.queryProfile,
                anchorBatchAvailable: scored.diagnostics.anchorBatchAvailable
            })
        });
    }
}

RiverMemoEngine.VERSION = VERSION;
RiverMemoEngine.ALGORITHM_VERSION = ALGORITHM_VERSION;
RiverMemoEngine.RESULT_SCHEMA = RESULT_SCHEMA;

module.exports = RiverMemoEngine;