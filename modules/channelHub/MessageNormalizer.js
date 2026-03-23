// modules/channelHub/MessageNormalizer.js
/**
 * 消息归一化器
 * 
 * 职责：
 * - 把各平台原始事件的消息内容统一转换成 runtime 可消费的 content parts
 * - 处理文本、图片、文件、音频等多模态输入
 * - 预留 mention、quote、thread 等元素
 * 
 * 依赖：无
 */

const { CHANNEL_EVENT_TYPES } = require('./constants');

class MessageNormalizer {
  constructor(options = {}) {
    this.debugMode = options.debugMode || false;
  }

  /**
   * 归一化整个事件的消息内容
   * @param {Object} envelope - 标准 ChannelEventEnvelope
   * @returns {Array} - 归一化后的 messages 数组
   */
  normalizeMessages(envelope) {
    const messages = envelope?.payload?.messages || [];
    const normalizedMessages = [];

    for (const msg of messages) {
      const normalized = this._normalizeMessage(msg, envelope);
      if (normalized) {
        normalizedMessages.push(normalized);
      }
    }

    // 确保至少有一条用户消息
    if (normalizedMessages.length === 0 && envelope?.payload?.text) {
      normalizedMessages.push({
        role: 'user',
        content: [{ type: 'text', text: envelope.payload.text }]
      });
    }

    return normalizedMessages;
  }

  /**
   * 归一化单条消息
   * @param {Object} msg - 原始消息对象
   * @param {Object} envelope - 完整的事件 envelope
   * @returns {Object|null} - 归一化后的消息
   */
  _normalizeMessage(msg, envelope) {
    if (!msg) return null;

    const role = msg.role || 'user';
    let content = msg.content;

    // 处理不同类型的 content
    if (typeof content === 'string') {
      content = this._normalizeTextContent(content);
    } else if (Array.isArray(content)) {
      content = this._normalizeContentParts(content, envelope);
    } else if (content && typeof content === 'object') {
      content = this._normalizeObjectContent(content, envelope);
    } else {
      // 兜底：空内容
      content = [{ type: 'text', text: '' }];
    }

    // 过滤掉空的部分
    content = content.filter(part => this._isValidPart(part));

    if (content.length === 0) {
      return null;
    }

    const normalized = { role, content };

    // 保留原始消息的其他字段（如 name）
    if (msg.name) normalized.name = msg.name;

    return normalized;
  }

  /**
   * 归一化纯文本内容
   * @param {string} text - 文本内容
   * @returns {Array} - content parts 数组
   */
  _normalizeTextContent(text) {
    if (!text || typeof text !== 'string') {
      return [{ type: 'text', text: '' }];
    }
    return [{ type: 'text', text: text.trim() }];
  }

  /**
   * 归一化 content parts 数组
   * @param {Array} parts - 原始 parts 数组
   * @param {Object} envelope - 完整的事件 envelope
   * @returns {Array} - 归一化后的 parts
   */
  _normalizeContentParts(parts, envelope) {
    const normalized = [];

    for (const part of parts) {
      const normalizedPart = this.normalizeContentPart(part, envelope);
      if (normalizedPart) {
        normalized.push(normalizedPart);
      }
    }

    return normalized;
  }

  /**
   * 归一化单个 content part
   * @param {Object} part - 原始 part
   * @param {Object} envelope - 完整的事件 envelope
   * @returns {Object|null} - 归一化后的 part
   */
  normalizeContentPart(part, envelope) {
    if (!part || typeof part !== 'object') return null;

    const partType = part.type;

    switch (partType) {
      case 'text':
        return this._normalizeTextPart(part);

      case 'image':
      case 'image_url':
        return this._normalizeImagePart(part);

      case 'file':
      case 'file_url':
        return this._normalizeFilePart(part);

      case 'audio':
      case 'audio_url':
        return this._normalizeAudioPart(part);

      case 'video':
      case 'video_url':
        return this._normalizeVideoPart(part);

      case 'mention':
        return this._normalizeMentionPart(part);

      case 'quote':
      case 'reply':
        return this._normalizeQuotePart(part);

      default:
        // 未知类型，尝试推断
        if (part.text) {
          return { type: 'text', text: String(part.text) };
        }
        if (part.image_url || part.url?.match(/\.(jpg|jpeg|png|gif|webp)/i)) {
          return this._normalizeImagePart(part);
        }
        if (part.file_url || part.url?.match(/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md)/i)) {
          return this._normalizeFilePart(part);
        }
        
        if (this.debugMode) {
          console.warn('[MessageNormalizer] 未知 part 类型:', partType, part);
        }
        return null;
    }
  }

  /**
   * 归一化对象类型的 content
   * @param {Object} content - content 对象
   * @param {Object} envelope - 完整的事件 envelope
   * @returns {Array} - content parts 数组
   */
  _normalizeObjectContent(content, envelope) {
    // 处理 { text: "..." } 格式
    if (content.text) {
      return [{ type: 'text', text: String(content.text) }];
    }

    // 处理 { url: "..." } 格式
    if (content.url) {
      const url = content.url;
      if (url.match(/\.(jpg|jpeg|png|gif|webp|bmp)/i)) {
        return [{ type: 'image_url', image_url: { url } }];
      }
      if (url.match(/\.(mp3|wav|ogg|m4a|flac)/i)) {
        return [{ type: 'audio_url', audio_url: { url } }];
      }
      if (url.match(/\.(mp4|webm|mov|avi)/i)) {
        return [{ type: 'video_url', video_url: { url } }];
      }
      return [{ type: 'file_url', file_url: { url } }];
    }

    // 处理 { image_url: "..." } 格式
    if (content.image_url) {
      const url = typeof content.image_url === 'string' 
        ? content.image_url 
        : content.image_url.url;
      return [{ type: 'image_url', image_url: { url } }];
    }

    return [{ type: 'text', text: '' }];
  }

  // ===== 各类型 part 归一化方法 =====

  _normalizeTextPart(part) {
    return {
      type: 'text',
      text: String(part.text || '').trim()
    };
  }

  _normalizeImagePart(part) {
    const url = part.image_url?.url || part.url || part.image_url;
    if (!url) return null;

    const normalized = {
      type: 'image_url',
      image_url: { url }
    };

    // 保留详细程度信息
    if (part.image_url?.detail) {
      normalized.image_url.detail = part.image_url.detail;
    }

    return normalized;
  }

  _normalizeFilePart(part) {
    const url = part.file_url?.url || part.url || part.file_url;
    if (!url) return null;

    return {
      type: 'file_url',
      file_url: {
        url,
        name: part.name || part.file_url?.name,
        mime_type: part.mime_type || part.file_url?.mime_type
      }
    };
  }

  _normalizeAudioPart(part) {
    const url = part.audio_url?.url || part.url || part.audio_url;
    if (!url) return null;

    return {
      type: 'audio_url',
      audio_url: { url }
    };
  }

  _normalizeVideoPart(part) {
    const url = part.video_url?.url || part.url || part.video_url;
    if (!url) return null;

    return {
      type: 'video_url',
      video_url: { url }
    };
  }

  _normalizeMentionPart(part) {
    return {
      type: 'mention',
      mention: {
        user_id: part.user_id || part.userId || part.id,
        display_name: part.display_name || part.displayName || part.name
      }
    };
  }

  _normalizeQuotePart(part) {
    return {
      type: 'quote',
      quote: {
        message_id: part.message_id || part.messageId || part.id,
        text: part.text || part.content,
        user_id: part.user_id || part.userId
      }
    };
  }

  /**
   * 检查 part 是否有效
   * @param {Object} part - content part
   * @returns {boolean}
   */
  _isValidPart(part) {
    if (!part || typeof part !== 'object') return false;

    switch (part.type) {
      case 'text':
        return part.text && part.text.trim().length > 0;
      case 'image_url':
        return part.image_url?.url;
      case 'file_url':
        return part.file_url?.url;
      case 'audio_url':
        return part.audio_url?.url;
      case 'video_url':
        return part.video_url?.url;
      case 'mention':
        return part.mention?.user_id;
      case 'quote':
        return part.quote?.message_id;
      default:
        return false;
    }
  }
}

module.exports = MessageNormalizer;