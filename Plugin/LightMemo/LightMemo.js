// Plugin/LightMemo/LightMemo.js
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { Jieba } = require('@node-rs/jieba');
const { dict } = require('@node-rs/jieba/dict');

class LightMemoPlugin {
    constructor() {
        this.name = 'LightMemo';
        this.vectorDBManager = null;
        this.tdbKnowledgeManager = null; // 冷知识库（TriviumDB）检索管理器
        this.aiMemoBridge = null; // RAGDiaryPlugin 共享的 AI 记忆总结桥
        this.jevClient = null; // VCP 根配置共享的 Jev 结构化决策客户端
        this.getSingleEmbedding = null;
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
        if (dependencies.jevClient) {
            this.jevClient = dependencies.jevClient;
            console.log('[LightMemo] JevClient injected. Optional Jev decision rerank enabled.');
        }
        if (dependencies.getSingleEmbedding) {
            this.getSingleEmbedding = dependencies.getSingleEmbedding;
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
        const configuredJevMaxChoices = parseInt(process.env.JevRerankMaxChoices, 10);
        const configuredJevMaxDocumentChars = parseInt(process.env.JevRerankMaxDocumentChars, 10);
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
            jevPrompt: process.env.JevRerankPrompt
                || '请选择最值得用于回答当前查询的记忆。请综合考虑逻辑关联、记忆叙事连续性与信息解释力；优先选择能直接回答问题、补足关键背景或维持事件连续性的内容，压低表面词汇重合、重复、跑题或缺乏上下文价值的内容。',
            jevMaxChoices: Number.isFinite(configuredJevMaxChoices)
                ? Math.max(2, Math.min(255, configuredJevMaxChoices))
                : 255,
            jevMaxDocumentChars: Number.isFinite(configuredJevMaxDocumentChars)
                ? Math.max(200, Math.min(50000, configuredJevMaxDocumentChars))
                : 6000
        };
    }

    async processToolCall(args) {
        try {
            if (/^(tagmemo[-_](ab|compare)|v91_compare)$/i.test(String(args.command || args.action || ''))) {
                throw new RangeError('TagMemo A/B 已退休，请使用 memory_ab');
            }
            const result = this._isMemoryABRequest(args)
                ? await this.handleMemoryAB(args)
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

    _isMemoryABRequest(args = {}) {
        const command = String(args.command || args.action || '')
            .trim()
            .toLowerCase();
        return [
            'memory_ab', 'memory-ab', 'memory_compare', 'memory_address_ab', 'memory-address-ab'
        ].includes(command);
    }

    async handleSearch(args) {
        return require('./nativeQuery').search.call(this, args);
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
            throw new RangeError('TagMemo V9 retrieval retired; select rivermemo or knn');
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
            `enginemode 仅支持 rivermemo 或 knn，收到 "${value}"`
        );
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

    async handleMemoryAB(args = {}) {
        return require('./nativeQuery').laboratory.call(this, args);
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
    async _handleColdKnowledgeSearch({ query, libraries, k, rerank, jev = false }) {
        if (!this.tdbKnowledgeManager) {
            return '冷知识库（TDBKnowledge）未启用或未注入，无法检索。';
        }
        if (!query || !query.trim()) {
            throw new Error("冷知识库检索的 'query' 不能为空。");
        }

        const normalizedK = Math.max(1, Math.floor(this._parseNumber(k, 5)));
        const rerankOptions = this._parseRerankOptions(rerank);
        const jevOptions = this._parseRerankOptions(jev);
        if (rerankOptions.enabled && jevOptions.enabled) {
            console.warn('[LightMemo] 冷知识检索同时启用 rerank 与 jev；为避免双重费用，本次仅执行 Jev。');
        }
        const refinementEnabled = rerankOptions.enabled || jevOptions.enabled;
        const fetchK = refinementEnabled ? normalizedK * 2 : normalizedK;

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

        if (refinementEnabled && docs.length > 0) {
            docs = docs.slice(0, fetchK);
            docs.forEach((doc, idx) => { doc.retrieval_rank = idx + 1; });
            docs = jevOptions.enabled
                ? await this._jevRerankDocuments(
                    query,
                    docs,
                    normalizedK,
                    jevOptions.rrfOptions
                )
                : await this._rerankDocuments(
                    query,
                    docs,
                    normalizedK,
                    rerankOptions.rrfOptions
                );
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
            if (typeof r.jev_score === 'number' && !isNaN(r.jev_score)) {
                scoreValue = r.jev_score;
                scoreType = 'Jev';
            } else if (typeof r.rerank_score === 'number' && !isNaN(r.rerank_score)) {
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

            if (typeof r.jev_score === 'number' && !isNaN(r.jev_score)) {
                scoreValue = r.jev_score;
                scoreType = 'Jev';
            } else if (typeof r.rerank_score === 'number' && !isNaN(r.rerank_score)) {
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

    _applyRrfFusion(documents, originalK, rrfOptions = null, label = 'Rerank') {
        if (!rrfOptions) {
            return documents.slice(0, originalK);
        }

        const RRF_K = 60;
        const alpha = rrfOptions.alpha ?? 0.5;
        documents.forEach((doc, index) => {
            doc.rerank_rank = index + 1;
            const retrievalRank = doc.retrieval_rank || documents.length;
            doc.rrf_score = alpha * (1 / (RRF_K + doc.rerank_rank))
                + (1 - alpha) * (1 / (RRF_K + retrievalRank));
        });
        documents.sort((left, right) => right.rrf_score - left.rrf_score);
        const finalDocuments = documents.slice(0, originalK);
        console.log(
            `[LightMemo] ${label}+(RRF) completed: ` +
            `${documents.length} -> ${finalDocuments.length} (α=${alpha}).`
        );
        return finalDocuments;
    }

    async _jevRerankDocuments(query, documents, originalK, rrfOptions = null) {
        if (
            !this.jevClient
            || typeof this.jevClient.decide !== 'function'
            || this.jevClient.isConfigured?.() !== true
        ) {
            console.warn('[LightMemo] Jev requested but shared JevClient is not configured. Keeping retrieval order.');
            return documents.slice(0, originalK);
        }
        if (!Array.isArray(documents) || documents.length <= 1) {
            return (documents || []).slice(0, originalK);
        }

        const maxChoices = Math.max(
            2,
            Math.min(255, Number(this.rerankConfig.jevMaxChoices) || 255)
        );
        const maxDocumentChars = Math.max(
            200,
            Number(this.rerankConfig.jevMaxDocumentChars) || 6000
        );
        const refinementWindow = Math.max(1, Math.floor(Number(originalK) || 1) * 2);
        const eligibleDocuments = documents.slice(
            0,
            Math.min(maxChoices, refinementWindow)
        );
        const criteria = {};
        const documentByChoice = new Map();

        eligibleDocuments.forEach((document, index) => {
            const choiceId = `doc_${String(index).padStart(3, '0')}`;
            const text = String(document?.text || '').trim();
            const boundedText = text.length > maxDocumentChars
                ? `${text.substring(0, maxDocumentChars)}…`
                : text;
            criteria[choiceId] = [
                `候选记忆 ${index + 1}`,
                document?.dbName ? `日记本: ${document.dbName}` : null,
                document?.sourceFile ? `路径: ${document.sourceFile}` : null,
                `内容:\n${boundedText}`
            ].filter(Boolean).join('\n');
            documentByChoice.set(choiceId, document);
        });

        try {
            const response = await this.jevClient.decide(
                {
                    task: 'lightmemo_memory_rerank',
                    query: String(query || ''),
                    candidate_count: eligibleDocuments.length
                },
                {
                    best_memory: {
                        type: 'choice',
                        instructions: this.rerankConfig.jevPrompt,
                        criteria
                    }
                }
            );
            const answer = response?.answers?.best_memory;
            const probabilities = answer?.probabilities;
            if (!probabilities || typeof probabilities !== 'object') {
                throw new Error('Jev choice response is missing probabilities.');
            }

            const reranked = Array.from(documentByChoice.entries())
                .map(([choiceId, document], index) => ({
                    ...document,
                    rerank_score: Number(probabilities[choiceId]) || 0,
                    jev_score: Number(probabilities[choiceId]) || 0,
                    jev_choice: choiceId,
                    jev_selected: answer.choice === choiceId,
                    jev_confidence: Number(answer.confidence) || 0,
                    rerank_failed: false,
                    _jevStableIndex: index
                }))
                .sort((left, right) =>
                    (right.jev_score - left.jev_score)
                    || (Number(right.jev_selected) - Number(left.jev_selected))
                    || (left._jevStableIndex - right._jevStableIndex)
                );
            reranked.forEach(document => {
                delete document._jevStableIndex;
            });

            const finalDocuments = this._applyRrfFusion(
                reranked,
                originalK,
                rrfOptions,
                'Jev'
            );
            console.log(
                `[LightMemo] Jev rerank completed: ${eligibleDocuments.length} -> ` +
                `${finalDocuments.length}, selected=${answer.choice || 'unknown'}, ` +
                `confidence=${Number(answer.confidence || 0).toFixed(4)}.`
            );
            return finalDocuments;
        } catch (error) {
            console.error('[LightMemo] Jev rerank failed; keeping retrieval order:', error.message);
            return documents.slice(0, originalK);
        }
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
        const refinementWindow = Math.max(1, Math.floor(Number(originalK) || 1) * 2);
        const validDocuments = documents
            .slice(0, refinementWindow)
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
