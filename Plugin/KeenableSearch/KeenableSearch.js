'use strict';

const path = require('path');

const KEYLESS_URL = 'https://api.keenable.ai/v1/search/public';
const KEYED_URL = 'https://api.keenable.ai/v1/search';
const TITLE = 'VCPToolBox';
const TIMEOUT_MS = 25000;

function clampResults(value, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(20, Math.max(1, n));
}

function buildRequest(request, env) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new Error('输入必须是 JSON 对象。');
    }
    const query = typeof request.query === 'string' ? request.query.trim() : '';
    if (!query) throw new Error('缺少必需参数: query。');
    const body = { query, max_results: clampResults(request.max_results, clampResults(env.KeenableMaxResults, 8)) };
    if (typeof request.site === 'string' && request.site.trim()) body.site = request.site.trim();
    if (request.published_after !== undefined) {
        if (typeof request.published_after !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(request.published_after)) {
            throw new Error('published_after 必须是 YYYY-MM-DD 格式。');
        }
        body.published_after = request.published_after;
    }
    const key = String(env.KeenableKey || '').trim();
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['X-API-Key'] = key;
    else headers['X-Keenable-Title'] = TITLE;
    return { url: key ? KEYED_URL : KEYLESS_URL, body, headers };
}

function formatResults(data, query) {
    const results = Array.isArray(data?.results) ? data.results.filter(r => r && typeof r.url === 'string') : [];
    if (results.length === 0) return `## Keenable 搜索结果\n\n**查询**: ${query}\n\n未找到相关结果。`;
    const lines = results.map((r, i) => {
        const title = String(r.title || r.url).replace(/[\r\n]+/g, ' ');
        const snippet = String(r.snippet || r.description || '').trim();
        return `${i + 1}. **[${title}](${r.url})**${snippet ? `\n   ${snippet.replace(/\r?\n/g, '\n   ')}` : ''}`;
    });
    return `## Keenable 搜索结果\n\n**查询**: ${query}\n\n${lines.join('\n\n')}`;
}

function describeStatus(status) {
    if (status === 401 || status === 403) return `Keenable API 认证失败（HTTP ${status}），请检查 KeenableKey。`;
    if (status === 429) return 'Keenable API 请求过于频繁（HTTP 429），请稍后重试或配置 KeenableKey。';
    return `Keenable API 请求失败（HTTP ${status}）。`;
}

async function main(request, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
    try {
        const { url, body, headers } = buildRequest(request, env);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let response;
        try {
            response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
        } catch (error) {
            return { status: 'error', error: error.name === 'AbortError' ? 'Keenable 搜索请求超时。' : '无法连接 Keenable API，请检查网络。' };
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) return { status: 'error', error: describeStatus(response.status) };
        const data = await response.json();
        return { status: 'success', result: { content: [{ type: 'text', text: formatResults(data, body.query) }] } };
    } catch (error) {
        return { status: 'error', error: error.message || 'KeenableSearch 执行失败。' };
    }
}

if (require.main === module) {
    try {
        require('dotenv').config({ path: path.join(__dirname, 'config.env'), quiet: true });
    } catch (_) { /* dotenv 不可用时只读进程环境变量 */ }
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', async () => {
        let result;
        try {
            result = await main(JSON.parse(input));
        } catch (_) {
            result = { status: 'error', error: '无法解析来自主服务的输入参数，请提供有效 JSON。' };
        }
        process.stdout.write(`${JSON.stringify(result)}\n`);
    });
}

module.exports = { main, buildRequest, formatResults, KEYLESS_URL, KEYED_URL };
