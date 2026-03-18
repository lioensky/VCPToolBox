// Plugin/RAGDiaryPlugin/MetaThinkingManager.js
// VCP元思考递归推理链管理器

const fs = require('fs').promises;
const path = require('path');

class MetaThinkingManager {
    constructor(ragPlugin) {
        this.ragPlugin = ragPlugin;
        this.metaThinkingChains = { chains: {} };
        this.metaChainThemeVectors = {};
        this._loadPromise = null;
    }

    async loadConfig() {
        if (this._loadPromise) return this._loadPromise;

        this._loadPromise = (async () => {
            // --- 加载元思考链配置 ---
            try {
                const metaChainPath = path.join(__dirname, 'meta_thinking_chains.json');
                const metaChainData = await fs.readFile(metaChainPath, 'utf-8');
                this.metaThinkingChains = JSON.parse(metaChainData);
                console.log(`[MetaThinkingManager] 成功加载元思考链配置，包含 ${Object.keys(this.metaThinkingChains.chains || {}).length} 个链定义。`);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    console.log('[MetaThinkingManager] 未找到 meta_thinking_chains.json，元思考功能将不可用。');
                } else {
                    console.error('[MetaThinkingManager] 加载元思考链配置时发生错误:', error.message);
                }
                this.metaThinkingChains = { chains: {} };
            }

            // --- 加载并缓存元思考链主题向量 ---
            try {
                const metaChainPath = path.join(__dirname, 'meta_thinking_chains.json');
                const metaChainCachePath = path.join(__dirname, 'meta_chain_vector_cache.json');
                const currentMetaChainHash = await this.ragPlugin._getFileHash(metaChainPath);

                if (currentMetaChainHash) {
                    let cache = null;
                    try {
                        const cacheData = await fs.readFile(metaChainCachePath, 'utf-8');
                        cache = JSON.parse(cacheData);
                    } catch (e) {
                        // Cache not found or corrupt
                    }

                    if (cache && cache.sourceHash === currentMetaChainHash) {
                        console.log('[MetaThinkingManager] 元思考链主题向量缓存有效，从磁盘加载...');
                        this.metaChainThemeVectors = cache.vectors;
                        console.log(`[MetaThinkingManager] 成功从缓存加载 ${Object.keys(this.metaChainThemeVectors).length} 个主题向量。`);
                    } else {
                        if (this.metaThinkingChains.chains && Object.keys(this.metaThinkingChains.chains).length > 0) {
                            console.log('[MetaThinkingManager] 元思考链配置已更新或缓存无效，正在重建主题向量...');
                            await this._buildAndSaveMetaChainThemeCache(currentMetaChainHash, metaChainCachePath);
                        }
                    }
                }
            } catch (error) {
                console.error('[MetaThinkingManager] 加载或构建元思考链主题向量时发生错误:', error.message);
            }
        })();

        return this._loadPromise;
    }

    async _buildAndSaveMetaChainThemeCache(configHash, cachePath) {
        console.log('[MetaThinkingManager] 正在为所有元思考链主题请求 Embedding API...');
        this.metaChainThemeVectors = {}; // 清空旧的内存缓存

        const chainNames = Object.keys(this.metaThinkingChains.chains || {});

        for (const chainName of chainNames) {
            // 关键：跳过 'default' 主题，因为它不是自动切换的目标
            if (chainName === 'default') {
                continue;
            }

            const themeVector = await this.ragPlugin.getSingleEmbeddingCached(chainName);
            if (themeVector) {
                this.metaChainThemeVectors[chainName] = themeVector;
                console.log(`[MetaThinkingManager] -> 已为元思考主题 "${chainName}" 成功获取向量。`);
            } else {
                console.error(`[MetaThinkingManager] -> 为元思考主题 "${chainName}" 获取向量失败。`);
            }
        }

        const newCache = {
            sourceHash: configHash,
            createdAt: new Date().toISOString(),
            vectors: this.metaChainThemeVectors,
        };

        try {
            await fs.writeFile(cachePath, JSON.stringify(newCache, null, 2), 'utf-8');
            console.log(`[MetaThinkingManager] 元思考链主题向量缓存已成功写入到 ${cachePath}`);
        } catch (writeError) {
            console.error('[MetaThinkingManager] 写入元思考链主题向量缓存文件失败:', writeError);
        }
    }

    /**
     * 处理VCP元思考链 - 递归向量增强的多阶段推理
     */
    async processMetaThinkingChain(chainName, queryVector, userContent, aiContent, combinedQueryForDisplay, kSequence, useGroup, isAutoMode = false, autoThreshold = 0.65) {

        // 🌟 兜底：如果配置尚未加载，先执行加载
        if (!this.metaThinkingChains.chains || Object.keys(this.metaThinkingChains.chains).length === 0) {
            console.log(`[MetaThinkingManager] 检测到配置未就绪，正在触发兜底加载...`);
            await this.loadConfig();
        }
        let finalChainName = chainName;
        if (isAutoMode) {
            let bestChain = 'default';
            let maxSimilarity = -1;

            const themeEntries = Object.entries(this.metaChainThemeVectors);
            if (themeEntries.length === 0) {
                console.log(`[MetaThinkingManager][Auto] 未加载任何主题向量，将使用默认主题。`);
            }

            for (const [themeName, themeVector] of themeEntries) {
                const similarity = this.ragPlugin.cosineSimilarity(queryVector, themeVector);
                if (similarity > maxSimilarity) {
                    maxSimilarity = similarity;
                    bestChain = themeName;
                }
            }

            console.log(`[MetaThinkingManager][Auto] 最匹配的主题是 "${bestChain}"，相似度: ${maxSimilarity.toFixed(4)}`);

            if (maxSimilarity >= autoThreshold) {
                finalChainName = bestChain;
                console.log(`[MetaThinkingManager][Auto] 相似度超过阈值 ${autoThreshold}，切换到主题: ${finalChainName}`);
            } else {
                finalChainName = 'default';
                console.log(`[MetaThinkingManager][Auto] 相似度未达到阈值，使用默认主题: ${finalChainName}`);
            }
        }

        console.log(`[MetaThinkingManager] 开始处理元思考链: ${finalChainName}`);

        // 获取思维链配置
        const chainConfig = this.metaThinkingChains.chains[finalChainName];
        if (!chainConfig || !chainConfig.clusters || !chainConfig.kSequence) {
            console.error(`[MetaThinkingManager] 未找到完整的思维链配置: ${finalChainName}`);
            return `[错误: 未找到"${finalChainName}"思维链配置]`;
        }

        const chain = chainConfig.clusters;
        const finalKSequence = [...chainConfig.kSequence]; // 复制数组避免修改原配置

        if (!Array.isArray(chain) || chain.length === 0) {
            console.error(`[MetaThinkingManager] 思维链簇定义为空: ${finalChainName}`);
            return `[错误: "${finalChainName}"思维链簇定义为空]`;
        }

        if (!Array.isArray(finalKSequence) || finalKSequence.length === 0) {
            console.error(`[MetaThinkingManager] K序列定义为空: ${finalChainName}`);
            return `[错误: "${finalChainName}"K序列定义为空]`;
        }

        // 验证K值序列长度
        if (finalKSequence.length !== chain.length) {
            console.warn(`[MetaThinkingManager] K值序列长度(${finalKSequence.length})与簇数量(${chain.length})不匹配`);
            return `[错误: "${finalChainName}"的K序列长度与簇数量不匹配]`;
        }

        console.log(`[MetaThinkingManager] 使用K序列: [${finalKSequence.join(', ')}]`);

        // 1️⃣ 生成缓存键（使用最终确定的链名称和K序列）
        const cacheKey = this.ragPlugin._generateCacheKey({
            userContent,
            aiContent: aiContent || '',
            chainName: finalChainName,
            kSequence: finalKSequence,
            useGroup,
            isAutoMode
        });

        // 2️⃣ 尝试从缓存获取
        const cachedResult = this.ragPlugin._getCachedResult(cacheKey);
        if (cachedResult) {
            if (this.ragPlugin.pushVcpInfo && cachedResult.vcpInfo) {
                try {
                    this.ragPlugin.pushVcpInfo({
                        ...cachedResult.vcpInfo,
                        fromCache: true
                    });
                } catch (e) {
                    console.error('[MetaThinkingManager] Cache hit broadcast failed:', e.message || e);
                }
            }
            return cachedResult.content;
        }

        // 3️⃣ 缓存未命中，执行原有逻辑
        console.log(`[MetaThinkingManager] 缓存未命中，执行元思考链...`);

        // 初始化
        let currentQueryVector = queryVector;
        const chainResults = [];
        const chainDetailedInfo = []; // 用于VCP Info广播

        // 如果启用语义组，获取激活的组
        let activatedGroups = null;
        if (useGroup) {
            activatedGroups = this.ragPlugin.semanticGroups.detectAndActivateGroups(userContent);
            if (activatedGroups.size > 0) {
                const enhancedVector = await this.ragPlugin.semanticGroups.getEnhancedVector(userContent, activatedGroups, currentQueryVector);
                if (enhancedVector) {
                    currentQueryVector = enhancedVector;
                    console.log(`[MetaThinkingManager] 语义组已激活，查询向量已增强`);
                }
            }
        }

        // 递归遍历每个思维簇
        for (let i = 0; i < chain.length; i++) {
            const clusterName = chain[i];
            // 使用配置文件中定义的k序列
            const k = finalKSequence[i];

            try {
                // 使用当前查询向量搜索当前簇
                const searchResults = await this.ragPlugin.vectorDBManager.search(clusterName, currentQueryVector, k);

                if (!searchResults || searchResults.length === 0) {
                    console.warn(`[MetaThinkingManager] 阶段${i + 1}未找到结果，使用原始查询向量继续`);
                    chainResults.push({
                        clusterName,
                        stage: i + 1,
                        results: [],
                        k: k,
                        degraded: true // 标记为降级模式
                    });
                    // currentQueryVector 保持不变，继续下一阶段
                    continue;
                }

                // 存储当前阶段结果
                chainResults.push({ clusterName, stage: i + 1, results: searchResults, k: k });

                // 用于VCP Info的详细信息
                chainDetailedInfo.push({
                    stage: i + 1,
                    clusterName,
                    k,
                    resultCount: searchResults.length,
                    results: searchResults.map(r => ({ text: r.text, score: r.score }))
                });

                // 关键步骤：向量融合，为下一阶段准备查询向量
                if (i < chain.length - 1) {
                    const resultVectors = [];
                    for (const result of searchResults) {
                        // 🌟 关键修复：searchResults 中的对象可能包含 vector 属性，优先使用以减少数据库查询
                        let vector = result.vector;
                        if (!vector) {
                            vector = await this.ragPlugin.vectorDBManager.getVectorByText(clusterName, result.text);
                        }

                        if (vector) {
                            // 确保 vector 是数组格式
                            const vectorArray = Array.isArray(vector) ? vector : (typeof vector === 'string' ? JSON.parse(vector) : Object.values(vector));
                            resultVectors.push(vectorArray);
                        }
                    }

                    if (resultVectors.length > 0) {
                        const avgResultVector = this._getAverageVector(resultVectors);
                        const config = this.ragPlugin.ragParams?.RAGDiaryPlugin || {};
                        const metaWeights = config.metaThinkingWeights || [0.8, 0.2];
                        
                        currentQueryVector = this.ragPlugin._getWeightedAverageVector(
                            [queryVector, avgResultVector],
                            metaWeights
                        );
                    } else {
                        console.warn(`[MetaThinkingManager] 无法获取结果向量，中断递归`);
                        break;
                    }
                }
            } catch (error) {
                console.error(`[MetaThinkingManager] 处理簇"${clusterName}"时发生错误:`, error.message);
                chainResults.push({
                    clusterName,
                    stage: i + 1,
                    results: [],
                    k: k,
                    error: error.message || '未知错误'
                });
                break;
            }
        }

        // VCP Info 广播：发送完整的思维链执行详情
        let vcpInfoData = null;
        if (this.ragPlugin.pushVcpInfo) {
            try {
                vcpInfoData = {
                    type: 'META_THINKING_CHAIN',
                    chainName: finalChainName,
                    query: combinedQueryForDisplay,
                    useGroup,
                    activatedGroups: activatedGroups ? Array.from(activatedGroups.keys()) : [],
                    stages: chainDetailedInfo,
                    totalStages: chain.length,
                    kSequence: finalKSequence,
                    // 🌟 限制广播结果长度
                    stages: chainDetailedInfo
                };
                this.ragPlugin.pushVcpInfo(vcpInfoData);
            } catch (broadcastError) {
                console.error(`[MetaThinkingManager] VCP Info 广播失败:`, broadcastError.message || broadcastError);
            }
        }

        // 4️⃣ 保存到缓存
        const formattedResult = this._formatMetaThinkingResults(chainResults, finalChainName, activatedGroups, isAutoMode);
        this.ragPlugin._setCachedResult(cacheKey, {
            content: formattedResult,
            vcpInfo: vcpInfoData
        });

        return formattedResult;
    }

    /**
     * 计算多个向量的平均值
     */
    _getAverageVector(vectors) {
        if (!vectors || vectors.length === 0) return null;
        if (vectors.length === 1) return vectors[0];

        const dimension = vectors[0].length;
        const result = new Array(dimension).fill(0);

        for (const vector of vectors) {
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
     * 格式化元思考链结果
     */
    _formatMetaThinkingResults(chainResults, chainName, activatedGroups, isAutoMode = false) {
        let content = `\n[--- VCP元思考链: "${chainName}" ${isAutoMode ? '(Auto模式)' : ''} ---]\n`;

        if (activatedGroups && activatedGroups.size > 0) {
            content += `[语义组增强: `;
            const groupNames = [];
            for (const [groupName, data] of activatedGroups) {
                groupNames.push(`${groupName}(${(data.strength * 100).toFixed(0)}%)`);
            }
            content += groupNames.join(', ') + ']\n';
        }

        if (isAutoMode) {
            content += `[自动选择主题: "${chainName}"]\n`;
        }
        content += `[推理链路径: ${chainResults.map(r => r.clusterName).join(' → ')}]\n\n`;

        // 输出每个阶段的结果
        for (const stageResult of chainResults) {
            content += `【阶段${stageResult.stage}: ${stageResult.clusterName}】`;
            if (stageResult.degraded) {
                content += ` [降级模式]\n`;
            } else {
                content += '\n';
            }

            if (stageResult.error) {
                content += `  [错误: ${stageResult.error}]\n`;
            } else if (stageResult.results.length === 0) {
                content += `  [未找到匹配的元逻辑模块]\n`;
            } else {
                content += `  [召回 ${stageResult.results.length} 个元逻辑模块]\n`;
                for (const result of stageResult.results) {
                    content += `  * ${result.text.trim()}\n`;
                }
            }
            content += '\n';
        }

        content += `[--- 元思考链结束 ---]\n`;
        return content;
    }
}

module.exports = MetaThinkingManager;