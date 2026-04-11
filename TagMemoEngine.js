// TagMemoEngine.js
// 🌟 浪潮算法独立模块 (TagMemo Engine)
// 包含：浪潮增强、EPA 投影、残差金字塔分析、有向共现矩阵、脉冲传播等核心逻辑

const path = require('path');
const EPAModule = require('./EPAModule');
const ResidualPyramid = require('./ResidualPyramid');

class TagMemoEngine {
    constructor(db, tagIndex, config, ragParams) {
        this.db = db;
        this.tagIndex = tagIndex;
        this.config = config;
        this.ragParams = ragParams;

        this.epa = null;
        this.residualPyramid = null;
        this.tagCooccurrenceMatrix = null;
        this.tagIntrinsicResiduals = null;

        // 🌟 TagMemo V7.1: 矩阵计算防抖系统
        this._accumulatedTagChanges = 0;
        this._matrixRebuildTimer = null;
        // 🌟 V8: 距离场缓存（供测地线重排使用）
        this.lastEnergyField = null;
    }

    async initialize() {
        // 初始化 EPA 和残差金字塔模块
        this.epa = new EPAModule(this.db, {
            dimension: this.config.dimension,
            vexusIndex: this.tagIndex,
            nodeResidual: this.ragParams.KnowledgeBaseManager?.nodeResidualGain || 0.05,
        });
        await this.epa.initialize();

        this.residualPyramid = new ResidualPyramid(this.tagIndex, this.db, {
            dimension: this.config.dimension
        });

        // 启动时构建共现矩阵
        this.buildDirectedCooccurrenceMatrix();
        // 加载内生残差
        this.loadIntrinsicResiduals();
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
                        const maxBaseWeight = allTags.length > 0 ? Math.max(...allTags.map(t => t.adjustedWeight / 1.33)) : 1.0;

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

            // [4.7] 🎈 注入幽灵节点 (暗度陈仓)
            let ghostIdCounter = -1; // 专属负数 ID
            const ghostVectorMap = new Map();
            // 获取当前基准权重
            const maxBaseWeight = allTags.length > 0 ? Math.max(...allTags.map(t => t.adjustedWeight / 1.33)) : 1.0;

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

            if (allTags.length === 0) return { vector: originalFloat32, info: null };

            // [5] 批量获取向量与名称 (性能优化：1次查询替代 N次循环查询)
            const dbTagIds = allTags.filter(t => t.id > 0).map(t => t.id);
            const tagRows = dbTagIds.length > 0
                ? this.db.prepare(`SELECT id, name, vector FROM tags WHERE id IN (${dbTagIds.map(() => '?').join(',')})`).all(...dbTagIds)
                : [];
            const tagDataMap = new Map(tagRows.map(r => [r.id, r]));

            // 🌟 终极闭环：把幽灵向量混入正规军的 Map 里！
            for (const [gid, ghostData] of ghostVectorMap.entries()) {
                tagDataMap.set(gid, ghostData);
            }

            // [5.5] 语义去重 (Semantic Deduplication)
            // 目的：消除冗余标签（如“委内瑞拉局势”与“委内瑞拉危机”），为多样性腾出空间
            const deduplicatedTags = [];
            const sortedTags = [...allTags].sort((a, b) => b.adjustedWeight - a.adjustedWeight);

            for (const tag of sortedTags) {
                const data = tagDataMap.get(tag.id);
                if (!data || !data.vector) continue;

                const vec = new Float32Array(data.vector.buffer, data.vector.byteOffset, dim);
                let isRedundant = false;

                for (const existing of deduplicatedTags) {
                    const existingData = tagDataMap.get(existing.id);
                    const existingVec = new Float32Array(existingData.vector.buffer, existingData.vector.byteOffset, dim);

                    // 计算余弦相似度
                    let dot = 0, normA = 0, normB = 0;
                    for (let d = 0; d < dim; d++) {
                        dot += vec[d] * existingVec[d];
                        normA += vec[d] * vec[d];
                        normB += existingVec[d] * existingVec[d];
                    }
                    const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));

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
                if (data && data.vector) {
                    const v = new Float32Array(data.vector.buffer, data.vector.byteOffset, dim);
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
                return { vector: originalFloat32, info: null };
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
            return { vector: originalFloat32, info: null };
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
     * @param {number} [options.alpha=0.3] - 测地线分数混合权重 (0=纯KNN, 1=纯测地线)
     * @param {number} [options.minGeoSamples=4] - 最小采样密度门槛
     * @returns {Array} 重排后的完整数组（不截断）
     */
    geodesicRerank(candidates, options = {}) {
        // L0: 距离场为空 → 整体退化
        if (!this.lastEnergyField || this.lastEnergyField.size === 0) {
            return candidates;
        }
        if (!candidates || candidates.length === 0) {
            return candidates;
        }

        const alpha = Math.max(0, Math.min(1, options.alpha ?? 0.3));
        const minGeoSamples = options.minGeoSamples ?? 4;

        try {
            // Step 1: 批量查询 chunk_id → file_id 映射（方案 A：自查映射）
            const chunkIds = candidates.map(c => Number(c.id));
            const chunkPlaceholders = chunkIds.map(() => '?').join(',');
            const chunkFileRows = this.db.prepare(
                `SELECT id, file_id FROM chunks WHERE id IN (${chunkPlaceholders})`
            ).all(...chunkIds);
            const chunkFileMap = new Map(chunkFileRows.map(r => [r.id, r.file_id]));

            // Step 2: 收集所有需要查询的 file_ids，批量查询 file_id → tag_id[] 映射
            const uniqueFileIds = [...new Set(chunkFileRows.map(r => r.file_id))];
            const fileTagsMap = new Map(); // file_id → [tag_id, ...]

            if (uniqueFileIds.length > 0) {
                const filePlaceholders = uniqueFileIds.map(() => '?').join(',');
                const fileTagRows = this.db.prepare(
                    `SELECT file_id, tag_id FROM file_tags WHERE file_id IN (${filePlaceholders})`
                ).all(...uniqueFileIds);

                for (const row of fileTagRows) {
                    if (!fileTagsMap.has(row.file_id)) {
                        fileTagsMap.set(row.file_id, []);
                    }
                    fileTagsMap.get(row.file_id).push(row.tag_id);
                }
            }

            // Step 3: 对每个候选计算 geoScore
            const energyField = this.lastEnergyField;
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

    // 🌟 TagMemo V7: 有向序位势能共现矩阵
    buildDirectedCooccurrenceMatrix() {
        console.log('[TagMemoEngine] 🧠 Building DIRECTED tag co-occurrence matrix...');
        try {
            // 势能参数
            const PHI_MAX = 0.9;
            const PHI_MIN = 0.5;

            // Step 1: 获取每篇日记的 Tag 数量（用于计算势能）
            const tagCountStmt = this.db.prepare(`
                SELECT file_id, COUNT(*) as tag_count
                FROM file_tags
                GROUP BY file_id
            `);
            const tagCounts = new Map();
            for (const row of tagCountStmt.iterate()) {
                tagCounts.set(row.file_id, row.tag_count);
            }

            // Step 2: 逐文件处理共现关系，规避 SQL Join 爆炸风险
            const stmt = this.db.prepare(`
                SELECT file_id, tag_id, position
                FROM file_tags
                WHERE position > 0
                ORDER BY file_id, position ASC
            `);

            const matrix = new Map();
            let currentFileId = -1;
            let fileTags = [];

            const processFileGroup = (tags, fid) => {
                const n = tags.length;
                if (n < 2 || n > 100) return; // 🛡️ 性能保护：跳过孤立点或超大脏文件

                for (let i = 0; i < n; i++) {
                    for (let j = i + 1; j < n; j++) {
                        const t1 = tags[i];
                        const t2 = tags[j];

                        // 计算序位势能 (基于 position 的衰减)
                        const phi1 = n > 1 ? PHI_MAX - (PHI_MAX - PHI_MIN) * (t1.pos - 1) / (n - 1) : PHI_MAX;
                        const phi2 = n > 1 ? PHI_MAX - (PHI_MAX - PHI_MIN) * (t2.pos - 1) / (n - 1) : PHI_MAX;
                        const weight = phi1 * phi2;

                        // 有向边：source → target (i < j 保证了顺序)
                        if (!matrix.has(t1.id)) matrix.set(t1.id, new Map());
                        const targetMap = matrix.get(t1.id);
                        targetMap.set(t2.id, (targetMap.get(t2.id) || 0) + weight);
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

            // Step 3: 处理旧数据（position = 0 的回退为无向等权重）
            const legacyStmt = this.db.prepare(`
                SELECT ft1.tag_id as tag1, ft2.tag_id as tag2, COUNT(ft1.file_id) as cnt
                FROM file_tags ft1
                JOIN file_tags ft2 
                    ON ft1.file_id = ft2.file_id 
                    AND ft1.tag_id < ft2.tag_id
                WHERE ft1.position = 0 OR ft2.position = 0
                GROUP BY ft1.tag_id, ft2.tag_id
            `);

            const LEGACY_PHI = 0.7; // 旧数据统一势能
            for (const row of legacyStmt.iterate()) {
                const weight = row.cnt * LEGACY_PHI * LEGACY_PHI;
                
                if (!matrix.has(row.tag1)) matrix.set(row.tag1, new Map());
                if (!matrix.has(row.tag2)) matrix.set(row.tag2, new Map());
                
                const e1 = matrix.get(row.tag1).get(row.tag2) || 0;
                matrix.get(row.tag1).set(row.tag2, e1 + weight);
                const e2 = matrix.get(row.tag2).get(row.tag1) || 0;
                matrix.get(row.tag2).set(row.tag1, e2 + weight);
            }

            this.tagCooccurrenceMatrix = matrix;
            console.log(`[TagMemoEngine] ✅ Directed co-occurrence matrix built. (${matrix.size} source nodes)`);
        } catch (e) {
            console.error('[TagMemoEngine] ❌ Failed to build directed matrix:', e);
            this.tagCooccurrenceMatrix = new Map();
        }
    }

    // 🌟 TagMemo V7: 加载内生残差
    loadIntrinsicResiduals() {
        try {
            const rows = this.db.prepare(
                'SELECT tag_id, residual_energy FROM tag_intrinsic_residuals'
            ).all();
            
            this.tagIntrinsicResiduals = new Map();
            for (const row of rows) {
                // 归一化到 [0.5, 2.0] 范围，避免极端值
                const clamped = Math.max(0.5, Math.min(2.0, row.residual_energy));
                this.tagIntrinsicResiduals.set(row.tag_id, clamped);
            }
            console.log(`[TagMemoEngine] ✅ Loaded ${this.tagIntrinsicResiduals.size} intrinsic residuals`);
        } catch (e) {
            console.warn('[TagMemoEngine] ⚠️ No intrinsic residuals available:', e.message);
            this.tagIntrinsicResiduals = null;
        }
    }

    // 🌟 TagMemo V7.7: 混合调度器 (阈值门槛 + 滑动窗口防抖)
    scheduleMatrixRebuild(changeCount = 1) {
        if (changeCount <= 0) return; 
        
        this._accumulatedTagChanges += changeCount;
        
        // 动态计算 1% 阈值
        let threshold = 50; 
        try {
            const totalTags = this.db.prepare('SELECT COUNT(*) as count FROM tags').get()?.count || 0;
            threshold = Math.max(10, Math.min(200, Math.floor(totalTags * 0.01)));
        } catch (e) { /* ignore */ }

        // 仅在达到阈值后，才进入防抖逻辑（实现“大变动后的冷静期”）
        if (this._accumulatedTagChanges >= threshold) {
            // 无论如何先清除旧计时器，实现“滑动窗口”防抖
            if (this._matrixRebuildTimer) {
                clearTimeout(this._matrixRebuildTimer);
            }

            // 设定 5 分钟（300,000ms）的冷却防抖
            const COOLING_DELAY = 300000; 
            this._matrixRebuildTimer = setTimeout(() => {
                console.log(`[TagMemoEngine] 📈 Changes reached threshold (${this._accumulatedTagChanges} >= ${threshold}) and quiet period finished. Rebuilding matrix...`);
                this.doMatrixRebuild();
            }, COOLING_DELAY);
            
            if (this._matrixRebuildTimer.unref) this._matrixRebuildTimer.unref();

            // 仅在第一次开启计时器时提示
            if (!this._matrixRebuildTimer._isLogged) {
                console.log(`[TagMemoEngine] 🛡️ Threshold reached. Matrix rebuild scheduled after 5min of quiescence.`);
                this._matrixRebuildTimer._isLogged = true;
            }
        }
        // 低于阈值时不执行任何操作，不计入倒计时。
    }

    async doMatrixRebuild() {
        this._accumulatedTagChanges = 0;
        this._matrixRebuildTimer = null;
        this.buildDirectedCooccurrenceMatrix();
        await this.recomputeIntrinsicResiduals();
    }

    // 🌟 TagMemo V7: 触发 Rust 预计算内生残差
    async recomputeIntrinsicResiduals() {
        if (!this.tagIndex || !this.tagIndex.computeIntrinsicResiduals) {
            console.warn('[TagMemoEngine] computeIntrinsicResiduals is not available in VexusIndex');
            return;
        }
        
        console.log('[TagMemoEngine] ⚡ Triggering Rust intrinsic residual precomputation...');
        try {
            const dbPath = path.join(path.dirname(this.db.name), 'knowledge_base.sqlite');
            const result = await this.tagIndex.computeIntrinsicResiduals(dbPath);
            console.log(`[TagMemoEngine] ✅ Rust precomputation complete: ${result.computedCount} computed, ${result.skippedCount} skipped in ${result.elapsedMs.toFixed(2)}ms`);
            
            // 重新加载结果
            this.loadIntrinsicResiduals();
        } catch (e) {
            console.error('[TagMemoEngine] ❌ Rust precomputation failed:', e.message || e);
            if (e.stack) console.error(e.stack);
        }
    }
}

module.exports = TagMemoEngine;