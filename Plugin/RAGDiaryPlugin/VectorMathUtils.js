'use strict';

/**
 * 计算余弦相似度。
 *
 * @param {Array<number>|Float32Array} vecA
 * @param {Array<number>|Float32Array} vecB
 * @returns {number}
 */
function cosineSimilarity(vecA, vecB) {
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
 * 计算多个向量的加权平均。
 *
 * @param {Array<Array<number>|Float32Array|null>} vectors
 * @param {Array<number>} weights
 * @param {object} [options]
 * @param {Console} [options.logger]
 * @returns {Array<number>|Float32Array|null}
 */
function getWeightedAverageVector(vectors, weights, options = {}) {
    const logger = options.logger || console;
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
        logger.warn('[RAGDiaryPlugin] Weight sum is zero, using equal weights.');
        validWeights.fill(1 / validVectors.length);
        weightSum = 1;
    }

    const normalizedWeights = validWeights.map(w => w / weightSum);
    const dimension = validVectors[0].length;
    const result = new Array(dimension).fill(0);

    for (let i = 0; i < validVectors.length; i++) {
        const vector = validVectors[i];
        const weight = normalizedWeights[i];

        if (vector.length !== dimension) {
            logger.error('[RAGDiaryPlugin] Vector dimensions do not match. Skipping mismatched vector.');
            continue;
        }

        for (let j = 0; j < dimension; j++) {
            result[j] += vector[j] * weight;
        }
    }

    return result;
}

/**
 * 计算多个向量的平均值。
 *
 * @param {Array<Array<number>|Float32Array|null>} vectors
 * @returns {Array<number>|Float32Array|null}
 */
function getAverageVector(vectors) {
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
 * Sigmoid 函数。
 *
 * @param {number} x
 * @returns {number}
 */
function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
}

/**
 * 字符 bigram Dice 相似度。
 *
 * @param {string} textA
 * @param {string} textB
 * @returns {number}
 */
function textDiceSimilarity(textA, textB) {
    if (textA === textB) return 1;
    if (!textA || !textB || textA.length < 2 || textB.length < 2) return 0;

    const buildBigrams = (text) => {
        const bigrams = new Map();
        for (let i = 0; i < text.length - 1; i++) {
            const gram = text.slice(i, i + 2);
            bigrams.set(gram, (bigrams.get(gram) || 0) + 1);
        }
        return bigrams;
    };

    const bigramsA = buildBigrams(textA);
    const bigramsB = buildBigrams(textB);
    let intersection = 0;

    for (const [gram, countA] of bigramsA.entries()) {
        const countB = bigramsB.get(gram) || 0;
        intersection += Math.min(countA, countB);
    }

    const totalA = Array.from(bigramsA.values()).reduce((sum, count) => sum + count, 0);
    const totalB = Array.from(bigramsB.values()).reduce((sum, count) => sum + count, 0);

    return totalA + totalB > 0 ? (2 * intersection) / (totalA + totalB) : 0;
}

module.exports = {
    cosineSimilarity,
    getWeightedAverageVector,
    getAverageVector,
    sigmoid,
    textDiceSimilarity
};