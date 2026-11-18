'use strict';

const ENDPOINT = 'https://deed.page/mcp';
const USER_AGENT = 'VCPToolBox-DeedPage/1.0.0 (https://github.com/lioensky/VCPToolBox)';
const TIMEOUT_MS = 45000;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function stringValue(value, name, maxLength) {
    if (typeof value !== 'string' || !value.trim() || (maxLength && value.length > maxLength)) {
        throw new Error(`${name} 必须是非空字符串${maxLength ? `，最多 ${maxLength} 字符` : ''}。`);
    }
    return value;
}

function slugValue(value) {
    const slug = stringValue(value, 'slug', 63);
    if (!SLUG_PATTERN.test(slug)) throw new Error('slug 只能包含小写字母、数字和连字符（1–63 字符，不能以连字符开头或结尾）。');
    return slug;
}

function normalizeArguments(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('输入必须是 JSON 对象。');
    }
    const token = input.token === undefined ? '' : stringValue(input.token, 'token').trim();
    if (/\s/.test(token)) throw new Error('token 不能包含空白字符。');
    const name = input.command;
    const args = {};
    if (name === 'publish_site') {
        args.files = { 'index.html': stringValue(input.html, 'html') };
        if (input.slug !== undefined) args.slug = slugValue(input.slug);
        if (input.ttl_seconds !== undefined) {
            const ttl = Number(input.ttl_seconds);
            if (!Number.isInteger(ttl) || ttl <= 0) throw new Error('ttl_seconds 必须是正整数（秒）。');
            args.ttl_seconds = ttl;
        }
    } else if (name === 'get_site') {
        args.slug = slugValue(input.slug);
    } else if (name === 'delete_site') {
        if (!token) throw new Error('删除站点需要显式传入该站点的 token（发布时返回的令牌）。');
        args.slug = slugValue(input.slug);
    } else {
        throw new Error('command 必须是 publish_site、get_site 或 delete_site。');
    }
    return { name, arguments: args };
}

function sanitizeResult(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('deed.page 返回的数据格式无效。');
    }
    // 远端响应是不可信数据：仅投影已知业务字段，不透传文案、原始 content 或未知嵌套对象。
    const result = {};
    const patterns = {
        slug: SLUG_PATTERN,
        version: /^v[0-9]+$/,
        plan: /^[a-z0-9_-]{1,32}$/,
        token: /^deed_tok_[A-Za-z0-9_-]{1,256}$/,
        expires_at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
        error: /^[a-zA-Z0-9_-]{1,64}$/
    };
    for (const [key, pattern] of Object.entries(patterns)) {
        if (typeof data[key] === 'string' && pattern.test(data[key])) result[key] = data[key];
    }
    for (const key of ['ok', 'unchanged', 'permanent']) {
        if (typeof data[key] === 'boolean') result[key] = data[key];
    }
    for (const key of ['bytes', 'files']) {
        if (Number.isSafeInteger(data[key]) && data[key] >= 0) result[key] = data[key];
    }
    for (const key of ['url', 'path_url', 'version_url', 'manifest_url']) {
        const value = data[key];
        // 限定 HTTPS deed.page 地址及路径字符，拒绝外站、凭据、查询参数和夹带的自由文本。
        if (typeof value === 'string' && value.length <= 2048 &&
            /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)?deed\.page\/[a-zA-Z0-9/_-]*$/.test(value)) {
            result[key] = value;
        }
    }
    if (typeof data.deleted === 'boolean' ||
        (typeof data.deleted === 'string' && SLUG_PATTERN.test(data.deleted))) {
        result.deleted = data.deleted;
    }
    if (data.listing && typeof data.listing.listed === 'boolean') {
        result.listing = { listed: data.listing.listed };
    }
    if (result.token) {
        result.token_note = '请记住站点 slug 与对应 token，以便后续更新或删除；令牌是私密管理凭据，不要写入公开网页或分享给无关人员。后续调用须显式传入该站点的 token，插件不会自动保存或跨站点复用。';
    }
    return result;
}

async function processRequest(input, { fetch: fetchImpl = globalThis.fetch } = {}) {
    const params = normalizeArguments(input);
    const token = input.token === undefined ? '' : input.token.trim();
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'VCPToolBox-DeedPage', version: '1.0.0' });
    const headers = { 'User-Agent': USER_AGENT };
    // 只使用本次调用显式传入的令牌，不读取环境变量或复用其他站点的凭据。
    if (token) headers.Authorization = `Bearer ${token}`;
    const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        requestInit: { headers },
        fetch: fetchImpl
    });
    const options = { signal: AbortSignal.timeout(TIMEOUT_MS), timeout: TIMEOUT_MS };
    const onAbort = () => { client.close().catch(() => {}); };
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
        await client.connect(transport, options);
        const { tools } = await client.listTools({}, options);
        if (!tools.some(tool => tool.name === params.name)) throw new Error(`服务未提供 ${params.name}。`);
        const response = await client.callTool(params, undefined, options);
        const text = (response.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
        let data = response.structuredContent;
        if (!data) {
            try { data = JSON.parse(text); } catch {
                return { status: 'error', error: 'deed.page 返回了无法解析的工具结果。' };
            }
        }
        const result = sanitizeResult(data);
        if (response.isError || result.ok === false) {
            // 错误路径同样不回显远端自由文本，避免清洗后的内容从 error 字段重新进入上下文。
            return { status: 'error', error: `deed.page MCP 工具调用失败${result.error ? `（${result.error}）` : ''}。`, result };
        }
        return { status: 'success', result };
    } finally {
        options.signal.removeEventListener('abort', onAbort);
        await client.close();
    }
}

if (require.main === module) {
    (async () => {
        try {
            let input = '';
            for await (const chunk of process.stdin) input += chunk;
            const output = await processRequest(JSON.parse(input));
            process.stdout.write(JSON.stringify(output));
        } catch (error) {
            process.stdout.write(JSON.stringify({ status: 'error', error: error.message }));
            process.exitCode = 1;
        }
    })();
}

module.exports = { processRequest, normalizeArguments, ENDPOINT, USER_AGENT };
