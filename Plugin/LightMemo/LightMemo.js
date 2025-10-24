// Plugin/LightMemoPlugin/LightMemo.js
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

class LightMemoPlugin {
    constructor() {
        this.name = 'LightMemo';
        this.vectorDBManager = null;
        this.getSingleEmbedding = null;
        this.projectBasePath = '';
        this.dailyNoteRootPath = '';
        this.rerankConfig = {};
        this.excludedFolders = [];
    }

    initialize(config, dependencies) {
        this.projectBasePath = config.PROJECT_BASE_PATH || path.join(__dirname, '..', '..');
        this.dailyNoteRootPath = path.join(this.projectBasePath, 'dailynote');
        
        if (dependencies.vectorDBManager) {
            this.vectorDBManager = dependencies.vectorDBManager;
        }
        if (dependencies.getSingleEmbedding) {
            this.getSingleEmbedding = dependencies.getSingleEmbedding;
        }

        this.loadConfig(); // Load config after dependencies are set
        console.log('[LightMemo] Plugin initialized successfully as a hybrid service.');
    }

    loadConfig() {
        // config.env is already loaded by Plugin.js, we just need to read the values
        const excluded = process.env.EXCLUDED_FOLDERS || "已整理,夜伽,MusicDiary";
        this.excludedFolders = excluded.split(',').map(f => f.trim()).filter(Boolean);

        this.rerankConfig = {
            url: process.env.RerankUrl || '',
            apiKey: process.env.RerankApi || '',
            model: process.env.RerankModel || '',
            maxTokens: parseInt(process.env.RerankMaxTokensPerBatch) || 30000,
            multiplier: 2.0
        };
    }

    async processToolCall(args) {
        try {
            return await this.handleSearch(args);
        } catch (error) {
            console.error('[LightMemo] Error processing tool call:', error);
            // Return an error structure that Plugin.js can understand
            return { plugin_error: error.message || 'An unknown error occurred in LightMemo.' };
        }
    }

    async handleSearch(args) {
        const {
            query,
            maid,
            k = 5,
        } = args;

        // Manually parse boolean-like strings, providing defaults
        const rerank = args.rerank !== undefined ? String(args.rerank).toLowerCase() === 'true' : false;
        const search_all_knowledge_bases = args.search_all_knowledge_bases !== undefined ? String(args.search_all_knowledge_bases).toLowerCase() === 'true' : false;

        if (!query || !maid) {
            throw new Error("参数 'query' 和 'maid' 是必需的。");
        }
        if (!this.vectorDBManager || !this.getSingleEmbedding) {
            throw new Error("核心依赖 (VectorDBManager, getSingleEmbedding) 未注入。");
        }

        let allDiaries = [];
        try {
            allDiaries = await fs.readdir(this.dailyNoteRootPath, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') {
                return "日记本根目录 'dailynote' 未找到。";
            }
            throw error;
        }

        const availableDiaries = allDiaries
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name)
            .filter(name => {
                if (name.startsWith('已整理') || name.endsWith('簇')) return false;
                if (this.excludedFolders.includes(name)) return false;
                return true;
            });

        let candidateDiaries = search_all_knowledge_bases
            ? availableDiaries
            : availableDiaries.filter(name => name.includes(maid));

        // --- 关键：执行两阶段搜索 ---
        // 1. 关键字初筛
        const targetDiaries = await this._keywordPreScreening(query, candidateDiaries);

        if (targetDiaries.length === 0) {
            return search_all_knowledge_bases
                ? "没有找到任何可供搜索的知识库。"
                : `没有找到署名为 "${maid}" 的相关知识库。`;
        }

        const queryVector = await this.getSingleEmbedding(query);
        if (!queryVector) {
            throw new Error("查询内容向量化失败。");
        }

        const kForSearch = rerank ? Math.max(1, Math.round(k * this.rerankConfig.multiplier)) : k;

        const searchPromises = targetDiaries.map(dbName =>
            this.vectorDBManager.search(dbName, queryVector, kForSearch)
                .then(results => results.map(r => ({ ...r, dbName })))
        );
        
        let allResults = (await Promise.all(searchPromises)).flat()
            .sort((a, b) => b.score - a.score); // <-- 关键：先按分数排序

        let finalResults;
        if (rerank && allResults.length > 0) {
            // Rerank 前先截取 top N，避免给 reranker 过多不相关的文档
            const preRerankResults = allResults.slice(0, kForSearch);
            finalResults = await this._rerankDocuments(query, preRerankResults, k);
        } else {
            finalResults = allResults.slice(0, k);
        }

        return this.formatResults(finalResults, query, targetDiaries);
    }

    formatResults(results, query, searchedDiaries) {
        if (results.length === 0) {
            return `关于“${query}”，在指定的知识库中没有找到相关的记忆片段。`;
        }

        let content = `\n[--- LightMemo 轻量回忆 ---]\n`;
        content += `[查询内容: "${query}"]\n`;
        content += `[搜索范围: ${searchedDiaries.join(', ')}]\n\n`;
        content += `[找到 ${results.length} 条相关记忆片段:]\n`;

        results.forEach(r => {
            content += `--- (来源: ${r.dbName}, 相关性: ${(r.score * 100).toFixed(1)}%)\n`;
            content += `${r.text.trim()}\n`;
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

    async _rerankDocuments(query, documents, originalK) {
        if (!this.rerankConfig.url || !this.rerankConfig.apiKey || !this.rerankConfig.model) {
            console.warn('[LightMemo] Rerank called, but is not configured. Skipping.');
            return documents.slice(0, originalK);
        }
        console.log(`[LightMemo] Starting rerank process for ${documents.length} documents.`);

        const rerankUrl = new URL('v1/rerank', this.rerankConfig.url).toString();
        const headers = {
            'Authorization': `Bearer ${this.rerankConfig.apiKey}`,
            'Content-Type': 'application/json',
        };
        const maxTokens = this.rerankConfig.maxTokens;
        const queryTokens = this._estimateTokens(query);

        let batches = [];
        let currentBatch = [];
        let currentTokens = queryTokens;

        for (const doc of documents) {
            const docTokens = this._estimateTokens(doc.text);
            if (currentTokens + docTokens > maxTokens && currentBatch.length > 0) {
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

        console.log(`[LightMemo] Split documents into ${batches.length} batches for reranking.`);

        let allRerankedDocs = [];
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const docTexts = batch.map(d => d.text);
            
            try {
                const body = {
                    model: this.rerankConfig.model,
                    query: query,
                    documents: docTexts,
                    top_n: docTexts.length 
                };

                console.log(`[LightMemo] Reranking batch ${i + 1}/${batches.length} with ${docTexts.length} documents.`);
                const response = await axios.post(rerankUrl, body, { headers });

                if (response.data && Array.isArray(response.data.results)) {
                    const rerankedResults = response.data.results;
                    const orderedBatch = rerankedResults
                        .map(result => {
                            const originalDoc = batch[result.index];
                            // 关键：将 rerank score 赋给原始文档，但保留原始 score 以备后用
                            return { ...originalDoc, rerank_score: result.relevance_score };
                        })
                        .filter(Boolean);
                    
                    allRerankedDocs.push(...orderedBatch);
                } else {
                    console.warn(`[LightMemo] Rerank for batch ${i + 1} returned invalid data. Appending original batch documents.`);
                    allRerankedDocs.push(...batch);
                }
            } catch (error) {
                console.error(`[LightMemo] Rerank API call failed for batch ${i + 1}. Appending original batch documents.`);
                if (error.response) {
                    console.error(`[LightMemo] Rerank API Error - Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
                } else {
                    console.error('[LightMemo] Rerank API Error - Message:', error.message);
                }
                allRerankedDocs.push(...batch);
            }
        }

        // 关键：在所有批次处理完后，根据 rerank_score 进行全局排序
        allRerankedDocs.sort((a, b) => b.rerank_score - a.rerank_score);

        const finalDocs = allRerankedDocs.slice(0, originalK);
        console.log(`[LightMemo] Rerank process finished. Returning ${finalDocs.length} documents.`);
        return finalDocs;
    }

    _tokenize(text) {
        if (!text) return [];
        // 1. 转换为小写以进行不区分大小写的匹配
        const lowerText = text.toLowerCase();
        // 2. 使用正则表达式匹配中文单字或连续的英文/数字序列
        const tokens = lowerText.match(/[\u4e00-\u9fa5]|[a-z0-9]+/g) || [];
        // 3. 定义并过滤掉常见的停用词，以减少噪音
        const stopWords = new Set(['的', '了', '在', '是', '我', '你', '他', '她', '它', '我们', '你们', '他们', 'a', 'an', 'the', 'is', 'are', 'am', 'in', 'on', 'at', 'to', 'and', 'or', 'but', 'what', 'when', 'where', 'how', 'who', 'which']);
        return tokens.filter(token => !stopWords.has(token));
    }

    async _keywordPreScreening(query, diaryNames) {
        const queryTokens = this._tokenize(query);
        // 如果查询没有有效的分词，则跳过初筛，返回所有日记本
        if (queryTokens.length === 0) {
            console.log('[LightMemo] No valid tokens in query, skipping keyword pre-screening.');
            return diaryNames;
        }

        console.log(`[LightMemo] Pre-screening with tokens: [${queryTokens.join(', ')}]`);

        const scoredDiaries = [];
        const scorePromises = diaryNames.map(async (diaryName) => {
            try {
                const diaryPath = path.join(this.dailyNoteRootPath, diaryName);
                const files = await fs.readdir(diaryPath);
                const contentFiles = files.filter(f => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md'));

                let totalScore = 0;
                // 并行读取日记本内的所有文件内容
                const contents = await Promise.all(
                    contentFiles.map(file => fs.readFile(path.join(diaryPath, file), 'utf-8'))
                );
                const fullContent = contents.join('\n');
                
                // 对整个日记本内容进行一次分词，提高效率
                const contentTokens = this._tokenize(fullContent);
                const tokenCounts = contentTokens.reduce((acc, token) => {
                    acc[token] = (acc[token] || 0) + 1;
                    return acc;
                }, {});

                // 基于查询词的词频计算分数
                for (const token of queryTokens) {
                    totalScore += (tokenCounts[token] || 0);
                }

                if (totalScore > 0) {
                    scoredDiaries.push({ name: diaryName, score: totalScore });
                }
            } catch (error) {
                console.error(`[LightMemo] Error during pre-screening diary "${diaryName}":`, error.message);
            }
        });

        await Promise.all(scorePromises);

        // 如果没有任何日记本匹配到关键词，则返回原始列表，让向量搜索尝试
        if (scoredDiaries.length === 0) {
            console.log('[LightMemo] No keyword matches found. Falling back to vector search on all target diaries.');
            return diaryNames;
        }

        // 按分数从高到低排序
        scoredDiaries.sort((a, b) => b.score - a.score);

        // 设定一个阈值，比如只取分数最高的7个日记本进行精搜
        const PRE_SCREENING_THRESHOLD = 7;
        const topDiaries = scoredDiaries.slice(0, PRE_SCREENING_THRESHOLD).map(d => d.name);

        console.log('[LightMemo] Keyword pre-screening top results:', scoredDiaries.slice(0, PRE_SCREENING_THRESHOLD));
        
        return topDiaries;
    }
}

module.exports = new LightMemoPlugin();