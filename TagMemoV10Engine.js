'use strict';

const crypto = require('crypto');
const { hashStable, immutableSnapshot } = require(
    './modules/tagmemoV10/immutable'
);

const VERSION = 'v10_alpha';
const ALGORITHM_VERSION = 'v10.alpha.1';
const ARTIFACT_SCHEMA = 'tagmemo-v10-alpha-artifact-v1';
const QUERY_TRACE_SCHEMA = 'tagmemo-v10-alpha-query-trace-v1';

class TagMemoV10Engine {
    constructor(db, tagIndex, config, ragParams, options = {}) {
        this.tagIndex = tagIndex;
        this.config = config || {};
        this.ragParams = ragParams || {};
        this.v9Engine = options.v9Engine || null;
        this.getNativeRuntime = typeof options.getNativeRuntime === 'function'
            ? options.getNativeRuntime
            : () => null;
        this._activeArtifact = null;
        this._artifactGeneration = 0;
        // 生产图资产、RiverMemo 持久化和派生资产均由 Rust MemoRuntime
        // 管理。JS 只保留配置、artifact 句柄和兼容门面。
        this.artifactRepository = options.artifactRepository || null;
        this.derivedAssetManager = options.derivedAssetManager || null;
    }

    updateRagParams(ragParams) {
        this.ragParams = ragParams || {};
    }

    getConditionedOperatorCacheDiagnostics() {
        return Object.freeze({
            enabled: false,
            limit: 0,
            entries: 0,
            hits: 0,
            misses: 0,
            bypasses: 0,
            evictions: 0,
            estimatedBytes: 0,
            runtimeOwnership: 'rust-memo-runtime'
        });
    }

    ensureExactDerivedAssets() {
        const error = new Error(
            'JS V10 exact derived asset maintenance is retired; use NativeKnowledgeRuntime'
        );
        error.code = 'TAGMEMO_JS_SQL_RETIRED';
        throw error;
    }

    getDerivedAssetDiagnostics() {
        return this.derivedAssetManager?.lastDiagnostics || null;
    }

    invalidateArtifact(reason = 'source-artifact-changed') {
        const previous = this._activeArtifact;
        this._activeArtifact = null;
        if (previous) {
            console.warn(
                `[TagMemo-V10] 🧹 Active artifact invalidated: reason=${reason}, ` +
                `artifact=${previous.artifactSig}, sourceV9=${previous.sourceArtifactSig}`
            );
        }
        return previous;
    }

    _isArtifactCompatibleWithActiveV9(artifact) {
        if (!artifact) return false;
        const activeV9 = this.v9Engine?.getArtifactBundleSnapshot?.('v9');
        return Boolean(
            activeV9?.artifactSig
            && artifact.sourceArtifactSig === activeV9.artifactSig
        );
    }

    getEffectiveConfig(overrides = {}) {
        // 实验室配置保留兼容；RiverMemo 是固定 Topology V3 的生产配置面，
        // 同名字段以 RiverMemo 为准。未公开的旧实验臂参数继续使用下方代码默认值。
        const laboratory = this.ragParams?.KnowledgeBaseManager?.tagMemoV10Alpha || {};
        const riverMemo = this.ragParams?.KnowledgeBaseManager?.riverMemo || {};
        const configured = {
            ...laboratory,
            ...riverMemo
        };
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
                rarityFloor: 0.15,
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
                topologyV3AnchorBonusCap: 0.1,
                topologyV3AnchorActivationZ: 2,
                topologyV3AnchorActivationFloor: 0.05,
                topologyV3AnchorSaturation: 0.2,
                topologyV3AnchorFrontierContrast: 2,
                topologyV3AnchorFrontierAbsFloor: 0.1,
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

    publishNativeArtifactHandle(nativeResult, options = {}) {
        if (
            !nativeResult?.artifactSig
            || !nativeResult?.sourceArtifactSig
            || nativeResult.persisted !== true
        ) {
            throw new TypeError(
                'Native Memo artifact handle requires persisted artifact/source signatures'
            );
        }
        const generation = ++this._artifactGeneration;
        const publishedAt = Number(options.publishedAt) || Date.now();
        const effectiveConfig = options.effectiveConfig
            || this.getEffectiveConfig(options.config || {});
        const artifact = Object.freeze({
            schema: ARTIFACT_SCHEMA,
            version: VERSION,
            algorithmVersion:
                nativeResult.algorithmVersion || 'memo.native-artifact-v1',
            artifactSig: nativeResult.artifactSig,
            generation,
            nativeGeneration:
                Number(nativeResult.generation) || null,
            graphGeneration: nativeResult.graphGeneration || '',
            databaseGeneration: nativeResult.databaseGeneration || '',
            provenanceGeneration:
                nativeResult.provenanceGeneration || '',
            modelSig:
                nativeResult.modelSig
                || this.v9Engine?.modelSig
                || this.config.modelSig
                || this.config.model
                || 'unknown-model',
            configHash: nativeResult.configHash || null,
            sourceArtifactSig: nativeResult.sourceArtifactSig,
            sourceGraphGeneration:
                nativeResult.sourceGraphGeneration
                || nativeResult.graphGeneration
                || '',
            maxInbound: Math.max(
                0,
                Number(nativeResult.maxInbound) || 0
            ),
            effectiveConfig,
            nodeCount: Math.max(
                0,
                Number(nativeResult.nodeCount) || 0
            ),
            edgeCount: Math.max(
                0,
                Number(nativeResult.edgeCount) || 0
            ),
            storageMode: 'rust-memo-runtime',
            residentAtPublication: nativeResult.resident === true,
            publishedAt
        });
        this._activeArtifact = artifact;
        console.log(
            `[TagMemo-V10] 🦀 Native control handle published: ` +
            `generation=${generation}, nativeGeneration=` +
            `${artifact.nativeGeneration ?? 'lazy'}, ` +
            `artifact=${artifact.artifactSig}, nodes=${artifact.nodeCount}, ` +
            `edges=${artifact.edgeCount}, resident=` +
            `${artifact.residentAtPublication}.`
        );
        return artifact;
    }

    publishArtifact(staging, options = {}) {
        if (
            !staging
            || staging.schema !== ARTIFACT_SCHEMA
            || staging.version !== VERSION
        ) {
            throw new TypeError('Invalid V10 artifact staging object');
        }
        const generation = ++this._artifactGeneration;
        const publishedAt = Number(options.publishedAt) || Date.now();
        const nodeCount = Math.max(
            0,
            Number(staging.sharedTransport?.nodeCount) || 0
        );
        const edgeCount = Math.max(
            0,
            Number(staging.sharedTransport?.edgeCount) || 0
        );

        // Rust MemoRuntime 是生产图资产的唯一常驻所有者。JS 发布对象只保留
        // 路由所需的签名、配置和诊断摘要，不保留 CSR、provenance 或 V9 借用视图。
        const artifact = Object.freeze({
            schema: staging.schema,
            version: staging.version,
            algorithmVersion: staging.algorithmVersion,
            artifactSig: staging.artifactSig,
            generation,
            graphGeneration: staging.graphGeneration,
            databaseGeneration: staging.databaseGeneration,
            provenanceGeneration: staging.provenanceGeneration,
            modelSig: staging.modelSig,
            configHash: staging.configHash,
            sourceArtifactSig: staging.sourceArtifactSig,
            sourceGraphGeneration: staging.sourceGraphGeneration || '',
            maxInbound: Math.max(0, Number(staging.maxInbound) || 0),
            effectiveConfig: staging.effectiveConfig,
            nodeCount,
            edgeCount,
            storageMode: 'rust-memo-runtime',
            publishedAt
        });
        this._activeArtifact = artifact;
        console.log(
            `[TagMemo-V10] 📦 Native-owned artifact handle published: ` +
            `generation=${generation}, artifact=${artifact.artifactSig}, ` +
            `nodes=${nodeCount}, edges=${edgeCount}, ` +
            `sourceV9=${artifact.sourceArtifactSig}`
        );
        return artifact;
    }

    _nativeArtifactUnavailableError(operation = 'getArtifactSnapshot') {
        const error = new Error(
            `${operation} requires a Rust-owned Memo artifact handle; ` +
            'JavaScript artifact construction and SQLite persistence are retired'
        );
        error.code = 'TAGMEMO_NATIVE_ARTIFACT_UNAVAILABLE';
        error.operation = operation;
        error.retryable = true;
        return error;
    }

    buildPersistAndPublishArtifact() {
        throw this._nativeArtifactUnavailableError(
            'buildPersistAndPublishArtifact'
        );
    }

    loadCompatiblePersistedArtifact() {
        throw this._nativeArtifactUnavailableError(
            'loadCompatiblePersistedArtifact'
        );
    }

    restoreOrBuildArtifact() {
        throw this._nativeArtifactUnavailableError('restoreOrBuildArtifact');
    }

    buildAndPublishArtifact() {
        throw this._nativeArtifactUnavailableError('buildAndPublishArtifact');
    }

    getArtifactSnapshot(options = {}) {
        if (
            this._activeArtifact
            && !this._isArtifactCompatibleWithActiveV9(this._activeArtifact)
        ) {
            this.invalidateArtifact('active-v9-signature-mismatch');
        }
        if (!this._activeArtifact && options.buildIfMissing !== false) {
            throw this._nativeArtifactUnavailableError('getArtifactSnapshot');
        }
        return this._activeArtifact;
    }

    _retiredJsGraphOperation(operation) {
        const error = new Error(
            `${operation} is retired; use NativeKnowledgeRuntime`
        );
        error.code = 'TAGMEMO_JS_GRAPH_RUNTIME_RETIRED';
        error.retryable = false;
        return error;
    }

    createSourceFieldFromVector() {
        throw this._retiredJsGraphOperation('createSourceFieldFromVector()');
    }

    projectDualFieldVectors() {
        throw this._retiredJsGraphOperation('projectDualFieldVectors()');
    }

    projectFieldVector() {
        throw this._retiredJsGraphOperation('projectFieldVector()');
    }

    prepareQuery() {
        throw this._retiredJsGraphOperation(
            'prepareQuery(); use KnowledgeBaseManager.prepareUnifiedMemoObservation()'
        );
    }

    createQueryState() {
        throw this._retiredJsGraphOperation('createQueryState()');
    }

    buildCandidateSuperset() {
        throw this._retiredJsGraphOperation('buildCandidateSuperset()');
    }

    projectCandidateCurves() {
        throw this._retiredJsGraphOperation('projectCandidateCurves()');
    }

    evaluateCandidateCurves() {
        throw this._retiredJsGraphOperation('evaluateCandidateCurves()');
    }

    computeDstcObservables() {
        throw this._retiredJsGraphOperation('computeDstcObservables()');
    }

    scoreExperimentArm() {
        throw this._retiredJsGraphOperation('scoreExperimentArm()');
    }

    runExperimentArms() {
        throw this._retiredJsGraphOperation('runExperimentArms()');
    }

    solveQueryState() {
        throw this._retiredJsGraphOperation(
            'solveQueryState(); use Rust MemoRuntime'
        );
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
        const runtime = this.getNativeRuntime?.();
        const generation = runtime?.databaseGeneration?.();
        if (Number.isSafeInteger(Number(generation)) && Number(generation) >= 0) {
            return String(Number(generation));
        }
        return 'database-unavailable';
    }

    _computeProvenanceGeneration() {
        return 'provenance-owned-by-rust-runtime';
    }
}

TagMemoV10Engine.VERSION = VERSION;
TagMemoV10Engine.ALGORITHM_VERSION = ALGORITHM_VERSION;
TagMemoV10Engine.ARTIFACT_SCHEMA = ARTIFACT_SCHEMA;
TagMemoV10Engine.QUERY_TRACE_SCHEMA = QUERY_TRACE_SCHEMA;

module.exports = TagMemoV10Engine;