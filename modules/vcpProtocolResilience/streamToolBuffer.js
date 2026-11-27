'use strict';

/**
 * modules/vcpProtocolResilience/streamToolBuffer.js
 * 流式工具块短缓冲与确定性词法终裁状态机（零外部依赖、0ms 确定性）
 * - 正常正文、代码围栏、行内反引号与思考块 0 延迟透传
 * - 仅暂存顶层 TOOL_REQUEST 块，闭合即立刻一次性 flush
 * - 罕见流式盲区（行内 <think> / Case 6B 围栏/反引号 / HTML <code>）由 protocolLexer 上帝视角终裁
 */
const lexer = require('./protocolLexer');

const MAX_UNCLOSED_TOOL_RETRIES = 2;

const UNCLOSED_RETRY_PROMPT =
  '[系统提示] 检测到你上一条回复中的工具调用请求未正确闭合（缺少结束标记或 ESCAPE 转义未配对闭合），系统已拦截并丢弃该未闭合片段。请重新输出完整的闭合工具调用请求，确保开标、闭标以及 ESCAPE 转义首尾成对闭合；若无需调用工具，请直接回复用户。';

const UNCLOSED_MIXED_BATCH_NOTE =
  '[系统提示] 注意：你上一条回复末尾存在未闭合的工具调用片段，系统已自动丢弃该未闭合片段；本批已闭合的合法工具已正常执行。如需执行该未闭合的工具，请在下一轮重新输出完整闭合的工具请求。';

const MAX_TAIL_HOLD = 36;
const MAX_XML_THINK_PREFIX_HOLD = 128;
const PROTECT_DEFER_RE = /`|(?:^|\n)[ \t]{0,3}~{3,}|<\/?[ \t]*(?:pre|code|script|style|think(?:ing)?|thought(?:s)?|antthinking)\b|\[\[VCP|[【\[]\s*(?:\/|／|\\)?\s*VCP|\[系统提示:\]|<<<\[(?:VCP_TOOL_BATCH_|(?:END_)?ROLE_DIVIDE_)|<{2,4}\[(?:END_)?TOOL_REQUEST_ESCAPE\]>{2,4}|\[--- (?:VCP元思考链|元思考链结束 ---\])|\[OneRing通知:/i;
const VCP_THINK_OPEN_PREFIX = '[--- VCP元思考链';
const VCP_THINK_OPEN_RE = /^\[--- VCP元思考链(?::\s*"[^"]*")?\s*---\]/;
const VCP_THINK_CLOSE = '[--- 元思考链结束 ---]';
const XML_THINK_TAGS = ['think', 'thinking', 'thought', 'thoughts', 'antthinking'];
const XML_THINK_OPEN_RE = /^<[ \t]*(think(?:ing)?|thought(?:s)?|antthinking)(?=[ \t>])[^>\r\n<]*>/i;
const LINE_START_THINK_CLOSE_RE = /^[ \t]*(?:<[ \t]*\/[ \t]*(?:think(?:ing)?|thought(?:s)?|antthinking)[ \t]*>|\[--- 元思考链结束 ---\])/i;
const EMOTICON_PREFIX_TAILS = [
  { left: '(', right: '・ω・´)ゞ' },
  { left: '(', right: '・ω・´)' },
  { left: '(', right: '･ω･´)' },
  { left: '(・', right: 'ω´・)' }
];

function isPossibleXmlThinkOpenPrefix(slice) {
  if (!slice || slice[0] !== '<' || slice.length > MAX_XML_THINK_PREFIX_HOLD) return false;
  if (/[\r\n>]/.test(slice)) return false;
  const afterLt = slice.slice(1).replace(/^[ \t]*/, '');
  if (!afterLt) return true;
  if (afterLt.includes('<')) return false;
  const tagPart = afterLt.split(/[ \t]/)[0].toLowerCase();
  if (XML_THINK_TAGS.some(t => t.startsWith(tagPart))) return true;
  return XML_THINK_TAGS.some(t => new RegExp(`^${t}(?:[ \\t]|$)`, 'i').test(afterLt));
}

function isPossibleStandaloneThinkClosePrefix(slice) {
  if (!slice || slice.length > MAX_TAIL_HOLD || slice.includes("\n")) return false;
  const trimmed = slice.replace(/^[ \t]*/, "");
  if (!trimmed) return false;
  if (trimmed[0] === "<") {
    const afterLt = trimmed.slice(1).replace(/^[ \t]*/, "");
    if (!afterLt) return true;
    if (afterLt[0] !== "/") return false;
    const afterSlash = afterLt.slice(1).replace(/^[ \t]*/, "");
    if (!afterSlash) return true;
    const gtIdx = afterSlash.indexOf(">");
    if (gtIdx !== -1) {
      const tag = afterSlash.slice(0, gtIdx).trim().toLowerCase();
      const rest = afterSlash.slice(gtIdx + 1);
      return XML_THINK_TAGS.includes(tag) && /^[ \t\r]*$/.test(rest);
    }
    const lower = afterSlash.toLowerCase();
    return XML_THINK_TAGS.some(t => t.startsWith(lower) || (lower.startsWith(t) && /^[ \t]*$/.test(lower.slice(t.length))));
  }
  if (trimmed[0] === "[") {
    if (trimmed.length <= VCP_THINK_CLOSE.length) return VCP_THINK_CLOSE.startsWith(trimmed);
    return trimmed.startsWith(VCP_THINK_CLOSE) && /^[ \t\r]*$/.test(trimmed.slice(VCP_THINK_CLOSE.length));
  }
  return false;
}

function isPossibleVcpThinkOpenPrefix(slice) {
  if (!slice || slice[0] !== '[' || slice.length > 512) return false;
  if (slice.includes('\n')) return false;
  if (slice.length < VCP_THINK_OPEN_PREFIX.length) {
    return VCP_THINK_OPEN_PREFIX.startsWith(slice);
  }
  return slice.startsWith(VCP_THINK_OPEN_PREFIX) && !slice.includes('---]');
}

function isPossibleToolOpenPrefix(slice, fuzzy) {
  if (!slice || slice.length > MAX_TAIL_HOLD) return false;
  if (fuzzy) {
    const m = /^<{1,4}(?:\[(?:[A-Za-z_]*(?:\]>{0,4})?)?)?$/.exec(slice);
    if (!m) return false;
    const bracketIdx = slice.indexOf('[');
    if (bracketIdx === -1) return true;
    const inner = slice.slice(bracketIdx + 1);
    if (!inner) return true;
    const endBracket = inner.indexOf(']');
    const label = (endBracket === -1 ? inner : inner.slice(0, endBracket)).toUpperCase();
    return 'TOOL_REQUEST'.startsWith(label) || 'TOOL_REQUEST_ESCAPE'.startsWith(label);
  }
  return lexer.START_MARKER.startsWith(slice) || '<<<[TOOL_REQUEST_ESCAPE]>>>'.startsWith(slice);
}

function matchToolOpenAt(tail, fuzzy) {
  if (fuzzy) {
    const fm = new RegExp(`^${lexer.FUZZY_START_BLOCK_RE.source}`, 'i').exec(tail);
    return fm ? fm[0].length : 0;
  }
  return tail.startsWith(lexer.START_MARKER) ? lexer.START_MARKER.length : 0;
}

function matchToolEscapeOpenAt(tail, fuzzy) {
  if (fuzzy) {
    const fm = /^<{2,4}\[TOOL_REQUEST_ESCAPE\]>{2,4}/i.exec(tail);
    return fm ? fm[0].length : 0;
  }
  return tail.startsWith('<<<[TOOL_REQUEST_ESCAPE]>>>') ? '<<<[TOOL_REQUEST_ESCAPE]>>>'.length : 0;
}

function matchToolEscapeCloseAt(tail, fuzzy) {
  if (fuzzy) {
    const fm = /^<{2,4}\[END_TOOL_REQUEST_ESCAPE\]>{2,4}/i.exec(tail);
    return fm ? fm[0].length : 0;
  }
  return tail.startsWith('<<<[END_TOOL_REQUEST_ESCAPE]>>>') ? '<<<[END_TOOL_REQUEST_ESCAPE]>>>'.length : 0;
}

function isPossibleToolEscapeClosePrefix(slice, fuzzy) {
  if (!slice || slice.length > MAX_TAIL_HOLD) return false;
  if (fuzzy) {
    const m = /^<{1,4}(?:\[(?:[A-Za-z_]*(?:\]>{0,4})?)?)?$/.exec(slice);
    if (!m) return false;
    const bracketIdx = slice.indexOf('[');
    if (bracketIdx === -1) return true;
    const inner = slice.slice(bracketIdx + 1);
    if (!inner) return true;
    const endBracket = inner.indexOf(']');
    const label = (endBracket === -1 ? inner : inner.slice(0, endBracket)).toUpperCase();
    return 'END_TOOL_REQUEST_ESCAPE'.startsWith(label);
  }
  return '<<<[END_TOOL_REQUEST_ESCAPE]>>>'.startsWith(slice);
}

function findValidToolClose(buf, pos, fuzzy) {
  if (fuzzy) {
    const re = new RegExp(lexer.FUZZY_END_BLOCK_RE.source, 'gi');
    const m = lexer.execValidToolMarker(re, buf, pos);
    return m ? { index: m.index, length: m[0].length } : null;
  }
  let scan = pos;
  while (scan < buf.length) {
    const idx = buf.indexOf(lexer.END_MARKER, scan);
    if (idx === -1) return null;
    if (!lexer.hasAdjacentAngle(buf, idx, lexer.END_MARKER.length) &&
        !lexer.isQuotedSingleToolMarker(buf, idx, lexer.END_MARKER.length)) {
      return { index: idx, length: lexer.END_MARKER.length };
    }
    scan = idx + 1;
  }
  return null;
}

function findNextValidToolOpen(buf, pos, fuzzy, isEof) {
  const openRe = fuzzy ? new RegExp(lexer.FUZZY_START_BLOCK_RE.source, 'gi') : /<<<\[TOOL_REQUEST\]>>>/g;
  openRe.lastIndex = pos;
  let m;
  while ((m = openRe.exec(buf)) !== null) {
    const idx = m.index;
    const len = m[0].length;
    const prevCh = idx > 0 ? buf[idx - 1] : '';
    if (prevCh === '<') {
      openRe.lastIndex = idx + 1;
      continue;
    }
    const endPos = idx + len;
    if (endPos === buf.length && !isEof) {
      return { pendingAt: idx };
    }
    const nextCh = endPos < buf.length ? buf[endPos] : '';
    if (nextCh === '>' || (lexer.QUOTED_PAIR_MAP[prevCh] && lexer.QUOTED_PAIR_MAP[prevCh] === nextCh)) {
      openRe.lastIndex = idx + 1;
      continue;
    }
    return { index: idx, length: len };
  }
  if (!isEof) {
    let ltScan = Math.max(pos, buf.length - MAX_TAIL_HOLD);
    while (ltScan < buf.length) {
      const ltIdx = buf.indexOf('<', ltScan);
      if (ltIdx === -1) break;
      if (isPossibleToolOpenPrefix(buf.slice(ltIdx), fuzzy)) {
        return { pendingAt: ltIdx };
      }
      ltScan = ltIdx + 1;
    }
  }
  return null;
}

function isLogicalLineWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\uFEFF' || ch === '\u200B';
}

function findAreaAt(areas, idx) {
  return lexer.findEnclosingRange(idx, areas);
}

function findNextAreaFrom(areas, pos) {
  let lo = 0;
  let hi = areas.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (areas[mid].end <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo < areas.length ? areas[lo] : null;
}

function createStreamToolBuffer(options = {}) {
  const fuzzyToolMatching = Boolean(options && options.fuzzyToolMatching);

  let mode = 'PASS'; // 'PASS' | 'BUFFER_TOOL'
  let passCtx = 'PROSE'; // 'PROSE' | 'FENCE' | 'BACKTICK_LINE_HEAD' | 'INLINE_CODE' | 'XML_THINK' | 'VCP_THINK'
  let atLineStart = true;
  let atLogicalLineStart = true;
  let atWsOnlyLineStart = true;
  let fenceChar = '';
  let fenceLen = 0;
  let pendingFenceLen = 0;
  let backtickLineSawOtherBt = false;
  let inlineBtLen = 0;
  let inlineSawBlockMeta = false;
  let thinkTagName = '';
  let thinkDepth = 0;
  let thinkInnerFenceChar = '';
  let thinkInnerFenceLen = 0;
  let thinkInnerInlineBtLen = 0;
  let thinkPendingClose = false;
  let pendingThinkEscapeDefer = false;

  let pendingTail = '';
  let toolBufChunks = [];
  let toolBufLen = 0;
  let toolWin = '';
  let toolWinBase = 0;
  let toolBufAbsStart = 0;
  let toolScanPos = 0;
  let toolBufDeferToEof = false;
  let toolProtectScanPos = 0;
  let inEscape = false;
  let escapeOpenChar = '';

  let ctxHoldActive = false;
  let ctxHoldBuf = '';
  let ctxHoldAbsStart = 0;

  let hasClosedToolBlock = false;
  const closedToolAbsStarts = [];
  const droppedTexts = [];
  let recentEmitted = '';
  let finished = false;
  const cleanChunks = [];
  const rawChunks = [];
  let rawTotalLen = 0;
  let lexFloorAbs = 0;

  function emitText(str) {
    if (!str) return '';
    cleanChunks.push(str);
    recentEmitted = (recentEmitted + str).slice(-40);
    return str;
  }

  function prevCharAt(buf, idx) {
    if (idx > 0) return buf[idx - 1];
    return recentEmitted.length > 0 ? recentEmitted[recentEmitted.length - 1] : '';
  }

  function checkEmoticonBacktick(buf, idx, isEof) {
    const leftCtx = (ctxHoldActive ? (recentEmitted + ctxHoldBuf) : recentEmitted) + buf.slice(0, idx);
    const rightTail = buf.slice(idx + 1);
    for (const emo of EMOTICON_PREFIX_TAILS) {
      if (!leftCtx.endsWith(emo.left)) continue;
      if (rightTail.startsWith(emo.right)) return 'MATCH';
      if (!isEof && rightTail.length < emo.right.length && emo.right.startsWith(rightTail)) return 'HOLD';
    }
    return 'NONE';
  }

  function resetToolBufferState() {
    toolBufChunks = [];
    toolBufLen = 0;
    toolWin = '';
    toolWinBase = 0;
    toolBufAbsStart = 0;
    toolScanPos = 0;
    toolBufDeferToEof = false;
    toolProtectScanPos = 0;
    inEscape = false;
    escapeOpenChar = '';
  }

  function appendToolBuf(str) {
    if (!str) return;
    toolBufChunks.push(str);
    toolBufLen += str.length;
    if (!toolBufDeferToEof) {
      toolWin += str;
    }
  }

  function trimToolWin() {
    if (toolBufDeferToEof) {
      toolWin = '';
      return;
    }
    const safeFrom = inEscape
      ? Math.max(0, toolScanPos - 4)
      : Math.max(0, Math.min(toolScanPos, Math.max(0, toolProtectScanPos - 48)) - 4);
    if (safeFrom > toolWinBase + 256) {
      const drop = safeFrom - toolWinBase;
      toolWin = toolWin.slice(drop);
      toolWinBase = safeFrom;
    }
  }

  function flushOrBufferPass(emitted, hold, rest, closedCtx) {
    if (!ctxHoldActive) {
      return { emitted, hold, rest };
    }
    if (closedCtx) {
      const out = ctxHoldBuf + emitted;
      ctxHoldActive = false;
      ctxHoldBuf = '';
      ctxHoldAbsStart = 0;
      return { emitted: out, hold, rest };
    }
    if (emitted) ctxHoldBuf += emitted;
    return { emitted: '', hold, rest };
  }

  function promoteCtxHoldToBufferTool(buf, resetCtxState) {
    resetToolBufferState();
    mode = 'BUFFER_TOOL';
    toolBufAbsStart = ctxHoldAbsStart;
    toolBufDeferToEof = true;
    appendToolBuf(ctxHoldBuf);
    appendToolBuf(buf);
    ctxHoldActive = false;
    ctxHoldBuf = '';
    ctxHoldAbsStart = 0;
    passCtx = 'PROSE';
    resetCtxState();
    return { emitted: '', hold: '', rest: '' };
  }

  function tryStartCtxHoldAtToolOpen(buf, i, isEof) {
    const tail = buf.slice(i);
    const prevCh = prevCharAt(buf, i);
    const openMatchLen = matchToolOpenAt(tail, fuzzyToolMatching);
    if (openMatchLen > 0) {
      const adjacentAngle = prevCh === '<' || (i + openMatchLen < buf.length && buf[i + openMatchLen] === '>');
      if (!adjacentAngle) {
        if (i + openMatchLen === buf.length && !isEof) {
          return { action: 'HOLD', tail };
        }
        const rightCh = i + openMatchLen < buf.length ? buf[i + openMatchLen] : '';
        if (lexer.QUOTED_PAIR_MAP[prevCh] && lexer.QUOTED_PAIR_MAP[prevCh] === rightCh) {
          return { action: 'SKIP', len: openMatchLen };
        }
        ctxHoldActive = true;
        ctxHoldAbsStart = rawTotalLen - tail.length;
        ctxHoldBuf = '';
        return { action: 'TRIGGER', tail };
      }
    } else if (!isEof && isPossibleToolOpenPrefix(tail, fuzzyToolMatching)) {
      return { action: 'HOLD', tail };
    }
    return null;
  }

  function stepPassProse(buf, isEof) {
    let i = 0;
    let curLineStart = atLineStart;
    let curLogicalLineStart = atLogicalLineStart;
    let curWsOnlyLineStart = atWsOnlyLineStart;

    while (i < buf.length) {
      if (curLineStart) {
        const spaceMatch = /^[ \t]{0,3}/.exec(buf.slice(i));
        const spLen = spaceMatch ? spaceMatch[0].length : 0;
        const afterSp = i + spLen;

        if (afterSp === buf.length) {
          if (!isEof && spLen > 0) {
            atLineStart = curLineStart;
            atLogicalLineStart = curLogicalLineStart;
            atWsOnlyLineStart = curWsOnlyLineStart;
            return { emitted: buf.slice(0, i), hold: buf.slice(i), rest: '' };
          }
          break;
        }

        const fch = buf[afterSp];
        if (fch === '`' || fch === '~') {
          let runEnd = afterSp;
          while (runEnd < buf.length && buf[runEnd] === fch) runEnd++;
          const runLen = runEnd - afterSp;

          if (runEnd === buf.length && !isEof && buf.length - i <= MAX_TAIL_HOLD) {
            atLineStart = curLineStart;
            atLogicalLineStart = curLogicalLineStart;
            atWsOnlyLineStart = curWsOnlyLineStart;
            return { emitted: buf.slice(0, i), hold: buf.slice(i), rest: '' };
          }

          if (runLen >= 3) {
            if (fch === '~') {
              passCtx = 'FENCE';
              fenceChar = '~';
              fenceLen = runLen;
              atLineStart = false;
              atLogicalLineStart = false;
            atWsOnlyLineStart = false;
              return { emitted: buf.slice(0, runEnd), hold: '', rest: buf.slice(runEnd) };
            }
            passCtx = 'BACKTICK_LINE_HEAD';
            pendingFenceLen = runLen;
            backtickLineSawOtherBt = false;
            atLineStart = false;
            atLogicalLineStart = false;
            atWsOnlyLineStart = false;
            return { emitted: buf.slice(0, runEnd), hold: '', rest: buf.slice(runEnd) };
          }
        }
      }

      const ch = buf[i];

      if (ch === '`') {
        let runEnd = i;
        while (runEnd < buf.length && buf[runEnd] === '`') runEnd++;
        const runLen = runEnd - i;

        if (runEnd === buf.length && !isEof && buf.length - i <= MAX_TAIL_HOLD) {
          atLineStart = curLineStart;
          atLogicalLineStart = curLogicalLineStart;
            atWsOnlyLineStart = curWsOnlyLineStart;
          return { emitted: buf.slice(0, i), hold: buf.slice(i), rest: '' };
        }

        if (runLen === 1) {
          const emoState = checkEmoticonBacktick(buf, i, isEof);
          if (emoState === 'HOLD') {
            atLineStart = curLineStart;
            atLogicalLineStart = curLogicalLineStart;
            atWsOnlyLineStart = curWsOnlyLineStart;
            return { emitted: buf.slice(0, i), hold: buf.slice(i), rest: '' };
          }
          if (emoState === 'MATCH') {
            curLineStart = false;
            curLogicalLineStart = false;
        curWsOnlyLineStart = false;
            i = runEnd;
            continue;
          }
        }

        passCtx = 'INLINE_CODE';
        inlineBtLen = runLen;
        inlineSawBlockMeta = false;
        atLineStart = false;
        atLogicalLineStart = false;
            atWsOnlyLineStart = false;
        return { emitted: buf.slice(0, runEnd), hold: '', rest: buf.slice(runEnd) };
      }

      if (ch === '<') {
        const tail = buf.slice(i);
        const prevCh = prevCharAt(buf, i);
        const openMatchLen = matchToolOpenAt(tail, fuzzyToolMatching);
        const escOpenMatchLen = openMatchLen > 0 ? 0 : matchToolEscapeOpenAt(tail, fuzzyToolMatching);
        if (openMatchLen > 0) {
          const adjacentAngle = prevCh === '<' || (i + openMatchLen < buf.length && buf[i + openMatchLen] === '>');
          if (!adjacentAngle) {
            if (i + openMatchLen === buf.length && !isEof) {
              atLineStart = curLineStart;
              atLogicalLineStart = curLogicalLineStart;
            atWsOnlyLineStart = curWsOnlyLineStart;
              return { emitted: buf.slice(0, i), hold: tail, rest: '' };
            }
            const rightCh = i + openMatchLen < buf.length ? buf[i + openMatchLen] : '';
            if (lexer.QUOTED_PAIR_MAP[prevCh] && lexer.QUOTED_PAIR_MAP[prevCh] === rightCh) {
              i += openMatchLen;
              curLineStart = false;
              curLogicalLineStart = false;
              curWsOnlyLineStart = false;
        curWsOnlyLineStart = false;
              continue;
            }
            const deferFromThinkEscape = pendingThinkEscapeDefer;
            pendingThinkEscapeDefer = false;
            resetToolBufferState();
            mode = 'BUFFER_TOOL';
            if (deferFromThinkEscape) {
              toolBufDeferToEof = true;
            }
            appendToolBuf(tail);
            toolBufAbsStart = rawTotalLen - tail.length;
            toolScanPos = openMatchLen;
            toolProtectScanPos = openMatchLen;
            atLineStart = false;
            atLogicalLineStart = false;
            atWsOnlyLineStart = false;
            return { emitted: buf.slice(0, i), hold: '', rest: '' };
          }
        } else if (escOpenMatchLen > 0) {
          const adjacentAngle = prevCh === '<' || (i + escOpenMatchLen < buf.length && buf[i + escOpenMatchLen] === '>');
          if (!adjacentAngle) {
            if (i + escOpenMatchLen === buf.length && !isEof) {
              atLineStart = curLineStart;
              atLogicalLineStart = curLogicalLineStart;
            atWsOnlyLineStart = curWsOnlyLineStart;
              return { emitted: buf.slice(0, i), hold: tail, rest: '' };
            }
            const rightCh = i + escOpenMatchLen < buf.length ? buf[i + escOpenMatchLen] : '';
            if (lexer.QUOTED_PAIR_MAP[prevCh] && lexer.QUOTED_PAIR_MAP[prevCh] === rightCh) {
              i += escOpenMatchLen;
              curLineStart = false;
              curLogicalLineStart = false;
              curWsOnlyLineStart = false;
        curWsOnlyLineStart = false;
              continue;
            }
            passCtx = 'TOOL_ESCAPE';
            atLineStart = false;
            atLogicalLineStart = false;
            atWsOnlyLineStart = false;
            const endPos = i + escOpenMatchLen;
            return { emitted: buf.slice(0, endPos), hold: '', rest: buf.slice(endPos) };
          }
        } else if (!isEof && isPossibleToolOpenPrefix(tail, fuzzyToolMatching)) {
          atLineStart = curLineStart;
          atLogicalLineStart = curLogicalLineStart;
            atWsOnlyLineStart = curWsOnlyLineStart;
          return { emitted: buf.slice(0, i), hold: tail, rest: '' };
        }

        if (curWsOnlyLineStart) {
          const thinkM = XML_THINK_OPEN_RE.exec(tail);
          if (thinkM) {
            passCtx = 'XML_THINK';
            thinkTagName = thinkM[1].toLowerCase();
            thinkDepth = 1;
            thinkInnerFenceChar = '';
            thinkInnerFenceLen = 0;
            thinkInnerInlineBtLen = 0;
            thinkPendingClose = false;
            const endPos = i + thinkM[0].length;
            atLineStart = false;
            atLogicalLineStart = false;
            atWsOnlyLineStart = false;
            return { emitted: buf.slice(0, endPos), hold: '', rest: buf.slice(endPos) };
          }
          if (!isEof && isPossibleXmlThinkOpenPrefix(tail)) {
            atLineStart = curLineStart;
            atLogicalLineStart = curLogicalLineStart;
            atWsOnlyLineStart = curWsOnlyLineStart;
            return { emitted: buf.slice(0, i), hold: tail, rest: '' };
          }
        }
      } else if (ch === '[' && curWsOnlyLineStart) {
        const tail = buf.slice(i);
        const vcpOpenM = VCP_THINK_OPEN_RE.exec(tail);
        if (vcpOpenM) {
          const afterOpen = tail.slice(vcpOpenM[0].length);
          const nlIdx = afterOpen.indexOf('\n');
          if (nlIdx === -1) {
            if (/^[ \t\r]*$/.test(afterOpen)) {
              if (!isEof && afterOpen.length <= 128) {
                atLineStart = curLineStart;
                atLogicalLineStart = curLogicalLineStart;
            atWsOnlyLineStart = curWsOnlyLineStart;
                return { emitted: buf.slice(0, i), hold: tail, rest: '' };
              }
              passCtx = 'VCP_THINK';
              thinkDepth = 0;
              thinkInnerFenceChar = '';
              thinkInnerFenceLen = 0;
              thinkInnerInlineBtLen = 0;
              thinkPendingClose = false;
              atLineStart = false;
              atLogicalLineStart = false;
            atWsOnlyLineStart = false;
              return { emitted: buf, hold: '', rest: '' };
            }
          } else if (/^[ \t\r]*$/.test(afterOpen.slice(0, nlIdx))) {
            const endPos = i + vcpOpenM[0].length + nlIdx + 1;
            passCtx = 'VCP_THINK';
            thinkDepth = 0;
            thinkInnerFenceChar = '';
            thinkInnerFenceLen = 0;
            thinkInnerInlineBtLen = 0;
            thinkPendingClose = false;
            atLineStart = true;
            atLogicalLineStart = true;
            atWsOnlyLineStart = true;
            return { emitted: buf.slice(0, endPos), hold: '', rest: buf.slice(endPos) };
          }
        } else if (!isEof && isPossibleVcpThinkOpenPrefix(tail)) {
          atLineStart = curLineStart;
          atLogicalLineStart = curLogicalLineStart;
            atWsOnlyLineStart = curWsOnlyLineStart;
          return { emitted: buf.slice(0, i), hold: tail, rest: '' };
        }
      }

      if (ch === '\n') {
        curLineStart = true;
        curLogicalLineStart = true;
        curWsOnlyLineStart = true;
      } else {
        if (ch !== '\r') curLineStart = false;
        if (ch !== ' ' && ch !== '\t' && ch !== '\r') curWsOnlyLineStart = false;
        if (!isLogicalLineWs(ch)) curLogicalLineStart = false;
      }
      i++;
    }

    atLineStart = curLineStart;
    atLogicalLineStart = curLogicalLineStart;
            atWsOnlyLineStart = curWsOnlyLineStart;
    return { emitted: buf, hold: '', rest: '' };
  }

  function stepPassBacktickLineHead(buf, isEof) {
    let i = 0;
    while (i < buf.length) {
      const ch = buf[i];
      if (ch === '\n') {
        if (!backtickLineSawOtherBt) {
          passCtx = 'FENCE';
          fenceChar = '`';
          fenceLen = pendingFenceLen;
          pendingFenceLen = 0;
          backtickLineSawOtherBt = false;
          atLineStart = true;
          atLogicalLineStart = true;
          atWsOnlyLineStart = true;
          return flushOrBufferPass(buf.slice(0, i + 1), '', buf.slice(i + 1), false);
        }
        passCtx = 'INLINE_CODE';
        inlineBtLen = pendingFenceLen;
        inlineSawBlockMeta = false;
        pendingFenceLen = 0;
        backtickLineSawOtherBt = false;
        atLineStart = true;
        atLogicalLineStart = true;
          atWsOnlyLineStart = true;
        return flushOrBufferPass(buf.slice(0, i + 1), '', buf.slice(i + 1), false);
      }
      if (ch === '`') {
        let runEnd = i;
        while (runEnd < buf.length && buf[runEnd] === '`') runEnd++;
        if (runEnd === buf.length && !isEof && buf.length - i <= MAX_TAIL_HOLD) {
          return flushOrBufferPass(buf.slice(0, i), buf.slice(i), '', false);
        }
        if (runEnd - i === pendingFenceLen) {
          passCtx = 'PROSE';
          pendingFenceLen = 0;
          backtickLineSawOtherBt = false;
          atLineStart = false;
          atLogicalLineStart = false;
          atWsOnlyLineStart = false;
          return flushOrBufferPass(buf.slice(0, runEnd), '', buf.slice(runEnd), true);
        }
        backtickLineSawOtherBt = true;
        i = runEnd;
        continue;
      }
      if (!ctxHoldActive && ch === '<') {
        const res = tryStartCtxHoldAtToolOpen(buf, i, isEof);
        if (res) {
          if (res.action === 'HOLD') return { emitted: buf.slice(0, i), hold: res.tail, rest: '' };
          if (res.action === 'SKIP') { i += res.len; continue; }
          return { emitted: buf.slice(0, i), hold: '', rest: res.tail };
        }
      }
      i++;
    }
    return flushOrBufferPass(buf, '', '', false);
  }

  function stepPassInlineCode(buf, isEof) {
    let i = 0;
    let curLineStart = atLineStart;
    const exitInlineToProseOrPromote = (pos, restSlice, nextLineStart = true) => {
      if (ctxHoldActive) {
        return promoteCtxHoldToBufferTool(buf, () => {
          inlineBtLen = 0;
          inlineSawBlockMeta = false;
        });
      }
      passCtx = "PROSE";
      inlineBtLen = 0;
      inlineSawBlockMeta = false;
      atLineStart = nextLineStart;
      atLogicalLineStart = nextLineStart;
      atWsOnlyLineStart = nextLineStart;
      return { emitted: buf.slice(0, pos), hold: "", rest: restSlice };
    };
    const getCurLineIndent = (pos) => {
      let indent = 0;
      let k = pos - 1;
      while (k >= 0 && (buf[k] === " " || buf[k] === "\t")) {
        indent++;
        k--;
      }
      if (k < 0) {
        const pre = ctxHoldActive ? ctxHoldBuf : recentEmitted;
        let pk = pre.length - 1;
        while (pk >= 0 && (pre[pk] === " " || pre[pk] === "\t")) {
          indent++;
          pk--;
        }
        if (pk >= 0 && pre[pk] !== "\n") return 4;
      } else if (buf[k] !== "\n") {
        return 4;
      }
      return indent;
    };
    const VCP_INFO_OPEN = "[[VCP调用结果信息汇总:";
    const BATCH_START = "<<<[VCP_TOOL_BATCH_START:";
    const ROLE_DIVIDE_PREFIX = "<<<[ROLE_DIVIDE_";

    while (i < buf.length) {
      const ch = buf[i];
      if (curLineStart) {
        if (ch === " " || ch === "\t" || ch === "\r") {
          i++;
          continue;
        }
        if (ch === "\n") {
          return exitInlineToProseOrPromote(i + 1, buf.slice(i + 1), true);
        }
        if ((ch === "`" || ch === "~") && getCurLineIndent(i) <= 3) {
          let runEnd = i;
          while (runEnd < buf.length && buf[runEnd] === ch) runEnd++;
          const runLen = runEnd - i;
          if (runEnd === buf.length && !isEof && buf.length - i <= MAX_TAIL_HOLD) {
            atLineStart = curLineStart;
            return flushOrBufferPass(buf.slice(0, i), buf.slice(i), "", false);
          }
          if (runLen >= 3) {
            if (ch === "~") {
              inlineSawBlockMeta = true;
              curLineStart = false;
              i = runEnd;
              continue;
            }
            if (runLen !== inlineBtLen) {
              const nlIdx = buf.indexOf("\n", runEnd);
              if (nlIdx === -1) {
                if (!buf.slice(runEnd).includes("`")) {
                  if (!isEof && buf.length - i <= MAX_TAIL_HOLD) {
                    atLineStart = curLineStart;
                    return flushOrBufferPass(buf.slice(0, i), buf.slice(i), "", false);
                  }
                  inlineSawBlockMeta = true;
                  curLineStart = false;
                  i = runEnd;
                  continue;
                }
              } else if (!buf.slice(runEnd, nlIdx).includes("`")) {
                inlineSawBlockMeta = true;
                curLineStart = false;
                i = runEnd;
                continue;
              }
            }
          }
        }
        if (ch === "<" || ch === "[") {
          const tail = buf.slice(i);
          const closeLineM = LINE_START_THINK_CLOSE_RE.exec(tail);
          if (closeLineM) {
            return exitInlineToProseOrPromote(i, tail, true);
          }
          if (!isEof && isPossibleStandaloneThinkClosePrefix(tail)) {
            atLineStart = curLineStart;
            return flushOrBufferPass(buf.slice(0, i), tail, "", false);
          }
          if (ch === "<" && inlineBtLen <= 2) {
            const openLen = matchToolOpenAt(tail, fuzzyToolMatching);
            if (openLen > 0) {
              const prevCh = prevCharAt(buf, i);
              const adjacentAngle = prevCh === "<" || (i + openLen < buf.length && buf[i + openLen] === ">");
              if (!adjacentAngle) {
                const afterOpen = tail.slice(openLen);
                if (!isEof && !afterOpen.includes("\n") && /^[ \t\r]*$/.test(afterOpen) && afterOpen.length <= MAX_TAIL_HOLD) {
                  atLineStart = curLineStart;
                  return flushOrBufferPass(buf.slice(0, i), tail, "", false);
                }
                if (/^[ \t]*(?:\r?\n|$)/.test(afterOpen)) {
                  return exitInlineToProseOrPromote(i, tail, true);
                }
              }
            } else if (!isEof && isPossibleToolOpenPrefix(tail, fuzzyToolMatching)) {
              atLineStart = curLineStart;
              return flushOrBufferPass(buf.slice(0, i), tail, "", false);
            }
          }
        }
      }

      if (!inlineSawBlockMeta && ch === "[") {
        const tail = buf.slice(i);
        if (tail.startsWith(VCP_INFO_OPEN)) {
          inlineSawBlockMeta = true;
          curLineStart = false;
          i += VCP_INFO_OPEN.length;
          continue;
        }
        if (!isEof && tail.length < VCP_INFO_OPEN.length && VCP_INFO_OPEN.startsWith(tail)) {
          atLineStart = curLineStart;
          return flushOrBufferPass(buf.slice(0, i), tail, "", false);
        }
      } else if (!inlineSawBlockMeta && ch === "<") {
        const tail = buf.slice(i);
        if (tail.startsWith(BATCH_START)) {
          inlineSawBlockMeta = true;
          curLineStart = false;
          i += BATCH_START.length;
          continue;
        }
        if (tail.startsWith(ROLE_DIVIDE_PREFIX)) {
          inlineSawBlockMeta = true;
          curLineStart = false;
          i += ROLE_DIVIDE_PREFIX.length;
          continue;
        }
        if (!isEof && tail.length <= MAX_TAIL_HOLD &&
            ((tail.length < BATCH_START.length && BATCH_START.startsWith(tail)) ||
             (tail.length < ROLE_DIVIDE_PREFIX.length && ROLE_DIVIDE_PREFIX.startsWith(tail)))) {
          atLineStart = curLineStart;
          return flushOrBufferPass(buf.slice(0, i), tail, "", false);
        }
      }

      if (ch === "`") {
        let runEnd = i;
        while (runEnd < buf.length && buf[runEnd] === "`") runEnd++;
        if (runEnd === buf.length && !isEof && buf.length - i <= MAX_TAIL_HOLD) {
          atLineStart = curLineStart;
          return flushOrBufferPass(buf.slice(0, i), buf.slice(i), "", false);
        }
        if (runEnd - i === inlineBtLen) {
          if (inlineBtLen === 1) {
            const emoState = checkEmoticonBacktick(buf, i, isEof);
            if (emoState === "HOLD") {
              atLineStart = curLineStart;
              return flushOrBufferPass(buf.slice(0, i), buf.slice(i), "", false);
            }
            if (emoState === "MATCH") {
              curLineStart = false;
              i = runEnd;
              continue;
            }
          }
          if (inlineSawBlockMeta && ctxHoldActive) {
            return promoteCtxHoldToBufferTool(buf, () => {
              inlineBtLen = 0;
              inlineSawBlockMeta = false;
            });
          }
          passCtx = "PROSE";
          inlineBtLen = 0;
          inlineSawBlockMeta = false;
          atLineStart = false;
          atLogicalLineStart = false;
          atWsOnlyLineStart = false;
          return flushOrBufferPass(buf.slice(0, runEnd), "", buf.slice(runEnd), true);
        }
        curLineStart = false;
        i = runEnd;
        continue;
      }

      if (!ctxHoldActive && ch === "<") {
        const res = tryStartCtxHoldAtToolOpen(buf, i, isEof);
        if (res) {
          if (res.action === "HOLD") {
            atLineStart = curLineStart;
            return { emitted: buf.slice(0, i), hold: res.tail, rest: "" };
          }
          if (res.action === "SKIP") {
            curLineStart = false;
            i += res.len;
            continue;
          }
          atLineStart = curLineStart;
          return { emitted: buf.slice(0, i), hold: "", rest: res.tail };
        }
      }

      if (ch === "\n") curLineStart = true;
      else if (ch !== "\r") curLineStart = false;
      i++;
    }

    atLineStart = curLineStart;
    return flushOrBufferPass(buf, "", "", false);
  }

  function stepPassFence(buf, isEof) {
    let i = 0;
    let curLineStart = atLineStart;

    while (i < buf.length) {
      if (curLineStart) {
        const spaceMatch = /^[ \t]{0,3}/.exec(buf.slice(i));
        const spLen = spaceMatch ? spaceMatch[0].length : 0;
        const afterSp = i + spLen;

        if (afterSp === buf.length) {
          if (!isEof && spLen > 0) {
            atLineStart = curLineStart;
            return flushOrBufferPass(buf.slice(0, i), buf.slice(i), '', false);
          }
          break;
        }

        if (buf[afterSp] === fenceChar) {
          let runEnd = afterSp;
          while (runEnd < buf.length && buf[runEnd] === fenceChar) runEnd++;
          const runLen = runEnd - afterSp;

          if (runEnd === buf.length && !isEof && buf.length - i <= MAX_TAIL_HOLD) {
            atLineStart = curLineStart;
            return flushOrBufferPass(buf.slice(0, i), buf.slice(i), '', false);
          }

          if (runLen >= fenceLen) {
            const nlIdx = buf.indexOf('\n', runEnd);
            if (nlIdx === -1) {
              if (/^[ \t\r]*$/.test(buf.slice(runEnd))) {
                if (!isEof && buf.length - i <= MAX_TAIL_HOLD) {
                  atLineStart = curLineStart;
                  return flushOrBufferPass(buf.slice(0, i), buf.slice(i), '', false);
                }
                passCtx = 'PROSE';
                fenceChar = '';
                fenceLen = 0;
                atLineStart = false;
                atLogicalLineStart = false;
          atWsOnlyLineStart = false;
                return flushOrBufferPass(buf, '', '', true);
              }
            } else if (/^[ \t\r]*$/.test(buf.slice(runEnd, nlIdx))) {
              const endPos = nlIdx + 1;
              passCtx = 'PROSE';
              fenceChar = '';
              fenceLen = 0;
              atLineStart = true;
              atLogicalLineStart = true;
          atWsOnlyLineStart = true;
              return flushOrBufferPass(buf.slice(0, endPos), '', buf.slice(endPos), true);
            }
          }
        }
      }

      if (!ctxHoldActive && buf[i] === '<') {
        const res = tryStartCtxHoldAtToolOpen(buf, i, isEof);
        if (res) {
          if (res.action === 'HOLD') {
            atLineStart = curLineStart;
            return { emitted: buf.slice(0, i), hold: res.tail, rest: '' };
          }
          if (res.action === 'SKIP') {
            curLineStart = false;
            i += res.len;
            continue;
          }
          atLineStart = curLineStart;
          return { emitted: buf.slice(0, i), hold: '', rest: res.tail };
        }
      }

      if (buf[i] === '\n') curLineStart = true;
      else if (buf[i] !== '\r') curLineStart = false;
      i++;
    }

    atLineStart = curLineStart;
    return flushOrBufferPass(buf, '', '', false);
  }

  function stepPassToolEscape(buf, isEof) {
    let i = 0;
    let curLineStart = atLineStart;

    while (i < buf.length) {
      const ch = buf[i];
      if (ch === '<') {
        const tail = buf.slice(i);
        const prevCh = i > 0
          ? buf[i - 1]
          : (ctxHoldActive && ctxHoldBuf.length > 0 ? ctxHoldBuf[ctxHoldBuf.length - 1] : prevCharAt(buf, 0));
        const closeMatchLen = matchToolEscapeCloseAt(tail, fuzzyToolMatching);
        if (closeMatchLen > 0) {
          const adjacentAngle = prevCh === '<' || (i + closeMatchLen < buf.length && buf[i + closeMatchLen] === '>');
          if (!adjacentAngle) {
            if (i + closeMatchLen === buf.length && !isEof) {
              atLineStart = curLineStart;
              return flushOrBufferPass(buf.slice(0, i), tail, '', false);
            }
            const rightCh = i + closeMatchLen < buf.length ? buf[i + closeMatchLen] : '';
            if (lexer.QUOTED_PAIR_MAP[prevCh] && lexer.QUOTED_PAIR_MAP[prevCh] === rightCh) {
              curLineStart = false;
              i += closeMatchLen;
              continue;
            }
            const endPos = i + closeMatchLen;
            passCtx = 'PROSE';
            atLineStart = false;
            atLogicalLineStart = false;
          atWsOnlyLineStart = false;
            return flushOrBufferPass(buf.slice(0, endPos), '', buf.slice(endPos), true);
          }
        } else if (!isEof && isPossibleToolEscapeClosePrefix(tail, fuzzyToolMatching)) {
          atLineStart = curLineStart;
          return flushOrBufferPass(buf.slice(0, i), tail, '', false);
        }

        if (!ctxHoldActive) {
          const res = tryStartCtxHoldAtToolOpen(buf, i, isEof);
          if (res) {
            if (res.action === 'HOLD') {
              atLineStart = curLineStart;
              return { emitted: buf.slice(0, i), hold: res.tail, rest: '' };
            }
            if (res.action === 'SKIP') {
              curLineStart = false;
              i += res.len;
              continue;
            }
            atLineStart = curLineStart;
            return { emitted: buf.slice(0, i), hold: '', rest: res.tail };
          }
        }
      }

      if (ch === '\n') curLineStart = true;
      else if (ch !== '\r') curLineStart = false;
      i++;
    }

    atLineStart = curLineStart;
    return flushOrBufferPass(buf, '', '', false);
  }

  function stepPassThink(buf, isEof, isVcp) {
    let i = 0;
    let curLineStart = atLineStart;
    let curLogicalLineStart = atLogicalLineStart;
    const xmlOpenRe = isVcp ? null : new RegExp(`^<[ \\t]*${thinkTagName}(?=[ \\t>])[^>\\r\\n<]*>`, 'i');
    const xmlCloseRe = isVcp ? null : new RegExp(`^<[ \\t]*/[ \\t]*${thinkTagName}[ \\t]*>`, 'i');

    const exitThinkToProse = (endPos, nextLineStart, deferNextTool = false) => {
      if (deferNextTool) pendingThinkEscapeDefer = true;
      passCtx = 'PROSE';
      thinkTagName = '';
      thinkDepth = 0;
      thinkInnerFenceChar = '';
      thinkInnerFenceLen = 0;
      thinkInnerInlineBtLen = 0;
      thinkPendingClose = false;
      atLineStart = nextLineStart;
      atLogicalLineStart = nextLineStart;
      atWsOnlyLineStart = nextLineStart;
      return { emitted: buf.slice(0, endPos), hold: '', rest: buf.slice(endPos) };
    };

    while (i < buf.length) {
      if (!thinkInnerFenceChar && thinkInnerInlineBtLen > 0 && curLineStart) {
        const blankM = /^[ \t\r]*\n/.exec(buf.slice(i));
        if (blankM) {
          thinkInnerInlineBtLen = 0;
          if (thinkPendingClose) return exitThinkToProse(i + blankM[0].length, true);
          curLineStart = true;
          curLogicalLineStart = true;
          i += blankM[0].length;
          continue;
        }
        if (!isEof && /^[ \t\r]+$/.test(buf.slice(i)) && buf.length - i <= MAX_TAIL_HOLD) {
          atLineStart = curLineStart;
          atLogicalLineStart = curLogicalLineStart;
          return { emitted: buf.slice(0, i), hold: buf.slice(i), rest: '' };
        }
      }

      if (curLineStart) {
        const spaceMatch = /^[ \t]{0,3}/.exec(buf.slice(i));
        const spLen = spaceMatch ? spaceMatch[0].length : 0;
        const afterSp = i + spLen;

        if (afterSp === buf.length) {
          if (!isEof && spLen > 0) {
            atLineStart = curLineStart;
            atLogicalLineStart = curLogicalLineStart;
            return { emitted: buf.slice(0, i), hold: buf.slice(i), rest: '' };
          }
          break;
        }

        const fch = buf[afterSp];
        if (!thinkInnerFenceChar && thinkInnerInlineBtLen === 0 && (fch === '`' || fch === '~')) {
          let runEnd = afterSp;
          while (runEnd < buf.length && buf[runEnd] === fch) runEnd++;
          const runLen = runEnd - afterSp;

          if (runEnd === buf.length && !isEof && buf.length - i <= MAX_TAIL_HOLD) {
            atLineStart = curLineStart;
            atLogicalLineStart = curLogicalLineStart;
            return { emitted: buf.slice(0, i), hold: buf.slice(i), rest: '' };
          }

          if (runLen >= 3) {
            if (fch === '~') {
              thinkInnerFenceChar = '~';
              thinkInnerFenceLen = runLen;
              curLineStart = false;
              curLogicalLineStart = false;
              i = runEnd;
              continue;
            }
            const nlIdx = buf.indexOf('\n', runEnd);
            if (nlIdx === -1) {
              if (!buf.slice(runEnd).includes('`')) {
                if (!isEof && buf.length - i <= MAX_TAIL_HOLD) {
                  atLineStart = curLineStart;
                  atLogicalLineStart = curLogicalLineStart;
                  return { emitted: buf.slice(0, i), hold: buf.slice(i), rest: '' };
                }
                thinkInnerFenceChar = '`';
                thinkInnerFenceLen = runLen;
                curLineStart = false;
                curLogicalLineStart = false;
                i = runEnd;
                continue;
              }
            } else if (!buf.slice(runEnd, nlIdx).includes('`')) {
              thinkInnerFenceChar = '`';
              thinkInnerFenceLen = runLen;
              curLineStart = false;
              curLogicalLineStart = false;
              i = runEnd;
              continue;
            }
          }
        } else if (thinkInnerFenceChar && fch === thinkInnerFenceChar) {
          let runEnd = afterSp;
          while (runEnd < buf.length && buf[runEnd] === thinkInnerFenceChar) runEnd++;
          if (runEnd === buf.length && !isEof && buf.length - i <= MAX_TAIL_HOLD) {
            atLineStart = curLineStart;
            atLogicalLineStart = curLogicalLineStart;
            return { emitted: buf.slice(0, i), hold: buf.slice(i), rest: '' };
          }
          if (runEnd - afterSp >= thinkInnerFenceLen) {
            const nlIdx = buf.indexOf('\n', runEnd);
            if (nlIdx === -1) {
              if (/^[ \t\r]*$/.test(buf.slice(runEnd))) {
                if (!isEof && buf.length - i <= MAX_TAIL_HOLD) {
                  atLineStart = curLineStart;
                  atLogicalLineStart = curLogicalLineStart;
                  return { emitted: buf.slice(0, i), hold: buf.slice(i), rest: '' };
                }
                thinkInnerFenceChar = '';
                thinkInnerFenceLen = 0;
              }
            } else if (/^[ \t\r]*$/.test(buf.slice(runEnd, nlIdx))) {
              thinkInnerFenceChar = '';
              thinkInnerFenceLen = 0;
              curLineStart = true;
              curLogicalLineStart = true;
              i = nlIdx + 1;
              continue;
            }
          }
        }
      }

      const ch = buf[i];
      const tail = buf.slice(i);

      if (!thinkInnerFenceChar && ch === '`') {
        let runEnd = i;
        while (runEnd < buf.length && buf[runEnd] === '`') runEnd++;
        const runLen = runEnd - i;
        if (runEnd === buf.length && !isEof && buf.length - i <= MAX_TAIL_HOLD) {
          atLineStart = curLineStart;
          atLogicalLineStart = curLogicalLineStart;
          return { emitted: buf.slice(0, i), hold: buf.slice(i), rest: '' };
        }
        if (thinkInnerInlineBtLen === 0) {
          if (runLen === 1) {
            const emoState = checkEmoticonBacktick(buf, i, isEof);
            if (emoState === 'HOLD') {
              atLineStart = curLineStart;
              atLogicalLineStart = curLogicalLineStart;
              return { emitted: buf.slice(0, i), hold: buf.slice(i), rest: '' };
            }
            if (emoState === 'MATCH') {
              curLineStart = false;
              curLogicalLineStart = false;
              i = runEnd;
              continue;
            }
          }
          thinkInnerInlineBtLen = runLen;
          curLineStart = false;
          curLogicalLineStart = false;
          i = runEnd;
          continue;
        }
        if (runLen === thinkInnerInlineBtLen) {
          if (runLen === 1) {
            const emoState = checkEmoticonBacktick(buf, i, isEof);
            if (emoState === 'HOLD') {
              atLineStart = curLineStart;
              atLogicalLineStart = curLogicalLineStart;
              return { emitted: buf.slice(0, i), hold: buf.slice(i), rest: '' };
            }
            if (emoState === 'MATCH') {
              curLineStart = false;
              curLogicalLineStart = false;
              i = runEnd;
              continue;
            }
          }
          thinkInnerInlineBtLen = 0;
        }
        curLineStart = false;
        curLogicalLineStart = false;
        i = runEnd;
        continue;
      }

      if (!isVcp && ch === '<') {
        if (!thinkInnerFenceChar && thinkInnerInlineBtLen === 0) {
          const om = xmlOpenRe.exec(tail);
          if (om) {
            thinkDepth += 1;
            curLineStart = false;
            curLogicalLineStart = false;
            i += om[0].length;
            continue;
          }
        }
        const m = xmlCloseRe.exec(tail);
        if (m) {
          if (!thinkInnerFenceChar && thinkInnerInlineBtLen === 0) {
            thinkDepth -= 1;
            if (thinkDepth <= 0) return exitThinkToProse(i + m[0].length, false);
            curLineStart = false;
            curLogicalLineStart = false;
            i += m[0].length;
            continue;
          }
          if (!thinkInnerFenceChar && thinkInnerInlineBtLen > 0 && curLogicalLineStart) {
            thinkInnerInlineBtLen = 0;
            thinkPendingClose = false;
            thinkDepth -= 1;
            if (thinkDepth <= 0) return exitThinkToProse(i + m[0].length, false);
            curLineStart = false;
            curLogicalLineStart = false;
            i += m[0].length;
            continue;
          }
          thinkPendingClose = true;
          curLineStart = false;
          curLogicalLineStart = false;
          i += m[0].length;
          continue;
        }
        if (!isEof) {
          if ((!thinkInnerFenceChar && thinkInnerInlineBtLen === 0 && isPossibleXmlThinkOpenPrefix(tail)) ||
              (tail.length <= MAX_TAIL_HOLD && /^<[ \t]*(?:\/[ \t]*(?:[a-zA-Z]*[ \t]*)?)?$/.test(tail))) {
            atLineStart = curLineStart;
            atLogicalLineStart = curLogicalLineStart;
            return { emitted: buf.slice(0, i), hold: tail, rest: '' };
          }
        }
      } else if (isVcp && ch === '[' && curLogicalLineStart) {
        if (tail.startsWith(VCP_THINK_CLOSE)) {
          if (!thinkInnerFenceChar) {
            thinkInnerInlineBtLen = 0;
            thinkPendingClose = false;
            return exitThinkToProse(i + VCP_THINK_CLOSE.length, false);
          }
          thinkPendingClose = true;
          curLineStart = false;
          curLogicalLineStart = false;
          i += VCP_THINK_CLOSE.length;
          continue;
        }
        if (!isEof && tail.length < VCP_THINK_CLOSE.length && VCP_THINK_CLOSE.startsWith(tail)) {
          atLineStart = curLineStart;
          atLogicalLineStart = curLogicalLineStart;
          return { emitted: buf.slice(0, i), hold: tail, rest: '' };
        }
      }

      if (thinkPendingClose && ch === '<') {
        const openMatchLen = matchToolOpenAt(tail, fuzzyToolMatching);
        const prevCh = prevCharAt(buf, i);
        if (openMatchLen > 0) {
          const adjacentAngle = prevCh === '<' || (i + openMatchLen < buf.length && buf[i + openMatchLen] === '>');
          if (!adjacentAngle) {
            if (i + openMatchLen === buf.length && !isEof) {
              atLineStart = curLineStart;
              atLogicalLineStart = curLogicalLineStart;
              return { emitted: buf.slice(0, i), hold: tail, rest: '' };
            }
            return exitThinkToProse(i, curLineStart, true);
          }
        } else if (!isEof && isPossibleToolOpenPrefix(tail, fuzzyToolMatching)) {
          atLineStart = curLineStart;
          atLogicalLineStart = curLogicalLineStart;
          return { emitted: buf.slice(0, i), hold: tail, rest: '' };
        }
      }

      if (ch === '\n') {
        curLineStart = true;
        curLogicalLineStart = true;
      } else {
        if (ch !== '\r') curLineStart = false;
        if (!isLogicalLineWs(ch)) curLogicalLineStart = false;
      }
      i++;
    }

    atLineStart = curLineStart;
    atLogicalLineStart = curLogicalLineStart;
    return { emitted: buf, hold: '', rest: '' };
  }

  function hasDeferredProtectBefore(endPos) {
    const from = Math.max(toolWinBase, toolProtectScanPos - 48);
    if (endPos <= from) return false;
    return PROTECT_DEFER_RE.test(toolWin.slice(from - toolWinBase, endPos - toolWinBase));
  }

  function stepToolBuffer(isEof) {
    if (toolBufDeferToEof) {
      return { flushed: "", rest: "" };
    }
    while (toolScanPos < toolBufLen) {
      const scanFrom = toolScanPos;
      const localScanFrom = Math.max(0, scanFrom - toolWinBase);
      if (inEscape) {
        const closeEsc = lexer.findNextEscapeToken(toolWin, localScanFrom, true, fuzzyToolMatching, escapeOpenChar);
        if (closeEsc) {
          inEscape = false;
          escapeOpenChar = "";
          toolScanPos = toolWinBase + closeEsc.index + closeEsc.length;
          toolProtectScanPos = Math.max(toolProtectScanPos, toolScanPos);
          trimToolWin();
          continue;
        }
        toolScanPos = Math.max(scanFrom, toolBufLen - 12);
        trimToolWin();
        return { flushed: "", rest: "" };
      }

      const escM = lexer.findNextEscapeToken(toolWin, localScanFrom, false, fuzzyToolMatching);
      const escIdx = escM ? toolWinBase + escM.index : -1;
      const closeMatch = findValidToolClose(toolWin, localScanFrom, fuzzyToolMatching);
      const closeIdx = closeMatch ? toolWinBase + closeMatch.index : -1;
      const openInfo = findNextValidToolOpen(toolWin, localScanFrom, fuzzyToolMatching, isEof);
      const nextOpen = openInfo && openInfo.index !== undefined
        ? { index: toolWinBase + openInfo.index, length: openInfo.length }
        : null;

      if (nextOpen && (closeIdx === -1 || nextOpen.index < closeIdx) && (escIdx === -1 || nextOpen.index < escIdx)) {
        toolBufDeferToEof = true;
        toolWin = "";
        return { flushed: "", rest: "" };
      }

      if (escIdx !== -1 && (closeIdx === -1 || escIdx < closeIdx)) {
        if (hasDeferredProtectBefore(escIdx)) {
          toolBufDeferToEof = true;
          toolWin = "";
          return { flushed: "", rest: "" };
        }
        inEscape = true;
        escapeOpenChar = toolWin[escIdx - toolWinBase];
        toolScanPos = escIdx + escM.length;
        trimToolWin();
        continue;
      }

      if (closeIdx !== -1) {
        if (hasDeferredProtectBefore(closeIdx)) {
          toolBufDeferToEof = true;
          toolWin = "";
          return { flushed: "", rest: "" };
        }
        const closeEnd = closeIdx + closeMatch.length;
        if (closeEnd === toolBufLen && !isEof) {
          toolScanPos = Math.min(scanFrom, closeIdx);
          trimToolWin();
          return { flushed: "", rest: "" };
        }
        const fullToolBuf = toolBufChunks.join("");
        const absCloseEnd = toolBufAbsStart + closeEnd;
        const flushed = fullToolBuf.slice(0, closeEnd);
        const rest = fullToolBuf.slice(closeEnd);
        lexFloorAbs = absCloseEnd;
        closedToolAbsStarts.push(toolBufAbsStart);
        resetToolBufferState();
        hasClosedToolBlock = true;
        mode = "PASS";
        passCtx = "PROSE";
        atLineStart = flushed.length > 0 && flushed[flushed.length - 1] === "\n";
        atLogicalLineStart = atLineStart;
        atWsOnlyLineStart = atLineStart;
        return { flushed, rest };
      }

      if (hasDeferredProtectBefore(toolBufLen)) {
        toolBufDeferToEof = true;
        toolWin = "";
        return { flushed: "", rest: "" };
      }
      toolProtectScanPos = Math.max(toolProtectScanPos, toolBufLen);

      if (openInfo && openInfo.pendingAt !== undefined) {
        toolScanPos = Math.min(scanFrom, toolWinBase + openInfo.pendingAt);
        trimToolWin();
        return { flushed: "", rest: "" };
      }

      toolScanPos = Math.max(scanFrom, toolBufLen - MAX_TAIL_HOLD);
      trimToolWin();
      return { flushed: "", rest: "" };
    }
    trimToolWin();
    return { flushed: "", rest: "" };
  }

  function isCrossClosedToolFalseInlineThink(text, area, floorAbs) {
    if (!area || area.type !== 'THINK' || floorAbs <= 0 || area.start >= floorAbs) {
      return false;
    }
    const openLineStart = area.start === 0 ? 0 : text.lastIndexOf('\n', area.start - 1) + 1;
    if (/^[ \t]*$/.test(text.slice(openLineStart, area.start))) return false;
    const closeStart = text.lastIndexOf('</', area.end - 1);
    if (closeStart < area.start) return false;
    const closeLineStart = closeStart === 0 ? 0 : text.lastIndexOf('\n', closeStart - 1) + 1;
    return !/^[ \t]*$/.test(text.slice(closeLineStart, closeStart));
  }

  function findFullTextToolEnd(text, afterOpenPos, areas, lexHints = null, stopAreas = null) {
    const validClosedEnd = lexer.scanClosedToolBlockEnd(text, afterOpenPos, lexHints, { fuzzyToolMatching });
    const endArea = validClosedEnd > 0 ? findAreaAt(areas, validClosedEnd - 1) : null;
    const isExternalEndArea = Boolean(endArea && (endArea.start < afterOpenPos || endArea.end > validClosedEnd));
    if (validClosedEnd > 0 && !isExternalEndArea) {
      return { closedEnd: validClosedEnd, dropEnd: -1 };
    }

    const openRe = fuzzyToolMatching ? new RegExp(lexer.FUZZY_START_BLOCK_RE.source, 'gi') : /<<<\[TOOL_REQUEST\]>>>/g;
    let nextIdx = -1;
    let saScan = afterOpenPos;
    while (saScan < text.length) {
      const cand = lexer.execValidToolMarker(openRe, text, saScan, lexHints, 'bufOpen');
      if (!cand) break;
      const inArea = findAreaAt(areas, cand.index + cand[0].length - 1);
      if (!inArea) {
        let ls = cand.index;
        let onlyWs = true;
        while (ls > 0) {
          const ch = text[ls - 1];
          if (ch === '\n') break;
          if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\uFEFF' && ch !== '\u200B') {
            onlyWs = false;
            break;
          }
          ls--;
        }
        nextIdx = onlyWs ? ls : cand.index;
        break;
      }
      saScan = inArea.end;
    }

    const stopList = stopAreas || areas.filter(a => a.type !== 'INLINE_CODE');
    let nextAreaStop = text.length;
    let lo = 0;
    let hi = stopList.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (stopList[mid].start < afterOpenPos) lo = mid + 1;
      else hi = mid;
    }
    if (lo < stopList.length) {
      nextAreaStop = stopList[lo].start;
    }

    const dropEnd = nextIdx !== -1 ? Math.min(nextIdx, nextAreaStop) : nextAreaStop;
    return { closedEnd: -1, dropEnd };
  }

  function arbitrateBufferAtFinish() {
    const fullRawText = rawChunks.join('');
    const rawAreas = lexer.findProtectionAreas(fullRawText, { fuzzyToolMatching, allowHeadlessThinkReset: false });
    const areas = lexFloorAbs > 0
      ? rawAreas.filter(a => !isCrossClosedToolFalseInlineThink(fullRawText, a, lexFloorAbs))
      : rawAreas;
    const openRe = fuzzyToolMatching ? new RegExp(lexer.FUZZY_START_BLOCK_RE.source, 'gi') : /<<<\[TOOL_REQUEST\]>>>/g;
    const stopAreas = areas.filter(a => a.type !== 'INLINE_CODE');
    const lexHints = {};
    let pos = toolBufAbsStart;
    let emitted = '';
    let dropped = false;
    let arbitrateFoundClosed = false;
    let pendingDropLineSep = '';
    const flushPendingDropLineSep = () => {
      if (pendingDropLineSep) {
        emitted += emitText(pendingDropLineSep);
        pendingDropLineSep = '';
      }
    };

    while (pos < fullRawText.length) {
      const curArea = findAreaAt(areas, pos);
      if (curArea) {
        flushPendingDropLineSep();
        emitted += emitText(fullRawText.slice(pos, curArea.end));
        pos = curArea.end;
        continue;
      }
      const nextOpen = lexer.execValidToolMarker(openRe, fullRawText, pos, lexHints, 'arbOpen');
      const nextArea = findNextAreaFrom(areas, pos);

      if (!nextOpen) {
        const tail = fullRawText.slice(pos);
        if (tail) {
          flushPendingDropLineSep();
          emitted += emitText(tail);
        }
        break;
      }
      if (nextArea && nextArea.start <= nextOpen.index) {
        flushPendingDropLineSep();
        if (nextArea.start > pos) emitted += emitText(fullRawText.slice(pos, nextArea.start));
        emitted += emitText(fullRawText.slice(nextArea.start, nextArea.end));
        pos = nextArea.end;
        continue;
      }
      if (nextOpen.index > pos) {
        flushPendingDropLineSep();
        emitted += emitText(fullRawText.slice(pos, nextOpen.index));
      }
      if (lexer.isQuotedSingleToolMarker(fullRawText, nextOpen.index, nextOpen[0].length)) {
        flushPendingDropLineSep();
        const qEnd = nextOpen.index + nextOpen[0].length;
        emitted += emitText(fullRawText.slice(nextOpen.index, qEnd));
        pos = qEnd;
        continue;
      }
      const scanRes = findFullTextToolEnd(fullRawText, nextOpen.index + nextOpen[0].length, areas, lexHints, stopAreas);
      if (scanRes.closedEnd !== -1) {
        flushPendingDropLineSep();
        emitted += emitText(fullRawText.slice(nextOpen.index, scanRes.closedEnd));
        arbitrateFoundClosed = true;
        pos = scanRes.closedEnd;
      } else {
        dropped = true;
        let effectiveDropEnd = scanRes.dropEnd;
        if (
          nextOpen.index > 0 &&
          fullRawText[nextOpen.index - 1] !== '\n' &&
          effectiveDropEnd > nextOpen.index &&
          effectiveDropEnd < fullRawText.length &&
          fullRawText[effectiveDropEnd - 1] === '\n'
        ) {
          const sepStart = (effectiveDropEnd - 2 >= nextOpen.index && fullRawText[effectiveDropEnd - 2] === '\r')
            ? effectiveDropEnd - 2
            : effectiveDropEnd - 1;
          if (!pendingDropLineSep) {
            pendingDropLineSep = fullRawText.slice(sepStart, effectiveDropEnd);
          }
          effectiveDropEnd = sepStart;
        }
        if (droppedTexts.length < 64) {
          droppedTexts.push(fullRawText.slice(nextOpen.index, effectiveDropEnd));
        }
        pos = scanRes.dropEnd;
      }
    }

    hasClosedToolBlock = arbitrateFoundClosed || closedToolAbsStarts.some(s => !findAreaAt(areas, s));
    resetToolBufferState();
    mode = 'PASS';
    passCtx = 'PROSE';
    return { emitted, dropped };
  }

  function processInput(input, isEof) {
    let out = '';
    let rest = input;
    if (input.length > 0) {
      rawChunks.push(input);
      rawTotalLen += input.length;
    }
    let toolNeedsScan = mode === 'BUFFER_TOOL';

    while (rest.length > 0 || toolNeedsScan || (mode === 'PASS' && pendingTail.length > 0)) {
      if (mode === 'BUFFER_TOOL') {
        if (rest.length > 0) {
          appendToolBuf(rest);
          rest = '';
        }
        const tbRes = stepToolBuffer(isEof);
        toolNeedsScan = false;
        if (tbRes.flushed) out += emitText(tbRes.flushed);
        if (tbRes.rest) rest = tbRes.rest;
        if (mode === 'BUFFER_TOOL' && !rest) break;
        continue;
      }

      const buf = pendingTail + rest;
      pendingTail = '';
      rest = '';
      if (!buf) break;

      let stepRes;
      if (passCtx === 'PROSE') stepRes = stepPassProse(buf, isEof);
      else if (passCtx === 'BACKTICK_LINE_HEAD') stepRes = stepPassBacktickLineHead(buf, isEof);
      else if (passCtx === 'INLINE_CODE') stepRes = stepPassInlineCode(buf, isEof);
      else if (passCtx === 'FENCE') stepRes = stepPassFence(buf, isEof);
      else if (passCtx === 'TOOL_ESCAPE') stepRes = stepPassToolEscape(buf, isEof);
      else stepRes = stepPassThink(buf, isEof, passCtx === 'VCP_THINK');

      if (stepRes.emitted) out += emitText(stepRes.emitted);
      pendingTail = stepRes.hold || '';
      rest = stepRes.rest || '';
      if (mode === 'BUFFER_TOOL') toolNeedsScan = true;
      if (!rest && !toolNeedsScan && mode === 'PASS') break;
    }

    return out;
  }

  function push(chunk) {
    if (finished || chunk === null || chunk === undefined) return '';
    const str = typeof chunk === 'string' ? chunk : String(chunk);
    return str ? processInput(str, false) : '';
  }

  function finish(finishOptions = {}) {
    if (finished) {
      return {
        emittedTail: '',
        droppedUnclosedToolBlock: false,
        droppedText: '',
        cleanContent: cleanChunks.join(''),
        hasClosedToolBlock
      };
    }
    finished = true;
    const exemptUnclosed = Boolean(finishOptions && finishOptions.exemptUnclosed);

    let emittedTail = processInput('', true);
    let droppedAtEof = false;

    if (ctxHoldActive) {
      if (exemptUnclosed) {
        emittedTail += emitText(ctxHoldBuf);
        ctxHoldActive = false;
        ctxHoldBuf = '';
        ctxHoldAbsStart = 0;
      } else {
        promoteCtxHoldToBufferTool('', () => {
          fenceChar = '';
          fenceLen = 0;
          pendingFenceLen = 0;
          backtickLineSawOtherBt = false;
          inlineBtLen = 0;
          inlineSawBlockMeta = false;
        });
      }
    }

    if (mode === 'BUFFER_TOOL') {
      if (exemptUnclosed) {
        emittedTail += emitText(toolBufChunks.join(''));
      } else {
        const arb = arbitrateBufferAtFinish();
        emittedTail += arb.emitted;
        droppedAtEof = arb.dropped;
      }
      resetToolBufferState();
      mode = 'PASS';
    }
    pendingThinkEscapeDefer = false;

    const droppedUnclosedToolBlock = !exemptUnclosed && droppedAtEof;
    return {
      emittedTail,
      droppedUnclosedToolBlock,
      droppedText: droppedTexts.join('\n'),
      cleanContent: cleanChunks.join(''),
      hasClosedToolBlock
    };
  }

  return { push, finish };
}

function stripUnclosedToolBlocks(text, options = {}) {
  if (typeof text !== 'string' || !text) {
    return { cleanContent: text || '', droppedUnclosedToolBlock: false, droppedText: '', hasClosedToolBlock: false };
  }
  const buffer = createStreamToolBuffer(options);
  const streamed = buffer.push(text);
  const fin = buffer.finish(options);
  return {
    cleanContent: streamed + fin.emittedTail,
    droppedUnclosedToolBlock: fin.droppedUnclosedToolBlock,
    droppedText: fin.droppedText,
    hasClosedToolBlock: fin.hasClosedToolBlock
  };
}

module.exports = {
  MAX_UNCLOSED_TOOL_RETRIES,
  UNCLOSED_RETRY_PROMPT,
  UNCLOSED_MIXED_BATCH_NOTE,
  createStreamToolBuffer,
  stripUnclosedToolBlocks
};
