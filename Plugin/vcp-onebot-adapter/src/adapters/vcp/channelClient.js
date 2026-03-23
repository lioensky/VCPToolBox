/**
 * VCP ChannelHub 客户端 (B2 协议)
 * 
 * 将 OneBot 事件转换为 ChannelEventEnvelope 格式发送到 VCP ChannelHub
 * 接收 ChannelRuntimeReply 格式的回复
 */

import { randomUUID } from 'crypto';

const CHANNEL_EVENT_VERSION = '2.0';

/**
 * 创建 VCP ChannelHub 客户端
 * @param {Object} options
 * @param {string} options.channelHubUrl - ChannelHub 事件入口 URL
 * @param {string} options.bridgeKey - 桥接密钥
 * @param {string} options.adapterId - 适配器 ID
 * @param {string} options.defaultAgentName - 默认 Agent 名称
 * @param {string} options.defaultAgentDisplayName - 默认 Agent 显示名称
 * @param {number} options.timeoutMs - 超时时间
 * @param {Object} options.logger - 日志器
 */
export function createVcpChannelClient({
  channelHubUrl,
  bridgeKey,
  adapterId,
  defaultAgentName = 'Nova',
  defaultAgentDisplayName = 'Nova',
  timeoutMs = 120000,
  logger = console,
}) {
  /**
   * 生成唯一 ID
   */
  function generateId(prefix = 'evt') {
    return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  }

  /**
   * 将 OneBot 消息转换为 ChannelEventEnvelope
   * @param {Object} onebotEvent - OneBot 原始事件
   * @param {Object} options - 额外选项
   * @returns {Object} ChannelEventEnvelope
   */
  function convertToEnvelope(onebotEvent, options = {}) {
    const now = Date.now();
    const eventId = generateId('evt');
    const requestId = generateId('req');

    // 解析消息类型
    const messageType = onebotEvent.message_type; // private / group
    const isGroup = messageType === 'group';

    // 解析发送者信息
    const sender = onebotEvent.sender || {};
    const userId = onebotEvent.user_id;
    const groupId = onebotEvent.group_id;

    // 构建 bindingKey
    const bindingKey = isGroup
      ? `qq:group:${groupId}:${userId}`
      : `qq:private:${userId}`;

    // 解析消息内容
    const messages = parseOneBotMessage(onebotEvent);

    // 构建 ChannelEventEnvelope
    const envelope = {
      version: CHANNEL_EVENT_VERSION,
      eventId,
      adapterId,
      channel: 'qq',
      eventType: 'message.created',
      occurredAt: now,
      requestId,
      target: {
        agentId: options.agentId || defaultAgentName,
        itemType: 'agent',
        itemId: options.agentId || defaultAgentName,
      },
      client: {
        clientType: 'qq',
        conversationId: isGroup ? `group_${groupId}` : `private_${userId}`,
        conversationType: isGroup ? 'group' : 'private',
        messageId: String(onebotEvent.message_id || eventId),
        messageThreadId: null,
      },
      sender: {
        userId: String(userId),
        nick: sender.nickname || sender.card || `用户${userId}`,
        isAdmin: isGroup ? (sender.role === 'admin' || sender.role === 'owner') : false,
        // QQ 平台特有字段
        qq: userId,
        card: sender.card || '',
        role: sender.role || 'member',
        title: sender.title || '',
      },
      session: {
        bindingKey,
        externalSessionKey: bindingKey,
        currentTopicId: null,
        allowCreateTopic: true,
        allowSwitchTopic: true,
      },
      payload: {
        messages: [
          {
            role: 'user',
            content: messages,
          },
        ],
      },
      runtime: {
        stream: false,
        model: options.agentId || defaultAgentName,
        overrides: {
          apiKey: '',
          apiBase: '',
          timeoutMs,
        },
      },
      metadata: {
        platform: 'qq',
        onebot: {
          raw: onebotEvent,
          time: onebotEvent.time,
          self_id: onebotEvent.self_id,
          post_type: onebotEvent.post_type,
          message_type: onebotEvent.message_type,
          sub_type: onebotEvent.sub_type,
          group_id: groupId,
          user_id: userId,
          message_id: onebotEvent.message_id,
          font: onebotEvent.font,
        },
      },
    };

    return envelope;
  }

  /**
   * 解析 OneBot 消息段
   * @param {Object} onebotEvent - OneBot 事件
   * @returns {Array} 标准化的消息内容数组
   */
  function parseOneBotMessage(onebotEvent) {
    const content = [];
    const message = onebotEvent.message || [];

    for (const segment of message) {
      switch (segment.type) {
        case 'text':
          if (segment.data?.text) {
            content.push({
              type: 'text',
              text: segment.data.text,
            });
          }
          break;

        case 'image':
          if (segment.data?.url || segment.data?.file) {
            content.push({
              type: 'image_url',
              image_url: {
                url: segment.data.url || `file://${segment.data.file}`,
                fileName: segment.data.file || '',
              },
            });
          }
          break;

        case 'at':
          // @ 消息转换为文本
          const atText = segment.data?.qq === 'all'
            ? '@全体成员 '
            : `@${segment.data?.name || segment.data?.qq || ''} `;
          content.push({
            type: 'text',
            text: atText,
          });
          break;

        case 'face':
          // QQ 表情转换为文本描述
          content.push({
            type: 'text',
            text: `[表情:${segment.data?.id || ''}]`,
          });
          break;

        case 'record':
          // 语音消息
          if (segment.data?.url || segment.data?.file) {
            content.push({
              type: 'audio_url',
              audio_url: {
                url: segment.data.url || `file://${segment.data.file}`,
              },
            });
          }
          break;

        case 'video':
          // 视频消息
          if (segment.data?.url || segment.data?.file) {
            content.push({
              type: 'video_url',
              video_url: {
                url: segment.data.url || `file://${segment.data.file}`,
              },
            });
          }
          break;

        case 'file':
          // 文件消息
          if (segment.data?.url || segment.data?.file) {
            content.push({
              type: 'file_url',
              file_url: {
                url: segment.data.url || `file://${segment.data.file}`,
                fileName: segment.data.file || 'unknown',
              },
            });
          }
          break;

        case 'reply':
          // 回复消息 - 添加引用信息
          content.push({
            type: 'text',
            text: `[回复消息ID:${segment.data?.id || ''}] `,
          });
          break;

        case 'forward':
          // 转发消息
          content.push({
            type: 'text',
            text: '[转发消息]',
          });
          break;

        case 'json':
        case 'xml':
          // 结构化消息
          content.push({
            type: 'text',
            text: `[${segment.type === 'json' ? 'JSON卡片' : 'XML卡片'}]`,
          });
          break;

        default:
          // 未知类型
          logger.debug('[vcp] Unknown OneBot segment type:', segment.type);
          content.push({
            type: 'text',
            text: `[${segment.type}]`,
          });
      }
    }

    // 如果没有任何内容，添加占位文本
    if (content.length === 0) {
      content.push({
        type: 'text',
        text: '[空消息]',
      });
    }

    return content;
  }

  /**
   * 发送事件到 ChannelHub
   * @param {Object} envelope - ChannelEventEnvelope
   * @returns {Promise<Object>} ChannelRuntimeReply
   */
  async function sendEvent(envelope) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        'Content-Type': 'application/json',
      };

      if (bridgeKey) {
        headers['x-channel-bridge-key'] = bridgeKey;
      }

      // 添加适配器标识
      headers['x-channel-adapter-id'] = adapterId;

      logger.debug('[vcp] Sending event to ChannelHub:', {
        eventId: envelope.eventId,
        requestId: envelope.requestId,
      });

      const response = await fetch(channelHubUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ChannelHub error: ${response.status} ${errorText}`);
      }

      const reply = await response.json();
      logger.debug('[vcp] Received reply from ChannelHub:', {
        requestId: reply.requestId,
        ok: reply.ok,
      });

      return reply;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new Error('ChannelHub request timeout');
      }

      logger.error('[vcp] Failed to send event:', error);
      throw error;
    }
  }

  /**
   * 处理 OneBot 消息并发送到 ChannelHub
   * @param {Object} onebotEvent - OneBot 原始事件
   * @param {Object} options - 选项
   * @returns {Promise<Object>} ChannelRuntimeReply
   */
  async function processAndSend(onebotEvent, options = {}) {
    const envelope = convertToEnvelope(onebotEvent, options);
    return sendEvent(envelope);
  }

  function extractReplyParts(reply) {
    const normalizedReply = reply?.reply || reply;
    const messages = Array.isArray(normalizedReply?.messages) ? normalizedReply.messages : [];
    const parts = [];

    for (const msg of messages) {
      if (!msg) {
        continue;
      }

      if (Array.isArray(msg.content)) {
        parts.push(...msg.content.filter(Boolean));
        continue;
      }

      if (typeof msg.content === 'string') {
        parts.push({
          type: 'text',
          text: msg.content,
        });
        continue;
      }

      if (msg.type) {
        parts.push(msg);
      }
    }

    return parts;
  }

  /**
   * 从 ChannelRuntimeReply 中提取回复文本
   * @param {Object} reply - ChannelRuntimeReply
   * @returns {string} 回复文本
   */
  function extractReplyText(reply) {
    if (!reply) {
      return '';
    }

    const parts = extractReplyParts(reply);
    const textParts = [];

    for (const part of parts) {
      if (part.type === 'text') {
        textParts.push(part.text || '');
      }
    }

    return textParts.join('\n');
  }

  /**
   * 从 ChannelRuntimeReply 中提取富回复内容
   * @param {Object} reply - ChannelRuntimeReply
   * @returns {Object} 富回复对象 { text, images, files, options }
   */
  function extractRichReply(reply) {
    const result = {
      text: '',
      images: [],
      files: [],
      options: [],
    };

    if (!reply) {
      return result;
    }

    const parts = extractReplyParts(reply);

    for (const part of parts) {
      switch (part.type) {
        case 'text':
          result.text += (part.text || '') + '\n';
          break;

        case 'image_url':
          result.images.push({
            url: part.image_url?.url || '',
            fileName: part.image_url?.fileName || '',
          });
          break;

        case 'file_url':
          result.files.push({
            url: part.file_url?.url || '',
            fileName: part.file_url?.fileName || '',
          });
          break;

        case 'action':
          if (part.action?.kind === 'button_group') {
            result.options = (part.action.items || []).map((item) => ({
              id: item.id || '',
              label: item.label || '',
              value: item.value || item.label || '',
            }));
          }
          break;
      }
    }

    result.text = result.text.trim();
    return result;
  }

  return {
    // 核心方法
    convertToEnvelope,
    sendEvent,
    processAndSend,

    // 辅助方法
    extractReplyText,
    extractRichReply,
    extractReplyParts,
    generateId,

    // 配置
    get adapterId() { return adapterId; },
    get channelHubUrl() { return channelHubUrl; },
  };
}
