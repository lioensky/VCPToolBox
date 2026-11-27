'use strict';

/**
 * modules/vcpProtocolResilience/thinkingMask.js
 * 思考链剥离与协议标记净化共用的安全保护区掩码引擎（底层词法统一复用 protocolLexer）
 */

const {
  findNestedVcpInfoRanges,
  filterCrossFenceVcpInfoRanges,
  findClosedMarkdownFenceRanges,
  findClosedToolBlockRanges,
  findClosedFenceAndToolRanges,
  createMonotonicThinkTracker,
  isCrossUnclosedThinkSpan
} = require('./protocolLexer');

const THOUGHT_CHAIN_REGEX = /^[ \t]*\[--- VCP元思考链(?:(?!---\]).)*?---\](?:[ \t]*\r?\n[\s\S]*?^[ \t]*\[--- 元思考链结束 ---\](?:[ \t]*\r?\n|[ \t]*)|[^\r\n]*?\[--- 元思考链结束 ---\][ \t]*(?:\r?\n|$))/gm;
const DANGLING_CONVENTIONAL_REGEX = /(?:^|\r?\n)[ \t]*<(think(?:ing)?|thought(?:s)?|antthinking)(?=[ \t\r\n>])[^>]*>[ \t]*(?:\r?\n|$)(?![\s\S]*?<\/\1[ \t]*>)[\s\S]*$/i;
const DANGLING_VCP_REGEX = /(?:^|\r?\n)[ \t]*\[--- VCP元思考链(?:(?:(?!---\]).)*?---\][ \t]*(?:\r?\n|$)|(?![^\r\n]*---\])[^\r\n]*(?:\r?\n|$))(?![\s\S]*?(?:^|\r?\n)[ \t]*\[--- 元思考链结束 ---\])[\s\S]*$/;

const STANDARD_THOUGHT_TAGS = new Set(['think', 'thinking', 'thought', 'thoughts', 'antthinking']);

function applyMaskRanges(text, ranges, pushMask) {
  if (!ranges || ranges.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor) continue;
    out += text.slice(cursor, r.start) + pushMask(text.slice(r.start, r.end));
    cursor = r.end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * 为思考链/纠偏正则剥离建立受保护区域掩码
 * @param {string} text
 * @param {Object} [options]
 * @param {Function} [options.shouldMaskInfoBlock] - 可选过滤：决定某个闭合 VCP调用结果信息汇总块是否掩码保护
 * @param {boolean} [options.skipTopLevelEscape] - 是否跳过步骤 5 顶层 ESCAPE 掩码（默认 false）
 * @returns {{ text: string, masks: Array<{token: string, content: string}> }}
 */
function maskProtectedRegionsForThinking(text, options = {}) {
  if (typeof text !== 'string') return { text, masks: [] };
  const masks = [];
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const pushMask = (chunk) => {
    const token = `__VCP_MASK_${nonce}_${masks.length}__`;
    masks.push({ token, content: chunk });
    return token;
  };

  let masked = text;

  // 1. 嵌套感知的闭合工具结果域
  const infoRanges = filterCrossFenceVcpInfoRanges(masked, findNestedVcpInfoRanges(masked));
  const filteredInfoRanges = typeof options.shouldMaskInfoBlock === 'function'
    ? infoRanges.filter(r => options.shouldMaskInfoBlock(masked.slice(r.start, r.end)))
    : infoRanges;
  masked = applyMaskRanges(masked, filteredInfoRanges, pushMask);

  // 2 & 3. 单遍源码顺序扫描闭合 Markdown 围栏代码块与转义感知闭合工具请求块（互不越界）
  const fenceAndToolRanges = findClosedFenceAndToolRanges(masked, options);
  masked = applyMaskRanges(masked, fenceAndToolRanges, pushMask);

  // 4. 闭合遗留日记块
  masked = masked.replace(/<<<DailyNoteStart>>>(?:(?!<<<DailyNoteStart>>>)[\s\S])*?<<<DailyNoteEnd>>>/g, pushMask);

  // 5. 剩余顶层转义体（在代码围栏与工具结果已掩码之后，杜绝跨代码块吞噬顶层思考链）
  if (!options.skipTopLevelEscape) {
    const escCloseRe = /(?:「末|\{末)(?:ESCAPE|escape)(?:」|\})/gi;
    if (escCloseRe.test(masked)) {
      const escOpenRe = /(?:「始|\{始)(?:ESCAPE|escape)(?:」|\})/gi;
      let out = '';
      let cursor = 0;
      let om;
      while ((om = escOpenRe.exec(masked)) !== null) {
        if (om.index < cursor) continue;
        escCloseRe.lastIndex = om.index + om[0].length;
        const cm = escCloseRe.exec(masked);
        if (!cm) break;
        const closeEnd = cm.index + cm[0].length;
        out += masked.slice(cursor, om.index) + pushMask(masked.slice(om.index, closeEnd));
        cursor = closeEnd;
        escOpenRe.lastIndex = cursor;
      }
      if (cursor > 0) {
        masked = out + masked.slice(cursor);
      }
    }
  }

  return { text: masked, masks };
}

/**
 * 单遍线性还原掩码区域（兼容嵌套与自定义掩码 token）
 */
function unmaskProtectedRegionsForThinking(text, masks) {
  if (!masks || !masks.length || typeof text !== 'string') return text;

  const tokenMap = new Map();
  let allStandard = true;
  let commonNonce = null;
  const stdTokenRe = /^__VCP_MASK_([a-z0-9]+)_(\d+)__$/;

  for (let i = 0; i < masks.length; i++) {
    const t = masks[i].token;
    tokenMap.set(t, i);
    if (allStandard) {
      const m = stdTokenRe.exec(t);
      if (!m || Number(m[2]) !== i) {
        allStandard = false;
      } else if (commonNonce === null) {
        commonNonce = m[1];
      } else if (commonNonce !== m[1]) {
        allStandard = false;
      }
    }
  }

  const stdPrefix = allStandard && commonNonce !== null ? `__VCP_MASK_${commonNonce}_` : '';
  if (stdPrefix && !text.includes(stdPrefix)) {
    return text;
  }

  const reSource = stdPrefix
    ? `__VCP_MASK_${commonNonce}_(\\d+)__`
    : masks.map(m => m.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const tokenRe = new RegExp(reSource, 'g');

  const resolved = new Array(masks.length);
  const resolving = new Uint8Array(masks.length);

  const resolveIdx = (idx) => {
    if (resolved[idx] !== undefined) return resolved[idx];
    const raw = masks[idx].content;
    if (!raw || (stdPrefix && !raw.includes(stdPrefix))) {
      resolved[idx] = raw;
      return raw;
    }
    resolving[idx] = 1;
    const innerRe = new RegExp(reSource, 'g');
    const out = raw.replace(innerRe, (match, capIdx) => {
      const targetIdx = stdPrefix ? Number(capIdx) : tokenMap.get(match);
      if (targetIdx === undefined || targetIdx < 0 || targetIdx >= masks.length || targetIdx >= idx || resolving[targetIdx]) {
        return match;
      }
      return resolveIdx(targetIdx);
    });
    resolving[idx] = 0;
    resolved[idx] = out;
    return out;
  };

  return text.replace(tokenRe, (match, capIdx) => {
    const idx = stdPrefix ? Number(capIdx) : tokenMap.get(match);
    if (idx === undefined || idx < 0 || idx >= masks.length) return match;
    return resolveIdx(idx);
  });
}

const EMOTICONS = ['(`・ω・´)ゞ', '(・`ω´・)', '(`・ω・´)', '(`･ω･´)'];

function isEmoticonBacktickAt(text, idx) {
  for (let i = 0; i < EMOTICONS.length; i++) {
    const emo = EMOTICONS[i];
    const offset = emo.indexOf('`');
    if (idx >= offset && text.startsWith(emo, idx - offset)) return true;
  }
  return false;
}

function createInlineBacktickChecker(text, extraTag = '') {
  if (!text || !text.includes('`')) return () => false;

  const len = text.length;
  const doubleNlRe = /\r?\n[ \t]*\r?\n/g;
  const normExtra = extraTag ? String(extraTag).trim() : '';
  const safeExtra = (normExtra && !STANDARD_THOUGHT_TAGS.has(normExtra.toLowerCase()))
    ? normExtra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : '';
  const lineStartThinkCloseRe = safeExtra
    ? new RegExp(`\\n[ \\t]*(?:<[ \\t]*\\/[ \\t]*(?:think(?:ing)?|thought(?:s)?|antthinking|${safeExtra})[ \\t]*>|\\[--- 元思考链结束 ---\\])`, 'gi')
    : /\n[ \t]*(?:<[ \t]*\/[ \t]*(?:think(?:ing)?|thought(?:s)?|antthinking)[ \t]*>|\[--- 元思考链结束 ---\])/gi;
  const thinkTracker = createMonotonicThinkTracker(text, null, safeExtra ? normExtra : '');
  const spans = [];
  let cachedDoubleNlIdx = -2;
  let cachedThinkCloseLineIdx = -2;
  let btCursor = 0;

  while (btCursor < len) {
    const nextBt = text.indexOf('`', btCursor);
    if (nextBt === -1) break;
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
    let limit = len;
    if (cachedDoubleNlIdx !== -1 && cachedDoubleNlIdx < limit) limit = cachedDoubleNlIdx;
    if (cachedThinkCloseLineIdx !== -1 && cachedThinkCloseLineIdx < limit) limit = cachedThinkCloseLineIdx;
    let scan = contentStart;
    let inlineEnd = -1;
    while (scan < limit) {
      const cBt = text.indexOf('`', scan);
      if (cBt === -1 || cBt >= limit) break;
      let cEnd = cBt;
      while (cEnd < len && text[cEnd] === '`') cEnd++;
      if (cEnd - cBt === runLen && !(runLen === 1 && isEmoticonBacktickAt(text, cBt))) {
        inlineEnd = cEnd;
        break;
      }
      scan = cEnd;
    }
    if (inlineEnd !== -1) {
      if (thinkTracker.hasThink) {
        thinkTracker.advanceTo(nextBt);
        if (isCrossUnclosedThinkSpan(text, contentStart, inlineEnd, thinkTracker.openVcpThink, thinkTracker.openThinkDepth, { inlineCloseLen: runLen, extraTag: thinkTracker.extraTag })) {
          btCursor = runEnd;
          continue;
        }
        thinkTracker.skipTo(inlineEnd);
      }
      spans.push(nextBt, inlineEnd);
      btCursor = inlineEnd;
    } else {
      btCursor = runEnd;
    }
  }

  if (spans.length === 0) return () => false;
  return (pos) => {
    let lo = 0;
    let hi = (spans.length >>> 1) - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const s = spans[mid << 1];
      const e = spans[(mid << 1) + 1];
      if (pos < s) hi = mid - 1;
      else if (pos >= e) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

function getLineWsStartAt(text, pos) {
  let ls = pos - 1;
  while (ls >= 0) {
    const c = text[ls];
    if (c === '\n') return ls + 1;
    if (c !== ' ' && c !== '\t') return -1;
    ls--;
  }
  return 0;
}

function getTrailingLineEndOffsetAt(text, pos) {
  let p = pos;
  while (p < text.length && (text[p] === ' ' || text[p] === '\t')) p++;
  if (p === text.length) return p;
  if (text[p] === '\n') return p + 1;
  if (text[p] === '\r' && text[p + 1] === '\n') return p + 2;
  return -1;
}

function stripVcpThoughtChainsLinear(text, isInBackticks) {
  const VCP_OPEN_PREFIX = '[--- VCP元思考链';
  const VCP_CLOSE = '[--- 元思考链结束 ---]';
  if (!text || !text.includes(VCP_OPEN_PREFIX) || !text.includes(VCP_CLOSE)) return text;

  const lineStartCloses = [];
  let cScan = 0;
  while (cScan < text.length) {
    const idx = text.indexOf(VCP_CLOSE, cScan);
    if (idx === -1) break;
    const cEnd = idx + VCP_CLOSE.length;
    if (!isInBackticks(idx) && getLineWsStartAt(text, idx) !== -1) {
      let endPos = cEnd;
      while (endPos < text.length && (text[endPos] === ' ' || text[endPos] === '\t')) endPos++;
      if (text[endPos] === '\n') endPos += 1;
      else if (text[endPos] === '\r' && text[endPos + 1] === '\n') endPos += 2;
      lineStartCloses.push({ start: idx, end: endPos });
    }
    cScan = cEnd;
  }

  const openRe = /^[ \t]*\[--- VCP元思考链/gm;
  let out = '';
  let cursor = 0;
  let scIdx = 0;
  let om;

  while ((om = openRe.exec(text)) !== null) {
    if (om.index < cursor) continue;
    if (isInBackticks(om.index)) continue;
    const nlIdx = text.indexOf('\n', om.index);
    const lineEnd = nlIdx === -1 ? text.length : nlIdx;
    const closeBracketIdx = text.indexOf('---]', om.index + om[0].length);
    if (closeBracketIdx === -1 || closeBracketIdx >= lineEnd) {
      openRe.lastIndex = lineEnd + 1;
      continue;
    }
    const afterBracket = closeBracketIdx + 4;
    const openTrailEnd = getTrailingLineEndOffsetAt(text, afterBracket);
    if (openTrailEnd !== -1 && nlIdx !== -1) {
      while (scIdx < lineStartCloses.length && lineStartCloses[scIdx].start < openTrailEnd) {
        scIdx++;
      }
      if (scIdx >= lineStartCloses.length) {
        // 多行元思考链已无任何后续行首闭标，剩余内容只可能未闭合
        break;
      }
      out += text.slice(cursor, om.index);
      cursor = lineStartCloses[scIdx].end;
      scIdx++;
      openRe.lastIndex = cursor;
    } else {
      let sameLineSearch = afterBracket;
      while (sameLineSearch < lineEnd) {
        const inlineClose = text.indexOf(VCP_CLOSE, sameLineSearch);
        if (inlineClose === -1 || inlineClose >= lineEnd) break;
        const endPos = getTrailingLineEndOffsetAt(text, inlineClose + VCP_CLOSE.length);
        if (!isInBackticks(inlineClose) && endPos !== -1) {
          out += text.slice(cursor, om.index);
          cursor = endPos;
          openRe.lastIndex = cursor;
          break;
        }
        sameLineSearch = inlineClose + VCP_CLOSE.length;
      }
    }
  }

  if (cursor === 0) return text;
  out += text.slice(cursor);
  return out;
}

function stripConventionalThoughtsDepthAware(text, isInBackticks) {
  if (!text || !text.includes('<')) return text;

  const isTagInBackticks = isInBackticks || createInlineBacktickChecker(text);

  const tagScanRe = /<([ \t]*)(\/?)[ \t]*(think(?:ing)?|thought(?:s)?|antthinking)(?=[ \t\r\n>])[^>\r\n<]*>/gi;
  const standaloneStackByTag = new Map();
  const nonStandaloneOpenByTag = new Map();
  const candidates = [];
  let lastAnyLineStartOpenPos = -1;
  let tm;

  while ((tm = tagScanRe.exec(text)) !== null) {
    if (isTagInBackticks(tm.index)) continue;

    const isClose = tm[2] === '/';
    const tagName = tm[3].toLowerCase();
    const tStart = tm.index;
    const tEnd = tStart + tm[0].length;

    if (!isClose) {
      const lineWsStart = getLineWsStartAt(text, tStart);
      const isLineStart = lineWsStart !== -1;
      if (isLineStart) {
        lastAnyLineStartOpenPos = lineWsStart;
        nonStandaloneOpenByTag.clear();
        let p = tEnd;
        while (p < text.length && (text[p] === ' ' || text[p] === '\t')) p++;
        const isStandalone = text[p] === '\n' || (text[p] === '\r' && text[p + 1] === '\n');

        let stack = standaloneStackByTag.get(tagName);
        if (!stack) {
          stack = [];
          standaloneStackByTag.set(tagName, stack);
        }
        if (isStandalone || stack.length > 0) {
          stack.push({ openStart: lineWsStart, isLineStart: true, isStandalone });
        } else {
          nonStandaloneOpenByTag.set(tagName, { openStart: lineWsStart });
        }
      } else {
        const stack = standaloneStackByTag.get(tagName);
        if (stack && stack.length > 0) {
          stack.push({ openStart: tStart, isLineStart: false, isStandalone: false });
        }
      }
      continue;
    }

    const closeLineStart = getLineWsStartAt(text, tStart) !== -1;
    const trailEndPos = getTrailingLineEndOffsetAt(text, tEnd);
    const stack = standaloneStackByTag.get(tagName);

    if (stack && stack.length > 0) {
      if (stack.length === 1 && !closeLineStart && trailEndPos === -1) {
        continue;
      }
      const popped = stack.pop();
      if (popped.isLineStart && (popped.isStandalone || lastAnyLineStartOpenPos <= popped.openStart)) {
        let closeEnd = -1;
        if (closeLineStart) {
          if (trailEndPos !== -1) {
            closeEnd = trailEndPos;
          } else {
            let p = tEnd;
            while (p < text.length && (text[p] === ' ' || text[p] === '\t')) p++;
            closeEnd = p;
          }
        } else if (trailEndPos !== -1) {
          closeEnd = trailEndPos;
        }
        if (closeEnd !== -1) {
          candidates.push({ start: popped.openStart, end: closeEnd });
        }
      }
    } else {
      const ns = nonStandaloneOpenByTag.get(tagName);
      if (ns && (closeLineStart || trailEndPos !== -1)) {
        let closeEnd = trailEndPos;
        if (closeEnd === -1) {
          let p = tEnd;
          while (p < text.length && (text[p] === ' ' || text[p] === '\t')) p++;
          closeEnd = p;
        }
        candidates.push({ start: ns.openStart, end: closeEnd });
        nonStandaloneOpenByTag.delete(tagName);
      }
    }
  }

  if (candidates.length === 0) return text;
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);

  let out = '';
  let cursor = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.start < cursor) continue;
    out += text.slice(cursor, c.start);
    cursor = c.end;
  }
  out += text.slice(cursor);
  return out;
}

function stripDanglingVcpThought(text, isInBackticks) {
  if (!text || !text.includes('[--- VCP元思考链')) return text;
  const VCP_CLOSE = '[--- 元思考链结束 ---]';
  let lastClosePos = -1;
  let searchEnd = text.length;
  while (searchEnd > 0) {
    const idx = text.lastIndexOf(VCP_CLOSE, searchEnd - 1);
    if (idx === -1) break;
    const atLineStart = getLineWsStartAt(text, idx) !== -1;
    const atLineEnd = getTrailingLineEndOffsetAt(text, idx + VCP_CLOSE.length) !== -1;
    if (!isInBackticks(idx) && atLineStart && atLineEnd) {
      lastClosePos = idx;
      break;
    }
    searchEnd = idx;
  }

  const openRe = /(?:^|\r?\n)[ \t]*\[--- VCP元思考链/g;
  openRe.lastIndex = lastClosePos === -1 ? 0 : lastClosePos;
  let m;
  while ((m = openRe.exec(text)) !== null) {
    const tagIdx = text.indexOf('[', m.index);
    if (isInBackticks(tagIdx)) continue;
    const afterPrefix = m.index + m[0].length;
    const nlIdx = text.indexOf('\n', afterPrefix);
    const lineEnd = nlIdx === -1 ? text.length : nlIdx;
    const lineRest = text.slice(afterPrefix, lineEnd);
    const closeBracketIdx = lineRest.indexOf('---]');
    if (closeBracketIdx === -1 || /^[ \t\r]*$/.test(lineRest.slice(closeBracketIdx + 4))) {
      return text.slice(0, m.index);
    }
  }
  return text;
}

function stripDanglingConventionalThought(text, isInBackticks) {
  if (!text || !text.includes("<")) return text;
  const isTagInBackticks = isInBackticks || createInlineBacktickChecker(text);
  const tagScanRe = /<([ \t]*)(\/?)[ \t]*(think(?:ing)?|thought(?:s)?|antthinking)(?=[ \t\r\n>])[^>\r\n<]*>/gi;
  const stackByTag = new Map();
  let tm;

  while ((tm = tagScanRe.exec(text)) !== null) {
    if (isTagInBackticks(tm.index)) continue;
    const isClose = tm[2] === "/";
    const tagName = tm[3].toLowerCase();
    const tStart = tm.index;
    const tEnd = tStart + tm[0].length;

    if (!isClose) {
      const lineWsStart = getLineWsStartAt(text, tStart);
      const isLineStart = lineWsStart !== -1;
      const trailEndPos = getTrailingLineEndOffsetAt(text, tEnd);
      const isStandaloneOpen = isLineStart && trailEndPos !== -1;
      let stack = stackByTag.get(tagName);
      if (!stack) {
        stack = [];
        stackByTag.set(tagName, stack);
      }
      if (isStandaloneOpen || stack.length > 0) {
        // Record cut position including preceding newline (matching original DANGLING_CONVENTIONAL_REGEX)
        let cutStart = lineWsStart;
        if (isStandaloneOpen && lineWsStart > 0) {
          if (text[lineWsStart - 1] === "\n") {
            cutStart = (lineWsStart >= 2 && text[lineWsStart - 2] === "\r") ? lineWsStart - 2 : lineWsStart - 1;
          }
        }
        stack.push({ cutStart, isStandaloneOpen });
      }
      continue;
    }

    const closeLineStart = getLineWsStartAt(text, tStart) !== -1;
    const trailEndPos = getTrailingLineEndOffsetAt(text, tEnd);
    const stack = stackByTag.get(tagName);
    if (stack && stack.length > 0) {
      if (stack.length === 1 && !closeLineStart && trailEndPos === -1) {
        continue;
      }
      stack.pop();
    }
  }

  let earliestCut = -1;
  for (const stack of stackByTag.values()) {
    for (let i = 0; i < stack.length; i++) {
      if (stack[i].isStandaloneOpen) {
        if (earliestCut === -1 || stack[i].cutStart < earliestCut) {
          earliestCut = stack[i].cutStart;
        }
        break;
      }
    }
  }
  return earliestCut !== -1 ? text.slice(0, earliestCut) : text;
}

/**
 * 带保护区掩码的安全思考链剥离函数
 */
function stripThoughtChainsSafe(text, options = {}) {
  if (typeof text !== 'string') return text;
  const { text: masked, masks } = maskProtectedRegionsForThinking(text, options);

  const isInMaskedBt = createInlineBacktickChecker(masked);
  let cleaned = stripVcpThoughtChainsLinear(masked, isInMaskedBt);
  const isInPostVcpBt = cleaned === masked ? isInMaskedBt : createInlineBacktickChecker(cleaned);
  cleaned = stripConventionalThoughtsDepthAware(cleaned, isInPostVcpBt);
  const isInPostConvBt = cleaned === masked ? isInMaskedBt : createInlineBacktickChecker(cleaned);
  cleaned = stripDanglingVcpThought(cleaned, isInPostConvBt);
  const isInPostDanglingVcpBt = cleaned === masked ? isInMaskedBt : createInlineBacktickChecker(cleaned);
  cleaned = stripDanglingConventionalThought(cleaned, isInPostDanglingVcpBt);

  const rawReasoningTag = options.reasoningTag !== undefined ? options.reasoningTag : options.extraTag;
  if (rawReasoningTag) {
    const normTag = String(rawReasoningTag).trim();
    if (normTag) {
      const safeTag = normTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const anyCloseRe = new RegExp(`<\\/${safeTag}[ \\t]*>`, 'gi');
      const hasAnyClose = anyCloseRe.test(cleaned);
      const isCustomTag = !STANDARD_THOUGHT_TAGS.has(normTag.toLowerCase());
      let customBtSource = null;
      let customBtChecker = null;
      const getCustomBtChecker = () => {
        if (customBtSource !== cleaned) {
          customBtSource = cleaned;
          customBtChecker = (!isCustomTag && cleaned === masked)
            ? isInMaskedBt
            : createInlineBacktickChecker(cleaned, isCustomTag ? normTag : '');
        }
        return customBtChecker;
      };
      if (hasAnyClose) {
        const leadingOpenRe = new RegExp(`^[ \\t]*<${safeTag}(?=[ \\t\\r\\n>])[^>]*>`, 'i');
        const leadOpenM = leadingOpenRe.exec(cleaned);
        if (leadOpenM) {
          const isInBt = getCustomBtChecker();
          const innerNewOpenRe = new RegExp(`\\r?\\n[ \\t]*<${safeTag}(?=[ \\t\\r\\n>])`, 'gi');
          const afterLeadOpen = leadOpenM.index + leadOpenM[0].length;
          innerNewOpenRe.lastIndex = afterLeadOpen;
          let nextOpenM;
          while ((nextOpenM = innerNewOpenRe.exec(cleaned)) !== null) {
            if (!isInBt(nextOpenM.index + nextOpenM[0].indexOf('<'))) break;
          }
          const openLimit = nextOpenM ? nextOpenM.index : cleaned.length;
          anyCloseRe.lastIndex = afterLeadOpen;
          let leadCloseM;
          while ((leadCloseM = anyCloseRe.exec(cleaned)) !== null) {
            if (leadCloseM.index >= openLimit) {
              leadCloseM = null;
              break;
            }
            if (!isInBt(leadCloseM.index)) break;
          }
          if (leadCloseM) {
            let cutEnd = leadCloseM.index + leadCloseM[0].length;
            while (cutEnd < cleaned.length && (cleaned[cutEnd] === ' ' || cleaned[cutEnd] === '\t')) cutEnd++;
            if (cleaned[cutEnd] === '\r' && cleaned[cutEnd + 1] === '\n') cutEnd += 2;
            else if (cleaned[cutEnd] === '\n') cutEnd += 1;
            cleaned = cleaned.slice(cutEnd);
          }
        }
      }

      if (!STANDARD_THOUGHT_TAGS.has(normTag.toLowerCase())) {
        if (hasAnyClose) {
          // 1) 线性替换多行完整块 (extraComplete)
          const isInCompleteBt = getCustomBtChecker();
          const multiOpenRe = new RegExp(`^[ \\t]*<${safeTag}(?=[ \\t\\r\\n>])[^>]*>[ \\t]*\\r?\\n`, 'gim');
          const lineCloseRe = new RegExp(`^[ \\t]*<\\/${safeTag}[ \\t]*>(?:[ \\t]*\\r?\\n|[ \\t]*)`, 'gim');
          let out = '';
          let cursor = 0;
          let om;
          while ((om = multiOpenRe.exec(cleaned)) !== null) {
            if (om.index < cursor) continue;
            if (isInCompleteBt(om.index + om[0].indexOf('<'))) continue;
            lineCloseRe.lastIndex = om.index + om[0].length;
            let cm;
            while ((cm = lineCloseRe.exec(cleaned)) !== null) {
              if (!isInCompleteBt(cm.index + cm[0].indexOf('<'))) break;
            }
            if (!cm) break;
            out += cleaned.slice(cursor, om.index);
            cursor = cm.index + cm[0].length;
            multiOpenRe.lastIndex = cursor;
          }
          if (cursor > 0) cleaned = out + cleaned.slice(cursor);

          // 2) 线性替换单/多行尾闭标块 (extraLineEnd)
          const isInLineBt = getCustomBtChecker();
          const lineOpenRe = new RegExp(`^[ \\t]*<${safeTag}(?=[ \\t\\r\\n>])[^>]*>`, 'gim');
          const lineEndCloseRe = new RegExp(`<\\/${safeTag}[ \\t]*>[ \\t]*(?:\\r?\\n|$)`, 'gim');
          const innerOpenRe = new RegExp(`\\r?\\n[ \\t]*<${safeTag}(?=[ \\t\\r\\n>])`, 'gi');
          let outLine = '';
          let cursorLine = 0;
          let cachedClose;
          let cachedInnerOpen;
          let lom;
          while ((lom = lineOpenRe.exec(cleaned)) !== null) {
            if (lom.index < cursorLine) continue;
            if (isInLineBt(lom.index + lom[0].indexOf('<'))) continue;
            const afterOpen = lom.index + lom[0].length;
            if (cachedClose === undefined || (cachedClose !== null && cachedClose.index < afterOpen)) {
              lineEndCloseRe.lastIndex = afterOpen;
              let cm;
              while ((cm = lineEndCloseRe.exec(cleaned)) !== null) {
                if (!isInLineBt(cm.index)) break;
              }
              cachedClose = cm;
            }
            if (!cachedClose) break;
            if (cachedInnerOpen === undefined || (cachedInnerOpen !== null && cachedInnerOpen.index < afterOpen)) {
              innerOpenRe.lastIndex = afterOpen;
              let iom;
              while ((iom = innerOpenRe.exec(cleaned)) !== null) {
                if (!isInLineBt(iom.index + iom[0].indexOf('<'))) break;
              }
              cachedInnerOpen = iom;
            }
            if (cachedInnerOpen && cachedInnerOpen.index < cachedClose.index) {
              continue;
            }
            outLine += cleaned.slice(cursorLine, lom.index);
            cursorLine = cachedClose.index + cachedClose[0].length;
            lineOpenRe.lastIndex = cursorLine;
          }
          if (cursorLine > 0) cleaned = outLine + cleaned.slice(cursorLine);
        }

        // 3) 线性截断尾部悬空未闭块 (extraDangling)
        const isInDanglingBt = getCustomBtChecker();
        let lastCloseEnd = 0;
        if (hasAnyClose) {
          anyCloseRe.lastIndex = 0;
          let cm;
          while ((cm = anyCloseRe.exec(cleaned)) !== null) {
            if (!isInDanglingBt(cm.index)) {
              lastCloseEnd = cm.index + cm[0].length;
            }
          }
        }
        const danglingOpenRe = new RegExp(`(?:^|\\r?\\n)[ \\t]*<${safeTag}(?=[ \\t\\r\\n>])[^>]*>[ \\t]*(?:\\r?\\n|$)`, 'gi');
        danglingOpenRe.lastIndex = lastCloseEnd;
        let dm;
        while ((dm = danglingOpenRe.exec(cleaned)) !== null) {
          if (!isInDanglingBt(dm.index + dm[0].indexOf('<'))) {
            cleaned = cleaned.slice(0, dm.index);
            break;
          }
        }
      }
    }
  }

  if (options.trim) {
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  }

  return unmaskProtectedRegionsForThinking(cleaned, masks);
}

module.exports = {
  findNestedVcpInfoRanges,
  findClosedMarkdownFenceRanges,
  findClosedToolBlockRanges,
  findClosedFenceAndToolRanges,
  maskProtectedRegionsForThinking,
  unmaskProtectedRegionsForThinking,
  stripThoughtChainsSafe
};
