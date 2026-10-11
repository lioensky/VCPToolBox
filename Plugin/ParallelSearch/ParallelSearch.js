'use strict';

const ENDPOINT = 'https://search.parallel.ai/mcp';
const USER_AGENT = 'VCPToolBox-ParallelSearch/1.0.0 (https://github.com/lioensky/VCPToolBox)';
const TIMEOUT_MS = 45000;

function stringValue(value, name, maxLength) {
    if (typeof value !== 'string' || !value.trim() || (maxLength && value.length > maxLength)) {
        throw new Error(`${name} 必须是非空字符串${maxLength ? `，最多 ${maxLength} 字符` : ''}。`);
    }
    return value;
}

// VCP 文本参数可以传 JSON 数组；直接调用时也接受数组。
function stringList(value, name, maxItems) {
    if (typeof value === 'string') {
        try { value = JSON.parse(value); }
        catch { throw new Error(`${name} 必须是 JSON 字符串数组。`); }
    }
    if (!Array.isArray(value) || !value.length || (maxItems && value.length > maxItems)) {
        throw new Error(`${name} 必须是非空字符串数组${maxItems ? `，最多 ${maxItems} 项` : ''}。`);
    }
    return value.map(item => stringValue(item, name));
}

function normalizeArguments(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('输入必须是 JSON 对象。');
    }
    const name = input.command;
    const args = {};
    if (name === 'web_search') {
        args.objective = stringValue(input.objective, 'objective');
        args.search_queries = stringList(input.search_queries, 'search_queries');
    } else if (name === 'web_fetch') {
        args.urls = stringList(input.urls, 'urls', 20);
        for (const url of args.urls) {
            let parsed;
            try { parsed = new URL(url); } catch { throw new Error('urls 必须是有效的 HTTP/HTTPS URL。'); }
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                throw new Error('urls 仅支持 HTTP/HTTPS URL。');
            }
        }
        if (input.objective !== undefined) args.objective = stringValue(input.objective, 'objective', 200);
        if (input.search_queries !== undefined) args.search_queries = stringList(input.search_queries, 'search_queries');
        if (input.full_content !== undefined) {
            if (![true, false, 'true', 'false'].includes(input.full_content)) {
                throw new Error('full_content 必须是 true 或 false。');
            }
            args.full_content = input.full_content === true || input.full_content === 'true';
        }
    } else {
        throw new Error('command 必须是 web_search 或 web_fetch。');
    }
    if (input.session_id !== undefined) args.session_id = stringValue(input.session_id, 'session_id', 100);
    return { name, arguments: args };
}

async function processRequest(input, { fetch: fetchImpl = globalThis.fetch } = {}) {
    const params = normalizeArguments(input);
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'VCPToolBox-ParallelSearch', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        requestInit: { headers: { 'User-Agent': USER_AGENT } },
        fetch: fetchImpl
    });
    const options = { signal: AbortSignal.timeout(TIMEOUT_MS), timeout: TIMEOUT_MS };
    // SDK 初始化通知不使用 request options；总截止时间也必须中止传输。
    const onAbort = () => { client.close().catch(() => {}); };
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
        await client.connect(transport, options);
        const { tools } = await client.listTools({}, options);
        if (!tools.some(tool => tool.name === params.name)) throw new Error(`服务未提供 ${params.name}。`);
        const response = await client.callTool(params, undefined, options);
        const content = response.content;
        // PluginManager 会解包 result；把 content 和结构化数据一起放入其中。
        const result = { ...response.structuredContent, content };
        if (response.isError) {
            return { status: 'error', error: content.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Parallel MCP 工具调用失败。', result };
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
