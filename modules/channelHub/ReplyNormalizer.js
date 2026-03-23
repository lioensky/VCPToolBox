// modules/channelHub/ReplyNormalizer.js
/**
 * 回复归一化器
 * 
 * 职责：
 * - 把 runtime 的原始输出统一整理成 ChannelRuntimeReply
 * - 兼容文本回复和未来结构化富回复
 * - 统一填充 meta、usage、topic
 * 
 * 设计文档：docs/interaction-middleware/CHANNEL_MIDDLEWARE_DESIGN.md 第 6.2.16 节
 */

const { createRequestId } = require('./utils');

/**
 * 回复归一化器类
 */
class ReplyNormalizer {
  /**
   * @param {Object} options - 配置选项
   * @param {boolean} options.debugMode - 调试模式
   */
  constructor(options = {}) {
    this.debugMode = options.debugMode || false;
  }

  /**
   * 归一化运行时输出
   * 
   * @param {Object} rawRuntimeOutput - 运行时原始输出
   * @param {Object} context - 上下文信息
   * @param {string} context.requestId - 请求ID
   * @param {string} context.agentId - Agent ID
   * @param {string} context.sessionKey - 会话Key
   * @param {string} [context.resolvedTopicId] - 解析的Topic ID
   * @returns {Object} - 标准化的 ChannelRuntimeReply
   */
  normalize(rawRuntimeOutput, context = {}) {
    // 判断输出类型并分发
    if (this._isStructuredReply(rawRuntimeOutput)) {
      return this.normalizeStructuredReply(rawRuntimeOutput, context);
    }
    
    return this.normalizeTextReply(rawRuntimeOutput, context);
  }

  /**
   * 判断是否为结构化回复
   * @param {Object} output - 输出对象
   * @returns {boolean}
   * @private
   */
  _isStructuredReply(output) {
    // 检查是否有标准的 messages 数组结构
    return output && 
           Array.isArray(output.messages) && 
           output.messages.length > 0 &&
           output.messages[0].role === 'assistant';
  }

  /**
   * 归一化文本回复
   * 
   * @param {Object} rawRuntimeOutput - 运行时原始输出（文本格式）
   * @param {Object} context - 上下文信息
   * @returns {Object} - ChannelRuntimeReply
   */
  normalizeTextReply(rawRuntimeOutput, context) {
    const {
      requestId = createRequestId(),
      agentId = 'default',
      sessionKey,
      resolvedTopicId
    } = context;

    // 从原始输出提取文本内容
    const textContent = this._extractTextContent(rawRuntimeOutput);
    
    // 提取工具调用事件（如果有）
    const toolEvents = this._extractToolEvents(rawRuntimeOutput);
    
    // 提取使用量信息
    const usage = this._extractUsage(rawRuntimeOutput);

    const reply = {
      replyId: `reply_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      requestId,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: textContent }
          ]
        }
      ],
      toolEvents,
      topic: {
        resolvedTopicId: resolvedTopicId || null
      },
      usage,
      meta: {
        agentId,
        sessionKey,
        normalizedAt: Date.now(),
        format: 'text'
      }
    };

    if (this.debugMode) {
      console.log('[ReplyNormalizer] 归一化文本回复:', {
        replyId: reply.replyId,
        textLength: textContent.length,
        hasToolEvents: toolEvents.length > 0
      });
    }

    return reply;
  }

  /**
   * 归一化结构化回复
   * 
   * @param {Object} rawRuntimeOutput - 运行时原始输出（结构化格式）
   * @param {Object} context - 上下文信息
   * @returns {Object} - ChannelRuntimeReply
   */
  normalizeStructuredReply(rawRuntimeOutput, context) {
    const {
      requestId = createRequestId(),
      agentId = 'default',
      sessionKey,
      resolvedTopicId
    } = context;

    // 处理消息内容
    const normalizedMessages = rawRuntimeOutput.messages.map(msg => {
      if (msg.content && Array.isArray(msg.content)) {
        // 已经是标准的 content parts 格式
        return {
          role: msg.role,
          content: msg.content.map(part => this._normalizeContentPart(part))
        };
      }
      
      // 字符串内容转换为标准格式
      if (typeof msg.content === 'string') {
        return {
          role: msg.role,
          content: [{ type: 'text', text: msg.content }]
        };
      }
      
      return msg;
    });

    const reply = {
      replyId: rawRuntimeOutput.replyId || `reply_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      requestId,
      messages: normalizedMessages,
      toolEvents: rawRuntimeOutput.toolEvents || [],
      topic: {
        resolvedTopicId: resolvedTopicId || rawRuntimeOutput.topic?.resolvedTopicId || null
      },
      usage: rawRuntimeOutput.usage || { promptTokens: 0, completionTokens: 0 },
      meta: {
        agentId,
        sessionKey,
        normalizedAt: Date.now(),
        format: 'structured',
        originalFormat: rawRuntimeOutput.format || 'unknown'
      }
    };

    if (this.debugMode) {
      console.log('[ReplyNormalizer] 归一化结构化回复:', {
        replyId: reply.replyId,
        messageCount: reply.messages.length,
        contentTypes: reply.messages.flatMap(m => m.content.map(c => c.type))
      });
    }

    return reply;
  }

  /**
   * 归一化单个内容部分
   * @param {Object} part - 内容部分
   * @returns {Object} - 归一化后的内容部分
   * @private
   */
  _normalizeContentPart(part) {
    // 确保每个 part 都有 type 字段
    if (!part.type) {
      if (part.text) return { type: 'text', text: part.text };
      if (part.image_url) return { type: 'image_url', image_url: part.image_url };
      if (part.file) return { type: 'file', ...part };
      if (part.audio) return { type: 'audio', ...part };
      if (part.action) return { type: 'action', action: part.action };
      
      // 默认作为文本处理
      return { type: 'text', text: JSON.stringify(part) };
    }
    
    return part;
  }

  /**
   * 从原始输出提取文本内容
   * @param {Object} output - 原始输出
   * @returns {string} - 文本内容
   * @private
   */
  _extractTextContent(output) {
    // 尝试多种常见格式
    if (typeof output === 'string') return output;
    
    if (output.text) return output.text;
    if (output.content) return output.content;
    if (output.reply) return output.reply;
    if (output.message) return output.message;
    if (output.response) return output.response;
    
    if (output.choices && Array.isArray(output.choices)) {
      const choice = output.choices[0];
      if (choice.message?.content) return choice.message.content;
      if (choice.delta?.content) return choice.delta.content;
      if (choice.text) return choice.text;
    }
    
    // 最后尝试 JSON 序列化
    try {
      return JSON.stringify(output, null, 2);
    } catch (e) {
      return '[无法序列化的输出]';
    }
  }

  /**
   * 提取工具调用事件
   * @param {Object} output - 原始输出
   * @returns {Array} - 工具事件列表
   * @private
   */
  _extractToolEvents(output) {
    if (output.toolEvents) return output.toolEvents;
    if (output.tool_calls) {
      return output.tool_calls.map(tc => ({
        toolCallId: tc.id,
        name: tc.function?.name || tc.name,
        arguments: tc.function?.arguments || tc.arguments,
        result: tc.result
      }));
    }
    return [];
  }

  /**
   * 提取使用量信息
   * @param {Object} output - 原始输出
   * @returns {Object} - 使用量对象
   * @private
   */
  _extractUsage(output) {
    if (output.usage) {
      return {
        promptTokens: output.usage.prompt_tokens || output.usage.promptTokens || 0,
        completionTokens: output.usage.completion_tokens || output.usage.completionTokens || 0,
        totalTokens: output.usage.total_tokens || output.usage.totalTokens || 0
      };
    }
    
    return {
      promptTokens: 0,
      completionTokens: 0
    };
  }
}

module.exports = ReplyNormalizer;
