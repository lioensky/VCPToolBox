'use strict';

/**
 * modules/vcpProtocolResilience/scanner.js
 * 100% 纯同步 0ms 确定性闭合工具块扫描器（底层词法与闭合判定统一复用 protocolLexer）
 */
const { classifyClosedBlockError } = require('./classifier');
const { resolveFuzzyMatching } = require('./spans');
const {
  FUZZY_START_BLOCK_RE,
  execValidToolMarker,
  endsWithValidEndMarkerBefore,
  isStandaloneMarkerLine,
  findEnclosingRange,
  scanClosedToolBlockEnd,
  findProtectionAreas
} = require('./protocolLexer');

function isTrailingLineWs(text, pos, allowBom = false) {
  const len = text.length;
  let p = pos;
  while (p < len) {
    const ch = text[p];
    if (ch === '\n') return true;
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && (!allowBom || (ch !== '\uFEFF' && ch !== '\u200B'))) {
      return false;
    }
    p++;
  }
  return true;
}

function findLineStartBackward(text, pos) {
  let p = pos;
  while (p > 0 && text[p - 1] !== '\n') p--;
  return p;
}

function findNextLineStart(text, pos) {
  const nl = text.indexOf('\n', pos);
  return nl === -1 ? text.length : nl + 1;
}

const ESCAPE_WALL_AREA_TYPES = new Set(['ROLE_WALL', 'BATCH', 'VCP_INFO', 'PILL']);
const OUTER_PROTECT_END_GUARD_TYPES = new Set([
  'FENCE', 'HTML', 'THINK', 'THINK_VCP', 'PILL',
  'INLINE_CODE', 'PUSH', 'ONERING_NOTICE', 'ROLE_WALL', 'BATCH', 'VCP_INFO', 'TOOL_ESCAPE'
]);

function recordClosedBlock(blockStart, blockEnd, content, options, blocks, protocolErrors) {
  const blockText = content.slice(blockStart, blockEnd);
  const err = classifyClosedBlockError(blockText, options);
  if (err) {
    protocolErrors.push({ ...err, startIndex: blockStart, endIndex: blockEnd });
  } else {
    blocks.push({
      type: 'CLOSED',
      isClosed: true,
      isProtocolError: false,
      start: blockStart,
      end: blockEnd,
      rawText: blockText
    });
  }
}

/**
 * 纯同步闭合工具块扫描器（0ms 零漂移）
 * 未闭合块由 streamToolBuffer 在流式/非流式源头拦截丢弃，此处仅精确扫描闭合块并交由 classifier 归类
 *
 * @param {string} content 待扫描文本
 * @param {object} [options={}] 配置项
 * @returns {{ blocks: Array, protocolErrors: Array, spans: Array }}
 */
function scanContentBlocksSync(content, options = {}) {
  if (typeof content !== 'string' || !content) {
    return { blocks: [], protocolErrors: [], spans: [] };
  }

  const len = content.length;
  const blocks = [];
  const protocolErrors = [];
  const fuzzy = resolveFuzzyMatching(options);
  const protectionAreas = findProtectionAreas(content, options);
  const escWallRanges = options.protectRoleDivider
    ? protectionAreas.filter(p => ESCAPE_WALL_AREA_TYPES.has(p.type))
    : undefined;
  const lexHints = {};

  let cursor = 0;
  const groupHeadMatch = /^[ \t]*\[[^\]\r\n]{1,30}的发言\][ \t]*[:：][ \t]*/.exec(content);
  const groupHeadEnd = (groupHeadMatch && groupHeadMatch[0].length < len && content.slice(groupHeadMatch[0].length).trim().length > 0)
    ? groupHeadMatch[0].length
    : 0;
  if (groupHeadEnd > 0) {
    cursor = groupHeadEnd;
  }

  function isProtected(idx) {
    return findEnclosingRange(idx, protectionAreas);
  }

  const startOpenRe = fuzzy ? new RegExp(FUZZY_START_BLOCK_RE.source, 'gi') : /<<<\[TOOL_REQUEST\]>>>/g;

  while (cursor < len) {
    const prot = isProtected(cursor);
    if (prot) {
      cursor = prot.end;
      continue;
    }

    const startMatch = execValidToolMarker(startOpenRe, content, cursor, lexHints, 'scannerStart');
    if (!startMatch) break;

    const markerStartPos = startMatch.index;
    const startLenInLine = startMatch[0].length;
    const afterOpen = markerStartPos + startLenInLine;

    const protAtMarker = isProtected(markerStartPos);
    if (protAtMarker) {
      cursor = Math.max(protAtMarker.end, afterOpen);
      continue;
    }

    const standaloneLine = isStandaloneMarkerLine(content, markerStartPos, startLenInLine);
    const isGlueStart = !standaloneLine &&
      endsWithValidEndMarkerBefore(content, markerStartPos, fuzzy) &&
      isTrailingLineWs(content, afterOpen, false);
    const isAfterGroupHeadStandalone = !standaloneLine &&
      groupHeadEnd > 0 &&
      markerStartPos === groupHeadEnd &&
      isTrailingLineWs(content, afterOpen, true);
    const isStandaloneStart = standaloneLine || isGlueStart || isAfterGroupHeadStandalone;

    const blockStart = standaloneLine
      ? Math.max(cursor, findLineStartBackward(content, markerStartPos))
      : markerStartPos;
    const rawEnd = scanClosedToolBlockEnd(content, afterOpen, lexHints, {
      fuzzyToolMatching: fuzzy,
      protectRoleDivider: Boolean(options.protectRoleDivider),
      opaqueRanges: escWallRanges
    });

    if (rawEnd === -1) {
      cursor = isStandaloneStart ? findNextLineStart(content, afterOpen) : afterOpen;
      continue;
    }

    const endProt = isProtected(rawEnd - 1);
    if (endProt && OUTER_PROTECT_END_GUARD_TYPES.has(endProt.type) &&
        (endProt.start < markerStartPos || endProt.end > rawEnd)) {
      cursor = endProt.start > blockStart
        ? endProt.start
        : Math.max(afterOpen, endProt.end);
      continue;
    }

    let endWsScan = rawEnd;
    while (endWsScan < len && (content[endWsScan] === ' ' || content[endWsScan] === '\t' || content[endWsScan] === '\r')) {
      endWsScan++;
    }
    if (endWsScan === len || content[endWsScan] === '\n') {
      const blockEnd = endWsScan < len ? endWsScan + 1 : len;
      recordClosedBlock(blockStart, blockEnd, content, options, blocks, protocolErrors);
      cursor = blockEnd;
      continue;
    }

    const blockEnd = rawEnd;
    recordClosedBlock(blockStart, blockEnd, content, options, blocks, protocolErrors);
    cursor = blockEnd;
  }

  return {
    blocks,
    protocolErrors,
    spans: []
  };
}

function scanContentBlocks(content, options = {}) {
  return scanContentBlocksSync(content, options);
}

module.exports = {
  isStandaloneMarkerLine,
  findProtectionAreas,
  scanContentBlocks,
  scanContentBlocksSync
};
