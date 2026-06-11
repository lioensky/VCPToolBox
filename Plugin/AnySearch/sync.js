#!/usr/bin/env node
"use strict";

// AnySearch 子领域目录维护脚本（手动执行，非插件入口）：
//
//   node Plugin/AnySearch/sync.js
//
// 匿名调用 AnySearch get_sub_domains（无参数 = 全量目录），与本目录
// plugin-manifest.json 描述中「领域目录」区块做语义比对；仅当目录真实变化时，
// 原子改写锚行之间的区块，其余内容（含人工修改）一概不动。写入后 VCP 服务器的
// 清单监听器会自动热重载工具描述，本脚本不做任何主动热更新。
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
const ANCHOR_START = "领域目录(domain: 子领域):";
const ANCHOR_END = "调用格式:";

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

function fetchLiveCatalogText() {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_sub_domains", arguments: {} },
  });
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
          const content = Array.isArray(data.result && data.result.content) ? data.result.content : [];
          const textItem = content.find((item) => item && item.type === "text");
          resolve(textItem ? textItem.text : "");
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

// 从 get_sub_domains 的 Markdown 输出解析 "### domain.sub" 行 → 有序 {domain: [subs]}
function parseCatalogFromApi(text) {
  const catalog = new Map();
  const re = /^###\s+([a-z0-9_]+)\.([a-z0-9_]+)\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const domain = m[1];
    const sub = m[2];
    if (!catalog.has(domain)) catalog.set(domain, []);
    const subs = catalog.get(domain);
    if (!subs.includes(sub)) subs.push(sub);
  }
  return catalog;
}

// 从目录区块文本解析 "domain: s1 s2" 行 → 有序 {domain: [subs]}
function parseCatalogFromBlock(block) {
  const catalog = new Map();
  for (const line of block.split("\n")) {
    const m = /^([a-z0-9_]+):\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    catalog.set(m[1], m[2].split(/\s+/).filter(Boolean));
  }
  return catalog;
}

function formatCatalog(catalog) {
  const lines = [];
  for (const [domain, subs] of catalog) lines.push(`${domain}: ${subs.join(" ")}`);
  return lines.join("\n");
}

// 语义相等：领域集合与各自子领域集合一致（与顺序、空白排版无关）
function catalogsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [domain, subs] of a) {
    const other = b.get(domain);
    if (!other || other.length !== subs.length) return false;
    const set = new Set(other);
    for (const sub of subs) if (!set.has(sub)) return false;
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

  const live = parseCatalogFromApi(await fetchLiveCatalogText());
  let totalSubs = 0;
  for (const subs of live.values()) totalSubs += subs.length;
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
