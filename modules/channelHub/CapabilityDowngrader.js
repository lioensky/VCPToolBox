/**
 * CapabilityDowngrader - 平台能力降级处理器
 * 
 * 职责：
 * - 当目标平台不支持某种消息类型时，自动降级到兼容格式
 * - 支持多级降级策略（如：卡片 -> 图片 -> 文本）
 * - 保持降级后消息的核心信息完整性
 * - 记录降级决策供审计使用
 * 
 * 降级规则示例：
 * - markdown -> 纯文本（移除格式标记）
 * - 图片 -> 链接文本（平台不支持图片时）
 * - 卡片 -> 文本摘要（平台不支持卡片时）
 * - 文件 -> 下载链接
 */

const { CHANNELS, CAPABILITY_FLAGS } = require('./constants');
const ChannelHubError = require('./errors');

/**
 * 降级策略定义
 */
const DOWNGRADE_STRATEGIES = {
  // 图片降级路径
  image: ['image', 'text_link', 'text'],
  
  // 卡片降级路径
  card: ['card', 'image_card', 'text_summary', 'text'],
  
  // Markdown降级路径
  markdown: ['markdown', 'plain_text'],
  
  // 文件降级路径
  file: ['file', 'download_link', 'text_link'],
  
  // 语音降级路径
  audio: ['audio', 'text_transcript', 'text'],
  
  // 视频降级路径
  video: ['video', 'image_thumbnail', 'text_link']
};

/**
 * 降级原因枚举
 */
const DowgradeReason = {
  CAPABILITY_NOT_SUPPORTED: 'capability_not_supported',
  SIZE_LIMIT_EXCEEDED: 'size_limit_exceeded',
  FORMAT_NOT_SUPPORTED: 'format_not_supported',
  ADAPTER_RESTRICTION: 'adapter_restriction'
};

class CapabilityDowngrader {
  /**
   * @param {Object} options - 配置选项
   * @param {Object} options.capabilityRegistry - CapabilityRegistry 实例
   * @param {Object} options.logger - 日志记录器
   * @param {Object} options.customStrategies - 自定义降级策略（覆盖默认）
   */
  constructor(options = {}) {
    this.capabilityRegistry = options.capabilityRegistry || null;
    this.logger = options.logger || console;
    
    // 合并自定义策略
    this.strategies = {
      ...DOWNGRADE_STRATEGIES,
      ...(options.customStrategies || {})
    };
    
    // 降级历史记录（用于审计）
    this.downgradeHistory = [];
    
    // 最大历史记录数
    this.maxHistorySize = options.maxHistorySize || 1000;
  }

  /**
   * 对消息部分执行降级处理
   * @param {Object} part - 消息部分对象
   * @param {string} targetChannel - 目标渠道
   * @param {Object} capabilities - 目标平台能力矩阵
   * @returns {Object} 降级结果 { downgraded: boolean, part: Object, reason: string, strategy: string[] }
   */
  downgradePart(part, targetChannel, capabilities) {
    const partType = this._detectPartType(part);
    
    // 检查是否需要降级
    if (this._isSupported(partType, capabilities)) {
      return {
        downgraded: false,
        part: part,
        reason: null,
        strategy: null
      };
    }
    
    // 获取降级策略
    const strategy = this.strategies[partType] || ['text'];
    
    // 执行降级
    let currentType = partType;
    let downgradedPart = part;
    let downgradePath = [partType];
    
    for (const nextType of strategy.slice(1)) {
      // 检查下一个类型是否支持
      if (this._isSupported(nextType, capabilities)) {
        downgradedPart = this._transformPart(part, currentType, nextType, targetChannel);
        downgradePath.push(nextType);
        break;
      }
      downgradePath.push(nextType);
      currentType = nextType;
    }
    
    // 如果降级到 text 仍不支持，返回空消息标记
    if (!this._isSupported(currentType, capabilities)) {
      downgradedPart = {
        type: 'text',
        text: '[此消息类型在当前平台不可用]',
        _fallback: true
      };
      downgradePath.push('fallback_text');
    }
    
    const reason = DowgradeReason.CAPABILITY_NOT_SUPPORTED;
    
    // 记录降级历史
    this._recordDowngrade({
      originalType: partType,
      finalType: downgradePath[downgradePath.length - 1],
      path: downgradePath,
      reason: reason,
      channel: targetChannel,
      timestamp: Date.now()
    });
    
    return {
      downgraded: true,
      part: downgradedPart,
      reason: reason,
      strategy: downgradePath
    };
  }

  /**
   * 对整条回复消息执行降级处理
   * @param {Object} reply - ChannelRuntimeReply 对象
   * @param {string} targetChannel - 目标渠道
   * @returns {Object} 降级后的 reply 对象
   */
  downgradeReply(reply, targetChannel) {
    // 获取目标平台能力
    const capabilities = this.capabilityRegistry 
      ? this.capabilityRegistry.getCapabilities(targetChannel)
      : this._getDefaultCapabilities(targetChannel);
    
    if (!reply.parts || !Array.isArray(reply.parts)) {
      return reply;
    }
    
    // 处理每个消息部分
    const downgradedParts = reply.parts.map(part => {
      const result = this.downgradePart(part, targetChannel, capabilities);
      return result.part;
    });
    
    // 过滤掉空消息（可选）
    const filteredParts = downgradedParts.filter(p => p && !p._skip);
    
    return {
      ...reply,
      parts: filteredParts,
      _downgraded: true,
      _targetChannel: targetChannel
    };
  }

  /**
   * 检测消息部分的类型
   * @param {Object} part - 消息部分
   * @returns {string} 类型标识
   */
  _detectPartType(part) {
    if (!part || typeof part !== 'object') {
      return 'text';
    }
    
    // 显式类型字段
    if (part.type) {
      switch (part.type) {
        case 'text':
          return part.markdown ? 'markdown' : 'text';
        case 'image':
          return 'image';
        case 'card':
        case 'interactive':
          return 'card';
        case 'file':
          return 'file';
        case 'audio':
          return 'audio';
        case 'video':
          return 'video';
        default:
          return part.type;
      }
    }
    
    // 根据内容推断类型
    if (part.imageUrl || part.image_url || part.imageKey) {
      return 'image';
    }
    if (part.card || part.elements) {
      return 'card';
    }
    if (part.fileUrl || part.file_key) {
      return 'file';
    }
    if (part.audioUrl || part.audio_key) {
      return 'audio';
    }
    if (part.videoUrl || part.video_key) {
      return 'video';
    }
    
    return 'text';
  }

  /**
   * 检查消息类型是否被平台支持
   * @param {string} type - 消息类型
   * @param {Object} capabilities - 能力矩阵
   * @returns {boolean}
   */
  _isSupported(type, capabilities) {
    if (!capabilities) {
      return true; // 无能力信息时默认支持
    }
    
    const capabilityMap = {
      text: 'supportsText',
      markdown: 'supportsMarkdown',
      image: 'supportsImage',
      card: 'supportsCard',
      file: 'supportsFile',
      audio: 'supportsAudio',
      video: 'supportsVideo',
      text_link: 'supportsText',
      text_summary: 'supportsText',
      download_link: 'supportsText',
      image_thumbnail: 'supportsImage',
      image_card: 'supportsImage',
      plain_text: 'supportsText',
      text_transcript: 'supportsText'
    };
    
    const capKey = capabilityMap[type];
    if (!capKey) {
      return true; // 未知类型默认支持
    }
    
    return capabilities[capKey] === true;
  }

  /**
   * 执行消息类型转换
   * @param {Object} originalPart - 原始消息部分
   * @param {string} fromType - 源类型
   * @param {string} toType - 目标类型
   * @param {string} channel - 目标渠道
   * @returns {Object} 转换后的消息部分
   */
  _transformPart(originalPart, fromType, toType, channel) {
    // 图片 -> 文本链接
    if (fromType === 'image' && toType === 'text_link') {
      const imageUrl = originalPart.imageUrl || originalPart.image_url || '';
      const alt = originalPart.alt || originalPart.title || '[图片]';
      return {
        type: 'text',
        text: `${alt}\n${imageUrl}`,
        _downgradedFrom: 'image'
      };
    }
    
    // 卡片 -> 文本摘要
    if (fromType === 'card' && toType === 'text_summary') {
      const title = originalPart.title || '';
      const desc = originalPart.description || '';
      const text = title ? `【${title}】\n${desc}` : desc;
      return {
        type: 'text',
        text: text || '[卡片消息]',
        _downgradedFrom: 'card'
      };
    }
    
    // Markdown -> 纯文本
    if ((fromType === 'markdown' || fromType === 'text') && toType === 'plain_text') {
      const markdown = originalPart.text || '';
      const plainText = this._stripMarkdown(markdown);
      return {
        type: 'text',
        text: plainText,
        _downgradedFrom: fromType
      };
    }
    
    // 文件 -> 下载链接
    if (fromType === 'file' && toType === 'download_link') {
      const fileUrl = originalPart.fileUrl || originalPart.file_url || '';
      const fileName = originalPart.fileName || originalPart.name || '文件';
      return {
        type: 'text',
        text: `📎 ${fileName}\n${fileUrl}`,
        _downgradedFrom: 'file'
      };
    }
    
    // 语音 -> 文本转录
    if (fromType === 'audio' && toType === 'text_transcript') {
      const transcript = originalPart.transcript || originalPart.text || '[语音消息]';
      return {
        type: 'text',
        text: `🎵 语音转文字：\n${transcript}`,
        _downgradedFrom: 'audio'
      };
    }
    
    // 视频 -> 图片缩略图
    if (fromType === 'video' && toType === 'image_thumbnail') {
      const thumbnail = originalPart.thumbnailUrl || originalPart.thumbnail || '';
      return {
        type: 'image',
        imageUrl: thumbnail,
        alt: originalPart.title || '视频缩略图',
        _downgradedFrom: 'video'
      };
    }
    
    // 视频 -> 文本链接
    if (fromType === 'video' && toType === 'text_link') {
      const videoUrl = originalPart.videoUrl || originalPart.video_url || '';
      const title = originalPart.title || '视频';
      return {
        type: 'text',
        text: `🎬 ${title}\n${videoUrl}`,
        _downgradedFrom: 'video'
      };
    }
    
    // 默认：返回原始内容的文本表示
    return {
      type: 'text',
      text: this._partToText(originalPart),
      _downgradedFrom: fromType
    };
  }

  /**
   * 移除 Markdown 格式标记
   * @param {string} markdown - Markdown 文本
   * @returns {string} 纯文本
   */
  _stripMarkdown(markdown) {
    if (!markdown) return '';
    
    return markdown
      // 移除标题标记
      .replace(/^#{1,6}\s+/gm, '')
      // 移除粗体/斜体
      .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
      // 移除删除线
      .replace(/~~([^~]+)~~/g, '$1')
      // 移除链接，保留文本
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // 移除图片
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '[$1]')
      // 移除代码块
      .replace(/```[\s\S]*?```/g, '[代码块]')
      // 移除行内代码
      .replace(/`([^`]+)`/g, '$1')
      // 移除引用标记
      .replace(/^>\s+/gm, '')
      // 移除列表标记
      .replace(/^[\*\-\+]\s+/gm, '• ')
      .replace(/^\d+\.\s+/gm, '')
      .trim();
  }

  /**
   * 将消息部分转换为文本表示
   * @param {Object} part - 消息部分
   * @returns {string} 文本表示
   */
  _partToText(part) {
    if (!part) return '';
    if (part.text) return part.text;
    if (part.content) return String(part.content);
    if (part.title || part.description) {
      return [part.title, part.description].filter(Boolean).join('\n');
    }
    return '[消息]';
  }

  /**
   * 获取默认能力矩阵
   * @param {string} channel - 渠道标识
   * @returns {Object} 能力矩阵
   */
  _getDefaultCapabilities(channel) {
    // 各平台默认能力
    const defaults = {
      [CHANNELS.DINGTALK]: {
        supportsText: true,
        supportsMarkdown: true,
        supportsImage: true,
        supportsCard: true,
        supportsFile: true,
        supportsAudio: false,
        supportsVideo: false
      },
      [CHANNELS.WECOM]: {
        supportsText: true,
        supportsMarkdown: true,
        supportsImage: true,
        supportsCard: true,
        supportsFile: true,
        supportsAudio: false,
        supportsVideo: false
      },
      [CHANNELS.FEISHU]: {
        supportsText: true,
        supportsMarkdown: true,
        supportsImage: true,
        supportsCard: true,
        supportsFile: true,
        supportsAudio: false,
        supportsVideo: false
      },
      [CHANNELS.QQ]: {
        supportsText: true,
        supportsMarkdown: false,
        supportsImage: true,
        supportsCard: false,
        supportsFile: false,
        supportsAudio: true,
        supportsVideo: false
      },
      [CHANNELS.WECHAT]: {
        supportsText: true,
        supportsMarkdown: false,
        supportsImage: true,
        supportsCard: false,
        supportsFile: false,
        supportsAudio: true,
        supportsVideo: true
      }
    };
    
    return defaults[channel] || {
      supportsText: true,
      supportsMarkdown: false,
      supportsImage: false,
      supportsCard: false,
      supportsFile: false,
      supportsAudio: false,
      supportsVideo: false
    };
  }

  /**
   * 记录降级历史
   * @param {Object} record - 降级记录
   */
  _recordDowngrade(record) {
    this.downgradeHistory.push(record);
    
    // 限制历史记录大小
    if (this.downgradeHistory.length > this.maxHistorySize) {
      this.downgradeHistory.shift();
    }
  }

  /**
   * 获取降级历史记录
   * @param {Object} filter - 过滤条件
   * @returns {Array} 降级记录列表
   */
  getDowngradeHistory(filter = {}) {
    let history = [...this.downgradeHistory];
    
    if (filter.channel) {
      history = history.filter(r => r.channel === filter.channel);
    }
    if (filter.originalType) {
      history = history.filter(r => r.originalType === filter.originalType);
    }
    if (filter.startTime) {
      history = history.filter(r => r.timestamp >= filter.startTime);
    }
    if (filter.endTime) {
      history = history.filter(r => r.timestamp <= filter.endTime);
    }
    
    return history;
  }

  /**
   * 获取降级统计信息
   * @returns {Object} 统计数据
   */
  getDowngradeStats() {
    const stats = {
      total: this.downgradeHistory.length,
      byChannel: {},
      byType: {},
      byReason: {}
    };
    
    for (const record of this.downgradeHistory) {
      // 按渠道统计
      stats.byChannel[record.channel] = (stats.byChannel[record.channel] || 0) + 1;
      
      // 按原始类型统计
      stats.byType[record.originalType] = (stats.byType[record.originalType] || 0) + 1;
      
      // 按原因统计
      stats.byReason[record.reason] = (stats.byReason[record.reason] || 0) + 1;
    }
    
    return stats;
  }

  /**
   * 清空降级历史
   */
  clearHistory() {
    this.downgradeHistory = [];
  }

  /**
   * 注册自定义降级策略
   * @param {string} type - 消息类型
   * @param {Array} strategy - 降级路径数组
   */
  registerStrategy(type, strategy) {
    if (!Array.isArray(strategy) || strategy.length === 0) {
      throw new ChannelHubError('INVALID_STRATEGY', '降级策略必须是非空数组');
    }
    this.strategies[type] = strategy;
  }
}

// 导出类和常量
module.exports = CapabilityDowngrader;
module.exports.DowgradeReason = DowgradeReason;
module.exports.DOWNGRADE_STRATEGIES = DOWNGRADE_STRATEGIES;