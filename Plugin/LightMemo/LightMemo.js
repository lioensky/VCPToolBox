// Plugin/LightMemoPlugin/LightMemo.js
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const { Jieba } = require('@node-rs/jieba');
const { dict } = require('@node-rs/jieba/dict');

class BM25Ranker {
    constructor() {
        this.k1 = 1.5;  // 词频饱和参数
        this.b = 0.75;  // 长度惩罚参数
    }

    /**
     * 计算BM25分数
     * @param {Array} queryTokens - 查询分词
     * @param {Array} docTokens - 文档分词
     * @param {Number} avgDocLength - 平均文档长度
     * @param {Object} idfScores - 每个词的IDF分数
     */
    score(queryTokens, docTokens, avgDocLength, idfScores) {
        const docLength = docTokens.length;
        const termFreq = {};

        // 统计词频
        for (const token of docTokens) {
            termFreq[token] = (termFreq[token] || 0) + 1;
        }

        let score = 0;
        for (const token of queryTokens) {
            const tf = termFreq[token] || 0;
            if (tf === 0) continue;

            const idf = idfScores[token] || 0;

            // BM25公式
            const numerator = tf * (this.k1 + 1);
            const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / avgDocLength));

            score += idf * (numerator / denominator);
        }

        return score;
    }

    /**
     * 计算IDF（逆文档频率）
     * @param {Array} allDocs - 所有文档的分词数组
     */
    calculateIDF(allDocs) {
        const N = allDocs.length;
        const df = {}; // document frequency

        // 统计每个词出现在多少文档中
        for (const doc of allDocs) {
            const uniqueTokens = new Set(doc);
            for (const token of uniqueTokens) {
                df[token] = (df[token] || 0) + 1;
            }
        }

        // 计算IDF
        const idfScores = {};
        for (const token in df) {
            // IDF = log((N - df + 0.5) / (df + 0.5) + 1)
            idfScores[token] = Math.log((N - df[token] + 0.5) / (df[token] + 0.5) + 1);
        }

        return idfScores;
    }
}

class LightMemoPlugin {
    constructor() {
        this.name = 'LightMemo';
        this.vectorDBManager = null;
        this.tdbKnowledgeManager = null; // 冷知识库（TriviumDB）检索管理器
        this.aiMemoBridge = null; // RAGDiaryPlugin 共享的 AI 记忆总结桥
        this.getSingleEmbedding = null;
        this.getBatchEmbeddings = null;
        this.projectBasePath = '';
        this.dailyNoteRootPath = '';
        this.rerankConfig = {};
        this.excludedFolders = [];
        this.semanticGroups = null;
        this.wordToGroupMap = new Map();
        this.stopWords = new Set([
            '的', '了', '在', '是', '我', '你', '他', '她', '它',
            '这', '那', '有', '个', '就', '不', '人', '都', '一',
            '上', '也', '很', '到', '说', '要', '去', '能', '会'
        ]);

        // ✅ 初始化 jieba 实例（加载默认字典）
        try {
            this.jiebaInstance = Jieba.withDict(dict);
            console.log('[LightMemo] Jieba initialized successfully.');
        } catch (error) {
            console.error('[LightMemo] Failed to initialize Jieba:', error);
            this.jiebaInstance = null;
        }
    }

    initialize(config, dependencies) {
        this.projectBasePath = config.PROJECT_BASE_PATH || path.join(__dirname, '..', '..');
        this.dailyNoteRootPath = process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(this.projectBasePath, 'dailynote');

        if (dependencies.vectorDBManager) {
            this.vectorDBManager = dependencies.vectorDBManager;
        }
        if (dependencies.tdbKnowledgeManager) {
            this.tdbKnowledgeManager = dependencies.tdbKnowledgeManager;
            console.log('[LightMemo] TDBKnowledgeManager injected. Cold knowledge base search enabled.');
        }
        if (dependencies.aiMemoBridge) {
            this.aiMemoBridge = dependencies.aiMemoBridge;
            console.log('[LightMemo] AIMemoBridge injected. Optional AI memory summarization enabled.');
        }
        if (dependencies.getSingleEmbedding) {
            this.getSingleEmbedding = dependencies.getSingleEmbedding;
        }
        if (dependencies.getBatchEmbeddings) {
            this.getBatchEmbeddings = dependencies.getBatchEmbeddings;
        }

        this.loadConfig(); // Load config after dependencies are set
        this.loadSemanticGroups();
        console.log('[LightMemo] Plugin initialized successfully as a hybrid service.');
    }

    loadConfig() {
        // config.env is already loaded by Plugin.js, we just need to read the values
        const excluded = process.env.EXCLUDED_FOLDERS || "已整理,夜伽,MusicDiary";
        this.excludedFolders = excluded.split(',').map(f => f.trim()).filter(Boolean);

        const configuredMaxDocuments = parseInt(process.env.RerankMaxDocumentsPerRequest, 10);
        const configuredConcurrency = parseInt(process.env.RerankMaxConcurrentRequests, 10);
        this.rerankConfig = {
            url: process.env.RerankUrl || '',
            apiKey: process.env.RerankApi || '',
            model: process.env.RerankModel || '',
            maxTokens: parseInt(process.env.RerankMaxTokensPerBatch) || 30000,
            // 单次最多 25 个 documents，避免误入服务商按 Token 计费的大批量档。
            maxDocumentsPerRequest: Number.isFinite(configuredMaxDocuments)
                ? Math.max(1, Math.min(25, configuredMaxDocuments))
                : 25,
            // 小批量请求采用有界并发，避免无上限并发压垮服务商。
            maxConcurrentRequests: Number.isFinite(configuredConcurrency)
                ? Math.max(1, Math.min(10, configuredConcurrency))
                : 3,
            multiplier: parseFloat(process.env.RerankMultiplier) || 2.0
        };
    }

    async processToolCall(args) {
        try {
            const result = this._isTagMemoV10Request(args)
                ? await this.handleTagMemoV10(args)
                : this._isTagMemoABRequest(args)
                    ? await this.handleTagMemoAB(args)
                    : this._isMappingRequest(args)
                        ? await this.handleMapping(args)
                        : await this.handleSearch(args);

            return this._normalizeToolResult(result);
        } catch (error) {
            console.error('[LightMemo] Error processing tool call:', error);
            // Return an error structure that Plugin.js can understand
            return { plugin_error: error.message || 'An unknown error occurred in LightMemo.' };
        }
    }

    _normalizeToolResult(result) {
        if (typeof result === 'string') {
            return this._buildAiFriendlyTextResult(result);
        }

        if (
            result &&
            typeof result === 'object' &&
            result.status === 'success' &&
            Array.isArray(result.result)
        ) {
            return {
                status: 'success',
                result: { content: result.result }
            };
        }

        if (
            result &&
            typeof result === 'object' &&
            result.status === 'success' &&
            result.result &&
            typeof result.result === 'object' &&
            Array.isArray(result.result.content)
        ) {
            return result;
        }

        if (result && typeof result === 'object' && Array.isArray(result.content)) {
            return {
                status: 'success',
                result
            };
        }

        return result;
    }

    async handleSearch(args) {
        // 兼容性处理：解构时提供默认值，确保 core_tags 缺失时不会报错
        const {
            query, maid, folder, k = 5, rerank = false,
            search_all_knowledge_bases = false,
            tag_boost: rawTagBoost = 0.5,
            core_tags = [],
            core_boost_factor = 1.33,
            knowledge_base = null,
            aimemo: rawAIMemo = false,
            aimemo_preset: rawAIMemoPreset = null,
            BM25: rawBM25Upper,
            bm25: rawBM25Lower,
            use_bm25: rawUseBM25,
            enginemode: rawEngineMode,
            engineMode: rawEngineModeAlias,
            // 兼容首版 RiverMemo 接口；新调用统一使用 enginemode。
            memory_engine: legacyMemoryEngine,
            memoryEngine: legacyMemoryEngineAlias
        } = args;

        const aiMemoOptions = this._parseAIMemoOptions(rawAIMemo, rawAIMemoPreset);

        const useBM25 = this._parseBooleanAlias(
            [
                ['BM25', rawBM25Upper],
                ['bm25', rawBM25Lower],
                ['use_bm25', rawUseBM25]
            ],
            true,
            'BM25'
        );

        // 🧊 冷知识库（TriviumDB）检索分流：
        //   - query 中带 [知识库] 或 [知识库:库名1,库名2] 语法
        //   - 或显式提供 knowledge_base 参数
        // 命中后走 TDBKnowledge 的 BM25+向量+图扩散混合检索，不进入 dailynote/TagMemo 流程。
        const coldRoute = this._detectColdKnowledgeRoute(query, knowledge_base);
        if (coldRoute) {
            return await this._handleColdKnowledgeSearch({
                query: coldRoute.query,
                libraries: coldRoute.libraries,
                k,
                rerank
            });
        }

        // 🌟 V9.1: 解析 tag_boost 的 "+" 后缀
        // tag_boost:「始」0.6「末」  → V9.1 向量增强
        // tag_boost:「始」0.6+「末」 → V9.1 向量增强 + 势能场重排
        let useGeodesicRerank = false;
        let tag_boost = rawTagBoost;
        if (typeof rawTagBoost === 'string') {
            const trimmedTagBoost = rawTagBoost.trim();
            if (trimmedTagBoost.endsWith('+')) {
                useGeodesicRerank = true;
                tag_boost = this._parseNumber(trimmedTagBoost.slice(0, -1), 0);
            } else {
                tag_boost = this._parseNumber(trimmedTagBoost, 0);
            }
        } else {
            tag_boost = this._parseNumber(rawTagBoost, 0);
        }

        const normalizedK = Math.max(1, Math.floor(this._parseNumber(k, 5)));
        const engineMode = this._parseEngineMode(
            rawEngineModeAlias
            ?? rawEngineMode
            ?? legacyMemoryEngineAlias
            ?? legacyMemoryEngine
        );
        // “+”只属于 TagMemo V9 势能场语法；KNN 与 RiverMemo 均不读取它。
        useGeodesicRerank = engineMode === 'tagmemo' && useGeodesicRerank;
        const potentialFieldConfig = this.vectorDBManager?.ragParams?.KnowledgeBaseManager?.geodesicRerank || {};
        const geoCandidateMultiplier = useGeodesicRerank
            ? Math.max(1, Math.min(10, Number(potentialFieldConfig.candidateKMultiplier) || 2))
            : 1;
        const geoCandidateK = Math.max(normalizedK, Math.ceil(normalizedK * geoCandidateMultiplier));
        const normalizedCoreTags = this._parseStringArray(core_tags);
        const normalizedCoreBoostFactor = this._parseNumber(core_boost_factor, 1.33);

        const parsedMaidScope = this._parseMaidScopedFolder(maid);
        const scopedMaid = parsedMaidScope.maid;
        const combinedFolder = this._mergeFolderScopes(folder, parsedMaidScope.folder);

        let isMusicSearch = false;
        let actualQuery = query || "";

        if (actualQuery.includes('[音乐检索]')) {
            isMusicSearch = true;
            actualQuery = actualQuery.replace('[音乐检索]', '').trim();
        }

        // --- 时间范围约束语法解析 ---
        let timeRange = null;
        const timeRangeRegex = /\[\s*(20\d{2}[-./]\d{1,2}(?:[-./]\d{1,2})?)\s*[~到-]\s*(20\d{2}[-./]\d{1,2}(?:[-./]\d{1,2})?)\s*\]/;
        let timeMatch = actualQuery.match(timeRangeRegex);

        const parseDateToNumber = (dateStr, isEnd) => {
            const parts = dateStr.split(/[-./]/);
            const y = parts[0];
            const m = (parts[1] || (isEnd ? '12' : '01')).padStart(2, '0');
            const d = (parts[2] || (isEnd ? '31' : '01')).padStart(2, '0');
            return parseInt(`${y}${m}${d}`, 10);
        };

        if (timeMatch) {
            const startNum = parseDateToNumber(timeMatch[1], false);
            const endNum = parseDateToNumber(timeMatch[2], true);
            timeRange = { start: startNum, end: endNum };
            actualQuery = actualQuery.replace(timeMatch[0], '').trim();
            console.log(`[LightMemo] Parsed time range constraint: ${timeMatch[1]} to ${timeMatch[2]} (${startNum} - ${endNum})`);
        } else {
            const singleDateRegex = /\[\s*(20\d{2}[-./]\d{1,2}(?:[-./]\d{1,2})?)\s*\]/;
            const singleDateMatch = actualQuery.match(singleDateRegex);
            if (singleDateMatch) {
                const dateNumStart = parseDateToNumber(singleDateMatch[1], false);
                const dateNumEnd = parseDateToNumber(singleDateMatch[1], true);
                timeRange = { start: dateNumStart, end: dateNumEnd };
                actualQuery = actualQuery.replace(singleDateMatch[0], '').trim();
                console.log(`[LightMemo] Parsed single date constraint: ${singleDateMatch[1]} (${dateNumStart} - ${dateNumEnd})`);
            }
        }

        if (!actualQuery && timeRange) {
            actualQuery = scopedMaid || combinedFolder || "记录"; // 如果只有时间约束，给予默认查询词避免向量化报错
        }

        if (!isMusicSearch && (!query || (!scopedMaid && !combinedFolder))) {
            throw new Error("参数 'query' 是必需的，且必须提供 'maid' 或 'folder'。");
        }

        const normalizedSearchAll = this._parseBoolean(search_all_knowledge_bases, false);

        const effectiveFolder = isMusicSearch ? 'MusicDiary' : combinedFolder;
        const effectiveMaid = isMusicSearch ? null : scopedMaid;
        const effectiveSearchAll = isMusicSearch ? false : normalizedSearchAll;

        // 从所有日记本中收集候选chunks
        const candidates = await this._gatherCandidateChunks({
            maid: effectiveMaid,
            folder: effectiveFolder,
            searchAll: effectiveSearchAll,
            ignoreExcludedFolders: isMusicSearch,
            timeRange: timeRange
        });

        if (candidates.length === 0) {
            if (isMusicSearch) return `没有在 ${effectiveFolder} 中找到相关的音乐记忆。`;
            return `没有找到署名为 "${effectiveMaid}" 的相关记忆。`;
        }

        console.log(`[LightMemo] Gathered ${candidates.length} candidate chunks from ${new Set(candidates.map(c => c.dbName)).size} diaries.`);

        let topByKeyword = [];

        if (isMusicSearch) {
            console.log(`[LightMemo] [音乐检索] 触发，跳过BM25关键词检索。`);
            topByKeyword = candidates; // 直接所有进入下一阶段
        } else if (!useBM25) {
            console.log('[LightMemo] BM25 keyword retrieval disabled by request. Using vector-only candidate pool.');
            topByKeyword = candidates;
        } else {
            // --- 第一阶段：关键词初筛（BM25） ---
            const queryTokens = this._tokenize(actualQuery);
            console.log(`[LightMemo] Query tokens: [${queryTokens.join(', ')}]`);

            // 扩展查询词（语义组）
            const expandedTokens = this._expandQueryTokens(queryTokens);
            const allQueryTokens = [...new Set([...queryTokens, ...expandedTokens])];
            console.log(`[LightMemo] Expanded tokens: [${allQueryTokens.join(', ')}]`);

            // BM25排序
            const bm25Ranker = new BM25Ranker();
            const allDocs = candidates.map(c => c.tokens);
            const idfScores = bm25Ranker.calculateIDF(allDocs);
            const avgDocLength = allDocs.reduce((sum, doc) => sum + doc.length, 0) / allDocs.length;

            const scoredCandidates = candidates.map(candidate => {
                const bm25Score = bm25Ranker.score(
                    allQueryTokens,
                    candidate.tokens,
                    avgDocLength,
                    idfScores
                );
                return { ...candidate, bm25Score };
            });

            // 🚀 优化：放宽 BM25 限制。如果 BM25 没搜到，可能是分词太碎或太死板，此时允许向量检索兜底。
            const bm25PoolK = Math.max(normalizedK * 5, geoCandidateK);
            topByKeyword = scoredCandidates
                .filter(c => c.bm25Score > 0)
                .sort((a, b) => b.bm25Score - a.bm25Score)
                .slice(0, bm25PoolK);

            // 测地线需要独立候选预算；BM25 命中不足时补齐到专属候选 K。
            if (topByKeyword.length < geoCandidateK) {
                console.log(
                    `[LightMemo] BM25 results insufficient for candidate pool ` +
                    `(${topByKeyword.length}/${geoCandidateK}), adding fallback candidates.`
                );
                const existingIds = new Set(topByKeyword.map(c => c.label));
                const fallbacks = scoredCandidates
                    .filter(c => !existingIds.has(c.label))
                    .slice(0, geoCandidateK - topByKeyword.length);
                topByKeyword = [...topByKeyword, ...fallbacks];
            }
        }

        console.log(`[LightMemo] Candidate pool size: ${topByKeyword.length} chunks.`);

        // --- 第二阶段：向量精排 ---
        let queryVector = await this.getSingleEmbedding(actualQuery);
        if (!queryVector) {
            throw new Error("查询内容向量化失败。");
        }
        // 保留原始查询坐标；TagMemo 增强后 queryVector 会被替换，四层影子读出需要同时观察 q 与 q'。
        const originalQueryVector = queryVector instanceof Float32Array
            ? new Float32Array(queryVector)
            : new Float32Array(queryVector);

        if (engineMode === 'rivermemo') {
            return await this._handleRiverMemoSearch({
                query,
                actualQuery,
                queryVector: originalQueryVector,
                candidates,
                maid: effectiveMaid,
                folder: effectiveFolder,
                searchAll: effectiveSearchAll,
                k: normalizedK,
                rerank,
                useBM25,
                tagBoost: tag_boost,
                coreTags: normalizedCoreTags,
                coreBoostFactor: normalizedCoreBoostFactor,
                aiMemoOptions
            });
        }

        let tagBoostInfo = null;
        let tagBoostEnergyField = null;
        let tagBoostEnergyFieldProvenance = null;
        let tagBoostArtifactBundle = null;
        // 🚀【新步骤】如果启用了 TagMemo，则调用 KBM 的功能来增强向量
        if (
            engineMode === 'tagmemo'
            && tag_boost > 0
            && this.vectorDBManager
            && typeof this.vectorDBManager.applyTagBoost === 'function'
        ) {
            const hasCore = normalizedCoreTags.length > 0;
            const waveLabel = useGeodesicRerank ? 'TagMemo V9.1 + Potential Field' : 'TagMemo V9.1';
            console.log(`[LightMemo] Applying ${waveLabel} boost (Factor: ${tag_boost}${hasCore ? `, CoreTags: ${core_tags.length}` : ''})`);

            // 即使 core_tags 为空，KBM 内部也会处理好默认逻辑
            const boostResult = this.vectorDBManager.applyTagBoost(
                new Float32Array(queryVector),
                tag_boost,
                normalizedCoreTags,
                normalizedCoreBoostFactor
            );

            if (boostResult && boostResult.vector) {
                queryVector = boostResult.vector;
                tagBoostInfo = boostResult.info;
                tagBoostEnergyField = boostResult.energyField || null;
                tagBoostEnergyFieldProvenance = boostResult.energyFieldProvenance || null;
                tagBoostArtifactBundle = boostResult.artifactBundle || null;

                if (tagBoostInfo) {
                    const matched = tagBoostInfo.matchedTags || [];
                    const coreMatched = tagBoostInfo.coreTagsMatched || [];
                    if (coreMatched.length > 0) {
                        console.log(`[LightMemo] TagMemo V9.1 Spotlight: [${coreMatched.join(', ')}]`);
                    }
                    if (matched.length > 0) {
                        console.log(`[LightMemo] TagMemo V9.1 Matched: [${matched.slice(0, 5).join(', ')}]`);
                    }
                }
            }
        }

        // 为每个候选chunk计算向量相似度
        const vectorScoredCandidates = await this._scoreByVectorSimilarity(
            topByKeyword,
            queryVector
        );

        // 混合BM25和向量分数
        // 🚀 优化：动态调整权重。如果有 BM25 分数，则关键词权重高；如果没有，则全靠向量。
        const hybridScored = vectorScoredCandidates.map(c => {
            if (isMusicSearch || !useBM25) {
                return {
                    ...c,
                    hybridScore: c.vectorScore, // 完全依赖向量分数
                    tagBoostInfo: tagBoostInfo
                };
            }

            const hasBM25 = c.bm25Score > 0;
            const bmWeight = hasBM25 ? 0.6 : 0.0;
            const vecWeight = hasBM25 ? 0.4 : 1.0;

            // 归一化 BM25 分数以便混合 (简单处理：除以最大可能分数或当前最高分)
            const normalizedBM25 = hasBM25 ? Math.min(1.0, c.bm25Score / 10) : 0;

            return {
                ...c,
                hybridScore: normalizedBM25 * bmWeight + c.vectorScore * vecWeight,
                tagBoostInfo: tagBoostInfo
            };
        }).sort((a, b) => b.hybridScore - a.hybridScore);

        // 🌟 V9.1: 查询级势能场重排
        let rankedCandidates = hybridScored;
        if (useGeodesicRerank && tag_boost > 0 && tagBoostInfo && this.vectorDBManager && this.vectorDBManager.geodesicRerank) {
            console.log(`[LightMemo] 🌟 V9.1: Applying potential-field rerank to ${hybridScored.length} candidates...`);

            // geodesicRerank expects candidates with `id` (chunk ID) and `score` fields
            const geoInput = hybridScored.map(c => ({
                ...c,
                id: c.label,  // label is chunk.id from SQLite
                score: c.hybridScore || c.vectorScore || 0
            }));

            const reranked = this.vectorDBManager.geodesicRerank(geoInput, {
                alpha: potentialFieldConfig.alpha,
                minGeoSamples: potentialFieldConfig.minGeoSamples,
                energyField: tagBoostEnergyField,
                energyFieldProvenance: tagBoostEnergyFieldProvenance,
                originalQueryVector,
                enhancedQueryVector: queryVector,
                queryGeometryState: {
                    epa: tagBoostInfo?.epa || null,
                    pyramid: tagBoostInfo?.pyramid || null
                },
                artifactBundle: tagBoostArtifactBundle
            });

            // Map results back with geodesic metadata
            rankedCandidates = reranked.map(r => ({
                ...r,
                hybridScore: r.score,
                tagBoostInfo: tagBoostInfo,
                potentialFieldV91: r.geo_score > 0
            }));

            const geoCount = rankedCandidates.filter(r => r.potentialFieldV91).length;
            console.log(
                `[LightMemo] 🌟 V9.1: Potential-field rerank complete. ` +
                `${geoCount}/${rankedCandidates.length} candidates with field contribution ` +
                `(requestedK=${normalizedK}, candidateK=${geoCandidateK}, multiplier=${geoCandidateMultiplier}).`
            );
        }

        // 取top K
        let finalResults = rankedCandidates.slice(0, normalizedK);

        // --- 第三阶段：Rerank（可选） ---
        // 🌟 Rerank+ (RRF): rerank 参数支持多种形式
        //   false          → 不使用 Rerank
        //   true           → 标准 Rerank（纯精排，无融合）
        //   "rrf"          → RRF 融合 (α=0.5)
        //   "rrf0.7"       → RRF 融合 (α=0.7, Reranker 占 70% 权重)
        //   0.7 (数字)     → RRF 融合 (α=0.7)，等价于 "rrf0.7"
        //   "0.7" (字符串) → RRF 融合 (α=0.7)，等价于 "rrf0.7"
        let useRerank = false;
        let rrfOptions = null;

        if (rerank === true) {
            useRerank = true;
        } else if (typeof rerank === 'number' && rerank > 0 && rerank <= 1.0) {
            // 直接传数字 → RRF 融合
            useRerank = true;
            rrfOptions = { alpha: rerank };
            console.log(`[LightMemo] 🌟 Rerank+ (RRF) 数字模式启用: α=${rerank}`);
        } else if (typeof rerank === 'string') {
            const lowerRerank = rerank.toLowerCase().trim();
            if (lowerRerank.startsWith('rrf')) {
                // "rrf" / "rrf0.7" 形式
                useRerank = true;
                const alphaMatch = lowerRerank.match(/rrf(\d+\.?\d*)/);
                const alpha = alphaMatch ? Math.min(1.0, Math.max(0.0, parseFloat(alphaMatch[1]))) : 0.5;
                rrfOptions = { alpha };
                console.log(`[LightMemo] 🌟 Rerank+ (RRF) 模式启用: α=${alpha}`);
            } else {
                // 尝试解析为数字字符串 "0.7"
                const numericAlpha = parseFloat(lowerRerank);
                if (!isNaN(numericAlpha) && numericAlpha > 0 && numericAlpha <= 1.0) {
                    useRerank = true;
                    rrfOptions = { alpha: numericAlpha };
                    console.log(`[LightMemo] 🌟 Rerank+ (RRF) 数字字符串模式启用: α=${numericAlpha}`);
                } else if (lowerRerank === 'true') {
                    useRerank = true;
                }
            }
        }

        if (useRerank && finalResults.length > 0) {
            // 🌟 Rerank+: 注入检索排位 (retrieval_rank) 用于 RRF 融合
            finalResults.forEach((doc, idx) => { doc.retrieval_rank = idx + 1; });
            finalResults = await this._rerankDocuments(actualQuery, finalResults, normalizedK, rrfOptions);
        }

        if (aiMemoOptions.enabled && finalResults.length > 0) {
            const aiMemoResult = await this._summarizeWithAIMemo({
                results: finalResults,
                query: actualQuery,
                presetName: aiMemoOptions.presetName,
                cacheSalt: JSON.stringify({
                    maid: effectiveMaid,
                    folder: effectiveFolder,
                    searchAll: effectiveSearchAll,
                    k: normalizedK,
                    rerank,
                    useBM25,
                    tagBoost: tag_boost,
                    geodesic: useGeodesicRerank,
                    coreTags: normalizedCoreTags
                })
            });
            if (aiMemoResult) return aiMemoResult;
        }

        return this.formatResults(finalResults, query);
    }

    _parseEngineMode(value) {
        const normalized = String(value || 'rivermemo').trim().toLowerCase();
        if ([
            'rivermemo',
            'river_memo',
            'river-memo',
            'topology_v3',
            'topology-v3',
            'river',
            '浪潮河流',
            '河流记忆'
        ].includes(normalized)) {
            return 'rivermemo';
        }
        if ([
            'tagmemo',
            'tagmemo_v9',
            'tagmemo-v9',
            'v9'
        ].includes(normalized)) {
            return 'tagmemo';
        }
        if ([
            'knn',
            'vector',
            'vector_knn',
            'vector-knn',
            '向量'
        ].includes(normalized)) {
            return 'knn';
        }
        throw new RangeError(
            `enginemode 仅支持 rivermemo、tagmemo 或 knn，收到 "${value}"`
        );
    }

    // 兼容已经使用首版 memory_engine 的内部调用与测试。
    _parseMemoryEngine(value) {
        return this._parseEngineMode(value);
    }

    _parseRerankOptions(rerank) {
        if (rerank === true) return { enabled: true, rrfOptions: null };
        if (typeof rerank === 'number' && rerank > 0 && rerank <= 1) {
            return { enabled: true, rrfOptions: { alpha: rerank } };
        }
        if (typeof rerank !== 'string') {
            return { enabled: false, rrfOptions: null };
        }

        const normalized = rerank.toLowerCase().trim();
        if (normalized.startsWith('rrf')) {
            const alphaMatch = normalized.match(/rrf(\d+\.?\d*)/);
            return {
                enabled: true,
                rrfOptions: {
                    alpha: alphaMatch
                        ? Math.min(1, Math.max(0, parseFloat(alphaMatch[1])))
                        : 0.5
                }
            };
        }
        const numericAlpha = parseFloat(normalized);
        if (
            Number.isFinite(numericAlpha)
            && numericAlpha > 0
            && numericAlpha <= 1
        ) {
            return {
                enabled: true,
                rrfOptions: { alpha: numericAlpha }
            };
        }
        return {
            enabled: normalized === 'true',
            rrfOptions: null
        };
    }

    async _handleRiverMemoSearch({
        query,
        actualQuery,
        queryVector,
        candidates,
        maid,
        folder,
        searchAll,
        k,
        rerank,
        useBM25,
        tagBoost,
        coreTags,
        coreBoostFactor,
        aiMemoOptions
    }) {
        if (
            !this.vectorDBManager
            || typeof this.vectorDBManager.rerankWithRiverMemoAsync !== 'function'
        ) {
            const error = new Error(
                'RiverMemo 异步生产接口不可用；请求未回退到其他记忆引擎'
            );
            error.code = 'RIVERMEMO_ASYNC_INTERFACE_UNAVAILABLE';
            throw error;
        }

        const riverConfig =
            this.vectorDBManager.ragParams?.KnowledgeBaseManager?.riverMemo || {};
        const candidateConfig = riverConfig.candidateSuperset || {};
        const bm25Limit = Math.max(
            k,
            Math.floor(Number(candidateConfig.bm25K) || 50)
        );
        const bm25Scores = new Map(
            useBM25
                ? this._buildBm25TopIds(
                    actualQuery,
                    candidates,
                    bm25Limit
                ).map(item => [Number(item.id), Number(item.score) || 0])
                : []
        );
        const offeredCandidates = candidates.map(candidate => ({
            ...candidate,
            id: Number(candidate.label),
            chunkId: Number(candidate.label),
            bm25Score: bm25Scores.get(Number(candidate.label)) || 0
        }));
        const allowedFileIds = [...new Set(
            candidates
                .map(candidate => Number(candidate.fileId))
                .filter(Number.isFinite)
        )];
        const diaryNames = [...new Set(
            candidates
                .map(candidate => String(candidate.dbName || '').trim())
                .filter(Boolean)
        )];
        const agentContext = {
            agentId: maid || null,
            diaryNames,
            allowedFileIds,
            deniedFileIds: [],
            visibilityMode: 'explicit_sql_scope',
            permissions: {
                allowPublic: false,
                allowOwn: true,
                allowAuthorized: true,
                allowOtherAgentPublic: false,
                allowUnknownProvenance: false
            }
        };
        const rerankOptions = this._parseRerankOptions(rerank);
        // 与既有 LightMemo 行为一致：外部 Rerank 只消费最终检索窗口。
        // RiverMemo 自身先在完整 SQL 授权候选域上建立六路候选超集。
        const riverResult = await this.vectorDBManager.rerankWithRiverMemoAsync(
            {
                text: actualQuery,
                vector: queryVector
            },
            offeredCandidates,
            agentContext,
            {
                topK: k,
                coreTags,
                sourceObservationConfig: {
                    baseTagBoost: Math.max(0, Number(tagBoost) || 0),
                    coreBoostFactor: Math.max(
                        0,
                        Number(coreBoostFactor) || 1.33
                    )
                },
                // Rust 内核以 allowedFileIds 执行可见性门控；不再创建 Node Worker。
                identityDiaryName: maid || null,
                includeTrace: false
            }
        );
        if (!riverResult || !Array.isArray(riverResult.results)) {
            const error = new Error('RiverMemo 返回了无效的生产结果');
            error.code = 'RIVERMEMO_INVALID_RESULT';
            throw error;
        }

        let finalResults = riverResult.results.map(item => ({
            ...item,
            label: Number(item.label ?? item.id ?? item.chunkId),
            hybridScore: Number(item.score) || 0,
            riverMemo: {
                artifactSig: riverResult.artifactSig,
                queryId: riverResult.queryId,
                omega: Number(item.omega) || 0,
                regime: item.riverRegime || riverResult.omega?.regime || null,
                role: item.role || null,
                topologyBonus: Number(item.topologyBonus) || 0,
                anchorBonus: Number(item.anchorBonus) || 0
            }
        }));

        const preparationTimings =
            riverResult.diagnostics?.preparationTimings || {};
        const nativeTimings =
            riverResult.diagnostics?.nativeTopologyV3 || {};
        const fieldDiagnostics = riverResult.diagnostics?.field || {};
        const operatorCache = fieldDiagnostics.conditionedOperatorCache || {};
        const fieldProjection = riverResult.diagnostics?.fieldProjection || {};
        console.log(
            `[LightMemo] 🌊 RiverMemo Topology V3 [Rust/Rayon] ranked ` +
            `${riverResult.diagnostics?.rankedCandidates || 0}/` +
            `${riverResult.diagnostics?.offeredCandidates || candidates.length} ` +
            `candidates; Ω=${Number(riverResult.omega?.omega || 0).toFixed(4)}, ` +
            `regime=${riverResult.omega?.regime || 'unknown'}, ` +
            `artifact=${riverResult.artifactSig || 'unknown'}, ` +
            `nativeTotal=${Number(nativeTimings.totalMs || 0).toFixed(1)}ms` +
            `(load=${Number(nativeTimings.loadMs || 0).toFixed(1)}, ` +
            `compute=${Number(nativeTimings.computeMs || 0).toFixed(1)}, ` +
            `ffi=${Number(nativeTimings.ffiTotalMs || 0).toFixed(1)}, ` +
            `threads=${Number(nativeTimings.rayonThreads || 0)}), ` +
            `nativeProjection=${Number(nativeTimings.projectedCandidates || 0)}, ` +
            `nativeSelection=${Number(nativeTimings.selectedCandidates || 0)}, ` +
            `prepare=${Number(preparationTimings.totalMs || 0).toFixed(1)}ms` +
            `(observe=${Number(
                preparationTimings.sourceObservationMs || 0
            ).toFixed(1)}, solve=${Number(
                preparationTimings.solveDualFieldsMs || 0
            ).toFixed(1)}, sourceProjection=${Number(
                preparationTimings.sourceProjectionMs || 0
            ).toFixed(1)}, dualProjection=${Number(
                preparationTimings.dualProjectionTotalMs || 0
            ).toFixed(1)}), ` +
            `fieldProjection=${fieldProjection.backend || 'unknown'}` +
            `(${Number(
                fieldProjection.nativeElapsedMs
                ?? fieldProjection.elapsedMs
                ?? 0
            ).toFixed(2)}ms, ` +
            `${fieldProjection.foundTags ?? '—'}/` +
            `${fieldProjection.requestedTags ?? '—'} tags), ` +
            `operatorCache=${fieldDiagnostics.conditionedOperatorCacheStatus || 'unknown'}` +
            `(${operatorCache.entries || 0}/${operatorCache.limit || 0}, ` +
            `${(Number(operatorCache.estimatedBytes || 0) / 1048576).toFixed(1)}MiB).`
        );

        if (rerankOptions.enabled && finalResults.length > 0) {
            finalResults.forEach((document, index) => {
                document.retrieval_rank = index + 1;
            });
            finalResults = await this._rerankDocuments(
                actualQuery,
                finalResults,
                k,
                rerankOptions.rrfOptions
            );
        }

        if (aiMemoOptions.enabled && finalResults.length > 0) {
            const aiMemoResult = await this._summarizeWithAIMemo({
                results: finalResults,
                query: actualQuery,
                presetName: aiMemoOptions.presetName,
                cacheSalt: JSON.stringify({
                    memoryEngine: 'rivermemo',
                    artifactSig: riverResult.artifactSig,
                    maid,
                    folder,
                    searchAll,
                    k,
                    rerank,
                    useBM25,
                    tagBoost,
                    coreTags
                })
            });
            if (aiMemoResult) return aiMemoResult;
        }

        return this.formatResults(finalResults, query);
    }

    _isTagMemoV10Request(args = {}) {
        const command = String(args.command || args.action || '').trim().toLowerCase();
        const version = String(
            args.tagmemo_version || args.tagMemoVersion || args.version || ''
        ).trim().toLowerCase();
        return [
            'tagmemo_v10',
            'tagmemo-v10',
            'tagmemo_v10_alpha',
            'tagmemo-v10-alpha',
            'tagmemo_v10_ab',
            'tagmemo-v10-ab',
            'tagmemo_unified_ab',
            'tagmemo-unified-ab',
            'v10_alpha',
            'v10-alpha',
            '统一认知几何',
            '统一寻址对照'
        ].includes(command) || ['v10', 'v10_alpha', 'v10.alpha.1'].includes(version);
    }

    _isTagMemoABRequest(args = {}) {
        const command = String(args.command || args.action || '').trim().toLowerCase();
        const mode = String(args.ab_mode || args.abMode || '').trim().toLowerCase();
        return [
            'tagmemo_ab', 'tagmemo-ab', 'memory_address_ab',
            'memory-address-ab', '双轨寻址', '双轨测绘',
            'tagmemo_compare', 'tagmemo-compare', 'v91_compare'
        ].includes(command) || ['a', 'b', 'mode_a', 'mode_b', 'kernel', 'product'].includes(mode);
    }

    /**
     * TagMemo V10 Alpha 独立实验入口。
     * 服务端批量脚本可传
     * experiment_arm=pure|gated|observed|topology|topology_v2|topology_v3|all，
     * 并用 disabled_observables=direct,structural,thematic,closure 做逐项消融。
     */
    async handleTagMemoV10(args = {}) {
        const requestStartedAt = performance.now();
        const timing = {};
        const measureSync = (name, operation) => {
            const startedAt = performance.now();
            const result = operation();
            timing[name] = performance.now() - startedAt;
            return result;
        };
        const measureAsync = async (name, operation) => {
            const startedAt = performance.now();
            const result = await operation();
            timing[name] = performance.now() - startedAt;
            return result;
        };

        const required = [
            'getTagMemoV10ArtifactSnapshot',
            'prepareTagMemoV10Query',
            'buildTagMemoV10CandidateSuperset',
            'projectTagMemoV10CandidateCurves',
            'evaluateTagMemoV10CandidateCurves',
            'computeTagMemoV10Dstc'
        ];
        const missing = required.filter(name =>
            typeof this.vectorDBManager?.[name] !== 'function'
        );
        if (missing.length > 0) {
            throw new Error(
                `TagMemo V10 Alpha 接口不可用：${missing.join(', ')}`
            );
        }

        const command = String(args.command || args.action || '').trim().toLowerCase();
        const abRequested = [
            'tagmemo_v10_ab',
            'tagmemo-v10-ab',
            'tagmemo_unified_ab',
            'tagmemo-unified-ab',
            '统一寻址对照'
        ].includes(command);
        const compareRerank = abRequested && this._parseBooleanAlias(
            [
                ['compare_rerank', args.compare_rerank],
                ['compareRerank', args.compareRerank],
                ['rerank_compare', args.rerank_compare]
            ],
            false,
            'TagMemo unified A/B Rerank comparison'
        );
        const includeDetails = abRequested && this._parseABIncludeDetails(args);
        const query = String(args.query || args.start || '').trim();
        if (!query) throw new Error('TagMemo V10 Alpha 需要 query 参数。');
        const parsedMaidScope = this._parseMaidScopedFolder(args.maid);
        const maid = parsedMaidScope.maid;
        const folder = this._mergeFolderScopes(
            args.folder,
            parsedMaidScope.folder
        );
        const searchAll = this._parseBoolean(
            args.search_all_knowledge_bases,
            false
        );
        if (!searchAll && !maid && !folder) {
            throw new Error(
                'TagMemo V10 Alpha 必须提供 maid/folder，或开启 search_all_knowledge_bases。'
            );
        }

        const k = Math.max(1, Math.floor(this._parseNumber(args.k, 5)));
        const mapExperimentK = Math.max(
            k,
            Math.floor(this._parseNumber(
                args.map_k ?? args.mapK,
                Math.max(20, k * 4)
            ))
        );
        const sourceK = Math.max(
            1,
            Math.floor(this._parseNumber(args.source_k ?? args.sourceK, 16))
        );
        // 统一 A/B 必须同时计算所有实验臂，确保评审文档来自同一 Query State 与候选池。
        const arm = abRequested
            ? 'all'
            : String(
                args.experiment_arm || args.experimentArm || args.arm || 'all'
            ).trim().toLowerCase();
        if (![
            'pure',
            'gated',
            'observed',
            'topology',
            'topology_v2',
            'topology_v3',
            'all'
        ].includes(arm)) {
            throw new Error(
                'experiment_arm 仅支持 pure、gated、observed、topology、topology_v2、topology_v3 或 all。'
            );
        }
        const disabledObservables = this._parseStringArray(
            args.disabled_observables || args.disabledObservables
        ).map(value => value.toLowerCase());
        const useBM25 = this._parseBooleanAlias(
            [
                ['BM25', args.BM25],
                ['bm25', args.bm25],
                ['use_bm25', args.use_bm25]
            ],
            true,
            'TagMemo V10 BM25'
        );
        const forceArtifactRebuild = this._parseBoolean(
            args.force_artifact_rebuild,
            false
        );

        const candidates = await measureAsync(
            'gatherCandidatesMs',
            () => this._gatherCandidateChunks({
                maid,
                folder,
                searchAll,
                ignoreExcludedFolders: false,
                timeRange: null
            })
        );
        if (candidates.length === 0) {
            return this._buildAiFriendlyTextResult(
                JSON.stringify({
                    schema: 'tagmemo-v10-alpha-lightmemo-result-v1',
                    version: 'v10_alpha',
                    query,
                    error: 'no-candidates-in-scope'
                })
            );
        }

        const queryVectorRaw = await measureAsync(
            'embeddingMs',
            () => this.getSingleEmbedding(query)
        );
        if (!queryVectorRaw) {
            throw new Error('TagMemo V10 Alpha 查询向量化失败。');
        }
        const queryVector = queryVectorRaw instanceof Float32Array
            ? queryVectorRaw
            : new Float32Array(queryVectorRaw);
        const snapshot = measureSync(
            'artifactSnapshotMs',
            () => this.vectorDBManager.getTagMemoV10ArtifactSnapshot({
                forceRebuild: forceArtifactRebuild
            })
        );
        if (!snapshot?.bundle) {
            throw new Error('TagMemo V10 Alpha Artifact 不可用。');
        }

        // _gatherCandidateChunks 已经执行当前请求的 SQL 作用域与署名过滤。
        // 将这些 file_id 显式声明为 authorized，禁止 provenance 层自行猜测公开权限。
        const allowedFileIds = [...new Set(
            candidates.map(candidate => Number(candidate.fileId))
                .filter(Number.isFinite)
        )];
        const diaryNames = [...new Set(
            candidates.map(candidate => String(candidate.dbName || ''))
                .filter(Boolean)
        )];
        const prepared = measureSync(
            'prepareAndSolveQueryMs',
            () => this.vectorDBManager.prepareTagMemoV10Query(
                { text: query, vector: queryVector },
                {
                    agentId: maid || null,
                    diaryNames,
                    allowedFileIds,
                    deniedFileIds: [],
                    visibilityMode: 'explicit_sql_scope',
                    permissions: {
                        allowPublic: false,
                        allowOwn: true,
                        allowAuthorized: true,
                        allowOtherAgentPublic: false,
                        allowUnknownProvenance: false
                    }
                },
                {
                    artifact: snapshot.bundle,
                    sourceObservationConfig: { sourceK }
                }
            )
        );
        const queryState = prepared.queryState;
        if (
            !prepared.denoisedVector
            || !prepared.localVector
            || !prepared.transferVector
        ) {
            throw new Error(
                'TagMemo V10 Alpha 降噪源或双尺度场无法回投影。'
            );
        }

        // _scoreByVectorSimilarity 当前是同步 SQLite + CPU 热循环包装成 async。
        // 分别计时而非 Promise.all，避免四个同步阶段被错误显示成同一个并发耗时。
        const queryRanked = await measureAsync(
            'queryVectorScoreMs',
            () => this._scoreByVectorSimilarity(candidates, queryVector)
        );
        const denoisedRanked = await measureAsync(
            'denoisedVectorScoreMs',
            () => this._scoreByVectorSimilarity(
                candidates,
                prepared.denoisedVector
            )
        );
        const localRanked = await measureAsync(
            'localVectorScoreMs',
            () => this._scoreByVectorSimilarity(candidates, prepared.localVector)
        );
        const transferRanked = await measureAsync(
            'transferVectorScoreMs',
            () => this._scoreByVectorSimilarity(candidates, prepared.transferVector)
        );
        const queryScoreById = new Map(
            queryRanked.map(item => [Number(item.label), item.vectorScore])
        );
        const denoisedScoreById = new Map(
            denoisedRanked.map(item => [
                Number(item.label),
                item.vectorScore
            ])
        );
        const localScoreById = new Map(
            localRanked.map(item => [Number(item.label), item.vectorScore])
        );
        const transferScoreById = new Map(
            transferRanked.map(item => [Number(item.label), item.vectorScore])
        );

        const bm25Ranked = measureSync(
            'bm25Ms',
            () => useBM25
                ? this._buildBm25TopIds(
                    query,
                    candidates,
                    Math.max(k, Number(
                        snapshot.bundle.effectiveConfig?.candidateSuperset?.bm25K
                    ) || 50)
                )
                : []
        );
        const bm25ScoreById = new Map(
            bm25Ranked.map(item => [Number(item.id), Number(item.score) || 0])
        );

        // Anchor 路只从 Local 有效域直达 file_tags，不从 Transfer 获得身份资格。
        const localDomainIds = Array.isArray(queryState.localDomain?.ids)
            ? queryState.localDomain.ids.map(Number).filter(Number.isFinite)
            : [];
        const anchorScoreByChunkId = new Map();
        measureSync('anchorDirectMs', () => {
            if (localDomainIds.length > 0 && allowedFileIds.length > 0) {
                const db = this.vectorDBManager.db;
                const tagPlaceholders = localDomainIds.map(() => '?').join(',');
                const filePlaceholders = allowedFileIds.map(() => '?').join(',');
                const anchorRows = db.prepare(`
                    SELECT c.id AS chunk_id, COUNT(DISTINCT ft.tag_id) AS hits
                    FROM chunks c
                    JOIN file_tags ft ON ft.file_id = c.file_id
                    WHERE ft.tag_id IN (${tagPlaceholders})
                      AND c.file_id IN (${filePlaceholders})
                    GROUP BY c.id
                    ORDER BY hits DESC, c.id ASC
                `).all(...localDomainIds, ...allowedFileIds);
                const maximumHits = Math.max(
                    1,
                    ...anchorRows.map(row => Number(row.hits) || 0)
                );
                for (const row of anchorRows) {
                    anchorScoreByChunkId.set(
                        Number(row.chunk_id),
                        (Number(row.hits) || 0) / maximumHits
                    );
                }
            }
        });

        const candidateAssemblyStartedAt = performance.now();
        const enrichedById = new Map(candidates.map(candidate => {
            const id = Number(candidate.label);
            return [id, {
                ...candidate,
                id,
                chunkId: id,
                queryScore: queryScoreById.get(id) || 0,
                denoisedFieldScore: denoisedScoreById.get(id) || 0,
                localFieldScore: localScoreById.get(id) || 0,
                transferFieldScore: transferScoreById.get(id) || 0,
                bm25Score: bm25ScoreById.get(id) || 0,
                anchorScore: anchorScoreByChunkId.get(id) || 0
            }];
        }));
        const rank = (scoreMap, limit, scoreField) =>
            [...enrichedById.values()]
                .filter(item => (scoreMap.get(item.id) || 0) > 0)
                .sort((left, right) =>
                    (scoreMap.get(right.id) || 0)
                    - (scoreMap.get(left.id) || 0)
                )
                .slice(0, limit)
                .map(item => ({
                    ...item,
                    score: item[scoreField]
                }));
        const candidateConfig = snapshot.bundle.effectiveConfig
            ?.candidateSuperset || {};
        const sourceCandidates = {
            query_knn: rank(
                queryScoreById,
                Number(candidateConfig.queryK) || 100,
                'queryScore'
            ),
            denoised_field_knn: rank(
                denoisedScoreById,
                Number(candidateConfig.denoisedK)
                    || Number(candidateConfig.queryK)
                    || 100,
                'denoisedFieldScore'
            ),
            local_field_knn: rank(
                localScoreById,
                Number(candidateConfig.localFieldK) || 100,
                'localFieldScore'
            ),
            transfer_field_knn: rank(
                transferScoreById,
                Number(candidateConfig.transferFieldK) || 100,
                'transferFieldScore'
            ),
            bm25: rank(
                bm25ScoreById,
                Number(candidateConfig.bm25K) || 50,
                'bm25Score'
            ),
            anchor_direct: rank(
                anchorScoreByChunkId,
                Number(candidateConfig.anchorK) || 50,
                'anchorScore'
            )
        };
        timing.candidateAssemblyMs = performance.now() - candidateAssemblyStartedAt;

        const superset = measureSync(
            'candidateSupersetMs',
            () => this.vectorDBManager
                .buildTagMemoV10CandidateSuperset(sourceCandidates, {
                    artifact: snapshot.bundle
                })
        );
        const projected = measureSync(
            'curveProjectionMs',
            () => this.vectorDBManager
                .projectTagMemoV10CandidateCurves(superset.candidates)
        );
        const pathBatch = measureSync(
            'pathGeometryMs',
            () => this.vectorDBManager
                .evaluateTagMemoV10CandidateCurves(
                    projected.curves,
                    queryState,
                    { artifact: snapshot.bundle }
                )
        );
        const allowedFileIdSet = new Set(allowedFileIds);
        const dstcBatch = measureSync(
            'dstcMs',
            () => this.vectorDBManager.computeTagMemoV10Dstc(
                pathBatch,
                queryState,
                {
                    artifact: snapshot.bundle,
                    disabledObservables,
                    identityEligibility: curve =>
                        Boolean(maid && String(curve.diaryName || '').includes(maid)),
                    visibilityEligibility: curve =>
                        allowedFileIdSet.has(Number(curve.fileId))
                }
            )
        );
        const armOptions = {
            artifact: snapshot.bundle,
            disabledObservables,
            queryState,
            queryText: query
        };
        const armRun = measureSync(
            'experimentArmsMs',
            () => arm === 'all'
                ? this.vectorDBManager.runTagMemoV10ExperimentArms(
                    dstcBatch,
                    armOptions
                )
                : {
                    schema: 'tagmemo-v10-alpha-experiment-arms-v1',
                    candidateCount: dstcBatch.results.length,
                    arms: {
                        [arm]: this.vectorDBManager.scoreTagMemoV10ExperimentArm(
                            dstcBatch,
                            arm,
                            armOptions
                        )
                    }
                }
        );

        if (abRequested) {
            const baselineStartedAt = performance.now();
            const v9Snapshot = this.vectorDBManager.getTagMemoArtifactSnapshot('v9', {
                strictVersion: true
            });
            if (!v9Snapshot?.bundle) {
                throw new Error('统一 A/B 无法执行：V9 Production ArtifactBundle 不可用。');
            }

            const tagBoost = Math.max(0, Math.min(1, this._parseNumber(
                typeof args.tag_boost === 'string'
                    ? args.tag_boost.replace(/\+$/, '')
                    : args.tag_boost,
                0.6
            )));
            const coreTags = this._parseStringArray(args.core_tags || args.coreTags);
            const coreBoostFactor = this._parseNumber(args.core_boost_factor, 1.33);
            const v9Boost = this.vectorDBManager.applyTagBoost(
                new Float32Array(queryVector),
                tagBoost,
                coreTags,
                coreBoostFactor,
                {
                    tagMemoVersion: 'v9',
                    strictVersion: true,
                    artifactBundle: v9Snapshot.bundle
                }
            );
            const v9VectorRanked = (await this._scoreByVectorSimilarity(
                candidates,
                v9Boost.vector
            )).map(item => ({
                ...item,
                id: Number(item.label),
                score: Number(item.vectorScore) || 0
            })).sort((left, right) => right.score - left.score);
            const v9Ranked = v9Boost.energyField
                ? this.vectorDBManager.geodesicRerank(v9VectorRanked, {
                    artifactBundle: v9Snapshot.bundle,
                    tagMemoVersion: 'v9',
                    energyField: v9Boost.energyField,
                    energyFieldProvenance: v9Boost.energyFieldProvenance,
                    originalQueryVector: queryVector,
                    enhancedQueryVector: v9Boost.vector,
                    queryGeometryState: {
                        epa: v9Boost.info?.epa || null,
                        pyramid: v9Boost.info?.pyramid || null
                    }
                })
                : v9VectorRanked;
            timing.v9ProductionMs = performance.now() - baselineStartedAt;

            const knnRanked = queryRanked.map(item => ({
                ...item,
                id: Number(item.label),
                score: Number(item.vectorScore) || 0
            })).sort((left, right) => right.score - left.score);
            const normalizedDenoisedRanked = denoisedRanked.map(item => ({
                ...item,
                id: Number(item.label),
                score: Number(item.vectorScore) || 0
            })).sort((left, right) => right.score - left.score);
            const normalizedLocalRanked = localRanked.map(item => ({
                ...item,
                id: Number(item.label),
                score: Number(item.vectorScore) || 0
            })).sort((left, right) => right.score - left.score);
            const normalizedTransferRanked = transferRanked.map(item => ({
                ...item,
                id: Number(item.label),
                score: Number(item.vectorScore) || 0
            })).sort((left, right) => right.score - left.score);

            const mapDiagnostics = this._buildTagMemoMapDiagnostics({
                k,
                rawKnn: knnRanked,
                v9PrivateKnn: v9VectorRanked,
                v10Denoised: normalizedDenoisedRanked,
                v10Local: normalizedLocalRanked,
                v10Transfer: normalizedTransferRanked
            });

            const orthogonalStartedAt = performance.now();
            const orthogonalMaps = {
                raw: {
                    label: 'Raw KNN Map',
                    ranked: knnRanked.slice(0, mapExperimentK)
                },
                v9Private: {
                    label: 'V9 Private KNN Map',
                    ranked: v9VectorRanked.slice(0, mapExperimentK)
                },
                v10Denoised: {
                    label: 'V10 Denoised Spike Map',
                    ranked: normalizedDenoisedRanked.slice(
                        0,
                        mapExperimentK
                    )
                },
                v10Local: {
                    label: 'V10 Local Map',
                    ranked: normalizedLocalRanked.slice(0, mapExperimentK)
                },
                v10Transfer: {
                    label: 'V10 Transfer Map',
                    ranked: normalizedTransferRanked.slice(0, mapExperimentK)
                }
            };
            const orthogonalCandidateById = new Map();
            for (const map of Object.values(orthogonalMaps)) {
                for (const item of map.ranked) {
                    const id = Number(item.id ?? item.label);
                    const candidate = enrichedById.get(id);
                    if (!candidate || orthogonalCandidateById.has(id)) continue;
                    orthogonalCandidateById.set(id, {
                        ...candidate,
                        id,
                        chunkId: id,
                        score: Number(item.score ?? item.vectorScore) || 0,
                        candidateSources: [{
                            source: 'orthogonal_map_union',
                            rank: 0,
                            rawScore: Number(item.score ?? item.vectorScore) || 0,
                            normalizedScore: 0
                        }]
                    });
                }
            }
            const orthogonalProjected = this.vectorDBManager
                .projectTagMemoV10CandidateCurves(
                    [...orthogonalCandidateById.values()]
                );
            const orthogonalPathBatch = this.vectorDBManager
                .evaluateTagMemoV10CandidateCurves(
                    orthogonalProjected.curves,
                    queryState,
                    { artifact: snapshot.bundle }
                );
            const orthogonalDstcBatch = this.vectorDBManager.computeTagMemoV10Dstc(
                orthogonalPathBatch,
                queryState,
                {
                    artifact: snapshot.bundle,
                    disabledObservables,
                    identityEligibility: curve =>
                        Boolean(maid && String(curve.diaryName || '').includes(maid)),
                    visibilityEligibility: curve =>
                        allowedFileIdSet.has(Number(curve.fileId))
                }
            );
            const orthogonalDstcById = new Map(
                orthogonalDstcBatch.results.map(item => [
                    Number(item.curve?.chunkId ?? item.curve?.id),
                    item
                ])
            );
            const orthogonalRuns = {};
            const runV9Kernel = ranked => {
                const input = ranked.map(item => ({
                    ...item,
                    id: Number(item.id ?? item.label),
                    score: Number(item.score ?? item.vectorScore) || 0
                }));
                return v9Boost.energyField
                    ? this.vectorDBManager.geodesicRerank(input, {
                        artifactBundle: v9Snapshot.bundle,
                        tagMemoVersion: 'v9',
                        energyField: v9Boost.energyField,
                        energyFieldProvenance: v9Boost.energyFieldProvenance,
                        originalQueryVector: queryVector,
                        enhancedQueryVector: v9Boost.vector,
                        queryGeometryState: {
                            epa: v9Boost.info?.epa || null,
                            pyramid: v9Boost.info?.pyramid || null
                        }
                    })
                    : input;
            };
            for (const [mapName, map] of Object.entries(orthogonalMaps)) {
                const mapIds = new Set(map.ranked.map(item =>
                    Number(item.id ?? item.label)
                ));
                const mapDstcBatch = {
                    schema: orthogonalDstcBatch.schema,
                    results: orthogonalDstcBatch.results.filter(item =>
                        mapIds.has(Number(item.curve?.chunkId ?? item.curve?.id))
                    )
                };
                const v10Kernel = this.vectorDBManager
                    .scoreTagMemoV10ExperimentArm(
                        mapDstcBatch,
                        'pure',
                        armOptions
                    );
                const v9Kernel = runV9Kernel(map.ranked);
                const sourceRankById = new Map(map.ranked.map((item, index) => [
                    Number(item.id ?? item.label),
                    index + 1
                ]));
                const v9RankById = new Map(v9Kernel.map((item, index) => [
                    Number(item.id ?? item.label),
                    index + 1
                ]));
                const v10RankById = new Map(v10Kernel.results.map((item, index) => [
                    Number(item.curve?.chunkId ?? item.curve?.id),
                    index + 1
                ]));
                orthogonalRuns[mapName] = {
                    label: map.label,
                    offered: map.ranked.length,
                    evaluatedByV10: mapDstcBatch.results.length,
                    missingFromProjection: [...mapIds].filter(id =>
                        !orthogonalDstcById.has(id)
                    ),
                    source: map.ranked,
                    v9Kernel,
                    v10Kernel: v10Kernel.results,
                    rankMovements: map.ranked.map(item => {
                        const id = Number(item.id ?? item.label);
                        const sourceRank = sourceRankById.get(id);
                        const v9Rank = v9RankById.get(id) ?? null;
                        const v10Rank = v10RankById.get(id) ?? null;
                        return {
                            id,
                            sourceRank,
                            v9Rank,
                            v10Rank,
                            v9Delta: v9Rank === null
                                ? null
                                : sourceRank - v9Rank,
                            v10Delta: v10Rank === null
                                ? null
                                : sourceRank - v10Rank
                        };
                    })
                };
            }
            timing.orthogonalMapKernelMs =
                performance.now() - orthogonalStartedAt;
            // Pure 与 Topology 的绝对分不处于同一物理标尺，使用完整同池
            // 排名做 Reciprocal Rank Fusion。并列保留 1:1 与 Pure 优先的
            // 2:1 两条评审轨；它们不修改任一 V10 实验臂的内核分数。
            const pureTopologyRrfK = 60;
            const pureResults = armRun.arms.pure.results;
            const topologyResults = armRun.arms.topology.results;
            const topologyV2Results = armRun.arms.topology_v2.results;
            const topologyV3Results = armRun.arms.topology_v3.results;
            const topologyRankById = new Map(
                topologyResults.map((item, index) => [
                    Number(item.curve?.chunkId ?? item.curve?.id),
                    index + 1
                ])
            );
            const buildPureTopologyRrf = (armName, rawWeights) => {
                const weightTotal =
                    Number(rawWeights.pure) + Number(rawWeights.topology);
                if (!Number.isFinite(weightTotal) || weightTotal <= 0) {
                    throw new Error(`无效的 Pure × Topology RRF 权重：${armName}`);
                }
                const weights = Object.freeze({
                    pure: Number(rawWeights.pure) / weightTotal,
                    topology: Number(rawWeights.topology) / weightTotal
                });
                return pureResults
                    .map((item, index) => {
                        const id = Number(
                            item.curve?.chunkId ?? item.curve?.id
                        );
                        const pureRank = index + 1;
                        const topologyRank = topologyRankById.get(id);
                        const pureContribution = weights.pure
                            / (pureTopologyRrfK + pureRank);
                        const topologyContribution =
                            Number.isFinite(topologyRank)
                                ? weights.topology
                                    / (pureTopologyRrfK + topologyRank)
                                : 0;
                        const fusionScore =
                            pureContribution + topologyContribution;
                        return {
                            ...item,
                            armResult: Object.freeze({
                                ...item.armResult,
                                arm: armName,
                                score: fusionScore,
                                baseScore: fusionScore,
                                fusion: Object.freeze({
                                    mode: 'rrf',
                                    k: pureTopologyRrfK,
                                    weights,
                                    pureRank,
                                    topologyRank:
                                        Number.isFinite(topologyRank)
                                            ? topologyRank
                                            : null,
                                    pureContribution,
                                    topologyContribution
                                })
                            })
                        };
                    })
                    .sort((left, right) =>
                        (right.armResult.score - left.armResult.score)
                        || (
                            left.armResult.fusion.pureRank
                            - right.armResult.fusion.pureRank
                        )
                    );
            };
            const pureTopologyRrfEqualResults = buildPureTopologyRrf(
                'pure_topology_rrf_1_1',
                { pure: 1, topology: 1 }
            );
            const pureTopologyRrfPureFirstResults = buildPureTopologyRrf(
                'pure_topology_rrf_2_1',
                { pure: 2, topology: 1 }
            );
            const tracks = {
                knn: { label: 'KNN', results: knnRanked },
                v9: {
                    label: `V9 Production (${v9Snapshot.bundle.algorithmVersion || 'v9'})`,
                    results: v9Ranked
                },
                pure: {
                    label: 'V10 Unified-Pure',
                    results: pureResults
                },
                topology: {
                    label: 'V10-Topology',
                    results: topologyResults
                },
                topologyV2: {
                    label: 'V10-Topology V2 Unified',
                    results: topologyV2Results
                },
                topologyV3: {
                    label: 'V10-Topology V3 Unified',
                    results: topologyV3Results,
                    diagnostics: armRun.arms.topology_v3.diagnostics
                },
                pureTopologyRrfEqual: {
                    label: 'V10 Pure × Topology RRF 1:1',
                    results: pureTopologyRrfEqualResults,
                    fusion: {
                        mode: 'rrf',
                        k: pureTopologyRrfK,
                        weights: { pure: 0.5, topology: 0.5 }
                    }
                },
                pureTopologyRrfPureFirst: {
                    label: 'V10 Pure × Topology RRF 2:1',
                    results: pureTopologyRrfPureFirstResults,
                    fusion: {
                        mode: 'rrf',
                        k: pureTopologyRrfK,
                        weights: { pure: 2 / 3, topology: 1 / 3 }
                    }
                },
                gated: {
                    label: 'V10 Unified-Gated',
                    results: armRun.arms.gated.results
                },
                observed: {
                    label: 'V10 Unified-Observed',
                    results: armRun.arms.observed.results
                }
            };

            let rerankTrack = null;
            if (compareRerank) {
                const rerankPool = [];
                const seen = new Set();
                const appendTrack = items => {
                    for (const item of items.slice(0, Math.max(k * 3, 20))) {
                        const id = Number(
                            item.id ?? item.label ?? item.curve?.chunkId
                        );
                        if (!Number.isFinite(id) || seen.has(id)) continue;
                        const candidate = enrichedById.get(id);
                        if (!candidate?.text) continue;
                        seen.add(id);
                        rerankPool.push({
                            ...candidate,
                            id,
                            retrieval_rank: rerankPool.length + 1
                        });
                    }
                };
                appendTrack(knnRanked);
                appendTrack(v9Ranked);
                appendTrack(armRun.arms.pure.results);
                appendTrack(armRun.arms.topology.results);
                appendTrack(armRun.arms.topology_v2.results);
                appendTrack(armRun.arms.topology_v3.results);
                appendTrack(pureTopologyRrfEqualResults);
                appendTrack(pureTopologyRrfPureFirstResults);
                appendTrack(armRun.arms.gated.results);
                appendTrack(armRun.arms.observed.results);

                const rerankStartedAt = performance.now();
                const reranked = await this._rerankDocuments(
                    query,
                    rerankPool,
                    Math.min(k, rerankPool.length)
                );
                timing.rerankMs = performance.now() - rerankStartedAt;
                rerankTrack = {
                    label: 'Rerank',
                    configured: Boolean(
                        this.rerankConfig.url
                        && this.rerankConfig.apiKey
                        && this.rerankConfig.model
                    ),
                    results: reranked.map(item => ({
                        ...item,
                        id: Number(item.id ?? item.label),
                        score: Number(item.rerank_score) || 0
                    }))
                };
                tracks.rerank = rerankTrack;
            }

            timing.totalBeforeMarkdownMs = performance.now() - requestStartedAt;
            const markdown = this._formatTagMemoUnifiedABMarkdown({
                query,
                k,
                tracks,
                artifact: snapshot.bundle,
                v9Artifact: v9Snapshot.bundle,
                queryState,
                disabledObservables,
                candidateDiagnostics: superset.diagnostics,
                mapDiagnostics,
                orthogonalRuns,
                mapExperimentK,
                timing,
                compareRerank,
                rerankTrack,
                includeDetails
            });
            return this._buildAiFriendlyTextResult(markdown);
        }

        const serializeArm = run => ({
            arm: run.arm,
            diagnostics: run.diagnostics,
            top: run.results.slice(0, k).map((item, index) => ({
                rank: index + 1,
                chunkId: item.curve.chunkId,
                diaryName: item.curve.diaryName,
                path: item.curve.path,
                text: item.curve.text,
                score: item.armResult.score,
                baseScore: item.armResult.baseScore,
                gateMultiplier: item.armResult.gateMultiplier,
                observedBonus: item.armResult.observedBonus,
                marginalContributions:
                    item.armResult.marginalContributions,
                rejected: item.armResult.rejected,
                rejectionReasons: item.armResult.rejectionReasons,
                candidateSources: item.curve.candidateSources,
                denoisedFieldScore: item.curve.denoisedFieldScore,
                topologyScoreMode: item.armResult.topologyScoreMode,
                topologyDualReadout: item.armResult.topologyDualReadout,
                topologyV2: item.armResult.topologyV2,
                topologyV3: item.armResult.topologyV3,
                relativeTopology: item.relativeTopology,
                geometry: item.geometry,
                dstc: item.observables
            }))
        });
        const reportAssemblyStartedAt = performance.now();
        const report = {
            schema: 'tagmemo-v10-alpha-lightmemo-result-v1',
            version: 'v10_alpha',
            algorithmVersion: 'v10.alpha.1',
            query,
            requestedArm: arm,
            disabledObservables,
            artifact: {
                artifactSig: snapshot.bundle.artifactSig,
                configHash: snapshot.bundle.configHash,
                databaseGeneration: snapshot.bundle.databaseGeneration,
                provenanceGeneration: snapshot.bundle.provenanceGeneration,
                graphGeneration: snapshot.bundle.graphGeneration
            },
            queryTrace: {
                queryId: queryState.queryId,
                artifactSig: queryState.artifactSig,
                scopeHash: queryState.scopeHash,
                sourceObservation: queryState.sourceObservation,
                queryRiverGraph: queryState.queryRiverGraph,
                solver: queryState.solver,
                fieldDiagnostics: queryState.fieldDiagnostics,
                localDomain: queryState.localDomain,
                transferDomain: queryState.transferDomain
            },
            candidateDiagnostics: superset.diagnostics,
            curveDiagnostics: projected.diagnostics,
            pathDiagnostics: pathBatch.diagnostics,
            timing,
            arms: Object.fromEntries(
                Object.entries(armRun.arms).map(([name, run]) => [
                    name,
                    serializeArm(run)
                ])
            )
        };
        timing.reportAssemblyMs = performance.now() - reportAssemblyStartedAt;

        // 先执行一次与最终结构等价的序列化以测量 JSON 成本，再把测量值写入最终输出。
        const serializationStartedAt = performance.now();
        const serializationProbe = JSON.stringify(report);
        timing.serializationMs = performance.now() - serializationStartedAt;
        timing.serializedBytes = Buffer.byteLength(serializationProbe, 'utf8');
        timing.totalBeforeFinalSerializationMs = performance.now() - requestStartedAt;

        const roundedTiming = {};
        for (const [name, value] of Object.entries(timing)) {
            roundedTiming[name] = name === 'serializedBytes'
                ? value
                : Number(value.toFixed(3));
        }
        report.timing = roundedTiming;
        const finalPayload = JSON.stringify(report);

        console.log(
            `[LightMemo][TagMemo-V10 Timing] total=${roundedTiming.totalBeforeFinalSerializationMs}ms, ` +
            `artifact=${roundedTiming.artifactSnapshotMs}ms, ` +
            `prepare+solve=${roundedTiming.prepareAndSolveQueryMs}ms, ` +
            `vectors=${Number((
                roundedTiming.queryVectorScoreMs
                + roundedTiming.denoisedVectorScoreMs
                + roundedTiming.localVectorScoreMs
                + roundedTiming.transferVectorScoreMs
            ).toFixed(3))}ms, ` +
            `curve=${roundedTiming.curveProjectionMs}ms, ` +
            `geometry=${roundedTiming.pathGeometryMs}ms, ` +
            `dstc=${roundedTiming.dstcMs}ms, ` +
            `arms=${roundedTiming.experimentArmsMs}ms, ` +
            `json=${roundedTiming.serializationMs}ms/${roundedTiming.serializedBytes}B`
        );

        return this._buildAiFriendlyTextResult(finalPayload);
    }

    /**
     * TagMemo V9.1 单轨寻址对照。
     * 模式 A：固定对称候选超集比较 KNN / V9.1向量增强 / V9.1+测地线 / 独立 Rerank。
     * 模式 B：同时比较三路端到端 Top-K，并可加入独立 Rerank。
     * 测地线对照在每次 A/B 中固定执行，不再由 potential_field 参数二选一。
     */
    async handleTagMemoAB(args = {}) {
        if (!this.vectorDBManager || typeof this.vectorDBManager.applyTagBoost !== 'function') {
            throw new Error('TagMemo V9.1 对照无法执行：KnowledgeBaseManager 未注入或版本接口不可用。');
        }

        const query = String(args.query || args.start || '').trim();
        if (!query) throw new Error('TagMemo V9.1 对照需要 query 参数。');

        const parsedMaidScope = this._parseMaidScopedFolder(args.maid);
        const maid = parsedMaidScope.maid;
        const folder = this._mergeFolderScopes(args.folder, parsedMaidScope.folder);
        const searchAll = this._parseBoolean(args.search_all_knowledge_bases, false);
        if (!searchAll && !maid && !folder) {
            throw new Error('TagMemo V9.1 对照必须提供 maid/folder，或开启 search_all_knowledge_bases。');
        }

        const rawMode = String(args.ab_mode || args.abMode || args.mode || 'A').trim().toLowerCase();
        const abMode = ['b', 'mode_b', 'product', 'end_to_end'].includes(rawMode) ? 'B' : 'A';
        const k = Math.max(1, Math.floor(this._parseNumber(args.k, 5)));
        const topL = Math.max(k, Math.floor(this._parseNumber(args.top_l ?? args.topL, Math.max(20, k * 4))));
        const tagBoost = Math.max(0, Math.min(1, this._parseNumber(
            typeof args.tag_boost === 'string' ? args.tag_boost.replace(/\+$/, '') : args.tag_boost,
            0.6
        )));
        const coreTags = this._parseStringArray(args.core_tags || args.coreTags);
        const coreBoostFactor = this._parseNumber(args.core_boost_factor, 1.33);
        const useBM25 = this._parseBooleanAlias(
            [['BM25', args.BM25], ['bm25', args.bm25], ['use_bm25', args.use_bm25]],
            true,
            'TagMemo V9.1 comparison BM25'
        );
        const compareRerank = this._parseBooleanAlias(
            [
                ['compare_rerank', args.compare_rerank],
                ['compareRerank', args.compareRerank],
                ['rerank_compare', args.rerank_compare]
            ],
            false,
            'TagMemo V9.1 Rerank comparison'
        );
        const includeDetails = this._parseABIncludeDetails(args);

        const candidates = await this._gatherCandidateChunks({
            maid,
            folder,
            searchAll,
            ignoreExcludedFolders: false,
            timeRange: null
        });
        if (candidates.length === 0) {
            return this._buildAiFriendlyTextResult('TagMemo V9.1 对照：指定作用域内没有可用记忆。');
        }

        const queryVector = await this.getSingleEmbedding(query);
        if (!queryVector) throw new Error('TagMemo V9.1 对照查询向量化失败。');

        const snapshot = this.vectorDBManager.getTagMemoArtifactSnapshot('v9', {
            strictVersion: true
        });
        if (!snapshot?.bundle) {
            throw new Error('TagMemo V9.1 对照无法执行：V9.1 ArtifactBundle 不可用。');
        }

        const knnRanked = (await this._scoreByVectorSimilarity(candidates, queryVector))
            .map(item => ({
                ...item,
                id: item.label,
                score: item.vectorScore || 0
            }))
            .sort((a, b) => b.score - a.score);

        const boost = this.vectorDBManager.applyTagBoost(
            new Float32Array(queryVector),
            tagBoost,
            coreTags,
            coreBoostFactor,
            {
                tagMemoVersion: 'v9',
                strictVersion: true,
                artifactBundle: snapshot.bundle
            }
        );
        const v91VectorRanked = (await this._scoreByVectorSimilarity(candidates, boost.vector))
            .map(item => ({
                ...item,
                id: item.label,
                score: item.vectorScore || 0
            }))
            .sort((a, b) => b.score - a.score);

        // A/B 固定双跑：同一增强向量、同一查询能量场、同一候选全集。
        // vectorRanked 是“不开测地线”的 V9.1 基线；geodesicRanked 是唯一实验变量。
        const geodesicRanked = boost.energyField
            ? this.vectorDBManager.geodesicRerank(v91VectorRanked, {
                artifactBundle: snapshot.bundle,
                tagMemoVersion: 'v9',
                energyField: boost.energyField,
                energyFieldProvenance: boost.energyFieldProvenance,
                originalQueryVector: queryVector,
                enhancedQueryVector: boost.vector,
                queryGeometryState: {
                    epa: boost.info?.epa || null,
                    pyramid: boost.info?.pyramid || null
                }
            })
            : v91VectorRanked;

        const runs = {
            knn: {
                ranked: knnRanked,
                top: knnRanked.slice(0, abMode === 'A' ? topL : k)
            },
            v9: {
                snapshot,
                boost,
                vectorRanked: v91VectorRanked,
                ranked: v91VectorRanked,
                top: v91VectorRanked.slice(0, abMode === 'A' ? topL : k)
            },
            geodesic: {
                ranked: geodesicRanked,
                top: geodesicRanked.slice(0, abMode === 'A' ? topL : k)
            }
        };

        const rerankRun = compareRerank
            ? await this._buildTagMemoABRerankRun({
                query,
                candidates,
                runs,
                abMode,
                topL,
                k,
                useBM25
            })
            : null;

        if (abMode === 'A') {
            return this._buildAiFriendlyTextResult(this._formatTagMemoKernelAB({
                query,
                candidates,
                runs,
                topL,
                k,
                tagBoost,
                useBM25,
                rerankRun,
                includeDetails
            }));
        }

        return this._buildAiFriendlyTextResult(this._formatTagMemoProductAB({
            query,
            runs,
            k,
            tagBoost,
            rerankRun,
            includeDetails
        }));
    }

    _buildTagMemoMapDiagnostics({
        k,
        rawKnn,
        v9PrivateKnn,
        v10Denoised,
        v10Local,
        v10Transfer
    }) {
        const normalizedK = Math.max(1, Math.floor(Number(k) || 1));
        const itemId = item => Number(item?.id ?? item?.label ?? item?.chunkId);
        const buildMap = (name, label, items) => {
            const ranked = (Array.isArray(items) ? items : [])
                .map((item, index) => ({
                    id: itemId(item),
                    rank: index + 1,
                    score: Number(item?.score ?? item?.vectorScore) || 0
                }))
                .filter(item => Number.isFinite(item.id))
                .slice(0, normalizedK);
            return {
                name,
                label,
                ranked,
                ids: new Set(ranked.map(item => item.id))
            };
        };
        const maps = {
            raw: buildMap('raw', 'Raw KNN Map', rawKnn),
            v9Private: buildMap(
                'v9Private',
                'V9 Private KNN Map',
                v9PrivateKnn
            ),
            v10Denoised: buildMap(
                'v10Denoised',
                'V10 Denoised Spike Map',
                v10Denoised
            ),
            v10Local: buildMap('v10Local', 'V10 Local Map', v10Local),
            v10Transfer: buildMap(
                'v10Transfer',
                'V10 Transfer Map',
                v10Transfer
            )
        };
        const pair = (leftName, rightName) => {
            const left = maps[leftName];
            const right = maps[rightName];
            const intersectionIds = [...left.ids].filter(id => right.ids.has(id));
            const unionIds = new Set([...left.ids, ...right.ids]);
            const leftOnlyIds = [...left.ids].filter(id => !right.ids.has(id));
            const rightOnlyIds = [...right.ids].filter(id => !left.ids.has(id));
            return {
                left: leftName,
                right: rightName,
                intersection: intersectionIds.length,
                union: unionIds.size,
                jaccard: unionIds.size > 0
                    ? intersectionIds.length / unionIds.size
                    : 0,
                leftOnly: leftOnlyIds.length,
                rightOnly: rightOnlyIds.length,
                leftOnlyIds,
                rightOnlyIds
            };
        };

        return {
            k: normalizedK,
            maps: Object.fromEntries(
                Object.entries(maps).map(([name, map]) => [
                    name,
                    {
                        name: map.name,
                        label: map.label,
                        ranked: map.ranked
                    }
                ])
            ),
            pairs: [
                pair('raw', 'v9Private'),
                pair('raw', 'v10Denoised'),
                pair('v9Private', 'v10Denoised'),
                pair('v10Denoised', 'v10Local'),
                pair('v10Local', 'v10Transfer'),
                pair('raw', 'v10Local'),
                pair('raw', 'v10Transfer')
            ]
        };
    }

    _formatTagMemoUnifiedABMarkdown({
        query,
        k,
        tracks,
        artifact,
        v9Artifact,
        queryState,
        disabledObservables,
        candidateDiagnostics,
        mapDiagnostics,
        orthogonalRuns,
        mapExperimentK,
        timing,
        compareRerank,
        rerankTrack,
        includeDetails = false
    }) {
        const fmt = (value, digits = 4) => Number.isFinite(Number(value))
            ? Number(value).toFixed(digits)
            : '—';
        const itemId = item => Number(
            item?.id ?? item?.label ?? item?.curve?.chunkId
        );
        const itemScore = item => Number(
            item?.armResult?.score ?? item?.score ?? item?.vectorScore
        ) || 0;
        const itemText = item => String(
            item?.curve?.text ?? item?.text ?? ''
        ).trim();
        const itemDiary = item => String(
            item?.curve?.diaryName ?? item?.dbName ?? ''
        ).trim();
        const itemPath = item => String(
            item?.curve?.path ?? item?.sourceFile ?? ''
        ).trim();
        const topByTrack = Object.fromEntries(
            Object.entries(tracks).map(([name, track]) => [
                name,
                (track.results || []).slice(0, k)
            ])
        );
        const rankMaps = Object.fromEntries(
            Object.entries(topByTrack).map(([name, items]) => [
                name,
                new Map(items.map((item, index) => [
                    itemId(item),
                    { rank: index + 1, score: itemScore(item) }
                ]))
            ])
        );
        const trackOrder = [
            'knn',
            'v9',
            'pure',
            'topology',
            'topologyV2',
            'topologyV3',
            'pureTopologyRrfEqual',
            'pureTopologyRrfPureFirst',
            'gated',
            'observed'
        ];
        if (tracks.rerank) trackOrder.push('rerank');
        const trackLabel = name => tracks[name]?.label || name;
        const allIds = [];
        const seenIds = new Set();
        const canonicalById = new Map();
        for (const name of trackOrder) {
            for (const item of topByTrack[name] || []) {
                const id = itemId(item);
                if (!canonicalById.has(id)) canonicalById.set(id, item);
                if (!Number.isFinite(id) || seenIds.has(id)) continue;
                seenIds.add(id);
                allIds.push(id);
            }
        }

        const pureIds = new Set((topByTrack.pure || []).map(itemId));
        const overlapWithPure = name => {
            const ids = new Set((topByTrack[name] || []).map(itemId));
            return [...ids].filter(id => pureIds.has(id)).length;
        };

        let md = '# TagMemo 统一寻址 A/B 评审文档\n\n';
        md += '> 本报告使用具名轨道，供人类或隔离 AI 打分员直接评估。  \n';
        md += `> 查询：**${this._escapeMarkdownCell(query)}**  \n`;
        md += `> Top-K：${k}  \n`;
        md += `> 生成时间：${new Date().toISOString()}  \n\n`;

        md += '## 1. 实验身份与公平条件\n\n';
        md += '- **KNN**：原始查询向量余弦排序。\n';
        md += `- **V9 Production**：当前生产 Artifact 与生产测地重排；实际算法版本 \`${v9Artifact.algorithmVersion || 'v9'}\`。\n`;
        md += '- **V10 Unified-Pure / Gated / Observed / V10-Topology / Topology V2 / Topology V3**：共享同一 V10 Artifact、Query State、EPA/Pyramid/Spike 降噪源、双尺度场、候选超集和候选曲线。\n';
        md += '- **V10-Topology**：第一主读出是降噪 Spike 修正向量与 Chunk 的相似度；第二主读出比较查询临时有向河网与候选原生有序 Tag 构型，并按图可靠度动态竞争解释权。旧相对增量公式仅由 `legacy_relative_bonus` 回放。\n';
        md += '- **V10-Topology V2 Unified**：以 Pure 连续场得分为内部坐标，按 atomic/propositional/narrative 查询模式估计动态结构置信度；Graph 只奖励其相对同等 Pure 强度候选的正向条件创新，不可观测或低于条件期望时不处罚 Pure。\n';
        md += '- **V10-Topology V3 Unified**：以 Pure 连续场为底座；河网可观测性 Ω 门控 V2 条件创新奖励；零边极限 Direct Anchor 保护稀有多种子精确接触候选，并在低 Ω 工况下降级无充分传播依据的结构角色。\n';
        md += '- **V10 Pure × Topology RRF 1:1**：在完整同池排名上按 `0.5/(60+PureRank) + 0.5/(60+TopologyRank)` 融合，作为两路同权对照。\n';
        md += '- **V10 Pure × Topology RRF 2:1**：按 `(2/3)/(60+PureRank) + (1/3)/(60+TopologyRank)` 融合，优先保护 Pure 识别的直接答案与高价值前因链，同时保留 Topology 的结构召回。两条 RRF 均不混合异标度绝对分，也不修改底层内核。\n';
        md += `- **Rerank**：${compareRerank
            ? (rerankTrack?.configured
                ? '已启用独立外部精排。'
                : '已请求但服务未配置，轨道为明确标记的降级输出。')
            : '未请求。'}\n`;
        md += `- V10 Artifact：\`${artifact.artifactSig}\`\n`;
        md += `- V9 Artifact：\`${v9Artifact.artifactSig}\`\n`;
        md += `- Query ID：\`${queryState.queryId}\`\n`;
        md += `- V10 查询源：\`${queryState.sourceObservation?.sourceMode || 'unknown'}\`；V9 观测资产：\`${queryState.sourceObservation?.v9ArtifactSig || '—'}\`\n`;
        const sourceDiagnostics = queryState.sourceObservation?.diagnostics || {};
        const riverDiagnostics = queryState.queryRiverGraph?.diagnostics || {};
        const topologyV3Results = tracks.topologyV3?.results || [];
        const topologyV3Observation =
            topologyV3Results[0]?.armResult?.topologyV3 || {};
        const anchorBatchDiagnostics =
            tracks.topologyV3?.diagnostics?.anchorBatchDiagnostics || {};
        const anchorRankedItems = topologyV3Results
            .slice()
            .sort((left, right) =>
                (
                    Number(right?.armResult?.topologyV3?.anchorStrength)
                    || 0
                ) - (
                    Number(left?.armResult?.topologyV3?.anchorStrength)
                    || 0
                )
            );
        const strongestAnchorItem = anchorRankedItems[0] || null;
        const secondAnchorItem = anchorRankedItems[1] || null;
        const strongestAnchorStrength = Number(
            strongestAnchorItem?.armResult?.topologyV3?.anchorStrength
        ) || 0;
        const secondAnchorStrength = Number(
            secondAnchorItem?.armResult?.topologyV3?.anchorStrength
        ) || 0;
        const anchorFrontierPromotions = topologyV3Results.filter(item =>
            item?.armResult?.topologyV3?.roleReclassificationReason
                === 'strong-direct-anchor-contrast'
        ).length;
        const anchorAwardedCount = Number(
            tracks.topologyV3?.diagnostics?.anchorAwardedCount
        ) || 0;
        md += `- 降噪观测：完整=${sourceDiagnostics.completeObservation === true ? '是' : '否'}；向量已变化=${sourceDiagnostics.vectorChanged === true ? '是' : '否'}；ΔL2=${fmt(sourceDiagnostics.vectorDeltaL2, 8)}；源↔增强余弦=${fmt(sourceDiagnostics.sourceEnhancedCosine, 8)}；源节点=${sourceDiagnostics.normalizedSourceNodes ?? sourceDiagnostics.sourceNodes ?? '—'}；EPA深度=${queryState.sourceObservation?.epa?.logicDepth ?? '—'}；Pyramid层数=${queryState.sourceObservation?.pyramid?.levels?.length ?? queryState.sourceObservation?.pyramid?.depth ?? '—'}${sourceDiagnostics.fallbackReason ? `；退化原因=${sourceDiagnostics.fallbackReason}` : ''}\n`;
        md += `- Spike 临时河网：节点=${riverDiagnostics.reachedNodes ?? queryState.queryRiverGraph?.nodes?.length ?? 0}；边=${riverDiagnostics.activeEdges ?? queryState.queryRiverGraph?.edges?.length ?? 0}；种子=${riverDiagnostics.seedNodes ?? '—'}；Ω=${fmt(topologyV3Observation.omega)}（边=${fmt(topologyV3Observation.omegaEdge)}/涌现=${fmt(topologyV3Observation.omegaEmerge)}/流熵=${fmt(topologyV3Observation.omegaFlow)}，工况=${topologyV3Observation.regime || '—'}）\n`;
        md += `- Direct Anchor 观测：锚种子=${anchorBatchDiagnostics.anchorSeedCount ?? '—'}；质量归一=${tracks.topologyV3?.diagnostics?.anchorMassNormalization || anchorBatchDiagnostics.massNormalization || '—'}；最强候选=${strongestAnchorItem ? `#${itemId(strongestAnchorItem)} / ${fmt(strongestAnchorStrength)}` : '—'}；次强候选=${secondAnchorItem ? `#${itemId(secondAnchorItem)} / ${fmt(secondAnchorStrength)}` : '—'}；池内μ=${fmt(tracks.topologyV3?.diagnostics?.anchorBatchMean)}；池内σ=${fmt(tracks.topologyV3?.diagnostics?.anchorBatchStdDev)}；激活门槛=${fmt(tracks.topologyV3?.diagnostics?.anchorActivationThreshold)}；获奖候选=${anchorAwardedCount}；前沿升格=${anchorFrontierPromotions}\n`;
        md += `- D/S/T/C 消融：${disabledObservables.length > 0
            ? disabledObservables.map(value => `\`${value}\``).join(', ')
            : '无'}\n\n`;

        md += '## 2. 私有地图位移诊断\n\n';
        md += '> 本节只比较候选生成坐标，不混入最终排序内核。V10 Denoised Spike Map 是 EPA/Pyramid/Spike 完整降噪后形成的第一主读出地图；Local/Transfer 是在同一降噪源上经权限条件化双尺度场回投影形成的地图。\n\n';
        md += '| 地图对 | 交集 | 并集 | Jaccard | 左侧独占 | 右侧独占 |\n';
        md += '|---|---:|---:|---:|---:|---:|\n';
        for (const pair of mapDiagnostics?.pairs || []) {
            const left = mapDiagnostics.maps[pair.left]?.label || pair.left;
            const right = mapDiagnostics.maps[pair.right]?.label || pair.right;
            md += `| ${left} ↔ ${right} | ${pair.intersection} | ${pair.union} | ${fmt(pair.jaccard)} | ${pair.leftOnly} | ${pair.rightOnly} |\n`;
        }
        md += '\n### 地图 Top-K 明细\n\n';
        for (const map of Object.values(mapDiagnostics?.maps || {})) {
            md += `- **${map.label}**：${map.ranked.map(item =>
                `${item.rank}.#${item.id}(${fmt(item.score)})`
            ).join('；') || '无'}\n`;
        }

        md += `\n## 3. 地图 × 排序内核正交交换（Map-K=${mapExperimentK}）\n\n`;
        md += '> 每行固定候选地图，只交换 V9 Production Kernel 与 V10 Unified-Pure Kernel。V10 对五张地图的并集仅做一次曲线投影与观测计算，不重复求场。\n\n';
        md += '| 候选地图 | 地图候选数 | V10可评估 | V9 Kernel Top-K | V10 Kernel Top-K | 内核Top-K重合 | Jaccard |\n';
        md += '|---|---:|---:|---|---|---:|---:|\n';
        for (const run of Object.values(orthogonalRuns || {})) {
            const v9Top = (run.v9Kernel || []).slice(0, k);
            const v10Top = (run.v10Kernel || []).slice(0, k);
            const v9Ids = new Set(v9Top.map(itemId));
            const v10Ids = new Set(v10Top.map(itemId));
            const intersection = [...v9Ids].filter(id => v10Ids.has(id)).length;
            const union = new Set([...v9Ids, ...v10Ids]).size;
            const topList = items => items.map((item, index) =>
                `${index + 1}.#${itemId(item)}(${fmt(itemScore(item))})`
            ).join('；') || '无';
            md += `| ${run.label} | ${run.offered} | ${run.evaluatedByV10} | ${topList(v9Top)} | ${topList(v10Top)} | ${intersection} | ${fmt(union > 0 ? intersection / union : 0)} |\n`;
            if (run.missingFromProjection?.length > 0) {
                md += `\n- ${run.label} 未能进入 V10 曲线投影的 Chunk：${run.missingFromProjection.map(id => `#${id}`).join('、')}\n`;
            }
        }

        md += '\n### 固定地图内核排名跨越\n\n';
        md += '> 正 ΔRank 表示内核把候选向前提升；负值表示向后移动。该表只展示每张地图经 V10 Pure 后的 Top-K。\n\n';
        for (const run of Object.values(orthogonalRuns || {})) {
            const movementById = new Map(
                (run.rankMovements || []).map(item => [item.id, item])
            );
            md += `#### ${run.label}\n\n`;
            md += '| Chunk | 地图原排名 | V9 Kernel 排名/Δ | V10 Kernel 排名/Δ | Query | Local | Transfer | Path | Occupancy | 语义底座 | 拓扑原量 | 可靠度 | 拓扑增益 |\n';
            md += '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
            for (const item of (run.v10Kernel || []).slice(0, k)) {
                const id = itemId(item);
                const movement = movementById.get(id) || {};
                const components = item.armResult?.components || {};
                const rankDelta = (rank, delta) => rank == null
                    ? '—'
                    : `#${rank} / ${delta > 0 ? '+' : ''}${delta}`;
                md += `| ${id} | #${movement.sourceRank ?? '—'} | ${rankDelta(movement.v9Rank, movement.v9Delta)} | ${rankDelta(movement.v10Rank, movement.v10Delta)} | ${fmt(components.query)} | ${fmt(components.local)} | ${fmt(components.transfer)} | ${fmt(components.path)} | ${fmt(components.occupancy)} | ${fmt(item.armResult?.semanticBase)} | ${fmt(item.armResult?.topologyRaw)} | ${fmt(item.armResult?.topologyReliability)} | ${fmt(item.armResult?.topologyBonus)} |\n`;
            }
            md += '\n';
        }

        md += '## 4. 产品 Top-K 重合与区间推动\n\n';
        for (const name of trackOrder.filter(name => name !== 'pure')) {
            md += `- ${trackLabel(name)} ↔ V10 Unified-Pure：${overlapWithPure(name)}/${k}\n`;
        }
        const droppedByUnionCap = Array.isArray(candidateDiagnostics?.droppedByUnionCap)
            ? candidateDiagnostics.droppedByUnionCap.length
            : Number(candidateDiagnostics?.droppedByUnionCap) || 0;
        md += `- 候选超集：提供 ${candidateDiagnostics?.offeredUnique ?? '—'} 个唯一候选，` +
            `保留 ${candidateDiagnostics?.selectedUnique ?? '—'} 个，` +
            `并集上限淘汰 ${droppedByUnionCap} 个，` +
            `多来源入选 ${candidateDiagnostics?.multiSourceSelected ?? '—'} 个。\n\n`;

        const fullKnnRank = new Map(
            (tracks.knn?.results || []).map((item, index) => [
                itemId(item),
                index + 1
            ])
        );
        md += '### V10 Pure Top-K 相对 Raw KNN 的跨越\n\n';
        md += '| V10排名 | Chunk | Raw KNN排名 | ΔRank | 候选来源 | Query | Local | Transfer | Path | Occupancy | 语义底座 | 拓扑原量 | 可靠度 | 拓扑增益 |\n';
        md += '|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
        (topByTrack.pure || []).forEach((item, index) => {
            const id = itemId(item);
            const rawRank = fullKnnRank.get(id) ?? null;
            const pureRank = index + 1;
            const delta = rawRank === null ? null : rawRank - pureRank;
            const sources = Array.isArray(item.curve?.candidateSources)
                ? item.curve.candidateSources
                    .map(source => source.source || String(source))
                    .join('+')
                : '—';
            const components = item.armResult?.components || {};
            md += `| ${pureRank} | ${id} | ${rawRank === null ? '—' : rawRank} | ${delta === null ? '新候选' : `${delta > 0 ? '+' : ''}${delta}`} | ${sources || '—'} | ${fmt(components.query)} | ${fmt(components.local)} | ${fmt(components.transfer)} | ${fmt(components.path)} | ${fmt(components.occupancy)} | ${fmt(item.armResult?.semanticBase)} | ${fmt(item.armResult?.topologyRaw)} | ${fmt(item.armResult?.topologyReliability)} | ${fmt(item.armResult?.topologyBonus)} |\n`;
        });
        md += '\n';

        md += '## 5. 统一排名总表\n\n';
        md += `| Chunk | 记忆摘要 | ${trackOrder.map(trackLabel).join(' | ')} |\n`;
        md += `|---:|---|${trackOrder.map(() => '---:').join('|')}|\n`;
        for (const id of allIds) {
            const summary = this._escapeMarkdownCell(
                this._shortMemoryText(itemText(canonicalById.get(id)), 100)
            );
            const cells = trackOrder.map(name => {
                const ranked = rankMaps[name]?.get(id);
                return ranked ? `#${ranked.rank} / ${fmt(ranked.score)}` : '—';
            });
            md += `| ${id} | ${summary} | ${cells.join(' | ')} |\n`;
        }

        if (!includeDetails) {
            md += '\n> 后续完整候选正文、诊断、性能计时与评审区已默认省略；显式传入 `include_details: true` 可返回。\n';
            return md;
        }

        md += '\n## 6. 各具名轨道完整候选\n\n';
        for (const name of trackOrder) {
            md += `### ${trackLabel(name)}\n\n`;
            const items = topByTrack[name] || [];
            if (items.length === 0) {
                md += '无可用结果。\n\n';
                continue;
            }
            items.forEach((item, index) => {
                md += `#### ${index + 1}. Chunk ${itemId(item)} · 分数 ${fmt(itemScore(item), 6)}\n\n`;
                md += `- 日记本：${this._escapeMarkdownCell(itemDiary(item) || '—')}\n`;
                md += `- 路径：${this._escapeMarkdownCell(itemPath(item) || '—')}\n`;
                if (item.armResult) {
                    const values = item.observables?.values || {};
                    const components = item.armResult.components || {};
                    const sources = Array.isArray(item.curve?.candidateSources)
                        ? item.curve.candidateSources
                            .map(source => source.source || String(source))
                            .join('+')
                        : '';
                    md += `- 候选来源：${sources || '—'}\n`;
                    md += `- V10 基础分：${fmt(item.armResult.baseScore, 6)}；门控倍率：${fmt(item.armResult.gateMultiplier)}；Observed 增益：${fmt(item.armResult.observedBonus, 6)}\n`;
                    if (item.armResult.fusion) {
                        const fusion = item.armResult.fusion;
                        md += `- Pure × Topology RRF：权重=${fmt(fusion.weights?.pure, 4)}:${fmt(fusion.weights?.topology, 4)}；Pure=#${fusion.pureRank ?? '—'} / ${fmt(fusion.pureContribution, 8)}；Topology=#${fusion.topologyRank ?? '—'} / ${fmt(fusion.topologyContribution, 8)}；k=${fusion.k}；融合分=${fmt(item.armResult.score, 8)}\n`;
                    }
                    md += `- 六分量 Q/D/L/X/G/O：${fmt(components.query)}/${fmt(item.curve?.denoisedFieldScore)}/${fmt(components.local)}/${fmt(components.transfer)}/${fmt(components.path)}/${fmt(components.occupancy)}\n`;
                    md += `- 权限校准：模式=${item.armResult.pureScoreMode || '—'}；语义底座=${fmt(item.armResult.semanticBase)}；拓扑原量=${fmt(item.armResult.topologyRaw)}；可靠度=${fmt(item.armResult.topologyReliability)}；拓扑增益=${fmt(item.armResult.topologyBonus)}≤${fmt(item.armResult.topologyBonusCap)}\n`;
                    if (item.armResult.topologyDualReadout) {
                        const dual = item.armResult.topologyDualReadout;
                        md += `- Topology 双主读出：模式=${item.armResult.topologyScoreMode || '—'}；Field=${fmt(dual.fieldScore)}；Graph=${fmt(dual.graphScore)}；可靠度模式=${dual.graphReliabilityMode || '—'}；图可靠度=${fmt(dual.graphReliability)}（边=${fmt(dual.graphEdgeReliability)}/节点退化=${fmt(dual.graphNodeOnlyReliability)}≤${fmt(dual.graphNodeOnlyReliabilityCap)}）；图权重=${fmt(dual.graphWeight)}；合成=${fmt(dual.dualReadoutScore)}\n`;
                        md += `- 相对河网：节点覆盖=${fmt(dual.matchedNodeCoverage)}；边覆盖=${fmt(dual.matchedEdgeCoverage)}；节点对齐=${fmt(dual.nodeAlignmentScore)}；节点图分=${fmt(dual.nodeGraphScore)}；完整边图分=${fmt(dual.edgeGraphScore)}；相对距离=${fmt(dual.relativeDistanceScore)}；方向=${fmt(dual.directionScore)}；边拓扑=${fmt(dual.edgeTopologyScore)}；Motif=${fmt(dual.motifScore)}；正文闭合=${fmt(dual.meanClosure)}\n`;
                        const strongestEdges = Array.isArray(item.relativeTopology?.edgeAlignments)
                            ? item.relativeTopology.edgeAlignments.slice(0, 3)
                            : [];
                        if (strongestEdges.length > 0) {
                            md += `- 最强河道对应：${strongestEdges.map(edge =>
                                `${edge.sourceId}→${edge.targetId} ≈ ${edge.candidateSourceId}→${edge.candidateTargetId}` +
                                `(距${fmt(edge.distanceSimilarity, 3)}/向${fmt(edge.directionSimilarity, 3)}/独立${fmt(edge.independentFraction, 3)}/质${fmt(edge.edgeQuality, 3)})`
                            ).join('；')}\n`;
                        } else {
                            md += `- 最强河道对应：无（${dual.reason || '未形成可信边对应'}）\n`;
                        }
                    }
                    if (item.armResult.topologyV2) {
                        const v2 = item.armResult.topologyV2;
                        const profile = v2.queryProfile || {};
                        md += `- Topology V2.1 大统一：查询模式=${v2.queryMode}；知识角色=${v2.role || '—'}；查询置信=${fmt(v2.queryConfidence)}；候选置信=${fmt(v2.candidateConfidence)}；统计可靠=${fmt(v2.statisticalReliability)}；联合置信=${fmt(v2.combinedConfidence)}；Pure=${fmt(v2.pureScore)}；Graph=${fmt(v2.graphScore)}（节点=${fmt(v2.graphNodeScore)}/边=${fmt(v2.graphEdgeScore)}）；最终=${fmt(v2.finalScore)}；负向处罚=关闭\n`;
                        md += `- V2.1 保守创新：条件期望=${fmt(v2.conditionalExpectedGraph)}；标准差=${fmt(v2.conditionalStdDev)}；预测不确定度=${fmt(v2.conditionalPredictionUncertainty)}；原创新=${fmt(v2.graphInnovationRaw)}；下置信界创新=${fmt(v2.graphInnovationLowerBound)}→正向${fmt(v2.graphInnovationPositive)}；z=${fmt(v2.innovationConfidenceZ)}；有效样本=${fmt(v2.conditionalEffectivePeerCount)}；条件邻居=${v2.conditionalPeerCount}\n`;
                        md += `- V2.1 角色权限：Direct证据=${fmt(v2.directEvidence)}；结构证据=${fmt(v2.structuralEvidence)}；角色倍率=${fmt(v2.roleMultiplier)}；请求奖励=${fmt(v2.requestedBonus)}；角色限幅后=${fmt(v2.confidenceLimitedBonus)}≤${fmt(v2.roleBonusCap)}；直接答案前沿=${fmt(v2.directFrontierScore)}；前沿预算=${v2.frontierBonusBudget === null ? '无限' : fmt(v2.frontierBonusBudget)}；前沿限幅=${v2.frontierLimited ? '是' : '否'}；最终奖励=${fmt(v2.bonus)}\n`;
                        md += `- V2 查询动态置信：模式适配=${fmt(profile.structuralAdequacy)}；场相干=${fmt(profile.fieldCoherence)}（能量集中=${fmt(profile.energyConcentration)}/EPA逻辑=${fmt(profile.epaLogicDepth)}/金字塔相干=${fmt(profile.pyramidCoherence)}）；当前知识域可观测=${fmt(profile.domainObservability)}；综合适配=${fmt(profile.dynamicAdequacy)}；观测头部K=${profile.observabilityHeadK ?? '—'}\n`;
                        md += `- V2 候选置信归因：闭合=${fmt(v2.closure)}；节点覆盖=${fmt(v2.nodeCoverage)}；边覆盖=${fmt(v2.edgeCoverage)}；节点对齐=${fmt(v2.nodeAlignment)}；边可靠=${fmt(v2.edgeReliability)}；核带宽(Pure/Closure/Direct)=${fmt(v2.conditionalBandwidth)}/${fmt(v2.conditionalClosureBandwidth)}/${fmt(v2.conditionalDirectBandwidth)}\n`;
                    }
                    if (item.armResult.topologyV3) {
                        const v3 = item.armResult.topologyV3;
                        md += `- Topology V3 工况门控：Ω=${fmt(v3.omega)}（边=${fmt(v3.omegaEdge)}/涌现=${fmt(v3.omegaEmerge)}/流熵=${fmt(v3.omegaFlow)}，${v3.regime || '—'}）；γ=${fmt(v3.omegaGamma)}；V2奖励=${fmt(v3.v2Bonus)}×${fmt(v3.graphGate)}→${fmt(v3.gatedV2Bonus)}\n`;
                        md += `- V3 Direct Anchor：聚合=${v3.anchorMassNormalization || '—'}；锚分=${fmt(v3.anchorScore)}×可靠=${fmt(v3.anchorReliability)}→强度=${fmt(v3.anchorStrength)}；激活=${fmt(v3.anchorActivation)}；奖励=${fmt(v3.anchorBonus)}≤${fmt(v3.anchorBonusCap)}；接触种子=${v3.contactedSeeds}（精确=${v3.exactContacts}/语义=${v3.semanticContacts}）；闭合=${fmt(v3.meanClosure)}\n`;
                        md += `- V3 Anchor 批内对比：μ=${fmt(v3.anchorBatchMean)}；σ=${fmt(v3.anchorBatchStdDev)}；θ=${fmt(v3.anchorActivationThreshold)}（floor=${fmt(v3.anchorActivationFloor)}/z=${fmt(v3.anchorActivationZ)}/sat=${fmt(v3.anchorSaturation)}）；最强=${fmt(v3.strongestAnchorStrength)}；次强=${fmt(v3.secondAnchorStrength)}；前沿判据=${fmt(v3.anchorFrontierContrast)}×且≥${fmt(v3.anchorFrontierAbsFloor)}；升格=${v3.anchorFrontierPromoted ? '是' : '否'}；获奖=${v3.anchorAwardedCount}\n`;
                        md += `- V3 角色与前沿：${v3.originalRole || '—'}→${v3.role || '—'}${v3.roleReclassified ? `（${v3.roleReclassificationReason || '已改判'}）` : '（未改判）'}；直接前沿=${fmt(v3.directFrontierScore)}；来源=${v3.frontierSource || '—'}；最终=${fmt(v3.finalScore)}\n`;
                    }
                    if (item.armResult.topologyRelativeGeometry) {
                        const relative = item.armResult.topologyRelativeGeometry;
                        md += `- 三层相对几何：Q=${fmt(relative.queryBase)}；ΔL=${fmt(relative.localGain)}×${fmt(relative.localReliability)}→${fmt(relative.localGainAward)}；ΔX=${fmt(relative.transferGain)}×${fmt(relative.transferReliability)}→${fmt(relative.transferGainAward)}；ΔB=${fmt(relative.boundaryGain)}×${fmt(relative.boundaryReliability)}→${fmt(relative.boundaryGainAward)}；Path→${fmt(relative.pathGainAward)}；总几何增益=${fmt(relative.totalGeometryGain)}\n`;
                        if (relative.strongestBoundary) {
                            const boundary = relative.strongestBoundary;
                            md += `- 一跳边界路径：Tag=${this._escapeMarkdownCell(boundary.tagName || boundary.tagId || '—')}；Q→Tag=${fmt(boundary.queryTagScore)}；Tag→Chunk=${fmt(boundary.tagChunkScore)}；B=${fmt(boundary.boundaryPathQuality)}；命中=${relative.boundaryHits}；饱和=${fmt(relative.boundarySaturation)}\n`;
                        } else {
                            md += '- 一跳边界路径：无可信边界接触\n';
                        }
                    }
                    md += `- D/S/T/C：${fmt(values.direct)}/${fmt(values.structural)}/${fmt(values.thematic)}/${fmt(values.closure)}\n`;
                    md += `- 路径质量：${fmt(item.geometry?.pathQuality)}；拒判：${item.armResult.rejected ? '是' : '否'}${item.armResult.rejectionReasons?.length
                        ? `（${item.armResult.rejectionReasons.join(', ')}）`
                        : ''}\n`;
                } else if (name === 'v9') {
                    md += `- V9 曲线分：${fmt(item.geo_score)}；奖励：${fmt(item.geo_bonus)}；证据级别：${item.geo_evidence_class || '—'}\n`;
                }
                md += `\n${itemText(item) || '（空正文）'}\n\n`;
            });
        }

        md += '## 7. 性能计时\n\n';
        md += '| 阶段 | 耗时 ms |\n|---|---:|\n';
        for (const [name, value] of Object.entries(timing)) {
            if (name.endsWith('Ms')) md += `| ${name} | ${fmt(value, 3)} |\n`;
        }

        md += '\n## 8. 评审员裁决区\n\n';
        md += '请独立评价每条轨道，不要只依据算法内部评分。\n\n';
        md += '| 轨道 | 相关性(1-5) | 前因/链条完整性(1-5) | 有价值惊喜(1-5) | 漂移风险(1-5，低为好) | 身份/权限正确 | 总体名次 |\n';
        md += '|---|---:|---:|---:|---:|---|---:|\n';
        for (const name of trackOrder) {
            md += `| ${trackLabel(name)} |  |  |  |  |  |  |\n`;
        }
        md += '\n### 最终裁决\n\n';
        md += '- 最佳轨道：\n';
        md += '- 最差轨道：\n';
        md += '- V10 独占有效召回：\n';
        md += '- 漂亮但错误的联想：\n';
        md += '- 权限或身份问题：\n';
        md += '- 评审理由：\n';

        return md;
    }

    async _buildTagMemoABRerankRun({ query, candidates, runs, abMode, topL, k, useBM25 }) {
        const configured = Boolean(
            this.rerankConfig.url &&
            this.rerankConfig.apiKey &&
            this.rerankConfig.model
        );
        if (!configured) {
            console.warn('[LightMemo] TagMemo V9.1 Rerank comparison requested, but Rerank is not configured.');
            return {
                requested: true,
                available: false,
                error: 'Rerank 未配置（需要 RerankUrl、RerankApi、RerankModel）',
                ranked: []
            };
        }

        const poolById = new Map();
        const candidateById = new Map(
            candidates.map(candidate => [Number(candidate.label), candidate])
        );
        const addToPool = (items, limit = items.length) => {
            items.slice(0, limit).forEach((item, index) => {
                const id = Number(item.id ?? item.label);
                if (!Number.isFinite(id)) return;
                const canonical = candidateById.get(id) || {};
                const existing = poolById.get(id);
                const retrievalRank = index + 1;
                if (!existing || retrievalRank < existing.retrieval_rank) {
                    poolById.set(id, {
                        ...canonical,
                        ...(existing || {}),
                        ...item,
                        id,
                        label: item.label ?? canonical.label ?? id,
                        text: String(item.text ?? existing?.text ?? canonical.text ?? '').trim(),
                        retrieval_rank: retrievalRank
                    });
                }
            });
        };

        if (abMode === 'A') {
            addToPool(runs.knn.ranked, topL);
            addToPool(runs.v9.ranked, topL);
            addToPool(runs.geodesic.ranked, topL);
            if (useBM25) addToPool(this._buildBm25TopIds(query, candidates, topL), topL);
        } else {
            addToPool(runs.knn.top, k);
            addToPool(runs.v9.top, k);
            addToPool(runs.geodesic.top, k);
        }

        const pool = [...poolById.values()].filter(item => item.text);
        const droppedCount = poolById.size - pool.length;
        if (droppedCount > 0) {
            console.warn(`[LightMemo] TagMemo V9.1 comparison: dropped ${droppedCount} Rerank candidates without text.`);
        }
        if (pool.length === 0) {
            return {
                requested: true,
                available: false,
                error: '没有可供 Rerank 横向比较的候选',
                ranked: []
            };
        }

        console.log(`[LightMemo] TagMemo V9.1 comparison: reranking ${pool.length} symmetric candidates.`);
        const outputLimit = abMode === 'A' ? pool.length : Math.min(k, pool.length);
        const reranked = await this._rerankDocuments(query, pool, outputLimit);
        const failedCount = reranked.filter(item => item.rerank_failed).length;
        const ranked = reranked.map(item => ({
            ...item,
            id: item.id ?? item.label,
            score: Number(item.rerank_score) || 0
        }));

        return {
            requested: true,
            available: failedCount < reranked.length,
            partialFailure: failedCount > 0 && failedCount < reranked.length,
            error: failedCount === reranked.length ? 'Rerank API 调用全部失败，未生成有效对比' : null,
            candidateCount: pool.length,
            ranked
        };
    }

    _buildBm25TopIds(query, candidates, limit) {
        const queryTokens = this._tokenize(query);
        const expanded = this._expandQueryTokens(queryTokens);
        const allQueryTokens = [...new Set([...queryTokens, ...expanded])];
        const ranker = new BM25Ranker();
        const allDocs = candidates.map(candidate => candidate.tokens || []);
        if (allDocs.length === 0) return [];
        const idf = ranker.calculateIDF(allDocs);
        const avgLength = allDocs.reduce((sum, doc) => sum + doc.length, 0) / allDocs.length || 1;
        return candidates
            .map(candidate => ({
                id: candidate.label,
                score: ranker.score(allQueryTokens, candidate.tokens || [], avgLength, idf)
            }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    _rankMap(items) {
        return new Map(items.map((item, index) => [
            Number(item.id ?? item.label),
            { rank: index + 1, score: Number(item.score ?? item.vectorScore) || 0, item }
        ]));
    }

    _shortMemoryText(text, maxLength = 84) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
    }

    _formatGeometryShadow(item) {
        const shadow = item?.geo_geometry_shadow;
        if (!shadow || typeof shadow !== 'object') return '';
        const fmt = value => Number(value || 0).toFixed(3);
        const weights = shadow.queryWeights || {};
        const direction = Number(shadow.directionConsistency || 0);
        const lift = Number(shadow.vectorLift || 0);
        const guarded = shadow.nodeFieldGuarded === true ? ' 节点场守卫' : '';
        return `D/S/T/C4/F=${fmt(shadow.directScore)}/${fmt(shadow.structuralScore)}/` +
            `${fmt(shadow.thematicScore)}/${fmt(shadow.closureScore)}/${fmt(shadow.fusedScore)}` +
            ` W=${fmt(weights.direct)}/${fmt(weights.structural)}/${fmt(weights.thematic)}` +
            ` Dir=${fmt(direction)} Lift=${lift >= 0 ? '+' : ''}${lift.toFixed(4)}${guarded}`;
    }

    _formatGeometryAuxiliary(item) {
        if (!item || item.geo_aux_enabled !== true) return '辅助=关闭';
        const fmt = value => Number(value || 0).toFixed(4);
        const reliability = Number(item.geo_aux_reliability || 0).toFixed(3);
        const identity = Number(item.geo_identity_anchor_strength || 0).toFixed(3);
        const identityMark = item.geo_identity_anchor_eligible === true ? '✓' : '×';
        return `主轨=${fmt(item.geo_base_bonus)} 辅助=${fmt(item.geo_aux_bonus)} ` +
            `地板=${fmt(item.geo_aux_target_floor)}(几何${fmt(item.geo_aux_geometry_floor)}` +
            `/身份${fmt(item.geo_aux_identity_floor)}) 可靠=${reliability} ` +
            `身份锚=${identityMark}${identity} 原因=${item.geo_aux_reason || 'unknown'}`;
    }

    _formatTagMemoKernelAB({
        query,
        candidates,
        runs,
        topL,
        k,
        tagBoost,
        useBM25,
        rerankRun,
        includeDetails = false
    }) {
        const bm25Top = useBM25 ? this._buildBm25TopIds(query, candidates, topL) : [];
        const sources = new Map();
        const add = (items, source) => items.slice(0, topL).forEach(item => {
            const id = Number(item.id ?? item.label);
            if (!sources.has(id)) sources.set(id, new Set());
            sources.get(id).add(source);
        });
        add(runs.knn.ranked, 'KNN');
        add(runs.v9.ranked, 'V9.1');
        add(runs.geodesic.ranked, '测地线');
        add(bm25Top, 'BM25');

        const knnMap = this._rankMap(runs.knn.ranked);
        const v91Map = this._rankMap(runs.v9.ranked);
        const geoMap = this._rankMap(runs.geodesic.ranked);
        const rerankMap = rerankRun?.available ? this._rankMap(rerankRun.ranked) : new Map();
        const byId = new Map(candidates.map(item => [Number(item.label), item]));
        const ids = [...sources.keys()].sort((a, b) => {
            const bestA = Math.min(knnMap.get(a)?.rank || Infinity, v91Map.get(a)?.rank || Infinity, geoMap.get(a)?.rank || Infinity);
            const bestB = Math.min(knnMap.get(b)?.rank || Infinity, v91Map.get(b)?.rank || Infinity, geoMap.get(b)?.rank || Infinity);
            return bestA - bestB;
        });

        const displayedIds = ids.slice(0, topL);
        let text = `\n[--- TagMemo V9.1 对照模式 A：固定对称候选超集 ---]\n`;
        text += `查询: ${query}\n参数: topL=${topL}, displayK=${k}, tag_boost=${tagBoost}, BM25=${useBM25}, compare_rerank=${Boolean(rerankRun)}\n`;
        text += `V9.1资产: ${runs.v9.snapshot.bundle.artifactSig}\n`;
        text += `固定实验变量: V9.1不开测地线 vs V9.1开启测地线（同一增强向量、能量场与候选全集）\n`;
        text += `对称超集: ${ids.length} 个唯一 chunk（KNN ∪ V9.1 ∪ 测地线${useBM25 ? ' ∪ BM25' : ''}），表格展示 ${displayedIds.length} 条\n`;
        if (rerankRun) {
            text += rerankRun.available
                ? `Rerank横向基线: ${rerankRun.candidateCount} 个对称候选${rerankRun.partialFailure ? '（部分批次失败）' : ''}\n\n`
                : `Rerank横向基线: 不可用（${rerankRun.error}）\n\n`;
        } else {
            text += '\n';
        }
        text += `| # | 候选记忆 | 进入路径 | KNN排名/分数 | V9.1无测地线 | V9.1+测地线 | ΔRank(测地线-无测地线) | 曲线分/置信度 |${rerankRun ? ' Rerank排名/分数 |' : ''}\n`;
        text += `|---:|---|---|---:|---:|---:|---:|---:|${rerankRun ? '---:|' : ''}\n`;
        displayedIds.forEach((id, index) => {
            const candidate = byId.get(id);
            const knn = knnMap.get(id);
            const v91 = v91Map.get(id);
            const geo = geoMap.get(id);
            const reranked = rerankMap.get(id);
            const delta = v91 && geo ? v91.rank - geo.rank : null;
            const fmt = value => value ? `${value.rank}/${value.score.toFixed(4)}` : '—';
            const geoItem = geo?.item;
            const contactTags = Array.isArray(geoItem?.geo_contact_tags)
                ? geoItem.geo_contact_tags.slice(0, 4).map(contact => {
                    const marker = contact.exact ? '=' : '~';
                    const source = contact.sourceType
                        ? `@${contact.sourceType}${Number.isFinite(contact.hop) ? `:${contact.hop}` : ''}`
                        : '';
                    return `${marker}${contact.name || contact.id}:${Number(contact.potential || 0).toFixed(2)}${source}`;
                }).join(', ')
                : '';
            const geometryShadow = this._formatGeometryShadow(geoItem);
            const geometryAuxiliary = this._formatGeometryAuxiliary(geoItem);
            const diagnostics = (geoItem && Number(geoItem.geo_score) > 0
                ? `${geoItem.geo_evidence_class || 'unknown'} ` +
                    `${Number(geoItem.geo_score).toFixed(4)}/${Number(geoItem.geo_confidence || 0).toFixed(3)} ` +
                    `+${Number(geoItem.geo_bonus || 0).toFixed(4)}≤${Number(geoItem.geo_bonus_cap || 0).toFixed(3)}` +
                    `${Number(geoItem.geo_direct_semantic_hits || 0) > 0
                        ? ` 直锚=${Number(geoItem.geo_direct_semantic_hits)}` +
                            `/强${Number(geoItem.geo_direct_semantic_strength || 0).toFixed(2)}` +
                            `/奖信${Number(geoItem.geo_reward_confidence || 0).toFixed(2)}`
                        : ''}` +
                    `${contactTags ? `<br>${this._escapeMarkdownCell(contactTags)}` : ''}`
                : `守卫/0${geoItem?.geo_guard_reason ? `<br>${this._escapeMarkdownCell(geoItem.geo_guard_reason)}` : ''}`) +
                `${geometryShadow ? `<br>${this._escapeMarkdownCell(geometryShadow)}` : ''}` +
                `${geometryAuxiliary ? `<br>${this._escapeMarkdownCell(geometryAuxiliary)}` : ''}`;
            text += `| ${index + 1} | ${this._escapeMarkdownCell(this._shortMemoryText(candidate?.text))} | ${[...sources.get(id)].join('+')} | ${fmt(knn)} | ${fmt(v91)} | ${fmt(geo)} | ${delta === null ? '—' : delta > 0 ? `+${delta}` : delta} | ${diagnostics} |${rerankRun ? ` ${fmt(reranked)} |` : ''}\n`;
        });
        if (!includeDetails) {
            text += `\n后续说明已默认省略；显式传入 include_details: true 可返回。\n`;
            return text;
        }
        text += `\n说明: 正 ΔRank 表示开启测地线后相对同一 V9.1 向量基线前移；诊断依次显示证据等级、曲线分/置信度、最终奖励≤等级上限。direct/structural/thematic 的排序权限逐级降低；@seed/@core/@emergent:n 表示接触场节点来源。D/S/T/C4/F 分别表示直接层、结构层、主题层、查询—候选闭合层和有界融合分；W 为查询动态权重，Dir 为候选顺序正向导通一致性，Lift 为增强查询相对原查询的余弦提升。辅助生产轨不替换主轨，只在节点场证据、类别证据、融合分与闭合度同时过门时补足保守奖励地板；几何地板与严格身份锚地板取最大值而不叠加。C4/Lift 不可独立发奖，节点场守卫候选保持无测地线分数。Rerank 只重排同一对称候选池。\n`;
        text += `[--- 模式 A 结束 ---]\n`;
        return text;
    }

    _formatTagMemoProductAB({
        query,
        runs,
        k,
        tagBoost,
        rerankRun,
        includeDetails = false
    }) {
        const knnTop = runs.knn.top;
        const v91Top = runs.v9.top;
        const geoTop = runs.geodesic.top;
        const knnIds = new Set(knnTop.map(item => Number(item.id ?? item.label)));
        const v91Ids = new Set(v91Top.map(item => Number(item.id ?? item.label)));
        const geoIds = new Set(geoTop.map(item => Number(item.id ?? item.label)));
        const geoOverlap = [...v91Ids].filter(id => geoIds.has(id));
        const vectorOnly = [...v91Ids].filter(id => !geoIds.has(id));
        const geoOnly = [...geoIds].filter(id => !v91Ids.has(id));
        const knnMap = this._rankMap(knnTop);
        const v91Map = this._rankMap(v91Top);
        const geoMap = this._rankMap(geoTop);
        const rerankMap = rerankRun?.available ? this._rankMap(rerankRun.ranked) : new Map();
        const rerankIds = new Set(rerankRun?.available ? rerankRun.ranked.map(item => Number(item.id ?? item.label)) : []);
        const rerankV91Overlap = [...rerankIds].filter(id => v91Ids.has(id)).length;
        const rerankGeoOverlap = [...rerankIds].filter(id => geoIds.has(id)).length;
        const items = new Map();
        [...knnTop, ...v91Top, ...geoTop, ...(rerankRun?.ranked || [])]
            .forEach(item => items.set(Number(item.id ?? item.label), item));
        const union = [...new Set([...knnIds, ...v91Ids, ...geoIds, ...rerankIds])];

        let text = `\n[--- TagMemo V9.1 对照模式 B：端到端寻址 ---]\n`;
        text += `查询: ${query}\n参数: k=${k}, tag_boost=${tagBoost}, geodesic_comparison=always, compare_rerank=${Boolean(rerankRun)}\n`;
        text += `V9.1资产: ${runs.v9.snapshot.bundle.artifactSig}\n`;
        text += `无测地线/测地线重合=${geoOverlap.length}/${k} (${(geoOverlap.length / k * 100).toFixed(1)}%) | 无测地线独占=${vectorOnly.length} | 测地线独占=${geoOnly.length}\n`;
        if (rerankRun) {
            text += rerankRun.available
                ? `Rerank Top-${rerankRun.ranked.length}: 与无测地线重合=${rerankV91Overlap} | 与测地线重合=${rerankGeoOverlap}${rerankRun.partialFailure ? ' | 部分批次失败' : ''}\n\n`
                : `Rerank横向基线: 不可用（${rerankRun.error}）\n\n`;
        } else {
            text += '\n';
        }
        text += `| 记忆片段 | KNN | V9.1无测地线 | V9.1+测地线 | 曲线分/置信度 |${rerankRun ? ' Rerank |' : ''} 归属 |\n`;
        text += `|---|---:|---:|---:|---:|${rerankRun ? '---:|' : ''}---|\n`;
        union.forEach(id => {
            const knnItem = knnMap.get(id);
            const v91Item = v91Map.get(id);
            const geoItem = geoMap.get(id);
            const reranked = rerankMap.get(id);
            const owners = [];
            if (knnItem) owners.push('KNN');
            if (v91Item) owners.push('V9.1');
            if (geoItem) owners.push('测地线');
            if (reranked) owners.push('Rerank');
            const fmt = value => value ? `${value.rank}/${value.score.toFixed(4)}` : '—';
            const geoData = geoItem?.item;
            const contactTags = Array.isArray(geoData?.geo_contact_tags)
                ? geoData.geo_contact_tags.slice(0, 4).map(contact => {
                    const marker = contact.exact ? '=' : '~';
                    const source = contact.sourceType
                        ? `@${contact.sourceType}${Number.isFinite(contact.hop) ? `:${contact.hop}` : ''}`
                        : '';
                    return `${marker}${contact.name || contact.id}:${Number(contact.potential || 0).toFixed(2)}${source}`;
                }).join(', ')
                : '';
            const geometryShadow = this._formatGeometryShadow(geoData);
            const geometryAuxiliary = this._formatGeometryAuxiliary(geoData);
            const diagnostics = (geoData && Number(geoData.geo_score) > 0
                ? `${geoData.geo_evidence_class || 'unknown'} ` +
                    `${Number(geoData.geo_score).toFixed(4)}/${Number(geoData.geo_confidence || 0).toFixed(3)} ` +
                    `+${Number(geoData.geo_bonus || 0).toFixed(4)}≤${Number(geoData.geo_bonus_cap || 0).toFixed(3)}` +
                    `${Number(geoData.geo_direct_semantic_hits || 0) > 0
                        ? ` 直锚=${Number(geoData.geo_direct_semantic_hits)}` +
                            `/强${Number(geoData.geo_direct_semantic_strength || 0).toFixed(2)}` +
                            `/奖信${Number(geoData.geo_reward_confidence || 0).toFixed(2)}`
                        : ''}` +
                    `${contactTags ? `<br>${this._escapeMarkdownCell(contactTags)}` : ''}`
                : `守卫/0${geoData?.geo_guard_reason ? `<br>${this._escapeMarkdownCell(geoData.geo_guard_reason)}` : ''}`) +
                `${geometryShadow ? `<br>${this._escapeMarkdownCell(geometryShadow)}` : ''}` +
                `${geometryAuxiliary ? `<br>${this._escapeMarkdownCell(geometryAuxiliary)}` : ''}`;
            text += `| ${this._escapeMarkdownCell(this._shortMemoryText(items.get(id)?.text, 100))} | ${fmt(knnItem)} | ${fmt(v91Item)} | ${fmt(geoItem)} | ${diagnostics} |${rerankRun ? ` ${fmt(reranked)} |` : ''} ${owners.join('+') || '—'} |\n`;
        });
        if (!includeDetails) {
            text += `\n后续说明已默认省略；显式传入 include_details: true 可返回。\n`;
            return text;
        }
        text += `\n测地线独占项用于判断曲线算法是否抵达无测地线 V9.1 未命中的有效记忆；无测地线独占项用于检查曲线重排的召回损失。两路始终共享同一增强向量、能量场和候选全集。D/S/T/C4/F、W、Dir、Lift 保留完整几何诊断；生产辅助只读取通过可靠度门控后的保守地板差额，C4/Lift 不独立发奖，节点场守卫保持零辅助。\n`;
        text += `[--- 模式 B 结束 ---]\n`;
        return text;
    }

    _getChunkVector(chunkId) {
        const db = this.vectorDBManager?.db;
        const dim = this.vectorDBManager?.config?.dimension;
        if (!db || !dim) return null;
        const row = db.prepare('SELECT vector FROM chunks WHERE id = ?').get(chunkId);
        if (!row?.vector || row.vector.length !== dim * 4) return null;
        if (row.vector.byteOffset % 4 === 0) {
            return new Float32Array(row.vector.buffer, row.vector.byteOffset, dim);
        }
        const copied = Buffer.from(row.vector);
        return new Float32Array(copied.buffer, copied.byteOffset, dim);
    }

    /**
     * 🧭 判断是否为开发测绘请求。
     * 支持 command/mode/action = map_distance/MapDistance/测绘，
     * 或显式 mapping/map_distance/map_develop 为真。
     */
    _isMappingRequest(args = {}) {
        const command = String(args.command || args.mode || args.action || '').trim().toLowerCase();
        if (['mapdistance', 'map_distance', 'mapping', 'tagmemo_map', 'wave_map', '测绘', '开发测绘'].includes(command)) {
            return true;
        }

        return this._parseBooleanAlias(
            [
                ['mapping', args.mapping],
                ['map_distance', args.map_distance],
                ['map_develop', args.map_develop]
            ],
            false,
            'mapping'
        );
    }

    /**
     * 🧭 LightMemo 开发测绘：比较起点 A 到一个或多个目标的三类距离。
     * - 纯 KNN 距离: 1 - cos(A, B)
     * - V9.1 TagMemo 距离: 1 - cos(TagBoost(A), TagBoost(B))
     * - V9.1 势能场加权距离: (1 - alpha) * 纯KNN + alpha * Tag 能量场距离
     */
    async handleMapping(args = {}) {
        const startText = args.start || args.origin || args.a || args.start_query || args.query;
        const targets = this._parseStringArray(args.targets || args.target || args.b || args.goal || args.goals);
        const rawTagBoost = args.tag_boost ?? 0.6;
        const tagBoost = this._parseNumber(typeof rawTagBoost === 'string' ? rawTagBoost.replace(/\+$/, '') : rawTagBoost, 0.6);
        const coreTags = this._parseStringArray(args.core_tags || args.coreTags);
        const coreBoostFactor = this._parseNumber(args.core_boost_factor, 1.33);
        const geoConfig = this.vectorDBManager?.ragParams?.KnowledgeBaseManager?.geodesicRerank || {};
        const alpha = Math.max(0, Math.min(1, this._parseNumber(args.geo_alpha ?? args.alpha, geoConfig.alpha ?? 0.35)));

        if (!startText || !String(startText).trim()) {
            throw new Error("测绘模式需要提供起点参数 start/origin/a/start_query/query。");
        }
        if (targets.length === 0) {
            throw new Error("测绘模式需要提供目标参数 targets/target/b/goal/goals，可用逗号、中文逗号、顿号或 | 分隔多个目标。");
        }
        if (!this.getBatchEmbeddings && !this.getSingleEmbedding) {
            throw new Error("测绘模式无法执行：Embedding 依赖未注入。");
        }

        const mappingTexts = [String(startText), ...targets];
        const mappingVectors = await this._getMappingEmbeddings(mappingTexts);
        const startVector = mappingVectors[0];
        if (!startVector) {
            throw new Error("起点 A 向量化失败。");
        }

        const startBoost = this._applyMappingTagBoost(startVector, tagBoost, coreTags, coreBoostFactor);
        const rows = [];

        for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
            const targetText = targets[targetIndex];
            const targetVector = mappingVectors[targetIndex + 1];
            if (!targetVector) {
                rows.push({
                    target: targetText,
                    error: '目标向量化失败'
                });
                continue;
            }

            const targetBoost = this._applyMappingTagBoost(targetVector, tagBoost, coreTags, coreBoostFactor);
            const pureKnnSim = this._cosineSimilarity(startVector, targetVector);
            const waveSim = this._cosineSimilarity(startBoost.vector, targetBoost.vector);
            const geoFieldSim = this._energyFieldSimilarity(startBoost.energyField, targetBoost.energyField);
            const weightedGeoSim = (1 - alpha) * pureKnnSim + alpha * geoFieldSim;

            rows.push({
                target: targetText,
                pureKnnSim,
                pureKnnDistance: 1 - pureKnnSim,
                waveSim,
                waveDistance: 1 - waveSim,
                geoFieldSim,
                weightedGeoSim,
                weightedGeoDistance: 1 - weightedGeoSim,
                startTags: startBoost.info?.matchedTags || [],
                targetTags: targetBoost.info?.matchedTags || []
            });
        }

        const reportText = this._formatMappingResults({
            startText: String(startText),
            rows,
            tagBoost,
            alpha,
            coreTags
        });

        return this._buildAiFriendlyTextResult(reportText);
    }

    async _getMappingEmbeddings(texts) {
        if (!Array.isArray(texts) || texts.length === 0) return [];
        const normalizedTexts = texts.map(text => String(text || '').trim());

        if (this.getBatchEmbeddings) {
            console.log(`[LightMemo] Mapping batch embedding: ${normalizedTexts.length} texts in one batched pipeline.`);
            const vectors = await this.getBatchEmbeddings(normalizedTexts);
            if (Array.isArray(vectors) && vectors.length === normalizedTexts.length) {
                return vectors;
            }
            console.warn(
                `[LightMemo] Mapping batch embedding returned invalid length ` +
                `(${Array.isArray(vectors) ? vectors.length : 'non-array'}), falling back to single embedding.`
            );
        }

        console.warn('[LightMemo] Mapping batch embedding unavailable. Falling back to sequential single embedding.');
        const vectors = [];
        for (const text of normalizedTexts) {
            vectors.push(text ? await this.getSingleEmbedding(text) : null);
        }
        return vectors;
    }

    _applyMappingTagBoost(vector, tagBoost, coreTags, coreBoostFactor) {
        const baseVector = vector instanceof Float32Array ? vector : new Float32Array(vector);
        if (tagBoost > 0 && this.vectorDBManager && typeof this.vectorDBManager.applyTagBoost === 'function') {
            const boostResult = this.vectorDBManager.applyTagBoost(
                new Float32Array(baseVector),
                tagBoost,
                coreTags,
                coreBoostFactor
            );

            if (boostResult && boostResult.vector) {
                return {
                    vector: boostResult.vector instanceof Float32Array ? boostResult.vector : new Float32Array(boostResult.vector),
                    info: boostResult.info || null,
                    energyField: boostResult.energyField || null,
                    energyFieldProvenance: boostResult.energyFieldProvenance || null,
                    artifactBundle: boostResult.artifactBundle || null
                };
            }
        }

        return {
            vector: baseVector,
            info: null,
            energyField: null,
            energyFieldProvenance: null,
            artifactBundle: null
        };
    }

    _energyFieldSimilarity(fieldA, fieldB) {
        if (!(fieldA instanceof Map) || !(fieldB instanceof Map) || fieldA.size === 0 || fieldB.size === 0) {
            return 0;
        }

        let dot = 0;
        let normA = 0;
        let normB = 0;

        for (const value of fieldA.values()) {
            const n = Number(value) || 0;
            normA += n * n;
        }
        for (const value of fieldB.values()) {
            const n = Number(value) || 0;
            normB += n * n;
        }
        if (normA <= 0 || normB <= 0) return 0;

        const [small, large] = fieldA.size <= fieldB.size ? [fieldA, fieldB] : [fieldB, fieldA];
        for (const [tagId, value] of small.entries()) {
            if (!large.has(tagId)) continue;
            dot += (Number(value) || 0) * (Number(large.get(tagId)) || 0);
        }

        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    _buildAiFriendlyTextResult(reportText) {
        // hybridservice/direct 插件会被 Plugin.js 解开 { status, result }。
        // 这里保持 result 为 { content: [...] }，让最终工具结果拥有 content 字段；
        // 不要让 result 直接等于数组，否则外层会把整个数组再次序列化进 text。
        return {
            status: 'success',
            result: {
                content: [
                    { type: 'text', text: reportText }
                ]
            }
        };
    }

    _formatMappingResults({ startText, rows, tagBoost, alpha, coreTags }) {
        const fmt = (value) => Number.isFinite(value) ? value.toFixed(4) : 'N/A';
        const fmtTags = (tags) => Array.isArray(tags) && tags.length > 0
            ? tags.slice(0, 5).join(', ')
            : '—';

        let content = `\n[--- LightMemo 开发测绘 / TagMemo Geodesic Map ---]\n`;
        content += `起点 A: ${startText}\n`;
        content += `参数: tag_boost=${tagBoost}, geodesic_alpha=${alpha}${coreTags.length > 0 ? `, core_tags=${coreTags.join(', ')}` : ''}\n\n`;
        content += `| # | 目标 | 纯KNN距离 | 纯KNN相似度 | V9.1 TagMemo距离 | V9.1 TagMemo相似度 | V9.1势能场加权距离 | V9.1势能场加权相似度 | Tag能量场相似度 | A命中Tag | 目标命中Tag |\n`;
        content += `|---:|---|---:|---:|---:|---:|---:|---:|---:|---|---|\n`;

        rows.forEach((row, index) => {
            if (row.error) {
                content += `| ${index + 1} | ${this._escapeMarkdownCell(row.target)} | N/A | N/A | N/A | N/A | N/A | N/A | N/A | ${row.error} | — |\n`;
                return;
            }

            content += `| ${index + 1} | ${this._escapeMarkdownCell(row.target)} | ${fmt(row.pureKnnDistance)} | ${fmt(row.pureKnnSim)} | ${fmt(row.waveDistance)} | ${fmt(row.waveSim)} | ${fmt(row.weightedGeoDistance)} | ${fmt(row.weightedGeoSim)} | ${fmt(row.geoFieldSim)} | ${this._escapeMarkdownCell(fmtTags(row.startTags))} | ${this._escapeMarkdownCell(fmtTags(row.targetTags))} |\n`;
        });

        content += `\n说明: 距离越小表示越近；纯KNN为原始向量余弦距离，V9.1 TagMemo为两端都经过增强后的向量距离，势能场加权距离使用 A/B 的Tag能量场余弦相似度与纯KNN按 alpha 融合，便于开发时观察语义拓扑与原始向量空间的偏差。\n`;
        content += `[--- 测绘结束 ---]\n`;
        return content;
    }

    _escapeMarkdownCell(value) {
        return String(value ?? '')
            .replace(/\|/g, '\\|')
            .replace(/\r?\n/g, '<br>');
    }

    /**
     * 🧊 检测冷知识库检索路由。
     * 支持两种触发方式：
     *   1. query 中包含 [知识库] 或 [知识库:库名1,库名2] / [知识库：库名] 语法
     *   2. 显式传入 knowledge_base 参数（字符串/数组），库名用逗号分隔
     * @returns {{ query: string, libraries: string[] }|null}
     */
    _detectColdKnowledgeRoute(query, knowledgeBaseArg) {
        if (!this.tdbKnowledgeManager) return null;

        let libraries = [];
        let cleanedQuery = typeof query === 'string' ? query : '';

        // 语法：[知识库] 或 [知识库:库名] 或 [知识库：库名1,库名2]
        const kbRegex = /\[\s*知识库\s*(?:[:：]\s*([^\]]+))?\s*\]/;
        const match = cleanedQuery.match(kbRegex);
        if (match) {
            if (match[1]) {
                libraries.push(...this._parseStringArray(match[1]));
            }
            cleanedQuery = cleanedQuery.replace(match[0], '').trim();
        }

        // 显式 knowledge_base 参数
        if (knowledgeBaseArg) {
            libraries.push(...this._parseStringArray(knowledgeBaseArg));
        }

        // 既没有 [知识库] 语法，也没有显式参数 → 不分流
        if (!match && (!knowledgeBaseArg || libraries.length === 0)) {
            return null;
        }

        // 去重
        libraries = [...new Set(libraries)];

        return { query: cleanedQuery || query || '', libraries };
    }

    /**
     * 🧊 处理冷知识库（TriviumDB）检索。
     * 走 TDBKnowledge 的 search_hybrid（BM25 稀疏 + 向量稠密 + 图扩散），
     * 可选叠加 LightMemo 自带的 Rerank 精排。
     */
    async _handleColdKnowledgeSearch({ query, libraries, k, rerank }) {
        if (!this.tdbKnowledgeManager) {
            return '冷知识库（TDBKnowledge）未启用或未注入，无法检索。';
        }
        if (!query || !query.trim()) {
            throw new Error("冷知识库检索的 'query' 不能为空。");
        }

        const normalizedK = Math.max(1, Math.floor(this._parseNumber(k, 5)));
        // Rerank 阶段会重排，因此初筛多取一些候选
        const fetchK = rerank ? normalizedK * 3 : normalizedK;

        console.log(`[LightMemo] 🧊 Cold knowledge search: query="${query}", libraries=[${libraries.join(', ') || 'ALL'}], k=${normalizedK}`);

        let hits = [];
        try {
            hits = await this.tdbKnowledgeManager.search(query, {
                libraries: libraries.length > 0 ? libraries : undefined,
                topK: fetchK,
                expandDepth: 1,
                minScore: 0.1,
                hybridAlpha: 0.65
            });
        } catch (error) {
            console.error('[LightMemo] Cold knowledge search failed:', error.message);
            return `冷知识库检索出错: ${error.message}`;
        }

        if (!hits || hits.length === 0) {
            const scope = libraries.length > 0 ? libraries.join(', ') : '全部知识库';
            return `关于"${query}"，在冷知识库（${scope}）中没有找到相关内容。`;
        }

        // 映射成 LightMemo Rerank/格式化所需的统一结构
        let docs = hits.map(h => ({
            dbName: h.library || '知识库',
            label: h.id,
            text: h.text || h.payload?.text_preview || '',
            sourceFile: h.sourceFile || h.payload?.source_path || '',
            vectorScore: typeof h.score === 'number' ? h.score : 0,
            hybridScore: typeof h.score === 'number' ? h.score : 0
        })).filter(d => d.text);

        // 可选 Rerank 精排（复用现有 rerank 解析与执行逻辑）
        let useRerank = false;
        let rrfOptions = null;
        if (rerank === true) {
            useRerank = true;
        } else if (typeof rerank === 'number' && rerank > 0 && rerank <= 1.0) {
            useRerank = true;
            rrfOptions = { alpha: rerank };
        } else if (typeof rerank === 'string') {
            const lower = rerank.toLowerCase().trim();
            if (lower.startsWith('rrf')) {
                useRerank = true;
                const m = lower.match(/rrf(\d+\.?\d*)/);
                rrfOptions = { alpha: m ? Math.min(1.0, Math.max(0.0, parseFloat(m[1]))) : 0.5 };
            } else {
                const numericAlpha = parseFloat(lower);
                if (!isNaN(numericAlpha) && numericAlpha > 0 && numericAlpha <= 1.0) {
                    useRerank = true;
                    rrfOptions = { alpha: numericAlpha };
                } else if (lower === 'true') {
                    useRerank = true;
                }
            }
        }

        if (useRerank && docs.length > 0) {
            docs.forEach((doc, idx) => { doc.retrieval_rank = idx + 1; });
            docs = await this._rerankDocuments(query, docs, normalizedK, rrfOptions);
        } else {
            docs = docs.slice(0, normalizedK);
        }

        return this._formatColdKnowledgeResults(docs, query, libraries);
    }

    _formatColdKnowledgeResults(results, query, libraries) {
        if (!results || results.length === 0) {
            const scope = libraries.length > 0 ? libraries.join(', ') : '全部知识库';
            return `关于"${query}"，在冷知识库（${scope}）中没有找到相关内容。`;
        }

        const searchedLibs = [...new Set(results.map(r => r.dbName))];
        let content = `\n[--- TDB 冷知识库检索 ---]\n`;
        content += `[查询内容: "${query}"]\n`;
        content += `[知识库范围: ${searchedLibs.join(', ')}]\n\n`;
        content += `[找到 ${results.length} 条相关知识片段:]\n`;

        results.forEach((r) => {
            let scoreValue = 0;
            let scoreType = '';
            if (typeof r.rerank_score === 'number' && !isNaN(r.rerank_score)) {
                scoreValue = r.rerank_score;
                scoreType = r.rerank_failed ? '混合' : 'Rerank';
            } else if (typeof r.hybridScore === 'number' && !isNaN(r.hybridScore)) {
                scoreValue = r.hybridScore;
                scoreType = '混合';
            } else if (typeof r.vectorScore === 'number' && !isNaN(r.vectorScore)) {
                scoreValue = r.vectorScore;
                scoreType = 'TDB';
            }
            const scoreDisplay = scoreValue > 0 ? `${(scoreValue * 100).toFixed(1)}%(${scoreType})` : 'N/A';

            content += `--- (来源: ${r.dbName}, 相关性: ${scoreDisplay})\n`;
            if (r.sourceFile) {
                content += `    [路径: ${r.sourceFile}]\n`;
            }
            // 每条召回内容后保留一个空行，避免多个知识片段视觉上粘连。
            content += `${(r.text || '').trim()}\n\n`;
        });

        content += `\n[--- 知识库检索结束 ---]\n`;
        return content;
    }

    formatResults(results, query) {
        if (results.length === 0) {
            return `关于"${query}"，在指定的知识库中没有找到相关的记忆片段。`;
        }

        const searchedDiaries = [...new Set(results.map(r => r.dbName))];
        let content = `\n[--- LightMemo 轻量回忆 ---]\n`;
        content += `[查询内容: "${query}"]\n`;
        content += `[搜索范围: ${searchedDiaries.join(', ')}]\n\n`;
        content += `[找到 ${results.length} 条相关记忆片段:]\n`;

        results.forEach((r, index) => {
            // 👇 修复：正确获取分数
            let scoreValue = 0;
            let scoreType = '';

            if (typeof r.rerank_score === 'number' && !isNaN(r.rerank_score)) {
                scoreValue = r.rerank_score;
                scoreType = r.rerank_failed ? '混合' : 'Rerank';
            } else if (typeof r.hybridScore === 'number' && !isNaN(r.hybridScore)) {
                scoreValue = r.hybridScore;
                scoreType = '混合';
            } else if (typeof r.vectorScore === 'number' && !isNaN(r.vectorScore)) {
                scoreValue = r.vectorScore;
                scoreType = '向量';
            } else if (typeof r.bm25Score === 'number' && !isNaN(r.bm25Score)) {
                scoreValue = r.bm25Score;
                scoreType = 'BM25';
            }

            const scoreDisplay = scoreValue > 0
                ? `${(scoreValue * 100).toFixed(1)}%(${scoreType})`
                : 'N/A';

            const localUrl = r.sourceFile ? `file:///${r.sourceFile.replace(/\\/g, '/')}` : '';
            content += `--- (来源: ${r.dbName}, 相关性: ${scoreDisplay})\n`;
            if (localUrl) {
                content += `    [路径: ${localUrl}]\n`;
            }
            if (r.riverMemo) {
                const river = r.riverMemo;
                content += `    [RiverMemo Topology V3: ` +
                    `Ω=${Number(river.omega || 0).toFixed(3)}` +
                    `/${river.regime || 'unknown'}, ` +
                    `角色=${river.role || 'unknown'}, ` +
                    `拓扑+${Number(river.topologyBonus || 0).toFixed(4)}, ` +
                    `直锚+${Number(river.anchorBonus || 0).toFixed(4)}]\n`;
            }
            if (r.tagBoostInfo) {
                // 使用解构默认值，确保即使 tagBoostInfo 结构不完整也能安全运行
                const { matchedTags = [], coreTagsMatched = [] } = r.tagBoostInfo;
                if (matchedTags.length > 0 || coreTagsMatched.length > 0) {
                    const memoLabel = r.potentialFieldV91 ? 'TagMemo V9.1 + 势能场' : 'TagMemo V9.1';
                    let boostLine = `    [${memoLabel} 增强: `;
                    // 只有当确实命中了核心标签时，才显示 🌟 标志
                    if (coreTagsMatched.length > 0) {
                        boostLine += `🌟${coreTagsMatched.join(', ')} `;
                        if (matchedTags.length > 0) boostLine += `| `;
                    }
                    if (matchedTags.length > 0) {
                        boostLine += `${matchedTags.slice(0, 5).join(', ')}`;
                    }
                    content += boostLine + `]\n`;
                }
            }
            // 每条召回内容后保留一个空行，避免多个记忆片段视觉上粘连。
            content += `${r.text.trim()}\n\n`;
        });

        content += `\n[--- 回忆结束 ---]\n`;
        return content;
    }

    _estimateTokens(text) {
        if (!text) return 0;
        const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
        const otherChars = text.length - chineseChars;
        return Math.ceil(chineseChars * 1.5 + otherChars * 0.25);
    }

    async _rerankDocuments(query, documents, originalK, rrfOptions = null) {
        if (!this.rerankConfig.url || !this.rerankConfig.apiKey || !this.rerankConfig.model) {
            console.warn('[LightMemo] Rerank not configured. Skipping.');
            return documents.slice(0, originalK);
        }

        // Rerank API 要求 query/documents 均为非空字符串；undefined 数组项会被
        // JSON.stringify 转成 null，部分服务会以 “input cannot be null” 拒绝整批。
        const normalizedQuery = String(query ?? '').trim();
        if (!normalizedQuery) {
            console.warn('[LightMemo] Rerank skipped because query is empty.');
            return documents.slice(0, originalK);
        }
        const validDocuments = documents
            .map(doc => ({
                ...doc,
                text: String(doc?.text ?? '').trim()
            }))
            .filter(doc => doc.text);
        const droppedCount = documents.length - validDocuments.length;
        if (droppedCount > 0) {
            console.warn(`[LightMemo] Dropped ${droppedCount} documents without valid text before reranking.`);
        }
        if (validDocuments.length === 0) {
            console.warn('[LightMemo] Rerank skipped because no document contains valid text.');
            return [];
        }

        console.log(`[LightMemo] Starting rerank for ${validDocuments.length} documents.`);

        const rerankUrl = new URL('v1/rerank', this.rerankConfig.url).toString();
        const headers = {
            'Authorization': `Bearer ${this.rerankConfig.apiKey}`,
            'Content-Type': 'application/json',
        };
        const maxTokens = this.rerankConfig.maxTokens;
        const queryTokens = this._estimateTokens(normalizedQuery);
        const maxDocumentsPerRequest = Math.max(
            1,
            Math.min(25, parseInt(this.rerankConfig.maxDocumentsPerRequest, 10) || 25)
        );
        const maxConcurrentRequests = Math.max(
            1,
            Math.min(10, parseInt(this.rerankConfig.maxConcurrentRequests, 10) || 3)
        );

        let batches = [];
        let currentBatch = [];
        let currentTokens = queryTokens;

        for (const doc of validDocuments) {
            const docTokens = this._estimateTokens(doc.text);
            const exceedsDocumentLimit = currentBatch.length >= maxDocumentsPerRequest;
            const exceedsTokenLimit = currentTokens + docTokens > maxTokens;
            if ((exceedsDocumentLimit || exceedsTokenLimit) && currentBatch.length > 0) {
                batches.push(currentBatch);
                currentBatch = [doc];
                currentTokens = queryTokens + docTokens;
            } else {
                currentBatch.push(doc);
                currentTokens += docTokens;
            }
        }
        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }

        console.log(
            `[LightMemo] Split into ${batches.length} free-tier batches ` +
            `(max ${maxDocumentsPerRequest} documents/request, concurrency ` +
            `${Math.min(maxConcurrentRequests, batches.length)}).`
        );

        const batchResults = new Array(batches.length);
        let nextBatchIndex = 0;

        const rerankBatch = async (batch, batchIndex) => {
            const docTexts = batch.map(d => d.text);

            try {
                const body = {
                    model: this.rerankConfig.model,
                    query: normalizedQuery,
                    documents: docTexts,
                    top_n: docTexts.length
                };

                console.log(`[LightMemo] Reranking batch ${batchIndex + 1}/${batches.length} (${docTexts.length} docs).`);
                const response = await axios.post(rerankUrl, body, {
                    headers,
                    timeout: 30000
                });

                let responseData = response.data;
                if (typeof responseData === 'string') {
                    try {
                        responseData = JSON.parse(responseData);
                    } catch (e) {
                        console.error('[LightMemo] Failed to parse rerank response:', responseData);
                        throw new Error('Invalid JSON response');
                    }
                }

                if (responseData && Array.isArray(responseData.results)) {
                    const rerankedResults = responseData.results;
                    console.log(`[LightMemo] Batch ${batchIndex + 1} rerank scores:`,
                        rerankedResults.map(r => r.relevance_score.toFixed(3)).join(', '));

                    return rerankedResults
                        .map(result => {
                            const originalDoc = batch[result.index];
                            if (!originalDoc) return null;
                            return {
                                ...originalDoc,
                                rerank_score: result.relevance_score
                            };
                        })
                        .filter(Boolean);
                }

                throw new Error('Invalid response format');
            } catch (error) {
                console.error(`[LightMemo] Rerank failed for batch ${batchIndex + 1}:`, error.message);
                if (error.response) {
                    console.error(`[LightMemo] API Error - Status: ${error.response.status}, Data:`,
                        JSON.stringify(error.response.data).slice(0, 200));
                }

                return batch.map(doc => ({
                    ...doc,
                    rerank_score: doc.hybridScore || doc.vectorScore || doc.bm25Score || 0,
                    rerank_failed: true
                }));
            }
        };

        // 有界 worker pool：并发处理免费小批量请求，结果按原批次顺序合并。
        const workerCount = Math.min(maxConcurrentRequests, batches.length);
        const workers = Array.from({ length: workerCount }, async () => {
            while (true) {
                const batchIndex = nextBatchIndex++;
                if (batchIndex >= batches.length) return;
                batchResults[batchIndex] = await rerankBatch(batches[batchIndex], batchIndex);
            }
        });
        await Promise.all(workers);
        const allRerankedDocs = batchResults.flatMap(result => result || []);

        // 🌟 Rerank+ (RRF Fusion) 或标准 Rerank 排序
        if (rrfOptions) {
            // --- Reciprocal Rank Fusion (RRF) ---
            const RRF_K = 60;
            const alpha = rrfOptions.alpha ?? 0.5;

            // Step 1: 按 rerank_score 降序排列，赋予 rerank_rank (1-based)
            allRerankedDocs.sort((a, b) => (b.rerank_score ?? -1) - (a.rerank_score ?? -1));
            allRerankedDocs.forEach((doc, idx) => { doc.rerank_rank = idx + 1; });

            // Step 2: 计算 RRF 融合分数
            allRerankedDocs.forEach(doc => {
                const retrievalRank = doc.retrieval_rank || allRerankedDocs.length;
                const rerankRank = doc.rerank_rank;
                doc.rrf_score = alpha * (1 / (RRF_K + rerankRank))
                              + (1 - alpha) * (1 / (RRF_K + retrievalRank));
            });

            // Step 3: 按 RRF 融合分数降序排列
            allRerankedDocs.sort((a, b) => b.rrf_score - a.rrf_score);

            const finalDocs = allRerankedDocs.slice(0, originalK);
            console.log(`[LightMemo] 🌟 Rerank+ (RRF) 完成: ${finalDocs.length}篇文档 (α=${alpha})`);
            finalDocs.forEach((doc, idx) => {
                console.log(`  [RRF #${idx + 1}] rrf=${doc.rrf_score?.toFixed(6)} | retrieval_rank=${doc.retrieval_rank} | rerank_rank=${doc.rerank_rank} | rerank_score=${doc.rerank_score?.toFixed(4) ?? 'N/A'} | hybrid_score=${doc.hybridScore?.toFixed(4) ?? 'N/A'}`);
            });

            return finalDocs;
        } else {
            // --- 标准 Rerank 排序（原有逻辑，不变） ---
            allRerankedDocs.sort((a, b) => {
                const scoreA = a.rerank_score ?? 0;
                const scoreB = b.rerank_score ?? 0;
                return scoreB - scoreA;
            });

            const finalDocs = allRerankedDocs.slice(0, originalK);
            console.log(`[LightMemo] Rerank complete. Final scores:`,
                finalDocs.map(d => (d.rerank_score || 0).toFixed(3)).join(', '));

            return finalDocs;
        }
    }

    /**
     * 解析 LightMemo 的 AIMemo+ 开关。
     * - false/未传：关闭
     * - true、aimemo、aimemo+、true+：使用默认配置
     * - 其他非布尔字符串：作为 RAGDiaryPlugin 的 AIMemo 预设名
     * - aimemo_preset 显式值优先作为预设名，并自动开启
     */
    _parseAIMemoOptions(value, explicitPreset = null) {
        const preset = typeof explicitPreset === 'string' ? explicitPreset.trim() : '';
        if (preset) {
            return { enabled: true, presetName: preset };
        }

        if (typeof value === 'boolean') {
            return { enabled: value, presetName: null };
        }
        if (typeof value === 'number') {
            return { enabled: value !== 0, presetName: null };
        }
        if (typeof value !== 'string') {
            return { enabled: false, presetName: null };
        }

        const normalized = value.trim();
        const lower = normalized.toLowerCase();
        if (!normalized || ['false', '0', 'no', 'off', 'disable', 'disabled', '关闭', '禁用', '否'].includes(lower)) {
            return { enabled: false, presetName: null };
        }
        if (['true', '1', 'yes', 'on', 'enable', 'enabled', 'aimemo', 'aimemo+', 'true+', '开启', '启用', '是'].includes(lower)) {
            return { enabled: true, presetName: null };
        }

        return { enabled: true, presetName: normalized };
    }

    /**
     * 将 LightMemo 最终候选提交给 RAGDiaryPlugin 唯一持有的 AIMemoHandler。
     * 返回 null 表示桥不可用、未配置或总结失败，调用方应保留原始检索结果。
     */
    async _summarizeWithAIMemo({ results, query, presetName = null, cacheSalt = '' }) {
        if (!this.aiMemoBridge || typeof this.aiMemoBridge.summarizeCandidates !== 'function') {
            console.warn('[LightMemo] AIMemo requested, but AIMemoBridge is unavailable. Falling back to raw memories.');
            return null;
        }

        if (
            !presetName &&
            typeof this.aiMemoBridge.isConfigured === 'function' &&
            !this.aiMemoBridge.isConfigured()
        ) {
            console.warn('[LightMemo] AIMemo requested, but default AIMemo configuration is incomplete. Falling back to raw memories.');
            return null;
        }

        const diaryNames = [...new Set(
            results.map(result => String(result?.dbName || '').trim()).filter(Boolean)
        )];

        try {
            const summary = await this.aiMemoBridge.summarizeCandidates({
                candidates: results,
                diaryNames,
                userContent: String(query || '').trim(),
                displayQuery: String(query || '').trim(),
                presetName,
                cacheSalt
            });
            const normalized = typeof summary === 'string' ? summary.trim() : '';
            if (
                !normalized ||
                /^\[(?:AIMemo功能未配置|AIMemo\+?处理失败|AIMemo聚合处理失败|AI模型调用失败)/.test(normalized)
            ) {
                console.warn(`[LightMemo] AIMemo returned an unusable result: ${normalized || '(empty)'}. Falling back to raw memories.`);
                return null;
            }

            return `\n[--- LightMemo AIMemo+ AI总结 ---]\n${normalized}\n[--- AI总结结束 ---]\n`;
        } catch (error) {
            console.error('[LightMemo] AIMemo summarization failed. Falling back to raw memories:', error.message);
            return null;
        }
    }

    /**
     * 解析 A/B 报告的后续详情开关。默认仅返回排行表及其之前的内容，
     * 只有调用方显式请求时才附加完整正文、诊断和评审数据。
     */
    _parseABIncludeDetails(args = {}) {
        return this._parseBooleanAlias(
            [
                ['include_details', args.include_details],
                ['includeDetails', args.includeDetails],
                ['include_followup_data', args.include_followup_data],
                ['full_report', args.full_report]
            ],
            false,
            'TagMemo A/B follow-up details'
        );
    }

    /**
     * 将工具协议传入的布尔值参数规范化。
     * VCP 工具参数常以字符串形式传入，字符串 "false" 在 JS 中是真值，
     * 如果不转换会导致 search_all_knowledge_bases 被误判为开启。
     */
    _parseBoolean(value, defaultValue = false) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value !== 'string') return defaultValue;

        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on', 'enable', 'enabled', '开启', '启用', '是'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off', '', 'disable', 'disabled', '关闭', '禁用', '否'].includes(normalized)) return false;

        return defaultValue;
    }

    /**
     * 从多个别名参数中解析布尔开关。
     * 后出现的显式可解析值优先生效，未提供或不可解析时保留默认值。
     */
    _parseBooleanAlias(namedValues, defaultValue = false, label = 'boolean option') {
        let result = defaultValue;
        let matchedName = null;

        for (const [name, value] of namedValues) {
            if (value === undefined || value === null) continue;
            const parsed = this._parseBoolean(value, null);
            if (parsed === null) {
                console.warn(`[LightMemo] Ignoring invalid ${label} value from ${name}: ${value}`);
                continue;
            }
            result = parsed;
            matchedName = name;
        }

        if (matchedName) {
            console.log(`[LightMemo] ${label} resolved from ${matchedName}: ${result}`);
        }

        return result;
    }

    /**
     * 将工具协议传入的数字参数规范化。
     */
    _parseNumber(value, defaultValue = 0) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value !== 'string') return defaultValue;

        const parsed = parseFloat(value.trim());
        return Number.isFinite(parsed) ? parsed : defaultValue;
    }

    /**
     * 将工具协议传入的数组参数规范化。
     * 兼容真实数组、JSON数组字符串，以及逗号/中文逗号/顿号/竖线分隔字符串。
     */
    _parseStringArray(value) {
        if (Array.isArray(value)) {
            return value
                .map(v => typeof v === 'string' ? v.trim() : String(v ?? '').trim())
                .filter(Boolean);
        }

        if (typeof value !== 'string') return [];

        const trimmed = value.trim();
        if (!trimmed) return [];

        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return parsed
                        .map(v => typeof v === 'string' ? v.trim() : String(v ?? '').trim())
                        .filter(Boolean);
                }
            } catch (e) {
                // 非 JSON 数组时继续按分隔符解析
            }
        }

        return trimmed
            .split(/[,，、|｜]/)
            .map(v => v.trim())
            .filter(Boolean);
    }

    /**
     * 解析 maid 中的作用域语法：[文件夹]署名
     * 示例：[小吉的地缘政治]小吉 => folder: 小吉的地缘政治, maid: 小吉
     * 文件夹部分支持用中文逗号、英文逗号或 | 分隔多个文件夹。
     */
    _parseMaidScopedFolder(maid) {
        if (typeof maid !== 'string') {
            return { maid, folder: null };
        }

        const trimmedMaid = maid.trim();
        const scopedMatch = trimmedMaid.match(/^\[([^\]]+)\](.*)$/);
        if (!scopedMatch) {
            return { maid: trimmedMaid, folder: null };
        }

        const scopedFolder = scopedMatch[1].trim();
        const scopedMaid = scopedMatch[2].trim();

        return {
            maid: scopedMaid || null,
            folder: scopedFolder || null
        };
    }

    /**
     * 合并显式 folder 参数与 maid 作用域文件夹，兼容中文逗号、英文逗号和 | 分隔的多文件夹写法
     */
    _mergeFolderScopes(folder, scopedFolder) {
        const folders = [];

        const appendFolders = (value) => {
            if (typeof value !== 'string') return;
            value.split(/[,，|]/)
                .map(f => f.trim())
                .filter(Boolean)
                .forEach(f => {
                    if (!folders.includes(f)) {
                        folders.push(f);
                    }
                });
        };

        appendFolders(folder);
        appendFolders(scopedFolder);

        return folders.length > 0 ? folders.join(',') : null;
    }

    _isBM25TokenLikeWord(token) {
        return /[\p{Script=Han}a-z0-9_]/iu.test(String(token || ''));
    }

    /**
     * 改用jieba分词（保留词组）
     */
    _tokenize(text) {
        if (!text) return [];

        // ✅ 使用实例调用 cut 方法
        if (!this.jiebaInstance) {
            console.warn('[LightMemo] Jieba not initialized, falling back to simple split.');
            // 降级方案：简单分词
            return text.split(/\s+/)
                .map(w => w.toLowerCase().trim())
                .filter(w => w.length >= 1) // 允许单字，提高搜索召回率（特别是姓名）
                .filter(w => this._isBM25TokenLikeWord(w))
                .filter(w => !this.stopWords.has(w));
        }

        const words = this.jiebaInstance.cut(text, false);  // 精确模式

        return words
            .map(w => w.toLowerCase().trim())
            .filter(w => w.length >= 1) // 允许单字，提高搜索召回率（特别是姓名）
            .filter(w => this._isBM25TokenLikeWord(w))
            .filter(w => !this.stopWords.has(w))
            .filter(w => w.length > 0);
    }
    /**
     * 从所有相关日记本中收集chunks（带署名过滤）
     * 适配 KnowledgeBaseManager (SQLite)
     */
    async _gatherCandidateChunks({ maid, folder, searchAll, ignoreExcludedFolders = false, timeRange = null }) {
        const db = this.vectorDBManager.db;
        if (!db) {
            console.error('[LightMemo] Database not initialized in KnowledgeBaseManager.');
            return [];
        }

        const candidates = [];
        const targetFolders = folder ? folder.split(/[,，|]/).map(f => f.trim()).filter(Boolean) : [];

        try {
            // 🚀 优化：使用 SQL 过滤减少 JS 端的处理压力
            let sql = `
                SELECT c.id, c.file_id, c.content, f.diary_name, f.path
                FROM chunks c
                JOIN files f ON c.file_id = f.id
                WHERE 1=1
            `;
            const params = [];

            // 1. 排除文件夹
            let currentExcludedFolders = this.excludedFolders;
            if (ignoreExcludedFolders && targetFolders.length > 0) {
                currentExcludedFolders = currentExcludedFolders.filter(f => !targetFolders.includes(f));
            }

            if (currentExcludedFolders.length > 0) {
                sql += ` AND f.diary_name NOT IN (${currentExcludedFolders.map(() => '?').join(',')})`;
                params.push(...currentExcludedFolders);
            }
            sql += ` AND f.diary_name NOT LIKE '已整理%' AND f.diary_name NOT LIKE '%簇'`;

            // 2. 目标范围过滤
            if (!searchAll) {
                if (targetFolders.length > 0) {
                    sql += ` AND (${targetFolders.map(() => "f.diary_name LIKE ?").join(" OR ")})`;
                    targetFolders.forEach(f => params.push(`%${f}%`));
                } else if (maid) {
                    sql += ` AND f.diary_name LIKE ?`;
                    params.push(`%${maid}%`);
                }
            }

            const stmt = db.prepare(sql);

            // 流式遍历过滤后的 chunks
            for (const row of stmt.iterate(...params)) {
                const text = row.content || '';

                // --- 2.5 时间范围过滤 ---
                if (timeRange) {
                    const header = text.substring(0, 100);
                    const chunkTimeMatch = header.match(/\[?(20\d{2}[-./]\d{1,2}(?:[-./]\d{1,2})?)\]?/);
                    if (!chunkTimeMatch) {
                        continue; // 无时间戳，被时间约束丢弃
                    }
                    const parts = chunkTimeMatch[1].split(/[-./]/);
                    const y = parts[0];
                    const m = (parts[1] || '01').padStart(2, '0');
                    const d = (parts[2] || '01').padStart(2, '0');
                    const chunkDateNum = parseInt(`${y}${m}${d}`, 10);

                    if (chunkDateNum < timeRange.start || chunkDateNum > timeRange.end) {
                        continue;
                    }
                }

                // 3. 署名过滤 (如果不是搜索全部且没有指定文件夹)
                if (!searchAll && targetFolders.length === 0 && maid) {
                    if (!this._checkSignature(text, maid)) continue;
                }

                // 4. 分词 (仅对通过初步过滤的进行分词)
                // 音乐检索不使用关键词，可以跳过分词以提高性能，返回空数组
                const tokens = ignoreExcludedFolders ? [] : this._tokenize(text);

                candidates.push({
                    dbName: row.diary_name,
                    label: row.id,
                    fileId: row.file_id,
                    text: text,
                    tokens: tokens,
                    sourceFile: row.path
                });
            }
        } catch (error) {
            console.error('[LightMemo] Error gathering chunks from DB:', error);
        }

        return candidates;
    }

    /**
     * 检查文本中是否包含特定署名
     */
    _checkSignature(text, maid) {
        if (!text || !maid) return false;

        // 提取第一行
        const firstLine = text.split('\n')[0].trim();

        // 检查第一行是否包含署名
        return firstLine.includes(maid);
    }

    /**
     * 为候选chunks计算向量相似度
     * 适配 KnowledgeBaseManager (SQLite)
     */
    async _scoreByVectorSimilarity(candidates, queryVector) {
        const db = this.vectorDBManager.db;
        if (!db) return [];

        const scored = [];
        const stmt = db.prepare('SELECT vector FROM chunks WHERE id = ?');
        const dim = this.vectorDBManager.config.dimension;

        for (const candidate of candidates) {
            try {
                const row = stmt.get(candidate.label); // label is chunk.id
                if (!row || !row.vector) continue;

                // 转换 BLOB 为 Float32Array
                // 注意：Buffer 是 Node.js 的 Buffer，可以直接作为 ArrayBuffer 使用，但需要注意 offset
                const chunkVector = new Float32Array(row.vector.buffer, row.vector.byteOffset, dim);

                const similarity = this._cosineSimilarity(queryVector, chunkVector);

                scored.push({
                    ...candidate,
                    vectorScore: similarity
                });
            } catch (error) {
                console.warn(`[LightMemo] Error calculating similarity for chunk ${candidate.label}:`, error.message);
                continue;
            }
        }

        return scored;
    }

    _cosineSimilarity(vecA, vecB) {
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
     * 基于语义组扩展查询词
     */
    _expandQueryTokens(queryTokens) {
        if (this.wordToGroupMap.size === 0) {
            return [];
        }

        const expandedTokens = new Set();
        const activatedGroups = new Set();

        for (const token of queryTokens) {
            const groupWords = this.wordToGroupMap.get(token.toLowerCase());
            if (groupWords) {
                const groupKey = groupWords.join(',');
                if (!activatedGroups.has(groupKey)) {
                    activatedGroups.add(groupKey);
                    groupWords.forEach(word => {
                        if (!queryTokens.includes(word)) {
                            expandedTokens.add(word);
                        }
                    });
                }
            }
        }

        return Array.from(expandedTokens);
    }

    async loadSemanticGroups() {
        const semanticGroupsPath = path.join(this.projectBasePath, 'Plugin', 'RAGDiaryPlugin', 'semantic_groups.json');
        try {
            const data = await fs.readFile(semanticGroupsPath, 'utf-8');
            this.semanticGroups = JSON.parse(data);
            this.wordToGroupMap = new Map();
            if (this.semanticGroups && this.semanticGroups.groups) {
                for (const groupName in this.semanticGroups.groups) {
                    const group = this.semanticGroups.groups[groupName];
                    if (group.words && Array.isArray(group.words)) {
                        const lowercasedWords = group.words.map(w => w.toLowerCase());
                        for (const word of lowercasedWords) {
                            this.wordToGroupMap.set(word, lowercasedWords);
                        }
                    }
                }
            }
            console.log(`[LightMemo] Semantic groups loaded successfully. ${this.wordToGroupMap.size} words mapped.`);
        } catch (error) {
            console.warn('[LightMemo] Could not load semantic_groups.json. Proceeding without query expansion.', error.message);
            this.semanticGroups = null;
            this.wordToGroupMap = new Map();
        }
    }

    /**
     * ✅ 关闭插件（预留）
     */
    shutdown() {
        console.log(`[LightMemo] Plugin shutdown.`);
    }
}

module.exports = new LightMemoPlugin();
