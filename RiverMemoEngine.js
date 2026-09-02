'use strict';

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
        // 诊断标记：原生缓存按 Artifact 签名在首次成功请求时加载。
        // 这里只记录本门面观测到的状态，不复制或持有原生资产。
        this._nativeArtifactCacheObserved = false;
        this._nativeArtifactSigObserved = null;
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
                    const queryVector = query?.vector instanceof Float32Array
                        ? query.vector
                        : new Float32Array(query?.vector || []);
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
        this._nativeArtifactCacheObserved = true;
        this._nativeArtifactSigObserved = artifact.artifactSig;
        const inputById = new Map(
            inputCandidates
                .map(candidate => [candidateId(candidate), candidate])
                .filter(([id]) => id !== null)
        );

        // 联合路径没有把中间候选返回 JS。只按最终 Top-K ID 批量 hydrate
        // 正文和路径，恢复现有公共结果对象契约。
        if (jointUsed && this.runtime.db?.prepare) {
            const finalIds = [...new Set(
                (Array.isArray(nativeResult.results)
                    ? nativeResult.results
                    : []
                ).map(item => Number(item?.chunkId ?? item?.id))
                    .filter(id => Number.isSafeInteger(id) && id > 0)
            )];
            if (finalIds.length > 0) {
                const placeholders = finalIds.map(() => '?').join(',');
                const rows = this.runtime.db.prepare(`
                    SELECT c.id, c.content AS text, f.path AS sourceFile,
                           f.diary_name AS diaryName, f.id AS fileId
                    FROM chunks c
                    JOIN files f ON f.id = c.file_id
                    WHERE c.id IN (${placeholders})
                `).all(...finalIds);
                for (const row of rows) {
                    inputById.set(Number(row.id), {
                        id: Number(row.id),
                        chunkId: Number(row.id),
                        text: row.text,
                        sourceFile: row.sourceFile,
                        fullPath: row.sourceFile,
                        diaryName: row.diaryName,
                        fileId: Number(row.fileId),
                        source: 'rag'
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

    }
}

RiverMemoEngine.VERSION = VERSION;
RiverMemoEngine.ALGORITHM_VERSION = ALGORITHM_VERSION;
RiverMemoEngine.RESULT_SCHEMA = RESULT_SCHEMA;

module.exports = RiverMemoEngine;