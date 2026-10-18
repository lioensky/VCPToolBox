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
        this._refreshPollTimer = null;
        this._refreshCheckPromise = null;
        this._trainingTagCount = 0;
        this._derivedTaskTimer = null;
        this._derivedTaskQueue = [];
        this._derivedTaskRunning = false;
        this._derivedTaskSequence = 0;
        this._lastDerivedTask = null;
        this._currentDerivedTask = null;
        this._isMatrixRebuilding = false;
        this._shutdownRequested = false;
        this.geometryArtifact = null;

        // Retained as compatibility state only. Rust MemoRuntime owns all assets.
        this.tagCooccurrenceMatrix = null;
        this.tagIntrinsicResiduals = null;
        this.tagRawResidualRatios = null;
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
        // Polling covers restart, deletes and maintenance writes, not just ingestion.
        this._refreshPollTimer = setInterval(() => {
            this.scheduleMatrixRebuildForNewTags([]);
        }, 60000);
        this._refreshPollTimer.unref?.();
        console.log(
            `[TagMemoEngine] Native MemoRuntime owns unified geometry and graph assets; ` +
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

        if (this._activeArtifactBundle?.runtimeArtifactSig === nativeResult.artifactSig
            && this._activeArtifactBundle?.nativeGeneration === (Number(nativeResult.generation) || null)
            && this._activeArtifactBundle?.residentAtPublication === (nativeResult.resident === true)) {
            return this._activeArtifactBundle;
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
            geometryArtifact: this.geometryArtifact,
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

    _geometryConfig() {
        const kb = this.ragParams?.KnowledgeBaseManager || {};
        return JSON.parse(JSON.stringify(kb.geometry || {}));
    }

    async recomputeGeometry() {
        if (typeof this.tagIndex?.computeMemoGeometry !== 'function') {
            throw this._nativeUnavailable('computeMemoGeometry');
        }
        const dbPath = this.getDbPath();
        if (!dbPath) throw new Error('TagMemoEngine requires a native database path');
        const config = JSON.stringify(this._geometryConfig());
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const result = await this.tagIndex.computeMemoGeometry(dbPath, this.modelSig, config);
                if (!result?.success) throw new Error('Native geometry publication failed');
                this.geometryArtifact = Object.freeze({
                    artifactSig: result.artifactSig, modelSig: this.modelSig,
                    algorithmVersion: result.algorithmVersion, configHash: result.configHash
                });
                if (!await this._assertNativeHealth('unified geometry')) {
                    throw new Error('Native storage is unhealthy after geometry publication');
                }
                return result;
            } catch (error) {
                if (attempt || !/revision_conflict|DERIVED_(?:GENERATION|DEPENDENCY)_CONFLICT/.test(String(error.message))) throw error;
            }
        }
    }

    async doMatrixRebuild(options = {}) {
        if (this._shutdownRequested || this._isMatrixRebuilding) return false;
        this._isMatrixRebuilding = true;
        const processedTagIds = new Set(this._accumulatedNewTagIds);
        try {
            this.knowledgeBaseManager?._captureMemoryStage?.('training:geometry-begin');
            if (this._currentDerivedTask) this._currentDerivedTask.phase = 'geometry';
            const geometry = await this.recomputeGeometry();
            this.knowledgeBaseManager?._captureMemoryStage?.('training:geometry-end');
            if (!geometry) return false;

            if (!this.tagIndex || typeof this.tagIndex.rebuildMemoArtifact !== 'function') {
                throw this._nativeUnavailable('rebuildMemoArtifact');
            }

            if (this._currentDerivedTask) this._currentDerivedTask.phase = 'artifact';
            this.knowledgeBaseManager?._captureMemoryStage?.('training:artifact-begin');
            const dbPath = this.getDbPath();
            const effectiveConfig = this._effectiveNativeConfig();
            const result = await this.tagIndex.rebuildMemoArtifact(
                dbPath,
                JSON.stringify({
                    modelSig: this.modelSig,
                    effectiveConfig
                })
            );
            this.knowledgeBaseManager?._captureMemoryStage?.('training:artifact-end');
            if (
                !result?.success
                || result.persisted !== true
                || result.resident !== true
            ) {
                throw new Error('Native Memo artifact was not published as resident');
            }

            if (this._currentDerivedTask) this._currentDerivedTask.phase = 'publishing';
            const handle = this.publishNativeArtifactHandle(result, effectiveConfig);
            // A failed companion publication must be retried even when the V9
            // handle was already published on the previous attempt.
            if (this._lastCompanionPublishedHandle !== handle) {
                await this.knowledgeBaseManager?.onNativeMemoArtifactPublished?.(result, handle);
                this._lastCompanionPublishedHandle = handle;
            }
            if (this._currentDerivedTask) this._currentDerivedTask.artifactSig = result.artifactSig;
            for (const id of processedTagIds) this._accumulatedNewTagIds.delete(id);
            this._accumulatedTagChanges = this._accumulatedNewTagIds.size;
            return true;
        } finally {
            this._isMatrixRebuilding = false;
            this.knowledgeBaseManager?._captureMemoryStage?.('training:finished');
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

        const factsChanged = options.reason === 'tag-consistency-commit';
        const existing = this._derivedTaskQueue.find(task =>
            task.status === 'queued' || (!factsChanged && task.status === 'running'));
        if (existing) {
            return {
                taskId: existing.id, queued: true, alreadyRunning: true,
                reason: options.reason || 'admin-active-full-training',
                task: this.getTrainingStatus()
            };
        }
        clearTimeout(this._matrixRebuildTimer);
        this._matrixRebuildTimer = null;
        clearTimeout(this._postStartupDerivedRefreshTimer);
        this._postStartupDerivedRefreshTimer = null;
        const taskId = this._enqueueDerivedTask(
            'active-full-training',
            () => this.doMatrixRebuild({
                reason: options.reason || 'admin-active-full-training',
            }),
            { maxAttempts: options.maxAttempts ?? 1 }
        );
        return {
            taskId,
            queued: Boolean(taskId),
            reason: options.reason || 'admin-active-full-training',
            threshold: this._getMatrixRebuildThreshold(),
            task: this.getTrainingStatus()
        };
    }

    getTrainingStatus() {
        const task = this._derivedTaskQueue.find(item => item.status === 'running')
            || this._derivedTaskQueue.find(item => item.status === 'queued')
            || this._lastDerivedTask;
        if (!task) return { taskId: null, status: 'idle', phase: 'idle' };
        return {
            taskId: task.id, status: task.status, phase: task.phase,
            type: task.type, createdAt: task.createdAt, startedAt: task.startedAt,
            finishedAt: task.finishedAt, attempts: task.attempts,
            error: task.error || null, artifactSig: task.artifactSig || null
        };
    }

    _getMatrixRebuildThreshold() {
        return Math.max(1, Math.ceil(this._trainingTagCount * 0.01));
    }

    scheduleMatrixRebuildForNewTags(newTagIds = []) {
        if (!Array.isArray(newTagIds) || this._shutdownRequested) return Promise.resolve(false);
        // Keep the legacy entry point, but never infer refresh state from new IDs:
        // Rust counts unique changed tags durably, including relations and deletes.
        if (this._refreshCheckPromise) return this._refreshCheckPromise;
        const pending = this._checkMatrixRefresh().catch(error => {
            console.warn('[TagMemoEngine] Memo refresh check deferred; active graph retained:', error.message);
            return false;
        }).finally(() => {
            if (this._refreshCheckPromise === pending) this._refreshCheckPromise = null;
        });
        this._refreshCheckPromise = pending;
        return pending;
    }

    async _checkMatrixRefresh() {
        const owner = this.knowledgeBaseManager;
        const runtime = owner?.nativeKnowledgeRuntime;
        if (!runtime?.getNativeMemoManifest || !owner?._computeNativeMemoConfigHash) return false;
        const config = owner._buildNativeMemoEffectiveConfig();
        const raw = await runtime.getNativeMemoManifest(
            this.getDbPath(), this.modelSig, owner._computeNativeMemoConfigHash(config)
        );
        if (this._shutdownRequested) return false;
        const row = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!row) return false; // Startup bootstrap owns the no-compatible-artifact case.
        this._trainingTagCount = Math.max(0, Number(row.trainingTagCount) || 0);
        this._accumulatedTagChanges = Math.max(0, Number(row.changedTagCount) || 0);
        if (this._accumulatedTagChanges < this._getMatrixRebuildThreshold()) return false;
        if (this._matrixRebuildTimer || this._isMatrixRebuilding
            || this._derivedTaskQueue.some(task => task.status === 'queued' || task.status === 'running')) {
            return true;
        }
        // Fixed deadline: polling or continuous writes must not postpone training forever.
        this._matrixRebuildTimer = setTimeout(() => {
            this._matrixRebuildTimer = null;
            if (!this._shutdownRequested) {
                this._enqueueDerivedTask('threshold-rebuild', () => this.doMatrixRebuild({
                    reason: 'threshold'
                }));
            }
        }, this._getMatrixRebuildQuietMs());
        this._matrixRebuildTimer.unref?.();
        console.log(`[TagMemoEngine] Memo refresh queued: changedTags=${this._accumulatedTagChanges}, ` +
            `baselineTags=${this._trainingTagCount}, threshold=${this._getMatrixRebuildThreshold()} (1%); active graph retained.`);
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
            } else {
                this.scheduleMatrixRebuildForNewTags([]);
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
            phase: 'queued',
            createdAt: Date.now(),
            startedAt: null,
            finishedAt: null,
            error: null,
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
        task.startedAt = Date.now();
        task.error = null;
        this._currentDerivedTask = task;
        task.attempts++;
        try {
            const success = await task.run();
            if (!success) throw new Error('native derived task returned false');
            task.status = 'completed';
            task.phase = 'completed';
            task.finishedAt = Date.now();
            this._lastDerivedTask = task;
            this._derivedTaskQueue = this._derivedTaskQueue.filter(item => item !== task);
        } catch (error) {
            task.error = String(error.message || error);
            if (task.attempts >= task.maxAttempts) {
                task.status = 'failed';
                task.phase = 'failed';
                task.finishedAt = Date.now();
                this._lastDerivedTask = task;
                console.error(`[TagMemoEngine] Derived task failed: ${task.type}`, error.message || error);
                this._derivedTaskQueue = this._derivedTaskQueue.filter(item => item !== task);
            } else {
                task.status = 'queued';
                task.phase = 'retry-wait';
                this._scheduleDerivedTaskPump(Math.min(900000, task.attempts * 60000));
            }
        } finally {
            this._currentDerivedTask = null;
            this._derivedTaskRunning = false;
            if (!this._shutdownRequested && !this._derivedTaskTimer
                && this._derivedTaskQueue.some(item => item.status === 'queued')) {
                this._scheduleDerivedTaskPump(1000);
            }
        }
    }

    async shutdown(options = {}) {
        if (this._shutdownRequested) return;
        this._shutdownRequested = true;
        clearInterval(this._refreshPollTimer);
        this._refreshPollTimer = null;
        await this._refreshCheckPromise;
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