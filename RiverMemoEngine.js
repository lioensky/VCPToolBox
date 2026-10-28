'use strict';

const { cleanRiverConfig } = require('./modules/knowledgeBase/memoConfig');
const {
    computeRiverObservability
} = require('./modules/tagmemoV10/riverObservability');

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

    getArtifactSnapshot(options = {}) {
        return this.runtime.getArtifactSnapshot(options);
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
                ?? cleanRiverConfig(artifact?.effectiveConfig).topology?.structRoleMinOmega
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
        const topology = {
            ...(cleanRiverConfig(artifact.effectiveConfig).topology || {}),
            ...(cleanRiverConfig(options).topology || {})
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
            topologyBonusCap: topology.topologyBonusCap,
            topologyPathSaturation: topology.topologyPathSaturation,
            conditionalBandwidth: topology.conditionalBandwidth,
            conditionalClosureBandwidth: topology.conditionalClosureBandwidth,
            conditionalDirectBandwidth: topology.conditionalDirectBandwidth,
            minimumPeers: topology.minimumPeers,
            minimumEffectivePeers: topology.minimumEffectivePeers,
            innovationConfidenceZ: topology.innovationConfidenceZ,
            innovationScale: topology.innovationScale,
            omegaGamma: topology.omegaGamma,
            structRoleMinOmega: topology.structRoleMinOmega,
            anchorBonusCap: topology.anchorBonusCap,
            anchorActivationZ: topology.anchorActivationZ,
            anchorActivationFloor: topology.anchorActivationFloor,
            anchorSaturation: topology.anchorSaturation,
            anchorFrontierContrast: topology.anchorFrontierContrast,
            anchorFrontierAbsFloor: topology.anchorFrontierAbsFloor
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
        const dbPath = String(options.dbPath || '');
        if (!dbPath || dbPath === ':memory:') {
            const error = new Error(
                'RiverMemo native Topology V3 requires a file-backed SQLite database path.'
            );
            error.code = 'RIVERMEMO_NATIVE_DB_PATH_UNAVAILABLE';
            throw error;
        }

        const observationHandle = typeof options.observationHandle === 'string'
            && options.observationHandle
            ? options.observationHandle
            : null;
        const payload = {
            observationHandle,
            dimension: Number(this.runtime.config.dimension),
            topK: Math.max(
                1,
                Math.floor(Number(options.topK) || inputCandidates.length)
            ),
            includeTrace: options.includeTrace === true,
            query: {
                text: String(query?.text || ''),
                vector: observationHandle
                    ? []
                    : Array.from(query?.vector || options.vector || [])
            },
            ...(observationHandle ? {} : {
                denoisedVector: Array.from(prepared.denoisedVector),
                localVector: Array.from(prepared.localVector),
                transferVector: Array.from(prepared.transferVector)
            }),
            candidates: inputCandidates.map(candidate => ({
                id: candidateId(candidate),
                score: Number(candidate.score) || 0,
                hybridScore: Number(candidate.hybridScore) || 0,
                vectorScore: Number(candidate.vectorScore) || 0,
                bm25Score: Number(candidate.bm25Score) || 0,
                timeScore: Number(candidate.timeScore) || 0,
                anchorScore: Number(candidate.anchorScore) || 0
            })).filter(candidate => candidate.id !== null),
            queryState: {
                queryId: queryState.queryId,
                completeObservation: observationHandle
                    ? true
                    : queryState.sourceObservation?.diagnostics
                        ?.completeObservation === true,
                ...(observationHandle ? {} : {
                    sourceField: queryState.sourceField || [],
                    localField: queryState.localField || [],
                    transferField: queryState.transferField || [],
                    localDomainIds: queryState.localDomain?.ids || [],
                    transferDomainIds: queryState.transferDomain?.ids || [],
                    riverNodes: Array.isArray(river.nodes) ? river.nodes : [],
                    riverEdges: Array.isArray(river.edges) ? river.edges : [],
                    fieldProvenance
                })
            },
            allowedFileIds: Array.isArray(agentContext.allowedFileIds)
                ? agentContext.allowedFileIds.map(Number).filter(Number.isFinite)
                : [],
            config: this._nativeConfig(artifact, options)
        };
        const nativeStartedAt = Date.now();
        const inputJson = JSON.stringify(payload);
        const tagIndex = this.runtime.tagIndex;
        const nativeKnowledgeRuntime = options.nativeKnowledgeRuntime || null;
        const jointRequested = options.nativeJointQuery === true;
        let jointUsed = false;
        let jointFallbackReason = null;
        let nativePayload;

        if (jointRequested) {
            const hybridPlan = options.nativeHybridPlan
                && typeof options.nativeHybridPlan === 'object'
                ? options.nativeHybridPlan
                : null;
            const supplementalVectors = options.nativeSupplementalVectors instanceof Float32Array
                ? options.nativeSupplementalVectors
                : new Float32Array(options.nativeSupplementalVectors || []);
            const useHybridAbi = !!hybridPlan;
            const nativeMethodAvailable = nativeKnowledgeRuntime && (
                useHybridAbi
                    ? typeof nativeKnowledgeRuntime.executeRiverQueryHybrid === 'function'
                    : typeof nativeKnowledgeRuntime.executeRiverQuery === 'function'
            );
            if (!nativeMethodAvailable) {
                const error = new Error(
                    useHybridAbi
                        ? 'NativeKnowledgeRuntime hybrid River ABI is unavailable'
                        : 'NativeKnowledgeRuntime joint River ABI is unavailable'
                );
                error.code = 'NATIVE_RIVER_QUERY_ABI_UNAVAILABLE';
                if (options.nativeJointFallbackToLegacy === false) throw error;
                jointFallbackReason = error.code;
            } else {
                try {
                    const diaryNames = [...new Set(
                        (Array.isArray(agentContext.diaryNames)
                            ? agentContext.diaryNames
                            : []
                        ).map(name => String(name || '').trim()).filter(Boolean)
                    )];
                    if (diaryNames.length === 0) {
                        const error = new Error(
                            'Native joint River query requires an explicit diary scope'
                        );
                        error.code = 'NATIVE_RIVER_QUERY_EMPTY_DIARY_SCOPE';
                        throw error;
                    }
                    const annVector = options.nativeAnnVector || query?.vector;
                    const queryVector = annVector instanceof Float32Array
                        ? annVector
                        : new Float32Array(annVector || []);
                    const nativePerIndexK = Math.max(
                        1,
                        Math.floor(Number(options.nativePerIndexK) || 300)
                    );
                    const nativeCandidateK = Math.max(
                        1,
                        Math.floor(Number(
                            options.nativeCandidateK
                            ?? inputCandidates.length
                            ?? 300
                        ) || 300)
                    );
                    const nativeSemanticThreshold = Math.max(
                        -1,
                        Math.min(
                            1,
                            Number(options.nativeSemanticThreshold) || 0.92
                        )
                    );

                    if (useHybridAbi) {
                        nativePayload = await nativeKnowledgeRuntime.executeRiverQueryHybrid(
                            dbPath,
                            artifact.artifactSig,
                            inputJson,
                            diaryNames,
                            queryVector,
                            supplementalVectors,
                            JSON.stringify(hybridPlan),
                            nativePerIndexK,
                            nativeCandidateK,
                            nativeSemanticThreshold
                        );
                    } else {
                        nativePayload = await nativeKnowledgeRuntime.executeRiverQuery(
                            dbPath,
                            artifact.artifactSig,
                            inputJson,
                            diaryNames,
                            queryVector,
                            nativePerIndexK,
                            nativeCandidateK,
                            nativeSemanticThreshold
                        );
                    }
                    jointUsed = true;
                } catch (error) {
                    if (options.nativeJointFallbackToLegacy === false) throw error;
                    jointFallbackReason =
                        error.code || error.message || 'native-joint-failed';
                    console.warn(
                        `[RiverMemo] Native joint query failed; falling back to ` +
                        `legacy native Topology input: ${error.message}`
                    );
                }
            }
        }

        if (!jointUsed) {
            if (typeof tagIndex?.rerankRivermemoTopologyV3 !== 'function') {
                const error = new Error(
                    'RiverMemo requires the VexusIndex-owned native runtime; rebuild rust-vexus-lite.'
                );
                error.code = 'RIVERMEMO_UNIFIED_NATIVE_RUNTIME_UNAVAILABLE';
                throw error;
            }
            nativePayload = await tagIndex.rerankRivermemoTopologyV3(
                dbPath,
                artifact.artifactSig,
                inputJson
            );
        }
        const nativeResult = JSON.parse(nativePayload);
        const memoRuntimeStats = typeof tagIndex?.memoRuntimeStats === 'function'
            ? tagIndex.memoRuntimeStats()
            : null;
        const inputById = new Map(
            inputCandidates
                .map(candidate => [candidateId(candidate), candidate])
                .filter(([id]) => id !== null)
        );

        // 联合查询优先消费 Rust 在同一读事务内回填的最终正文。
        // 仅旧 ABI 缺少该字段时才经异步门面补水；不得复用调用方旧正文。
        if (jointUsed) {
            inputById.clear();
            for (const item of Array.isArray(nativeResult.results) ? nativeResult.results : []) {
                const id = Number(item?.chunkId ?? item?.id);
                const row = item?.hydratedChunk;
                if (!Number.isSafeInteger(id) || id <= 0 || !row || typeof row !== 'object') continue;
                inputById.set(id, {
                    ...row,
                    id,
                    chunkId: id,
                    fullPath: row.fullPath || row.sourceFile,
                    source: row.source || 'rag'
                });
            }
        }
        if (jointUsed && typeof options.hydrateChunksByIds === 'function') {
            const finalIds = [...new Set(
                (Array.isArray(nativeResult.results)
                    ? nativeResult.results
                    : []
                ).map(item => Number(item?.chunkId ?? item?.id))
                    .filter(id => Number.isSafeInteger(id) && id > 0 && !inputById.has(id))
            )];
            if (finalIds.length > 0) {
                const rows = await options.hydrateChunksByIds(finalIds);
                for (const row of Array.isArray(rows) ? rows : []) {
                    const id = Number(row?.id ?? row?.chunkId);
                    if (!Number.isSafeInteger(id) || id <= 0) continue;
                    inputById.set(id, {
                        ...row,
                        id,
                        chunkId: id,
                        fullPath: row.fullPath || row.sourceFile,
                        source: row.source || 'rag'
                    });
                }
            }
        }
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
            const rawCandidateSources = (Array.isArray(item.candidateSources)
                ? item.candidateSources
                : []
            ).map(source => typeof source === 'string'
                ? source
                : String(source?.source || '')
            ).filter(Boolean);
            const resolvedSource = rawCandidateSources.includes('time')
                ? 'time'
                : (rawCandidateSources.includes('bm25')
                    ? (options.nativeHybridPlan?.bm25Mode === 'body'
                        ? 'bm25_body'
                        : 'bm25_tag')
                    : (original.source || 'rag'));
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
                source: resolvedSource,
                rank: Number(item.rank),
                score: clamp01(item.score),
                originalScore: Number(item.originalScore) || 0,
                baseScore: clamp01(item.baseScore),
                fieldScore: clamp01(item.fieldScore),
                fieldResonanceBonus: clamp01(item.fieldResonanceBonus),
                pathBonus: clamp01(item.pathBonus),
                graphBonus: clamp01(item.graphBonus),
                scoreClipping: Math.max(0, Number(item.scoreClipping) || 0),
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
                    rawCandidateSources
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
            algorithmVersion: nativeResult.algorithmVersion || ALGORITHM_VERSION,
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
                    ffiTotalMs: Date.now() - nativeStartedAt,
                    hybridPlanUsed: jointUsed && !!options.nativeHybridPlan,
                    runtimeOwnership: jointUsed
                        ? 'native-knowledge-runtime-joint'
                        : 'vexus-index-instance',
                    jointRequested,
                    jointUsed,
                    jointFallbackReason,
                    memoRuntime: memoRuntimeStats
                        ? Object.freeze({ ...memoRuntimeStats })
                        : null
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

        // 生产统一管线已经在 Rust MemoRuntime 内完成 Local/Transfer
        // scaled-resolvent、有效支持域和向量投影。禁止再次调用 JS
        // prepareQuery()/solveQueryState() 持有并遍历第二份 CSR。
        const prepared = options.nativePreparedQuery || null;
        if (!prepared) {
            const error = new Error(
                'RiverMemo requires Rust-native prepared dual fields'
            );
            error.code = 'RIVERMEMO_NATIVE_DUAL_FIELDS_UNAVAILABLE';
            throw error;
        }
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

        // 候选投影、路径几何、一对一拓扑、Direct Anchor、候选自身结构奖励
        // 和最终排序全部由 Rust/Rayon 在一个 N-API 调用内完成。
        // JS 仅准备查询连续场并消费稳定结果，禁止再进入旧的逐候选计算链。
        return await this._rerankNative(
            query,
            inputCandidates,
            agentContext,
            options,
            artifact,
            prepared
        );

    }
}

RiverMemoEngine.VERSION = VERSION;
RiverMemoEngine.ALGORITHM_VERSION = ALGORITHM_VERSION;
RiverMemoEngine.RESULT_SCHEMA = RESULT_SCHEMA;

module.exports = RiverMemoEngine;