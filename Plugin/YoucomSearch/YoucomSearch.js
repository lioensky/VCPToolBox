#!/usr/bin/env node
'use strict';

const axios = require('axios');
const stdin = require('process').stdin;

const YOUCOM_SEARCH_URL = 'https://ydc-index.io/v1/search';
const DEFAULT_COUNT = 10;
const MAX_COUNT = 20;
const VALID_FRESHNESS = ['day', 'week', 'month', 'year'];

/**
 * 格式化单条搜索结果（网页或新闻）为 Markdown 列表项。
 * 对缺失字段进行防御处理，永不抛出异常。
 */
function formatOneResult(index, item) {
    item = item || {};
    const title = (typeof item.title === 'string' && item.title.trim()) ? item.title : '(无标题)';
    const url = (typeof item.url === 'string') ? item.url : '';

    let md = `${index}. **[${title}](${url})**\n`;

    if (typeof item.description === 'string' && item.description.trim()) {
        md += `   ${item.description}\n`;
    }

    const rawSnippets = Array.isArray(item.snippets) ? item.snippets : [];
    const snippets = rawSnippets.filter(s => typeof s === 'string' && s.trim().length > 0);
    if (snippets.length > 0) {
        snippets.forEach(s => {
            md += `   - ${s.trim()}\n`;
        });
    }

    md += '\n';
    return md;
}

/**
 * 将 You.com 搜索响应格式化为 Markdown。
 * 纯函数：不发起任何网络请求，对 null/undefined/畸形结构进行防御处理。
 */
function formatYoucomResults(response) {
    const results = (response && typeof response === 'object') ? response.results : null;
    const web = (results && Array.isArray(results.web)) ? results.web : [];
    const news = (results && Array.isArray(results.news)) ? results.news : [];

    if (web.length === 0 && news.length === 0) {
        return '未找到相关搜索结果。\n';
    }

    let md = '';
    let index = 0;

    if (web.length > 0) {
        md += `### 网页结果\n`;
        web.forEach(item => {
            index += 1;
            md += formatOneResult(index, item);
        });
    }

    if (news.length > 0) {
        md += `### 新闻结果\n`;
        news.forEach(item => {
            index += 1;
            md += formatOneResult(index, item);
        });
    }

    return md;
}

/**
 * 解析 YoucomKey：支持逗号分隔的多个 Key，随机挑选一个使用（与 TavilyKey 逻辑一致）。
 * 返回 { key, allKeys } 或 { error }，从不抛出异常。
 * allKeys 包含所有候选 Key（用于后续对错误消息做防泄露脱敏），不仅仅是被选中的那一个。
 */
function resolveApiKey(rawKey) {
    if (!rawKey || typeof rawKey !== 'string' || !rawKey.trim()) {
        return { error: 'YoucomKey environment variable not set.' };
    }

    if (rawKey.includes(',')) {
        const keys = rawKey.split(',').map(k => k.trim()).filter(k => k.length > 0);
        if (keys.length === 0) {
            return { error: 'YoucomKey environment variable is empty or contains only commas.' };
        }
        return { key: keys[Math.floor(Math.random() * keys.length)], allKeys: keys };
    }

    const trimmed = rawKey.trim();
    return { key: trimmed, allKeys: [trimmed] };
}

/**
 * 对外部错误消息中可能出现的 API Key 原文进行脱敏替换，防止密钥通过底层 HTTP 库的
 * 错误信息（例如冗长的请求回显）意外泄露到插件输出中。
 */
function redactSecrets(message, secrets) {
    if (typeof message !== 'string' || !Array.isArray(secrets)) {
        return message;
    }
    let sanitized = message;
    for (const secret of secrets) {
        if (typeof secret === 'string' && secret.length > 0 && sanitized.includes(secret)) {
            sanitized = sanitized.split(secret).join('[REDACTED]');
        }
    }
    return sanitized;
}

/**
 * 归一化 count 参数：非数字/负数/零 -> 默认值 10；超过上限 -> 截断为 20。
 */
function normalizeCount(count) {
    let n = parseInt(count, 10);
    if (isNaN(n) || n <= 0) {
        n = DEFAULT_COUNT;
    }
    if (n > MAX_COUNT) {
        n = MAX_COUNT;
    }
    return n;
}

/**
 * 默认的 HTTP GET 实现（生产环境使用）。测试中会注入替身函数，不发起真实网络请求。
 */
async function defaultHttpGet(url, config) {
    return axios.get(url, config);
}

/**
 * 对单个子查询发起 You.com 搜索请求，返回响应体（response.data）。
 * 可能抛出异常（网络错误/HTTP 错误），由调用方通过 Promise.allSettled 或 try/catch 处理。
 */
async function fetchSubQuery(subQuery, apiKey, extraParams, httpGet) {
    const response = await httpGet(YOUCOM_SEARCH_URL, {
        headers: { 'X-API-Key': apiKey },
        params: Object.assign({ query: subQuery }, extraParams),
        timeout: 25000
    });
    return (response && response.data) ? response.data : null;
}

/**
 * You.com 搜索核心逻辑。接受可注入的 httpGet（用于测试，避免真实网络请求）。
 * 支持使用 || 分隔的多个查询并发搜索。
 * 契约：永不抛出异常，永远返回 {status:"success", result} 或 {status:"error", error}。
 * 契约：任何输出字符串中都不得包含 apiKey 原文。
 */
async function searchYoucom(query, options = {}, httpGet = defaultHttpGet) {
    // 声明在 try 之外，以便 catch 块也能用它对错误消息脱敏（即使异常发生在解析 Key 之后）。
    let secretsToRedact = [];
    try {
        const { apiKey: rawApiKey, count, freshness, country, language } = options || {};

        const resolvedKey = resolveApiKey(rawApiKey);
        if (resolvedKey.error) {
            return { status: 'error', error: resolvedKey.error };
        }
        const apiKey = resolvedKey.key;
        secretsToRedact = resolvedKey.allKeys || [apiKey];

        const rawQuery = (typeof query === 'string') ? query : '';
        const subQueries = rawQuery.split('||').map(q => q.trim()).filter(q => q.length > 0);

        if (subQueries.length === 0) {
            return { status: 'error', error: "No valid search query after splitting by '||'" };
        }

        const normalizedCount = normalizeCount(count);
        const extraParams = { count: normalizedCount };
        if (typeof freshness === 'string' && VALID_FRESHNESS.includes(freshness)) {
            extraParams.freshness = freshness;
        }
        if (typeof country === 'string' && country.trim()) {
            extraParams.country = country.trim();
        }
        if (typeof language === 'string' && language.trim()) {
            extraParams.language = language.trim();
        }

        if (subQueries.length === 1) {
            const data = await fetchSubQuery(subQueries[0], apiKey, extraParams, httpGet);
            return { status: 'success', result: formatYoucomResults(data) };
        }

        // 多个子查询 => 并发搜索
        const settled = await Promise.allSettled(
            subQueries.map(subQuery =>
                fetchSubQuery(subQuery, apiKey, extraParams, httpGet).then(data => ({ subQuery, data }))
            )
        );

        let markdownResult = '';
        const failedResults = [];
        let hasAnySuccess = false;

        settled.forEach((result, idx) => {
            if (result.status === 'fulfilled') {
                hasAnySuccess = true;
                const { subQuery, data } = result.value;
                markdownResult += `## 🔍 查询: ${subQuery}\n\n`;
                markdownResult += formatYoucomResults(data);
                markdownResult += '\n\n---\n\n';
            } else {
                const rawReasonMessage = (result.reason && result.reason.message) ? result.reason.message : '未知错误';
                const reasonMessage = redactSecrets(rawReasonMessage, secretsToRedact);
                failedResults.push({ subQuery: subQueries[idx], error: reasonMessage });
            }
        });

        if (failedResults.length > 0) {
            markdownResult += `## ⚠️ 以下查询失败\n\n`;
            for (const fail of failedResults) {
                markdownResult += `### 查询: ${fail.subQuery}\n`;
                markdownResult += `错误: ${fail.error}\n\n`;
            }
        }

        if (!hasAnySuccess) {
            const firstError = failedResults.length > 0 ? failedResults[0].error : '未知错误';
            return { status: 'error', error: `Youcom Search Error: ${firstError}` };
        }

        return { status: 'success', result: markdownResult };
    } catch (e) {
        const rawMessage = (e && e.message) ? e.message : 'An unknown error occurred.';
        const message = redactSecrets(rawMessage, secretsToRedact);
        return { status: 'error', error: `Youcom Search Error: ${message}` };
    }
}

async function main() {
    let inputData = '';
    stdin.setEncoding('utf8');

    stdin.on('data', function (chunk) {
        inputData += chunk;
    });

    stdin.on('end', async function () {
        let output;

        try {
            if (!inputData.trim()) {
                throw new Error('No input data received from stdin.');
            }

            const data = JSON.parse(inputData);

            output = await searchYoucom(data.query, {
                apiKey: process.env.YoucomKey,
                count: data.count,
                freshness: data.freshness,
                country: data.country,
                language: data.language
            });
        } catch (e) {
            let errorMessage;
            if (e instanceof SyntaxError) {
                errorMessage = 'Invalid JSON input.';
            } else if (e instanceof Error) {
                errorMessage = e.message;
            } else {
                errorMessage = 'An unknown error occurred.';
            }
            output = { status: 'error', error: `Youcom Search Error: ${errorMessage}` };
        }

        // Output JSON to stdout
        process.stdout.write(JSON.stringify(output, null, 2));
    });
}

if (require.main === module) {
    main().catch(error => {
        // Catch any unhandled promise rejections from main
        process.stdout.write(JSON.stringify({ status: 'error', error: `Unhandled Plugin Error: ${error.message || error}` }));
        process.exit(1); // Indicate failure
    });
}

module.exports = {
    formatYoucomResults,
    searchYoucom
};
