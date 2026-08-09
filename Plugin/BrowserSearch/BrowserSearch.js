'use strict';

const crypto = require('crypto');

let pluginConfig = {};
let pluginManager = null;
let transactionTail = Promise.resolve();
let pendingTransactions = 0;

const resultCache = new Map();
const lastEngineRequestAt = new Map();

const SUPPORTED_ENGINES = new Set([
    'auto',
    'google',
    'baidu',
    'bing',
    'bing_cn',
    'bing_global'
]);

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['true', '1', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function parseInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function getConfig() {
    return {
        defaultEngine: String(pluginConfig.BROWSER_SEARCH_DEFAULT_ENGINE || 'auto').trim().toLowerCase(),
        maxResults: parseInteger(pluginConfig.BROWSER_SEARCH_MAX_RESULTS, 10, 1, 30),
        maxBatchQueries: parseInteger(pluginConfig.BROWSER_SEARCH_MAX_BATCH_QUERIES, 6, 1, 20),
        cacheTtlMs: parseInteger(pluginConfig.BROWSER_SEARCH_CACHE_TTL_MS, 120000, 0, 3600000),
        minIntervalMs: parseInteger(pluginConfig.BROWSER_SEARCH_MIN_INTERVAL_MS, 1500, 0, 60000),
        batchLaunchIntervalMs: parseInteger(pluginConfig.BROWSER_SEARCH_BATCH_LAUNCH_INTERVAL_MS, 600, 0, 10000),
        renderWaitMs: parseInteger(pluginConfig.BROWSER_SEARCH_RENDER_WAIT_MS, 1800, 0, 10000),
        closeTabAfterSearch: parseBoolean(pluginConfig.BROWSER_SEARCH_CLOSE_TAB_AFTER_SEARCH, false),
        debugMode: parseBoolean(pluginConfig.DebugMode, false)
    };
}

function initialize(config = {}, dependencies = {}) {
    pluginConfig = config;
    pluginManager = dependencies.pluginManager || null;

    if (getConfig().debugMode) {
        console.log('[BrowserSearch] initialized; ChromeBridge will be resolved lazily');
    }
}

function getChromeBridge() {
    const chromeBridge = pluginManager?.getServiceModule?.('ChromeBridge');
    if (!chromeBridge || typeof chromeBridge.executeManagedCommand !== 'function') {
        throw new Error('BrowserSearch 依赖 ChromeBridge hybridservice，且需要其导出 executeManagedCommand()。请确认 ChromeBridge 已启用并完成加载。');
    }
    return chromeBridge;
}

function containsHanText(value) {
    return /[\u3400-\u9fff]/u.test(String(value || ''));
}

function normalizeMarket(value) {
    const market = String(value || '').trim();
    if (!market) return null;
    if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(market)) {
        throw new Error(`market 格式无效: ${market}`);
    }
    return market;
}

function resolveEngine(requestedEngine, query, market) {
    let engine = String(requestedEngine || getConfig().defaultEngine || 'auto').trim().toLowerCase();
    if (!SUPPORTED_ENGINES.has(engine)) {
        throw new Error(`不支持的搜索引擎: ${engine}。可选值: ${Array.from(SUPPORTED_ENGINES).join(', ')}`);
    }

    const normalizedMarket = normalizeMarket(market);
    if (engine === 'auto') {
        engine = containsHanText(query) ? 'bing_cn' : 'bing_global';
    } else if (engine === 'bing') {
        if (normalizedMarket) {
            engine = normalizedMarket.toLowerCase() === 'zh-cn' ? 'bing_cn' : 'bing_global';
        } else {
            engine = containsHanText(query) ? 'bing_cn' : 'bing_global';
        }
    }

    return { engine, market: normalizedMarket };
}

function buildSearchUrl(engine, query, market, safeSearch, timeRange) {
    let url;
    const normalizedSafeSearch = String(safeSearch || '').trim().toLowerCase();
    const normalizedTimeRange = String(timeRange || '').trim().toLowerCase();

    if (engine === 'google') {
        url = new URL('https://www.google.com/search');
        url.searchParams.set('q', query);
        url.searchParams.set('hl', market?.toLowerCase() === 'zh-cn' ? 'zh-CN' : (market || (containsHanText(query) ? 'zh-CN' : 'en')));
        if (normalizedSafeSearch === 'strict') url.searchParams.set('safe', 'active');
        if (normalizedSafeSearch === 'off') url.searchParams.set('safe', 'off');
        const googleTimeRanges = { day: 'd', week: 'w', month: 'm', year: 'y' };
        if (googleTimeRanges[normalizedTimeRange]) {
            url.searchParams.set('tbs', `qdr:${googleTimeRanges[normalizedTimeRange]}`);
        }
    } else if (engine === 'baidu') {
        url = new URL('https://www.baidu.com/s');
        url.searchParams.set('wd', query);
        if (normalizedTimeRange === 'day') url.searchParams.set('gpc', 'stf=1');
    } else {
        const isChina = engine === 'bing_cn';
        url = new URL(isChina ? 'https://cn.bing.com/search' : 'https://www.bing.com/search');
        url.searchParams.set('q', query);
        url.searchParams.set('mkt', market || (isChina ? 'zh-CN' : 'en-US'));
        url.searchParams.set('setlang', isChina ? 'zh-hans' : String(market || 'en-US'));
        url.searchParams.set('cc', isChina ? 'CN' : marketToCountryCode(market));
        if (normalizedSafeSearch === 'strict') url.searchParams.set('adlt', 'strict');
        if (normalizedSafeSearch === 'moderate') url.searchParams.set('adlt', 'moderate');
        if (normalizedSafeSearch === 'off') url.searchParams.set('adlt', 'off');
        const bingTimeRanges = { day: 'Day', week: 'Week', month: 'Month', year: 'Year' };
        if (bingTimeRanges[normalizedTimeRange]) {
            url.searchParams.set('filters', `ex1:"ez${bingTimeRanges[normalizedTimeRange]}"`);
        }
    }

    return url.toString();
}

function marketToCountryCode(market) {
    const parts = String(market || 'en-US').split('-');
    const country = parts[1];
    return country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : 'US';
}

function buildCacheKey(input) {
    return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function getCachedResult(key) {
    const entry = resultCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        resultCache.delete(key);
        return null;
    }
    return entry.value;
}

function setCachedResult(key, value, ttlMs) {
    if (ttlMs <= 0) return;
    resultCache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs
    });

    if (resultCache.size > 200) {
        const oldestKey = resultCache.keys().next().value;
        resultCache.delete(oldestKey);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function enforceRateLimit(engine, minimumIntervalMs) {
    const lastAt = lastEngineRequestAt.get(engine) || 0;
    const remaining = minimumIntervalMs - (Date.now() - lastAt);
    if (remaining > 0) await sleep(remaining);
    lastEngineRequestAt.set(engine, Date.now());
}

function runExclusive(task) {
    pendingTransactions += 1;
    const run = transactionTail.then(task, task);
    transactionTail = run.catch(() => undefined);
    return run.finally(() => {
        pendingTransactions = Math.max(0, pendingTransactions - 1);
    });
}

function buildExtractionScript(engine, maxResults, renderWaitMs) {
    return `
const engine = ${JSON.stringify(engine)};
const maxResults = ${JSON.stringify(maxResults)};
const renderWaitMs = ${JSON.stringify(renderWaitMs)};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
const absoluteUrl = href => {
    try { return new URL(href, location.href).href; } catch { return ''; }
};
const unwrapGoogleUrl = href => {
    try {
        const parsed = new URL(href, location.href);
        if (parsed.hostname.endsWith('google.com') && parsed.pathname === '/url') {
            return parsed.searchParams.get('q') || parsed.searchParams.get('url') || href;
        }
        return parsed.href;
    } catch { return href; }
};
const blockedPatterns = [
    /captcha/i,
    /unusual traffic/i,
    /verify you are human/i,
    /detected unusual/i,
    /安全验证/,
    /请输入验证码/,
    /网络不给力/,
    /访问受限/,
    /人机验证/
];
const detectBlock = () => {
    const sample = clean([document.title, location.href, document.body?.innerText?.slice(0, 5000)].join(' '));
    const matched = blockedPatterns.find(pattern => pattern.test(sample));
    const captchaElement = document.querySelector(
        'iframe[src*="recaptcha"], iframe[src*="captcha"], #captcha, .captcha, [class*="captcha"], [id*="captcha"]'
    );
    return {
        blocked: Boolean(matched || captchaElement),
        reason: matched ? String(matched) : (captchaElement ? 'captcha_element_detected' : null)
    };
};
const selectors = {
    google: {
        containers: ['div.MjjYud', 'div.g'],
        title: ['h3'],
        link: ['a:has(h3)', 'h3'],
        snippet: ['.VwiC3b', '[data-sncf]', '.IsZvec']
    },
    bing: {
        containers: ['li.b_algo', 'li.b_ans'],
        title: ['h2', 'h3'],
        link: ['h2 a', 'h3 a', 'a'],
        snippet: ['.b_caption p', '.b_snippet', 'p']
    },
    baidu: {
        containers: ['div.result', 'div.c-container', '[tpl="se_com_default"]'],
        title: ['h3', '.t'],
        link: ['h3 a', '.t a', 'a'],
        snippet: ['.c-abstract', '.content-right_8Zs40', '[class*="abstract"]', '.c-span-last']
    }
};
const mode = engine === 'google' ? 'google' : (engine === 'baidu' ? 'baidu' : 'bing');
const config = selectors[mode];
const queryFirst = (root, list) => {
    for (const selector of list) {
        try {
            const found = root.querySelector(selector);
            if (found) return found;
        } catch {}
    }
    return null;
};
const collect = () => {
    const containers = [];
    const seenNodes = new Set();
    for (const selector of config.containers) {
        document.querySelectorAll(selector).forEach(node => {
            if (!seenNodes.has(node)) {
                seenNodes.add(node);
                containers.push(node);
            }
        });
    }
    const results = [];
    const seenUrls = new Set();
    for (const container of containers) {
        const titleNode = queryFirst(container, config.title);
        let linkNode = queryFirst(container, config.link);
        if (linkNode && linkNode.tagName !== 'A') linkNode = linkNode.closest('a');
        const title = clean(titleNode?.innerText || linkNode?.innerText);
        let url = absoluteUrl(linkNode?.href || '');
        if (mode === 'google') url = unwrapGoogleUrl(url);
        if (!title || !/^https?:/i.test(url)) continue;
        try {
            const parsed = new URL(url);
            const host = parsed.hostname.toLowerCase();
            if (
                host.endsWith('google.com') && ['/search', '/preferences'].includes(parsed.pathname) ||
                host.endsWith('bing.com') && parsed.pathname.startsWith('/search') ||
                host.endsWith('baidu.com') && parsed.pathname === '/s'
            ) continue;
        } catch {}
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        const snippetNode = queryFirst(container, config.snippet);
        const snippet = clean(snippetNode?.innerText || '');
        results.push({
            rank: results.length + 1,
            title,
            url,
            snippet: snippet.slice(0, 1000),
            displayedUrl: clean(container.querySelector('cite')?.innerText || '')
        });
        if (results.length >= maxResults) break;
    }
    return results;
};
let results = collect();
const startedAt = Date.now();
while (results.length === 0 && Date.now() - startedAt < renderWaitMs) {
    await sleep(Math.min(300, renderWaitMs));
    results = collect();
}
const block = detectBlock();
return {
    engineMode: mode,
    requestedEngine: engine,
    effectiveUrl: location.href,
    pageTitle: document.title,
    blocked: block.blocked,
    blockReason: block.reason,
    resultCount: results.length,
    results,
    extractedAt: new Date().toISOString()
};
`;
}

function detectEffectiveEngine(effectiveUrl) {
    try {
        const hostname = new URL(effectiveUrl).hostname.toLowerCase();
        if (hostname === 'cn.bing.com') return 'bing_cn';
        if (hostname.endsWith('bing.com')) return 'bing_global';
        if (hostname.endsWith('baidu.com')) return 'baidu';
        if (hostname.includes('google.')) return 'google';
    } catch {}
    return 'unknown';
}

function formatSearchMarkdown(payload) {
    const lines = [
        `## BrowserSearch 搜索结果`,
        '',
        `- 查询: ${payload.query}`,
        `- 请求引擎: ${payload.requestedEngine}`,
        `- 实际引擎: ${payload.effectiveEngine}`,
        `- 结果数量: ${payload.results.length}`,
        `- 缓存命中: ${payload.cached ? '是' : '否'}`,
        `- 最终页面: ${payload.effectiveUrl}`
    ];

    if (payload.redirected) {
        lines.push(`- 提示: 搜索引擎根据网络出口、Cookie 或 Profile 偏好发生了区域重定向`);
    }
    if (payload.warning) {
        lines.push(`- 警告: ${payload.warning}`);
    }

    lines.push('');
    payload.results.forEach(item => {
        lines.push(`### ${item.rank}. [${item.title}](${item.url})`);
        if (item.displayedUrl) lines.push(`> ${item.displayedUrl}`);
        if (item.snippet) lines.push('', item.snippet);
        lines.push('');
    });

    if (payload.results.length === 0) {
        lines.push('未提取到自然搜索结果。可能是页面结构变化、结果仍在渲染，或搜索引擎返回了验证页面。');
    }

    return lines.join('\n').trim();
}

function buildSuccessResult(payload) {
    return {
        status: 'success',
        result: {
            content: [
                {
                    type: 'text',
                    text: formatSearchMarkdown(payload)
                }
            ],
            details: payload
        }
    };
}

function normalizeParams(params = {}) {
    const query = String(params.query || params.keyword || params.q || '').trim();
    if (!query) throw new Error('缺少 query 搜索关键词');
    if (query.length > 500) throw new Error('query 过长，最多允许 500 个字符');

    const resolved = resolveEngine(params.engine, query, params.market);
    const config = getConfig();
    const maxResults = parseInteger(params.maxResults, config.maxResults, 1, 30);
    const closeTab = params.closeTab === undefined
        ? config.closeTabAfterSearch
        : parseBoolean(params.closeTab, config.closeTabAfterSearch);

    return {
        query,
        requestedEngine: resolved.engine,
        market: resolved.market,
        maxResults,
        safeSearch: params.safeSearch,
        timeRange: params.timeRange,
        closeTab,
        bypassCache: parseBoolean(params.bypassCache, false)
    };
}

function getCacheIdentity(normalized) {
    return {
        query: normalized.query,
        engine: normalized.requestedEngine,
        market: normalized.market,
        maxResults: normalized.maxResults,
        safeSearch: normalized.safeSearch || null,
        timeRange: normalized.timeRange || null
    };
}

function buildPayload(normalized, searchUrl, extracted) {
    const effectiveEngine = detectEffectiveEngine(extracted.effectiveUrl);
    const redirected = effectiveEngine !== 'unknown' &&
        effectiveEngine !== normalized.requestedEngine;

    return {
        query: normalized.query,
        requestedEngine: normalized.requestedEngine,
        effectiveEngine,
        requestedMarket: normalized.market,
        searchUrl,
        effectiveUrl: extracted.effectiveUrl,
        pageTitle: extracted.pageTitle,
        redirected,
        blocked: extracted.blocked === true,
        blockReason: extracted.blockReason || null,
        warning: extracted.blocked
            ? `搜索引擎返回了验证或访问限制页面 (${extracted.blockReason || 'unknown'})；插件不会尝试绕过验证`
            : (extracted.results.length === 0 ? '当前页面未提取到自然搜索结果' : null),
        results: Array.isArray(extracted.results)
            ? extracted.results.slice(0, normalized.maxResults)
            : [],
        cached: false,
        searchedAt: new Date().toISOString()
    };
}

async function extractActiveSearchPage(chromeBridge, normalized, searchUrl, config) {
    const extractionBody = buildExtractionScript(
        normalized.requestedEngine,
        normalized.maxResults,
        config.renderWaitMs
    );
    const extractionResponse = await chromeBridge.executeManagedCommand({
        command: 'cdp_runtime_evaluate',
        // BrowserSearch 依赖 managed Chrome，本身已具备 CDP 权限。使用 Runtime.evaluate
        // 可原生等待 Promise 并按值返回，不依赖 MAIN world 页面 CSP，也不依赖
        // ISOLATED world 的 MV3 extension CSP 对动态 new Function/eval 的限制。
        expression: `(async () => {\n${extractionBody}\n})()`,
        cdpParams: {
            awaitPromise: true,
            returnByValue: true
        }
    });

    const cdpEnvelope = extractionResponse?.result;
    if (cdpEnvelope?.exceptionDetails) {
        const description = cdpEnvelope.exceptionDetails.exception?.description ||
            cdpEnvelope.exceptionDetails.text ||
            '未知 CDP Runtime 异常';
        throw new Error(`浏览器搜索页面 CDP 提取脚本执行异常: ${description}`);
    }

    const remoteObject = cdpEnvelope?.result;
    const extracted = remoteObject?.value;
    if (!extracted || typeof extracted !== 'object') {
        throw new Error(
            `浏览器搜索页面 CDP 提取脚本未返回结构化结果 ` +
            `(type=${remoteObject?.type || 'missing'}, subtype=${remoteObject?.subtype || 'none'})`
        );
    }

    return buildPayload(normalized, searchUrl, extracted);
}

async function executeSearch(normalized) {
    const config = getConfig();
    const searchUrl = buildSearchUrl(
        normalized.requestedEngine,
        normalized.query,
        normalized.market,
        normalized.safeSearch,
        normalized.timeRange
    );
    const cacheKey = buildCacheKey(getCacheIdentity(normalized));

    if (!normalized.bypassCache) {
        const cached = getCachedResult(cacheKey);
        if (cached) {
            return buildSuccessResult({
                ...cached,
                cached: true
            });
        }
    }

    const chromeBridge = getChromeBridge();
    await enforceRateLimit(normalized.requestedEngine, config.minIntervalMs);

    let openedTabId = null;
    try {
        await chromeBridge.executeManagedCommand(
            {
                command: 'open_url',
                url: searchUrl,
                pageInfoFallbackMs: Math.max(4000, config.renderWaitMs + 2500)
            },
            {
                waitForPageInfo: true
            }
        );

        const tabsResponse = await chromeBridge.executeManagedCommand({
            command: 'list_tabs'
        });
        const tabs = tabsResponse?.result?.tabs || [];
        const activeTab = tabs.find(tab => tab.active);
        openedTabId = activeTab?.id || null;

        const payload = await extractActiveSearchPage(
            chromeBridge,
            normalized,
            searchUrl,
            config
        );

        if (!payload.blocked) {
            setCachedResult(cacheKey, payload, config.cacheTtlMs);
        }

        return buildSuccessResult(payload);
    } finally {
        if (normalized.closeTab && openedTabId !== null) {
            await chromeBridge.executeManagedCommand({
                command: 'close_tab',
                target: String(openedTabId)
            }, {
                allowAutoCreate: false
            }).catch(error => {
                if (config.debugMode) {
                    console.warn('[BrowserSearch] failed to close search tab:', error.message);
                }
            });
        }
    }
}

function normalizeBatchQueries(params = {}) {
    let rawQueries = params.queries;
    if (typeof rawQueries === 'string') {
        const trimmed = rawQueries.trim();
        if (trimmed.startsWith('[')) {
            try {
                rawQueries = JSON.parse(trimmed);
            } catch (error) {
                throw new Error(`queries JSON 解析失败: ${error.message}`);
            }
        } else {
            rawQueries = trimmed.split(/\r?\n|\s*\|\s*/).filter(Boolean);
        }
    }

    if (!Array.isArray(rawQueries) || rawQueries.length === 0) {
        return null;
    }

    const config = getConfig();
    if (rawQueries.length > config.maxBatchQueries) {
        throw new Error(`批量搜索最多允许 ${config.maxBatchQueries} 个查询词，当前收到 ${rawQueries.length} 个`);
    }

    return rawQueries.map((item, index) => {
        const itemParams = item && typeof item === 'object'
            ? { ...params, ...item, queries: undefined }
            : { ...params, query: item, queries: undefined };
        try {
            return normalizeParams(itemParams);
        } catch (error) {
            throw new Error(`第 ${index + 1} 个查询无效: ${error.message}`);
        }
    });
}

function deduplicateBatchResults(items) {
    const merged = [];
    const seen = new Set();

    for (const item of items) {
        if (!item.success || !item.payload) continue;
        for (const result of item.payload.results) {
            let key = result.url;
            try {
                const url = new URL(result.url);
                ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(name => {
                    url.searchParams.delete(name);
                });
                url.hash = '';
                key = url.toString();
            } catch {}

            if (seen.has(key)) continue;
            seen.add(key);
            merged.push({
                ...result,
                matchedQuery: item.payload.query,
                sourceEngine: item.payload.effectiveEngine
            });
        }
    }

    return merged.map((item, index) => ({ ...item, rank: index + 1 }));
}

function buildBatchResult(items, startedAt) {
    const successful = items.filter(item => item.success);
    const failed = items.filter(item => !item.success);
    const mergedResults = deduplicateBatchResults(items);
    const lines = [
        '## BrowserSearch 批量搜索结果',
        '',
        `- 查询数量: ${items.length}`,
        `- 成功: ${successful.length}`,
        `- 失败: ${failed.length}`,
        `- 聚合去重结果: ${mergedResults.length}`,
        `- 耗时: ${Date.now() - startedAt}ms`,
        ''
    ];

    for (const item of items) {
        if (item.success) {
            lines.push(formatSearchMarkdown(item.payload), '', '---', '');
        } else {
            lines.push(
                `### 查询失败：${item.query}`,
                '',
                `- 错误: ${item.error}`,
                '',
                '---',
                ''
            );
        }
    }

    return {
        status: 'success',
        result: {
            content: [{
                type: 'text',
                text: lines.join('\n').trim()
            }],
            details: {
                batch: true,
                queryCount: items.length,
                successCount: successful.length,
                failureCount: failed.length,
                durationMs: Date.now() - startedAt,
                items,
                mergedResults
            }
        }
    };
}

async function executeBatchSearch(normalizedQueries) {
    const startedAt = Date.now();
    const config = getConfig();
    const chromeBridge = getChromeBridge();
    const items = new Array(normalizedQueries.length);
    const pendingPlans = [];

    normalizedQueries.forEach((normalized, index) => {
        const cacheKey = buildCacheKey(getCacheIdentity(normalized));
        const cached = normalized.bypassCache ? null : getCachedResult(cacheKey);
        if (cached) {
            items[index] = {
                success: true,
                payload: { ...cached, cached: true }
            };
            return;
        }

        pendingPlans.push({
            index,
            normalized,
            cacheKey,
            searchUrl: buildSearchUrl(
                normalized.requestedEngine,
                normalized.query,
                normalized.market,
                normalized.safeSearch,
                normalized.timeRange
            )
        });
    });

    if (pendingPlans.length === 0) {
        return buildBatchResult(items, startedAt);
    }

    const tabsBeforeResponse = await chromeBridge.executeManagedCommand({
        command: 'list_tabs'
    });
    const tabsBefore = tabsBeforeResponse?.result?.tabs || [];
    const maxTabs = Number(tabsBeforeResponse?.result?.maxTabs || 8);
    const availableTabs = Math.max(0, maxTabs - tabsBefore.length);

    if (pendingPlans.length > availableTabs) {
        throw new Error(
            `批量搜索需要新开 ${pendingPlans.length} 个标签页，但 managed Chrome 仅剩 ${availableTabs} 个可用槽位 ` +
            `(${tabsBefore.length}/${maxTabs})。请减少 queries、启用 closeTab，或先清理旧标签页。`
        );
    }

    // 导航并行、DOM 提取串行：多个页面可以重叠加载，但绝不并行操作活动标签页。
    const launchResults = await Promise.allSettled(pendingPlans.map(async (plan, launchIndex) => {
        if (launchIndex > 0 && config.batchLaunchIntervalMs > 0) {
            await sleep(launchIndex * config.batchLaunchIntervalMs);
        }
        const response = await chromeBridge.executeManagedCommand({
            command: 'open_url',
            url: plan.searchUrl
        }, {
            waitForPageInfo: false
        });
        return { plan, response };
    }));

    const tabsAfterResponse = await chromeBridge.executeManagedCommand({
        command: 'list_tabs'
    });
    const tabsAfter = tabsAfterResponse?.result?.tabs || [];
    const oldTabIds = new Set(tabsBefore.map(tab => tab.id));
    const newlyOpenedTabs = tabsAfter
        .filter(tab => !oldTabIds.has(tab.id))
        .sort((a, b) => Number(a.id) - Number(b.id));
    const claimedTabIds = new Set();

    const findTabForPlan = (plan) => {
        const exactQueryTab = newlyOpenedTabs.find(tab => {
            if (claimedTabIds.has(tab.id)) return false;
            try {
                const tabUrl = new URL(tab.url);
                const tabQuery = tabUrl.searchParams.get('q') || tabUrl.searchParams.get('wd');
                return tabQuery === plan.normalized.query;
            } catch {
                return false;
            }
        });
        if (exactQueryTab) return exactQueryTab;

        try {
            const expected = new URL(plan.searchUrl);
            const sameUrlTab = newlyOpenedTabs.find(tab => {
                if (claimedTabIds.has(tab.id)) return false;
                try {
                    const actual = new URL(tab.url);
                    return actual.hostname === expected.hostname &&
                        actual.pathname === expected.pathname &&
                        actual.searchParams.get('q') === expected.searchParams.get('q') &&
                        actual.searchParams.get('wd') === expected.searchParams.get('wd');
                } catch {
                    return false;
                }
            });
            if (sameUrlTab) return sameUrlTab;
        } catch {}

        return newlyOpenedTabs.find(tab => !claimedTabIds.has(tab.id)) || null;
    };

    for (let launchIndex = 0; launchIndex < launchResults.length; launchIndex++) {
        const launch = launchResults[launchIndex];
        const plan = pendingPlans[launchIndex];

        if (launch.status === 'rejected') {
            items[plan.index] = {
                success: false,
                query: plan.normalized.query,
                error: launch.reason?.message || String(launch.reason)
            };
            continue;
        }

        const returnedTabId = launch.value.response?.result?.tab?.id;
        const matchedTab = returnedTabId !== undefined && returnedTabId !== null
            ? newlyOpenedTabs.find(tab => tab.id === returnedTabId)
            : findTabForPlan(plan);
        const tabId = returnedTabId ?? matchedTab?.id;
        if (tabId !== undefined && tabId !== null) {
            claimedTabIds.add(tabId);
        }

        if (tabId === undefined || tabId === null) {
            items[plan.index] = {
                success: false,
                query: plan.normalized.query,
                error: '搜索标签页已打开，但无法确定 tabId'
            };
            continue;
        }

        try {
            await chromeBridge.executeManagedCommand({
                command: 'switch_tab',
                target: String(tabId)
            });
            if (config.renderWaitMs > 0) {
                await sleep(Math.min(config.renderWaitMs, 2500));
            }

            const payload = await extractActiveSearchPage(
                chromeBridge,
                plan.normalized,
                plan.searchUrl,
                config
            );
            if (!payload.blocked) {
                setCachedResult(plan.cacheKey, payload, config.cacheTtlMs);
            }
            items[plan.index] = { success: true, payload };
        } catch (error) {
            items[plan.index] = {
                success: false,
                query: plan.normalized.query,
                error: error.message
            };
        } finally {
            if (plan.normalized.closeTab) {
                await chromeBridge.executeManagedCommand({
                    command: 'close_tab',
                    target: String(tabId)
                }, {
                    allowAutoCreate: false
                }).catch(() => undefined);
            }
        }
    }

    return buildBatchResult(items, startedAt);
}

async function processToolCall(params = {}) {
    const command = String(params.command || 'search').trim().toLowerCase();

    if (command === 'status') {
        const config = getConfig();
        return {
            status: 'success',
            result: {
                content: [{
                    type: 'text',
                    text: `BrowserSearch 已加载。排队事务: ${pendingTransactions}，缓存条目: ${resultCache.size}，默认引擎: ${config.defaultEngine}`
                }],
                details: {
                    pendingTransactions,
                    cacheEntries: resultCache.size,
                    supportedEngines: Array.from(SUPPORTED_ENGINES),
                    config
                }
            }
        };
    }

    if (command === 'clear_cache') {
        const cleared = resultCache.size;
        resultCache.clear();
        return {
            status: 'success',
            result: {
                content: [{
                    type: 'text',
                    text: `BrowserSearch 缓存已清空，共移除 ${cleared} 条记录。`
                }],
                details: { cleared }
            }
        };
    }

    if (command !== 'search') {
        throw new Error(`未知命令: ${command}。支持 search、status、clear_cache`);
    }

    const normalizedBatch = normalizeBatchQueries(params);
    if (normalizedBatch) {
        return runExclusive(() => executeBatchSearch(normalizedBatch));
    }

    const normalized = normalizeParams(params);
    return runExclusive(() => executeSearch(normalized));
}

function shutdown() {
    resultCache.clear();
    lastEngineRequestAt.clear();
    pluginManager = null;
}

module.exports = {
    initialize,
    processToolCall,
    shutdown,
    _private: {
        buildSearchUrl,
        detectEffectiveEngine,
        resolveEngine
    }
};