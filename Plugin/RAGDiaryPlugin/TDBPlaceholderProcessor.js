// Plugin/RAGDiaryPlugin/TDBPlaceholderProcessor.js
//
// 🧊 TDB 冷知识库占位符适配层
//
// 职责：解析 [[xx知识库]] / 《《xx知识库》》 两类占位符，复用 RAGDiaryPlugin 已有的
//       向量化、Rerank、VCPInfo 广播能力，调用 TDBKnowledgeManager 的检索管线。
//
// 设计原则：
//   1. 只做"占位符外壳 + TDB 专业检索管线"，不继承日记本的 TagMemo / Associate / Time 等热记忆语义。
//   2. 支持 :K、::Rerank、::Rerank+0.7、::TruncateX、::Expand、::BM25、::BM25+ 后缀，其余修饰符静默忽略。
//      注意：冷知识库没有日记本 Tag 行语义，::BM25 / ::BM25+ 均只作用于 chunk 全文文本索引。
//   3. VCPInfo 推送复用 RAGDiaryPlugin 的 RAG_RETRIEVAL_DETAILS 格式，做到前端二次兼容（无需前端二次开发）。
//   4. 不复用 VCP_RAG_BLOCK_START 自描述块标记，避免被日记本的 RAG 记忆刷新逻辑（refreshRagBlock）误劫持。

const path = require('path');
const fs = require('fs').promises;
const BM25QueryOptimizer = require('./BM25QueryOptimizer.js');

const DEFAULT_TDB_THRESHOLD = 0.30; // 《《》》门控的默认相似度阈值（冷知识库通常比日记本更宽松）

class TDBPlaceholderProcessor {
    /**
     * @param {object} host - RAGDiaryPlugin 实例，复用其向量化 / Rerank / 广播 / 缓存能力
     */
    constructor(host) {
        this.host = host;
        this.tdbKnowledgeManager = null;

        // 库名增强向量缓存：libraryName -> { nameVector, enhancedVector, threshold }
        this.libraryConfig = {};        // 从 tdb_tags.json 加载的 { 库名: { threshold, tags, description } }
        this.libraryVectorCache = new Map();

        // 🔎 冷知识库 BM25 查询优化器：仅优化传给 TDB 文本索引的 chunk 全文查询，不引入日记本 Tag 语义。
        this.bm25QueryOptimizer = new BM25QueryOptimizer({ logger: console });
    }

    /**
     * 注入 TDB 冷知识库管理器（由 RAGDiaryPlugin.initialize 透传）
     */
    setTdbKnowledgeManager(manager) {
        this.tdbKnowledgeManager = manager;
    }

    isEnabled() {
        return !!(this.tdbKnowledgeManager && this.tdbKnowledgeManager.initialized);
    }

    /**
     * 可选加载 tdb_tags.json（与 rag_tags.json 同目录），用于 《《》》 门控的阈值与增强向量。
     * 结构示例：
     * {
     *   "VCP知识": { "threshold": 0.32, "tags": ["VCP系统","插件开发"], "description": "..." }
     * }
     */
    async loadConfig() {
        const configPath = path.join(__dirname, 'tdb_tags.json');
        try {
            const data = await fs.readFile(configPath, 'utf-8');
            this.libraryConfig = JSON.parse(data);
            console.log(`[TDBPlaceholder] ✅ 已加载 tdb_tags.json，共 ${Object.keys(this.libraryConfig).length} 个库配置。`);
        } catch (e) {
            if (e.code === 'ENOENT') {
                console.log('[TDBPlaceholder] 未找到 tdb_tags.json，《《》》门控将使用默认阈值与纯库名向量。');
            } else {
                console.warn('[TDBPlaceholder] 加载 tdb_tags.json 失败:', e.message);
            }
            this.libraryConfig = {};
        }
    }

    // ────────────────────────────────────────────────────────────
    // 后缀解析（仅五个有效后缀，其余忽略）
    // ────────────────────────────────────────────────────────────

    /**
     * 解析允许的后缀修饰符。
     * 支持：
     *   :K            → topK（如 :8）
     *   ::Rerank      → 标准精排
     *   ::Rerank+0.7  → RRF 融合（α=0.7）
     *   ::TruncateX   → 分数阈值过滤（如 ::Truncate0.35）
     *   ::Expand      → 父文档展开
     *   ::BM25        → 优化 TDB 文本侧查询（chunk 全文）
     *   ::BM25+       → 同 ::BM25；冷知识库无 Tag 行，仍只匹配 chunk 全文
     */
    _parseModifiers(modifiers, defaultK) {
        const mod = modifiers || '';

        // K：第一个独立 :数字（不含 ::），与日记本 _extractKMultiplier 习惯一致但此处直接作为 topK
        let k = defaultK;
        const kMatch = mod.match(/(?:^|[^:]):(\d+)(?![\d.])/);
        if (kMatch) {
            const parsed = parseInt(kMatch[1], 10);
            if (Number.isFinite(parsed) && parsed > 0) k = parsed;
        }

        // Rerank+ (RRF)
        const rerankPlusMatch = mod.match(/::Rerank\+(\d+\.?\d*)?/);
        const useRerankPlus = !!rerankPlusMatch;
        const rrfAlpha = useRerankPlus
            ? (rerankPlusMatch[1] ? Math.min(1.0, Math.max(0.0, parseFloat(rerankPlusMatch[1]))) : 0.5)
            : null;
        const useRerank = /::Rerank/.test(mod);

        // Truncate
        const truncateMatch = mod.match(/::Truncate(\d+\.?\d*)/);
        const truncateThreshold = truncateMatch ? parseFloat(truncateMatch[1]) : 0;

        // Expand
        const useExpand = /::Expand/.test(mod);

        // BM25：冷知识库没有 Tag 行，::BM25 / ::BM25+ 均只用于 chunk 全文文本索引查询优化。
        const bm25Match = mod.match(/::BM25(\+)?(?:\d*\.?\d+)?(?=$|::|[^\d.])/i);
        const useBM25 = !!bm25Match;
        const useBM25Plus = !!(bm25Match && bm25Match[1]);

        return { k, useRerank, useRerankPlus, rrfAlpha, truncateThreshold, useExpand, useBM25, useBM25Plus, bm25Mode: useBM25 ? 'body' : null };
    }

    /**
     * 解析库名：支持 | 聚合多库。
     * "VCP知识" -> ["VCP知识"]
     * "VCP知识|插件规范" -> ["VCP知识", "插件规范"]
     */
    _parseLibraryNames(rawName) {
        return String(rawName || '')
            .split('|')
            .map(s => s.trim())
            .filter(Boolean);
    }

    // ────────────────────────────────────────────────────────────
    // 《《》》门控：库名/增强向量相似度
    // ────────────────────────────────────────────────────────────

    async _getLibraryVectors(libraryName) {
        if (this.libraryVectorCache.has(libraryName)) {
            return this.libraryVectorCache.get(libraryName);
        }

        const conf = this.libraryConfig[libraryName] || {};
        const texts = [libraryName];

        // 增强文本：库名 + 描述 + tags（若配置）
        let enhancedText = null;
        if (Array.isArray(conf.tags) && conf.tags.length > 0) {
            enhancedText = `${libraryName} 的相关主题：${conf.tags.join(', ')}`;
            if (conf.description) enhancedText += `。${conf.description}`;
            texts.push(enhancedText);
        } else if (conf.description) {
            enhancedText = `${libraryName}。${conf.description}`;
            texts.push(enhancedText);
        }

        let nameVector = null;
        let enhancedVector = null;
        try {
            nameVector = await this.host.getSingleEmbeddingCached(libraryName);
            if (enhancedText) {
                enhancedVector = await this.host.getSingleEmbeddingCached(enhancedText);
            }
        } catch (e) {
            console.warn(`[TDBPlaceholder] 库名向量化失败 "${libraryName}":`, e.message);
        }

        const entry = {
            nameVector,
            enhancedVector,
            threshold: typeof conf.threshold === 'number' ? conf.threshold : DEFAULT_TDB_THRESHOLD
        };
        this.libraryVectorCache.set(libraryName, entry);
        return entry;
    }

    /**
     * 计算查询向量对一组库的最高相似度，以及这组库的平均阈值。
     */
    async _computeGate(queryVector, libraryNames) {
        let maxSim = 0;
        let totalThreshold = 0;
        let count = 0;

        for (const name of libraryNames) {
            const { nameVector, enhancedVector, threshold } = await this._getLibraryVectors(name);
            totalThreshold += threshold;
            count++;

            if (nameVector) {
                maxSim = Math.max(maxSim, this.host.cosineSimilarity(queryVector, nameVector));
            }
            if (enhancedVector) {
                maxSim = Math.max(maxSim, this.host.cosineSimilarity(queryVector, enhancedVector));
            }
        }

        const avgThreshold = count > 0 ? totalThreshold / count : DEFAULT_TDB_THRESHOLD;
        return { maxSim, avgThreshold };
    }

    // ────────────────────────────────────────────────────────────
    // 核心检索
    // ────────────────────────────────────────────────────────────

    _normalizeBM25QueryInput(text) {
        const processor = this.host?.directDiaryTextProcessor;
        if (processor && typeof processor.normalizeBM25QueryInput === 'function') {
            return processor.normalizeBM25QueryInput(text);
        }

        return String(text || '')
            .replace(/\{\{.*?\}\}/gs, ' ')
            .replace(/\[\[.*?\]\]/gs, ' ')
            .replace(/<<.*?>>/gs, ' ')
            .replace(/《《.*?》》/gs, ' ')
            .replace(/<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g, ' ')
            .replace(/「始」[\s\S]*?「末」/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _tokenizeBM25Query(text) {
        const processor = this.host?.directDiaryTextProcessor;
        if (processor && typeof processor.tokenize === 'function') {
            return processor.tokenize(text);
        }

        return String(text || '')
            .toLowerCase()
            .match(/[\u4e00-\u9fff]{2,}|[a-z_][a-z0-9_.:/@#-]{1,}|\d+(?:\.\d+)*/gi) || [];
    }

    _buildTdbBM25QueryText(queryText, opts) {
        if (!opts.useBM25) {
            return {
                queryText,
                queryTokens: [],
                selectedTerms: [],
                optimized: false
            };
        }

        try {
            const config = this.host?.ragParams?.RAGDiaryPlugin || {};
            const optimized = this.bm25QueryOptimizer.createQueryText({
                userText: queryText,
                aiText: '',
                baseWeights: [1, 0],
                normalize: (text) => this._normalizeBM25QueryInput(text),
                tokenize: (text) => this._tokenizeBM25Query(text),
                options: config.bm25QueryOptimizer || {}
            });

            if (optimized.queryText) {
                console.log(
                    `[TDBPlaceholder] BM25 chunk query optimized: ` +
                    `tokens=${optimized.queryTokens.length}, terms=${optimized.selectedTerms.length}, ` +
                    `mode=body${opts.useBM25Plus ? '+' : ''}`
                );
                return {
                    ...optimized,
                    optimized: true
                };
            }
        } catch (e) {
            console.warn('[TDBPlaceholder] BM25 查询优化失败，使用原始 queryText:', e.message);
        }

        return {
            queryText: this._normalizeBM25QueryInput(queryText) || queryText,
            queryTokens: [],
            selectedTerms: [],
            optimized: false
        };
    }

    /**
     * 执行 TDB 检索 + 可选 Rerank + Truncate。返回 { results, opts }。
     */
    async _retrieve(queryVector, queryText, libraryNames, opts) {
        const { k, useRerank, useRerankPlus, rrfAlpha, truncateThreshold, useExpand } = opts;

        // Rerank 时多取候选
        const fetchK = useRerank
            ? Math.max(k, Math.round(k * (this.host.rerankConfig?.multiplier || 2.0)))
            : k;

        const sparseQuery = this._buildTdbBM25QueryText(queryText, opts);
        opts.bm25QueryTokens = sparseQuery.queryTokens || [];
        opts.bm25OptimizedQuery = sparseQuery.queryText;
        opts.useBM25Optimizer = !!sparseQuery.optimized;

        let hits = await this.tdbKnowledgeManager.searchWithVector(queryVector, sparseQuery.queryText, {
            libraries: libraryNames,
            topK: fetchK,
            expandDepth: 1,
            minScore: 0.1,
            hybridAlpha: 0.65,
            expand: useExpand
        });

        if (!hits || hits.length === 0) return [];

        // 复用 RAGDiaryPlugin 的 Rerank（含 RRF 融合）
        if (useRerank && hits.length > 0) {
            hits.forEach((doc, idx) => { doc.retrieval_rank = idx + 1; });
            const rrfOpts = useRerankPlus ? { alpha: rrfAlpha } : null;
            try {
                hits = await this.host._rerankDocuments(queryText, hits, k, rrfOpts);
            } catch (e) {
                console.warn('[TDBPlaceholder] Rerank 失败，使用原始排序:', e.message);
                hits = hits.slice(0, k);
            }
        } else {
            hits = hits.slice(0, k);
        }

        // Truncate：分数阈值过滤
        if (truncateThreshold > 0) {
            const before = hits.length;
            hits = hits.filter(r => (r.rerank_score ?? r.score ?? 0) >= truncateThreshold);
            if (before !== hits.length) {
                console.log(`[TDBPlaceholder] Truncate applied: ${before} -> ${hits.length} (阈值 ${truncateThreshold})`);
            }
        }

        return hits;
    }

    // ────────────────────────────────────────────────────────────
    // VCPInfo 广播（复用 RAG_RETRIEVAL_DETAILS，前端二次兼容）
    // ────────────────────────────────────────────────────────────

    /**
     * 推送 VCPInfo。沿用 RAGDiaryPlugin 的 RAG_RETRIEVAL_DETAILS schema，
     * 让前端 TagMemo 可视化面板无需任何二次开发即可渲染冷知识库召回。
     * 额外附带 sourceType / libraries 字段，老前端忽略、新前端可选用。
     */
    _broadcast(libraryNames, queryForDisplay, opts, hits) {
        if (!this.host.pushVcpInfo) return;

        const dbName = libraryNames.join(' + ');

        // 与日记本结果结构对齐：text / score / source / matchedTags
        const cleanedResults = (hits || []).slice(0, 20).map(r => {
            const cleaned = {
                text: r.text || '',
                score: r.rerank_score ?? r.score ?? undefined,
                source: 'tdb',
            };
            // 来源文件作为可读标签，复用 matchedTags 字段以便前端原样展示
            const tags = [];
            if (r.library) tags.push(r.library);
            if (r.sourceFile) tags.push(r.sourceFile);
            if (tags.length > 0) cleaned.matchedTags = tags;
            return cleaned;
        });

        const payload = {
            type: 'RAG_RETRIEVAL_DETAILS',
            dbName: dbName,
            query: queryForDisplay,
            k: opts.k,
            useTime: false,
            useGroup: false,
            useRerank: opts.useRerank,
            useRerankPlus: opts.useRerankPlus,
            rrfAlpha: opts.rrfAlpha,
            useGeodesicRerank: false,
            useExpand: opts.useExpand,
            useAssociate: false,
            useBM25: opts.useBM25,
            bm25Mode: opts.bm25Mode,
            bm25QueryTokens: opts.bm25QueryTokens,
            bm25OptimizedQuery: opts.bm25OptimizedQuery,
            useBM25Optimizer: opts.useBM25Optimizer,
            useTagMemo: false,
            tagWeight: null,
            coreTags: [],
            results: cleanedResults,
            // ── 二次兼容扩展字段（老前端忽略，新前端可识别为冷知识库来源）──
            sourceType: 'TDBKnowledge',
            libraries: libraryNames
        };

        try {
            this.host.pushVcpInfo(payload);
        } catch (e) {
            console.error('[TDBPlaceholder] VCPInfo broadcast failed:', e.message || e);
            try {
                this.host.pushVcpInfo({
                    type: 'RAG_RETRIEVAL_DETAILS',
                    dbName,
                    sourceType: 'TDBKnowledge',
                    error: 'Detailed stats broadcast failed: ' + (e.message || 'Unknown error')
                });
            } catch (_) { }
        }
    }

    // ────────────────────────────────────────────────────────────
    // 循环占位符防护
    // ────────────────────────────────────────────────────────────

    /**
     * 清理知识库召回内容中的递归占位符。
     * 防止“知识库展开日记本 / 日记本展开知识库”形成跨系统循环注入。
     */
    _sanitizeNestedPlaceholders(text) {
        return String(text || '')
            .replace(/\[\[.*日记本.*\]\]/g, '[循环占位符已移除]')
            .replace(/<<.*日记本.*>>/g, '[循环占位符已移除]')
            .replace(/《《.*日记本.*》》/g, '[循环占位符已移除]')
            .replace(/\{\{.*日记本.*\}\}/g, '[循环占位符已移除]')
            .replace(/\[\[.*知识库.*\]\]/g, '[循环占位符已移除]')
            .replace(/《《.*知识库.*》》/g, '[循环占位符已移除]');
    }

    // ────────────────────────────────────────────────────────────
    // 格式化输出（不使用 VCP_RAG_BLOCK_START，避免被记忆刷新劫持）
    // ────────────────────────────────────────────────────────────

    _format(libraryNames, queryForDisplay, hits) {
        const scope = libraryNames.join(', ');
        if (!hits || hits.length === 0) {
            return `\n[--- TDB 冷知识库检索 (${scope}) ---]\n关于"${queryForDisplay}"，未找到相关知识片段。\n[--- 知识库检索结束 ---]\n`;
        }

        let out = `\n[--- TDB 冷知识库检索 ---]\n`;
        out += `[知识库范围: ${scope}]\n`;
        out += `[找到 ${hits.length} 条相关知识片段:]\n`;

        for (const r of hits) {
            const score = r.rerank_score ?? r.score;
            const scoreDisplay = (typeof score === 'number' && score > 0)
                ? `${(score * 100).toFixed(1)}%`
                : 'N/A';
            out += `--- (来源: ${r.library || scope}, 相关性: ${scoreDisplay})\n`;
            if (r.sourceFile) out += `    [路径: ${r.sourceFile}]\n`;
            out += `${this._sanitizeNestedPlaceholders(r.text).trim()}\n`;
        }

        out += `[--- 知识库检索结束 ---]\n`;
        return out;
    }

    // ────────────────────────────────────────────────────────────
    // 对外入口：处理单条占位符
    // ────────────────────────────────────────────────────────────

    /**
     * 处理 [[xx知识库]] 直接检索。
     * @returns {Promise<string>} 替换内容
     */
    async processDirect(rawName, modifiers, queryVector, queryForDisplay, defaultK) {
        if (!this.isEnabled()) {
            console.warn('[TDBPlaceholder] TDB 冷知识库未启用，跳过 [[知识库]] 检索。');
            return '';
        }

        const libraryNames = this._parseLibraryNames(rawName);
        if (libraryNames.length === 0) return '';

        const opts = this._parseModifiers(modifiers, defaultK || 5);

        try {
            const hits = await this._retrieve(queryVector, queryForDisplay, libraryNames, opts);
            this._broadcast(libraryNames, queryForDisplay, opts, hits);
            return this._format(libraryNames, queryForDisplay, hits);
        } catch (e) {
            console.error(`[TDBPlaceholder] [[${rawName}知识库]] 检索失败:`, e.message);
            return `[冷知识库检索失败: ${e.message}]`;
        }
    }

    /**
     * 处理 《《xx知识库》》 门控检索：先判定相关度，过阈值才注入。
     * @returns {Promise<string>} 替换内容（不相关则为空字符串）
     */
    async processHybrid(rawName, modifiers, queryVector, queryForDisplay, defaultK) {
        if (!this.isEnabled()) {
            console.warn('[TDBPlaceholder] TDB 冷知识库未启用，跳过 《《知识库》》 检索。');
            return '';
        }

        const libraryNames = this._parseLibraryNames(rawName);
        if (libraryNames.length === 0) return '';

        const opts = this._parseModifiers(modifiers, defaultK || 5);

        try {
            // 门控：库名/增强向量相似度
            const { maxSim, avgThreshold } = await this._computeGate(queryVector, libraryNames);

            // Truncate 后缀也可抬高门控阈值
            const effectiveThreshold = Math.max(avgThreshold, opts.truncateThreshold || 0);

            if (maxSim < effectiveThreshold) {
                console.log(`[TDBPlaceholder] 《《${rawName}知识库》》 门控未通过: 相似度 ${maxSim.toFixed(4)} < 阈值 ${effectiveThreshold.toFixed(4)}，跳过注入。`);
                return '';
            }

            console.log(`[TDBPlaceholder] 《《${rawName}知识库》》 门控通过: ${maxSim.toFixed(4)} >= ${effectiveThreshold.toFixed(4)}，开始检索...`);

            const hits = await this._retrieve(queryVector, queryForDisplay, libraryNames, opts);
            this._broadcast(libraryNames, queryForDisplay, opts, hits);
            return this._format(libraryNames, queryForDisplay, hits);
        } catch (e) {
            console.error(`[TDBPlaceholder] 《《${rawName}知识库》》 检索失败:`, e.message);
            return `[冷知识库检索失败: ${e.message}]`;
        }
    }
}

module.exports = TDBPlaceholderProcessor;