'use strict';

const crypto = require('crypto');
const {
    hashStable,
    immutableSnapshot,
    createReadonlyCsr
} = require('./modules/tagmemoV10/immutable');
const { buildProvenanceView } = require('./modules/tagmemoV10/provenance');
const {
    createDualConditionedOperators
} = require('./modules/tagmemoV10/agentConditioner');
const { solveDualScaledFields } = require('./modules/tagmemoV10/scaledFieldSolver');
const { buildCandidateSuperset } = require('./modules/tagmemoV10/candidateSuperset');
const { projectCandidateCurves } = require('./modules/tagmemoV10/curveProjector');
const { evaluateCandidateCurves } = require('./modules/tagmemoV10/unifiedPathGeometry');
const {
    evaluateRelativeTopologyBatch
} = require('./modules/tagmemoV10/relativeTopologyMatcher');
const { computeDstcBatch } = require('./modules/tagmemoV10/dstcObservables');
const {
    computeRiverObservability
} = require('./modules/tagmemoV10/riverObservability');
const {
    computeDirectAnchorBatch
} = require('./modules/tagmemoV10/directAnchorReadout');
const {
    scoreExperimentArm,
    runExperimentArms
} = require('./modules/tagmemoV10/experimentArms');

const VERSION = 'v10_alpha';
const ALGORITHM_VERSION = 'v10.alpha.1';
const ARTIFACT_SCHEMA = 'tagmemo-v10-alpha-artifact-v1';
const QUERY_TRACE_SCHEMA = 'tagmemo-v10-alpha-query-trace-v1';

class TagMemoV10Engine {
    constructor(db, tagIndex, config, ragParams, options = {}) {
        this.db = db;
        this.tagIndex = tagIndex;
        this.config = config || {};
        this.ragParams = ragParams || {};
        this.v9Engine = options.v9Engine || null;
        this._activeArtifact = null;
        this._artifactGeneration = 0;
    }

    updateRagParams(ragParams) {
        this.ragParams = ragParams || {};
    }

    rebindDatabase(db) {
        this.db = db;
    }

    getEffectiveConfig(overrides = {}) {
        const configured = this.ragParams?.KnowledgeBaseManager?.tagMemoV10Alpha || {};
        return immutableSnapshot({
            enabled: configured.enabled === true || configured.enabled === 1,
            mode: configured.mode || 'shadow',
            experimentArm: configured.experimentArm || 'pure',
            strictVersion: configured.strictVersion !== false,
            traceEnabled: configured.traceEnabled !== false,
            sourceObservation: {
                mode: 'v9_epa_pyramid_spike',
                baseTagBoost: 0.6,
                coreBoostFactor: 1.33,
                allowKnnFallback: false,
                fallbackSourceK: 16,
                ...(configured.sourceObservation || {})
            },
            localField: {
                solver: 'scaled_resolvent',
                alpha: 0.15,
                maxIterations: 80,
                tolerance: 1e-9,
                ...(configured.localField || {})
            },
            transferField: {
                solver: 'scaled_resolvent',
                alpha: 0.55,
                maxIterations: 80,
                tolerance: 1e-9,
                ...(configured.transferField || {})
            },
            effectiveSupport: {
                method: 'mass_ratio',
                localMassRatio: 0.8,
                transferMassRatio: 0.9,
                ...(configured.effectiveSupport || {})
            },
            agentConditioning: {
                enabled: true,
                localAffinityMin: 0.75,
                localAffinityMax: 1.25,
                transferAffinityMin: 0.9,
                transferAffinityMax: 1.1,
                ...(configured.agentConditioning || {})
            },
            candidateSuperset: {
                queryK: 100,
                localFieldK: 100,
                transferFieldK: 100,
                bm25K: 50,
                anchorK: 50,
                maxUnionCandidates: 300,
                minimumGeometryCoverage: 0.5,
                ...(configured.candidateSuperset || {})
            },
            pathGeometry: {
                localWeight: 0.6,
                transferWeight: 0.4,
                directionFloor: 0.05,
                supportMode: 'effective_domain',
                minimumSupportedPotential: 0,
                ...(configured.pathGeometry || {})
            },
            relativeTopology: {
                enabled: true,
                semanticNodeThreshold: 0.48,
                relativeDistanceTemperature: 0.35,
                reverseDirectionCredit: 0.25,
                selfEvidenceFloor: 0.15,
                nodeOnlyReliabilityCap: 0.2,
                minimumRiverEdgeFlow: 0.015,
                maximumRiverEdges: 96,
                traceEdgeLimit: 24,
                ...(configured.relativeTopology || {})
            },
            riverObservability: {
                kappaEdge: 0.5,
                kappaRatio: 0.3,
                epsilon: 0.02,
                collapsedThreshold: 0.12,
                sparseThreshold: 0.45,
                ...(configured.riverObservability || {})
            },
            directAnchor: {
                semanticThreshold: 0.8,
                semanticDiscount: 0.7,
                specificityFloor: 0.35,
                reliabilitySeedSaturation: 2,
                fallbackReliabilityCap: 0.5,
                traceLimit: 8,
                ...(configured.directAnchor || {})
            },
            dstc: {
                compute: true,
                arm: configured.experimentArm || 'pure',
                observedRewardCap: 0.12,
                semanticScoreMode: 'positive',
                pureScoreMode: 'topology_limited',
                topologyBonusCap: 0.08,
                topologyPathSaturation: 0.15,
                topologyReliabilityMode: 'path_closure',
                topologyScoreMode: 'relative_graph_dual_readout',
                topologyGraphWeightMax: 0.55,
                topologyGraphWeightFloor: 0,
                topologyFieldScore: 'denoised',
                topologyV2BonusCap: 0.08,
                topologyV2InnovationScale: 0.5,
                topologyV2ConditionalBandwidth: 0.04,
                topologyV2ClosureBandwidth: 0.1,
                topologyV2DirectBandwidth: 0.12,
                topologyV2MinimumPeers: 3,
                topologyV2MinimumEffectivePeers: 2.5,
                topologyV2InnovationConfidenceZ: 1,
                topologyV2QueryConfidenceFloor: 0.2,
                topologyV2DirectEvidenceThreshold: 0.55,
                topologyV2DirectFrontierMargin: 0.03,
                topologyV2FrontierProtectionMargin: 0.005,
                topologyV3OmegaGamma: 1,
                topologyV3StructRoleMinOmega: 0.12,
                topologyV3AnchorBonusCap: 0.06,
                topologyV3AnchorBonusScale: 0.08,
                topologyV3AnchorFrontierThreshold: 0.45,
                topologyV2RoleCaps: {
                    atomic_concept: 0.08,
                    direct_answer: 0.02,
                    structural_explanation: 0.045,
                    thematic_neighbor: 0.008
                },
                topologyV2RoleMultipliers: {
                    atomic_concept: 1,
                    direct_answer: 0.35,
                    structural_explanation: 0.7,
                    thematic_neighbor: 0.15
                },
                semanticSimilarityMode: 'positive',
                closureMode: 'query_weighted',
                queryClosureWeight: 0.65,
                tagClosureWeight: 0.35,
                ...(configured.dstc || {})
            },
            safety: {
                permissionViolationTolerance: 0,
                failClosed: true,
                ...(configured.safety || {})
            },
            benchmark: {
                traceCandidates: true,
                ...(configured.benchmark || {})
            },
            ...overrides
        });
    }

    buildAndPublishArtifact(options = {}) {
        const sourceBundle = options.sourceBundle
            || this.v9Engine?.getArtifactBundleSnapshot?.('v9');
        if (!sourceBundle?.propagationKernel) {
            const error = new Error('V10 Alpha requires an available V9.2 fact transport snapshot');
            error.code = 'TAGMEMO_V10_SOURCE_ARTIFACT_UNAVAILABLE';
            throw error;
        }

        const effectiveConfig = this.getEffectiveConfig(options.config || {});
        const configHash = hashStable(effectiveConfig, 32);
        const sharedTransport = createReadonlyCsr(sourceBundle.propagationKernel);
        if (sharedTransport.maxRowMass >= 1) {
            const error = new Error(
                `V10 transport violates convergence budget: maxRowMass=${sharedTransport.maxRowMass}`
            );
            error.code = 'TAGMEMO_V10_UNSTABLE_TRANSPORT';
            throw error;
        }

        const databaseGeneration = this._computeDatabaseGeneration();
        const graphGeneration = sharedTransport.contentSig;
        const modelSig = sourceBundle.modelSig || this.v9Engine?.modelSig || 'unknown-model';
        const provenanceView = buildProvenanceView(this.db, {
            maxTagsPerFile: 100,
            direction: this.ragParams?.KnowledgeBaseManager?.orderedCooccurrence || {}
        });
        const provenanceGeneration = provenanceView.generation;
        const artifactSig = hashStable({
            schema: ARTIFACT_SCHEMA,
            version: VERSION,
            algorithmVersion: ALGORITHM_VERSION,
            graphGeneration,
            databaseGeneration,
            provenanceGeneration,
            modelSig,
            configHash,
            sourceArtifactSig: sourceBundle.artifactSig || null,
            residualArtifactSig: sourceBundle.residualArtifact?.artifactSig || null
        }, 48);

        const generation = ++this._artifactGeneration;
        const publishedAt = Date.now();
        const artifact = Object.freeze({
            schema: ARTIFACT_SCHEMA,
            version: VERSION,
            algorithmVersion: ALGORITHM_VERSION,
            artifactSig,
            generation,
            graphGeneration,
            databaseGeneration,
            provenanceGeneration,
            modelSig,
            configHash,
            sourceArtifactSig: sourceBundle.artifactSig || null,
            sharedTransport,
            rawResidualRatioView: immutableSnapshot(
                sourceBundle.rawResidualRatioMap || new Map()
            ),
            anchorGainView: immutableSnapshot(
                sourceBundle.anchorGainMap || new Map()
            ),
            pairwiseView: immutableSnapshot(
                sourceBundle.pairwiseView || new Map()
            ),
            inboundMassView: immutableSnapshot(
                sourceBundle.inboundMassMap || new Map()
            ),
            maxInbound: Math.max(
                0,
                Number(sourceBundle.maxInbound) || 0
            ),
            wormholeView: immutableSnapshot(
                sourceBundle.wormholeEdges || new Set()
            ),
            provenanceView,
            effectiveConfig,
            publishedAt
        });

        this._activeArtifact = artifact;
        console.log(
            `[TagMemo-V10] 📦 Alpha artifact published: generation=${generation}, ` +
            `artifact=${artifactSig}, nodes=${sharedTransport.nodeCount}, ` +
            `edges=${sharedTransport.edgeCount}, maxRowMass=${sharedTransport.maxRowMass.toFixed(6)}`
        );
        return artifact;
    }

    getArtifactSnapshot(options = {}) {
        if (!this._activeArtifact && options.buildIfMissing !== false) {
            return this.buildAndPublishArtifact(options);
        }
        return this._activeArtifact;
    }

    createSourceFieldFromVector(vector, options = {}) {
        if (!this.tagIndex || typeof this.tagIndex.search !== 'function') {
            const error = new Error('V10 source observation requires the global Tag index');
            error.code = 'TAGMEMO_V10_TAG_INDEX_UNAVAILABLE';
            throw error;
        }
        const input = vector instanceof Float32Array
            ? vector
            : new Float32Array(vector || []);
        if (input.length !== Number(this.config.dimension)) {
            throw new RangeError(
                `V10 query vector dimension must be ${this.config.dimension}, got ${input.length}`
            );
        }
        const sourceK = Math.max(1, Math.floor(Number(options.sourceK) || 16));
        const minimumScore = Math.max(-1, Math.min(1, Number(options.minimumScore) || 0));
        const results = this.tagIndex.search(input, sourceK);
        const positive = results
            .map(item => [
                Number(item.id),
                Math.max(0, (Number(item.score) || 0) - minimumScore)
            ])
            .filter(([id, mass]) => Number.isFinite(id) && id > 0 && mass > 0);
        const total = positive.reduce((sum, entry) => sum + entry[1], 0);
        if (total <= 0) {
            const error = new Error('V10 query did not activate any Tag source');
            error.code = 'TAGMEMO_V10_EMPTY_SOURCE';
            throw error;
        }
        return Object.freeze(
            positive.map(([id, mass]) => Object.freeze([id, mass / total]))
        );
    }

    projectFieldVector(fieldEntries, options = {}) {
        const dimension = Math.max(1, Number(this.config.dimension) || 0);
        const entries = Array.isArray(fieldEntries) ? fieldEntries : [];
        const ids = entries.map(entry => Number(entry[0])).filter(Number.isFinite);
        if (ids.length === 0 || !this.db?.prepare) return null;

        const rows = [];
        for (let offset = 0; offset < ids.length; offset += 500) {
            const batch = ids.slice(offset, offset + 500);
            const placeholders = batch.map(() => '?').join(',');
            rows.push(...this.db.prepare(
                `SELECT id, vector FROM tags WHERE id IN (${placeholders})`
            ).all(...batch));
        }
        const rowById = new Map(rows.map(row => [Number(row.id), row]));
        const output = new Float64Array(dimension);
        let totalWeight = 0;
        for (const [rawId, rawMass] of entries) {
            const row = rowById.get(Number(rawId));
            const mass = Math.max(0, Number(rawMass) || 0);
            if (!row?.vector || row.vector.length !== dimension * 4 || mass <= 0) continue;
            const aligned = row.vector.byteOffset % 4 === 0
                ? row.vector
                : Buffer.from(row.vector);
            const tagVector = new Float32Array(
                aligned.buffer,
                aligned.byteOffset,
                dimension
            );
            for (let index = 0; index < dimension; index++) {
                output[index] += tagVector[index] * mass;
            }
            totalWeight += mass;
        }
        if (totalWeight <= 0) return null;

        let norm = 0;
        for (let index = 0; index < dimension; index++) {
            output[index] /= totalWeight;
            norm += output[index] * output[index];
        }
        norm = Math.sqrt(norm);
        if (norm <= 1e-12) return null;
        const projected = new Float32Array(dimension);
        for (let index = 0; index < dimension; index++) {
            projected[index] = output[index] / norm;
        }
        return projected;
    }

    prepareQuery(query, agentContext = {}, options = {}) {
        const artifact = options.artifact || this.getArtifactSnapshot();
        const queryVectorRaw = query?.vector || options.vector;
        const queryVector = queryVectorRaw instanceof Float32Array
            ? queryVectorRaw
            : new Float32Array(queryVectorRaw || []);
        const configuredObservation = {
            ...(artifact.effectiveConfig.sourceObservation || {}),
            // sourceObservation 曾被早期调用方用于配置覆盖；保留兼容，
            // 新调用统一使用 sourceObservationConfig，避免与观测结果混淆。
            ...(options.sourceObservation || {}),
            ...(options.sourceObservationConfig || {})
        };

        let sourceObservation = options.sourceObservationResult || null;
        let sourceField = options.sourceField || null;
        if (!sourceField && !sourceObservation) {
            const mode = String(
                configuredObservation.mode || 'v9_epa_pyramid_spike'
            ).trim().toLowerCase();
            if (
                mode === 'v9_epa_pyramid_spike'
                && typeof this.v9Engine?.observeQueryForV10 === 'function'
            ) {
                sourceObservation = this.v9Engine.observeQueryForV10(
                    queryVector,
                    {
                        artifactBundle: this.v9Engine
                            .getArtifactBundleSnapshot?.('v9'),
                        baseTagBoost: configuredObservation.baseTagBoost,
                        coreBoostFactor:
                            configuredObservation.coreBoostFactor,
                        coreTags: options.coreTags || []
                    }
                );
                if (
                    sourceObservation?.sourceMode
                    === 'v9_epa_pyramid_spike'
                    && Array.isArray(sourceObservation.sourceField)
                    && sourceObservation.sourceField.length > 0
                ) {
                    sourceField = sourceObservation.sourceField;
                }
            }
        }

        if (!sourceField) {
            if (configuredObservation.allowKnnFallback !== true) {
                const error = new Error(
                    'V10 denoised source observation is unavailable and KNN fallback is disabled'
                );
                error.code = 'TAGMEMO_V10_DENOISED_SOURCE_UNAVAILABLE';
                throw error;
            }
            sourceField = this.createSourceFieldFromVector(
                queryVector,
                {
                    sourceK: configuredObservation.fallbackSourceK
                        ?? configuredObservation.sourceK
                        ?? 16,
                    minimumScore: configuredObservation.minimumScore
                }
            );
            sourceObservation = Object.freeze({
                schema: 'tagmemo-v10-source-observation-fallback-v1',
                sourceMode: 'tag_knn_fallback',
                sourceField,
                enhancedVector: null,
                queryRiverGraph: null,
                epa: Object.freeze({}),
                pyramid: Object.freeze({}),
                propagation: Object.freeze({}),
                diagnostics: Object.freeze({
                    sourceNodes: sourceField.length,
                    fallback: true
                })
            });
        }

        const initial = this.createQueryState(
            query,
            agentContext,
            artifact,
            {
                ...options,
                sourceField,
                sourceObservation
            }
        );
        const solved = this.solveQueryState(initial, {
            ...options,
            artifact
        });
        const denoisedVector = sourceObservation?.enhancedVector
            ? new Float32Array(sourceObservation.enhancedVector)
            : this.projectFieldVector(solved.sourceField);
        return Object.freeze({
            queryState: solved,
            denoisedVector,
            localVector: this.projectFieldVector(solved.localField),
            transferVector: this.projectFieldVector(solved.transferField)
        });
    }

    createQueryState(query, agentContext = {}, artifact = null, options = {}) {
        const snapshot = artifact || this.getArtifactSnapshot();
        if (!snapshot || snapshot.version !== VERSION) {
            const error = new Error('A V10 Alpha artifact snapshot is required');
            error.code = 'TAGMEMO_V10_ARTIFACT_UNAVAILABLE';
            throw error;
        }

        const normalizedQuery = this._normalizeQuery(query);
        const normalizedAgentContext = this._normalizeAgentContext(agentContext);
        const sourceField = this._normalizeSourceField(options.sourceField);
        const sourceObservation = this._normalizeSourceObservation(
            options.sourceObservation,
            sourceField
        );
        const solver = immutableSnapshot({
            local: {
                ...snapshot.effectiveConfig.localField,
                ...(options.localField || {})
            },
            transfer: {
                ...snapshot.effectiveConfig.transferField,
                ...(options.transferField || {})
            }
        });
        const scopeHash = hashStable({
            agentId: normalizedAgentContext.agentId,
            diaryNames: normalizedAgentContext.diaryNames,
            allowedFileIds: normalizedAgentContext.allowedFileIds,
            deniedFileIds: normalizedAgentContext.deniedFileIds,
            visibilityMode: normalizedAgentContext.visibilityMode
        }, 32);
        const queryId = options.queryId || crypto.randomUUID();
        const createdAt = Number(options.createdAt) || Date.now();

        return Object.freeze({
            schema: QUERY_TRACE_SCHEMA,
            version: VERSION,
            algorithmVersion: ALGORITHM_VERSION,
            queryId,
            artifactSig: snapshot.artifactSig,
            artifactGeneration: snapshot.generation,
            configHash: snapshot.configHash,
            databaseGeneration: snapshot.databaseGeneration,
            scopeHash,
            query: normalizedQuery,
            agentContext: normalizedAgentContext,
            sourceField,
            sourceObservation,
            queryRiverGraph: sourceObservation.queryRiverGraph,
            solver,
            conditionedTransportView: null,
            localField: null,
            transferField: null,
            localDomain: null,
            transferDomain: null,
            fieldDiagnostics: null,
            createdAt
        });
    }

    buildCandidateSuperset(sourceCandidates, options = {}) {
        const artifact = options.artifact || this.getArtifactSnapshot();
        return buildCandidateSuperset(
            sourceCandidates,
            {
                ...artifact.effectiveConfig.candidateSuperset,
                ...(options.config || {})
            }
        );
    }

    projectCandidateCurves(candidates, options = {}) {
        return projectCandidateCurves(
            this.db,
            candidates,
            {
                dimension: this.config.dimension,
                ...options
            }
        );
    }

    _loadTagVectorsById(ids) {
        const uniqueIds = [...new Set(
            (Array.isArray(ids) ? ids : [])
                .map(Number)
                .filter(id => Number.isFinite(id) && id > 0)
        )];
        const vectorById = new Map();
        const dimension = Math.max(1, Number(this.config.dimension) || 0);
        if (uniqueIds.length === 0 || !this.db?.prepare) return vectorById;

        for (let offset = 0; offset < uniqueIds.length; offset += 500) {
            const batch = uniqueIds.slice(offset, offset + 500);
            const placeholders = batch.map(() => '?').join(',');
            const rows = this.db.prepare(
                `SELECT id, vector FROM tags WHERE id IN (${placeholders})`
            ).all(...batch);
            for (const row of rows) {
                if (!row.vector || row.vector.length !== dimension * 4) continue;
                const aligned = row.vector.byteOffset % 4 === 0
                    ? row.vector
                    : Buffer.from(row.vector);
                vectorById.set(
                    Number(row.id),
                    new Float32Array(
                        aligned.buffer,
                        aligned.byteOffset,
                        dimension
                    )
                );
            }
        }
        return vectorById;
    }

    evaluateCandidateCurves(curves, queryState, options = {}) {
        const artifact = options.artifact || this.getArtifactSnapshot();
        const pathBatch = evaluateCandidateCurves(
            curves,
            queryState,
            {
                ...artifact.effectiveConfig.pathGeometry,
                ...(options.config || {})
            }
        );
        const relativeConfig = {
            ...artifact.effectiveConfig.relativeTopology,
            ...(options.relativeTopology || {})
        };
        if (relativeConfig.enabled === false) return pathBatch;

        // Pairwise 缓存不是完整 Tag×Tag 矩阵。一次性读取查询河网节点向量，
        // 供匹配器在缓存未命中时执行真实语义对应；禁止在逐候选循环中查库。
        const riverNodeIds = [...new Set(
            (Array.isArray(queryState?.queryRiverGraph?.nodes)
                ? queryState.queryRiverGraph.nodes
                : []
            )
                .map(node => Number(node.id))
                .filter(id => Number.isFinite(id) && id > 0)
        )];
        const queryTagVectorById = this._loadTagVectorsById(riverNodeIds);

        return evaluateRelativeTopologyBatch(
            pathBatch,
            queryState,
            {
                ...relativeConfig,
                pairwiseView: artifact.pairwiseView,
                provenanceView: artifact.provenanceView,
                queryTagVectorById
            }
        );
    }

    computeDstcObservables(pathBatch, queryState, options = {}) {
        const artifact = options.artifact || this.getArtifactSnapshot();
        return computeDstcBatch(
            pathBatch,
            queryState,
            {
                ...artifact.effectiveConfig.pathGeometry,
                ...artifact.effectiveConfig.dstc,
                ...options
            }
        );
    }

    _prepareExperimentOptions(dstcBatch, options, artifact) {
        const queryState = options.queryState || null;
        const riverObservability = options.riverObservability
            || computeRiverObservability(
                queryState,
                {
                    ...artifact.effectiveConfig.riverObservability,
                    structRoleMinOmega:
                        artifact.effectiveConfig.dstc
                            ?.topologyV3StructRoleMinOmega
                }
            );

        let anchorBatch = options.anchorBatch || null;
        if (!anchorBatch && queryState) {
            const provenance = Array.isArray(
                queryState.sourceObservation?.fieldProvenance
            )
                ? queryState.sourceObservation.fieldProvenance
                : [];
            const provenanceIds = provenance
                .filter(entry => {
                    const value = entry?.[1] || {};
                    return Number(value.hop) === 0
                        && (
                            value.sourceType === 'core'
                            || value.sourceType === 'seed'
                        );
                })
                .map(entry => Number(entry?.[0]));
            const fallbackIds = Array.isArray(queryState.sourceField)
                ? queryState.sourceField.map(entry => Number(entry?.[0]))
                : [];
            const anchorIds = provenanceIds.length > 0
                ? provenanceIds
                : fallbackIds;
            const anchorTagVectorById = this._loadTagVectorsById(anchorIds);
            anchorBatch = computeDirectAnchorBatch(
                dstcBatch,
                queryState,
                {
                    ...artifact.effectiveConfig.directAnchor,
                    inboundMassView: artifact.inboundMassView,
                    maxInbound: artifact.maxInbound,
                    anchorTagVectorById
                }
            );
        }

        return {
            ...artifact.effectiveConfig.dstc,
            ...options,
            queryState,
            riverObservabilityConfig:
                artifact.effectiveConfig.riverObservability,
            riverObservability,
            anchorBatch
        };
    }

    scoreExperimentArm(dstcBatch, arm = 'pure', options = {}) {
        const artifact = options.artifact || this.getArtifactSnapshot();
        return scoreExperimentArm(
            dstcBatch,
            arm,
            this._prepareExperimentOptions(dstcBatch, options, artifact)
        );
    }

    runExperimentArms(dstcBatch, options = {}) {
        const artifact = options.artifact || this.getArtifactSnapshot();
        return runExperimentArms(
            dstcBatch,
            this._prepareExperimentOptions(dstcBatch, options, artifact)
        );
    }

    solveQueryState(queryState, options = {}) {
        const artifact = options.artifact || this.getArtifactSnapshot();
        const replay = this.assertReplayCompatible(queryState, artifact);
        if (!replay.compatible) {
            const error = new Error(
                `V10 query state is not replay-compatible: ${replay.mismatches.join(', ')}`
            );
            error.code = 'TAGMEMO_V10_REPLAY_MISMATCH';
            error.mismatches = replay.mismatches;
            throw error;
        }

        const agentContext = {
            ...queryState.agentContext,
            publicDiaryNames: options.publicDiaryNames || []
        };
        const conditioningConfig = artifact.effectiveConfig.agentConditioning || {};
        const nodeVisibility = typeof options.nodeVisibility === 'function'
            ? options.nodeVisibility
            : () => true;
        const identityEligibility = typeof options.identityEligibility === 'function'
            ? options.identityEligibility
            : () => false;
        const rankingEligibility = typeof options.rankingEligibility === 'function'
            ? options.rankingEligibility
            : () => true;
        const provenanceClassifier =
            typeof artifact.provenanceView.createContextClassifier === 'function'
                ? artifact.provenanceView.createContextClassifier(agentContext)
                : null;
        const edgeProvenance = provenanceClassifier
            ? (sourceId, targetId) =>
                provenanceClassifier.getEdgeMass(sourceId, targetId)
            : (sourceId, targetId, context) =>
                artifact.provenanceView.getEdgeMass(sourceId, targetId, context);
        const common = {
            ...conditioningConfig,
            scopeHash: queryState.scopeHash,
            failClosed: artifact.effectiveConfig.safety?.failClosed !== false,
            nodeVisibility,
            identityEligibility,
            rankingEligibility,
            edgeProvenance,
            queryGate: options.queryGate,
            affinityGate: options.affinityGate
        };
        const dualOperator = createDualConditionedOperators(
            artifact.sharedTransport,
            agentContext,
            common
        );
        const localOperator = dualOperator.localOperator;
        const transferOperator = dualOperator.transferOperator;
        const solved = solveDualScaledFields({
            localOperator,
            transferOperator,
            dualOperator,
            sourceField: queryState.sourceField,
            local: queryState.solver.local,
            transfer: queryState.solver.transfer,
            support: artifact.effectiveConfig.effectiveSupport
        });

        return Object.freeze({
            ...queryState,
            conditionedTransportView: Object.freeze({
                schema: dualOperator.schema,
                pairSig: dualOperator.pairSig,
                edgeCount: dualOperator.edgeCount,
                permittedEdges: dualOperator.permittedEdges,
                forbiddenEdgeMass: dualOperator.forbiddenEdgeMass,
                local: localOperator,
                transfer: transferOperator
            }),
            localField: solved.localField,
            transferField: solved.transferField,
            localDomain: solved.localDomain,
            transferDomain: solved.transferDomain,
            fieldDiagnostics: solved.diagnostics
        });
    }

    assertReplayCompatible(queryState, artifact = null) {
        const snapshot = artifact || this.getArtifactSnapshot({ buildIfMissing: false });
        if (!queryState || queryState.schema !== QUERY_TRACE_SCHEMA) {
            throw new TypeError('Invalid V10 query trace schema');
        }
        const mismatches = [];
        if (!snapshot) mismatches.push('artifact-unavailable');
        else {
            if (queryState.artifactSig !== snapshot.artifactSig) mismatches.push('artifactSig');
            if (queryState.configHash !== snapshot.configHash) mismatches.push('configHash');
            if (queryState.databaseGeneration !== snapshot.databaseGeneration) {
                mismatches.push('databaseGeneration');
            }
        }
        return Object.freeze({
            compatible: mismatches.length === 0,
            mismatches: Object.freeze(mismatches)
        });
    }

    _normalizeQuery(query) {
        if (typeof query === 'string') {
            return Object.freeze({
                text: query.trim(),
                vector: null,
                hash: hashStable(query.trim(), 32)
            });
        }

        const text = String(query?.text || '').trim();
        const rawVector = query?.vector;
        const vector = rawVector && typeof rawVector.length === 'number'
            ? Object.freeze(Array.from(rawVector, value => Number(value) || 0))
            : null;
        return Object.freeze({
            text,
            vector,
            hash: hashStable({ text, vector }, 32)
        });
    }

    _normalizeAgentContext(agentContext) {
        const normalizeIds = value => Object.freeze(
            [...new Set((Array.isArray(value) ? value : [])
                .map(Number)
                .filter(Number.isFinite))]
                .sort((a, b) => a - b)
        );
        const diaryNames = Object.freeze(
            [...new Set((Array.isArray(agentContext.diaryNames)
                ? agentContext.diaryNames
                : agentContext.diaryName
                    ? [agentContext.diaryName]
                    : [])
                .map(value => String(value).trim())
                .filter(Boolean))]
                .sort()
        );

        return Object.freeze({
            agentId: String(agentContext.agentId || agentContext.maid || '').trim() || null,
            diaryNames,
            publicDiaryNames: Object.freeze(
                [...new Set((Array.isArray(agentContext.publicDiaryNames)
                    ? agentContext.publicDiaryNames
                    : [])
                    .map(value => String(value).trim())
                    .filter(Boolean))]
                    .sort()
            ),
            allowedFileIds: normalizeIds(agentContext.allowedFileIds),
            deniedFileIds: normalizeIds(agentContext.deniedFileIds),
            visibilityMode: String(agentContext.visibilityMode || 'scope_only'),
            permissions: immutableSnapshot(agentContext.permissions || {}),
            affinity: immutableSnapshot(agentContext.affinity || {})
        });
    }

    _normalizeSourceObservation(observation, sourceField) {
        const input = observation && typeof observation === 'object'
            ? observation
            : {};
        const river = input.queryRiverGraph
            && typeof input.queryRiverGraph === 'object'
            ? input.queryRiverGraph
            : null;
        return immutableSnapshot({
            schema: input.schema
                || 'tagmemo-v10-source-observation-v1',
            sourceMode: input.sourceMode || 'explicit_source_field',
            v9ArtifactSig: input.v9ArtifactSig || null,
            epa: input.epa || {},
            pyramid: input.pyramid || {},
            propagation: input.propagation || {},
            matchedTags: Array.isArray(input.matchedTags)
                ? input.matchedTags
                : [],
            coreTagsMatched: Array.isArray(input.coreTagsMatched)
                ? input.coreTagsMatched
                : [],
            fieldProvenance: Array.isArray(input.fieldProvenance)
                ? input.fieldProvenance
                : [],
            queryRiverGraph: river,
            diagnostics: {
                ...(input.diagnostics || {}),
                normalizedSourceNodes: sourceField.length,
                completeObservation:
                    input.diagnostics?.completeObservation === true,
                vectorChanged:
                    input.diagnostics?.vectorChanged === true,
                vectorDeltaL2:
                    Number(input.diagnostics?.vectorDeltaL2) || 0,
                sourceEnhancedCosine:
                    Number(input.diagnostics?.sourceEnhancedCosine) || 0,
                fallbackReason:
                    input.diagnostics?.fallbackReason || null
            }
        });
    }

    _normalizeSourceField(sourceField) {
        const entries = sourceField instanceof Map
            ? [...sourceField.entries()]
            : Array.isArray(sourceField)
                ? sourceField
                : [];
        const normalized = entries
            .map(([rawId, rawMass]) => [Number(rawId), Math.max(0, Number(rawMass) || 0)])
            .filter(([id, mass]) => Number.isFinite(id) && id > 0 && mass > 0)
            .sort((left, right) => left[0] - right[0]);
        const total = normalized.reduce((sum, entry) => sum + entry[1], 0);
        return Object.freeze(normalized.map(([id, mass]) =>
            Object.freeze([id, total > 0 ? mass / total : 0])
        ));
    }

    _computeDatabaseGeneration() {
        if (!this.db?.prepare) return 'database-unavailable';
        const facts = {};
        for (const table of ['files', 'chunks', 'tags', 'file_tags']) {
            try {
                if (table === 'files') {
                    facts[table] = this.db.prepare(`
                        SELECT
                            COUNT(*) AS count,
                            COALESCE(MAX(id), 0) AS maxId,
                            COALESCE(MAX(updated_at), 0) AS maxUpdatedAt,
                            COALESCE(SUM(size), 0) AS totalSize
                        FROM files
                    `).get();
                } else if (table === 'file_tags') {
                    facts[table] = this.db.prepare(`
                        SELECT
                            COUNT(*) AS count,
                            COALESCE(SUM(file_id), 0) AS fileMass,
                            COALESCE(SUM(tag_id), 0) AS tagMass,
                            COALESCE(SUM(position), 0) AS positionMass
                        FROM file_tags
                    `).get();
                } else {
                    facts[table] = this.db.prepare(`
                        SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS maxId
                        FROM ${table}
                    `).get();
                }
            } catch (error) {
                facts[table] = { error: error.message };
            }
        }
        return hashStable(facts, 40);
    }

    _computeProvenanceGeneration() {
        if (!this.db?.prepare) return 'provenance-unavailable';
        try {
            const rows = this.db.prepare(`
                SELECT diary_name, COUNT(*) AS fileCount,
                       COALESCE(SUM(size), 0) AS totalSize,
                       COALESCE(MAX(updated_at), 0) AS maxUpdatedAt
                FROM files
                GROUP BY diary_name
                ORDER BY diary_name
            `).all();
            return hashStable(rows, 40);
        } catch (error) {
            return hashStable({ error: error.message }, 40);
        }
    }
}

TagMemoV10Engine.VERSION = VERSION;
TagMemoV10Engine.ALGORITHM_VERSION = ALGORITHM_VERSION;
TagMemoV10Engine.ARTIFACT_SCHEMA = ARTIFACT_SCHEMA;
TagMemoV10Engine.QUERY_TRACE_SCHEMA = QUERY_TRACE_SCHEMA;

module.exports = TagMemoV10Engine;