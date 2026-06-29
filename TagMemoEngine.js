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
        this.tagIntrinsicResiduals = null;

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

    /**
     * 🌟 TagMemo 浪潮 + EPA + Residual Pyramid + Worldview Gating + LIF Spike Propagation (V6)
     *
     * 返回值中的 energyField 是查询级距离场。不要依赖 lastEnergyField 参与搜索重排：
     * lastEnergyField 只是兼容/诊断缓存，在全局搜索 await 间隙会被其他并发查询覆盖。
     */
    applyTagBoost(vector, baseTagBoost, coreTags = [], coreBoostFactor = 1.33) {
        const debug = false;
        const originalFloat32 = vector instanceof Float32Array ? vector : new Float32Array(vector);
        const dim = originalFloat32.length;

        try {
            // 🌟 V8: 清空旧距离场，防止跨调用数据泄露
            this.lastEnergyField = null;

            // [1] EPA 分析 (逻辑深度与共振) - 识别"你在哪个世界"
            const epaResult = this.epa.project(originalFloat32);
            const resonance = this.epa.detectCrossDomainResonance(originalFloat32);
            const queryWorld = epaResult.dominantAxes[0]?.label || 'Unknown';

            // [2] 残差金字塔分析 (新颖度与覆盖率) - 90% 能量截断
            const pyramid = this.residualPyramid.analyze(originalFloat32);
            const features = pyramid.features;

            // [3] 动态调整策略
            const config = this.ragParams?.KnowledgeBaseManager || {};
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
            if (allTags.length > 0 && this.tagCooccurrenceMatrix) {
                const srConfig = config.spikeRouting || {};
                const MAX_SAFE_HOPS = srConfig.maxSafeHops ?? 4;
                const BASE_MOMENTUM = srConfig.baseMomentum ?? 2.0;
                const FIRING_THRESHOLD = srConfig.firingThreshold ?? 0.10;
                const BASE_DECAY = srConfig.baseDecay ?? 0.25;
                const WORMHOLE_DECAY = srConfig.wormholeDecay ?? 0.70;
                const TENSION_THRESHOLD = srConfig.tensionThreshold ?? 1.0;
                const MAX_EMERGENT_NODES = srConfig.maxEmergentNodes ?? 50;
                const MAX_NEIGHBORS_PER_NODE = srConfig.maxNeighborsPerNode ?? 20;

                // 1. 初始注入：带有“动量(TTL)”的脉冲发射器
                let activeSpikes = new Map();      // id -> { energy, momentum }
                const accumulatedEnergy = new Map(); // id -> energySum 全局能量累加器
                
                allTags.forEach(t => {
                    activeSpikes.set(t.id, { energy: t.adjustedWeight, momentum: BASE_MOMENTUM });
                    accumulatedEnergy.set(t.id, t.adjustedWeight);
                });

                // 2. 迭代扩散网络 (基于动量与张力驱动)
                for (let hop = 0; hop < MAX_SAFE_HOPS; hop++) {
                    const nextSpikes = new Map();
                    let propagated = false;

                    for (const [nodeId, spike] of activeSpikes.entries()) {
                        if (spike.energy < FIRING_THRESHOLD || spike.momentum < 0) continue;

                        const synapses = this.tagCooccurrenceMatrix.get(nodeId);
                        if (!synapses) continue;

                        const sortedSynapses = Array.from(synapses.entries())
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, MAX_NEIGHBORS_PER_NODE);

                        for (const [neighborId, coocWeight] of sortedSynapses) {
                            // TagMemo V7: Wormhole Routing
                            // 张力 = 目标节点的残差新颖度 * 边权重
                            const neighborResidual = this.tagIntrinsicResiduals?.get(neighborId) ?? 1.0;
                            const tension = coocWeight * neighborResidual;
                            
                            // 虫洞判定
                            const isWormhole = tension >= TENSION_THRESHOLD;
                            
                            // 能量衰减与动量消耗策略
                            const decayFactor = isWormhole ? WORMHOLE_DECAY : BASE_DECAY;
                            const momentumCost = isWormhole ? 0 : 1.0; // 穿越虫洞豁免动量消耗

                            const injectedCurrent = spike.energy * coocWeight * decayFactor;
                            
                            if (injectedCurrent < 0.01) continue;
                            
                            const nextMomentum = spike.momentum - momentumCost;
                            if (nextMomentum < 0 && !isWormhole) continue; // 动量耗尽且非虫洞，则停止传播

                            // 聚合到达同一节点的脉冲
                            const existing = nextSpikes.get(neighborId);
                            if (existing) {
                                existing.energy += injectedCurrent;
                                existing.momentum = Math.max(existing.momentum, nextMomentum); // 继承最优动量
                            } else {
                                nextSpikes.set(neighborId, { energy: injectedCurrent, momentum: nextMomentum });
                            }
                        }
                    }

                    // 3. 将新一波激发的电流叠加到全局激活总图中
                    for (const [nid, newSpike] of nextSpikes.entries()) {
                        const currentSum = accumulatedEnergy.get(nid) || 0;
                        accumulatedEnergy.set(nid, currentSum + newSpike.energy);
                        if (newSpike.energy > 0.01) propagated = true;
                    }

                    if (!propagated) break;
                    
                    // 下一跳的火种
                    activeSpikes = nextSpikes;
                }

                // 🌟 V8: 缓存距离场（供 geodesicRerank 使用）
                this.lastEnergyField = accumulatedEnergy;

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

            if (allTags.length === 0) return { vector: originalFloat32, info: null, energyField: this.lastEnergyField };

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
                return { vector: originalFloat32, info: null, energyField: this.lastEnergyField };
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
                    epa: { logicDepth, entropy: entropyPenalty, resonance: resonance.resonance },
                    pyramid: { coverage: features.coverage, novelty: features.novelty, depth: features.depth }
                }
            };

        } catch (e) {
            console.error('[TagMemoEngine] TagMemo V6 CRITICAL FAIL:', e);
            return { vector: originalFloat32, info: null, energyField: null };
        }
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
     * 🌟 V8: 测地线重排 (Geodesic Rerank)
     * 复用 Spike Propagation 已计算的 accumulatedEnergy 距离场，
     * 对 KNN 候选 chunk 做基于"地形贴地距离"的二次重排。
     *
     * 三层防御链：
     *   L0: lastEnergyField 为空 → 整体退化（返回原数组）
     *   L1: chunk 的 hitCount < minGeoSamples → 该 chunk 的 geoScore = 0
     *   L2: 所有 chunk 的 maxGeo = 0 → 归一化跳过，全部走纯 KNN
     *
     * @param {Array<{id: BigInt|Number, score: Number}>} candidates - 原始 KNN 搜索结果
     * @param {object} options - 配置项
     * @param {number} [options.alpha] - 测地线分数混合权重 (0=纯KNN, 1=纯测地线)，默认读取 rag_params.json: KnowledgeBaseManager.geodesicRerank.alpha
     * @param {number} [options.minGeoSamples] - 最小采样密度门槛，默认读取 rag_params.json: KnowledgeBaseManager.geodesicRerank.minGeoSamples
     * @returns {Array} 重排后的完整数组（不截断）
     */
    geodesicRerank(candidates, options = {}) {
        let energyField = options.energyField;
        if (!energyField && options.allowLastEnergyFieldFallback === true) {
            energyField = this.lastEnergyField;
            console.warn('[TagMemoEngine] ⚠️ geodesicRerank using lastEnergyField fallback by explicit opt-in; prefer query-scoped options.energyField to avoid cross-query contamination.');
        }

        // L0: 距离场为空 → 整体退化
        if (!energyField || energyField.size === 0) {
            return candidates;
        }
        if (!candidates || candidates.length === 0) {
            return candidates;
        }

        const geoConfig = this.ragParams?.KnowledgeBaseManager?.geodesicRerank || {};
        const rawAlpha = options.alpha ?? geoConfig.alpha;
        const rawMinGeoSamples = options.minGeoSamples ?? geoConfig.minGeoSamples;

        if (!Number.isFinite(Number(rawAlpha)) || !Number.isFinite(Number(rawMinGeoSamples))) {
            console.warn('[TagMemoEngine] geodesicRerank missing valid alpha/minGeoSamples config; falling back to original order.');
            return candidates;
        }

        const alpha = Math.max(0, Math.min(1, Number(rawAlpha)));
        const minGeoSamples = Math.max(1, Math.floor(Number(rawMinGeoSamples)));

        try {
            // Step 1: 批量查询 chunk_id → file_id 映射（chunked IN，避免 SQLite 参数数量上限）
            const chunkIds = candidates.map(c => Number(c.id)).filter(Number.isFinite);
            const chunkFileRows = this._queryByChunks('SELECT id, file_id FROM chunks WHERE id', chunkIds);
            const chunkFileMap = new Map(chunkFileRows.map(r => [r.id, r.file_id]));

            // Step 2: 收集所有需要查询的 file_ids，批量查询 file_id → tag_id[] 映射
            const uniqueFileIds = [...new Set(chunkFileRows.map(r => r.file_id))];
            const fileTagsMap = new Map(); // file_id → [tag_id, ...]

            if (uniqueFileIds.length > 0) {
                const fileTagRows = this._queryByChunks(
                    'SELECT file_id, tag_id FROM file_tags WHERE file_id',
                    uniqueFileIds
                );

                for (const row of fileTagRows) {
                    if (!fileTagsMap.has(row.file_id)) {
                        fileTagsMap.set(row.file_id, []);
                    }
                    fileTagsMap.get(row.file_id).push(row.tag_id);
                }
            }

            // Step 3: 对每个候选计算 geoScore
            let maxGeo = 0;
            const geoData = candidates.map(c => {
                const chunkId = Number(c.id);
                const fileId = chunkFileMap.get(chunkId);
                if (fileId === undefined) {
                    return { candidate: c, geoScore: 0, hitCount: 0, totalEnergy: 0 };
                }

                const tagIds = fileTagsMap.get(fileId) || [];
                let totalEnergy = 0;
                let hitCount = 0;

                for (const tid of tagIds) {
                    const energy = energyField.get(tid);
                    if (energy !== undefined) {
                        totalEnergy += energy;
                        hitCount++;
                    }
                }

                // L1: 最小采样密度门槛
                const geoScore = hitCount >= minGeoSamples
                    ? totalEnergy / hitCount
                    : 0; // 密度不足 → 放弃测地线评估，退化为纯 KNN

                if (geoScore > maxGeo) maxGeo = geoScore;

                return { candidate: c, geoScore, hitCount, totalEnergy };
            });

            // L2: 所有 chunk 的 maxGeo = 0 → 归一化跳过，全部走纯 KNN 排序
            if (maxGeo === 0) {
                return candidates;
            }

            // Step 4: 归一化并混合分数
            const reranked = geoData.map(d => {
                const normalizedGeo = d.geoScore / maxGeo; // [0, 1]
                const knnScore = d.candidate.score || 0;
                const finalScore = (1 - alpha) * knnScore + alpha * normalizedGeo;

                return {
                    ...d.candidate,
                    score: finalScore,
                    original_knn_score: knnScore,
                    geo_score: d.geoScore,
                    normalized_geo: normalizedGeo,
                    geo_hit_count: d.hitCount
                };
            });

            // Step 5: 按 finalScore 降序排列（只重排，不截断）
            reranked.sort((a, b) => b.score - a.score);

            console.log(`[TagMemo-V8 Geodesic] α=${alpha}, minSamples=${minGeoSamples}, candidates=${candidates.length}, maxGeo=${maxGeo.toFixed(4)}, reranked=${reranked.filter(r => r.geo_score > 0).length} with geo contribution`);

            return reranked;

        } catch (e) {
            console.error('[TagMemoEngine] geodesicRerank failed, falling back to original order:', e.message);
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

            this.tagCooccurrenceMatrix = matrix;

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
        } catch (e) {
            console.error('[TagMemoEngine] ❌ Failed to build V8.2 ordered-bidirectional matrix:', e);
            this.tagCooccurrenceMatrix = new Map();
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
        if (this.knowledgeBaseManager && typeof this.knowledgeBaseManager.checkpointAndAssertDatabaseHealthy === 'function') {
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
            const healthy = this._assertHealthyAfterRustWrite(owner);
            if (!healthy) {
                console.error(`[TagMemoEngine] 🚨 Database health check failed before releasing Rust write lease "${owner}".`);
                return null;
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

    // 🌟 TagMemo V7: 加载内生残差
    loadIntrinsicResiduals(options = {}) {
        const { failOnCorruption = false } = options;

        const doLoad = () => {
            const rows = this.db.prepare(
                'SELECT tag_id, residual_energy FROM tag_intrinsic_residuals'
            ).all();

            this.tagIntrinsicResiduals = new Map();
            for (const row of rows) {
                // 归一化到 [0.5, 2.0] 范围，避免极端值
                const clamped = Math.max(0.5, Math.min(2.0, row.residual_energy));
                this.tagIntrinsicResiduals.set(row.tag_id, clamped);
            }
            return this.tagIntrinsicResiduals.size;
        };

        try {
            const count = doLoad();
            console.log(`[TagMemoEngine] ✅ Loaded ${count} intrinsic residuals`);
            return true;
        } catch (e) {
            this.tagIntrinsicResiduals = null;
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
            console.log(`[TagMemoEngine] 🛡️ Ignored legacy relation-count matrix rebuild signal (${changeCount}); V8.3 threshold uses unique new tag ids.`);
        }
    }

    async doMatrixRebuild(options = {}) {
        const rebuildReason = options.reason || 'manual';
        if (this._isMatrixRebuilding) {
            console.warn('[TagMemoEngine] Matrix rebuild already running; keeping accumulated new tags for next debounce window.');
            if (!this._matrixRebuildTimer && this._accumulatedNewTagIds.size > 0) {
                this._scheduleMatrixRebuildTimer(this._getMatrixRebuildQuietMs(), 'follow-up-threshold');
            }
            return;
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
                // 🌟 V8.2-γ: 先补齐底座，再构建矩阵
                // 顺序：sim 预计算 → 屏障 → 加载 sim Map → 内生残差预计算/屏障/加载 → 构建 V8.2 双向矩阵
                const pairResult = await this.recomputePairwiseSimilarities({ blocking: true, leaseAlreadyHeld: true });
                if (!pairResult) return false;
                // 🛡️ P0: Rust 写后先 checkpoint + 健康屏障（含 suspect 重开），再用健康连接读取派生表，
                // 避免跨连接 WAL/SHM 瞬态视图触发读端 malformed。屏障失败即中止本轮，不继续后续阶段。
                if (!this._assertHealthyAfterRustWrite('pairwise-sim load barrier')) return false;
                this.loadPairwiseSimilarities({ failOnCorruption: true });

                const isThresholdRebuild = rebuildReason === 'threshold' || rebuildReason === 'follow-up-threshold';
                const shouldRecomputeIntrinsicResiduals = this._isIntrinsicResidualRecomputeEnabled()
                    || (isThresholdRebuild && this._isIntrinsicResidualThresholdRecomputeEnabled());

                if (shouldRecomputeIntrinsicResiduals) {
                    if (isThresholdRebuild && !this._isIntrinsicResidualRecomputeEnabled()) {
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

                this.buildDirectedCooccurrenceMatrix();
                return true;
            }, { pendingThreshold: 0 });

            if (!rebuilt) {
                for (const id of newTagIdsAtStart) this._accumulatedNewTagIds.add(id);
                this._accumulatedTagChanges = this._accumulatedNewTagIds.size;
                this._scheduleMatrixRebuildTimer(this._getMatrixRebuildQuietMs(), rebuildReason);
                return;
            }
        } catch (e) {
            console.error('[TagMemoEngine] ❌ Matrix rebuild failed; preserving accumulated changes and scheduling retry:', e.message || e);
            if (e.stack) console.error(e.stack);
            for (const id of newTagIdsAtStart) this._accumulatedNewTagIds.add(id);
            this._accumulatedTagChanges = this._accumulatedNewTagIds.size;
            this._scheduleMatrixRebuildTimer(this._getMatrixRebuildQuietMs(), rebuildReason);
        } finally {
            this._isMatrixRebuilding = false;
            if (this._accumulatedNewTagIds.size > 0) {
                this._accumulatedTagChanges = this._accumulatedNewTagIds.size;
                console.log(`[TagMemoEngine] 🔁 ${this._accumulatedNewTagIds.size} new unique tag(s) pending after rebuild attempt; scheduling follow-up debounce.`);
                this._scheduleMatrixRebuildTimer(this._getMatrixRebuildQuietMs(), 'follow-up-threshold');
            }
            console.log(`[TagMemoEngine] Matrix rebuild finished for ${changesAtStart} accumulated new unique tag(s).`);
        }
    }

    _scheduleMatrixRebuildTimer(delayMs, reason = 'follow-up-threshold') {
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
    }

    // 🌟 TagMemo V7: 触发 Rust 预计算内生残差
    async recomputeIntrinsicResiduals(opts = {}) {
        const { leaseAlreadyHeld = false } = opts;
        if (!this.tagIndex || !this.tagIndex.computeIntrinsicResiduals) {
            console.warn('[TagMemoEngine] computeIntrinsicResiduals is not available in VexusIndex');
            return;
        }

        const run = async () => {
            const irConfig = this.ragParams?.KnowledgeBaseManager?.intrinsicResidual || {};
            const maxBasis = Number.isFinite(Number(irConfig.maxBasis))
                ? Math.max(1, Math.floor(Number(irConfig.maxBasis)))
                : 4;
            const minNeighbors = Number.isFinite(Number(irConfig.minNeighbors))
                ? Math.max(1, Math.floor(Number(irConfig.minNeighbors)))
                : 3;
            const method = process.env.TAGMEMO_IR_METHOD || irConfig.method || 'anchored_gs';
            console.log(
                `[TagMemoEngine] ⚡ Triggering Rust intrinsic residual precomputation ` +
                `(method=${method}, maxBasis=${maxBasis}, minNeighbors=${minNeighbors}, model_sig=${this.modelSig})...`
            );
            try {
                const dbPath = path.join(path.dirname(this.db.name), 'knowledge_base.sqlite');
                const result = await this.tagIndex.computeIntrinsicResiduals(
                    dbPath,
                    maxBasis,
                    minNeighbors,
                    this.modelSig
                );
                if (!result) return null;
                console.log(`[TagMemoEngine] ✅ Rust precomputation complete: ${result.computedCount} computed, ${result.skippedCount} skipped in ${result.elapsedMs.toFixed(2)}ms`);

                // 🛡️ P0: Rust 写后先 checkpoint + 健康屏障，再读取，避免读端瞬态 malformed。
                if (!this._assertHealthyAfterRustWrite('intrinsic-residuals load barrier')) return null;
                // 重新加载结果
                this.loadIntrinsicResiduals({ failOnCorruption: true });
                return result;
            } catch (e) {
                console.error('[TagMemoEngine] ❌ Rust precomputation failed:', e.message || e);
                if (e.stack) console.error(e.stack);
                return null;
            }
        };

        if (leaseAlreadyHeld) return await run();
        return await this._withRustWriteLease('tagmemo:intrinsic-residuals', run, { pendingThreshold: 0 });
    }

    schedulePostStartupDerivedRefresh(delayMs = 300000) {
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
                    await this.doMatrixRebuild({ reason: forceFullDerivedRefresh ? 'startup-full-derived-refresh' : 'startup-bootstrap' });
                    return true;
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
    }

    _enqueueDerivedTask(type, run, options = {}) {
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
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        this._derivedTaskQueue.push(task);
        this._scheduleDerivedTaskPump(0);
        return task.id;
    }

    _scheduleDerivedTaskPump(delayMs = 1000) {
        if (this._derivedTaskTimer) clearTimeout(this._derivedTaskTimer);
        this._derivedTaskTimer = setTimeout(() => {
            this._derivedTaskTimer = null;
            this._processDerivedTaskQueue();
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
        if (this._derivedTaskRunning) return;
        const task = this._derivedTaskQueue.find(item => item.status === 'queued');
        if (!task) return;

        const blockReason = this._getDerivedTaskBlockReason();
        if (blockReason) {
            console.log(`[TagMemoEngine] 🕒 Derived task queue waiting: ${blockReason}. queued=${this._derivedTaskQueue.length}`);
            this._scheduleDerivedTaskPump(30000);
            return;
        }

        this._derivedTaskRunning = true;
        task.status = 'running';
        task.attempts++;
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
                console.warn(`[TagMemoEngine] ⚠️ Derived task failed, will retry in ${Math.round(backoffMs / 1000)}s: ${task.type} (${task.id}): ${e.message || e}`);
                this._scheduleDerivedTaskPump(backoffMs);
            }
        } finally {
            this._derivedTaskRunning = false;
            if (this._derivedTaskQueue.some(item => item.status === 'queued')) {
                this._scheduleDerivedTaskPump(this._derivedTaskTimer ? 30000 : 1000);
            }
        }
    }
}

module.exports = TagMemoEngine;