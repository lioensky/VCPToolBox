// modules/vcpLoop/toolCallParser.js
const toolMarkerFuzzyMatcher = require('./toolMarkerFuzzyMatcher');

class ToolCallParser {
  static MARKERS = {
    START: '<<<' + '[TOOL_REQUEST]>>>',
    END: '<<<' + '[END_TOOL_REQUEST]>>>'
  };

  static ESCAPE_MARKERS = {
    START: '「始' + 'ESCAPE」',
    END: '「末' + 'ESCAPE」'
  };

  static ESCAPED_LITERAL_MAP = {
    ['<<<[TOOL_REQUEST_' + 'ESCAPE]>>>']: '<<<' + '[TOOL_REQUEST]>>>',
    ['<<<[END_TOOL_REQUEST_' + 'ESCAPE]>>>']: '<<<' + '[END_TOOL_REQUEST]>>>',
    ['「始' + 'ESCAPE」']: '「始」',
    ['「末' + 'ESCAPE」']: '「末」'
  };

  /**
   * 收集正文中不受思考标签状态机影响的字面量保护区间：
   * 1. 权威工具结果域：VCP调用结果信息汇总 ... VCP调用结果结束（嵌套感知）
   * 2. Markdown 围栏代码块：``` ... ``` 与 ~~~ ... ~~~（含 0-3 空格缩进与流尾未闭合围栏）
   * 3. Markdown 行内代码跨度：` ... `（限制在同段落内，且豁免颜文字反引号）
   *
   * 注意：已进入真实思考块（depth > 0）后，思考块内部的伪代码块由外层思考状态优先统辖，
   * 调用方仅在 depth === 0 时查询本保护区间，从而确保思考块内的伪代码块+伪工具 100% 被剥离。
   *
   * @param {string} content
   * @returns {Array<{start: number, end: number, kind: string}>}
   */
  static _collectReasoningLiteralRanges(content) {
    if (!content || typeof content !== 'string') return [];

    const ranges = [];
    const len = content.length;
    const TOOL_RESULT_OPEN = '[' + '[VCP调用结果信息汇总:';
    const TOOL_RESULT_CLOSE = 'VCP调用结果结束]' + ']';
    const EMOTICONS = ['(`・ω・´)ゞ', '(・`ω´・)', '(`・ω・´)', '(`･ω･´)'];

    const isEmoticonBacktick = (idx) => EMOTICONS.some(emo => {
      const offset = emo.indexOf('`');
      return idx >= offset && content.startsWith(emo, idx - offset);
    });

    const countRun = (idx, ch) => {
      let c = idx;
      while (c < len && content[c] === ch) c += 1;
      return c - idx;
    };

    const findLineEnd = (idx) => {
      const nl = content.indexOf('\n', idx);
      return nl === -1 ? len : nl;
    };

    const lineStartAt = (idx) => (idx === 0 ? 0 : content.lastIndexOf('\n', idx - 1) + 1);

    let cursor = 0;
    while (cursor < len) {
      // 1. 优先识别工具结果数据域（嵌套感知）
      if (content.startsWith(TOOL_RESULT_OPEN, cursor)) {
        let depth = 1;
        let scan = cursor + TOOL_RESULT_OPEN.length;
        let nextOpen = content.indexOf(TOOL_RESULT_OPEN, scan);
        let regionEnd = len;

        while (scan <= len) {
          const nextClose = content.indexOf(TOOL_RESULT_CLOSE, scan);
          if (nextClose === -1) {
            regionEnd = len;
            break;
          }
          if (nextOpen !== -1 && nextOpen < nextClose) {
            depth += 1;
            scan = nextOpen + TOOL_RESULT_OPEN.length;
            nextOpen = content.indexOf(TOOL_RESULT_OPEN, scan);
            continue;
          }
          depth -= 1;
          scan = nextClose + TOOL_RESULT_CLOSE.length;
          if (depth === 0) {
            regionEnd = scan;
            break;
          }
          if (nextOpen !== -1 && nextOpen < scan) {
            nextOpen = content.indexOf(TOOL_RESULT_OPEN, scan);
          }
        }

        ranges.push({ start: cursor, end: regionEnd, kind: 'tool-result' });
        cursor = regionEnd;
        continue;
      }

      const ch = content[cursor];

      // 2. 识别 Markdown 围栏代码块（``` 或 ~~~，行首 0-3 空格缩进）
      if (ch === '`' || ch === '~') {
        const runLen = countRun(cursor, ch);
        const lineStart = lineStartAt(cursor);
        const prefix = content.slice(lineStart, cursor);
        const lineEnd = findLineEnd(cursor + runLen);
        const infoString = content.slice(cursor + runLen, lineEnd);

        const isValidFenceOpen =
          runLen >= 3 &&
          /^[ \t]{0,3}$/.test(prefix) &&
          (ch !== '`' || !infoString.includes('`'));

        if (isValidFenceOpen) {
          let scanLineStart = lineEnd < len ? lineEnd + 1 : len;
          let fenceEnd = len;

          while (scanLineStart <= len) {
            const scanLineEnd = findLineEnd(scanLineStart);
            let mStart = scanLineStart;
            let indent = 0;
            while (
              mStart < scanLineEnd &&
              indent < 3 &&
              (content[mStart] === ' ' || content[mStart] === '\t')
            ) {
              mStart += 1;
              indent += 1;
            }
            if (content[mStart] === ch) {
              const closeLen = countRun(mStart, ch);
              const trailing = content.slice(mStart + closeLen, scanLineEnd);
              if (closeLen >= runLen && /^[ \t]*\r?$/.test(trailing)) {
                fenceEnd = scanLineEnd < len ? scanLineEnd + 1 : scanLineEnd;
                break;
              }
            }
            if (scanLineEnd >= len) break;
            scanLineStart = scanLineEnd + 1;
          }

          ranges.push({ start: cursor, end: fenceEnd, kind: 'fence' });
          cursor = fenceEnd;
          continue;
        }

        // 3. 识别 Markdown 行内反引号代码跨度（不跨空行，豁免颜文字）
        if (ch === '`') {
          if (runLen === 1 && isEmoticonBacktick(cursor)) {
            cursor += 1;
            continue;
          }
          const contentStart = cursor + runLen;
          const remainder = content.slice(contentStart);
          const paraBoundary = /\r?\n[ \t]*\r?\n/.exec(remainder);
          const limit = paraBoundary ? contentStart + paraBoundary.index : len;

          let scan = contentStart;
          let inlineEnd = -1;
          while (scan < limit) {
            const nextBt = content.indexOf('`', scan);
            if (nextBt === -1 || nextBt >= limit) break;
            const closeLen = countRun(nextBt, '`');
            if (closeLen === runLen) {
              inlineEnd = nextBt + closeLen;
              break;
            }
            scan = nextBt + closeLen;
          }

          if (inlineEnd !== -1) {
            ranges.push({ start: cursor, end: inlineEnd, kind: 'inline' });
            cursor = inlineEnd;
            continue;
          }

          cursor += runLen;
          continue;
        }
      }

      cursor += 1;
    }

    return ranges;
  }

  /**
   * 剥离顶层独占行的 VCP元思考链 明文块，防止模型模仿系统元思考链格式并在其中演练伪造的工具调用。
   * 代码域与工具结果域内的同名文本原样保留。
   *
   * @param {string} content
   * @param {Array<{start: number, end: number, kind: string}>} [precomputedLiteralRanges]
   * @returns {string}
   */
  static _stripVcpMetaThoughtBlocks(content, precomputedLiteralRanges = null) {
    const META_OPEN_TOKEN = '[--- ' + 'VCP元思考链';
    if (!content || typeof content !== 'string' || !content.includes(META_OPEN_TOKEN)) {
      return content;
    }

    const literalRanges = precomputedLiteralRanges || this._collectReasoningLiteralRanges(content);
    const isInsideLiteral = (idx) => literalRanges.some(r => idx >= r.start && idx < r.end);

    const startRegex = new RegExp('^[ \\t]*\\[--- ' + 'VCP元思考链(?::\\s*"[^"]*")?\\s*---\\][ \\t]*(?:\\r?\\n|$)', 'gm');
    const endRegex = new RegExp('^[ \\t]*\\[--- ' + '元思考链结束 ---\\][ \\t]*(?:\\r?\\n|$)', 'gm');

    const chunks = [];
    let cursor = 0;
    let startMatch;

    while ((startMatch = startRegex.exec(content)) !== null) {
      if (startMatch.index < cursor || isInsideLiteral(startMatch.index)) {
        continue;
      }

      chunks.push(content.slice(cursor, startMatch.index));

      endRegex.lastIndex = startMatch.index + startMatch[0].length;
      let endMatch = null;
      while ((endMatch = endRegex.exec(content)) !== null) {
        if (!isInsideLiteral(endMatch.index)) break;
      }

      if (!endMatch) {
        // 顶层元思考链未闭合：保守丢弃其后内容
        return chunks.join('');
      }

      cursor = endMatch.index + endMatch[0].length;
      startRegex.lastIndex = cursor;
    }

    chunks.push(content.slice(cursor));
    return chunks.join('');
  }

  /**
   * 从可见正文中剥离模型思考块（内外测度精准收敛版）。
   *
   * @param {string} content
   * @returns {string}
   */
  static stripReasoningBlocks(content) {
    if (!content || typeof content !== 'string') return '';

    const preCleaned = this._stripVcpMetaThoughtBlocks(content);
    if (!preCleaned || !preCleaned.includes('<')) return preCleaned;

    // 1. 预收集顶层代码域与工具结果保护域（仅在 depth === 0 时生效）
    const literalRanges = this._collectReasoningLiteralRanges(preCleaned);
    let literalCursor = 0;
    const findContainingLiteralRange = (idx) => {
      while (literalCursor < literalRanges.length && literalRanges[literalCursor].end <= idx) {
        literalCursor += 1;
      }
      const range = literalRanges[literalCursor];
      return range && idx >= range.start && idx < range.end ? range : null;
    };

    const isInsideAnyLiteral = (idx) => {
      for (let i = 0; i < literalRanges.length; i++) {
        if (idx < literalRanges[i].start) return false;
        if (idx < literalRanges[i].end) return true;
      }
      return false;
    };

    // 2. 收集在代码域/工具结果域之外出现的完整工具请求块候选
    //    （仅当扫描游标在 depth === 0 到达时才激活原子保护，思考块内部的伪工具块不保护）
    const topLevelToolCandidates = [];
    let toolScanOffset = 0;
    while (toolScanOffset < preCleaned.length) {
      const startMatch = toolMarkerFuzzyMatcher.findBlockStartMarker(preCleaned, toolScanOffset);
      if (!startMatch) break;

      if (isInsideAnyLiteral(startMatch.index)) {
        toolScanOffset = startMatch.index + startMatch.marker.length;
        continue;
      }

      const blockStart = startMatch.index + startMatch.marker.length;
      const endMatch = this._findBlockEnd(preCleaned, blockStart);
      if (!endMatch) {
        break;
      }
      const blockEnd = endMatch.index + endMatch.marker.length;
      topLevelToolCandidates.push({ start: startMatch.index, end: blockEnd });
      toolScanOffset = blockEnd;
    }

    let toolCandidateCursor = 0;
    const findContainingToolCandidate = (idx) => {
      while (
        toolCandidateCursor < topLevelToolCandidates.length &&
        topLevelToolCandidates[toolCandidateCursor].end <= idx
      ) {
        toolCandidateCursor += 1;
      }
      const cand = topLevelToolCandidates[toolCandidateCursor];
      return cand && idx >= cand.start && idx < cand.end ? cand : null;
    };

    // 判断标签是否处于行首（同行左侧仅有空白字符）
    const isAtLineStart = (idx) => {
      const lineStart = idx === 0 ? 0 : preCleaned.lastIndexOf('\n', idx - 1) + 1;
      return /^[ \t]*$/.test(preCleaned.slice(lineStart, idx));
    };

    // 判断闭合标签是否处于行尾或独占一行（用于甄别真实的无头思考泄漏 vs 句中内联讨论）
    const isAtLineEndOrStandalone = (tagStart, tagEnd) => {
      const lineEndIdx = preCleaned.indexOf('\n', tagEnd);
      const lineEnd = lineEndIdx === -1 ? preCleaned.length : lineEndIdx;
      const trailing = preCleaned.slice(tagEnd, lineEnd);
      return isAtLineStart(tagStart) || /^[ \t]*\r?$/.test(trailing);
    };

    // 严格单行无尖括号思考标签正则（动态构造以避免自指）：
    const TAG_PATTERN = '<[ \\t]*(\\/?)[ \\t]*(think(?:ing)?|thought|antthinking)\\b(?:[ \\t]+[^>\\r\\n<]*?)?[ \\t]*>';
    const tagRegex = new RegExp(TAG_PATTERN, 'gi');

    // 预检某个句中内联开标签（!lineStart）在后续非保护域中是否存在配对的闭合标签：
    const hasMatchingCloseAhead = (openEndIndex) => {
      const probeRegex = new RegExp(TAG_PATTERN, 'gi');
      probeRegex.lastIndex = openEndIndex;
      let probeDepth = 1;
      let probeMatch;
      while ((probeMatch = probeRegex.exec(preCleaned)) !== null) {
        const pIdx = probeMatch.index;
        if (isInsideAnyLiteral(pIdx)) {
          continue;
        }
        const inTool = topLevelToolCandidates.some(tc => pIdx >= tc.start && pIdx < tc.end);
        if (inTool) {
          continue;
        }
        if (probeMatch[1] === '/') {
          probeDepth -= 1;
          if (probeDepth === 0) return true;
        } else {
          probeDepth += 1;
        }
      }
      return false;
    };

    const chunks = [];
    let cursor = 0;
    let depth = 0;
    let hasClosedAnyBlock = false;
    let match;

    while ((match = tagRegex.exec(preCleaned)) !== null) {
      const matchStart = match.index;
      const matchEnd = tagRegex.lastIndex;
      const isClosingTag = match[1] === '/';

      // 当处于思考块外部（depth === 0）时，保护代码围栏、行内代码、工具结果以及顶层已确立的工具请求块
      if (depth === 0) {
        const litRange = findContainingLiteralRange(matchStart);
        if (litRange) {
          tagRegex.lastIndex = litRange.end;
          continue;
        }

        const toolCand = findContainingToolCandidate(matchStart);
        if (toolCand) {
          tagRegex.lastIndex = toolCand.end;
          continue;
        }
      }

      if (depth === 0) {
        if (isClosingTag) {
          // 潜空间无头思考泄漏（Headless Reasoning Leak）：
          // 此前没有任何已闭合思考块，且该闭合标签位于行首或行尾（非句中内联提及），
          // 则判定从开头至该闭合标签之间的内容（含其中演练的伪工具草稿）均为无头思考泄漏，整体丢弃！
          if (
            !hasClosedAnyBlock &&
            isAtLineEndOrStandalone(matchStart, matchEnd)
          ) {
            chunks.length = 0;
            hasClosedAnyBlock = true;
            cursor = matchEnd;
            continue;
          }

          // 句中孤立提及的结束标签（如“将</think>之间的工具屏蔽”）：仅移除标签自身，保留两侧正文
          chunks.push(preCleaned.slice(cursor, matchStart));
          cursor = matchEnd;
          continue;
        }

        // depth === 0 遇到开始标签：
        // 若该开始标签嵌在句子中间（!isAtLineStart），且后续非保护域直到文末都没有配对闭合标签，
        // 则直接判定为正文行内自指字面量，原地放行不进入思考深度！
        if (!isAtLineStart(matchStart) && !hasMatchingCloseAhead(matchEnd)) {
          continue;
        }

        chunks.push(preCleaned.slice(cursor, matchStart));
        depth = 1;
        cursor = matchEnd;
        continue;
      }

      // depth > 0（处于真实思考块内部）
      if (isClosingTag) {
        depth -= 1;
        if (depth === 0) {
          hasClosedAnyBlock = true;
        }
      } else {
        depth += 1;
      }

      cursor = matchEnd;
    }

    // depth > 0 表示行首开启的真实思考流未闭合：为防止截断思考中的伪工具被执行，保守丢弃尾部
    if (depth === 0) {
      chunks.push(content === preCleaned ? content.slice(cursor) : preCleaned.slice(cursor));
    }

    return chunks.join('');
  }

  /**
   * 解析AI响应中的所有工具调用
   * @param {string} content - AI响应内容
   * @returns {Array<{name: string, args: object, archery: boolean, archeryNoReply?: boolean}>}
   */
  static parse(content) {
    if (!content || typeof content !== 'string') return [];

    const contentWithoutThink = this.stripReasoningBlocks(content);
    const toolCalls = [];
    let searchOffset = 0;

    while (searchOffset < contentWithoutThink.length) {
      const blockInfo = this.extractNextToolBlock(contentWithoutThink, searchOffset);
      if (!blockInfo) break;

      const parsed = this.parseBlock(blockInfo.blockContent);
      if (parsed) {
        toolCalls.push(parsed);
      }

      searchOffset = blockInfo.nextOffset;
    }

    return toolCalls;
  }

  /**
   * 提取从指定偏移开始的下一个工具块，忽略 ESCAPE 字段中的结束标记。
   * @param {string} content
   * @param {number} fromIndex
   * @returns {{blockContent: string, startIndex: number, endIndex: number, nextOffset: number}|null}
   */
  static extractNextToolBlock(content, fromIndex = 0) {
    if (!content || typeof content !== 'string') return null;

    const startMatch = toolMarkerFuzzyMatcher.findBlockStartMarker(content, fromIndex);
    if (!startMatch) return null;

    const blockStart = startMatch.index + startMatch.marker.length;
    const endMatch = this._findBlockEnd(content, blockStart);
    if (!endMatch) return null;

    return {
      blockContent: content.substring(blockStart, endMatch.index).trim(),
      startIndex: startMatch.index,
      endIndex: endMatch.index,
      nextOffset: endMatch.index + endMatch.marker.length
    };
  }

  /**
   * 解析单个工具调用块，可供其他入口（如人类直调工具）复用
   * @param {string} blockContent
   * @returns {{name: string, args: object, archery: boolean, archeryNoReply: boolean, markHistory: boolean, river: string|null, vref: string|null}|null}
   */
  static parseBlock(blockContent) {
    if (!blockContent || typeof blockContent !== 'string') return null;

    const fields = this._scanFields(blockContent);
    if (fields.length === 0) return null;

    const args = {};
    let toolName = null;
    let jevVirtualField = null;
    let isArchery = false;
    let archeryNoReply = false;
    let markHistory = false;
    let river = null;
    let vref = null;

    for (const field of fields) {
      const trimmedValue = field.value.trim();

      if (field.key === 'tool_name') {
        toolName = trimmedValue;
      } else if (field.key.toLowerCase() === 'jev') {
        // JEV 可能是顶层实验性虚拟工具，也可能是真实工具（如 LightMemo、LexibankOperator）的合法参数。
        // 暂存该字段，留待全部字段扫描完毕后依据 tool_name 是否显式声明进行延迟裁决，消解顺序敏感与身份抢占歧义。
        jevVirtualField = field;
      } else if (field.key === 'archery') {
        isArchery = trimmedValue === 'true' || trimmedValue === 'no_reply';
        archeryNoReply = trimmedValue === 'no_reply';
      } else if (field.key === 'ink') {
        markHistory = trimmedValue === 'mark_history';
      } else if (field.key === 'river') {
        river = trimmedValue;
      } else if (field.key === 'vref') {
        vref = trimmedValue;
      } else {
        // 工具参数：保留前导缩进（仅剥离首行紧贴标记的单次换行，以及末尾的单次换行/空白）
        args[field.key] = this._normalizeFieldValue(field.value);
      }
    }

    // 字段扫描完成后的延迟裁决：
    if (jevVirtualField) {
      if (!toolName) {
        // 未显式声明 tool_name 时，作为顶层实验性虚拟工具触发：
        // 它没有真实 plugin manifest，由 ToolExecutor 在插件查找前展开为一个或多个白名单真实工具调用。
        toolName = 'JEV';
        args.expression = jevVirtualField.value.trim();
      } else {
        // 已显式声明 tool_name（如 LightMemo、LexibankOperator 等）：
        // jev 作为该实体工具的普通参数处理，保留规范化后的参数值。
        args[jevVirtualField.key] = this._normalizeFieldValue(jevVirtualField.value);
      }
    }

    // 兼容中性署名字段 valet：现有工具链统一读取 args.maid，
    // 因此当 valet 存在且 maid 未显式提供时，镜像一份到 maid。
    if (args.valet && !args.maid) {
      args.maid = args.valet;
    }

    return toolName ? { name: toolName, args, archery: isArchery, archeryNoReply, markHistory, river, vref } : null;
  }

  static _findBlockEnd(content, fromIndex) {
    let cursor = fromIndex;
    const escapeStartRegex = toolMarkerFuzzyMatcher.getEscapeStartRegex(false);
    const escapeEndRegex = toolMarkerFuzzyMatcher.getEscapeEndRegex(false);

    while (cursor < content.length) {
      const remaining = content.slice(cursor);
      const startMatch = escapeStartRegex.exec(remaining);
      const nextEscapeStart = startMatch ? cursor + startMatch.index : -1;
      
      const endMatch = toolMarkerFuzzyMatcher.findBlockEndMarker(content, cursor);

      if (!endMatch) return null;
      if (nextEscapeStart === -1 || endMatch.index < nextEscapeStart) {
        return endMatch;
      }

      const searchStartFrom = nextEscapeStart + startMatch[0].length;
      const escapeEndMatch = escapeEndRegex.exec(content.slice(searchStartFrom));

      if (!escapeEndMatch) {
        return null;
      }

      const escapedEnd = searchStartFrom + escapeEndMatch.index;
      cursor = escapedEnd + escapeEndMatch[0].length;
    }

    return null;
  }

  static _scanFields(blockContent) {
    const fields = [];
    let cursor = 0;

    while (cursor < blockContent.length) {
      cursor = this._skipWhitespaceAndCommas(blockContent, cursor);
      if (cursor >= blockContent.length) break;

      const keyMatch = /^[\w_]+/.exec(blockContent.slice(cursor));
      if (!keyMatch) {
        cursor += 1;
        continue;
      }

      const key = keyMatch[0];
      cursor += key.length;
      cursor = this._skipWhitespace(blockContent, cursor);

      if (blockContent[cursor] !== ':') {
        continue;
      }
      cursor += 1;
      cursor = this._skipWhitespace(blockContent, cursor);

      let startMarker = null;
      let endMarker = null;
      let endIndex = -1;
      let isEscape = false;

      const escapeStartRegex = toolMarkerFuzzyMatcher.getEscapeStartRegex(true);
      const escapeMatch = escapeStartRegex.exec(blockContent.slice(cursor));

      if (escapeMatch) {
        isEscape = true;
        startMarker = escapeMatch[0];
        cursor += startMarker.length;

        const escapeEndRegex = toolMarkerFuzzyMatcher.getEscapeEndRegex(false);
        const endMatch = escapeEndRegex.exec(blockContent.slice(cursor));
        if (endMatch) {
          endIndex = cursor + endMatch.index;
          endMarker = endMatch[0];
        }
      } else {
        const startMatch = toolMarkerFuzzyMatcher.matchFieldStartMarker(blockContent, cursor);

        if (!startMatch) {
          continue;
        }

        startMarker = startMatch.marker;
        cursor += startMarker.length;

        const endMatch = toolMarkerFuzzyMatcher.findFieldEndMarker(blockContent, cursor);
        if (endMatch) {
          endIndex = endMatch.index;
          endMarker = endMatch.marker;
        }
      }

      if (endIndex === -1) {
        break;
      }

      const rawValue = blockContent.slice(cursor, endIndex);
      const restoredValue = isEscape
        ? this._restoreEscapedLiterals(rawValue)
        : rawValue;

      fields.push({ key, value: restoredValue });

      cursor = endIndex + endMarker.length;
      cursor = this._skipWhitespace(blockContent, cursor);
      if (blockContent[cursor] === ',') {
        cursor += 1;
      }
    }

    return fields;
  }

  /**
   * 规范化参数字段值：
   * 保护首行与各行的代码/文本前导缩进（禁止直接使用全量 trim()）。
   * 1. 若首字符紧跟换行（\r\n 或 \n），剥离该换行符，但保留第一行代码的缩进空格。
   * 2. 剥离末尾的换行及尾随空白。
   * @param {string} value
   * @returns {string}
   */
  static _normalizeFieldValue(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/^(?:\r?\n)/, '').replace(/(?:\r?\n)?[ \t]*$/, '');
  }

  static _restoreEscapedLiterals(content) {
    let restored = content;
    for (const [escapedValue, literalValue] of Object.entries(this.ESCAPED_LITERAL_MAP)) {
      restored = restored.split(escapedValue).join(literalValue);
    }
    restored = restored.replace(toolMarkerFuzzyMatcher.getEscapeStartRegex(false), '「始」');
    restored = restored.replace(toolMarkerFuzzyMatcher.getEscapeEndRegex(false), '「末」');
    return restored;
  }

  static _skipWhitespace(content, index) {
    while (index < content.length && /\s/.test(content[index])) {
      index += 1;
    }
    return index;
  }

  static _skipWhitespaceAndCommas(content, index) {
    while (index < content.length && /[\s,]/.test(content[index])) {
      index += 1;
    }
    return index;
  }

  /**
   * 分离普通调用和Archery调用
   */
  static separate(toolCalls) {
    return {
      normal: toolCalls.filter(tc => !tc.archery),
      archery: toolCalls.filter(tc => tc.archery)
    };
  }
}

module.exports = ToolCallParser;
