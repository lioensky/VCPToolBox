const toolboxManager = require('../../modules/toolboxManager.js');

const DEFAULT_MAX_BLOCKS = 2;
const DEFAULT_MAX_CHARS = 8000;
const MAX_BLOCKS_LIMIT = 10;
const MAX_CHARS_LIMIT = 30000;
const MODES = new Set(['list', 'best', 'all']);

const FRIENDLY_TOOLBOX_ALIASES = new Map([
  ['file', 'VCPFileToolBox'],
  ['files', 'VCPFileToolBox'],
  ['filetoolbox', 'VCPFileToolBox'],
  ['vcpfiletoolbox', 'VCPFileToolBox'],
  ['search', 'VCPSearchToolBox'],
  ['web', 'VCPSearchToolBox'],
  ['network', 'VCPSearchToolBox'],
  ['vcpsh', 'VCPSearchToolBox'],
  ['vcpsearchtoolbox', 'VCPSearchToolBox'],
  ['memo', 'VCPMemoToolBox'],
  ['memory', 'VCPMemoToolBox'],
  ['rag', 'VCPMemoToolBox'],
  ['vcpmemotoolbox', 'VCPMemoToolBox'],
  ['contact', 'VCPContactToolBox'],
  ['communication', 'VCPContactToolBox'],
  ['message', 'VCPContactToolBox'],
  ['vcpcontacttoolbox', 'VCPContactToolBox'],
  ['media', 'VCPMediaToolBox'],
  ['image', 'VCPMediaToolBox'],
  ['video', 'VCPMediaToolBox'],
  ['vcpmediatoolbox', 'VCPMediaToolBox'],
  ['flowlock', 'VCPFlowLockToolBox'],
  ['flow', 'VCPFlowLockToolBox'],
  ['rhythm', 'VCPFlowLockToolBox'],
  ['vcpflowlocktoolbox', 'VCPFlowLockToolBox']
]);

class ToolboxQueryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ToolboxQueryError';
    this.code = code;
    this.details = details;
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function parseInput(rawInput) {
  const text = String(rawInput || '').trim();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw new ToolboxQueryError('INVALID_JSON', `stdin 不是有效 JSON: ${error.message}`);
  }
}

function toStringValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function toClampedInteger(value, defaultValue, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function getAvailableAliases() {
  return Array.from(toolboxManager.toolboxMap.keys()).sort();
}

function resolveToolboxAlias(inputAlias) {
  const rawAlias = toStringValue(inputAlias);
  if (!rawAlias) {
    throw new ToolboxQueryError('TOOLBOX_REQUIRED', '缺少 toolbox 参数。', {
      availableToolboxes: getAvailableAliases()
    });
  }

  if (toolboxManager.isToolbox(rawAlias)) return rawAlias;

  const normalized = normalizeKey(rawAlias);
  const friendlyAlias = FRIENDLY_TOOLBOX_ALIASES.get(normalized);
  if (friendlyAlias && toolboxManager.isToolbox(friendlyAlias)) return friendlyAlias;

  const exactCaseInsensitive = getAvailableAliases().find(alias => normalizeKey(alias) === normalized);
  if (exactCaseInsensitive) return exactCaseInsensitive;

  if (!normalized.startsWith('vcp') && normalized.endsWith('toolbox')) {
    const prefixed = `VCP${rawAlias}`;
    const prefixedMatch = getAvailableAliases().find(alias => normalizeKey(alias) === normalizeKey(prefixed));
    if (prefixedMatch) return prefixedMatch;
  }

  throw new ToolboxQueryError('UNKNOWN_TOOLBOX', `未知静态工具箱: ${rawAlias}`, {
    availableToolboxes: getAvailableAliases()
  });
}

function extractTitle(content) {
  const lines = String(content || '').split('\n');
  const heading = lines.find(line => /^\s{0,3}#{1,6}\s+/.test(line));
  if (heading) return heading.replace(/^\s{0,3}#{1,6}\s+/, '').trim();
  const nonEmpty = lines.find(line => line.trim());
  return nonEmpty ? nonEmpty.trim().slice(0, 80) : '';
}

function summarizeBlock(block, index) {
  return {
    index,
    threshold: block.threshold,
    description: block.description || '',
    title: extractTitle(block.content),
    charCount: String(block.content || '').length,
    isBaseBlock: index === 0 && Number(block.threshold) === 0
  };
}

function buildSearchTerms(query) {
  const normalized = String(query || '').toLowerCase();
  const terms = new Set();

  for (const match of normalized.match(/[a-z0-9_.:/-]{2,}/gi) || []) {
    terms.add(match.toLowerCase());
  }

  for (const part of normalized.split(/[\s,，。；;、|/\\()[\]{}"'“”‘’：:]+/)) {
    const trimmed = part.trim();
    if (trimmed.length >= 2) terms.add(trimmed);
  }

  const chineseChars = Array.from(normalized.match(/[\u3400-\u9fff]/g) || []);
  for (let i = 0; i < chineseChars.length - 1; i += 1) {
    terms.add(chineseChars.slice(i, i + 2).join(''));
  }
  for (let i = 0; i < chineseChars.length - 2; i += 1) {
    terms.add(chineseChars.slice(i, i + 3).join(''));
  }

  return Array.from(terms).filter(term => term.length >= 2);
}

function scoreBlock(block, query, index) {
  const title = extractTitle(block.content).toLowerCase();
  const description = String(block.description || '').toLowerCase();
  const content = String(block.content || '').toLowerCase();
  const wholeQuery = String(query || '').trim().toLowerCase();
  const haystack = `${description}\n${title}\n${content}`;
  const terms = buildSearchTerms(query);

  let score = 0;
  if (wholeQuery && haystack.includes(wholeQuery)) score += 20;

  for (const term of terms) {
    if (!haystack.includes(term)) continue;
    score += 5;
    if (title.includes(term)) score += 4;
    if (description.includes(term)) score += 3;
    if (content.includes(term)) score += 1;
  }

  // Prefer dedicated folded sections over the already-visible base block on ties.
  if (index > 0) score += 0.01;
  return score;
}

function limitContent(blocks, maxChars) {
  let remaining = maxChars;
  let truncated = false;

  const limitedBlocks = blocks.map(block => {
    const content = String(block.content || '');
    if (remaining <= 0) {
      truncated = true;
      return { ...block, content: '', truncated: true };
    }

    if (content.length > remaining) {
      truncated = true;
      const clipped = content.slice(0, remaining);
      remaining = 0;
      return {
        ...block,
        content: `${clipped}\n\n[StaticToolboxQuery: 内容已因 maxChars 限制截断]`,
        truncated: true
      };
    }

    remaining -= content.length;
    return { ...block, truncated: false };
  });

  return { blocks: limitedBlocks, truncated };
}

function selectBlockByIndex(blocks, requestedBlock, includeBase) {
  const rawIndex = toStringValue(requestedBlock);
  if (!rawIndex) return null;

  if (!/^\d+$/.test(rawIndex)) {
    throw new ToolboxQueryError('INVALID_BLOCK_INDEX', `block/index 必须是非负整数: ${rawIndex}`);
  }

  const index = Number.parseInt(rawIndex, 10);
  const block = blocks[index];
  if (!block || (!includeBase && summarizeBlock(block, index).isBaseBlock)) {
    throw new ToolboxQueryError('BLOCK_NOT_FOUND', `未找到可返回的 block index: ${index}`);
  }

  return { block, index };
}

async function queryStaticToolbox(params = {}) {
  await toolboxManager.loadMap();

  const mode = toStringValue(params.mode || 'best').toLowerCase();
  if (!MODES.has(mode)) {
    throw new ToolboxQueryError('INVALID_MODE', `mode 必须是 list、best 或 all，当前为: ${mode}`);
  }

  const toolbox = resolveToolboxAlias(params.toolbox);
  const foldObject = await toolboxManager.getFoldObject(toolbox);
  const foldBlocks = Array.isArray(foldObject.fold_blocks) ? foldObject.fold_blocks : [];
  const summaries = foldBlocks.map(summarizeBlock);
  const includeBase = toBoolean(params.includeBase, false);
  const maxBlocks = toClampedInteger(params.maxBlocks, DEFAULT_MAX_BLOCKS, 1, MAX_BLOCKS_LIMIT);
  const maxChars = toClampedInteger(params.maxChars, DEFAULT_MAX_CHARS, 500, MAX_CHARS_LIMIT);
  const query = toStringValue(params.query);

  if (mode === 'list') {
    return {
      toolbox,
      pluginDescription: foldObject.plugin_description || '',
      mode,
      availableBlocks: summaries,
      usage: '使用 mode=best + query 获取相关 block 内容；或使用 block/index 精确获取目录中的 block。'
    };
  }

  const candidateEntries = foldBlocks
    .map((block, index) => ({ block, index, summary: summaries[index] }))
    .filter(entry => includeBase || !entry.summary.isBaseBlock);

  if (candidateEntries.length === 0) {
    throw new ToolboxQueryError('NO_MATCH', `${toolbox} 没有可查询的折叠 block。`);
  }

  let matchedEntries;
  const explicitBlock = params.block !== undefined ? params.block : params.index;
  const selected = selectBlockByIndex(foldBlocks, explicitBlock, includeBase);

  if (selected) {
    matchedEntries = [{ ...selected, score: 100 }];
  } else if (mode === 'all') {
    matchedEntries = candidateEntries.slice(0, maxBlocks).map(entry => ({ ...entry, score: null }));
  } else {
    if (!query) {
      throw new ToolboxQueryError('QUERY_REQUIRED', 'mode=best 需要 query 参数，或改用 mode=list 查看目录。');
    }

    matchedEntries = candidateEntries
      .map(entry => ({
        ...entry,
        score: scoreBlock(entry.block, query, entry.index)
      }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, maxBlocks);

    if (matchedEntries.length === 0) {
      throw new ToolboxQueryError('NO_MATCH', `未在 ${toolbox} 中找到与 query 相关的折叠说明。`, {
        query,
        availableBlocks: summaries
      });
    }
  }

  const rawMatchedBlocks = matchedEntries.map(entry => ({
    ...summarizeBlock(entry.block, entry.index),
    score: entry.score,
    content: String(entry.block.content || '')
  }));

  const limited = limitContent(rawMatchedBlocks, maxChars);

  return {
    toolbox,
    pluginDescription: foldObject.plugin_description || '',
    mode,
    query,
    matchedBlocks: limited.blocks,
    hiddenBlockCount: Math.max(candidateEntries.length - matchedEntries.length, 0),
    truncated: limited.truncated,
    usage: '阅读 matchedBlocks.content 后，再按其中格式调用真实工具；StaticToolboxQuery 本身只查询说明，不执行真实操作。'
  };
}

function printSuccess(result) {
  process.stdout.write(JSON.stringify({ status: 'success', result }, null, 2));
}

function printError(error) {
  const code = error instanceof ToolboxQueryError ? error.code : 'UNEXPECTED_ERROR';
  const message = error && error.message ? error.message : '未知错误';
  const details = error instanceof ToolboxQueryError ? error.details : {};
  process.stdout.write(JSON.stringify({
    status: 'error',
    error: message,
    result: {
      code,
      message,
      ...details
    }
  }, null, 2));
}

async function main() {
  try {
    const rawInput = await readStdin();
    const params = parseInput(rawInput);
    const result = await queryStaticToolbox(params);
    printSuccess(result);
  } catch (error) {
    printError(error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ToolboxQueryError,
  buildSearchTerms,
  parseInput,
  queryStaticToolbox,
  resolveToolboxAlias,
  scoreBlock,
  summarizeBlock
};
