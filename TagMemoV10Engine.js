'use strict';

const { immutableSnapshot } = require(
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
        const { cleanRiverConfig } = require('./modules/knowledgeBase/memoConfig');
        return immutableSnapshot(cleanRiverConfig({
            ...cleanRiverConfig(this.ragParams?.KnowledgeBaseManager?.riverMemo),
            ...overrides
        }, true));
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

}

TagMemoV10Engine.VERSION = VERSION;
TagMemoV10Engine.ALGORITHM_VERSION = ALGORITHM_VERSION;
TagMemoV10Engine.ARTIFACT_SCHEMA = ARTIFACT_SCHEMA;
TagMemoV10Engine.QUERY_TRACE_SCHEMA = QUERY_TRACE_SCHEMA;

module.exports = TagMemoV10Engine;