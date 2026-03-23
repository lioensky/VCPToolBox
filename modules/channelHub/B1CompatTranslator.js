// modules/channelHub/B1CompatTranslator.js
/**
 * B1 兼容转换器
 * 
 * 职责：
 * - 把现有 /internal/channel-ingest 的 B1 请求转换成 B2 ChannelEventEnvelope
 * - 把 B2 ChannelRuntimeReply 转换回 B1 的 reply.text 格式
 * 
 * 背景：
 * - 迁移期间 B1 需要保留兼容，但不继续扩展新能力
 * - B1 与 B2 共用同一条核心处理链
 * 
 * B1 字段映射到 B2：
 * - agentId → target.agentId
 * - requestId → requestId
 * - channel → channel
 * - client.* → client.*
 * - sender.* → sender.*
 * - topicControl.bindingKey → session.bindingKey
 * - topicControl.currentTopicId → session.currentTopicId
 * - messages → payload.messages
 * - modelConfig.* → runtime.*
 * - vcpConfig.runtimeOverrides → runtime.overrides
 * - reply.text → reply.messages[].text (反向)
 */

const { CHANNEL_EVENT_VERSION } = require('./constants');
const { EventValidationError } = require('./errors');

class B1CompatTranslator {
  constructor(options = {}) {
    this.debugMode = options.debugMode || false;
  }

  /**
   * 将 B1 请求体转换为 B2 ChannelEventEnvelope
   * @param {Object} body - B1 请求体
   * @param {Object} headers - 请求头
   * @returns {Object} B2 ChannelEventEnvelope
   */
  translateRequest(body, headers = {}) {
    const envelope = {
      version: CHANNEL_EVENT_VERSION,
      eventId: body.requestId || `b1-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      adapterId: body.adapterId || headers['x-channel-adapter-id'] || 'b1-compat',
      channel: body.channel || 'unknown',
      eventType: 'message.created',
      occurredAt: Date.now(),
      requestId: body.requestId,
      target: this._translateTarget(body),
      client: this._translateClient(body),
      sender: this._translateSender(body),
      session: this._translateSession(body),
      payload: this._translatePayload(body),
      runtime: this._translateRuntime(body),
      metadata: {
        source: 'b1-compat',
        originalAgentName: body.agentName,
        vcpConfig: body.vcpConfig
      }
    };

    if (this.debugMode) {
      console.log('[B1CompatTranslator] B1 → B2 转换完成:', {
        b1RequestId: body.requestId,
        b2EventId: envelope.eventId,
        agentId: envelope.target.agentId
      });
    }

    return envelope;
  }

  /**
   * 将 B2 ChannelRuntimeReply 转换为 B1 响应格式
   * @param {Object} channelRuntimeReply - B2 运行时回复
   * @returns {Object} B1 响应格式 { reply: { text, content } }
   */
  translateReply(channelRuntimeReply) {
    // 从结构化回复中提取文本
    const textParts = [];
    
    if (channelRuntimeReply.messages && Array.isArray(channelRuntimeReply.messages)) {
      for (const msg of channelRuntimeReply.messages) {
        if (msg.role === 'assistant' && msg.content) {
          if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === 'text' && part.text) {
                textParts.push(part.text);
              }
            }
          } else if (typeof msg.content === 'string') {
            textParts.push(msg.content);
          }
        }
      }
    }

    const replyText = textParts.join('\n');

    const b1Reply = {
      reply: {
        text: replyText,
        content: replyText
      }
    };

    // 如果有 topic 信息，附加到响应中
    if (channelRuntimeReply.topic?.resolvedTopicId) {
      b1Reply.topicId = channelRuntimeReply.topic.resolvedTopicId;
    }

    // 如果有 meta 信息，附加到响应中
    if (channelRuntimeReply.meta) {
      b1Reply.meta = {
        agentId: channelRuntimeReply.meta.agentId,
        model: channelRuntimeReply.meta.model
      };
    }

    if (this.debugMode) {
      console.log('[B1CompatTranslator] B2 → B1 转换完成:', {
        replyLength: replyText.length,
        topicId: b1Reply.topicId
      });
    }

    return b1Reply;
  }

  /**
   * 翻译 target 字段
   */
  _translateTarget(body) {
    return {
      agentId: body.agentId || 'default',
      itemType: body.itemType || 'agent',
      itemId: body.agentId || body.itemId || 'default'
    };
  }

  /**
   * 翻译 client 字段
   */
  _translateClient(body) {
    const client = body.client || {};
    return {
      clientType: client.clientType || body.channel || 'unknown',
      conversationId: client.conversationId || client.conversationid || 'unknown',
      conversationType: client.conversationType || client.chatType || 'unknown',
      messageId: client.messageId || client.msgId || `b1-msg-${Date.now()}`,
      messageThreadId: client.messageThreadId || client.threadId || null
    };
  }

  /**
   * 翻译 sender 字段
   */
  _translateSender(body) {
    const sender = body.sender || {};
    return {
      userId: sender.userId || sender.senderId || sender.staffId || 'unknown',
      nick: sender.nick || sender.displayName || sender.name || 'User',
      corpId: sender.corpId || null,
      isAdmin: sender.isAdmin || sender.isadmin || false
    };
  }

  /**
   * 翻译 session 字段
   */
  _translateSession(body) {
    const topicControl = body.topicControl || {};
    const client = body.client || {};
    
    // 构建 bindingKey
    let bindingKey = topicControl.bindingKey;
    if (!bindingKey) {
      // 尝试从 client 信息构建
      const channel = body.channel || 'unknown';
      const convId = client.conversationId || client.conversationid || 'unknown';
      const senderObj = body.sender || {};
      const userId = senderObj.userId || senderObj.senderId || senderObj.staffId || 'unknown';
      bindingKey = `${channel}:${client.conversationType || 'chat'}:${convId}:${userId}`;
    }

    return {
      bindingKey: bindingKey,
      externalSessionKey: topicControl.externalSessionKey || bindingKey,
      currentTopicId: topicControl.currentTopicId || topicControl.topicId || null,
      allowCreateTopic: topicControl.allowCreateTopic !== false,
      allowSwitchTopic: topicControl.allowSwitchTopic !== false
    };
  }

  /**
   * 翻译 payload 字段
   */
  _translatePayload(body) {
    const messages = body.messages || [];
    
    // 确保 messages 格式正确
    const normalizedMessages = messages.map(msg => {
      if (typeof msg.content === 'string') {
        return {
          role: msg.role || 'user',
          content: [{ type: 'text', text: msg.content }]
        };
      } else if (Array.isArray(msg.content)) {
        return {
          role: msg.role || 'user',
          content: msg.content
        };
      }
      return msg;
    });

    return {
      messages: normalizedMessages
    };
  }

  /**
   * 翻译 runtime 字段
   */
  _translateRuntime(body) {
    const modelConfig = body.modelConfig || {};
    const vcpConfig = body.vcpConfig || {};
    const runtimeOverrides = vcpConfig.runtimeOverrides || {};

    return {
      stream: false, // B1 桥接默认非流式
      model: modelConfig.model || body.agentId || 'default',
      overrides: {
        apiKey: runtimeOverrides.apiKey || '',
        apiBase: runtimeOverrides.apiBase || runtimeOverrides.apiBaseUrl || '',
        timeoutMs: runtimeOverrides.timeoutMs || 90000,
        model: runtimeOverrides.model || modelConfig.model
      }
    };
  }
}

module.exports = B1CompatTranslator;