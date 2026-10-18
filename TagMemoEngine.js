'use strict';

const crypto = require('crypto');

class TagMemoEngine {
    constructor(_legacyDb, tagIndex, config = {}, ragParams = {}, knowledgeBaseManager = null) {
        this.tagIndex = tagIndex;
        this.config = config || {};
        this.ragParams = ragParams || {};
        this.knowledgeBaseManager = knowledgeBaseManager;
        this.getDbPath = () => knowledgeBaseManager?.dbPath || '';

        this.modelSig = this._computeModelSig();
        this._activeArtifactBundle = null;
        this._artifactBundleGeneration = 0;

        this._accumulatedNewTagIds = new Set();
        this._accumulatedTagChanges = 0;
        this._matrixRebuildTimer = null;
        this._postStartupDerivedRefreshTimer = null;
        this._derivedTaskTimer = null;
        this._derivedTaskQueue = [];
        this._derivedTaskRunning = false;
        this._derivedTaskSequence = 0;
        this._isMatrixRebuilding = false;
        this._shutdownRequested = false;
        this.intrinsicResidualArtifact = null;

        // Retained as compatibility state only. Rust MemoRuntime owns all assets.
        this.tagCooccurrenceMatrix = null;
        this.tagIntrinsicResiduals = null;
        this.tagRawResidualRatios = null;
        this.tagPairSimilarities = new Map();
    }

    _envFlag(name, fallback = false) {
        const value = process.env[name];
        if (value === undefined || value === null || value === '') return fallback;
        return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
    }

    _computeModelSig() {
        const model = this.config?.modelSig || this.config?.model || 'unknown-model';
        const dimension = this.config?.dimension || 0;
        return crypto.createHash('sha256')
            .update(`${model}:${dimension}`)
            .digest('hex')
            .slice(0, 16);
    }

    updateRagParams(params) {
        this.ragParams = params || {};
    }

    async initialize() {
        console.log(
            `[TagMemoEngine] Native MemoRuntime owns EPA, Residual, Pairwise and graph assets; ` +
            `model_sig=${this.modelSig}.`
        );
        return true;
    }

    _nativeUnavailable(operation) {
        const error = new Error(
            `${operation} requires the Rust NativeKnowledgeRuntime path`
        );
        error.code = 'TAGMEMO_NATIVE_RUNTIME_UNAVAILABLE';
        error.retryable = true;
        return error;
    }

    _retired(operation) {
        const error = new Error(
            `${operation} is retired; use KnowledgeBaseManager.prepareUnifiedMemoObservation()`
        );
        error.code = 'TAGMEMO_JS_GRAPH_RUNTIME_RETIRED';
        return error;
    }

    applyTagBoost() {
        throw this._retired('TagMemoEngine.applyTagBoost()');
    }

    observeQueryForV10() {
        throw this._retired('TagMemoEngine.observeQueryForV10()');
    }

    getEPAAnalysis() {
        return {
            logicDepth: 0.5,
            resonance: 0,
            entropy: 0.5,
            dominantAxes: [],
            runtimeOwnership: 'rust-memo-runtime',
            deprecated: true
        };
    }

    resolveArtifactBundle(options = {}) {
        const requestedVersion = options.version || 'v9';
        if (requestedVersion !== 'v9') {
            const error = new Error(`TagMemo artifact version "${requestedVersion}" was retired`);
            error.code = 'TAGMEMO_VERSION_RETIRED';
            throw error;
        }

        const bundle = this.getArtifactBundleSnapshot('v9');
        if (!bundle) {
            const error = new Error('Native TagMemo artifact is unavailable');
            error.code = 'TAGMEMO_ARTIFACT_UNAVAILABLE';
            error.retryable = true;
            throw error;
        }
        return {
            bundle,
            requestedVersion: 'v9',
            effectiveVersion: 'v9',
            fallbackUsed: false,
            fallbackReason: null,
            explicitVersion: options.version !== undefined
        };
    }

    getArtifactBundleSnapshot(version = 'v9') {
        if (version !== 'v9') return null;
        return this._activeArtifactBundle;
    }

    publishNativeArtifactHandle(nativeResult, effectiveConfig = {}) {
        if (
            !nativeResult?.artifactSig
            || !nativeResult?.sourceArtifactSig
            || nativeResult.persisted !== true
        ) {
            throw new TypeError(
                'Native Memo publication requires persisted artifact and source signatures'
            );
        }

        const generation = ++this._artifactBundleGeneration;
        const bundle = Object.freeze({
            version: 'v9',
            artifactSig: nativeResult.sourceArtifactSig,
            sourceArtifactSig: nativeResult.sourceArtifactSig,
            runtimeArtifactSig: nativeResult.artifactSig,
            graphGeneration: String(nativeResult.graphGeneration || ''),
            sourceGraphGeneration: String(
                nativeResult.sourceGraphGeneration || nativeResult.graphGeneration || ''
            ),
            databaseGeneration: String(nativeResult.databaseGeneration || ''),
            provenanceGeneration: String(nativeResult.provenanceGeneration || ''),
            modelSig: nativeResult.modelSig || this.modelSig,
            configHash: nativeResult.configHash || null,
            effectiveConfig: Object.freeze(
                JSON.parse(JSON.stringify(effectiveConfig || {}))
            ),
            residualArtifact: this.intrinsicResidualArtifact,
            algorithmVersion: nativeResult.algorithmVersion || 'memo.native-artifact-v1',
            generation,
            nativeGeneration: Number(nativeResult.generation) || null,
            storageMode: 'rust-memo-runtime',
            residentAtPublication: nativeResult.resident === true,
            publishedAt: Date.now()
        });

        this._activeArtifactBundle = bundle;
        this.tagCooccurrenceMatrix = null;
        this.tagIntrinsicResiduals = null;
        this.tagRawResidualRatios = null;
        this.tagPairSimilarities = new Map();

        console.log(
            `[TagMemoEngine] Native Memo control handle published: ` +
            `generation=${generation}, artifact=${bundle.artifactSig}, ` +
            `runtimeArtifact=${bundle.runtimeArtifactSig}`
        );
        return bundle;
    }

    releaseNativeOwnedArtifactAssets(expectedArtifactSig = null) {
        const active = this._activeArtifactBundle;
        if (!active) return false;
        if (expectedArtifactSig && active.artifactSig !== expectedArtifactSig) return false;
        return active.storageMode === 'rust-memo-runtime';
    }

    _effectiveNativeConfig() {
        const kbConfig = JSON.parse(JSON.stringify(
            this.ragParams?.KnowledgeBaseManager || {}
        ));
        const v10Config = this.knowledgeBaseManager
            ?.tagMemoV10Engine
            ?.getEffectiveConfig?.() || {};
        return {
            ...kbConfig,
            ...v10Config,
            orderedCooccurrence: kbConfig.orderedCooccurrence || {},
            v9: kbConfig.v9 || {},
            spikeRouting: kbConfig.spikeRouting || {}
        };
    }

    async _assertNativeHealth(operation) {
        const runtime = this.knowledgeBaseManager?.nativeKnowledgeRuntime;
        if (!runtime || typeof runtime.healthCheck !== 'function') return true;
        const rawHealth = await runtime.healthCheck();
        const health = typeof rawHealth === 'string'
            ? JSON.parse(rawHealth)
            : rawHealth;
        if (health && health.healthy !== true) {
            console.error(
                `[TagMemoEngine] Native storage health failed after ${operation}: ` +
                `${health.state || 'unknown'}`
            );
            return false;
        }
        return true;
    }

    async recomputePairwiseSimilarities(options = {}) {
        if (!this.tagIndex || typeof this.tagIndex.computePairwiseSimilarities !== 'function') {
            throw this._nativeUnavailable('computePairwiseSimilarities');
        }

        const dbPath = this.getDbPath();
        if (!dbPath) throw new Error('TagMemoEngine requires a native database path');

        try {
            return await this.tagIndex.computePairwiseSimilarities(
                dbPath,
                this.modelSig,
                Number(options.minSimilarity ?? 0.05),
                options.fullRebuild === true
            );
        } catch (error) {
            console.error('[TagMemoEngine] Rust pairwise computation failed:', error.message || error);
            return null;
        }
    }

    _intrinsicResidualConfig() {
        const raw = this.ragParams?.KnowledgeBaseManager?.intrinsicResidual || {};
        const number = (value, fallback, min, max) => {
            const numeric = Number(value);
            return Number.isFinite(numeric)
                ? Math.max(min, Math.min(max, numeric))
                : fallback;
        };
        const integer = (value, fallback, min, max) =>
            Math.floor(number(value, fallback, min, max));
        const boolean = (value, fallback) => {
            if (value === undefined || value === null) return fallback;
            if (typeof value === 'boolean') return value;
            return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
        };

        return {
            method: ['anchored_gs', 'centroid', 'svd'].includes(
                String(raw.method || 'anchored_gs').toLowerCase()
            ) ? String(raw.method || 'anchored_gs').toLowerCase() : 'anchored_gs',
            maxNeighbors: integer(raw.maxNeighbors, 48, 4, 256),
            maxBasis: integer(raw.maxBasis, 4, 1, 32),
            minNeighbors: integer(raw.minNeighbors, 3, 1, 64),
            semanticEnabled: boolean(raw.semanticEnabled, true),
            semanticPeak: number(raw.semanticPeak, 0.65, -1, 1),
            semanticSigma: number(raw.semanticSigma, 0.25, 0.02, 2),
            semanticFloor: number(raw.semanticFloor, 0.35, 0, 1),
            semanticHardFloor: number(raw.semanticHardFloor, -1, -1, 1),
            minGain: number(raw.minGain, 0.015, 0, 1),
            positionDecay: number(raw.positionDecay, 0.15, 0, 4),
            v9AnchorBase: number(raw.v9AnchorBase, 0.75, 0, 4),
            v9AnchorScale: number(raw.v9AnchorScale, 1.25, 0, 4),
            v9AnchorGamma: number(raw.v9AnchorGamma, 1, 0.1, 8),
            v9AnchorMin: number(raw.v9AnchorMin, 0.5, 0, 4),
            v9AnchorMax: number(raw.v9AnchorMax, 2, 0, 8)
        };
    }

    async recomputeIntrinsicResiduals() {
        if (!this.tagIndex || typeof this.tagIndex.computeIntrinsicResiduals !== 'function') {
            throw this._nativeUnavailable('computeIntrinsicResiduals');
        }

        const dbPath = this.getDbPath();
        if (!dbPath) throw new Error('TagMemoEngine requires a native database path');

        const config = this._intrinsicResidualConfig();
        const result = await this.tagIndex.computeIntrinsicResiduals(
            dbPath,
            config.maxBasis,
            config.minNeighbors,
            this.modelSig,
            JSON.stringify(config)
        );
        if (!result) return null;

        this.intrinsicResidualArtifact = Object.freeze({
            artifactSig: result.artifactSig || null,
            modelSig: this.modelSig,
            algorithmVersion: result.algorithmVersion || null,
            configHash: result.configHash || null
        });
        await this._assertNativeHealth('intrinsic residual computation');
        return result;
    }

    async doMatrixRebuild(options = {}) {
        if (this._shutdownRequested || this._isMatrixRebuilding) return false;
        this._isMatrixRebuilding = true;
        try {
            const pairwise = await this.recomputePairwiseSimilarities({
                fullRebuild: options.fullRebuildPairwise === true
            });
            if (!pairwise) return false;

            if (
                options.forceIntrinsicResiduals === true
                || this._envFlag('TAGMEMO_INTRINSIC_RESIDUAL_FORCE_RECOMPUTE')
                || options.reason === 'threshold'
            ) {
                const residual = await this.recomputeIntrinsicResiduals();
                if (!residual) return false;
            }

            if (!this.tagIndex || typeof this.tagIndex.rebuildMemoArtifact !== 'function') {
                throw this._nativeUnavailable('rebuildMemoArtifact');
            }

            const dbPath = this.getDbPath();
            const effectiveConfig = this._effectiveNativeConfig();
            const result = await this.tagIndex.rebuildMemoArtifact(
                dbPath,
                JSON.stringify({
                    modelSig: this.modelSig,
                    effectiveConfig
                })
            );
            if (
                !result?.success
                || result.persisted !== true
                || result.resident !== true
            ) {
                throw new Error('Native Memo artifact was not published as resident');
            }

            const handle = this.publishNativeArtifactHandle(result, effectiveConfig);
            this.knowledgeBaseManager?.onNativeMemoArtifactPublished?.(result, handle);
            return true;
        } finally {
            this._isMatrixRebuilding = false;
        }
    }

    requestActiveFullTraining(options = {}) {
        if (this._shutdownRequested) {
            return {
                taskId: null,
                queued: false,
                reason: options.reason || 'admin-active-full-training',
                error: 'TagMemoEngine is shutting down'
            };
        }

        const taskId = this._enqueueDerivedTask(
            'active-full-training',
            () => this.doMatrixRebuild({
                reason: options.reason || 'admin-active-full-training',
                fullRebuildPairwise: true,
                forceIntrinsicResiduals: true
            }),
            { maxAttempts: options.maxAttempts ?? 1 }
        );
        return {
            taskId,
            queued: Boolean(taskId),
            reason: options.reason || 'admin-active-full-training',
            threshold: this._getMatrixRebuildThreshold()
        };
    }

    _getMatrixRebuildThreshold() {
        return 50;
    }

    scheduleMatrixRebuildForNewTags(newTagIds = []) {
        if (!Array.isArray(newTagIds) || this._shutdownRequested) return false;
        for (const id of newTagIds) {
            const numeric = Number(id);
            if (Number.isSafeInteger(numeric) && numeric > 0) {
                this._accumulatedNewTagIds.add(numeric);
            }
        }
        this._accumulatedTagChanges = this._accumulatedNewTagIds.size;
        if (this._accumulatedNewTagIds.size < this._getMatrixRebuildThreshold()) {
            return false;
        }

        if (this._matrixRebuildTimer) clearTimeout(this._matrixRebuildTimer);
        this._matrixRebuildTimer = setTimeout(() => {
            this._matrixRebuildTimer = null;
            this._enqueueDerivedTask('threshold-rebuild', () => this.doMatrixRebuild({
                reason: 'threshold'
            }));
        }, this._getMatrixRebuildQuietMs());
        this._matrixRebuildTimer.unref?.();
        return true;
    }

    _getMatrixRebuildQuietMs() {
        const value = Number(process.env.TAGMEMO_MATRIX_REBUILD_QUIET_MS);
        return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 300000;
    }

    schedulePostStartupDerivedRefresh(delayMs = 300000) {
        if (this._shutdownRequested) return false;
        clearTimeout(this._postStartupDerivedRefreshTimer);
        this._postStartupDerivedRefreshTimer = setTimeout(() => {
            this._postStartupDerivedRefreshTimer = null;
            const artifact = this.getArtifactBundleSnapshot('v9');
            if (!artifact) {
                this._enqueueDerivedTask('startup-bootstrap', () => this.doMatrixRebuild({
                    reason: 'startup-bootstrap'
                }));
            }
        }, Math.max(0, Number(delayMs) || 0));
        this._postStartupDerivedRefreshTimer.unref?.();
        return true;
    }

    _enqueueDerivedTask(type, run, options = {}) {
        if (this._shutdownRequested) return null;
        if (this._derivedTaskQueue.some(task => task.type === type && task.status === 'queued')) {
            return null;
        }

        const task = {
            id: `${type}-${Date.now()}-${++this._derivedTaskSequence}`,
            type,
            run,
            status: 'queued',
            attempts: 0,
            maxAttempts: options.maxAttempts ?? 3
        };
        this._derivedTaskQueue.push(task);
        this._scheduleDerivedTaskPump(0);
        return task.id;
    }

    _scheduleDerivedTaskPump(delayMs) {
        clearTimeout(this._derivedTaskTimer);
        this._derivedTaskTimer = setTimeout(() => {
            this._derivedTaskTimer = null;
            this._processDerivedTaskQueue();
        }, Math.max(0, delayMs));
        this._derivedTaskTimer.unref?.();
    }

    async _processDerivedTaskQueue() {
        if (this._shutdownRequested || this._derivedTaskRunning) return;
        const task = this._derivedTaskQueue.find(item => item.status === 'queued');
        if (!task) return;

        this._derivedTaskRunning = true;
        task.status = 'running';
        task.attempts++;
        try {
            const success = await task.run();
            if (!success) throw new Error('native derived task returned false');
            this._derivedTaskQueue = this._derivedTaskQueue.filter(item => item !== task);
        } catch (error) {
            if (task.attempts >= task.maxAttempts) {
                console.error(`[TagMemoEngine] Derived task failed: ${task.type}`, error.message || error);
                this._derivedTaskQueue = this._derivedTaskQueue.filter(item => item !== task);
            } else {
                task.status = 'queued';
                this._scheduleDerivedTaskPump(Math.min(900000, task.attempts * 60000));
            }
        } finally {
            this._derivedTaskRunning = false;
            if (this._derivedTaskQueue.some(item => item.status === 'queued')) {
                this._scheduleDerivedTaskPump(1000);
            }
        }
    }

    async shutdown(options = {}) {
        if (this._shutdownRequested) return;
        this._shutdownRequested = true;
        clearTimeout(this._matrixRebuildTimer);
        clearTimeout(this._postStartupDerivedRefreshTimer);
        clearTimeout(this._derivedTaskTimer);
        this._matrixRebuildTimer = null;
        this._postStartupDerivedRefreshTimer = null;
        this._derivedTaskTimer = null;
        this._derivedTaskQueue = this._derivedTaskQueue.filter(task => task.status === 'running');

        const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 1800000);
        const startedAt = Date.now();
        while (this._derivedTaskRunning && Date.now() - startedAt < timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        this._derivedTaskQueue = [];
    }
}

module.exports = TagMemoEngine;