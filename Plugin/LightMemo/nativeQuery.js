'use strict';

function parseRequest(plugin, args) {
    const parsed = plugin._parseMaidScopedFolder(args.maid);
    const folder = plugin._mergeFolderScopes(args.folder, parsed.folder);
    const originalQuery = String(args.query || '').trim();
    if (!originalQuery) throw new Error('LightMemo 需要 query 参数。');
    const music = originalQuery.includes('[音乐检索]');
    let text = originalQuery.replace('[音乐检索]', '').trim();
    const date = value => {
        const parts = value.split(/[-./]/).map(Number);
        return parts[0] * 10000 + parts[1] * 100 + (parts[2] || 1);
    };
    const endDate = value => {
        const parts = value.split(/[-./]/).map(Number);
        return parts[0] * 10000 + parts[1] * 100 + (parts[2] || 31);
    };
    const pattern = /\[\s*(20\d{2}[-./]\d{1,2}(?:[-./]\d{1,2})?)\s*(?:[~到-]\s*(20\d{2}[-./]\d{1,2}(?:[-./]\d{1,2})?))?\s*\]/;
    const match = text.match(pattern);
    const timeRange = match ? { start: date(match[1]), end: endDate(match[2] || match[1]) } : null;
    if (timeRange && timeRange.start > timeRange.end) throw new RangeError('时间区间起点晚于终点。');
    if (match) text = text.replace(match[0], '').trim();
    const searchAll = !music && plugin._parseBoolean(args.search_all_knowledge_bases, false);
    if (!music && !searchAll && !folder && !parsed.maid) {
        throw new Error('必须提供 maid/folder 或显式开启全库搜索。');
    }
    if (typeof args.tag_boost === 'string' && args.tag_boost.trim().endsWith('+')) {
        throw new RangeError('tag_boost 的 + 势场后缀已退休，请提供数值');
    }
    const k = Math.min(1000, Math.max(1, Math.floor(plugin._parseNumber(args.k, 5))));
    const mode = plugin._parseEngineMode(args.engineMode ?? args.enginemode
        ?? args.memoryEngine ?? args.memory_engine);
    return {
        text: text || parsed.maid || folder || '记录',
        originalQuery, k, mode,
        scope: {
            searchAll, folders: music ? ['MusicDiary'] : (folder || '').split(',').filter(Boolean),
            maid: music ? '' : String(parsed.maid || ''),
            excludedFolders: plugin.excludedFolders, includeMusic: music, timeRange
        },
        useBM25: !music && plugin._parseBooleanAlias([
            ['BM25', args.BM25], ['bm25', args.bm25], ['use_bm25', args.use_bm25]
        ], true, 'BM25'),
        coreTags: plugin._parseStringArray(args.core_tags ?? args.coreTags),
        tagBoost: Math.max(0, plugin._parseNumber(args.tag_boost, 0.5)),
        coreBoostFactor: Math.max(0, plugin._parseNumber(args.core_boost_factor, 1.33))
    };
}

async function execute(plugin, request, args, { ab = false, topK = request.k } = {}) {
    const manager = plugin.vectorDBManager;
    if (typeof manager?.executeLightMemoQuery !== 'function') {
        const error = new Error('LIGHTMEMO_NATIVE_QUERY_UNAVAILABLE: 请更新匹配的 Rust 模块与 KBM');
        error.code = 'LIGHTMEMO_NATIVE_QUERY_UNAVAILABLE';
        throw error;
    }
    const raw = await plugin.getSingleEmbedding(request.text);
    if (!raw) throw new Error('查询内容向量化失败。');
    const vector = raw instanceof Float32Array ? raw : new Float32Array(raw);
    const tokens = request.useBM25 ? plugin._tokenize(request.text) : [];
    const candidateK = ab
        ? Math.min(100, Math.max(topK, Math.floor(plugin._parseNumber(args.candidate_k ?? args.candidateK, 30))))
        : Math.min(2000, Math.max(topK, 256));
    return manager.executeLightMemoQuery(
        { text: request.text, vector },
        {
            scope: request.scope, engineMode: request.mode, k: topK, candidateK,
            abMode: ab, useBm25: request.useBM25 && (ab || request.mode !== 'knn'),
            queryTokens: [...new Set([...tokens, ...plugin._expandQueryTokens(tokens)])],
            coreTags: request.coreTags, sourceObservationConfig: {
                baseTagBoost: request.tagBoost, coreBoostFactor: request.coreBoostFactor
            }
        }
    );
}

async function search(args) {
    const cold = this._detectColdKnowledgeRoute(args.query, args.knowledge_base);
    if (cold) return this._handleColdKnowledgeSearch({
        query: cold.query, libraries: cold.libraries, k: args.k,
        rerank: args.rerank, jev: args.jev
    });
    const request = parseRequest(this, args);
    const rerank = this._parseRerankOptions(args.rerank);
    const jev = this._parseRerankOptions(args.jev);
    const topK = Math.min(1000, (rerank.enabled || jev.enabled) ? request.k * 2 : request.k);
    const response = await execute(this, request, args, { topK });
    let results = response.results;
    results.forEach((item, index) => { item.retrieval_rank = index + 1; });
    if (jev.enabled) results = await this._jevRerankDocuments(request.text, results, request.k, jev.rrfOptions);
    else if (rerank.enabled) results = await this._rerankDocuments(request.text, results, request.k, rerank.rrfOptions);
    else results = results.slice(0, request.k);
    const ai = this._parseAIMemoOptions(args.aimemo, args.aimemo_preset);
    if (ai.enabled && results.length) {
        const summary = await this._summarizeWithAIMemo({
            results, query: request.text, presetName: ai.presetName,
            cacheSalt: JSON.stringify({
                scope: request.scope, mode: request.mode, k: request.k,
                coreTags: request.coreTags, tagBoost: request.tagBoost,
                coreBoostFactor: request.coreBoostFactor, useBM25: request.useBM25,
                rerank: args.rerank, jev: args.jev,
                databaseGeneration: response.diagnostics?.databaseGeneration,
                artifactSig: response.river?.artifactSig
            })
        });
        if (summary) return summary;
    }
    return this.formatResults(results, request.originalQuery);
}

async function laboratory(args = {}) {
    const request = parseRequest(this, args);
    if (request.k > 100) throw new RangeError('实验室 k 最大为 100。');
    const response = await execute(this, request, args, { ab: true, topK: request.k });
    const pool = response.comparisonPool;
    const compare = this._parseBoolean(args.compare_rerank ?? args.compareRerank, true);
    let external = [];
    if (compare && pool.length) {
        // Explicit laboratory override: rank the complete shared pool, not the regular 2*K window.
        const ranked = await this._rerankDocuments(request.text, pool.map(item => ({ ...item })),
            pool.length);
        external = ranked.filter(item => item.rerank_failed !== true
            && Number.isFinite(item.rerank_score)).slice(0, request.k);
    }
    const tracks = [
        ['TDB 向量基线', response.tdbTopK],
        ['Rerank', external],
        ['RiverMemo V3', response.river?.results || []]
    ];
    const rows = new Map();
    tracks.forEach(([, items]) => items.forEach(item => rows.set(Number(item.id ?? item.chunkId), item)));
    let output = '# LightMemo 三轨实验室\n\n';
    output += `- 查询：${this._escapeMarkdownCell(request.originalQuery)}\n`;
    output += `- 共同候选：${pool.length}；Top-K：${request.k}；同快照、同过滤边界。\n`;
    output += '- TDB 按原件余弦排序；比较排序/读出，不代表全库精确召回率。\n';
    output += `- Rerank：${external.length ? '获得有效外部评分' : '关闭、未配置或失败；不冒充回退评分'}。\n`;
    output += '- BM25：候选内子串词频证据，不是全库倒排召回。\n\n';
    output += '| Chunk | 摘要 | TDB 向量基线 | Rerank | RiverMemo V3 |\n|---:|---|---:|---:|---:|\n';
    for (const [id, item] of rows) {
        const cells = tracks.map(([, items], track) => {
            const index = items.findIndex(item => Number(item.id ?? item.chunkId) === id);
            if (index < 0) return '—';
            const score = track === 1 ? items[index].rerank_score
                : track === 0 ? items[index].vectorScore : items[index].score;
            return `#${index + 1} / ${Number(score).toFixed(4)}`;
        });
        output += `| ${id} | ${this._escapeMarkdownCell(String(item.text || '').replace(/\s+/g, ' ').slice(0, 100))} | ${cells.join(' | ')} |\n`;
    }
    return output;
}

module.exports = { search, laboratory };