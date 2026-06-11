#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");

const DEFAULT_ENDPOINT = "https://api.anysearch.com/mcp";
const TIMEOUT_DEFAULT_MS = 30000;
const TIMEOUT_MIN_MS = 1000;
const TIMEOUT_MAX_MS = 120000;
const MAX_RESULTS_MIN = 1;
const MAX_RESULTS_MAX = 10;
const BATCH_MAX = 5;
const DOMAINS_MAX = 5;

// Official AnySearch domains. Flow: pick the matching domain, call get_sub_domains(domain)
// to learn its sub_domains + required params, then run a vertical `search`.
const DOMAINS = [
  "general", "resource", "social_media", "finance", "academic", "legal",
  "health", "business", "security", "ip", "code", "energy",
  "environment", "agriculture", "travel", "film", "gaming",
];
const DOMAIN_SET = new Set(DOMAINS);

// 请求命令 -> JSON-RPC 工具名（仅大小写/连字符归一，不做旧名兼容）。
const COMMANDS = new Set(["search", "get_sub_domains", "batch_search", "extract"]);

process.stdin.setEncoding("utf8");
if (process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding("utf8");

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
    process.stdin.on("data", (chunk) => { input += chunk; });
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
      fail("无效命令。可用命令：search、get_sub_domains、batch_search、extract。");
    }
    return command;
  }
  // command 省略时按参数推断：有 queries 即批量，有 url（且无 query）即提取，否则搜索。
  if (payload.queries !== undefined || payload.query_items !== undefined) return "batch_search";
  const hasQuery = !!firstString(payload, ["query", "q", "text", "Query"]);
  if (!hasQuery && firstString(payload, ["url", "URL", "link"])) return "extract";
  return "search";
}

function parseMaxResults(source) {
  const value = source.max_results ?? source.maxResults;
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) fail("max_results 必须是整数。");
  return Math.max(MAX_RESULTS_MIN, Math.min(MAX_RESULTS_MAX, parsed));
}

// 子领域参数：首选纯文本 k=v,k2=v2（空值写 k=）；也接受对象 / JSON 对象字符串。
function parseSubDomainParams(source) {
  const value = source.params ?? source.sub_domain_params ?? source.subDomainParams ?? source.sdp;
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch (_) { /* fall through to the error below */ }
    } else if (trimmed.includes("=")) {
      const result = {};
      for (const pair of trimmed.split(",")) {
        const item = pair.trim();
        if (!item) continue;
        const eq = item.indexOf("=");
        if (eq <= 0) fail(`sub_domain_params 文本格式应为 k=v,k2=v2（空值写 k=），收到："${item}"。`);
        result[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
      }
      return result;
    }
  }
  fail("sub_domain_params 应为 k=v,k2=v2 文本（空值写 k=），或 JSON 对象。");
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

// search 与 batch_search 查询项共用的选项解析。
// domain 可省略：自动取 sub_domain 的「域.」前缀；显式给出且与前缀矛盾时报错。
function buildSearchOptions(source) {
  const options = {};
  const subDomain = firstString(source, ["sub_domain", "subDomain", "subdomain"]);
  let domain = firstString(source, ["domain", "Domain"]).toLowerCase();
  if (subDomain) {
    const prefix = subDomain.split(".")[0].toLowerCase();
    if (domain && domain !== prefix) {
      fail(`domain "${domain}" 与 sub_domain 前缀 "${prefix}" 不一致；domain 可直接省略。`);
    }
    domain = prefix;
  }
  if (domain) options.domain = assertDomain(domain);
  if (subDomain) options.sub_domain = subDomain;

  const subDomainParams = parseSubDomainParams(source);
  if (subDomainParams) options.sub_domain_params = subDomainParams;

  const maxResults = parseMaxResults(source);
  if (maxResults !== undefined) options.max_results = maxResults;

  return options;
}

function buildSearchArguments(payload) {
  const query = firstString(payload, ["query", "q", "text", "Query"]);
  if (!query) fail("search 缺少必填参数 query。");
  return { query, ...buildSearchOptions(payload) };
}

function buildGetSubDomainsArguments(payload) {
  const domains = parseDomainList(payload.domains);
  if (domains.length > 0) {
    if (domains.length > DOMAINS_MAX) fail(`domains 最多 ${DOMAINS_MAX} 个领域。`);
    domains.forEach(assertDomain);
    return { domains };
  }
  const domain = firstString(payload, ["domain", "Domain"]).toLowerCase();
  if (!domain) fail("get_sub_domains 需要 domain 或 domains 参数。");
  return { domain: assertDomain(domain) };
}

function buildBatchItem(item, shared) {
  const source = typeof item === "string" ? { query: item } : item;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    fail("batch_search 的查询项必须是字符串或对象。");
  }
  const query = firstString(source, ["query", "q", "text", "Query"]);
  if (!query) fail("batch_search 的每个查询项都需要 query。");
  // Top-level (shared) options apply to every item; per-item fields override them.
  return { ...shared, query, ...buildSearchOptions(source) };
}

function buildBatchSearchArguments(payload) {
  const raw = payload.queries ?? payload.query_items;
  if (raw === undefined || raw === null || raw === "") {
    fail("batch_search 缺少必填参数 queries。");
  }
  let items = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    try {
      items = JSON.parse(trimmed);
    } catch (_) {
      items = trimmed.split("|").map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(items)) items = [items];
  if (items.length < 1 || items.length > BATCH_MAX) {
    fail(`batch_search 需要 1-${BATCH_MAX} 个查询。`);
  }
  const shared = buildSearchOptions(payload);
  return { queries: items.map((item) => buildBatchItem(item, shared)) };
}

function buildExtractArguments(payload) {
  const url = firstString(payload, ["url", "URL", "link"]);
  if (!url) fail("extract 缺少必填参数 url。");
  if (!/^https?:\/\//i.test(url)) fail("url 必须以 http:// 或 https:// 开头。");
  return { url };
}

const ARGUMENT_BUILDERS = {
  search: buildSearchArguments,
  get_sub_domains: buildGetSubDomainsArguments,
  batch_search: buildBatchSearchArguments,
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

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" ||
    hostname === "::1" || hostname === "[::1]";
}

// Production endpoints must be HTTPS so the Bearer key is never sent in cleartext.
// Plain HTTP is allowed only for loopback (local mock / proxy), where it never
// touches the network.
function resolveTransport(url) {
  if (url.protocol === "https:") return https;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return http;
  fail("ANYSEARCH_ENDPOINT 必须是 https:// 地址（http:// 仅允许 127.0.0.1）。");
}

function callAnySearch(toolName, args) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  const endpoint = (process.env.ANYSEARCH_ENDPOINT || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
  let url;
  try {
    url = new URL(endpoint);
  } catch (_) {
    fail("ANYSEARCH_ENDPOINT 不是合法 URL。");
  }
  const transport = resolveTransport(url);

  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  };
  const apiKey = pickApiKey();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === "http:" ? 80 : 443),
    path: `${url.pathname}${url.search}`,
    method: "POST",
    headers,
  };

  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let data;
        try {
          data = JSON.parse(raw);
        } catch (_) {
          reject(new Error(`API 返回了非 JSON 响应：${raw.slice(0, 500)}`));
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(data)}`));
          return;
        }
        if (data.error) {
          reject(new Error(data.error.message || JSON.stringify(data.error)));
          return;
        }
        const result = data.result || {};
        const content = Array.isArray(result.content) ? result.content : [];
        const textItem = content.find((item) => item && item.type === "text");
        resolve(textItem ? textItem.text : JSON.stringify(result, null, 2));
      });
    });

    req.setTimeout(getTimeoutMs(), () => req.destroy(new Error("API 请求超时。")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  try {
    const payload = parsePayload(await readStdin());
    const command = normalizeCommand(payload);
    const args = ARGUMENT_BUILDERS[command](payload);
    const content = await callAnySearch(command, args);
    const text = typeof content === "string" && content.trim()
      ? content.trim()
      : "AnySearch API 未返回可读文本内容。";
    // 富内容形态：server 的 _formatResult 会直接取 text，AI 收到干净 Markdown，
    // 不会被包进 original_plugin_output 的 JSON 转义串。
    emit({ status: "success", result: { content: [{ type: "text", text }] } });
  } catch (error) {
    fail(error.message || String(error));
  }
}

main();
