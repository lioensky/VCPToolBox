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
  PENDING: 'pending',         // 等待处理
  PROCESSING: 'processing',   // 处理中
  DELIVERED: 'delivered',     // 已投递
  FAILED: 'failed',           // 投递失败
  DEAD_LETTER: 'dead_letter', // 死信
  CANCELLED: 'cancelled'      // 已取消
};

/**
 * 审计事件类型
 */
const AUDIT_TYPES = {
  INGRESS: 'ingress',           // 入站事件
  ROUTE: 'route',               // 路由决策
  RUNTIME: 'runtime',           // 运行时调用
  DELIVERY: 'delivery',         // 投递
  ERROR: 'error',               // 错误
  RETRY: 'retry',               // 重试
  DEDUP_HIT: 'dedup_hit'        // 去重命中
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
  supportsImage: false,
  supportsFile: false,
  supportsAudio: false,
  supportsCard: false,
  supportsActionCallback: false,
  supportsThread: false,
  supportsMention: false,
  supportsProactivePush: false,
  maxMessageLength: 4096,
  mediaUploadMode: 'none'
};

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
  QQ: 'qq',
  WECHAT: 'wechat',
  ONEBOT: 'onebot'
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
  B1: '1.0',  // 旧版 channel-ingest
  B2: '2.0'   // 新版 channel-hub/events
};

module.exports = {
  // 版本
  CHANNEL_HUB_STATE_VERSION,
  CHANNEL_EVENT_VERSION,
  
  // 状态枚举
  OUTBOX_STATUS,
  AUDIT_TYPES,
  CHANNEL_EVENT_TYPES,
  
  // 默认配置
  DEFAULT_RETRY_POLICY,
  DEFAULT_CAPABILITY_PROFILE,
  
  // 目录名
  STATE_DIRNAME,
  AUDIT_DIRNAME,
  MEDIA_DIRNAME,
  
  // 平台标识
  PLATFORMS,
  
  // 会话类型
  CONVERSATION_TYPES,
  
  // 桥接版本
  BRIDGE_VERSIONS
};
