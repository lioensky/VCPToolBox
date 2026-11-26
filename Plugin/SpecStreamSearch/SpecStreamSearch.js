'use strict';

const path = require('path');

const API_URL = 'https://api.specstream.ai/v1/web-search';
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
    const key = String(env.SpecStreamKey || '').trim();
    if (!key) throw new Error('未配置 SpecStreamKey，请在 Plugin/SpecStreamSearch/config.env 中填写 API Key。');
    // site 与 published_after 写成查询运算符，由服务端对每条结果强制执行。
    const parts = [query];
    if (typeof request.site === 'string' && request.site.trim()) {
        const site = request.site.trim();
        if (!/^[A-Za-z0-9.-]+$/.test(site)) throw new Error('site 只能是域名，例如 github.com。');
        parts.push(`site:${site}`);
    }
    if (request.published_after !== undefined) {
        if (typeof request.published_after !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(request.published_after)) {
            throw new Error('published_after 必须是 YYYY-MM-DD 格式。');
        }
        parts.push(`after:${request.published_after}`);
    }
    const body = { q: parts.join(' '), num: clampResults(request.max_results, clampResults(env.SpecStreamMaxResults, 8)) };
    if (String(env.SpecStreamSpeed || '').trim().toLowerCase() === 'fast') body.speed = 'fast';
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
    return { url: API_URL, body, headers, query };
}

function formatResults(data, query) {
    const sources = Array.isArray(data?.sources) ? data.sources.filter(s => s && typeof s.url === 'string') : [];
    const answer = data?.answer && data.answer.value !== undefined && data.answer.value !== null ? data.answer : null;
    if (sources.length === 0 && !answer) return `## SpecStream 搜索结果\n\n**查询**: ${query}\n\n未找到相关结果。`;
    const head = [`## SpecStream 搜索结果`, '', `**查询**: ${query}`];
    if (answer) {
        const value = String(answer.value).replace(/[\r\n]+/g, ' ');
        head.push('', `**答案**: ${value}${answer.page ? `（来源: ${answer.page}）` : ''}`);
    }
    const lines = sources.map((s, i) => {
        const title = String(s.title || s.url).replace(/[\r\n]+/g, ' ');
        const site = s.site ? ` · ${s.site}` : '';
        const snippet = String(s.snippet || '').trim();
        return `${i + 1}. **[${title}](${s.url})**${site}${snippet ? `\n   ${snippet.replace(/\r?\n/g, '\n   ')}` : ''}`;
    });
    return `${head.join('\n')}${lines.length ? `\n\n${lines.join('\n\n')}` : ''}`;
}

function describeStatus(status, message) {
    if (status === 401 || status === 403) return `SpecStream API 认证失败（HTTP ${status}），请检查 SpecStreamKey。`;
    if (status === 402) return 'SpecStream 账户余额不足（HTTP 402），请在 specstream.ai 充值后重试。';
    if (status === 429) return 'SpecStream API 请求过于频繁（HTTP 429），请稍后重试。';
    return `SpecStream API 请求失败（HTTP ${status}）${message ? `：${message}` : '。'}`;
}

async function main(request, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
    try {
        const { url, body, headers, query } = buildRequest(request, env);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let response;
        try {
            response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
        } catch (error) {
            return { status: 'error', error: error.name === 'AbortError' ? 'SpecStream 搜索请求超时。' : '无法连接 SpecStream API，请检查网络。' };
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) {
            let message = '';
            try {
                const payload = await response.json();
                message = typeof payload?.error?.message === 'string' ? payload.error.message : '';
            } catch (_) { /* 错误响应不是 JSON 时只报告状态码 */ }
            return { status: 'error', error: describeStatus(response.status, message) };
        }
        const payload = await response.json();
        return { status: 'success', result: { content: [{ type: 'text', text: formatResults(payload?.data, query) }] } };
    } catch (error) {
        return { status: 'error', error: error.message || 'SpecStreamSearch 执行失败。' };
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

module.exports = { main, buildRequest, formatResults, API_URL };
