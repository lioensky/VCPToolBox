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

            const chainConfig = this.metaThinkingChains.chains[chainName];
            const embeddingText = (typeof chainConfig === 'object' && chainConfig?.description) || chainName;
            const themeVector = await this.ragPlugin.getSingleEmbeddingCached(embeddingText);
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
    async processMetaThinkingChain(chainName, queryVector, userContent, aiContent, combinedQueryForDisplay, kSequence, useGroup, isAutoMode = false, autoThreshold = 0.65, autoWhitelist = null, autoBlacklist = null, riverOptions = null) {

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
                // 🌟 白名单/黑名单过滤
                if (autoWhitelist && !autoWhitelist.includes(themeName)) continue;
                if (autoBlacklist && autoBlacklist.includes(themeName)) continue;
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

        // 请求级观测优先使用 Sense 构链；没有观测时仍允许走 Rust 原生
        // 多索引 ANN，避免为元思考再走一遍 JS search 往返。
        if (riverOptions?.getObservation) {
            try {
                const prepared = await riverOptions.getObservation();
                if (!prepared && riverOptions.searchNativeCandidates) {
                    const nativeResults = [];
                    let groups = null;
                    let nativeVector = queryVector;
                    if (useGroup) {
                        groups = this.ragPlugin.semanticGroups.detectAndActivateGroups(userContent);
                        if (groups.size > 0) {
                            nativeVector = await this.ragPlugin.semanticGroups.getEnhancedVector(
                                userContent, groups, queryVector
                            ) || queryVector;
                        }
                    }
                    for (let i = 0; i < chain.length; i++) {
                        const k = finalKSequence[i];
                        const candidates = k === 0
                            ? []
                            : await riverOptions.searchNativeCandidates(
                                chain[i],
                                nativeVector,
                                {
                                    perIndexK: Math.max(k, riverOptions.config.candidateK),
                                    globalK: Math.max(k, riverOptions.config.candidateK)
                                }
                            );
                        nativeResults.push({
                            clusterName: chain[i],
                            stage: i + 1,
                            k,
                            results: candidates.slice(0, k),
                            nativeAnn: true
                        });
                    }
                    const nativeFormatted = this._formatMetaThinkingResults(
                        nativeResults, finalChainName, groups, isAutoMode
                    );
                    try {
                        this.ragPlugin.pushVcpInfo?.({
                            type: 'META_THINKING_CHAIN',
                            chainName: finalChainName,
                            query: combinedQueryForDisplay,
                            useGroup,
                            engine: 'knn-native-ann',
                            kSequence: finalKSequence,
                            totalStages: chain.length,
                            stages: nativeResults.map(stage => ({
                                ...stage,
                                results: stage.results.map(result => ({
                                    text: this._stripTagMetadata(result.text),
                                    score: result.score
                                }))
                            }))
                        });
                    } catch (error) {
                        console.warn('[MetaThinkingManager] Native ANN broadcast failed:', error.message);
                    }
                    return nativeFormatted;
                }
                if (prepared) {
                    const config = riverOptions.config;
                    if (chain.length > 32 || finalKSequence.some(k =>
                        !Number.isSafeInteger(k) || k < 0 || k > 32
                    )) throw new Error('阶段或 K 超过原生构链预算');
                    let candidateVector = queryVector;
                    let groups = null;
                    if (useGroup) {
                        groups = this.ragPlugin.semanticGroups.detectAndActivateGroups(userContent);
                        if (groups.size > 0) {
                            candidateVector = await this.ragPlugin.semanticGroups.getEnhancedVector(
                                userContent, groups, queryVector
                            ) || queryVector;
                        }
                    }
                    const stages = [];
                    // 有界串行召回，避免大量思维簇同时加载索引。
                    for (let i = 0; i < chain.length; i++) {
                        const k = finalKSequence[i];
                        const candidates = k === 0 ? [] : await this.ragPlugin.vectorDBManager.searchKnn(
                            chain[i], candidateVector,
                            Math.min(256, Math.max(k, config.candidateK)), 0
                        );
                        stages.push({ diaryName: chain[i], k, candidates });
                    }
                    const plan = await this.ragPlugin.vectorDBManager.planRiverThinking(
                        prepared, stages, { minClosure: config.minClosure }
                    );
                    const results = plan.stages.map((stage, index) => ({
                        clusterName: stage.diaryName,
                        stage: index + 1,
                        k: stage.k,
                        results: stage.results
                    }));
                    const formatted = this._formatMetaThinkingResults(
                        results, finalChainName, groups, isAutoMode
                    );
                    try {
                        this.ragPlugin.pushVcpInfo?.({
                            type: 'META_THINKING_CHAIN',
                            chainName: finalChainName,
                            query: combinedQueryForDisplay,
                            useGroup,
                            engine: 'rivermemo-sense',
                            artifactSig: plan.artifactSig,
                            kSequence: finalKSequence,
                            totalStages: chain.length,
                            stages: results.map(stage => ({
                                ...stage,
                                results: stage.results.map(result => ({
                                    text: this._stripTagMetadata(result.text),
                                    score: result.riverThinking?.score,
                                    riverThinking: result.riverThinking
                                }))
                            }))
                        });
                    } catch (error) {
                        console.warn('[MetaThinkingManager] River broadcast failed:', error.message);
                    }
                    return formatted;
                }
            } catch (error) {
                // Sense 已存在但没有形成可承接的思维路径时，
                // 降级到 Rust 原生 ANN，而不是立即回到 JS search。
                if (riverOptions?.searchNativeCandidates) {
                    try {
                        const nativeResults = [];
                        let groups = null;
                        let nativeVector = queryVector;
                        if (useGroup) {
                            groups = this.ragPlugin.semanticGroups.detectAndActivateGroups(userContent);
                            if (groups.size > 0) {
                                nativeVector = await this.ragPlugin.semanticGroups.getEnhancedVector(
                                    userContent, groups, queryVector
                                ) || queryVector;
                            }
                        }
                        for (let i = 0; i < chain.length; i++) {
                            const k = finalKSequence[i];
                            const candidates = k === 0
                                ? []
                                : await riverOptions.searchNativeCandidates(
                                    chain[i],
                                    nativeVector,
                                    {
                                        perIndexK: Math.max(k, riverOptions.config.candidateK),
                                        globalK: Math.max(k, riverOptions.config.candidateK)
                                    }
                                );
                            nativeResults.push({
                                clusterName: chain[i],
                                stage: i + 1,
                                k,
                                results: candidates.slice(0, k),
                                nativeAnn: true,
                                degraded: true
                            });
                        }
                        const nativeFormatted = this._formatMetaThinkingResults(
                            nativeResults, finalChainName, groups, isAutoMode
                        );
                        this.ragPlugin.pushVcpInfo?.({
                            type: 'META_THINKING_CHAIN',
                            chainName: finalChainName,
                            query: combinedQueryForDisplay,
                            useGroup,
                            engine: 'knn-native-ann',
                            fallbackFrom: 'rivermemo-sense',
                            fallbackReason: error.message,
                            kSequence: finalKSequence,
                            totalStages: chain.length,
                            stages: nativeResults
                        });
                        console.warn(
                            `[MetaThinkingManager] River Sense had no grounded route; ` +
                            `degraded to native ANN: ${error.message}`
                        );
                        return nativeFormatted;
                    } catch (nativeError) {
                        console.warn(
                            `[MetaThinkingManager] Native ANN fallback failed: ${nativeError.message}`
                        );
                    }
                }
                console.warn(`[MetaThinkingManager] River thinking fallback to legacy:`, error.message);
            }
        }

        // 1️⃣ 生成缓存键（使用最终确定的链名称和K序列）
        const cacheKey = this.ragPlugin._generateCacheKey({
            userContent,
            aiContent: aiContent || '',
            chainName: `${finalChainName}:tagless-v1:${JSON.stringify(chain)}`,
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
                const searchResults = k === 0 ? [] : await this.ragPlugin.vectorDBManager.searchKnn(clusterName, currentQueryVector, k);

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
     * 只移除末尾连续 Tag 元数据行，与知识库标签提取边界一致。
     * 保留正文中的示例、行内 Tag 文本以及闭合代码块中的内容。
     */
    _stripTagMetadata(text) {
        const lines = String(text || '').split(/\r?\n/);
        let end = lines.length - 1;
        while (end >= 0 && !lines[end].trim()) end--;
        let start = end;
        while (start >= 0 && /^[ \t]*Tag[：:][^\r\n]*$/i.test(lines[start])) start--;
        if (start === end) return String(text || '').trim();
        // 不擦除未闭合代码围栏内的示例。
        let fence = null;
        for (let i = 0; i <= start; i++) {
            const match = lines[i].match(/^[ \t]*(`{3,}|~{3,})/);
            if (!match) continue;
            if (!fence) fence = match[1];
            else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
        }
        return fence ? String(text || '').trim() : lines.slice(0, start + 1).join('\n').trim();
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
        const riverMode = chainResults.some(stage => stage.results.some(r => r.riverThinking));
        content += `[${riverMode ? '阶段配额顺序' : '推理链路径'}: ${chainResults.map(r => r.clusterName).join(' → ')}]\n\n`;
        if (riverMode) {
            content += '[Sense传播支持的方法框架：承接表示语义渠道支持，不代表形式逻辑证明；补充模块不构成依赖。]\n';
        }

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
                    const body = this._stripTagMetadata(result.text);
                    if (!body) continue;
                    const route = result.riverThinking;
                    if (route) {
                        const labels = {
                            root: '起始渠道', continuation: '渠道承接',
                            analogy: '类比迁移（需验证）', supplement: '独立补充'
                        };
                        const parents = route.parents?.length
                            ? `；承接模块 ${route.parents.join(', ')}` : '';
                        content += `  [模块 ${route.chunkId}：${labels[route.relation] || '独立补充'}${parents}]\n`;
                    }
                    content += `  * ${body}\n`;
                }
            }
            content += '\n';
        }

        content += `[--- 元思考链结束 ---]\n`;
        return content;
    }

    /**
     * 解析 V3 专属星池目录集合（与旧版 meta_thinking_chains.json 彻底隔离，绝不混入旧簇）
     */
    _resolveV3StarPoolDiaries(poolScope) {
        const explicit = String(poolScope || '')
            .split(/[|,，]/)
            .map(s => s.trim())
            .filter(Boolean);
        return explicit.length > 0 ? [...new Set(explicit)] : ['希夷星池簇'];
    }

    /**
     * 从文件名或候选块中提纯 V3 本征概念核名称（文件名即星名，正文无需 @Star 前缀）
     */
    _extractV3StarName(candidate) {
        const rawFile = String(candidate?.sourceFile || candidate?.fullPath || '').trim();
        if (rawFile) {
            let base = path.basename(rawFile).replace(/\.(?:md|txt)$/i, '');
            base = base
                .replace(/^(?:锦囊[一二三四五六七八九十百千万\d]+_|(?:\d+[_-]))/u, '')
                .replace(/\s*[（(][^）)]*[）)]\s*$/u, '')
                .trim();
            if (base && !/^\d{4}-\d{2}-\d{2}/.test(base)) {
                return base;
            }
        }

        const text = String(candidate?.text || '').trim();
        if (text) {
            const firstLine = text.split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
            const bracketMatch = firstLine.match(/^【([^】]+)】/) || firstLine.match(/^#\s+(.+)$/);
            if (bracketMatch && bracketMatch[1]) {
                let title = bracketMatch[1].trim();
                title = title
                    .replace(/^(?:思考模块|思维模块|锦囊[一二三四五六七八九十百千万\d]+)[：:\s]*/u, '')
                    .replace(/^RP-\d+[a-z]*\s+/i, '')
                    .replace(/\s*[（(][^）)]*[）)]\s*$/u, '')
                    .trim();
                if (title) return title;
            }
        }
        return text ? text.slice(0, 12).replace(/\s+/g, '') : '';
    }

    _v3NormalizeVector(vec) {
        if (!vec || typeof vec.length !== 'number' || vec.length === 0) return null;
        let normSq = 0;
        for (let i = 0; i < vec.length; i++) {
            const v = Number(vec[i]);
            if (!Number.isFinite(v)) return null;
            normSq += v * v;
        }
        if (normSq <= 1e-12) return null;
        const inv = 1 / Math.sqrt(normSq);
        const out = new Float32Array(vec.length);
        for (let i = 0; i < vec.length; i++) {
            out[i] = vec[i] * inv;
        }
        return out;
    }

    _v3Dot(a, b) {
        if (!a || !b || a.length !== b.length) return 0;
        let sum = 0;
        const len = a.length;
        const limit = len - 3;
        let i = 0;
        for (; i < limit; i += 4) {
            sum += a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3];
        }
        for (; i < len; i++) {
            sum += a[i] * b[i];
        }
        return sum;
    }

    _v3DotFlat(a, flatMatrix, offset) {
        let sum = 0;
        const len = a.length;
        const limit = len - 3;
        let i = 0;
        for (; i < limit; i += 4) {
            sum += a[i] * flatMatrix[offset + i]
                + a[i + 1] * flatMatrix[offset + i + 1]
                + a[i + 2] * flatMatrix[offset + i + 2]
                + a[i + 3] * flatMatrix[offset + i + 3];
        }
        for (; i < len; i++) {
            sum += a[i] * flatMatrix[offset + i];
        }
        return sum;
    }

    /**
     * 对称实矩阵特征分解（Householder 三对角化 + 隐式 QL 移位迭代），返回按特征值降序排列的 { eigenvalues, eigenvectors }。
     */
    _v3SymmetricEigenDecomp(symMatrix, n) {
        const z = new Float64Array(symMatrix);
        const d = new Float64Array(n);
        const e = new Float64Array(n);

        for (let i = n - 1; i >= 1; i--) {
            const l = i - 1;
            let h = 0;
            let scale = 0;
            if (l > 0) {
                for (let k = 0; k <= l; k++) scale += Math.abs(z[i * n + k]);
                if (scale === 0) {
                    e[i] = z[i * n + l];
                } else {
                    for (let k = 0; k <= l; k++) {
                        const v = z[i * n + k] / scale;
                        z[i * n + k] = v;
                        h += v * v;
                    }
                    const f = z[i * n + l];
                    const g = f >= 0 ? -Math.sqrt(h) : Math.sqrt(h);
                    e[i] = scale * g;
                    h -= f * g;
                    z[i * n + l] = f - g;
                    let fSum = 0;
                    for (let j = 0; j <= l; j++) {
                        z[j * n + i] = z[i * n + j] / h;
                        let gAcc = 0;
                        for (let k = 0; k <= j; k++) gAcc += z[j * n + k] * z[i * n + k];
                        for (let k = j + 1; k <= l; k++) gAcc += z[k * n + j] * z[i * n + k];
                        e[j] = gAcc / h;
                        fSum += e[j] * z[i * n + j];
                    }
                    const hh = fSum / (h + h);
                    for (let j = 0; j <= l; j++) {
                        const fVal = z[i * n + j];
                        const gVal = e[j] - hh * fVal;
                        e[j] = gVal;
                        for (let k = 0; k <= j; k++) {
                            z[j * n + k] -= fVal * e[k] + gVal * z[i * n + k];
                        }
                    }
                }
            } else {
                e[i] = z[i * n + l];
            }
            d[i] = h;
        }
        d[0] = 0;
        e[0] = 0;

        for (let i = 0; i < n; i++) {
            const l = i - 1;
            if (d[i] !== 0) {
                for (let j = 0; j <= l; j++) {
                    let gAcc = 0;
                    for (let k = 0; k <= l; k++) gAcc += z[i * n + k] * z[k * n + j];
                    for (let k = 0; k <= l; k++) z[k * n + j] -= gAcc * z[k * n + i];
                }
            }
            d[i] = z[i * n + i];
            z[i * n + i] = 1.0;
            for (let j = 0; j <= l; j++) {
                z[j * n + i] = 0.0;
                z[i * n + j] = 0.0;
            }
        }

        for (let i = 1; i < n; i++) e[i - 1] = e[i];
        e[n - 1] = 0;
        const pythag = (a, b) => {
            const absA = Math.abs(a);
            const absB = Math.abs(b);
            if (absA > absB) {
                const r = absB / absA;
                return absA * Math.sqrt(1 + r * r);
            }
            return absB === 0 ? 0 : absB * Math.sqrt(1 + (absA / absB) * (absA / absB));
        };
        for (let l = 0; l < n; l++) {
            let iter = 0;
            let m;
            do {
                for (m = l; m < n - 1; m++) {
                    const dd = Math.abs(d[m]) + Math.abs(d[m + 1]);
                    if (Math.abs(e[m]) + dd === dd) break;
                }
                if (m !== l) {
                    if (iter++ === 60) break;
                    let g = (d[l + 1] - d[l]) / (2 * e[l]);
                    let r = pythag(g, 1);
                    g = d[m] - d[l] + e[l] / (g + (g >= 0 ? Math.abs(r) : -Math.abs(r)));
                    let s = 1;
                    let c = 1;
                    let p = 0;
                    let i;
                    for (i = m - 1; i >= l; i--) {
                        const f = s * e[i];
                        const b = c * e[i];
                        r = pythag(f, g);
                        e[i + 1] = r;
                        if (r === 0) {
                            d[i + 1] -= p;
                            e[m] = 0;
                            break;
                        }
                        s = f / r;
                        c = g / r;
                        g = d[i + 1] - p;
                        r = (d[i] - g) * s + 2 * c * b;
                        p = s * r;
                        d[i + 1] = g + p;
                        g = c * r - b;
                        for (let k = 0; k < n; k++) {
                            const fz = z[k * n + i + 1];
                            z[k * n + i + 1] = s * z[k * n + i] + c * fz;
                            z[k * n + i] = c * z[k * n + i] - s * fz;
                        }
                    }
                    if (r === 0 && i >= l) continue;
                    d[l] -= p;
                    e[l] = g;
                    e[m] = 0;
                }
            } while (m !== l);
        }

        const order = Array.from({ length: n }, (_, idx) => idx).sort((a, b) => d[b] - d[a]);
        const eigenvalues = new Float64Array(n);
        const eigenvectors = new Float64Array(n * n);
        for (let col = 0; col < n; col++) {
            const src = order[col];
            eigenvalues[col] = d[src];
            for (let row = 0; row < n; row++) {
                eigenvectors[row * n + col] = z[row * n + src];
            }
        }
        return { eigenvalues, eigenvectors };
    }

    _v3ProjectToSubspace(vec, uk, k, d) {
        if (!vec || !uk || vec.length !== d || k <= 0) return null;
        const out = new Float32Array(k);
        let normSq = 0;
        const limit = d - 3;
        for (let r = 0; r < k; r++) {
            const uOff = r * d;
            let s0 = 0;
            let s1 = 0;
            let s2 = 0;
            let s3 = 0;
            let c = 0;
            for (; c < limit; c += 4) {
                s0 += uk[uOff + c] * vec[c];
                s1 += uk[uOff + c + 1] * vec[c + 1];
                s2 += uk[uOff + c + 2] * vec[c + 2];
                s3 += uk[uOff + c + 3] * vec[c + 3];
            }
            let sum = s0 + s1 + s2 + s3;
            for (; c < d; c++) sum += uk[uOff + c] * vec[c];
            out[r] = sum;
            normSq += sum * sum;
        }
        if (!Number.isFinite(normSq) || normSq <= 1e-18) return null;
        const inv = 1 / Math.sqrt(normSq);
        for (let r = 0; r < k; r++) out[r] *= inv;
        return out;
    }

    /**
     * 两阶段无损全息粗筛子空间构造（大星池 N·D >= 2000·3072 时触发）：
     * - 从等步长样本的 Gram 特征谱中自动导出累计方差 >= 1 - σ_pair 的截断维数 k（零硬编码维数）；
     * - 构建行正交基 U_k 与归一化的粗筛矩阵 zMatrixK ∈ R^{N×k}，用于 Top-M 无损粗筛后再回 3072 维精排。
     */
    _v3BuildCoarseSubspace(zMatrix, nStars, dim, pairStdCos = 0.089) {
        if (!zMatrix || nStars < 64 || dim < 64) return null;
        const subN = Math.min(nStars, 512);
        const subIdx = Array.from({ length: subN }, (_, i) => Math.floor((i * nStars) / subN));
        const gram = new Float64Array(subN * subN);
        const limit = dim - 3;
        for (let i = 0; i < subN; i++) {
            gram[i * subN + i] = 1.0;
            const offI = subIdx[i] * dim;
            for (let j = i + 1; j < subN; j++) {
                const offJ = subIdx[j] * dim;
                let s0 = 0;
                let s1 = 0;
                let s2 = 0;
                let s3 = 0;
                let c = 0;
                for (; c < limit; c += 4) {
                    s0 += zMatrix[offI + c] * zMatrix[offJ + c];
                    s1 += zMatrix[offI + c + 1] * zMatrix[offJ + c + 1];
                    s2 += zMatrix[offI + c + 2] * zMatrix[offJ + c + 2];
                    s3 += zMatrix[offI + c + 3] * zMatrix[offJ + c + 3];
                }
                let s = s0 + s1 + s2 + s3;
                for (; c < dim; c++) s += zMatrix[offI + c] * zMatrix[offJ + c];
                gram[i * subN + j] = s;
                gram[j * subN + i] = s;
            }
        }
        const eig = this._v3SymmetricEigenDecomp(gram, subN);
        let sumLam = 0;
        for (let i = 0; i < subN; i++) {
            if (eig.eigenvalues[i] > 0) sumLam += eig.eigenvalues[i];
        }
        if (sumLam <= 1e-12) return null;
        const effSigma = Number.isFinite(pairStdCos) && pairStdCos > 1e-4
            ? Math.min(0.4, pairStdCos)
            : (1 / Math.sqrt(Math.max(16, dim)));
        const targetVar = Math.max(0.6, Math.min(0.98, 1 - effSigma));
        let cum = 0;
        let kVar = 1;
        for (let i = 0; i < subN; i++) {
            cum += Math.max(0, eig.eigenvalues[i]);
            if (cum / sumLam >= targetVar) {
                kVar = i + 1;
                break;
            }
        }
        const kMin = Math.min(64, subN, dim);
        let k = Math.max(kMin, Math.min(subN, dim, kVar));
        let kValid = 0;
        for (let r = 0; r < k; r++) {
            if (eig.eigenvalues[r] > 1e-6) kValid = r + 1;
            else break;
        }
        k = Math.max(1, kValid);
        const uk = new Float32Array(k * dim);
        for (let r = 0; r < k; r++) {
            const lam = Math.max(0, eig.eigenvalues[r]);
            if (lam <= 1e-6) continue;
            const invSig = 1 / Math.sqrt(lam);
            const uOff = r * dim;
            for (let i = 0; i < subN; i++) {
                const w = eig.eigenvectors[i * subN + r] * invSig;
                const zOff = subIdx[i] * dim;
                for (let c = 0; c < dim; c++) uk[uOff + c] += w * zMatrix[zOff + c];
            }
            let rowNormSq = 0;
            for (let c = 0; c < dim; c++) rowNormSq += uk[uOff + c] * uk[uOff + c];
            if (rowNormSq > 1e-12) {
                const rowInv = 1 / Math.sqrt(rowNormSq);
                for (let c = 0; c < dim; c++) uk[uOff + c] *= rowInv;
            } else {
                uk.fill(0, uOff, uOff + dim);
            }
        }

        const zMatrixK = new Float32Array(nStars * k);
        for (let i = 0; i < nStars; i++) {
            const zOff = i * dim;
            const kOff = i * k;
            let normSq = 0;
            for (let r = 0; r < k; r++) {
                const uOff = r * dim;
                let s0 = 0;
                let s1 = 0;
                let s2 = 0;
                let s3 = 0;
                let c = 0;
                for (; c < limit; c += 4) {
                    s0 += uk[uOff + c] * zMatrix[zOff + c];
                    s1 += uk[uOff + c + 1] * zMatrix[zOff + c + 1];
                    s2 += uk[uOff + c + 2] * zMatrix[zOff + c + 2];
                    s3 += uk[uOff + c + 3] * zMatrix[zOff + c + 3];
                }
                let s = s0 + s1 + s2 + s3;
                for (; c < dim; c++) s += uk[uOff + c] * zMatrix[zOff + c];
                zMatrixK[kOff + r] = s;
                normSq += s * s;
            }
            if (normSq > 1e-18) {
                const inv = 1 / Math.sqrt(normSq);
                for (let r = 0; r < k; r++) zMatrixK[kOff + r] *= inv;
            }
        }
        return { k, subN, targetVar, uk, zMatrixK };
    }

    _v3CoarseSelectTopIndices(scores, count, topM) {
        const m = Math.max(1, Math.min(count, topM));
        const topIdx = new Int32Array(m);
        const topVal = new Float32Array(m).fill(-Infinity);
        let minPos = 0;
        let minVal = -Infinity;
        for (let i = 0; i < count; i++) {
            const sc = scores[i];
            if (sc > minVal) {
                topIdx[minPos] = i;
                topVal[minPos] = sc;
                minPos = 0;
                minVal = topVal[0];
                for (let t = 1; t < m; t++) {
                    if (topVal[t] < minVal) {
                        minVal = topVal[t];
                        minPos = t;
                    }
                }
            }
        }
        return topIdx;
    }

    _v3WeightedCentroid(items) {
        let acc = null;
        for (const item of Array.isArray(items) ? items : []) {
            const unit = this._v3NormalizeVector(item?.vector);
            const weight = Number(item?.weight);
            if (!unit || !Number.isFinite(weight) || weight <= 0) continue;
            if (!acc) acc = new Float64Array(unit.length);
            if (unit.length !== acc.length) continue;
            for (let i = 0; i < acc.length; i++) {
                acc[i] += unit[i] * weight;
            }
        }
        return acc ? this._v3NormalizeVector(acc) : null;
    }

    _v3GramSchmidtOrthogonal(target, axis) {
        const t = this._v3NormalizeVector(target);
        const a = this._v3NormalizeVector(axis);
        if (!t) return null;
        if (!a || t.length !== a.length) return t;
        const proj = this._v3Dot(t, a);
        const residual = new Float64Array(t.length);
        for (let i = 0; i < t.length; i++) {
            residual[i] = t[i] - proj * a[i];
        }
        return this._v3NormalizeVector(residual);
    }

    /**
     * 精确二维子空间正交投影剥离（2×2 Gram 最小二乘 + 近共线对称角平分线）：
     * - 一次性扣除 span(axis1, axis2) 平面分量，严格满足双轴换序对称与零泄漏；
     * - 当两轴近平行或反平行（det <= 1e-6·aa·bb）时，对齐符号后沿对称角平分线作一维剥离，避免近奇异矩阵求逆误差；
     * - 当 preserveMagnitude=true 时保留 target 真实模长（供阻尼后的日记向量一步量出总残差）；
     * - 若残差模长 novelty <= 1e-6 或 < minNorm，返回 vector: null，绝不放大噪声或回退原向量。
     */
    _v3OrthogonalizePlane(target, axis1, axis2 = null, minNorm = 0.12, preserveMagnitude = false) {
        if (!target || typeof target.length !== 'number' || target.length === 0) {
            return { vector: null, novelty: 0 };
        }
        let cur;
        if (preserveMagnitude) {
            let normSq = 0;
            for (let i = 0; i < target.length; i++) {
                const v = Number(target[i]);
                if (!Number.isFinite(v)) return { vector: null, novelty: 0 };
                normSq += v * v;
            }
            if (normSq <= 1e-12) return { vector: null, novelty: 0 };
            cur = target;
        } else {
            cur = this._v3NormalizeVector(target);
            if (!cur) return { vector: null, novelty: 0 };
        }

        const validA1 = (axis1 && axis1.length === cur.length) ? axis1 : null;
        const validA2 = (axis2 && axis2.length === cur.length) ? axis2 : null;
        const a = validA1 || validA2;
        const b = (validA1 && validA2) ? validA2 : null;

        const aa = a ? this._v3Dot(a, a) : 0;
        const bb = b ? this._v3Dot(b, b) : 0;
        const ab = (a && b) ? this._v3Dot(a, b) : 0;
        const ca = a ? this._v3Dot(cur, a) : 0;
        const cb = b ? this._v3Dot(cur, b) : 0;
        const det = aa * bb - ab * ab;

        let u = 0;
        let v = 0;
        if (a && b && det > 1e-6 * aa * bb) {
            u = (bb * ca - ab * cb) / det;
            v = (aa * cb - ab * ca) / det;
        } else if (a && b && aa > 0 && bb > 0) {
            // Rank-1 近平行/反平行退化：对齐符号后沿对称角平分线剥离，保持双轴换序完全对称
            const sign = ab < 0 ? -1 : 1;
            const na = Math.sqrt(aa);
            const nb = Math.sqrt(bb);
            const k = (ca / na + sign * cb / nb) / (2 + (2 * Math.abs(ab)) / (na * nb));
            u = k / na;
            v = (sign * k) / nb;
        } else if (a && aa > 0) {
            u = ca / aa;
        }

        const residual = new Float64Array(cur.length);
        let resNormSq = 0;
        for (let i = 0; i < cur.length; i++) {
            let val = cur[i];
            if (a) val -= u * a[i];
            if (b) val -= v * b[i];
            residual[i] = val;
            resNormSq += val * val;
        }
        const novelty = Math.sqrt(Math.max(0, resNormSq));
        if (novelty <= 1e-6 || novelty < minNorm) {
            return { vector: null, novelty };
        }
        const inv = 1 / novelty;
        const out = new Float32Array(cur.length);
        for (let i = 0; i < cur.length; i++) out[i] = residual[i] * inv;
        return { vector: out, novelty: Math.min(1, novelty) };
    }

    _v3DedupeCandidates(candidates) {
        const merged = new Map();
        for (const item of Array.isArray(candidates) ? candidates : []) {
            const starName = this._extractV3StarName(item);
            if (!starName) continue;
            const existing = merged.get(starName);
            if (!existing) {
                merged.set(starName, { item, starName });
                continue;
            }
            // 同名星保留更高 RiverMemo 综合分的一份，并融合更高拓扑/场指标
            const prevScore = Number(existing.item?.score) || 0;
            const nextScore = Number(item?.score) || 0;
            if (nextScore > prevScore) {
                merged.set(starName, { item, starName });
            }
        }
        return Array.from(merged.values());
    }

    async _v3FetchChunkVectors(vdb, chunkIds, vectorCache) {
        if (typeof vdb?.getVectorByChunkId !== 'function') return vectorCache;
        const missing = [];
        const seen = new Set();
        for (const rawId of chunkIds) {
            const id = Number(rawId);
            if (!Number.isSafeInteger(id) || id <= 0) continue;
            if (vectorCache.has(id) || seen.has(id)) continue;
            seen.add(id);
            missing.push(id);
        }
        if (missing.length === 0) return vectorCache;
        await Promise.all(missing.map(async id => {
            try {
                const raw = await vdb.getVectorByChunkId(id);
                const unit = this._v3NormalizeVector(raw);
                vectorCache.set(id, unit);
            } catch (_) {
                vectorCache.set(id, null);
            }
        }));
        return vectorCache;
    }

    /**
     * 精确二维非负锥投影能量 ‖Π_{cone(u1, u2)}(vec)‖²（闭式 2×2 NNLS，零迭代）
     */
    _v3ConeProjSq2(b1, b2, g12) {
        const det = 1 - g12 * g12;
        let projSq = 0;
        if (det > 1e-8) {
            const a1 = (b1 - g12 * b2) / det;
            const a2 = (b2 - g12 * b1) / det;
            if (a1 >= 0 && a2 >= 0) {
                projSq = a1 * b1 + a2 * b2;
            } else {
                const p1 = Math.max(0, b1);
                const p2 = Math.max(0, b2);
                projSq = Math.max(p1 * p1, p2 * p2);
            }
        } else {
            const p1 = Math.max(0, b1);
            const p2 = Math.max(0, b2);
            projSq = Math.max(p1 * p1, p2 * p2);
        }
        return Math.max(0, Math.min(1, projSq));
    }

    /**
     * 精确三维非负锥投影能量 ‖Π_{cone(u1, u2, u3)}(vec)‖²（闭式 3×3 Active-Set NNLS，零迭代）：
     * 直接求 3×3 Gram 矩阵伴随解；若全非负则为内点精确最优，否则取 3 个二维面投影最大值。
     */
    _v3ConeProjSq3(b1, b2, b3, g12, g13, g23) {
        // 3×3 对称单位对角 Gram 矩阵余子式
        const c11 = 1 - g23 * g23;
        const c22 = 1 - g13 * g13;
        const c33 = 1 - g12 * g12;
        const c12 = g13 * g23 - g12;
        const c13 = g12 * g23 - g13;
        const c23 = g12 * g13 - g23;
        const det = c11 + g12 * c12 + g13 * c13;
        if (det > 1e-8) {
            const a1 = (c11 * b1 + c12 * b2 + c13 * b3) / det;
            const a2 = (c12 * b1 + c22 * b2 + c23 * b3) / det;
            const a3 = (c13 * b1 + c23 * b2 + c33 * b3) / det;
            if (a1 >= 0 && a2 >= 0 && a3 >= 0) {
                return Math.max(0, Math.min(1, a1 * b1 + a2 * b2 + a3 * b3));
            }
        }
        return Math.max(
            this._v3ConeProjSq2(b1, b2, g12),
            this._v3ConeProjSq2(b1, b3, g13),
            this._v3ConeProjSq2(b2, b3, g23)
        );
    }

    /**
     * 非负锥边际增量振幅 √I_q(B, z) = √(‖Π_{cone(B ∪ {z})}(q)‖² - ‖Π_{cone(B)}(q)‖²)
     * 借鉴狮子 RIVERMEMO_XW_SOURCE_ABLATION.md 的非负锥增量解释算子：
     * 支持传入预计算不变量 precomputed = { b1, b2, g12, baseSq } 避免循环内重复点积。
     */
    _v3ConeMarginalGain(target, basis, candidate, precomputed = null) {
        if (!target || !candidate || target.length !== candidate.length) return 0;
        const n = Array.isArray(basis) ? basis.length : 0;
        if (n === 0) {
            return Math.max(0, this._v3Dot(target, candidate));
        }
        if (n === 1) {
            const u1 = basis[0];
            if (!u1 || u1.length !== target.length) return Math.max(0, this._v3Dot(target, candidate));
            const b1 = precomputed ? precomputed.b1 : this._v3Dot(target, u1);
            const b2 = this._v3Dot(target, candidate);
            const g12 = this._v3Dot(u1, candidate);
            const baseSq = precomputed ? precomputed.baseSq : (Math.max(0, b1) ** 2);
            const extSq = this._v3ConeProjSq2(b1, b2, g12);
            return Math.sqrt(Math.max(0, extSq - baseSq));
        }
        const u1 = basis[0];
        const u2 = basis[1];
        if (!u1 || !u2 || u1.length !== target.length || u2.length !== target.length) {
            return Math.max(0, this._v3Dot(target, candidate));
        }
        const b1 = precomputed ? precomputed.b1 : this._v3Dot(target, u1);
        const b2 = precomputed ? precomputed.b2 : this._v3Dot(target, u2);
        const g12 = precomputed ? precomputed.g12 : this._v3Dot(u1, u2);
        const baseSq = precomputed ? precomputed.baseSq : this._v3ConeProjSq2(b1, b2, g12);
        const b3 = this._v3Dot(target, candidate);
        const g13 = precomputed?.g13 ?? this._v3Dot(u1, candidate);
        const g23 = precomputed?.g23 ?? this._v3Dot(u2, candidate);
        const extSq = this._v3ConeProjSq3(b1, b2, b3, g12, g13, g23);
        return Math.sqrt(Math.max(0, extSq - baseSq));
    }

    _v3LoadGlobalManifold(vdb, options = {}) {
        const storeDir = vdb?.config?.storePath
            || (vdb?.dbPath ? path.dirname(vdb.dbPath) : null);
        if (!storeDir) return null;
        if (!(this._v3GlobalManifoldCacheByStore instanceof Map)) {
            this._v3GlobalManifoldCacheByStore = new Map();
        }
        const cacheMap = this._v3GlobalManifoldCacheByStore;
        const setCache = (entry) => {
            cacheMap.delete(storeDir);
            while (cacheMap.size >= 4) {
                const oldestKey = cacheMap.keys().next().value;
                if (oldestKey === undefined) break;
                cacheMap.delete(oldestKey);
            }
            cacheMap.set(storeDir, entry);
            this._v3GlobalManifoldCache = entry;
        };
        const ttlMs = options.ttlMs ?? 3000;
        const now = Date.now();
        const prevCache = cacheMap.get(storeDir)
            || (this._v3GlobalManifoldCache?.storeDir === storeDir ? this._v3GlobalManifoldCache : null);
        if (prevCache && ttlMs > 0 && (now - prevCache.checkedAt) < ttlMs) {
            cacheMap.delete(storeDir);
            cacheMap.set(storeDir, prevCache);
            return prevCache.value;
        }
        try {
            const fsSync = require('node:fs');
            const crypto = require('node:crypto');
            const files = [];
            const expectedDbBase = vdb?.dbPath ? `${path.basename(vdb.dbPath)}.chunks-warped-` : null;
            const modelSig = vdb?.config?.modelSig ? String(vdb.config.modelSig) : null;
            const expectedModelDigest = modelSig
                ? crypto.createHash('sha256').update(modelSig).digest('hex')
                : null;
            for (const name of fsSync.readdirSync(storeDir)) {
                if (!/\.vcpwc$/i.test(name)) continue;
                const fullPath = path.join(storeDir, name);
                try {
                    const stat = fsSync.statSync(fullPath);
                    const exactMatch = Boolean(
                        expectedDbBase
                        && expectedModelDigest
                        && name === `${expectedDbBase}${expectedModelDigest}.vcpwc`
                    );
                    const dbMatch = Boolean(expectedDbBase && name.startsWith(expectedDbBase));
                    files.push({ fullPath, mtimeMs: stat.mtimeMs, size: stat.size, exactMatch, dbMatch });
                } catch (_) {
                    // 热替换并发删旧文件时忽略单个瞬态 ENOENT
                }
            }
            files.sort((a, b) =>
                (Number(b.exactMatch) - Number(a.exactMatch))
                || (Number(b.dbMatch) - Number(a.dbMatch))
                || (b.mtimeMs - a.mtimeMs)
            );
            if (files.length === 0) {
                setCache({ storeDir, key: 'empty', value: null, checkedAt: now });
                return null;
            }
            const latest = files[0];
            const tailPath = latest.fullPath.replace(/\.vcpwc$/i, '.vcpwi');
            let tailStat = null;
            try {
                tailStat = fsSync.statSync(tailPath);
            } catch (_) {
                tailStat = null;
            }
            const tailKey = tailStat ? `|tail:${tailStat.mtimeMs}:${tailStat.size}` : '';
            const cacheKey = `${latest.fullPath}:${latest.mtimeMs}:${latest.size}${tailKey}`;
            if (prevCache?.key === cacheKey) {
                prevCache.checkedAt = Date.now();
                cacheMap.delete(storeDir);
                cacheMap.set(storeDir, prevCache);
                return prevCache.value;
            }
            const { parseChunkField, parseConvertedTail } = require('../WarpedFieldAtlas/lib/snapshot');
            const { createGeometry } = require('../WarpedFieldAtlas/lib/geometry');
            const parsed = parseChunkField(fsSync.readFileSync(latest.fullPath));
            const idx = parsed?.index;
            if (!idx?.meanAxis || !idx?.ids || !idx?.radius || idx.ids.length === 0) {
                setCache({ storeDir, key: cacheKey, value: null, checkedAt: now });
                return null;
            }
            const validMeanAxis = this._v3NormalizeVector(idx.meanAxis);
            if (!validMeanAxis) {
                setCache({ storeDir, key: cacheKey, value: null, checkedAt: now });
                return null;
            }

            const convertedChunkIds = new Set();
            let convertedVersions = null;
            if (tailStat && typeof parseConvertedTail === 'function') {
                try {
                    const tailParsed = parseConvertedTail(fsSync.readFileSync(tailPath), parsed.fullDigest || null);
                    if (tailParsed && Array.isArray(tailParsed.chunkIds)) {
                        for (const cid of tailParsed.chunkIds) convertedChunkIds.add(cid);
                        if (tailParsed.versions && typeof tailParsed.versions === 'object') {
                            convertedVersions = tailParsed.versions;
                        }
                    }
                } catch (_) {
                    // 侧车瞬态写入/损坏时忽略，仅计回退未入图
                }
            }

            const geo = createGeometry(idx);
            const radiusByChunkId = new Map();
            const idToSlot = new Map();
            let maxRadius = -Infinity;
            for (let i = 0; i < idx.ids.length; i++) {
                const cid = Number(idx.ids[i]);
                idToSlot.set(cid, i);
                const r = Number(idx.radius[i]);
                if (!Number.isFinite(r)) continue;
                radiusByChunkId.set(cid, r);
                if (r > maxRadius) maxRadius = r;
            }
            // 校验 CSR 图完整性并预计算入度数组，防止损坏快照越界
            const hasValidCsr = Boolean(
                idx.offsets && idx.graph && idx.offsets.length >= idx.ids.length + 1
            );
            const inDeg = new Float64Array(idx.ids.length);
            if (hasValidCsr) {
                const gLen = idx.graph.length;
                for (let u = 0; u < idx.ids.length; u++) {
                    const s = Math.max(0, Math.min(gLen, idx.offsets[u] || 0));
                    const e = Math.max(s, Math.min(gLen, idx.offsets[u + 1] || 0));
                    for (let k = s; k < e; k++) {
                        const v = idx.graph[k];
                        if (v >= 0 && v < inDeg.length) inDeg[v] += 1;
                    }
                }
            }
            const beta = Number(idx.config?.meanSubtractBeta);
            const effectiveBeta = Number.isFinite(beta) && beta >= 0 && beta < 0.99 ? beta : 0.7;
            const defaultRadius = Number.isFinite(maxRadius) ? maxRadius * 0.98 : 0.63;
            const alignmentQuantiles = (parsed?.alignmentQuantiles && parsed.alignmentQuantiles.length === 64)
                ? parsed.alignmentQuantiles
                : null;
            const value = {
                cacheKey,
                meanAxis: validMeanAxis,
                beta: effectiveBeta,
                rule: parsed?.rule || null,
                alignmentQuantiles,
                ids: idx.ids,
                offsets: hasValidCsr ? idx.offsets : null,
                graph: hasValidCsr ? idx.graph : null,
                inDeg,
                idToSlot,
                convertedChunkIds,
                trainedVersions: parsed?.versions || null,
                convertedVersions,
                radiusByChunkId,
                defaultRadius,
                geo: geo?.supported ? geo : null,
                nodeCount: idx.ids.length
            };
            const entry = { storeDir, key: cacheKey, value, checkedAt: Date.now() };
            setCache(entry);
            return value;
        } catch (err) {
            console.warn('[MetaThinkingManager][V3] 读取全库 V5 双曲流形快照失败，退回普通切空间:', err.message);
            const fallback = this._v3GlobalManifoldCacheByStore?.get(storeDir)
                || (this._v3GlobalManifoldCache?.storeDir === storeDir ? this._v3GlobalManifoldCache : null);
            if (fallback) {
                fallback.checkedAt = now;
                return fallback.value;
            }
            return null;
        }
    }

    /**
     * 精确复现 Rust warped_chunks.rs 分位径向映射：为未入图 / .vcpwi 新星计算真实测地半径
     */
    _v3ComputeChunkQuantileRadius(alignment, knots) {
        if (!knots || knots.length < 2 || !Number.isFinite(alignment)) return 0.63;
        const val = Math.max(0, Math.min(1, Math.abs(alignment)));
        const n = knots.length;
        let lo = 0;
        while (lo < n && knots[lo] < val) lo++;
        let hi = lo;
        while (hi < n && knots[hi] <= val) hi++;
        let pct;
        if (lo !== hi) {
            pct = (lo + hi - 1) / (2 * (n - 1));
        } else if (lo === 0) {
            pct = 0;
        } else if (lo === n) {
            pct = 1;
        } else {
            const denom = Math.max(1e-12, knots[lo] - knots[lo - 1]);
            pct = ((lo - 1) + (val - knots[lo - 1]) / denom) / (n - 1);
        }
        return 0.35 + 0.30 * (Math.max(0, 1 - pct) ** 1.10);
    }

    /**
     * 按狮子 V5 原生全局均值轴变换将原始向量投影到全库黎曼切空间方向 x̂
     */
    _v3ToGlobalSpace(vec, manifold) {
        const u = this._v3NormalizeVector(vec);
        if (!u) return null;
        const axis = manifold?.meanAxis;
        if (!axis || axis.length !== u.length) return u;
        const beta = manifold.beta ?? 0.7;
        const align = this._v3Dot(u, axis);
        const out = new Float64Array(u.length);
        for (let i = 0; i < u.length; i++) {
            out[i] = u[i] - beta * align * axis[i];
        }
        return this._v3NormalizeVector(out) || u;
    }

    /**
     * 第二层星池切空间去中心化：剥离星池自身文风公共均值轴 μ_star，
     * 将窄锥星池展开为以 0 为中心的满球面，激活正交张力与负相关对偶极。
     */
    _v3ToStarSpace(xGlobal, starMeanAxis, betaStar = 0.85) {
        const x = this._v3NormalizeVector(xGlobal);
        if (!x) return null;
        if (!starMeanAxis || starMeanAxis.length !== x.length) return x;
        const align = this._v3Dot(x, starMeanAxis);
        const out = new Float64Array(x.length);
        for (let i = 0; i < x.length; i++) {
            out[i] = x[i] - betaStar * align * starMeanAxis[i];
        }
        return this._v3NormalizeVector(out) || x;
    }

    /**
     * 双层去中心化组合投影：raw → 全局 V5 切空间 x̂ → 星池去中心化切空间 ẑ
     */
    _v3ToStarVector(vec, manifold, starMeanAxis, betaStar = 0.85) {
        const x = this._v3ToGlobalSpace(vec, manifold);
        return x ? this._v3ToStarSpace(x, starMeanAxis, betaStar) : null;
    }

    /**
     * 统一 V5.2 epaMean(β=0.7) Tag 切空间去均值投影（复用在锐度探针与统一 QR 形色分解中）
     */
    _v3ToTagGlobalSpace(vec, epaMean) {
        const u = this._v3NormalizeVector(vec);
        if (!u) return null;
        if (!epaMean || epaMean.length !== u.length) return u;
        const al = this._v3Dot(u, epaMean);
        const out = new Float64Array(u.length);
        for (let i = 0; i < u.length; i++) out[i] = u[i] - 0.7 * al * epaMean[i];
        return this._v3NormalizeVector(out) || u;
    }

    /**
     * 按 chunkId 优先、starName 兜底查询星池缓存元数据（兼容多 chunk 星卡）
     */
    _v3LookupStarMeta(starPool, item, starName = null) {
        if (!starPool) return null;
        const cid = Number(item?.chunkId ?? item?.id);
        if (Number.isSafeInteger(cid)) {
            const byId = starPool.byChunkId?.get(cid);
            if (byId) return byId;
        }
        const resolvedName = starName || this._extractV3StarName(item);
        return resolvedName ? (starPool.byStarName?.get(resolvedName) || null) : null;
    }

    /**
     * 狮子 V5 原生黎曼双曲测地距离与路径体制（支持复用预计算 leg 加速）
     */
    _v3HyperbolicMetric(ra, xa, rb, xb, manifold, legA = null, legB = null) {
        const cos = Math.max(-1, Math.min(1, this._v3Dot(xa, xb)));
        const theta = Math.acos(cos);
        if (manifold?.geo) {
            return {
                distance: manifold.geo.distance(ra, rb, theta, legA, legB),
                regime: manifold.geo.regime(ra, rb, theta, legA, legB),
                theta
            };
        }
        return {
            distance: theta,
            regime: theta >= 1.0 ? 'throat' : 'dip',
            theta
        };
    }

    /**
     * Fisher-Tippett-Gnedenko 精确极值分布参数（N 个标准正态样本最大值的渐近位置 b_N 与尺度 a_N）：
     * - tau = √(2 ln N), a_N = 1 / tau, b_N = tau - (ln(ln N) + ln(4π)) / (2·tau)
     * - 随星池扩编（716 → 2,000 → 10,000+）自动精确缩放，消除 0.85·tau 固定比例魔数。
     */
    _v3FisherTippettParams(n) {
        const effN = Math.max(4, Number(n) || 4);
        const lnN = Math.log(effN);
        const tau = Math.sqrt(2 * lnN);
        const aN = 1 / tau;
        const bN = Math.max(1.0, tau - (Math.log(Math.max(1.0001, lnN)) + Math.log(4 * Math.PI)) / (2 * tau));
        return { tau, aN, bN };
    }

    /**
     * 标准正态分布累积函数 Φ(x)（Abramowitz & Stegun 7.1.26 解析有理逼近，误差 < 7.5e-8）。
     */
    _v3NormalCdf(x) {
        if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
        const ax = Math.abs(x);
        if (ax >= 8.5) return x > 0 ? 1 : 0;
        const t = 1 / (1 + 0.2316419 * ax);
        const density = 0.3989422804014327 * Math.exp(-0.5 * ax * ax);
        const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
        const tail = density * poly;
        return x >= 0 ? (1 - tail) : tail;
    }

    /**
     * 预建星池 z 空间 3-bit（8 分位）自信息量曝光索引：
     * - cuts: Float32Array(7 * D)，每维 8 分位切点 p = j/8 (j=1..7)
     * - tau: Float32Array(D)，无参分位色窗半宽 τ_d = (Q_75,d - Q_25,d) / 8 = (cuts[5,d] - cuts[1,d]) / 8
     * - binMass: Float32Array(8 * D)，每维各 8 桶内样本占比
     * - codes: Uint8Array(N * D)，每颗星在每维的 3-bit 桶号 0..7
     */
    _v3BuildExposureIndex3(zMatrix, nStars, dim) {
        if (!zMatrix || !Number.isInteger(nStars) || nStars < 16 || !Number.isInteger(dim) || dim <= 0) {
            return null;
        }
        if (zMatrix.length < nStars * dim) return null;

        const cuts = new Float32Array(7 * dim);
        const mins = new Float32Array(dim);
        const maxs = new Float32Array(dim);
        const tau = new Float32Array(dim);
        const binMass = new Float32Array(8 * dim);
        const codes = new Uint8Array(nStars * dim);
        const col = new Float32Array(nStars);
        const binCounts = new Int32Array(8);
        const invN = 1 / nStars;

        for (let d = 0; d < dim; d++) {
            for (let i = 0; i < nStars; i++) {
                const v = zMatrix[i * dim + d];
                col[i] = Number.isFinite(v) ? v : 0;
            }
            col.sort();
            mins[d] = col[0];
            maxs[d] = col[nStars - 1];

            for (let j = 1; j <= 7; j++) {
                const pos = (j / 8) * (nStars - 1);
                const lo = Math.floor(pos);
                const hi = Math.ceil(pos);
                const frac = pos - lo;
                cuts[(j - 1) * dim + d] = lo === hi ? col[lo] : (col[lo] * (1 - frac) + col[hi] * frac);
            }
            const c0 = cuts[d];
            const c1 = cuts[dim + d];
            const c2 = cuts[2 * dim + d];
            const c3 = cuts[3 * dim + d];
            const c4 = cuts[4 * dim + d];
            const c5 = cuts[5 * dim + d];
            const c6 = cuts[6 * dim + d];
            tau[d] = Math.max(0, (c5 - c1) / 8);

            binCounts.fill(0);
            for (let i = 0; i < nStars; i++) {
                const rawV = zMatrix[i * dim + d];
                const v = Number.isFinite(rawV) ? rawV : 0;
                let b;
                if (v <= c3) {
                    if (v <= c1) {
                        b = v <= c0 ? 0 : 1;
                    } else {
                        b = v <= c2 ? 2 : 3;
                    }
                } else {
                    if (v <= c5) {
                        b = v <= c4 ? 4 : 5;
                    } else {
                        b = v <= c6 ? 6 : 7;
                    }
                }
                codes[i * dim + d] = b;
                binCounts[b]++;
            }
            for (let b = 0; b < 8; b++) {
                binMass[b * dim + d] = binCounts[b] * invN;
            }
        }

        return { nStars, dim, cuts, mins, maxs, tau, binMass, codes };
    }

    /**
     * 基于 3-bit 分位索引计算给定查询向量 zExpQuery 下，候选星相对于 (s1, s2) 的自信息量净新增曝光 U_new(i | s1, s2)。
     * 严格只在 (s1, s2) 未被查询色窗照亮的盲区维度列表 blindDims 上累加 I_d * overlapProb(b, d)。
     */
    _v3ComputeUniqueExposureScores(exposureIndex3, zExpQuery, s1Idx, s2Idx, candidateIndices = null) {
        if (!exposureIndex3 || !zExpQuery) return null;
        const { nStars, dim, cuts, mins, maxs, tau, binMass, codes } = exposureIndex3;
        if (!cuts || !mins || !maxs || !tau || !binMass || !codes || nStars < 16 || dim <= 0) {
            return null;
        }
        if (zExpQuery.length !== dim) return null;
        if (!Number.isInteger(s1Idx) || s1Idx < 0 || s1Idx >= nStars) return null;
        if (!Number.isInteger(s2Idx) || s2Idx < 0 || s2Idx >= nStars) return null;

        const invN = 1 / nStars;
        const lut = new Float32Array(8 * dim);
        const blindDims = new Int32Array(dim);
        let blindCount = 0;
        const ov = new Float64Array(8);
        const s1Base = s1Idx * dim;
        const s2Base = s2Idx * dim;

        for (let d = 0; d < dim; d++) {
            const qd = zExpQuery[d];
            const td = tau[d];
            if (!Number.isFinite(qd) || !Number.isFinite(td) || td < 0) continue;
            const wLo = qd - td;
            const wHi = qd + td;
            const minD = mins[d];
            const maxD = maxs[d];
            if (wHi < minD || wLo > maxD) continue;

            const c0 = cuts[d];
            const c1 = cuts[dim + d];
            const c2 = cuts[2 * dim + d];
            const c3 = cuts[3 * dim + d];
            const c4 = cuts[4 * dim + d];
            const c5 = cuts[5 * dim + d];
            const c6 = cuts[6 * dim + d];

            let pd = 0;
            for (let b = 0; b < 8; b++) {
                const mass = binMass[b * dim + d];
                if (mass <= 0) {
                    ov[b] = 0;
                    continue;
                }
                let lo;
                let hi;
                switch (b) {
                    case 0: lo = minD; hi = c0; break;
                    case 1: lo = c0; hi = c1; break;
                    case 2: lo = c1; hi = c2; break;
                    case 3: lo = c2; hi = c3; break;
                    case 4: lo = c3; hi = c4; break;
                    case 5: lo = c4; hi = c5; break;
                    case 6: lo = c5; hi = c6; break;
                    default: lo = c6; hi = maxD; break;
                }
                const width = hi - lo;
                let ovVal = 0;
                if (width <= 1e-12) {
                    ovVal = (wLo <= lo && lo <= wHi) ? 1 : 0;
                } else {
                    const oLo = wLo > lo ? wLo : lo;
                    const oHi = wHi < hi ? wHi : hi;
                    if (oHi > oLo) {
                        ovVal = (oHi - oLo) / width;
                    }
                }
                ov[b] = ovVal;
                pd += mass * ovVal;
            }

            const pClamped = Math.min(1, Math.max(invN, pd));
            const infoD = Math.max(0, -Math.log(pClamped));
            if (infoD <= 0) continue;

            let anyLutPos = false;
            for (let b = 0; b < 8; b++) {
                const v = infoD * ov[b];
                lut[b * dim + d] = v;
                if (v > 0) anyLutPos = true;
            }
            if (!anyLutPos) continue;

            const lutS1 = lut[codes[s1Base + d] * dim + d];
            const lutS2 = lut[codes[s2Base + d] * dim + d];
            if (lutS1 <= 0 && lutS2 <= 0) {
                blindDims[blindCount++] = d;
            }
        }

        const outLen = candidateIndices ? candidateIndices.length : nStars;
        const scores = new Float64Array(outLen);
        if (blindCount === 0) {
            if (candidateIndices) {
                for (let k = 0; k < outLen; k++) {
                    const si = candidateIndices[k];
                    if (!Number.isInteger(si) || si < 0 || si >= nStars) scores[k] = NaN;
                }
            }
            return scores;
        }

        const blindLut = new Float32Array(blindCount * 8);
        for (let bi = 0; bi < blindCount; bi++) {
            const d = blindDims[bi];
            const dst = bi * 8;
            for (let b = 0; b < 8; b++) {
                blindLut[dst + b] = lut[b * dim + d];
            }
        }

        for (let k = 0; k < outLen; k++) {
            const si = candidateIndices ? candidateIndices[k] : k;
            if (!Number.isInteger(si) || si < 0 || si >= nStars) {
                scores[k] = NaN;
                continue;
            }
            const base = si * dim;
            let acc = 0;
            for (let bi = 0; bi < blindCount; bi++) {
                const d = blindDims[bi];
                acc += blindLut[bi * 8 + codes[base + d]];
            }
            scores[k] = acc;
        }
        return scores;
    }

    /**
     * 只读加载并缓存星池完整张量库（~716 星，支持未来扩编至数千星及多 Chunk 星卡），
     * 预计算 V5 全局方向 x̂、星池去中心化方向 ẑ、测地半径 leg 及 Fisher-Tippett 无尺度统计描述子。
     */
    _v3LoadStarPoolCache(vdb, diaryNames, manifold, options = {}) {
        const dbPath = vdb?.dbPath;
        if (!dbPath || !Array.isArray(diaryNames) || diaryNames.length === 0) return null;
        const normalizedDiaries = [...new Set(
            diaryNames.map(s => String(s || '').trim()).filter(Boolean)
        )].sort();
        if (normalizedDiaries.length === 0) return null;
        if (!this._v3StarPoolCache) this._v3StarPoolCache = new Map();
        const MAX_STAR_POOL_CACHE_ENTRIES = 8;
        const scopeKey = `${dbPath}\0${normalizedDiaries.join('\0')}`;
        const manifoldKey = manifold?.cacheKey || 'no-manifold';
        const ttlMs = options.ttlMs ?? 3000;
        const now = Date.now();
        const cached = this._v3StarPoolCache.get(scopeKey);
        if (cached && cached.manifoldKey === manifoldKey && ttlMs > 0 && (now - (cached.checkedAt || 0)) < ttlMs) {
            this._v3StarPoolCache.delete(scopeKey);
            this._v3StarPoolCache.set(scopeKey, cached);
            return cached;
        }
        const getDbStatSig = () => {
            if (dbPath === ':memory:') return null;
            try {
                const fsSync = require('node:fs');
                const mainSt = fsSync.statSync(dbPath);
                let walSig = 'nowal';
                try {
                    const walSt = fsSync.statSync(`${dbPath}-wal`);
                    walSig = `${walSt.mtimeMs}:${walSt.size}`;
                } catch (_) {
                    walSig = 'nowal';
                }
                let shmSig = 'noshm';
                try {
                    const shmSt = fsSync.statSync(`${dbPath}-shm`);
                    shmSig = `${shmSt.mtimeMs}:${shmSt.size}`;
                } catch (_) {
                    shmSig = 'noshm';
                }
                return `${mainSt.mtimeMs}:${mainSt.size}|${walSig}|${shmSig}`;
            } catch (_) {
                return null;
            }
        };
        const currentStatSig = ttlMs > 0 ? getDbStatSig() : null;
        // 防止 Windows NTFS 下 WAL 同尺寸覆写导致 stat 签名不变的漏刷：连续 stat 快路径最长 15s 后复核 SQL 指纹
        const sqlVerifiedFresh = !cached?.sqlVerifiedAt || (now - cached.sqlVerifiedAt) < 15000;
        if (cached && cached.manifoldKey === manifoldKey && ttlMs > 0 && currentStatSig && cached.dbStatSig === currentStatSig && sqlVerifiedFresh) {
            cached.checkedAt = Date.now();
            this._v3StarPoolCache.delete(scopeKey);
            this._v3StarPoolCache.set(scopeKey, cached);
            return cached;
        }
        let Database;
        try {
            Database = require('better-sqlite3');
        } catch (_) {
            return cached && cached.manifoldKey === manifoldKey ? cached : null;
        }
        let db = null;
        try {
            const crypto = require('node:crypto');
            db = new Database(dbPath, { readonly: true, timeout: 1000 });
            const placeholders = normalizedDiaries.map(() => '?').join(',');
            const fp = db.prepare(
                `SELECT COUNT(*) AS cnt,
                        COALESCE(MAX(c.id), 0) AS maxId,
                        COALESCE(MAX(c.vector_version), 0) AS maxVer,
                        COALESCE(SUM(c.vector_version), 0) AS sumVer,
                        COALESCE(MAX(f.updated_at), 0) AS maxUpd
                 FROM chunks c JOIN files f ON c.file_id = f.id
                 WHERE f.diary_name IN (${placeholders})`
            ).get(...normalizedDiaries);
            let globalChunkFacts = '0';
            try {
                const factRow = db.prepare("SELECT value FROM kbm_runtime_meta WHERE key = 'global_chunk_facts'").get();
                if (factRow?.value !== undefined && factRow?.value !== null) {
                    globalChunkFacts = String(factRow.value);
                }
            } catch (_) {
                globalChunkFacts = '0';
            }
            let epaRow = null;
            let epaDigest = null;
            try {
                epaRow = db.prepare("SELECT value FROM kv_store WHERE key = 'epa_basis_cache'").get();
                if (epaRow?.value) {
                    epaDigest = crypto.createHash('sha256').update(epaRow.value).digest('hex').slice(0, 16);
                }
            } catch (_) {
                epaRow = null;
            }
            const versionKey = `${manifoldKey}|${fp?.cnt || 0}:${fp?.maxId || 0}:${fp?.maxVer || 0}:${fp?.sumVer || 0}:${fp?.maxUpd || 0}|${globalChunkFacts}|${epaDigest || 'none'}`;
            if (cached && cached.versionKey === versionKey) {
                const refreshedNow = Date.now();
                cached.checkedAt = refreshedNow;
                cached.sqlVerifiedAt = refreshedNow;
                if (currentStatSig) cached.dbStatSig = currentStatSig;
                this._v3StarPoolCache.delete(scopeKey);
                this._v3StarPoolCache.set(scopeKey, cached);
                return cached;
            }

            const rows = db.prepare(
                `SELECT c.id AS chunkId, c.file_id AS fileId, c.vector_version AS vectorVersion,
                        c.content AS text, c.vector AS vec,
                        f.diary_name AS diaryName, f.path AS sourceFile
                 FROM chunks c JOIN files f ON c.file_id = f.id
                 WHERE f.diary_name IN (${placeholders})
                 ORDER BY c.id ASC`
            ).all(...normalizedDiaries);

            const byName = new Map();
            const allChunks = [];
            let manifoldMissingStars = 0;
            const hasVersionBaseline = Boolean(
                (manifold?.trainedVersions && Object.keys(manifold.trainedVersions).length > 0)
                || (manifold?.convertedVersions && Object.keys(manifold.convertedVersions).length > 0)
            );
            for (const row of rows) {
                const buf = row.vec;
                if (!buf || buf.byteLength === 0 || buf.byteLength % 4 !== 0) continue;
                const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
                const raw = this._v3NormalizeVector(f32);
                if (!raw) continue;
                const starName = this._extractV3StarName(row);
                if (!starName) continue;

                const cid = Number(row.chunkId);
                const trainedVer = manifold?.convertedVersions?.[cid] ?? manifold?.trainedVersions?.[cid] ?? null;
                const isVersionMatched = !manifold || !hasVersionBaseline || (
                    Array.isArray(trainedVer)
                    && Number(trainedVer[0]) === Number(row.vectorVersion)
                    && Number(trainedVer[1]) === Number(row.fileId)
                );
                const slot = isVersionMatched ? manifold?.idToSlot?.get(cid) : undefined;
                const inConvertedTail = Boolean(isVersionMatched && manifold?.convertedChunkIds?.has(cid));
                if (manifold && slot === undefined && !inConvertedTail) manifoldMissingStars++;
                let radius;
                if (isVersionMatched && manifold?.radiusByChunkId && manifold.radiusByChunkId.has(cid)) {
                    radius = manifold.radiusByChunkId.get(cid);
                } else if (manifold?.alignmentQuantiles && manifold?.meanAxis && raw.length === manifold.meanAxis.length) {
                    radius = this._v3ComputeChunkQuantileRadius(this._v3Dot(raw, manifold.meanAxis), manifold.alignmentQuantiles);
                } else {
                    radius = manifold?.defaultRadius ?? 0.63;
                }
                const x = this._v3ToGlobalSpace(raw, manifold);
                const leg = manifold?.geo ? manifold.geo.leg(radius) : null;
                const entry = {
                    chunkId: cid,
                    fileId: row.fileId,
                    diaryName: row.diaryName,
                    sourceFile: row.sourceFile,
                    starName,
                    text: row.text || '',
                    raw,
                    x,
                    z: null,
                    slot,
                    radius,
                    leg
                };
                allChunks.push(entry);
                if (byName.has(starName)) {
                    byName.get(starName).chunks.push(entry);
                } else {
                    byName.set(starName, { ...entry, chunks: [entry] });
                }
            }

            // 多 Chunk 星卡语义聚合：融合同一星卡全部分块的原始向量均值，并重算测地半径与 leg，避免截断或碎片漂移
            const stars = Array.from(byName.values()).map((st) => {
                if (!Array.isArray(st.chunks) || st.chunks.length <= 1) return st;
                const aggRaw = this._v3WeightedCentroid(st.chunks.map(c => ({ vector: c.raw, weight: 1 })));
                if (!aggRaw) return st;
                const aggX = this._v3ToGlobalSpace(aggRaw, manifold);
                let aggRadius = st.radius;
                if (manifold?.alignmentQuantiles && manifold?.meanAxis && aggRaw.length === manifold.meanAxis.length) {
                    aggRadius = this._v3ComputeChunkQuantileRadius(this._v3Dot(aggRaw, manifold.meanAxis), manifold.alignmentQuantiles);
                } else {
                    const finiteRadii = st.chunks.map(c => c.radius).filter(Number.isFinite);
                    if (finiteRadii.length > 0) {
                        aggRadius = finiteRadii.reduce((s, r) => s + r, 0) / finiteRadii.length;
                    }
                }
                const aggLeg = manifold?.geo ? manifold.geo.leg(aggRadius) : st.leg;
                return { ...st, raw: aggRaw, x: aggX || st.x, radius: aggRadius, leg: aggLeg };
            });
            if (stars.length === 0) {
                this._v3StarPoolCache.delete(scopeKey);
                return null;
            }

            const dim = stars[0].x.length;
            const meanAcc = new Float64Array(dim);
            let inDegSum = 0;
            let inDegCount = 0;
            const starSlots = new Set();
            for (const st of stars) {
                if (st.x && st.x.length === dim) {
                    for (let d = 0; d < dim; d++) meanAcc[d] += st.x[d];
                }
                if (st.slot !== undefined) {
                    starSlots.add(st.slot);
                    if (manifold?.inDeg) {
                        inDegSum += manifold.inDeg[st.slot] || 0;
                        inDegCount++;
                    }
                }
            }
            const starMeanAxis = this._v3NormalizeVector(meanAcc);
            let alignSum = 0;
            let alignSqSum = 0;
            let alignCount = 0;
            if (starMeanAxis) {
                for (const st of stars) {
                    if (st.x && st.x.length === starMeanAxis.length) {
                        const al = this._v3Dot(st.x, starMeanAxis);
                        alignSum += al;
                        alignSqSum += al * al;
                        alignCount++;
                    }
                }
            }
            const meanAlignMean = alignCount > 0 ? (alignSum / alignCount) : null;
            const meanAlignStd = alignCount > 1
                ? Math.sqrt(Math.max(1e-6, alignSqSum / alignCount - meanAlignMean * meanAlignMean))
                : null;
            // 解析零均值去中心化闭式 β_* = 1 - √(1 - ā²) / (ā·√(N - 1))，收紧上限 0.96 防止万星扩编压扁径向自由度
            const betaStar = (
                stars.length >= 16
                && Number.isFinite(meanAlignMean)
                && meanAlignMean > 0.1
                && meanAlignMean < 0.999
            )
                ? Math.max(0.5, Math.min(0.96, 1 - Math.sqrt(Math.max(0, 1 - meanAlignMean * meanAlignMean)) / (meanAlignMean * Math.sqrt(Math.max(1, stars.length - 1)))))
                : 0.85;

            let epaMeanRaw = null;
            if (epaRow?.value) {
                try {
                    const parsedEpa = JSON.parse(epaRow.value);
                    const b64 = parsedEpa?.mean;
                    if (typeof b64 === 'string' && b64) {
                        const buf = Buffer.from(b64, 'base64');
                        if (buf.byteLength > 0 && buf.byteLength % 4 === 0) {
                            epaMeanRaw = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
                        }
                    }
                } catch (_) {
                    epaMeanRaw = null;
                }
            }

            const byChunkId = new Map();
            const byStarName = new Map();
            const bySlot = new Map();
            const zMatrix = new Float32Array(stars.length * dim);
            const indexByStarName = new Map();
            for (const st of allChunks) {
                st.zRaw = this._v3ToStarSpace(st.x, starMeanAxis, betaStar);
                st.z = st.zRaw;
                byChunkId.set(st.chunkId, st);
                if (st.slot !== undefined) {
                    bySlot.set(st.slot, st);
                }
            }
            for (let si = 0; si < stars.length; si++) {
                const st = stars[si];
                if (Array.isArray(st.chunks) && st.chunks.length > 1) {
                    st.zRaw = this._v3ToStarSpace(st.x, starMeanAxis, betaStar);
                    st.z = st.zRaw;
                    // 多 Chunk 星卡聚合后同步回写每块分块的 raw/x/radius/leg/z/zRaw，防止 Step 1 召回非首块 chunk 时拿到碎片方向与半径
                    for (const ch of st.chunks) {
                        ch.raw = st.raw;
                        ch.x = st.x;
                        ch.radius = st.radius;
                        ch.leg = st.leg;
                        ch.zRaw = st.zRaw;
                        ch.z = st.z;
                    }
                } else {
                    const c0 = byChunkId.get(st.chunkId);
                    if (c0) {
                        st.zRaw = c0.zRaw;
                        st.z = c0.z;
                    } else {
                        st.zRaw = this._v3ToStarSpace(st.x, starMeanAxis, betaStar);
                        st.z = st.zRaw;
                    }
                }
                if (st.z && st.z.length === dim) {
                    zMatrix.set(st.z, si * dim);
                }
                indexByStarName.set(st.starName, si);
                byStarName.set(st.starName, st);
            }

            // 星池自标定无尺度分布描述子（Fisher-Tippett 极值闭式，随星池扩编自动重标定）
            const ft = this._v3FisherTippettParams(stars.length);
            const tauExtremeZ = ft.tau;

            let orthTopScale = 0.22;
            let pairMeanCos = 0;
            let pairStdCos = 1 / Math.sqrt(Math.max(1, dim));
            let nnStepMed = 1.25;
            if (stars.length >= 16) {
                const probeStep = Math.max(1, Math.floor(stars.length / 48));
                const probeTops = [];
                let pairSum = 0;
                let pairSqSum = 0;
                let pairCount = 0;
                for (let pi = 0; pi < stars.length; pi += probeStep) {
                    const zp = stars[pi].z;
                    if (!zp) continue;
                    let best1 = -Infinity;
                    for (let pj = 0; pj < stars.length; pj++) {
                        if (pj === pi) continue;
                        const zj = stars[pj].z;
                        if (!zj) continue;
                        const s = this._v3Dot(zp, zj);
                        pairSum += s;
                        pairSqSum += s * s;
                        pairCount++;
                        if (s > best1) best1 = s;
                    }
                    if (Number.isFinite(best1) && best1 > 0) probeTops.push(best1);
                }
                if (pairCount > 1) {
                    pairMeanCos = pairSum / pairCount;
                    pairStdCos = Math.sqrt(Math.max(1e-6, pairSqSum / pairCount - pairMeanCos * pairMeanCos));
                }
                if (probeTops.length >= 4) {
                    probeTops.sort((a, b) => a - b);
                    const med = probeTops[Math.floor(probeTops.length * 0.5)];
                    if (Number.isFinite(med) && med > 0.05) {
                        orthTopScale = Math.max(0.10, Math.min(0.55, med));
                        nnStepMed = Math.sqrt(Math.max(1e-6, 2 * (1 - med)));
                    }
                }
            }
            // 纯张量盲区零分布解析闭式（零伪 Gram / 零外部样本依赖）：
            // 三体非负锥合力覆盖振幅若低于单星 Fisher-Tippett 期望极值 b_N·σ_pair，触发中度盲区 ⊘(r_⊥)；
            // 若连下界 (b_N - 2·a_N)·σ_pair 都达不到，触发深度盲区 ⊘(r_⊥ ≫ 0)。
            const covBase = Math.min(0.65, Math.max(0.10, ft.bN * pairStdCos));
            const covHigh = Math.min(covBase, Math.max(pairStdCos, (ft.bN - 2 * ft.aN) * pairStdCos));
            const coneResidualBase = Math.sqrt(Math.max(0.01, 1 - covBase * covBase));
            const coneResidualHigh = Math.max(coneResidualBase + 0.005, Math.sqrt(Math.max(0.01, 1 - covHigh * covHigh)));
            const needsCoarseSubspace = stars.length * dim >= 2000 * 3072;
            const coarseSubspace = (needsCoarseSubspace && options.syncCoarseSubspace === true)
                ? this._v3BuildCoarseSubspace(zMatrix, stars.length, dim, pairStdCos)
                : null;
            const exposureIndex3 = stars.length >= 16
                ? this._v3BuildExposureIndex3(zMatrix, stars.length, dim)
                : null;

            const nowLoaded = Date.now();
            const pool = {
                versionKey,
                manifoldKey,
                dbStatSig: currentStatSig || getDbStatSig(),
                checkedAt: nowLoaded,
                sqlVerifiedAt: nowLoaded,
                stars,
                zMatrix,
                zDim: dim,
                coarseSubspace,
                exposureIndex3,
                indexByStarName,
                byChunkId,
                byStarName,
                bySlot,
                starSlots,
                starMeanAxis,
                betaStar,
                meanAlignMean,
                meanAlignStd,
                tauExtremeZ,
                gumbelAN: ft.aN,
                gumbelBN: ft.bN,
                orthTopScale,
                pairMeanCos,
                pairStdCos,
                nnStepMed,
                coneResidualBase,
                coneResidualHigh,
                manifoldMissingStars,
                avgStarInDeg: inDegCount > 0 ? Math.max(4, inDegSum / inDegCount) : 32,
                epaDigest,
                epaMean: epaMeanRaw ? (this._v3NormalizeVector(epaMeanRaw) || null) : null
            };
            this._v3StarPoolCache.delete(scopeKey);
            while (this._v3StarPoolCache.size >= MAX_STAR_POOL_CACHE_ENTRIES) {
                const oldestKey = this._v3StarPoolCache.keys().next().value;
                if (oldestKey === undefined) break;
                this._v3StarPoolCache.delete(oldestKey);
            }
            this._v3StarPoolCache.set(scopeKey, pool);
            if (needsCoarseSubspace && !pool.coarseSubspace && options.asyncCoarseSubspace !== false) {
                this._v3ScheduleCoarseSubspaceBuild(pool, scopeKey);
            }
            return pool;
        } catch (err) {
            console.warn('[MetaThinkingManager][V3] 读取星池张量缓存失败，回退动态候选池:', err.message);
            if (cached && cached.manifoldKey === manifoldKey) {
                cached.checkedAt = now;
                return cached;
            }
            return null;
        } finally {
            try { db?.close(); } catch (_) { /* noop */ }
        }
    }

    async _v3GetTagVectors(vdb, tagNames) {
        if (!vdb || typeof vdb.getTagVectorByName !== 'function') return new Map();
        if (!this._v3TagVectorCache) this._v3TagVectorCache = new Map();
        const dbScope = String(vdb.dbPath || 'default');
        const NEGATIVE_TTL_MS = 5000;
        const now = Date.now();
        const result = new Map();
        const missing = [];
        const seenMissing = new Set();
        for (const rawName of Array.isArray(tagNames) ? tagNames : []) {
            const name = String(rawName || '').trim();
            if (!name || result.has(name)) continue;
            const cacheKey = `${dbScope}\0${name}`;
            if (this._v3TagVectorCache.has(cacheKey)) {
                const entry = this._v3TagVectorCache.get(cacheKey);
                if (entry && entry.vector) {
                    // LRU touch
                    this._v3TagVectorCache.delete(cacheKey);
                    this._v3TagVectorCache.set(cacheKey, entry);
                    result.set(name, entry.vector);
                    continue;
                }
                if (entry && entry.vector === null && (now - (entry.cachedAt || 0)) < NEGATIVE_TTL_MS) {
                    continue;
                }
                this._v3TagVectorCache.delete(cacheKey);
            }
            if (!seenMissing.has(name)) {
                seenMissing.add(name);
                missing.push({ name, cacheKey });
            }
        }
        if (missing.length > 0) {
            await Promise.all(missing.map(async ({ name, cacheKey }) => {
                try {
                    const raw = await vdb.getTagVectorByName(name);
                    const unit = this._v3NormalizeVector(raw);
                    this._v3TagVectorCache.delete(cacheKey);
                    while (this._v3TagVectorCache.size >= 512) {
                        const oldest = this._v3TagVectorCache.keys().next().value;
                        if (oldest === undefined) break;
                        this._v3TagVectorCache.delete(oldest);
                    }
                    this._v3TagVectorCache.set(cacheKey, { vector: unit, cachedAt: Date.now() });
                    if (unit) result.set(name, unit);
                } catch (_) {
                    // 瞬时异常绝不向缓存写入 null，防止永久失明与绕过容量上限
                }
            }));
        }
        return result;
    }

    /**
     * 纯张量无尺度用户意图载荷系数 α_user ∈ [0, 1]（全部由 Fisher-Tippett 精确极值分布驱动，零 0.85 魔数）：
     * 1) 精确 Fisher-Tippett Gumbel 生存函数 exp(-exp(-(zScore - b_N) / a_N))；
     * 2) 相对星池均值对齐分布 (μ_α, σ_α) 的反向偏离概率；
     * 3) 原生 V5.2 去噪场相对矢量拉偏比例 Δ_den / ‖Δ_den‖。
     */
    _v3ComputeUserIntentLoad(rawUserVec, zUserOnly, rawPrevAiVec, rawMixVec, denoisedVec, manifold, starPool) {
        if (!zUserOnly || !starPool || !Array.isArray(starPool.stars) || starPool.stars.length < 16) {
            return { load: 1.0, top1: null, zScore: null, meanAlign: null, denBoost: 0 };
        }
        const clamp01 = (v) => Math.max(0, Math.min(1, v));
        let top1 = -Infinity;
        let sum = 0;
        let sumSq = 0;
        let count = 0;
        for (const st of starPool.stars) {
            if (!st?.z || st.z.length !== zUserOnly.length) continue;
            const s = this._v3Dot(zUserOnly, st.z);
            sum += s;
            sumSq += s * s;
            count++;
            if (s > top1) {
                top1 = s;
            }
        }
        if (count < 16 || !Number.isFinite(top1)) {
            return { load: 1.0, top1: null, zScore: null, meanAlign: null, denBoost: 0 };
        }
        const mean = sum / count;
        const std = Math.sqrt(Math.max(1e-12, sumSq / count - mean * mean));
        const zScore = (top1 - mean) / std;

        let meanAlign = null;
        if (rawUserVec && starPool.starMeanAxis) {
            const xUser = this._v3ToGlobalSpace(rawUserVec, manifold);
            if (xUser && xUser.length === starPool.starMeanAxis.length) {
                meanAlign = this._v3Dot(xUser, starPool.starMeanAxis);
            }
        }

        const ft = (Number.isFinite(starPool.gumbelBN) && Number.isFinite(starPool.gumbelAN) && starPool.gumbelAN > 0)
            ? { bN: starPool.gumbelBN, aN: starPool.gumbelAN }
            : this._v3FisherTippettParams(count);
        // 精确 Fisher-Tippett-Gnedenko Gumbel 生存概率（全 N 尺度严格自洽，零额外辅权）
        const baseLoad = Math.exp(-Math.exp(-Math.max(-30, Math.min(30, (zScore - ft.bN) / ft.aN))));

        let denBoost = 0;
        if (
            rawUserVec && rawPrevAiVec && rawMixVec && denoisedVec
            && rawUserVec.length === denoisedVec.length
            && rawPrevAiVec.length === denoisedVec.length
            && rawMixVec.length === denoisedVec.length
        ) {
            let pullUser = 0;
            let pullPrev = 0;
            let deltaNormSq = 0;
            for (let i = 0; i < denoisedVec.length; i++) {
                const delta = denoisedVec[i] - rawMixVec[i];
                deltaNormSq += delta * delta;
                pullUser += delta * rawUserVec[i];
                pullPrev += delta * rawPrevAiVec[i];
            }
            const deltaNorm = Math.sqrt(deltaNormSq);
            const pairStdRef = (Number.isFinite(starPool.pairStdCos) && starPool.pairStdCos > 1e-4)
                ? starPool.pairStdCos
                : (1 / Math.sqrt(Math.max(4, zUserOnly.length)));
            if (pullUser > 0 && deltaNorm > 1e-6) {
                const pullRatio = (pullUser - pullPrev) / deltaNorm;
                denBoost = clamp01(pullRatio) * clamp01(Math.sqrt(deltaNorm / pairStdRef));
            }
        }

        const load = clamp01(Math.max(baseLoad, denBoost));
        return { load, top1, zScore, meanAlign, denBoost };
    }

    /**
     * 只读加载并缓存 V5.2 全局 Tag 均值轴 epa_basis_cache.mean（供 31k-Tag 切空间去均值分布检验）。
     */
    _v3LoadEpaMean(vdb, options = {}) {
        const dbPath = vdb?.dbPath;
        if (!dbPath || dbPath === ':memory:') return null;
        if (!this._v3EpaMeanCache) this._v3EpaMeanCache = new Map();
        const ttlMs = options.ttlMs ?? 15000;
        const now = Date.now();
        const cached = this._v3EpaMeanCache.get(dbPath);
        if (cached && ttlMs > 0 && (now - (cached.checkedAt || 0)) < ttlMs) {
            return cached.value;
        }
        let Database;
        try {
            Database = require('better-sqlite3');
        } catch (_) {
            return cached?.value || null;
        }
        let db = null;
        try {
            db = new Database(dbPath, { readonly: true, timeout: 1000 });
            const row = db.prepare("SELECT value FROM kv_store WHERE key = 'epa_basis_cache'").get();
            if (!row?.value) {
                this._v3EpaMeanCache.set(dbPath, { checkedAt: now, value: null });
                return null;
            }
            const parsed = JSON.parse(row.value);
            const sig = String(parsed?.artifactSig || '');
            if (cached && cached.sig === sig && cached.value) {
                cached.checkedAt = Date.now();
                return cached.value;
            }
            const b64 = parsed?.mean;
            if (typeof b64 !== 'string' || !b64) return null;
            const buf = Buffer.from(b64, 'base64');
            if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
            const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
            const unit = this._v3NormalizeVector(f32);
            if (!unit) return null;
            while (this._v3EpaMeanCache.size >= 4) {
                const oldestKey = this._v3EpaMeanCache.keys().next().value;
                if (oldestKey === undefined) break;
                this._v3EpaMeanCache.delete(oldestKey);
            }
            this._v3EpaMeanCache.set(dbPath, { sig, checkedAt: Date.now(), value: unit });
            return unit;
        } catch (_) {
            return cached?.value || null;
        } finally {
            try { db?.close(); } catch (_) { /* noop */ }
        }
    }

    /**
     * 在 epaMean(β=0.7) 切空间中对指定单位向量集合做 2-pass MGS 正交剥离，计算舒尔补条件附和 R² (partialPh) 与总控制比 (partialCtrl)，
     * 并通过精确线性逆映射 P_β^{-1} 还原。
     */
    _v3StripBasisInEpaSpace(rawVec, basisRawList, epaMean = null, minNorm = 0.05, phBasis = null, metaBasis = null, options = {}) {
        const xU = this._v3ToTagGlobalSpace(rawVec, epaMean);
        if (!xU) return { vector: null, xResidual: null, residualNorm: 0, partialPh: null, partialCtrl: null };
        const orthoBasis = [];
        for (const bv of Array.isArray(basisRawList) ? basisRawList : []) {
            const xB = this._v3ToTagGlobalSpace(bv, epaMean);
            if (!xB || xB.length !== xU.length) continue;
            const cur = Float64Array.from(xB);
            for (let pass = 0; pass < 2; pass++) {
                for (const ob of orthoBasis) {
                    const p = this._v3Dot(cur, ob);
                    for (let i = 0; i < cur.length; i++) cur[i] -= p * ob[i];
                }
            }
            const unitB = this._v3NormalizeVector(cur);
            if (unitB) orthoBasis.push(unitB);
        }
        const xRes = Float64Array.from(xU);
        for (let pass = 0; pass < 2; pass++) {
            for (const ob of orthoBasis) {
                const p = this._v3Dot(xRes, ob);
                for (let i = 0; i < xRes.length; i++) xRes[i] -= p * ob[i];
            }
        }
        let normSq = 0;
        for (let i = 0; i < xRes.length; i++) normSq += xRes[i] * xRes[i];
        const residualNorm = Math.sqrt(Math.max(0, normSq));
        if (residualNorm <= 1e-6 || residualNorm < minNorm) {
            return { vector: null, xResidual: null, residualNorm, partialPh: null, partialCtrl: null };
        }
        const xShellUnit = this._v3NormalizeVector(xRes);
        let partialPh = null;
        let partialCtrl = null;
        if (Array.isArray(phBasis) && phBasis.length > 0 && orthoBasis.length > 0 && xShellUnit) {
            const projectCond = (vecs, extraOrtho = []) => {
                const condBasis = [];
                for (const vb of vecs) {
                    if (!vb || vb.length !== xRes.length) continue;
                    const cur = Float64Array.from(vb);
                    for (let pass = 0; pass < 2; pass++) {
                        for (const ob of orthoBasis) {
                            const p = this._v3Dot(cur, ob);
                            for (let i = 0; i < cur.length; i++) cur[i] -= p * ob[i];
                        }
                        for (const eb of extraOrtho) {
                            const p = this._v3Dot(cur, eb);
                            for (let i = 0; i < cur.length; i++) cur[i] -= p * eb[i];
                        }
                        for (const cb of condBasis) {
                            const p = this._v3Dot(cur, cb);
                            for (let i = 0; i < cur.length; i++) cur[i] -= p * cb[i];
                        }
                    }
                    const unitCb = this._v3NormalizeVector(cur);
                    if (unitCb) condBasis.push(unitCb);
                }
                return condBasis;
            };
            const phCondBasis = projectCond(phBasis);
            if (phCondBasis.length > 0) {
                let sumSq = 0;
                for (const cb of phCondBasis) {
                    const c = Math.max(0, this._v3Dot(xShellUnit, cb));
                    sumSq += c * c;
                }
                partialPh = Math.min(1, sumSq);
            }
            if (Array.isArray(metaBasis) && metaBasis.length > 0) {
                const metaCondBasis = projectCond(metaBasis, phCondBasis);
                let metaSq = 0;
                for (let mi = 0; mi < metaCondBasis.length; mi++) {
                    const d = this._v3Dot(xShellUnit, metaCondBasis[mi]);
                    const c = mi === 0 ? Math.max(0, d) : d;
                    metaSq += c * c;
                }
                partialCtrl = Math.min(1, (partialPh ?? 0) + metaSq);
            } else {
                partialCtrl = partialPh;
            }
        }
        if (options?.skipInverse) {
            return { vector: null, xResidual: xShellUnit, residualNorm, partialPh, partialCtrl };
        }
        let restored = xRes;
        if (epaMean && epaMean.length === xRes.length) {
            const invFactor = 0.7 / 0.3;
            const align = this._v3Dot(xRes, epaMean);
            restored = new Float64Array(xRes.length);
            for (let i = 0; i < xRes.length; i++) {
                restored[i] = xRes[i] + invFactor * align * epaMean[i];
            }
        }
        return { vector: this._v3NormalizeVector(restored), xResidual: xShellUnit, residualNorm, partialPh, partialCtrl };
    }

    /**
     * 在模糊边界区，直接消费 Rust V5.2 每轮免费算出的校准不变量（epa.inDomainGate / l0.energyExplained / residualEnergyRatio），
     * 并在 epaMean(β=0.7) 切空间中正交剥离全部非附和 L0 Tag 构造残差外壳向量 shellUserVec 与舒尔补条件附和 R² (partialPh)，识别“带技术词的纯附和”。
     */
    async _v3MeasureV52TagSharpness(vdb, rawUserVec, userContent, epaMean = null, options = {}) {
        const emptyOut = {
            maxTagX: null,
            top1Contrib: null,
            logicDepth: null,
            inDomainGate: null,
            outOfDomain: null,
            l0Explained: null,
            patternStrength: null,
            entityEvidence: 0,
            sharpness: 1.0,
            shellXVec: null,
            shellResidualNorm: null,
            partialPh: null,
            partialCtrl: null,
            prepared: null
        };
        if (!vdb || typeof vdb.prepareUnifiedMemoObservation !== 'function' || !rawUserVec) {
            return emptyOut;
        }
        const xU = this._v3ToTagGlobalSpace(rawUserVec, epaMean);
        if (!xU) return emptyOut;
        const lightweightProbe = Boolean(options?.lightweightProbe);
        const returnPrepared = Boolean(options?.returnPrepared) && !lightweightProbe;
        const signal = options?.signal || null;
        let probePrep = null;
        let handedOff = false;
        try {
            const baseObsOpts = options?.obsOpts || { sourceObservationConfig: { baseTagBoost: 0.459, coreBoostFactor: 1.33 } };
            const effectiveObsOpts = lightweightProbe
                ? {
                    ...baseObsOpts,
                    maxPyramidLevels: 1,
                    maxEmergentNodes: 0,
                    spikeRouting: { ...(baseObsOpts.spikeRouting || {}), maxSafeHops: 0 },
                    localField: { ...(baseObsOpts.localField || {}), maxIterations: 1 },
                    transferField: { ...(baseObsOpts.transferField || {}), maxIterations: 1 },
                    effectiveSupport: { ...(baseObsOpts.effectiveSupport || {}), localMassRatio: 0.01, transferMassRatio: 0.01 }
                }
                : baseObsOpts;
            probePrep = await vdb.prepareUnifiedMemoObservation(
                { text: String(userContent || ''), vector: rawUserVec },
                effectiveObsOpts
            );
            if (signal?.aborted) {
                const abortErr = new Error('MetaThinkingV3 probe aborted');
                abortErr.name = 'AbortError';
                throw abortErr;
            }
            const l0Level = probePrep?.sourceObservationResult?.pyramid?.levels?.[0] || null;
            const l0Tags = (l0Level?.tags || []).slice(0, 6);
            const epaObj = probePrep?.sourceObservationResult?.epa || null;
            const hasNativeInDomain = Number.isFinite(Number(epaObj?.inDomainGate));
            const inDomainGate = hasNativeInDomain ? Number(epaObj.inDomainGate) : null;
            const outOfDomain = Number.isFinite(Number(epaObj?.outOfDomain)) ? Number(epaObj.outOfDomain) : null;
            const hasNativeL0Energy = Number.isFinite(Number(l0Level?.energyExplained));
            const l0Explained = hasNativeL0Energy ? Number(l0Level.energyExplained) : null;
            const patternStrength = Number.isFinite(Number(l0Level?.handshakeFeatures?.patternStrength))
                ? Number(l0Level.handshakeFeatures.patternStrength)
                : null;
            const logicDepth = Number(epaObj?.logicDepth) || 0;

            if (l0Tags.length === 0) {
                if (returnPrepared && probePrep) handedOff = true;
                return {
                    maxTagX: null,
                    top1Contrib: 0,
                    logicDepth,
                    inDomainGate,
                    outOfDomain,
                    l0Explained,
                    patternStrength,
                    entityEvidence: 0,
                    sharpness: 1.0,
                    shellXVec: null,
                    shellResidualNorm: null,
                    partialPh: null,
                    partialCtrl: null,
                    prepared: handedOff ? probePrep : null
                };
            }
            const top1Contrib = Number(l0Tags[0]?.contribution) || 0;
            const tagVecs = await this._v3GetTagVectors(vdb, l0Tags.map(t => t.name));
            if (signal?.aborted) {
                const abortErr = new Error('MetaThinkingV3 probe aborted');
                abortErr.name = 'AbortError';
                throw abortErr;
            }
            let maxTagX = -Infinity;
            const stripTagsRaw = [];
            const phBasis = Array.isArray(options?.phBasis) ? options.phBasis : null;
            const metaBasis = Array.isArray(options?.metaBasis) ? options.metaBasis : null;
            for (const t of l0Tags) {
                const tv = tagVecs.get(t.name);
                if (!tv) continue;
                const xT = this._v3ToTagGlobalSpace(tv, epaMean);
                if (!xT || xT.length !== xU.length) continue;
                const s = this._v3Dot(xU, xT);
                if (s > maxTagX) maxTagX = s;
                // 仅剥离非附和实体/领域 Tag，防止把附和语义本身剥掉
                let tagPhE = 0;
                if (phBasis) {
                    for (const b of phBasis) {
                        const c = Math.max(0, this._v3Dot(xT, b));
                        tagPhE += c * c;
                    }
                }
                const tagPhCut = Number.isFinite(Number(options?.tagPhCut)) ? Number(options.tagPhCut) : 0.5;
                if (tagPhE < tagPhCut) {
                    stripTagsRaw.push(tv);
                }
            }
            const stripTargetVec = (options?.stripSourceVec && options.stripSourceVec.length === rawUserVec.length)
                ? options.stripSourceVec
                : rawUserVec;
            const stripped = stripTagsRaw.length > 0
                ? this._v3StripBasisInEpaSpace(stripTargetVec, stripTagsRaw, epaMean, 0.05, phBasis, metaBasis, { skipInverse: true })
                : { vector: null, xResidual: null, residualNorm: null, partialPh: null, partialCtrl: null };
            const shellXVec = stripped.xResidual;
            const shellResidualNorm = stripped.residualNorm;
            const partialPh = stripped.partialPh;
            const partialCtrl = stripped.partialCtrl;

            if (!Number.isFinite(maxTagX)) {
                if (returnPrepared && probePrep) handedOff = true;
                return {
                    maxTagX: null,
                    top1Contrib,
                    logicDepth,
                    inDomainGate,
                    outOfDomain,
                    l0Explained,
                    patternStrength,
                    entityEvidence: 0,
                    sharpness: 1.0,
                    shellXVec,
                    shellResidualNorm,
                    partialPh,
                    partialCtrl,
                    prepared: handedOff ? probePrep : null
                };
            }
            const clamp01 = (v) => Math.max(0, Math.min(1, v));
            // 纯张量无斜坡透出：直接消费上游 V5.2 已校准的 inDomainGate × l0Explained（或自然投影量 maxTagX / top1Contrib），
            // 彻底废除 14 个硬切分段斜坡魔数。
            const nativeCalibrated = (inDomainGate !== null && l0Explained !== null)
                ? clamp01(Math.sqrt(Math.max(0, l0Explained * inDomainGate)))
                : (inDomainGate ?? l0Explained ?? clamp01(logicDepth));
            const entityEvidence = clamp01(Math.max(nativeCalibrated, top1Contrib, Math.max(0, maxTagX)));
            const sharpness = clamp01(Math.max(Math.max(0, maxTagX), top1Contrib, nativeCalibrated));
            if (returnPrepared && probePrep) handedOff = true;
            return {
                maxTagX,
                top1Contrib,
                logicDepth,
                inDomainGate,
                outOfDomain,
                l0Explained,
                patternStrength,
                entityEvidence,
                sharpness,
                shellXVec,
                shellResidualNorm,
                partialPh,
                partialCtrl,
                prepared: handedOff ? probePrep : null
            };
        } catch (err) {
            if (err?.name === 'AbortError' || signal?.aborted) {
                throw err;
            }
            return emptyOut;
        } finally {
            if (probePrep && !handedOff) {
                try { vdb.releaseMemoObservation?.(probePrep); } catch (_) { /* noop */ }
            }
        }
    }

    /**
     * 轻量懒加载双语三维正交元指令子空间 B_meta = { muPhatic, qMeta, qMode, eDrill, eEscape }：
     * - qMeta 捕获公共元指令载荷，qMode 捕获与 qMeta/muPhatic 严格正交的深挖(-) vs 破局(+)极性轴；
     * - 仅当宿主提供 embedding 接口时执行一次批量嵌入并常驻内存；离线/单测静默降级为 null。
     */
    async _v3EnsureMetaPolarityAxes() {
        if (this._v3MetaAxesCache) {
            return this._v3MetaAxesCache;
        }
        if (this._v3MetaAxesNoEmbedder) {
            return null;
        }
        if (this._v3MetaAxesRetryAt && Date.now() < this._v3MetaAxesRetryAt) {
            return null;
        }
        if (this._v3MetaAxesPromise) {
            return this._v3MetaAxesPromise;
        }
        const batchFn = typeof this.ragPlugin?.getBatchEmbeddings === 'function'
            ? (texts) => this.ragPlugin.getBatchEmbeddings(texts)
            : null;
        const singleFn = !batchFn && typeof this.ragPlugin?.getSingleEmbeddingCached === 'function'
            ? (texts) => Promise.all(texts.map(t => this.ragPlugin.getSingleEmbeddingCached(t)))
            : null;
        const embedder = batchFn || singleFn;
        if (!embedder) {
            this._v3MetaAxesNoEmbedder = true;
            return null;
        }
        this._v3MetaAxesPromise = (async () => {
            try {
                const protoPhatic = [
                    '继续', '好的', '嗯嗯', '可以的没问题',
                    '写得真好我很喜欢', '交给你了你来决定', '太棒了完全认可', '谢谢辛苦了'
                ];
                const protoPhaticBanter = [
                    '笑死太好笑了接着整',
                    '哈哈绝了真有意思往下说',
                    '太秀了不愧是你继续冲',
                    '这个梗我服了太真实了'
                ];
                const protoPhaticEn = [
                    'sounds great keep going', 'nice job continue', 'makes sense go ahead', 'got it thank you'
                ];
                const protoDrill = [
                    '往底层机理再深挖一下',
                    '顺着当前逻辑把细节展开讲透',
                    '别换话题，继续深究这个原理',
                    'dig deeper into the underlying mechanism',
                    'stay on this point and analyze the details'
                ];
                const protoEscape = [
                    '跳出当前框架换一个完全不同的视角',
                    '打破这个思路，从反面或者跨领域重新看',
                    '换个新角度，给我一个反直觉的切入点',
                    '把这套思路掀翻用全新视角重新审视',
                    '推翻原有前提从异质维度重构问题',
                    'step back and try a completely different perspective',
                    'break out of this framing with a fresh angle'
                ];
                const allTexts = [...protoPhatic, ...protoPhaticBanter, ...protoPhaticEn, ...protoDrill, ...protoEscape];
                const vecs = await embedder(allTexts);
                if (!Array.isArray(vecs) || vecs.length !== allTexts.length) {
                    this._v3MetaAxesRetryAt = Date.now() + 5000;
                    return null;
                }
                const normAll = vecs.map(v => this._v3NormalizeVector(v));
                if (normAll.some(v => !v)) {
                    this._v3MetaAxesRetryAt = Date.now() + 5000;
                    return null;
                }
                const centroid = (slice) => this._v3WeightedCentroid(slice.map(vector => ({ vector, weight: 1 })));
                let off = 0;
                const phBaseSlice = normAll.slice(off, off + protoPhatic.length); off += protoPhatic.length;
                const phBanterSlice = normAll.slice(off, off + protoPhaticBanter.length); off += protoPhaticBanter.length;
                const phEnSlice = normAll.slice(off, off + protoPhaticEn.length); off += protoPhaticEn.length;
                const drillSlice = normAll.slice(off, off + protoDrill.length); off += protoDrill.length;
                const escapeSlice = normAll.slice(off);
                const muPhatic = centroid(phBaseSlice);
                const muPhaticBanter = centroid(phBanterSlice);
                const muPhaticEn = centroid(phEnSlice);
                const muDrill = centroid(drillSlice);
                const muEscape = centroid(escapeSlice);
                const eDrill = this._v3GramSchmidtOrthogonal(muDrill, muPhatic);
                const eEscape = this._v3GramSchmidtOrthogonal(muEscape, muPhatic);
                if (!muPhatic || !eDrill || !eEscape) {
                    this._v3MetaAxesRetryAt = Date.now() + 5000;
                    return null;
                }
                const qMetaRaw = this._v3WeightedCentroid([
                    { vector: eDrill, weight: 1 },
                    { vector: eEscape, weight: 1 }
                ]);
                const qMeta = this._v3GramSchmidtOrthogonal(qMetaRaw, muPhatic) || qMetaRaw;
                const diff = new Float64Array(eEscape.length);
                for (let i = 0; i < diff.length; i++) diff[i] = eEscape[i] - eDrill[i];
                const qModeStep = this._v3GramSchmidtOrthogonal(diff, qMeta) || this._v3NormalizeVector(diff);
                const qMode = this._v3GramSchmidtOrthogonal(qModeStep, muPhatic) || qModeStep;
                this._v3MetaAxesRetryAt = 0;
                this._v3MetaAxesCache = {
                    muPhatic,
                    muPhaticBanter,
                    muPhaticEn,
                    muDrill,
                    muEscape,
                    eDrill,
                    eEscape,
                    qMeta,
                    qMode,
                    phSamples: [...phBaseSlice, ...phBanterSlice, ...phEnSlice],
                    drillSamples: drillSlice,
                    escapeSamples: escapeSlice
                };
                return this._v3MetaAxesCache;
            } catch (_) {
                this._v3MetaAxesRetryAt = Date.now() + 5000;
                return null;
            } finally {
                this._v3MetaAxesPromise = null;
            }
        })();
        return this._v3MetaAxesPromise;
    }

    /**
     * 计算用户输入相对统一正交元指令子空间的纯张量形色分解（V3.8 QR 能量闭合）：
     * - 存在 epaMean 时，在与 V5.2 完全同源的 epaMean(β=0.7) 空间构造 2-pass MGS 正交基 [qrPhBasis, qMeta, qMode]，
     *   严格满足帕塞瓦尔能量闭合 E_ph + E_meta + E_color ≡ 1 与无量纲极性角 η_angle ∈ [-1, 1]（彻底消除跨坐标系减法与硬阈值栈）；
     * - 离线/无 epaMean（如合成单测）保持原始单位空间精确正交 QR 回退。
     */
    _v3EvalMetaPolarity(rawUserVec, alpha0 = 1.0, axes = null, options = {}) {
        const refAxes = axes || this._v3MetaAxesCache || null;
        if (!rawUserVec || !refAxes) {
            return { isMetaCmd: false, etaMode: 0 };
        }
        const u = this._v3NormalizeVector(rawUserVec);
        if (!u || u.length !== refAxes.muPhatic.length) {
            return { isMetaCmd: false, etaMode: 0 };
        }
        const epaMean = options?.epaMean || null;
        const shellXVecOpt = options?.shellXVec ? this._v3NormalizeVector(options.shellXVec) : null;
        const shellUserVec = (!shellXVecOpt && options?.shellUserVec) ? this._v3NormalizeVector(options.shellUserVec) : null;

        const hasEpa = Boolean(epaMean && epaMean.length === u.length);
        // 统一正交 QR 能量闭合路径：有 epaMean 时对齐 V5.2 epaMean(β=0.7) 切空间；无 epaMean 时退化为原单位空间恒等投影
        const centerTagSpace = (vec) => (hasEpa ? this._v3ToTagGlobalSpace(vec, epaMean) : this._v3NormalizeVector(vec));
        const gsOrtho = (vec, basis) => {
            const out = Float64Array.from(vec);
            for (let pass = 0; pass < 2; pass++) {
                for (const b of basis) {
                    const p = this._v3Dot(out, b);
                    for (let i = 0; i < out.length; i++) out[i] -= p * b[i];
                }
            }
            return this._v3NormalizeVector(out);
        };
        if (!(this._v3QrUnifiedByEpa instanceof Map)) {
            this._v3QrUnifiedByEpa = new Map();
        }
        const rawDigest = options?.epaDigest;
        let cacheKey = '__raw_unit_space__';
        if (hasEpa) {
            cacheKey = (typeof rawDigest === 'string' && rawDigest && rawDigest !== 'none') ? rawDigest : epaMean;
        }
        let qr = this._v3QrUnifiedByEpa.get(cacheKey) || null;
        if (!qr || qr.refAxes !== refAxes) {
            const phList = [refAxes.muPhatic, refAxes.muPhaticBanter, refAxes.muPhaticEn]
                .filter(Boolean)
                .map(centerTagSpace)
                .filter(Boolean);
            const phBasis = [];
            for (const pc of phList) {
                const b = gsOrtho(pc, phBasis);
                if (b) phBasis.push(b);
            }
            const xD = centerTagSpace(refAxes.muDrill || refAxes.eDrill);
            const xE = centerTagSpace(refAxes.muEscape || refAxes.eEscape);
            const metaSum = (xD && xE) ? this._v3WeightedCentroid([{ vector: xD, weight: 0.5 }, { vector: xE, weight: 0.5 }]) : null;
            const qMetaU = metaSum ? (gsOrtho(metaSum, phBasis) || metaSum) : null;
            const modeDiff = (xD && xE)
                ? this._v3NormalizeVector(Float64Array.from(xE, (v, i) => v - xD[i]))
                : null;
            const qModeU = modeDiff ? (gsOrtho(modeDiff, qMetaU ? [...phBasis, qMetaU] : phBasis) || modeDiff) : null;
            const metaBasis = [qMetaU, qModeU].filter(Boolean);
            qr = { refAxes, epaMean: hasEpa ? epaMean : null, phBasis, qMetaU, qModeU, metaBasis, calibByPool: new Map() };
            while (this._v3QrUnifiedByEpa.size >= 4) {
                const oldest = this._v3QrUnifiedByEpa.keys().next().value;
                if (oldest === undefined) break;
                this._v3QrUnifiedByEpa.delete(oldest);
            }
            this._v3QrUnifiedByEpa.set(cacheKey, qr);
        }

        const evalPhEnergy = (xVec) => {
            if (!xVec) return 0;
            // 单侧非负锥附和能量：反向附和分量 (dot < 0) 不计为附和
            let sumSq = 0;
            for (const b of qr.phBasis) {
                const c = Math.max(0, this._v3Dot(xVec, b));
                sumSq += c * c;
            }
            return Math.min(1, sumSq);
        };
        const evalMetaTuple = (xVec) => {
            const cm = qr.qMetaU ? Math.max(0, this._v3Dot(xVec, qr.qMetaU)) : 0;
            const cd = qr.qModeU ? this._v3Dot(xVec, qr.qModeU) : 0;
            return { cMeta: cm, cMode: cd, eMeta: Math.min(1, cm * cm + cd * cd) };
        };

        // 懒加载统一零分布校准（有实池用星池实测分布；无实池/合成单测用理论各向同性 Beta 零分布喂入同一主方程，彻底消除三轨分裂）
        const poolObj = options?.starPool || null;
        const poolCalibKey = poolObj?.stars?.length >= 16 ? (poolObj.versionKey || 'pool') : `iso:${u.length}`;
        if (!(qr.calibByPool instanceof Map)) qr.calibByPool = new Map();
        let calib = qr.calibByPool.get(poolCalibKey) || null;
        if (!calib) {
            const statOf = (arr) => {
                if (!arr.length) return { mean: 0, std: 0, q10: 0 };
                const sorted = arr.slice().sort((a, b) => a - b);
                const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
                const variance = arr.reduce((s, v) => s + (v - mean) * (v - mean), 0) / arr.length;
                return {
                    mean,
                    std: Math.sqrt(Math.max(0, variance)),
                    q10: sorted[Math.floor(sorted.length * 0.10)]
                };
            };
            let stPh0 = null;
            let stMt0 = null;
            let stCl0 = null;
            let stRm0 = null;
            let hasRealNull = false;
            if (poolObj?.stars?.length >= 16) {
                const ph0 = [], mt0 = [], cl0 = [], rm0 = [];
                for (const st of poolObj.stars) {
                    if (!st?.raw || st.raw.length !== u.length) continue;
                    const xS = centerTagSpace(st.raw);
                    if (!xS) continue;
                    const ep = evalPhEnergy(xS);
                    const { eMeta: em } = evalMetaTuple(xS);
                    const ec = Math.max(0, 1 - ep - em);
                    ph0.push(ep);
                    mt0.push(em);
                    cl0.push(ec);
                    rm0.push((em + ec) > 1e-9 ? (em / (em + ec)) : 0);
                }
                const cPh0 = statOf(ph0);
                const cMt0 = statOf(mt0);
                const cCl0 = statOf(cl0);
                const cRm0 = statOf(rm0);
                if (cPh0.std > 1e-4 && cMt0.std > 1e-4 && cCl0.std > 1e-4) {
                    stPh0 = cPh0;
                    stMt0 = cMt0;
                    stCl0 = cCl0;
                    stRm0 = cRm0;
                    hasRealNull = true;
                }
            }
            if (!hasRealNull) {
                // 无实池离线/合成先验零分布：由通用语义嵌入流形有效背景秩 d_lang = 40 与标准正交子空间维数 (k_ph=3, k_mt=2)
                // 经单侧 Beta(k/2, (d_lang - k)/2) 闭式导出，统一喂入唯一主轨 A 贝叶斯方程
                const dLang = 40;
                const kPhEff = Math.max(3, qr.phBasis.length);
                const kMtEff = Math.max(2, qr.metaBasis.length);
                const muPhIso = kPhEff / dLang;
                const sdPhIso = Math.sqrt((kPhEff * (dLang - kPhEff)) / (dLang * dLang * (dLang + 2)));
                const muMtIso = kMtEff / dLang;
                const sdMtIso = Math.sqrt((kMtEff * (dLang - kMtEff)) / (dLang * dLang * (dLang + 2)));
                const muClIso = 1 - muPhIso - muMtIso;
                const sdClIso = Math.sqrt(sdPhIso * sdPhIso + sdMtIso * sdMtIso);
                stPh0 = { mean: muPhIso, std: sdPhIso, q10: 0.5 * muPhIso };
                stMt0 = { mean: muMtIso, std: sdMtIso, q10: 0.5 * muMtIso };
                stCl0 = { mean: muClIso, std: sdClIso, q10: Math.max(0, muClIso - sdClIso) };
                stRm0 = { mean: muMtIso / (muMtIso + muClIso), std: sdMtIso, q10: 0 };
            }

            let muPhPlus = 0.56, sdPhPlus = 0.15, muMtNonMeta = 0;
            if (Array.isArray(refAxes.phSamples) && refAxes.phSamples.length > 0) {
                const arr = [], arrMt0 = [];
                for (const v of refAxes.phSamples) {
                    const xS = centerTagSpace(v);
                    arr.push(evalPhEnergy(xS));
                    arrMt0.push(evalMetaTuple(xS).eMeta);
                }
                const s = statOf(arr);
                const sMt0 = statOf(arrMt0);
                if (s.mean > stPh0.mean) {
                    muPhPlus = s.mean;
                    sdPhPlus = Math.max(1e-3, s.std);
                }
                muMtNonMeta = sMt0.mean;
            }
            let muMtPlus = 0.45, sdMtPlus = 0.10, muClPlus = 0.35, sdClPlus = 0.065;
            let muClDrill = 0.45, sdClDrill = 0.08;
            const drillSamples = Array.isArray(refAxes.drillSamples) ? refAxes.drillSamples : [];
            const escapeSamples = Array.isArray(refAxes.escapeSamples) ? refAxes.escapeSamples : [];
            const mtSamples = [...drillSamples, ...escapeSamples];
            if (drillSamples.length > 0) {
                const arrClD = [];
                for (const v of drillSamples) {
                    const xS = centerTagSpace(v);
                    const ep = evalPhEnergy(xS);
                    const { eMeta: em } = evalMetaTuple(xS);
                    arrClD.push(Math.max(0, 1 - ep - em));
                }
                const sClD = statOf(arrClD);
                if (sClD.mean < stCl0.mean) {
                    muClDrill = sClD.mean;
                    sdClDrill = Math.max(1e-3, sClD.std);
                }
            }
            let protoModeAngleScale = 0.25;
            if (mtSamples.length > 0) {
                const arrMt = [], arrCl = [], arrAngles = [];
                for (const v of mtSamples) {
                    const xS = centerTagSpace(v);
                    const ep = evalPhEnergy(xS);
                    const { cMeta: cm, cMode: cd, eMeta: em } = evalMetaTuple(xS);
                    arrMt.push(em);
                    arrCl.push(Math.max(0, 1 - ep - em));
                    arrAngles.push(Math.abs(cd) / Math.sqrt(cm * cm + cd * cd + stMt0.mean));
                }
                const sMt = statOf(arrMt);
                const sCl = statOf(arrCl);
                const sAng = statOf(arrAngles);
                if (sMt.mean > stMt0.mean) {
                    muMtPlus = sMt.mean;
                    sdMtPlus = Math.max(1e-3, sMt.std);
                }
                if (sCl.mean < stCl0.mean) {
                    muClPlus = sCl.mean;
                    sdClPlus = Math.max(1e-3, sCl.std);
                }
                if (sAng.mean > 0.05) {
                    protoModeAngleScale = sAng.mean;
                }
            }
            const thetaPhStar = (stPh0.mean * sdPhPlus + muPhPlus * stPh0.std) / (stPh0.std + sdPhPlus);
            const thetaMtStar = (stMt0.mean * sdMtPlus + muMtPlus * stMt0.std) / (stMt0.std + sdMtPlus);
            const thetaClStar = (stCl0.mean * sdClPlus + muClPlus * stCl0.std) / (stCl0.std + sdClPlus);
            const thetaClDrillStar = (stCl0.mean * sdClDrill + muClDrill * stCl0.std) / (stCl0.std + sdClDrill);
            // 正常实体的颜色能量落在零分布 99% 双侧置信区间 [μ_cl0 - z_{0.995}·σ_cl0, 1]（z_{0.995} = 2.5758）内；
            // 显著跌破该 99% 置信下界且伴随高元指令能量者为纯元指令
            const z995 = 2.5758293;
            const metaColorGateCut = Math.max(thetaClStar + stCl0.std, thetaClDrillStar, stCl0.mean - z995 * stCl0.std);

            let muPhShell0 = stPh0.mean;
            let sdPhShell0 = stPh0.std;
            let resEnergyNullMean = 0.25;
            if (hasRealNull) {
                // 采样最多 48 颗星，剥离其最近邻“非附和星”(evalPhEnergy < μ_ph0 + σ_ph0，与线上 L0 Tag 过滤 100% 同构)
                const nonPhTagCut = stPh0.mean + stPh0.std;
                const shPhArr = [];
                const shResEnergyArr = [];
                const shStep = Math.max(1, Math.floor(poolObj.stars.length / 48));
                for (let pi = 0; pi < poolObj.stars.length; pi += shStep) {
                    const stA = poolObj.stars[pi];
                    if (!stA?.z || !stA?.raw) continue;
                    let bestJ = -1;
                    let bestS = -Infinity;
                    for (let pj = 0; pj < poolObj.stars.length; pj++) {
                        if (pj === pi) continue;
                        const stB = poolObj.stars[pj];
                        if (!stB?.z || !stB?.raw) continue;
                        const s = this._v3Dot(stA.z, stB.z);
                        if (s > bestS) {
                            const xB = centerTagSpace(stB.raw);
                            if (xB && evalPhEnergy(xB) < nonPhTagCut) {
                                bestS = s;
                                bestJ = pj;
                            }
                        }
                    }
                    if (bestJ >= 0 && poolObj.stars[bestJ]?.raw) {
                        const strippedSt = this._v3StripBasisInEpaSpace(
                            stA.raw, [poolObj.stars[bestJ].raw], qr.epaMean, 0.05, qr.phBasis, qr.metaBasis, { skipInverse: true }
                        );
                        if (Number.isFinite(strippedSt.partialPh)) shPhArr.push(strippedSt.partialPh);
                        if (Number.isFinite(strippedSt.residualNorm) && strippedSt.residualNorm > 0) {
                            shResEnergyArr.push(strippedSt.residualNorm * strippedSt.residualNorm);
                        }
                    }
                }
                const stSh0 = statOf(shPhArr);
                if (shPhArr.length >= 4) {
                    muPhShell0 = stSh0.mean;
                    if (stSh0.std > 1e-4) sdPhShell0 = stSh0.std;
                }
                if (shResEnergyArr.length >= 4) {
                    resEnergyNullMean = shResEnergyArr.reduce((s, v) => s + v, 0) / shResEnergyArr.length;
                }
            }
            // 95% 单侧置信界 (z_{0.95} = 1.6448536)：在 +2σ 壳处跨过 0.5 后验中轴，同时守住英文 C4 零误伤
            const z95 = 1.6448536;
            const shellPhNullThresh = muPhShell0 + z95 * sdPhShell0;

            calib = {
                hasRealNull,
                muPh0: stPh0.mean, sdPh0: stPh0.std, q10Ph0: stPh0.q10,
                muPhShell0, sdPhShell0, shellPhNullThresh, resEnergyNullMean,
                muMt0: stMt0.mean, sdMt0: stMt0.std, q10Mt0: stMt0.q10, muMtNonMeta,
                muCl0: stCl0.mean, sdCl0: stCl0.std,
                muRMeta0: stRm0.mean, sdRMeta0: stRm0.std,
                muPhPlus, sdPhPlus, thetaPhStar,
                muMtPlus, sdMtPlus, thetaMtStar,
                muClPlus, sdClPlus, thetaClStar,
                thetaClDrillStar, metaColorGateCut, protoModeAngleScale
            };
            while (qr.calibByPool.size >= 4) {
                const oldest = qr.calibByPool.keys().next().value;
                if (oldest === undefined) break;
                qr.calibByPool.delete(oldest);
            }
            qr.calibByPool.set(poolCalibKey, calib);
        }

        const xU = centerTagSpace(u);
        const rawEPh = evalPhEnergy(xU);
        let shellXVec = null;
        if (shellXVecOpt && shellXVecOpt.length === u.length) {
            shellXVec = shellXVecOpt;
        } else if (shellUserVec && shellUserVec.length === u.length) {
            shellXVec = centerTagSpace(shellUserVec);
        }
        const shellEPh = shellXVec ? evalPhEnergy(shellXVec) : 0;
        const partialPh = Number.isFinite(Number(options?.partialPh)) ? Number(options.partialPh) : null;
        const partialCtrl = Number.isFinite(Number(options?.partialCtrl)) ? Number(options.partialCtrl) : partialPh;
        const partialMeta = (partialCtrl !== null && partialPh !== null)
            ? Math.max(0, partialCtrl - partialPh)
            : 0;

        const { cMeta: cMetaU, cMode: cModeU, eMeta: qrEMeta } = evalMetaTuple(xU);
        const qrEtaAngle = cModeU / Math.sqrt(cMetaU * cMetaU + cModeU * cModeU + Math.max(1e-4, calib.muMt0));

        const effPh = Math.max(rawEPh, shellEPh);
        const effMt = qrEMeta;
        const phDominatesMeta = partialPh === null
            ? (rawEPh >= effMt)
            : (partialPh >= partialMeta && rawEPh >= calib.muPh0);
        const qrEPh = phDominatesMeta ? effPh : rawEPh;
        const pPhaticCentered = hasEpa ? Math.sqrt(qrEPh) : null;
        const shellPhaticCentered = (hasEpa && shellXVec) ? Math.sqrt(shellEPh) : null;
        const qrEColor = Math.max(0, 1 - qrEPh - qrEMeta);
        const rMeta = (qrEMeta + qrEColor) > 1e-9 ? (qrEMeta / (qrEMeta + qrEColor)) : 0;

        // 统一纯张量 Schur 补残余信噪比附和度 sPh ∈ [0, 1]（无壳/有壳两路各自按自身零分布基准独立归一化再取 max，消除双乘门控偏差）
        const sig = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
        const sPhRaw = sig((rawEPh - calib.thetaPhStar) / Math.max(1e-4, calib.sdPh0));
        const shellResNorm = Number(options?.shellResidualNorm);
        const hasShell = Boolean(shellXVec || partialPh !== null);
        const resEnergyNull = Number.isFinite(calib.resEnergyNullMean) && calib.resEnergyNullMean > 0 ? calib.resEnergyNullMean : 0.25;
        const resEnergy = (Number.isFinite(shellResNorm) && shellResNorm > 0) ? (shellResNorm * shellResNorm) : resEnergyNull;
        const snrWeight = hasShell ? (resEnergy / (resEnergy + Math.max(1e-4, calib.sdPh0))) : 0;
        const sPhShell = shellXVec ? sig((shellEPh - calib.shellPhNullThresh) / Math.max(1e-4, calib.sdPhShell0)) : 0;
        const sPhPartial = partialPh === null ? 0 : sig((partialPh - calib.shellPhNullThresh) / Math.max(1e-4, calib.sdPhShell0));
        const rawAboveNullGate = sig((rawEPh - calib.q10Ph0) / Math.max(1e-4, 0.5 * calib.sdPh0));
        const phVsMetaGate = phDominatesMeta
            ? (1 / (1 + (effMt / Math.max(1e-6, qrEPh)) ** 2))
            : (1 / (1 + (effMt / Math.max(1e-6, rawEPh)) ** 2));
        const shellVsMetaGate = partialPh === null
            ? 1.0
            : (1 / (1 + (Math.max(0, partialMeta - partialPh) / Math.max(1e-6, partialPh)) ** 2));
        const sPhFromShell = Math.max(sPhShell, sPhPartial) * snrWeight * rawAboveNullGate * shellVsMetaGate;
        const rawDominance = hasShell
            ? sig((rawEPh - (calib.thetaPhStar + 2.0 * calib.sdPh0)) / Math.max(1e-4, calib.sdPh0))
            : 1.0;
        const phVsMetaGateAtNull = 1 / (1 + (calib.muMt0 / Math.max(1e-6, calib.muPh0)) ** 2);
        const sPhNullRaw = sig((calib.muPh0 - calib.thetaPhStar) / Math.max(1e-4, calib.sdPh0))
            * (hasShell ? sig((calib.muPh0 - (calib.thetaPhStar + 2.0 * calib.sdPh0)) / Math.max(1e-4, calib.sdPh0)) : 1.0)
            * phVsMetaGateAtNull;
        const rawAboveNullAtNull = sig((calib.muPh0 - calib.q10Ph0) / Math.max(1e-4, 0.5 * calib.sdPh0));
        const snrWeightAtNull = resEnergyNull / (resEnergyNull + Math.max(1e-4, calib.sdPh0));
        const sPhNullShell = hasShell
            ? (sig((calib.muPhShell0 - calib.shellPhNullThresh) / Math.max(1e-4, calib.sdPhShell0)) * snrWeightAtNull * rawAboveNullAtNull * phVsMetaGateAtNull)
            : 0;
        const sPhRawDebiased = Math.max(0, Math.min(1, (sPhRaw * rawDominance * phVsMetaGate - sPhNullRaw) / Math.max(1e-6, 1 - sPhNullRaw)));
        const sPhShellDebiased = hasShell
            ? Math.max(0, Math.min(1, (sPhFromShell * phVsMetaGate - sPhNullShell) / Math.max(1e-6, 1 - sPhNullShell)))
            : 0;
        const sPh = hasShell ? Math.max(sPhRawDebiased, sPhShellDebiased) : sPhRawDebiased;

        const isTechWrappedPhatic = Boolean(
            hasShell
            && phDominatesMeta
            && rawEPh >= calib.muPh0
            && sPhShellDebiased >= 0.5
        );
        const strongPhatic = sPh >= 0.5;

        const metaZ = (qrEMeta - calib.muMt0) / Math.max(1e-4, calib.sdMt0);
        const rMetaZ = (rMeta - calib.muRMeta0) / Math.max(1e-4, calib.sdRMeta0);
        const metaColorGateCut = calib.metaColorGateCut;
        const lowColorSubspace = (qrEColor < metaColorGateCut) || Boolean(options?.l0DomainCollapsed);
        // 双语强元指令保护：当 metaZ >= 2.0 且 rMetaZ >= 2.5 且低色区成立时，不因英语祈使句底噪把 etaMode 一刀切零
        const confirmedStrongMeta = metaZ >= 2.0 && rMetaZ >= 2.5 && lowColorSubspace;
        const isMetaCmd = (!strongPhatic || confirmedStrongMeta) && metaZ >= 1.5 && (lowColorSubspace || (rMetaZ >= 2.0 && alpha0 < 0.5));
        const clampContent = isMetaCmd && lowColorSubspace;

        const rMetaThresh = calib.muRMeta0 + 2.0 * calib.sdRMeta0;
        const rMetaExcess = Math.max(0, rMeta - rMetaThresh);
        const colorModeGate = sig((metaColorGateCut - qrEColor) / Math.max(1e-4, calib.sdCl0));
        let etaMode = 0;
        if ((!strongPhatic || confirmedStrongMeta) && (isMetaCmd || (rMetaZ >= 2.0 && metaZ >= 0.5 && lowColorSubspace))) {
            const strengthGain = isMetaCmd ? 1.0 : Math.min(1.0, rMetaExcess / Math.max(1e-4, calib.sdRMeta0));
            const modeGate = isMetaCmd ? 1.0 : colorModeGate;
            etaMode = Math.max(-1, Math.min(1, (qrEtaAngle / Math.max(0.05, calib.protoModeAngleScale)) * strengthGain * modeGate));
        }

        const phaticDamp = isMetaCmd ? 1.0 : (1 - sPh);

        // 统一 Wiener 经验贝叶斯连续剥色（无偏收缩 1 - μ_null/E，cleanNormSq > 0.04 数值稳定下界与附和底噪量纲解耦）
        let colorVector = null;
        const gammaMeta = qrEMeta > calib.q10Mt0
            ? Math.min(1, Math.max(0, (qrEMeta - calib.muMtNonMeta) / Math.max(1e-6, qrEMeta)))
            : 0;
        const gammaPh = (gammaMeta > 0 && rawEPh > calib.muPh0)
            ? 0.5 * Math.min(1, Math.max(0, (rawEPh - calib.muPh0) / Math.max(1e-6, rawEPh)))
            : 0;
        if (!clampContent && !strongPhatic && (gammaMeta > 1e-4 || gammaPh > 1e-4) && (qr.qMetaU || qr.qModeU)) {
            const xClean = Float64Array.from(xU);
            if (qr.qMetaU && gammaMeta > 0) {
                for (let i = 0; i < xClean.length; i++) xClean[i] -= gammaMeta * cMetaU * qr.qMetaU[i];
            }
            if (qr.qModeU && gammaMeta > 0) {
                for (let i = 0; i < xClean.length; i++) xClean[i] -= gammaMeta * cModeU * qr.qModeU[i];
            }
            if (gammaPh > 0 && qr.phBasis.length > 0) {
                for (const b of qr.phBasis) {
                    const proj = Math.max(0, this._v3Dot(xU, b));
                    if (proj > 0) {
                        for (let i = 0; i < xClean.length; i++) xClean[i] -= gammaPh * proj * b[i];
                    }
                }
            }
            let cleanNormSq = 0;
            for (let i = 0; i < xClean.length; i++) cleanNormSq += xClean[i] * xClean[i];
            // 残差模长 > 0.2（cleanNormSq > 0.04）的纯几何数值稳定性下界（与附和底噪量纲彻底解耦）
            if (cleanNormSq > 0.04) {
                if (hasEpa) {
                    const invFactor = 0.7 / 0.3;
                    const alignClean = this._v3Dot(xClean, epaMean);
                    const restored = new Float64Array(xClean.length);
                    for (let i = 0; i < xClean.length; i++) {
                        restored[i] = xClean[i] + invFactor * alignClean * epaMean[i];
                    }
                    colorVector = this._v3NormalizeVector(restored);
                } else {
                    colorVector = this._v3NormalizeVector(xClean);
                }
            }
        }

        return {
            isMetaCmd,
            clampContent,
            etaMode,
            rMeta,
            sPh,
            sPhFromShell,
            pPhaticCentered,
            shellPhaticCentered,
            isTechWrappedPhatic,
            phBasis: qr.phBasis,
            metaBasis: qr.metaBasis,
            phaticDamp,
            colorVector,
            qrEPh,
            qrEMeta,
            qrEColor,
            qrEtaAngle,
            calib
        };
    }

    /**
     * 统一纯张量附和与技术词外壳载荷门控（零 0.25 常数天花板：按颜色能量相对零分布置信下界的连续后验平滑压缩）
     */
    _v3ApplyPhaticContentGate(rawAlpha, metaPol) {
        const sPh = Number.isFinite(metaPol?.sPh) ? Math.max(0, Math.min(1, metaPol.sPh)) : 0;
        let baseAlpha = rawAlpha * (metaPol?.phaticDamp ?? 1.0);
        if (metaPol?.clampContent) {
            const calib = metaPol.calib;
            const sdCl = Math.max(1e-4, Number(calib?.sdCl0) || 0.05);
            const cutCl = Number.isFinite(Number(calib?.metaColorGateCut)) ? Number(calib.metaColorGateCut) : 0.75;
            const eCl = Number.isFinite(Number(metaPol.qrEColor)) ? Number(metaPol.qrEColor) : 0;
            const zCl = Math.max(-30, Math.min(30, (eCl - cutCl) / sdCl));
            // 当 qrEColor < metaColorGateCut 时 sigmoid < 0.5，clampCap 严格连续落在 (0, 0.25)，纯元指令越纯压得越低
            const clampCap = 0.5 / (1 + Math.exp(-zCl));
            baseAlpha = Math.min(rawAlpha, clampCap);
        }
        if (metaPol?.isTechWrappedPhatic) {
            const oneMinusS = 1 - sPh;
            return Math.min(baseAlpha, oneMinusS * oneMinusS);
        }
        return baseAlpha;
    }

    /**
     * 纯 Agent 轨迹运动学（统一 k ∈ {3, 4} 步受限半径亚扩散不变量 ρ_k ≤ halfStep/√2 ∧ R_k < 1）：
     * - 球面质心均方半径 ρ_k 与 halfStep/√2 严格同为 L¹ 弦长量纲，彻底消除 1D 余弦极值 vs 3D 单形体积量纲错配；
     * - 广义扩散比 R_k < 1 为受限盆地亚扩散，R_k ≥ 1 为弹道式单调推进（自动豁免单调及抖动单调深挖）；
     * - 100% 破解慢速紧盆地盘旋 (slowSpiral)，且非停滞态零噪声 mEndo = 0。
     */
    _v3ComputeAgentKinematics(historyAssistantVectors, rawPrevAiVec, manifold, starMeanAxis = null, betaStar = 0.85, options = {}) {
        const empty = {
            cSelf: null,
            cSelfPrev: null,
            kappaAi: null,
            collapse3: null,
            simplexVolume3: null,
            chordRatio: null,
            diffusionRatio4: null,
            basinRadiusK: null,
            torsion3: null,
            normalStep3: null,
            helicalDeepDive: false,
            returnSim: null,
            oscillating: false,
            stagnant: false,
            mEndo: 0
        };
        if (!rawPrevAiVec || !Array.isArray(historyAssistantVectors) || historyAssistantVectors.length === 0) {
            return empty;
        }
        const a1Raw = this._v3NormalizeVector(rawPrevAiVec);
        const a2Raw = this._v3NormalizeVector(historyAssistantVectors[historyAssistantVectors.length - 1]);
        const a3Raw = historyAssistantVectors.length >= 2
            ? this._v3NormalizeVector(historyAssistantVectors[historyAssistantVectors.length - 2])
            : null;
        const a4Raw = historyAssistantVectors.length >= 3
            ? this._v3NormalizeVector(historyAssistantVectors[historyAssistantVectors.length - 3])
            : null;
        if (!a1Raw || !a2Raw || a1Raw.length !== a2Raw.length) {
            return empty;
        }
        const z1 = this._v3ToStarVector(a1Raw, manifold, starMeanAxis, betaStar);
        const z2 = this._v3ToStarVector(a2Raw, manifold, starMeanAxis, betaStar);
        if (!z1 || !z2 || z1.length !== z2.length) {
            return empty;
        }
        const pool = options?.starPool || null;
        const hasPoolScale = Boolean(
            pool
            && Number.isFinite(pool?.pairStdCos) && pool.pairStdCos > 1e-6
        );
        const effRank = Math.max(8, Math.min(z1.length, 128));
        const pairStdCos = hasPoolScale ? pool.pairStdCos : (1 / Math.sqrt(effRank));
        const ft = (Number.isFinite(pool?.gumbelBN) && pool.gumbelBN > 1.0)
            ? { tau: pool.tauExtremeZ, bN: pool.gumbelBN }
            : this._v3FisherTippettParams(hasPoolScale ? (pool.stars?.length || 716) : effRank * 4);
        // 与星池规模 N 及密度解耦：仅锚定嵌入流形固有随机零分布尺度 σ_pair（万星扩编时维持稳定，避免密池漏检真停滞）
        const halfStep = Math.sqrt(2 * Math.sqrt(3) * pairStdCos);
        // 纯欧氏/球面外接圆临界半径（L¹ 弦长量纲）：4 步 90° 闭环在单步 halfStep 下的精确半径 halfStep/√2
        const basinRadiusCrit = halfStep / Math.SQRT2;
        // 3D 单形临界体积（严格 L² 面积量纲）：√2 · basinRadiusCrit² = halfStep² / √2（716 星 ≈ 0.221）
        const volCritL2 = (halfStep * halfStep) / Math.SQRT2;
        // 2 步单步冻结弦长下界（L¹ 弦长量纲）：小于 halfStep/2（约 cos > 0.961）
        const freezeStepL1 = 0.5 * halfStep;
        const pairMeanCos = Number.isFinite(pool?.pairMeanCos) ? pool.pairMeanCos : 0;

        const cSelf = this._v3Dot(z1, z2);
        const step12 = Math.sqrt(Math.max(0, 2 * (1 - cSelf)));
        let cSelfPrev = null;
        let collapse3 = null;
        let simplexVolume3 = null;
        let chordRatio = null;
        let diffusionRatio4 = null;
        let basinRadiusK = null;
        let torsion3 = null;
        let normalStep3 = null;
        let kappaAi = null;
        let c13 = null;
        let c14 = null;

        const z3 = (a3Raw && a3Raw.length === a1Raw.length)
            ? this._v3ToStarVector(a3Raw, manifold, starMeanAxis, betaStar)
            : null;
        if (z3) {
            cSelfPrev = this._v3Dot(z2, z3);
            c13 = this._v3Dot(z1, z3);
            collapse3 = (cSelf + cSelfPrev + c13) / 3;
            const det3 = 1 + 2 * cSelf * cSelfPrev * c13 - cSelf * cSelf - cSelfPrev * cSelfPrev - c13 * c13;
            simplexVolume3 = Math.sqrt(Math.max(0, det3));
            chordRatio = (1 - c13) / Math.max(1e-6, (1 - cSelf) + (1 - cSelfPrev));
            basinRadiusK = Math.sqrt(Math.max(0, (2 / 9) * ((1 - cSelf) + (1 - cSelfPrev) + (1 - c13))));
            const dCurr = this._v3GramSchmidtOrthogonal(z1, z2);
            const dPrev = this._v3GramSchmidtOrthogonal(z2, z3);
            if (dCurr && dPrev) {
                kappaAi = this._v3Dot(dCurr, dPrev);
            }
        }
        const z4 = (a4Raw && a4Raw.length === a1Raw.length)
            ? this._v3ToStarVector(a4Raw, manifold, starMeanAxis, betaStar)
            : null;
        if (z4 && z3) {
            c14 = this._v3Dot(z1, z4);
            const c24 = this._v3Dot(z2, z4);
            const c34 = this._v3Dot(z3, z4);
            diffusionRatio4 = (1 - c14) / Math.max(1e-6, (1 - cSelf) + (1 - cSelfPrev) + (1 - c34));
            basinRadiusK = Math.sqrt(Math.max(
                0,
                ((1 - cSelf) + (1 - cSelfPrev) + (1 - c34) + (1 - c13) + (1 - c24) + (1 - c14)) / 8
            ));
            // 4步离散 Frenet 扭率 / 自旋不变量：复用 2×2 Gram 正交投影（含 rank-1 对称角平分线退化），
            // 避免 det G_2 -> 0 的 0/0 奇异点，并用绝对法向位移 δ_{⊥,3} = ‖v_3‖ · τ_3 过滤高维微噪假高扭率。
            const v1 = new Float64Array(z1.length);
            const v2 = new Float64Array(z1.length);
            const v3 = new Float64Array(z1.length);
            for (let i = 0; i < z1.length; i++) {
                v1[i] = z3[i] - z4[i];
                v2[i] = z2[i] - z3[i];
                v3[i] = z1[i] - z2[i];
            }
            const v1Unit = this._v3NormalizeVector(v1);
            const v2Unit = this._v3NormalizeVector(v2);
            if (v1Unit && v2Unit) {
                const orthoTorsion = this._v3OrthogonalizePlane(v3, v1Unit, v2Unit, 0, false);
                torsion3 = Number.isFinite(orthoTorsion.novelty) ? orthoTorsion.novelty : 0;
                normalStep3 = step12 * torsion3;
            } else {
                torsion3 = 0;
                normalStep3 = 0;
            }
        }

        const returnSim = (c13 !== null || c14 !== null)
            ? Math.max(c13 ?? -1, c14 ?? -1)
            : null;
        const effReturnChord = (c13 !== null && cSelfPrev !== null)
            ? ((1 - (returnSim ?? c13)) / Math.max(1e-6, (1 - cSelf) + (1 - cSelfPrev)))
            : chordRatio;

        // 1) 乒乓振荡：有效折返弦比小于等边极限 0.5、回跳越过 Fisher-Tippett 极值 b_N，且 3D 体积低于 L² 临界体积
        const returnZ = (returnSim !== null) ? ((returnSim - pairMeanCos) / Math.max(1e-6, pairStdCos)) : 0;
        const oscillating = Boolean(
            effReturnChord !== null
            && effReturnChord < 0.5
            && returnZ >= ft.bN
            && (simplexVolume3 === null || simplexVolume3 <= volCritL2)
            && step12 > halfStep
        );
        // 2) 分层受限半径停滞定律：
        //    - 3 步 (k=3)：3 点不足以区分“紧盆地深耕”与“慢速外旋”，需同时满足 3D 体积塌缩 V_3 ≤ volCritL2（L² 量纲）
        //      且 120° 折返 (chordRatio ≤ 0.5 ∧ step12 ≤ halfStep) 或单步冻结 (chordRatio < 1.5 ∧ step12 ≤ freezeStepL1)；
        //    - 4 步 (k=4)：引入第 4 步后可解析区分“持续深耕”与“慢速紧盆地盘旋”，
        //      diffusionRatio4 为平方距离比，理论无偏布朗亚扩散临界值为 R_4 < 1.0；
        //      配合球面质心均方半径 ρ_4 ≤ halfStep/√2（L¹ 量纲）精确捕获 75°~120° 慢速盘旋且零误报！
        const basin3Collapsed = Boolean(
            simplexVolume3 !== null
            && simplexVolume3 <= volCritL2
            && (
                (chordRatio <= 0.5 && step12 <= halfStep)
                || (chordRatio < 1.5 && step12 <= freezeStepL1)
            )
        );
        const spiral4Collapsed = Boolean(
            diffusionRatio4 !== null
            && basinRadiusK !== null
            && basinRadiusK <= basinRadiusCrit
            && diffusionRatio4 < 1.0
        );
        // 紧盆地 3D 螺旋上升深钻豁免：若 4 步受限半径亚扩散但非振荡，且最后一步既有高 Frenet 扭率 (τ_3 >= 1/√3)
        // 又有实质绝对法向位移 (δ_{⊥,3} >= halfStep/√3)，说明在同盆地内持续掀开正交新维度，豁免停滞误报。
        const normalCritL1 = halfStep / Math.sqrt(3);
        const helicalDeepDive = Boolean(
            spiral4Collapsed
            && !oscillating
            && step12 > freezeStepL1
            && torsion3 !== null
            && normalStep3 !== null
            && torsion3 >= (1 / Math.sqrt(3))
            && normalStep3 >= normalCritL1
        );
        const stagnant = Boolean(
            oscillating
            || (simplexVolume3 === null && step12 <= freezeStepL1)
            || (!helicalDeepDive && (basin3Collapsed || spiral4Collapsed))
        );

        // 非停滞态零噪声 (mEndo = 0)；仅在确认停滞/振荡时给正向破局推力
        let mEndo = 0;
        if (stagnant) {
            const rDef = basinRadiusK === null ? 0 : Math.max(0, (basinRadiusCrit - basinRadiusK) / Math.max(1e-6, basinRadiusCrit));
            const sDef = Math.max(0, (freezeStepL1 - step12) / Math.max(1e-6, freezeStepL1));
            const oDef = oscillating && effReturnChord !== null
                ? Math.max(0, (0.5 - effReturnChord) / 0.5)
                : 0;
            mEndo = Math.min(1.0, 0.5 + 0.5 * Math.max(rDef, sDef, oDef));
        }

        return {
            cSelf,
            cSelfPrev,
            kappaAi,
            collapse3,
            simplexVolume3,
            chordRatio,
            diffusionRatio4,
            basinRadiusK,
            torsion3,
            normalStep3,
            helicalDeepDive,
            returnSim,
            oscillating,
            stagnant,
            mEndo
        };
    }

    /**
     * 纯几何主星背景惯性差分校准（零角色名、零字数阈值、单轮恒等保真）：
     * 当存在与本轮纯用户向量 z_user 不同的背景轴 z_bg（上轮 aiVec / 全局 Tag 去噪向量）时，
     * 在保持 V5.2 原生分 v5Score 为主导的前提下，叠加连续差分项 λ · (⟨z_i, z_user⟩ - ⟨z_i, z_bg⟩)：
     * - 单轮或 z_user == z_bg 时差分严格为 0，100% 保持 V5.2 原始排序；
     * - 多轮时自然抑制“仅靠上轮/背景惯性虚高、对本轮用户新意偏低”的残留星，抬升本轮新意星；
     * - 低意图载荷附和轮（如“继续/好的/加油”）由 calibrationWeight = 0.28 · α_user 自动平滑衰减，避免扣掉正在讨论的主话题。
     */
    _v3CalibratePrimaryCandidates(primaryCandidates, zUser, zBg, starPool, vectorCache, toZ, calibrationWeight = 0.28) {
        if (!Array.isArray(primaryCandidates) || primaryCandidates.length === 0 || !zUser || !zBg) {
            return primaryCandidates;
        }
        const parsedWeight = (calibrationWeight === null || calibrationWeight === undefined || calibrationWeight === '')
            ? NaN
            : Number(calibrationWeight);
        const weight = Number.isFinite(parsedWeight) ? Math.max(0, parsedWeight) : 0.28;
        if (weight <= 1e-6 || this._v3Dot(zUser, zBg) >= 0.999) {
            return primaryCandidates;
        }
        return primaryCandidates.map((item) => {
            const cid = Number(item?.chunkId ?? item?.id);
            const stMeta = this._v3LookupStarMeta(starPool, item);
            const zV = stMeta?.z || (Number.isSafeInteger(cid) && vectorCache.has(cid) ? toZ(vectorCache.get(cid)) : null);
            if (!zV) return item;
            const v5Score = Number(item?.score) || 0;
            const userAlign = Math.max(0, this._v3Dot(zV, zUser));
            const bgAlign = Math.max(0, this._v3Dot(zV, zBg));
            const calibrated = v5Score + weight * (userAlign - bgAlign);
            return { ...item, score: calibrated, rawV5Score: v5Score };
        });
    }

    /**
     * 同轮个人记忆正交桥（三级兜底：真实唤醒日记 → 狮子 V5.2 Tag 空间 matchedTags 桥 → zDenoised）：
     * 投影到星池切空间 z 并剥离 (z1, z2) 张成平面；当向量几何正交偏移显著时自动剥离上轮 zPrevAi 残留。
     */
    async _v3BuildDiaryBridge(vdb, activeDiaryChunks, diaryNames, manifold, starMeanAxis, betaStar, z1, z2, zDenoised, vectorCache, options = {}) {
        const excludeSet = new Set(Array.isArray(diaryNames) ? diaryNames : []);
        const zPrevAi = options.zPrevAi || null;
        const rawShift = Number(options.timeFlowShift);
        let effShift = 0;
        if (Number.isFinite(rawShift)) {
            effShift = Math.max(0, Math.min(1, rawShift));
        } else if (options.timeFlowMode === 'orthogonal' || options.timeFlowMode === 'topic-jump') {
            effShift = 1.0;
        }
        let minNovelty = 0.12;
        if (options.bridgeEpsilon !== undefined && Number.isFinite(Number(options.bridgeEpsilon))) {
            minNovelty = Math.max(0, Number(options.bridgeEpsilon));
        } else if (options.minNovelty !== undefined && Number.isFinite(Number(options.minNovelty))) {
            minNovelty = Math.max(0, Number(options.minNovelty));
        }
        const orthogonalize = (vec) => {
            let cur = this._v3NormalizeVector(vec);
            if (!cur) return { vector: null, novelty: 0 };
            if (zPrevAi && effShift > 1e-4 && cur.length === zPrevAi.length) {
                const projPrev = this._v3Dot(cur, zPrevAi);
                if (projPrev > 0) {
                    const damp = Math.min(1.0, effShift * 1.25);
                    const cleaned = new Float64Array(cur.length);
                    for (let i = 0; i < cur.length; i++) {
                        cleaned[i] = cur[i] - damp * projPrev * zPrevAi[i];
                    }
                    cur = cleaned; // 保留阻尼后真实模长，交由 2×2 Gram 一步量出精确总残差
                }
            }
            return this._v3OrthogonalizePlane(cur, z1, z2, minNovelty, true);
        };

        const deduped = new Map();
        for (const item of Array.isArray(activeDiaryChunks) ? activeDiaryChunks : []) {
            const cid = Number(item?.chunkId ?? item?.id);
            const dName = String(item?.diaryName || '');
            if (!Number.isSafeInteger(cid) || cid <= 0) continue;
            if (excludeSet.has(dName) || dName.endsWith('簇')) continue;
            const rawItemScore = Number(item?.score);
            const score = (Number.isFinite(rawItemScore) && rawItemScore > 0) ? rawItemScore : 0.2;
            const topologyBonus = Math.max(0, Number(item?.riverMemo?.topologyBonus ?? item?.topologyBonus) || 0);
            const riverRole = item?.riverMemo?.role || item?.riverRole || item?.role || null;
            const prev = deduped.get(cid);
            if (!prev) {
                deduped.set(cid, { chunkId: cid, score, topologyBonus, riverRole });
            } else {
                const useNewRole = score >= prev.score ? riverRole : prev.riverRole;
                deduped.set(cid, {
                    chunkId: cid,
                    score: Math.max(prev.score, score),
                    topologyBonus: Math.max(prev.topologyBonus, topologyBonus),
                    riverRole: useNewRole || prev.riverRole || riverRole
                });
            }
        }
        const topDiaries = Array.from(deduped.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, 8);

        if (topDiaries.length > 0) {
            await this._v3FetchChunkVectors(vdb, topDiaries.map(d => d.chunkId), vectorCache);
            const topoBudgetCT = 0.08; // RiverMemo 默认拓扑预算常数 C_T
            const maxScore = Math.max(1e-6, ...topDiaries.map(d => d.score));
            const rawFootprints = [];
            let validDiaryCount = 0;
            let maxRawNovelty = 0;

            for (const d of topDiaries) {
                const raw = vectorCache.get(d.chunkId);
                if (!raw) continue;
                const z = this._v3ToStarVector(raw, manifold, starMeanAxis, betaStar);
                if (!z) continue;
                validDiaryCount++;
                const ortho = orthogonalize(z);
                if (ortho.novelty > maxRawNovelty) maxRawNovelty = ortho.novelty;
                if (!ortho.vector) continue;

                const baseRel = d.score / maxScore;
                const topoGain = 1 + (d.topologyBonus / topoBudgetCT);
                const rawWeight = ortho.novelty * baseRel * topoGain;
                rawFootprints.push({
                    chunkId: d.chunkId,
                    vector: ortho.vector,
                    novelty: ortho.novelty,
                    topologyBonus: d.topologyBonus,
                    riverRole: d.riverRole,
                    rawWeight
                });
            }

            if (rawFootprints.length > 0) {
                const maxRawW = Math.max(1e-9, ...rawFootprints.map(f => f.rawWeight));
                const footprints = rawFootprints.map(f => ({
                    chunkId: f.chunkId,
                    vector: f.vector,
                    novelty: f.novelty,
                    weight: f.novelty * (f.rawWeight / maxRawW),
                    topologyBonus: f.topologyBonus,
                    riverRole: f.riverRole
                }));
                const centroid = this._v3WeightedCentroid(
                    footprints.map(f => ({ vector: f.vector, weight: f.weight }))
                );
                const mainVec = this._v3NormalizeVector(centroid) || footprints[0].vector;
                return {
                    vector: mainVec,
                    novelty: maxRawNovelty,
                    footprints,
                    count: validDiaryCount,
                    source: 'active-diaries'
                };
            }
            if (validDiaryCount > 0) {
                return {
                    vector: null,
                    novelty: maxRawNovelty,
                    footprints: [],
                    count: validDiaryCount,
                    source: 'active-diaries-saturated'
                };
            }
        }

        // 第二级兜底：无被动日记时，借狮子 V5.2 Tag 空间 (.vcpwf) 命中的 matchedTags 搭桥
        // （经真实消融证实：L1 残差在带元词句 C4 上含修辞残余，专注服务公式 ∂_2 与 qOrthoZ 退化兜底，不覆写 Star 3 桥）
        const matchedTags = Array.isArray(options.matchedTags) ? options.matchedTags.slice(0, 6) : [];
        if (matchedTags.length > 0) {
            const tagVecs = await this._v3GetTagVectors(vdb, matchedTags);
            const weighted = [];
            for (let i = 0; i < matchedTags.length; i++) {
                const raw = tagVecs.get(matchedTags[i]);
                if (!raw) continue;
                const z = this._v3ToStarVector(raw, manifold, starMeanAxis, betaStar);
                if (z) weighted.push({ vector: z, weight: 1 / (1 + i * 0.25) });
            }
            const centroid = this._v3WeightedCentroid(weighted);
            if (centroid) {
                const ortho = orthogonalize(centroid);
                return {
                    vector: ortho.vector,
                    novelty: ortho.novelty,
                    footprints: [],
                    count: weighted.length,
                    source: ortho.vector ? 'v5-tag-bridge' : 'v5-tag-bridge-saturated'
                };
            }
        }

        if (zDenoised) {
            const ortho = orthogonalize(zDenoised);
            return {
                vector: ortho.vector,
                novelty: ortho.novelty,
                footprints: [],
                count: 0,
                source: ortho.vector ? 'v5-denoised' : 'v5-denoised-saturated'
            };
        }
        return { vector: null, novelty: 0, footprints: [], count: 0, source: 'none' };
    }

    /**
     * 纯几何对话演进时间轴流矢 v_τ（零文本正则、零字数阈值，优先消费纯 AI 运动学 trajectory，保留 historySegments 兼容兜底）：
     * - v_τ = norm(z_now - max(0, ⟨z_now, z_prev⟩) · z_prev)
     * - 一阶：cCurr = ⟨z_now, z_prev⟩，shift = clamp01((0.15 - cCurr) / 0.25) * effIntentLoad
     * - 二阶（优先用纯 AI 轨迹 A_{t-2} 避免连续两句附和击穿 segmentContext）：
     *   严格区分：正常深耕 (deepen_steady) / 往外跳 (explore_jump) / 跳完落地深挖 (post_jump_deepen) /
     *   折返合龙 (dialectic_return) / 纯 AI 高相似停滞 (stagnation_loop)
     */
    _v3TimeFlowAxis(_userText, userVec, aiVec, denoisedVec, fallbackQuery, z1, manifold, starMeanAxis = null, betaStar = 0.85, historySegments = null, userIntentLoad = 1.0, options = {}) {
        const zNow = this._v3ToStarVector(userVec || fallbackQuery, manifold, starMeanAxis, betaStar);
        const zPrev = this._v3ToStarVector(aiVec, manifold, starMeanAxis, betaStar);
        const zDenoised = this._v3ToStarVector(denoisedVec || fallbackQuery, manifold, starMeanAxis, betaStar);
        const parsedIntentLoad = (userIntentLoad === null || userIntentLoad === undefined || userIntentLoad === '')
            ? NaN
            : Number(userIntentLoad);
        const effIntentLoad = Number.isFinite(parsedIntentLoad)
            ? Math.max(0, Math.min(1, parsedIntentLoad))
            : 1.0;

        const kin = options?.agentKinematics || null;
        const hasPureAiBaseline = Boolean(kin && Number.isFinite(kin.cSelf));

        let zSeg = null;
        if (!hasPureAiBaseline && Array.isArray(historySegments) && historySegments.length > 0) {
            let anchorIdx = historySegments.length - 1;
            while (
                anchorIdx > 0
                && Array.isArray(historySegments[anchorIdx]?.roles)
                && historySegments[anchorIdx].roles.length > 0
                && historySegments[anchorIdx].roles.every(r => r === 'user')
            ) {
                anchorIdx--;
            }
            const lastSegVec = historySegments[anchorIdx]?.assistantVector || historySegments[anchorIdx]?.vector;
            if (lastSegVec) {
                zSeg = this._v3ToStarVector(lastSegVec, manifold, starMeanAxis, betaStar);
            }
        }

        if (zNow && zPrev && zNow.length === zPrev.length) {
            const continuity = this._v3Dot(zNow, zPrev);
            const tfPool = options?.starPool || null;
            const pairMean = Number.isFinite(tfPool?.pairMeanCos) ? tfPool.pairMeanCos : 0;
            const pairStd = (Number.isFinite(tfPool?.pairStdCos) && tfPool.pairStdCos > 1e-4)
                ? tfPool.pairStdCos
                : (1 / Math.sqrt(Math.max(128, zNow.length)));
            // 以星池无关向量对零分布 (μ_pair, σ_pair) 的精确标准正态生存函数 pCont = 1 - Φ(z) 自标定偏移与跳变边界（C^∞ 光滑，零分段折线魔数）
            const zCont = (continuity - pairMean) / pairStd;
            const pCont = 1 - this._v3NormalCdf(zCont);
            const rawShift = Math.min(1, 2 * pCont);
            const shift = rawShift * effIntentLoad;
            let mode = 'advance';
            if (pCont >= 0.30) mode = 'orthogonal';
            else if (pCont >= 0.005) mode = 'pivot';

            let cPrev = hasPureAiBaseline ? kin.cSelf : null;
            let cAnchor = null;
            const canExploreJump = pCont > 0.10 && effIntentLoad >= 0.5;
            let phase = canExploreJump ? 'explore_jump' : 'steady';

            if (hasPureAiBaseline) {
                const pPrevCont = 1 - this._v3NormalCdf((cPrev - pairMean) / pairStd);
                if (canExploreJump) {
                    phase = 'explore_jump';
                } else if (kin.stagnant) {
                    phase = 'stagnation_loop';
                } else if (pPrevCont > 0.10 && pCont <= 0.01) {
                    phase = 'post_jump_deepen';
                } else {
                    phase = 'deepen_steady';
                }
            } else if (zSeg && zSeg.length === zNow.length) {
                cPrev = this._v3Dot(zPrev, zSeg);
                cAnchor = this._v3Dot(zNow, zSeg);
                const pPrevCont = 1 - this._v3NormalCdf((cPrev - pairMean) / pairStd);
                const pAnchorCont = 1 - this._v3NormalCdf((cAnchor - pairMean) / pairStd);
                if (pPrevCont > 0.10 && pCont <= 0.01) {
                    phase = 'post_jump_deepen';
                } else if (Math.min(continuity, cPrev, cAnchor) > Math.SQRT1_2) {
                    phase = 'stagnation_loop';
                } else if (canExploreJump && pAnchorCont <= 0.01) {
                    phase = 'dialectic_return';
                } else if (canExploreJump) {
                    phase = 'explore_jump';
                } else {
                    phase = 'deepen_steady';
                }
            }

            const subtract = Math.max(0, continuity);
            const diff = new Float64Array(zNow.length);
            let normSq = 0;
            for (let i = 0; i < zNow.length; i++) {
                diff[i] = zNow[i] - subtract * zPrev[i];
                normSq += diff[i] * diff[i];
            }
            if (normSq > 1e-4) {
                return { vector: this._v3NormalizeVector(diff), continuity, shift, mode, cPrev, cAnchor, phase, intentLoad: effIntentLoad };
            }
            const fallbackSame = (zDenoised && z1)
                ? this._v3GramSchmidtOrthogonal(zDenoised, z1)
                : (zDenoised || zNow);
            return { vector: fallbackSame || zNow, continuity, shift, mode, cPrev, cAnchor, phase, intentLoad: effIntentLoad };
        }
        const fallback = (zDenoised && z1) ? this._v3GramSchmidtOrthogonal(zDenoised, z1) : zDenoised;
        return { vector: fallback, continuity: null, shift: 0, mode: 'initial', cPrev: null, cAnchor: null, phase: 'initial', intentLoad: effIntentLoad };
    }

    async _v3QueryStarPool(vdb, diaryNames, text, vector, prepared, options = {}) {
        const topK = options.topK ?? 24;
        const candidateK = options.candidateK ?? 128;
        if (!vector) return { results: [], engine: 'none', diagnostics: null };
        if (options.lowLoadPrimaryResult && !options.includeTrace) {
            return options.lowLoadPrimaryResult;
        }
        const lowLoadCacheKey = options.lowLoadCacheKey || null;
        if (lowLoadCacheKey && vdb && typeof vdb === 'object' && !options.includeTrace) {
            if (!(this._v3LowLoadObsCache instanceof WeakMap)) {
                this._v3LowLoadObsCache = new WeakMap();
            }
            const vdbCache = this._v3LowLoadObsCache.get(vdb);
            const hit = vdbCache?.get(lowLoadCacheKey);
            if (hit && (Date.now() - hit.cachedAt) < 15000 && hit.primaryQuery) {
                vdbCache.delete(lowLoadCacheKey);
                vdbCache.set(lowLoadCacheKey, hit);
                return hit.primaryQuery;
            }
        }
        if (typeof vdb?.executeNativeRiverQuery === 'function') {
            const response = await vdb.executeNativeRiverQuery(
                { text: String(text || ''), vector: Array.from(vector) },
                {
                    diaryNames,
                    topK,
                    candidateK,
                    preparedMemoObservation: prepared || undefined,
                    // 经 500 条真实星池查询 Dev/Holdout 消融验证：关闭 includeTrace 仅 0.8% 星 2 差异、0W/0L 未来退化，
                    // 同时减少 64% FFI JSON 体积（2.77x）并压平 GC 长尾；允许调试通过 options.includeTrace 显式开启。
                    includeTrace: options.includeTrace === true
                }
            );
            const out = {
                results: Array.isArray(response?.results) ? response.results : [],
                engine: response?.diagnostics?.degraded
                    ? (response.diagnostics.retrievalEngine || 'warped_ann')
                    : 'rivermemo-v5.2',
                diagnostics: response?.diagnostics || null,
                omega: response?.omega || null,
                queryMorphology: response?.diagnostics?.queryProfile?.mode || null,
                queryMorphologyWeights: response?.queryMorphology || response?.diagnostics?.queryProfile?.morphology || null,
                matchedTags: Array.isArray(response?.queryTags?.matchedTags)
                    ? response.queryTags.matchedTags
                    : []
            };
            if (lowLoadCacheKey && vdb && typeof vdb === 'object' && !options.includeTrace && options.lowLoadObsSnapshot) {
                if (!(this._v3LowLoadObsCache instanceof WeakMap)) {
                    this._v3LowLoadObsCache = new WeakMap();
                }
                let vdbCache = this._v3LowLoadObsCache.get(vdb);
                if (!vdbCache) {
                    vdbCache = new Map();
                    this._v3LowLoadObsCache.set(vdb, vdbCache);
                }
                vdbCache.delete(lowLoadCacheKey);
                while (vdbCache.size >= 16) {
                    const oldest = vdbCache.keys().next().value;
                    if (oldest === undefined) break;
                    vdbCache.delete(oldest);
                }
                vdbCache.set(lowLoadCacheKey, {
                    ...options.lowLoadObsSnapshot,
                    primaryQuery: out,
                    cachedAt: Date.now()
                });
            }
            return out;
        }
        if (typeof vdb?.searchKnn === 'function') {
            const collected = [];
            for (const name of diaryNames) {
                const rows = await vdb.searchKnn(name, vector, Math.min(24, topK));
                if (Array.isArray(rows)) collected.push(...rows);
            }
            return { results: collected, engine: 'knn-fallback', diagnostics: null };
        }
        return { results: [], engine: 'unavailable', diagnostics: null };
    }

    /**
     * V3.2 纯张量三体分离器（全库 V5 流形 × 星池双层去中心化切空间 z × 非负锥清场 × 个人记忆正交桥）：
     * - 星1 (势陷 ∂_A): 与作者 RiverMemo V5.2 共享观测同源，消费同轮河网与属门接地主星
     * - 星2 (势陷 ∇_B): 在全星池去中心化 z 空间中按正交张力 + 上下文耦合 × 光滑反镜像清场精确求解
     * - 星3 (思奇 v_∞(C ⊖ φ)): 按时空抛飞扭矩 (p·d²) + 同轮个人记忆正交桥 + Laplace 平滑 2 跳 PMI 图 × 二维非负锥清场精确求解
     */
    _selectV3TrinityStars(candidates, options = {}) {
        const deduplicated = Array.isArray(options.deduplicatedCandidates)
            ? options.deduplicatedCandidates
            : this._v3DedupeCandidates(candidates);
        if (deduplicated.length === 0) return [];

        const vectorByChunkId = options.vectorByChunkId instanceof Map ? options.vectorByChunkId : new Map();
        const manifold = options.manifold || null;
        const starPool = options.starPool || null;
        const starMeanAxis = options.starMeanAxis || starPool?.starMeanAxis || null;
        const betaStar = options.betaStar ?? starPool?.betaStar ?? 0.85;

        const resolveStarMeta = (item) => {
            const cached = this._v3LookupStarMeta(starPool, item);
            if (cached) {
                return cached;
            }
            const id = Number(item?.chunkId ?? item?.id);
            const raw = Number.isSafeInteger(id) ? (vectorByChunkId.get(id) || null) : null;
            const x = raw ? this._v3ToGlobalSpace(raw, manifold) : null;
            const z = x ? this._v3ToStarSpace(x, starMeanAxis, betaStar) : null;
            let radius;
            if (manifold?.radiusByChunkId && Number.isSafeInteger(id) && manifold.radiusByChunkId.has(id)) {
                radius = manifold.radiusByChunkId.get(id);
            } else if (raw && manifold?.alignmentQuantiles && manifold?.meanAxis && raw.length === manifold.meanAxis.length) {
                radius = this._v3ComputeChunkQuantileRadius(this._v3Dot(raw, manifold.meanAxis), manifold.alignmentQuantiles);
            } else {
                radius = manifold?.defaultRadius ?? 0.63;
            }
            return { x, z, radius, leg: null };
        };
        const hasFlatZMatrix = Boolean(
            starPool?.zMatrix
            && starPool?.indexByStarName
            && starPool?.zDim > 0
        );
        const flatZMatrix = hasFlatZMatrix ? starPool.zMatrix : null;
        const flatZDim = hasFlatZMatrix ? starPool.zDim : 0;
        const flatZIndex = hasFlatZMatrix ? starPool.indexByStarName : null;

        const zQuery = this._v3NormalizeVector(options.zQuery);
        const zExpQuery = options.zExpQuery !== undefined
            ? this._v3NormalizeVector(options.zExpQuery)
            : zQuery;
        const tensionTangentZ = this._v3NormalizeVector(options.tensionTangentZ || options.tensionTangent);
        const ejectImpulseZ = this._v3NormalizeVector(options.ejectImpulseZ || options.ejectImpulse);
        const timeFlowZ = this._v3NormalizeVector(options.timeFlowZ);
        const diaryBridgeZ = this._v3NormalizeVector(options.diaryBridgeZ);
        const rawModeM = Number(options.modeM);
        const modeM = Number.isFinite(rawModeM) ? Math.max(-1, Math.min(1, rawModeM)) : 0;
        const escapePhase = Math.max(0, modeM);
        const hasV37Modality = Boolean(options.useV37Modality) || Math.abs(modeM) > 1e-4;
        const zPrevAiRef = this._v3NormalizeVector(options.zPrevAiRef);

        // 1. 第一颗星 (势陷 ∂_A)
        let primary = options.lockedPrimary || null;
        if (!primary) {
            const primaryPool = Array.isArray(options.primaryCandidates) && options.primaryCandidates.length > 0
                ? this._v3DedupeCandidates(options.primaryCandidates)
                : deduplicated;
            const sortedByPrimary = [...primaryPool].sort((a, b) =>
                (Number(b.item.score) || 0) - (Number(a.item.score) || 0)
            );
            primary = { ...sortedByPrimary[0], slot: 'primary', source: 'rivermemo-v5.2-shared' };
        }
        const m1 = resolveStarMeta(primary.item);
        if (primary.radius === undefined || primary.radius === null) {
            primary = { ...primary, radius: m1.radius };
        }
        const x1 = m1.x;
        const z1 = m1.z || x1;
        const r1 = m1.radius;
        const leg1 = m1.leg;

        // 2. 第二颗星 (势陷 ∇_B): 在全星池去中心化 z 空间精确求解强张力对偶星
        const remainingForSecond = deduplicated.filter(entry => entry.starName !== primary.starName);
        if (remainingForSecond.length === 0) {
            return [primary];
        }
        const effPairMean = Number.isFinite(starPool?.pairMeanCos) ? starPool.pairMeanCos : 0;
        const effPairStd = (Number.isFinite(starPool?.pairStdCos) && starPool.pairStdCos > 1e-6)
            ? starPool.pairStdCos
            : (1 / Math.sqrt(Math.max(4, z1?.length || 128)));
        const ftDiary = (Number.isFinite(starPool?.gumbelBN) && starPool.gumbelBN > 1.0 && Number.isFinite(starPool?.gumbelAN))
            ? { aN: starPool.gumbelAN, bN: starPool.gumbelBN }
            : this._v3FisherTippettParams(starPool?.stars?.length || Math.max(64, remainingForSecond.length));
        // 锚定有效维数 σ_pair 的 χ₂ 99.9% 单轴标尺（与 N 及局部密化 orthTopScale 严格无关，杜绝万星扩编时清场变松/甜点贴脸）
        const chi2Radius999 = Math.sqrt(2 * Math.log(1000)) * effPairStd;
        const starNeighborScale = Math.min(1 / Math.SQRT2, Math.max(0.15, chi2Radius999));
        // 2D 正交非负锥 99.9% χ₂ 极值外切半径 √2 · chi2Radius999 = 2√(ln 1000)·σ_pair
        const coneClearScale = Math.min(1 / Math.SQRT2, Math.max(0.20, Math.SQRT2 * chi2Radius999));
        const coarseSub = (
            hasFlatZMatrix
            && starPool?.coarseSubspace?.zMatrixK
            && starPool?.coarseSubspace?.uk
            && starPool.coarseSubspace.k > 0
            && starPool.coarseSubspace.k < flatZDim
        ) ? starPool.coarseSubspace : null;
        const coarseM = coarseSub
            ? Math.min(starPool.stars.length, Math.max(128, Math.ceil(2 * Math.sqrt(starPool.stars.length))))
            : 0;
        let conjugate = options.lockedConjugate || null;
        if (!conjugate) {
            let bestSecondEntry = remainingForSecond[0];
            let bestSecondScore = -Infinity;
            let bestSecondHasVec = false;
            let bestSecondCos1 = 0;
            let bestSecondTension = 0;
            let bestSecondConeGain = 0;
            let bestSecondPenalty = 1.0;
            const qBaseB1 = (zQuery && z1) ? this._v3Dot(zQuery, z1) : 0;
            const qBaseSq = Math.max(0, qBaseB1) ** 2;

            let evalSecondCandidates = remainingForSecond;
            if (coarseSub && (tensionTangentZ || zQuery) && remainingForSecond.length > coarseM * 2) {
                const cK = coarseSub.k;
                const cZMatK = coarseSub.zMatrixK;
                const cUk = coarseSub.uk;
                const z1K = z1 ? this._v3ProjectToSubspace(z1, cUk, cK, flatZDim) : null;
                const zQK = zQuery ? this._v3ProjectToSubspace(zQuery, cUk, cK, flatZDim) : null;
                const tanZK = tensionTangentZ ? this._v3ProjectToSubspace(tensionTangentZ, cUk, cK, flatZDim) : null;
                if ((!z1 || z1K) && (!zQuery || zQK) && (!tensionTangentZ || tanZK)) {
                    const qB1K = (zQK && z1K) ? this._v3Dot(zQK, z1K) : 0;
                    const qBSqK = Math.max(0, qB1K) ** 2;
                    const cScores = new Float32Array(remainingForSecond.length);
                    const unindexed = [];
                    for (let idx = 0; idx < remainingForSecond.length; idx++) {
                        const entry = remainingForSecond[idx];
                        const flatIdx = flatZIndex.get(entry.starName);
                        if (flatIdx === undefined) {
                            cScores[idx] = -Infinity;
                            unindexed.push(entry);
                            continue;
                        }
                        const offK = flatIdx * cK;
                        const cos1K = z1K ? this._v3DotFlat(z1K, cZMatK, offK) : 0;
                        const tenK = tanZK ? Math.max(0, this._v3DotFlat(tanZK, cZMatK, offK)) : 0;
                        let coneGainK = 0;
                        if (zQK) {
                            const b2K = this._v3DotFlat(zQK, cZMatK, offK);
                            coneGainK = z1K
                                ? Math.sqrt(Math.max(0, this._v3ConeProjSq2(qB1K, b2K, cos1K) - qBSqK))
                                : Math.max(0, b2K);
                        }
                        const antiK = z1K
                            ? (Math.sqrt(Math.max(0, 1 - cos1K * cos1K)) / (1 + (Math.abs(cos1K) / starNeighborScale) ** 6))
                            : 1.0;
                        const rawK = tanZK ? (0.5 * tenK + 0.5 * coneGainK) : coneGainK;
                        cScores[idx] = rawK * antiK;
                    }
                    const topIdx = this._v3CoarseSelectTopIndices(cScores, remainingForSecond.length, coarseM);
                    evalSecondCandidates = unindexed;
                    for (let t = 0; t < topIdx.length; t++) {
                        if (cScores[topIdx[t]] > -Infinity) {
                            evalSecondCandidates.push(remainingForSecond[topIdx[t]]);
                        }
                    }
                }
            }

            for (let idx = 0; idx < evalSecondCandidates.length; idx++) {
                const entry = evalSecondCandidates[idx];
                const c = entry.item;
                const flatIdx = flatZIndex ? flatZIndex.get(entry.starName) : undefined;
                const useFlat = flatIdx !== undefined && (!z1 || flatZDim === z1.length);
                let zi = null;
                let cos1z = 0;
                let tensionAlign = 0;
                let coneGainQ = 0;
                let hasVec = false;

                if (useFlat) {
                    const off = flatIdx * flatZDim;
                    hasVec = Boolean(tensionTangentZ || zQuery);
                    cos1z = z1 ? this._v3DotFlat(z1, flatZMatrix, off) : 0;
                    tensionAlign = tensionTangentZ ? Math.max(0, this._v3DotFlat(tensionTangentZ, flatZMatrix, off)) : 0;
                    if (zQuery) {
                        const b2 = this._v3DotFlat(zQuery, flatZMatrix, off);
                        if (z1) {
                            const extSq = this._v3ConeProjSq2(qBaseB1, b2, cos1z);
                            coneGainQ = Math.sqrt(Math.max(0, extSq - qBaseSq));
                        } else {
                            coneGainQ = Math.max(0, b2);
                        }
                    }
                } else {
                    const mi = resolveStarMeta(c);
                    zi = mi.z || mi.x;
                    cos1z = (zi && z1) ? this._v3Dot(zi, z1) : 0;
                    tensionAlign = (zi && tensionTangentZ) ? Math.max(0, this._v3Dot(zi, tensionTangentZ)) : 0;
                    if (zi && zQuery) {
                        if (z1) {
                            const b2 = this._v3Dot(zQuery, zi);
                            const extSq = this._v3ConeProjSq2(qBaseB1, b2, cos1z);
                            coneGainQ = Math.sqrt(Math.max(0, extSq - qBaseSq));
                        } else {
                            coneGainQ = Math.max(0, this._v3Dot(zi, zQuery));
                        }
                    }
                    hasVec = Boolean(zi && (tensionTangentZ || zQuery));
                }

                // 尺度化正交清场（与 Star 3 coneClearance 同源 6 次有理清场）：√(1 - c²) / (1 + (|c| / starNeighborScale)⁶)
                const antiMirrorPenalty = ((useFlat || zi) && z1)
                    ? (Math.sqrt(Math.max(0, 1 - cos1z * cos1z)) / (1 + (Math.abs(cos1z) / starNeighborScale) ** 6))
                    : 1.0;
                let rawSecondScore = Number(c.score) || 0;
                if (hasVec) {
                    rawSecondScore = tensionTangentZ
                        ? (0.5 * tensionAlign + 0.5 * coneGainQ)
                        : coneGainQ;
                }

                const composite = rawSecondScore * antiMirrorPenalty;
                const isBetter = hasVec
                    ? (!bestSecondHasVec || composite > bestSecondScore)
                    : (!bestSecondHasVec && composite > bestSecondScore);
                if (isBetter) {
                    bestSecondHasVec = hasVec;
                    bestSecondScore = composite;
                    bestSecondEntry = entry;
                    bestSecondCos1 = cos1z;
                    bestSecondTension = tensionAlign;
                    bestSecondConeGain = coneGainQ;
                    bestSecondPenalty = antiMirrorPenalty;
                }
            }
            const bestSecondMeta = resolveStarMeta(bestSecondEntry.item);
            const bestSecond = {
                ...bestSecondEntry,
                cos1: bestSecondCos1,
                radius: bestSecondMeta.radius,
                tensionAlign: bestSecondTension,
                qAlign: bestSecondConeGain,
                antiMirrorPenalty: bestSecondPenalty
            };
            if (x1 && bestSecondMeta.x) {
                const hm = this._v3HyperbolicMetric(r1, x1, bestSecondMeta.radius, bestSecondMeta.x, manifold, leg1, bestSecondMeta.leg);
                bestSecond.distH1 = hm.distance;
                bestSecond.regime1 = hm.regime;
                if (leg1 && bestSecondMeta.leg) {
                    const throatCrit1 = Math.max(0.25, leg1.angle + bestSecondMeta.leg.angle);
                    bestSecond.rho1 = hm.theta / throatCrit1;
                }
            }
            conjugate = { ...bestSecond, slot: 'conjugate', orthoScore: bestSecondScore };
        }
        const m2 = resolveStarMeta(conjugate.item);
        if (options.onlyFirstTwo) {
            return [primary, conjugate];
        }
        const x2 = m2.x;
        const z2 = m2.z || x2;
        const r2 = m2.radius;
        const leg2 = m2.leg;

        // 3. 第三颗星 (思奇 v_∞(C ⊖ φ)): 扭矩差(p·d²) + 同轮个人记忆正交桥 + 连续温控模态 × 非负锥清场
        const remainingForThird = remainingForSecond.filter(entry => entry.starName !== conjugate.starName);
        if (remainingForThird.length === 0) {
            return [primary, conjugate];
        }

        const g12 = (z1 && z2) ? this._v3Dot(z1, z2) : 0;
        const makeConePre3 = (target) => {
            if (!target || !z1 || !z2) return null;
            const b1 = this._v3Dot(target, z1);
            const b2 = this._v3Dot(target, z2);
            const baseSq = this._v3ConeProjSq2(b1, b2, g12);
            const rCone = Math.sqrt(Math.max(0.05, 1 - baseSq));
            return { b1, b2, g12, baseSq, rCone };
        };
        const diaryPre = makeConePre3(diaryBridgeZ);
        const tauPre = makeConePre3(timeFlowZ);

        // 无尺度纯张量正交上界标定（严格 IIA：仅依赖 χ₂ 统计标尺 starNeighborScale 与正交余量 rCone，扩编不变）
        const diaryScale = starNeighborScale * (diaryPre?.rCone ?? 1.0);
        const tauScale = starNeighborScale * (tauPre?.rCone ?? 1.0);

        const rawDiaryNovelty = Number(options.diaryBridgeNovelty);
        const diaryNoveltyGain = Number.isFinite(rawDiaryNovelty)
            ? Math.max(0, rawDiaryNovelty)
            : 1.0;

        // 逐篇多峰边缘足迹（Boundary Footprint）：预计算每篇日记正交向量在 (z1, z2) 下的非负锥基线与 Fisher-Tippett 尾事件门控尺度
        const fpEntries = [];
        for (const fp of Array.isArray(options.diaryFootprints) ? options.diaryFootprints : []) {
            const vec = this._v3NormalizeVector(fp?.vector);
            const weight = Math.max(0, Number(fp?.weight) || 0);
            if (!vec || weight <= 0) continue;
            const pre = makeConePre3(vec);
            if (!pre) continue;
            fpEntries.push({
                vec,
                weight,
                b1: pre.b1,
                b2: pre.b2,
                baseSq: pre.baseSq,
                scale: starNeighborScale * pre.rCone
            });
        }
        const diaryTailFloor = Math.max(0, effPairMean) + 0.5 * ftDiary.bN * effPairStd;
        const diaryTailScale = Math.max(1e-4, ftDiary.aN * effPairStd);

        // 纯无参双通道比例（裁撤零收益 Thermostat 与生产死代码 wPmi）：wTorque = 2/3, wDiary = 1/3
        const wTorque = 2 / 3;
        const wDiary = 1 / 3;
        // Rayleigh 抛飞扭矩甜点 p* = min(1/√3, starNeighborScale)
        const torqueSweetSpot = Math.min(1 / Math.sqrt(3), starNeighborScale);

        let bestThirdEntry = remainingForThird[0];
        let bestThirdScore = -Infinity;
        let bestThirdHasVec = false;
        let bestThirdMeta = null;
        let bestTorqueOnlyName = null;
        let bestTorqueOnlyScore = -Infinity;

        const dPreB1 = diaryPre ? diaryPre.b1 : 0;
        const dPreB2 = diaryPre ? diaryPre.b2 : 0;
        const dPreBaseSq = diaryPre ? diaryPre.baseSq : 0;
        const tPreB1 = tauPre ? tauPre.b1 : 0;
        const tPreB2 = tauPre ? tauPre.b2 : 0;
        const tPreBaseSq = tauPre ? tauPre.baseSq : 0;
        const invSweetSpot = 1 / Math.max(1e-6, torqueSweetSpot);
        const drillPhase = hasV37Modality ? Math.max(0, -modeM) : 0;
        const repelAnchor = (hasV37Modality && escapePhase > 0) ? (zPrevAiRef || z1) : null;

        let evalThirdCandidates = remainingForThird;
        if (coarseSub && z1 && z2 && remainingForThird.length > coarseM * 2) {
            const cK = coarseSub.k;
            const cZMatK = coarseSub.zMatrixK;
            const cUk = coarseSub.uk;
            const z1K = this._v3ProjectToSubspace(z1, cUk, cK, flatZDim);
            const z2K = this._v3ProjectToSubspace(z2, cUk, cK, flatZDim);
            if (z1K && z2K) {
                const g12K = this._v3Dot(z1K, z2K);
                const makePreK = (target) => {
                    if (!target) return null;
                    const tK = this._v3ProjectToSubspace(target, cUk, cK, flatZDim);
                    if (!tK) return null;
                    const b1 = this._v3Dot(tK, z1K);
                    const b2 = this._v3Dot(tK, z2K);
                    const baseSq = this._v3ConeProjSq2(b1, b2, g12K);
                    return { vec: tK, b1, b2, baseSq, scale: starNeighborScale * Math.sqrt(Math.max(0.05, 1 - baseSq)) };
                };
                const ejK = ejectImpulseZ ? this._v3ProjectToSubspace(ejectImpulseZ, cUk, cK, flatZDim) : null;
                const tauK = makePreK(timeFlowZ);
                const diaryPreK = fpEntries.length === 0 ? makePreK(diaryBridgeZ) : null;
                const fpEntriesK = fpEntries.map(fp => {
                    const pre = makePreK(fp.vec);
                    return pre ? { ...pre, weight: fp.weight } : null;
                }).filter(Boolean);
                const repelK = repelAnchor ? this._v3ProjectToSubspace(repelAnchor, cUk, cK, flatZDim) : null;

                const s3Scores = new Float32Array(remainingForThird.length);
                const tOnlyScores = new Float32Array(remainingForThird.length);
                const unindexed3 = [];
                for (let idx = 0; idx < remainingForThird.length; idx++) {
                    const entry = remainingForThird[idx];
                    const flatIdx = flatZIndex.get(entry.starName);
                    if (flatIdx === undefined) {
                        s3Scores[idx] = -Infinity;
                        tOnlyScores[idx] = -Infinity;
                        unindexed3.push(entry);
                        continue;
                    }
                    const offK = flatIdx * cK;
                    const cos1 = this._v3DotFlat(z1K, cZMatK, offK);
                    const cos2 = this._v3DotFlat(z2K, cZMatK, offK);
                    let dBridge = 0;
                    if (fpEntriesK.length > 0) {
                        for (let m = 0; m < fpEntriesK.length; m++) {
                            const fp = fpEntriesK[m];
                            const b3 = this._v3DotFlat(fp.vec, cZMatK, offK);
                            const g = Math.sqrt(Math.max(0, this._v3ConeProjSq3(fp.b1, fp.b2, b3, g12K, cos1, cos2) - fp.baseSq));
                            const sat = g / (g + Math.max(1e-6, fp.scale));
                            const gate = this._v3NormalCdf((g - diaryTailFloor) / diaryTailScale);
                            const pk = fp.weight * sat * gate;
                            if (pk > dBridge) dBridge = pk;
                        }
                    } else if (diaryPreK) {
                        const b3 = this._v3DotFlat(diaryPreK.vec, cZMatK, offK);
                        const dRaw = Math.sqrt(Math.max(0, this._v3ConeProjSq3(diaryPreK.b1, diaryPreK.b2, b3, g12K, cos1, cos2) - diaryPreK.baseSq));
                        dBridge = (dRaw / (dRaw + Math.max(1e-6, diaryPreK.scale))) * diaryNoveltyGain;
                    }
                    let tauGain = 0;
                    if (tauK) {
                        const b3 = this._v3DotFlat(tauK.vec, cZMatK, offK);
                        tauGain = Math.sqrt(Math.max(0, this._v3ConeProjSq3(tauK.b1, tauK.b2, b3, g12K, cos1, cos2) - tauK.baseSq));
                    }
                    const coneProj = Math.sqrt(this._v3ConeProjSq2(cos1, cos2, g12K));
                    const coneClear = Math.sqrt(Math.max(0, 1 - coneProj * coneProj)) / (1 + (coneProj / coneClearScale) ** 6);
                    const pAl = ejK ? Math.max(0, this._v3DotFlat(ejK, cZMatK, offK)) : torqueSweetSpot;
                    const uRay = pAl * invSweetSpot;
                    const uRaySq = uRay * uRay;
                    const bite = Math.min(1.0, uRaySq * Math.exp(1 - uRaySq));
                    const normTau = tauK ? (tauGain / (tauGain + Math.max(1e-6, tauK.scale))) : bite;
                    const td = 0.5 * bite + 0.5 * normTau;
                    let effTorque = wTorque * td;
                    let sc = (wTorque * td + wDiary * dBridge) * coneClear;
                    if (hasV37Modality) {
                        if (drillPhase > 0) {
                            const prox = 0.5 * Math.max(0, cos1) + 0.5 * Math.max(0, cos2);
                            const drillT = (1 - 0.30 * drillPhase) * td + 0.30 * drillPhase * prox;
                            effTorque = wTorque * drillT;
                            sc = (effTorque + wDiary * dBridge) * coneClear;
                        } else if (escapePhase > 0) {
                            const pRep = repelK ? Math.max(0, this._v3DotFlat(repelK, cZMatK, offK)) : 0;
                            const rep = 1.0 - 0.30 * escapePhase * pRep;
                            effTorque = wTorque * td * rep;
                            sc = sc * rep;
                        }
                    }
                    s3Scores[idx] = sc;
                    tOnlyScores[idx] = effTorque * coneClear;
                }
                const topS3 = this._v3CoarseSelectTopIndices(s3Scores, remainingForThird.length, coarseM);
                const topTorque = this._v3CoarseSelectTopIndices(tOnlyScores, remainingForThird.length, coarseM);
                const seen = new Set();
                evalThirdCandidates = [...unindexed3];
                for (let t = 0; t < topS3.length; t++) {
                    const idx3 = topS3[t];
                    if (s3Scores[idx3] > -Infinity && !seen.has(idx3)) {
                        seen.add(idx3);
                        evalThirdCandidates.push(remainingForThird[idx3]);
                    }
                }
                for (let t = 0; t < topTorque.length; t++) {
                    const idx3 = topTorque[t];
                    if (tOnlyScores[idx3] > -Infinity && !seen.has(idx3)) {
                        seen.add(idx3);
                        evalThirdCandidates.push(remainingForThird[idx3]);
                    }
                }
            }
        }

        const evalThirdCount = evalThirdCandidates.length;
        const hasVecArr = new Uint8Array(evalThirdCount);
        const evalPoolIndices = new Int32Array(evalThirdCount);
        evalPoolIndices.fill(-1);
        const rawTorqueArr = new Float64Array(evalThirdCount);
        const diaryBridgeArr = new Float64Array(evalThirdCount);
        const coneClearanceArr = new Float64Array(evalThirdCount);
        const cos1Arr = new Float64Array(evalThirdCount);
        const cos2Arr = new Float64Array(evalThirdCount);
        const coneProjArr = new Float64Array(evalThirdCount);
        const coneEscapeArr = new Float64Array(evalThirdCount);
        const pAlignArr = new Float64Array(evalThirdCount);
        const normTauGainArr = new Float64Array(evalThirdCount);
        const prevAlignArr = new Float64Array(evalThirdCount);
        const fallbackScoreArr = new Float64Array(evalThirdCount);

        for (let idx = 0; idx < evalThirdCount; idx++) {
            const entry = evalThirdCandidates[idx];
            const c = entry.item;
            const flatIdx = flatZIndex ? flatZIndex.get(entry.starName) : undefined;
            const useFlat = Boolean(flatIdx !== undefined && z1 && z2 && flatZDim === z1.length && flatZDim === z2.length);
            let zi = null;
            let hasVec = false;

            if (useFlat) {
                hasVec = true;
            } else {
                const mi = resolveStarMeta(c);
                zi = mi.z || mi.x;
                hasVec = Boolean(zi && z1 && z2);
            }

            if (hasVec) {
                hasVecArr[idx] = 1;
                if (flatIdx !== undefined) evalPoolIndices[idx] = flatIdx;
                const off = useFlat ? (flatIdx * flatZDim) : 0;
                const cos1 = useFlat ? this._v3DotFlat(z1, flatZMatrix, off) : this._v3Dot(zi, z1);
                const cos2 = useFlat ? this._v3DotFlat(z2, flatZMatrix, off) : this._v3Dot(zi, z2);
                let diaryBridge = 0;
                if (fpEntries.length > 0) {
                    for (let m = 0; m < fpEntries.length; m++) {
                        const fp = fpEntries[m];
                        const b3 = useFlat ? this._v3DotFlat(fp.vec, flatZMatrix, off) : this._v3Dot(fp.vec, zi);
                        const extSq = this._v3ConeProjSq3(fp.b1, fp.b2, b3, g12, cos1, cos2);
                        const g = Math.sqrt(Math.max(0, extSq - fp.baseSq));
                        const sat = g / (g + Math.max(1e-6, fp.scale));
                        const gate = this._v3NormalCdf((g - diaryTailFloor) / diaryTailScale);
                        const peak = fp.weight * sat * gate;
                        if (peak > diaryBridge) diaryBridge = peak;
                    }
                } else if (diaryBridgeZ) {
                    const b3 = useFlat ? this._v3DotFlat(diaryBridgeZ, flatZMatrix, off) : this._v3Dot(diaryBridgeZ, zi);
                    const extSq = this._v3ConeProjSq3(dPreB1, dPreB2, b3, g12, cos1, cos2);
                    const diaryRaw = Math.sqrt(Math.max(0, extSq - dPreBaseSq));
                    diaryBridge = (diaryRaw / (diaryRaw + Math.max(1e-6, diaryScale))) * diaryNoveltyGain;
                }
                let tauGain = 0;
                if (timeFlowZ) {
                    const b3 = useFlat ? this._v3DotFlat(timeFlowZ, flatZMatrix, off) : this._v3Dot(timeFlowZ, zi);
                    const extSq = this._v3ConeProjSq3(tPreB1, tPreB2, b3, g12, cos1, cos2);
                    tauGain = Math.sqrt(Math.max(0, extSq - tPreBaseSq));
                }

                const coneProj = Math.sqrt(this._v3ConeProjSq2(cos1, cos2, g12));
                const coneEscape = Math.sqrt(Math.max(0, 1 - coneProj * coneProj));
                // 固定 99.9% χ₂ 置信半径 2√(ln 1000)·σ_pair + 光滑 6 次有理清场
                const coneClearance = coneEscape / (1 + (coneProj / coneClearScale) ** 6);

                const pAlign = ejectImpulseZ
                    ? Math.max(0, useFlat ? this._v3DotFlat(ejectImpulseZ, flatZMatrix, off) : this._v3Dot(zi, ejectImpulseZ))
                    : torqueSweetSpot;
                const uRay = pAlign * invSweetSpot;
                const uRaySq = uRay * uRay;
                const biteTorque = Math.min(1.0, uRaySq * Math.exp(1 - uRaySq));
                const normTauGain = timeFlowZ ? (tauGain / (tauGain + Math.max(1e-6, tauScale))) : biteTorque;
                const rawTorqueDeficit = 0.5 * biteTorque + 0.5 * normTauGain;

                cos1Arr[idx] = cos1;
                cos2Arr[idx] = cos2;
                diaryBridgeArr[idx] = diaryBridge;
                coneProjArr[idx] = coneProj;
                coneEscapeArr[idx] = coneEscape;
                coneClearanceArr[idx] = coneClearance;
                pAlignArr[idx] = pAlign;
                normTauGainArr[idx] = normTauGain;
                rawTorqueArr[idx] = rawTorqueDeficit;
                if (hasV37Modality && escapePhase > 0 && repelAnchor) {
                    prevAlignArr[idx] = Math.max(0, useFlat ? this._v3DotFlat(repelAnchor, flatZMatrix, off) : this._v3Dot(zi, repelAnchor));
                }
            } else {
                fallbackScoreArr[idx] = Number(c.score) || 0;
            }
        }

        // Star 3 净新增曝光通道 U_new(x | s1, s2) 与 Rayleigh torqueDeficit 一阶尺度守恒几何融合
        let fusedTorqueArr = rawTorqueArr;
        let uniqueExposureCdfArr = null;
        const expIdx3 = (
            starPool?.exposureIndex3
            && starPool.exposureIndex3.nStars === starPool.stars?.length
            && starPool.exposureIndex3.dim === flatZDim
        ) ? starPool.exposureIndex3 : null;
        const s1ExpIdx = (expIdx3 && primary?.starName && flatZIndex) ? flatZIndex.get(primary.starName) : undefined;
        const s2ExpIdx = (expIdx3 && conjugate?.starName && flatZIndex) ? flatZIndex.get(conjugate.starName) : undefined;
        if (expIdx3 && zExpQuery && zExpQuery.length === expIdx3.dim && s1ExpIdx !== undefined && s2ExpIdx !== undefined && evalThirdCount >= 2) {
            const uNewRaw = this._v3ComputeUniqueExposureScores(expIdx3, zExpQuery, s1ExpIdx, s2ExpIdx, evalPoolIndices);
            if (uNewRaw) {
                let uSum = 0;
                let uCount = 0;
                for (let idx = 0; idx < evalThirdCount; idx++) {
                    if (hasVecArr[idx] && Number.isFinite(uNewRaw[idx])) {
                        uSum += uNewRaw[idx];
                        uCount++;
                    }
                }
                if (uCount >= 2) {
                    const uMean = uSum / uCount;
                    let uVarAcc = 0;
                    for (let idx = 0; idx < evalThirdCount; idx++) {
                        if (hasVecArr[idx] && Number.isFinite(uNewRaw[idx])) {
                            const d = uNewRaw[idx] - uMean;
                            uVarAcc += d * d;
                        }
                    }
                    const uStd = Math.sqrt(uVarAcc / uCount);
                    if (uStd > 1e-9) {
                        const invUStd = 1 / uStd;
                        const tempUCdf = new Float64Array(evalThirdCount);
                        const gArr = new Float64Array(evalThirdCount);
                        let sumRawTorque = 0;
                        let sumG = 0;
                        for (let idx = 0; idx < evalThirdCount; idx++) {
                            if (hasVecArr[idx] && Number.isFinite(uNewRaw[idx])) {
                                const uc = this._v3NormalCdf((uNewRaw[idx] - uMean) * invUStd);
                                const g = Math.sqrt(Math.max(0, rawTorqueArr[idx]) * uc);
                                tempUCdf[idx] = uc;
                                gArr[idx] = g;
                                sumRawTorque += rawTorqueArr[idx];
                                sumG += g;
                            } else {
                                tempUCdf[idx] = NaN;
                            }
                        }
                        if (sumRawTorque > 1e-12 && sumG > 1e-12) {
                            const scale = sumRawTorque / sumG;
                            fusedTorqueArr = new Float64Array(rawTorqueArr);
                            for (let idx = 0; idx < evalThirdCount; idx++) {
                                if (hasVecArr[idx] && Number.isFinite(uNewRaw[idx])) {
                                    fusedTorqueArr[idx] = Math.min(1, gArr[idx] * scale);
                                }
                            }
                            uniqueExposureCdfArr = tempUCdf;
                        }
                    }
                }
            }
        }

        for (let idx = 0; idx < evalThirdCount; idx++) {
            const entry = evalThirdCandidates[idx];
            if (hasVecArr[idx]) {
                const cos1 = cos1Arr[idx];
                const cos2 = cos2Arr[idx];
                const diaryBridge = diaryBridgeArr[idx];
                const coneProj = coneProjArr[idx];
                const coneEscape = coneEscapeArr[idx];
                const coneClearance = coneClearanceArr[idx];
                const pAlign = pAlignArr[idx];
                const normTauGain = normTauGainArr[idx];
                const torqueDeficit = fusedTorqueArr[idx];
                const uCdf = (uniqueExposureCdfArr && Number.isFinite(uniqueExposureCdfArr[idx]))
                    ? uniqueExposureCdfArr[idx]
                    : null;

                const baseScore = wTorque * torqueDeficit + wDiary * diaryBridge;
                let effMemContrib = wDiary * diaryBridge;
                let effTorqueContrib = wTorque * torqueDeficit;
                let slingshotScore;

                if (hasV37Modality) {
                    if (drillPhase > 0) {
                        const proximalPull = 0.5 * Math.max(0, cos1) + 0.5 * Math.max(0, cos2);
                        const drillTorqueTerm = (1 - 0.30 * drillPhase) * torqueDeficit + 0.30 * drillPhase * proximalPull;
                        slingshotScore = (wTorque * drillTorqueTerm + wDiary * diaryBridge) * coneClearance;
                        effTorqueContrib = wTorque * drillTorqueTerm;
                    } else if (escapePhase > 0) {
                        const prevAlign = prevAlignArr[idx];
                        const escapeRepel = 1.0 - 0.30 * escapePhase * prevAlign;
                        slingshotScore = baseScore * escapeRepel * coneClearance;
                        effTorqueContrib = wTorque * torqueDeficit * escapeRepel;
                        effMemContrib = wDiary * diaryBridge * escapeRepel;
                    } else {
                        slingshotScore = baseScore * coneClearance;
                    }
                } else {
                    slingshotScore = baseScore * coneClearance;
                }
                const torqueOnlyScore = effTorqueContrib * coneClearance;
                if (torqueOnlyScore > bestTorqueOnlyScore) {
                    bestTorqueOnlyScore = torqueOnlyScore;
                    bestTorqueOnlyName = entry.starName;
                }

                const isBetterThird = !bestThirdHasVec || slingshotScore > bestThirdScore;
                if (isBetterThird) {
                    bestThirdHasVec = true;
                    bestThirdScore = slingshotScore;
                    bestThirdEntry = entry;
                    const dDiffSq = Math.max(0, 1 - pAlign * pAlign);
                    bestThirdMeta = {
                        cos1,
                        cos2,
                        coneProj,
                        escape: coneEscape,
                        coneClearance,
                        pAlign,
                        dDiff: Math.sqrt(dDiffSq),
                        torqueDeficit,
                        tauGain: normTauGain,
                        uniqueExposureCdf: uCdf,
                        diaryBridge,
                        _effectiveMemContrib: effMemContrib,
                        _effectiveTorqueContrib: effTorqueContrib
                    };
                }
            } else {
                const fallbackScore = fallbackScoreArr[idx];
                if (!bestThirdHasVec && fallbackScore > bestThirdScore) {
                    bestThirdScore = fallbackScore;
                    bestThirdEntry = entry;
                    bestThirdMeta = {};
                }
            }
        }
        const winnerMeta = resolveStarMeta(bestThirdEntry.item);
        const bestThird = {
            ...bestThirdEntry,
            ...(bestThirdMeta || {}),
            radius: winnerMeta.radius,
            _memoryFlippedWinner: Boolean(bestTorqueOnlyName && bestThirdEntry.starName !== bestTorqueOnlyName),
            _memoryMargin: Number.isFinite(bestTorqueOnlyScore) ? (bestThirdScore - bestTorqueOnlyScore) : 0
        };
        if (winnerMeta.x && x1 && x2) {
            const hm1 = this._v3HyperbolicMetric(r1, x1, winnerMeta.radius, winnerMeta.x, manifold, leg1, winnerMeta.leg);
            const hm2 = this._v3HyperbolicMetric(r2, x2, winnerMeta.radius, winnerMeta.x, manifold, leg2, winnerMeta.leg);
            bestThird.distH1 = hm1.distance;
            bestThird.distH2 = hm2.distance;
            bestThird.regime1 = hm1.regime;
            bestThird.regime2 = hm2.regime;
        }
        const slingshot = { ...bestThird, slot: 'slingshot', slingshotScore: bestThirdScore };

        return [primary, conjugate, slingshot];
    }

    /**
     * 将三颗星核与求解态几何前态渲染为紧致纯公式（V3.5）：
     * - 双星互拉耦合：`∧` (主从协同) / `⋈` (无偏对称鞍点，min(b1,b2)/max(b1,b2) >= 0.92)
     * - 河网形态推进箭头（消费 V5.2 连续 queryMorphology）：`↦` (atomic) / `⊢` (propositional) / `⇝` (narrative)
     * - 抛飞记忆共振：`σ_∞(C ⊖ φ | ℳ)`（无魔法数相对主导：记忆+波前加权贡献 ≥ 纯空间扭矩贡献）
     * - 多尺度盲区（纯向量准入，零字数判断）：`∥ ⊘(r_⊥)` (>0.968) / `∥ ⊘(r_⊥ ≫ 0)` (>0.980) / `∥ ⊘(∂_2)` (V5.2 金字塔 L1 实层)
     * - 二阶时间流相态：`→_{τ↺} ?^{-1}` (跳完深挖/真停滞>0.75) / `→_{τ↗} ?` (往外跳<0.12) / `→_{τ⇄} ?` (折返合龙) / `→_{τ,x} ?` (稳态推进)
     */
    _formatV3Formula(selectedStars, signals = null) {
        const stars = Array.isArray(selectedStars) ? selectedStars : [];
        const names = stars
            .map(s => (typeof s === 'string' ? s : s?.starName))
            .filter(Boolean);
        if (names.length === 0) return '';

        const toFinite = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
        const b1 = toFinite(signals?.b1);
        const b2 = toFinite(signals?.b2);
        const dualSaddle = signals?.dualSaddle === undefined
            ? (Number.isFinite(b1) && Number.isFinite(b2) && b1 > 0.05 && b2 > 0.05 && (Math.min(b1, b2) / Math.max(b1, b2)) >= 0.92)
            : Boolean(signals.dualSaddle);
        const pairOp = dualSaddle ? '⋈' : '∧';

        const morphology = signals?.queryMorphology;
        let flowArrow = '↦';
        if (morphology === 'propositional') flowArrow = '⊢';
        else if (morphology === 'narrative') flowArrow = '⇝';

        const s3 = stars[2];
        const diaryVal = Number(s3?.diaryBridge) || 0;
        const torqueVal = toFinite(s3?.torqueDeficit);
        const defaultMemSteered = Number.isFinite(torqueVal)
            ? (diaryVal > 0 && ((1 / 3) * diaryVal) >= ((2 / 3) * torqueVal))
            : (diaryVal >= 0.30);
        const memorySteered = signals?.memorySteered ?? defaultMemSteered;
        const slingshotArg = (name) => (memorySteered ? `${name} ⊖ φ | ℳ` : `${name} ⊖ φ`);

        const residualGrounded = signals?.residualGrounded !== false;
        const res = toFinite(signals?.coneResidual3D);
        const resBase = Number.isFinite(Number(signals?.coneResidualBase)) ? Number(signals.coneResidualBase) : 0.968;
        const resHigh = Number.isFinite(Number(signals?.coneResidualHigh)) ? Number(signals.coneResidualHigh) : 0.980;
        const hasDeepLayer = Boolean(signals?.hasDeepLayer);
        let conePart = '';
        if (residualGrounded && Number.isFinite(res)) {
            if (res > resHigh) conePart = 'r_⊥ ≫ 0';
            else if (res > resBase) conePart = 'r_⊥';
        }
        let residualPart = '';
        if (conePart && hasDeepLayer) {
            residualPart = ` ∥ ⊘(${conePart} ⊕ ∂_2)`;
        } else if (conePart) {
            residualPart = ` ∥ ⊘(${conePart})`;
        } else if (residualGrounded && hasDeepLayer) {
            residualPart = ' ∥ ⊘(∂_2)';
        }

        const tf = signals?.timeFlow || null;
        const phase = tf?.phase;
        const tfCont = toFinite(tf?.continuity);
        const tfIntentLoad = toFinite(tf?.intentLoad);
        const fallbackJumpAllowed = !Number.isFinite(tfIntentLoad) || tfIntentLoad >= 0.5;
        let tailOp = '→_{τ,x} ?';
        if (phase === 'post_jump_deepen' || phase === 'stagnation_loop') {
            tailOp = '→_{τ↺} ?^{-1}';
        } else if (phase === 'dialectic_return') {
            tailOp = '→_{τ⇄} ?';
        } else if (phase === 'explore_jump' || (!phase && Number.isFinite(tfCont) && tfCont < 0.12 && fallbackJumpAllowed)) {
            tailOp = '→_{τ↗} ?';
        }

        if (names.length === 1) {
            return `$$思奇 σ_∞(${slingshotArg(names[0])})${residualPart} ${tailOp}$$`;
        }
        if (names.length === 2) {
            return `$$势陷[∂${names[0]} ${pairOp} ∇${names[1]}]_φ${residualPart} ${tailOp}$$`;
        }
        return `$$势陷[∂${names[0]} ${pairOp} ∇${names[1]}]_φ ${flowArrow} 思奇 σ_∞(${slingshotArg(names[2])})${residualPart} ${tailOp}$$`;
    }

    /**
     * 元思考 V3.2 纯张量三体引擎（V5.2 共享观测锚定主星 + 星池双层去中心化切空间精确全扫 + 同轮个人记忆正交桥）：
     * 1. 星1 (势陷 ∂_A): 仅执行 1 次共享观测 V5.2 查询（含 RiverMemo Sense 落地），零多余 Tag 金字塔与属门冲突
     * 2. 星2 (势陷 ∇_B): 在内存缓存的全星池去中心化 z 空间中 <1ms 精确求解正交张力对偶星
     * 3. 星3 (思奇 v_∞(C ⊖ φ)): 结合时空抛飞扭矩 (p·d²) + 同轮个人记忆正交桥 + Laplace 平滑 2 跳 PMI × 二维非负锥清场精确求解
     */
    async processMetaThinkingV3(poolScope, queryVector, userContent, _aiContent, combinedQueryForDisplay, useGroup, riverOptions = null) {
        const tStart = Date.now();
        const signal = riverOptions?.signal || null;
        const throwIfAborted = () => {
            if (signal?.aborted) {
                const abortErr = new Error('MetaThinkingV3 aborted');
                abortErr.name = 'AbortError';
                throw abortErr;
            }
        };
        throwIfAborted();
        const diaryNames = this._resolveV3StarPoolDiaries(poolScope);
        let effectiveVector = this._v3NormalizeVector(queryVector);
        let activatedGroups = null;

        if (useGroup && this.ragPlugin?.semanticGroups && queryVector) {
            activatedGroups = this.ragPlugin.semanticGroups.detectAndActivateGroups(userContent);
            if (activatedGroups && activatedGroups.size > 0) {
                const enhanced = await this.ragPlugin.semanticGroups.getEnhancedVector(
                    userContent, activatedGroups, queryVector
                );
                throwIfAborted();
                effectiveVector = this._v3NormalizeVector(enhanced) || effectiveVector;
            }
        }

        const vdb = this.ragPlugin?.vectorDBManager;
        const manifold = this._v3LoadGlobalManifold(vdb);
        const starPool = this._v3LoadStarPoolCache(vdb, diaryNames, manifold);
        await this._v3EnsureMetaPolarityAxes();
        throwIfAborted();

        const hasRealStarPool = Boolean(starPool?.stars?.length >= 16);
        const epaMean = hasRealStarPool ? (starPool?.epaMean || this._v3LoadEpaMean(vdb)) : null;
        const epaDigest = starPool?.epaDigest || null;
        const expectedDim = manifold?.meanAxis?.length || starPool?.stars?.[0]?.raw?.length || epaMean?.length || 0;
        if (expectedDim > 0 && (!effectiveVector || effectiveVector.length !== expectedDim)) {
            console.warn(`[MetaThinkingV3] 查询向量维度不匹配 (${effectiveVector?.length || 0} != ${expectedDim})，跳过本轮求解`);
            return '';
        }
        const rawUserVecRaw = this._v3NormalizeVector(riverOptions?.userVector);
        const rawUserVec = (rawUserVecRaw && (!expectedDim || rawUserVecRaw.length === expectedDim))
            ? rawUserVecRaw
            : effectiveVector;
        let groupUserVec = rawUserVec;
        if (activatedGroups && activatedGroups.size > 0 && riverOptions?.userVector && (!expectedDim || riverOptions.userVector.length === expectedDim)) {
            const enhancedUser = await this.ragPlugin.semanticGroups.getEnhancedVector(
                userContent, activatedGroups, riverOptions.userVector
            );
            throwIfAborted();
            groupUserVec = this._v3NormalizeVector(enhancedUser) || rawUserVec;
        }
        const rawPrevAiVecNorm = riverOptions?.aiVector ? this._v3NormalizeVector(riverOptions.aiVector) : null;
        const rawPrevAiVec = (rawPrevAiVecNorm && (!expectedDim || rawPrevAiVecNorm.length === expectedDim))
            ? rawPrevAiVecNorm
            : null;
        const preStarMean = starPool?.starMeanAxis || null;
        const preBetaStar = starPool?.betaStar ?? 0.85;
        const poolOpt = hasRealStarPool ? starPool : null;
        const prePolHint = rawUserVec ? this._v3EvalMetaPolarity(rawUserVec, 1.0, null, { epaMean, epaDigest, starPool: poolOpt }) : { colorVector: null };
        const preProbeUserVec = prePolHint.colorVector || rawUserVec;
        const preZUserColor = preProbeUserVec ? this._v3ToStarVector(preProbeUserVec, manifold, preStarMean, preBetaStar) : null;
        const preIntentInfo = (rawPrevAiVec && hasRealStarPool)
            ? this._v3ComputeUserIntentLoad(preProbeUserVec, preZUserColor, rawPrevAiVec, null, null, manifold, starPool)
            : { load: 1.0, top1: null, zScore: null, meanAlign: null, denBoost: 0 };
        const preAlpha0 = preIntentInfo.load;
        let metaPolarity = this._v3EvalMetaPolarity(rawUserVec, preAlpha0, null, {
            top1: preIntentInfo.top1,
            epaMean,
            epaDigest,
            starPool: poolOpt
        });
        let v52EntityEvidence = 0;
        let v52L0Explained = null;
        let v52InDomainGate = null;
        let shellXVec = null;
        let shellResidualNorm = null;
        let shellPartialPh = null;
        let shellPartialCtrl = null;
        let sharpestPrepared = null;
        let ownedPrepared = null;
        try {
        const hasBaseTagBoost = riverOptions?.baseTagBoost !== undefined && Number.isFinite(Number(riverOptions.baseTagBoost));
        const obsOpts = {
            ...(Array.isArray(riverOptions?.coreTags) && riverOptions.coreTags.length > 0
                ? { coreTags: riverOptions.coreTags }
                : {}),
            sourceObservationConfig: {
                baseTagBoost: hasBaseTagBoost ? Math.max(0, Number(riverOptions.baseTagBoost)) : 0.459,
                coreBoostFactor: 1.33
            }
        };
        const poolPairMean = Number.isFinite(starPool?.pairMeanCos) ? starPool.pairMeanCos : 0;
        const poolPairStd = (Number.isFinite(starPool?.pairStdCos) && starPool.pairStdCos > 1e-4)
            ? starPool.pairStdCos
            : (1 / Math.sqrt(Math.max(128, expectedDim || 128)));
        const memShellStarCut = poolPairMean + 1.5 * poolPairStd;
        let preMemShellXVec = null;
        if (hasRealStarPool && rawPrevAiVec && preZUserColor && Array.isArray(metaPolarity?.phBasis) && preIntentInfo.top1 >= memShellStarCut) {
            const topMatchedStars = [];
            for (const st of starPool.stars) {
                if (!st?.z || !st?.raw) continue;
                const s = this._v3Dot(preZUserColor, st.z);
                if (s >= memShellStarCut) topMatchedStars.push({ s, raw: st.raw });
            }
            if (topMatchedStars.length > 0) {
                topMatchedStars.sort((a, b) => b.s - a.s);
                const memShell = this._v3StripBasisInEpaSpace(
                    rawUserVec,
                    topMatchedStars.slice(0, 4).map(x => x.raw),
                    epaMean,
                    0.05,
                    metaPolarity.phBasis,
                    metaPolarity.metaBasis,
                    { skipInverse: true }
                );
                if (memShell.xResidual) {
                    preMemShellXVec = memShell.xResidual;
                    if (Number.isFinite(memShell.residualNorm)) shellResidualNorm = memShell.residualNorm;
                    if (Number.isFinite(memShell.partialPh)) shellPartialPh = memShell.partialPh;
                    if (Number.isFinite(memShell.partialCtrl)) shellPartialCtrl = memShell.partialCtrl;
                    metaPolarity = this._v3EvalMetaPolarity(rawUserVec, preAlpha0, null, {
                        top1: preIntentInfo.top1,
                        shellXVec: preMemShellXVec,
                        shellResidualNorm,
                        partialPh: shellPartialPh,
                        partialCtrl: shellPartialCtrl,
                        epaMean,
                        epaDigest,
                        starPool: poolOpt
                    });
                }
            }
        }
        const preQrEPh = Number.isFinite(metaPolarity?.qrEPh) ? metaPolarity.qrEPh : null;
        const nullCalib = metaPolarity?.calib || null;
        const preMetaZ = nullCalib
            ? ((metaPolarity.qrEMeta ?? 0) - nullCalib.muMt0) / Math.max(1e-4, nullCalib.sdMt0)
            : 0;
        const preRMetaZ = nullCalib
            ? ((metaPolarity.rMeta ?? 0) - nullCalib.muRMeta0) / Math.max(1e-4, nullCalib.sdRMeta0)
            : 0;
        const ambiguousMetaBand = Boolean(
            nullCalib
            && !metaPolarity.isMetaCmd
            && !(metaPolarity.isTechWrappedPhatic || (metaPolarity.sPh ?? 0) >= 0.5)
            && preMetaZ >= 2.5
            && preRMetaZ >= 2.5
            && (metaPolarity.qrEColor ?? 1) < (nullCalib.muCl0 - 2.0 * nullCalib.sdCl0)
        );
        const alreadyConfirmedLowPhatic = Boolean(
            nullCalib
            && preQrEPh !== null
            && preQrEPh >= (nullCalib.thetaPhStar + 2.0 * nullCalib.sdPh0)
            && (metaPolarity.sPh ?? 0) >= 0.85
            && (preAlpha0 * (metaPolarity.phaticDamp ?? 1.0)) < 0.5
        );
        // 统一零分布门控：仅当低于 q10Ph0 且剥壳未触警、颜色能量在正常区且未落入高元词模糊带时跳过 L0 探针
        const alreadyConfirmedClearContent = Boolean(
            nullCalib
            && !ambiguousMetaBand
            && preQrEPh !== null
            && preQrEPh < nullCalib.q10Ph0
            && (shellPartialPh === null || shellPartialPh < nullCalib.muPhShell0)
            && !metaPolarity.isTechWrappedPhatic
            && (metaPolarity.qrEColor ?? 0) >= nullCalib.thetaClStar
        );
        const needL0Probe = Boolean(
            nullCalib && (
                (preQrEPh !== null && preQrEPh >= nullCalib.muPh0 && (metaPolarity.qrEPh >= metaPolarity.qrEMeta))
                || Boolean(metaPolarity.isTechWrappedPhatic)
                || ambiguousMetaBand
                || (preIntentInfo.top1 === null || preAlpha0 < 0.5)
            )
        );
        const hasGroupUserShiftPre = Boolean(activatedGroups && activatedGroups.size > 0 && riverOptions?.userVector);
        const preZPrevAi = rawPrevAiVec ? this._v3ToStarVector(rawPrevAiVec, manifold, preStarMean, preBetaStar) : null;
        // 严格在双层去中心化 z 空间以零分布边界 (μ_pair + 1.5·σ_pair) 判定同话题延续（修复原始窄锥空间 dot >= 0.25 恒为 true 导致复用失效的 Bug）
        const preSameTopicAsPrevAi = Boolean(
            preZPrevAi
            && preZUserColor
            && preZUserColor.length === preZPrevAi.length
            && this._v3Dot(preZUserColor, preZPrevAi) >= memShellStarCut
        );
        const hasSharedObsProvider = typeof riverOptions?.getObservation === 'function';
        const preConfirmedPhaticShell = Boolean(
            metaPolarity?.isTechWrappedPhatic
            || (Number.isFinite(metaPolarity?.sPh) && metaPolarity.sPh >= 0.5)
        );
        // 在探针必然被丢弃的场景（有共享观测提供方 / 同话题延续 / 语义组偏移 / 预确认附和壳 / 高元词模糊带校验）启用上游原生轻量 L0 参数，
        // 保留“无共享观测且 z 空间真异域新题”场景的单次完整观测零重跑复用能力。
        const probeWillBeDiscarded = hasSharedObsProvider || hasGroupUserShiftPre || preSameTopicAsPrevAi || preConfirmedPhaticShell || ambiguousMetaBand;
        if (
            hasRealStarPool
            && rawPrevAiVec
            && !metaPolarity.clampContent
            && !alreadyConfirmedLowPhatic
            && !alreadyConfirmedClearContent
            && needL0Probe
            && typeof vdb?.prepareUnifiedMemoObservation === 'function'
        ) {
            const sharpRes = await this._v3MeasureV52TagSharpness(vdb, preProbeUserVec, userContent, epaMean, {
                lightweightProbe: probeWillBeDiscarded,
                returnPrepared: !probeWillBeDiscarded,
                stripSourceVec: rawUserVec,
                obsOpts,
                signal,
                phBasis: metaPolarity?.phBasis || null,
                metaBasis: metaPolarity?.metaBasis || null,
                tagPhCut: nullCalib.muPh0 + nullCalib.sdPh0
            });
            // 必须在 throwIfAborted() 之前接管句柄，保证 Abort 时 finally 100% 释放原生观测
            sharpestPrepared = sharpRes.prepared || null;
            throwIfAborted();
            v52EntityEvidence = Number(sharpRes.entityEvidence) || 0;
            v52L0Explained = (sharpRes.l0Explained !== null && sharpRes.l0Explained !== undefined && Number.isFinite(Number(sharpRes.l0Explained)))
                ? Number(sharpRes.l0Explained)
                : null;
            v52InDomainGate = (sharpRes.inDomainGate !== null && sharpRes.inDomainGate !== undefined && Number.isFinite(Number(sharpRes.inDomainGate)))
                ? Number(sharpRes.inDomainGate)
                : null;
            shellXVec = sharpRes.shellXVec || preMemShellXVec || null;
            if (Number.isFinite(sharpRes.shellResidualNorm)) {
                shellResidualNorm = sharpRes.shellResidualNorm;
            }
            if (Number.isFinite(sharpRes.partialPh)) {
                shellPartialPh = sharpRes.partialPh;
            }
            if (Number.isFinite(sharpRes.partialCtrl)) {
                shellPartialCtrl = sharpRes.partialCtrl;
            }
            const l0DomainCollapsed = Boolean(
                ambiguousMetaBand
                && v52L0Explained !== null
                && v52InDomainGate !== null
                && (v52L0Explained * v52InDomainGate) < 0.25
            );
            metaPolarity = this._v3EvalMetaPolarity(rawUserVec, preAlpha0, null, {
                shellXVec,
                shellResidualNorm,
                partialPh: shellPartialPh,
                partialCtrl: shellPartialCtrl,
                l0DomainCollapsed,
                epaMean,
                epaDigest,
                starPool: poolOpt
            });
        } else if (preMemShellXVec) {
            shellXVec = preMemShellXVec;
        }
        const postNullCalib = metaPolarity?.calib || null;
        const resolveColorUserVec = async (pol) => {
            if (!pol?.colorVector || pol.clampContent) return groupUserVec;
            if (activatedGroups && activatedGroups.size > 0 && this.ragPlugin?.semanticGroups) {
                const enh = await this.ragPlugin.semanticGroups.getEnhancedVector(
                    userContent, activatedGroups, pol.colorVector
                );
                throwIfAborted();
                return this._v3NormalizeVector(enh) || pol.colorVector;
            }
            return pol.colorVector;
        };
        const obsColorUserVec = await resolveColorUserVec(metaPolarity);
        const rawMainWeights = Array.isArray(riverOptions?.mainSearchWeights) && riverOptions.mainSearchWeights.length >= 2
            ? riverOptions.mainSearchWeights.map(Number)
            : null;
        const mainUserWeight = (rawMainWeights && Number.isFinite(rawMainWeights[0]) && rawMainWeights[0] > 0 && Number.isFinite(rawMainWeights[1]) && rawMainWeights[1] >= 0)
            ? rawMainWeights[0]
            : 0.7;
        const mainAiWeight = (rawMainWeights && Number.isFinite(rawMainWeights[0]) && rawMainWeights[0] > 0 && Number.isFinite(rawMainWeights[1]) && rawMainWeights[1] >= 0)
            ? rawMainWeights[1]
            : 0.3;
        const mainWeightSum = mainUserWeight + mainAiWeight;
        const normUserWeight = mainWeightSum > 1e-9 ? (mainUserWeight / mainWeightSum) : 0.7;
        const normAiWeight = mainWeightSum > 1e-9 ? (mainAiWeight / mainWeightSum) : 0.3;
        const colorEffectiveVector = (metaPolarity.colorVector && !metaPolarity.clampContent && rawPrevAiVec)
            ? (this._v3WeightedCentroid([
                { vector: obsColorUserVec, weight: normUserWeight },
                { vector: rawPrevAiVec, weight: normAiWeight }
            ]) || effectiveVector)
            : effectiveVector;

        // 单一纯张量意图与内容载荷结算（彻底移除 7 次重复极性评估与 unifiedContentAlpha 补丁分支）
        let userIntentLoad = preAlpha0;
        let contentAlpha = 1.0;
        if (hasRealStarPool && rawPrevAiVec) {
            const reusePreIntent = Boolean(
                obsColorUserVec
                && preProbeUserVec
                && (obsColorUserVec === preProbeUserVec || this._v3Dot(obsColorUserVec, preProbeUserVec) >= 0.9999)
            );
            const baseIntentInfo = reusePreIntent
                ? preIntentInfo
                : (() => {
                    const baseZObsProbe = obsColorUserVec
                        ? this._v3ToStarVector(obsColorUserVec, manifold, preStarMean, preBetaStar)
                        : null;
                    return baseZObsProbe
                        ? this._v3ComputeUserIntentLoad(obsColorUserVec, baseZObsProbe, rawPrevAiVec, null, null, manifold, starPool)
                        : { load: preAlpha0, top1: preIntentInfo.top1 };
                })();
            if (postNullCalib) {
                const rawNative = (v52L0Explained !== null && v52InDomainGate !== null)
                    ? (v52L0Explained * v52InDomainGate)
                    : v52EntityEvidence;
                const nativeSignal = Math.max(0, Math.min(1, rawNative)) * (1 - (metaPolarity.sPh ?? 0));
                const sigCl = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30,
                    ((metaPolarity.qrEColor ?? 0) - postNullCalib.metaColorGateCut) / Math.max(1e-4, postNullCalib.sdCl0)
                ))));
                const metaZPost = ((metaPolarity.qrEMeta ?? 0) - postNullCalib.muMt0) / Math.max(1e-4, postNullCalib.sdMt0);
                const nonMetaGate = 1 / (1 + Math.exp(Math.max(-30, Math.min(30, metaZPost - 1.5))));
                const colorNovelSignal = metaPolarity.isMetaCmd ? 0 : (sigCl * (1 - (metaPolarity.sPh ?? 0)) * nonMetaGate);
                userIntentLoad = Math.max(baseIntentInfo.load, nativeSignal, colorNovelSignal);
            } else {
                userIntentLoad = baseIntentInfo.load;
            }
            contentAlpha = this._v3ApplyPhaticContentGate(userIntentLoad, metaPolarity);
        }

        // 源头分流：当判定为低内容载荷/元指令且存在上一轮 AI 底盘时，不复用偏重用户的 ::RiverMemo 日记观测，
        // 改为独立用精度加权向量 qObs 自建并行观测（日记本逻辑 0 改动）。
        const preferIndependentObs = Boolean(hasRealStarPool && rawPrevAiVec && contentAlpha < 0.5);

        let prepared = (!preferIndependentObs && typeof riverOptions?.getObservation === 'function')
            ? await riverOptions.getObservation()
            : null;
        throwIfAborted();

        // 连续精度加权观测源向量：仅在低内容载荷 (< 0.5) 时平滑让渡给 aiVector（在 0.5 处 C0 连续衔接 normUserWeight:normAiWeight）；
        // 高载荷 (>= 0.5) 直接保持 colorEffectiveVector，避免把外部新话题稀释回旧 AI 占比；独立 AI 观测一律清空附和/元指令字面文本。
        let obsQueryVector = colorEffectiveVector;
        let obsQueryText = String(userContent || '');
        let wUserObs = normUserWeight;
        let lowLoadCacheKey = null;
        let lowLoadCachedEntry = null;
        if (!prepared && preferIndependentObs && rawPrevAiVec && obsColorUserVec && hasRealStarPool) {
            const uObs = Math.max(0, Math.min(1, contentAlpha / 0.5));
            wUserObs = normUserWeight * uObs * uObs;
            obsQueryVector = this._v3WeightedCentroid([
                { vector: obsColorUserVec, weight: wUserObs },
                { vector: rawPrevAiVec, weight: 1 - wUserObs }
            ]) || colorEffectiveVector;
            obsQueryText = '';
            // 当 wUserObs <= 0.01（即观测向量几乎纯为 rawPrevAiVec）且存在真实磁盘 DB 路径时，复用短 TTL 观测快照与 Step 1 结果
            if (wUserObs <= 0.01 && vdb?.dbPath && vdb.dbPath !== ':memory:' && !riverOptions?.includeTrace) {
                const crypto = require('node:crypto');
                const coreSig = Array.isArray(obsOpts.coreTags)
                    ? obsOpts.coreTags.map(t => String(t?.name || t || '')).join(',')
                    : '';
                const rawBytes = new Uint8Array(rawPrevAiVec.buffer, rawPrevAiVec.byteOffset, rawPrevAiVec.byteLength);
                const vecHash = crypto.createHash('sha256').update(rawBytes).digest('hex').slice(0, 16);
                lowLoadCacheKey = `${vdb.dbPath}\0${starPool?.versionKey || 'no-ver'}\0${diaryNames.join('|')}\0${obsOpts.sourceObservationConfig.baseTagBoost}\0${coreSig}\0${vecHash}`;
                const vdbCache = this._v3LowLoadObsCache instanceof WeakMap ? this._v3LowLoadObsCache.get(vdb) : null;
                const hit = vdbCache?.get(lowLoadCacheKey);
                if (hit && (Date.now() - hit.cachedAt) < 15000) {
                    lowLoadCachedEntry = hit;
                    obsQueryVector = rawPrevAiVec;
                } else {
                    obsQueryVector = rawPrevAiVec;
                }
            }
        }

        // 若本轮无 ::RiverMemo 共享观测、未发生低载荷切换、且在双层去中心化 z 空间中本轮与上轮 AI 属异域新题 (< μ_pair + 1.5·σ_pair) 时接管复用 sharpestPrepared；
        // 同话题延续不丢弃 0.3 * rawPrevAiVec 上下文底座，保持与跳过探针分支相同的 70/30 混合契约。
        const hasGroupUserShift = Boolean(activatedGroups && activatedGroups.size > 0 && riverOptions?.userVector);
        const sameProbeVec = Boolean(
            obsColorUserVec
            && preProbeUserVec
            && (obsColorUserVec === preProbeUserVec || this._v3Dot(obsColorUserVec, preProbeUserVec) >= 0.9999)
        );
        let obsColorZForReuse = null;
        if (sameProbeVec) {
            obsColorZForReuse = preZUserColor;
        } else if (obsColorUserVec) {
            obsColorZForReuse = this._v3ToStarVector(obsColorUserVec, manifold, preStarMean, preBetaStar);
        }
        const isDistinctFromPrevAi = !preZPrevAi
            || !obsColorZForReuse
            || obsColorZForReuse.length !== preZPrevAi.length
            || this._v3Dot(obsColorZForReuse, preZPrevAi) < memShellStarCut;
        const canReuseSharpest = Boolean(
            !prepared
            && !preferIndependentObs
            && sharpestPrepared
            && !hasGroupUserShift
            && sameProbeVec
            && isDistinctFromPrevAi
        );
        if (canReuseSharpest) {
            ownedPrepared = sharpestPrepared;
            prepared = ownedPrepared;
            sharpestPrepared = null;
            obsQueryVector = obsColorUserVec;
        } else if (sharpestPrepared) {
            try { vdb.releaseMemoObservation?.(sharpestPrepared); } catch (_) { /* noop */ }
            sharpestPrepared = null;
        }

        // 若命中低载荷同 AI 底座快照缓存，直接还原只读快照并透传 primaryQuery，跳过原生制备与二次 TTL 复检
        let lowLoadPrimaryResult = null;
        if (lowLoadCachedEntry && lowLoadCachedEntry.primaryQuery && !prepared) {
            prepared = lowLoadCachedEntry.preparedSnapshot;
            lowLoadPrimaryResult = lowLoadCachedEntry.primaryQuery;
        } else if (!prepared && obsQueryVector && typeof vdb?.prepareUnifiedMemoObservation === 'function') {
            // 若本轮没有挂载 ::RiverMemo 日记本共享观测（或低载荷主动分流），主动准备一次统一观测并在 finally 释放
            try {
                ownedPrepared = await vdb.prepareUnifiedMemoObservation(
                    { text: obsQueryText, vector: obsQueryVector },
                    obsOpts
                );
                prepared = ownedPrepared;
            } catch (_) {
                // 统一观测不可用时静默降级
            }
        }
        throwIfAborted();
        const vectorCache = new Map();
        const denoisedVector = this._v3NormalizeVector(prepared?.enhancedVector) || obsQueryVector;
        const lowLoadObsSnapshot = (lowLoadCacheKey && !lowLoadCachedEntry && prepared)
            ? {
                preparedSnapshot: {
                    enhancedVector: prepared.enhancedVector ? Float32Array.from(prepared.enhancedVector) : null,
                    sourceObservationResult: {
                        matchedTags: Array.isArray(prepared?.sourceObservationResult?.matchedTags)
                            ? prepared.sourceObservationResult.matchedTags.slice()
                            : [],
                        pyramid: prepared?.sourceObservationResult?.pyramid || null
                    }
                }
            }
            : null;

        // Step 1: 唯一一次原生 RiverMemo V5.2 查询（消融验证 topK=24, candidateK=128 与 48/256 主星 100% 一致且减半水合开销）
        const primaryQuery = await this._v3QueryStarPool(
            vdb, diaryNames, obsQueryText, obsQueryVector, prepared, {
                topK: 24,
                candidateK: 128,
                lowLoadCacheKey,
                lowLoadObsSnapshot,
                lowLoadPrimaryResult
            }
        );
        throwIfAborted();
        const primaryCandidates = primaryQuery.results;
        const retrievalEngine = primaryQuery.engine;
        const omegaRegime = primaryCandidates[0]?.riverRegime || primaryQuery.omega?.regime || 'unknown';
        const toFiniteOrNaN = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
        const omegaStats = {
            omega: toFiniteOrNaN(primaryCandidates[0]?.omega ?? primaryQuery.omega?.omega),
            omegaEdge: toFiniteOrNaN(primaryQuery.omega?.omegaEdge),
            omegaEmerge: toFiniteOrNaN(primaryQuery.omega?.omegaEmerge),
            omegaFlow: toFiniteOrNaN(primaryQuery.omega?.omegaFlow)
        };
        const queryMorphology = primaryQuery.queryMorphology || null;
        const morphWeights = primaryQuery.queryMorphologyWeights || null;

        // 若星池缓存不可用（如单测 mock），回退到按需拉取候选向量并现场计算星池均值轴
        let starMeanAxis = starPool?.starMeanAxis || null;
        const betaStar = starPool?.betaStar ?? 0.85;
        let fullCandidates = [];
        const primaryScoreByName = new Map();

        for (const item of primaryCandidates) {
            const name = this._extractV3StarName(item);
            if (!name) continue;
            const prev = primaryScoreByName.get(name);
            const score = Number(item?.score) || 0;
            if (!prev || score > prev.score) {
                primaryScoreByName.set(name, {
                    score,
                    item
                });
            }
        }

        if (starPool && starPool.stars.length > 0) {
            if (starPool.byChunkId instanceof Map) {
                for (const [cid, chunkEntry] of starPool.byChunkId) {
                    if (chunkEntry?.raw) vectorCache.set(cid, chunkEntry.raw);
                }
            }
            for (const st of starPool.stars) {
                vectorCache.set(st.chunkId, st.raw);
                const step1 = primaryScoreByName.get(st.starName);
                fullCandidates.push(step1 ? step1.item : {
                    chunkId: st.chunkId,
                    fileId: st.fileId,
                    diaryName: st.diaryName,
                    sourceFile: st.sourceFile,
                    text: st.text,
                    score: 0
                });
            }
        } else {
            await this._v3FetchChunkVectors(
                vdb,
                primaryCandidates.map(item => Number(item?.chunkId ?? item?.id)),
                vectorCache
            );
            fullCandidates = primaryCandidates;
            const xList = [];
            for (const item of primaryCandidates) {
                const raw = vectorCache.get(Number(item?.chunkId ?? item?.id));
                const x = raw ? this._v3ToGlobalSpace(raw, manifold) : null;
                if (x) xList.push({ vector: x, weight: 1 });
            }
            if (xList.length >= 4) {
                starMeanAxis = this._v3WeightedCentroid(xList);
            }
        }

        const tSolveStart = Date.now();
        const toZ = (vec) => this._v3ToStarVector(vec, manifold, starMeanAxis, betaStar);

        const zPrevAi = rawPrevAiVec ? toZ(rawPrevAiVec) : null;
        const zDen = denoisedVector ? toZ(denoisedVector) : null;

        const finalMetaPol = metaPolarity;
        const colorUserVec = obsColorUserVec;
        const zUserOnly = toZ(colorUserVec);
        const finalColorEffectiveVector = colorEffectiveVector;
        const zEffMixed = toZ(finalColorEffectiveVector);
        const uMix = Math.max(0, Math.min(1, contentAlpha / 0.5));

        // 纯 Agent 轨迹运动学（完全免疫用户附和切段）与连续模态控制律 m ∈ [-1, +1]
        const agentKinematics = this._v3ComputeAgentKinematics(
            riverOptions?.historyAssistantVectors,
            rawPrevAiVec,
            manifold,
            starMeanAxis,
            betaStar,
            { starPool }
        );
        const isExternalJump = Boolean(contentAlpha >= 0.5 && zUserOnly && zPrevAi && this._v3Dot(zUserOnly, zPrevAi) < memShellStarCut);
        // 外部真换话题时：重置旧话题轨迹惯性 mEndo=0（不再强加 +0.65 破局弹飞），仅保留用户自身的显式元指令极性 etaMode
        const effectiveMEndo = isExternalJump ? 0 : agentKinematics.mEndo;
        const modeM = hasRealStarPool && (rawPrevAiVec || Math.abs(finalMetaPol.etaMode) > 0.10)
            ? Math.max(-1, Math.min(1, effectiveMEndo + finalMetaPol.etaMode))
            : 0;
        const useV37Modality = Boolean(hasRealStarPool && (rawPrevAiVec || Math.abs(finalMetaPol.etaMode) > 0.10));

        // 静态背景惯性轴：低内容载荷时纯以 zPrevAi 为底盘（避免混入被用户词折射过的 zDen）
        const zBg = contentAlpha < 0.5
            ? (zPrevAi || zDen)
            : this._v3WeightedCentroid([
                ...(zPrevAi ? [{ vector: zPrevAi, weight: 0.5 }] : []),
                ...(zDen ? [{ vector: zDen, weight: 0.5 }] : [])
            ]);

        // 纯几何主星校准：在 z 空间融合本轮纯用户方向并抑制静态背景惯性残余
        const effectivePrimaryCandidates = this._v3CalibratePrimaryCandidates(
            primaryCandidates, zUserOnly, zBg, starPool, vectorCache, toZ, 0.28 * contentAlpha
        );
        const v5InfoById = new Map();
        let maxCalibratedV5 = 0;
        for (const item of effectivePrimaryCandidates) {
            const cid = Number(item?.chunkId ?? item?.id);
            const sc = Number(item?.score) || 0;
            if (sc > maxCalibratedV5) maxCalibratedV5 = sc;
            if (Number.isSafeInteger(cid)) {
                v5InfoById.set(cid, {
                    score: sc,
                    baseScore: Number(item?.baseScore) || 0,
                    fieldScore: Number(item?.fieldScore) || 0,
                    topologyBonus: Number(item?.topologyBonus) || 0
                });
            }
        }

        let primarySourceCandidates = effectivePrimaryCandidates;
        let usedStarPoolFallback = false;
        if (useV37Modality && contentAlpha < 0.5 && fullCandidates.length > 0 && zPrevAi) {
            // 连续全池融合重排：双方按全池峰值同量纲对齐（含 0.15 噪声下限地板）；
            // 若已启用独立 AI 观测 (preferIndependentObs)，以 C¹ 三次 Hermite smoothstep 连续过渡至 1.0 尊重 V5.2 排序。
            const v5Denom = maxCalibratedV5 > 1e-6 ? maxCalibratedV5 : 1.0;
            let maxAgentAlign = 0;
            let topV5Score = -Infinity;
            let topV5AgentAlign = 0;
            const agentAligns = fullCandidates.map((item) => {
                const cid = Number(item?.chunkId ?? item?.id);
                const stMeta = this._v3LookupStarMeta(starPool, item);
                const zV = stMeta?.z || null;
                const align = zV ? Math.max(0, this._v3Dot(zV, zPrevAi)) : 0;
                if (align > maxAgentAlign) maxAgentAlign = align;
                const v5Info = Number.isSafeInteger(cid) ? v5InfoById.get(cid) : null;
                if (v5Info && v5Info.score > topV5Score) {
                    topV5Score = v5Info.score;
                    topV5AgentAlign = align;
                }
                return align;
            });
            const agentDenom = Math.max(0.15, maxAgentAlign);
            const topV5AgentRatio = topV5Score > 0 ? Math.max(0, Math.min(1, topV5AgentAlign / agentDenom)) : 0;
            let v5Weight = uMix;
            if (preferIndependentObs) {
                const tV5 = Math.min(1, topV5AgentRatio / 0.5);
                v5Weight = Math.max(uMix, tV5 * tV5 * (3 - 2 * tV5));
            }
            primarySourceCandidates = fullCandidates.map((item, idx) => {
                const cid = Number(item?.chunkId ?? item?.id);
                const v5Info = Number.isSafeInteger(cid) ? v5InfoById.get(cid) : null;
                const v5Norm = v5Info ? Math.max(0, Math.min(1, v5Info.score / v5Denom)) : 0;
                const agentNorm = Math.max(0, Math.min(1, agentAligns[idx] / agentDenom));
                const blended = v5Weight * v5Norm + (1 - v5Weight) * agentNorm;
                return { ...item, score: blended, rawV5Score: v5Info?.score ?? (Number(item?.score) || 0) };
            });
        } else if (primarySourceCandidates.length === 0 && fullCandidates.length > 0) {
            const fallbackQueryZ = contentAlpha < 0.5
                ? (zEffMixed || zPrevAi || zUserOnly)
                : (zUserOnly || zEffMixed);
            if (fallbackQueryZ) {
                usedStarPoolFallback = true;
                primarySourceCandidates = fullCandidates.map((item) => {
                    const stMeta = this._v3LookupStarMeta(starPool, item);
                    const zV = stMeta?.z || null;
                    return zV ? { ...item, score: Math.max(0, this._v3Dot(zV, fallbackQueryZ)) } : item;
                });
            } else {
                primarySourceCandidates = fullCandidates;
            }
        }
        const calibratedTopList = this._v3DedupeCandidates(primarySourceCandidates)
            .sort((a, b) => (Number(b.item?.score) || 0) - (Number(a.item?.score) || 0));
        const calibratedByName = new Map(calibratedTopList.map(entry => [entry.starName, entry]));

        // Sense 落地主星仅在有效内容载荷 (contentAlpha >= 0.5) 时参与主导；低载荷下避免用户闲聊词共现河道短路星 1
        let groundedPrimary = null;
        if (prepared && contentAlpha >= 0.5 && typeof vdb?.planRiverThinking === 'function' && effectivePrimaryCandidates.length > 0) {
            try {
                const stages = diaryNames.map(name => ({
                    diaryName: name,
                    k: 1,
                    candidates: effectivePrimaryCandidates.filter(c => c.diaryName === name)
                })).filter(s => s.candidates.length > 0);
                if (stages.length > 0) {
                    const plan = await vdb.planRiverThinking(
                        prepared,
                        stages,
                        { minClosure: riverOptions?.config?.minClosure ?? 0.2 }
                    );
                    const firstHit = plan?.stages?.flatMap(s => s.results || []).find(r => r?.riverThinking?.route);
                    if (firstHit) {
                        const hitName = this._extractV3StarName(firstHit);
                        const calibratedHit = hitName ? calibratedByName.get(hitName)?.item : null;
                        const topCalibrated = calibratedTopList[0]?.item;
                        const topRel = Number(topCalibrated?.score) || 0;
                        const hitRel = Number(calibratedHit?.score ?? firstHit?.score) || 0;
                        if (topRel <= 0 || (hitRel >= topRel * 0.90 && (topRel - hitRel) <= 0.05)) {
                            groundedPrimary = calibratedHit ? { ...firstHit, score: calibratedHit.score, rawV5Score: calibratedHit.rawV5Score } : firstHit;
                        }
                    }
                }
            } catch (_) {
                // 星池簇若无独立日记共现河道则静默沿用共享观测 V5.2 主星
            }
        }

        // 唯一主星定锚：先定 lockedPrimary 再供 z1 计算与 _selectV3TrinityStars 共享，消除双处重复排序分歧
        let lockedPrimary = null;
        if (groundedPrimary) {
            const name = this._extractV3StarName(groundedPrimary);
            if (name) {
                lockedPrimary = {
                    item: groundedPrimary,
                    starName: name,
                    slot: 'primary',
                    source: 'rivermemo-sense-grounded'
                };
            }
        }
        if (!lockedPrimary && calibratedTopList[0]) {
            lockedPrimary = {
                ...calibratedTopList[0],
                slot: 'primary',
                source: usedStarPoolFallback ? 'star-pool-cosine-fallback' : 'rivermemo-v5.2-shared'
            };
        }
        const finalPrimaryPicked = lockedPrimary;

        const cid1 = Number(finalPrimaryPicked?.item?.chunkId ?? finalPrimaryPicked?.item?.id);
        const st1 = this._v3LookupStarMeta(starPool, finalPrimaryPicked?.item, finalPrimaryPicked?.starName);
        const rawU1 = st1?.raw || (Number.isSafeInteger(cid1) ? (vectorCache.get(cid1) || null) : null);
        const z1 = st1?.z || (rawU1 ? toZ(rawU1) : null);

        // 先行计算纯几何对话演进时间流矢 v_τ（低载荷时将用户输入对齐到载荷混合后的 obsQueryVector，彻底封死 C7 夸赞词经 timeFlow 偷渡进 Star 3）
        const timeFlowUserVec = preferIndependentObs ? obsQueryVector : colorUserVec;
        const timeFlow = this._v3TimeFlowAxis(
            userContent,
            timeFlowUserVec,
            riverOptions?.aiVector,
            denoisedVector,
            finalColorEffectiveVector,
            z1,
            manifold,
            starMeanAxis,
            betaStar,
            riverOptions?.historySegments,
            contentAlpha,
            { agentKinematics, starPool: poolOpt }
        );
        const geoShift = Number(timeFlow.shift) || 0;
        const aiDenoisedTangentZ = (zDen && z1) ? this._v3GramSchmidtOrthogonal(zDen, z1) : null;
        const uMixSq = uMix * uMix;
        let effectiveTimeFlowZ = timeFlow.vector;
        if (preferIndependentObs) {
            if (wUserObs <= 0.01) {
                effectiveTimeFlowZ = aiDenoisedTangentZ;
            } else {
                effectiveTimeFlowZ = this._v3WeightedCentroid([
                    ...(timeFlow.vector ? [{ vector: timeFlow.vector, weight: uMixSq }] : []),
                    ...(aiDenoisedTangentZ ? [{ vector: aiDenoisedTangentZ, weight: 1 - uMixSq }] : [])
                ]) || aiDenoisedTangentZ;
            }
        }

        // Step 2: 在去中心化星池切空间 z 中连续构造对话意图 zQ
        let zEff = (zUserOnly && zEffMixed && geoShift > 0)
            ? (this._v3WeightedCentroid([
                { vector: zUserOnly, weight: geoShift },
                { vector: zEffMixed, weight: 1 - geoShift }
            ]) || zEffMixed)
            : (zEffMixed || zUserOnly);
        if (contentAlpha < 0.5 && zPrevAi) {
            let zEffUserWeight = uMix;
            if (preferIndependentObs) {
                zEffUserWeight = wUserObs <= 0.01 ? 0 : wUserObs;
            }
            zEff = (zEffUserWeight > 0 && zUserOnly)
                ? (this._v3WeightedCentroid([
                    { vector: zUserOnly, weight: zEffUserWeight },
                    { vector: zPrevAi, weight: 1 - zEffUserWeight }
                ]) || zPrevAi)
                : zPrevAi;
        }
        let zQuery = zEff;
        if (zEff && zDen && zEff.length === zDen.length) {
            const cosED = Math.max(-1, Math.min(1, this._v3Dot(zEff, zDen)));
            const drift = Math.max(0, 1 - cosED);
            const wDen = (1 - geoShift) / (3 * (1 + 2 * drift));
            zQuery = this._v3WeightedCentroid([
                { vector: zEff, weight: 1 - wDen },
                { vector: zDen, weight: wDen }
            ]) || zEff;
        }

        // V5.2 NNLS 金字塔 L1/L2 残差暗线标签（仅用于公式 ∂_2 与广播，不再做无收益 Tag 向量 SQL 拉取）
        const pyramidLevelsRef = prepared?.sourceObservationResult?.pyramid?.levels;
        const pyramidL1Names = Array.isArray(pyramidLevelsRef) && pyramidLevelsRef.length >= 2
            ? [
                ...(Array.isArray(pyramidLevelsRef[1]?.tags) ? pyramidLevelsRef[1].tags : []),
                ...(Array.isArray(pyramidLevelsRef[2]?.tags) ? pyramidLevelsRef[2].tags : [])
            ]
                .filter(t => t?.name && Number(t.contribution) > 0.01)
                .sort((a, b) => (Number(b.contribution) || 0) - (Number(a.contribution) || 0))
                .slice(0, 6)
                .map(t => t.name)
            : [];

        let tensionTangentZ = null;
        if (zQuery && z1) {
            const qOrthoZ = this._v3OrthogonalizePlane(zQuery, z1, null, 0.12).vector;
            const effOrthoZ = (!qOrthoZ && zEffMixed)
                ? this._v3OrthogonalizePlane(zEffMixed, z1, null, 0.12).vector
                : null;
            tensionTangentZ = qOrthoZ || effOrthoZ || null;
        }

        // 预去重全星池候选，供两次 _selectV3TrinityStars 调用复用，避免重复 716 次名称提纯与 Map 去重
        const deduplicatedFull = this._v3DedupeCandidates(fullCandidates);

        // 先在内存全星池锁定星1与星2（onlyFirstTwo=true 跳过星3空跑循环，<1ms）
        const prelimTrinity = this._selectV3TrinityStars(fullCandidates, {
            onlyFirstTwo: true,
            deduplicatedCandidates: deduplicatedFull,
            lockedPrimary,
            primaryCandidates: effectivePrimaryCandidates,
            zQuery,
            tensionTangentZ,
            manifold,
            starPool,
            starMeanAxis,
            betaStar,
            vectorByChunkId: vectorCache,
            modeM,
            useV37Modality
        });

        // Step 3: 合成时空抛飞冲量 φ(z)（由 V5.2 连续河网形态权重 (p_A, p_P, p_N) 驱动）+ 个人记忆 / L1 潜台词正交桥
        let ejectImpulseZ = null;
        let diaryBridge = { vector: null, novelty: 0, count: 0, source: 'none' };
        let diaryWaitMs = 0;

        if (prelimTrinity.length >= 2) {
            const star1 = prelimTrinity[0];
            const star2 = prelimTrinity[1];
            const rawS1Id = Number(star1.item?.chunkId ?? star1.item?.id);
            const rawS2Id = Number(star2.item?.chunkId ?? star2.item?.id);
            const st1Pool = this._v3LookupStarMeta(starPool, star1.item, star1.starName);
            const st2Pool = this._v3LookupStarMeta(starPool, star2.item, star2.starName);
            const s1Z = st1Pool?.z || toZ(vectorCache.get(rawS1Id));
            const s2Z = st2Pool?.z || toZ(vectorCache.get(rawS2Id));

            let activeDiaryChunks = [];
            // 低载荷/附和/纯元指令切换至独立 AI 观测时，不消费外侧按含用户词混合向量召回的日记块，防止夸赞技术词偷渡进 Star 3
            if (!preferIndependentObs) {
                if (typeof riverOptions?.getActiveDiaryChunks === 'function') {
                    const tWait0 = Date.now();
                    activeDiaryChunks = await riverOptions.getActiveDiaryChunks();
                    diaryWaitMs = Math.max(0, Date.now() - tWait0);
                    throwIfAborted();
                } else if (Array.isArray(riverOptions?.activeDiaryChunks)) {
                    activeDiaryChunks = riverOptions.activeDiaryChunks;
                }
            }
            diaryBridge = await this._v3BuildDiaryBridge(
                vdb,
                activeDiaryChunks,
                diaryNames,
                manifold,
                starMeanAxis,
                betaStar,
                s1Z,
                s2Z,
                zDen,
                vectorCache,
                {
                    bridgeEpsilon: riverOptions?.bridgeEpsilon,
                    zPrevAi,
                    timeFlowMode: timeFlow.mode,
                    timeFlowShift: geoShift,
                    matchedTags: prepared?.sourceObservationResult?.matchedTags || primaryQuery.matchedTags || []
                }
            );
            throwIfAborted();

            if (s1Z && s2Z) {
                const wingBind = this._v3WeightedCentroid([
                    { vector: s1Z, weight: 0.5 },
                    { vector: s2Z, weight: 0.5 }
                ]);
                const negS1 = Float32Array.from(s1Z, v => -v);
                const wingShear = this._v3WeightedCentroid([
                    { vector: s2Z, weight: 0.5 },
                    { vector: negS1, weight: 0.5 }
                ]);
                // 按物理对称整数比 + 连续 geoShift 驱动抛飞方向（跳话题时自动向 timeFlow 切向倾斜）
                let bRaw = 1 + (1 - geoShift);
                let sRaw = 1;
                let tRaw = 1 + geoShift;
                if (queryMorphology === 'propositional') {
                    bRaw = 1;
                    sRaw = 1 + (1 - geoShift);
                    tRaw = 1 + geoShift;
                } else if (queryMorphology === 'narrative') {
                    bRaw = 1;
                    sRaw = 1;
                    tRaw = 2 + geoShift;
                }
                const mSum = bRaw + sRaw + tRaw;
                const wBind = bRaw / mSum;
                const wShearBase = sRaw / mSum;
                const wTime = tRaw / mSum;
                // 深挖态 (modeM < 0) 平滑撤除 -z1 离心剪切并向主星内敛
                const shearScale = (useV37Modality && modeM < 0)
                    ? Math.max(0, 1 + modeM)
                    : 1.0;
                const impulseParts = [
                    { vector: wingBind, weight: wBind }
                ];
                if (shearScale > 1e-3 && wShearBase > 1e-6) {
                    impulseParts.push({ vector: wingShear, weight: wShearBase * shearScale });
                }
                if (shearScale < 0.999 && wShearBase > 1e-6) {
                    impulseParts.push({ vector: s1Z, weight: wShearBase * (1 - shearScale) });
                }
                if (effectiveTimeFlowZ && wTime > 1e-6) {
                    impulseParts.push({ vector: effectiveTimeFlowZ, weight: wTime });
                }
                ejectImpulseZ = this._v3WeightedCentroid(impulseParts) || wingBind;
            }
        }

        const zExpQuery = preferIndependentObs
            ? (zPrevAi || (obsQueryVector ? toZ(obsQueryVector) : null))
            : (obsQueryVector ? toZ(obsQueryVector) : null);
        const selectedStars = this._selectV3TrinityStars(fullCandidates, {
            deduplicatedCandidates: deduplicatedFull,
            lockedPrimary: prelimTrinity[0] || lockedPrimary,
            lockedConjugate: prelimTrinity[1] || null,
            primaryCandidates: effectivePrimaryCandidates,
            zQuery,
            zExpQuery,
            tensionTangentZ,
            ejectImpulseZ,
            timeFlowZ: effectiveTimeFlowZ,
            diaryBridgeZ: diaryBridge.vector,
            diaryBridgeNovelty: diaryBridge.novelty,
            diaryFootprints: diaryBridge.footprints,
            manifold,
            starPool,
            starMeanAxis,
            betaStar,
            vectorByChunkId: vectorCache,
            modeM,
            useV37Modality,
            zPrevAiRef: isExternalJump ? null : zPrevAi
        });
        const solveMs = Math.max(0, Date.now() - tSolveStart - diaryWaitMs);
        const totalMs = Date.now() - tStart;

        // 计算三体非负锥对当前意图 zQuery 的覆盖与正交未解余项 η_⊥ = √(1 - ‖Π_{cone}(zQ)‖²)
        let coneCoverage3D = null;
        let coneResidual3D = null;
        let top1StarAlignZ = 0;
        let top2StarAlignZ = 0;
        const coneTargetZ = zQuery || zUserOnly || zEffMixed;
        if (coneTargetZ && selectedStars.length > 0) {
            const zStars = selectedStars
                .map(s => this._v3LookupStarMeta(starPool, s?.item, s?.starName)?.z
                    || toZ(vectorCache.get(Number(s?.item?.chunkId ?? s?.item?.id))))
                .filter(Boolean);
            if (zStars[0]) {
                top1StarAlignZ = Math.max(0, this._v3Dot(coneTargetZ, zStars[0]));
            }
            if (zStars[1]) {
                top2StarAlignZ = Math.max(0, this._v3Dot(coneTargetZ, zStars[1]));
            }
            let projSq = null;
            if (zStars.length >= 3) {
                const b1 = this._v3Dot(coneTargetZ, zStars[0]);
                const b2 = this._v3Dot(coneTargetZ, zStars[1]);
                const b3 = this._v3Dot(coneTargetZ, zStars[2]);
                const g12 = this._v3Dot(zStars[0], zStars[1]);
                const g13 = this._v3Dot(zStars[0], zStars[2]);
                const g23 = this._v3Dot(zStars[1], zStars[2]);
                projSq = this._v3ConeProjSq3(b1, b2, b3, g12, g13, g23);
            } else if (zStars.length === 2) {
                const b1 = this._v3Dot(coneTargetZ, zStars[0]);
                const b2 = this._v3Dot(coneTargetZ, zStars[1]);
                const g12 = this._v3Dot(zStars[0], zStars[1]);
                projSq = this._v3ConeProjSq2(b1, b2, g12);
            } else if (zStars.length === 1) {
                const b1 = Math.max(0, this._v3Dot(coneTargetZ, zStars[0]));
                projSq = b1 * b1;
            }
            if (projSq !== null) {
                coneCoverage3D = Math.sqrt(Math.max(0, Math.min(1, projSq)));
                coneResidual3D = Math.sqrt(Math.max(0, 1 - projSq));
            }
        }

        // 纯向量空间语义准入门控（零字数判断）：全局 Tag 场 / 河网 / 星池 / 真实日记或 Tag 桥存在实质结构激发，高 r_⊥ 才是真盲区
        // 注意：v5-denoised 兜底本身即 query 剥离 (z1,z2)，不能用来循环论证 query 的结构准入
        const pyramidObj = prepared?.sourceObservationResult?.pyramid || null;
        const tagExplainedEnergy = Number(pyramidObj?.totalExplainedEnergy) || 0;
        const pyramidDepth = Number(pyramidObj?.depth) || (Array.isArray(pyramidObj?.levels) ? pyramidObj.levels.length : 0);
        const l0Coherence = toFiniteOrNaN(pyramidObj?.levels?.[0]?.handshakeFeatures?.directionCoherence);
        const omegaVal = Number.isFinite(omegaStats.omega) ? omegaStats.omega : 0;
        // 直接信任 V5.2 原生 NNLS 金字塔剥出的二层实层作为深层暗线 ∂_2（跨模式 100% 一致、零漂移）
        const hasDeepLayer = pyramidDepth >= 2 && pyramidL1Names.length > 0;

        const hasRealDiaryOrTagBridge = (
            (diaryBridge?.source === 'active-diaries' || diaryBridge?.source === 'v5-tag-bridge')
            && (Number(diaryBridge?.novelty) || 0) >= 0.12
        );
        const starAlignSigCut = poolPairMean + 1.5 * poolPairStd;
        const residualGrounded = (
            tagExplainedEnergy >= 0.35
            || omegaVal >= 0.12
            || top1StarAlignZ >= starAlignSigCut
            || hasRealDiaryOrTagBridge
        );

        // 无偏对称双极鞍点：基于星池零分布噪声尺度 σ_pair 判定（两星吸附均显著且差值落于 0.10σ_pair 精细对称带内，维持稀疏高奇异值）
        const dualSaddle = top1StarAlignZ > starAlignSigCut
            && top2StarAlignZ > starAlignSigCut
            && Math.abs(top1StarAlignZ - top2StarAlignZ) <= 0.10 * poolPairStd;
        // 反事实边际翻盘判据：当真实个人日记桥 (active-diaries) 非零并实际改写了 Star 3 胜出星，或记忆贡献 ≥ 扭矩贡献时点亮 | ℳ
        const s3Star = selectedStars[2];
        const s3MemContrib = s3Star
            ? (s3Star._effectiveMemContrib ?? ((1 / 3) * (Number(s3Star.diaryBridge) || 0)))
            : 0;
        const s3TorqueContrib = s3Star
            ? (s3Star._effectiveTorqueContrib ?? ((2 / 3) * (Number(s3Star.torqueDeficit) || 0)))
            : 0;
        const memorySteered = Boolean(
            s3Star
            && s3MemContrib > 0
            && (
                (diaryBridge.source === 'active-diaries' && s3Star._memoryFlippedWinner)
                || s3MemContrib >= s3TorqueContrib
            )
        );
        const formula = this._formatV3Formula(selectedStars, {
            b1: top1StarAlignZ,
            b2: top2StarAlignZ,
            dualSaddle,
            queryMorphology,
            memorySteered,
            coneResidual3D,
            coneResidualBase: starPool?.coneResidualBase,
            coneResidualHigh: starPool?.coneResidualHigh,
            residualGrounded,
            hasDeepLayer,
            timeFlow
        });
        const star1Source = selectedStars[0]?.source || 'rivermemo-v5.2-shared';
        const missingStars = starPool?.manifoldMissingStars ?? 0;

        const fmtStar = (s) => {
            if (!s) return '无';
            const extras = [];
            if (s.slot === 'primary') extras.push(star1Source);
            if (s.slot === 'conjugate') {
                if (s.tensionAlign != null) extras.push(`t=${Number(s.tensionAlign).toFixed(3)}`);
                if (s.cos1 != null) extras.push(`cos1z=${Number(s.cos1).toFixed(2)}`);
                if (s.distH1 != null) extras.push(`dH1=${Number(s.distH1).toFixed(2)}`);
            }
            if (s.slot === 'slingshot') {
                if (s.torqueDeficit != null) extras.push(`C⊖φ=${Number(s.torqueDeficit).toFixed(3)}`);
                if (s.diaryBridge != null && s.diaryBridge > 0) extras.push(`diary=${Number(s.diaryBridge).toFixed(2)}`);
                if (s.coneProj != null) extras.push(`cone=${Number(s.coneProj).toFixed(2)}`);
            }
            return `${s.starName}${extras.length ? `(${extras.join(',')})` : ''}`;
        };
        const tauText = timeFlow.continuity === null || timeFlow.continuity === undefined
            ? 'n/a'
            : Number(timeFlow.continuity).toFixed(2);
        const resText = coneResidual3D === null ? 'n/a' : coneResidual3D.toFixed(2);
        const l1Note = pyramidL1Names.length > 0 ? ` | L1=${pyramidL1Names.length}` : '';
        const missingNote = missingStars > 0 ? ` | ⚠️未入图星=${missingStars}(建议全量重训)` : '';
        throwIfAborted();
        if (selectedStars.length === 0) {
            console.log(`[MetaThinkingV3.8] 星池=${diaryNames.join('|')}(0) 为空，跳过公式注入与观测广播 (耗时=${totalMs}ms)`);
            return '';
        }

        const diaryBridgeLabel = diaryBridge.source === 'none'
            ? 'none(0)'
            : `${diaryBridge.source}(${diaryBridge.count},nov=${(Number(diaryBridge.novelty) || 0).toFixed(2)})`;
        const morphLabel = queryMorphology || 'atomic';
        const omegaFlowText = Number.isFinite(omegaStats.omegaFlow) ? omegaStats.omegaFlow.toFixed(2) : 'n/a';
        console.log(
            `[MetaThinkingV3.8] 星池=${diaryNames.join('|')}(${starPool?.stars?.length || fullCandidates.length}) | ` +
            `Ω=${omegaRegime}(F=${omegaFlowText}) | 态=${morphLabel} | m=${modeM.toFixed(2)}(η=${finalMetaPol.etaMode.toFixed(2)},αc=${contentAlpha.toFixed(2)}) | ` +
            `τ=${timeFlow.mode}/${timeFlow.phase}(s=${tauText},shift=${geoShift.toFixed(2)},α=${userIntentLoad.toFixed(2)}) | ` +
            `r⊥=${resText}(g=${residualGrounded ? 1 : 0},∂2=${hasDeepLayer ? 1 : 0}) | ` +
            `桥=${diaryBridgeLabel}${l1Note} | ` +
            `耗时=${solveMs}ms/${totalMs}ms${missingNote} | ` +
            `势陷∂=${fmtStar(selectedStars[0])} | 势陷∇=${fmtStar(selectedStars[1])} | 思奇=${fmtStar(selectedStars[2])} | ` +
            `公式=${formula}`
        );

        const dualTransferSource = 'retired';
        const dualTransferNovelty = 0;
        try {
            const slotLabels = { primary: '势陷 ∂ 主星', conjugate: '势陷 ∇ 对偶星', slingshot: '思奇 σ∞(C⊖φ) 抛飞星' };
            const observerStages = selectedStars.map((s, idx) => {
                const metrics = [];
                if (s.slot === 'primary') metrics.push(`来源: ${star1Source} · Ω=${omegaRegime}`);
                if (s.slot === 'conjugate') {
                    if (s.tensionAlign != null) metrics.push(`z张力=${Number(s.tensionAlign).toFixed(3)}`);
                    if (s.cos1 != null) metrics.push(`cos1z=${Number(s.cos1).toFixed(2)}`);
                    if (s.distH1 != null) metrics.push(`全库双曲距dH=${Number(s.distH1).toFixed(2)}`);
                }
                if (s.slot === 'slingshot') {
                    if (s.torqueDeficit != null) metrics.push(`扭矩差C⊖φ=${Number(s.torqueDeficit).toFixed(3)}(p=${Number(s.pAlign).toFixed(2)})`);
                    if (s.diaryBridge != null) metrics.push(`记忆正交桥=${Number(s.diaryBridge).toFixed(2)}(${diaryBridge.source}:${diaryBridge.count})`);
                    if (s.coneProj != null) metrics.push(`非负锥投影=${Number(s.coneProj).toFixed(2)}(清场=${Number(s.coneClearance ?? 1).toFixed(2)})`);
                    if (coneResidual3D !== null) metrics.push(`锥外余项r⊥=${coneResidual3D.toFixed(2)}`);
                    metrics.push(`时间流=${timeFlow.mode} · 求解=${solveMs}ms`);
                }
                const sourceLabel = metrics.join(' · ') || retrievalEngine;
                const body = this._stripTagMetadata(s.item?.text || '');
                let stageScore = Number(s.item?.score) || 0;
                if (s.slot === 'conjugate') stageScore = Number(s.orthoScore ?? s.item?.score) || 0;
                else if (s.slot === 'slingshot') stageScore = Number(s.slingshotScore ?? s.item?.score) || 0;
                return {
                    stage: idx + 1,
                    clusterName: `${slotLabels[s.slot] || s.slot} · ${s.starName}`,
                    resultCount: 1,
                    results: [{
                        score: stageScore,
                        source: sourceLabel,
                        text: body || s.starName
                    }]
                };
            });

            this.ragPlugin?.pushVcpInfo?.({
                type: 'META_THINKING_CHAIN',
                version: 'v3.8-pure-tensor',
                chainName: `势陷↦思奇 V3.8 · ${diaryNames.join('|')}`,
                poolScope: diaryNames.join('|'),
                diaries: diaryNames,
                starPoolSize: starPool?.stars?.length || fullCandidates.length,
                manifoldMissingStars: missingStars,
                star1Source,
                omegaRegime,
                omegaFlow: Number.isFinite(omegaStats.omegaFlow) ? +omegaStats.omegaFlow.toFixed(4) : null,
                omegaEdge: Number.isFinite(omegaStats.omegaEdge) ? +omegaStats.omegaEdge.toFixed(4) : null,
                omegaEmerge: Number.isFinite(omegaStats.omegaEmerge) ? +omegaStats.omegaEmerge.toFixed(4) : null,
                queryMorphology: morphLabel,
                queryMorphologyWeights: morphWeights,
                pyramidDepth,
                l0DirectionCoherence: Number.isFinite(l0Coherence) ? +l0Coherence.toFixed(4) : null,
                hasDeepLayer,
                userIntentLoad: +userIntentLoad.toFixed(4),
                contentAlpha: +contentAlpha.toFixed(4),
                modalityM: +modeM.toFixed(4),
                metaPolarityEta: +finalMetaPol.etaMode.toFixed(4),
                agentCSelf: Number.isFinite(agentKinematics.cSelf) ? +agentKinematics.cSelf.toFixed(4) : null,
                agentKappaAi: Number.isFinite(agentKinematics.kappaAi) ? +agentKinematics.kappaAi.toFixed(4) : null,
                agentCollapse3: Number.isFinite(agentKinematics.collapse3) ? +agentKinematics.collapse3.toFixed(4) : null,
                agentSimplexV3: Number.isFinite(agentKinematics.simplexVolume3) ? +agentKinematics.simplexVolume3.toFixed(4) : null,
                agentTorsion3: Number.isFinite(agentKinematics.torsion3) ? +agentKinematics.torsion3.toFixed(4) : null,
                agentNormalStep3: Number.isFinite(agentKinematics.normalStep3) ? +agentKinematics.normalStep3.toFixed(4) : null,
                agentHelicalDeepDive: Boolean(agentKinematics.helicalDeepDive),
                qrEPh: Number.isFinite(finalMetaPol.qrEPh) ? +finalMetaPol.qrEPh.toFixed(4) : null,
                qrEMeta: Number.isFinite(finalMetaPol.qrEMeta) ? +finalMetaPol.qrEMeta.toFixed(4) : null,
                qrEColor: Number.isFinite(finalMetaPol.qrEColor) ? +finalMetaPol.qrEColor.toFixed(4) : null,
                independentObservationUsed: preferIndependentObs,
                dualTransferSource,
                dualTransferNovelty,
                timeFlowShift: geoShift,
                pyramidL1Tags: pyramidL1Names,
                timeFlowMode: timeFlow.mode,
                timeFlowPhase: timeFlow.phase,
                timeFlowContinuity: timeFlow.continuity,
                timeFlowCPrev: timeFlow.cPrev,
                timeFlowCAnchor: timeFlow.cAnchor,
                coneCoverage3D: coneCoverage3D === null ? null : +coneCoverage3D.toFixed(4),
                coneResidual3D: coneResidual3D === null ? null : +coneResidual3D.toFixed(4),
                dualSaddle,
                residualGrounded,
                memorySteered,
                diaryBridgeSource: diaryBridge.source,
                diaryBridgeCount: diaryBridge.count,
                diaryBridgeFootprints: Array.isArray(diaryBridge.footprints) ? diaryBridge.footprints.length : 0,
                diaryBridgeNovelty: Number.isFinite(diaryBridge.novelty) ? +diaryBridge.novelty.toFixed(4) : 0,
                globalManifoldNodes: manifold?.nodeCount || null,
                solveMs,
                totalMs,
                query: `${formula}\n\n${combinedQueryForDisplay || ''}`.trim(),
                useGroup,
                engine: retrievalEngine,
                formula,
                totalStages: observerStages.length,
                stages: observerStages,
                stars: selectedStars.map(s => ({
                    slot: s.slot,
                    name: s.starName,
                    score: s.item?.score,
                    cos1: s.cos1 ?? null,
                    cos2: s.cos2 ?? null,
                    distH1: s.distH1 ?? null,
                    distH2: s.distH2 ?? null,
                    radius: s.radius ?? null,
                    pAlign: s.pAlign ?? null,
                    dDiff: s.dDiff ?? null,
                    torqueDeficit: s.torqueDeficit ?? null,
                    uniqueExposureCdf: s.uniqueExposureCdf ?? null,
                    diaryBridge: s.diaryBridge ?? null,
                    coneProj: s.coneProj ?? null,
                    coneClearance: s.coneClearance ?? null,
                    escape: s.escape ?? null,
                    role: s.item?.role ?? null
                }))
            });
        } catch (err) {
            console.warn('[MetaThinkingManager][V3.8] VCP Info broadcast failed:', err.message);
        }

        return formula;
        } finally {
            if (sharpestPrepared) {
                try {
                    vdb?.releaseMemoObservation?.(sharpestPrepared);
                } catch (_) { /* noop */ }
            }
            if (ownedPrepared) {
                try {
                    vdb?.releaseMemoObservation?.(ownedPrepared);
                } catch (_) { /* noop */ }
            }
        }
    }

    /**
     * 异步单飞构造大星池谱粗筛子空间（worker_threads 离主线程，不阻塞 Node.js 事件循环与 SSE 流）。
     */
    _v3ScheduleCoarseSubspaceBuild(pool, scopeKey) {
        if (!pool || !pool.zMatrix || !pool.stars?.length || !pool.zDim) return null;
        if (!this._v3CoarseSubspaceJobs) this._v3CoarseSubspaceJobs = new Map();
        const jobKey = `${scopeKey}\0${pool.versionKey}`;
        if (this._v3CoarseSubspaceJobs.has(jobKey)) {
            return this._v3CoarseSubspaceJobs.get(jobKey);
        }
        let WorkerCtor;
        try {
            ({ Worker: WorkerCtor } = require('node:worker_threads'));
        } catch (_) {
            return null;
        }
        if (typeof WorkerCtor !== 'function') return null;

        const zCopy = new Float32Array(pool.zMatrix);
        const job = new Promise((resolve) => {
            let worker;
            try {
                worker = new WorkerCtor(__filename, {
                    workerData: {
                        __v3CoarseSubspaceTask: true,
                        zBuffer: zCopy.buffer,
                        nStars: pool.stars.length,
                        dim: pool.zDim,
                        pairStdCos: pool.pairStdCos
                    },
                    transferList: [zCopy.buffer]
                });
            } catch (_) {
                this._v3CoarseSubspaceJobs.delete(jobKey);
                resolve(null);
                return;
            }
            worker.unref?.();
            let settled = false;
            const finish = (val) => {
                if (settled) return;
                settled = true;
                this._v3CoarseSubspaceJobs.delete(jobKey);
                resolve(val);
            };
            worker.once('message', (msg) => {
                if (msg?.ok && msg.ukBuffer && msg.zMatrixKBuffer) {
                    const coarse = {
                        k: msg.k,
                        subN: msg.subN,
                        targetVar: msg.targetVar,
                        uk: new Float32Array(msg.ukBuffer),
                        zMatrixK: new Float32Array(msg.zMatrixKBuffer)
                    };
                    pool.coarseSubspace = coarse;
                    finish(coarse);
                } else {
                    finish(null);
                }
            });
            worker.once('error', () => finish(null));
            worker.once('exit', () => finish(null));
        });
        this._v3CoarseSubspaceJobs.set(jobKey, job);
        return job;
    }

    async waitCoarseSubspaceBuilds() {
        if (!this._v3CoarseSubspaceJobs || this._v3CoarseSubspaceJobs.size === 0) return;
        await Promise.allSettled([...this._v3CoarseSubspaceJobs.values()]);
    }
}

const { isMainThread, parentPort, workerData } = require('node:worker_threads');
if (!isMainThread && workerData && workerData.__v3CoarseSubspaceTask) {
    try {
        const { zBuffer, nStars, dim, pairStdCos } = workerData;
        const zMatrix = new Float32Array(zBuffer);
        const mgr = new MetaThinkingManager(null);
        const res = mgr._v3BuildCoarseSubspace(zMatrix, nStars, dim, pairStdCos);
        if (res && res.uk && res.zMatrixK) {
            parentPort.postMessage(
                {
                    ok: true,
                    k: res.k,
                    subN: res.subN,
                    targetVar: res.targetVar,
                    ukBuffer: res.uk.buffer,
                    zMatrixKBuffer: res.zMatrixK.buffer
                },
                [res.uk.buffer, res.zMatrixK.buffer]
            );
        } else {
            parentPort.postMessage({ ok: false });
        }
    } catch (err) {
        parentPort.postMessage({ ok: false, error: err?.message || String(err) });
    }
}

module.exports = MetaThinkingManager;