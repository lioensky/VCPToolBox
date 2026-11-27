'use strict';

/**
 * modules/vcpProtocolResilience/foldingHelper.js
 * 
 * Batch 5: 04_细则 折叠保留与向量净化模块
 * 
 * 职责：
 * 1. stripResilienceMarkers(text, options):
 *    在不修改 messages 原件的前提下，对送入向量化、折叠哈希计算与后台记忆摘要的临时文本复印件执行全量净化。
 *    实现「三态逐字节恒等与零 1 字节哈希抖动」：
 *    - 状态 0（OneRing 前置未洗原件态）
 *    - 状态 1（活药态）
 *    - 状态 2（退药态）
 *    三态输出完全一致，杜绝 FoldingStore 1 字节哈希分裂。
 * 2. isProtocolGuidancePill(content, options):
 *    严格限定顶层 ROLE_DIVIDE_USER 内识别系统药丸，跳过嵌套的 [[VCP调用结果信息汇总:...]]，杜绝自指防投毒。
 * 3. extractTopLevelPillEnvelope(content, options):
 *    提取顶层药丸信息；若发现顶层残缺开标签却无闭合尾标，触发 P6 失败安全并标记 shouldSkipFolding: true。
 * 4. foldWithPillIfPresent(content, summaryOrFoldFn, options):
 *    安全折叠含药楼层；若有药丸则只提取纯净药丸并重新用独立外壳包裹在摘要后，
 *    严禁将混合批次中同批 50KB 业务工具大日志带出。残缺药丸时原样返回原 content。
 *    同时支持 string 与多模态 Array<{ type, text, cache_control }>，递归保留不可枚举元数据与 Symbol。
 */

const {
  isResilienceEnabled,
  stripErrorBlocksAndReceiptsFromText,
  findVcpInfoRanges,
  findRoleDivideUserEnvelopes,
  copyArrayMetadata,
  EMPTY_FLOOR_PLACEHOLDER,
  maskInnerInfoRangesWithSpaces,
  findTopLevelPillMatches,
  buildProtectedSkipRanges
} = require('./historyCleanse');
const { findEnclosingRange } = require('./protocolLexer');

const { createBatchStartScanner } = require('../toolResultBatch');
const { maskProtectedRegionsForThinking, unmaskProtectedRegionsForThinking } = require('./thinkingMask');

/**
 * 匹配系统药丸开闭标正则（兼容全半角方括号、斜杠变体、含/不含“工具调用”四字）
 */
const PILL_OPEN_TAG_REGEX = /[【\[［]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］]/i;
const PILL_CLOSE_TAG_REGEX = /[【\[［]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］]/i;
const PILL_ANY_TAG_REGEX = new RegExp(`(?:${PILL_OPEN_TAG_REGEX.source}|${PILL_CLOSE_TAG_REGEX.source})`, 'i');

/**
 * 完整常驻药丸正则（动态构造，防 /g lastIndex 污染，支持全半角标点前缀）
 */
function createPillRegex() {
  return /(?:[【\[［]\s*系统提示\s*[:：]\s*[】\]］]\s*)?[【\[［]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］][\s\S]*?[【\[［]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］]/gi;
}

/**
 * 剥除多行常驻药丸正则（支持全半角标点前缀）
 */
const PILL_STRIP_REGEX = /[ \t]*(?:[【\[［]\s*系统提示\s*[:：]\s*[】\]］]\s*)?[【\[［]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］][\s\S]*?[【\[［]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］][ \t]*/gi;

/**
 * 剥除掏空后的错误结果信息汇总块（仅含元数据与空返回内容）
 */
const EMPTY_ERROR_INFO_REGEX = /[ \t]*\[\[VCP调用结果信息汇总:\s*(?:\r?\n)?(?:[ \t]*-(?![ \t]*(?:返回内容|执行状态))[^\r\n:：]+[:：][^\r\n]*(?:\r?\n))*?[ \t]*-[ \t]*执行状态[:：][ \t]*❌[ \t]*ERROR[ \t]*(?:\r?\n)?(?:[ \t]*-(?![ \t]*(?:返回内容|执行状态))[^\r\n:：]+[:：][^\r\n]*(?:\r?\n))*?(?:[ \t]*-[ \t]*返回内容[:：]?[ \t]*)?\s*VCP调用结果结束\]\][ \t]*(?:\r?\n)?/gi;

/**
 * 剥除纯空批次摘要外壳
 */
const EMPTY_BATCH_SUMMARY_REGEX = /[ \t]*(?:<<<\[VCP_TOOL_BATCH_SUMMARY\]>>>\s*<<<\[END_VCP_TOOL_BATCH_SUMMARY\]>>>|\[本轮工具调用摘要:\]\s*(?:\r?\n)?\s*\[本轮工具调用摘要结束\]|[【\[]\s*本轮工具调用摘要\s*[:：]\s*[】\]]\s*(?:\r?\n)?\s*[【\[]\s*本轮工具调用摘要结束\s*[】\]])[ \t]*(?:\r?\n)?/g;

function stripGuidanceBlocksLinear(text) {
  const OPEN = '[[VCP协议纠偏指导:';
  const CLOSE = '[[/VCP协议纠偏指导]]';
  if (!text || !text.includes(OPEN) || !text.includes(CLOSE)) return text;

  const lastClose = text.lastIndexOf(CLOSE);
  let out = '';
  let cursor = 0;
  let scan = 0;
  while (scan <= lastClose) {
    const openIdx = text.indexOf(OPEN, scan);
    if (openIdx === -1 || openIdx > lastClose) break;
    const closeIdx = text.indexOf(CLOSE, openIdx + OPEN.length);
    if (closeIdx === -1) break;

    let delStart = openIdx;
    while (delStart > cursor && (text[delStart - 1] === ' ' || text[delStart - 1] === '\t')) {
      delStart--;
    }
    let delEnd = closeIdx + CLOSE.length;
    while (delEnd < text.length && (text[delEnd] === ' ' || text[delEnd] === '\t')) {
      delEnd++;
    }
    if (text[delEnd] === '\r' && text[delEnd + 1] === '\n') delEnd += 2;
    else if (text[delEnd] === '\n') delEnd += 1;

    out += text.slice(cursor, delStart);
    cursor = delEnd;
    scan = delEnd;
  }

  if (cursor === 0) return text;
  out += text.slice(cursor);
  return out;
}

/**
 * 剥除纠偏指导回执正则（跨行非贪婪、单行极简回执、未闭合截断残余）
 */
const GUIDANCE_STRIP_REGEX = /[ \t]*\[\[VCP协议纠偏指导:[\s\S]*?\[\[\/VCP协议纠偏指导\]\][ \t]*(?:\r?\n)?/g;
const GUIDANCE_SINGLE_LINE_REGEX = /(?:^[ \t]*|(?<=返回内容[:：][ \t]*)|(?<=<<<\[ROLE_DIVIDE_USER\]>>>[ \t]*))\[\[VCP协议纠偏指导:[^\r\n\]]+\]\](?:(?=[ \t]*(?:<<<\[END_ROLE_DIVIDE_USER\]>>>|VCP调用结果结束\]\]))|[ \t]*(?:\r?\n|$))/gm;
const GUIDANCE_TRUNCATED_REGEX = /(?:(?:^|(?<=\n))[ \t]*|(?<=返回内容[:：][ \t]*)|(?<=<<<\[ROLE_DIVIDE_USER\]>>>[ \t]*))\[\[VCP协议纠偏指导:[ \t]*(?:code=(?![^\r\n\]]*\]\])|[\r\n])[\s\S]*?(?=(?:\[\[VCP协议纠偏指导:)|(?:<<<\[\/?(?:END_)?ROLE_DIVIDE)|(?:VCP调用结果结束\]\])|$)(?:\r?\n)?/g;

/**
 * 剥除工具结果摘要中的格式错误项
 */
const SUMMARY_ERROR_ITEM_REGEX = /(?:[；;][ \t]*)?[ \t]*(?:-\s*(?:\[[xX]\]\s*)?|\[[xX]\]\s*)?(?:[^\r\n:：\-—>；;\s]+\s*(?:->|[:：])\s*|[^\r\n:：\-—>；;\s]+\s+)?(?:格式错误|执行失败)（未执行）[^\r\n；;]*(?:[；;]|[。.\s]*(?:\r?\n|$))/g;

/**
 * 剥除全错楼层置空安全占位文本（包含当前与历史占位符）
 */
const PLACEHOLDER_STRIP_REGEX = /[ \t]*(?:\(上轮未执行的异常工具调用已略去\)|\[工具调用纠偏已归档\])[ \t]*(?:\r?\n)?/g;

/**
 * 剥除纯药丸拔除后留下的空 ROLE_DIVIDE_USER 壳
 */
const EMPTY_ROLE_DIVIDE_REGEX = /[ \t]*<<<\[ROLE_DIVIDE_USER\]>>>\s*<<<\[END_ROLE_DIVIDE_USER\]>>>[ \t]*(?:\r?\n)?/g;

/**
 * 剥除错误批次擦除后留下的纯空批次外壳
 */
const EMPTY_BATCH_ENVELOPE_REGEX = /[ \t]*<<<\[ROLE_DIVIDE_USER\]>>>\s*<<<\[VCP_TOOL_BATCH_START:[^\]]+\]>>>\s*<<<\[VCP_TOOL_BATCH_END:[^\]]+\]>>>\s*<<<\[END_ROLE_DIVIDE_USER\]>>>[ \t]*(?:\r?\n)?/g;

/**
 * 提取文本内容或多模态消息的有效纯文本
 * @param {string|Array<Object>|Object} content
 * @returns {string}
 */
function extractPureText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p?.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join('\n');
  }
  if (content && typeof content === 'object' && !Array.isArray(content) && ('content' in content)) {
    return extractPureText(content.content);
  }
  return '';
}

/**
 * 核心函数 1：stripResilienceMarkers(text, options)
 * 在不修改原件的前提下，对临时文本复印件执行全量自愈与药丸标记净化。
 * 确保同一楼层在「未洗原件态」、「含药态」、「退药态」下送入计算产出的文本 100% 逐字节恒等。
 * 
 * @param {string|Array<Object>} input
 * @param {Object} [options]
 * @returns {string|Array<Object>}
 */
function stripResilienceMarkers(input, options = {}) {
  if (!isResilienceEnabled(options)) {
    return input;
  }
  // BUG-R2-08 / BUG-R4-02: 对消息对象 { role, content } 的解包与重装支持（兼容 content === '' 空文本）
  if (input && typeof input === 'object' && !Array.isArray(input) && ('content' in input)) {
    return {
      ...input,
      content: stripResilienceMarkers(input.content, options)
    };
  }
  if (Array.isArray(input)) {
    const strippedParts = input.map(part => {
      if (part?.type === 'text' && typeof part.text === 'string') {
        return { ...part, text: stripResilienceMarkers(part.text, options) };
      }
      return part;
    });
    return copyArrayMetadata(input, strippedParts);
  }
  if (typeof input !== 'string' || !input) {
    return input || '';
  }

  let text = input;

  // 1. 前置未洗复印件联动擦除（消除状态 0 与状态 1/2 的坏块与报错回执差异）
  if (text.includes('[[VCP协议纠偏指导:')) {
    text = stripErrorBlocksAndReceiptsFromText(text, options);
  }

  // 2. 正则兜底剥离：孤立或指纹失配的纠偏指导块、单行极简回执与截断残余
  // 必须先掩码保护正常业务工具结果（如 FileOperator 读源码）、代码围栏与闭合工具块，
  // 仅放行真正属于 VCP 纠偏错误汇总块的区间，杜绝正常工具返回值被截断。
  if (text.includes('[[VCP协议纠偏指导:')) {
    const { text: maskedText, masks } = maskProtectedRegionsForThinking(text, {
      shouldMaskInfoBlock: (block) => {
        const head = block.slice(0, 600);
        const toolMatch = head.match(/^[ \t]*-[ \t]*工具名称[:：][ \t]*(.+)$/m);
        const statusMatch = head.match(/^[ \t]*-[ \t]*执行状态[:：][ \t]*(.+)$/m);
        const isVcpTool = Boolean(toolMatch && toolMatch[1].trim() === 'VCP工具调用');
        const isErrorStatus = Boolean(statusMatch && /❌\s*ERROR/i.test(statusMatch[1]));
        const hasGuidanceReturn = /^[ \t]*-[ \t]*返回内容[:：]\s*\[\[VCP协议纠偏指导:/m.test(head);
        const isGuidanceErrorInfo = isVcpTool || (isErrorStatus && hasGuidanceReturn);
        return !isGuidanceErrorInfo;
      }
    });
    let stripped = maskedText;
    stripped = stripGuidanceBlocksLinear(stripped);
    stripped = stripped.replace(GUIDANCE_SINGLE_LINE_REGEX, '');
    stripped = stripped.replace(GUIDANCE_TRUNCATED_REGEX, '');
    text = unmaskProtectedRegionsForThinking(stripped, masks);
  }

  // 3. 剥离顶层 ROLE_DIVIDE_USER 内的常驻系统药丸（严禁在保护区及外层散文/工具结果中全局误删）
  if (PILL_OPEN_TAG_REGEX.test(text) && text.includes('<<<[ROLE_DIVIDE_USER]>>>')) {
    const envelopes = findRoleDivideUserEnvelopes(text);
    for (let i = envelopes.length - 1; i >= 0; i--) {
      const env = envelopes[i];
      if (!PILL_OPEN_TAG_REGEX.test(env.bodyText)) continue;

      const innerInfoRanges = findVcpInfoRanges(env.bodyText);
      const matchesToStrip = findTopLevelPillMatches(env.bodyText, innerInfoRanges, PILL_STRIP_REGEX);

      if (matchesToStrip.length > 0) {
        let newBody = env.bodyText;
        for (let j = matchesToStrip.length - 1; j >= 0; j--) {
          const { start, end } = matchesToStrip[j];
          newBody = newBody.slice(0, start) + newBody.slice(end);
        }
        text = text.slice(0, env.bodyStart) + newBody + text.slice(env.bodyEnd);
      }
    }
  }

  // 4. 剥离可能残存的摘要报错项
  if (text.includes('（未执行）')) {
    text = text.replace(SUMMARY_ERROR_ITEM_REGEX, '');
  }

  // 4.1 剥离掏空后的错误结果块与纯空批次摘要外壳（使 P6 触发后的空错误批次壳能被干净清除）
  if (text.includes('[[VCP调用结果信息汇总:') && text.includes('VCP调用结果结束]]') && (text.includes('❌ ERROR') || text.includes('❌ERROR'))) {
    text = text.replace(EMPTY_ERROR_INFO_REGEX, '');
  }
  if (text.includes('<<<[VCP_TOOL_BATCH_SUMMARY]>>>') || text.includes('本轮工具调用摘要')) {
    text = text.replace(EMPTY_BATCH_SUMMARY_REGEX, '');
  }

  // 5. 剥离全错楼层占位符（消除状态 1/2 与状态 0 的占位符差异，雷区 1C）
  if (text.includes('(上轮未执行的异常工具调用已略去)') || text.includes('[工具调用纠偏已归档]')) {
    text = text.replace(PLACEHOLDER_STRIP_REGEX, '');
  }

  // 6. 剥离纯药丸剥除后遗留的空 ROLE_DIVIDE_USER 外壳（雷区 1A）
  if (text.includes('<<<[ROLE_DIVIDE_USER]>>>')) {
    text = text.replace(EMPTY_BATCH_ENVELOPE_REGEX, '');
    text = text.replace(EMPTY_ROLE_DIVIDE_REGEX, '');
  }

  // 7. 紧密收敛周边多余换行（收敛混合批次拔药后的换行，杜绝 1 字节哈希抖动，雷区 1B）
  // 在 <<<[VCP_TOOL_BATCH_END: 前方将多个换行收敛为单一换行（兼容 CRLF）
  text = text.replace(/(?:\r?\n)+<<<\[VCP_TOOL_BATCH_END:/g, (match) => match.includes('\r') ? '\r\n<<<[VCP_TOOL_BATCH_END:' : '\n<<<[VCP_TOOL_BATCH_END:');
  text = text.replace(/(?:\r?\n)+<<<\[END_ROLE_DIVIDE_USER\]>>>/g, (match) => match.includes('\r') ? '\r\n<<<[END_ROLE_DIVIDE_USER]>>>' : '\n<<<[END_ROLE_DIVIDE_USER]>>>');

  // 将 3 个以上连续换行压缩为 2 个换行（兼容 CRLF）
  text = text.replace(/(\r?\n){3,}/g, '$1$1').trim();

  return text;
}

/**
 * 核心函数 2：extractTopLevelPillEnvelope(content, options)
 * 提取顶层 ROLE_DIVIDE_USER 外壳内的纯净药丸。
 * 遵循雷区 3 铁律：屏蔽内部嵌套的 [[VCP调用结果信息汇总:...]]（自指防投毒）。
 * 遵循雷区 5 铁律：若发现顶层残缺开标却无闭合尾标，触发 P6 失败安全并返回 shouldSkipFolding: true。
 * 
 * @param {string|Array<Object>|Object} content
 * @param {Object} [options]
 * @returns {{
 *   hasPill: boolean,
 *   pillText: string|null,
 *   envelope: Object|null,
 *   hasMalformedPill: boolean,
 *   shouldSkipFolding: boolean,
 *   isMixedBatch: boolean,
 *   targetPartIndex: number
 * }}
 */
function extractTopLevelPillEnvelope(content, options = {}) {
  const defaultRes = {
    hasPill: false,
    pillText: null,
    envelope: null,
    hasMalformedPill: false,
    shouldSkipFolding: false,
    isMixedBatch: false,
    targetPartIndex: -1
  };

  if (!isResilienceEnabled(options)) {
    return defaultRes;
  }

  // 归一化输入文本与分片索引
  let texts = [];
  if (typeof content === 'string') {
    texts.push({ text: content, partIndex: -1 });
  } else if (Array.isArray(content)) {
    for (let pIdx = 0; pIdx < content.length; pIdx++) {
      const part = content[pIdx];
      if (part?.type === 'text' && typeof part.text === 'string') {
        texts.push({ text: part.text, partIndex: pIdx });
      }
    }
  } else if (content && typeof content === 'object' && !Array.isArray(content) && ('content' in content)) {
    return extractTopLevelPillEnvelope(content.content, options);
  }

  const START_TAG = '<<<[ROLE_DIVIDE_USER]>>>';
  const END_TAG = '<<<[END_ROLE_DIVIDE_USER]>>>';

  // =========================================================================
  // 第一阶段：全局残损巡检（Global Malformed Inspection）
  // 必须遍历全部分片和全部外壳，只要发现任何残损，立即触发 P6 失败安全并全局返回 shouldSkipFolding: true！
  // =========================================================================

  // 1.1 外壳截断校验 (BUG-R4-04)：
  // 统计 ROLE_DIVIDE_USER 开闭壳数量；若开壳数量 > 闭壳数量，且在未闭合外壳区域内检测到 PILL_OPEN_TAG_REGEX
  for (const { text, partIndex } of texts) {
    if (!text || !text.includes(START_TAG)) continue;

    const { infoRanges, fenceToolRanges, skipRanges } = buildProtectedSkipRanges(text, null, true);
    const isInsideSkipped = (idx) => Boolean(findEnclosingRange(idx, skipRanges));

    let openPositions = [];
    let sPos = 0;
    while ((sPos = text.indexOf(START_TAG, sPos)) !== -1) {
      if (!isInsideSkipped(sPos)) {
        openPositions.push(sPos);
      }
      sPos += START_TAG.length;
    }

    // 统计闭壳数量（排除嵌套在 VCP_INFO/围栏/闭合工具块内的闭壳）
    let closePositions = [];
    let ePos = 0;
    while ((ePos = text.indexOf(END_TAG, ePos)) !== -1) {
      if (!isInsideSkipped(ePos)) {
        closePositions.push(ePos);
      }
      ePos += END_TAG.length;
    }

    const envelopes = findRoleDivideUserEnvelopes(text);
    const hasUnbalancedEnvelopes = openPositions.length !== closePositions.length || openPositions.length > envelopes.length;
    let hasSwallowedEnvelopes = false;
    for (let i = 0; i < envelopes.length && !hasSwallowedEnvelopes; i++) {
      const env = envelopes[i];
      let searchPos = env.bodyStart;
      while (searchPos < env.bodyEnd) {
        const hit = text.indexOf(START_TAG, searchPos);
        if (hit === -1 || hit >= env.bodyEnd) break;
        if (!isInsideSkipped(hit)) {
          hasSwallowedEnvelopes = true;
          break;
        }
        searchPos = hit + START_TAG.length;
      }
    }

    if (hasUnbalancedEnvelopes || hasSwallowedEnvelopes) {
      const topPillTags = findTopLevelPillMatches(text, infoRanges, PILL_ANY_TAG_REGEX, fenceToolRanges);
      if (topPillTags.length > 0) {
        return {
          hasPill: false,
          pillText: null,
          envelope: null,
          hasMalformedPill: true,
          shouldSkipFolding: true,
          isMixedBatch: false,
          targetPartIndex: partIndex
        };
      }
    }

    const closedStarts = new Set(envelopes.map(env => env.start));
    const unclosedStarts = openPositions.filter(p => !closedStarts.has(p));

    if (unclosedStarts.length > 0) {
      const topPillTags = findTopLevelPillMatches(text, infoRanges, PILL_ANY_TAG_REGEX, fenceToolRanges);
      for (const tag of topPillTags) {
        const isInsideClosedEnv = envelopes.some(env => tag.start >= env.start && tag.end <= env.end);
        const isAfterUnclosedStart = unclosedStarts.some(uStart => tag.start >= uStart);
        if (!isInsideClosedEnv && isAfterUnclosedStart) {
          return {
            hasPill: false,
            pillText: null,
            envelope: null,
            hasMalformedPill: true,
            shouldSkipFolding: true,
            isMixedBatch: false,
            targetPartIndex: partIndex
          };
        }
      }
    }
  }

  // 1.2 封闭外壳内部残损巡检与药丸候选预搜集 (BUG-R4-03)
  // 解耦「残损巡检」与「药丸提取」：遍历所有 envelopes，只要任何一个 envelope 残损，立刻返回 shouldSkipFolding: true
  let firstValidPillCandidate = null;

  for (const { text, partIndex } of texts) {
    const envelopes = findRoleDivideUserEnvelopes(text);

    for (const env of envelopes) {
      const innerInfoRanges = findVcpInfoRanges(env.bodyText);

      // 搜集该外壳内的开闭标（通过等长空白掩码排除嵌套在 innerInfoRanges 内部的字面量）
      const openMatches = findTopLevelPillMatches(env.bodyText, innerInfoRanges, PILL_OPEN_TAG_REGEX)
        .map(m => ({ type: 'open', index: m.start, end: m.end }));
      const closeMatches = findTopLevelPillMatches(env.bodyText, innerInfoRanges, PILL_CLOSE_TAG_REGEX)
        .map(m => ({ type: 'close', index: m.start, end: m.end }));

      // 事件栈/位置序判定：将开标与闭标合并按 index 排序
      const events = [...openMatches, ...closeMatches].sort((a, b) => a.index - b.index);
      let stack = [];
      let hasMalformed = false;

      for (const evt of events) {
        if (evt.type === 'open') {
          if (stack.length > 0) {
            // BUG-R3-03: 遇到自嵌套非法药丸（在未闭合的药丸内又出现了开标签）！
            hasMalformed = true;
            break;
          }
          stack.push(evt);
        } else if (evt.type === 'close') {
          if (stack.length === 0) {
            // 遇到先闭后开（倒置残缺）或孤立闭标！
            hasMalformed = true;
            break;
          }
          stack.pop();
        }
      }

      if (stack.length > 0) {
        // 存在未配对的开标（栈未清空，截断残缺）！
        hasMalformed = true;
      }

      // 提取该外壳内完整匹配的药丸（在等长掩码串上匹配，根除 VCP_INFO 内字面药丸标题跨界桥接）
      let matchedPill = null;
      if (!hasMalformed && openMatches.length > 0 && closeMatches.length > 0) {
        const topPills = findTopLevelPillMatches(env.bodyText, innerInfoRanges, createPillRegex());
        if (topPills.length > 0) {
          matchedPill = topPills[0].text.trim();
        }
      }

      // 若存在开标或闭标，却未能匹配到合法顶层药丸（如药丸跨越 50KB 业务日志被 isOverlappingInfo 拦截），判定为残损触发 P6 失败安全
      if (!hasMalformed && (openMatches.length > 0 || closeMatches.length > 0) && !matchedPill) {
        hasMalformed = true;
      }

      // 只要当前外壳残损，立刻触发全局 P6 失败安全！绝不容许后续外壳短路放行！
      if (hasMalformed) {
        return {
          hasPill: false,
          pillText: null,
          envelope: env,
          hasMalformedPill: true,
          shouldSkipFolding: true,
          isMixedBatch: false,
          targetPartIndex: partIndex
        };
      }

      // 若当前外壳包含合法药丸，且尚未记录首个合法候选，则缓存之
      if (matchedPill && !firstValidPillCandidate) {
        const batchScanner = createBatchStartScanner();
        const isMixedBatch = batchScanner.test(env.bodyText);
        firstValidPillCandidate = {
          hasPill: true,
          pillText: matchedPill,
          envelope: env,
          hasMalformedPill: false,
          shouldSkipFolding: false,
          isMixedBatch,
          targetPartIndex: partIndex
        };
      }
    }
  }

  // =========================================================================
  // 第二阶段：在确认全消息无任何残缺的前提下，才返回命中的合法药丸信息
  // =========================================================================
  if (firstValidPillCandidate) {
    return firstValidPillCandidate;
  }

  return defaultRes;
}

/**
 * 核心函数 3：isProtocolGuidancePill(content, options)
 * 判断指定内容是否包含真正的顶层系统药丸（屏蔽嵌套自指与残缺开标）
 * 
 * @param {string|Array<Object>|Object} content
 * @param {Object} [options]
 * @returns {boolean}
 */
function isProtocolGuidancePill(content, options = {}) {
  if (!isResilienceEnabled(options)) {
    return false;
  }
  const res = extractTopLevelPillEnvelope(content, options);
  return Boolean(res.hasPill && !res.hasMalformedPill);
}

/**
 * 核心函数 4：foldWithPillIfPresent(content, summaryOrFoldFn, options)
 * 在折叠含药楼层时保留为「摘要 + 药丸」。
 * 
 * 核心铁律：
 * 1. 雷区 4：若为混合批次，绝对不能把原 ROLE_DIVIDE_USER 内同批 50KB 业务工具大日志带出！
 *    只提取纯净药丸 pillText，单独用干净的 <<<[ROLE_DIVIDE_USER]>>>\n${pillText}\n<<<[END_ROLE_DIVIDE_USER]>>> 包裹。
 * 2. 雷区 5：若发现残缺药丸，触发 P6 失败安全，直接跳过不折叠，原样返回 content。
 * 3. 雷区 6：同时支持 string 与多模态 Array<{ type, text, cache_control }>，递归复制不可枚举元数据与 Symbol。
 * 4. 雷区 7：输出结构与 roleDivider.process() 完美联动，精确切分为 assistant(摘要) + user(静态药丸)。
 * 
 * @param {string|Array<Object>|Object} content 原消息 content
 * @param {string|Function} summaryOrFoldFn 折叠摘要字符串或折叠计算回调
 * @param {Object} [options]
 * @returns {string|Array<Object>|Object}
 */
/**
 * 构建多模态折叠数组分片：保留非文本分片，收敛文本分片并继承 cache_control；
 * 当存在非文本分片且摘要为空串时，跳过空 text 分片并将 cache_control 移交给首个有效分片。
 */
function buildFoldedArrayParts(content, summaryText, tailPart = null) {
  const newParts = [];
  let textUpdated = false;
  let inheritedCacheControl = null;
  for (const part of content) {
    if (part?.type === 'text' && part.cache_control && !inheritedCacheControl) {
      inheritedCacheControl = part.cache_control;
    }
  }

  const hasNonTextPart = content.some(part => part && part.type !== 'text');
  const skipEmptyTextPart = hasNonTextPart && summaryText.trim() === '';

  for (let pIdx = 0; pIdx < content.length; pIdx++) {
    const part = content[pIdx];
    if (part?.type === 'text') {
      if (!textUpdated) {
        textUpdated = true;
        if (skipEmptyTextPart) {
          continue;
        }
        const updatedPart = { ...part, text: summaryText };
        if (!updatedPart.cache_control && inheritedCacheControl) {
          updatedPart.cache_control = inheritedCacheControl;
        }
        newParts.push(updatedPart);
      }
    } else {
      newParts.push(part);
    }
  }

  if (!textUpdated && !skipEmptyTextPart) {
    const firstPart = { type: 'text', text: summaryText };
    if (inheritedCacheControl) {
      firstPart.cache_control = inheritedCacheControl;
    }
    newParts.unshift(firstPart);
  }

  if (skipEmptyTextPart && inheritedCacheControl && newParts.length > 0 && !newParts[0].cache_control) {
    newParts[0] = { ...newParts[0], cache_control: inheritedCacheControl };
  }

  if (tailPart) {
    newParts.push(tailPart);
  }

  return copyArrayMetadata(content, newParts);
}

function foldWithPillIfPresent(content, summaryOrFoldFn, options = {}) {
  // BUG-R3-02 / BUG-08 / BUG-R4-02: 消息对象解包必须提升至最顶端（在 isResilienceEnabled 检查之前），保证门控关闭或 content === '' 时同样维持对象结构
  if (content && typeof content === 'object' && !Array.isArray(content) && ('content' in content)) {
    return {
      ...content,
      content: foldWithPillIfPresent(content.content, summaryOrFoldFn, options)
    };
  }

  if (!isResilienceEnabled(options)) {
    let rawSummary = '';
    if (typeof summaryOrFoldFn === 'function') {
      const textArg = typeof content === 'string' ? content : extractPureText(content);
      try {
        rawSummary = summaryOrFoldFn(textArg);
      } catch (err) {
        rawSummary = '';
      }
    } else if (typeof summaryOrFoldFn === 'string') {
      rawSummary = summaryOrFoldFn;
    } else {
      rawSummary = String(summaryOrFoldFn || '');
    }
    rawSummary = String(rawSummary != null ? rawSummary : '');

    if (typeof content === 'string') {
      return rawSummary;
    }

    if (Array.isArray(content)) {
      return buildFoldedArrayParts(content, rawSummary, null);
    }

    return rawSummary;
  }

  // 1. 提取顶层药丸
  const pillInfo = extractTopLevelPillEnvelope(content, options);

  // 2. 雷区 5：P6 失败安全——残缺药丸跳过不折叠，原样直通返回
  if (pillInfo.shouldSkipFolding || pillInfo.hasMalformedPill) {
    return content;
  }

  // 3. 计算摘要纯文本（传入已被净化的干净文本，防止摘要模型把规范当成业务正文总结）
  let cleanTextForSummary = '';
  if (typeof content === 'string') {
    cleanTextForSummary = stripResilienceMarkers(content, options);
  } else if (Array.isArray(content)) {
    cleanTextForSummary = extractPureText(stripResilienceMarkers(content, options));
  }

  let foldedSummary = '';
  if (typeof summaryOrFoldFn === 'function') {
    try {
      foldedSummary = summaryOrFoldFn(cleanTextForSummary);
    } catch (err) {
      foldedSummary = '';
    }
  } else if (typeof summaryOrFoldFn === 'string') {
    foldedSummary = summaryOrFoldFn;
  } else {
    foldedSummary = String(summaryOrFoldFn || '');
  }
  foldedSummary = String(foldedSummary != null ? foldedSummary : '');

  // 4. 拼装折叠终态文本
  let finalFoldedText = '';
  if (pillInfo.hasPill && pillInfo.pillText) {
    // 雷区 4：丢弃混合批次同批大日志，仅用干净外壳包裹纯净药丸！
    const cleanPillEnvelope = `<<<[ROLE_DIVIDE_USER]>>>\n${pillInfo.pillText}\n<<<[END_ROLE_DIVIDE_USER]>>>`;
    finalFoldedText = foldedSummary.trimEnd()
      ? `${foldedSummary.trimEnd()}\n${cleanPillEnvelope}`
      : cleanPillEnvelope;
  } else {
    finalFoldedText = foldedSummary;
  }

  // 5. 雷区 6：多模态数组与元数据（cache_control、Symbol、__oneRingMeta）无损继承
  if (typeof content === 'string') {
    return finalFoldedText;
  }

  if (Array.isArray(content)) {
    const tailPart = (pillInfo.hasPill && pillInfo.pillText)
      ? { type: 'text', text: `<<<[ROLE_DIVIDE_USER]>>>\n${pillInfo.pillText}\n<<<[END_ROLE_DIVIDE_USER]>>>` }
      : null;
    return buildFoldedArrayParts(content, foldedSummary, tailPart);
  }

  return finalFoldedText;
}

module.exports = {
  stripResilienceMarkers,
  isProtocolGuidancePill,
  extractTopLevelPillEnvelope,
  foldWithPillIfPresent,
  createPillRegex,
  PILL_OPEN_TAG_REGEX,
  PILL_CLOSE_TAG_REGEX,
  PILL_ANY_TAG_REGEX
};
