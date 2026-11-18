'use strict';

const { buildQueryTokens } = require('./queryTokens');

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
    const useBm25 = request.useBM25 && (ab || request.mode !== 'knn');
    const { queryTokens, diagnostics: tokenDiagnostics } = buildQueryTokens(
        plugin, request.text, useBm25
    );
    if (tokenDiagnostics.truncated || tokenDiagnostics.invalid) {
        console.warn('[LightMemo] Query keyword budget:', tokenDiagnostics);
    }
    const candidateK = ab
        ? Math.min(100, Math.max(topK, Math.floor(plugin._parseNumber(args.candidate_k ?? args.candidateK, 30))))
        : Math.min(2000, Math.max(topK, 256));
    return manager.executeLightMemoQuery(
        { text: request.text, vector },
        {
            scope: request.scope, engineMode: request.mode, k: topK, candidateK,
            abMode: ab, ...(ab ? { warpedAb: true } : {}),
            useBm25, queryTokens, tokenDiagnostics,
            coreTags: request.coreTags, sourceObservationConfig: {
                baseTagBoost: request.tagBoost, coreBoostFactor: request.coreBoostFactor
            }
        }
    );
}

async function search(args) {
    const original = String(args.query || '');
    if (original.includes('[音乐检索]')) {
        const query = original.replace('[音乐检索]', '').trim();
        if (!query) throw new Error('音乐检索需要查询内容。');
        return this._handleColdKnowledgeSearch({
            query, libraries: ['MusicDiary'], k: args.k, rerank: args.rerank, jev: args.jev
        });
    }
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
    if (!pool.length) {
        console.warn('[LightMemo] Empty AB candidate pool:', JSON.stringify(
            response.diagnostics?.scope || { requested: request.scope, reason: 'native_scope_diagnostics_unavailable' }
        ));
    }
    const compare = this._parseBoolean(args.compare_rerank ?? args.compareRerank, true);
    let external = [];
    if (compare && pool.length) {
        // Explicit laboratory override: rank the complete shared pool, not the regular 2*K window.
        const ranked = await this._rerankDocuments(request.text, pool.map(item => ({ ...item })),
            pool.length);
        external = ranked.filter(item => item.rerank_failed !== true
            && Number.isFinite(item.rerank_score)).slice(0, request.k);
    }
    const compareJev = this._parseBoolean(args.compare_jev ?? args.compareJev, true);
    let jev = [];
    if (compareJev && pool.length) {
        // 独立副本避免 Jev/Rerank 的评分和排序字段污染其他轨道。
        // 实验室使用完整共同池；Jev 自身的 maxChoices 上限仍然有效。
        const ranked = await this._jevRerankDocuments(request.text,
            pool.map((item, index) => ({ ...item, retrieval_rank: index + 1 })),
            pool.length);
        jev = ranked.filter(item => item.rerank_failed !== true
            && Number.isFinite(item.jev_score)).slice(0, request.k);
    }
    const tracks = [
        ['TDB 向量基线', response.tdbTopK, 'vectorScore'],
        ['Rerank', external, 'rerank_score'],
        ['Jev', jev, 'jev_score'],
        ['RiverMemo V3/4 · TDB候选', response.river?.results || [], 'score'],
        ['双曲 Chunk ANN', response.warpedTopK || [], 'warpedScore'],
        ['双曲 RiverMemo V5', response.warpedRiver?.results || [], 'score']
    ];
    const rows = new Map();
    tracks.forEach(([, items]) => items.forEach(item => rows.set(Number(item.id ?? item.chunkId), item)));
    let output = '# LightMemo 六轨实验室\n\n';
    output += `- 查询：${this._escapeMarkdownCell(request.originalQuery)}\n`;
    output += `- 对照并集候选：${pool.length}；Top-K：${request.k}；Chunk 读取同快照、同过滤边界。\n`;
    output += '- 原生 TDB ANN：保留现有 2-bit SM 无图扫描召回及原件余弦排序；双曲 Chunk ANN：全局共享几何，按范围检索，按双曲距离升序（展示负距离，越大越近）。范围内不超过 128 条时走共享几何上的精确扫描，不冒充图导航。\n';
    output += '- 两条 Tag 观测分别准备并校验同资产签名，不保证跨阶段同一 SQL 快照；首次构建或快照恢复成本包含在诊断中；日常成员同步不重建冻结几何。\n';
    output += '- RiverMemo V3/4：TDB 候选 + 现有 Tag/NNLS 观测；双曲 RiverMemo V5：双曲 Chunk 候选 + 双曲 Tag 观测。最终均由现有原生 RiverMemo 读出器重新评分，不沿用 ANN 排名；V5 是生产链路名，不伪造读出算法版本。\n';
    output += '- Rerank/Jev 使用两套召回候选的去重并集；两条 RiverMemo 各用自己的召回池，因此这是端到端对照，不是固定池排序消融。\n';
    output += '- TDB 按原件余弦排序；比较排序/读出，不代表全库精确召回率。\n';
    output += `- Rerank：${external.length ? '获得有效外部评分' : '关闭、未配置或失败；不冒充回退评分'}。\n`;
    output += `- Jev：${jev.length ? '获得有效外部评分' : '关闭、未配置或失败；不冒充回退评分'}；共同池受 JevRerankMaxChoices 上限限制。\n`;
    output += '- BM25：候选内子串词频证据，不是全库倒排召回。\n\n';
    output += '| Chunk | 摘要 | 原生 TDB ANN | Rerank | Jev | RiverMemo V3/4 · TDB候选 | 双曲 Chunk ANN | 双曲 RiverMemo V5 |\n|---:|---|---:|---:|---:|---:|---:|---:|\n';
    for (const [id, item] of rows) {
        const cells = tracks.map(([, items, scoreField]) => {
            const index = items.findIndex(item => Number(item.id ?? item.chunkId) === id);
            if (index < 0) return '—';
            const score = items[index][scoreField];
            return `#${index + 1} / ${Number(score).toFixed(4)}`;
        });
        output += `| ${id} | ${this._escapeMarkdownCell(String(item.text || '').replace(/\s+/g, ' ').slice(0, 100))} | ${cells.join(' | ')} |\n`;
    }
    output += require('./abDiagnostics').formatScopeDiagnostics(this, request, response);
    output += require('./abDiagnostics').formatDiagnostics(this, request, response);
    if (response.recallPools) {
        output += `\n## 双召回对照\n\n- 候选 ID 与交集：${this._escapeMarkdownCell(JSON.stringify(response.recallPools))}\n`;
    }
    output += `\n- Chunk 双曲诊断：${this._escapeMarkdownCell(JSON.stringify(response.diagnostics?.warpedChunks) ?? '未返回；请重建原生模块')}\n`;
    output += `- Tag 双曲诊断：${this._escapeMarkdownCell(JSON.stringify(response.warpedMemoObservation?.diagnostics?.tagRouting) ?? '未返回')}\n`;
    if (response.warpedRiver) {
        output += '\n## 双曲 RiverMemo V5 生产链路\n';
        output += require('./abDiagnostics').formatDiagnostics(this, request, {
            ...response, river: response.warpedRiver,
            memoObservation: response.warpedMemoObservation
        });
    } else {
        output += '\n- V5 未执行或原生未返回；不使用旧 RiverMemo 分数冒充 V5。\n';
    }
    return output;
}

module.exports = { search, laboratory };