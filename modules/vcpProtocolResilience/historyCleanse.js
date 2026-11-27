'use strict';

/**
 * modules/vcpProtocolResilience/historyCleanse.js
 * 
 * Batch 4: 03_细则 轮间历史清洗模块
 * 
 * 职责：
 * 1. 真人边界（P3）：调用 messageProcessor.findLastRealUserMessage 确定真人边界 lastRealHumanIndex。
 *    支持纯多模态附件（无文本）真实用户消息兜底识别。>= lastRealHumanIndex 的活跃轮内消息 100% 保持原样不动。
 * 2. 多模态与元数据继承：兼容 string 与 array content，完整继承非文本分片与附加属性（如 cache_control）。
 *    使用 copyArrayMetadata 深度保留 messages.__oneRingMeta 与 Symbol 元数据，包括 msg.content 自身属性。
 * 3. 楼层级（Floor Level）正文置空安全防御：多模态分片禁止局部独立判空，统一在消息楼层级别判空并填入占位符。
 * 4. 统一倒序切片数学（防坐标漂移与首字符吞噬）：坏块删除区间与 ROLE_DIVIDE_USER 替换/删除区间归入统一 edits 列表，
 *    通过 applyEdits 升序合并重叠/相邻区间，再降序切片拼接，杜绝后随代码首字符吞噬。
 * 5. 严格身份与状态认证的纠偏块识别：定义 isRealGuidanceBlock，必须为 VCP 虚拟错误回执且闭合，
 *    绝不抓取业务工具（如 SourceReader）返回文档/代码中的字面量凭条，杜绝假指纹误触发 P6 失败安全。
 * 6. 顶层 ROLE_DIVIDE_USER 系统药丸铁律：严格遵循 04_细则 3.2 铁律，只有位于顶层 ROLE_DIVIDE_USER 外壳内的药丸
 *    才视作系统药丸，正文或代码块中解释 VCP 规范的内容 100% 完整保护，绝不被误判抹除。
 * 7. 药丸闭标定界截取与列表项安全隔离：Section IV 防错警示仅在药丸闭标前截取，且仅吸收 - 【 开头的已知警示，
 *    绝不泄漏业务列表项，与已知错误归一化去重，彻底保障绝对幂等性。
 * 8. 摘要解析鲁棒兼容：支持分号及换行/Markdown 列表格式的工具调用摘要精准解析与重拼。
 * 9. 独立纯函数 stripErrorBlocksAndReceiptsFromText：供下游 foldingHelper 净化未洗复印件，绝不插入药丸或占位符。
 */

const { findLastRealUserMessage, isMetaThinkingV3Message } = require('../messageProcessor');
const diagnoser = require('./diagnoser');
const guidanceAssembler = require('./guidanceAssembler');
const { createBatchStartScanner } = require('../toolResultBatch');
const { isResilienceEnabled } = require('./spans');
const { findNestedVcpInfoRanges: findVcpInfoRanges, findClosedFenceAndToolRanges, findEnclosingRange } = require('./protocolLexer');

/**
 * 用户拍板规范：纠偏指导回执匹配正则
 */
const RECEIPT_REGEX = /\[\[VCP协议纠偏指导:\s*code=([A-Z0-9_]+)\s+block=([a-zA-Z0-9_-]+)\]\]/g;

/**
 * 无状态单次测试正则（防 /g lastIndex 污染）
 */
const RECEIPT_TEST_REGEX = /\[\[VCP协议纠偏指导:\s*code=([A-Z0-9_]+)\s+block=([a-zA-Z0-9_-]+)\]\]/i;

function createReceiptGlobalRegex() {
  return new RegExp(RECEIPT_REGEX.source, "g");
}

const PILL_OPEN_CORE_RE = /(?:[【\[［]\s*系统提示\s*[:：]\s*[】\]］]\s*)?[【\[［]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］]/gi;
const PILL_CLOSE_CORE_RE = /[【\[［]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］]/gi;
const PILL_OPEN_STRIP_RE = /[ \t]*(?:[【\[［]\s*系统提示\s*[:：]\s*[】\]］]\s*)?[【\[［]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］]/gi;
const PILL_CLOSE_STRIP_RE = /[【\[［]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］][ \t]*/gi;

function findPillRangesLinear(text, includeHorizontalWs = false) {
  if (typeof text !== 'string' || !text || !text.includes('VCP')) return [];
  const closeCheck = new RegExp(PILL_CLOSE_CORE_RE.source, 'i');
  if (!closeCheck.test(text)) return [];

  const openRe = new RegExp((includeHorizontalWs ? PILL_OPEN_STRIP_RE : PILL_OPEN_CORE_RE).source, 'gi');
  const closeRe = new RegExp((includeHorizontalWs ? PILL_CLOSE_STRIP_RE : PILL_CLOSE_CORE_RE).source, 'gi');
  const ranges = [];
  let openM;
  let cachedCloseM;

  while ((openM = openRe.exec(text)) !== null) {
    const afterOpen = openM.index + openM[0].length;
    if (cachedCloseM === undefined || (cachedCloseM !== null && cachedCloseM.index < afterOpen)) {
      closeRe.lastIndex = afterOpen;
      cachedCloseM = closeRe.exec(text);
    }
    if (!cachedCloseM) break;
    const endPos = cachedCloseM.index + cachedCloseM[0].length;
    ranges.push({ start: openM.index, end: endPos });
    openRe.lastIndex = endPos;
  }
  return ranges;
}

function hasLinearPillInText(text) {
  return findPillRangesLinear(text, false).length > 0;
}

function createPillGlobalRegex() {
  return /(?:[【\[［]\s*系统提示\s*[:：]\s*[】\]］]\s*)?[【\[［]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］][\s\S]*?[【\[［]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］]/gi;
}

/**
 * OneRing 行内通知尾标正则
 */
const ONERING_REGEX = /\[OneRing通知:[^\]]*\]/g;

/**
 * 全错楼层正文置空安全占位文本（防止主流 API 报 400 且防堵死 roleDivider）
 */
const EMPTY_FLOOR_PLACEHOLDER = '(上轮未执行的异常工具调用已略去)';

/**
 * 反向查找已知错误提醒词对应的错误代码
 */
const REMINDER_LINE_TO_KEY = new Map();
if (guidanceAssembler && guidanceAssembler.SPECIALIZED_REMINDERS_MAP) {
  for (const [key, reminder] of Object.entries(guidanceAssembler.SPECIALIZED_REMINDERS_MAP)) {
    if (typeof reminder === 'string') {
      REMINDER_LINE_TO_KEY.set(reminder.trim(), key);
    }
  }
}

/**
 * 环境变量门控检查，同时支持 options.enabled 传参覆盖
 * 兼容 ENABLE_TOOL_PROTOCOL_RESILIENCE 与 VCP_PROTOCOL_RESILIENCE_ENABLED，默认关闭（需显式开启）
 * @param {Object} [options]
 * @returns {boolean}
 */
// 门控逻辑统一复用 ./spans.js 中的 isResilienceEnabled

/**
 * 完整复制数组对象上的不可枚举属性（如 __oneRingMeta 与 Symbol 元数据）
 * @param {Array} source
 * @param {Array} target
 * @returns {Array}
 */
function copyArrayMetadata(source, target) {
  if (!Array.isArray(source) || !Array.isArray(target)) return target;

  for (const key of Reflect.ownKeys(source)) {
    if (typeof key === 'string' && /^(?:length|\d+)$/.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    try {
      Object.defineProperty(target, key, descriptor);
    } catch (e) {
      // 容错兜底
    }
  }

  return target;
}

/**
 * 扫描所有 <<<[ROLE_DIVIDE_USER]>>> ... <<<[END_ROLE_DIVIDE_USER]>>> 批次回执区间
 * 严格屏蔽内部嵌套的 VCP_INFO 结果块（防止工具返回代码字面量导致提前闭合）
 * @param {string} text
 * @returns {Array<Object>}
 */
function mergeDisjointRanges(ranges) {
  if (!ranges || ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    const prev = merged[merged.length - 1];
    if (r.start <= prev.end) {
      if (r.end > prev.end) prev.end = r.end;
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  return merged;
}

function buildProtectedSkipRanges(text, infoRanges = null, protectRoleDivider = false) {
  const resolvedInfoRanges = infoRanges || findVcpInfoRanges(text);
  const fenceAndToolRanges = findClosedFenceAndToolRanges(text, {
    opaqueRanges: resolvedInfoRanges,
    protectRoleDivider
  });
  const fenceToolRaw = [];
  const rawSkips = [];
  for (let i = 0; i < resolvedInfoRanges.length; i++) {
    rawSkips.push({ start: resolvedInfoRanges[i].start, end: resolvedInfoRanges[i].end });
  }
  for (let i = 0; i < fenceAndToolRanges.length; i++) {
    const r = fenceAndToolRanges[i];
    if (r.kind === 'fence' || r.kind === 'tool' || r.kind === 'tool_escape') {
      const span = { start: r.start, end: r.end };
      fenceToolRaw.push(span);
      rawSkips.push(span);
    }
  }
  return {
    infoRanges: resolvedInfoRanges,
    fenceToolRanges: mergeDisjointRanges(fenceToolRaw),
    skipRanges: mergeDisjointRanges(rawSkips)
  };
}

function findRoleDivideUserEnvelopes(text) {
  const START_TAG = '<<<[ROLE_DIVIDE_USER]>>>';
  const END_TAG = '<<<[END_ROLE_DIVIDE_USER]>>>';

  if (typeof text !== 'string' || !text.includes(START_TAG) || !text.includes(END_TAG)) {
    return [];
  }

  const { skipRanges } = buildProtectedSkipRanges(text, null, true);

  const lastEndPos = text.lastIndexOf(END_TAG);
  const envelopes = [];
  let cursor = 0;
  while (cursor <= lastEndPos) {
    const s = text.indexOf(START_TAG, cursor);
    if (s === -1 || s > lastEndPos) break;
    const hitSkip = findEnclosingRange(s, skipRanges);
    if (hitSkip) {
      cursor = Math.max(s + START_TAG.length, hitSkip.end);
      continue;
    }
    let e = s + START_TAG.length;
    let foundEnd = -1;
    while (e <= lastEndPos) {
      const candidate = text.indexOf(END_TAG, e);
      if (candidate === -1) break;
      const matchingSkip = findEnclosingRange(candidate, skipRanges);
      if (matchingSkip) {
        e = matchingSkip.end;
      } else {
        foundEnd = candidate + END_TAG.length;
        break;
      }
    }
    if (foundEnd !== -1) {
      envelopes.push({
        start: s,
        end: foundEnd,
        rawText: text.slice(s, foundEnd),
        bodyStart: s + START_TAG.length,
        bodyEnd: foundEnd - END_TAG.length,
        bodyText: text.slice(s + START_TAG.length, foundEnd - END_TAG.length)
      });
      cursor = foundEnd;
    } else {
      break;
    }
  }
  return envelopes;
}

/**
 * 严格判定某个 VCP_INFO 结果块是否属于真正的 VCP 协议纠偏回执
 * 必须包含 RECEIPT_TEST_REGEX，且工具名称为 VCP工具调用或状态为 ERROR，且必须包含闭标 [[/VCP协议纠偏指导]]
 * 杜绝正常业务工具（如 SourceReader）读取的文档/代码字面量被误判为纠偏块
 * @param {string} infoText
 * @returns {boolean}
 */
function isRealGuidanceBlock(infoText) {
  if (typeof infoText !== 'string' || !infoText) return false;
  if (!RECEIPT_TEST_REGEX.test(infoText)) return false;
  const isVcpTool = /工具名称:\s*VCP工具调用/i.test(infoText);
  const isErrorStatus = /执行状态:\s*❌\s*ERROR/i.test(infoText);
  const hasClose = infoText.includes('[[/VCP协议纠偏指导]]');
  const hasSingleLine = /\[\[VCP协议纠偏指导:\s*code=[A-Z0-9_]+\s+block=[a-zA-Z0-9_-]+\]\]/i.test(infoText);
  return (isVcpTool || isErrorStatus) && (hasClose || hasSingleLine);
}

/**
 * 将 innerInfoRanges 覆盖的保护区间原地替换为等长空格，保持字符下标 1:1 映射
 * 防止保护区内的字面量药丸标题跨界桥接吞噬保护区外的真实药丸
 * @param {string} bodyText
 * @param {Array<{ start: number, end: number }>} innerInfoRanges
 * @returns {string}
 */
function maskInnerInfoRangesWithSpaces(bodyText, innerInfoRanges) {
  if (typeof bodyText !== 'string' || !bodyText || !Array.isArray(innerInfoRanges) || innerInfoRanges.length === 0) {
    return bodyText || '';
  }
  const len = bodyText.length;
  const sorted = innerInfoRanges
    .map(r => ({
      start: Math.max(0, Math.min(len, r.start)),
      end: Math.max(0, Math.min(len, r.end))
    }))
    .filter(r => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return bodyText;

  let out = '';
  let cursor = 0;
  for (const r of sorted) {
    if (r.start > cursor) {
      out += bodyText.slice(cursor, r.start);
    }
    const maskStart = Math.max(cursor, r.start);
    if (r.end > maskStart) {
      out += ' '.repeat(r.end - maskStart);
      cursor = r.end;
    }
  }
  if (cursor < len) {
    out += bodyText.slice(cursor);
  }
  return out;
}

/**
 * 在等长空白掩码串上执行顶层药丸/标签匹配，返回原始坐标与原切片文本
 * @param {string} bodyText
 * @param {Array<{ start: number, end: number }>} innerInfoRanges
 * @param {RegExp} pillRegex
 * @returns {Array<{ start: number, end: number, text: string }>}
 */
function overlapsSortedRange(sortedRanges, start, end) {
  let lo = 0;
  let hi = sortedRanges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const r = sortedRanges[mid];
    if (end <= r.start) {
      hi = mid - 1;
    } else if (start >= r.end) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

function hasEndpointInSortedRanges(sortedRanges, start, end) {
  return Boolean(
    findEnclosingRange(start, sortedRanges) ||
    (end > start && findEnclosingRange(end - 1, sortedRanges))
  );
}

function findTopLevelPillMatches(bodyText, innerInfoRanges, pillRegex, outerContainerRanges = null) {
  if (typeof bodyText !== 'string' || !bodyText || !pillRegex) return [];
  const hasInfoRanges = Array.isArray(innerInfoRanges) && innerInfoRanges.length > 0;
  const sortedInfoRanges = hasInfoRanges
    ? [...innerInfoRanges].sort((a, b) => a.start - b.start || a.end - b.end)
    : null;
  const hasOuterRanges = Array.isArray(outerContainerRanges) && outerContainerRanges.length > 0;
  const sortedOuterRanges = hasOuterRanges ? mergeDisjointRanges(outerContainerRanges) : null;
  let maskedBody = bodyText;
  if (hasInfoRanges || hasOuterRanges) {
    const maskRanges = hasInfoRanges && hasOuterRanges
      ? mergeDisjointRanges([...sortedInfoRanges, ...sortedOuterRanges])
      : (sortedInfoRanges || sortedOuterRanges);
    maskedBody = maskInnerInfoRangesWithSpaces(bodyText, maskRanges);
  }
  const matches = [];

  const isRejected = (start, end) => (
    (hasInfoRanges && overlapsSortedRange(sortedInfoRanges, start, end)) ||
    (hasOuterRanges && hasEndpointInSortedRanges(sortedOuterRanges, start, end))
  );

  if (pillRegex.source.includes('[\\s\\S]*?')) {
    const includeHorizontalWs = pillRegex.source.startsWith('[ \\t]*');
    const linearRanges = findPillRangesLinear(maskedBody, includeHorizontalWs);
    for (let i = 0; i < linearRanges.length; i++) {
      const { start, end } = linearRanges[i];
      if (isRejected(start, end)) {
        continue;
      }
      matches.push({
        start,
        end,
        text: bodyText.slice(start, end)
      });
    }
    return matches;
  }

  const flags = pillRegex.flags.includes('g') ? pillRegex.flags : `${pillRegex.flags}g`;
  const re = new RegExp(pillRegex.source, flags);
  let m;
  while ((m = re.exec(maskedBody)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const start = m.index;
    const end = start + m[0].length;
    if (isRejected(start, end)) {
      continue;
    }
    matches.push({
      start,
      end,
      text: bodyText.slice(start, end)
    });
  }
  return matches;
}

function findUnprotectedNakedPillMatches(text) {
  const { infoRanges, fenceToolRanges } = buildProtectedSkipRanges(text, null, false);
  return findTopLevelPillMatches(text, infoRanges, createPillGlobalRegex(), fenceToolRanges);
}

/**
 * 判定一段文本是否在 ROLE_DIVIDE_USER 顶层外壳内包含真正的系统药丸
 * 遵循 04_细则 3.2 铁律：只有位于顶层 ROLE_DIVIDE_USER 外壳内的药丸才是系统药丸
 * 杜绝正文或代码块中解释 VCP_STATIC_PILL_PROMPT 的内容被误判为药丸
 * @param {string} text
 * @returns {boolean}
 */
function hasSystemPillInText(text, precomputedEnvelopes = null) {
  if (typeof text !== 'string' || !text) return false;
  if (!hasLinearPillInText(text)) return false;
  const envelopes = precomputedEnvelopes || findRoleDivideUserEnvelopes(text);
  return envelopes.some(env => {
    if (!hasLinearPillInText(env.bodyText)) return false;
    const innerInfoRanges = findVcpInfoRanges(env.bodyText);
    return findTopLevelPillMatches(env.bodyText, innerInfoRanges, createPillGlobalRegex()).length > 0;
  });
}

/**
 * 判定文本中是否存在不属于 findVcpInfoRanges 保护区的药丸（包含裸药丸）
 * 供 noPillMode 纯擦除模式判定使用，杜绝正常工具保护区内的规范文档被抹杀
 * @param {string} text
 * @returns {boolean}
 */
function hasUnprotectedPill(text) {
  if (typeof text !== 'string' || !text) return false;
  if (!hasLinearPillInText(text)) return false;
  return findUnprotectedNakedPillMatches(text).length > 0;
}

/**
 * 判定一段文本是否在 ROLE_DIVIDE_USER 顶层外壳内包含真正的协议纠偏回执
 * @param {string} text
 * @returns {boolean}
 */
function hasRealGuidanceInText(text, precomputedEnvelopes = null) {
  if (typeof text !== 'string' || !text) return false;
  if (!RECEIPT_TEST_REGEX.test(text)) return false;
  const envelopes = precomputedEnvelopes || findRoleDivideUserEnvelopes(text);
  for (const env of envelopes) {
    const innerInfos = findVcpInfoRanges(env.bodyText);
    if (innerInfos.length > 0) {
      if (innerInfos.some(info => isRealGuidanceBlock(info.text))) {
        return true;
      }
    } else if (RECEIPT_TEST_REGEX.test(env.bodyText)) {
      return true;
    }
  }
  return false;
}

/**
 * 判定多模态 content 数组在可见正文维度是否全空（支持非文本媒体分片识别）
 * @param {Array<Object>} parts
 * @returns {boolean}
 */
function isMultimodalContentEmpty(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return true;
  for (const part of parts) {
    if (!part) continue;
    if (part.type !== 'text') {
      // 存在非文本分片（如图片、音频等多模态媒体），消息整体不为空
      return false;
    }
    if (typeof part.text === 'string' && !checkVisibleTextEmpty(part.text)) {
      // 存在可见文本正文
      return false;
    }
  }
  return true;
}

/**
 * 判定摘要行是否属于协议错误项（需剔除）
 * 匹配：
 * - "VCP工具调用 格式错误（未执行）"（含 "(记录ID: ...)" 变体）
 * - "- [x] VCP工具调用 -> 格式错误（未执行）"
 * @param {string} item
 * @returns {boolean}
 */
function isProtocolErrorSummaryItem(item) {
  const trimmed = item.trim();
  if (!trimmed) return false;
  return /VCP工具调用.*格式错误/i.test(trimmed);
}

/**
 * 解析并清洗 envelope 内部的 [本轮工具调用摘要:] ... [本轮工具调用摘要结束]
 * 增加 isInsideInfo 判定，跳过工具输出内部的代码字面量假摘要
 * 同时兼容分号与换行/Markdown 列表格式
 * @param {string} envelopeBody
 * @returns {Object}
 */
function processSummaryInEnvelope(envelopeBody, precomputedInfos = null) {
  const startTag = '[本轮工具调用摘要:]';
  const endTag = '[本轮工具调用摘要结束]';
  if (!envelopeBody || !envelopeBody.includes(startTag) || !envelopeBody.includes(endTag)) {
    return {
      hasSummary: false,
      summaryStart: -1,
      summaryEnd: -1,
      fullSummaryBlock: '',
      cleanedSummaryBlock: '',
      remainingItems: []
    };
  }
  const infoRanges = precomputedInfos || findVcpInfoRanges(envelopeBody);
  function isInsideInfo(idx) {
    return Boolean(findEnclosingRange(idx, infoRanges));
  }

  let sIdx = -1;
  let cursor = 0;
  while (cursor < envelopeBody.length) {
    const cand = envelopeBody.indexOf(startTag, cursor);
    if (cand === -1) break;
    if (isInsideInfo(cand)) {
      cursor = cand + startTag.length;
      continue;
    }
    sIdx = cand;
    break;
  }
  if (sIdx === -1) {
    return {
      hasSummary: false,
      summaryStart: -1,
      summaryEnd: -1,
      fullSummaryBlock: '',
      cleanedSummaryBlock: '',
      remainingItems: []
    };
  }

  let eIdx = -1;
  cursor = sIdx + startTag.length;
  while (cursor < envelopeBody.length) {
    const cand = envelopeBody.indexOf(endTag, cursor);
    if (cand === -1) break;
    if (isInsideInfo(cand)) {
      cursor = cand + endTag.length;
      continue;
    }
    eIdx = cand;
    break;
  }
  if (eIdx === -1 || eIdx <= sIdx) {
    return {
      hasSummary: false,
      summaryStart: -1,
      summaryEnd: -1,
      fullSummaryBlock: '',
      cleanedSummaryBlock: '',
      remainingItems: []
    };
  }

  const fullSummaryBlock = envelopeBody.slice(sIdx, eIdx + endTag.length);
  const inner = envelopeBody.slice(sIdx + startTag.length, eIdx).trim();
  const stripped = inner.replace(/[。.\s]+$/, '');
  // P2-1: 同时兼容分号与换行/列表格式拆分
  const items = stripped.split(/(?:[；;]|\r?\n)+/).map(s => s.trim()).filter(Boolean);
  const remainingItems = items.filter(item => !isProtocolErrorSummaryItem(item));

  let formattedSummary = '';
  if (remainingItems.length > 0) {
    const isListFormat = remainingItems.some(i => /^[-*]\s+/.test(i));
    if (isListFormat) {
      formattedSummary = remainingItems.join('\n') + '\n';
    } else {
      formattedSummary = remainingItems.join('；') + '。\n';
    }
  }

  const cleanedSummaryBlock = remainingItems.length > 0
    ? `\n[本轮工具调用摘要:]\n${formattedSummary}[本轮工具调用摘要结束]\n`
    : '';

  return {
    hasSummary: true,
    summaryStart: sIdx,
    summaryEnd: eIdx + endTag.length,
    fullSummaryBlock,
    cleanedSummaryBlock,
    remainingItems
  };
}

/**
 * 判定剥离了 OneRing 通知与 ROLE_DIVIDE_USER（包括药丸）后的可见正文是否全空
 * @param {string} text
 * @returns {boolean}
 */
function checkVisibleTextEmpty(text) {
  if (typeof text !== 'string' || !text) return true;
  let s = text.replace(ONERING_REGEX, '');
  const envelopes = findRoleDivideUserEnvelopes(s);
  if (envelopes.length > 0) {
    const edits = envelopes.map(e => ({ start: e.start, end: e.end, replacement: '' }));
    s = applyEdits(s, edits);
  }
  return s.trim().length === 0;
}

/**
 * 统一倒序切片区间合并与替换数学（防坐标漂移与首字符吞噬）
 * 1. 按 start 升序排序，若 start 相同则 end 升序；
 * 2. 合并相邻（edit.start <= last.end）或重叠区间；
 * 3. 按 start 降序（从后往前）切片拼接。
 * @param {string} text
 * @param {Array<{ start: number, end: number, replacement: string }>} edits
 * @returns {string}
 */
function applyEdits(text, edits) {
  if (!edits || edits.length === 0) return text;

  // 1. 按 start 升序排序，start 相同则 end 升序
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);

  // 2. 合并重叠或紧密相邻的区间
  const merged = [];
  for (const edit of sorted) {
    if (merged.length === 0) {
      merged.push({ ...edit });
      continue;
    }
    const last = merged[merged.length - 1];
    if (edit.start <= last.end) {
      last.end = Math.max(last.end, edit.end);
      last.replacement += edit.replacement;
    } else {
      merged.push({ ...edit });
    }
  }

  // 3. 线性升序单遍切片合并（O(N) 杜绝大文本多次整串拼接退化）
  const parts = [];
  let cursor = 0;
  for (let i = 0; i < merged.length; i++) {
    const edit = merged[i];
    if (edit.start > cursor) {
      parts.push(text.slice(cursor, edit.start));
    }
    if (edit.replacement) {
      parts.push(edit.replacement);
    }
    cursor = edit.end;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts.join('');
}

/**
 * 从文本中剥除旧药丸（用于更早历史楼层的新陈代谢）
 * 严格遵循 04_细则 3.2 铁律：仅剥离位于 ROLE_DIVIDE_USER 内的药丸外壳或内容
 * 杜绝盲猜全局替换抹除正常代码块
 * @param {string} text
 * @param {Object} [options]
 * @param {boolean} [options.allowPlaceholder=true] - 剥除后若全空是否允许填入占位符
 * @returns {string}
 */
function buildPureEnvelopeDeleteEdit(text, env, matchedSpans = null) {
  let s = env.start;
  let e = env.end;
  if (e < text.length && text[e] === '\r' && text[e + 1] === '\n') {
    e += 2;
  } else if (e < text.length && text[e] === '\n') {
    e += 1;
  } else if (s > 0 && text[s - 1] === '\n' && (!matchedSpans || !findEnclosingRange(s - 1, matchedSpans))) {
    s--;
    if (s > 0 && text[s - 1] === '\r' && (!matchedSpans || !findEnclosingRange(s - 1, matchedSpans))) {
      s--;
    }
  }
  return { start: s, end: e, replacement: '' };
}

function stripOldPillsFromText(text, options = {}) {
  if (typeof text !== 'string' || !text) return text;
  const noPillMode = Boolean(options.noPillMode);
  if (!hasSystemPillInText(text) && !(noPillMode && hasUnprotectedPill(text))) {
    return text;
  }

  const allowPlaceholder = options.allowPlaceholder !== false;

  const envelopes = options.precomputedEnvelopes || findRoleDivideUserEnvelopes(text);
  const edits = [];
  for (const env of envelopes) {
    if (hasLinearPillInText(env.bodyText)) {
      const innerInfoRanges = findVcpInfoRanges(env.bodyText);
      const pillMatches = findTopLevelPillMatches(env.bodyText, innerInfoRanges, createPillGlobalRegex());

      if (pillMatches.length > 0) {
        const batchScanner = createBatchStartScanner();
        const hasBatch = batchScanner.test(env.bodyText);
        if (!hasBatch && innerInfoRanges.length === 0) {
          // 纯药丸外壳：整体删除（统一消耗尾随单换行对齐三态）
          edits.push(buildPureEnvelopeDeleteEdit(text, env));
        } else {
          // 混合批次内的药丸或含其他工具输出：仅剥离药丸正文，绝不碰 innerInfoRanges 内的内容
          let newBody = env.bodyText;
          for (let j = pillMatches.length - 1; j >= 0; j--) {
            newBody = newBody.slice(0, pillMatches[j].start) + newBody.slice(pillMatches[j].end);
          }
          newBody = newBody.replace(/(\r?\n){3,}/g, '$1$1');
          edits.push({ start: env.bodyStart, end: env.bodyEnd, replacement: newBody });
        }
      }
    }
  }

  text = applyEdits(text, edits);

  // 仅在 noPillMode（单文本纯净化模式）下剥除裸药丸，严格排除 VCP_INFO、围栏与闭合工具块保护区
  if (noPillMode && hasLinearPillInText(text)) {
    const nakedPillMatches = findUnprotectedNakedPillMatches(text);
    if (nakedPillMatches.length > 0) {
      text = applyEdits(text, nakedPillMatches.map(m => ({ start: m.start, end: m.end, replacement: '' })));
    }
  }

  text = text.replace(/(\r?\n){3,}/g, '$1$1').trim();

  // 若剥离后正文为空，仅在 allowPlaceholder 为 true 时填入占位符
  if (allowPlaceholder && checkVisibleTextEmpty(text)) {
    if (text.includes('<<<[ROLE_DIVIDE_USER]>>>')) {
      const rIdx = text.indexOf('<<<[ROLE_DIVIDE_USER]>>>');
      text = `${EMPTY_FLOOR_PLACEHOLDER}\n\n` + text.slice(rIdx);
    } else if (text.includes('[OneRing通知:')) {
      text = EMPTY_FLOOR_PLACEHOLDER + '\n' + text.trim();
    } else {
      text = EMPTY_FLOOR_PLACEHOLDER;
    }
  }

  return text;
}

/**
 * 单条文本的历史清洗核心逻辑
 * @param {string} text
 * @param {Object} config
 * @param {string|null} [config.pillText] - 欲插入的标准药丸文本（仅活药层使用）
 * @param {boolean} [config.isLivingPillLayer=false] - 是否被指定为唯一定位活药层
 * @param {boolean} [config.shouldStripOldPill=false] - 是否需要拔除更早历史楼层的旧药丸
 * @param {boolean} [config.noPillMode=false] - 纯擦除模式（供 stripErrorBlocksAndReceiptsFromText 调用，绝不插药绝不插占位符）
 * @param {boolean} [config.allowPlaceholder] - 是否允许注入占位符（多模态分片置 false）
 * @param {Object} [config.options] - 透传选项
 * @returns {{ text: string, errorSpans: Array, hasCleaned: boolean }}
 */
function cleanseSingleText(text, config = {}) {
  if (typeof text !== 'string' || !text) {
    return { text: text || '', errorSpans: [], hasCleaned: false };
  }

  const {
    pillText,
    isLivingPillLayer = false,
    shouldStripOldPill = false,
    noPillMode = false,
    options = {}
  } = config;

  const allowPlaceholder = config.allowPlaceholder !== undefined
    ? Boolean(config.allowPlaceholder)
    : !noPillMode;

  // 1. 扫描回执凭条：仅从 ROLE_DIVIDE_USER 内被确认是 realGuidanceBlock 的区间内提取
  const envelopes = config.precomputedEnvelopes || findRoleDivideUserEnvelopes(text);
  const innerInfosByEnv = new Map();
  const guidanceInfoSet = new WeakSet();
  const receiptMatches = [];
  for (const env of envelopes) {
    const innerInfos = findVcpInfoRanges(env.bodyText);
    innerInfosByEnv.set(env, innerInfos);
    if (innerInfos.length > 0) {
      for (const info of innerInfos) {
        const isGuidance = isRealGuidanceBlock(info.text);
        if (isGuidance) guidanceInfoSet.add(info);
        if (isGuidance) {
          RECEIPT_REGEX.lastIndex = 0;
          let m;
          while ((m = RECEIPT_REGEX.exec(info.text)) !== null) {
            receiptMatches.push({
              fullMatch: m[0],
              code: m[1],
              block: m[2].toLowerCase(),
              index: env.bodyStart + info.start + m.index
            });
          }
        }
      }
    } else if (RECEIPT_TEST_REGEX.test(env.bodyText)) {
      const re = createReceiptGlobalRegex();
      let m;
      while ((m = re.exec(env.bodyText)) !== null) {
        receiptMatches.push({
          fullMatch: m[0],
          code: m[1],
          block: m[2].toLowerCase(),
          index: env.bodyStart + m.index
        });
      }
    }
  }

  // 若无回执凭条
  if (receiptMatches.length === 0) {
    // 场景 A：该楼层被选为活药层（无新错但需收敛/刷新药丸）
    if (isLivingPillLayer && pillText && hasSystemPillInText(text)) {
      const edits = [];
      const pillEnvEntries = [];
      for (const env of envelopes) {
        if (!hasLinearPillInText(env.bodyText)) continue;
        let innerInfoRanges = innerInfosByEnv.get(env);
    if (!innerInfoRanges) { innerInfoRanges = findVcpInfoRanges(env.bodyText); innerInfosByEnv.set(env, innerInfoRanges); }
        const pillMatches = findTopLevelPillMatches(env.bodyText, innerInfoRanges, createPillGlobalRegex());
        if (pillMatches.length > 0) {
          pillEnvEntries.push({ env, innerInfoRanges, pillMatches });
        }
      }
      const lastPillEntry = pillEnvEntries.length > 0 ? pillEnvEntries[pillEnvEntries.length - 1] : null;

      for (const entry of pillEnvEntries) {
        const { env, innerInfoRanges, pillMatches } = entry;

        const batchScanner = createBatchStartScanner();
        const hasBatch = batchScanner.test(env.bodyText);
        if (entry === lastPillEntry) {
          if (!hasBatch && innerInfoRanges.length === 0) {
            // 纯药丸外壳：替换为最新标准药丸
            edits.push({
              start: env.start,
              end: env.end,
              replacement: `<<<[ROLE_DIVIDE_USER]>>>\n${pillText}\n<<<[END_ROLE_DIVIDE_USER]>>>`
            });
          } else {
            // 混合批次内药丸：替换药丸部分（只替换 pillMatches，不触碰 innerInfoRanges 内内容，按需补换行保幂等）
            let newBody = env.bodyText;
            if (pillMatches.length > 0) {
              for (let j = pillMatches.length - 1; j >= 0; j--) {
                let rep = '';
                if (j === pillMatches.length - 1) {
                  const before = newBody.slice(0, pillMatches[j].start);
                  const after = newBody.slice(pillMatches[j].end);
                  const lead = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
                  const trail = after.length > 0 && after[0] !== '\n' && after[0] !== '\r' ? '\n' : '';
                  rep = `${lead}${pillText}${trail}`;
                }
                newBody = newBody.slice(0, pillMatches[j].start) + rep + newBody.slice(pillMatches[j].end);
              }
            } else {
              const lead = newBody.length > 0 && !newBody.endsWith('\n') ? '\n' : '';
              newBody = `${newBody}${lead}${pillText}\n`;
            }
            edits.push({ start: env.bodyStart, end: env.bodyEnd, replacement: newBody });
          }
        } else {
          // 单消息内更早历史的冗余药丸外壳：一律彻底剥除收敛，杜绝单消息多药
          if (!hasBatch && innerInfoRanges.length === 0) {
            edits.push(buildPureEnvelopeDeleteEdit(text, env));
          } else {
            let newBody = env.bodyText;
            for (let j = pillMatches.length - 1; j >= 0; j--) {
              newBody = newBody.slice(0, pillMatches[j].start) + newBody.slice(pillMatches[j].end);
            }
            edits.push({ start: env.bodyStart, end: env.bodyEnd, replacement: newBody });
          }
        }
      }
      if (edits.length > 0) {
        let refreshed = applyEdits(text, edits);
        refreshed = refreshed.replace(/(\r?\n){3,}/g, '$1$1').trim();
        return { text: refreshed, errorSpans: [], hasCleaned: refreshed !== text };
      }
    }

    // 场景 B：该楼层包含旧药丸且需要拔除（或 noPillMode 纯擦除模式）
    const shouldStrip = shouldStripOldPill
      ? hasSystemPillInText(text)
      : (noPillMode && (hasSystemPillInText(text) || hasUnprotectedPill(text)));
    if (shouldStrip) {
      const stripped = stripOldPillsFromText(text, { allowPlaceholder, noPillMode });
      return { text: stripped, errorSpans: [], hasCleaned: stripped !== text };
    }
    return { text, errorSpans: [], hasCleaned: false };
  }

  // 2. 存在回执凭条，调用诊断器同步抽取坏块坐标映射
  const diagOptions = {
    protectRoleDivider: true,
    isHistoryExtraction: true,
    includeClosedBlockCandidates: true,
    finishReason: 'stop',
    sawDone: true,
    ...options
  };
  const errMap = diagnoser.extractHistoricalErrorBlocks(text, diagOptions);

  // 3. P6 失败安全校验：必须所有凭条的 block 都能在 errMap 中找到匹配区间
  const matchedSpans = [];
  const seenReceiptBlocks = new Set();
  const matchedSpanKeys = new Set();
  for (const rc of receiptMatches) {
    if (seenReceiptBlocks.has(rc.block)) continue;
    const candidateSpans = errMap.get(rc.block);
    if (!candidateSpans || candidateSpans.length === 0) {
      // 找不到匹配坏块，P6 失败安全触发：原样放行，绝不动刀
      return { text, errorSpans: [], hasCleaned: false };
    }
    seenReceiptBlocks.add(rc.block);
    for (const span of candidateSpans) {
      const spanKey = span.start + ":" + span.end;
      if (!matchedSpanKeys.has(spanKey)) {
        matchedSpanKeys.add(spanKey);
        matchedSpans.push(span);
      }
    }
  }

  // 4. 解析各 envelope，按纯错误批次 vs 混合批次精确定界
  const envelopeItems = [];
  for (const env of envelopes) {
    let innerInfoRanges = innerInfosByEnv.get(env);
    if (!innerInfoRanges) { innerInfoRanges = findVcpInfoRanges(env.bodyText); innerInfosByEnv.set(env, innerInfoRanges); }
    const guidanceBlocks = [];
    const otherResultBlocks = [];
    for (const info of innerInfoRanges) {
      const isGuidance = guidanceInfoSet.has(info) || isRealGuidanceBlock(info.text);
      if (isGuidance) {
        guidanceBlocks.push(info);
      } else {
        otherResultBlocks.push(info);
      }
    }

    let isEnvelopeWithReceipt = guidanceBlocks.length > 0;
    if (!isEnvelopeWithReceipt && innerInfoRanges.length === 0) {
      isEnvelopeWithReceipt = RECEIPT_TEST_REGEX.test(env.bodyText);
    }
    if (!isEnvelopeWithReceipt) {
      continue;
    }

    const summaryInfo = processSummaryInEnvelope(env.bodyText, innerInfoRanges);
    const isPureError = otherResultBlocks.length === 0 && summaryInfo.remainingItems.length === 0;

    let batchStartMarker = null;
    let batchEndMarker = null;
    const bsScanner = createBatchStartScanner();
    let bsMatch;
    while ((bsMatch = bsScanner.exec(env.bodyText)) !== null) {
      if (!findEnclosingRange(bsMatch.index, innerInfoRanges)) {
        batchStartMarker = bsMatch[0];
        break;
      }
    }

    let timestamp = null;
    if (batchStartMarker) {
      const tsMatch = batchStartMarker.match(/<<<\[VCP_TOOL_BATCH_START:([^\]]+)\]>>>/);
      if (tsMatch) {
        timestamp = tsMatch[1];
      }
    }

    if (timestamp) {
      const expectedEnd = `<<<[VCP_TOOL_BATCH_END:${timestamp}]>>>`;
      const lastIdx = env.bodyText.lastIndexOf(expectedEnd);
      if (lastIdx !== -1 && !findEnclosingRange(lastIdx, innerInfoRanges)) {
        batchEndMarker = expectedEnd;
      }
    }
    if (!batchEndMarker) {
      // 兜底找最后一个不在 innerInfoRanges 内部的 VCP_TOOL_BATCH_END
      const beScanner = /<<<\[VCP_TOOL_BATCH_END:[^\]]+\]>>>/g;
      let m;
      while ((m = beScanner.exec(env.bodyText)) !== null) {
        if (!findEnclosingRange(m.index, innerInfoRanges)) {
          batchEndMarker = m[0];
        }
      }
      if (!batchEndMarker && timestamp) {
        batchEndMarker = `<<<[VCP_TOOL_BATCH_END:${timestamp}]>>>`;
      }
    }

    envelopeItems.push({
      env,
      isPureError,
      otherResultBlocks,
      summaryInfo,
      batchStartMarker,
      batchEndMarker
    });
  }

  // 5. 归集统一编辑操作（edits）
  const edits = [];

  // A. 坏块擦除操作
  for (const span of matchedSpans) {
    edits.push({
      start: span.start,
      end: span.end,
      replacement: ''
    });
  }

  matchedSpans.sort((a, b) => a.start - b.start || a.end - b.end);

  // B. 处理各个包含回执的 envelope
  function isIndexInSpans(idx, spans) {
    return Boolean(findEnclosingRange(idx, spans));
  }

  const lastEnvWithReceipt = envelopeItems.length > 0 ? envelopeItems[envelopeItems.length - 1] : null;

  for (const item of envelopeItems) {
    const { env, isPureError, otherResultBlocks, summaryInfo, batchStartMarker, batchEndMarker } = item;
    const shouldAttachPill = !noPillMode && isLivingPillLayer && item === lastEnvWithReceipt && Boolean(pillText);

    if (isPureError) {
      if (shouldAttachPill) {
        // 变药 — 纯错误批次：将 ROLE_DIVIDE_USER 内部替换为药丸
        const rep = `<<<[ROLE_DIVIDE_USER]>>>\n${pillText}\n<<<[END_ROLE_DIVIDE_USER]>>>`;
        edits.push({ start: env.start, end: env.end, replacement: rep });
      } else {
        // 旧错删除或纯擦除模式：整块移除 ROLE_DIVIDE_USER（统一消耗尾随单换行对齐三态）
        edits.push(buildPureEnvelopeDeleteEdit(text, env, matchedSpans));
      }
    } else {
      // 混合批次
      let body = '';
      if (batchStartMarker) {
        body += `\n${batchStartMarker}\n`;
      }
      for (const ob of otherResultBlocks) {
        body += `\n${ob.text.trim()}\n`;
      }
      if (summaryInfo.cleanedSummaryBlock) {
        body += summaryInfo.cleanedSummaryBlock;
      }
      if (shouldAttachPill) {
        // 变药 — 混合批次：将静态药丸紧贴插入到 VCP_TOOL_BATCH_END 正前方
        body += `\n${pillText}\n`;
      }
      if (batchEndMarker) {
        body += `${batchEndMarker}\n`;
      }

      const rep = `<<<[ROLE_DIVIDE_USER]>>>${body}<<<[END_ROLE_DIVIDE_USER]>>>`;
      edits.push({ start: env.start, end: env.end, replacement: rep });
    }
  }

  // C. 剥除未纳入 envelopeItems 处理的游离旧药丸外壳（杜绝单消息内旧药与新药并存，严格保护 innerInfoRanges）
  const handledEnvs = new Set(envelopeItems.map(item => item.env));
  for (const env of envelopes) {
    if (!handledEnvs.has(env) && hasLinearPillInText(env.bodyText)) {
      let innerInfoRanges = innerInfosByEnv.get(env);
    if (!innerInfoRanges) { innerInfoRanges = findVcpInfoRanges(env.bodyText); innerInfosByEnv.set(env, innerInfoRanges); }
      const pillMatches = findTopLevelPillMatches(env.bodyText, innerInfoRanges, createPillGlobalRegex());

      if (pillMatches.length > 0) {
        const batchScanner = createBatchStartScanner();
        const hasBatch = batchScanner.test(env.bodyText);
        if (!hasBatch && innerInfoRanges.length === 0) {
          edits.push(buildPureEnvelopeDeleteEdit(text, env, matchedSpans));
        } else {
          let newBody = env.bodyText;
          for (let j = pillMatches.length - 1; j >= 0; j--) {
            newBody = newBody.slice(0, pillMatches[j].start) + newBody.slice(pillMatches[j].end);
          }
          edits.push({ start: env.bodyStart, end: env.bodyEnd, replacement: newBody });
        }
      }
    }
  }

  // 6. 统一通过 applyEdits 进行升序重叠合并与降序切片拼接（数学防漂移）
  let cleansedText = applyEdits(text, edits);

  // 7. 剥除本文本内原有的游离旧药丸（若非活药层，或活药层但药丸位置已重新生成）
  const postEnvs = cleansedText === text ? envelopes : null;
  const shouldStripPost = (shouldStripOldPill || !isLivingPillLayer)
    ? hasSystemPillInText(cleansedText, postEnvs)
    : (noPillMode && (hasSystemPillInText(cleansedText, postEnvs) || hasUnprotectedPill(cleansedText)));
  if (shouldStripPost) {
    cleansedText = stripOldPillsFromText(cleansedText, { allowPlaceholder, noPillMode });
  }

  cleansedText = cleansedText.replace(/(\r?\n){3,}/g, '$1$1').trim();

  // 8. 全错楼层正文置空安全兜底（仅在 allowPlaceholder 为 true 时执行）
  if (allowPlaceholder && checkVisibleTextEmpty(cleansedText)) {
    if (cleansedText.includes('<<<[ROLE_DIVIDE_USER]>>>')) {
      // 活药层：占位符置于 ROLE_DIVIDE_USER 前面
      const rIdx = cleansedText.indexOf('<<<[ROLE_DIVIDE_USER]>>>');
      cleansedText = `${EMPTY_FLOOR_PLACEHOLDER}\n\n` + cleansedText.slice(rIdx);
    } else if (cleansedText.includes('[OneRing通知:')) {
      // 旧错层仅剩 OneRing：占位符置于 OneRing 前面
      cleansedText = `${EMPTY_FLOOR_PLACEHOLDER}\n` + cleansedText.trim();
    } else {
      cleansedText = EMPTY_FLOOR_PLACEHOLDER;
    }
  }

  return {
    text: cleansedText,
    errorSpans: matchedSpans,
    hasCleaned: true
  };
}

/**
 * 单文本坏块与回执擦除纯函数
 * 供下游 foldingHelper 净化未洗复印件，绝不插入药丸，绝不插入占位符
 * @param {string} text
 * @param {Object} [options]
 * @returns {string}
 */
function stripErrorBlocksAndReceiptsFromText(text, options = {}) {
  if (!isResilienceEnabled(options)) {
    return text || '';
  }
  if (typeof text !== 'string' || !text) {
    return text || '';
  }
  const result = cleanseSingleText(text, {
    noPillMode: true,
    allowPlaceholder: false,
    options
  });
  return result.text;
}

/**
 * 轮间历史清洗主入口
 * @param {Array<Object>} messages
 * @param {Object} [options]
 * @returns {Array<Object>}
 */
function cleanseHistory(messages, options = {}) {
  if (!isResilienceEnabled(options)) {
    return messages;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  // 1. 查找真人边界（P3），同时通过 sanitize 屏蔽伪系统/ROLE_DIVIDE_USER 用户消息（保留剥离 [系统通知]...[系统通知结束] 后的真实正文）
  const SYSTEM_PROMPT_PREFIX_REGEX = /^\s*(?:\[系统(?:提示|邀请指令|通知|[^\]]*[:：])|<<<\[ROLE_DIVIDE_USER\]>>>|<!--\s*VCP_TOOL_PAYLOAD\s*-->)/;
  const SYSTEM_NOTICE_END = '[系统通知结束]';
  const stripSystemNotices = (raw) => {
    const s = String(raw || '');
    if (!s.includes('[系统通知') || !s.includes(SYSTEM_NOTICE_END)) {
      return s.trim();
    }
    const noticeOpenRe = /\[系统通知[:：]?\]/g;
    let out = '';
    let cursor = 0;
    let nm;
    while ((nm = noticeOpenRe.exec(s)) !== null) {
      const closeIdx = s.indexOf(SYSTEM_NOTICE_END, nm.index + nm[0].length);
      if (closeIdx === -1) break;
      out += s.slice(cursor, nm.index);
      cursor = closeIdx + SYSTEM_NOTICE_END.length;
      noticeOpenRe.lastIndex = cursor;
    }
    return (cursor === 0 ? s : out + s.slice(cursor)).trim();
  };
  let lastRealHuman = findLastRealUserMessage(messages, {
    sanitize: (raw) => {
      const stripped = stripSystemNotices(raw);
      return SYSTEM_PROMPT_PREFIX_REGEX.test(stripped) ? '' : stripped;
    }
  });
  let lastRealHumanIndex = lastRealHuman ? lastRealHuman.index : -1;

  // P2-3 & R4-1: 边界推进与防御：若在 lastRealHumanIndex 之后存在纯多模态附件（如 image_url）的真人用户消息，推进真人边界
  for (let i = messages.length - 1; i > lastRealHumanIndex; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      if (typeof isMetaThinkingV3Message === 'function' && isMetaThinkingV3Message(m)) {
        continue;
      }
      let isSystemPrompt = false;
      let hasRealUserMedia = false;
      if (typeof m.content === 'string') {
        const stripped = stripSystemNotices(m.content);
        if (stripped && SYSTEM_PROMPT_PREFIX_REGEX.test(stripped)) {
          isSystemPrompt = true;
        }
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part?.type === 'text' && typeof part.text === 'string') {
            const stripped = stripSystemNotices(part.text);
            if (stripped && SYSTEM_PROMPT_PREFIX_REGEX.test(stripped)) {
              isSystemPrompt = true;
            }
          } else if (part?.type && part.type !== 'text') {
            hasRealUserMedia = true;
          }
        }
      }
      if (!isSystemPrompt && hasRealUserMedia) {
        lastRealHumanIndex = i;
        break;
      }
    }
  }

  // RT2-P1-2: 群聊换棒边界推进（仅匹配 [系统邀请指令]，绝不放宽 [系统提示:] 心流锁 / [系统通知] / ROLE_DIVIDE_USER / VCP_TOOL_PAYLOAD）
  const GROUP_INVITATION_PREFIX_REGEX = /^\s*\[系统邀请指令[:：]?\]?/;
  for (let i = messages.length - 1; i > lastRealHumanIndex; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      let text = '';
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        text = m.content
          .filter(part => part && part.type === 'text' && typeof part.text === 'string')
          .map(part => part.text)
          .join('\n');
      } else if (m.content && typeof m.content === 'object' && typeof m.content.text === 'string') {
        text = m.content.text;
      }
      if (GROUP_INVITATION_PREFIX_REGEX.test(text)) {
        let hasPriorAssistant = false;
        for (let k = 0; k < i; k++) {
          if (messages[k] && messages[k].role === 'assistant') {
            hasPriorAssistant = true;
            break;
          }
        }
        if (hasPriorAssistant) {
          lastRealHumanIndex = i;
          break;
        }
      }
    }
  }

  if (lastRealHumanIndex <= 0) {
    return messages;
  }

  // 2. 第一轮正序扫描：收集 0 <= i < lastRealHumanIndex 范围内所有错误元数据与旧药警示
  const envCache = new Map();
  const getCachedEnvelopes = (txt) => {
    let envs = envCache.get(txt);
    if (!envs) {
      envs = findRoleDivideUserEnvelopes(txt);
      envCache.set(txt, envs);
    }
    return envs;
  };
  const allHistoricalErrors = [];
  const rawAntiPatternLines = [];
  const indicesWithPill = [];
  let lastReceiptIndex = -1;

  for (let i = 0; i < lastRealHumanIndex; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;

    const texts = [];
    if (typeof msg.content === 'string') {
      texts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          texts.push(part.text);
        }
      }
    }

    let msgHasPill = false;
    for (const txt of texts) {
      const envelopes = getCachedEnvelopes(txt);

      // P0-1 & P0-2: 提取旧药丸中的 Section IV 警示项（严格限制在 ROLE_DIVIDE_USER 内部且闭标前，排除 findVcpInfoRanges 保护区）
      for (const env of envelopes) {
        if (hasLinearPillInText(env.bodyText)) {
          const innerInfoRanges = findVcpInfoRanges(env.bodyText);
          const pillMatches = findTopLevelPillMatches(env.bodyText, innerInfoRanges, createPillGlobalRegex());
          for (const pm of pillMatches) {
            msgHasPill = true;
            const pillStr = pm.text;
            const s4Idx = pillStr.indexOf('### 四');
            if (s4Idx !== -1) {
              const s4Text = pillStr.slice(s4Idx);
              const closeTagRe = /[【\[［]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］]/i;
              const closeMatch = closeTagRe.exec(s4Text);
              const innerS4 = closeMatch ? s4Text.slice(0, closeMatch.index) : s4Text;
              const lines = innerS4.split('\n').map(l => l.trim()).filter(l => l.startsWith('- 【'));
              for (const line of lines) {
                if (!rawAntiPatternLines.includes(line)) {
                  rawAntiPatternLines.push(line);
                }
              }
            }
          }
        }
      }

      // P1-1: 提取真实回执中的错误对象（严格限制在 isRealGuidanceBlock 内部）
      const textReceipts = [];
      for (const env of envelopes) {
        const innerInfos = findVcpInfoRanges(env.bodyText);
        if (innerInfos.length > 0) {
          for (const info of innerInfos) {
            if (isRealGuidanceBlock(info.text)) {
              const re = createReceiptGlobalRegex();
              let rm;
              while ((rm = re.exec(info.text)) !== null) {
                textReceipts.push(rm);
              }
            }
          }
        } else if (RECEIPT_TEST_REGEX.test(env.bodyText)) {
          const re = createReceiptGlobalRegex();
          let rm;
          while ((rm = re.exec(env.bodyText)) !== null) {
            textReceipts.push(rm);
          }
        }
      }

      if (textReceipts.length > 0) {
        const diagOptions = {
          protectRoleDivider: true,
          isHistoryExtraction: true,
          includeClosedBlockCandidates: true,
          finishReason: 'stop',
          sawDone: true,
          ...options
        };
        const errMap = diagnoser.extractHistoricalErrorBlocks(txt, diagOptions);

        // P6 预检：必须该楼层内所有凭条均能在 errMap 中找到匹配坏块
        // 若存在任一指纹失配，该楼层在 Step 4 必触发 P6 失败安全原样放行
        // 因此绝不可将其记录为 lastReceiptIndex，亦不可将其伪错误推入 allHistoricalErrors（防止错杀历史旧药）
        const allReceiptsValid = textReceipts.every(rm => {
          const fp = rm[2].toLowerCase();
          const list = errMap.get(fp);
          return list && list.length > 0;
        });

        if (!allReceiptsValid) {
          // 触发 P6 失败安全预警，跳过此楼层，不篡夺活药层归属
          continue;
        }

        lastReceiptIndex = i;
        const seenHistBlocks = new Set();
        const seenHistSpanKeys = new Set();
        for (const rm of textReceipts) {
          const blockFp = rm[2].toLowerCase();
          if (seenHistBlocks.has(blockFp)) continue;
          seenHistBlocks.add(blockFp);
          const list = errMap.get(blockFp);
          for (const span of list) {
            const sk = span.start + ":" + span.end;
            if (seenHistSpanKeys.has(sk)) continue;
            seenHistSpanKeys.add(sk);
            allHistoricalErrors.push({
              errorCode: span.errorCode,
              subType: span.subType,
              detectedPluginInMaid: span.detectedPluginInMaid,
              pluginInMaid: span.pluginInMaid,
              roleNameInTool: span.roleNameInTool,
              isDuplicateConflict: span.isDuplicateConflict
            });
          }
        }
      }
    }

    if (msgHasPill) {
      indicesWithPill.push(i);
    }
  }

  // P0-1: 归一化与去重 accumulatedAntiPatterns，杜绝与 allHistoricalErrors 产生重复警示条目
  const currentErrorKeys = new Set();
  for (const err of allHistoricalErrors) {
    const code = typeof err === 'string' ? err : err.errorCode;
    if (code) {
      currentErrorKeys.add(code);
      if (code === 'COLON_SYNTAX') currentErrorKeys.add('MALFORMED_BLOCK_SYNTAX');
      if (code === 'DUPLICATE_KEY_CONFLICT' || /DUPLICATE/i.test(code) || (typeof code === 'string' && code.includes('重复'))) {
        currentErrorKeys.add('DUPLICATE_KEY_CONFLICT');
      }
    }
    if (typeof err === 'object' && err !== null) {
      const subType = err.subType;
      if (subType) {
        currentErrorKeys.add(subType);
      }
      if (err.isDuplicateConflict || subType === 'DUPLICATE_KEY_CONFLICT' || (typeof err.errorDetail === 'string' && (err.errorDetail.includes('重复定义') || err.errorDetail.includes('冲突')))) {
        currentErrorKeys.add('DUPLICATE_KEY_CONFLICT');
      }
      if (subType === 'BLACKLIST_SCENARIO_A' || subType === 'BLACKLIST_SCENARIO_B' || err.detectedPluginInMaid || err.pluginInMaid) {
        currentErrorKeys.add('MAID_IS_PLUGIN');
      }
      if (subType === 'ROLE_IN_TOOL_NAME' || err.roleNameInTool) {
        currentErrorKeys.add('ROLE_IN_TOOL_NAME');
      }
    }
  }

  const accumulatedAntiPatterns = [];
  for (const line of rawAntiPatternLines) {
    const trimmedLine = line.trim();
    let mappedKey = REMINDER_LINE_TO_KEY.get(trimmedLine);
    if (!mappedKey && guidanceAssembler && guidanceAssembler.SPECIALIZED_REMINDERS_MAP) {
      for (const [key, reminder] of Object.entries(guidanceAssembler.SPECIALIZED_REMINDERS_MAP)) {
        const tagMatch = reminder.match(/【[^】]+】/);
        if (tagMatch && trimmedLine.includes(tagMatch[0])) {
          mappedKey = key;
          break;
        }
      }
    }
    if (mappedKey && currentErrorKeys.has(mappedKey)) {
      // 当前轮次已从错误回执中提取，不再重复传入完整字符串
      continue;
    }
    if (!accumulatedAntiPatterns.includes(line)) {
      accumulatedAntiPatterns.push(line);
    }
  }

  // 3. 组装活药文本与确定全局唯一活药层目标坐标（消除逆序时序盲区）
  let pillText = null;
  let targetLivingPillIndex = -1;

  if (allHistoricalErrors.length > 0) {
    pillText = guidanceAssembler.assembleHistoricalPill({
      historicalErrors: allHistoricalErrors,
      accumulatedAntiPatterns,
      customStaticPrompt: options.customStaticPrompt
    });
    targetLivingPillIndex = lastReceiptIndex;
  } else if (indicesWithPill.length > 0) {
    // 全历史无新报错回执，但存在旧药丸：收敛为单药！
    pillText = guidanceAssembler.assembleHistoricalPill({
      historicalErrors: [],
      accumulatedAntiPatterns,
      customStaticPrompt: options.customStaticPrompt
    });
    targetLivingPillIndex = indicesWithPill[indicesWithPill.length - 1];
  }

  // 4. 第二轮倒序扫描：绝对坐标判定活药层与旧药拔除层
  const cleansedMessages = new Array(messages.length);

  // >= lastRealHumanIndex 100% 保持原样不动
  for (let i = lastRealHumanIndex; i < messages.length; i++) {
    cleansedMessages[i] = messages[i];
  }

  for (let i = lastRealHumanIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') {
      cleansedMessages[i] = msg;
      continue;
    }

    // 绝对坐标判定：唯一定位活药层 vs 旧药拔除层（彻底消除局部状态依赖）
    const isTargetLivingLayer = (i === targetLivingPillIndex) && Boolean(pillText);
    const shouldStripOldPill = Boolean(pillText) && !isTargetLivingLayer;

    // 清洗该消息
    if (typeof msg.content === 'string') {
      const res = cleanseSingleText(msg.content, {
        pillText,
        isLivingPillLayer: isTargetLivingLayer,
        shouldStripOldPill,
        precomputedEnvelopes: getCachedEnvelopes(msg.content),
        options
      });
      cleansedMessages[i] = res.hasCleaned ? { ...msg, content: res.text } : msg;
    } else if (Array.isArray(msg.content)) {
      let anyCleaned = false;
      const newParts = [];
      let partPillAssigned = false;
      for (let pIdx = msg.content.length - 1; pIdx >= 0; pIdx--) {
        const part = msg.content[pIdx];
        if (part?.type === 'text' && typeof part.text === 'string') {
          const partEnvs = getCachedEnvelopes(part.text);
          const partHasReceipt = hasRealGuidanceInText(part.text, partEnvs);
          const partHasOldPill = hasSystemPillInText(part.text, partEnvs);
          const partIsLiving = isTargetLivingLayer && !partPillAssigned && (partHasReceipt || partHasOldPill);
          if (partIsLiving) {
            partPillAssigned = true;
          }
          // P1-2: 多模态分片禁止局部插入占位符
          const res = cleanseSingleText(part.text, {
            pillText,
            isLivingPillLayer: partIsLiving,
            shouldStripOldPill: !partIsLiving && (shouldStripOldPill || partPillAssigned),
            allowPlaceholder: false,
            precomputedEnvelopes: partEnvs,
            options
          });
          if (res.hasCleaned) anyCleaned = true;
          newParts.unshift({ ...part, text: res.text });
        } else {
          newParts.unshift(part);
        }
      }

      // P1-2: 楼层级（Floor Level）正文置空安全防御
      // 只有整条消息的所有 text parts 均无可见文字且无非文本媒体时，才统一填入一次占位符
      if (isMultimodalContentEmpty(newParts)) {
        anyCleaned = true;
        let placeholderInjected = false;
        // 优先在包含 ROLE_DIVIDE_USER 的分片前置插入
        for (let pIdx = 0; pIdx < newParts.length; pIdx++) {
          const p = newParts[pIdx];
          if (p?.type === 'text' && typeof p.text === 'string' && p.text.includes('<<<[ROLE_DIVIDE_USER]>>>')) {
            const rIdx = p.text.indexOf('<<<[ROLE_DIVIDE_USER]>>>');
            newParts[pIdx] = {
              ...p,
              text: `${EMPTY_FLOOR_PLACEHOLDER}\n\n` + p.text.slice(rIdx)
            };
            placeholderInjected = true;
            break;
          }
        }
        // 其次在包含 OneRing 通知尾标的分片前置插入
        if (!placeholderInjected) {
          for (let pIdx = 0; pIdx < newParts.length; pIdx++) {
            const p = newParts[pIdx];
            if (p?.type === 'text' && typeof p.text === 'string' && p.text.includes('[OneRing通知:')) {
              newParts[pIdx] = {
                ...p,
                text: `${EMPTY_FLOOR_PLACEHOLDER}\n` + p.text.trim()
              };
              placeholderInjected = true;
              break;
            }
          }
        }
        // 最后兜底：在首个文本分片中填入，或新增文本分片
        if (!placeholderInjected) {
          const firstTextIdx = newParts.findIndex(p => p?.type === 'text');
          if (firstTextIdx !== -1) {
            newParts[firstTextIdx] = {
              ...newParts[firstTextIdx],
              text: EMPTY_FLOOR_PLACEHOLDER
            };
          } else {
            newParts.unshift({ type: 'text', text: EMPTY_FLOOR_PLACEHOLDER });
          }
        }
      }

      // P1: 过滤清洗后产生的纯空文本分片（{ type: 'text', text: '' }），防止触发 API 400
      // 同时如果被过滤的空分片携带了 cache_control 等关键属性，平移给首个有效分片
      let orphanedCacheControl = null;
      const survivingParts = [];
      for (const p of newParts) {
        if (!p) continue;
        if (p.type === 'text') {
          if (typeof p.text === 'string' && p.text.trim().length === 0) {
            if (p.cache_control && !orphanedCacheControl) {
              orphanedCacheControl = p.cache_control;
            }
            anyCleaned = true;
            continue;
          }
        }
        survivingParts.push(p);
      }

      if (survivingParts.length === 0) {
        survivingParts.push({
          type: 'text',
          text: EMPTY_FLOOR_PLACEHOLDER,
          ...(orphanedCacheControl ? { cache_control: orphanedCacheControl } : {})
        });
        anyCleaned = true;
      } else if (orphanedCacheControl) {
        if (!survivingParts[0].cache_control) {
          survivingParts[0] = { ...survivingParts[0], cache_control: orphanedCacheControl };
        }
      }

      // P2-2: 无损继承 msg.content 数组自身的不可枚举与 Symbol 属性
      cleansedMessages[i] = anyCleaned ? { ...msg, content: copyArrayMetadata(msg.content, survivingParts) } : msg;
    } else {
      cleansedMessages[i] = msg;
    }
  }

  // 5. 复制不可枚举元数据（含 Symbol）并返回
  return copyArrayMetadata(messages, cleansedMessages);
}

module.exports = {
  cleanseHistory,
  stripErrorBlocksAndReceiptsFromText,
  isResilienceEnabled,
  EMPTY_FLOOR_PLACEHOLDER,
  RECEIPT_REGEX,
  RECEIPT_TEST_REGEX,
  applyEdits,
  copyArrayMetadata,
  isRealGuidanceBlock,
  hasSystemPillInText,
  hasRealGuidanceInText,
  findVcpInfoRanges,
  findRoleDivideUserEnvelopes,
  hasUnprotectedPill,
  maskInnerInfoRangesWithSpaces,
  findTopLevelPillMatches,
  buildProtectedSkipRanges
};
