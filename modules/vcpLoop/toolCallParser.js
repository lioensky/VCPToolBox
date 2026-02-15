// modules/vcpLoop/toolCallParser.js
class ToolCallParser {
  static MARKERS = {
    START: '<<<[TOOL_REQUEST]>>>',
    END: '<<<[END_TOOL_REQUEST]>>>'
  };

  /**
   * 解析AI响应中的所有工具调用
   * @param {string} content - AI响应内容
   * @returns {Array<{name: string, args: object, archery: boolean}>}
   */
  static parse(content) {
    if (!content || typeof content !== 'string') return [];

    // 移除 <think> 标签及其内容，防止解析思维链中的工具调用
    const contentWithoutThink = content.replace(/<think>[\s\S]*?<\/think>/g, '');
    
    const toolCalls = [];
    content = contentWithoutThink;
    let searchOffset = 0;

    while (searchOffset < content.length) {
      const startIndex = content.indexOf(this.MARKERS.START, searchOffset);
      if (startIndex === -1) break;

      const endIndex = content.indexOf(
        this.MARKERS.END,
        startIndex + this.MARKERS.START.length
      );
      if (endIndex === -1) {
        searchOffset = startIndex + this.MARKERS.START.length;
        continue;
      }

      const blockContent = content
        .substring(startIndex + this.MARKERS.START.length, endIndex)
        .trim();
      
      const parsed = this._parseBlock(blockContent);
      if (parsed) {
        toolCalls.push(parsed);
      }
      
      searchOffset = endIndex + this.MARKERS.END.length;
    }

    return toolCalls;
  }

  static _parseBlock(blockContent) {
    const paramRegex = /([\w_]+)\s*:\s*「始」([\s\S]*?)「末」\s*(?:,)?/g;
    const args = {};
    let toolName = null;
    let isArchery = false;
    let markHistory = false;
    let match;

    while ((match = paramRegex.exec(blockContent)) !== null) {
      const [, key, value] = match;
      const trimmedValue = value.trim();
      
      if (key === 'tool_name') {
        toolName = trimmedValue;
      } else if (key === 'archery') {
        isArchery = trimmedValue === 'true' || trimmedValue === 'no_reply';
      } else if (key === 'ink') {
        markHistory = trimmedValue === 'mark_history';
      } else {
        args[key] = trimmedValue;
      }
    }

    return toolName ? { name: toolName, args, archery: isArchery, markHistory } : null;
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