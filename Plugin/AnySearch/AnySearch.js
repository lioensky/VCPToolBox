#!/usr/bin/env node
"use strict";

const https = require("https");

const DEFAULT_ENDPOINT = "https://api.anysearch.com/mcp";
const AVAILABLE_DOMAINS = new Set([
  "code", "tech", "fashion", "travel", "home", "ecommerce",
  "gaming", "film", "music", "finance", "academic", "legal",
  "business", "ip", "security", "education", "health", "religion",
  "geo", "environment", "energy", "ugc",
]);
const CONTENT_TYPES = new Set([
  "web", "news", "code", "doc", "academic", "data", "image", "video", "audio",
]);
const FRESHNESS_VALUES = new Set(["day", "week", "month", "year"]);
const ZONES = new Set(["cn", "intl"]);

process.stdin.setEncoding("utf8");
if (process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding("utf8");

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function fail(message, result) {
  const payload = { status: "error", error: `AnySearch Error: ${message}` };
  if (result !== undefined) payload.result = result;
  emit(payload);
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input.replace(/^\uFEFF/, "")));
  });
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) fail("No input received from stdin.");
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      fail("Invalid JSON payload.");
    }
    return payload;
  } catch (_) {
    fail("Invalid JSON payload.");
  }
}

function firstString(payload, keys) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeCommand(payload) {
  const raw = firstString(payload, ["command", "action", "tool", "mode"]) || "search";
  const normalized = raw.toLowerCase().replace(/-/g, "_").trim();
  const aliases = {
    search: "search",
    web_search: "search",
    list_domains: "list_domains",
    list_domain: "list_domains",
    domains: "list_domains",
    batch_search: "batch_search",
    batch: "batch_search",
    extract: "extract",
    fetch: "extract",
    url_extract: "extract",
  };
  const command = aliases[normalized];
  if (!command) fail("Invalid command. Use search, list_domains, batch_search, or extract.");
  return command;
}

function parseStringList(value, fieldName) {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
      return [String(parsed).trim()].filter(Boolean);
    } catch (_) {
      return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  fail(`${fieldName} must be a string or array.`);
}

function parseInteger(value, fieldName, min, max) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) fail(`${fieldName} must be an integer.`);
  return Math.max(min, Math.min(max, parsed));
}

function parseJsonObject(value, fieldName) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (_) {
      // handled below
    }
  }
  fail(`${fieldName} must be a JSON object.`);
}

function validateAllowed(value, allowed, fieldName) {
  if (value !== undefined && !allowed.has(value)) {
    fail(`Invalid ${fieldName}: ${value}.`);
  }
}

function buildSearchArguments(payload) {
  const query = firstString(payload, ["query", "q", "text", "Query"]);
  if (!query) fail("Missing required argument: query.");

  const args = { query };
  const domain = firstString(payload, ["domain", "Domain"]);
  const subDomain = firstString(payload, ["sub_domain", "subDomain", "subdomain"]);
  const zone = firstString(payload, ["zone"]);
  const freshness = firstString(payload, ["freshness"]);
  const contentTypes = parseStringList(payload.content_types ?? payload.contentTypes, "content_types");
  const maxResults = parseInteger(payload.max_results ?? payload.maxResults, "max_results", 1, 100);
  const subDomainParams = parseJsonObject(payload.sub_domain_params ?? payload.subDomainParams, "sub_domain_params");

  if (domain) {
    validateAllowed(domain, AVAILABLE_DOMAINS, "domain");
    args.domain = domain;
  }
  if (subDomain) args.sub_domain = subDomain;
  if (subDomainParams) args.sub_domain_params = subDomainParams;
  if (contentTypes) {
    for (const type of contentTypes) validateAllowed(type, CONTENT_TYPES, "content_types");
    args.content_types = contentTypes;
  }
  if (zone) {
    validateAllowed(zone, ZONES, "zone");
    args.zone = zone;
  }
  if (freshness) {
    validateAllowed(freshness, FRESHNESS_VALUES, "freshness");
    args.freshness = freshness;
  }
  if (maxResults !== undefined) args.max_results = maxResults;

  return args;
}

function buildListDomainsArguments(payload) {
  const domains = parseStringList(payload.domains, "domains");
  const domain = firstString(payload, ["domain", "Domain"]);

  if (domains && domains.length > 0) {
    if (domains.length > 5) fail("domains supports a maximum of 5 domains.");
    for (const item of domains) validateAllowed(item, AVAILABLE_DOMAINS, "domains");
    return { domains };
  }

  if (!domain) return {};
  validateAllowed(domain, AVAILABLE_DOMAINS, "domain");
  return { domain };
}

function normalizeBatchQueries(value) {
  if (value === undefined || value === null || value === "") fail("Missing required argument: queries.");

  let queries = value;
  if (typeof value === "string") {
    try {
      queries = JSON.parse(value);
    } catch (_) {
      queries = value.split("|").map((item) => ({ query: item.trim() })).filter((item) => item.query);
    }
  }

  if (!Array.isArray(queries)) queries = [queries];
  if (queries.length < 1 || queries.length > 5) fail("batch_search requires 1-5 queries.");

  return queries.map((item) => {
    if (typeof item === "string") return { query: item };
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("Each batch query must be a string or object.");
    if (!item.query && !item.q && !item.text) fail("Each batch query requires query.");
    return {
      ...item,
      query: item.query || item.q || item.text,
    };
  });
}

function buildBatchSearchArguments(payload) {
  const rawQueries = payload.queries !== undefined ? payload.queries : payload.query_items;
  return { queries: normalizeBatchQueries(rawQueries) };
}

function buildExtractArguments(payload) {
  const url = firstString(payload, ["url", "URL", "link"]);
  if (!url) fail("Missing required argument: url.");
  if (!/^https?:\/\//i.test(url)) fail("url must start with http:// or https://.");
  return { url };
}

function buildArguments(command, payload) {
  switch (command) {
    case "search": return buildSearchArguments(payload);
    case "list_domains": return buildListDomainsArguments(payload);
    case "batch_search": return buildBatchSearchArguments(payload);
    case "extract": return buildExtractArguments(payload);
    default: fail("Unsupported command.");
  }
}

function parseApiKeys() {
  const raw = (process.env.ANYSEARCH_API_KEY || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickApiKey() {
  const apiKeys = parseApiKeys();
  if (apiKeys.length === 0) return "";
  return apiKeys[Math.floor(Math.random() * apiKeys.length)];
}

function getTimeoutMs() {
  const parsed = Number.parseInt(process.env.ANYSEARCH_TIMEOUT_MS || "", 10);
  if (Number.isNaN(parsed)) return 30000;
  return Math.max(1000, Math.min(120000, parsed));
}

function getEndpoint() {
  const endpoint = (process.env.ANYSEARCH_ENDPOINT || DEFAULT_ENDPOINT).trim();
  return endpoint || DEFAULT_ENDPOINT;
}

function callAnySearch(toolName, args) {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  const url = new URL(getEndpoint());
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  };
  const apiKey = pickApiKey();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    method: "POST",
    headers,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        let data;
        try {
          data = JSON.parse(body);
        } catch (_) {
          reject(new Error(`Non-JSON response from API: ${body.slice(0, 500)}`));
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
        resolve({
          raw_jsonrpc_result: result,
          content: textItem ? textItem.text : JSON.stringify(result, null, 2),
        });
      });
    });

    req.setTimeout(getTimeoutMs(), () => {
      req.destroy(new Error("API request timed out."));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function formatMarkdownResult(command, args, apiResult) {
  const lines = [
    `## AnySearch 执行结果`,
    ``,
    `- **命令**: \`${command}\``,
    `- **参数**: \`${JSON.stringify(args)}\``,
    ``,
  ];

  const content = typeof apiResult.content === "string" ? apiResult.content.trim() : "";
  if (content) {
    lines.push(content);
  } else {
    lines.push("_AnySearch API 未返回可读文本内容。_");
  }

  return lines.join("\n");
}

async function main() {
  try {
    const payload = parsePayload(await readStdin());
    const command = normalizeCommand(payload);
    const args = buildArguments(command, payload);
    const apiResult = await callAnySearch(command, args);
    emit({
      status: "success",
      result: formatMarkdownResult(command, args, apiResult),
    });
  } catch (error) {
    fail(error.message || String(error));
  }
}

main();
