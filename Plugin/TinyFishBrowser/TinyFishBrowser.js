#!/usr/bin/env node
import https from 'https';
import http from 'http';

// ============================================================
//  Configuration
// ============================================================

const API_KEY = (process.env.TINYFISH_API_KEY || '').trim();
const SEARCH_API_HOST = 'api.search.tinyfish.ai';
const FETCH_API_HOST = 'api.fetch.tinyfish.ai';
const DEBUG_MODE = (process.env.DebugMode || 'false').toLowerCase() === 'true';

// ============================================================
//  Utilities
// ============================================================

function debugLog(msg, ...args) {
    if (DEBUG_MODE) console.error(`[TinyFish][Debug] ${msg}`, ...args);
}

function log(level, msg) {
    console.error(`[${new Date().toISOString()}] [TinyFish] [${level}] ${msg}`);
}

function outputAndExit(result) {
    const code = result.status === 'success' ? 0 : 1;
    process.stdout.write(JSON.stringify(result), () => process.exit(code));
}

// ============================================================
//  HTTPS Request Helper
// ============================================================

function httpsRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = data ? JSON.parse(data) : {};
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
                } catch (e) {
                    reject(new Error(`响应解析失败: ${e.message}. Raw: ${data.substring(0, 200)}`));
                }
            });
        });
        req.on('error', e => reject(new Error(`网络请求失败: ${e.message}`)));
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('请求超时(60秒)')); });
        if (postData) req.write(postData);
        req.end();
    });
}

// ============================================================
//  Search API Handler
// ============================================================

async function handleSearch(args) {
    const query = args.q || args.query || args.text || args.Query;
    if (!query) throw new Error('必须提供搜索关键词 (q/query/text)');

    const location = args.location || '';
    const language = args.language || '';
    const page = parseInt(args.page || '0', 10);
    const thumbnails = args.thumbnails === true || args.thumbnails === 'true';

    // Build query string
    const params = new URLSearchParams();
    params.set('query', query);
    if (location) params.set('location', location);
    if (language) params.set('language', language);
    if (!isNaN(page) && page >= 0 && page <= 10) params.set('page', String(page));
    if (thumbnails) params.set('thumbnails', 'true');

    const path = `/?${params.toString()}`;
    debugLog(`Search API 请求: ${SEARCH_API_HOST}${path}`);

    const res = await httpsRequest({
        hostname: SEARCH_API_HOST,
        port: 443,
        path,
        method: 'GET',
        headers: {
            'X-API-Key': API_KEY,
            'User-Agent': 'VCP-TinyFishBrowser/1.0'
        }
    });

    if (res.statusCode === 200) {
        const data = res.body;
        const results = data.results || [];
        const totalResults = data.total_results || results.length;

        // Format results for LLM consumption
        let text = `**TinyFish 搜索结果**\n\n`;
        text += `**查询**: ${query}\n`;
        if (location) text += `**地区**: ${location}\n`;
        if (language) text += `**语言**: ${language}\n`;
        text += `**结果数**: ${totalResults}\n`;
        text += `**页码**: ${data.page || 0}\n\n`;

        if (results.length === 0) {
            text += `未找到相关结果。\n`;
        } else {
            results.forEach((r, i) => {
                text += `### ${i + 1}. ${r.title}\n`;
                text += `**来源**: ${r.site_name || r.url}\n`;
                text += `**摘要**: ${r.snippet || '无摘要'}\n`;
                text += `**链接**: ${r.url}\n`;
                if (r.thumbnail_url) text += `![缩略图](${r.thumbnail_url})\n`;
                text += '\n';
            });
        }

        return {
            content: [{ type: 'text', text }],
            details: {
                query,
                totalResults,
                page: data.page || 0,
                results: results.map(r => ({
                    position: r.position,
                    title: r.title,
                    snippet: r.snippet,
                    url: r.url,
                    site_name: r.site_name
                }))
            }
        };
    }

    const errMsg = res.body?.error?.message || `API错误: ${res.statusCode}`;
    throw new Error(`搜索失败: ${errMsg}`);
}

// ============================================================
//  Fetch API Handler
// ============================================================

async function handleFetch(args) {
    let urls = args.urls || args.url || args.Url;

    if (!urls) throw new Error('必须提供要抓取的 URL (urls/url)');

    // Normalize to array
    if (typeof urls === 'string') {
        try {
            urls = JSON.parse(urls);
        } catch {
            urls = [urls];
        }
    }
    if (!Array.isArray(urls)) urls = [urls];

    if (urls.length === 0) throw new Error('URL 列表不能为空');
    if (urls.length > 10) {
        log('warn', `URL 数量超过10个，仅处理前10个`);
        urls = urls.slice(0, 10);
    }

    const format = args.format || 'markdown';
    const links = args.links === true || args.links === 'true';
    const imageLinks = args.image_links === true || args.image_links === 'true' || args.imageLinks === true;
    const includeHtmlHead = args.include_html_head === true || args.includeHtmlHead === 'true';

    const requestBody = {
        urls,
        format,
        links,
        image_links: imageLinks,
        include_html_head: includeHtmlHead
    };

    const postData = JSON.stringify(requestBody);
    debugLog(`Fetch API 请求: ${FETCH_API_HOST}/, body: ${postData.substring(0, 300)}`);

    const res = await httpsRequest({
        hostname: FETCH_API_HOST,
        port: 443,
        path: '/',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': API_KEY,
            'User-Agent': 'VCP-TinyFishBrowser/1.0',
            'Content-Length': Buffer.byteLength(postData)
        }
    }, postData);

    if (res.statusCode === 200) {
        const data = res.body;
        const results = data.results || [];
        const errors = data.errors || [];

        let text = `**TinyFish 网页抓取结果**\n\n`;
        text += `**请求URL数**: ${urls.length}\n`;
        text += `**成功**: ${results.length}\n`;
        text += `**失败**: ${errors.length}\n`;
        text += `**输出格式**: ${format}\n\n`;

        // Successful results
        for (const r of results) {
            text += `---\n`;
            text += `### ${r.title || '无标题'}\n`;
            text += `**URL**: ${r.url}\n`;
            if (r.final_url && r.final_url !== r.url) text += `**最终URL**: ${r.final_url}\n`;
            if (r.description) text += `**描述**: ${r.description}\n`;
            if (r.language) text += `**语言**: ${r.language}\n`;
            if (r.author) text += `**作者**: ${r.author}\n`;
            if (r.published_date) text += `**发布日期**: ${r.published_date}\n`;
            if (r.latency_ms) text += `**加载耗时**: ${r.latency_ms.toFixed(0)}ms\n`;

            // Content
            if (r.text) {
                if (typeof r.text === 'string') {
                    // Truncate very long content
                    const maxLen = 8000;
                    const content = r.text.length > maxLen
                        ? r.text.substring(0, maxLen) + `\n\n...（内容过长，已截断至 ${maxLen} 字符，完整内容请查看 details）`
                        : r.text;
                    text += `\n**内容**:\n\n${content}\n`;
                } else if (typeof r.text === 'object') {
                    text += `\n**内容**: (JSON 结构化数据，详见 details)\n\`\`\`json\n${JSON.stringify(r.text, null, 2).substring(0, 2000)}\n\`\`\`\n`;
                }
            }

            // Links
            if (r.links && r.links.length > 0) {
                text += `\n**外链 (${r.links.length}个)**:\n`;
                r.links.slice(0, 20).forEach(link => { text += `- ${link}\n`; });
                if (r.links.length > 20) text += `- ... 还有 ${r.links.length - 20} 个链接\n`;
            }

            // Image links
            if (r.image_links && r.image_links.length > 0) {
                text += `\n**图片链接 (${r.image_links.length}个)**:\n`;
                r.image_links.slice(0, 10).forEach(img => { text += `- ${img}\n`; });
                if (r.image_links.length > 10) text += `- ... 还有 ${r.image_links.length - 10} 个图片\n`;
            }

            text += '\n';
        }

        // Errors
        if (errors.length > 0) {
            text += `\n**抓取失败的URL**:\n`;
            errors.forEach(e => {
                text += `- ${e.url}: ${e.error}\n`;
            });
        }

        return {
            content: [{ type: 'text', text }],
            details: {
                results: results.map(r => ({
                    url: r.url,
                    final_url: r.final_url,
                    title: r.title,
                    description: r.description,
                    language: r.language,
                    format: r.format,
                    text: r.text,
                    author: r.author,
                    published_date: r.published_date,
                    links: r.links,
                    image_links: r.image_links,
                    latency_ms: r.latency_ms
                })),
                errors
            }
        };
    }

    const errMsg = res.body?.error?.message || `API错误: ${res.statusCode}`;
    throw new Error(`抓取失败: ${errMsg}`);
}

// ============================================================
//  Main
// ============================================================

async function main() {
    try {
        if (!API_KEY) {
            throw new Error('未配置 TINYFISH_API_KEY，请在 config.env 中设置');
        }

        // Read stdin
        const input = await new Promise(resolve => {
            let data = '';
            process.stdin.on('data', chunk => data += chunk);
            process.stdin.on('end', () => resolve(data));
        });

        if (!input.trim()) {
            outputAndExit({ status: 'error', error: 'TinyFishBrowser Plugin Error: 未收到输入数据' });
            return;
        }

        const args = JSON.parse(input);
        debugLog('收到参数:', JSON.stringify(args).substring(0, 300));

        const command = (args.command || args.Command || args.cmd || '').toLowerCase();

        let result;

        switch (command) {
            case 'tinyfishsearch':
            case 'search':
            case 's': {
                result = await handleSearch(args);
                break;
            }
            case 'tinyfishfetch':
            case 'fetch':
            case 'f': {
                result = await handleFetch(args);
                break;
            }
            default:
                throw new Error(`未知命令: "${command}"。可用命令: TinyFishSearch (搜索), TinyFishFetch (抓取)`);
        }

        log('info', `命令 "${command}" 执行成功`);
        outputAndExit({ status: 'success', result });

    } catch (error) {
        log('error', `错误: ${error.message}`);
        outputAndExit({ status: 'error', error: `TinyFishBrowser Plugin Error: ${error.message}` });
    }
}

main();