'use strict';

/**
 * modules/vcpProtocolResilience/protocolLexer.js
 * V2.1 唯一词法真理源（纯同步、零外部依赖）：
 * 收口工具起止标、邻接守卫、配对引号单标记豁免、字段与 ESCAPE 原语、
 * VCP_INFO 嵌套与行首尾校验、闭合围栏/工具块扫描与 Phase 0 保护区识别。
 */
const { resolveFuzzyMatching } = require('./spans');

const START_MARKER = '<<<[TOOL_REQUEST]>>>';
const END_MARKER = '<<<[END_TOOL_REQUEST]>>>';
const FUZZY_START_BLOCK_RE = /<{2,4}\[TOOL_REQUEST\]>{2,4}/i;
const FUZZY_END_BLOCK_RE = /<{2,4}\[END_TOOL_REQUEST\]>{2,4}/i;

const FIELD_OPEN_RE = /[^:=\uFF1A \t\r\n<>\[\]]+[ \t]*[:=\uFF1A][ \t\r\n]*([「{])始/g;
const CROSS_SLICE_FIELD_RE = /(?:^|\n|,)[ \t]*[^:=\uFF1A \t\r\n<>\[\]]+[ \t]*[:=\uFF1A][ \t\r\n]*[「{]始/;
const CROSS_FIELD_HEAD_STICKY_RE = /[ \t]*[^:=\uFF1A \t\r\n<>\[\]]+[ \t]*[:=\uFF1A][ \t\r\n]*[「{]始/y;
const CROSS_FIELD_NEXT_RE = /(?:\n|,)[ \t]*[^:=\uFF1A \t\r\n<>\[\]]+[ \t]*[:=\uFF1A][ \t\r\n]*[「{]始/g;
const EMOTICONS = ['(`・ω・´)ゞ', '(・`ω´・)', '(`・ω・´)', '(`･ω･´)'];

const QUOTED_PAIR_MAP = {
  '"': '"',
  "'": "'",
  '“': '”',
  '「': '」'
};

function hasAdjacentAngle(text, idx, len) {
  const prev = idx > 0 ? text[idx - 1] : '';
  const next = idx + len < text.length ? text[idx + len] : '';
  return prev === '<' || next === '>';
}

function isQuotedSingleToolMarker(text, idx, len) {
  if (typeof text !== 'string' || idx <= 0 || idx + len >= text.length) return false;
  const left = text[idx - 1];
  const right = text[idx + len];
  return Boolean(QUOTED_PAIR_MAP[left] && QUOTED_PAIR_MAP[left] === right);
}

function execCachedRegex(re, text, scan, hints, key) {
  if (hints && key) {
    const h = hints[key];
    if (h && h.from <= scan && (h.match === null || h.match.index >= scan)) {
      return h.match;
    }
  }
  re.lastIndex = scan;
  const match = re.exec(text);
  if (hints && key) {
    hints[key] = { from: scan, match };
  }
  return match;
}

function execValidToolMarker(re, text, scan, hints = null, key = '') {
  if (hints && key) {
    const h = hints[key];
    if (h && h.from <= scan && (h.match === null || h.match.index >= scan)) {
      return h.match;
    }
  }
  re.lastIndex = scan;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (!hasAdjacentAngle(text, match.index, match[0].length) &&
        !isQuotedSingleToolMarker(text, match.index, match[0].length)) {
      break;
    }
    re.lastIndex = match.index + 1;
  }
  if (hints && key) {
    hints[key] = { from: scan, match };
  }
  return match;
}

function findExactMarkerInLine(line, marker, guardCharLeft, guardCharRight) {
  let pos = 0;
  while ((pos = line.indexOf(marker, pos)) !== -1) {
    const prev = pos > 0 ? line[pos - 1] : '';
    const next = pos + marker.length < line.length ? line[pos + marker.length] : '';
    if (prev !== guardCharLeft && next !== guardCharRight && !isQuotedSingleToolMarker(line, pos, marker.length)) {
      return { index: pos, length: marker.length, marker };
    }
    pos += 1;
  }
  return null;
}

function findFuzzyMarkerInLine(line, pattern) {
  const re = new RegExp(pattern.source, 'gi');
  let m;
  while ((m = re.exec(line)) !== null) {
    if (!hasAdjacentAngle(line, m.index, m[0].length) && !isQuotedSingleToolMarker(line, m.index, m[0].length)) {
      return { index: m.index, length: m[0].length, marker: m[0] };
    }
    re.lastIndex = m.index + 1;
  }
  return null;
}

function findValidStartInLine(line, fuzzy = false) {
  if (!line) return null;
  return fuzzy ? findFuzzyMarkerInLine(line, FUZZY_START_BLOCK_RE) : findExactMarkerInLine(line, START_MARKER, '<', '>');
}

function findValidEndInLine(line, fuzzy = false) {
  if (!line) return null;
  return fuzzy ? findFuzzyMarkerInLine(line, FUZZY_END_BLOCK_RE) : findExactMarkerInLine(line, END_MARKER, '<', '>');
}

function endsWithValidEndMarkerBefore(text, pos, fuzzy = false) {
  let end = pos;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  if (end === 0) return false;
  const tail = text.slice(Math.max(0, end - 40), end);
  return fuzzy ? /<{2,4}\[END_TOOL_REQUEST\]>{2,4}$/i.test(tail) : tail.endsWith(END_MARKER);
}

function isStandaloneMarkerLine(text, index, markerLen) {
  if (typeof text !== 'string' || index < 0 || index >= text.length) return false;
  let l = index;
  let spaceCount = 0;
  while (l > 0) {
    const ch = text[l - 1];
    if (ch === '\n') break;
    if (ch === ' ') {
      spaceCount++;
      if (spaceCount > 3) return false;
    } else if (ch !== '\uFEFF' && ch !== '\u200B') {
      return false;
    }
    l--;
  }
  let r = index + markerLen;
  const len = text.length;
  while (r < len) {
    const ch = text[r];
    if (ch === '\n') break;
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\uFEFF' && ch !== '\u200B') {
      return false;
    }
    r++;
  }
  return true;
}

function findNextEscapeToken(text, pos, isClosing, fuzzy, openChar = '') {
  let pattern;
  if (fuzzy) {
    pattern = isClosing ? /[「{]末(?:ESCAPE|escape)[」}]/gi : /[「{]始(?:ESCAPE|escape)[」}]/gi;
  } else if (isClosing) {
    pattern = openChar === '{' ? /\{末(?:ESCAPE|escape)\}/gi : /「末(?:ESCAPE|escape)」/gi;
  } else {
    pattern = /「始(?:ESCAPE|escape)」|\{始(?:ESCAPE|escape)\}/gi;
  }
  pattern.lastIndex = pos;
  const match = pattern.exec(text);
  return match ? { index: match.index, length: match[0].length, openChar: match[0][0] } : null;
}

const INFO_BOUNDARY_TOKEN_YRE = /(?:<!--VCP_THOUGHT_CHAIN_\d+-->|<<<\[(?:(?:END_)?ROLE_DIVIDE_[A-Z]+|VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+)\]>>>)/y;
const INFO_THOUGHT_TOKEN_RE = /^<!--VCP_THOUGHT_CHAIN_\d+-->$/;
const INFO_WALL_TOKEN_RE = /^<<<\[(?:(?:END_)?ROLE_DIVIDE_[A-Z]+|VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+)\]>>>$/;

function isLineLeadingBlank(text, index) {
  let p = index;
  while (p > 0) {
    const ch = text[p - 1];
    if (ch === '\n') return true;
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      p--;
      continue;
    }
    if (ch !== '>') return false;
    if (p >= 6 && text[p - 2] === '-' && text[p - 3] === '-') {
      const minOpen = Math.max(0, p - 64);
      const openPos = text.lastIndexOf('<!--', p - 4);
      if (openPos < minOpen || !INFO_THOUGHT_TOKEN_RE.test(text.slice(openPos, p))) {
        return false;
      }
      p = openPos;
      continue;
    }
    if (p >= 10 && text[p - 2] === '>' && text[p - 3] === '>' && text[p - 4] === ']') {
      const minOpen = Math.max(0, p - 256);
      const openPos = text.lastIndexOf('<<<[', p - 5);
      if (openPos < minOpen || !INFO_WALL_TOKEN_RE.test(text.slice(openPos, p))) {
        return false;
      }
      p = openPos;
      continue;
    }
    return false;
  }
  return true;
}

function isLineTrailingBlank(text, afterIndex) {
  let p = afterIndex;
  const len = text.length;
  while (p < len) {
    const ch = text[p];
    if (ch === '\n') return true;
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      p++;
      continue;
    }
    if (ch !== '<') return false;
    INFO_BOUNDARY_TOKEN_YRE.lastIndex = p;
    const m = INFO_BOUNDARY_TOKEN_YRE.exec(text);
    if (!m) return false;
    p += m[0].length;
  }
  return true;
}

function findNestedVcpInfoRanges(text) {
  const ranges = [];
  const START = '[[VCP调用结果信息汇总:';
  const END = 'VCP调用结果结束]]';
  if (typeof text !== 'string' || !text.includes(START) || !text.includes(END)) {
    return ranges;
  }

  const validEnds = [];
  let endScan = 0;
  while (endScan <= text.length) {
    const pos = text.indexOf(END, endScan);
    if (pos === -1) break;
    if (isLineLeadingBlank(text, pos) && isLineTrailingBlank(text, pos + END.length)) {
      validEnds.push(pos);
    }
    endScan = pos + END.length;
  }
  if (validEnds.length === 0) return ranges;

  const lastEndPos = validEnds[validEnds.length - 1];
  const allStarts = [];
  const lineLeadingStarts = [];
  let startScan = 0;
  while (startScan <= lastEndPos) {
    const pos = text.indexOf(START, startScan);
    if (pos === -1 || pos > lastEndPos) break;
    const isLineLeading = isLineLeadingBlank(text, pos);
    const entry = { pos, isLineLeading };
    allStarts.push(entry);
    if (isLineLeading) lineLeadingStarts.push(entry);
    startScan = pos + START.length;
  }
  if (lineLeadingStarts.length === 0) return ranges;

  const runMatchPass = (starts) => {
    const matches = new Map();
    const stack = [];
    let si = 0;
    let ei = 0;
    while (si < starts.length && ei < validEnds.length) {
      if (starts[si].pos < validEnds[ei]) {
        stack.push(starts[si]);
        si++;
      } else {
        if (stack.length > 0) {
          const open = stack.pop();
          if (open.isLineLeading) {
            matches.set(open.pos, validEnds[ei] + END.length);
          }
        }
        ei++;
      }
    }
    while (ei < validEnds.length && stack.length > 0) {
      const open = stack.pop();
      if (open.isLineLeading) {
        matches.set(open.pos, validEnds[ei] + END.length);
      }
      ei++;
    }
    return { matches, hasUnmatchedLineLeading: stack.some(item => item.isLineLeading) };
  };

  const pass1 = runMatchPass(allStarts);
  const pass2Matches = pass1.hasUnmatchedLineLeading ? runMatchPass(lineLeadingStarts).matches : null;

  let cursor = 0;
  for (let i = 0; i < lineLeadingStarts.length; i++) {
    const start = lineLeadingStarts[i].pos;
    if (start < cursor) continue;
    let blockEnd = pass1.matches.get(start);
    if (blockEnd === undefined && pass2Matches) {
      blockEnd = pass2Matches.get(start);
    }
    if (blockEnd !== undefined) {
      ranges.push({ start, end: blockEnd, text: text.slice(start, blockEnd) });
      cursor = blockEnd;
    }
  }

  return ranges;
}

function findClosedFenceLineEnd(text, openNl, fenceChar, fenceLen, noCloseCache = null, opaqueRanges = null) {
  const len = text.length;
  const scanStart = openNl === -1 ? len : openNl + 1;
  if (noCloseCache) {
    const cached = noCloseCache[fenceChar];
    if (cached && scanStart >= cached.minPos && fenceLen >= cached.minLen) {
      return -1;
    }
  }
  const hasOpaque = Boolean(opaqueRanges && opaqueRanges.length > 0);
  let scanPos = scanStart;
  while (scanPos < len) {
    if (hasOpaque) {
      const hitOpaque = findEnclosingRange(scanPos, opaqueRanges);
      if (hitOpaque) {
        const afterEndNl = text.indexOf('\n', hitOpaque.end);
        if (afterEndNl === -1) break;
        scanPos = afterEndNl + 1;
        continue;
      }
    }
    const cNl = text.indexOf('\n', scanPos);
    const cLineEnd = cNl === -1 ? len : cNl;
    const cRaw = text.slice(scanPos, cLineEnd);
    const cLine = cRaw.endsWith('\r') ? cRaw.slice(0, -1) : cRaw;
    const closeMatch = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(cLine);
    if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
      return cLineEnd;
    }
    if (cNl === -1) break;
    scanPos = cNl + 1;
  }
  if (noCloseCache) {
    const prev = noCloseCache[fenceChar];
    if (!prev || fenceLen < prev.minLen || (fenceLen === prev.minLen && scanStart < prev.minPos)) {
      noCloseCache[fenceChar] = { minPos: scanStart, minLen: fenceLen };
    }
  }
  return -1;
}

function findClosedMarkdownFenceRanges(text) {
  const ranges = [];
  if (typeof text !== 'string' || (!text.includes('```') && !text.includes('~~~'))) {
    return ranges;
  }

  const len = text.length;
  const noFenceCloseCache = {};
  let pos = 0;
  while (pos < len) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    const rawLine = text.slice(pos, lineEnd);
    let line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    const openMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (openMatch) {
      const fenceChar = openMatch[1][0];
      const fenceLen = openMatch[1].length;
      const info = openMatch[2] || '';
      if (fenceChar === '`' && info.includes('`')) {
        pos = nl === -1 ? len : nl + 1;
        continue;
      }
      const closeEnd = findClosedFenceLineEnd(text, nl, fenceChar, fenceLen, noFenceCloseCache);
      if (closeEnd !== -1) {
        ranges.push({ start: pos, end: closeEnd });
        const afterCloseNl = text.indexOf('\n', closeEnd);
        pos = afterCloseNl === -1 ? len : afterCloseNl + 1;
        continue;
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }

  return ranges;
}

function isEmoticonBacktickAt(text, idx) {
  for (let i = 0; i < EMOTICONS.length; i++) {
    const emo = EMOTICONS[i];
    const offset = emo.indexOf('`');
    if (idx >= offset && text.startsWith(emo, idx - offset)) return true;
  }
  return false;
}

function collectUnclosedContainersInField(valSlice) {
  if (!valSlice || (
    !valSlice.includes('`') &&
    !valSlice.includes('~') &&
    !valSlice.includes('<') &&
    !valSlice.includes('[')
  )) {
    return [];
  }

  let openFence = null;
  let openInlineBtLen = 0;
  let vcpThinkOpen = false;
  const thinkDepthByTag = Object.create(null);
  const htmlDepthByTag = Object.create(null);
  const bracketScanLines = [];
  const thinkRe = /<[ \t]*(\/?)[ \t]*(think(?:ing)?|thought(?:s)?|antthinking)(?=[ \t>])[^>\r\n<]*>/gi;
  const htmlRe = /<[ \t]*(\/?)[ \t]*(pre|code|script|style)(?=[ \t>])[^>\r\n<]*>/gi;
  const vcpOpenLineRe = /^[ \t]*\[--- VCP元思考链(?::\s*"[^"]*")?\s*---\][ \t]*$/;
  const vcpCloseLineRe = /^[ \t]*\[--- 元思考链结束 ---\]/;
  const lines = valSlice.split('\n');

  for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li];
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (openFence) {
      const closeM = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closeM && closeM[1][0] === openFence.char && closeM[1].length >= openFence.len) {
        openFence = null;
      }
      continue;
    }

    if (openInlineBtLen === 0) {
      if (/^[ \t]*$/.test(line)) {
        continue;
      }
      if (vcpOpenLineRe.test(line)) {
        vcpThinkOpen = true;
        continue;
      }
      if (vcpThinkOpen) {
        const vcpCloseM = vcpCloseLineRe.exec(line);
        if (vcpCloseM) {
          vcpThinkOpen = false;
          line = line.slice(vcpCloseM[0].length);
          if (/^[ \t\r]*$/.test(line)) continue;
        }
      }
      const openM = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (openM) {
        const fChar = openM[1][0];
        const fLen = openM[1].length;
        const info = openM[2] || '';
        if (fChar === '~' || !info.includes('`')) {
          openFence = { kind: 'fence', char: fChar, len: fLen };
          continue;
        }
      }
    } else if (li < lines.length - 1 && /^[ \t]*$/.test(line)) {
      openInlineBtLen = 0;
      continue;
    }

    let outsideLine = '';
    if (!line.includes('`')) {
      if (openInlineBtLen === 0) outsideLine = line;
    } else {
      let cPos = 0;
      while (cPos < line.length) {
        const bt = line.indexOf('`', cPos);
        if (bt === -1) {
          if (openInlineBtLen === 0) {
            outsideLine += cPos === 0 ? line : line.slice(cPos);
          }
          break;
        }
        if (openInlineBtLen === 0 && bt > cPos) {
          outsideLine += line.slice(cPos, bt);
        }
        let runEnd = bt;
        while (runEnd < line.length && line[runEnd] === '`') runEnd++;
        const runLen = runEnd - bt;
        if (openInlineBtLen === 0) {
          if (runLen === 1 && isEmoticonBacktickAt(line, bt)) {
            outsideLine += '`';
            cPos = runEnd;
            continue;
          }
          openInlineBtLen = runLen;
        } else if (runLen === openInlineBtLen) {
          openInlineBtLen = 0;
        }
        cPos = runEnd;
      }
    }

    if (!outsideLine) continue;

    if (outsideLine.includes('<')) {
      thinkRe.lastIndex = 0;
      let tm;
      while ((tm = thinkRe.exec(outsideLine)) !== null) {
        const tag = tm[2].toLowerCase();
        if (tm[1] === '/') {
          if (thinkDepthByTag[tag] > 0) thinkDepthByTag[tag] -= 1;
        } else {
          thinkDepthByTag[tag] = (thinkDepthByTag[tag] || 0) + 1;
        }
      }
      htmlRe.lastIndex = 0;
      let hm;
      while ((hm = htmlRe.exec(outsideLine)) !== null) {
        const tag = hm[2].toLowerCase();
        if (hm[1] === '/') {
          if (htmlDepthByTag[tag] > 0) htmlDepthByTag[tag] -= 1;
        } else {
          htmlDepthByTag[tag] = (htmlDepthByTag[tag] || 0) + 1;
        }
      }
    }

    if (outsideLine.includes('[') || outsideLine.includes('【') || outsideLine.includes(']')) {
      bracketScanLines.push(outsideLine);
    }
  }

  let pillOpen = false;
  let pushOpen = false;
  let oneRingOpen = false;
  if (bracketScanLines.length > 0) {
    const bracketText = bracketScanLines.join('\n');
    if (bracketText.includes('[系统提示:]') && bracketText.includes('VCP')) {
      const pillTokRe = /(\[系统提示:\]\s*[【\[]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]])|([【\[]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]])/g;
      let pm;
      while ((pm = pillTokRe.exec(bracketText)) !== null) {
        if (pm[1]) pillOpen = true;
        else if (pillOpen) pillOpen = false;
      }
    }
    if (bracketText.includes('[[VCP桌面推送通知:')) {
      const pushTokRe = /(\[\[VCP桌面推送通知:)|(\]\])/g;
      let pm;
      while ((pm = pushTokRe.exec(bracketText)) !== null) {
        if (pm[1]) pushOpen = true;
        else if (pushOpen) pushOpen = false;
      }
    }
    if (bracketText.includes('[OneRing通知:')) {
      const oneRingTokRe = /(\[OneRing通知:)|(\])/g;
      let om;
      while ((om = oneRingTokRe.exec(bracketText)) !== null) {
        if (om[1]) oneRingOpen = true;
        else if (oneRingOpen) oneRingOpen = false;
      }
    }
  }

  const out = [];
  if (openFence) out.push(openFence);
  if (openInlineBtLen > 0) out.push({ kind: 'inlineBt', len: openInlineBtLen });
  for (const tagName of Object.keys(thinkDepthByTag)) {
    if (thinkDepthByTag[tagName] > 0) {
      out.push({ kind: 'think', tagName });
    }
  }
  for (const tagName of Object.keys(htmlDepthByTag)) {
    if (htmlDepthByTag[tagName] > 0) {
      out.push({ kind: 'html', tagName });
    }
  }
  if (vcpThinkOpen) out.push({ kind: 'vcpThink' });
  if (pillOpen) out.push({ kind: 'pill' });
  if (pushOpen) out.push({ kind: 'push' });
  if (oneRingOpen) out.push({ kind: 'oneRingNotice' });
  return out;
}

const LATER_OPEN_FUZZY_RE = /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi;
const LATER_OPEN_STRICT_RE = /<<<\[TOOL_REQUEST(?:_ESCAPE)?\]>>>/g;
const LATER_FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)/gm;

function hasMatchingContainerCloseAfter(text, candidateEnd, openContainers, fuzzy, hints = null) {
  if (!openContainers || openContainers.length === 0) return false;
  const toolBucketKey = fuzzy ? 'fuzzy' : 'strict';
  const nextOpenRe = fuzzy ? LATER_OPEN_FUZZY_RE : LATER_OPEN_STRICT_RE;
  let hasFenceInText;
  if (hints && hints._hasFenceInText !== undefined) {
    hasFenceInText = hints._hasFenceInText;
  } else {
    hasFenceInText = text.includes('```') || text.includes('~~~');
    if (hints) hints._hasFenceInText = hasFenceInText;
  }
  const fenceOpenRe = LATER_FENCE_OPEN_RE;

  let laterState = hints && hints._laterSimpleContainers && hints._laterSimpleContainers[toolBucketKey];
  if (!laterState || candidateEnd < laterState.initialFrom) {
    laterState = {
      initialFrom: candidateEnd,
      scanPos: candidateEnd,
      ranges: [],
      hints: {},
      noFenceCloseCache: {},
      cachedFenceM: undefined
    };
    if (hints) {
      if (!hints._laterSimpleContainers) hints._laterSimpleContainers = {};
      hints._laterSimpleContainers[toolBucketKey] = laterState;
    }
  }

  const findNextLaterFence = (from) => {
    if (!hasFenceInText) return null;
    if (laterState.cachedFenceM !== undefined &&
        (laterState.cachedFenceM === null || laterState.cachedFenceM.index >= from)) {
      return laterState.cachedFenceM;
    }
    let searchPos = from;
    while (searchPos < text.length) {
      fenceOpenRe.lastIndex = searchPos;
      const fm = fenceOpenRe.exec(text);
      if (!fm) {
        laterState.cachedFenceM = null;
        return null;
      }
      const info = fm[2] || '';
      if (fm[1][0] === '`' && info.includes('`')) {
        const nl = text.indexOf('\n', fm.index);
        searchPos = nl === -1 ? text.length : nl + 1;
        continue;
      }
      laterState.cachedFenceM = fm;
      return fm;
    }
    laterState.cachedFenceM = null;
    return null;
  };

  const isInsideLaterClosedToolOrFence = (pos) => {
    while (laterState.scanPos < pos) {
      const fenceM = findNextLaterFence(laterState.scanPos);
      const toolM = execValidToolMarker(nextOpenRe, text, laterState.scanPos, laterState.hints, 'laterOpen');
      if (!fenceM && !toolM) {
        laterState.scanPos = text.length;
        break;
      }
      const fStart = fenceM ? fenceM.index : Infinity;
      const tStart = toolM ? toolM.index : Infinity;
      if (Math.min(fStart, tStart) >= pos) break;

      if (fStart <= tStart) {
        const openNl = text.indexOf('\n', fenceM.index);
        const closeEnd = findClosedFenceLineEnd(
          text,
          openNl,
          fenceM[1][0],
          fenceM[1].length,
          laterState.noFenceCloseCache
        );
        if (closeEnd !== -1) {
          laterState.ranges.push({ start: fenceM.index, end: closeEnd });
          const afterCloseNl = text.indexOf('\n', closeEnd);
          laterState.scanPos = afterCloseNl === -1 ? text.length : afterCloseNl + 1;
          if (closeEnd > pos) return true;
        } else {
          laterState.scanPos = openNl === -1 ? text.length : openNl + 1;
        }
      } else {
        const isEscapeWrapper = /_ESCAPE\]/i.test(toolM[0]);
        const tEnd = scanClosedToolBlockEnd(
          text,
          toolM.index + toolM[0].length,
          laterState.hints,
          { fuzzyToolMatching: fuzzy, isEscapeWrapper, skipContainerCloseCheck: true }
        );
        if (tEnd > 0) {
          laterState.ranges.push({ start: toolM.index, end: tEnd });
          laterState.scanPos = tEnd;
          if (tEnd > pos) return true;
        } else {
          laterState.scanPos = toolM.index + toolM[0].length;
        }
      }
    }
    return Boolean(findEnclosingRange(pos, laterState.ranges));
  };

  let cachedParaLimit = -1;
  const getParaLimit = () => {
    if (hints && hints._paraLimitCache && hints._paraLimitCache.from <= candidateEnd && hints._paraLimitCache.limit >= candidateEnd) {
      return hints._paraLimitCache.limit;
    }
    if (cachedParaLimit !== -1) return cachedParaLimit;
    GAP_DOUBLE_NL_GRE.lastIndex = candidateEnd;
    const dM = GAP_DOUBLE_NL_GRE.exec(text);
    cachedParaLimit = dM ? dM.index : text.length;
    if (hints) hints._paraLimitCache = { from: candidateEnd, limit: cachedParaLimit };
    return cachedParaLimit;
  };

  let closeCache = hints && hints._containerCloseCache;
  if (hints && !closeCache) {
    closeCache = Object.create(null);
    hints._containerCloseCache = closeCache;
  }

  const getContainerKey = (c) => {
    if (c.kind === 'fence') return `${toolBucketKey}:fence:${c.char}:${c.len}`;
    if (c.kind === 'inlineBt') return `${toolBucketKey}:inlineBt:${c.len}`;
    if (c.kind === 'think' || c.kind === 'html') return `${toolBucketKey}:${c.kind}:${c.tagName}`;
    return `${toolBucketKey}:${c.kind}`;
  };

  for (let i = 0; i < openContainers.length; i++) {
    const c = openContainers[i];
    const cKey = getContainerKey(c);
    const cached = closeCache && closeCache[cKey];

    if (c.kind === 'inlineBt') {
      const paraLimit = getParaLimit();
      let positions;
      if (cached && cached.from <= candidateEnd && cached.paraLimit === paraLimit) {
        positions = cached.positions;
      } else {
        positions = [];
        let btScan = candidateEnd;
        while (btScan < paraLimit) {
          const bt = text.indexOf('`', btScan);
          if (bt === -1 || bt >= paraLimit) break;
          let runEnd = bt;
          while (runEnd < text.length && text[runEnd] === '`') runEnd++;
          const runLen = runEnd - bt;
          if (runLen === c.len &&
              !(c.len === 1 && isEmoticonBacktickAt(text, bt)) &&
              !isInsideLaterClosedToolOrFence(bt)) {
            positions.push(bt);
          }
          btScan = runEnd;
        }
        if (closeCache) {
          closeCache[cKey] = { from: candidateEnd, paraLimit, positions };
        }
      }
      let lo = 0;
      let hi = positions.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (positions[mid] < candidateEnd) lo = mid + 1;
        else hi = mid;
      }
      if (((positions.length - lo) & 1) === 1) return true;
      continue;
    }

    if (cached && cached.from <= candidateEnd && (cached.pos === -1 || cached.pos >= candidateEnd)) {
      if (cached.pos !== -1) return true;
      continue;
    }

    let foundPos = -1;
    if (c.kind === 'fence') {
      const chEsc = c.char === '`' ? '`' : '~';
      const fenceCloseRe = new RegExp(`^[ \\t]{0,3}${chEsc}{${c.len},}[ \\t\\r]*$`, 'gm');
      fenceCloseRe.lastIndex = candidateEnd;
      let m;
      while ((m = fenceCloseRe.exec(text)) !== null) {
        if (!isInsideLaterClosedToolOrFence(m.index)) {
          foundPos = m.index;
          break;
        }
      }
    } else if (c.kind === 'think' || c.kind === 'html') {
      const closeRe = new RegExp(`<\\/[ \\t]*${c.tagName}[ \\t]*>`, 'gi');
      closeRe.lastIndex = candidateEnd;
      let m;
      while ((m = closeRe.exec(text)) !== null) {
        if (!isInsideLaterClosedToolOrFence(m.index)) {
          foundPos = m.index;
          break;
        }
      }
    } else if (c.kind === 'vcpThink') {
      const vcpCloseRe = /^[ \t]*\[--- 元思考链结束 ---\]/gm;
      vcpCloseRe.lastIndex = candidateEnd;
      let m;
      while ((m = vcpCloseRe.exec(text)) !== null) {
        if (!isInsideLaterClosedToolOrFence(m.index)) {
          foundPos = m.index;
          break;
        }
      }
    } else if (c.kind === 'pill') {
      const pillCloseRe = /[【\[]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]]/g;
      pillCloseRe.lastIndex = candidateEnd;
      let m;
      while ((m = pillCloseRe.exec(text)) !== null) {
        if (!isInsideLaterClosedToolOrFence(m.index)) {
          foundPos = m.index;
          break;
        }
      }
    } else if (c.kind === 'push') {
      const pushCloseRe = /\]\]/g;
      pushCloseRe.lastIndex = candidateEnd;
      let m;
      while ((m = pushCloseRe.exec(text)) !== null) {
        if (!isInsideLaterClosedToolOrFence(m.index)) {
          foundPos = m.index;
          break;
        }
      }
    } else if (c.kind === 'oneRingNotice') {
      const oneRingCloseRe = /\]/g;
      oneRingCloseRe.lastIndex = candidateEnd;
      let m;
      while ((m = oneRingCloseRe.exec(text)) !== null) {
        if (!isInsideLaterClosedToolOrFence(m.index)) {
          foundPos = m.index;
          break;
        }
      }
    }

    if (closeCache) {
      closeCache[cKey] = { from: candidateEnd, pos: foundPos };
    }
    if (foundPos !== -1) return true;
  }
  return false;
}

const SCAN_END_ESC_FUZZY_RE = /<{2,4}\[END_TOOL_REQUEST_ESCAPE\]>{2,4}/gi;
const SCAN_END_ESC_STRICT_RE = /<<<\[END_TOOL_REQUEST_ESCAPE\]>>>/g;
const SCAN_END_FUZZY_RE = /<{2,4}\[END_TOOL_REQUEST\]>{2,4}/gi;
const SCAN_END_STRICT_RE = /<<<\[END_TOOL_REQUEST\]>>>/g;
const SCAN_OPEN_FUZZY_RE = /<{2,4}\[TOOL_REQUEST\]>{2,4}/gi;
const SCAN_OPEN_STRICT_RE = /<<<\[TOOL_REQUEST\]>>>/g;
const SCAN_WALL_RE = /(?:<<<\[(?:END_)?ROLE_DIVIDE_|<<<\[VCP_TOOL_BATCH_START:|\[\[VCP调用结果信息汇总:)/g;
const WALL_ROLE_OPEN_YRE = /<<<\[ROLE_DIVIDE_([A-Z]+(?::[0-9]+)?)\]>>>/y;
const WALL_ROLE_CLOSE_YRE = /<<<\[END_ROLE_DIVIDE_([A-Z]+(?::[0-9]+)?)\]>>>/y;
const WALL_BATCH_START_YRE = /<<<\[VCP_TOOL_BATCH_START:([^\]\r\n]+)\]>>>/y;
const WALL_BATCH_END_RE = /<<<\[VCP_TOOL_BATCH_END:([^\]\r\n]+)\]>>>/g;
const ROLE_TAG_ANY_RE = /<<<\[(END_)?ROLE_DIVIDE_([A-Z]+(?::[0-9]+)?)\]>>>/g;
const SCAN_FIELD_OPEN_RE = new RegExp(FIELD_OPEN_RE.source, 'g');
const SCAN_ESC_SUFFIX_RE = /(?:ESCAPE|escape)([」}])/iy;
const SCAN_NORM_TAIL_FUZZY_RE = /[^\r\n「{]*?[」}]/y;
const SCAN_NORM_TAIL_STRICT_RE = /(?:_[\w-]+)?[」}]/y;
const SCAN_STRICT_FIELD_CLOSE_RE = /「末」/g;
const SCAN_FUZZY_FIELD_CLOSE_FUZZY_RE = /[「{]末(?!ESCAPE)[^\r\n「{]*?[」}]/gi;
const SCAN_FUZZY_FIELD_CLOSE_STRICT_RE = /[「{]末(?!ESCAPE)(?:_[\w-]+)?[」}]/gi;
const SCAN_INNER_ESC_OPEN_RE = /(?:「始|\{始)(?:ESCAPE|escape)(?:」|\})/gi;
const SCAN_INNER_ESC_CLOSE_RE = /(?:「末|\{末)(?:ESCAPE|escape)(?:」|\})/gi;
const SCAN_ESC_CLOSE_ANY_RE = /[「{]末(?:ESCAPE|escape)[」}]/gi;
const SCAN_ESC_CLOSE_CJK_RE = /「末(?:ESCAPE|escape)」/gi;
const SCAN_ESC_CLOSE_BRACE_RE = /\{末(?:ESCAPE|escape)\}/gi;

function hasUnclosedRoleBeforePos(text, activeHints, roleKey, beforePos) {
  if (!text.includes('<<<[ROLE_DIVIDE_')) return false;
  const openTag = `<<<[ROLE_DIVIDE_${roleKey}]>>>`;
  const closeTag = `<<<[END_ROLE_DIVIDE_${roleKey}]>>>`;
  if (!activeHints.roleBeforeTrack) activeHints.roleBeforeTrack = Object.create(null);
  let track = activeHints.roleBeforeTrack[roleKey];
  if (!track || track.pos > beforePos) {
    track = { pos: 0, lastStart: -1, lastEnd: -1 };
    activeHints.roleBeforeTrack[roleKey] = track;
  }
  if (track.pos < beforePos) {
    let sScan = track.pos;
    while (sScan < beforePos) {
      const idx = text.indexOf(openTag, sScan);
      if (idx === -1 || idx >= beforePos) break;
      track.lastStart = idx;
      sScan = idx + openTag.length;
    }
    let eScan = track.pos;
    while (eScan < beforePos) {
      const idx = text.indexOf(closeTag, eScan);
      if (idx === -1 || idx >= beforePos) break;
      track.lastEnd = idx;
      eScan = idx + closeTag.length;
    }
    track.pos = beforePos;
  }
  return track.lastStart !== -1 && track.lastStart > track.lastEnd;
}

function findNextMonotonicTagPos(text, activeHints, cacheKey, tag, fromPos) {
  if (!activeHints[cacheKey]) activeHints[cacheKey] = Object.create(null);
  const cache = activeHints[cacheKey];
  let idx = cache[tag];
  if (idx === undefined || (idx !== -1 && idx < fromPos)) {
    idx = text.indexOf(tag, fromPos);
    cache[tag] = idx;
  }
  return idx;
}

const FIELD_CONT_END_STRICT_YRE = /[ \t\r\n,，]*<<<\[END_TOOL_REQUEST\]>>>/y;
const FIELD_CONT_END_FUZZY_YRE = /[ \t\r\n,，]*<{2,4}\[END_TOOL_REQUEST\]>{2,4}/iy;
const FIELD_CONT_NEXT_YRE = /[ \t\r\n,，]*[a-zA-Z0-9_-]+[ \t]*:[ \t\r\n]*[「{]始/y;

function getEnclosingVcpInfoCached(text, activeHints, pos) {
  if (activeHints.hasVcpInfoEnd === undefined) {
    activeHints.hasVcpInfoEnd = text.includes('VCP调用结果结束]]');
  }
  if (!activeHints.hasVcpInfoEnd) return null;
  if (!activeHints.vcpInfoRanges) {
    activeHints.vcpInfoRanges = findNestedVcpInfoRanges(text);
  }
  return findEnclosingRange(pos, activeHints.vcpInfoRanges);
}

function findFirstBatchEndAfterCached(text, activeHints, batchId, afterPos) {
  if (activeHints.hasBatchEnd === undefined) {
    activeHints.hasBatchEnd = text.includes('<<<[VCP_TOOL_BATCH_END:');
  }
  if (!activeHints.hasBatchEnd) return -1;
  if (!activeHints.batchEndsById) {
    const map = new Map();
    WALL_BATCH_END_RE.lastIndex = 0;
    let bm;
    while ((bm = WALL_BATCH_END_RE.exec(text)) !== null) {
      let arr = map.get(bm[1]);
      if (!arr) {
        arr = [];
        map.set(bm[1], arr);
      }
      arr.push({ start: bm.index, end: bm.index + bm[0].length });
    }
    activeHints.batchEndsById = map;
  }
  const arr = activeHints.batchEndsById.get(batchId);
  if (!arr || arr.length === 0) return -1;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].start < afterPos) lo = mid + 1;
    else hi = mid;
  }
  return lo < arr.length ? arr[lo].end : -1;
}

function hasValidSelfContainedFieldContinuation(text, activeHints, afterClosePos, fuzzy, toolEndRe, nextOpenRe) {
  const contEndRe = fuzzy ? FIELD_CONT_END_FUZZY_YRE : FIELD_CONT_END_STRICT_YRE;
  contEndRe.lastIndex = afterClosePos;
  const endM = contEndRe.exec(text);
  if (endM) {
    const markerOffset = endM[0].search(/</);
    const markerAbs = afterClosePos + markerOffset;
    const markerLen = endM[0].length - markerOffset;
    if (!hasAdjacentAngle(text, markerAbs, markerLen) &&
        !isQuotedSingleToolMarker(text, markerAbs, markerLen)) {
      return true;
    }
  }
  FIELD_CONT_NEXT_YRE.lastIndex = afterClosePos;
  if (!FIELD_CONT_NEXT_YRE.exec(text)) {
    return false;
  }
  const ownEndM = execValidToolMarker(toolEndRe, text, afterClosePos, activeHints, 'selfContEnd');
  if (!ownEndM) return false;
  const nextToolM = execValidToolMarker(nextOpenRe, text, afterClosePos, activeHints, 'selfContNext');
  if (nextToolM && nextToolM.index < ownEndM.index) return false;
  return true;
}

function isRealFieldWall(text, activeHints, afterOpenPos, wM, closeBoundaryIdx, hasFieldClose, fieldCloseLen, fuzzy, toolEndRe, nextOpenRe) {
  const wIdx = wM.index;
  if (text[wIdx] === '[') {
    if (!isLineLeadingBlank(text, wIdx)) return false;
    const vcpRange = getEnclosingVcpInfoCached(text, activeHints, wIdx);
    if (!vcpRange) return false;
    if (!hasFieldClose || vcpRange.end > closeBoundaryIdx) return true;
    return !hasValidSelfContainedFieldContinuation(text, activeHints, closeBoundaryIdx + fieldCloseLen, fuzzy, toolEndRe, nextOpenRe);
  }
  if (text.startsWith('<<<[END_ROLE_DIVIDE_', wIdx)) {
    WALL_ROLE_CLOSE_YRE.lastIndex = wIdx;
    const rm = WALL_ROLE_CLOSE_YRE.exec(text);
    if (!rm) return false;
    return hasUnclosedRoleBeforePos(text, activeHints, rm[1], afterOpenPos);
  }
  if (text.startsWith('<<<[ROLE_DIVIDE_', wIdx)) {
    WALL_ROLE_OPEN_YRE.lastIndex = wIdx;
    const rm = WALL_ROLE_OPEN_YRE.exec(text);
    if (!rm) return false;
    const roleKey = rm[1];
    const afterRoleOpen = wIdx + rm[0].length;
    const openTag = `<<<[ROLE_DIVIDE_${roleKey}]>>>`;
    const closeTag = `<<<[END_ROLE_DIVIDE_${roleKey}]>>>`;
    const firstEnd = findNextMonotonicTagPos(text, activeHints, 'roleEndPos', closeTag, afterRoleOpen);
    if (firstEnd === -1) return false;
    const nextStart = findNextMonotonicTagPos(text, activeHints, 'roleStartPos', openTag, afterRoleOpen);
    const isPaired = nextStart === -1 || firstEnd < nextStart;
    if (!isPaired) return false;
    if (!hasFieldClose || firstEnd >= closeBoundaryIdx) return true;
    if (!isLineLeadingBlank(text, wIdx)) return false;
    return !hasValidSelfContainedFieldContinuation(text, activeHints, closeBoundaryIdx + fieldCloseLen, fuzzy, toolEndRe, nextOpenRe);
  }
  WALL_BATCH_START_YRE.lastIndex = wIdx;
  const bm = WALL_BATCH_START_YRE.exec(text);
  if (!bm) return false;
  const batchEnd = findFirstBatchEndAfterCached(text, activeHints, bm[1], wIdx + bm[0].length);
  if (batchEnd === -1) return false;
  if (!hasFieldClose || batchEnd > closeBoundaryIdx) return true;
  return !hasValidSelfContainedFieldContinuation(text, activeHints, closeBoundaryIdx + fieldCloseLen, fuzzy, toolEndRe, nextOpenRe);
}

function findEffectiveFieldWall(text, wallRe, activeHints, afterOpenPos, fromPos, stopAtIdx, closeBoundaryIdx, hasFieldClose, fieldCloseLen, fuzzy, toolEndRe, nextOpenRe) {
  if (activeHints.hasAnyWall === undefined) {
    activeHints.hasAnyWall =
      text.includes('<<<[ROLE_DIVIDE_') ||
      text.includes('<<<[END_ROLE_DIVIDE_') ||
      text.includes('<<<[VCP_TOOL_BATCH_START:') ||
      text.includes('[[VCP调用结果信息汇总:');
  }
  if (!activeHints.hasAnyWall) return null;
  const fc = activeHints.fieldWallCache;
  if (fc && fc.afterOpenPos === afterOpenPos && fc.closeBoundaryIdx === closeBoundaryIdx &&
      fromPos >= fc.fromPos && stopAtIdx <= fc.stopAtIdx &&
      (fc.match === null || fc.match.index >= fromPos)) {
    return fc.match;
  }
  let wScan = fromPos;
  let res = null;
  while (wScan < stopAtIdx) {
    const wM = execCachedRegex(wallRe, text, wScan, activeHints, 'wall');
    if (!wM || wM.index >= stopAtIdx) {
      res = wM;
      break;
    }
    if (isRealFieldWall(text, activeHints, afterOpenPos, wM, closeBoundaryIdx, hasFieldClose, fieldCloseLen, fuzzy, toolEndRe, nextOpenRe)) {
      res = wM;
      break;
    }
    wScan = wM.index + wM[0].length;
  }
  activeHints.fieldWallCache = { afterOpenPos, closeBoundaryIdx, fromPos, stopAtIdx, match: res };
  return res;
}

function getEscCloseSpecFor(fuzzy, openBracket, closeBracket) {
  if (fuzzy) return { re: SCAN_ESC_CLOSE_ANY_RE, hintKey: 'escCloseAny' };
  if (openBracket === '「' && closeBracket === '」') return { re: SCAN_ESC_CLOSE_CJK_RE, hintKey: 'escCloseCjk' };
  if (openBracket === '{' && closeBracket === '}') return { re: SCAN_ESC_CLOSE_BRACE_RE, hintKey: 'escCloseBrace' };
  return { re: SCAN_ESC_CLOSE_ANY_RE, hintKey: 'escCloseAny' };
}

function hasCrossFieldBetweenPos(text, activeHints, afterNext, limitPos) {
  if (afterNext >= limitPos) return false;
  CROSS_FIELD_HEAD_STICKY_RE.lastIndex = afterNext;
  const headM = CROSS_FIELD_HEAD_STICKY_RE.exec(text);
  if (headM && headM.index + headM[0].length <= limitPos) return true;
  const nextFieldM = execCachedRegex(CROSS_FIELD_NEXT_RE, text, afterNext, activeHints, 'crossField');
  return Boolean(nextFieldM && nextFieldM.index + nextFieldM[0].length <= limitPos);
}

function mayHaveUnclosedContainerInRange(text, start, end) {
  if (end <= start) return false;
  if (end - start <= 32) {
    for (let i = start; i < end; i++) {
      const ch = text[i];
      if (ch === '`' || ch === '~' || ch === '<' || ch === '[') return true;
    }
    return false;
  }
  return true;
}

function scanClosedToolBlockEnd(text, afterOpenPos, hints = null, options = {}) {
  const len = text.length;
  let scan = afterOpenPos;
  const fuzzy = resolveFuzzyMatching(options);
  const isEscapeWrapper = Boolean(options && options.isEscapeWrapper);
  const skipContainerCloseCheck = Boolean((options && options.skipContainerCloseCheck) || isEscapeWrapper);
  const activeHints = hints || {};
  const escWallRanges = (options && options.protectRoleDivider && Array.isArray(options.opaqueRanges))
    ? options.opaqueRanges
    : null;

  const toolEndRe = isEscapeWrapper
    ? (fuzzy ? SCAN_END_ESC_FUZZY_RE : SCAN_END_ESC_STRICT_RE)
    : (fuzzy ? SCAN_END_FUZZY_RE : SCAN_END_STRICT_RE);
  const endHintKey = isEscapeWrapper ? 'escEnd' : 'end';
  if (isEscapeWrapper) {
    const escEndM = execValidToolMarker(toolEndRe, text, afterOpenPos, activeHints, endHintKey);
    return escEndM ? escEndM.index + escEndM[0].length : -1;
  }
  const nextOpenRe = fuzzy ? SCAN_OPEN_FUZZY_RE : SCAN_OPEN_STRICT_RE;
  const nextHintKey = 'next';
  const wallRe = SCAN_WALL_RE;
  const fieldOpenRe = SCAN_FIELD_OPEN_RE;
  const escSuffixRe = SCAN_ESC_SUFFIX_RE;
  const normOpenTailRe = fuzzy ? SCAN_NORM_TAIL_FUZZY_RE : SCAN_NORM_TAIL_STRICT_RE;
  const strictFieldCloseRe = SCAN_STRICT_FIELD_CLOSE_RE;
  const fuzzyFieldCloseRe = fuzzy ? SCAN_FUZZY_FIELD_CLOSE_FUZZY_RE : SCAN_FUZZY_FIELD_CLOSE_STRICT_RE;
  const innerEscOpenRe = SCAN_INNER_ESC_OPEN_RE;
  const innerEscCloseRe = SCAN_INNER_ESC_CLOSE_RE;



  while (scan < len) {
    const fieldM = execCachedRegex(fieldOpenRe, text, scan, activeHints, 'field');
    const endM = execValidToolMarker(toolEndRe, text, scan, activeHints, endHintKey);
    const nextM = execValidToolMarker(nextOpenRe, text, scan, activeHints, nextHintKey);
    const wallM = execCachedRegex(wallRe, text, scan, activeHints, 'wall');

    let stopIdx = len;
    if (nextM && nextM.index < stopIdx) stopIdx = nextM.index;
    if (wallM && wallM.index < stopIdx) stopIdx = wallM.index;

    const endIdx = endM ? endM.index : len;
    const fieldIdx = fieldM ? fieldM.index : len;

    if (stopIdx < endIdx && stopIdx <= fieldIdx) return -1;
    if (endM && endIdx <= fieldIdx && endIdx < stopIdx) {
      const candidateEnd = endM.index + endM[0].length;
      if (!skipContainerCloseCheck && mayHaveUnclosedContainerInRange(text, scan, endM.index)) {
        const tailUnclosed = collectUnclosedContainersInField(text.slice(scan, endM.index));
        if (hasMatchingContainerCloseAfter(text, candidateEnd, tailUnclosed, fuzzy, activeHints)) {
          return -1;
        }
      }
      return candidateEnd;
    }
    if (!fieldM || fieldIdx >= len) return -1;

    const afterStartPrefix = fieldM.index + fieldM[0].length;
    const openBracket = fieldM[1];
    escSuffixRe.lastIndex = afterStartPrefix;
    const escSuffixM = escSuffixRe.exec(text);

    if (escSuffixM) {
      const { re: escCloseRe, hintKey: escCloseHintKey } = getEscCloseSpecFor(fuzzy, openBracket, escSuffixM[1]);
      const escBodyStart = afterStartPrefix + escSuffixM[0].length;
      const escCloseM = execCachedRegex(escCloseRe, text, escBodyStart, activeHints, escCloseHintKey);
      if (!escCloseM) return -1;
      if (escWallRanges) {
        const hitWall = findEnclosingRange(escCloseM.index, escWallRanges);
        if (hitWall && hitWall.start >= afterOpenPos) return -1;
      }
      scan = escCloseM.index + escCloseM[0].length;
      continue;
    }

    normOpenTailRe.lastIndex = afterStartPrefix;
    const normOpenTailM = normOpenTailRe.exec(text);
    if (!normOpenTailM) {
      scan = afterStartPrefix;
      continue;
    }

    const isStrictFieldClose = !fuzzy && openBracket === '「' && normOpenTailM[0] === '」';
    const fieldCloseRe = isStrictFieldClose ? strictFieldCloseRe : fuzzyFieldCloseRe;
    const fieldCloseHintKey = isStrictFieldClose ? 'strictFieldClose' : 'fuzzyFieldClose';
    const valStart = afterStartPrefix + normOpenTailM[0].length;
    let fScan = valStart;
    let fieldDone = false;

    while (fScan < len) {
      const fCloseM = execCachedRegex(fieldCloseRe, text, fScan, activeHints, fieldCloseHintKey);
      const fEndM = execValidToolMarker(toolEndRe, text, fScan, activeHints, endHintKey);
      const fNextM = execValidToolMarker(nextOpenRe, text, fScan, activeHints, nextHintKey);
      const hasFieldClose = Boolean(fCloseM);
      const fieldCloseLen = fCloseM ? fCloseM[0].length : 0;
      const closeBoundaryIdx = fCloseM ? fCloseM.index : (fEndM ? fEndM.index : len);
      const wallStopIdx = (fEndM && fCloseM && fEndM.index < fCloseM.index) ? len : closeBoundaryIdx;
      const fWallM = findEffectiveFieldWall(text, wallRe, activeHints, afterOpenPos, fScan, wallStopIdx, closeBoundaryIdx, hasFieldClose, fieldCloseLen, fuzzy, toolEndRe, nextOpenRe);
      const wallLimit = fWallM ? fWallM.index : len;

      const innerEscOpenM = execCachedRegex(innerEscOpenRe, text, fScan, activeHints, 'innerEscOpen');
      if (innerEscOpenM && innerEscOpenM.index < wallLimit && (!fCloseM || innerEscOpenM.index < fCloseM.index)) {
        const innerEscCloseM = execCachedRegex(innerEscCloseRe, text, innerEscOpenM.index + innerEscOpenM[0].length, activeHints, 'innerEscClose');
        if (innerEscCloseM && innerEscCloseM.index < wallLimit) {
          const crossedAfterOwnEnd = Boolean(
            fEndM && fNextM && fEndM.index < fNextM.index && fNextM.index < innerEscCloseM.index &&
            hasCrossFieldBetweenPos(text, activeHints, fNextM.index + fNextM[0].length, innerEscCloseM.index)
          );
          const crossedClosedBlock = Boolean(
            crossedAfterOwnEnd ||
            (fCloseM && fEndM && fCloseM.index < fEndM.index && fEndM.index < innerEscCloseM.index)
          );
          let isValidInnerEscape = !crossedClosedBlock && (!fEndM || fEndM.index > innerEscCloseM.index);
          if (!crossedClosedBlock && !isValidInnerEscape) {
            const afterEscClose = innerEscCloseM.index + innerEscCloseM[0].length;
            fieldCloseRe.lastIndex = afterEscClose;
            const afterCloseM = fieldCloseRe.exec(text);
            if (afterCloseM && afterCloseM.index < wallLimit) {
              const postEscNextM = execValidToolMarker(nextOpenRe, text, afterEscClose);
              const crossAfterClose = Boolean(
                postEscNextM && postEscNextM.index < afterCloseM.index &&
                hasCrossFieldBetweenPos(text, activeHints, postEscNextM.index + postEscNextM[0].length, afterCloseM.index)
              );
              if (!crossAfterClose) {
                const afterEndM = execValidToolMarker(toolEndRe, text, afterCloseM.index + afterCloseM[0].length, activeHints, endHintKey);
                if (afterEndM && afterEndM.index < wallLimit) {
                  isValidInnerEscape = true;
                }
              }
            }
          }
          if (isValidInnerEscape) {
            fScan = innerEscCloseM.index + innerEscCloseM[0].length;
            continue;
          }
        }
      }

      if (fCloseM && fCloseM.index < wallLimit) {
        let skipFieldClose = false;
        if (fNextM && fNextM.index < fCloseM.index &&
            hasCrossFieldBetweenPos(text, activeHints, fNextM.index + fNextM[0].length, fCloseM.index)) {
          if (!(fEndM && fEndM.index < fNextM.index)) {
            return -1;
          }
          skipFieldClose = true;
        }
        if (!skipFieldClose && fEndM && fEndM.index < fCloseM.index) {
          if (fNextM && fEndM.index < fNextM.index && fNextM.index < fCloseM.index) {
            skipFieldClose = true;
          } else {
            const afterClosePos = fCloseM.index + fCloseM[0].length;
            const afterEndM = execValidToolMarker(toolEndRe, text, afterClosePos, activeHints, 'postCloseEnd');
            const postCloseNextM = execValidToolMarker(nextOpenRe, text, afterClosePos, activeHints, 'postCloseNext');
            const closeBelongsToCurrentBlock = Boolean(
              afterEndM &&
              afterEndM.index < wallLimit &&
              !(postCloseNextM && postCloseNextM.index < afterEndM.index)
            );
            if (!closeBelongsToCurrentBlock) {
              skipFieldClose = true;
            }
          }
        }
        if (!skipFieldClose) {
          scan = fCloseM.index + fCloseM[0].length;
          fieldDone = true;
          break;
        }
      }

      let fallbackLimit = wallLimit;
      if (fNextM && fNextM.index < fallbackLimit) fallbackLimit = fNextM.index;
      if (fEndM && fEndM.index < fallbackLimit) {
        const candidateEnd = fEndM.index + fEndM[0].length;
        if (!skipContainerCloseCheck && mayHaveUnclosedContainerInRange(text, valStart, fEndM.index)) {
          const currentFieldUnclosed = collectUnclosedContainersInField(text.slice(valStart, fEndM.index));
          if (hasMatchingContainerCloseAfter(text, candidateEnd, currentFieldUnclosed, fuzzy, activeHints)) {
            return -1;
          }
        }
        return candidateEnd;
      }

      return -1;
    }

    if (!fieldDone) return -1;
  }

  return -1;
}

function findClosedToolBlockRanges(text, options = {}) {
  const ranges = [];
  if (typeof text !== 'string' || !/\[TOOL_REQUEST/i.test(text)) {
    return ranges;
  }

  const fuzzy = resolveFuzzyMatching(options);
  const openRe = fuzzy ? /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi : /<<<\[TOOL_REQUEST(?:_ESCAPE)?\]>>>/g;
  const hints = {};
  let cursor = 0;

  while (cursor < text.length) {
    const openMatch = execValidToolMarker(openRe, text, cursor);
    if (!openMatch) break;

    const isEscapeWrapper = /_ESCAPE\]/i.test(openMatch[0]);
    const closedEnd = scanClosedToolBlockEnd(text, openMatch.index + openMatch[0].length, hints, { ...options, isEscapeWrapper });
    if (closedEnd > 0) {
      ranges.push({ start: openMatch.index, end: closedEnd });
      cursor = closedEnd;
    } else {
      cursor = openMatch.index + openMatch[0].length;
    }
  }

  return ranges;
}

const PROSE_HTML_BLOCK_OPEN_YRE = /<(pre|script|style)(?=[ \t\r\n>])[^><]*>/iy;
const PROSE_CODE_OPEN_YRE = /<code(?=[ \t>])[^>\r\n<]*>/iy;
const PROSE_HTML_CLOSE_YRE = /<\/(pre|script|style|code)[ \t]*>/iy;
const PROSE_THINK_TAG_YRE = /<[ \t]*(\/?)[ \t]*(think(?:ing)?|thought(?:s)?|antthinking)(?=[ \t>])[^>\r\n<]*>/iy;
const PROSE_PILL_OPEN_YRE = /\[系统提示:\]\s*[【\[]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]]/y;
const PROSE_PILL_CLOSE_YRE = /[【\[]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]][ \t]*/y;
const PROSE_VCP_OPEN_LINE_RE = /^[ \t]*\[--- VCP元思考链(?::\s*"[^"]*")?\s*---\][ \t\r]*$/;
const PROSE_VCP_CLOSE_LINE_RE = /^[ \t]*\[--- 元思考链结束 ---\]/;
const PROSE_LINE_START_THINK_CLOSE_RE = /^[ \t]*(?:<[ \t]*\/[ \t]*(?:think(?:ing)?|thought(?:s)?|antthinking)[ \t]*>|\[--- 元思考链结束 ---\])/i;
const PROSE_STANDALONE_TOOL_STRICT_RE = /^([ \t]*)(<<<\[TOOL_REQUEST\]>>>)[ \t\r]*$/;
const PROSE_STANDALONE_TOOL_FUZZY_RE = /^([ \t]*)(<{2,4}\[TOOL_REQUEST\]>{2,4})[ \t\r]*$/i;

function isTrailingLineWs(text, afterIndex) {
  const len = text.length;
  for (let r = afterIndex; r < len; r++) {
    const ch = text[r];
    if (ch === '\n') break;
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\uFEFF' && ch !== '\u200B') {
      return false;
    }
  }
  return true;
}
const GAP_DOUBLE_NL_RE = /\r?\n[ \t]*\r?\n/;
const GAP_DOUBLE_NL_GRE = /\r?\n[ \t]*\r?\n/g;
const GAP_THINK_CLOSE_LINE_RE = /\n[ \t]*(?:<[ \t]*\/[ \t]*(?:think(?:ing)?|thought(?:s)?|antthinking)[ \t]*>|\[--- 元思考链结束 ---\])/i;
const GAP_THINK_CLOSE_LINE_GRE = /\n[ \t]*(?:<[ \t]*\/[ \t]*(?:think(?:ing)?|thought(?:s)?|antthinking)[ \t]*>|\[--- 元思考链结束 ---\])/gi;
const GAP_PILL_CLOSE_RE = /[【\[]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]]/;
const GAP_PILL_CLOSE_GRE = /[【\[]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]]/g;
const GAP_VCP_CLOSE_LINE_RE = /^[ \t]*\[--- 元思考链结束 ---\]/m;
const GAP_VCP_CLOSE_LINE_GRE = /^[ \t]*\[--- 元思考链结束 ---\]/gm;
const GAP_HTML_CLOSE_RES = {
  pre: /<\/pre[ \t]*>/i,
  script: /<\/script[ \t]*>/i,
  style: /<\/style[ \t]*>/i,
  code: /<\/code[ \t]*>/i
};
const GAP_HTML_CLOSE_GRES = {
  pre: /<\/pre[ \t]*>/gi,
  script: /<\/script[ \t]*>/gi,
  style: /<\/style[ \t]*>/gi,
  code: /<\/code[ \t]*>/gi
};
const GAP_THINK_CLOSE_RES = {
  think: /<[ \t]*\/[ \t]*think[ \t]*>/i,
  thinking: /<[ \t]*\/[ \t]*thinking[ \t]*>/i,
  thought: /<[ \t]*\/[ \t]*thought[ \t]*>/i,
  thoughts: /<[ \t]*\/[ \t]*thoughts[ \t]*>/i,
  antthinking: /<[ \t]*\/[ \t]*antthinking[ \t]*>/i
};
const GAP_THINK_CLOSE_GRES = {
  think: /<[ \t]*\/[ \t]*think[ \t]*>/gi,
  thinking: /<[ \t]*\/[ \t]*thinking[ \t]*>/gi,
  thought: /<[ \t]*\/[ \t]*thought[ \t]*>/gi,
  thoughts: /<[ \t]*\/[ \t]*thoughts[ \t]*>/gi,
  antthinking: /<[ \t]*\/[ \t]*antthinking[ \t]*>/gi
};

const THINK_TAG_NAMES = ['think', 'thinking', 'thought', 'thoughts', 'antthinking'];
const THINK_TAG_SCAN_RES = {
  think: /<[ \t]*(\/?)[ \t]*think(?=[ \t>])[^>\r\n<]*>/gi,
  thinking: /<[ \t]*(\/?)[ \t]*thinking(?=[ \t>])[^>\r\n<]*>/gi,
  thought: /<[ \t]*(\/?)[ \t]*thought(?=[ \t>])[^>\r\n<]*>/gi,
  thoughts: /<[ \t]*(\/?)[ \t]*thoughts(?=[ \t>])[^>\r\n<]*>/gi,
  antthinking: /<[ \t]*(\/?)[ \t]*antthinking(?=[ \t>])[^>\r\n<]*>/gi
};
const THINK_TAG_SCAN_YRES = {
  think: /<[ \t]*(\/?)[ \t]*think(?=[ \t>])[^>\r\n<]*>/iy,
  thinking: /<[ \t]*(\/?)[ \t]*thinking(?=[ \t>])[^>\r\n<]*>/iy,
  thought: /<[ \t]*(\/?)[ \t]*thought(?=[ \t>])[^>\r\n<]*>/iy,
  thoughts: /<[ \t]*(\/?)[ \t]*thoughts(?=[ \t>])[^>\r\n<]*>/iy,
  antthinking: /<[ \t]*(\/?)[ \t]*antthinking(?=[ \t>])[^>\r\n<]*>/iy
};
const TOOL_OPEN_STRICT_YRE = /<<<\[TOOL_REQUEST(?:_ESCAPE)?\]>>>/y;
const TOOL_OPEN_FUZZY_YRE = /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/iy;

function isLineLeadingWsOnly(text, pos) {
  for (let ls = pos - 1; ls >= 0 && text[ls] !== '\n'; ls--) {
    if (text[ls] !== ' ' && text[ls] !== '\t') return false;
  }
  return true;
}

function hasUnmatchedThinkCloseAfter(text, fromPos, tagNameOrVcp, options = {}) {
  if (typeof text !== 'string' || fromPos >= text.length) return false;
  const isVcp = tagNameOrVcp === 'vcp';
  const normTag = isVcp ? '' : String(tagNameOrVcp || '').trim();
  const normLower = normTag.toLowerCase();
  if (!isVcp && !normTag) return false;
  const safeCustomTag = (!isVcp && !THINK_TAG_SCAN_RES[normLower])
    ? normTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : '';
  const xmlTagGre = isVcp
    ? null
    : (THINK_TAG_SCAN_RES[normLower] || new RegExp(`<[ \\t]*(\\/?)[ \\t]*${safeCustomTag}(?=[ \\t>])[^>\\r\\n<]*>`, 'gi'));
  const xmlTagYre = isVcp
    ? null
    : (THINK_TAG_SCAN_YRES[normLower] || new RegExp(`<[ \\t]*(\\/?)[ \\t]*${safeCustomTag}(?=[ \\t>])[^>\\r\\n<]*>`, 'iy'));
  const customLineCloseRe = safeCustomTag
    ? new RegExp(`^[ \\t]*<[ \\t]*\\/[ \\t]*${safeCustomTag}[ \\t]*>`, 'i')
    : null;

  const skipRanges = Array.isArray(options.skipRanges) ? options.skipRanges : null;
  if (skipRanges) {
    if (isVcp) {
      let lineStart = Math.max(0, fromPos);
      if (lineStart > 0 && text[lineStart - 1] !== '\n') {
        const nl = text.indexOf('\n', lineStart);
        if (nl === -1) return false;
        lineStart = nl + 1;
      }
      let depth = 0;
      const len = text.length;
      while (lineStart < len) {
        const hit = findEnclosingRange(lineStart, skipRanges);
        if (hit) {
          if (hit.end > lineStart && text[hit.end - 1] === '\n') {
            lineStart = hit.end;
          } else {
            const nl = text.indexOf('\n', hit.end);
            lineStart = nl === -1 ? len : nl + 1;
          }
          continue;
        }
        const nl = text.indexOf('\n', lineStart);
        const lineEnd = nl === -1 ? len : nl;
        const lineEndNoCr = (lineEnd > lineStart && text[lineEnd - 1] === '\r') ? lineEnd - 1 : lineEnd;
        const lineSlice = text.slice(lineStart, lineEndNoCr);
        if (PROSE_VCP_OPEN_LINE_RE.test(lineSlice)) {
          depth++;
        } else if (PROSE_VCP_CLOSE_LINE_RE.test(lineSlice)) {
          const lbPos = lineStart + lineSlice.indexOf('[');
          if (!findEnclosingRange(lbPos, skipRanges)) {
            if (depth === 0) return true;
            depth--;
          }
        }
        lineStart = nl === -1 ? len : nl + 1;
      }
      return false;
    }

    xmlTagGre.lastIndex = Math.max(0, fromPos);
    let depth = 0;
    let m;
    while ((m = xmlTagGre.exec(text)) !== null) {
      const hit = findEnclosingRange(m.index, skipRanges);
      if (hit) {
        xmlTagGre.lastIndex = Math.max(m.index + 1, hit.end);
        continue;
      }
      if (m[1] === '/') {
        if (depth === 0) return true;
        depth--;
      } else {
        depth++;
      }
    }
    return false;
  }

  const len = text.length;
  const opaqueRanges = Array.isArray(options.opaqueRanges) && options.opaqueRanges.length > 0 ? options.opaqueRanges : null;
  const opaqueLen = opaqueRanges ? opaqueRanges.length : 0;
  const fuzzy = options.fuzzy !== undefined ? Boolean(options.fuzzy) : resolveFuzzyMatching(options);
  const toolOpenYre = fuzzy ? TOOL_OPEN_FUZZY_YRE : TOOL_OPEN_STRICT_YRE;
  const standaloneToolLineRe = fuzzy ? PROSE_STANDALONE_TOOL_FUZZY_RE : PROSE_STANDALONE_TOOL_STRICT_RE;
  const noFenceCloseCache = {};
  const toolHints = {};
  let opaqueIdx = 0;
  let pos = Math.max(0, fromPos);
  let depth = 0;
  let inlineBtLen = 0;
  let lineWsOnly = isLineLeadingWsOnly(text, pos);

  while (pos < len) {
    if (opaqueRanges) {
      while (opaqueIdx < opaqueLen && opaqueRanges[opaqueIdx].end <= pos) opaqueIdx++;
      if (opaqueIdx < opaqueLen && opaqueRanges[opaqueIdx].start <= pos) {
        inlineBtLen = 0;
        pos = opaqueRanges[opaqueIdx].end;
        lineWsOnly = isLineLeadingWsOnly(text, pos);
        continue;
      }
    }

    const segLimit = (opaqueRanges && opaqueIdx < opaqueLen && opaqueRanges[opaqueIdx].start < len)
      ? opaqueRanges[opaqueIdx].start
      : len;
    const nl = text.indexOf('\n', pos);
    const hasCompleteLine = nl !== -1 && nl < segLimit;
    const segEnd = hasCompleteLine ? nl : segLimit;

    if (lineWsOnly && segEnd > pos) {
      const lineEndNoCr = (segEnd > pos && text[segEnd - 1] === '\r') ? segEnd - 1 : segEnd;
      const lineSlice = text.slice(pos, lineEndNoCr);
      if (hasCompleteLine && /^[ \t]*$/.test(lineSlice)) {
        if (inlineBtLen > 0) inlineBtLen = 0;
        pos = segEnd + 1;
        lineWsOnly = true;
        continue;
      }
      if (inlineBtLen > 0 && (PROSE_LINE_START_THINK_CLOSE_RE.test(lineSlice) || (customLineCloseRe && customLineCloseRe.test(lineSlice)))) {
        inlineBtLen = 0;
      }
      if (inlineBtLen === 0) {
        if (isVcp) {
          if (PROSE_VCP_OPEN_LINE_RE.test(lineSlice)) {
            depth++;
            pos = hasCompleteLine ? segEnd + 1 : segEnd;
            lineWsOnly = hasCompleteLine;
            continue;
          }
          const vcpCloseM = PROSE_VCP_CLOSE_LINE_RE.exec(lineSlice);
          if (vcpCloseM) {
            if (depth === 0) return true;
            depth--;
            const afterClose = pos + vcpCloseM[0].length;
            if (afterClose < segEnd) {
              pos = afterClose;
              lineWsOnly = false;
            } else {
              pos = hasCompleteLine ? segEnd + 1 : segEnd;
              lineWsOnly = hasCompleteLine;
              continue;
            }
          }
        }
        const fenceLineM = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(lineSlice);
        if (fenceLineM && (fenceLineM[1][0] === '~' || !(fenceLineM[2] || '').includes('`'))) {
          const closeEnd = hasCompleteLine
            ? findClosedFenceLineEnd(text, nl, fenceLineM[1][0], fenceLineM[1].length, noFenceCloseCache, opaqueRanges)
            : -1;
          if (closeEnd !== -1) {
            const afterCloseNl = text.indexOf('\n', closeEnd);
            pos = afterCloseNl === -1 ? len : afterCloseNl + 1;
            lineWsOnly = true;
            continue;
          }
          pos = hasCompleteLine ? segEnd + 1 : segEnd;
          lineWsOnly = hasCompleteLine;
          continue;
        }
      } else if (inlineBtLen <= 2 && hasCompleteLine) {
        const tLineM = standaloneToolLineRe.exec(lineSlice);
        if (tLineM) {
          const markerAbs = pos + tLineM[1].length;
          if (!hasAdjacentAngle(text, markerAbs, tLineM[2].length) &&
              !isQuotedSingleToolMarker(text, markerAbs, tLineM[2].length)) {
            inlineBtLen = 0;
          }
        }
      }
    }

    let p = pos;
    let jumpedTool = false;
    while (p < segEnd) {
      if (inlineBtLen > 0) {
        const bt = text.indexOf('`', p);
        if (bt === -1 || bt >= segEnd) {
          if (lineWsOnly && !/^[ \t\r]*$/.test(text.slice(p, segEnd))) lineWsOnly = false;
          p = segEnd;
          break;
        }
        if (lineWsOnly && bt > p && !/^[ \t\r]*$/.test(text.slice(p, bt))) lineWsOnly = false;
        let rEnd = bt;
        while (rEnd < segEnd && text[rEnd] === '`') rEnd++;
        const rLen = rEnd - bt;
        if (!(rLen === 1 && isEmoticonBacktickAt(text, bt)) && rLen === inlineBtLen) {
          inlineBtLen = 0;
        }
        lineWsOnly = false;
        p = rEnd;
        continue;
      }

      const nBt = text.indexOf('`', p);
      const nLt = text.indexOf('<', p);
      let tokPos = segEnd;
      let tokType = 0;
      if (nBt !== -1 && nBt < tokPos) { tokPos = nBt; tokType = 1; }
      if (nLt !== -1 && nLt < tokPos) { tokPos = nLt; tokType = 2; }

      if (tokType === 0) {
        if (lineWsOnly && !/^[ \t\r]*$/.test(text.slice(p, segEnd))) lineWsOnly = false;
        p = segEnd;
        break;
      }
      if (lineWsOnly && tokPos > p && !/^[ \t\r]*$/.test(text.slice(p, tokPos))) {
        lineWsOnly = false;
      }

      if (tokType === 1) {
        let rEnd = tokPos;
        while (rEnd < segEnd && text[rEnd] === '`') rEnd++;
        const rLen = rEnd - tokPos;
        if (!(rLen === 1 && isEmoticonBacktickAt(text, tokPos))) {
          inlineBtLen = rLen;
        }
        lineWsOnly = false;
        p = rEnd;
        continue;
      }

      lineWsOnly = false;
      toolOpenYre.lastIndex = tokPos;
      const tm = toolOpenYre.exec(text);
      if (tm && !hasAdjacentAngle(text, tokPos, tm[0].length) && !isQuotedSingleToolMarker(text, tokPos, tm[0].length)) {
        const isEscapeWrapper = /_ESCAPE\]/i.test(tm[0]);
        const closedEnd = scanClosedToolBlockEnd(
          text,
          tokPos + tm[0].length,
          toolHints,
          { fuzzyToolMatching: fuzzy, isEscapeWrapper, skipContainerCloseCheck: true }
        );
        if (closedEnd > 0) {
          pos = closedEnd;
          lineWsOnly = isLineLeadingWsOnly(text, pos);
          jumpedTool = true;
          break;
        }
      }

      if (!isVcp) {
        xmlTagYre.lastIndex = tokPos;
        const xm = xmlTagYre.exec(text);
        if (xm && xm.index + xm[0].length <= segEnd) {
          if (xm[1] === '/') {
            if (depth === 0) return true;
            depth--;
          } else {
            depth++;
          }
          p = xm.index + xm[0].length;
          continue;
        }
      }

      p = tokPos + 1;
    }

    if (jumpedTool) continue;
    pos = hasCompleteLine ? segEnd + 1 : segEnd;
    lineWsOnly = hasCompleteLine;
  }

  return false;
}

function createMonotonicThinkTracker(text, skipAreas = null, extraTag = '') {
  const normExtra = extraTag ? String(extraTag).trim() : '';
  const safeExtra = (normExtra && !THINK_TAG_SCAN_RES[normExtra.toLowerCase()])
    ? normExtra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : '';
  const extraLower = safeExtra ? normExtra.toLowerCase() : '';
  const extraTagYre = safeExtra
    ? new RegExp(`<[ \\t]*(\\/?)[ \\t]*${safeExtra}(?=[ \\t>])[^>\\r\\n<]*>`, 'iy')
    : null;
  const hasStdThink = text.includes('<') && /<[ \t]*(?:think(?:ing)?|thought(?:s)?|antthinking)(?=[ \t>])/i.test(text);
  const hasVcpThink = text.includes('[--- VCP元思考链');
  const hasExtraThink = Boolean(safeExtra) && text.includes('<') && new RegExp(`<[ \\t]*${safeExtra}(?=[ \\t>])`, 'i').test(text);
  const hasThink = hasStdThink || hasVcpThink || hasExtraThink;

  const skips = Array.isArray(skipAreas) && skipAreas.length > 0 ? skipAreas : null;
  let skipIdx = 0;
  let cursor = 0;
  let cachedNl = -2;
  const openThinkDepth = { think: 0, thinking: 0, thought: 0, thoughts: 0, antthinking: 0 };
  if (extraLower) openThinkDepth[extraLower] = 0;
  const state = {
    hasThink,
    extraTag: extraLower,
    skipAreas: skips || [],
    openVcpThink: false,
    openThinkDepth,
    skipTo(pos) {
      if (pos > cursor) cursor = pos;
    },
    advanceTo(targetEnd) {
      if (!hasThink) return;
      while (cursor < targetEnd) {
        if (skips) {
          while (skipIdx < skips.length && skips[skipIdx].end <= cursor) {
            skipIdx++;
          }
          if (skipIdx < skips.length && skips[skipIdx].start <= cursor) {
            cursor = Math.min(targetEnd, skips[skipIdx].end);
            continue;
          }
        }
        const segLimit = (skips && skipIdx < skips.length && skips[skipIdx].start < targetEnd)
          ? skips[skipIdx].start
          : targetEnd;
        if (cachedNl === -2 || (cachedNl !== -1 && cachedNl < cursor)) {
          cachedNl = text.indexOf('\n', cursor);
        }
        const nl = cachedNl;
        const hasCompleteLine = nl !== -1 && nl < segLimit;
        const segEnd = hasCompleteLine ? nl : segLimit;
        const atLineStart = cursor === 0 || text[cursor - 1] === '\n';
        let p = cursor;
        if (atLineStart && segEnd > cursor && (state.openVcpThink || (hasCompleteLine && hasVcpThink))) {
          const lineEndNoCr = (segEnd > cursor && text[segEnd - 1] === '\r') ? segEnd - 1 : segEnd;
          const lineSlice = text.slice(cursor, lineEndNoCr);
          if (state.openVcpThink) {
            const vcpCloseM = PROSE_VCP_CLOSE_LINE_RE.exec(lineSlice);
            if (vcpCloseM) {
              state.openVcpThink = false;
              p = cursor + vcpCloseM[0].length;
            }
          } else if (hasCompleteLine && hasVcpThink && PROSE_VCP_OPEN_LINE_RE.test(lineSlice)) {
            state.openVcpThink = true;
            cursor = segEnd + 1;
            continue;
          }
        }
        if (!state.openVcpThink) {
          while (p < segEnd) {
            const lt = text.indexOf('<', p);
            if (lt === -1 || lt >= segEnd) break;
            if (hasStdThink) {
              PROSE_THINK_TAG_YRE.lastIndex = lt;
              const tTagM = PROSE_THINK_TAG_YRE.exec(text);
              if (tTagM && tTagM.index + tTagM[0].length <= segEnd) {
                const tName = tTagM[2].toLowerCase();
                if (tTagM[1] === '/') {
                  if (openThinkDepth[tName] > 0) openThinkDepth[tName] -= 1;
                } else {
                  openThinkDepth[tName] += 1;
                }
                p = tTagM.index + tTagM[0].length;
                continue;
              }
            }
            if (extraTagYre) {
              extraTagYre.lastIndex = lt;
              const eTagM = extraTagYre.exec(text);
              if (eTagM && eTagM.index + eTagM[0].length <= segEnd) {
                if (eTagM[1] === '/') {
                  if (openThinkDepth[extraLower] > 0) openThinkDepth[extraLower] -= 1;
                } else {
                  openThinkDepth[extraLower] += 1;
                }
                p = eTagM.index + eTagM[0].length;
                continue;
              }
            }
            p = lt + 1;
          }
        }
        cursor = hasCompleteLine ? segEnd + 1 : segEnd;
      }
    }
  };
  return state;
}

function hasOddSameLineBackticks(text, fromPos, targetLen) {
  const nl = text.indexOf('\n', fromPos);
  const lineEnd = nl === -1 ? text.length : nl;
  let count = 0;
  let scan = fromPos;
  while (scan < lineEnd) {
    const bt = text.indexOf('`', scan);
    if (bt === -1 || bt >= lineEnd) break;
    let rEnd = bt;
    while (rEnd < lineEnd && text[rEnd] === '`') rEnd++;
    if (rEnd - bt === targetLen && !(targetLen === 1 && isEmoticonBacktickAt(text, bt))) {
      count++;
    }
    scan = rEnd;
  }
  return (count & 1) === 1;
}

function hasTrailingUnmatchedThinkClose(text, closeEnd, tagNameOrVcp, options = {}) {
  if (!hasUnmatchedThinkCloseAfter(text, closeEnd, tagNameOrVcp, options)) {
    return false;
  }
  const inlineCloseLen = options.inlineCloseLen || 0;
  if (inlineCloseLen > 0 && closeEnd >= inlineCloseLen && hasOddSameLineBackticks(text, closeEnd, inlineCloseLen)) {
    return hasUnmatchedThinkCloseAfter(text, closeEnd - inlineCloseLen, tagNameOrVcp, options);
  }
  return true;
}

function isCrossUnclosedThinkSpan(text, innerStart, closeEnd, isOpenVcpThink, thinkDepthObj, options = {}) {
  if (innerStart >= closeEnd) return false;
  const extraTag = options.extraTag || '';
  let hasActiveXmlThink = Boolean(extraTag && thinkDepthObj[extraTag] > 0);
  if (!hasActiveXmlThink) {
    for (let i = 0; i < THINK_TAG_NAMES.length; i++) {
      if (thinkDepthObj[THINK_TAG_NAMES[i]] > 0) {
        hasActiveXmlThink = true;
        break;
      }
    }
  }
  if (!isOpenVcpThink && !hasActiveXmlThink) return false;
  if (!isOpenVcpThink) {
    const ltPos = text.indexOf('<', innerStart);
    if (ltPos === -1 || ltPos >= closeEnd) return false;
  }
  const skipRanges = Array.isArray(options.skipRanges) && options.skipRanges.length > 0 ? options.skipRanges : null;
  const innerSlice = text.slice(innerStart, closeEnd);
  if (isOpenVcpThink) {
    const vcpRelStart = (innerStart > 0 && text[innerStart - 1] !== '\n') ? innerSlice.indexOf('\n') : 0;
    if (vcpRelStart !== -1) {
      const vcpAbsStart = vcpRelStart === 0 ? innerStart : innerStart + vcpRelStart + 1;
      let hasVcpCloseInSpan = false;
      if (skipRanges) {
        GAP_VCP_CLOSE_LINE_GRE.lastIndex = vcpAbsStart;
        let vm;
        while ((vm = GAP_VCP_CLOSE_LINE_GRE.exec(text)) !== null && vm.index < closeEnd) {
          const hit = findEnclosingRange(vm.index, skipRanges);
          if (hit) {
            GAP_VCP_CLOSE_LINE_GRE.lastIndex = Math.max(vm.index + 1, hit.end);
            continue;
          }
          hasVcpCloseInSpan = true;
          break;
        }
      } else {
        const vcpTarget = vcpRelStart === 0 ? innerSlice : innerSlice.slice(vcpRelStart + 1);
        hasVcpCloseInSpan = GAP_VCP_CLOSE_LINE_RE.test(vcpTarget);
      }
      if (hasVcpCloseInSpan && !hasTrailingUnmatchedThinkClose(text, closeEnd, 'vcp', options)) {
        return true;
      }
    }
  }
  if (hasActiveXmlThink && innerSlice.includes('<')) {
    const tagList = extraTag ? [...THINK_TAG_NAMES, extraTag] : THINK_TAG_NAMES;
    for (let i = 0; i < tagList.length; i++) {
      const tag = tagList[i];
      if (thinkDepthObj[tag] <= 0) continue;
      let hasCloseInSpan = false;
      if (skipRanges) {
        let gRe = GAP_THINK_CLOSE_GRES[tag];
        if (!gRe) {
          const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          gRe = new RegExp(`<[ \\t]*\\/[ \\t]*${safeTag}[ \\t]*>`, 'gi');
        }
        gRe.lastIndex = innerStart;
        let gm;
        while ((gm = gRe.exec(text)) !== null && gm.index < closeEnd) {
          const hit = findEnclosingRange(gm.index, skipRanges);
          if (hit) {
            gRe.lastIndex = Math.max(gm.index + 1, hit.end);
            continue;
          }
          hasCloseInSpan = true;
          break;
        }
      } else {
        let sRe = GAP_THINK_CLOSE_RES[tag];
        if (!sRe) {
          const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          sRe = new RegExp(`<[ \\t]*\\/[ \\t]*${safeTag}[ \\t]*>`, 'i');
        }
        hasCloseInSpan = sRe.test(innerSlice);
      }
      if (hasCloseInSpan && !hasTrailingUnmatchedThinkClose(text, closeEnd, tag, options)) {
        return true;
      }
    }
  }
  return false;
}

function extractGapTextOutsideClosedFields(text, bodyStart, closedEnd, fuzzy) {
  const head = text.slice(bodyStart, closedEnd);
  if (!head.includes('始')) return head;

  const escSuffixRe = SCAN_ESC_SUFFIX_RE;
  const normOpenTailRe = fuzzy ? SCAN_NORM_TAIL_FUZZY_RE : SCAN_NORM_TAIL_STRICT_RE;
  const parts = [];
  let s = bodyStart;

  while (s < closedEnd) {
    SCAN_FIELD_OPEN_RE.lastIndex = s;
    const fm = SCAN_FIELD_OPEN_RE.exec(text);
    if (!fm || fm.index >= closedEnd) {
      parts.push(text.slice(s, closedEnd));
      break;
    }
    if (fm.index > s) {
      parts.push(text.slice(s, fm.index));
    }
    const afterStart = fm.index + fm[0].length;
    const openBracket = fm[1];

    escSuffixRe.lastIndex = afterStart;
    const escSuffixM = escSuffixRe.exec(text);
    if (escSuffixM) {
      const escCloseRe = fuzzy
        ? SCAN_ESC_CLOSE_ANY_RE
        : (openBracket === '「' && escSuffixM[1] === '」'
          ? SCAN_ESC_CLOSE_CJK_RE
          : (openBracket === '{' && escSuffixM[1] === '}' ? SCAN_ESC_CLOSE_BRACE_RE : SCAN_ESC_CLOSE_ANY_RE));
      escCloseRe.lastIndex = afterStart + escSuffixM[0].length;
      const cm = escCloseRe.exec(text);
      if (cm && cm.index + cm[0].length <= closedEnd) {
        parts.push('_');
        s = cm.index + cm[0].length;
        continue;
      }
      parts.push(text.slice(fm.index, closedEnd));
      break;
    }

    normOpenTailRe.lastIndex = afterStart;
    const normTailM = normOpenTailRe.exec(text);
    if (!normTailM || afterStart + normTailM[0].length > closedEnd) {
      parts.push(text.slice(fm.index, afterStart));
      s = afterStart;
      continue;
    }
    const isStrictClose = !fuzzy && openBracket === '「' && normTailM[0] === '」';
    const fieldCloseRe = isStrictClose ? SCAN_STRICT_FIELD_CLOSE_RE : (fuzzy ? SCAN_FUZZY_FIELD_CLOSE_FUZZY_RE : SCAN_FUZZY_FIELD_CLOSE_STRICT_RE);
    let fScan = afterStart + normTailM[0].length;
    let fieldCloseEnd = -1;
    while (fScan < closedEnd) {
      fieldCloseRe.lastIndex = fScan;
      const fCloseM = fieldCloseRe.exec(text);
      const closeIdx = fCloseM && fCloseM.index < closedEnd ? fCloseM.index : -1;
      SCAN_INNER_ESC_OPEN_RE.lastIndex = fScan;
      const innerEscOpenM = SCAN_INNER_ESC_OPEN_RE.exec(text);
      if (innerEscOpenM && innerEscOpenM.index < closedEnd && (closeIdx === -1 || innerEscOpenM.index < closeIdx)) {
        SCAN_INNER_ESC_CLOSE_RE.lastIndex = innerEscOpenM.index + innerEscOpenM[0].length;
        const innerEscCloseM = SCAN_INNER_ESC_CLOSE_RE.exec(text);
        if (innerEscCloseM && innerEscCloseM.index + innerEscCloseM[0].length <= closedEnd) {
          fScan = innerEscCloseM.index + innerEscCloseM[0].length;
          continue;
        }
      }
      if (closeIdx !== -1 && fCloseM.index + fCloseM[0].length <= closedEnd) {
        fieldCloseEnd = fCloseM.index + fCloseM[0].length;
      }
      break;
    }
    if (fieldCloseEnd !== -1) {
      parts.push('_');
      s = fieldCloseEnd;
    } else {
      parts.push(text.slice(fm.index, closedEnd));
      break;
    }
  }
  return parts.join('');
}

function findMonotonicRegexIdx(cacheObj, key, re, fromPos) {
  let idx = cacheObj[key];
  if (idx === undefined || (idx !== -1 && idx < fromPos)) {
    re.lastIndex = fromPos;
    const m = re.exec(cacheObj.text);
    idx = m ? m.index : -1;
    cacheObj[key] = idx;
  }
  return idx;
}

function doesCandidateCrossOuterContainer(text, toolStart, openLen, closedEnd, state, fuzzy, isEscapeWrapper = false, escapeGapCache = null) {
  const bodyStart = toolStart + openLen;
  if (bodyStart >= closedEnd) return false;

  if (isEscapeWrapper && escapeGapCache) {
    if (state.openInlineBtLen > 0) {
      let btLimit = closedEnd;
      const dNlIdx = findMonotonicRegexIdx(escapeGapCache, 'doubleNlIdx', GAP_DOUBLE_NL_GRE, bodyStart);
      if (dNlIdx !== -1 && dNlIdx < btLimit) btLimit = dNlIdx;
      const thCloseIdx = findMonotonicRegexIdx(escapeGapCache, 'thinkCloseLineIdx', GAP_THINK_CLOSE_LINE_GRE, bodyStart);
      if (thCloseIdx !== -1 && thCloseIdx < btLimit) btLimit = thCloseIdx;

      const targetLen = state.openInlineBtLen;
      let nextBt = escapeGapCache.nextBtByLen[targetLen];
      if (nextBt === undefined || (nextBt !== -1 && nextBt < bodyStart)) {
        let gScan = bodyStart;
        nextBt = -1;
        while (gScan < text.length) {
          const gBt = text.indexOf('`', gScan);
          if (gBt === -1) break;
          let gEnd = gBt;
          while (gEnd < text.length && text[gEnd] === '`') gEnd++;
          if (gEnd - gBt === targetLen && !(targetLen === 1 && isEmoticonBacktickAt(text, gBt))) {
            nextBt = gBt;
            break;
          }
          gScan = gEnd;
        }
        escapeGapCache.nextBtByLen[targetLen] = nextBt;
      }
      if (nextBt !== -1 && nextBt < btLimit) {
        return true;
      }
    }

    if (state.openPill) {
      const pillCloseIdx = findMonotonicRegexIdx(escapeGapCache, 'pillCloseIdx', GAP_PILL_CLOSE_GRE, bodyStart);
      if (pillCloseIdx !== -1 && pillCloseIdx < closedEnd) return true;
    }

    if (state.openVcpThink) {
      const vcpCloseIdx = findMonotonicRegexIdx(escapeGapCache, 'vcpCloseIdx', GAP_VCP_CLOSE_LINE_GRE, bodyStart);
      if (vcpCloseIdx !== -1 && vcpCloseIdx < closedEnd) return true;
    }

    for (const tag of ['pre', 'script', 'style']) {
      if (state.openHtmlDepth[tag] > 0) {
        const idx = findMonotonicRegexIdx(escapeGapCache, `html_${tag}`, GAP_HTML_CLOSE_GRES[tag], bodyStart);
        if (idx !== -1 && idx < closedEnd) return true;
      }
    }
    if (state.openHtmlDepth.code > 0) {
      let nlIdx = escapeGapCache.nlIdx;
      if (nlIdx === undefined || (nlIdx !== -1 && nlIdx < bodyStart)) {
        nlIdx = text.indexOf('\n', bodyStart);
        escapeGapCache.nlIdx = nlIdx;
      }
      const lineEnd = nlIdx === -1 ? closedEnd : Math.min(nlIdx, closedEnd);
      const codeCloseIdx = findMonotonicRegexIdx(escapeGapCache, 'html_code', GAP_HTML_CLOSE_GRES.code, bodyStart);
      if (codeCloseIdx !== -1 && codeCloseIdx < lineEnd) return true;
    }
    for (const tag of ['think', 'thinking', 'thought', 'thoughts', 'antthinking']) {
      if (state.openThinkDepth[tag] > 0) {
        const idx = findMonotonicRegexIdx(escapeGapCache, `think_${tag}`, GAP_THINK_CLOSE_GRES[tag], bodyStart);
        if (idx !== -1 && idx < closedEnd) return true;
      }
    }
    return false;
  }

  const gapText = isEscapeWrapper
    ? text.slice(bodyStart, closedEnd)
    : extractGapTextOutsideClosedFields(text, bodyStart, closedEnd, fuzzy);
  if (!gapText) return false;

  if (state.openInlineBtLen > 0 && gapText.includes('`')) {
    let btLimit = gapText.length;
    const dNl = GAP_DOUBLE_NL_RE.exec(gapText);
    if (dNl && dNl.index < btLimit) btLimit = dNl.index;
    const thClose = GAP_THINK_CLOSE_LINE_RE.exec(gapText);
    if (thClose && thClose.index < btLimit) btLimit = thClose.index;
    let gScan = 0;
    while (gScan < btLimit) {
      const gBt = gapText.indexOf('`', gScan);
      if (gBt === -1 || gBt >= btLimit) break;
      let gEnd = gBt;
      while (gEnd < gapText.length && gapText[gEnd] === '`') gEnd++;
      if (gEnd - gBt === state.openInlineBtLen &&
          !(state.openInlineBtLen === 1 && isEmoticonBacktickAt(gapText, gBt))) {
        return true;
      }
      gScan = gEnd;
    }
  }

  if (state.openPill && GAP_PILL_CLOSE_RE.test(gapText)) {
    return true;
  }

  if (state.openVcpThink && GAP_VCP_CLOSE_LINE_RE.test(gapText)) {
    return true;
  }

  if (gapText.includes('<')) {
    for (const tag of ['pre', 'script', 'style']) {
      if (state.openHtmlDepth[tag] > 0 && GAP_HTML_CLOSE_RES[tag].test(gapText)) {
        return true;
      }
    }
    if (state.openHtmlDepth.code > 0) {
      const nlIdx = gapText.indexOf('\n');
      const sameLine = nlIdx === -1 ? gapText : gapText.slice(0, nlIdx);
      if (GAP_HTML_CLOSE_RES.code.test(sameLine)) {
        return true;
      }
    }
    for (const tag of ['think', 'thinking', 'thought', 'thoughts', 'antthinking']) {
      if (state.openThinkDepth[tag] > 0 && GAP_THINK_CLOSE_RES[tag].test(gapText)) {
        return true;
      }
    }
  }

  return false;
}

function findPairedRoleWallRanges(text, opaqueRanges = null) {
  if (typeof text !== 'string' || !text.includes('<<<[ROLE_DIVIDE_') || !text.includes('<<<[END_ROLE_DIVIDE_')) {
    return [];
  }
  const stacksByRole = new Map();
  const rawPairs = [];
  ROLE_TAG_ANY_RE.lastIndex = 0;
  let m;
  while ((m = ROLE_TAG_ANY_RE.exec(text)) !== null) {
    if (opaqueRanges) {
      const hit = findEnclosingRange(m.index, opaqueRanges);
      if (hit) {
        ROLE_TAG_ANY_RE.lastIndex = hit.end;
        continue;
      }
    }
    const isEnd = Boolean(m[1]);
    const roleKey = m[2];
    if (!isEnd) {
      let st = stacksByRole.get(roleKey);
      if (!st) {
        st = [];
        stacksByRole.set(roleKey, st);
      }
      st.push(m.index);
    } else {
      const st = stacksByRole.get(roleKey);
      if (st && st.length > 0) {
        const start = st.pop();
        rawPairs.push({ start, end: m.index + m[0].length });
      }
    }
  }
  if (rawPairs.length === 0) return [];
  rawPairs.sort((a, b) => a.start - b.start || b.end - a.end);
  const outer = [];
  let lastEnd = -1;
  for (let i = 0; i < rawPairs.length; i++) {
    const r = rawPairs[i];
    if (r.start < lastEnd) continue;
    outer.push(r);
    lastEnd = r.end;
  }
  return outer;
}

function findClosedFenceAndToolRanges(text, options = {}) {
  const ranges = [];
  if (typeof text !== 'string') return ranges;
  const protectRoleDivider = Boolean(options.protectRoleDivider);
  const hasRoleWall = protectRoleDivider && text.includes('<<<[ROLE_DIVIDE_') && text.includes('<<<[END_ROLE_DIVIDE_');
  const hasFence = text.includes('```') || text.includes('~~~');
  const hasTool = /\[TOOL_REQUEST/i.test(text);
  if (!hasFence && !hasTool && !hasRoleWall) return ranges;

  const len = text.length;
  const fenceOpenRe = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)/gm;
  const fuzzy = resolveFuzzyMatching(options);
  const toolOpenRe = fuzzy ? /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi : /<<<\[TOOL_REQUEST(?:_ESCAPE)?\]>>>/g;
  const standaloneToolLineRe = fuzzy ? PROSE_STANDALONE_TOOL_FUZZY_RE : PROSE_STANDALONE_TOOL_STRICT_RE;

  let cachedFenceM;
  const findNextFence = (from) => {
    if (!hasFence) return null;
    if (cachedFenceM !== undefined && (cachedFenceM === null || cachedFenceM.index >= from)) {
      return cachedFenceM;
    }
    let searchPos = from;
    while (searchPos < len) {
      fenceOpenRe.lastIndex = searchPos;
      const m = fenceOpenRe.exec(text);
      if (!m) {
        cachedFenceM = null;
        return null;
      }
      const info = m[2] || '';
      if (m[1][0] === '`' && info.includes('`')) {
        const nl = text.indexOf('\n', m.index);
        searchPos = nl === -1 ? len : nl + 1;
        continue;
      }
      cachedFenceM = m;
      return m;
    }
    cachedFenceM = null;
    return null;
  };

  const hasVcpThinkInText = text.includes('[--- VCP元思考链');
  let proseCursor = 0;
  let proseLineWsOnly = true;
  let openInlineBtLen = 0;
  const openHtmlDepth = { pre: 0, script: 0, style: 0, code: 0 };
  let openPill = false;
  let openVcpThink = false;
  const openThinkDepth = { think: 0, thinking: 0, thought: 0, thoughts: 0, antthinking: 0 };
  const outerState = { openInlineBtLen: 0, openHtmlDepth, openPill: false, openVcpThink: false, openThinkDepth };
  let nextBtPos = text.indexOf('`');
  let nextLtPos = text.indexOf('<');
  let nextLbPos = text.indexOf('[');
  let nextCjkLbPos = text.indexOf('【');

  const hasAnyOpenOuterContainer = () => (
    openInlineBtLen > 0 ||
    openPill ||
    openVcpThink ||
    openHtmlDepth.pre > 0 ||
    openHtmlDepth.script > 0 ||
    openHtmlDepth.style > 0 ||
    openHtmlDepth.code > 0 ||
    openThinkDepth.think > 0 ||
    openThinkDepth.thinking > 0 ||
    openThinkDepth.thought > 0 ||
    openThinkDepth.thoughts > 0 ||
    openThinkDepth.antthinking > 0
  );

  const advanceProseTo = (targetEnd) => {
    while (proseCursor < targetEnd) {
      const nl = text.indexOf('\n', proseCursor);
      const hasCompleteLine = nl !== -1 && nl < targetEnd;
      const segEnd = hasCompleteLine ? nl : targetEnd;

      if (proseLineWsOnly && segEnd > proseCursor && (openInlineBtLen > 0 || openVcpThink || (hasCompleteLine && (hasFence || hasVcpThinkInText)))) {
        const lineEndNoCr = (segEnd > proseCursor && text[segEnd - 1] === '\r') ? segEnd - 1 : segEnd;
        const lineSlice = text.slice(proseCursor, lineEndNoCr);
        if (hasCompleteLine && /^[ \t]*$/.test(lineSlice)) {
          if (openInlineBtLen > 0) openInlineBtLen = 0;
          openHtmlDepth.code = 0;
          proseCursor = segEnd + 1;
          proseLineWsOnly = true;
          continue;
        }
        if (openInlineBtLen > 0 && PROSE_LINE_START_THINK_CLOSE_RE.test(lineSlice)) {
          openInlineBtLen = 0;
        }
        if (openVcpThink) {
          const vcpCloseM = PROSE_VCP_CLOSE_LINE_RE.exec(lineSlice);
          if (vcpCloseM) {
            openVcpThink = false;
            openHtmlDepth.code = 0;
            if (hasCompleteLine && /^[ \t\r]*$/.test(lineSlice.slice(vcpCloseM[0].length))) {
              proseCursor = segEnd + 1;
              proseLineWsOnly = true;
              continue;
            }
            proseCursor += vcpCloseM[0].length;
            proseLineWsOnly = false;
          }
        }
        if (hasCompleteLine && proseLineWsOnly) {
          if (openInlineBtLen === 0) {
            if (hasVcpThinkInText && PROSE_VCP_OPEN_LINE_RE.test(lineSlice)) {
              openVcpThink = true;
              openHtmlDepth.code = 0;
              proseCursor = segEnd + 1;
              proseLineWsOnly = true;
              continue;
            }
            if (hasFence) {
              const fenceLineM = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(lineSlice);
              if (fenceLineM && (fenceLineM[1][0] === '~' || !(fenceLineM[2] || '').includes('`'))) {
                openHtmlDepth.code = 0;
                proseCursor = segEnd + 1;
                proseLineWsOnly = true;
                continue;
              }
            }
          } else if (openInlineBtLen <= 2) {
            const tLineM = standaloneToolLineRe.exec(lineSlice);
            if (tLineM) {
              const markerAbs = proseCursor + tLineM[1].length;
              if (!hasAdjacentAngle(text, markerAbs, tLineM[2].length) &&
                  !isQuotedSingleToolMarker(text, markerAbs, tLineM[2].length)) {
                openInlineBtLen = 0;
              }
            }
          }
        }
      }

      let p = proseCursor;
      while (p < segEnd) {
        if (openInlineBtLen > 0) {
          if (nextBtPos !== -1 && nextBtPos < p) nextBtPos = text.indexOf('`', p);
          const bt = nextBtPos;
          if (bt === -1 || bt >= segEnd) {
            if (proseLineWsOnly && !/^[ \t\r]*$/.test(text.slice(p, segEnd))) proseLineWsOnly = false;
            p = segEnd;
            break;
          }
          if (proseLineWsOnly && bt > p && !/^[ \t\r]*$/.test(text.slice(p, bt))) proseLineWsOnly = false;
          let rEnd = bt;
          while (rEnd < segEnd && text[rEnd] === '`') rEnd++;
          const rLen = rEnd - bt;
          if (!(rLen === 1 && isEmoticonBacktickAt(text, bt)) && rLen === openInlineBtLen) {
            openInlineBtLen = 0;
          }
          proseLineWsOnly = false;
          p = rEnd;
          continue;
        }

        if (nextBtPos !== -1 && nextBtPos < p) nextBtPos = text.indexOf('`', p);
        if (nextLtPos !== -1 && nextLtPos < p) nextLtPos = text.indexOf('<', p);
        if (nextLbPos !== -1 && nextLbPos < p) nextLbPos = text.indexOf('[', p);
        if (nextCjkLbPos !== -1 && nextCjkLbPos < p) nextCjkLbPos = text.indexOf('【', p);
        const nBt = nextBtPos;
        const nLt = nextLtPos;
        const nLb = nextLbPos;
        const nCjkLb = nextCjkLbPos;
        let tokPos = segEnd;
        let tokType = 0;
        if (nBt !== -1 && nBt < tokPos) { tokPos = nBt; tokType = 1; }
        if (nLt !== -1 && nLt < tokPos) { tokPos = nLt; tokType = 2; }
        if (nLb !== -1 && nLb < tokPos) { tokPos = nLb; tokType = 3; }
        if (nCjkLb !== -1 && nCjkLb < tokPos) { tokPos = nCjkLb; tokType = 4; }

        if (tokType === 0) {
          if (proseLineWsOnly && !/^[ \t\r]*$/.test(text.slice(p, segEnd))) proseLineWsOnly = false;
          p = segEnd;
          break;
        }
        if (proseLineWsOnly && tokPos > p && !/^[ \t\r]*$/.test(text.slice(p, tokPos))) {
          proseLineWsOnly = false;
        }

        if (tokType === 1) {
          let rEnd = tokPos;
          while (rEnd < segEnd && text[rEnd] === '`') rEnd++;
          const rLen = rEnd - tokPos;
          if (!(rLen === 1 && isEmoticonBacktickAt(text, tokPos))) {
            openInlineBtLen = rLen;
          }
          proseLineWsOnly = false;
          p = rEnd;
          continue;
        }

        if (tokType === 2) {
          proseLineWsOnly = false;
          if (tokPos + 1 < segEnd && text[tokPos + 1] === '<') {
            p = tokPos + 1;
            continue;
          }
          PROSE_HTML_CLOSE_YRE.lastIndex = tokPos;
          const hCloseM = PROSE_HTML_CLOSE_YRE.exec(text);
          if (hCloseM && hCloseM.index + hCloseM[0].length <= segEnd) {
            const hTag = hCloseM[1].toLowerCase();
            if (openHtmlDepth[hTag] > 0) openHtmlDepth[hTag] -= 1;
            p = hCloseM.index + hCloseM[0].length;
            continue;
          }
          PROSE_HTML_BLOCK_OPEN_YRE.lastIndex = tokPos;
          const hOpenM = PROSE_HTML_BLOCK_OPEN_YRE.exec(text);
          if (hOpenM && hOpenM.index + hOpenM[0].length <= segEnd) {
            const hTag = hOpenM[1].toLowerCase();
            openHtmlDepth[hTag] += 1;
            p = hOpenM.index + hOpenM[0].length;
            continue;
          }
          PROSE_CODE_OPEN_YRE.lastIndex = tokPos;
          const cOpenM = PROSE_CODE_OPEN_YRE.exec(text);
          if (cOpenM && cOpenM.index + cOpenM[0].length <= segEnd) {
            openHtmlDepth.code += 1;
            p = cOpenM.index + cOpenM[0].length;
            continue;
          }
          if (!openVcpThink) {
            PROSE_THINK_TAG_YRE.lastIndex = tokPos;
            const tTagM = PROSE_THINK_TAG_YRE.exec(text);
            if (tTagM && tTagM.index + tTagM[0].length <= segEnd) {
              const tName = tTagM[2].toLowerCase();
              if (tTagM[1] === '/') {
                if (openThinkDepth[tName] > 0) openThinkDepth[tName] -= 1;
              } else {
                openThinkDepth[tName] += 1;
              }
              p = tTagM.index + tTagM[0].length;
              continue;
            }
          }
          p = tokPos + 1;
          continue;
        }

        proseLineWsOnly = false;
        PROSE_PILL_OPEN_YRE.lastIndex = tokPos;
        const pOpenM = PROSE_PILL_OPEN_YRE.exec(text);
        if (pOpenM && pOpenM.index + pOpenM[0].length <= segEnd) {
          openPill = true;
          p = pOpenM.index + pOpenM[0].length;
          continue;
        }
        PROSE_PILL_CLOSE_YRE.lastIndex = tokPos;
        const pCloseM = PROSE_PILL_CLOSE_YRE.exec(text);
        if (pCloseM && pCloseM.index + pCloseM[0].length <= segEnd) {
          openPill = false;
          p = pCloseM.index + pCloseM[0].length;
          continue;
        }
        p = tokPos + 1;
      }

      if (hasCompleteLine) {
        openHtmlDepth.code = 0;
        proseCursor = segEnd + 1;
        proseLineWsOnly = true;
      } else {
        proseCursor = segEnd;
      }
    }
  };

  const skipAcceptedRangeInProse = (start, end, breaksInlineBt = false) => {
    advanceProseTo(start);
    if (breaksInlineBt && openInlineBtLen > 0) {
      openInlineBtLen = 0;
    }
    if (end > proseCursor) {
      const nlInRange = text.indexOf('\n', proseCursor);
      if (nlInRange !== -1 && nlInRange < end) {
        openHtmlDepth.code = 0;
      }
      proseCursor = end;
      let ls = proseCursor - 1;
      proseLineWsOnly = true;
      while (ls >= 0 && text[ls] !== '\n') {
        if (text[ls] !== ' ' && text[ls] !== '\t') {
          proseLineWsOnly = false;
          break;
        }
        ls--;
      }
    }
  };

  const opaqueRanges = Array.isArray(options.opaqueRanges) ? options.opaqueRanges : null;
  const opaqueLen = opaqueRanges ? opaqueRanges.length : 0;
  const pairedRoleWalls = hasRoleWall ? findPairedRoleWallRanges(text, options.roleWallMask || opaqueRanges) : [];
  const roleWallLen = pairedRoleWalls.length;
  let escWallRanges = opaqueRanges;
  if (protectRoleDivider && roleWallLen > 0) {
    const mergedRaw = [];
    if (opaqueRanges) {
      for (let i = 0; i < opaqueLen; i++) mergedRaw.push({ start: opaqueRanges[i].start, end: opaqueRanges[i].end });
    }
    for (let i = 0; i < roleWallLen; i++) mergedRaw.push({ start: pairedRoleWalls[i].start, end: pairedRoleWalls[i].end });
    escWallRanges = buildSortedMergedAreas(mergedRaw);
  }
  let opaqueIdx = 0;
  let roleIdx = 0;
  let pos = 0;
  const toolHints = {};
  const noFenceCloseCache = {};
  let cachedFenceDoubleNlIdx = -2;
  const btPositionsByLen = new Map();
  const countInlineBtRunsInRange = (targetLen, startPos, endPos) => {
    let positions = btPositionsByLen.get(targetLen);
    if (!positions) {
      positions = [];
      let scan = 0;
      while (scan < len) {
        const bt = text.indexOf('`', scan);
        if (bt === -1) break;
        let rEnd = bt;
        while (rEnd < len && text[rEnd] === '`') rEnd++;
        if (rEnd - bt === targetLen && !(targetLen === 1 && isEmoticonBacktickAt(text, bt))) {
          positions.push(bt);
        }
        scan = rEnd;
      }
      btPositionsByLen.set(targetLen, positions);
    }
    const lowerBound = (x) => {
      let lo = 0;
      let hi = positions.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (positions[mid] < x) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    return lowerBound(endPos) - lowerBound(startPos);
  };
  const toolScanOpts = { ...options, opaqueRanges: escWallRanges, isEscapeWrapper: false };
  const escScanOpts = { ...options, opaqueRanges: escWallRanges, isEscapeWrapper: true };
  let escapeGapCache = null;
  while (pos < len) {
    while (opaqueIdx < opaqueLen && opaqueRanges[opaqueIdx].start < pos) {
      opaqueIdx++;
    }
    while (roleIdx < roleWallLen && pairedRoleWalls[roleIdx].start < pos) {
      roleIdx++;
    }
    const nextOpaque = opaqueIdx < opaqueLen ? opaqueRanges[opaqueIdx] : null;
    const nextRoleWall = roleIdx < roleWallLen ? pairedRoleWalls[roleIdx] : null;
    const fenceM = findNextFence(pos);
    const toolM = hasTool ? execValidToolMarker(toolOpenRe, text, pos, toolHints, 'outerToolOpen') : null;
    if (!nextOpaque && !nextRoleWall && !fenceM && !toolM) break;

    const opStart = nextOpaque ? nextOpaque.start : Infinity;
    const rStart = nextRoleWall ? nextRoleWall.start : Infinity;
    const fStart = fenceM ? fenceM.index : Infinity;
    const tStart = toolM ? toolM.index : Infinity;

    if (opStart <= rStart && opStart <= fStart && opStart <= tStart) {
      const opEnd = Math.max(pos + 1, nextOpaque.end);
      skipAcceptedRangeInProse(nextOpaque.start, opEnd, true);
      pos = opEnd;
      opaqueIdx++;
    } else if (rStart <= fStart && rStart <= tStart) {
      const rEnd = Math.max(pos + 1, nextRoleWall.end);
      ranges.push({ kind: 'role_wall', start: nextRoleWall.start, end: rEnd });
      skipAcceptedRangeInProse(nextRoleWall.start, rEnd, true);
      pos = rEnd;
      roleIdx++;
    } else if (fStart <= tStart) {
      const openNl = text.indexOf('\n', fenceM.index);
      const closeEnd = findClosedFenceLineEnd(text, openNl, fenceM[1][0], fenceM[1].length, noFenceCloseCache, opaqueRanges);
      if (closeEnd !== -1) {
        advanceProseTo(fenceM.index);
        if (openInlineBtLen > 0) {
          const fenceMarkerEnd = fenceM.index + fenceM[0].length - (fenceM[2] ? fenceM[2].length : 0);
          let btLimit = closeEnd;
          if (cachedFenceDoubleNlIdx === -2 || (cachedFenceDoubleNlIdx !== -1 && cachedFenceDoubleNlIdx < fenceMarkerEnd)) {
            GAP_DOUBLE_NL_GRE.lastIndex = fenceMarkerEnd;
            const dNlM = GAP_DOUBLE_NL_GRE.exec(text);
            cachedFenceDoubleNlIdx = dNlM ? dNlM.index : -1;
          }
          if (cachedFenceDoubleNlIdx !== -1 && cachedFenceDoubleNlIdx < btLimit) {
            btLimit = cachedFenceDoubleNlIdx;
          }
          const btCount = countInlineBtRunsInRange(openInlineBtLen, fenceMarkerEnd, btLimit);
          if ((btCount & 1) === 1) {
            pos = openNl === -1 ? len : openNl + 1;
            continue;
          }
        }
        if (isCrossUnclosedThinkSpan(text, openNl === -1 ? len : openNl + 1, closeEnd, openVcpThink, openThinkDepth, { opaqueRanges, fuzzy })) {
          pos = openNl === -1 ? len : openNl + 1;
          continue;
        }
        ranges.push({ kind: 'fence', start: fenceM.index, end: closeEnd });
        skipAcceptedRangeInProse(fenceM.index, closeEnd, true);
        const afterCloseNl = text.indexOf('\n', closeEnd);
        pos = afterCloseNl === -1 ? len : afterCloseNl + 1;
      } else {
        pos = openNl === -1 ? len : openNl + 1;
      }
    } else {
      const isEscapeWrapper = /_ESCAPE\]/i.test(toolM[0]);
      const closedEnd = scanClosedToolBlockEnd(text, toolM.index + toolM[0].length, toolHints, isEscapeWrapper ? escScanOpts : toolScanOpts);
      if (closedEnd > 0) {
        advanceProseTo(toolM.index);
        if (!isEscapeWrapper && openInlineBtLen > 0 && openInlineBtLen <= 2 && proseLineWsOnly &&
            isTrailingLineWs(text, toolM.index + toolM[0].length)) {
          openInlineBtLen = 0;
        }
        if (hasAnyOpenOuterContainer()) {
          outerState.openInlineBtLen = openInlineBtLen;
          outerState.openPill = openPill;
          outerState.openVcpThink = openVcpThink;
          if (isEscapeWrapper && !escapeGapCache) {
            escapeGapCache = { text, nextBtByLen: Object.create(null) };
          }
          if (doesCandidateCrossOuterContainer(text, toolM.index, toolM[0].length, closedEnd, outerState, fuzzy, isEscapeWrapper, isEscapeWrapper ? escapeGapCache : null)) {
            pos = toolM.index + toolM[0].length;
            continue;
          }
        }
        ranges.push({ kind: isEscapeWrapper ? 'tool_escape' : 'tool', start: toolM.index, end: closedEnd });
        skipAcceptedRangeInProse(toolM.index, closedEnd);
        pos = closedEnd;
      } else {
        pos = toolM.index + toolM[0].length;
      }
    }
  }
  return ranges;
}

function findEnclosingRange(pos, ranges) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const r = ranges[mid];
    if (pos < r.start) {
      hi = mid - 1;
    } else if (pos >= r.end) {
      lo = mid + 1;
    } else {
      return r;
    }
  }
  return null;
}

function buildSortedMergedAreas(areas) {
  if (!areas.length) return [];
  const sorted = [...areas].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i];
    const prev = merged[merged.length - 1];
    if (a.start < prev.end || (a.start === prev.end && a.type === prev.type)) {
      if (a.end > prev.end) prev.end = a.end;
      if (prev.type === 'INLINE_CODE' && a.type !== 'INLINE_CODE') {
        prev.type = a.type;
      }
    } else {
      merged.push({ ...a });
    }
  }
  return merged;
}

function isPosInSortedAreas(sortedAreas, pos) {
  return findEnclosingRange(pos, sortedAreas) !== null;
}

function clampAreaEndToTool(start, end, closedToolRanges) {
  const tool = findEnclosingRange(start, closedToolRanges);
  return tool && end > tool.end ? tool.end : end;
}

function filterCrossFenceVcpInfoRanges(text, vcpInfoRanges, precomputedPlainFences = null) {
  if (!Array.isArray(vcpInfoRanges) || vcpInfoRanges.length === 0) return vcpInfoRanges || [];
  if (typeof text !== "string" || (!text.includes("```") && !text.includes("~~~"))) return vcpInfoRanges;
  const plainFences = precomputedPlainFences || findClosedMarkdownFenceRanges(text);
  if (!plainFences || plainFences.length === 0) return vcpInfoRanges;
  return vcpInfoRanges.filter((r) => {
    const startFence = findEnclosingRange(r.start, plainFences);
    if (!startFence || r.end <= startFence.end) return true;
    const endFence = findEnclosingRange(r.end - 1, plainFences);
    return !(endFence && endFence.start !== startFence.start);
  });
}

function findProtectionAreas(text, options = {}) {
  const areas = [];
  if (typeof text !== 'string' || !text) return areas;
  const len = text.length;

  const fuzzy = resolveFuzzyMatching(options);
  let m;

  const vcpInfoRanges = findNestedVcpInfoRanges(text);
  let filteredVcpInfoRanges = vcpInfoRanges;
  let safePlainFences = [];
  if (text.includes('```') || text.includes('~~~')) {
    const plainFences = findClosedMarkdownFenceRanges(text);
    if (plainFences.length > 0) {
      if (vcpInfoRanges.length > 0) {
        filteredVcpInfoRanges = filterCrossFenceVcpInfoRanges(text, vcpInfoRanges, plainFences);
        let vIdx = 0;
        for (let fi = 0; fi < plainFences.length; fi++) {
          const f = plainFences[fi];
          while (vIdx < filteredVcpInfoRanges.length && filteredVcpInfoRanges[vIdx].end <= f.start) {
            vIdx++;
          }
          if (vIdx < filteredVcpInfoRanges.length && filteredVcpInfoRanges[vIdx].start < f.end) {
            continue;
          }
          safePlainFences.push(f);
        }
      } else {
        safePlainFences = plainFences;
      }
    }
  }
  const preRoleBatchRaw = [];
  for (const r of filteredVcpInfoRanges) preRoleBatchRaw.push({ start: r.start, end: r.end, type: 'VCP_INFO' });
  for (const f of safePlainFences) preRoleBatchRaw.push({ start: f.start, end: f.end, type: 'FENCE' });
  const preRoleBatchMask = preRoleBatchRaw.length > 0 ? buildSortedMergedAreas(preRoleBatchRaw) : null;


  const batchRaw = [];
  if (text.includes('<<<[VCP_TOOL_BATCH_START:') && text.includes('<<<[VCP_TOOL_BATCH_END:')) {
    const B_START = '<<<[VCP_TOOL_BATCH_START:';
    const B_END = '<<<[VCP_TOOL_BATCH_END:';
    const endPosById = new Map();
    let lastValidEndStart = -1;
    let eScan = 0;
    while (eScan < len) {
      const bClose = text.indexOf(B_END, eScan);
      if (bClose === -1) break;
      if (preRoleBatchMask) {
        const hitClose = findEnclosingRange(bClose, preRoleBatchMask);
        if (hitClose) {
          eScan = hitClose.end;
          continue;
        }
      }
      const closeInnerStart = bClose + B_END.length;
      const closeRb = text.indexOf(']>>>', closeInnerStart);
      if (closeRb === -1) break;
      const closeInner = text.indexOf(']', closeInnerStart);
      if (closeInner !== closeRb || closeRb === closeInnerStart) {
        eScan = closeInnerStart;
        continue;
      }
      const id = text.slice(closeInnerStart, closeRb);
      let arr = endPosById.get(id);
      if (!arr) {
        arr = [];
        endPosById.set(id, arr);
      }
      arr.push({ start: bClose, end: closeRb + 4 });
      lastValidEndStart = bClose;
      eScan = closeRb + 4;
    }

    if (lastValidEndStart !== -1) {
      const endCursorById = new Map();
      let bScan = 0;
      while (bScan <= lastValidEndStart) {
        const bOpen = text.indexOf(B_START, bScan);
        if (bOpen === -1 || bOpen > lastValidEndStart) break;
        if (preRoleBatchMask) {
          const hitOpen = findEnclosingRange(bOpen, preRoleBatchMask);
          if (hitOpen) {
            bScan = hitOpen.end;
            continue;
          }
        }
        const openInnerStart = bOpen + B_START.length;
        const openRb = text.indexOf(']>>>', openInnerStart);
        if (openRb === -1 || openRb > lastValidEndStart) break;
        const openInnerClose = text.indexOf(']', openInnerStart);
        if (openInnerClose !== openRb || openRb === openInnerStart) {
          bScan = openInnerStart;
          continue;
        }
        const openId = text.slice(openInnerStart, openRb);
        const afterOpen = openRb + 4;
        const endList = endPosById.get(openId);
        let matchedEnd = -1;
        if (endList) {
          let eIdx = endCursorById.get(openId) || 0;
          while (eIdx < endList.length && endList[eIdx].start < afterOpen) {
            eIdx++;
          }
          endCursorById.set(openId, eIdx);
          if (eIdx < endList.length) {
            matchedEnd = endList[eIdx].end;
            endCursorById.set(openId, eIdx + 1);
          }
        }
        if (matchedEnd === -1) {
          bScan = afterOpen;
          continue;
        }
        batchRaw.push({ start: bOpen, end: matchedEnd, type: 'BATCH' });
        bScan = matchedEnd;
      }
    }
  }

  const opaqueRaw = [];
  for (const r of filteredVcpInfoRanges) opaqueRaw.push({ start: r.start, end: r.end, type: 'VCP_INFO' });
  for (const r of batchRaw) opaqueRaw.push(r);
  const opaqueRanges = opaqueRaw.length > 0 ? buildSortedMergedAreas(opaqueRaw) : null;

  const fenceAndToolRanges = findClosedFenceAndToolRanges(text, {
    fuzzyToolMatching: fuzzy,
    opaqueRanges,
    roleWallMask: preRoleBatchMask,
    protectRoleDivider: Boolean(options.protectRoleDivider)
  });
  const closedToolRanges = fenceAndToolRanges.filter(r => r.kind === 'tool');
  const closedToolEscapeRanges = fenceAndToolRanges.filter(r => r.kind === 'tool_escape');
  const closedFenceRanges = fenceAndToolRanges.filter(r => r.kind === 'fence');
  const closedRoleWallRanges = fenceAndToolRanges.filter(r => r.kind === 'role_wall');

  if (typeof options.headlessLeakCutEnd === 'number' && options.headlessLeakCutEnd > 0) {
    areas.push({ start: 0, end: Math.min(len, options.headlessLeakCutEnd), type: 'HEADLESS_THINK' });
  }

  for (const r of closedToolEscapeRanges) {
    areas.push({ start: r.start, end: r.end, type: 'TOOL_ESCAPE' });
  }

  for (const r of closedRoleWallRanges) {
    areas.push({ start: r.start, end: r.end, type: 'ROLE_WALL' });
  }

  for (const r of vcpInfoRanges) {
    if (findEnclosingRange(r.start, closedFenceRanges)) continue;
    const enclosingTool = findEnclosingRange(r.start, closedToolRanges);
    if (enclosingTool) continue;
    areas.push({ start: r.start, end: r.end, type: 'VCP_INFO' });
  }

  for (const r of batchRaw) {
    const enclosingTool = findEnclosingRange(r.start, closedToolRanges);
    if (enclosingTool && enclosingTool.end >= r.end) continue;
    areas.push({ start: r.start, end: clampAreaEndToTool(r.start, r.end, closedToolRanges), type: 'BATCH' });
  }

  const preFenceAreas = buildSortedMergedAreas(areas);
  const fenceAreas = [];
  for (const f of closedFenceRanges) {
    const hit = findEnclosingRange(f.start, preFenceAreas);
    if (hit && f.end > hit.end) continue;
    const area = { start: f.start, end: f.end, type: 'FENCE' };
    areas.push(area);
    fenceAreas.push(area);
  }

  const preMetaAreas = buildSortedMergedAreas(areas);

  if (text.includes('[系统提示:]') && text.includes('VCP')) {
    const pillOpenRe = /[ \t]*\[系统提示:\]\s*[【\[]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]]/g;
    const pillCloseRe = /[【\[]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]][ \t]*/g;
    let pOpenM;
    let cachedPCloseM;
    while ((pOpenM = pillOpenRe.exec(text)) !== null) {
      const openTool = findEnclosingRange(pOpenM.index, closedToolRanges);
      if (openTool) {
        pillOpenRe.lastIndex = openTool.end;
        continue;
      }
      if (isPosInSortedAreas(preMetaAreas, pOpenM.index)) continue;
      const afterOpen = pOpenM.index + pOpenM[0].length;
      if (cachedPCloseM === undefined || (cachedPCloseM !== null && cachedPCloseM.index < afterOpen)) {
        pillCloseRe.lastIndex = afterOpen;
        let pm;
        while ((pm = pillCloseRe.exec(text)) !== null &&
            (isPosInSortedAreas(preMetaAreas, pm.index) || Boolean(findEnclosingRange(pm.index, closedToolRanges)))) {
          // skip closing tags inside preMetaAreas or closedToolRanges
        }
        cachedPCloseM = pm;
      }
      if (!cachedPCloseM) break;
      const endPos = cachedPCloseM.index + cachedPCloseM[0].length;
      areas.push({ start: pOpenM.index, end: clampAreaEndToTool(pOpenM.index, endPos, closedToolRanges), type: 'PILL' });
      pillOpenRe.lastIndex = endPos;
    }
  }

  if (text.includes('[[VCP桌面推送通知:') && text.includes(']]')) {
    const PUSH_START = '[[VCP桌面推送通知:';
    const lastPushEnd = text.lastIndexOf(']]');
    let pScan = 0;
    while (pScan <= lastPushEnd) {
      const pOpen = text.indexOf(PUSH_START, pScan);
      if (pOpen === -1 || pOpen > lastPushEnd) break;
      const openTool = findEnclosingRange(pOpen, closedToolRanges);
      if (openTool) {
        pScan = openTool.end;
        continue;
      }
      const openProt = findEnclosingRange(pOpen, preMetaAreas);
      if (openProt) {
        pScan = openProt.end;
        continue;
      }
      let closeSearch = pOpen + PUSH_START.length;
      let pClose = -1;
      while (closeSearch <= lastPushEnd) {
        const cand = text.indexOf(']]', closeSearch);
        if (cand === -1) break;
        const closeTool = findEnclosingRange(cand, closedToolRanges);
        if (closeTool) {
          closeSearch = closeTool.end;
          continue;
        }
        const closeProt = findEnclosingRange(cand, preMetaAreas);
        if (closeProt) {
          closeSearch = closeProt.end;
          continue;
        }
        pClose = cand;
        break;
      }
      if (pClose === -1) break;
      const endPos = pClose + 2;
      areas.push({ start: pOpen, end: clampAreaEndToTool(pOpen, endPos, closedToolRanges), type: 'PUSH' });
      pScan = endPos;
    }
  }

  if (text.includes('[OneRing通知:') && text.includes(']')) {
    const OR_START = '[OneRing通知:';
    const lastRb = text.lastIndexOf(']');
    let oScan = 0;
    while (oScan <= lastRb) {
      const oOpen = text.indexOf(OR_START, oScan);
      if (oOpen === -1 || oOpen > lastRb) break;
      const openTool = findEnclosingRange(oOpen, closedToolRanges);
      if (openTool) {
        oScan = openTool.end;
        continue;
      }
      const openProt = findEnclosingRange(oOpen, preMetaAreas);
      if (openProt) {
        oScan = openProt.end;
        continue;
      }
      let closeSearch = oOpen + OR_START.length;
      let oClose = -1;
      while (closeSearch <= lastRb) {
        const cand = text.indexOf(']', closeSearch);
        if (cand === -1) break;
        const closeTool = findEnclosingRange(cand, closedToolRanges);
        if (closeTool) {
          closeSearch = closeTool.end;
          continue;
        }
        const closeProt = findEnclosingRange(cand, preMetaAreas);
        if (closeProt) {
          closeSearch = closeProt.end;
          continue;
        }
        oClose = cand;
        break;
      }
      if (oClose === -1) break;
      const endPos = oClose + 1;
      areas.push({ start: oOpen, end: clampAreaEndToTool(oOpen, endPos, closedToolRanges), type: 'ONERING_NOTICE' });
      oScan = endPos;
    }
  }

  const hasThinkTagOrVcp =
    (text.includes('<') && /<[ \t]*(?:think(?:ing)?|thought(?:s)?|antthinking)(?=[ \t>])/i.test(text)) ||
    text.includes('[--- VCP元思考链');
  const preInlineAreas = buildSortedMergedAreas(areas);
  const inlineThinkTracker = (hasThinkTagOrVcp && text.includes('`'))
    ? createMonotonicThinkTracker(text, buildSortedMergedAreas([...preInlineAreas, ...closedToolRanges]))
    : null;
  const blockPreInlineAreas = preInlineAreas.filter(
    a => a.type === 'HEADLESS_THINK' || a.type === 'ROLE_WALL' || a.type === 'VCP_INFO' || a.type === 'BATCH' || a.type === 'FENCE'
  );
  let blockPreIdx = 0;
  const doubleNlRe = /\r?\n[ \t]*\r?\n/g;
  const lineStartThinkCloseRe = /\n[ \t]*(?:<[ \t]*\/[ \t]*(?:think(?:ing)?|thought(?:s)?|antthinking)[ \t]*>|\[--- 元思考链结束 ---\])/gi;
  const standaloneToolOpenLineRe = fuzzy
    ? /\n([ \t]*)(<{2,4}\[TOOL_REQUEST\]>{2,4})[ \t]*(?=\r?\n|$)/gi
    : /\n([ \t]*)(<<<\[TOOL_REQUEST\]>>>)[ \t]*(?=\r?\n|$)/g;
  let cachedDoubleNlIdx = -2;
  let cachedThinkCloseLineIdx = -2;
  let cachedToolOpenLineIdx = -2;
  let btCursor = 0;
  while (btCursor < len) {
    const nextBt = text.indexOf('`', btCursor);
    if (nextBt === -1) break;
    const hitPre = findEnclosingRange(nextBt, preInlineAreas);
    if (hitPre) {
      btCursor = hitPre.end;
      continue;
    }
    const hitTool = findEnclosingRange(nextBt, closedToolRanges);
    if (hitTool) {
      btCursor = hitTool.end;
      continue;
    }
    let runEnd = nextBt;
    while (runEnd < len && text[runEnd] === '`') runEnd++;
    const runLen = runEnd - nextBt;
    if (runLen >= 3) {
      let ls = nextBt - 1;
      let isLineStartFence = true;
      while (ls >= 0) {
        const c = text[ls];
        if (c === '\n') break;
        if (c !== ' ' && c !== '\t') {
          isLineStartFence = false;
          break;
        }
        ls--;
      }
      if (isLineStartFence && nextBt - (ls + 1) <= 3) {
        const nlIdx = text.indexOf('\n', runEnd);
        const lineEnd = nlIdx === -1 ? len : nlIdx;
        const nextBtOnLine = text.indexOf('`', runEnd);
        if (nextBtOnLine === -1 || nextBtOnLine >= lineEnd) {
          btCursor = runEnd;
          continue;
        }
      }
    }
    if (runLen === 1 && isEmoticonBacktickAt(text, nextBt)) {
      btCursor = nextBt + 1;
      continue;
    }
    const contentStart = runEnd;
    if (cachedDoubleNlIdx === -2 || (cachedDoubleNlIdx !== -1 && cachedDoubleNlIdx < contentStart)) {
      doubleNlRe.lastIndex = contentStart;
      const dM = doubleNlRe.exec(text);
      cachedDoubleNlIdx = dM ? dM.index : -1;
    }
    if (cachedThinkCloseLineIdx === -2 || (cachedThinkCloseLineIdx !== -1 && cachedThinkCloseLineIdx < contentStart)) {
      lineStartThinkCloseRe.lastIndex = contentStart;
      const tCloseM = lineStartThinkCloseRe.exec(text);
      cachedThinkCloseLineIdx = tCloseM ? tCloseM.index : -1;
    }
    if (runLen <= 2 && (cachedToolOpenLineIdx === -2 || (cachedToolOpenLineIdx !== -1 && cachedToolOpenLineIdx < contentStart))) {
      standaloneToolOpenLineRe.lastIndex = contentStart;
      let tOpenM;
      while ((tOpenM = standaloneToolOpenLineRe.exec(text)) !== null) {
        const markerStart = tOpenM.index + 1 + tOpenM[1].length;
        if (!hasAdjacentAngle(text, markerStart, tOpenM[2].length) &&
            !isQuotedSingleToolMarker(text, markerStart, tOpenM[2].length)) {
          break;
        }
      }
      cachedToolOpenLineIdx = tOpenM ? tOpenM.index : -1;
    }
    while (blockPreIdx < blockPreInlineAreas.length && blockPreInlineAreas[blockPreIdx].end <= contentStart) {
      blockPreIdx++;
    }
    let limit = len;
    if (cachedDoubleNlIdx !== -1 && cachedDoubleNlIdx < limit) limit = cachedDoubleNlIdx;
    if (cachedThinkCloseLineIdx !== -1 && cachedThinkCloseLineIdx < limit) limit = cachedThinkCloseLineIdx;
    if (runLen <= 2 && cachedToolOpenLineIdx !== -1 && cachedToolOpenLineIdx < limit) limit = cachedToolOpenLineIdx;
    if (blockPreIdx < blockPreInlineAreas.length && blockPreInlineAreas[blockPreIdx].start < limit) {
      limit = blockPreInlineAreas[blockPreIdx].start;
    }
    let scan = contentStart;
    let inlineEnd = -1;
    while (scan < limit) {
      const cBt = text.indexOf('`', scan);
      if (cBt === -1 || cBt >= limit) break;
      const hitClosedTool = findEnclosingRange(cBt, closedToolRanges);
      if (hitClosedTool) {
        scan = hitClosedTool.end;
        continue;
      }
      const hitPreClose = findEnclosingRange(cBt, preInlineAreas);
      if (hitPreClose) {
        scan = hitPreClose.end;
        continue;
      }
      let cEnd = cBt;
      while (cEnd < len && text[cEnd] === '`') cEnd++;
      if (cEnd - cBt === runLen && !(runLen === 1 && isEmoticonBacktickAt(text, cBt))) {
        inlineEnd = cEnd;
        break;
      }
      scan = cEnd;
    }
    if (inlineEnd !== -1) {
      const clampedEnd = clampAreaEndToTool(nextBt, inlineEnd, closedToolRanges);
      if (inlineThinkTracker) {
        inlineThinkTracker.advanceTo(nextBt);
        if (isCrossUnclosedThinkSpan(text, contentStart, clampedEnd, inlineThinkTracker.openVcpThink, inlineThinkTracker.openThinkDepth, { opaqueRanges, fuzzy, inlineCloseLen: clampedEnd === inlineEnd ? runLen : 0 })) {
          btCursor = runEnd;
          continue;
        }
        inlineThinkTracker.skipTo(clampedEnd);
      }
      areas.push({ start: nextBt, end: clampedEnd, type: 'INLINE_CODE' });
      btCursor = clampedEnd;
    } else {
      btCursor = runEnd;
    }
  }

  if (text.includes('</')) {
    const preHtmlAreas = buildSortedMergedAreas(areas);
    const htmlOpenRe = /<(pre|script|style)(?=[ \t\r\n>])[^><]*>/gi;
    const cachedHtmlClose = Object.create(null);
    const closeReByTag = {
      pre: /<\/pre\s*>/gi,
      script: /<\/script\s*>/gi,
      style: /<\/style\s*>/gi
    };
    const htmlThinkTracker = hasThinkTagOrVcp
      ? createMonotonicThinkTracker(text, buildSortedMergedAreas([...preHtmlAreas, ...closedToolRanges]))
      : null;
    while ((m = htmlOpenRe.exec(text)) !== null) {
      const openTool = findEnclosingRange(m.index, closedToolRanges);
      if (openTool) {
        htmlOpenRe.lastIndex = openTool.end;
        continue;
      }
      if (isPosInSortedAreas(preHtmlAreas, m.index)) continue;
      const tag = m[1].toLowerCase();
      const afterOpen = m.index + m[0].length;
      let closeM = cachedHtmlClose[tag];
      if (closeM === undefined || (closeM !== null && closeM.index < afterOpen)) {
        const cRe = closeReByTag[tag];
        cRe.lastIndex = afterOpen;
        while ((closeM = cRe.exec(text)) !== null &&
            (isPosInSortedAreas(preHtmlAreas, closeM.index) || Boolean(findEnclosingRange(closeM.index, closedToolRanges)))) {
          // skip closing tags inside preHtmlAreas or closedToolRanges
        }
        cachedHtmlClose[tag] = closeM;
      }
      if (!closeM) continue;
      const closeEnd = closeM.index + closeM[0].length;
      if (htmlThinkTracker) {
        htmlThinkTracker.advanceTo(m.index);
        if (isCrossUnclosedThinkSpan(text, afterOpen, closeEnd, htmlThinkTracker.openVcpThink, htmlThinkTracker.openThinkDepth, { skipRanges: htmlThinkTracker.skipAreas })) {
          continue;
        }
      }
      areas.push({ start: m.index, end: clampAreaEndToTool(m.index, closeEnd, closedToolRanges), type: 'HTML' });
      htmlOpenRe.lastIndex = closeEnd;
    }
    if (/<\/code[ \t]*>/i.test(text)) {
      const preInlineHtmlAreas = buildSortedMergedAreas(areas);
      const codeOpenRe = /<code(?=[ \t>])[^>\r\n<]*>/gi;
      const codeCloseRe = /<\/code[ \t]*>/gi;
      let cachedCodeCloseM;
      let nextNl = -1;
      while ((m = codeOpenRe.exec(text)) !== null) {
        const openTool = findEnclosingRange(m.index, closedToolRanges);
        if (openTool) {
          codeOpenRe.lastIndex = openTool.end;
          continue;
        }
        if (isPosInSortedAreas(preInlineHtmlAreas, m.index)) continue;
        const afterOpen = m.index + m[0].length;
        if (nextNl < afterOpen) {
          nextNl = text.indexOf('\n', afterOpen);
          if (nextNl === -1) nextNl = len;
        }
        if (cachedCodeCloseM === undefined || (cachedCodeCloseM !== null && cachedCodeCloseM.index < afterOpen)) {
          codeCloseRe.lastIndex = afterOpen;
          let cm;
          while ((cm = codeCloseRe.exec(text)) !== null &&
              (isPosInSortedAreas(preInlineHtmlAreas, cm.index) || Boolean(findEnclosingRange(cm.index, closedToolRanges)))) {
            // skip closing </code> inside preInlineHtmlAreas or closedToolRanges
          }
          cachedCodeCloseM = cm;
        }
        if (!cachedCodeCloseM) break;
        if (cachedCodeCloseM.index > nextNl) {
          codeOpenRe.lastIndex = nextNl + 1;
          continue;
        }
        const closeEnd = cachedCodeCloseM.index + cachedCodeCloseM[0].length;
        if (text.slice(afterOpen, cachedCodeCloseM.index).includes('\r')) continue;
        areas.push({ start: m.index, end: clampAreaEndToTool(m.index, closeEnd, closedToolRanges), type: 'HTML' });
        codeOpenRe.lastIndex = closeEnd;
      }
    }
  }

  const preVcpAreas = buildSortedMergedAreas(areas);
  const vcpAreas = [];
  const isInVcpOrPreArea = (pos) => isPosInSortedAreas(preVcpAreas, pos) || isPosInSortedAreas(vcpAreas, pos);
  const vcpThinkOpenRe = /^[ \t]*\[--- VCP元思考链(?::\s*"[^"]*")?\s*---\][ \t]*(?:\r?\n|$)/gm;
  const vcpThinkCloseMarker = '[--- 元思考链结束 ---]';
  while ((m = vcpThinkOpenRe.exec(text)) !== null) {
    if (isInVcpOrPreArea(m.index)) continue;
    const enclosingTool = findEnclosingRange(m.index, closedToolRanges);
    let closeSearchFrom = m.index + m[0].length;
    let rawEnd = len;
    while (closeSearchFrom < len) {
      const closeIdx = text.indexOf(vcpThinkCloseMarker, closeSearchFrom);
      if (closeIdx === -1) {
        rawEnd = len;
        break;
      }
      const lineStart = closeIdx === 0 ? 0 : text.lastIndexOf('\n', closeIdx - 1) + 1;
      const afterCloseIdx = closeIdx + vcpThinkCloseMarker.length;
      const nextNl = text.indexOf('\n', afterCloseIdx);
      const lineEnd = nextNl === -1 ? len : nextNl;
      const isStandaloneClose = /^[ \t]*$/.test(text.slice(lineStart, closeIdx));
      const closeInAreas = isInVcpOrPreArea(closeIdx);
      const closeInExternalTool = !enclosingTool && Boolean(findEnclosingRange(closeIdx, closedToolRanges));
      if (isStandaloneClose && !closeInAreas && !closeInExternalTool) {
        rawEnd = afterCloseIdx;
        break;
      }
      closeSearchFrom = afterCloseIdx;
    }
    const clamped = enclosingTool && rawEnd > enclosingTool.end ? enclosingTool.end : rawEnd;
    const area = { start: m.index, end: clamped, type: 'THINK_VCP' };
    areas.push(area);
    vcpAreas.push(area);
    vcpThinkOpenRe.lastIndex = clamped;
  }

  const preThinkAreas = buildSortedMergedAreas(areas);
  const thinkAreas = [];
  const thinkTagPattern = /<[ \t]*(\/?)[ \t]*(think(?:ing)?|thought(?:s)?|antthinking)(?=[ \t>])[^>\r\n<]*>/gi;
  const thinkStacksByScope = new Map();
  const thinkCandidates = [];
  let tMatch;
  while ((tMatch = thinkTagPattern.exec(text)) !== null) {
    const tStart = tMatch.index;
    if (isPosInSortedAreas(preThinkAreas, tStart)) continue;

    const tagName = tMatch[2].toLowerCase();
    const tEnd = tMatch.index + tMatch[0].length;
    const enclosingTool = findEnclosingRange(tStart, closedToolRanges);
    const scopeKey = `${enclosingTool ? enclosingTool.start : -1}:${tagName}`;

    if (tMatch[1] === '/') {
      const stack = thinkStacksByScope.get(scopeKey);
      if (stack && stack.length > 0) {
        const open = stack.pop();
        thinkCandidates.push({ start: open.start, end: tEnd, type: 'THINK' });
      }
      continue;
    }

    let ls = tStart - 1;
    let isAtLineStart = true;
    while (ls >= 0) {
      const c = text[ls];
      if (c === '\n') break;
      if (c !== ' ' && c !== '\t') {
        isAtLineStart = false;
        break;
      }
      ls--;
    }

    let stack = thinkStacksByScope.get(scopeKey);
    if (!stack) {
      stack = [];
      thinkStacksByScope.set(scopeKey, stack);
    }
    stack.push({ start: tStart, end: tEnd, isAtLineStart, enclosingTool });
  }

  for (const stack of thinkStacksByScope.values()) {
    for (let i = 0; i < stack.length; i++) {
      const open = stack[i];
      if (open.isAtLineStart) {
        thinkCandidates.push({
          start: open.start,
          end: open.enclosingTool ? open.enclosingTool.end : len,
          type: 'THINK'
        });
      }
    }
  }

  if (thinkCandidates.length > 0) {
    thinkCandidates.sort((a, b) => a.start - b.start || b.end - a.end);
    let lastAcceptedEnd = -1;
    for (let i = 0; i < thinkCandidates.length; i++) {
      const cand = thinkCandidates[i];
      if (cand.start < lastAcceptedEnd) continue;
      areas.push(cand);
      thinkAreas.push(cand);
      lastAcceptedEnd = cand.end;
    }
  }

  const preHeadlessAreas = buildSortedMergedAreas(areas);
  if (options.allowHeadlessThinkReset !== false && !options.isHistoryExtraction) {
    const anyThinkTagRe = /<[ \t]*(\/?)[ \t]*(think(?:ing)?|thought(?:s)?|antthinking)(?=[ \t>])[^>\r\n<]*>/gi;
    let firstToolSyntaxIdx = -2;
    let tagMatch;
    while ((tagMatch = anyThinkTagRe.exec(text)) !== null) {
      const tagStart = tagMatch.index;
      if (isPosInSortedAreas(preHeadlessAreas, tagStart)) continue;
      if (tagMatch[1] !== '/') break;

      const tagEnd = tagStart + tagMatch[0].length;
      let isAtStart = true;
      for (let l = tagStart - 1; l >= 0; l--) {
        const ch = text[l];
        if (ch === '\n') break;
        if (ch !== ' ' && ch !== '\t') {
          isAtStart = false;
          break;
        }
      }
      if (!isAtStart) continue;

      let isAtEnd = true;
      for (let r = tagEnd; r < len; r++) {
        const ch = text[r];
        if (ch === '\n') break;
        if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
          isAtEnd = false;
          break;
        }
      }
      if (!isAtEnd) continue;

      if (firstToolSyntaxIdx === -2) {
        firstToolSyntaxIdx = fuzzy
          ? text.search(/<{2,4}\[(?:TOOL_REQUEST|END_TOOL_REQUEST)/i)
          : text.search(/<<<\[(?:TOOL_REQUEST|END_TOOL_REQUEST)/i);
      }
      if (firstToolSyntaxIdx !== -1 && firstToolSyntaxIdx < tagStart) {
        break;
      }
      areas.push({ start: 0, end: tagEnd, type: 'HEADLESS_THINK' });
      break;
    }
  }

  return buildSortedMergedAreas(areas);
}

module.exports = {
  START_MARKER,
  END_MARKER,
  FUZZY_START_BLOCK_RE,
  FUZZY_END_BLOCK_RE,
  FIELD_OPEN_RE,
  CROSS_SLICE_FIELD_RE,
  QUOTED_PAIR_MAP,
  hasAdjacentAngle,
  isQuotedSingleToolMarker,
  execCachedRegex,
  execValidToolMarker,
  findExactMarkerInLine,
  findFuzzyMarkerInLine,
  findValidStartInLine,
  findValidEndInLine,
  endsWithValidEndMarkerBefore,
  isStandaloneMarkerLine,
  findNextEscapeToken,
  isLineLeadingBlank,
  isLineTrailingBlank,
  findNestedVcpInfoRanges,
  filterCrossFenceVcpInfoRanges,
  findClosedMarkdownFenceRanges,
  scanClosedToolBlockEnd,
  findClosedToolBlockRanges,
  hasUnmatchedThinkCloseAfter,
  createMonotonicThinkTracker,
  isCrossUnclosedThinkSpan,
  findClosedFenceAndToolRanges,
  findEnclosingRange,
  clampAreaEndToTool,
  findProtectionAreas
};
