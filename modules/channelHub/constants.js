/**
 * modules/channelHub/constants.js
 * 
 * 集中维护 ChannelHub 相关常量
 * 避免状态名、目录名、事件名散落在各模块里
 * 
 * @description 目标：其他模块不再硬编码事件名和状态名
 */

const CHANNEL_HUB_STATE_VERSION = '1.0.0';
const CHANNEL_EVENT_VERSION = '2.0';

/**
 * 出站任务状态枚举
 */
const OUTBOX_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  DEAD_LETTER: 'dead_letter',
  CANCELLED: 'cancelled'
};

/**
 * 投递状态（DeliveryOutbox 使用，与 OUTBOX_STATUS 保持一致）
 */
const DELIVERY_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  DEAD_LETTER: 'dead_letter',
  CANCELLED: 'cancelled'
};

/**
 * 适配器状态枚举
 */
const ADAPTER_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  ERROR: 'error',
  INITIALIZING: 'initializing'
};

/**
 * 任务优先级枚举
 */
const PRIORITY = {
  HIGH: 1,
  NORMAL: 5,
  LOW: 10
};

/**
 * 审计事件类型
 */
const AUDIT_TYPES = {
  INGRESS: 'ingress',
  ROUTE: 'route',
  RUNTIME: 'runtime',
  DELIVERY: 'delivery',
  ERROR: 'error',
  RETRY: 'retry',
  DEDUP_HIT: 'dedup_hit'
};

/**
 * 通道事件类型
 */
const CHANNEL_EVENT_TYPES = {
  MESSAGE_CREATED: 'message.created',
  MESSAGE_UPDATED: 'message.updated',
  MESSAGE_DELETED: 'message.deleted',
  ACTION_TRIGGERED: 'action.triggered',
  FILE_UPLOADED: 'file.uploaded',
  USER_JOINED: 'user.joined',
  USER_LEFT: 'user.left'
};

/**
 * 默认重试策略
 */
const DEFAULT_RETRY_POLICY = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableErrors: ['NETWORK_ERROR', 'TIMEOUT', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE']
};

/**
 * 默认能力矩阵模板
 */
const DEFAULT_CAPABILITY_PROFILE = {
  supportsText: true,
  supportsMarkdown: false,
  supportsImage: false,
  supportsFile: false,
  supportsAudio: false,
  supportsVideo: false,
  supportsCard: false,
  supportsActionCallback: false,
  supportsThread: false,
  supportsMention: false,
  supportsProactivePush: false,
  maxMessageLength: 4096,
  maxImageSize: 10 * 1024 * 1024,
  maxFileSize: 10 * 1024 * 1024,
  mediaUploadMode: 'none'
};

/**
 * 去重缓存 TTL（毫秒）
 */
const DEDUP_TTL_MS = 300000; // 5分钟

/**
 * 状态目录名称
 */
const STATE_DIRNAME = 'state/channelHub';
const AUDIT_DIRNAME = 'audit';
const MEDIA_DIRNAME = 'media';

/**
 * 平台标识
 */
const PLATFORMS = {
  DINGTALK: 'dingtalk',
  WECOM: 'wecom',
  FEISHU: 'feishu',
  LARK: 'lark',
  QQ: 'qq',
  WECHAT: 'wechat',
  ONEBOT: 'onebot'
};

/**
 * 平台标识别名（兼容 CapabilityDowngrader 等模块使用 CHANNELS）
 */
const CHANNELS = PLATFORMS;

/**
 * 能力标志位名称（兼容别名）
 */
const CAPABILITY_FLAGS = {
  TEXT: 'supportsText',
  MARKDOWN: 'supportsMarkdown',
  IMAGE: 'supportsImage',
  FILE: 'supportsFile',
  AUDIO: 'supportsAudio',
  VIDEO: 'supportsVideo',
  CARD: 'supportsCard',
  ACTION_CALLBACK: 'supportsActionCallback',
  THREAD: 'supportsThread',
  MENTION: 'supportsMention',
  PROACTIVE_PUSH: 'supportsProactivePush'
};

/**
 * 会话类型
 */
const CONVERSATION_TYPES = {
  PRIVATE: 'private',
  GROUP: 'group',
  CHANNEL: 'channel'
};

/**
 * 桥接协议版本
 */
const BRIDGE_VERSIONS = {
  B1: '1.0',
  B2: '2.0'
};

module.exports = {
  // 版本
  CHANNEL_HUB_STATE_VERSION,
  CHANNEL_EVENT_VERSION,
  
  // 状态枚举
  OUTBOX_STATUS,
  DELIVERY_STATUS,
  ADAPTER_STATUS,
  PRIORITY,
  AUDIT_TYPES,
  CHANNEL_EVENT_TYPES,
  
  // 默认配置
  DEFAULT_RETRY_POLICY,
  DEFAULT_CAPABILITY_PROFILE,
  
  // 去重
  DEDUP_TTL_MS,
  
  // 目录名
  STATE_DIRNAME,
  AUDIT_DIRNAME,
  MEDIA_DIRNAME,
  
  // 平台标识
  PLATFORMS,
  CHANNELS,
  
  // 能力标志
  CAPABILITY_FLAGS,
  
  // 会话类型
  CONVERSATION_TYPES,
  
  // 桥接版本
  BRIDGE_VERSIONS
};