// modules/vcpLoop/toolCallParser.js
class ToolCallParser {
  static MARKERS = {
    START: '<<<[TOOL_REQUEST]>>>',
    END: '<<<[END_TOOL_REQUEST]>>>'
  };

  static ESCAPE_MARKERS = {
    START: '「始ESCAPE」',
    END: '「末ESCAPE」'
  };

  static ESCAPED_LITERAL_MAP = {
    '<<<[TOOL_REQUEST_ESCAPE]>>>': '<<<[TOOL_REQUEST]>>>',
    '<<<[END_TOOL_REQUEST_ESCAPE]>>>': '<<<[END_TOOL_REQUEST]>>>',
    '「始ESCAPE」': '「始」',
    '「末ESCAPE」': '「末」'
  };

  /**
   * 解析AI响应中的所有工具调用
   * @param {string} content - AI响应内容
   * @returns {Array<{name: string, args: object, archery: boolean}>}
   */
  static parse(content) {
    if (!content || typeof content !== 'string') return [];

    const contentWithoutThink = content.replace(/<think>[\s\S]*?<\/think>/g, '');
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

    const startIndex = content.indexOf(this.MARKERS.START, fromIndex);
    if (startIndex === -1) return null;

    const blockStart = startIndex + this.MARKERS.START.length;
    const endIndex = this._findBlockEnd(content, blockStart);
    if (endIndex === -1) return null;

    return {
      blockContent: content.substring(blockStart, endIndex).trim(),
      startIndex,
      endIndex,
      nextOffset: endIndex + this.MARKERS.END.length
    };
  }

  /**
   * 解析单个工具调用块，可供其他入口（如人类直调工具）复用
   * @param {string} blockContent
   * @returns {{name: string, args: object, archery: boolean, markHistory: boolean, river: string|null, vref: string|null}|null}
   */
  static parseBlock(blockContent) {
    if (!blockContent || typeof blockContent !== 'string') return null;

    const fields = this._scanFields(blockContent);
    if (fields.length === 0) return null;

    const args = {};
    let toolName = null;
    let isArchery = false;
    let markHistory = false;
    let river = null;
    let vref = null;

    for (const field of fields) {
      const trimmedValue = field.value.trim();

      if (field.key === 'tool_name') {
        toolName = trimmedValue;
      } else if (field.key === 'archery') {
        isArchery = trimmedValue === 'true' || trimmedValue === 'no_reply';
      } else if (field.key === 'ink') {
        markHistory = trimmedValue === 'mark_history';
      } else if (field.key === 'river') {
        river = trimmedValue;
      } else if (field.key === 'vref') {
        vref = trimmedValue;
      } else {
        args[field.key] = trimmedValue;
      }
    }

    return toolName ? { name: toolName, args, archery: isArchery, markHistory, river, vref } : null;
  }

  static _findBlockEnd(content, fromIndex) {
    let cursor = fromIndex;

    while (cursor < content.length) {
      const nextEscapeStart = content.indexOf(this.ESCAPE_MARKERS.START, cursor);
      const nextBlockEnd = content.indexOf(this.MARKERS.END, cursor);

      if (nextBlockEnd === -1) return -1;
      if (nextEscapeStart === -1 || nextBlockEnd < nextEscapeStart) {
        return nextBlockEnd;
      }

      const escapedEnd = content.indexOf(
        this.ESCAPE_MARKERS.END,
        nextEscapeStart + this.ESCAPE_MARKERS.START.length
      );

      if (escapedEnd === -1) {
        return -1;
      }

      cursor = escapedEnd + this.ESCAPE_MARKERS.END.length;
    }

    return -1;
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

      let startMarker;
      let endMarker;
      if (blockContent.startsWith(this.ESCAPE_MARKERS.START, cursor)) {
        startMarker = this.ESCAPE_MARKERS.START;
        endMarker = this.ESCAPE_MARKERS.END;
      } else if (blockContent.startsWith('「始」', cursor)) {
        startMarker = '「始」';
        endMarker = '「末」';
      } else {
        continue;
      }

      cursor += startMarker.length;
      const endIndex = blockContent.indexOf(endMarker, cursor);
      if (endIndex === -1) {
        break;
      }

      const rawValue = blockContent.slice(cursor, endIndex);
      const restoredValue = startMarker === this.ESCAPE_MARKERS.START
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

  static _restoreEscapedLiterals(content) {
    let restored = content;
    for (const [escapedValue, literalValue] of Object.entries(this.ESCAPED_LITERAL_MAP)) {
      restored = restored.split(escapedValue).join(literalValue);
    }
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
