#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const { formatSearchResults } = require("./resultFormatter");

const TIMEOUT_DEFAULT_MS = 30000;
const TIMEOUT_MIN_MS = 1000;
// VCP host kills this synchronous process at 45s; keep cleanup headroom.
const TIMEOUT_MAX_MS = 40000;
const MAX_RESULTS_MIN = 1;
const MAX_RESULTS_MAX = 10;
const ZONES = new Set(["cn", "intl"]);
const BATCH_MAX = 5;
const DOMAINS_MAX = 5;

// 能力级隐式路由：搜索固定走结构化 REST；目录查询、正文提取和维护同步走 MCP。
const DEFAULT_SEARCH_ENDPOINT = "https://api.anysearch.com/v1/search";
const DEFAULT_MCP_ENDPOINT = "https://api.anysearch.com/mcp";

// Official AnySearch domains. Flow: pick the matching domain, call get_sub_domains(domain)
// to learn its sub_domains + required params, then run a vertical `search`.
const DOMAINS = [
  "general",
  "resource",
  "social_media",
  "finance",
  "academic",
  "legal",
  "health",
  "business",
  "security",
  "ip",
  "code",
  "energy",
  "environment",
  "agriculture",
  "travel",
  "film",
  "gaming",
];
const DOMAIN_SET = new Set(DOMAINS);

// 请求命令 -> JSON-RPC 工具名（仅大小写/连字符归一，不做旧名兼容）。
const COMMANDS = new Set([
  "search",
  "get_sub_domains",
  "batch_search",
  "extract",
]);

process.stdin.setEncoding("utf8");
if (process.stdout.setDefaultEncoding)
  process.stdout.setDefaultEncoding("utf8");

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

// VCP convention: surface errors through the JSON payload on stdout and exit 0
// (the host reads stdout; a non-zero exit would be treated as a crash).
function fail(message) {
  emit({ status: "error", error: `AnySearch Error: ${message}` });
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input.replace(/^﻿/, "")));
  });
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) fail("stdin 未收到输入。");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    fail("stdin 不是合法的 JSON。");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("输入必须是 JSON 对象。");
  }
  return payload;
}

function firstString(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeCommand(payload) {
  const raw = firstString(payload, ["command", "action", "tool", "mode"]);
  if (raw) {
    const command = raw.toLowerCase().replace(/-/g, "_").trim();
    if (!COMMANDS.has(command)) {
      fail(
        "无效命令。可用命令：search、get_sub_domains、batch_search、extract。"
      );
    }
    return command;
  }
  // command 省略时按参数推断：有 queries 即批量，有 url（且无 query）即提取，否则搜索。
  if (payload.queries !== undefined || payload.query_items !== undefined)
    return "batch_search";
  const hasQuery = !!firstString(payload, ["query", "q", "text", "Query"]);
  if (!hasQuery && firstString(payload, ["url", "URL", "link"]))
    return "extract";
  return "search";
}

function parseZone(source, keys = ["zone", "Zone"]) {
  const zone = firstString(source, keys).toLowerCase();
  if (!zone) return undefined;
  if (!ZONES.has(zone)) {
    fail("zone 仅支持 cn（中国大陆）或 intl（国际）。");
  }
  return zone;
}

function parseMaxResults(source) {
  const value = source.max_results ?? source.maxResults;
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) fail("max_results 必须是整数。");
  return Math.max(MAX_RESULTS_MIN, Math.min(MAX_RESULTS_MAX, parsed));
}

// 子领域参数：首选纯文本 k=v,k2=v2（空值写 k=）；也接受对象 / JSON 对象字符串；
// v3 对齐：额外兼容 PowerShell 风格 {k:v,k2:v2}（JSON.parse 失败时的容错路径）。
function parseSubDomainParams(source) {
  const value =
    source.params ??
    source.sub_domain_params ??
    source.subDomainParams ??
    source.sdp;
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("{")) {
      // 先尝试标准 JSON
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          return parsed;
      } catch (_) {
        /* fall through to PowerShell-style parse */
      }
      // v3 对齐：PowerShell 风格 {k:v,k2:v2} 容错（不带引号的键值对）
      const inner = trimmed.replace(/^\{|\}$/g, "").trim();
      if (inner) {
        const result = {};
        let ok = true;
        for (const pair of inner.split(",")) {
          const item = pair.trim();
          if (!item) continue;
          const colon = item.indexOf(":");
          if (colon <= 0) {
            ok = false;
            break;
          }
          result[item.slice(0, colon).trim()] = item.slice(colon + 1).trim();
        }
        if (ok && Object.keys(result).length > 0) return result;
      }
    } else if (trimmed.includes("=")) {
      const result = {};
      for (const pair of trimmed.split(",")) {
        const item = pair.trim();
        if (!item) continue;
        const eq = item.indexOf("=");
        if (eq <= 0)
          fail(
            `sub_domain_params 文本格式应为 k=v,k2=v2（空值写 k=），收到："${item}"。`
          );
        result[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
      }
      return result;
    }
  }
  fail(
    "sub_domain_params 应为 k=v,k2=v2 文本（空值写 k=），{k:v,k2:v2} 或 JSON 对象。"
  );
}

function parseDomainList(value) {
  if (value === undefined || value === null || value === "") return [];
  let list = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    try {
      const parsed = JSON.parse(trimmed);
      list = Array.isArray(parsed) ? parsed : trimmed.split(",");
    } catch (_) {
      list = trimmed.split(",");
    }
  }
  if (!Array.isArray(list)) list = [list];
  return list.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

function assertDomain(domain) {
  if (!DOMAIN_SET.has(domain)) {
    fail(`无效领域 "${domain}"。可用领域：${DOMAINS.join(", ")}。`);
  }
  return domain;
}

function buildGetSubDomainsArguments(payload) {
  const domains = parseDomainList(payload.domains);
  if (domains.length > 0) {
    if (domains.length > DOMAINS_MAX)
      fail(`domains 最多 ${DOMAINS_MAX} 个领域。`);
    domains.forEach(assertDomain);
    return { domains };
  }
  const domain = firstString(payload, ["domain", "Domain"]).toLowerCase();
  if (!domain) fail("get_sub_domains 需要 domain 或 domains 参数。");
  return { domain: assertDomain(domain) };
}

function buildExtractArguments(payload) {
  const url = firstString(payload, ["url", "URL", "link"]);
  if (!url) fail("extract 缺少必填参数 url。");
  if (!/^https?:\/\//i.test(url)) fail("url 必须以 http:// 或 https:// 开头。");
  return { url };
}

// v3 对齐：统一编译搜索任务 IR。把 VCP 输入编译成 1-5 个内部任务数组，
// 供 executeSearchTasks 有界并发执行。三种模式：
//   1. 单路：只有顶层 query，无编号字段 → 1 个任务
//   2. 同路多词：queries（| 分隔），共享 sub_domain/zone/params/max_results → N 个任务
//   3. 自由路线：queryN/sub_domainN/zoneN/paramsN/max_resultsN（N=1..5），继承顶层默认值
// 规则：
//   - queries 与编号字段混用 → 报错
//   - 编号不连续 → 允许，按升序稳定输出
//   - 只有 max_resultsN 没有 query/tag/params 差异 → 不创建路线
//   - 每条路线最终必须有 query
//   - 最多 5 路
function compileSearchTasks(payload) {
  const topQuery = firstString(payload, ["query", "q", "text", "Query"]);
  const topSubDomain = firstString(payload, [
    "sub_domain",
    "subDomain",
    "subdomain",
  ]);
  const topZone = parseZone(payload);
  const topParams = parseSubDomainParams(payload);
  const topMaxResults = parseMaxResults(payload);

  // 检测编号字段
  const numberedFields = [];
  for (let i = 1; i <= 5; i++) {
    const keys = [
      `query${i}`,
      `q${i}`,
      `text${i}`,
      `sub_domain${i}`,
      `subDomain${i}`,
      `zone${i}`,
      `params${i}`,
      `sdp${i}`,
      `max_results${i}`,
    ];
    if (
      keys.some(
        (k) =>
          payload[k] !== undefined && payload[k] !== null && payload[k] !== ""
      )
    ) {
      numberedFields.push(i);
    }
  }

  // 检测 queries
  const hasQueries =
    payload.queries !== undefined || payload.query_items !== undefined;

  // 规则：queries 与编号字段混用 → 报错
  if (hasQueries && numberedFields.length > 0) {
    fail(
      "queries 与编号字段（query1/sub_domain1 等）不能混用；请选择一种编排方式。"
    );
  }

  // 模式 2：同路多词（queries）
  if (hasQueries) {
    const raw = payload.queries ?? payload.query_items;
    let items = raw;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      try {
        items = JSON.parse(trimmed);
      } catch (_) {
        items = trimmed
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
    if (!Array.isArray(items)) items = [items];
    if (items.length < 1 || items.length > BATCH_MAX) {
      fail(`queries 需要 1-${BATCH_MAX} 个查询。`);
    }
    // 每个查询共享顶层 sub_domain/zone/params/max_results
    return items.map((item, idx) => {
      const query =
        typeof item === "string"
          ? item.trim()
          : firstString(item, ["query", "q", "text", "Query"]);
      if (!query) fail(`queries 的第 ${idx + 1} 项缺少 query。`);
      const task = { routeIndex: idx, query };
       if (topSubDomain) task.sub_domain = topSubDomain;
       if (topZone) task.zone = topZone;
       if (topParams) task.params = topParams;
      if (topMaxResults !== undefined) task.max_results = topMaxResults;
      return task;
    });
  }

  // 模式 3：自由路线编排（编号字段）
  if (numberedFields.length > 0) {
    const tasks = [];
    for (const i of numberedFields) {
      const query = firstString(payload, [`query${i}`, `q${i}`, `text${i}`]);
       const subDomain = firstString(payload, [
         `sub_domain${i}`,
         `subDomain${i}`,
       ]);
      const zone = parseZone(payload, [`zone${i}`]);
       const params = parseSubDomainParams({
        params: payload[`params${i}`],
        sdp: payload[`sdp${i}`],
        sub_domain_params: payload[`sub_domain_params${i}`],
      });
      const maxResults = parseMaxResults({
        max_results: payload[`max_results${i}`],
        maxResults: payload[`maxResults${i}`],
      });

      // 继承顶层默认值
       const finalQuery = query || topQuery;
       const finalSubDomain = subDomain || topSubDomain;
       const finalZone = zone || topZone;
       const finalParams = params || topParams;
      const finalMaxResults =
        maxResults !== undefined ? maxResults : topMaxResults;

      // 只有 max_resultsN 没有 query/tag/zone/params 差异 → 不创建路线
      // 即：编号字段只提供了 max_resultsN，且无顶层 query 可继承
       const hasOverride = query || subDomain || zone || params;
      if (!hasOverride && !topQuery) {
        continue; // 空路线：只有 max_resultsN，无 query 可继承
      }
      if (!finalQuery) {
        fail(`路线 ${i} 缺少 query（顶层或编号 query${i} 均未提供）。`);
      }

      const task = { routeIndex: i, query: finalQuery };
       if (finalSubDomain) task.sub_domain = finalSubDomain;
       if (finalZone) task.zone = finalZone;
       if (finalParams) task.params = finalParams;
      if (finalMaxResults !== undefined) task.max_results = finalMaxResults;
      tasks.push(task);
    }
    if (tasks.length === 0) fail("自由路线编排未产生任何有效路线。");
    if (tasks.length > BATCH_MAX) fail(`自由路线编排最多 ${BATCH_MAX} 路。`);
    return tasks;
  }

  // 模式 1：单路搜索
  if (!topQuery) fail("search 缺少必填参数 query。");
  const task = { routeIndex: 0, query: topQuery };
   if (topSubDomain) task.sub_domain = topSubDomain;
   if (topZone) task.zone = topZone;
   if (topParams) task.params = topParams;
  if (topMaxResults !== undefined) task.max_results = topMaxResults;
  return [task];
}

// 1-5 路搜索使用非阻塞 HTTP 并发；单路失败不取消其他路线，不重试 429。
// 搜索固定走 REST，以保持结构化裁剪、全局去重和稳定输出契约。
function normalizeMcpToolResponse(response) {
  if (!response.ok) return response;
  const data = response.data || {};
  if (data.error) {
    return {
      ...response,
      ok: false,
      error: data.error.message || "MCP 工具返回错误",
      requestId: data.error.data?.request_id || response.requestId,
    };
  }

  const result = data.result || {};
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(
      (item) => item && item.type === "text" && typeof item.text === "string"
    )
    .map((item) => item.text)
    .join("\n\n");
  const requestId = result.request_id || data.request_id || response.requestId;
  if (result.isError) {
    return {
      ...response,
      ok: false,
      error: text || "MCP 工具返回 isError: true",
      requestId,
    };
  }
  return { ...response, mcpText: text, requestId };
}

function executeSearchTasks(tasks) {
  const timeoutMs = getTimeoutMs();
  const endpoint = getSearchEndpoint();
  const promises = tasks.map((task) => {
    const body = { query: task.query };
    if (task.sub_domain) body.tag = task.sub_domain;
    if (task.zone) body.zone = task.zone;
    if (task.params) body.params = task.params;
    if (task.max_results !== undefined) body.max_results = task.max_results;

    return postJson(endpoint, JSON.stringify(body), { timeoutMs }).then(
      (result) => ({
        routeIndex: task.routeIndex,
        ...result,
      })
    );
  });

  return Promise.allSettled(promises).then((results) =>
    results.map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : {
            routeIndex: tasks[index].routeIndex,
            ok: false,
            error: result.reason?.message || String(result.reason),
            statusCode: 0,
          }
    )
  );
}

const ARGUMENT_BUILDERS = {
  get_sub_domains: buildGetSubDomainsArguments,
  extract: buildExtractArguments,
};

function pickApiKey() {
  const keys = (process.env.ANYSEARCH_API_KEY || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  if (keys.length === 0) return "";
  return keys[Math.floor(Math.random() * keys.length)];
}

function getTimeoutMs() {
  const parsed = Number.parseInt(process.env.ANYSEARCH_TIMEOUT_MS || "", 10);
  if (Number.isNaN(parsed)) return TIMEOUT_DEFAULT_MS;
  return Math.max(TIMEOUT_MIN_MS, Math.min(TIMEOUT_MAX_MS, parsed));
}

// 搜索 endpoint：未配置时使用官方 /v1/search。
function getSearchEndpoint() {
  return (
    (process.env.ANYSEARCH_SEARCH_ENDPOINT || DEFAULT_SEARCH_ENDPOINT).trim() ||
    DEFAULT_SEARCH_ENDPOINT
  );
}

// MCP endpoint：新变量优先；旧 ANYSEARCH_ENDPOINT 作为兼容别名保留一个版本周期；都没有时用官方 /mcp。
function getMcpEndpoint() {
  const mcp = (process.env.ANYSEARCH_MCP_ENDPOINT || "").trim();
  if (mcp) return mcp;
  const legacy = (process.env.ANYSEARCH_ENDPOINT || "").trim();
  if (legacy) return legacy;
  return DEFAULT_MCP_ENDPOINT;
}

function isLoopback(hostname) {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

// Production endpoints must be HTTPS so the Bearer key is never sent in cleartext.
// Plain HTTP is allowed only for loopback (local mock / proxy), where it never
// touches the network.
function resolveTransport(url) {
  if (url.protocol === "https:") return https;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return http;
  fail("ANYSEARCH_ENDPOINT 必须是 https:// 地址（http:// 仅允许 127.0.0.1）。");
}

// v3 对齐：统一的 POST + JSON 请求函数。供 REST 搜索和 MCP 工具调用共用。
// 安全规则：
// - URL 必须 https（loopback 除外）；非法协议直接 fail。
// - 错误文本不拼接完整 headers、完整 Authorization、完整请求体或完整响应原文。
// - 非 JSON 响应只取前 200 字符并做基础脱敏，避免把 HTML/网关错误页里的 token 回显。
// - 429 不重试（由调用方决定如何呈现），本函数只负责一次请求的完整错误语义。
// 返回：{ ok: true, data, statusCode } 或 { ok: false, error, statusCode, requestId }。
function postJson(endpoint, body, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || getTimeoutMs();
  const sendAuth = opts.sendAuth !== false; // 默认注入 Authorization

  let url;
  try {
    url = new URL(endpoint);
  } catch (_) {
    return Promise.resolve({
      ok: false,
      error: "endpoint 不是合法 URL。",
      statusCode: 0,
    });
  }
  const transport = resolveTransport(url);

  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "X-Anysearch-Client": "vcp-anysearch/3.0.1",
  };
  if (sendAuth) {
    const apiKey = pickApiKey();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  }

  const reqOptions = {
    hostname: url.hostname,
    port: url.port || (url.protocol === "http:" ? 80 : 443),
    path: `${url.pathname}${url.search}`,
    method: "POST",
    headers,
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const req = transport.request(reqOptions, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        const statusCode = res.statusCode || 0;
        const requestId = (res.headers && res.headers["x-request-id"]) || "";

        // 非 JSON 响应：网关错误页/HTML，只取前 200 字符并移除可能的 token 片段
        let data;
        try {
          data = JSON.parse(raw);
        } catch (_) {
          const snippet = raw
            .slice(0, 200)
            .replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]");
          finish({
            ok: false,
            error: `API 返回了非 JSON 响应（HTTP ${statusCode}）：${snippet}`,
            statusCode,
            requestId,
          });
          return;
        }

        // HTTP 4xx/5xx：只保留 code 和 message，不回显完整响应体
        if (statusCode >= 400) {
          const msg =
            (data && data.message) ||
            (data && data.error && data.error.message) ||
            `HTTP ${statusCode}`;
          finish({
            ok: false,
            error: `HTTP ${statusCode}：${msg}`,
            statusCode,
            requestId,
            data,
          });
          return;
        }

        // REST 业务错误：HTTP 200 但 code !== 0（AnySearch REST 约定 code=0 成功）
        // 注意：MCP JSON-RPC 响应没有顶层 code 字段，不会误判
        if (data && typeof data.code === "number" && data.code !== 0) {
          const msg = (data && data.message) || `code=${data.code}`;
          finish({
            ok: false,
            error: msg,
            statusCode,
            requestId: data.request_id || requestId,
            data,
          });
          return;
        }

        finish({ ok: true, data, statusCode, requestId });
      });
    });

    // 超时：直接 resolve 超时错误并销毁请求。用 finish 保证只 resolve 一次，
    // 避免 req.destroy 触发的 error 事件和 timeout 回调双重 resolve。
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, error: "API 请求超时。", statusCode: 0 });
    }, timeoutMs);

    req.on("error", (err) => {
      finish({ ok: false, error: err.message || String(err), statusCode: 0 });
    });
    req.write(body);
    req.end();
  });
}

function callAnySearch(toolName, args) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  return postJson(getMcpEndpoint(), body)
    .then(normalizeMcpToolResponse)
    .then((response) => {
      if (!response.ok) throw new Error(response.error || "MCP 请求失败");
      return (
        response.mcpText || JSON.stringify(response.data?.result || {}, null, 2)
      );
    });
}

// v3 对齐：extract 内容截断。50,000 字符硬上限，避免超长页面无界回灌。
const EXTRACT_MAX_CHARS = 50000;
function truncateExtractContent(text) {
  if (typeof text !== "string") return "";
  if (text.length <= EXTRACT_MAX_CHARS) return text;
  const notice = "\n\n...(内容已截断，达到 50,000 字符上限)...";
  return text.slice(0, EXTRACT_MAX_CHARS - notice.length) + notice;
}

async function main() {
  try {
    const payload = parsePayload(await readStdin());
    const command = normalizeCommand(payload);

    // v3 对齐：search 和 batch_search 走新的编译+并发+裁剪路径
    if (command === "search" || command === "batch_search") {
      const tasks = compileSearchTasks(payload);
      const routeResults = await executeSearchTasks(tasks);
      const text = formatSearchResults(routeResults);
      emit({
        status: "success",
        result: { content: [{ type: "text", text }] },
      });
      return;
    }

    // get_sub_domains 和 extract 继续走 MCP
    const args = ARGUMENT_BUILDERS[command](payload);
    const content = await callAnySearch(command, args);

    // v3 对齐：extract 截断 50k
    const text =
      command === "extract"
        ? truncateExtractContent(
            typeof content === "string" ? content.trim() : ""
          )
        : typeof content === "string" && content.trim()
        ? content.trim()
        : "AnySearch API 未返回可读文本内容。";

    emit({ status: "success", result: { content: [{ type: "text", text }] } });
  } catch (error) {
    fail(error.message || String(error));
  }
}

main();
