/**
 * ResultDeduplicator.js
 * Tagmemo v4 核心组件：基于 SVD 和残差金字塔的结果智能去重器
 * 
 * 功能：
 * 1. 分析结果集中的潜在主题 (Latent Topics)
 * 2. 使用残差投影选择最具代表性的结果
 * 3. 确保弱语义关联 (Weak Links) 不被丢弃
 */

const EPAModule = require('./EPAModule');
const ResidualPyramid = require('./ResidualPyramid');

class ResultDeduplicator {
    constructor(db, config = {}) {
        this.db = db;
        this.config = {
            dimension: config.dimension || 3072,
            maxResults: config.maxResults || 20, // 最终保留的最大结果数
            topicCount: config.topicCount || 8, // SVD 提取的主题数
            minEnergyRatio: 0.1, // 剩余能量阈值
            redundancyThreshold: 0.85, // 冗余阈值 (余弦相似度)
            ...config
        };

        // 复用现有的基础设施
        this.epa = new EPAModule(db, {
            dimension: this.config.dimension,
            maxBasisDim: this.config.topicCount,
            clusterCount: 16 // 针对结果集的小规模聚类
        });

        // 残差金字塔用于投影计算
        this.residualCalculator = new ResidualPyramid(null, db, {
            dimension: this.config.dimension
        });
    }

    /**
     * 对候选结果集进行去重和精选
     * @param {Array} candidates - 候选结果数组 [{ text, score, vector?, ... }]
     * @param {Object} queryVector - 原始查询向量 (Float32Array)
     */
    async deduplicate(candidates, queryVector) {
        if (!candidates || candidates.length === 0) return [];

        // 1. 预处理：过滤无向量的结果，确保 Float32Array
        const validCandidates = candidates.filter(c => c.vector || c._vector); // 兼容不同字段名
        if (validCandidates.length <= 5) return candidates; // 数量太少无需去重

        console.log(`[ResultDeduplicator] Starting deduplication for ${validCandidates.length} candidates...`);

        // 提取向量数组
        const vectors = validCandidates.map(c => {
            const v = c.vector || c._vector;
            return v instanceof Float32Array ? v : new Float32Array(v);
        });

        // 2. 这里的 SVD 分析不再依赖预训练的 Tag 簇，而是直接对本次的结果集进行分析
        // 临时构造一个 clusterData 结构给 EPAModule 用
        const clusterData = {
            vectors: vectors,
            weights: vectors.map(v => 1), // 等权重
            labels: validCandidates.map(c => 'candidate')
        };

        // 3. 计算加权 PCA (SVD) 以提取当前结果集的主题分布
        // 这能告诉我们，这些搜索结果主要在讨论哪几个方面
        const svdResult = this.epa._computeWeightedPCA(clusterData);
        const { U: topics, S: energies } = svdResult;

        // 过滤掉能量极弱的主题
        const significantTopics = [];
        const totalEnergy = energies.reduce((a, b) => a + b, 0);
        let cumEnergy = 0;
        for (let i = 0; i < topics.length; i++) {
            significantTopics.push(topics[i]);
            cumEnergy += energies[i];
            if (cumEnergy / totalEnergy > 0.95) break;
        }

        console.log(`[ResultDeduplicator] Identify ${significantTopics.length} significant latent topics.`);

        // 4. 残差选择算法 (Residual Selection)
        // 目标：选择一组结果，使其能最大程度覆盖 query 在 significantTopics 上的投影

        const selectedIndices = new Set();
        const selectedResults = [];

        // 4.1 优先保留与 Query 最直接相关的第一名 (Anchor)
        // 假设 candidates 已经按 score 排序，直接取第一个
        // 但为了严谨，我们重新计算一次与 Query 的相似度
        let bestIdx = -1;
        let bestSim = -1;

        // 归一化 Query
        const nQuery = this._normalize(queryVector);

        for (let i = 0; i < vectors.length; i++) {
            const sim = this._dotProduct(this._normalize(vectors[i]), nQuery);
            if (sim > bestSim) {
                bestSim = sim;
                bestIdx = i;
            }
        }

        if (bestIdx !== -1) {
            selectedIndices.add(bestIdx);
            selectedResults.push(validCandidates[bestIdx]);
        }

        // 4.2 迭代选择：寻找能解释剩余特征的最佳候选项
        const maxRounds = this.config.maxResults - 1;

        // 初始正交基 = [第一名]
        const currentBasis = [vectors[bestIdx]];

        for (let round = 0; round < maxRounds; round++) {
            let maxProjectedEnergy = -1;
            let nextBestIdx = -1;

            // 遍历未选择的候选者
            for (let i = 0; i < vectors.length; i++) {
                if (selectedIndices.has(i)) continue;

                const vec = vectors[i];

                // A. 计算该向量与已选集合的"差异" (残差)
                // 使用 ResidualPyramid 的正交投影逻辑
                // 我们想找一个向量，它在"已选基底"之外的分量最大（即提供了最多的新信息）
                const { residual } = this.residualCalculator._computeOrthogonalProjection(vec, currentBasis.map(v => ({ vector: v })));
                const noveltyEnergy = this._magnitude(residual) ** 2;

                // B. 同时，这个新信息必须是"相关"的新信息，而不是噪音
                // 检查它在 significantTopics 上的投影
                // 这里做一个简化：只要它在 Topics 空间内有投影，且相对于已选基底独特即可

                // 综合评分：差异性 * 原始相关度
                // 原始 score 通常在 candidates[i].score 中
                // 如果没有，用刚才算的 sim
                const originalScore = validCandidates[i].score || 0.5;
                const score = noveltyEnergy * (originalScore + 0.5); // +0.5 平滑防止负分

                if (score > maxProjectedEnergy) {
                    maxProjectedEnergy = score;
                    nextBestIdx = i;
                }
            }

            if (nextBestIdx !== -1) {
                // 检查是否过于相似 (虽然残差投影已经隐含了这一点，但显式阈值更安全)
                // 实际上正交投影的 residual magnitude 如果很小，说明线性相关（相似）
                if (maxProjectedEnergy < 0.01) {
                    console.log(`[ResultDeduplicator] Remaining candidates provide negligible novelty. Stopping.`);
                    break;
                }

                selectedIndices.add(nextBestIdx);
                selectedResults.push(validCandidates[nextBestIdx]);
                currentBasis.push(vectors[nextBestIdx]);
            } else {
                break;
            }
        }

        console.log(`[ResultDeduplicator] Selected ${selectedResults.length} / ${validCandidates.length} diverse results.`);
        return selectedResults;
    }

    _normalize(vec) {
        const dim = vec.length;
        const res = new Float32Array(dim);
        let mag = 0;
        for (let i = 0; i < dim; i++) mag += vec[i] ** 2;
        mag = Math.sqrt(mag);
        if (mag > 1e-9) {
            for (let i = 0; i < dim; i++) res[i] = vec[i] / mag;
        }
        return res;
    }

    _dotProduct(v1, v2) {
        let sum = 0;
        for (let i = 0; i < v1.length; i++) sum += v1[i] * v2[i];
        return sum;
    }

    _magnitude(vec) {
        let sum = 0;
        for (let i = 0; i < vec.length; i++) sum += vec[i] ** 2;
        return Math.sqrt(sum);
    }
}

module.exports = ResultDeduplicator;
