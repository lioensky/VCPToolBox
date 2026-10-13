'use strict';

// Keep AnySearch's native route fields intact; do not invent a second batch DSL.
async function buildAnySearchArgs(parsed, resolveLegacy, explicit = null) {
    const args = explicit ? structuredClone(explicit) : {};
    if (explicit && (parsed.primary.length || parsed.constraints.length || parsed.imageUrls.length)) throw new Error('JEV AnySearch 使用 JEVArgs 时不要重复提供正文或筛选参数。');
    const remaining = [];
    const aliases = { 操作: 'command', 命令: 'command', action: 'command', 数量: 'max_results', count: 'max_results', limit: 'max_results', 区域: 'zone', 领域: 'domain', 子域: 'sub_domain', 参数: 'params' };
    const put = (key, value) => {
        if (Object.hasOwn(args, key)) throw new Error(`JEV AnySearch 参数 ${key} 重复。`);
        args[key] = value;
    };
    if (!explicit) {
        for (const value of parsed.constraints) {
            const match = value.match(/^([^:：]+)[:：]\s*([\s\S]+)$/);
            if (match) put(aliases[match[1].trim()] || match[1].trim(), match[2].trim());
            else if (/^\d+\s*(条|项|个)$/.test(value)) put('max_results', value.match(/^\d+/)[0]);
            else remaining.push(value);
        }
        if (!args.command) {
            if (/查询子域|子域目录/.test(parsed.intentText)) args.command = 'get_sub_domains';
            else if (/提取正文/.test(parsed.intentText)) args.command = 'extract';
            else if (/批量搜索/.test(parsed.intentText)) args.command = 'batch_search';
        }
        if (parsed.imageUrls.length) {
            if (parsed.imageUrls.length !== 1) throw new Error('JEV AnySearch 正文提取一次只接受一个 URL。');
            put('url', parsed.imageUrls[0]);
        }
    }
    args.command ||= args.queries !== undefined ? 'batch_search' : args.url ? 'extract' : 'search';
    if (!['search', 'batch_search', 'get_sub_domains', 'extract'].includes(args.command)) throw new Error('JEV AnySearch 操作无效。');
    if (!explicit && parsed.primary.length) {
        const key = { get_sub_domains: 'domain', extract: 'url', batch_search: 'queries', search: 'query' }[args.command];
        put(key, parsed.primary.join(' '));
    }
    const search = ['search', 'batch_search'].includes(args.command);
    if (remaining.length) {
        if (remaining.some(value => /^(?:(?:最近|过去|近).*(?:天|周|月|年)|(?:19|20)\d{2}(?:年|年至今)?)$/.test(value))) throw new Error('JEV AnySearch 没有通用日期过滤；请选择支持日期参数的子域，并在params中明确传递。');
        if (!search || Object.keys(args).some(k => /^(sub_domain|params|queries|query\d)/.test(k))) throw new Error(`JEV AnySearch 请将 [${remaining[0]}] 写为明确参数。`);
        const legacy = await resolveLegacy(args.query || '', remaining);
        for (const [key, value] of Object.entries(legacy)) put(key, value);
    }
    const numbered = /^(query|sub_domain|zone|params|max_results)([1-5])$/;
    const allowed = search ? ['command', 'query', 'queries', 'domain', 'sub_domain', 'params', 'zone', 'max_results'] : args.command === 'extract' ? ['command', 'url'] : ['command', 'domain', 'domains'];
    for (const [key, value] of Object.entries(args)) {
        if (!allowed.includes(key) && !(search && numbered.test(key))) throw new Error(`JEV AnySearch 当前操作不支持 ${key}。`);
        if (value === null || value === undefined || typeof value === 'string' && !value.trim()) throw new Error(`JEV AnySearch ${key} 不能为空。`);
        if (/^max_results\d?$/.test(key) && (!/^\d+$/.test(String(value)) || +value < 1 || +value > 10)) throw new Error('JEV AnySearch 数量必须为 1–10。');
        if (/^zone\d?$/.test(key) && !['cn', 'intl'].includes(value)) throw new Error('JEV AnySearch zone 只能为 cn/intl。');
        if (/^params\d?$/.test(key) && !(typeof value === 'string' || typeof value === 'object' && !Array.isArray(value))) throw new Error('JEV AnySearch params 必须为参数文本或对象。');
        if (/^sub_domain\d?$/.test(key) && (typeof value !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(value))) throw new Error('JEV AnySearch 子域使用 domain.sub_domain 格式。');
    }
    if (args.command === 'extract') {
        if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url)) throw new Error('JEV AnySearch 提取需要 http(s) URL。');
        return args;
    }
    if (args.command === 'get_sub_domains') {
        if (!!args.domain === !!args.domains) throw new Error('JEV AnySearch 需要 domain 或 domains，不能同时提供。');
        const domains = args.domains === undefined ? [args.domain] : Array.isArray(args.domains) ? args.domains : String(args.domains).split(',');
        if (domains.length > 5 || domains.some(d => typeof d !== 'string' || !/^[a-z_]+$/.test(d.trim()))) throw new Error('JEV AnySearch 领域应为 1–5 个领域标识。');
        return args; // Domain enums and dynamic sub-domain schemas remain owned by the plugin.
    }
    if (args.domain && args.sub_domain && args.domain !== args.sub_domain.split('.')[0]) throw new Error('JEV AnySearch domain 与 sub_domain 不一致。');
    const indexes = [...new Set(Object.keys(args).map(k => k.match(numbered)?.[2]).filter(Boolean))];
    if (args.queries !== undefined) {
        if (indexes.length || args.query !== undefined) throw new Error('JEV AnySearch queries 不能与 query 或编号路线混用。');
        let queries = args.queries;
        if (typeof queries === 'string') {
            if (queries.trim().startsWith('[')) {
                try { queries = JSON.parse(queries); } catch { throw new Error('JEV AnySearch queries JSON 无效。'); }
            } else queries = queries.split('|').map(q => q.trim());
        }
        if (!Array.isArray(queries) || queries.length < 1 || queries.length > 5 || queries.some(q => typeof q !== 'string' || !q.trim())) throw new Error('JEV AnySearch queries 需要 1–5 条非空搜索词；不同参数使用编号路线。');
    } else if (indexes.length) {
        for (const i of indexes) {
            if (!args['query' + i] && !args.query) throw new Error(`JEV AnySearch 路线 ${i} 缺少 query${i} 或公共 query。`);
        }
    } else if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('JEV AnySearch 搜索缺少 query。');
    for (const [key, value] of Object.entries(args)) if (/^query\d?$/.test(key) && typeof value !== 'string') throw new Error(`JEV AnySearch ${key} 必须是字符串。`);
    args.max_results ??= '5';
    return args;
}

module.exports = { buildAnySearchArgs };
