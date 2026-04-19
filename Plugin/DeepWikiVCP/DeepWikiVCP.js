/**
 * DeepWikiVCP v2.0 - VCP 同步插件
 * 通过 DeepWiki 官方 MCP API 获取 GitHub 仓库的 AI 生成文档
 *
 * API 端点: https://mcp.deepwiki.com/mcp
 * 协议: MCP over Streamable HTTP (JSON-RPC 2.0)
 * 认证: 公开仓库无需认证
 * 零外部依赖 - 仅使用 Node.js 18+ 内置 fetch()
 *
 * @author infinite-vector
 * @version 2.0.0
 */

// ============================================================
// 1. 配置与常量
// ============================================================

const MCP_ENDPOINT = 'https://mcp.deepwiki.com/mcp';
const REQUEST_TIMEOUT = 120000; // 120秒超时
const MAX_CONTENT_LENGTH = 80000; // 内容截断阈值（字符数），防止 token 爆炸

// ============================================================
// 2. 日志与响应工具
// ============================================================

const log = (msg) => {
    console.error(`[DeepWikiVCP] ${new Date().toISOString()}: ${msg}`);
};

const sendResponse = (data) => {
    console.log(JSON.stringify(data));
    process.exit(0);
};

const sendError = (message) => {
    sendResponse({ status: 'error', error: `DeepWiki Error: ${message}` });
};

// ============================================================
// 3. MCP 通信核心
// ============================================================

/**
 * 向 DeepWiki MCP 服务器发送 JSON-RPC 请求
 * MCP 协议使用 Streamable HTTP：
 *   - POST JSON-RPC 到 /mcp 端点
 *   - 响应可能是标准 JSON 或 SSE 流
 */
async function mcpCall(toolName, args) {
    const payload = {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        id: Date.now(),
    };

    log(`调用 MCP: ${toolName}, 参数: ${JSON.stringify(args)}`);

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
        const res = await fetch(MCP_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        clearTimeout(tid);

        if (!res.ok) {
            const errText = await res.text().catch(() => 'Unknown');
            throw new Error(`HTTP ${res.status}: ${errText.substring(0, 500)}`);
        }

        const ct = res.headers.get('content-type') || '';

        // 情况1: 标准 JSON 响应
        if (ct.includes('application/json')) {
            const r = await res.json();
            if (r.error) throw new Error(`MCP Error: ${JSON.stringify(r.error)}`);
            return r.result || r;
        }

        // 情况2: SSE 流式响应 (MCP Streamable HTTP)
        if (ct.includes('text/event-stream')) {
            return await parseSSE(res);
        }

        // 情况3: 纯文本回退
        const body = await res.text();
        try {
            const p = JSON.parse(body);
            if (p.error) throw new Error(`MCP Error: ${JSON.stringify(p.error)}`);
            return p.result || p;
        } catch {
            return { content: [{ type: 'text', text: body }] };
        }
    } catch (e) {
        clearTimeout(tid);
        if (e.name === 'AbortError') {
            throw new Error(`请求超时 (${REQUEST_TIMEOUT / 1000}秒)`);
        }
        throw e;
    }
}

/**
 * 解析 SSE (Server-Sent Events) 流式响应
 */
async function parseSSE(response) {
    const text = await response.text();
    const lines = text.split('\n');
    let lastData = null;

    for (const line of lines) {
        if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr && dataStr !== '[DONE]') {
                try {
                    lastData = JSON.parse(dataStr);
                } catch {
                    // 非 JSON 数据行，跳过
                }
            }
        }
    }

    if (lastData) {
        if (lastData.error) {
            throw new Error(`MCP SSE Error: ${JSON.stringify(lastData.error)}`);
        }
        return lastData.result || lastData;
    }

    // 没有解析到有效 JSON-RPC 结果，把整个文本作为内容返回
    return { content: [{ type: 'text', text }] };
}

// ============================================================
// 4. 结果提取与格式化
// ============================================================

/**
 * 从 MCP 响应中提取文本内容
 * MCP 工具返回格式: { content: [{ type: 'text', text: '...' }] }
 */
function extractText(result) {
    if (!result) return '(无返回内容)';

    // 标准 MCP 工具返回格式
    if (result.content && Array.isArray(result.content)) {
        return result.content
            .filter(item => item.type === 'text')
            .map(item => item.text)
            .join('\n\n');
    }

    // 直接文本
    if (typeof result === 'string') return result;

    // 嵌套结果
    if (result.result) return extractText(result.result);

    // 兜底：JSON 序列化
    return JSON.stringify(result, null, 2);
}

/**
 * 智能截断内容，防止 token 爆炸
 * 优先在换行符处截断，保持内容完整性
 */
function truncate(text, maxLen = MAX_CONTENT_LENGTH) {
    if (!text || text.length <= maxLen) return text;

    const truncated = text.substring(0, maxLen);
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = lastNewline > maxLen * 0.8 ? lastNewline : maxLen;

    return truncated.substring(0, cutPoint) +
        `\n\n---\n⚠️ [内容已截断] 原始 ${text.length} 字符，截断至 ${cutPoint} 字符。可用 wiki_ask 针对具体主题提问。`;
}

// ============================================================
// 5. 仓库标识解析
// ============================================================

/**
 * 将各种输入格式标准化为 owner/repo
 * 支持:
 *   - "owner/repo"
 *   - "https://github.com/owner/repo"
 *   - "https://deepwiki.com/owner/repo"
 *   - "https://deepwiki.com/owner/repo/some/page"
 *   - 带尾部斜杠的各种格式
 */
function parseRepo(input) {
    if (!input || typeof input !== 'string') return null;

    let cleaned = input.trim();

    // 去除 URL 前缀
    cleaned = cleaned.replace(/^https?:\/\/(www\.)?(github\.com|deepwiki\.com)\//, '');

    // 去除尾部斜杠
    cleaned = cleaned.replace(/\/+$/, '');

    // 提取 owner/repo (前两段路径)
    const parts = cleaned.split('/').filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
}

// ============================================================
// 6. 指令处理器
// ============================================================

/**
 * wiki_structure: 获取仓库的 wiki 目录结构
 */
async function handleStructure(args) {
    const repo = parseRepo(args.url || args.repo || args.reponame || args.repoName);
    if (!repo) {
        return sendError('无法解析仓库标识。请提供 owner/repo 格式，例如: lioensky/VCPToolBox');
    }

    log(`获取 wiki 结构: ${repo}`);

    try {
        const result = await mcpCall('read_wiki_structure', { repoName: repo });
        const text = truncate(extractText(result));

        sendResponse({
            status: 'success',
            result: `## 📚 DeepWiki 文档结构: ${repo}\n\n${text}`,
            messageForAI: `已获取 ${repo} 的 DeepWiki 文档目录结构。可用 wiki_content 读取完整文档，或用 wiki_ask 针对特定主题提问。`,
        });
    } catch (e) {
        sendError(`获取 ${repo} 的文档结构失败: ${e.message}`);
    }
}

/**
 * wiki_content: 读取仓库的完整 wiki 文档
 * 注意: DeepWiki MCP 的 read_wiki_contents 只接受 repoName 参数，
 * 返回整个仓库的文档内容，不支持指定单个页面。
 */
async function handleContent(args) {
    const repo = parseRepo(args.url || args.repo || args.reponame || args.repoName);
    if (!repo) {
        return sendError('无法解析仓库标识。请提供 owner/repo 格式。');
    }

    log(`获取 wiki 完整文档: ${repo}`);

    try {
        const result = await mcpCall('read_wiki_contents', { repoName: repo });
        const text = truncate(extractText(result));

        sendResponse({
            status: 'success',
            result: `## 📖 DeepWiki 完整文档: ${repo}\n\n${text}`,
            messageForAI: `已获取 ${repo} 的完整 DeepWiki 文档。如内容被截断，可用 wiki_ask 针对具体主题提问。`,
        });
    } catch (e) {
        sendError(`获取 ${repo} 的文档内容失败: ${e.message}`);
    }
}

/**
 * wiki_ask: 向 DeepWiki AI 提问
 */
async function handleAsk(args) {
    const repo = parseRepo(args.url || args.repo || args.reponame || args.repoName);
    const question = args.question || args.query || args.q;

    if (!repo) {
        return sendError('无法解析仓库标识。请提供 owner/repo 格式。');
    }
    if (!question) {
        return sendError('缺少必需参数: question。请提供你想问的问题。');
    }

    log(`向 DeepWiki 提问: ${repo}, 问题: ${question}`);

    try {
        const result = await mcpCall('ask_question', { repoName: repo, question: question });
        const text = truncate(extractText(result));

        sendResponse({
            status: 'success',
            result: `## 🤖 DeepWiki AI 回答: ${repo}\n\n**问题**: ${question}\n\n---\n\n${text}`,
            messageForAI: `DeepWiki AI 已回答关于 ${repo} 的问题。`,
        });
    } catch (e) {
        sendError(`向 DeepWiki 提问失败: ${e.message}`);
    }
}

// ============================================================
// 7. 指令分发器
// ============================================================

/**
 * 根据 command 字段路由到对应的处理器
 * 支持同义词和大小写容错
 * 智能猜测：无 command 但有 question 时自动走 ask
 */
async function processRequest(req) {
    let cmd = (req.command || '').toLowerCase().trim();

    // 参数容错：统一处理大小写和同义词
    const args = {};
    for (const [k, v] of Object.entries(req)) {
        args[k.toLowerCase()] = v;
    }
    // 保持原始大小写的参数也能被识别
    Object.assign(args, req);

    // 智能猜测：如果没有显式 command 但有 question，优先走 ask
    const hasQuestion = args.question || args.query || args.q;
    if (!cmd && hasQuestion) {
        cmd = 'wiki_ask';
    }
    if (!cmd) {
        cmd = 'wiki_structure';
    }

    switch (cmd) {
        case 'wiki_structure':
        case 'structure':
        case 'list':
        case 'list_pages':
            return handleStructure(args);

        case 'wiki_content':
        case 'content':
        case 'read':
        case 'read_page':
        case 'fetch':
            return handleContent(args);

        case 'wiki_ask':
        case 'ask':
        case 'question':
        case 'search':
            return handleAsk(args);

        default:
            // 兜底：未知 command 时，有 question 走 ask，否则走 structure
            if (hasQuestion) return handleAsk(args);
            return handleStructure(args);
    }
}

// ============================================================
// 8. 插件入口 (stdio)
// ============================================================

let inputData = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
    inputData += chunk;
});

process.stdin.on('end', async () => {
    try {
        if (!inputData.trim()) {
            return sendError('未从 stdin 接收到任何数据。');
        }

        const request = JSON.parse(inputData);
        await processRequest(request);
    } catch (e) {
        if (e instanceof SyntaxError) {
            sendError('无法解析输入的 JSON 数据。');
        } else {
            log(`未捕获错误: ${e.message}`);
            sendError(`插件执行出错: ${e.message}`);
        }
    }
});