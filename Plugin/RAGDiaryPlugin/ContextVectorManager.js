/**
 * ContextVectorManager - 上下文向量对应映射管理模块
 * 
 * 功能：
 * 1. 维护当前会话中所有消息（除最后一条 AI 和用户消息外）的向量映射。
 * 2. 提供模糊匹配技术，处理 AI 或用户对上下文的微小编辑。
 * 3. 为后续的“上下文向量衰减聚合系统”提供底层数据支持。
 */

const crypto = require('crypto');

class ContextVectorManager {
    constructor(plugin) {
        this.plugin = plugin;
        // 核心映射：normalizedHash -> { vector, role, originalText, timestamp }
        this.vectorMap = new Map();
        // 顺序索引：用于按顺序获取向量
        this.historyAssistantVectors = [];
        this.historyUserVectors = [];

        // 模糊匹配阈值 (0.0 ~ 1.0)，用于判断两个文本是否足够相似以复用向量，因为是用于提取特征向量所以模糊程度可以大一点
        this.fuzzyThreshold = 0.85;
        this.decayRate = 0.75; // 🌟 衰减率加快 (0.85 -> 0.75)
        this.maxContextWindow = 10; // 🌟 限制聚合窗口为最近 10 楼
    }

    /**
     * 文本归一化处理
     */
    _normalize(text) {
        if (!text) return '';
        // 复用插件的清理逻辑
        let cleaned = this.plugin._stripHtml(text);
        cleaned = this.plugin._stripEmoji(cleaned);
        cleaned = this.plugin._stripToolMarkers(cleaned); // ✅ 新增：同步净化工具调用噪音
        // 移除多余空格、换行，转小写
        return cleaned.toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * 生成内容哈希
     */
    _generateHash(text) {
        return crypto.createHash('sha256').update(text).digest('hex');
    }

    /**
     * 简单的字符串相似度算法 (Dice's Coefficient)
     * 用于处理微小编辑时的模糊匹配
     */
    _calculateSimilarity(str1, str2) {
        if (str1 === str2) return 1.0;
        if (str1.length < 2 || str2.length < 2) return 0;

        const getBigrams = (str) => {
            const bigrams = new Set();
            for (let i = 0; i < str.length - 1; i++) {
                bigrams.add(str.substring(i, i + 2));
            }
            return bigrams;
        };

        const b1 = getBigrams(str1);
        const b2 = getBigrams(str2);
        let intersect = 0;
        for (const b of b1) {
            if (b2.has(b)) intersect++;
        }

        return (2.0 * intersect) / (b1.size + b2.size);
    }

    /**
     * 尝试在现有缓存中寻找模糊匹配的向量
     */
    _findFuzzyMatch(normalizedText) {
        for (const entry of this.vectorMap.values()) {
            const similarity = this._calculateSimilarity(normalizedText, this._normalize(entry.originalText));
            if (similarity >= this.fuzzyThreshold) {
                return entry.vector;
            }
        }
        return null;
    }

    /**
     * 更新上下文映射
     * @param {Array} messages - 当前会话的消息数组
     * @param {Object} options - 配置项 { allowApi: false }
     */
    async updateContext(messages, options = {}) {
        if (!Array.isArray(messages)) return;
        const { allowApi = false } = options;

        const newAssistantVectors = [];
        const newUserVectors = [];

        const stats = {
            totalHistoricalAssistantMessages: 0,
            totalHistoricalUserMessages: 0,
            vectorizedAssistantMessages: 0,
            vectorizedUserMessages: 0,
            exactHashHits: 0,
            fuzzyHits: 0,
            embeddingCacheHits: 0,
            apiGenerated: 0,
            unresolved: 0,
            skippedSystemMessages: 0,
            skippedLastTurnMessages: 0,
            skippedEmptyMessages: 0
        };

        // 识别最后的消息索引以进行排除
        const lastUserIndex = messages.findLastIndex(m => m.role === 'user');
        const lastAiIndex = messages.findLastIndex(m => m.role === 'assistant');

        const tasks = messages.map(async (msg, index) => {
            // 排除逻辑：系统消息、最后一个用户消息、最后一个 AI 消息
            if (msg.role === 'system') {
                stats.skippedSystemMessages++;
                return;
            }
            if (index === lastUserIndex || index === lastAiIndex) {
                stats.skippedLastTurnMessages++;
                return;
            }

            const content = typeof msg.content === 'string'
                ? msg.content
                : (Array.isArray(msg.content) ? msg.content.find(p => p.type === 'text')?.text : '') || '';

            if (!content || content.length < 2) {
                stats.skippedEmptyMessages++;
                return;
            }

            if (msg.role === 'assistant') {
                stats.totalHistoricalAssistantMessages++;
            } else if (msg.role === 'user') {
                stats.totalHistoricalUserMessages++;
            }

            const normalized = this._normalize(content);
            const hash = this._generateHash(normalized);

            let vector = null;
            let vectorSource = 'none';

            // 1. 精确匹配
            if (this.vectorMap.has(hash)) {
                vector = this.vectorMap.get(hash).vector;
                vectorSource = 'exact';
            }
            // 2. 模糊匹配 (处理微小编辑)
            else {
                vector = this._findFuzzyMatch(normalized);
                if (vector) {
                    vectorSource = 'fuzzy';
                }

                // 3. 尝试从插件的 Embedding 缓存中获取（不触发 API）
                if (!vector) {
                    vector = this.plugin._getEmbeddingFromCacheOnly(content);
                    if (vector) {
                        vectorSource = 'embeddingCache';
                    }
                }

                // 4. 如果缓存也没有，且允许 API，则请求新向量（触发 API）
                if (!vector && allowApi) {
                    vector = await this.plugin.getSingleEmbeddingCached(content);
                    if (vector) {
                        vectorSource = 'api';
                    }
                }

                // 存入映射
                if (vector) {
                    this.vectorMap.set(hash, {
                        vector,
                        role: msg.role,
                        originalText: content,
                        timestamp: Date.now()
                    });
                }
            }

            if (vectorSource === 'exact') stats.exactHashHits++;
            else if (vectorSource === 'fuzzy') stats.fuzzyHits++;
            else if (vectorSource === 'embeddingCache') stats.embeddingCacheHits++;
            else if (vectorSource === 'api') stats.apiGenerated++;
            else stats.unresolved++;

            if (vector) {
                const entry = { vector, index, role: msg.role };
                if (msg.role === 'assistant') {
                    newAssistantVectors.push(entry);
                    stats.vectorizedAssistantMessages++;
                } else if (msg.role === 'user') {
                    newUserVectors.push(entry);
                    stats.vectorizedUserMessages++;
                }
            }
        });

        await Promise.all(tasks);

        // 保持原始顺序
        this.historyAssistantVectors = newAssistantVectors.sort((a, b) => a.index - b.index).map(v => v.vector);
        this.historyUserVectors = newUserVectors.sort((a, b) => a.index - b.index).map(v => v.vector);

        console.log(
            `[ContextVectorManager] 上下文向量映射已更新。` +
            ` 历史AI消息: ${stats.totalHistoricalAssistantMessages}, 已向量化AI: ${stats.vectorizedAssistantMessages};` +
            ` 历史用户消息: ${stats.totalHistoricalUserMessages}, 已向量化用户: ${stats.vectorizedUserMessages};` +
            ` 命中统计[精确:${stats.exactHashHits}, 模糊:${stats.fuzzyHits}, 缓存:${stats.embeddingCacheHits}, API:${stats.apiGenerated}, 未解析:${stats.unresolved}]` +
            `；跳过[system:${stats.skippedSystemMessages}, 最后一轮:${stats.skippedLastTurnMessages}, 空消息:${stats.skippedEmptyMessages}]` +
            `；历史向量API开关=${allowApi}`
        );
    }

    /**
     * 公共查询接口：获取所有历史 AI 输出的向量
     */
    getHistoryAssistantVectors() {
        return this.historyAssistantVectors;
    }

    /**
     * 公共查询接口：获取所有历史用户输入的向量
     */
    getHistoryUserVectors() {
        return this.historyUserVectors;
    }

    /**
     * 聚合多楼层向量，近期楼层权重更高 (衰减聚合)
     * @param {string} role - 'assistant' 或 'user'
     * @returns {Float32Array|null} 聚合后的向量
     */
    aggregateContext(role = 'assistant') {
        let vectors = role === 'assistant' ? this.historyAssistantVectors : this.historyUserVectors;
        if (vectors.length === 0) return null;

        // 🌟 限制窗口：只取最近的 maxContextWindow 楼层
        if (vectors.length > this.maxContextWindow) {
            vectors = vectors.slice(-this.maxContextWindow);
        }

        const dim = vectors[0].length;
        const aggregated = new Float32Array(dim);
        let totalWeight = 0;

        // 这里的 index 越大表示越接近当前楼层
        vectors.forEach((vector, idx) => {
            // 指数衰减：越早的楼层权重越低
            const age = vectors.length - idx;
            const weight = Math.pow(this.decayRate, age);

            for (let i = 0; i < dim; i++) {
                aggregated[i] += vector[i] * weight;
            }
            totalWeight += weight;
        });

        if (totalWeight > 0) {
            for (let i = 0; i < dim; i++) {
                aggregated[i] /= totalWeight;
            }
        }

        return aggregated;
    }

    /**
     * 计算向量的"逻辑深度指数" L
     * 核心思想：如果向量能量集中在少数维度，说明逻辑聚焦
     *
     * @param {Array|Float32Array} vector - 向量
     * @param {number} topK - 只看前K个最大分量
     * @returns {number} L ∈ [0, 1]，越高表示逻辑越集中
     */
    computeLogicDepth(vector, topK = 64) {
        if (!vector) return 0;
        const dim = vector.length;
        const energies = new Float32Array(dim);
        let totalEnergy = 0;

        for (let i = 0; i < dim; i++) {
            energies[i] = vector[i] * vector[i];
            totalEnergy += energies[i];
        }

        if (totalEnergy < 1e-9) return 0;

        const sorted = Array.from(energies).sort((a, b) => b - a);
        let topKEnergy = 0;
        const actualTopK = Math.min(topK, dim);
        for (let i = 0; i < actualTopK; i++) {
            topKEnergy += sorted[i];
        }

        const concentration = topKEnergy / totalEnergy;
        const expectedUniform = actualTopK / dim;
        const L = (concentration - expectedUniform) / (1 - expectedUniform);

        return Math.max(0, Math.min(1, L));
    }

    /**
     * 计算语义宽度指数 S
     * 核心思想：L2归一化后 Σv_i² = 1，v_i² 构成概率分布，
     * 用归一化熵衡量能量的分散程度。
     * S ≈ 1 → 能量均匀分布，语义宽泛
     * S ≈ 0 → 能量集中少数维度，语义精准
     *
     * @param {Array|Float32Array} vector - L2归一化向量
     * @returns {number} S ∈ [0, 1]
     */
    computeSemanticWidth(vector) {
        if (!vector) return 0;
        const dim = vector.length;

        // v_i^2 构成概率分布 (L2归一化 => Σv_i² = 1)
        let entropy = 0;
        for (let i = 0; i < dim; i++) {
            const p = vector[i] * vector[i];
            if (p > 1e-12) {
                entropy -= p * Math.log(p);
            }
        }

        // 归一化到 [0, 1]：均匀分布时熵最大 = log(dim)
        const maxEntropy = Math.log(dim);
        return maxEntropy > 0 ? entropy / maxEntropy : 0;
    }

    /**
     * 获取特定索引范围的向量（高级查询）
     */
    getVectorsByRange(role, start, end) {
        // 预留接口
        return [];
    }

    /**
     * 清理过期或过多的映射
     */
    cleanup(maxSize = 1000) {
        if (this.vectorMap.size > maxSize) {
            // 简单的 LRU 或全部清空
            this.vectorMap.clear();
        }
    }

    /**
     * 🌟 Tagmemo V4: 基于语义向量的上下文分段 (Semantic Segmentation)
     * 将连续的、高相似度的消息归并为一个段落 (Segment/Topic)
     * 
     * @param {Array} messages - 消息列表 (通常是 history)
     * @param {number} similarityThreshold - 分段阈值，低于此值则断开 (默认 0.70)
     * @returns {Array<{vector: Float32Array, text: string, role: string, range: [number, number]}>}
     */
    segmentContext(messages, similarityThreshold = 0.70) {
        // 1. 获取所有有效向量并按顺序排列
        // 我们需要合并 assistant 和 user 的向量，按 index 排序
        const allEntries = [];
        this.vectorMap.forEach((entry, hash) => {
            // 注意：vectorMap 中存储的是无序的 hash 映射，我们需要找到对应的 index
            // 但 updateContext 中构建的 historyAssistantVectors 丢失了原始 index
            // 因此我们需要重新扫描一次 messages 来对齐向量
            // 优化：直接在 updateContext 时存储带 index 的列表会更好，但为了少改动，这里重新扫描
        });

        // 由于 vectorMap hash 丢失了 index，我们利用 updateContext 中的逻辑重新构建有序列表
        // 或者直接修改 updateContext 让 vectorMap 存 index? 不行，hash是去重的。
        // 最好的办法是重新遍历 messages，查 vectorMap

        const sequence = [];
        messages.forEach((msg, index) => {
            // 跳过系统消息和无关消息
            if (msg.role === 'system') return;

            const content = typeof msg.content === 'string'
                ? msg.content
                : (Array.isArray(msg.content) ? msg.content.find(p => p.type === 'text')?.text : '') || '';

            if (!content || content.length < 2) return;

            const normalized = this._normalize(content);
            const hash = this._generateHash(normalized);

            // 尝试精确匹配
            let entry = this.vectorMap.get(hash);

            // 尝试模糊匹配 (如果精确匹配失败)
            if (!entry) {
                // 这里为了性能，只做精确查找。模糊查找开销较大且 updateContext 已经做过了并存入 vectorMap
                // 理论上如果 updateContext 刚跑过，vectorMap 里应该有（或是 fuzzy 后的 match）
                // 我们再次计算 fuzzy 可能会很慢。
                // 妥协：如果没有 vector，跳过
            }

            if (entry && entry.vector) {
                sequence.push({
                    index,
                    role: msg.role,
                    text: content,
                    vector: entry.vector
                });
            }
        });

        if (sequence.length === 0) return [];

        // 2. 执行分段
        const segments = [];
        let currentSegment = {
            vectors: [sequence[0].vector],
            texts: [sequence[0].text],
            startIndex: sequence[0].index,
            endIndex: sequence[0].index,
            roles: [sequence[0].role]
        };

        for (let i = 1; i < sequence.length; i++) {
            const curr = sequence[i];
            const prev = sequence[i - 1];

            // 计算与上一条的相似度
            const sim = this._cosineSimilarity(prev.vector, curr.vector);

            // 角色变化也可以作为分段的弱信号，但在这里我们主要看语义
            // 如果相似度高，即使角色不同也可以合并（例如连续的问答对，讨论同一个话题）
            // 如果相似度低，即使角色相同也应该断开

            if (sim >= similarityThreshold) {
                // 合并
                currentSegment.vectors.push(curr.vector);
                currentSegment.texts.push(curr.text);
                currentSegment.endIndex = curr.index;
                currentSegment.roles.push(curr.role);
            } else {
                // 断开，保存旧段
                segments.push(this._finalizeSegment(currentSegment));
                // 开启新段
                currentSegment = {
                    vectors: [curr.vector],
                    texts: [curr.text],
                    startIndex: curr.index,
                    endIndex: curr.index,
                    roles: [curr.role]
                };
            }
        }
        // 保存最后一个段
        segments.push(this._finalizeSegment(currentSegment));

        return segments;
    }

    _finalizeSegment(seg) {
        // 计算平均向量
        const count = seg.vectors.length;
        const dim = seg.vectors[0].length;
        const avgVec = new Float32Array(dim);

        for (const v of seg.vectors) {
            for (let d = 0; d < dim; d++) {
                avgVec[d] += v[d];
            }
        }

        // 归一化
        let mag = 0;
        for (let d = 0; d < dim; d++) {
            avgVec[d] /= count;
            mag += avgVec[d] * avgVec[d];
        }
        mag = Math.sqrt(mag);
        if (mag > 1e-9) {
            for (let d = 0; d < dim; d++) avgVec[d] /= mag;
        }

        return {
            vector: avgVec,
            // 组合文本用于展示或日志
            text: seg.texts.join('\n'),
            roles: [...new Set(seg.roles)], // 去重角色
            range: [seg.startIndex, seg.endIndex],
            count: count
        };
    }

    _cosineSimilarity(vecA, vecB) {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dot += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

}

module.exports = ContextVectorManager;