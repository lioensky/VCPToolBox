/**
 * DeepWikiVCP v2.1.0 - VCP同步插件
 * 通过DeepWiki 官方 MCP API 获取任意GitHub公开仓库的 AI 生成文档
 *
 * 支持功能:
 * - wiki_structure: 获取文档目录结构
 * - wiki_content: 读取完整文档内容
 * - wiki_ask: AI 智能问答 (支持 Deep Research /多仓库查询)
 *
 * API 端点: https://mcp.deepwiki.com/mcp
 * 协议: MCP over Streamable HTTP (JSON-RPC 2.0)
 * 认证: 公开仓库无需认证
 * 零外部依赖 -仅使用 Node.js 18+ 内置 fetch()
 *
 * === MCP 参数限制 ===
 * ask_question schema: { repoName: string|string[], question: string }
 * 不接受其他参数。Deep Research 通过 [DEEP RESEARCH] 前缀实现。
 *
 * === 代理策略 ===
 * 仅当 config.env中显式配置 DEEPWIKI_PROXY 时才启用代理。
 * 不读取系统级HTTP_PROXY，避免劫持系统代理导致不稳定。
 * 代理请求使用15秒快速超时，失败后自动回退直连(180秒超时)。
 *
 * @author infinite-vector
 * @version 2.1.0
 */

//============================================================
// 1. 配置与常量
// ============================================================
const MCP_ENDPOINT = 'https://mcp.deepwiki.com/mcp';
const REQUEST_TIMEOUT = 180000;
const PROXY_TIMEOUT = 15000;
const MAX_CONTENT_LENGTH = 80000;

//============================================================
// 2. 代理支持
// ============================================================
let proxyDispatcher = null;

function setupProxy() {
  const explicitProxy = process.env.DEEPWIKI_PROXY;
  if (!explicitProxy) {
    log('未配置 DEEPWIKI_PROXY，使用默认网络（与v2.0行为一致）');
    return;
  }
  log(`检测到显式代理: ${explicitProxy}`);
  try {
    const { ProxyAgent } = require('undici');
    proxyDispatcher = new ProxyAgent({ uri: explicitProxy, allowH2: false });
    log(`ProxyAgent 已创建 (H2禁用): ${explicitProxy}`);
  } catch (e) {
    log(`ProxyAgent 创建失败 (${e.message})，使用默认网络`);
    proxyDispatcher = null;
  }
}

// ============================================================
// 3. 日志与响应
// ============================================================
const log = (msg) => console.error(`[DeepWikiVCP] ${new Date().toISOString()}: ${msg}`);
const sendResponse = (data) => { console.log(JSON.stringify(data)); process.exit(0); };
const sendError = (message) => sendResponse({ status: 'error', error: `DeepWiki Error: ${message}` });

// ============================================================
// 4. MCP 通信核心
// ============================================================
async function mcpCallOnce(toolName, args, dispatcher, timeout) {
  const payload = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id: Date.now(),
  };

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeout);

  const fetchOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  };
  if (dispatcher) fetchOptions.dispatcher = dispatcher;

  try {
    const res = await fetch(MCP_ENDPOINT, fetchOptions);
    clearTimeout(tid);

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown');
      throw new Error(`HTTP ${res.status}: ${errText.substring(0, 500)}`);
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const r = await res.json();
      if (r.error) throw new Error(`MCP Error: ${JSON.stringify(r.error)}`);
      return r.result || r;
    }
    if (ct.includes('text/event-stream')) {
      return await parseSSE(res);
    }
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
      throw new Error(`请求超时 (${timeout / 1000}秒)`);
    }
    throw e;
  }
}

async function mcpCall(toolName, args) {
  log(`调用 MCP: ${toolName}, 参数: ${JSON.stringify(args)}`);

  if (proxyDispatcher) {
    try {
      return await mcpCallOnce(toolName, args, proxyDispatcher, PROXY_TIMEOUT);
    } catch (e) {
      log(`代理请求失败 (${e.message})，回退直连...`);
      try {
        return await mcpCallOnce(toolName, args, null, REQUEST_TIMEOUT);
      } catch (e2) {
        throw new Error(`代理和直连均失败。代理: ${e.message} | 直连: ${e2.message}`);
      }
    }
  }

  return await mcpCallOnce(toolName, args, null, REQUEST_TIMEOUT);
}

async function parseSSE(response) {
  const text = await response.text();
  const lines = text.split('\n');
  let lastData = null;
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const dataStr = line.slice(6).trim();
      if (dataStr && dataStr !== '[DONE]') {
        try { lastData = JSON.parse(dataStr); } catch { /* skip */ }
      }
    }
  }
  if (lastData) {
    if (lastData.error) throw new Error(`MCP SSE Error: ${JSON.stringify(lastData.error)}`);
    return lastData.result || lastData;
  }
  return { content: [{ type: 'text', text }] };
}

// ============================================================
// 5. 结果提取与格式化
// ============================================================
function extractText(result) {
  if (!result) return '(无返回内容)';
  if (result.content && Array.isArray(result.content)) {
    return result.content.filter(i => i.type === 'text').map(i => i.text).join('\n\n');
  }
  if (typeof result === 'string') return result;
  if (result.result) return extractText(result.result);
  return JSON.stringify(result, null, 2);
}

function truncate(text, maxLen = MAX_CONTENT_LENGTH) {
  if (!text || text.length <= maxLen) return text;
  const truncated = text.substring(0, maxLen);
  const lastNL = truncated.lastIndexOf('\n');
  const cutPoint = lastNL > maxLen * 0.8 ? lastNL : maxLen;
  return truncated.substring(0, cutPoint) +`\n\n---\n⚠️ [内容已截断] 原始${text.length}字符，截断至${cutPoint}字符。可用wiki_ask针对具体主题提问。`;
}

// ============================================================
// 6. 仓库标识解析
// ============================================================
function parseRepo(input) {
  if (!input || typeof input !== 'string') return null;
  let cleaned = input.trim();
  cleaned = cleaned.replace(/^https?:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org|deepwiki\.com)\//, '');
  cleaned = cleaned.replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
}

/** 支持逗号分隔的多仓库，最多10个 */
function parseRepoInput(input) {
  if (!input || typeof input !== 'string') return null;
  if (input.includes(',')) {
    const repos = input.split(',').map(s => parseRepo(s.trim())).filter(Boolean);
    if (repos.length === 0) return null;
    if (repos.length === 1) return repos[0];
    if (repos.length > 10) {
      log(`警告: 提供了${repos.length}个仓库，最多支持10个，已截断至前10个`);
      return repos.slice(0, 10);
    }
    return repos;
  }
  return parseRepo(input);
}

// ============================================================
// 7. 高级参数收集器(预留)
// ============================================================
function collectAdvancedParams(args) {
  const adv = {};
  const token = args.token || process.env.DEEPWIKI_GITHUB_TOKEN || process.env.DEEPWIKI_GITLAB_TOKEN;
  if (token) adv.token = token;
  if (args.type) adv.type = args.type;
  if (args.provider) adv.provider = args.provider;
  if (args.model) adv.model = args.model;
  if (args.language) adv.language = args.language;
  const fp = args.filepath || args.filePath || args.file_path;
  if (fp) adv.filePath = fp;
  if (args.excluded_dirs || args.excludedDirs) adv.excluded_dirs = args.excluded_dirs || args.excludedDirs;
  if (args.included_dirs || args.includedDirs) adv.included_dirs = args.included_dirs || args.includedDirs;
  return adv;
}

// ============================================================
// 8. 指令处理器
// ============================================================
async function handleStructure(args) {
  const repo = parseRepo(args.url || args.repo || args.reponame || args.repoName);
  if (!repo) return sendError('无法解析仓库标识。请提供 owner/repo 格式');
  log(`获取 wiki结构: ${repo}`);
  try {
    const result = await mcpCall('read_wiki_structure', { repoName: repo });
    sendResponse({
      status: 'success',
      result: `##📚 DeepWiki 文档结构: ${repo}\n\n${truncate(extractText(result))}`,
      messageForAI: `已获取 ${repo} 的文档目录。可用 wiki_content 读取完整文档，或 wiki_ask 提问。`,
    });
  } catch (e) { sendError(`获取 ${repo} 文档结构失败: ${e.message}`); }
}

async function handleContent(args) {
  const repo = parseRepo(args.url || args.repo || args.reponame || args.repoName);
  if (!repo) return sendError('无法解析仓库标识。请提供 owner/repo 格式');
  log(`获取 wiki 完整文档: ${repo}`);
  try {
    const result = await mcpCall('read_wiki_contents', { repoName: repo });
    sendResponse({
      status: 'success',
      result: `## 📖 DeepWiki 完整文档: ${repo}\n\n${truncate(extractText(result))}`,
      messageForAI: `已获取 ${repo} 的完整文档。如被截断，可用 wiki_ask 针对具体主题提问。`,
    });
  } catch (e) { sendError(`获取 ${repo} 文档内容失败: ${e.message}`); }
}

async function handleAsk(args) {
  const repoInput = parseRepoInput(args.url || args.repo || args.reponame || args.repoName);
  let question = args.question || args.query || args.q;
  if (!repoInput) return sendError('无法解析仓库标识。owner/repo 格式，多仓库逗号分隔(最多10个)');
  if (!question) return sendError('缺少 question 参数');

  // 检测多仓库截断
  const rawUrl = args.url || args.repo || args.reponame || args.repoName || '';
  const originalCount = rawUrl.includes(',') ? rawUrl.split(',').filter(s => s.trim()).length : 0;
  const wasTruncated = originalCount > 10;

  const deepResearch = args.deep_research === true || args.deep_research === 'true'
    || args.deepresearch === true || args.deepresearch === 'true'
    || args.deepResearch === true || args.deepResearch === 'true';
  if (deepResearch) { question = `[DEEP RESEARCH] ${question}`; log('Deep Research 已激活'); }

  const isMulti = Array.isArray(repoInput);
  const label = isMulti ? repoInput.join(' + ') : repoInput;
  if (isMulti) log(`多仓库查询: ${repoInput.length}个`);

  const adv = collectAdvancedParams(args);
  if (Object.keys(adv).length > 0) log(`高级参数(预留): ${JSON.stringify(adv)}`);

  log(`提问: ${label}, 问题: ${question}`);
  try {
    const result = await mcpCall('ask_question', { repoName: repoInput, question });
    const mode = deepResearch ? '🔬 Deep Research' : '🤖 AI 回答';
    const multi = isMulti ? ` (跨${repoInput.length}个仓库)` : '';
    const truncNote = wasTruncated ? ` ⚠️ 原始提供了${originalCount}个仓库，已截断至前10个。` : '';
    sendResponse({
      status: 'success',
      result: `## ${mode}: ${label}${multi}\n\n**问题**: ${question}\n\n---\n\n${truncate(extractText(result))}`,
      messageForAI: `DeepWiki 已回答 ${label} 的问题。${deepResearch ? '(Deep Research)' : ''}${multi}${truncNote}`,
    });
  } catch (e) { sendError(`提问失败: ${e.message}`); }
}

// ============================================================
// 9. 指令分发器
// ============================================================
async function processRequest(req) {
  let cmd = (req.command || '').toLowerCase().trim();
  const args = {};
  for (const [k, v] of Object.entries(req)) { args[k.toLowerCase()] = v; }
  Object.assign(args, req);

  const hasQ = args.question || args.query || args.q;
  if (!cmd && hasQ) cmd = 'wiki_ask';
  if (!cmd) cmd = 'wiki_structure';

  switch (cmd) {
    case 'wiki_structure': case 'structure': case 'list': case 'list_pages':
      return handleStructure(args);
    case 'wiki_content': case 'content': case 'read': case 'read_page': case 'fetch':
      return handleContent(args);
    case 'wiki_ask': case 'ask': case 'question': case 'search':
      return handleAsk(args);
    default:
      if (hasQ) return handleAsk(args);
      return handleStructure(args);
  }
}

// ============================================================
// 10. 入口
// ============================================================
setupProxy();
let inputData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { inputData += chunk; });
process.stdin.on('end', async () => {
  try {
    if (!inputData.trim()) return sendError('未从stdin接收到数据');
    await processRequest(JSON.parse(inputData));
  } catch (e) {
    if (e instanceof SyntaxError) sendError('无法解析JSON数据');
    else { log(`未捕获错误: ${e.message}`); sendError(`插件出错: ${e.message}`); }
  }
});