/**
 * ResidualPyramid.js
 * 残差金字塔模块 (Physics-Optimized Edition)
 * 功能：基于 Gram-Schmidt 正交化计算多层级语义残差，精确分析语义能量谱。
 */

class ResidualPyramid {
    constructor(tagIndex, db, config = {}) {
        this.tagIndex = tagIndex;
        this.db = db;
        this.config = {
            maxLevels: config.maxLevels || 3,
            topK: config.topK || 10,
            // 修正：使用能量阈值。0.1 表示当残差能量低于原始能量的 10% 时停止 (即解释了 90%)
            minEnergyRatio: config.minEnergyRatio || 0.1, 
            dimension: config.dimension || 3072,
            ...config
        };
    }

    /**
     * 🌟 核心：计算查询向量的残差金字塔
     * @param {Float32Array|Array} queryVector - 原始查询向量
     */
    analyze(queryVector) {
        const dim = this.config.dimension;
        const pyramid = {
            levels: [],
            totalExplainedEnergy: 0, // 被Tag解释的总能量比例 (0~1)
            finalResidual: null,     // 最终残差向量
            features: {}             // 提取的特征
        };

        // 确保使用 Float32Array
        let currentVector = queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);
        
        // 计算初始总能量 E = ||v||^2
        const originalMagnitude = this._magnitude(currentVector);
        const originalEnergy = originalMagnitude * originalMagnitude;
        
        // 防止除零错误
        if (originalEnergy < 1e-12) {
            return this._emptyResult(dim);
        }

        let currentResidual = new Float32Array(currentVector); // 迭代中的残差

        for (let level = 0; level < this.config.maxLevels; level++) {
            // 1. 搜索当前残差向量的最近 Tags
            const searchBuffer = Buffer.from(currentResidual.buffer, currentResidual.byteOffset, currentResidual.byteLength);
            let tagResults;
            try {
                tagResults = this.tagIndex.search(searchBuffer, this.config.topK);
            } catch (e) {
                console.warn(`[Residual] Search failed at level ${level}:`, e.message);
                break;
            }
            
            if (!tagResults || tagResults.length === 0) break;

            // 2. 获取Tag详细信息 (向量)
            const tagIds = tagResults.map(r => r.id);
            const rawTags = this._getTagVectors(tagIds);
            if (rawTags.length === 0) break;
            
            // 3. 🌟 核心修正：Gram-Schmidt 正交投影
            // 计算当前残差在这些 Tag 张成的子空间上的精确投影
            const { projection, residual, orthogonalBasis, basisCoefficients } = this._computeOrthogonalProjection(
                currentResidual, rawTags
            );
            
            // 4. 计算能量数据
            const residualMagnitude = this._magnitude(residual);
            const residualEnergy = residualMagnitude * residualMagnitude;
            const currentEnergy = this._magnitude(currentResidual) ** 2;
            
            // 本层解释的能量 = (旧残差能量 - 新残差能量) / 原始总能量
            // 注意：由于正交投影性质，||R_old||^2 = ||Projection||^2 + ||R_new||^2
            const energyExplainedByLevel = Math.max(0, currentEnergy - residualEnergy) / originalEnergy;

            // 5. 分析握手特征 (基于原始 Tag 方向，而非正交基)
            const handshakes = this._computeHandshakes(currentResidual, rawTags);

            pyramid.levels.push({
                level,
                tags: rawTags.map((t, i) => {
                    const res = tagResults.find(r => r.id === t.id);
                    // 估算该 Tag 在本层解释中的贡献度 (基于其在正交基中的投影分量)
                    // 这是一个近似值，因为 Gram-Schmidt 对顺序敏感，但这比单纯的 softmax 准确
                    return {
                        id: t.id,
                        name: t.name,
                        similarity: res ? res.score : 0,
                        // 修正：权重不再是 softmax，而是该 Tag 对解释能量的贡献
                        contribution: basisCoefficients[i] || 0, 
                        handshakeMagnitude: handshakes.magnitudes[i]
                    };
                }),
                projectionMagnitude: this._magnitude(projection),
                residualMagnitude,
                residualEnergyRatio: residualEnergy / originalEnergy,
                energyExplained: energyExplainedByLevel,
                handshakeFeatures: this._analyzeHandshakes(handshakes, dim)
            });
            
            pyramid.totalExplainedEnergy += energyExplainedByLevel;
            currentResidual = residual; // 更新残差用于下一轮

            // 6. 能量阈值截断 (Energy Cutoff)
            // 如果剩余能量少于设定的比例 (例如 10%)，则停止
            if ((residualEnergy / originalEnergy) < this.config.minEnergyRatio) {
                break;
            }
        }
        
        pyramid.finalResidual = currentResidual;
        pyramid.features = this._extractPyramidFeatures(pyramid);
        
        return pyramid;
    }

    /**
     * 🌟 数学修正：Gram-Schmidt 正交化投影
     * 将 vector 投影到 tags 张成的子空间中
     */
    _computeOrthogonalProjection(vector, tags) {
        const dim = this.config.dimension;
        const n = tags.length;

        // 🌟 优先使用 Rust 高性能投影
        if (this.tagIndex && typeof this.tagIndex.computeOrthogonalProjection === 'function') {
            try {
                const flattenedTags = new Float32Array(n * dim);
                for (let i = 0; i < n; i++) {
                    const buf = tags[i].vector;
                    const tagVec = new Float32Array(dim);
                    new Uint8Array(tagVec.buffer).set(buf);
                    flattenedTags.set(tagVec, i * dim);
                }

                const result = this.tagIndex.computeOrthogonalProjection(
                    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
                    Buffer.from(flattenedTags.buffer, flattenedTags.byteOffset, flattenedTags.byteLength),
                    n
                );

                return {
                    projection: new Float32Array(result.projection.map(x => x)),
                    residual: new Float32Array(result.residual.map(x => x)),
                    basisCoefficients: new Float32Array(result.basisCoefficients.map(x => x))
                };
            } catch (e) {
                console.warn('[Residual] Rust projection failed, falling back to JS:', e.message);
            }
        }

        const basis = []; // 存储正交基向量 { vec: Float32Array, originalIndex: number }
        const basisCoefficients = new Float32Array(n); // 记录每个 Tag (对应基) 承载的投影分量
        
        // 1. 构建正交基 (Modified Gram-Schmidt 算法，数值更稳定)
        for (let i = 0; i < n; i++) {
            const buf = tags[i].vector;
            const tagVec = new Float32Array(dim);
            new Uint8Array(tagVec.buffer).set(buf);
            
            // v_i = t_i
            let v = new Float32Array(tagVec);
            
            // 减去在已有基上的投影: v = v - <v, u_j> * u_j
            for (let j = 0; j < basis.length; j++) {
                const u = basis[j];
                const dot = this._dotProduct(v, u);
                for (let d = 0; d < dim; d++) {
                    v[d] -= dot * u[d];
                }
            }
            
            // 归一化得到 u_i
            const mag = this._magnitude(v);
            if (mag > 1e-6) { // 防止零向量
                for (let d = 0; d < dim; d++) v[d] /= mag;
                basis.push(v);
                
                // 计算 Query 在这个新基向量上的投影分量系数
                // coeff = <Query, u_i>
                const coeff = this._dotProduct(vector, v);
                basisCoefficients[i] = Math.abs(coeff); // 记录绝对贡献
            } else {
                basisCoefficients[i] = 0; // 该 Tag 线性相关，无独立贡献
            }
        }

        // 2. 计算总投影 P = Σ <vector, u_i> * u_i
        const projection = new Float32Array(dim);
        for (let i = 0; i < basis.length; i++) {
            const u = basis[i];
            const dot = this._dotProduct(vector, u);
            for (let d = 0; d < dim; d++) {
                projection[d] += dot * u[d];
            }
        }

        // 3. 计算残差 R = vector - P
        const residual = new Float32Array(dim);
        for (let d = 0; d < dim; d++) {
            residual[d] = vector[d] - projection[d];
        }

        return { projection, residual, orthogonalBasis: basis, basisCoefficients };
    }

    /**
     * 计算握手差值（查询与每个Tag的差向量）
     * 保留此逻辑用于分析方向性差异
     */
    _computeHandshakes(query, tags) {
        const dim = this.config.dimension;
        const n = tags.length;

        // 🌟 优先使用 Rust 高性能分析
        if (this.tagIndex && typeof this.tagIndex.computeHandshakes === 'function') {
            try {
                const flattenedTags = new Float32Array(n * dim);
                for (let i = 0; i < n; i++) {
                    const buf = tags[i].vector;
                    const tagVec = new Float32Array(dim);
                    new Uint8Array(tagVec.buffer).set(buf);
                    flattenedTags.set(tagVec, i * dim);
                }

                const result = this.tagIndex.computeHandshakes(
                    Buffer.from(query.buffer, query.byteOffset, query.byteLength),
                    Buffer.from(flattenedTags.buffer, flattenedTags.byteOffset, flattenedTags.byteLength),
                    n
                );

                const directions = [];
                for (let i = 0; i < n; i++) {
                    directions.push(new Float32Array(
                        result.directions.slice(i * dim, (i + 1) * dim).map(x => x)
                    ));
                }

                return { magnitudes: result.magnitudes.map(x => x), directions };
            } catch (e) {
                console.warn('[Residual] Rust handshakes failed, falling back to JS:', e.message);
            }
        }

        const magnitudes = [];
        const directions = [];
        
        for (let i = 0; i < n; i++) {
            const buf = tags[i].vector;
            const tagVec = new Float32Array(dim);
            new Uint8Array(tagVec.buffer).set(buf);
            const delta = new Float32Array(dim);
            let magSq = 0;
            for (let d = 0; d < dim; d++) {
                delta[d] = query[d] - tagVec[d];
                magSq += delta[d] * delta[d];
            }
            const mag = Math.sqrt(magSq);
            magnitudes.push(mag);
            
            const dir = new Float32Array(dim);
            if (mag > 1e-9) {
                for (let d = 0; d < dim; d++) dir[d] = delta[d] / mag;
            }
            directions.push(dir);
        }
        return { magnitudes, directions };
    }

    /**
     * 分析握手差值的统计特征
     * 优化：更清晰的物理意义
     */
    _analyzeHandshakes(handshakes, dim) {
        const n = handshakes.magnitudes.length;
        if (n === 0) return null;
        
        // 1. 差值方向的一致性 (Coherence)
        // 如果所有 Tag 都在同一个方向上偏离 Query，说明 Query 有明确的“偏移意图”
        const avgDirection = new Float32Array(dim);
        for (let i = 0; i < n; i++) {
            for (let d = 0; d < dim; d++) avgDirection[d] += handshakes.directions[i][d];
        }
        for (let d = 0; d < dim; d++) avgDirection[d] /= n;
        
        const directionCoherence = this._magnitude(avgDirection);
        
        // 2. 内部张力 (Internal Tension / Pattern Strength)
        // Tag 之间的差值方向是否相似？
        let pairwiseSimSum = 0;
        let pairCount = 0;
        // 采样前 5 个两两比较，避免 O(N^2)
        const limit = Math.min(n, 5); 
        for (let i = 0; i < limit; i++) {
            for (let j = i + 1; j < limit; j++) {
                pairwiseSimSum += Math.abs(this._dotProduct(handshakes.directions[i], handshakes.directions[j]));
                pairCount++;
            }
        }
        const avgPairwiseSim = pairCount > 0 ? pairwiseSimSum / pairCount : 0;
        
        return {
            // Coherence 高：Query 在所有 Tag 的"外部" (新领域)
            // Coherence 低：Query 被 Tag 包围在"中间" (已知领域的细节)
            directionCoherence, 
            patternStrength: avgPairwiseSim,
            
            // 🌟 修正公式：
            // 新颖信号：方向一致性高(偏移明确) + 残差大(未被解释) -> 这里只计算方向分量
            noveltySignal: directionCoherence,
            
            // 噪音信号：方向杂乱无章 (Coherence低) 且 Tag 之间也很乱 (Sim低)
            noiseSignal: (1 - directionCoherence) * (1 - avgPairwiseSim)
        };
    }

    /**
     * 提取综合特征
     */
    _extractPyramidFeatures(pyramid) {
        if (pyramid.levels.length === 0) {
            return { depth: 0, coverage: 0, novelty: 1, coherence: 0, tagMemoActivation: 0 };
        }

        const level0 = pyramid.levels[0];
        const handshake = level0.handshakeFeatures;
        
        // 覆盖率 = 解释的总能量 (0~1)
        const coverage = Math.min(1.0, pyramid.totalExplainedEnergy);
        
        // 相干度：第一层召回的 Tags 是否属于同一簇
        const coherence = handshake ? handshake.patternStrength : 0;

        // 🌟 修正：Novelty (新颖度)
        // 真正的"新"，是现有的 Tag 解释不了的部分 (Residual Energy)
        // 加上方向一致性 (说明不仅解释不了，而且偏向一个特定未知方向)
        const residualRatio = 1 - coverage;
        const directionalNovelty = handshake ? handshake.noveltySignal : 0;
        const novelty = (residualRatio * 0.7) + (directionalNovelty * 0.3);

        return {
            depth: pyramid.levels.length,
            coverage,
            novelty,
            coherence,
            
            // 🌟 综合决策指标：是否激活 TagMemo 增强？
            // 逻辑：如果覆盖率已经很高 (Query很常见)，或者完全是噪音，就不需要太强的 Memo
            // 如果相干性高 (Tag 属于同一类)，且有一定覆盖率，说明找到了正确的"邻域"，此时适合激活
            tagMemoActivation: coverage * coherence * (1 - (handshake?.noiseSignal || 0)),
            
            // 扩展信号：是否需要去搜索新的 Tag？(当新颖度高时)
            expansionSignal: novelty
        };
    }

    _getTagVectors(ids) {
        // 简单的 SQL 占位符生成
        const placeholders = ids.map(() => '?').join(',');
        return this.db.prepare(`
            SELECT id, name, vector FROM tags WHERE id IN (${placeholders})
        `).all(...ids);
    }

    _magnitude(vec) {
        let sum = 0;
        for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
        return Math.sqrt(sum);
    }

    _dotProduct(v1, v2) {
        let sum = 0;
        for (let i = 0; i < v1.length; i++) sum += v1[i] * v2[i];
        return sum;
    }

    _emptyResult(dim) {
        return {
            levels: [],
            totalExplainedEnergy: 0,
            finalResidual: new Float32Array(dim),
            features: { depth: 0, coverage: 0, novelty: 1, coherence: 0, tagMemoActivation: 0 }
        };
    }
}

module.exports = ResidualPyramid;