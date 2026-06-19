#!/usr/bin/env node
"use strict";

// AnySearch 子领域目录维护脚本（手动执行，非插件入口）：
//
//   node Plugin/AnySearch/sync.js
//
// 取数路径（API 不支持无参数全量查询，必须分批）：
//   1. tools/list 读取 get_sub_domains 的 domain enum —— 服务端声明的权威域清单，
//      新增领域会出现在 enum 里，因此本脚本能自动发现新域；
//   2. 按每批最多 5 个域调用 get_sub_domains，汇总出全量目录。
//
// 然后与本目录 plugin-manifest.json 描述中「领域目录」区块做语义比对；仅当目录
// 真实变化时，原子改写锚行之间的区块，其余内容（含人工修改）一概不动。写入后
// VCP 服务器的清单监听器会自动热重载工具描述，本脚本不做任何主动热更新。
//
// 不被 PluginManager 加载（无独立 manifest），不出现在工具列表，
// 不参与服务器启动，也不会被 AnySearch 的常规调用触发。
//
// 行为约束：
// - 目录区块仅存在于锚行之间；人工删除锚行 = 永久退出自动同步（脚本只读不写）。
// - 语义一致（与排版、顺序无关）则不写文件，幂等。
// - 网络/解析失败、解析结果过小（格式漂移防御）一律不写文件。
// - 写入采用「临时文件 + 原子改名」，服务器监听器永远不会读到半截 JSON。

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const DEFAULT_ENDPOINT = "https://api.anysearch.com/mcp";
const MANIFEST_PATH = path.resolve(__dirname, "plugin-manifest.json");

// 目录区块锚行：替换仅发生在两行之间（不含锚行本身）。
const ANCHOR_START = "目录(域: 子域(必填参数)):";
const ANCHOR_END = "调用格式:";

const BATCH_SIZE = 5; // get_sub_domains 单次最多 5 个域

// 防御 API 输出格式漂移：解析结果低于该规模时视为异常，放弃写入。
const MIN_DOMAINS = 5;
const MIN_SUBS = 10;

function getEndpoint() {
  return (process.env.ANYSEARCH_ENDPOINT || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
}

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" ||
    hostname === "::1" || hostname === "[::1]";
}

function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const url = new URL(getEndpoint());
  let transport;
  if (url.protocol === "https:") transport = https;
  else if (url.protocol === "http:" && isLoopback(url.hostname)) transport = http;
  else return Promise.reject(new Error("endpoint 必须是 https://（http:// 仅允许 127.0.0.1）"));

  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === "http:" ? 80 : 443),
    path: `${url.pathname}${url.search}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };
  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        try {
          const data = JSON.parse(raw);
          if (res.statusCode >= 400 || data.error) {
            reject(new Error(data.error ? (data.error.message || "API error") : `HTTP ${res.statusCode}`));
            return;
          }
          resolve(data.result || {});
        } catch (_) {
          reject(new Error("API 返回了非 JSON 响应"));
        }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error("API 请求超时")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function textOf(result) {
  const content = Array.isArray(result.content) ? result.content : [];
  const textItem = content.find((item) => item && item.type === "text");
  return textItem ? textItem.text : "";
}

// 服务端声明的权威域清单：tools/list 中 get_sub_domains 的 domain enum
async function fetchDomainEnum() {
  const result = await rpc("tools/list", {});
  const tool = (result.tools || []).find((t) => t && t.name === "get_sub_domains");
  if (!tool || !tool.inputSchema || !tool.inputSchema.properties) {
    throw new Error("tools/list 中找不到 get_sub_domains 的参数定义");
  }
  const props = tool.inputSchema.properties;
  const domainEnum = (props.domain && props.domain.enum) ||
    (props.domains && props.domains.items && props.domains.items.enum);
  if (!Array.isArray(domainEnum) || domainEnum.length === 0) {
    throw new Error("tools/list 未声明 domain enum");
  }
  return domainEnum.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

// 从 get_sub_domains 的 Markdown 输出解析目录：
// "### domain.sub" 开新子域；其下 "- `param` (required)" 行记为必填参数。
// 目录结构：Map<domain, Map<sub, requiredParams[]>>
function parseInto(catalog, text) {
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^###\s+([a-z0-9_]+)\.([a-z0-9_]+)\s*$/.exec(line);
    if (head) {
      if (!catalog.has(head[1])) catalog.set(head[1], new Map());
      const subs = catalog.get(head[1]);
      if (!subs.has(head[2])) subs.set(head[2], []);
      current = subs.get(head[2]);
      continue;
    }
    if (/^##\s/.test(line)) { current = null; continue; }
    if (!current) continue;
    const param = /^-\s+`([a-z0-9_]+)`\s+\(required\)/.exec(line);
    if (param && !current.includes(param[1])) current.push(param[1]);
  }
}

async function fetchLiveCatalog() {
  const domains = await fetchDomainEnum();
  const catalog = new Map();
  for (let i = 0; i < domains.length; i += BATCH_SIZE) {
    const batch = domains.slice(i, i + BATCH_SIZE);
    const result = await rpc("tools/call", { name: "get_sub_domains", arguments: { domains: batch } });
    parseInto(catalog, textOf(result));
  }
  return catalog;
}

// 从目录区块文本解析 "domain: s1(a,b) s2" 行 → Map<domain, Map<sub, required[]>>
function parseCatalogFromBlock(block) {
  const catalog = new Map();
  for (const line of block.split("\n")) {
    const m = /^([a-z0-9_]+):\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const subs = new Map();
    for (const token of m[2].split(/\s+/).filter(Boolean)) {
      const t = /^([a-z0-9_]+)(?:\(([a-z0-9_,]*)\))?$/.exec(token);
      if (!t) continue;
      subs.set(t[1], t[2] ? t[2].split(",").filter(Boolean) : []);
    }
    catalog.set(m[1], subs);
  }
  return catalog;
}

function formatCatalog(catalog) {
  const lines = [];
  for (const [domain, subs] of catalog) {
    const parts = [];
    for (const [sub, required] of subs) {
      parts.push(required.length ? `${sub}(${required.join(",")})` : sub);
    }
    lines.push(`${domain}: ${parts.join(" ")}`);
  }
  return lines.join("\n");
}

// 语义相等：领域、子域、各子域必填参数集合一致（与顺序、空白排版无关）
function catalogsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [domain, subsA] of a) {
    const subsB = b.get(domain);
    if (!subsB || subsB.size !== subsA.size) return false;
    for (const [sub, reqA] of subsA) {
      const reqB = subsB.get(sub);
      if (!reqB || reqB.length !== reqA.length) return false;
      const set = new Set(reqB);
      for (const p of reqA) if (!set.has(p)) return false;
    }
  }
  return true;
}

function splitDescription(description) {
  const start = description.indexOf(ANCHOR_START);
  const end = description.indexOf(ANCHOR_END);
  if (start === -1 || end === -1 || end <= start) return null;
  const bodyStart = start + ANCHOR_START.length;
  return {
    head: description.slice(0, bodyStart),
    body: description.slice(bodyStart, end),
    tail: description.slice(end),
  };
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const command = manifest.capabilities && manifest.capabilities.invocationCommands &&
    manifest.capabilities.invocationCommands[0];
  const parts = command && typeof command.description === "string"
    ? splitDescription(command.description)
    : null;

  const live = await fetchLiveCatalog();
  let totalSubs = 0;
  for (const subs of live.values()) totalSubs += subs.size;
  if (live.size < MIN_DOMAINS || totalSubs < MIN_SUBS) {
    throw new Error(`解析结果过小（${live.size} 域 / ${totalSubs} 子领域），疑似 API 格式漂移，已放弃写入`);
  }

  const fresh = formatCatalog(live);
  process.stdout.write(fresh + "\n");

  if (!parts) {
    process.stderr.write("[sync] 未找到目录区块锚行，视为人工接管，未写入。\n");
    return;
  }
  if (catalogsEqual(parseCatalogFromBlock(parts.body), live)) {
    process.stderr.write("[sync] 目录无变化，未写入。\n");
    return;
  }

  command.description = `${parts.head}\n${fresh}\n${parts.tail}`;
  const serialized = JSON.stringify(manifest, null, 2) + "\n";
  const tmpPath = `${MANIFEST_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, serialized);
  fs.renameSync(tmpPath, MANIFEST_PATH); // 原子替换；服务器监听到变更后自行热重载
  process.stderr.write("[sync] 目录已更新，VCP 服务器将自动热重载工具描述。\n");
}

main().catch((error) => {
  process.stderr.write(`[sync] 失败：${error.message}（未写入任何文件）\n`);
  process.exit(1);
});
