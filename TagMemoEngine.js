// TagMemoEngine.js
// 🌟 浪潮算法独立模块 (TagMemo Engine)
// 包含：浪潮增强、EPA 投影、残差金字塔分析、有序双向共现矩阵 (V8.2)、脉冲传播等核心逻辑

const path = require('path');
const crypto = require('crypto');
const EPAModule = require('./EPAModule');
const ResidualPyramid = require('./ResidualPyramid');

class TagMemoEngine {
    constructor(db, tagIndex, config, ragParams, knowledgeBaseManager = null) {
        this.db = db;
        this.tagIndex = tagIndex;
        this.config = config;
        this.ragParams = ragParams;
        this.knowledgeBaseManager = knowledgeBaseManager;

        this.epa = null;
        this.residualPyramid = null;
        this.tagCooccurrenceMatrix = null;
        // V9.1 单轨锚增益与数据库无关的原始残差比例。
        this.tagIntrinsicResiduals = null;
        this.tagRawResidualRatios = null;
        this.intrinsicResidualArtifact = null;

        // TagMemo V9.1: RCU 风格单轨活动资产包。
        // 发布后对象及其 Map 只读；重建始终创建全新的 Map，再一次性替换此指针。
        this._activeArtifactBundle = null;
        this._artifactBundlesByVersion = Object.freeze({});
        this._artifactBundleGeneration = 0;

        // 🌟 TagMemo V7.1: 矩阵计算防抖系统
        // V8.3: 阈值触发改为“唯一新增 tag”Set 累积，而不是 file_tags 关系数累加。
        // 共现矩阵仍以 file_tags 组关系为真相；这里只负责判断“是否真的出现了足够多没见过的新 tag”。
        this._accumulatedTagChanges = 0; // legacy 诊断字段，不再作为阈值主依据
        this._accumulatedNewTagIds = new Set();
        this._matrixRebuildTimer = null;
        this._matrixRebuildScheduleLogged = false;
        this._isMatrixRebuilding = false;
        // 🌟 V8: 最近一次距离场缓存（仅保留兼容/诊断用途；搜索链路必须使用查询级 energyField，避免 await 并发污染）
        this.lastEnergyField = null;
        this.lastEnergyFieldProvenance = null;

        // 🌟 V8.2-γ: 持久化的 Tag 对语义距离 (内存 Map: "a:b" → cosineSim)
        // 边视角的语义邻近度，与 tagIntrinsicResiduals (节点视角) 正交。
        this.tagPairSimilarities = new Map();
        // embedding 模型签名 (含维度)，跨模型自动失效
        this.modelSig = this._computeModelSig();
        // 是否在本进程内已经触发过冷启动 sim 预计算
        this._pairSimColdStartDone = false;
        this._postStartupDerivedRefreshTimer = null;
        this._derivedTaskQueue = [];
        this._derivedTaskRunning = false;
        this._derivedTaskTimer = null;
        this._derivedTaskSeq = 0;
        this._shutdownRequested = false;
    }

    _envFlag(name, defaultValue = false) {
        const raw = process.env[name];
        if (raw === undefined || raw === null || raw === '') return defaultValue;
        const normalized = String(raw).trim().toLowerCase();
        return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
    }

    _isEpaBackgroundRecomputeEnabled() {
        return this._envFlag('KNOWLEDGEBASE_EPA_BACKGROUND_RECOMPUTE', false);
    }

    _isIntrinsicResidualRecomputeEnabled() {
        return this._envFlag('TAGMEMO_INTRINSIC_RESIDUAL_FORCE_RECOMPUTE', false);
    }

    _isIntrinsicResidualThresholdRecomputeEnabled() {
        return this._envFlag('TAGMEMO_IR_RECOMPUTE_ON_THRESHOLD', true);
    }

    _getMatrixRebuildQuietMs() {
        const raw = Number(process.env.TAGMEMO_MATRIX_REBUILD_QUIET_MS);
        if (!Number.isFinite(raw)) return 300000;
        return Math.max(0, Math.floor(raw));
    }

    _hasWarmDerivedCaches() {
        const epaReady = !!(this.epa && this.epa.initialized && this.epa.orthoBasis && this.epa.orthoBasis.length > 0);
        const pairwiseReady = this.tagPairSimilarities instanceof Map && this.tagPairSimilarities.size > 0;
        const intrinsicReady = this.tagIntrinsicResiduals instanceof Map && this.tagIntrinsicResiduals.size > 0;
        const matrixReady = this.tagCooccurrenceMatrix instanceof Map && this.tagCooccurrenceMatrix.size > 0;
        return { epaReady, pairwiseReady, intrinsicReady, matrixReady };
    }

    _shouldSkipPostStartupDerivedRefresh() {
        const epaHotOff = !this._isEpaBackgroundRecomputeEnabled();
        const irHotOff = !this._isIntrinsicResidualRecomputeEnabled();
        const caches = this._hasWarmDerivedCaches();
        const noTagChanges = this._accumulatedNewTagIds.size <= 0;

        return {
            skip: epaHotOff && irHotOff && noTagChanges && caches.epaReady && caches.pairwiseReady && caches.intrinsicReady && caches.matrixReady,
            epaHotOff,
            irHotOff,
            noTagChanges,
            ...caches
        };
    }

    /**
     * 🌟 V8.2: 计算 embedding 模型签名（必须包含维度，
     * 防止 VECTORDB_DIMENSION 切换后读到维度错位的 BLOB）
     */
    _computeModelSig() {
        // EmbeddingModelSig 表示“向量语义空间签名”，与实际请求渠道解耦。
        // 未配置时回退到主 embedding 模型名，保持旧版本行为。
        const modelName = this.config?.modelSig || this.config?.model || 'unknown-model';
        const dim = this.config?.dimension || 0;
        return crypto.createHash('sha256')
            .update(`${modelName}:${dim}`)
            .digest('hex')
            .slice(0, 16);
    }

    _decodeVectorBlob(blob, dim, label = 'vector') {
        if (blob instanceof Float32Array) {
            return blob.length === dim ? blob : null;
        }
        if (!blob || typeof blob.length !== 'number') {
            return null;
        }

        const expectedBytes = dim * Float32Array.BYTES_PER_ELEMENT;
        if (blob.length !== expectedBytes) {
            console.warn(`[TagMemoEngine] ⚠️ Invalid ${label} blob length: expected ${expectedBytes}, got ${blob.length}`);
            return null;
        }

        if (blob.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
            return new Float32Array(blob.buffer, blob.byteOffset, dim);
        }

        const copied = Buffer.from(blob);
        return new Float32Array(copied.buffer, copied.byteOffset, dim);
    }

    _queryByChunks(sqlPrefix, values, sqlSuffix = '', chunkSize = 500) {
        if (!Array.isArray(values) || values.length === 0) return [];
        const rows = [];

        for (let i = 0; i < values.length; i += chunkSize) {
            const batch = values.slice(i, i + chunkSize);
            const placeholders = batch.map(() => '?').join(',');
            rows.push(...this.db.prepare(`${sqlPrefix} IN (${placeholders})${sqlSuffix}`).all(...batch));
        }

        return rows;
    }

    _deepFreezeConfig(value) {
        if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
        for (const child of Object.values(value)) this._deepFreezeConfig(child);
        return Object.freeze(value);
    }

    _computeGraphGeneration(matrix, pairwiseView, residualMap) {
        let edgeCount = 0;
        let edgeMass = 0;
        if (matrix instanceof Map) {
            for (const edges of matrix.values()) {
                if (!(edges instanceof Map)) continue;
                edgeCount += edges.size;
                for (const weight of edges.values()) edgeMass += Number(weight) || 0;
            }
        }
        return [
            `sources:${matrix instanceof Map ? matrix.size : 0}`,
            `edges:${edgeCount}`,
            `edgeMass:${edgeMass.toFixed(8)}`,
            `pairs:${pairwiseView instanceof Map ? pairwiseView.size : 0}`,
            `residuals:${residualMap instanceof Map ? residualMap.size : 0}`
        ].join('|');
    }

    _validateArtifactBundle(bundle) {
        if (!bundle || bundle.version !== 'v9') {
            throw new Error('ArtifactBundle must be the V9.1 production asset');
        }
        if (!bundle.artifactSig || !bundle.graphGeneration) {
            throw new Error('ArtifactBundle is missing signature/generation');
        }
        if (!(bundle.anchorGainMap instanceof Map) || !(bundle.propagationKernel instanceof Map)) {
            throw new Error('ArtifactBundle is missing anchor-gain/kernel Map');
        }
        if (!(bundle.rawResidualRatioMap instanceof Map)) {
            throw new Error('ArtifactBundle is missing raw residual ratio Map');
        }
        if (!(bundle.inboundMassMap instanceof Map) || !(bundle.hubSpecificityBaseMap instanceof Map)) {
            throw new Error('ArtifactBundle is missing precomputed inbound/hub-specificity Map');
        }
        if (!(bundle.pairwiseView instanceof Map)) {
            throw new Error('ArtifactBundle is missing pairwise Map');
        }
        for (const [source, edges] of bundle.propagationKernel.entries()) {
            if (!(edges instanceof Map)) {
                throw new Error(`ArtifactBundle kernel source ${source} is not a Map`);
            }
            for (const [target, weight] of edges.entries()) {
                if (!Number.isFinite(Number(weight)) || Number(weight) < 0) {
                    throw new Error(`ArtifactBundle kernel has invalid edge ${source}->${target}`);
                }
            }
        }
        return true;
    }

    _preparePublishedBundle(staging, generation, publishedAt) {
        this._validateArtifactBundle(staging);
        return Object.freeze({
            ...staging,
            effectiveConfig: this._deepFreezeConfig(staging.effectiveConfig),
            potentialFieldConfig: this._deepFreezeConfig(staging.potentialFieldConfig),
            publishedAt,
            generation
        });
    }

    releaseNativeOwnedArtifactAssets(expectedArtifactSig = null) {
        const active = this._activeArtifactBundle;
        if (!active) return false;
        if (
            expectedArtifactSig
            && active.artifactSig !== expectedArtifactSig
        ) {
            return false;
        }
        if (active.storageMode === 'rust-memo-runtime') return true;

        const lightweight = Object.freeze({
            version: active.version,
            artifactSig: active.artifactSig,
            graphGeneration: active.graphGeneration,
            modelSig: active.modelSig,
            effectiveConfig: active.effectiveConfig,
            potentialFieldConfig: active.potentialFieldConfig,
            residualArtifact: active.residualArtifact,
            algorithmVersion: active.algorithmVersion,
            generation: active.generation,
            publishedAt: active.publishedAt,
            storageMode: 'rust-memo-runtime'
        });
        this._activeArtifactBundle = lightweight;
        this._artifactBundlesByVersion = Object.freeze({
            generation: lightweight.generation,
            publishedAt: lightweight.publishedAt,
            activeVersion: 'v9',
            bundles: Object.freeze({ v9: lightweight })
        });

        // 断开所有兼容别名，确保 V9 Map、pairwise 和 residual 可被 GC。
        this.tagCooccurrenceMatrix = null;
        this.tagIntrinsicResiduals = null;
        this.tagRawResidualRatios = null;
        this.tagPairSimilarities = new Map();
        this.lastEnergyField = null;
        this.lastEnergyFieldProvenance = null;

        console.log(
            `[TagMemoEngine] 🦀 JS graph assets released; Rust MemoRuntime owns ` +
            `artifact=${lightweight.artifactSig}, generation=${lightweight.generation}.`
        );
        return true;
    }

    _assertJsGraphRuntimeAvailable(operation) {
        if (this._activeArtifactBundle?.storageMode === 'rust-memo-runtime') {
            const error = new Error(
                `${operation} uses the retired JS graph runtime; use the asynchronous unified Rust Memo API`
            );
            error.code = 'TAGMEMO_JS_GRAPH_RUNTIME_RETIRED';
            throw error;
        }
    }

    _publishArtifactBundle(staging) {
        const generation = ++this._artifactBundleGeneration;
        const publishedAt = Date.now();
        const bundle = this._preparePublishedBundle(staging, generation, publishedAt);

        // 单次引用替换发布完整 V9.1 资产，杜绝 residual/kernel/config 分别换代。
        const registry = Object.freeze({
            generation,
            publishedAt,
            activeVersion: 'v9',
            bundles: Object.freeze({ v9: bundle })
        });
        this._artifactBundlesByVersion = registry;
        this._activeArtifactBundle = bundle;
        this.tagCooccurrenceMatrix = bundle.propagationKernel;
        this.tagIntrinsicResiduals = bundle.anchorGainMap;
        this.tagRawResidualRatios = bundle.rawResidualRatioMap;
        this.tagPairSimilarities = bundle.pairwiseView;

        console.log(
            `[TagMemoEngine] 📦 V9.1 production artifact published atomically: ` +
            `generation=${generation}, artifact=${bundle.artifactSig}`
        );

        // RiverMemo 是 V9 的伴生派生资产。V9 必须先独立原子发布；
        // 伴生编译/落库失败只影响 RiverMemo，不得回滚已经健康的 V9。
        if (
            this.knowledgeBaseManager
            && typeof this.knowledgeBaseManager
                .onTagMemoArtifactPublished === 'function'
        ) {
            try {
                const companion =
                    this.knowledgeBaseManager.onTagMemoArtifactPublished(
                        bundle,
                        registry
                    );
                if (companion?.artifactSig) {
                    this.releaseNativeOwnedArtifactAssets(bundle.artifactSig);
                }
            } catch (error) {
                console.error(
                    '[TagMemoEngine] ⚠️ RiverMemo companion build failed after V9 publish; V9 remains active:',
                    error.message || error
                );
            }
        }
        return registry;
    }

    getArtifactBundleSnapshot(version = null) {
        const requestedVersion = version || 'v9';
        if (requestedVersion !== 'v9') return null;
        return this._artifactBundlesByVersion?.bundles?.v9 || this._activeArtifactBundle;
    }

    resolveArtifactBundle(options = {}) {
        const requestedVersion = options.version || 'v9';
        if (requestedVersion !== 'v9') {
            const error = new Error(
                `TagMemo artifact version "${requestedVersion}" was retired; V9.1 is the only supported production version`
            );
            error.code = 'TAGMEMO_VERSION_RETIRED';
            error.requestedVersion = requestedVersion;
            throw error;
        }

        const bundle = this.getArtifactBundleSnapshot('v9');
        if (!bundle) {
            const error = new Error('V9.1 TagMemo artifact bundle is unavailable');
            error.code = 'TAGMEMO_ARTIFACT_UNAVAILABLE';
            throw error;
        }

        return {
            bundle,
            requestedVersion: 'v9',
            effectiveVersion: 'v9',
            fallbackUsed: false,
            fallbackReason: null,
            explicitVersion: options.version !== undefined && options.version !== null,
            strictVersion: true
        };
    }

    _buildV9PropagationKernel(factMatrix, residualMap, v9Config = {}) {
        const kernel = new Map();
        const wormholeEdges = new Set();
        const outboundMass = Math.max(0.01, Math.min(1, Number(v9Config.outboundMass ?? 0.95)));
        // V9.1 仍让虫洞在总预算内竞争；association reserve 不产生额外能量。
        const associationReserveMass = Math.min(
            Math.max(0, Number(v9Config.associationReserveMass ?? 0.05)),
            outboundMass
        );
        const evidenceCompression = Math.max(0.01, Number(v9Config.evidenceCompression ?? 1));
        const wormholeGain = Math.max(1, Number(v9Config.wormholeGain ?? 1.35));
        const tensionThreshold = Math.max(0, Number(v9Config.tensionThreshold ?? 1));
        const hubPenaltyExponent = Math.max(0, Math.min(1, Number(v9Config.hubPenaltyExponent ?? 0.3)));
        const hubPenaltyFloor = Math.max(0.05, Math.min(1, Number(v9Config.hubPenaltyFloor ?? 0.55)));
        const hubPenaltyCeiling = Math.max(1, Math.min(4, Number(v9Config.hubPenaltyCeiling ?? 1.8)));
        const hubSmoothingRatio = Math.max(0.01, Math.min(2, Number(v9Config.hubSmoothingRatio ?? 0.1)));

        // 第一遍：保留每条边的未归一化证据，并统计目标节点吸收的全图入流。
        // 入流统计必须发生在行归一化之前，否则无法识别“从许多来源吸积少量质量”的通用枢纽。
        const rawRows = new Map();
        const targetInflows = new Map();
        for (const [sourceId, edges] of factMatrix.entries()) {
            if (!(edges instanceof Map) || edges.size === 0) continue;
            const rawEdges = [];
            for (const [targetId, compatWeight] of edges.entries()) {
                const evidence = Math.log1p(Math.max(0, Number(compatWeight) || 0) * evidenceCompression);
                const residual = residualMap?.get(targetId) ?? 1;
                const isWormhole = evidence * residual >= tensionThreshold;
                const rawConductance = evidence * (isWormhole ? wormholeGain : 1);
                if (!Number.isFinite(rawConductance) || rawConductance <= 0) continue;
                rawEdges.push([targetId, rawConductance, isWormhole]);
                targetInflows.set(targetId, (targetInflows.get(targetId) || 0) + rawConductance);
            }
            if (rawEdges.length > 0) rawRows.set(sourceId, rawEdges);
        }

        const positiveInflows = [...targetInflows.values()]
            .filter(value => Number.isFinite(value) && value > 0)
            .sort((a, b) => a - b);
        const medianInflow = positiveInflows.length > 0
            ? positiveInflows[Math.floor(positiveInflows.length / 2)]
            : 1;
        const smoothing = Math.max(1e-9, medianInflow * hubSmoothingRatio);

        // 第二遍：按“相对中位入流”温和抑制枢纽，再统一归一化到固定行预算。
        // 夹逼防止罕见节点被无限奖励，也防止真实核心概念被过度压低。
        for (const [sourceId, rawEdges] of rawRows.entries()) {
            const adjustedEdges = [];
            let adjustedSum = 0;
            let wormholeAdjustedSum = 0;

            for (const [targetId, rawConductance, isWormhole] of rawEdges) {
                const relativeInflow = (targetInflows.get(targetId) || 0) / (medianInflow + smoothing);
                const rawPenalty = hubPenaltyExponent > 0
                    ? Math.pow(Math.max(1e-9, relativeInflow), -hubPenaltyExponent)
                    : 1;
                const hubPenalty = Math.max(hubPenaltyFloor, Math.min(hubPenaltyCeiling, rawPenalty));
                const adjustedConductance = rawConductance * hubPenalty;
                if (!Number.isFinite(adjustedConductance) || adjustedConductance <= 0) continue;
                adjustedEdges.push([targetId, adjustedConductance, isWormhole]);
                adjustedSum += adjustedConductance;
                if (isWormhole) wormholeAdjustedSum += adjustedConductance;
            }

            if (adjustedSum <= 0) continue;
            const normalizedEdges = new Map();
            const reserveMass = wormholeAdjustedSum > 0 ? associationReserveMass : 0;
            const mainMass = outboundMass - reserveMass;
            for (const [targetId, adjustedConductance, isWormhole] of adjustedEdges) {
                const mainConductance = mainMass * adjustedConductance / adjustedSum;
                const associationConductance = isWormhole && wormholeAdjustedSum > 0
                    ? reserveMass * adjustedConductance / wormholeAdjustedSum
                    : 0;
                normalizedEdges.set(targetId, mainConductance + associationConductance);
                if (isWormhole) wormholeEdges.add(`${sourceId}:${targetId}`);
            }
            kernel.set(sourceId, normalizedEdges);
        }

        return {
            kernel,
            wormholeEdges,
            outboundMass,
            kernelDiagnostics: Object.freeze({
                algorithmVersion: 'v9.1-hub-aware',
                medianInflow,
                targetCount: targetInflows.size,
                hubPenaltyExponent,
                hubPenaltyFloor,
                hubPenaltyCeiling
            })
        };
    }

    _buildInboundArtifacts(kernel) {
        const inboundMassMap = new Map();
        let maxInbound = 0;

        if (kernel instanceof Map) {
            for (const edges of kernel.values()) {
                if (!(edges instanceof Map)) continue;
                for (const [rawTargetId, rawConductance] of edges.entries()) {
                    const targetId = Number(rawTargetId);
                    const conductance = Math.max(0, Number(rawConductance) || 0);
                    if (!Number.isFinite(targetId) || conductance <= 0) continue;
                    const next = (inboundMassMap.get(targetId) || 0) + conductance;
                    inboundMassMap.set(targetId, next);
                    if (next > maxInbound) maxInbound = next;
                }
            }
        }

        // 不带 publicHubFloor 的基础 specificity，只依赖图资产；查询热参数可在 O(1) 读取后施加 floor。
        const hubSpecificityBaseMap = new Map();
        for (const [tagId, inboundMass] of inboundMassMap.entries()) {
            const ratio = maxInbound > 0 ? Math.max(0, Math.min(1, inboundMass / maxInbound)) : 0;
            hubSpecificityBaseMap.set(tagId, 1 - Math.sqrt(ratio));
        }

        return { inboundMassMap, maxInbound, hubSpecificityBaseMap };
    }

    _stageAndPublishV91Bundle(factMatrix) {
        const pairwiseView = this.tagPairSimilarities instanceof Map
            ? this.tagPairSimilarities
            : new Map();
        const anchorGainMap = this.tagIntrinsicResiduals instanceof Map
            ? this.tagIntrinsicResiduals
            : new Map();
        const rawResidualRatioMap = this.tagRawResidualRatios instanceof Map
            ? this.tagRawResidualRatios
            : new Map();
        const kbConfig = JSON.parse(JSON.stringify(
            this.ragParams?.KnowledgeBaseManager || {}
        ));
        const v9Config = kbConfig.v9 || {};
        const potentialFieldConfig = kbConfig.potentialFieldRerank
            || kbConfig.geodesicRerank
            || {};
        const build = this._buildV9PropagationKernel(factMatrix, anchorGainMap, v9Config);
        const inboundArtifacts = this._buildInboundArtifacts(build.kernel);
        const graphGeneration = this._computeGraphGeneration(
            build.kernel,
            pairwiseView,
            anchorGainMap
        );
        const effectiveConfig = JSON.parse(JSON.stringify(kbConfig));
        const artifactSig = crypto.createHash('sha256')
            .update(JSON.stringify({
                version: 'v9',
                algorithmVersion: 'v9.1',
                modelSig: this.modelSig,
                graphGeneration,
                residualArtifact: this.intrinsicResidualArtifact?.artifactSig || 'legacy',
                effectiveConfig
            }))
            .digest('hex')
            .slice(0, 24);

        return this._publishArtifactBundle({
            version: 'v9',
            artifactSig,
            graphGeneration,
            modelSig: this.modelSig,
            effectiveConfig,
            // 明确物理量语义；residualMap 仅保留为旧调用兼容别名。
            anchorGainMap,
            rawResidualRatioMap,
            residualMap: anchorGainMap,
            propagationKernel: build.kernel,
            inboundMassMap: inboundArtifacts.inboundMassMap,
            maxInbound: inboundArtifacts.maxInbound,
            hubSpecificityBaseMap: inboundArtifacts.hubSpecificityBaseMap,
            pairwiseView,
            potentialFieldConfig: JSON.parse(JSON.stringify(potentialFieldConfig)),
            residualArtifact: this.intrinsicResidualArtifact
                ? Object.freeze({ ...this.intrinsicResidualArtifact })
                : null,
            wormholeEdges: build.wormholeEdges,
            outboundMass: build.outboundMass,
            kernelDiagnostics: build.kernelDiagnostics,
            algorithmVersion: 'v9.1'
        });
    }

    async initialize() {
        // 初始化 EPA 和残差金字塔模块
        this.epa = new EPAModule(this.db, {
            dimension: this.config.dimension,
            vexusIndex: this.tagIndex,
            nodeResidual: this.ragParams.KnowledgeBaseManager?.nodeResidualGain || 0.05,
            withRustWriteLease: (owner, fn, options = {}) => this._withRustWriteLease(owner, fn, options),
            deferRustRecompute: true,
        });
        await this.epa.initialize();

        this.residualPyramid = new ResidualPyramid(this.tagIndex, this.db, {
            dimension: this.config.dimension
        });

        // 🌟 V8.2-γ: 冷启动只做检测，不在 initialize() 内阻塞派生计算。
        // 大库下 pairwise/EPA 派生写会延后到 System Ready + startup cooldown 后由后台刷新触发，
        // 以避免和启动 full scan / 小巴士主写产生 WAL/checkpoint 竞态。
        try {
            const cnt = this.db.prepare(
                'SELECT COUNT(*) as c FROM tag_pair_similarity WHERE model_sig = ?'
            ).get(this.modelSig)?.c || 0;

            if (cnt === 0) {
                console.log(`[TagMemoEngine] 🧊 V8.2 cold start: pairwise similarity cache empty for model_sig=${this.modelSig}; will refresh after startup cooldown.`);
            } else {
                console.log(`[TagMemoEngine] 🌡️ V8.2 warm start: ${cnt} cached pairwise similarities for model_sig=${this.modelSig}`);
            }
        } catch (e) {
            console.warn('[TagMemoEngine] ⚠️ V8.2 cold start check failed (table may not exist yet):', e.message);
        }

        // 加载矩阵依赖的持久化底座：边相似度 + 节点内生残差
        this.loadPairwiseSimilarities();
        this.loadIntrinsicResiduals();

        // 启动时构建共现矩阵：确保 reverseAnchorBoost 能吃到已加载残差
        this.buildDirectedCooccurrenceMatrix();
    }

    /**
     * 更新热调控参数
     */
    updateRagParams(params) {
        this.ragParams = params;
        if (this.epa) {
            // 如果 EPA 支持动态更新参数，可以在这里调用
        }
    }

    _propagateSpikes(initialTags, queryMatrix, queryResiduals, queryWormholeEdges, srConfig = {}) {
        const MAX_SAFE_HOPS = srConfig.maxSafeHops ?? 4;
        const BASE_MOMENTUM = srConfig.baseMomentum ?? 2.0;
        const FIRING_THRESHOLD = srConfig.firingThreshold ?? 0.10;
        const BASE_DECAY = srConfig.baseDecay ?? 0.25;
        const WORMHOLE_DECAY = srConfig.wormholeDecay ?? 0.70;
        const TENSION_THRESHOLD = srConfig.tensionThreshold ?? 1.0;
        const MAX_NEIGHBORS_PER_NODE = srConfig.maxNeighborsPerNode ?? 20;

        // V9.1 使用有前驱记忆的传播状态，精确识别 i→j→i 的立即回流。
        // 状态数量设硬上限，防止边状态在高分支图中指数增长。
        const returnFlowFactor = Math.max(0, Math.min(1, Number(srConfig.v91ReturnFlowFactor ?? 0.15)));
        const firGamma = Math.max(0.05, Math.min(0.95, Number(srConfig.v91FirGamma ?? 0.6)));
        const maxPropagationStates = Math.max(100, Math.floor(Number(srConfig.v91MaxPropagationStates ?? 2000)));
        const firWeights = [];
        let firWeightSum = 0;
        for (let hop = 0; hop <= MAX_SAFE_HOPS; hop++) {
            const weight = Math.pow(firGamma, hop);
            firWeights.push(weight);
            firWeightSum += weight;
        }
        if (firWeightSum > 0) {
            for (let hop = 0; hop < firWeights.length; hop++) firWeights[hop] /= firWeightSum;
        }

        // key 为 prev:node，V9.1 使用前驱边状态抑制立即回流。
        // provenance 记录查询场节点来自显式核心、原始种子还是第几跳涌现，
        // 让读出层区分“直接事实证据”和“传播后的主题共振”。
        let activeSpikes = new Map();
        const accumulatedEnergy = new Map();
        const fieldProvenance = new Map();
        // V10 共享观测需要的不只是最终节点势，还需要查询诱导传播过程中
        // 实际承载过质量的有向边。该资产严格请求级，不写入全局 Artifact。
        const riverEdgeFlow = new Map();
        const strongestParentByNode = new Map();
        for (const tag of initialTags) {
            const key = `seed:${tag.id}`;
            const sourceType = tag.isCore ? 'core' : 'seed';
            activeSpikes.set(key, {
                nodeId: tag.id,
                previousNodeId: null,
                energy: tag.adjustedWeight,
                momentum: BASE_MOMENTUM,
                sourceType,
                hop: 0
            });
            accumulatedEnergy.set(tag.id, tag.adjustedWeight * firWeights[0]);
            fieldProvenance.set(Number(tag.id), {
                sourceType,
                hop: 0,
                seedId: Number(tag.id)
            });
        }

        const diagnostics = {
            algorithmVersion: 'v9.1-soft-nonbacktracking-fir',
            returnFlowSuppressedMass: 0,
            stateTruncations: 0,
            hopInFlightMass: []
        };

        for (let hop = 0; hop < MAX_SAFE_HOPS; hop++) {
            const nextSpikes = new Map();
            let propagated = false;
            let inFlightMass = 0;

            for (const spike of activeSpikes.values()) {
                if (spike.energy < FIRING_THRESHOLD || spike.momentum < 0) continue;
                const synapses = queryMatrix.get(spike.nodeId);
                if (!synapses) continue;

                const sortedSynapses = Array.from(synapses.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, MAX_NEIGHBORS_PER_NODE);

                for (const [neighborId, coocWeight] of sortedSynapses) {
                    const neighborResidual = queryResiduals?.get(neighborId) ?? 1.0;
                    const tension = coocWeight * neighborResidual;
                    const isWormhole = queryWormholeEdges instanceof Set
                        ? queryWormholeEdges.has(`${spike.nodeId}:${neighborId}`)
                        : tension >= TENSION_THRESHOLD;
                    const decayFactor = isWormhole ? WORMHOLE_DECAY : BASE_DECAY;
                    const momentumCost = isWormhole ? 0 : 1.0;
                    const isImmediateReturn = spike.previousNodeId !== null
                        && neighborId === spike.previousNodeId;
                    const flowFactor = isImmediateReturn ? returnFlowFactor : 1;
                    const unpenalizedCurrent = spike.energy * coocWeight * decayFactor;
                    const injectedCurrent = unpenalizedCurrent * flowFactor;
                    if (isImmediateReturn) {
                        diagnostics.returnFlowSuppressedMass += unpenalizedCurrent - injectedCurrent;
                    }
                    if (injectedCurrent < 0.01) continue;

                    const sourceId = Number(spike.nodeId);
                    const targetId = Number(neighborId);
                    const edgeKey = `${sourceId}:${targetId}`;
                    const previousEdge = riverEdgeFlow.get(edgeKey);
                    if (previousEdge) {
                        previousEdge.flow += injectedCurrent;
                        previousEdge.maxFlow = Math.max(
                            previousEdge.maxFlow,
                            injectedCurrent
                        );
                        previousEdge.minHop = Math.min(
                            previousEdge.minHop,
                            spike.hop + 1
                        );
                    } else {
                        riverEdgeFlow.set(edgeKey, {
                            sourceId,
                            targetId,
                            flow: injectedCurrent,
                            maxFlow: injectedCurrent,
                            conductance: Math.max(0, Number(coocWeight) || 0),
                            minHop: spike.hop + 1,
                            wormhole: isWormhole,
                            immediateReturn: isImmediateReturn
                        });
                    }
                    const previousParent = strongestParentByNode.get(targetId);
                    if (
                        !previousParent
                        || injectedCurrent > previousParent.flow
                        || (
                            injectedCurrent === previousParent.flow
                            && spike.hop + 1 < previousParent.hop
                        )
                    ) {
                        strongestParentByNode.set(targetId, {
                            parentId: sourceId,
                            flow: injectedCurrent,
                            hop: spike.hop + 1,
                            wormhole: isWormhole
                        });
                    }

                    const nextMomentum = spike.momentum - momentumCost;
                    if (nextMomentum < 0 && !isWormhole) continue;

                    const stateKey = `${spike.nodeId}:${neighborId}`;
                    const existing = nextSpikes.get(stateKey);
                    if (existing) {
                        existing.energy += injectedCurrent;
                        existing.momentum = Math.max(existing.momentum, nextMomentum);
                        if (spike.hop + 1 < existing.hop) {
                            existing.hop = spike.hop + 1;
                            existing.sourceType = spike.sourceType;
                        }
                    } else {
                        nextSpikes.set(stateKey, {
                            nodeId: neighborId,
                            previousNodeId: spike.nodeId,
                            energy: injectedCurrent,
                            momentum: nextMomentum,
                            sourceType: spike.sourceType,
                            hop: spike.hop + 1
                        });
                    }
                }
            }

            if (nextSpikes.size > maxPropagationStates) {
                const retained = [...nextSpikes.entries()]
                    .sort((a, b) => b[1].energy - a[1].energy)
                    .slice(0, maxPropagationStates);
                diagnostics.stateTruncations += nextSpikes.size - retained.length;
                nextSpikes.clear();
                for (const [key, value] of retained) nextSpikes.set(key, value);
            }

            const nodeEnergyThisHop = new Map();
            for (const newSpike of nextSpikes.values()) {
                nodeEnergyThisHop.set(
                    newSpike.nodeId,
                    (nodeEnergyThisHop.get(newSpike.nodeId) || 0) + newSpike.energy
                );
                const numericNodeId = Number(newSpike.nodeId);
                const previousProvenance = fieldProvenance.get(numericNodeId);
                if (!previousProvenance || newSpike.hop < previousProvenance.hop) {
                    fieldProvenance.set(numericNodeId, {
                        sourceType: 'emergent',
                        originType: newSpike.sourceType,
                        hop: newSpike.hop
                    });
                }
                inFlightMass += newSpike.energy;
            }
            diagnostics.hopInFlightMass.push(inFlightMass);

            const fieldWeight = firWeights[hop + 1];
            for (const [nodeId, energy] of nodeEnergyThisHop.entries()) {
                accumulatedEnergy.set(
                    nodeId,
                    (accumulatedEnergy.get(nodeId) || 0) + energy * fieldWeight
                );
                if (energy > 0.01) propagated = true;
            }

            if (!propagated) break;
            activeSpikes = nextSpikes;
        }

        const maximumNodeEnergy = Math.max(
            0,
            ...accumulatedEnergy.values()
        );
        const maximumEdgeFlow = Math.max(
            0,
            ...[...riverEdgeFlow.values()].map(edge => edge.flow)
        );
        const riverGraph = Object.freeze({
            schema: 'tagmemo-query-spike-river-v1',
            nodes: Object.freeze(
                [...accumulatedEnergy.entries()]
                    .map(([rawId, rawEnergy]) => {
                        const id = Number(rawId);
                        const provenance = fieldProvenance.get(id) || {};
                        const parent = strongestParentByNode.get(id) || null;
                        return Object.freeze({
                            id,
                            energy: Math.max(0, Number(rawEnergy) || 0),
                            normalizedEnergy: maximumNodeEnergy > 0
                                ? Math.max(0, Number(rawEnergy) || 0)
                                    / maximumNodeEnergy
                                : 0,
                            sourceType: provenance.sourceType || 'unknown',
                            originType: provenance.originType || null,
                            hop: Number.isFinite(provenance.hop)
                                ? provenance.hop
                                : null,
                            seedId: Number.isFinite(provenance.seedId)
                                ? provenance.seedId
                                : null,
                            strongestParent: parent
                                ? Object.freeze({ ...parent })
                                : null
                        });
                    })
                    .sort((left, right) =>
                        (right.energy - left.energy) || (left.id - right.id)
                    )
            ),
            edges: Object.freeze(
                [...riverEdgeFlow.values()]
                    .map(edge => Object.freeze({
                        ...edge,
                        normalizedFlow: maximumEdgeFlow > 0
                            ? edge.flow / maximumEdgeFlow
                            : 0
                    }))
                    .sort((left, right) =>
                        (right.flow - left.flow)
                        || (left.sourceId - right.sourceId)
                        || (left.targetId - right.targetId)
                    )
            ),
            diagnostics: Object.freeze({
                seedNodes: initialTags.length,
                reachedNodes: accumulatedEnergy.size,
                activeEdges: riverEdgeFlow.size,
                maximumNodeEnergy,
                maximumEdgeFlow
            })
        });

        return {
            accumulatedEnergy,
            fieldProvenance,
            diagnostics,
            riverGraph
        };
    }

    /**
     * 🌟 TagMemo 浪潮 + EPA + Residual Pyramid + Worldview Gating + LIF Spike Propagation (V6)
     *
     * 返回值中的 energyField 是查询级距离场。不要依赖 lastEnergyField 参与搜索重排：
     * lastEnergyField 只是兼容/诊断缓存，在全局搜索 await 间隙会被其他并发查询覆盖。
     */
    applyTagBoost(vector, baseTagBoost, coreTags = [], coreBoostFactor = 1.33, options = {}) {
        this._assertJsGraphRuntimeAvailable('TagMemoEngine.applyTagBoost()');
        const debug = false;
        const originalFloat32 = vector instanceof Float32Array ? vector : new Float32Array(vector);
        const dim = originalFloat32.length;
        // 请求开始时只解析一次活动指针；后续后台发布不会改变本次查询持有的对象。
        const resolution = options.artifactBundle
            ? {
                bundle: options.artifactBundle,
                requestedVersion: options.version || options.artifactBundle.version,
                effectiveVersion: options.artifactBundle.version,
                fallbackUsed: false,
                fallbackReason: null
            }
            : this.resolveArtifactBundle(options);
        const artifactBundle = resolution.bundle;
        const queryMatrix = artifactBundle?.propagationKernel || this.tagCooccurrenceMatrix;
        const queryResiduals = artifactBundle?.anchorGainMap || artifactBundle?.residualMap || this.tagIntrinsicResiduals;
        const queryVersion = 'v9';
        const queryWormholeEdges = artifactBundle?.wormholeEdges;

        try {
            // 🌟 V8: 清空旧距离场，防止跨调用数据泄露
            this.lastEnergyField = null;
            this.lastEnergyFieldProvenance = null;

            // [1] EPA 分析 (逻辑深度与共振) - 识别"你在哪个世界"
            const epaResult = this.epa.project(originalFloat32);
            const resonance = this.epa.detectCrossDomainResonance(originalFloat32);
            const queryWorld = epaResult.dominantAxes[0]?.label || 'Unknown';

            // [2] 残差金字塔分析 (新颖度与覆盖率) - 90% 能量截断
            const pyramid = this.residualPyramid.analyze(originalFloat32);
            const features = pyramid.features;

            // [3] 动态调整策略
            // 配置与核/残差属于同一不可变资产包，禁止在请求中途读取热更新后的 ragParams。
            const config = artifactBundle?.effectiveConfig || this.ragParams?.KnowledgeBaseManager || {};
            const logicDepth = epaResult.logicDepth;        // 0~1, 高=逻辑聚焦
            const entropyPenalty = epaResult.entropy;       // 0~1, 高=信息散乱
            const resonanceBoost = Math.log(1 + resonance.resonance);

            // 核心公式：结合 EPA 和残差特征
            const actRange = config.activationMultiplier || [0.5, 1.5];
            const activationMultiplier = actRange[0] + features.tagMemoActivation * (actRange[1] - actRange[0]);
            const dynamicBoostFactor = (logicDepth * (1 + resonanceBoost) / (1 + entropyPenalty * 0.5)) * activationMultiplier;

            const boostRange = config.dynamicBoostRange || [0.3, 2.0];
            const effectiveTagBoost = baseTagBoost * Math.max(boostRange[0], Math.min(boostRange[1], dynamicBoostFactor));

            // 🌟 动态核心加权优化 (Dynamic Core Boost Optimization)
            // 目标范围：1.20 (20%) ~ 1.40 (40%)
            // 逻辑：逻辑深度越高（意图明确）或覆盖率越低（新领域需要锚点），核心标签权重越高
            const coreMetric = (logicDepth * 0.5) + ((1 - features.coverage) * 0.5);
            const coreRange = config.coreBoostRange || [1.20, 1.40];
            const dynamicCoreBoostFactor = coreRange[0] + (coreMetric * (coreRange[1] - coreRange[0]));

            if (debug) {
                console.log(`[TagMemo-V6] World=${queryWorld}, Depth=${logicDepth.toFixed(3)}, Resonance=${resonance.resonance.toFixed(3)}`);
                console.log(`[TagMemo-V6] Coverage=${features.coverage.toFixed(3)}, Explained=${(pyramid.totalExplainedEnergy * 100).toFixed(1)}%`);
                console.log(`[TagMemo-V6] Effective Boost: ${effectiveTagBoost.toFixed(3)}, Dynamic Core Boost: ${dynamicCoreBoostFactor.toFixed(3)}`);
            }

            // [4] 收集金字塔中的所有 Tags 并应用“世界观门控”与“语言补偿”
            const allTags = [];
            const seenTagIds = new Set();

            // 🌟 莱恩的鲁棒分流法：鸭子类型分离输入参数
            const coreTagStrings = [];
            const hardGhostObjects = [];
            const softGhostObjects = [];

            if (Array.isArray(coreTags)) {
                coreTags.forEach(t => {
                    if (typeof t === 'string') {
                        coreTagStrings.push(t.toLowerCase());
                    } else if (t && t.name && t.vector) {
                        // 如果带有向量，说明是幽灵对象，按 isCore 再次分流
                        if (t.isCore) hardGhostObjects.push(t);
                        else softGhostObjects.push(t);
                    }
                });
            }
            // 这个 Set 只管原生的字符串补全逻辑
            const coreTagSet = new Set(coreTagStrings);

            // 🛡️ 防御性检查：确保 pyramid.levels 存在且为数组
            const levels = Array.isArray(pyramid.levels) ? pyramid.levels : [];

            levels.forEach(level => {
                // 🛡️ 防御性检查：确保 level.tags 存在且为数组
                const tags = Array.isArray(level.tags) ? level.tags : [];

                tags.forEach(t => {
                    if (!t || seenTagIds.has(t.id)) return;

                    // 🌟 核心 Tag 增强逻辑 (Spotlight)
                    // 安全访问 t.name
                    const tagName = t.name ? t.name.toLowerCase() : '';
                    const isCore = tagName && coreTagSet.has(tagName);
                    // 🌟 个体相关度微调：如果核心标签本身与查询高度相关，在动态基准上给予额外奖励 (0.95 ~ 1.05x)
                    const individualRelevance = t.similarity || 0.5;
                    const coreBoost = isCore ? (dynamicCoreBoostFactor * (0.95 + individualRelevance * 0.1)) : 1.0;

                    // A. 语言置信度补偿 (Language Confidence Gating)
                    // 如果是纯英文技术词汇且当前不是技术语境，引入惩罚
                    let langPenalty = 1.0;
                    if (this.config.langConfidenceEnabled) {
                        // 扩展技术噪音检测：非中文且符合技术命名特征（允许空格以覆盖如 Dadroit JSON Viewer）
                        // 安全访问 t.name
                        const tName = t.name || '';
                        const isTechnicalNoise = !/[\u4e00-\u9fa5]/.test(tName) && /^[A-Za-z0-9\-_.\s]+$/.test(tName) && tName.length > 3;
                        const isTechnicalWorld = queryWorld !== 'Unknown' && /^[A-Za-z0-9\-_.]+$/.test(queryWorld);

                        if (isTechnicalNoise && !isTechnicalWorld) {
                            // 🌟 阶梯式语言补偿：不再一刀切
                            // 如果是政治/社会世界观，减轻对英文实体的压制（可能是 Trump, Musk 等重要实体）
                            // 🌟 更加鲁棒的世界观判定：使用模糊匹配
                            const isSocialWorld = /Politics|Society|History|Economics|Culture/i.test(queryWorld);
                            const comp = config.languageCompensator || {};
                            const basePenalty = queryWorld === 'Unknown'
                                ? (comp.penaltyUnknown ?? this.config.langPenaltyUnknown)
                                : (comp.penaltyCrossDomain ?? this.config.langPenaltyCrossDomain);
                            langPenalty = isSocialWorld ? Math.sqrt(basePenalty) : basePenalty; // 使用平方根软化惩罚
                        }
                    }

                    // B. 世界观门控 (Worldview Gating)
                    // 简单实现：如果 Tag 本身有向量，检查其与查询世界的正交性
                    // 这里暂用 layerDecay 代替复杂的实时投影以保证性能
                    const layerDecay = Math.pow(0.7, level.level);

                    allTags.push({
                        ...t,
                        adjustedWeight: (t.contribution || t.weight || 0) * layerDecay * langPenalty * coreBoost,
                        isCore: isCore
                    });
                    seenTagIds.add(t.id);
                });
            });

            // [4.5] 仿脑认知扩散 (Spike Propagation / Lif-Router)
            // 🔧 重构 V7：动量与残差张力驱动的虫洞跃迁 (Wormhole Routing)
            let propagationDiagnostics = null;
            let queryRiverGraph = null;
            if (allTags.length > 0 && queryMatrix) {
                const srConfig = config.spikeRouting || {};
                const MAX_EMERGENT_NODES = srConfig.maxEmergentNodes ?? 50;

                const propagation = this._propagateSpikes(
                    allTags,
                    queryMatrix,
                    queryResiduals,
                    queryWormholeEdges,
                    srConfig
                );
                const accumulatedEnergy = propagation.accumulatedEnergy;
                const fieldProvenance = propagation.fieldProvenance;
                propagationDiagnostics = propagation.diagnostics;
                queryRiverGraph = propagation.riverGraph || null;

                // 查询级缓存仅用于返回；并发搜索必须继续显式传递 energyField 与 provenance。
                this.lastEnergyField = accumulatedEnergy;
                this.lastEnergyFieldProvenance = fieldProvenance;

                // 4. 将涌现出来的高电位节点，重新塞回到 allTags
                const allTagsMap = new Map();
                allTags.forEach(t => allTagsMap.set(t.id, t));

                const newAllTags = [];
                const emergentCandidates = [];
                seenTagIds.clear();

                for (const [nid, emergentEnergy] of accumulatedEnergy.entries()) {
                    if (allTagsMap.has(nid)) {
                        // 原始就有这个 Tag (种子节点)
                        const existingTag = allTagsMap.get(nid);
                        // 🌟 小克的精妙细节：取 max，防止种子被双向/循环共现不合理膨胀
                        existingTag.adjustedWeight = Math.max(existingTag.adjustedWeight, emergentEnergy);
                        newAllTags.push(existingTag);
                        seenTagIds.add(nid);
                    } else {
                        // 纯粹因为拓扑传导「涌现」出来的关联节点
                        emergentCandidates.push({
                            id: nid,
                            adjustedWeight: emergentEnergy,
                            isPullback: true // 涌现节点标记
                        });
                    }
                }
                
                // 🔧 涌现节点强截断
                emergentCandidates.sort((a, b) => b.adjustedWeight - a.adjustedWeight);
                const topEmergent = emergentCandidates.slice(0, MAX_EMERGENT_NODES);
                topEmergent.forEach(t => {
                    newAllTags.push(t);
                    seenTagIds.add(t.id);
                });

                if (debug && topEmergent.length > 0) {
                    console.log(`[TagMemo-V7 Spike] Seeds=${allTagsMap.size}, Emergent=${topEmergent.length} (capped from ${emergentCandidates.length}), Total=${newAllTags.length}`);
                }
                
                // 将 allTags 指向经历过脉冲洗礼的完整网络
                allTags.length = 0;
                allTags.push(...newAllTags);
            }

            // [4.6] 核心 Tag 补全 (确保聚光灯不遗漏)
            if (coreTagSet.size > 0) {
                const missingCoreTags = Array.from(coreTagSet).filter(ct =>
                    !allTags.some(at => at.name && at.name.toLowerCase() === ct)
                );

                if (missingCoreTags.length > 0) {
                    try {
                        const placeholders = missingCoreTags.map(() => '?').join(',');
                        const rows = this.db.prepare(`SELECT id, name, vector FROM tags WHERE name IN (${placeholders})`).all(...missingCoreTags);

                        // 获取当前 pyramid 的最大权重作为基准
                        const maxBaseWeight = allTags.length > 0 ? Math.max(...allTags.map(t => t.adjustedWeight / coreBoostFactor)) : 1.0;

                        rows.forEach(row => {
                            if (!seenTagIds.has(row.id)) {
                                allTags.push({
                                    id: row.id,
                                    name: row.name,
                                    // 虚拟召回的核心标签使用动态计算的加权因子
                                    adjustedWeight: maxBaseWeight * dynamicCoreBoostFactor,
                                    isCore: true,
                                    isVirtual: true // 标记为非向量召回
                                });
                                seenTagIds.add(row.id);
                            }
                        });
                    } catch (e) {
                        console.warn('[TagMemo-V6] Failed to supplement core tags:', e.message);
                    }
                }
            }

            // [4.6] 核心 Tag 补全和 [4.7] 幽灵节点在脉冲传播之后注入：
            // 幽灵节点是负 id 且无矩阵边；补全核心 Tag 作为“最终融合锚点”而非拓扑扩散种子，
            // 避免用户显式 coreTags 反向扩大本轮脉冲传播范围。
            // [4.7] 🎈 注入幽灵节点 (暗度陈仓)
            let ghostIdCounter = -1; // 专属负数 ID
            const ghostVectorMap = new Map();
            // 获取当前基准权重
            const maxBaseWeight = allTags.length > 0 ? Math.max(...allTags.map(t => t.adjustedWeight / coreBoostFactor)) : 1.0;

            const injectGhosts = (ghosts, isCore) => {
                ghosts.forEach(ghost => {
                    const gid = ghostIdCounter--;
                    // 1. 塞进 allTags 参与拓扑运算
                    allTags.push({
                        id: gid,
                        name: ghost.name,
                        adjustedWeight: maxBaseWeight * (isCore ? dynamicCoreBoostFactor : 1.0),
                        isCore: isCore,
                        isVirtual: true
                    });
                    // 2. 存入幽灵字典备用
                    ghostVectorMap.set(gid, {
                        id: gid,
                        name: ghost.name,
                        vector: ghost.vector // Float32Array 本体
                    });
                    seenTagIds.add(gid);
                });
            };

            injectGhosts(hardGhostObjects, true);
            injectGhosts(softGhostObjects, false);

            if (allTags.length === 0) {
                return {
                    vector: originalFloat32,
                    info: null,
                    energyField: this.lastEnergyField,
                    energyFieldProvenance: this.lastEnergyFieldProvenance,
                    artifactBundle
                };
            }

            // [5] 批量获取向量与名称（chunked IN，避免 SQLite 参数数量上限）
            const dbTagIds = allTags.filter(t => t.id > 0).map(t => t.id);
            const tagRows = this._queryByChunks('SELECT id, name, vector FROM tags WHERE id', dbTagIds);
            const tagDataMap = new Map(tagRows.map(r => [r.id, r]));

            // 🌟 终极闭环：把幽灵向量混入正规军的 Map 里！
            for (const [gid, ghostData] of ghostVectorMap.entries()) {
                tagDataMap.set(gid, ghostData);
            }

            // [5.5] 语义去重 (Semantic Deduplication)
            // 目的：消除冗余标签（如“委内瑞拉局势”与“委内瑞拉危机”），为多样性腾出空间
            const deduplicatedTags = [];
            const sortedTags = [...allTags].sort((a, b) => b.adjustedWeight - a.adjustedWeight);
            const normalizedVectorCache = new Map(); // id -> { vec: Float32Array, norm: Number }

            for (const tag of sortedTags) {
                const data = tagDataMap.get(tag.id);
                const vec = data ? this._decodeVectorBlob(data.vector, dim, `tag:${tag.id}`) : null;
                if (!vec) continue;

                let normSq = 0;
                for (let d = 0; d < dim; d++) normSq += vec[d] * vec[d];
                const norm = Math.sqrt(normSq);
                if (norm <= 1e-9) continue;

                normalizedVectorCache.set(tag.id, { vec, norm });

                let isRedundant = false;

                for (const existing of deduplicatedTags) {
                    const existingCached = normalizedVectorCache.get(existing.id);
                    if (!existingCached) continue;

                    // 计算余弦相似度：向量解码与范数已缓存，避免 O(n²) 重复分配/重复 norm。
                    let dot = 0;
                    const existingVec = existingCached.vec;
                    for (let d = 0; d < dim; d++) {
                        dot += vec[d] * existingVec[d];
                    }
                    const similarity = dot / (norm * existingCached.norm);

                    const dedupThreshold = config.deduplicationThreshold ?? 0.88;
                    if (similarity > dedupThreshold) {
                        isRedundant = true;
                        // 权重合并：将冗余标签的部分能量转移给代表性标签，并保留 Core 属性
                        existing.adjustedWeight += tag.adjustedWeight * 0.2;
                        if (tag.isCore) existing.isCore = true;
                        break;
                    }
                }

                if (!isRedundant) {
                    if (!tag.name) tag.name = data.name; // 补全名称
                    deduplicatedTags.push(tag);
                }
            }

            // [6] 构建上下文向量
            const contextVec = new Float32Array(dim);
            let totalWeight = 0;

            for (const t of deduplicatedTags) {
                const data = tagDataMap.get(t.id);
                const v = data ? this._decodeVectorBlob(data.vector, dim, `tag:${t.id}`) : null;
                if (v) {
                    for (let d = 0; d < dim; d++) contextVec[d] += v[d] * t.adjustedWeight;
                    totalWeight += t.adjustedWeight;
                }
            }

            if (totalWeight > 0) {
                // 归一化上下文向量
                let mag = 0;
                for (let d = 0; d < dim; d++) {
                    contextVec[d] /= totalWeight;
                    mag += contextVec[d] * contextVec[d];
                }
                mag = Math.sqrt(mag);
                if (mag > 1e-9) for (let d = 0; d < dim; d++) contextVec[d] /= mag;
            } else {
                return {
                    vector: originalFloat32,
                    info: null,
                    energyField: this.lastEnergyField,
                    energyFieldProvenance: this.lastEnergyFieldProvenance,
                    artifactBundle
                };
            }

            // [6] 最终融合 (clamp 防止外推：boost > 1 时原向量会被反向叠加)
            const alpha = Math.min(1.0, effectiveTagBoost);
            const fused = new Float32Array(dim);
            let fusedMag = 0;
            for (let d = 0; d < dim; d++) {
                fused[d] = (1 - alpha) * originalFloat32[d] + alpha * contextVec[d];
                fusedMag += fused[d] * fused[d];
            }

            fusedMag = Math.sqrt(fusedMag);
            if (fusedMag > 1e-9) for (let d = 0; d < dim; d++) fused[d] /= fusedMag;

            return {
                vector: fused,
                energyField: this.lastEnergyField,
                energyFieldProvenance: this.lastEnergyFieldProvenance,
                // 调用方必须把生成 energyField 的同一代资产传给读出层。
                artifactBundle,
                info: {
                    // 🌟 标记核心 Tag 召回情况 (安全映射)
                    coreTagsMatched: deduplicatedTags.filter(t => t.isCore && t.name).map(t => t.name),
                    // 仅返回权重足够高的 Tag，过滤掉被压制的噪音，提升召回纯净度
                    matchedTags: (() => {
                        if (deduplicatedTags.length === 0) return [];
                        const maxWeight = Math.max(...deduplicatedTags.map(t => t.adjustedWeight));
                        return deduplicatedTags.filter(t => {
                            // 🌟 核心修正：Core Tags 必须始终包含在 Normal Tags 中，防止排挤效应
                            if (t.isCore) return true;

                            const tName = t.name || '';
                            const isTech = !/[\u4e00-\u9fa5]/.test(tName) && /^[A-Za-z0-9\-_.\s]+$/.test(tName);
                            if (isTech) {
                                // 🌟 软化 TF-IDF 压制：将英文实体的过滤门槛从 0.2 降至 0.08
                                return t.adjustedWeight > maxWeight * (config.techTagThreshold ?? 0.08);
                            }
                            // 🌟 进一步降低门槛：从 0.03 降至 0.015
                            // 理由：Normal 必须是 Core 的超集，且要容纳高频背景主语
                            return t.adjustedWeight > maxWeight * (config.normalTagThreshold ?? 0.015);
                        }).map(t => t.name).filter(Boolean);
                    })(),
                    boostFactor: effectiveTagBoost,
                    requestedVersion: resolution.requestedVersion,
                    effectiveVersion: resolution.effectiveVersion,
                    versionFallbackUsed: resolution.fallbackUsed,
                    versionFallbackReason: resolution.fallbackReason,
                    artifactSig: artifactBundle?.artifactSig || null,
                    graphGeneration: artifactBundle?.graphGeneration || null,
                    artifactGeneration: artifactBundle?.generation || null,
                    epa: {
                        logicDepth,
                        entropy: entropyPenalty,
                        resonance: resonance.resonance,
                        dominantAxes: Array.isArray(epaResult.dominantAxes)
                            ? epaResult.dominantAxes.map(axis => ({
                                label: axis.label,
                                score: Number(axis.score) || 0
                            }))
                            : []
                    },
                    pyramid: {
                        coverage: features.coverage,
                        novelty: features.novelty,
                        coherence: features.coherence,
                        activation: features.tagMemoActivation,
                        depth: features.depth,
                        levels: levels.map(level => ({
                            level: level.level,
                            energyExplained: level.energyExplained,
                            residualEnergyRatio: level.residualEnergyRatio,
                            tags: (Array.isArray(level.tags) ? level.tags : [])
                                .map(tag => ({
                                    id: Number(tag.id),
                                    name: tag.name || null,
                                    similarity: Number(tag.similarity) || 0,
                                    contribution: Number(tag.contribution) || 0,
                                    handshakeMagnitude:
                                        Number(tag.handshakeMagnitude) || 0
                                }))
                        }))
                    },
                    propagation: propagationDiagnostics,
                    queryRiverGraph,
                    algorithmVersion: artifactBundle?.algorithmVersion || queryVersion
                }
            };

        } catch (e) {
            console.error('[TagMemoEngine] TagMemo V6 CRITICAL FAIL:', e);
            return {
                vector: originalFloat32,
                info: null,
                energyField: null,
                energyFieldProvenance: null,
                artifactBundle
            };
        }
    }

    /**
     * 为 V10 提供 V9 完整查询降噪管线的只读观测。
     *
     * 该接口复用 EPA、Residual Pyramid、语言/世界观门控、Core 加权和
     * Spike 路由，但不把 V9 的最终候选奖励或 geodesicRerank 人格带入 V10。
     * V10 消费的是降噪后的 Spike 节点场、来源信息和查询级有向边流。
     */
    observeQueryForV10(vector, options = {}) {
        const sourceVector = vector instanceof Float32Array
            ? new Float32Array(vector)
            : new Float32Array(vector || []);
        const artifactBundle = options.artifactBundle
            || this.getArtifactBundleSnapshot('v9');
        const observation = this.applyTagBoost(
            sourceVector,
            Math.max(0, Number(options.baseTagBoost ?? 0.6)),
            Array.isArray(options.coreTags) ? options.coreTags : [],
            Math.max(0, Number(options.coreBoostFactor ?? 1.33)),
            {
                artifactBundle,
                version: 'v9'
            }
        );
        const enhancedVector = observation.vector instanceof Float32Array
            && observation.vector.length === sourceVector.length
            ? observation.vector
            : null;
        let sourceNormSq = 0;
        let enhancedNormSq = 0;
        let sourceEnhancedDot = 0;
        let vectorDeltaSq = 0;
        if (enhancedVector) {
            for (let index = 0; index < sourceVector.length; index++) {
                const sourceValue = Number(sourceVector[index]) || 0;
                const enhancedValue = Number(enhancedVector[index]) || 0;
                const delta = enhancedValue - sourceValue;
                sourceNormSq += sourceValue * sourceValue;
                enhancedNormSq += enhancedValue * enhancedValue;
                sourceEnhancedDot += sourceValue * enhancedValue;
                vectorDeltaSq += delta * delta;
            }
        }
        const sourceEnhancedCosine = sourceNormSq > 0 && enhancedNormSq > 0
            ? sourceEnhancedDot / Math.sqrt(sourceNormSq * enhancedNormSq)
            : 0;
        const vectorDeltaL2 = Math.sqrt(vectorDeltaSq);
        // applyTagBoost() 为兼容生产路径会在内部故障或无法构造上下文时
        // 返回原查询向量。V10 不得把这种兼容回退误报成完整降噪观测。
        const completeObservation = Boolean(
            observation.info
            && enhancedVector
            && vectorDeltaL2 > 1e-7
        );
        const spikeField = completeObservation
            && observation.energyField instanceof Map
            ? [...observation.energyField.entries()]
                .map(([rawId, rawMass]) => Object.freeze([
                    Number(rawId),
                    Math.max(0, Number(rawMass) || 0)
                ]))
                .filter(([id, mass]) =>
                    Number.isFinite(id) && id > 0 && mass > 0
                )
                .sort((left, right) =>
                    (right[1] - left[1]) || (left[0] - right[0])
                )
            : [];
        const totalMass = spikeField.reduce(
            (sum, entry) => sum + entry[1],
            0
        );
        const normalizedSpikeField = Object.freeze(
            spikeField.map(([id, mass]) =>
                Object.freeze([id, totalMass > 0 ? mass / totalMass : 0])
            )
        );
        const info = observation.info || {};
        return Object.freeze({
            schema: 'tagmemo-v10-v9-denoised-observation-v1',
            sourceMode: normalizedSpikeField.length > 0
                ? 'v9_epa_pyramid_spike'
                : 'unavailable',
            sourceField: normalizedSpikeField,
            enhancedVector: completeObservation
                ? Object.freeze(Array.from(enhancedVector))
                : null,
            fieldProvenance: Object.freeze(
                observation.energyFieldProvenance instanceof Map
                    ? [...observation.energyFieldProvenance.entries()]
                        .map(([id, value]) => Object.freeze([
                            Number(id),
                            Object.freeze({ ...value })
                        ]))
                    : []
            ),
            queryRiverGraph: info.queryRiverGraph || null,
            epa: Object.freeze({ ...(info.epa || {}) }),
            pyramid: Object.freeze({ ...(info.pyramid || {}) }),
            propagation: Object.freeze({ ...(info.propagation || {}) }),
            matchedTags: Object.freeze(
                Array.isArray(info.matchedTags)
                    ? info.matchedTags.slice()
                    : []
            ),
            coreTagsMatched: Object.freeze(
                Array.isArray(info.coreTagsMatched)
                    ? info.coreTagsMatched.slice()
                    : []
            ),
            v9ArtifactSig: artifactBundle?.artifactSig || null,
            diagnostics: Object.freeze({
                sourceNodes: normalizedSpikeField.length,
                rawSpikeMass: totalMass,
                completeObservation,
                vectorDeltaL2,
                sourceEnhancedCosine,
                vectorChanged: vectorDeltaL2 > 1e-7,
                fallbackReason: completeObservation
                    ? null
                    : !observation.info
                        ? 'v9-tag-boost-returned-no-query-info'
                        : !enhancedVector
                            ? 'v9-tag-boost-returned-invalid-vector'
                            : 'v9-enhanced-vector-equals-source-vector',
                riverNodes:
                    info.queryRiverGraph?.diagnostics?.reachedNodes || 0,
                riverEdges:
                    info.queryRiverGraph?.diagnostics?.activeEdges || 0
            })
        });
    }

    /**
     * 获取向量的 EPA 分析数据（逻辑深度、共振等）
     */
    getEPAAnalysis(vector) {
        if (!this.epa || !this.epa.initialized) {
            return { logicDepth: 0.5, resonance: 0, entropy: 0.5, dominantAxes: [] };
        }
        const vec = vector instanceof Float32Array ? vector : new Float32Array(vector);
        const projection = this.epa.project(vec);
        const resonance = this.epa.detectCrossDomainResonance(vec);
        return {
            logicDepth: projection.logicDepth,
            entropy: projection.entropy,
            resonance: resonance.resonance,
            dominantAxes: projection.dominantAxes
        };
    }

    /**
     * V9.1 查询诱导式曲线测地重排。
     *
     * 不再把“候选 Tag ID 与离散 energyField 的交集数量”当作距离。每篇候选文件的
     * 有序 Tag 链是一条待检验曲线；查询能量场通过 Tag 向量局部核插值到这条曲线上，
     * 再联合候选自身的 Tag 质量、连续性、拓扑导通、语义弧长与 Chunk 闭合度计算分数。
     *
     * 守卫原则：
     *   - 查询场本身不可信时整批回退；
     *   - 候选既无精确接触也无可信连续场接触时不获得测地贡献；
     *   - 全批无贡献或缺乏区分度时保持原始顺序；
     *   - 无贡献候选保留原 KNN 分数，不被测地混合无差别压低。
     *
     * @param {Array<{id: BigInt|Number, score: Number}>} candidates 原始候选
     * @param {object} options 查询级 energyField 与热配置
     * @returns {Array} 重排后的完整数组（不截断）
     */
    geodesicRerank(candidates, options = {}) {
        this._assertJsGraphRuntimeAvailable('TagMemoEngine.geodesicRerank()');
        let energyField = options.energyField;
        let requestedFieldProvenance = options.energyFieldProvenance;
        if (!energyField && options.allowLastEnergyFieldFallback === true) {
            energyField = this.lastEnergyField;
            requestedFieldProvenance = this.lastEnergyFieldProvenance;
            console.warn('[TagMemoEngine] ⚠️ geodesicRerank using lastEnergyField fallback by explicit opt-in; prefer query-scoped options.energyField.');
        }
        if (!(energyField instanceof Map) || energyField.size === 0 || !Array.isArray(candidates) || candidates.length === 0) {
            return candidates;
        }

        const geoConfig = options.config
            || this.ragParams?.KnowledgeBaseManager?.potentialFieldRerank
            || this.ragParams?.KnowledgeBaseManager?.geodesicRerank
            || {};
        const alpha = Number(options.alpha ?? geoConfig.alpha);
        const minGeoSamples = Number(options.minGeoSamples ?? geoConfig.minGeoSamples);
        if (!Number.isFinite(alpha) || !Number.isFinite(minGeoSamples)) {
            console.warn('[TagMemoEngine] geodesicRerank missing valid alpha/minGeoSamples config; falling back to original order.');
            return candidates;
        }

        const mixAlpha = Math.max(0, Math.min(1, alpha));
        const sampleScale = Math.max(1, Math.floor(minGeoSamples));
        const fallbackEnabled = geoConfig.fallbackToKnnOnLowTrust !== false
            && geoConfig.fallbackToKnnOnLowTrust !== 0;
        const minFieldTags = Math.max(1, Math.floor(Number(geoConfig.minFieldTags ?? sampleScale)));
        const minFieldEntropy = Math.max(0, Math.min(1, Number(geoConfig.minFieldEntropy ?? 0.12)));
        const minCandidateCoverage = Math.max(0, Math.min(1, Number(geoConfig.minGeoCoverageRatio ?? 0.2)));
        const minGeoScore = Math.max(0, Number(geoConfig.minMaxGeoScore ?? 0.01));
        const minGeoSpread = Math.max(0, Number(geoConfig.minGeoScoreSpread ?? 0.03));

        const maxFieldNodes = Math.max(minFieldTags, Math.floor(Number(geoConfig.maxFieldNodes ?? 48)));
        const fieldEnergyMassRatio = Math.max(0.5, Math.min(1, Number(geoConfig.fieldEnergyMassRatio ?? 0.95)));
        const minStrongEvidence = Math.max(0, Number(geoConfig.minStrongEvidence ?? 1));

        // 连续场与曲线参数均提供内置默认值，现有配置无需迁移即可运行。
        // 接触阈值必须先初始化，后续语义直锚门槛会以 strongContactThreshold 为安全下限。
        const fieldSimilarityThreshold = Math.max(-1, Math.min(1, Number(geoConfig.fieldSimilarityThreshold ?? 0.50)));
        const strongContactThreshold = Math.max(0, Math.min(1, Number(geoConfig.strongContactThreshold ?? 0.16)));
        const weakContactThreshold = Math.max(0, Math.min(strongContactThreshold, Number(geoConfig.weakContactThreshold ?? 0.06)));
        const fieldKernelExponent = Math.max(0.25, Number(geoConfig.fieldKernelExponent ?? 2.0));
        const maxFieldNeighbors = Math.max(1, Math.floor(Number(geoConfig.maxFieldNeighbors ?? 4)));
        const positionDecay = Math.max(0, Number(geoConfig.candidatePositionDecay ?? 0.035));
        const publicHubFloor = Math.max(0.05, Math.min(1, Number(geoConfig.publicHubFloor ?? 0.35)));
        const minClosureSimilarity = Math.max(-1, Math.min(1, Number(geoConfig.minClosureSimilarity ?? 0.20)));

        // V9.2 读出校准：分数使用绝对标度映射，并按证据等级限制最大排序权限。
        const geoRewardFloor = Math.max(0, Math.min(1, Number(geoConfig.geoRewardFloor ?? 0.015)));
        const geoRewardSaturation = Math.max(
            geoRewardFloor + 1e-6,
            Math.min(1, Number(geoConfig.geoRewardSaturation ?? 0.25))
        );
        const directBonusCap = Math.max(0, Math.min(1, Number(geoConfig.directBonusCap ?? 0.18)));
        const structuralBonusCap = Math.max(0, Math.min(directBonusCap, Number(geoConfig.structuralBonusCap ?? 0.10)));
        const thematicBonusCap = Math.max(0, Math.min(structuralBonusCap, Number(geoConfig.thematicBonusCap ?? 0.035)));
        const structuralContinuityMin = Math.max(0, Math.min(1, Number(geoConfig.structuralContinuityMin ?? 0.08)));
        const thematicMinPotential = Math.max(0, Math.min(1, Number(geoConfig.thematicMinPotential ?? 0.08)));
        const thematicMaxIsolatedRatio = Math.max(0, Math.min(1, Number(geoConfig.thematicMaxIsolatedRatio ?? 0.65)));

        // 稀疏交叉联想守卫：位置上孤立的命中，只有在“命中子图”中同时具备
        // 非局部拓扑边、语义相似、查询势能和 Chunk 闭合时，才可减免部分孤立比例。
        // 这不是取消随机跳跃惩罚，而是把“序列不相邻”和“语义不连贯”分开裁决。
        const sparseAssociationEnabled = geoConfig.sparseAssociationEnabled !== false
            && geoConfig.sparseAssociationEnabled !== 0;
        const sparseAssociationMinContacts = Math.max(
            2,
            Math.floor(Number(geoConfig.sparseAssociationMinContacts ?? 3))
        );
        const sparseAssociationMinConductance = Math.max(
            0,
            Math.min(1, Number(geoConfig.sparseAssociationMinConductance ?? 0.015))
        );
        const sparseAssociationMinSimilarity = Math.max(
            -1,
            Math.min(1, Number(geoConfig.sparseAssociationMinSimilarity ?? 0.48))
        );
        const sparseAssociationMinPotential = Math.max(
            weakContactThreshold,
            Math.min(1, Number(geoConfig.sparseAssociationMinPotential ?? 0.08))
        );
        const sparseAssociationMinClosure = Math.max(
            0,
            Math.min(1, Number(geoConfig.sparseAssociationMinClosure ?? 0.20))
        );
        const sparseAssociationPairSaturation = Math.max(
            1,
            Math.floor(Number(geoConfig.sparseAssociationPairSaturation ?? 3))
        );
        const sparseAssociationMaxRelief = Math.max(
            0,
            Math.min(0.8, Number(geoConfig.sparseAssociationMaxRelief ?? 0.55))
        );
        // 非精确 ID 也可以构成直接事实锚点，但必须同时满足“来自查询 seed/core、
        // 势能足够高、至少多个独立接触”，避免单个宽泛近义词把主题共振抬成直接证据。
        const directSemanticMinPotential = Math.max(
            strongContactThreshold,
            Math.min(1, Number(geoConfig.directSemanticMinPotential ?? 0.16))
        );
        const directSemanticSaturation = Math.max(
            directSemanticMinPotential + 1e-6,
            Math.min(1, Number(geoConfig.directSemanticSaturation ?? 0.35))
        );
        const directSemanticMinContacts = Math.max(
            1,
            Math.floor(Number(geoConfig.directSemanticMinContacts ?? 2))
        );
        const directConfidenceFloor = Math.max(
            0,
            Math.min(1, Number(geoConfig.directConfidenceFloor ?? 0.35))
        );

        // 四层几何生产辅助：旧测地奖励仍是主轨，辅助轨只提供有界“奖励地板补差”。
        // 默认关闭并由热配置显式启用；C4/Lift 只能验证闭合，不能独立创造奖励。
        const geometryAuxConfig = geoConfig.geometryAuxiliary || {};
        const geometryAuxEnabled = geometryAuxConfig.enabled === true
            || geometryAuxConfig.enabled === 1;
        const geometryAuxMaxBonus = Math.max(
            0,
            Math.min(0.05, Number(geometryAuxConfig.maxAuxBonus ?? 0.018))
        );
        const geometryAuxDirectCap = Math.max(
            0,
            Math.min(geometryAuxMaxBonus, Number(geometryAuxConfig.directFloorCap ?? geometryAuxMaxBonus))
        );
        const geometryAuxStructuralCap = Math.max(
            0,
            Math.min(geometryAuxDirectCap, Number(geometryAuxConfig.structuralFloorCap ?? 0.012))
        );
        const geometryAuxThematicCap = Math.max(
            0,
            Math.min(geometryAuxStructuralCap, Number(geometryAuxConfig.thematicFloorCap ?? 0.006))
        );
        const geometryAuxMinFused = Math.max(
            0,
            Math.min(1, Number(geometryAuxConfig.minFusedScore ?? 0.12))
        );
        const geometryAuxMinClosure = Math.max(
            0,
            Math.min(1, Number(geometryAuxConfig.minClosureScore ?? 0.55))
        );
        const geometryAuxMinClassEvidence = Math.max(
            0,
            Math.min(1, Number(geometryAuxConfig.minClassEvidence ?? 0.10))
        );
        const geometryAuxExponent = Math.max(
            0.5,
            Math.min(4, Number(geometryAuxConfig.floorExponent ?? 1.5))
        );

        // Exact Identity Anchor：仅保护高势能 query seed/core 精确接触。
        // 还必须同时满足 Tag 特异性与 Tag→chunk 闭合，公共 Tag 和 emergent 节点不能触发。
        const identityConfig = geometryAuxConfig.identityAnchor || {};
        const identityAnchorEnabled = geometryAuxEnabled
            && (identityConfig.enabled === true || identityConfig.enabled === 1);
        const identityAnchorMinPotential = Math.max(
            0,
            Math.min(1, Number(identityConfig.minPotential ?? 0.80))
        );
        const identityAnchorMinSpecificity = Math.max(
            0,
            Math.min(1, Number(identityConfig.minSpecificity ?? 0.55))
        );
        const identityAnchorMinClosure = Math.max(
            0,
            Math.min(1, Number(identityConfig.minTagChunkClosure ?? 0.35))
        );
        const identityAnchorMinStrength = Math.max(
            0,
            Math.min(1, Number(identityConfig.minStrength ?? 0.55))
        );
        const identityAnchorFloorCap = Math.max(
            0,
            Math.min(
                Math.min(directBonusCap, geometryAuxMaxBonus),
                Number(identityConfig.floorCap ?? 0.018)
            )
        );
        const identityAnchorExponent = Math.max(
            0.5,
            Math.min(4, Number(identityConfig.floorExponent ?? 1.25))
        );

        const energyFieldProvenance = requestedFieldProvenance instanceof Map
            ? requestedFieldProvenance
            : new Map();

        // V9.2 四层几何影子读出：只产生诊断，不参与当前排序。
        // EPA/Pyramid 描述查询希望从 direct/structural/thematic 三层读取多少信息；
        // 后续候选观测再描述每层实际提供了多少证据。
        const queryGeometryState = options.queryGeometryState || options.queryState || {};
        const queryEpa = queryGeometryState.epa || {};
        const queryPyramid = queryGeometryState.pyramid || {};
        const finite01 = (value, fallback = 0.5) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
        };
        const logicDepth = finite01(queryEpa.logicDepth);
        const queryEntropy = finite01(queryEpa.entropy);
        const queryResonance = finite01(queryEpa.resonance, 0);
        const pyramidCoverage = finite01(queryPyramid.coverage);
        const pyramidNovelty = finite01(queryPyramid.novelty);
        const pyramidDepth = finite01(queryPyramid.depth);
        const rawGeometryWeights = {
            direct: 0.45 + 0.35 * logicDepth + 0.20 * pyramidCoverage,
            structural: 0.35 + 0.30 * pyramidDepth + 0.25 * pyramidNovelty + 0.10 * queryResonance,
            thematic: 0.20 + 0.35 * queryEntropy + 0.30 * queryResonance + 0.15 * (1 - logicDepth)
        };
        const geometryWeightSum = Object.values(rawGeometryWeights).reduce((sum, value) => sum + value, 0) || 1;
        const queryGeometryWeights = Object.freeze({
            direct: rawGeometryWeights.direct / geometryWeightSum,
            structural: rawGeometryWeights.structural / geometryWeightSum,
            thematic: rawGeometryWeights.thematic / geometryWeightSum
        });
        const originalQueryVector = options.originalQueryVector
            ? (options.originalQueryVector instanceof Float32Array
                ? options.originalQueryVector
                : new Float32Array(options.originalQueryVector))
            : null;
        const enhancedQueryVector = options.enhancedQueryVector
            ? (options.enhancedQueryVector instanceof Float32Array
                ? options.enhancedQueryVector
                : new Float32Array(options.enhancedQueryVector))
            : null;

        const fallback = (reason, extra = {}) => {
            if (fallbackEnabled) {
                const details = Object.entries(extra)
                    .map(([key, value]) => `${key}=${typeof value === 'number' ? value.toFixed(4) : value}`)
                    .join(', ');
                console.warn(`[TagMemo-V9.1 GeodesicCurve] 🛡️ Fallback to original order: ${reason}${details ? ` (${details})` : ''}.`);
            }
            return candidates;
        };

        const normalizedField = new Map();
        for (const [rawId, rawEnergy] of energyField.entries()) {
            const id = Number(rawId);
            const energy = Math.max(0, Number(rawEnergy) || 0);
            if (!Number.isFinite(id) || id <= 0 || energy <= 0) continue;
            // 不同 key 类型归一化后可能合并，保留较强的查询场值。
            normalizedField.set(id, Math.max(normalizedField.get(id) || 0, energy));
        }

        const positiveField = [];
        let fieldEnergySum = 0;
        let maxFieldEnergy = 0;
        for (const [id, energy] of normalizedField.entries()) {
            positiveField.push({ id, energy });
            fieldEnergySum += energy;
            if (energy > maxFieldEnergy) maxFieldEnergy = energy;
        }
        if (positiveField.length < minFieldTags || fieldEnergySum <= 0 || maxFieldEnergy <= 0) {
            return fallback('query energy field has insufficient positive support', {
                positiveTags: positiveField.length,
                minFieldTags
            });
        }

        let entropy = 0;
        for (const item of positiveField) {
            const p = item.energy / fieldEnergySum;
            entropy -= p * Math.log(p);
            item.normalizedEnergy = item.energy / maxFieldEnergy;
        }
        positiveField.sort((a, b) => b.energy - a.energy);
        const normalizedEntropy = positiveField.length > 1 ? entropy / Math.log(positiveField.length) : 0;
        if (fallbackEnabled && normalizedEntropy < minFieldEntropy) {
            return fallback('query energy field entropy too low', { entropy: normalizedEntropy, minFieldEntropy });
        }

        // 先按累计能量质量截断，再查询向量，避免完整场节点进入 SQLite 与高维余弦热循环。
        const retainedField = [];
        let retainedEnergy = 0;
        for (const item of positiveField) {
            if (
                retainedField.length >= maxFieldNodes
                || (retainedField.length >= minFieldTags && retainedEnergy / fieldEnergySum >= fieldEnergyMassRatio)
            ) {
                break;
            }
            retainedField.push(item);
            retainedEnergy += item.energy;
        }

        const cosine = (left, right) => {
            if (!left || !right || left.length !== right.length) return 0;
            let dot = 0;
            let normLeft = 0;
            let normRight = 0;
            for (let i = 0; i < left.length; i++) {
                dot += left[i] * right[i];
                normLeft += left[i] * left[i];
                normRight += right[i] * right[i];
            }
            return normLeft > 1e-12 && normRight > 1e-12
                ? dot / (Math.sqrt(normLeft) * Math.sqrt(normRight))
                : 0;
        };
        const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));

        try {
            const dimension = Number(this.config?.dimension) || 0;
            if (dimension <= 0) return fallback('invalid vector dimension', { dimension });

            // 一次性取得候选 Chunk、文件归属和终点向量。
            const chunkIds = [...new Set(candidates.map(item => Number(item.id)).filter(Number.isFinite))];
            const chunkRows = this._queryByChunks(
                'SELECT id, file_id, vector FROM chunks WHERE id',
                chunkIds
            );
            const chunkById = new Map(chunkRows.map(row => [Number(row.id), row]));
            const fileIds = [...new Set(chunkRows.map(row => Number(row.file_id)).filter(Number.isFinite))];

            // position 是候选曲线的方向；旧 position=0 数据按 tag_id 稳定排序但降低方向可信度。
            const fileTagRows = fileIds.length > 0
                ? this._queryByChunks(
                    'SELECT file_id, tag_id, position FROM file_tags WHERE file_id',
                    fileIds,
                    ' ORDER BY file_id, position ASC, tag_id ASC'
                )
                : [];
            const chainsByFile = new Map();
            const candidateTagIds = new Set();
            for (const row of fileTagRows) {
                const fileId = Number(row.file_id);
                const tagId = Number(row.tag_id);
                if (!Number.isFinite(fileId) || !Number.isFinite(tagId)) continue;
                if (!chainsByFile.has(fileId)) chainsByFile.set(fileId, []);
                chainsByFile.get(fileId).push({
                    id: tagId,
                    position: Math.max(0, Number(row.position) || 0)
                });
                candidateTagIds.add(tagId);
            }

            const allTagIds = [...new Set([
                ...retainedField.map(item => item.id),
                ...candidateTagIds
            ])];
            const tagRows = this._queryByChunks(
                'SELECT id, name, vector FROM tags WHERE id',
                allTagIds
            );
            const tagById = new Map();
            for (const row of tagRows) {
                const vector = this._decodeVectorBlob(row.vector, dimension, `geodesic-tag:${row.id}`);
                if (vector) tagById.set(Number(row.id), { id: Number(row.id), name: row.name, vector });
            }

            const fieldNodes = retainedField
                .map(item => {
                    const tag = tagById.get(item.id);
                    const provenance = energyFieldProvenance.get(Number(item.id)) || {
                        sourceType: 'unknown',
                        hop: null
                    };
                    return tag ? { ...item, ...tag, provenance } : null;
                })
                .filter(Boolean);
            if (fieldNodes.length < minFieldTags) {
                return fallback('query field vectors unavailable', {
                    fieldVectors: fieldNodes.length,
                    minFieldTags
                });
            }

            // 必须读取生成 energyField 的同一代资产；入流与 hub 基值已在发布阶段预计算。
            const bundle = options.artifactBundle
                || this.getArtifactBundleSnapshot(options.version || 'v9');
            const kernel = bundle?.propagationKernel || this.tagCooccurrenceMatrix || new Map();
            const anchorGainMap = bundle?.anchorGainMap || bundle?.residualMap || this.tagIntrinsicResiduals || new Map();
            const hubSpecificityBaseMap = bundle?.hubSpecificityBaseMap || new Map();

            const hubSpecificity = tagId => {
                const base = hubSpecificityBaseMap.get(Number(tagId));
                return Number.isFinite(base) ? Math.max(publicHubFloor, clamp01(base)) : 1;
            };

            // 对任意候选 Tag 向量采样查询连续势场。相同 Tag 跨文件只计算一次。
            const sampledPotentialCache = new Map();
            const samplePotential = tag => {
                const cached = sampledPotentialCache.get(tag.id);
                if (cached) return cached;

                const exact = normalizedField.get(Number(tag.id));
                const exactPotential = exact === undefined
                    ? 0
                    : clamp01((Number(exact) || 0) / maxFieldEnergy);

                const neighbors = [];
                for (const fieldNode of fieldNodes) {
                    if (fieldNode.id === tag.id) continue;
                    const similarity = cosine(tag.vector, fieldNode.vector);
                    if (similarity < fieldSimilarityThreshold) continue;
                    const local = (similarity - fieldSimilarityThreshold)
                        / Math.max(1e-6, 1 - fieldSimilarityThreshold);
                    neighbors.push({
                        similarity,
                        fieldNode,
                        potential: fieldNode.normalizedEnergy
                            * Math.pow(clamp01(local), fieldKernelExponent)
                            * hubSpecificity(fieldNode.id)
                    });
                }
                neighbors.sort((a, b) => b.potential - a.potential);
                const selected = neighbors.slice(0, maxFieldNeighbors);
                const interpolated = selected.length > 0
                    ? selected.reduce((sum, item) => sum + item.potential, 0)
                        / Math.sqrt(selected.length)
                    : 0;
                const exactProvenance = energyFieldProvenance.get(Number(tag.id)) || null;
                const nearestFieldNode = selected[0]?.fieldNode || null;

                const result = {
                    potential: clamp01(Math.max(exactPotential, interpolated)),
                    exact: exactPotential > 0,
                    exactSourceType: exactProvenance?.sourceType || null,
                    exactHop: Number.isFinite(exactProvenance?.hop) ? exactProvenance.hop : null,
                    nearestSimilarity: selected[0]?.similarity || 0,
                    nearestSourceType: nearestFieldNode?.provenance?.sourceType || null,
                    nearestHop: Number.isFinite(nearestFieldNode?.provenance?.hop)
                        ? nearestFieldNode.provenance.hop
                        : null
                };
                sampledPotentialCache.set(tag.id, result);
                return result;
            };

            const geoData = candidates.map((candidate, originalIndex) => {
                const chunkId = Number(candidate.id);
                const chunkRow = chunkById.get(chunkId);
                const chain = chunkRow ? (chainsByFile.get(Number(chunkRow.file_id)) || []) : [];
                const chunkVector = chunkRow
                    ? this._decodeVectorBlob(chunkRow.vector, dimension, `geodesic-chunk:${chunkId}`)
                    : null;

                if (!chunkRow || !chunkVector || chain.length === 0) {
                    return {
                        candidate,
                        originalIndex,
                        geoScore: 0,
                        confidence: 0,
                        reason: 'missing-chunk-vector-or-tag-chain'
                    };
                }

                const samples = [];
                let totalCandidateMass = 0;
                let contactedMass = 0;
                let weightedPotential = 0;
                let exactHits = 0;
                let directExactHits = 0;
                let directExactMaxPotential = 0;
                let directExactBestSpecificity = 0;
                let directExactBestClosure = 0;
                let identityAnchorStrength = 0;
                let emergentExactHits = 0;
                let directSemanticHits = 0;
                let directSemanticPotentialSum = 0;
                let directSemanticMaxPotential = 0;
                let strongHits = 0;
                let weakHits = 0;
                let maxPotential = 0;

                for (let index = 0; index < chain.length; index++) {
                    const chainNode = chain[index];
                    const tag = tagById.get(chainNode.id);
                    if (!tag) continue;

                    const closure = clamp01(
                        (cosine(tag.vector, chunkVector) - minClosureSimilarity)
                        / Math.max(1e-6, 1 - minClosureSimilarity)
                    );
                    const anchorGain = Math.max(0.5, Math.min(2, Number(anchorGainMap?.get(tag.id)) || 1));
                    const positional = Math.exp(-positionDecay * Math.max(0, chainNode.position - 1));
                    const specificity = hubSpecificity(tag.id);
                    const candidateMass = Math.max(0.02, closure * anchorGain * positional * specificity);
                    const fieldSample = samplePotential(tag);
                    const contacted = fieldSample.potential >= weakContactThreshold;

                    totalCandidateMass += candidateMass;
                    if (contacted) {
                        contactedMass += candidateMass;
                        weightedPotential += candidateMass * fieldSample.potential;
                        weakHits++;
                    }
                    if (fieldSample.potential >= strongContactThreshold) strongHits++;
                    if (fieldSample.exact) {
                        exactHits++;
                        if (fieldSample.exactSourceType === 'core' || fieldSample.exactSourceType === 'seed') {
                            directExactHits++;
                            directExactMaxPotential = Math.max(
                                directExactMaxPotential,
                                fieldSample.potential
                            );
                            const exactIdentityStrength = clamp01(
                                fieldSample.potential
                                * specificity
                                * Math.sqrt(Math.max(0, closure))
                            );
                            if (exactIdentityStrength > identityAnchorStrength) {
                                identityAnchorStrength = exactIdentityStrength;
                                directExactBestSpecificity = specificity;
                                directExactBestClosure = closure;
                            }
                        } else {
                            emergentExactHits++;
                        }
                    }
                    const semanticSourceIsDirect = !fieldSample.exact
                        && (
                            fieldSample.nearestSourceType === 'core'
                            || fieldSample.nearestSourceType === 'seed'
                        )
                        && fieldSample.potential >= directSemanticMinPotential;
                    if (semanticSourceIsDirect) {
                        directSemanticHits++;
                        directSemanticPotentialSum += fieldSample.potential;
                        directSemanticMaxPotential = Math.max(
                            directSemanticMaxPotential,
                            fieldSample.potential
                        );
                    }
                    if (fieldSample.potential > maxPotential) maxPotential = fieldSample.potential;

                    samples.push({
                        id: tag.id,
                        name: tag.name,
                        vector: tag.vector,
                        position: chainNode.position || index + 1,
                        candidateMass,
                        closure,
                        potential: fieldSample.potential,
                        exact: fieldSample.exact,
                        exactSourceType: fieldSample.exactSourceType,
                        exactHop: fieldSample.exactHop,
                        nearestSimilarity: fieldSample.nearestSimilarity,
                        nearestSourceType: fieldSample.nearestSourceType,
                        nearestHop: fieldSample.nearestHop
                    });
                }

                if (samples.length === 0 || totalCandidateMass <= 0 || weakHits === 0) {
                    // 节点场守卫不应抹掉第四层观测：即使 D/S/T 暂无可信接触，
                    // 仍记录原查询→候选、增强查询→候选及 V9.1 向量提升，供跨层诊断。
                    const originalQueryClosure = originalQueryVector
                        ? clamp01((cosine(originalQueryVector, chunkVector) + 1) / 2)
                        : 0;
                    const enhancedQueryClosure = enhancedQueryVector
                        ? clamp01((cosine(enhancedQueryVector, chunkVector) + 1) / 2)
                        : 0;
                    const vectorLift = originalQueryVector && enhancedQueryVector
                        ? enhancedQueryClosure - originalQueryClosure
                        : 0;
                    const vectorLiftConsistency = clamp01(0.5 + vectorLift * 5);
                    const closureScore = clamp01(
                        0.35 * originalQueryClosure
                        + 0.45 * enhancedQueryClosure
                        + 0.20 * vectorLiftConsistency
                    );
                    return {
                        candidate,
                        originalIndex,
                        geoScore: 0,
                        confidence: 0,
                        reason: 'no-trusted-field-contact',
                        sampleCount: samples.length,
                        exactHits,
                        directExactHits,
                        directExactMaxPotential,
                        directExactBestSpecificity,
                        directExactBestClosure,
                        identityAnchorStrength,
                        emergentExactHits,
                        directSemanticHits,
                        directSemanticStrength: 0,
                        strongHits,
                        weakHits,
                        geometryShadow: {
                            version: 'four-layer-shadow-v1',
                            directScore: 0,
                            structuralScore: 0,
                            thematicScore: 0,
                            closureScore,
                            fusedScore: 0,
                            queryWeights: queryGeometryWeights,
                            directionConsistency: 0,
                            meanForwardConductance: 0,
                            meanReverseConductance: 0,
                            supportedSegments: 0,
                            originalQueryClosure,
                            enhancedQueryClosure,
                            vectorLift,
                            vectorLiftConsistency,
                            nodeFieldGuarded: true
                        }
                    };
                }

                const weightedCoverage = clamp01(contactedMass / totalCandidateMass);
                const meanPotential = contactedMass > 0 ? clamp01(weightedPotential / contactedMass) : 0;

                // 连续性：奖励相邻高势能走廊，允许有限低谷；单点接触不会伪装成长链。
                let transitionWeight = 0;
                let continuityMass = 0;
                let semanticArc = 0;
                let weightedSemanticArc = 0;
                let weightedAction = 0;
                let isolatedMass = 0;
                const isolatedSamples = [];
                let directedSupportWeight = 0;
                let directionConsistencyMass = 0;
                let forwardConductanceMass = 0;
                let reverseConductanceMass = 0;
                let supportedSegments = 0;
                for (let index = 0; index < samples.length; index++) {
                    const current = samples[index];
                    const leftActive = index > 0 && samples[index - 1].potential >= weakContactThreshold;
                    const rightActive = index + 1 < samples.length && samples[index + 1].potential >= weakContactThreshold;
                    if (current.potential >= weakContactThreshold && !leftActive && !rightActive) {
                        const isolatedNodeMass = current.candidateMass * current.potential;
                        isolatedMass += isolatedNodeMass;
                        isolatedSamples.push({
                            ...current,
                            sampleIndex: index,
                            isolatedNodeMass
                        });
                    }
                    if (index + 1 >= samples.length) continue;

                    const next = samples[index + 1];
                    const similarity = Math.max(-1, Math.min(1, cosine(current.vector, next.vector)));
                    const arc = Math.acos(similarity) / Math.PI;
                    const directConductance = Math.max(
                        0,
                        Number(kernel?.get(current.id)?.get(next.id)) || 0
                    );
                    const reverseConductance = Math.max(
                        0,
                        Number(kernel?.get(next.id)?.get(current.id)) || 0
                    );
                    const topology = clamp01(Math.sqrt(Math.max(directConductance, reverseConductance)));
                    const segmentPotential = Math.sqrt(current.potential * next.potential);
                    const segmentMass = Math.sqrt(current.candidateMass * next.candidateMass);
                    const segmentTrust = segmentPotential * (0.65 + 0.35 * topology);
                    const directionalTotal = directConductance + reverseConductance;
                    const directionalWeight = segmentMass * Math.max(segmentPotential, 0.05);
                    if (directionalTotal > 0) {
                        const directionRatio = directConductance / directionalTotal;
                        directedSupportWeight += directionalWeight;
                        directionConsistencyMass += directionalWeight * directionRatio;
                        forwardConductanceMass += directionalWeight * directConductance;
                        reverseConductanceMass += directionalWeight * reverseConductance;
                        supportedSegments++;
                    }

                    transitionWeight += segmentMass;
                    continuityMass += segmentMass * segmentTrust;
                    semanticArc += arc;
                    weightedSemanticArc += arc * segmentMass;
                    weightedAction += arc * segmentMass / Math.max(0.08, segmentPotential + 0.25 * topology);
                }

                const continuity = transitionWeight > 0
                    ? clamp01(continuityMass / transitionWeight)
                    : clamp01(maxPotential * 0.35);
                const rawIsolatedRatio = weightedPotential > 0
                    ? clamp01(isolatedMass / weightedPotential)
                    : 1;

                // 对位置孤立命中构造非局部子图。只有一对节点同时通过拓扑、语义、
                // 势能和闭合四重门槛，才记作可信交叉联想边。
                let sparseAssociationPairs = 0;
                let sparseAssociationQualityMass = 0;
                let sparseAssociationConnectedMass = 0;
                let sparseAssociationConfidence = 0;
                const sparseAssociationConnectedIds = new Set();
                if (
                    sparseAssociationEnabled
                    && isolatedSamples.length >= sparseAssociationMinContacts
                    && isolatedMass > 0
                ) {
                    for (let leftIndex = 0; leftIndex < isolatedSamples.length; leftIndex++) {
                        const left = isolatedSamples[leftIndex];
                        if (
                            left.potential < sparseAssociationMinPotential
                            || left.closure < sparseAssociationMinClosure
                        ) {
                            continue;
                        }

                        for (let rightIndex = leftIndex + 1; rightIndex < isolatedSamples.length; rightIndex++) {
                            const right = isolatedSamples[rightIndex];
                            if (
                                right.potential < sparseAssociationMinPotential
                                || right.closure < sparseAssociationMinClosure
                            ) {
                                continue;
                            }

                            // 相邻采样点已由普通 continuity 负责；这里只证明真正的跨段联想。
                            if (Math.abs(right.sampleIndex - left.sampleIndex) <= 1) continue;

                            const forward = Math.max(
                                0,
                                Number(kernel?.get(left.id)?.get(right.id)) || 0
                            );
                            const reverse = Math.max(
                                0,
                                Number(kernel?.get(right.id)?.get(left.id)) || 0
                            );
                            const conductance = Math.max(forward, reverse);
                            if (conductance < sparseAssociationMinConductance) continue;

                            const similarity = Math.max(
                                -1,
                                Math.min(1, cosine(left.vector, right.vector))
                            );
                            if (similarity < sparseAssociationMinSimilarity) continue;

                            const topologyQuality = clamp01(
                                (conductance - sparseAssociationMinConductance)
                                / Math.max(1e-6, 1 - sparseAssociationMinConductance)
                            );
                            const semanticQuality = clamp01(
                                (similarity - sparseAssociationMinSimilarity)
                                / Math.max(1e-6, 1 - sparseAssociationMinSimilarity)
                            );
                            const potentialQuality = Math.sqrt(left.potential * right.potential);
                            const closurePairQuality = Math.sqrt(left.closure * right.closure);
                            const relationQuality = Math.pow(
                                Math.max(
                                    0,
                                    topologyQuality
                                    * semanticQuality
                                    * potentialQuality
                                    * closurePairQuality
                                ),
                                0.25
                            );
                            if (relationQuality <= 0) continue;

                            sparseAssociationPairs++;
                            sparseAssociationQualityMass += relationQuality;
                            sparseAssociationConnectedIds.add(left.id);
                            sparseAssociationConnectedIds.add(right.id);
                        }
                    }

                    for (const sample of isolatedSamples) {
                        if (sparseAssociationConnectedIds.has(sample.id)) {
                            sparseAssociationConnectedMass += sample.isolatedNodeMass;
                        }
                    }

                    const connectedMassRatio = clamp01(
                        sparseAssociationConnectedMass / isolatedMass
                    );
                    const pairSaturation = clamp01(
                        sparseAssociationPairs / sparseAssociationPairSaturation
                    );
                    const meanRelationQuality = sparseAssociationPairs > 0
                        ? clamp01(sparseAssociationQualityMass / sparseAssociationPairs)
                        : 0;
                    sparseAssociationConfidence = clamp01(
                        connectedMassRatio
                        * pairSaturation
                        * meanRelationQuality
                    );
                }

                // 最多只减免一部分孤立量；即使关联子图很强，仍保留剩余随机跳跃守卫。
                const isolatedRatio = clamp01(
                    rawIsolatedRatio
                    * (1 - sparseAssociationMaxRelief * sparseAssociationConfidence)
                );
                const actionQuality = weightedSemanticArc > 0
                    ? clamp01(Math.exp(-weightedAction / Math.max(0.15, weightedSemanticArc)))
                    : clamp01(maxPotential * 0.5);
                const closureQuality = samples.reduce(
                    (sum, sample) => sum + sample.closure * sample.candidateMass,
                    0
                ) / totalCandidateMass;
                const directionConsistency = directedSupportWeight > 0
                    ? clamp01(directionConsistencyMass / directedSupportWeight)
                    : 0;
                const meanForwardConductance = directedSupportWeight > 0
                    ? Math.max(0, forwardConductanceMass / directedSupportWeight)
                    : 0;
                const meanReverseConductance = directedSupportWeight > 0
                    ? Math.max(0, reverseConductanceMass / directedSupportWeight)
                    : 0;

                // 不以绝对 Tag 数裁决。sampleScale 只控制“证据饱和速度”：
                // 短 Tag 链的核心锚点仍可成立，长链的孤立弱命中不会因数量膨胀获利。
                const effectiveEvidence = strongHits + exactHits * 0.75;
                const adaptiveTarget = Math.max(1, Math.min(sampleScale, Math.ceil(Math.sqrt(samples.length))));
                const evidenceConfidence = clamp01(effectiveEvidence / adaptiveTarget);
                const contactConfidence = clamp01(
                    weightedCoverage
                    * (0.55 + 0.45 * evidenceConfidence)
                    * (1 - 0.65 * isolatedRatio)
                );

                const geoScore = contactConfidence * clamp01(
                    0.30 * meanPotential
                    + 0.20 * maxPotential
                    + 0.20 * continuity
                    + 0.15 * actionQuality
                    + 0.15 * closureQuality
                );

                const directSemanticMeanPotential = directSemanticHits > 0
                    ? directSemanticPotentialSum / directSemanticHits
                    : 0;
                const directSemanticStrength = directSemanticHits >= directSemanticMinContacts
                    ? clamp01(
                        (directSemanticMeanPotential - directSemanticMinPotential)
                        / (directSemanticSaturation - directSemanticMinPotential)
                    )
                    : 0;

                // 四层几何影子读出。D/S/T 是同时存在的连续通道，而 legacy evidenceClass
                // 继续承担现有生产奖励限幅，不受本段计算影响。
                const directContactSaturation = clamp01(
                    (directExactHits + directSemanticHits)
                    / Math.max(1, directSemanticMinContacts + 1)
                );
                const directScore = clamp01(
                    0.45 * Math.max(directSemanticStrength, directExactHits > 0 ? 1 : 0)
                    + 0.25 * maxPotential
                    + 0.20 * meanPotential
                    + 0.10 * directContactSaturation
                );
                const structuralContact = clamp01(
                    (emergentExactHits + Math.min(strongHits, adaptiveTarget))
                    / Math.max(1, adaptiveTarget + 1)
                );
                const structuralScore = clamp01(
                    0.25 * continuity
                    + 0.20 * actionQuality
                    + 0.15 * closureQuality
                    + 0.15 * (1 - isolatedRatio)
                    + 0.15 * directionConsistency
                    + 0.10 * structuralContact
                );
                const thematicScore = clamp01(
                    0.35 * weightedCoverage
                    + 0.30 * meanPotential
                    + 0.20 * (1 - isolatedRatio)
                    + 0.15 * closureQuality
                );
                const originalQueryClosure = originalQueryVector
                    ? clamp01((cosine(originalQueryVector, chunkVector) + 1) / 2)
                    : 0;
                const enhancedQueryClosure = enhancedQueryVector
                    ? clamp01((cosine(enhancedQueryVector, chunkVector) + 1) / 2)
                    : 0;
                const vectorLift = originalQueryVector && enhancedQueryVector
                    ? enhancedQueryClosure - originalQueryClosure
                    : 0;
                const vectorLiftConsistency = clamp01(0.5 + vectorLift * 5);
                const closureScore = clamp01(
                    0.25 * originalQueryClosure
                    + 0.35 * enhancedQueryClosure
                    + 0.30 * closureQuality
                    + 0.10 * vectorLiftConsistency
                );
                const weightedDirect = queryGeometryWeights.direct * directScore;
                const weightedStructural = queryGeometryWeights.structural * structuralScore;
                const weightedThematic = queryGeometryWeights.thematic * thematicScore;
                const fusedGeometryScore = clamp01(
                    (1 - (1 - weightedDirect) * (1 - weightedStructural) * (1 - weightedThematic))
                    * closureScore
                );

                let evidenceClass = 'thematic';
                let evidenceReason = 'interpolated-theme-contact';
                if (directExactHits > 0) {
                    evidenceClass = 'direct';
                    evidenceReason = 'query-seed-or-core-exact-contact';
                } else if (directSemanticHits >= directSemanticMinContacts) {
                    evidenceClass = 'direct';
                    evidenceReason = 'multi-query-anchor-semantic-contact';
                } else if (
                    exactHits > 0
                    || (
                        strongHits >= 2
                        && continuity >= structuralContinuityMin
                        && isolatedRatio <= thematicMaxIsolatedRatio
                    )
                ) {
                    evidenceClass = 'structural';
                    evidenceReason = exactHits > 0
                        ? 'propagated-exact-contact'
                        : 'multi-contact-continuous-corridor';
                }

                // 纯主题晕轮必须至少具备可解释的势能与非孤立接触，否则只保留诊断，不授予排序权。
                const rewardEligible = evidenceClass !== 'thematic'
                    || (
                        maxPotential >= thematicMinPotential
                        && isolatedRatio <= thematicMaxIsolatedRatio
                    );

                return {
                    candidate,
                    originalIndex,
                    geoScore,
                    confidence: contactConfidence,
                    evidenceClass,
                    evidenceReason,
                    rewardEligible,
                    exactHits,
                    directExactHits,
                    directExactMaxPotential,
                    directExactBestSpecificity,
                    directExactBestClosure,
                    identityAnchorStrength,
                    emergentExactHits,
                    directSemanticHits,
                    directSemanticStrength,
                    directSemanticMeanPotential,
                    directSemanticMaxPotential,
                    strongHits,
                    weakHits,
                    sampleCount: samples.length,
                    weightedCoverage,
                    meanPotential,
                    maxPotential,
                    continuity,
                    isolatedRatio,
                    rawIsolatedRatio,
                    sparseAssociationConfidence,
                    sparseAssociationPairs,
                    sparseAssociationConnectedNodes: sparseAssociationConnectedIds.size,
                    actionQuality,
                    closureQuality,
                    semanticArc,
                    geometryShadow: {
                        version: 'four-layer-shadow-v1',
                        directScore,
                        structuralScore,
                        thematicScore,
                        closureScore,
                        fusedScore: fusedGeometryScore,
                        queryWeights: queryGeometryWeights,
                        directionConsistency,
                        meanForwardConductance,
                        meanReverseConductance,
                        supportedSegments,
                        originalQueryClosure,
                        enhancedQueryClosure,
                        vectorLift,
                        vectorLiftConsistency
                    },
                    reason: geoScore > 0 ? null : 'curve-confidence-zero',
                    contactTags: samples
                        .filter(sample => sample.potential >= weakContactThreshold)
                        .sort((a, b) => b.potential - a.potential)
                        .slice(0, 8)
                        .map(sample => ({
                            id: sample.id,
                            name: sample.name,
                            potential: sample.potential,
                            exact: sample.exact,
                            position: sample.position,
                            sourceType: sample.exact
                                ? sample.exactSourceType
                                : sample.nearestSourceType,
                            hop: sample.exact
                                ? sample.exactHop
                                : sample.nearestHop
                        }))
                };
            });

            const contributors = geoData.filter(item => item.geoScore > 0);
            if (contributors.length === 0) {
                return fallback('no candidate curve contacted the query field', {
                    candidates: candidates.length,
                    fieldTags: fieldNodes.length
                });
            }

            let minPositiveGeo = Infinity;
            let maxGeo = 0;
            for (const item of contributors) {
                minPositiveGeo = Math.min(minPositiveGeo, item.geoScore);
                maxGeo = Math.max(maxGeo, item.geoScore);
            }
            const coverageRatio = contributors.length / candidates.length;
            const spread = maxGeo - minPositiveGeo;
            const strongEvidence = contributors.reduce(
                (sum, item) => sum + (item.strongHits || 0) + (item.exactHits || 0) * 0.75,
                0
            );

            // 稀有但精准的场接触不应因低覆盖单独被拒绝；仅联合低覆盖、低曲线分和弱证据时回退。
            if (
                fallbackEnabled
                && coverageRatio < minCandidateCoverage
                && maxGeo < minGeoScore
                && strongEvidence < minStrongEvidence
            ) {
                return fallback('candidate curve readout jointly low-trust', {
                    coverage: coverageRatio,
                    maxGeo,
                    strongEvidence
                });
            }
            if (
                fallbackEnabled
                && contributors.length > 1
                && spread < minGeoSpread
                && maxGeo < minGeoScore
                && strongEvidence < minStrongEvidence
            ) {
                return fallback('candidate curve scores jointly lack discrimination', {
                    spread,
                    maxGeo,
                    strongEvidence
                });
            }

            const reranked = geoData.map(item => {
                const knnScore = Number(item.candidate.score) || 0;
                // 不再把批内冠军强制归一化为 1；相同绝对曲线分跨查询获得相同读出强度。
                const normalizedGeo = item.geoScore > 0
                    ? clamp01(
                        (item.geoScore - geoRewardFloor)
                        / (geoRewardSaturation - geoRewardFloor)
                    )
                    : 0;
                const bonusCap = item.evidenceClass === 'direct'
                    ? directBonusCap
                    : item.evidenceClass === 'structural'
                        ? structuralBonusCap
                        : thematicBonusCap;
                const directSemanticQualified = item.evidenceClass === 'direct'
                    && (item.directSemanticHits || 0) >= directSemanticMinContacts;
                const rewardStrength = directSemanticQualified
                    ? Math.max(normalizedGeo, item.directSemanticStrength || 0)
                    : normalizedGeo;
                const rewardConfidence = directSemanticQualified
                    ? Math.max(item.confidence || 0, directConfidenceFloor)
                    : item.confidence;
                const requestedBonus = item.rewardEligible
                    ? mixAlpha * rewardConfidence * rewardStrength
                    : 0;
                const baseGeoBonus = Math.min(bonusCap, Math.max(0, requestedBonus));

                // 辅助轨必须已经拥有可信节点场证据。闭合层和向量提升只参与门控，
                // 不允许节点场守卫候选或单纯 KNN 相似候选凭 C4/Lift 获得奖励。
                const shadow = item.geometryShadow || null;
                const classEvidence = item.evidenceClass === 'direct'
                    ? Number(shadow?.directScore || 0)
                    : item.evidenceClass === 'structural'
                        ? Number(shadow?.structuralScore || 0)
                        : Number(shadow?.thematicScore || 0);
                const classFloorCap = item.evidenceClass === 'direct'
                    ? geometryAuxDirectCap
                    : item.evidenceClass === 'structural'
                        ? geometryAuxStructuralCap
                        : geometryAuxThematicCap;
                const fusedShadow = Math.max(0, Number(shadow?.fusedScore) || 0);
                const closureShadow = Math.max(0, Number(shadow?.closureScore) || 0);
                const geometryAuxEligible = geometryAuxEnabled
                    && item.rewardEligible === true
                    && shadow
                    && shadow.nodeFieldGuarded !== true
                    && classEvidence >= geometryAuxMinClassEvidence
                    && fusedShadow >= geometryAuxMinFused
                    && closureShadow >= geometryAuxMinClosure;
                const fusedReliability = geometryAuxEligible
                    ? clamp01(
                        (fusedShadow - geometryAuxMinFused)
                        / Math.max(1e-6, 1 - geometryAuxMinFused)
                    )
                    : 0;
                const classReliability = geometryAuxEligible
                    ? clamp01(
                        (classEvidence - geometryAuxMinClassEvidence)
                        / Math.max(1e-6, 1 - geometryAuxMinClassEvidence)
                    )
                    : 0;
                const closureReliability = geometryAuxEligible
                    ? clamp01(
                        (closureShadow - geometryAuxMinClosure)
                        / Math.max(1e-6, 1 - geometryAuxMinClosure)
                    )
                    : 0;
                const geometryAuxReliability = geometryAuxEligible
                    ? Math.cbrt(fusedReliability * classReliability * closureReliability)
                    : 0;
                const geometryAuxTargetFloor = geometryAuxEligible
                    ? classFloorCap * Math.pow(geometryAuxReliability, geometryAuxExponent)
                    : 0;

                const identityAnchorEligible = identityAnchorEnabled
                    && item.evidenceClass === 'direct'
                    && item.rewardEligible === true
                    && shadow?.nodeFieldGuarded !== true
                    && (item.directExactHits || 0) > 0
                    && (item.directExactMaxPotential || 0) >= identityAnchorMinPotential
                    && (item.directExactBestSpecificity || 0) >= identityAnchorMinSpecificity
                    && (item.directExactBestClosure || 0) >= identityAnchorMinClosure
                    && (item.identityAnchorStrength || 0) >= identityAnchorMinStrength;
                const identityAnchorReliability = identityAnchorEligible
                    ? clamp01(
                        (item.identityAnchorStrength - identityAnchorMinStrength)
                        / Math.max(1e-6, 1 - identityAnchorMinStrength)
                    )
                    : 0;
                const identityAnchorTargetFloor = identityAnchorEligible
                    ? identityAnchorFloorCap
                        * Math.pow(identityAnchorReliability, identityAnchorExponent)
                    : 0;

                // 生产公式：辅助目标不是额外线性奖励，只补足旧奖励未达到的最低权限。
                // 两个辅助来源取 max 而非相加，进一步避免同一 direct 证据被重复计算。
                const auxiliaryTargetFloor = Math.min(
                    bonusCap,
                    Math.max(geometryAuxTargetFloor, identityAnchorTargetFloor)
                );
                const geometryAuxBonus = geometryAuxEnabled
                    ? Math.min(
                        geometryAuxMaxBonus,
                        Math.max(0, auxiliaryTargetFloor - baseGeoBonus)
                    )
                    : 0;
                const geoBonus = Math.min(bonusCap, baseGeoBonus + geometryAuxBonus);
                const finalScore = knnScore + geoBonus;
                const geoEffect = geoBonus > 0 ? 'boost' : 'neutral';
                const geometryAuxReason = !geometryAuxEnabled
                    ? 'disabled'
                    : shadow?.nodeFieldGuarded === true
                        ? 'node-field-guarded'
                        : geometryAuxBonus > 0
                            ? (identityAnchorTargetFloor >= geometryAuxTargetFloor
                                ? 'identity-floor-gap'
                                : 'geometry-floor-gap')
                            : auxiliaryTargetFloor > 0
                                ? 'base-bonus-already-satisfies-floor'
                                : 'reliability-gate-not-met';

                return {
                    ...item.candidate,
                    score: finalScore,
                    original_knn_score: knnScore,
                    geo_score: item.geoScore,
                    normalized_geo: normalizedGeo,
                    geo_bonus: geoBonus,
                    geo_base_bonus: baseGeoBonus,
                    geo_aux_bonus: geometryAuxBonus,
                    geo_aux_target_floor: auxiliaryTargetFloor,
                    geo_aux_geometry_floor: geometryAuxTargetFloor,
                    geo_aux_identity_floor: identityAnchorTargetFloor,
                    geo_aux_enabled: geometryAuxEnabled,
                    geo_aux_eligible: geometryAuxEligible,
                    geo_aux_reliability: geometryAuxReliability,
                    geo_aux_reason: geometryAuxReason,
                    geo_identity_anchor_eligible: identityAnchorEligible,
                    geo_identity_anchor_strength: item.identityAnchorStrength || 0,
                    geo_identity_anchor_reliability: identityAnchorReliability,
                    geo_direct_exact_max_potential: item.directExactMaxPotential || 0,
                    geo_direct_exact_best_specificity: item.directExactBestSpecificity || 0,
                    geo_direct_exact_best_closure: item.directExactBestClosure || 0,
                    geo_bonus_cap: bonusCap,
                    geo_effect: geoEffect,
                    geo_evidence_class: item.evidenceClass || 'neutral',
                    geo_evidence_reason: item.evidenceReason || item.reason || null,
                    geo_reward_eligible: item.rewardEligible === true,
                    geo_hit_count: item.weakHits || 0,
                    geo_confidence: item.confidence,
                    geo_curve_samples: item.sampleCount || 0,
                    geo_exact_hits: item.exactHits || 0,
                    geo_direct_exact_hits: item.directExactHits || 0,
                    geo_emergent_exact_hits: item.emergentExactHits || 0,
                    geo_direct_semantic_hits: item.directSemanticHits || 0,
                    geo_direct_semantic_strength: item.directSemanticStrength || 0,
                    geo_reward_strength: rewardStrength,
                    geo_reward_confidence: rewardConfidence || 0,
                    geo_strong_hits: item.strongHits || 0,
                    geo_weighted_coverage: item.weightedCoverage || 0,
                    geo_mean_potential: item.meanPotential || 0,
                    geo_max_potential: item.maxPotential || 0,
                    geo_continuity: item.continuity || 0,
                    // isolated_ratio 是参与生产裁决的有效值；raw 值保留原始序列孤立观测。
                    geo_isolated_ratio: item.isolatedRatio ?? 1,
                    geo_raw_isolated_ratio: item.rawIsolatedRatio ?? item.isolatedRatio ?? 1,
                    geo_sparse_association_confidence: item.sparseAssociationConfidence || 0,
                    geo_sparse_association_pairs: item.sparseAssociationPairs || 0,
                    geo_sparse_association_connected_nodes: item.sparseAssociationConnectedNodes || 0,
                    geo_action_quality: item.actionQuality || 0,
                    geo_closure_quality: item.closureQuality || 0,
                    geo_contact_tags: item.contactTags || [],
                    geo_guard_reason: item.reason || null,
                    // 四层几何仍保留完整诊断；生产只读取受严格门控和独立上限约束的奖励地板。
                    geo_geometry_shadow: item.geometryShadow || null,
                    geo_direct_score: item.geometryShadow?.directScore || 0,
                    geo_structural_score: item.geometryShadow?.structuralScore || 0,
                    geo_thematic_score: item.geometryShadow?.thematicScore || 0,
                    geo_closure_score: item.geometryShadow?.closureScore || 0,
                    geo_fused_shadow_score: item.geometryShadow?.fusedScore || 0,
                    geo_direction_consistency: item.geometryShadow?.directionConsistency || 0,
                    geo_vector_lift: item.geometryShadow?.vectorLift || 0
                };
            });

            reranked.sort((left, right) =>
                (right.score - left.score)
                || ((right.original_knn_score || 0) - (left.original_knn_score || 0))
            );

            const leader = [...contributors].sort((a, b) => b.geoScore - a.geoScore)[0];
            const evidenceCounts = geoData.reduce((counts, item) => {
                const key = item.evidenceClass || 'neutral';
                counts[key] = (counts[key] || 0) + 1;
                return counts;
            }, {});
            const auxiliaryBoosted = reranked.filter(item => (item.geo_aux_bonus || 0) > 0);
            const identityProtected = reranked.filter(item => item.geo_aux_reason === 'identity-floor-gap');
            console.log(
                `[TagMemo-V9.2 GeodesicCurve] α=${mixAlpha.toFixed(3)}, candidates=${candidates.length}, ` +
                `contributors=${contributors.length}, fieldTags=${fieldNodes.length}, ` +
                `evidence=direct:${evidenceCounts.direct || 0}/structural:${evidenceCounts.structural || 0}/thematic:${evidenceCounts.thematic || 0}, ` +
                `aux=${geometryAuxEnabled ? 'on' : 'off'}:${auxiliaryBoosted.length}, identityProtected=${identityProtected.length}, ` +
                `curveRange=${minPositiveGeo.toFixed(4)}..${maxGeo.toFixed(4)}, ` +
                `leaderChunk=${Number(leader?.candidate?.id)}, leaderCoverage=${(leader?.weightedCoverage || 0).toFixed(3)}, ` +
                `leaderContinuity=${(leader?.continuity || 0).toFixed(3)}, leaderContacts=${leader?.weakHits || 0}`
            );
            return reranked;
        } catch (error) {
            console.error('[TagMemoEngine] geodesicRerank curve evaluation failed, falling back to original order:', error.message);
            return candidates;
        }
    }

    // ============================================================
    // 🌟 TagMemo V8.2-γ: 有序双向势能共现矩阵
    // 三轴解耦：
    //   - 拓扑层 (形): 双向共现 (是否邻接)
    //   - 方向层 (色): 顺逆流阻尼 (叙事方向)
    //   - 语义层 (质): 向量距离阻尼 (semanticGain) + 概念锚 boost (节点残差)
    // 七条工程纪律：
    //   1) 反转守卫 backwardWeight ≤ forwardWeight × 95% (保叙事方向公理)
    //   2) 冷启动阻塞 (在 initialize 中处理)
    //   3) model_sig 含 dimension (在 _computeModelSig 中处理)
    //   4) sim 预计算与矩阵重建共用 _isMatrixRebuilding 锁 (在 doMatrixRebuild 中处理)
    //   5) getSim 未命中 fallback = 0.1 (与噪声阈值 0.05 解耦)
    //   6) Gemini 分布建议先扫描再调 peak (留作运行时 ops 任务)
    //   7) tags.vector 重写时 DELETE 涉及该 tag 的 sim 行 (在 KnowledgeBaseManager 中处理)
    // ============================================================
    buildDirectedCooccurrenceMatrix() {
        const matrixBuildStartedAt = Date.now();
        console.log('[TagMemoEngine] 🧠 V8.2 Building ORDERED-BIDIRECTIONAL tag co-occurrence matrix (γ)...');
        try {
            // 势能参数
            const PHI_MAX = 0.9;
            const PHI_MIN = 0.5;

            // ---------- V8.2 灰度参数（rag_params.json: orderedCooccurrence） ----------
            const matrixConfig = this.ragParams?.KnowledgeBaseManager?.orderedCooccurrence || {};

            // 顺流：叙事方向 A → B
            const FORWARD_GAIN = matrixConfig.forwardGain ?? 1.0;

            // 逆流：回溯方向 B → A，默认保留但明显阻尼
            const RAW_REVERSE_GAIN = matrixConfig.reverseGain ?? 0.42;
            const MIN_REVERSE_GAIN = matrixConfig.minReverseGain ?? 0.25;
            const MAX_REVERSE_GAIN = matrixConfig.maxReverseGain ?? 0.70;
            const reverseGain = Math.max(
                MIN_REVERSE_GAIN,
                Math.min(MAX_REVERSE_GAIN, RAW_REVERSE_GAIN)
            );

            // Tag 序位距离衰减：相邻 Tag 强，远距离 Tag 弱（默认关闭，灰度逐步开）
            const DISTANCE_DECAY = matrixConfig.distanceDecay ?? 0.0;

            // β: 概念锚逆流增强（基于节点残差）
            // boolean 兼容数值 1/0（前端 UI 用数值表达 toggle）
            const rawAnchorBoost = matrixConfig.reverseAnchorBoost;
            const REVERSE_ANCHOR_BOOST = (rawAnchorBoost === true || rawAnchorBoost === 1)
                || (typeof rawAnchorBoost === 'number' && rawAnchorBoost >= 1);
            const REVERSE_ANCHOR_MAX = matrixConfig.reverseAnchorMax ?? 1.5;

            // γ: 语义增益（基于边向量距离）
            // 同时兼容嵌套对象 (semanticGain.{enabled,peak,sigma,lowSimFallback})
            // 与平铺数值字段 (semanticGainEnabled / semanticGainPeak / semanticGainSigma / semanticGainLowSimFallback)
            // 平铺写法是为了适配 AdminPanel-Vue RagTuning UI 的 nested 单层渲染约束。
            const semGainCfg = matrixConfig.semanticGain || {};
            const rawSemEnabled = semGainCfg.enabled ?? matrixConfig.semanticGainEnabled;
            const SEM_GAIN_ENABLED = (rawSemEnabled === true || rawSemEnabled === 1)
                || (typeof rawSemEnabled === 'number' && rawSemEnabled >= 1);
            const SEM_PEAK = semGainCfg.peak ?? matrixConfig.semanticGainPeak ?? 0.65;
            const SEM_SIGMA = semGainCfg.sigma ?? matrixConfig.semanticGainSigma ?? 0.25;
            const SEM_LOW_FALLBACK = semGainCfg.lowSimFallback ?? matrixConfig.semanticGainLowSimFallback ?? 0.1;

            // 反转守卫：逆流永远不超过顺流的 95%
            const REVERSE_INVERSION_GUARD = matrixConfig.reverseInversionGuard ?? 0.95;

            // ---------- 钟形语义增益 ----------
            // 低 sim 软底（0.40~0.55）+ 中段高斯钟形（peak 黄金区放大）+ 高 sim 抑制
            const semanticGain = (sim) => {
                if (!SEM_GAIN_ENABLED) return 1.0;
                if (!Number.isFinite(sim)) return 1.0;
                if (sim < 0.15) return 0.4 + sim * 1.0; // 软底 0.40 ~ 0.55
                return 0.5 + 0.8 * Math.exp(
                    -((sim - SEM_PEAK) ** 2) / (2 * SEM_SIGMA * SEM_SIGMA)
                );
            };

            // 包装 getSim，未命中走配置化 fallback
            const getSimSafe = (a, b) => {
                if (!SEM_GAIN_ENABLED) return SEM_LOW_FALLBACK;
                const v = this.getSim(a, b);
                return Number.isFinite(v) && v > 0 ? v : SEM_LOW_FALLBACK;
            };

            // ---------- Step 1: 双向共现 ----------
            const stmt = this.db.prepare(`
                SELECT file_id, tag_id, position
                FROM file_tags
                WHERE position > 0
                ORDER BY file_id, position ASC
            `);

            const matrix = new Map();
            let currentFileId = -1;
            let fileTags = [];

            // 可观测性指标
            let forwardEdges = 0;
            let backwardEdges = 0;
            let anchorBoostedEdges = 0;
            let invertedClampedEdges = 0;

            const progressIntervalFiles = parseInt(process.env.TAGMEMO_MATRIX_PROGRESS_INTERVAL_FILES, 10) || 5000;
            let processedOrderedFiles = 0;
            let skippedOrderedFiles = 0;
            let orderedPairOps = 0;

            const addEdge = (from, to, weight) => {
                if (!Number.isFinite(weight) || weight <= 0) return false;
                if (!matrix.has(from)) matrix.set(from, new Map());
                const targetMap = matrix.get(from);
                targetMap.set(to, (targetMap.get(to) || 0) + weight);
                return true;
            };

            const processFileGroup = (tags, fid) => {
                processedOrderedFiles++;
                const n = tags.length;
                if (n < 2) return;
                if (n > 100) {
                    skippedOrderedFiles++;
                    return;
                } // 性能保护

                orderedPairOps += (n * (n - 1)) / 2;
                if (processedOrderedFiles % progressIntervalFiles === 0) {
                    console.log(
                        `[TagMemoEngine] 🧭 Matrix ordered progress: files=${processedOrderedFiles}, ` +
                        `skipped=${skippedOrderedFiles}, pairOps≈${Math.round(orderedPairOps)}, ` +
                        `sources=${matrix.size}, elapsed=${Date.now() - matrixBuildStartedAt}ms`
                    );
                }

                for (let i = 0; i < n; i++) {
                    for (let j = i + 1; j < n; j++) {
                        const t1 = tags[i];
                        const t2 = tags[j];

                        // 序位势能：越靠前的 tag 越像叙事源头
                        const phi1 = n > 1
                            ? PHI_MAX - (PHI_MAX - PHI_MIN) * (t1.pos - 1) / (n - 1)
                            : PHI_MAX;
                        const phi2 = n > 1
                            ? PHI_MAX - (PHI_MAX - PHI_MIN) * (t2.pos - 1) / (n - 1)
                            : PHI_MAX;

                        const delta = Math.max(1, t2.pos - t1.pos);

                        // 距离衰减
                        const distanceFactor = DISTANCE_DECAY > 0
                            ? Math.exp(-DISTANCE_DECAY * (delta - 1))
                            : 1.0;

                        const baseWeight = phi1 * phi2 * distanceFactor;

                        // γ: 语义增益（对称项，余弦距离天然对称）
                        const sim = getSimSafe(t1.id, t2.id);
                        const semGain = semanticGain(sim);

                        // 顺流：A → B
                        const forwardWeight = baseWeight * FORWARD_GAIN * semGain;

                        // 逆流：B → A
                        let dynamicReverseGain = reverseGain;

                        // β: 概念锚增强 — 高内生残差的源头 (t1) 更适合作为逆流回溯目标
                        // (B → A 时 A=t1，t1 的残差越大 → t1 越像独立锚点 → 逆流越通畅)
                        if (REVERSE_ANCHOR_BOOST && this.tagIntrinsicResiduals) {
                            const anchorMass = this.tagIntrinsicResiduals.get(t1.id) ?? 1.0;
                            const boost = Math.min(REVERSE_ANCHOR_MAX, anchorMass);
                            if (boost > 1.0) anchorBoostedEdges++;
                            dynamicReverseGain *= boost;
                        }

                        // 安全夹逼
                        dynamicReverseGain = Math.max(
                            MIN_REVERSE_GAIN,
                            Math.min(MAX_REVERSE_GAIN, dynamicReverseGain)
                        );

                        let backwardWeight = baseWeight * dynamicReverseGain * semGain;

                        // 🛡️ 反转守卫：逆流永远不超过顺流 × 95%
                        // 保 V8.2 的根本前提:叙事方向不对称
                        const cap = forwardWeight * REVERSE_INVERSION_GUARD;
                        if (backwardWeight > cap) {
                            backwardWeight = cap;
                            invertedClampedEdges++;
                        }

                        if (addEdge(t1.id, t2.id, forwardWeight)) forwardEdges++;
                        if (addEdge(t2.id, t1.id, backwardWeight)) backwardEdges++;
                    }
                }
            };

            for (const row of stmt.iterate()) {
                if (row.file_id !== currentFileId) {
                    if (fileTags.length > 0) processFileGroup(fileTags, currentFileId);
                    currentFileId = row.file_id;
                    fileTags = [];
                }
                fileTags.push({ id: row.tag_id, pos: row.position });
            }
            if (fileTags.length > 0) processFileGroup(fileTags, currentFileId);

            // ---------- Step 2: 旧数据 (position=0) 回退为无向等权重 ----------
            // 🛡️ CPU loop/卡死修复：
            // 旧实现使用 file_tags 自连接 + GROUP BY，在旧库或 position=0 数据较多时会产生巨大的 O(N²)
            // 同步 SQLite 执行计划；Node 主线程卡在 better-sqlite3 内部时不会输出任何新日志，看起来像“无日志高占用”。
            // 改为与 Rust/V8.2 主路径一致的逐文件流式聚合，并保留单文件 Tag 数 ≤100 的守恒保护。
            const legacyStmt = this.db.prepare(`
                SELECT file_id, tag_id
                FROM file_tags
                WHERE position = 0
                ORDER BY file_id
            `);

            const LEGACY_PHI = 0.7;
            let legacyFileId = -1;
            let legacyTags = [];
            let legacyProcessedFiles = 0;
            let legacySkippedFiles = 0;
            let legacyPairOps = 0;

            const processLegacyFileGroup = (tags) => {
                legacyProcessedFiles++;
                const n = tags.length;
                if (n < 2) return;
                if (n > 100) {
                    legacySkippedFiles++;
                    return;
                }

                legacyPairOps += (n * (n - 1)) / 2;
                if (legacyProcessedFiles % progressIntervalFiles === 0) {
                    console.log(
                        `[TagMemoEngine] 🧭 Matrix legacy progress: files=${legacyProcessedFiles}, ` +
                        `skipped=${legacySkippedFiles}, pairOps≈${Math.round(legacyPairOps)}, ` +
                        `sources=${matrix.size}, elapsed=${Date.now() - matrixBuildStartedAt}ms`
                    );
                }

                const weightBase = LEGACY_PHI * LEGACY_PHI;
                for (let i = 0; i < n; i++) {
                    for (let j = i + 1; j < n; j++) {
                        const tag1 = tags[i];
                        const tag2 = tags[j];
                        if (tag1 === tag2) continue;

                        // legacy 数据天然无方向，仍走 sim 调制保持语义一致性
                        const sim = getSimSafe(tag1, tag2);
                        const semGain = semanticGain(sim);
                        const weight = weightBase * semGain;

                        if (addEdge(tag1, tag2, weight)) forwardEdges++;
                        if (addEdge(tag2, tag1, weight)) backwardEdges++;
                    }
                }
            };

            for (const row of legacyStmt.iterate()) {
                if (row.file_id !== legacyFileId) {
                    if (legacyTags.length > 0) processLegacyFileGroup(legacyTags);
                    legacyFileId = row.file_id;
                    legacyTags = [];
                }
                legacyTags.push(row.tag_id);
            }
            if (legacyTags.length > 0) processLegacyFileGroup(legacyTags);

            // V9.1 staging 资产完整构建结束后才一次性发布；旧请求继续持有旧 bundle。
            const publishedRegistry = this._stageAndPublishV91Bundle(matrix);

            console.log(
                `[TagMemoEngine] ✅ V8.2 Ordered-bidirectional matrix built. ` +
                `sources=${matrix.size}, forward=${forwardEdges}, backward=${backwardEdges}, ` +
                `anchor_boosted=${anchorBoostedEdges}, inversion_clamped=${invertedClampedEdges}, ` +
                `reverseGain=${reverseGain.toFixed(3)}, distanceDecay=${DISTANCE_DECAY}, ` +
                `semGain=${SEM_GAIN_ENABLED ? `bell(peak=${SEM_PEAK}, σ=${SEM_SIGMA})` : 'disabled'}, ` +
                `anchorBoost=${REVERSE_ANCHOR_BOOST ? `≤${REVERSE_ANCHOR_MAX}x` : 'disabled'}, ` +
                `orderedFiles=${processedOrderedFiles}, orderedSkippedFiles=${skippedOrderedFiles}, orderedPairOps≈${Math.round(orderedPairOps)}, ` +
                `legacyFiles=${legacyProcessedFiles}, legacySkippedFiles=${legacySkippedFiles}, legacyPairOps≈${Math.round(legacyPairOps)}, ` +
                `simCacheSize=${this.tagPairSimilarities.size}, elapsed=${Date.now() - matrixBuildStartedAt}ms`
            );
            return publishedRegistry;
        } catch (e) {
            // 构建全程使用 staging Map；失败时必须保留上一代活动 Bundle 及所有兼容别名。
            console.error('[TagMemoEngine] ❌ Failed to build V8.2 ordered-bidirectional matrix; keeping previous active artifact:', e);
            throw e;
        }
    }

    // 🌟 V8.2-γ: 加载持久化的 Tag 对语义相似度到内存 Map
    // 矩阵构建是热路径，不能每对 pair 查 SQLite。
    loadPairwiseSimilarities(options = {}) {
        const { failOnCorruption = false } = options;

        const doLoad = () => {
            const rows = this.db.prepare(
                'SELECT tag_a, tag_b, similarity FROM tag_pair_similarity WHERE model_sig = ?'
            ).all(this.modelSig);

            this.tagPairSimilarities = new Map();
            for (const row of rows) {
                this.tagPairSimilarities.set(`${row.tag_a}:${row.tag_b}`, row.similarity);
            }
            return this.tagPairSimilarities.size;
        };

        try {
            const count = doLoad();
            console.log(`[TagMemoEngine] ✅ V8.2 Loaded ${count} pairwise similarities (model_sig=${this.modelSig})`);
            return true;
        } catch (e) {
            this.tagPairSimilarities = new Map();
            const isCorruption = this.knowledgeBaseManager?._isSqliteCorruptionError?.(e);

            if (failOnCorruption && isCorruption) {
                // 🛡️ P0: 单次 malformed 多为跨连接 WAL/SHM 瞬态视图问题。
                // 先走二阶段健康检查 (suspect → 重开连接 → 复检)；复检通过 (连接已重绑定到健康连接)
                // 则用健康连接重试一次加载，避免把可恢复的瞬态故障误判为派生任务失败。
                const recovered = this.knowledgeBaseManager.checkpointAndAssertDatabaseHealthy('loading pairwise similarities');
                if (recovered) {
                    try {
                        const count = doLoad();
                        console.warn(`[TagMemoEngine] ♻️ V8.2 Reloaded ${count} pairwise similarities after suspect recovery (model_sig=${this.modelSig}).`);
                        return true;
                    } catch (retryErr) {
                        console.error('[TagMemoEngine] ❌ V8.2 pairwise similarity reload still failed after suspect recovery:', retryErr.message || retryErr);
                        this.tagPairSimilarities = new Map();
                        throw retryErr;
                    }
                }
                // 二阶段复检仍失败 → 视为真正损坏，向上抛出以中止派生链。
                throw e;
            }

            console.warn('[TagMemoEngine] ⚠️ V8.2 pairwise similarity table not yet available:', e.message);
            return false;
        }
    }

    /**
     * 🌟 V8.2-γ: 查询两个 tag 的持久化余弦相似度
     * 约定 a < b，未命中返回 0（由 buildDirectedCooccurrenceMatrix 包装为配置化 fallback）
     */
    getSim(idA, idB) {
        if (idA === idB) return 1.0;
        const [a, b] = idA < idB ? [idA, idB] : [idB, idA];
        const v = this.tagPairSimilarities.get(`${a}:${b}`);
        return Number.isFinite(v) ? v : 0;
    }

    /**
     * 🛡️ SQLite 写后验收统一入口。
     * 不在 TagMemoEngine 内直接 checkpoint，避免 EPA / matrix rebuild 路径出现
     * TagMemoEngine 与 KnowledgeBaseManager 双重 TRUNCATE checkpoint。
     */
    _checkpointAfterRustWrite(tag) {
        return this._assertHealthyAfterRustWrite(tag);
    }

    _assertHealthyAfterRustWrite(tag) {
        const reason = `Rust write "${tag}"`;
        if (
            this.knowledgeBaseManager
            && typeof this.knowledgeBaseManager.reopenAndAssertDatabaseHealthy === 'function'
        ) {
            return this.knowledgeBaseManager.reopenAndAssertDatabaseHealthy(reason);
        }
        // 兼容尚未实现专用 Rust 屏障的测试桩/降级 coordinator。
        if (
            this.knowledgeBaseManager
            && typeof this.knowledgeBaseManager.checkpointAndAssertDatabaseHealthy === 'function'
        ) {
            return this.knowledgeBaseManager.checkpointAndAssertDatabaseHealthy(reason);
        }
        // 无 KnowledgeBaseManager coordinator 的测试/降级环境中，不能递归调用自身；
        // 此时没有统一 checkpoint 裁决者，只能视为软通过。
        return true;
    }

    async _withRustWriteLease(owner, fn, options = {}) {
        if (!this.knowledgeBaseManager || typeof this.knowledgeBaseManager.requestRustWriteLease !== 'function') {
            return await fn();
        }

        const lease = await this.knowledgeBaseManager.requestRustWriteLease(owner, options);
        if (!lease) {
            console.warn(`[TagMemoEngine] 🦀⏳ Rust write lease denied/timed out for "${owner}"; deferring this run.`);
            return null;
        }

        try {
            const result = await fn();
            // 复合流水线可在每次 Rust 写后自行执行屏障，避免租约尾部再次
            // 重开连接并重复 TRUNCATE + quick_check。
            if (options.skipFinalHealthCheck !== true) {
                const healthy = this._assertHealthyAfterRustWrite(owner);
                if (!healthy) {
                    console.error(`[TagMemoEngine] 🚨 Database health check failed before releasing Rust write lease "${owner}".`);
                    return null;
                }
            }
            return result;
        } finally {
            lease.release();
        }
    }

    /**
     * 🌟 V8.2-γ: 触发 Rust 预计算成对语义相似度
     * - 默认增量模式（跳过已缓存且 model_sig 一致的 pair）
     * - 与 doMatrixRebuild 共用 _isMatrixRebuilding 锁
     */
    async recomputePairwiseSimilarities(opts = {}) {
        const { fullRebuild = false, blocking = false, minSimilarity = 0.05, leaseAlreadyHeld = false } = opts;

        if (!this.tagIndex || !this.tagIndex.computePairwiseSimilarities) {
            console.warn('[TagMemoEngine] ⚠️ computePairwiseSimilarities is not available in VexusIndex (Rust binary may need rebuild)');
            return null;
        }

        // 锁串行：避免与矩阵重建撞车产生"嵌合矩阵"
        // blocking=true 用于冷启动场景，由调用方持锁
        if (!blocking && this._isMatrixRebuilding) {
            console.log('[TagMemoEngine] 🛡️ V8.2 sim recompute deferred: matrix rebuild in progress');
            return null;
        }

        const run = async () => {
            console.log(`[TagMemoEngine] ⚡ V8.2 Triggering Rust pairwise similarity precomputation (model_sig=${this.modelSig}, fullRebuild=${fullRebuild})...`);
            try {
                const dbPath = path.join(path.dirname(this.db.name), 'knowledge_base.sqlite');
                const result = await this.tagIndex.computePairwiseSimilarities(
                    dbPath,
                    this.modelSig,
                    minSimilarity,
                    fullRebuild
                );
                if (!result) return null;
                console.log(
                    `[TagMemoEngine] ✅ V8.2 Rust pairwise sim done: ` +
                    `pairs=${result.pairCount}, computed=${result.computedCount}, ` +
                    `skipped=${result.skippedCount}, stored=${result.storedCount}, ` +
                    `elapsed=${result.elapsedMs.toFixed(2)}ms`
                );
                return result;
            } catch (e) {
                console.error('[TagMemoEngine] ❌ V8.2 Rust pairwise sim failed:', e.message || e);
                if (e.stack) console.error(e.stack);
                return null;
            }
        };

        if (leaseAlreadyHeld) return await run();
        return await this._withRustWriteLease('tagmemo:pairwise-sim', run, { pendingThreshold: 0 });
    }

    // 🌟 TagMemo V7/V9: 加载双语义内生残差
    loadIntrinsicResiduals(options = {}) {
        const { failOnCorruption = false } = options;

        const doLoad = () => {
            const rows = this.db.prepare(`
                SELECT
                    tag_id,
                    residual_energy,
                    raw_residual_ratio,
                    v9_anchor_gain,
                    model_sig,
                    artifact_sig,
                    algorithm_version,
                    config_hash
                FROM tag_intrinsic_residuals
            `).all();

            this.tagIntrinsicResiduals = new Map();
            this.tagRawResidualRatios = new Map();
            this.intrinsicResidualArtifact = null;

            for (const row of rows) {
                // Number(null) === 0，所有 nullable 派生列必须先检查非空，再做数值转换。
                const hasFiniteValue = value =>
                    value !== null && value !== undefined && Number.isFinite(Number(value));

                // 老数据库在首次 V9.1 全量重建前可能尚无 v9_anchor_gain；
                // residual_energy 仅作为一次性启动兼容值，重建后会被 V9.1 数值覆盖。
                const anchorValue = hasFiniteValue(row.v9_anchor_gain)
                    ? Number(row.v9_anchor_gain)
                    : Number(row.residual_energy);
                this.tagIntrinsicResiduals.set(
                    row.tag_id,
                    Math.max(0.5, Math.min(2.0, Number.isFinite(anchorValue) ? anchorValue : 1.0))
                );

                if (hasFiniteValue(row.raw_residual_ratio)) {
                    this.tagRawResidualRatios.set(
                        row.tag_id,
                        Math.max(0, Math.min(1, Number(row.raw_residual_ratio)))
                    );
                }

                if (!this.intrinsicResidualArtifact && row.artifact_sig) {
                    this.intrinsicResidualArtifact = {
                        artifactSig: row.artifact_sig,
                        modelSig: row.model_sig || this.modelSig,
                        algorithmVersion: row.algorithm_version || null,
                        configHash: row.config_hash || null
                    };
                }
            }

            return {
                v9Count: this.tagIntrinsicResiduals.size,
                rawCount: this.tagRawResidualRatios.size
            };
        };

        try {
            const counts = doLoad();
            console.log(
                `[TagMemoEngine] ✅ Loaded V9.1 intrinsic residuals: ` +
                `anchors=${counts.v9Count}, raw=${counts.rawCount}, ` +
                `artifact=${this.intrinsicResidualArtifact?.artifactSig || 'legacy'}`
            );
            return true;
        } catch (e) {
            this.tagIntrinsicResiduals = null;
            this.tagRawResidualRatios = null;
            this.intrinsicResidualArtifact = null;
            const isCorruption = this.knowledgeBaseManager?._isSqliteCorruptionError?.(e);

            if (failOnCorruption && isCorruption) {
                // 🛡️ P0: 同 pairwise，单次 malformed 先二阶段复检，通过后用健康连接重试一次加载。
                const recovered = this.knowledgeBaseManager.checkpointAndAssertDatabaseHealthy('loading intrinsic residuals');
                if (recovered) {
                    try {
                        const count = doLoad();
                        console.warn(`[TagMemoEngine] ♻️ Reloaded ${count} intrinsic residuals after suspect recovery.`);
                        return true;
                    } catch (retryErr) {
                        console.error('[TagMemoEngine] ❌ Intrinsic residual reload still failed after suspect recovery:', retryErr.message || retryErr);
                        this.tagIntrinsicResiduals = null;
                        this.tagRawResidualRatios = null;
                        this.intrinsicResidualArtifact = null;
                        throw retryErr;
                    }
                }
                throw e;
            }

            console.warn('[TagMemoEngine] ⚠️ No intrinsic residuals available:', e.message);
            return false;
        }
    }

    _getMatrixRebuildThreshold() {
        let threshold = 50;
        try {
            const totalTags = this.db.prepare('SELECT COUNT(*) as count FROM tags').get()?.count || 0;
            threshold = Math.max(10, Math.min(200, Math.floor(totalTags * 0.01)));
        } catch (e) { /* ignore */ }
        return threshold;
    }

    _scheduleThresholdMatrixRebuild(threshold, delayMs = this._getMatrixRebuildQuietMs(), reason = 'threshold') {
        if (this._shutdownRequested) return false;
        if (this._matrixRebuildTimer) {
            clearTimeout(this._matrixRebuildTimer);
        }

        this._matrixRebuildTimer = setTimeout(() => {
            console.log(`[TagMemoEngine] 📈 New unique tags reached threshold (${this._accumulatedNewTagIds.size} >= ${threshold}) and quiet period finished. Rebuilding matrix...`);
            this.doMatrixRebuild({ reason: 'threshold' }).catch(e => {
                console.error('[TagMemoEngine] ❌ Unhandled matrix rebuild failure from threshold timer:', e.message || e);
            });
        }, delayMs);

        if (this._matrixRebuildTimer.unref) this._matrixRebuildTimer.unref();

        if (!this._matrixRebuildScheduleLogged) {
            console.log(`[TagMemoEngine] 🛡️ Matrix rebuild ${reason}: newUniqueTags=${this._accumulatedNewTagIds.size} >= ${threshold}. Scheduled after ${Math.round(delayMs / 1000)}s of quiescence.`);
            this._matrixRebuildScheduleLogged = true;
        }
        return true;
    }

    _ensureMatrixRebuildScheduledIfThreshold(reason = 'threshold') {
        const threshold = this._getMatrixRebuildThreshold();

        // 仅在唯一新增 tag 达到阈值后，才进入防抖逻辑（实现“大变动后的冷静期”）
        if (this._accumulatedNewTagIds.size >= threshold) {
            this._scheduleThresholdMatrixRebuild(threshold, this._getMatrixRebuildQuietMs(), reason);
            return true;
        }

        return false;
    }

    // 🌟 TagMemo V8.3: 以唯一新增 tag Set 作为 1% 阈值依据
    scheduleMatrixRebuildForNewTags(newTagIds = []) {
        if (!Array.isArray(newTagIds) || newTagIds.length === 0) return;

        let added = 0;
        for (const id of newTagIds) {
            const numericId = Number(id);
            if (!Number.isFinite(numericId) || numericId <= 0) continue;
            const before = this._accumulatedNewTagIds.size;
            this._accumulatedNewTagIds.add(numericId);
            if (this._accumulatedNewTagIds.size > before) added++;
        }

        if (added <= 0) return;
        this._accumulatedTagChanges = this._accumulatedNewTagIds.size; // legacy 诊断镜像
        this._ensureMatrixRebuildScheduledIfThreshold('new unique tag threshold reached');
        // 低于阈值时不执行任何操作，不计入倒计时。
    }

    // 🌟 Legacy 兼容入口：旧的 file_tags 关系数不再驱动 1% 阈值。
    scheduleMatrixRebuild(changeCount = 1) {
        if (changeCount > 0) {
            console.log(`[TagMemoEngine] 🛡️ Ignored legacy relation-count matrix rebuild signal (${changeCount}); V9.1 threshold uses unique new tag ids.`);
        }
    }

    /**
     * 全量训练成功后的单轨收尾。
     *
     * 物理列保留以兼容旧 SQLite 文件，但清空 V8.3 数值，并只保留当前模型最新的
     * V9.1 intrinsic/pairwise artifact 与对应状态。调用方必须已持有 Rust 写租约。
     */
    _cleanupRetiredV83DerivedAssets() {
        const currentIntrinsicSig = this.intrinsicResidualArtifact?.artifactSig || null;
        const latestPairwise = this.db.prepare(`
            SELECT artifact_sig
            FROM tagmemo_artifacts
            WHERE asset_type = 'pairwise_similarity'
              AND model_sig = ?
              AND status = 'ready'
            ORDER BY updated_at DESC
            LIMIT 1
        `).get(this.modelSig);
        const currentPairwiseSig = latestPairwise?.artifact_sig || null;

        const cleanup = this.db.transaction(() => {
            let intrinsicStatuses = 0;
            let pairwiseStatuses = 0;
            let artifacts = 0;

            if (currentIntrinsicSig) {
                intrinsicStatuses = this.db.prepare(
                    'DELETE FROM tag_intrinsic_residual_status WHERE artifact_sig != ?'
                ).run(currentIntrinsicSig).changes;
            } else {
                intrinsicStatuses = this.db.prepare(
                    'DELETE FROM tag_intrinsic_residual_status'
                ).run().changes;
            }

            if (currentPairwiseSig) {
                pairwiseStatuses = this.db.prepare(
                    'DELETE FROM tag_pair_similarity_status WHERE artifact_sig != ?'
                ).run(currentPairwiseSig).changes;
            } else {
                pairwiseStatuses = this.db.prepare(
                    'DELETE FROM tag_pair_similarity_status'
                ).run().changes;
            }

            const retained = [currentIntrinsicSig, currentPairwiseSig].filter(Boolean);
            if (retained.length > 0) {
                const placeholders = retained.map(() => '?').join(',');
                artifacts = this.db.prepare(
                    `DELETE FROM tagmemo_artifacts WHERE artifact_sig NOT IN (${placeholders})`
                ).run(...retained).changes;
            } else {
                artifacts = this.db.prepare('DELETE FROM tagmemo_artifacts').run().changes;
            }

            const compatValues = this.db.prepare(`
                UPDATE tag_intrinsic_residuals
                SET v8_3_compat_gain = NULL
                WHERE v8_3_compat_gain IS NOT NULL
            `).run().changes;

            return { intrinsicStatuses, pairwiseStatuses, artifacts, compatValues };
        });

        const result = cleanup();
        console.log(
            `[TagMemoEngine] 🧹 V9.1 single-track cleanup complete: ` +
            `retiredArtifacts=${result.artifacts}, intrinsicStatuses=${result.intrinsicStatuses}, ` +
            `pairwiseStatuses=${result.pairwiseStatuses}, v8.3CompatValues=${result.compatValues}.`
        );
        return result;
    }

    requestActiveFullTraining(options = {}) {
        const reason = options.reason || 'admin-active-full-training';
        const previousPendingNewTags = this._accumulatedNewTagIds.size;

        if (this._matrixRebuildTimer) {
            clearTimeout(this._matrixRebuildTimer);
            this._matrixRebuildTimer = null;
        }

        // 主动训练相当于手动消费“1% 阈值窗口”：按钮使用后立即清零累计计数，
        // 避免训练完成后又被旧的防抖窗口重复触发。
        this._accumulatedNewTagIds.clear();
        this._accumulatedTagChanges = 0;
        this._matrixRebuildScheduleLogged = false;

        const taskId = this._enqueueDerivedTask('active-full-training', async () => {
            return await this.doMatrixRebuild({
                reason,
                fullRebuildPairwise: true,
                forceIntrinsicResiduals: true,
                preservePendingOnFailure: false,
                allowDuringStartupCooldown: true
            });
        }, { maxAttempts: options.maxAttempts ?? 1 });

        if (!taskId) {
            return {
                taskId: null,
                queued: false,
                reason,
                resetPendingNewTags: previousPendingNewTags,
                threshold: this._getMatrixRebuildThreshold(),
                error: 'TagMemoEngine is shutting down'
            };
        }

        console.log(
            `[TagMemoEngine] 🧠 Active full self-training requested. ` +
            `taskId=${taskId}, resetPendingNewTags=${previousPendingNewTags}, reason=${reason}`
        );

        return {
            taskId,
            queued: true,
            reason,
            resetPendingNewTags: previousPendingNewTags,
            threshold: this._getMatrixRebuildThreshold()
        };
    }

    async doMatrixRebuild(options = {}) {
        const rebuildReason = options.reason || 'manual';
        const preservePendingOnFailure = options.preservePendingOnFailure !== false;
        const fullRebuildPairwise = options.fullRebuildPairwise === true;
        const forceIntrinsicResiduals = options.forceIntrinsicResiduals === true;
        const cleanupRetiredV83Assets = options.cleanupRetiredV83Assets === true
            || (fullRebuildPairwise && forceIntrinsicResiduals);
        if (this._shutdownRequested) {
            console.warn('[TagMemoEngine] Matrix rebuild refused because shutdown is in progress.');
            return false;
        }
        if (this._isMatrixRebuilding) {
            console.warn('[TagMemoEngine] Matrix rebuild already running; keeping accumulated new tags for next debounce window.');
            if (!this._matrixRebuildTimer && this._accumulatedNewTagIds.size > 0) {
                this._scheduleMatrixRebuildTimer(this._getMatrixRebuildQuietMs(), 'follow-up-threshold');
            }
            return false;
        }

        const newTagIdsAtStart = new Set(this._accumulatedNewTagIds);
        const changesAtStart = newTagIdsAtStart.size;
        this._accumulatedNewTagIds.clear();
        this._accumulatedTagChanges = 0;
        this._matrixRebuildTimer = null;
        this._matrixRebuildScheduleLogged = false;
        this._isMatrixRebuilding = true;

        try {
            const rebuilt = await this._withRustWriteLease('tagmemo:matrix-rebuild', async () => {
                // V9.1 单轨顺序：sim 预计算 → 健康屏障/加载 → intrinsic residual
                // 预计算/屏障/加载 → 构建并原子发布 V9.1 kernel → 清理退休资产。
                const pairResult = await this.recomputePairwiseSimilarities({ blocking: true, leaseAlreadyHeld: true, fullRebuild: fullRebuildPairwise });
                if (!pairResult) return false;
                // 🛡️ P0: Rust 写后先 checkpoint + 健康屏障（含 suspect 重开），再用健康连接读取派生表，
                // 避免跨连接 WAL/SHM 瞬态视图触发读端 malformed。屏障失败即中止本轮，不继续后续阶段。
                if (!this._assertHealthyAfterRustWrite('pairwise-sim load barrier')) return false;
                this.loadPairwiseSimilarities({ failOnCorruption: true });

                const isThresholdRebuild = rebuildReason === 'threshold' || rebuildReason === 'follow-up-threshold';
                const shouldRecomputeIntrinsicResiduals = forceIntrinsicResiduals
                    || this._isIntrinsicResidualRecomputeEnabled()
                    || (isThresholdRebuild && this._isIntrinsicResidualThresholdRecomputeEnabled());

                if (shouldRecomputeIntrinsicResiduals) {
                    if (forceIntrinsicResiduals) {
                        console.log('[TagMemoEngine] 🔁 Intrinsic residual recompute forced by active full training request.');
                    } else if (isThresholdRebuild && !this._isIntrinsicResidualRecomputeEnabled()) {
                        console.log('[TagMemoEngine] 🔁 Intrinsic residual recompute enabled for threshold matrix rebuild: TAGMEMO_IR_RECOMPUTE_ON_THRESHOLD=true.');
                    }
                    const intrinsicResult = await this.recomputeIntrinsicResiduals({ leaseAlreadyHeld: true });
                    if (!intrinsicResult) return false;
                    if (!this._assertHealthyAfterRustWrite('intrinsic-residuals load barrier')) return false;
                    this.loadIntrinsicResiduals({ failOnCorruption: true });
                } else {
                    const skipReason = isThresholdRebuild
                        ? 'TAGMEMO_IR_RECOMPUTE_ON_THRESHOLD=false and TAGMEMO_INTRINSIC_RESIDUAL_FORCE_RECOMPUTE=false'
                        : 'TAGMEMO_INTRINSIC_RESIDUAL_FORCE_RECOMPUTE=false';
                    console.log(`[TagMemoEngine] 🛡️ Intrinsic residual hot recompute skipped: ${skipReason}. Loading existing residual cache only.`);
                    this.loadIntrinsicResiduals({ failOnCorruption: true });
                }

                const publishedRegistry = this.buildDirectedCooccurrenceMatrix();
                if (!publishedRegistry?.bundles?.v9) return false;
                if (cleanupRetiredV83Assets) {
                    this._cleanupRetiredV83DerivedAssets();
                }
                return true;
            }, {
                pendingThreshold: 0,
                allowDuringStartupCooldown: options.allowDuringStartupCooldown === true,
                // pairwise 与 intrinsic 阶段已各自在读取前完成专用 Rust 写后屏障。
                skipFinalHealthCheck: true
            });

            if (!rebuilt) {
                if (preservePendingOnFailure) {
                    for (const id of newTagIdsAtStart) this._accumulatedNewTagIds.add(id);
                    this._accumulatedTagChanges = this._accumulatedNewTagIds.size;
                    this._scheduleMatrixRebuildTimer(this._getMatrixRebuildQuietMs(), rebuildReason);
                }
                return false;
            }
            return true;
        } catch (e) {
            console.error(
                `[TagMemoEngine] ❌ Matrix rebuild failed${preservePendingOnFailure ? '; preserving accumulated changes and scheduling retry' : ''}:`,
                e.message || e
            );
            if (e.stack) console.error(e.stack);
            if (preservePendingOnFailure) {
                for (const id of newTagIdsAtStart) this._accumulatedNewTagIds.add(id);
                this._accumulatedTagChanges = this._accumulatedNewTagIds.size;
                this._scheduleMatrixRebuildTimer(this._getMatrixRebuildQuietMs(), rebuildReason);
            }
            return false;
        } finally {
            this._isMatrixRebuilding = false;
            if (!this._shutdownRequested && this._accumulatedNewTagIds.size > 0) {
                this._accumulatedTagChanges = this._accumulatedNewTagIds.size;
                console.log(`[TagMemoEngine] 🔁 ${this._accumulatedNewTagIds.size} new unique tag(s) pending after rebuild attempt; scheduling follow-up debounce.`);
                this._scheduleMatrixRebuildTimer(this._getMatrixRebuildQuietMs(), 'follow-up-threshold');
            }
            console.log(`[TagMemoEngine] Matrix rebuild finished for ${changesAtStart} accumulated new unique tag(s).`);
        }
    }

    _scheduleMatrixRebuildTimer(delayMs, reason = 'follow-up-threshold') {
        if (this._shutdownRequested) return false;
        if (this._matrixRebuildTimer) {
            clearTimeout(this._matrixRebuildTimer);
        }

        this._matrixRebuildScheduleLogged = true;
        this._matrixRebuildTimer = setTimeout(() => {
            console.log(`[TagMemoEngine] 📈 Follow-up quiet period finished. Rebuilding matrix for ${this._accumulatedNewTagIds.size} accumulated new unique tag(s)...`);
            this.doMatrixRebuild({ reason }).catch(e => {
                console.error('[TagMemoEngine] ❌ Unhandled matrix rebuild failure from follow-up timer:', e.message || e);
            });
        }, delayMs);

        if (this._matrixRebuildTimer.unref) this._matrixRebuildTimer.unref();
        return true;
    }

    _buildIntrinsicResidualConfigSnapshot() {
        const raw = this.ragParams?.KnowledgeBaseManager?.intrinsicResidual || {};
        const finiteOr = (value, fallback, min, max) => {
            if (value === null || value === undefined || !Number.isFinite(Number(value))) {
                return fallback;
            }
            return Math.max(min, Math.min(max, Number(value)));
        };
        const integerOr = (value, fallback, min, max) =>
            Math.floor(finiteOr(value, fallback, min, max));
        const boolOr = (value, fallback) => {
            if (value === null || value === undefined) return fallback;
            if (typeof value === 'boolean') return value;
            if (typeof value === 'number') return value !== 0;
            const normalized = String(value).trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
            if (['false', '0', 'no', 'off'].includes(normalized)) return false;
            return fallback;
        };

        const methodRaw = String(raw.method ?? 'anchored_gs').trim().toLowerCase();
        const method = ['anchored_gs', 'centroid', 'svd'].includes(methodRaw)
            ? methodRaw
            : 'anchored_gs';

        return {
            method,
            maxNeighbors: integerOr(raw.maxNeighbors, 48, 4, 256),
            maxBasis: integerOr(raw.maxBasis, 4, 1, 32),
            minNeighbors: integerOr(raw.minNeighbors, 3, 1, 64),
            semanticEnabled: boolOr(raw.semanticEnabled, true),
            semanticPeak: finiteOr(raw.semanticPeak, 0.65, -1, 1),
            semanticSigma: finiteOr(raw.semanticSigma, 0.25, 0.02, 2),
            semanticFloor: finiteOr(raw.semanticFloor, 0.35, 0, 1),
            semanticHardFloor: finiteOr(raw.semanticHardFloor, -1, -1, 1),
            minGain: finiteOr(raw.minGain, 0.015, 0, 1),
            positionDecay: finiteOr(raw.positionDecay, 0.15, 0, 4),
            v9AnchorBase: finiteOr(raw.v9AnchorBase, 0.75, 0, 4),
            v9AnchorScale: finiteOr(raw.v9AnchorScale, 1.25, 0, 4),
            v9AnchorGamma: finiteOr(raw.v9AnchorGamma, 1.0, 0.1, 8),
            v9AnchorMin: finiteOr(raw.v9AnchorMin, 0.5, 0, 4),
            v9AnchorMax: finiteOr(raw.v9AnchorMax, 2.0, 0, 8)
        };
    }

    _validateIntrinsicResidualEffectiveConfig(expected, result) {
        if (!result?.effectiveConfig) {
            console.warn('[TagMemoEngine] ⚠️ Rust residual result did not return effectiveConfig; native binary may be stale.');
            return false;
        }

        try {
            const actual = JSON.parse(result.effectiveConfig);
            const keys = [
                'method', 'maxNeighbors', 'maxBasis', 'minNeighbors',
                'semanticEnabled', 'semanticPeak', 'semanticSigma',
                'semanticFloor', 'semanticHardFloor', 'minGain',
                'positionDecay', 'v9AnchorBase', 'v9AnchorScale',
                'v9AnchorGamma', 'v9AnchorMin', 'v9AnchorMax'
            ];
            const mismatches = keys.filter(key => actual[key] !== expected[key]);
            if (mismatches.length > 0) {
                console.error(
                    `[TagMemoEngine] ❌ Rust residual effective config mismatch: ${mismatches.join(', ')}`
                );
                return false;
            }
            return true;
        } catch (e) {
            console.error('[TagMemoEngine] ❌ Failed to parse Rust residual effectiveConfig:', e.message);
            return false;
        }
    }

    // 🌟 TagMemo V7/V9: 触发 Rust 预计算内生残差
    async recomputeIntrinsicResiduals(opts = {}) {
        const { leaseAlreadyHeld = false } = opts;
        if (!this.tagIndex || !this.tagIndex.computeIntrinsicResiduals) {
            console.warn('[TagMemoEngine] computeIntrinsicResiduals is not available in VexusIndex');
            return;
        }

        const run = async () => {
            const effectiveConfig = this._buildIntrinsicResidualConfigSnapshot();
            const effectiveConfigJson = JSON.stringify(effectiveConfig);
            console.log(
                `[TagMemoEngine] ⚡ Triggering Rust intrinsic residual precomputation ` +
                `(config=${effectiveConfigJson}, model_sig=${this.modelSig})...`
            );
            try {
                const dbPath = path.join(path.dirname(this.db.name), 'knowledge_base.sqlite');
                const result = await this.tagIndex.computeIntrinsicResiduals(
                    dbPath,
                    effectiveConfig.maxBasis,
                    effectiveConfig.minNeighbors,
                    this.modelSig,
                    effectiveConfigJson
                );
                if (!result) return null;
                const configVerified = this._validateIntrinsicResidualEffectiveConfig(effectiveConfig, result);
                if (!configVerified) {
                    console.error('[TagMemoEngine] ❌ Refusing residual artifact with unverified effective configuration.');
                    return null;
                }
                console.log(
                    `[TagMemoEngine] ✅ Rust precomputation complete: ` +
                    `${result.computedCount} computed, ${result.skippedCount} skipped, ` +
                    `algorithm=${result.algorithmVersion}, artifact=${result.artifactSig}, ` +
                    `elapsed=${result.elapsedMs.toFixed(2)}ms`
                );

                return result;
            } catch (e) {
                console.error('[TagMemoEngine] ❌ Rust precomputation failed:', e.message || e);
                if (e.stack) console.error(e.stack);
                return null;
            }
        };

        if (leaseAlreadyHeld) return await run();

        // 独立调用仍完整执行“Rust 计算 → 新连接健康屏障 → 单次加载”；
        // 复合矩阵流水线则由调用方在阶段边界执行同一序列。
        return await this._withRustWriteLease('tagmemo:intrinsic-residuals', async () => {
            const result = await run();
            if (!result) return null;
            if (!this._assertHealthyAfterRustWrite('intrinsic-residuals load barrier')) return null;
            this.loadIntrinsicResiduals({ failOnCorruption: true });
            return result;
        }, {
            pendingThreshold: 0,
            skipFinalHealthCheck: true
        });
    }

    schedulePostStartupDerivedRefresh(delayMs = 300000) {
        if (this._shutdownRequested) return false;
        if (this._postStartupDerivedRefreshTimer) {
            clearTimeout(this._postStartupDerivedRefreshTimer);
        }

        this._postStartupDerivedRefreshTimer = setTimeout(() => {
            this._postStartupDerivedRefreshTimer = null;
            console.log('[TagMemoEngine] 🌙 Post-startup derived refresh window opened.');

            const skipDecision = this._shouldSkipPostStartupDerivedRefresh();
            if (skipDecision.skip) {
                console.log(
                    '[TagMemoEngine] 🛡️ Post-startup derived refresh skipped: warm EPA/pairwise/IR/matrix caches are already loaded, ' +
                    'EPA/IR hot recompute switches are false, and no tag changes accumulated.'
                );
                return;
            }

            if (this._isEpaBackgroundRecomputeEnabled()) {
                this._enqueueDerivedTask('epa-basis', async () => {
                    if (this.epa && typeof this.epa.refreshInBackground === 'function') {
                        return await this.epa.refreshInBackground();
                    }
                    return false;
                });
            } else {
                console.log('[TagMemoEngine] 🛡️ EPA background hot recompute skipped: KNOWLEDGEBASE_EPA_BACKGROUND_RECOMPUTE=false.');
            }

            const forceBootstrapMatrixRebuild = !skipDecision.pairwiseReady || !skipDecision.matrixReady;
            const forceFullDerivedRefresh = this._isEpaBackgroundRecomputeEnabled() && this._isIntrinsicResidualRecomputeEnabled();
            if (forceBootstrapMatrixRebuild || forceFullDerivedRefresh) {
                if (forceFullDerivedRefresh) {
                    console.log(
                        '[TagMemoEngine] 🔥 Full derived refresh requested: ' +
                        'KNOWLEDGEBASE_EPA_BACKGROUND_RECOMPUTE=true and TAGMEMO_INTRINSIC_RESIDUAL_FORCE_RECOMPUTE=true. ' +
                        'Matrix/IR pipeline will run after startup cooldown.'
                    );
                } else {
                    console.log(
                        '[TagMemoEngine] 🧊 Post-startup matrix bootstrap required: ' +
                        `pairwiseReady=${skipDecision.pairwiseReady}, matrixReady=${skipDecision.matrixReady}.`
                    );
                }
                this._enqueueDerivedTask('matrix-rebuild', async () => {
                    return await this.doMatrixRebuild({
                        reason: forceFullDerivedRefresh ? 'startup-full-derived-refresh' : 'startup-bootstrap'
                    });
                });
            } else if (this._accumulatedNewTagIds.size > 0) {
                const scheduled = this._ensureMatrixRebuildScheduledIfThreshold('post-startup accumulated new unique tags');
                if (!scheduled) {
                    const threshold = this._getMatrixRebuildThreshold();
                    console.log(
                        `[TagMemoEngine] 🛡️ Post-startup matrix rebuild delegated to threshold scheduler: ` +
                        `${this._accumulatedNewTagIds.size}/${threshold} accumulated new unique tag(s); below threshold, no rebuild scheduled.`
                    );
                }
            }
        }, Math.max(0, delayMs));

        if (this._postStartupDerivedRefreshTimer.unref) this._postStartupDerivedRefreshTimer.unref();
        console.log(`[TagMemoEngine] 🕒 Post-startup derived refresh scheduled after ${Math.round(delayMs / 1000)}s.`);
        return true;
    }

    _enqueueDerivedTask(type, run, options = {}) {
        if (this._shutdownRequested) {
            console.warn(`[TagMemoEngine] Ignored derived task "${type}" because shutdown is in progress.`);
            return null;
        }
        const existing = this._derivedTaskQueue.find(task => task.type === type && task.status === 'queued');
        if (existing) {
            existing.run = run;
            existing.updatedAt = Date.now();
            return existing.id;
        }

        const task = {
            id: `${type}-${Date.now()}-${++this._derivedTaskSeq}`,
            type,
            run,
            status: 'queued',
            attempts: 0,
            maxAttempts: options.maxAttempts ?? 3,
            nextAttemptAt: 0,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        this._derivedTaskQueue.push(task);
        this._scheduleDerivedTaskPump(0);
        return task.id;
    }

    _scheduleDerivedTaskPump(delayMs = 1000) {
        if (this._shutdownRequested) return;
        if (this._derivedTaskTimer) clearTimeout(this._derivedTaskTimer);
        this._derivedTaskTimer = setTimeout(() => {
            this._derivedTaskTimer = null;
            if (!this._shutdownRequested) this._processDerivedTaskQueue();
        }, Math.max(0, delayMs));
        if (this._derivedTaskTimer.unref) this._derivedTaskTimer.unref();
    }

    _getDerivedTaskBlockReason() {
        const kb = this.knowledgeBaseManager;
        if (!kb) return null;
        if (kb.databaseCorruptionDetected || kb.dbHealthState === 'corrupt') return 'database-corruption';
        if (kb.dbHealthState && kb.dbHealthState !== 'healthy') return `database-${kb.dbHealthState}`;
        if (kb.rustWriteLease) return `rust-lease-active:${kb.rustWriteLease.owner}`;
        if (kb.isProcessing) return 'js-batch-processing';
        if (kb.isProcessingDeletes) return 'js-delete-processing';
        if (kb.pendingDeletes?.size > 0) return `pending-deletes:${kb.pendingDeletes.size}`;
        if (kb.pendingFiles?.size > 0) return `pending-files:${kb.pendingFiles.size}`;
        return null;
    }

    async _processDerivedTaskQueue() {
        if (this._shutdownRequested || this._derivedTaskRunning) return;
        const now = Date.now();
        const queuedTasks = this._derivedTaskQueue.filter(item => item.status === 'queued');
        if (queuedTasks.length === 0) return;

        const task = queuedTasks.find(item => (item.nextAttemptAt || 0) <= now);
        if (!task) {
            const nextAttemptAt = Math.min(...queuedTasks.map(item => item.nextAttemptAt || now));
            this._scheduleDerivedTaskPump(Math.max(1, nextAttemptAt - now));
            return;
        }

        const blockReason = this._getDerivedTaskBlockReason();
        if (blockReason) {
            console.log(`[TagMemoEngine] 🕒 Derived task queue waiting: ${blockReason}. queued=${this._derivedTaskQueue.length}`);
            this._scheduleDerivedTaskPump(30000);
            return;
        }

        this._derivedTaskRunning = true;
        task.status = 'running';
        task.attempts++;
        task.nextAttemptAt = 0;
        task.updatedAt = Date.now();

        try {
            console.log(`[TagMemoEngine] ▶️ Derived task started: ${task.type} (${task.id})`);
            const ok = await task.run();
            if (ok === false || ok === null) {
                throw new Error(`derived task returned ${ok}`);
            }
            task.status = 'done';
            task.updatedAt = Date.now();
            this._derivedTaskQueue = this._derivedTaskQueue.filter(item => item.id !== task.id);
            console.log(`[TagMemoEngine] ✅ Derived task finished: ${task.type} (${task.id})`);
        } catch (e) {
            task.updatedAt = Date.now();
            if (task.attempts >= task.maxAttempts) {
                task.status = 'failed';
                console.warn(`[TagMemoEngine] ⚠️ Derived task failed permanently: ${task.type} (${task.id}): ${e.message || e}`);
                this._derivedTaskQueue = this._derivedTaskQueue.filter(item => item.id !== task.id);
            } else {
                task.status = 'queued';
                const backoffMs = Math.min(15 * 60 * 1000, 60000 * task.attempts);
                task.nextAttemptAt = Date.now() + backoffMs;
                console.warn(`[TagMemoEngine] ⚠️ Derived task failed, will retry in ${Math.round(backoffMs / 1000)}s: ${task.type} (${task.id}): ${e.message || e}`);
            }
        } finally {
            this._derivedTaskRunning = false;
            if (!this._shutdownRequested) {
                const queued = this._derivedTaskQueue.filter(item => item.status === 'queued');
                if (queued.length > 0) {
                    const now = Date.now();
                    const nextAttemptAt = Math.min(...queued.map(item => item.nextAttemptAt || now + 1000));
                    this._scheduleDerivedTaskPump(Math.max(1, nextAttemptAt - now));
                }
            }
        }
    }

    async shutdown(options = {}) {
        if (this._shutdownRequested) return;
        this._shutdownRequested = true;

        for (const timerName of [
            '_matrixRebuildTimer',
            '_postStartupDerivedRefreshTimer',
            '_derivedTaskTimer'
        ]) {
            if (this[timerName]) {
                clearTimeout(this[timerName]);
                this[timerName] = null;
            }
        }

        // queued 任务尚未持有任何资源，关闭时直接取消；running 任务等待其安全释放租约。
        this._derivedTaskQueue = this._derivedTaskQueue.filter(task => task.status === 'running');
        const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30 * 60 * 1000);
        const startedAt = Date.now();
        while (this._derivedTaskRunning && Date.now() - startedAt < timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (this._derivedTaskRunning) {
            console.warn(`[TagMemoEngine] ⚠️ Shutdown timed out after ${timeoutMs}ms while a derived task was still running.`);
        } else {
            this._derivedTaskQueue = [];
        }
    }
}

module.exports = TagMemoEngine;