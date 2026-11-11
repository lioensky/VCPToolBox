'use strict';

const path = require('path');
const axios = require('axios');
const { randomInt } = require('crypto');
const dotenv = require('dotenv');
const manifest = require('./plugin-manifest.json');

const EFFORTS = new Set(['lite', 'standard', 'deep']);

function buildPayload(request, env) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new Error('输入必须是 JSON 对象。');
    }
    const topic = request.SearchTopic ?? request.input;
    if (typeof topic !== 'string' || !topic.trim()) {
        throw new Error('缺少必需参数: SearchTopic（或 input）。');
    }
    if (topic.length > 40000) {
        throw new Error('研究问题最长为 40,000 字符。');
    }
    const effort = request.research_effort ?? request.ResearchEffort ?? env.YouSearchEffort ?? 'standard';
    if (!EFFORTS.has(effort)) {
        throw new Error('research_effort 仅支持 lite、standard、deep。');
    }
    if (request.background !== undefined && request.background !== false && request.background !== 'false') {
        throw new Error('YouSearch 只支持同步执行，不支持 background。');
    }
    if (request.output_schema !== undefined) {
        throw new Error('YouSearch 返回 Markdown，不支持 output_schema。');
    }
    const payload = { input: topic.trim(), research_effort: effort, background: false };
    if (request.source_control !== undefined) {
        let control = request.source_control;
        if (typeof control === 'string') {
            try {
                control = JSON.parse(control);
            } catch (_) {
                throw new Error('source_control 必须是有效的 JSON 对象。');
            }
        }
        if (!control || typeof control !== 'object' || Array.isArray(control)) {
            throw new Error('source_control 必须是 JSON 对象。');
        }
        const allowed = ['include_domains', 'exclude_domains', 'freshness', 'country'];
        if (Object.keys(control).some(key => !allowed.includes(key))) {
            throw new Error('source_control 包含不支持的字段。');
        }
        for (const key of ['include_domains', 'exclude_domains']) {
            if (control[key] !== undefined && (!Array.isArray(control[key])
                || control[key].some(domain => typeof domain !== 'string' || !domain.trim()))) {
                throw new Error(`source_control.${key} 必须是非空字符串组成的数组。`);
            }
        }
        if (control.freshness !== undefined && !['day', 'week', 'month', 'year'].includes(control.freshness)) {
            throw new Error('source_control.freshness 仅支持 day、week、month、year。');
        }
        if (control.country !== undefined && (typeof control.country !== 'string' || !/^[A-Za-z]{2}$/.test(control.country))) {
            throw new Error('source_control.country 必须是两位国家代码。');
        }
        payload.source_control = control;
    }
    return payload;
}

function formatReport(data, payload) {
    const output = data?.output;
    if (!output || typeof output.content !== 'string' || !output.content.trim()
        || (output.content_type !== undefined && output.content_type !== 'text')) {
        throw new Error('You.com 未返回有效的 Markdown 研究正文。');
    }
    let report = `## YouSearch 检索报告 [档位: ${payload.research_effort}]\n\n**研究主题**: ${payload.input}\n\n${output.content.trim()}`;
    if (Array.isArray(output.sources) && output.sources.length > 0) {
        // 不去重、不重排、不丢弃空条目，确保与正文 [[1, 2]] 引用编号对应。
        const sources = output.sources.map((source, index) => {
            const title = typeof source?.title === 'string'
                ? source.title.replace(/[\r\n]+/g, ' ').replace(/([\\[\]])/g, '\\$1')
                : '参考来源';
            let url;
            try {
                const parsed = new URL(source?.url);
                if (['http:', 'https:'].includes(parsed.protocol)) {
                    url = parsed.href.replace(/[<>]/g, char => encodeURIComponent(char));
                }
            } catch (_) { /* 缺失或无效 URL 仍保留引用位置。 */ }
            let entry = `${index + 1}. ${url ? `[${title}](<${url}>)` : `${title}（来源 URL 不可用）`}`;
            if (Array.isArray(source?.snippets)) {
                for (const snippet of source.snippets) {
                    if (typeof snippet === 'string' && snippet.trim()) {
                        entry += `\n\n   > ${snippet.trim().replace(/\r?\n/g, '\n   > ')}`;
                    }
                }
            }
            return entry;
        });
        report += `\n\n### 参考来源\n\n${sources.join('\n\n')}`;
    }
    return report;
}

function describeError(error) {
    const status = error.response?.status;
    if (status === 402) return 'You.com API 额度不足（HTTP 402），请检查账户余额。';
    if (status === 401 || status === 403) return `You.com API 认证失败（HTTP ${status}），请检查 YouSearchKey。`;
    if (status === 429) return 'You.com API 请求过于频繁（HTTP 429），请稍后重试。';
    if (status) return `You.com API 请求失败（HTTP ${status}）。`;
    if (['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED'].includes(error.code)) {
        return 'You.com 同步研究请求超时，请稍后重试或降低研究档位。';
    }
    // 不返回 axios 配置/请求对象或上游错误体，避免泄露请求头中的 API Key。
    if (error.isAxiosError) return '无法连接 You.com API，请检查网络和 YouSearchUrl 配置。';
    return error.message || 'YouSearch 执行失败。';
}

async function main(request, { env = process.env, http = axios } = {}) {
    try {
        const payload = buildPayload(request, env);
        const keys = [...new Set(String(env.YouSearchKey || '').split(/[,|]/).map(key => key.trim()).filter(Boolean))];
        if (keys.length === 0) throw new Error('请在插件配置中设置 YouSearchKey。');
        const key = keys[randomInt(keys.length)];
        const url = new URL(env.YouSearchUrl || 'https://api.you.com/v1/research');
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            throw new Error('YouSearchUrl 必须是无内嵌认证信息的 HTTP(S) 地址。');
        }
        let proxy = false;
        if (env.YouSearchProxy?.trim()) {
            let proxyUrl;
            try {
                proxyUrl = new URL(env.YouSearchProxy.trim());
            } catch (_) {
                throw new Error('YouSearchProxy 必须是有效的 HTTP(S) 代理地址。');
            }
            if (!['http:', 'https:'].includes(proxyUrl.protocol)) {
                throw new Error('YouSearchProxy 仅支持 HTTP(S) 代理。');
            }
            proxy = {
                protocol: proxyUrl.protocol.slice(0, -1),
                host: proxyUrl.hostname,
                port: Number(proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80))
            };
            if (proxyUrl.username || proxyUrl.password) {
                proxy.auth = {
                    username: decodeURIComponent(proxyUrl.username),
                    password: decodeURIComponent(proxyUrl.password)
                };
            }
        }
        const configuredTimeout = Number(env.YouSearchTimeout);
        const hardTimeout = Number(manifest.communication.timeout);
        const timeout = Math.min(
            Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 240000,
            hardTimeout - 15000
        );
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await http.post(url.href, payload, {
                headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
                timeout,
                signal: controller.signal,
                maxRedirects: 0,
                proxy
            });
            return {
                status: 'success',
                result: { content: [{ type: 'text', text: formatReport(response.data, payload) }] }
            };
        } finally {
            clearTimeout(timer);
        }
    } catch (error) {
        return { status: 'error', error: describeError(error) };
    }
}

if (require.main === module) {
    dotenv.config({ path: path.join(__dirname, 'config.env'), quiet: true });
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', async () => {
        let result;
        try {
            const request = JSON.parse(input);
            result = await main(request);
        } catch (_) {
            result = { status: 'error', error: '无法解析来自主服务的输入参数，请提供有效 JSON。' };
        }
        // 等待 stdout 正常排空，避免长报告被 process.exit 截断。
        process.stdout.write(`${JSON.stringify(result)}\n`);
    });
}

module.exports = { main, buildPayload, formatReport };