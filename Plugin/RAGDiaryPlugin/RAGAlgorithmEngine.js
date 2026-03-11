// Plugin/RAGDiaryPlugin/RAGAlgorithmEngine.js

/**
 * RAG 算法核心引擎
 */
class RAGAlgorithmEngine {
    /**
     * 余弦相似度计算
     */
    static cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) {
            return 0;
        }
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) {
            return 0;
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * 加权平均向量
     */
    static getWeightedAverageVector(vectors, weights) {
        const validVectors = [];
        const validWeights = [];
        for (let i = 0; i < vectors.length; i++) {
            if (vectors[i] && vectors[i].length > 0) {
                validVectors.push(vectors[i]);
                validWeights.push(weights[i] || 0);
            }
        }

        if (validVectors.length === 0) return null;
        if (validVectors.length === 1) return validVectors[0];

        let weightSum = validWeights.reduce((sum, w) => sum + w, 0);
        if (weightSum === 0) {
            validWeights.fill(1 / validVectors.length);
            weightSum = 1;
        }

        const normalizedWeights = validWeights.map(w => w / weightSum);
        const dimension = validVectors[0].length;
        const result = new Array(dimension).fill(0);

        for (let i = 0; i < validVectors.length; i++) {
            const vector = validVectors[i];
            const weight = normalizedWeights[i];
            if (vector.length !== dimension) continue;
            for (let j = 0; j < dimension; j++) {
                result[j] += vector[j] * weight;
            }
        }
        return result;
    }

    /**
     * 普通平均向量
     */
    static getAverageVector(vectors) {
        if (!vectors || vectors.length === 0) return null;
        if (vectors.length === 1) return vectors[0];

        const dimension = vectors[0].length;
        const result = new Array(dimension).fill(0);

        for (const vector of vectors) {
            if (!vector || vector.length !== dimension) continue;
            for (let i = 0; i < dimension; i++) {
                result[i] += vector[i];
            }
        }

        for (let i = 0; i < dimension; i++) {
            result[i] /= vectors.length;
        }
        return result;
    }

    /**
     * Sigmoid 激活函数
     */
    static sigmoid(x) {
        return 1 / (1 + Math.exp(-x));
    }

    /**
     * V3 动态参数计算：结合 L, R, S
     */
    static async calculateDynamicParams(queryVector, userText, aiText, vectorDBManager, contextVectorManager, ragParams) {
        const userLen = userText ? userText.length : 0;
        let k_base = 3;
        if (userLen > 100) k_base = 6;
        else if (userLen > 30) k_base = 4;

        if (aiText) {
            const tokens = aiText.match(/[a-zA-Z0-9]+|[^\s\x00-\xff]/g) || [];
            const uniqueTokens = new Set(tokens).size;
            if (uniqueTokens > 100) k_base = Math.max(k_base, 6);
            else if (uniqueTokens > 40) k_base = Math.max(k_base, 4);
        }

        const epa = await vectorDBManager.getEPAAnalysis(queryVector);
        const L = epa.logicDepth;
        const R = epa.resonance;
        const S = contextVectorManager.computeSemanticWidth(queryVector);

        const config = ragParams?.RAGDiaryPlugin || {};
        const noise_penalty = config.noise_penalty ?? 0.05;
        const betaInput = L * Math.log(1 + R + 1) - S * noise_penalty;
        const beta = this.sigmoid(betaInput);

        const weightRange = config.tagWeightRange || [0.05, 0.45];
        const finalTagWeight = weightRange[0] + beta * (weightRange[1] - weightRange[0]);

        const kAdjustment = Math.round(L * 3 + Math.log1p(R) * 2);
        const finalK = Math.max(3, Math.min(10, k_base + kAdjustment));

        let tagTruncationRatio = (config.tagTruncationBase ?? 0.6) + (L * 0.3) - (S * 0.2) + (Math.min(R, 1) * 0.1);
        const truncationRange = config.tagTruncationRange || [0.5, 0.9];
        tagTruncationRatio = Math.max(truncationRange[0], Math.min(truncationRange[1], tagTruncationRatio));

        return {
            k: finalK,
            tagWeight: finalTagWeight,
            tagTruncationRatio: tagTruncationRatio,
            metrics: { L, R, S, beta }
        };
    }

    /**
     * 旧版动态 K 计算
     */
    static calculateDynamicK(userText, aiText = null) {
        const userLen = userText ? userText.length : 0;
        let k_user = 3;
        if (userLen > 100) k_user = 7;
        else if (userLen > 30) k_user = 5;
        if (!aiText) return k_user;
        const tokens = aiText.match(/[a-zA-Z0-9]+|[^\s\x00-\xff]/g) || [];
        const uniqueTokens = new Set(tokens).size;
        let k_ai = 3;
        if (uniqueTokens > 100) k_ai = 7;
        else if (uniqueTokens > 40) k_ai = 5;
        return Math.round((k_user + k_ai) / 2);
    }

    /**
     * 核心标签截断
     */
    static truncateCoreTags(tags, ratio, metrics) {
        if (!tags || tags.length <= 5) return tags;
        const targetCount = Math.max(5, Math.ceil(tags.length * ratio));
        const truncated = tags.slice(0, targetCount);
        return truncated;
    }
}

module.exports = RAGAlgorithmEngine;
