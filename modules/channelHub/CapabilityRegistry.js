// modules/channelHub/CapabilityRegistry.js
/**
 * 平台能力注册中心
 * 
 * 职责：
 * - 统一管理平台能力矩阵
 * - 支持查询某适配器支持哪些能力
 * - 提供能力查询接口
 * 
 * 能力类型：
 * - 文本能力 (supportsText)
 * - 图片能力 (supportsImage)
 * - 文件能力 (supportsFile)
 * - 音频能力 (supportsAudio)
 * - 卡片能力 (supportsCard)
 * - 按钮回调能力 (supportsActionCallback)
 * - 话题能力 (supportsThread)
 * - @提及能力 (supportsMention)
 * - 主动推送能力 (supportsProactivePush)
 * 
 * 依赖：
 * - AdapterRegistry.js
 * - constants.js
 */

const { DEFAULT_CAPABILITY_PROFILE } = require('./constants');

class CapabilityRegistry {
  /**
   * @param {Object} options
   * @param {Object} options.adapterRegistry - 适配器注册中心实例
   * @param {Object} options.logger - 日志记录器
   */
  constructor(options = {}) {
    this.adapterRegistry = options.adapterRegistry;
    this.logger = options.logger || console;
    
    // 内置平台能力配置
    this.builtinProfiles = {
      // 钉钉能力配置
      dingtalk: {
        supportsText: true,
        supportsImage: true,
        supportsFile: true,
        supportsAudio: true,
        supportsCard: true,
        supportsActionCallback: true,
        supportsThread: false,
        supportsMention: true,
        supportsProactivePush: true,
        maxMessageLength: 20000,
        maxImageSize: 20 * 1024 * 1024, // 20MB
        maxFileSize: 20 * 1024 * 1024, // 20MB
        mediaUploadMode: 'platform' // platform: 上传到平台服务器
      },
      // 企业微信能力配置
      wecom: {
        supportsText: true,
        supportsImage: true,
        supportsFile: true,
        supportsAudio: false,
        supportsCard: true,
        supportsActionCallback: true,
        supportsThread: false,
        supportsMention: true,
        supportsProactivePush: true,
        maxMessageLength: 4096,
        maxImageSize: 10 * 1024 * 1024, // 10MB
        maxFileSize: 20 * 1024 * 1024, // 20MB
        mediaUploadMode: 'platform'
      },
      // 飞书能力配置
      lark: {
        supportsText: true,
        supportsImage: true,
        supportsFile: true,
        supportsAudio: false,
        supportsCard: true,
        supportsActionCallback: true,
        supportsThread: true,
        supportsMention: true,
        supportsProactivePush: true,
        maxMessageLength: 30000,
        maxImageSize: 20 * 1024 * 1024, // 20MB
        maxFileSize: 30 * 1024 * 1024, // 30MB
        mediaUploadMode: 'platform'
      },
      // QQ/OneBot 能力配置
      onebot: {
        supportsText: true,
        supportsImage: true,
        supportsFile: false,
        supportsAudio: true,
        supportsCard: false,
        supportsActionCallback: false,
        supportsThread: false,
        supportsMention: true,
        supportsProactivePush: true,
        maxMessageLength: 5000,
        maxImageSize: 5 * 1024 * 1024, // 5MB
        maxFileSize: 10 * 1024 * 1024, // 10MB
        mediaUploadMode: 'base64' // base64: 转为 base64 发送
      },
      // 微信公众号能力配置
      wechat: {
        supportsText: true,
        supportsImage: true,
        supportsFile: false,
        supportsAudio: false,
        supportsCard: false,
        supportsActionCallback: true,
        supportsThread: false,
        supportsMention: false,
        supportsProactivePush: true,
        maxMessageLength: 600,
        maxImageSize: 2 * 1024 * 1024, // 2MB
        maxFileSize: 0,
        mediaUploadMode: 'platform'
      },
      // 默认能力配置
      default: DEFAULT_CAPABILITY_PROFILE
    };
  }

  /**
   * 获取适配器的能力配置
   * @param {string} adapterId - 适配器ID
   * @returns {Promise<Object>} 能力配置对象
   */
  async getProfile(adapterId) {
    // 尝试从适配器配置获取能力配置
    if (this.adapterRegistry) {
      const adapter = await this.adapterRegistry.getAdapter(adapterId);
      if (adapter && adapter.capabilityProfile) {
        // 合并适配器自定义能力和默认能力
        return this.mergeProfile(adapter.capabilityProfile, this.getDefaultProfile(adapter.channel));
      }
    }
    
    // 返回默认能力配置
    return this.getDefaultProfile();
  }

  /**
   * 获取平台的默认能力配置
   * @param {string} channel - 平台标识
   * @returns {Object} 能力配置对象
   */
  getDefaultProfile(channel) {
    if (channel && this.builtinProfiles[channel]) {
      return { ...this.builtinProfiles[channel] };
    }
    return { ...this.builtinProfiles.default };
  }

  /**
   * 合并能力配置
   * @param {Object} adapterProfile - 适配器自定义能力配置
   * @param {Object} defaults - 默认能力配置
   * @returns {Object} 合并后的能力配置
   */
  mergeProfile(adapterProfile, defaults) {
    return {
      ...defaults,
      ...adapterProfile
    };
  }

  /**
   * 检查适配器是否支持某能力
   * @param {string} adapterId - 适配器ID
   * @param {string} capabilityName - 能力名称
   * @returns {Promise<boolean>} 是否支持
   */
  async supports(adapterId, capabilityName) {
    const profile = await this.getProfile(adapterId);
    return !!profile[capabilityName];
  }

  /**
   * 获取所有内置平台的能力配置
   * @returns {Object} 平台能力配置映射
   */
  getAllBuiltinProfiles() {
    return { ...this.builtinProfiles };
  }

  /**
   * 获取适配器的消息长度限制
   * @param {string} adapterId - 适配器ID
   * @returns {Promise<number>} 最大消息长度
   */
  async getMaxMessageLength(adapterId) {
    const profile = await this.getProfile(adapterId);
    return profile.maxMessageLength || 4096;
  }

  /**
   * 获取适配器的媒体大小限制
   * @param {string} adapterId - 适配器ID
   * @param {string} mediaType - 媒体类型 (image, file, audio)
   * @returns {Promise<number>} 最大媒体大小（字节）
   */
  async getMaxMediaSize(adapterId, mediaType) {
    const profile = await this.getProfile(adapterId);
    const sizeKey = `max${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)}Size`;
    return profile[sizeKey] || 10 * 1024 * 1024; // 默认 10MB
  }

  /**
   * 获取适配器的媒体上传模式
   * @param {string} adapterId - 适配器ID
   * @returns {Promise<string>} 媒体上传模式
   */
  async getMediaUploadMode(adapterId) {
    const profile = await this.getProfile(adapterId);
    return profile.mediaUploadMode || 'platform';
  }
}

module.exports = CapabilityRegistry;