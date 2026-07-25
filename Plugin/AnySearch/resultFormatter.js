"use strict";

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "ref",
  "ref_src",
  "ref_url",
]);
const SNIPPET_MAX_CHARS = 300;
const PER_RESULT_MAX_CHARS = 1500;
const TOTAL_OUTPUT_MAX_CHARS = 20000;

function normalizeUrl(url) {
  if (!url || typeof url !== "string") return "";
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === "http:" && parsed.port === "80") ||
      (parsed.protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = "";
    }
    parsed.hash = "";
    const params = new URLSearchParams(parsed.search);
    for (const key of [...params.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) params.delete(key);
    }
    parsed.search = params.toString();
    let normalized = parsed.toString();
    if (normalized.endsWith("/") && parsed.pathname !== "/") {
      normalized = normalized.replace(/\/$/, "");
    }
    return normalized;
  } catch (_) {
    return url;
  }
}

function normalizeText(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function normalizeSearchResult(raw, routeIndex) {
  if (!raw || typeof raw !== "object") return null;
  const title = normalizeText(raw.title) || "(无标题)";
  const url = normalizeUrl(raw.url);
  const snippet = normalizeText(raw.snippet);
  const content = normalizeText(raw.content);
  const summary =
    snippet || (content ? content.slice(0, SNIPPET_MAX_CHARS) : "");
  return { title, url, summary, routeIndexes: [routeIndex] };
}

function deduplicateResults(results) {
  const deduped = [];
  const urlOwners = new Map();
  for (const candidate of results) {
    if (!candidate || !candidate.url) continue;
    const duplicateIndex = urlOwners.get(candidate.url);
    if (duplicateIndex === undefined) {
      urlOwners.set(candidate.url, deduped.length);
      deduped.push(candidate);
      continue;
    }
    const existing = deduped[duplicateIndex];
    const routeIndexes = [
      ...new Set([...existing.routeIndexes, ...candidate.routeIndexes]),
    ].sort((a, b) => a - b);
    if (candidate.summary.length > existing.summary.length) {
      deduped[duplicateIndex] = { ...candidate, routeIndexes };
    } else {
      existing.routeIndexes = routeIndexes;
    }
  }
  return deduped;
}

function routeLabel(routeIndexes, hasMultipleRoutes) {
  return hasMultipleRoutes ? `[路线 ${routeIndexes.join("、")}] ` : "";
}

function fitWithinBudget(blocks) {
  const output = [];
  const truncationNotice = "...(结果已裁剪，达到总输出预算)...";
  let length = 0;
  for (const block of blocks) {
    const separatorLength = output.length > 0 ? 2 : 0;
    if (length + separatorLength + block.length <= TOTAL_OUTPUT_MAX_CHARS) {
      output.push(block);
      length += separatorLength + block.length;
      continue;
    }
    const noticeSeparator = output.length > 0 ? 2 : 0;
    if (
      length + noticeSeparator + truncationNotice.length <=
      TOTAL_OUTPUT_MAX_CHARS
    ) {
      output.push(truncationNotice);
    }
    break;
  }
  return output.join("\n\n");
}

function formatSearchResults(routeResults) {
  const hasMultipleRoutes = routeResults.length > 1;
  const blocks = [];
  const normalizedResults = [];
  for (const route of routeResults) {
    const label = routeLabel([route.routeIndex], hasMultipleRoutes);
    if (!route.ok) {
      const requestId = route.requestId
        ? `（request_id: ${route.requestId}）`
        : "";
      blocks.push(`${label}搜索失败：${route.error}${requestId}`);
      continue;
    }
    const results = route.data?.data?.results;
    if (!Array.isArray(results) || results.length === 0) {
      blocks.push(`${label}未找到结果。`);
      continue;
    }
    normalizedResults.push(
      ...results
        .map((raw) => normalizeSearchResult(raw, route.routeIndex))
        .filter(Boolean)
    );
  }
  for (const result of deduplicateResults(normalizedResults)) {
    let entry = `${routeLabel(result.routeIndexes, hasMultipleRoutes)}${
      result.title
    }\n${result.url}`;
    if (result.summary)
      entry += `\n${result.summary.slice(0, SNIPPET_MAX_CHARS)}`;
    if (entry.length > PER_RESULT_MAX_CHARS) {
      entry = `${entry.slice(0, PER_RESULT_MAX_CHARS - 3)}...`;
    }
    blocks.push(entry);
  }
  return fitWithinBudget(blocks);
}

module.exports = { formatSearchResults };
