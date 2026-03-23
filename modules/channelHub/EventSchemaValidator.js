// modules/channelHub/EventSchemaValidator.js
/**
 * 事件协议校验器
 * 
 * 职责：
 * - 校验 B2 ChannelEventEnvelope 格式
 * - 补齐默认字段
 * - 归一化时间戳、布尔值和空数组
 * - 统一错误输出
 * 
 * 依赖：
 * - schemas/channel-event-envelope.schema.json
 * - errors.js
 */

const { EventValidationError } = require('./errors');
const { CHANNEL_EVENT_VERSION } = require('./constants');

// B2 事件必需字段
const REQUIRED_FIELDS = [
  'version',
  'eventId',
  'adapterId',
  'channel',
  'eventType',
  'occurredAt'
];

const REQUIRED_NESTED_FIELDS = {
  'target': ['agentId'],
  'client': ['messageId'],
  'payload': ['messages']
};

// 默认值映射
const DEFAULT_VALUES = {
  version: CHANNEL_EVENT_VERSION,
  eventType: 'message.created',
  'client.conversationType': 'single',
  'session.allowCreateTopic': true,
  'session.allowSwitchTopic': true,
  'runtime.stream': false
};

class EventSchemaValidator {
  constructor(options = {}) {
    this.options = options;
    this.strictMode = options.strictMode || false;
    // TODO: 加载 JSON Schema 进行更严格的校验
    this.schema = null;
  }

  /**
   * 校验事件 Envelope
   * @param {Object} input - 原始输入
   * @returns {{valid: boolean, envelope: Object, errors: Array<string>}}
   */
  validateEnvelope(input) {
    const errors = [];
    
    if (!input || typeof input !== 'object') {
      errors.push('输入必须是非空对象');
      return { valid: false, envelope: null, errors };
    }

    // 检查必需字段
    for (const field of REQUIRED_FIELDS) {
      if (input[field] === undefined || input[field] === null) {
        errors.push(`缺少必需字段: ${field}`);
      }
    }

    // 检查嵌套必需字段
    for (const [parent, children] of Object.entries(REQUIRED_NESTED_FIELDS)) {
      if (!input[parent] || typeof input[parent] !== 'object') {
        errors.push(`缺少必需的 ${parent} 对象`);
        continue;
      }
      for (const child of children) {
        if (input[parent][child] === undefined) {
          errors.push(`缺少必需字段: ${parent}.${child}`);
        }
      }
    }

    // 校验 payload.messages
    if (input.payload?.messages) {
      const msgErrors = this._validateMessages(input.payload.messages);
      errors.push(...msgErrors);
    }

    // 校验时间戳
    if (input.occurredAt && typeof input.occurredAt !== 'number') {
      errors.push('occurredAt 必须是数字时间戳');
    }

    return {
      valid: errors.length === 0,
      envelope: errors.length === 0 ? input : null,
      errors
    };
  }

  /**
   * 归一化事件 Envelope（补齐默认值）
   * @param {Object} input - 原始输入
   * @returns {Object} 归一化后的 Envelope
   */
  normalizeEnvelope(input) {
    const envelope = JSON.parse(JSON.stringify(input));
    
    // 补齐默认值
    for (const [path, value] of Object.entries(DEFAULT_VALUES)) {
      const parts = path.split('.');
      let obj = envelope;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) {
          obj[parts[i]] = {};
        }
        obj = obj[parts[i]];
      }
      const lastKey = parts[parts.length - 1];
      if (obj[lastKey] === undefined) {
        obj[lastKey] = value;
      }
    }

    // 归一化时间戳
    if (envelope.occurredAt && typeof envelope.occurredAt === 'string') {
      envelope.occurredAt = new Date(envelope.occurredAt).getTime();
    }

    // 确保 metadata 存在
    if (!envelope.metadata) {
      envelope.metadata = {};
    }

    // 确保消息数组格式正确
    if (envelope.payload?.messages) {
      envelope.payload.messages = envelope.payload.messages.map(msg => 
        this._normalizeMessage(msg)
      );
    }

    return envelope;
  }

  /**
   * 校验消息数组
   * @param {Array} messages 
   * @returns {Array<string>} 错误列表
   */
  _validateMessages(messages) {
    const errors = [];
    
    if (!Array.isArray(messages)) {
      errors.push('payload.messages 必须是数组');
      return errors;
    }

    if (messages.length === 0) {
      errors.push('payload.messages 不能为空数组');
      return errors;
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.role) {
        errors.push(`messages[${i}] 缺少 role 字段`);
      }
      if (!msg.content && !msg.tool_calls) {
        errors.push(`messages[${i}] 缺少 content 或 tool_calls`);
      }
    }

    return errors;
  }

  /**
   * 归一化单条消息
   * @param {Object} msg 
   * @returns {Object}
   */
  _normalizeMessage(msg) {
    const normalized = { ...msg };
    
    // 确保 content 是数组格式
    if (typeof normalized.content === 'string') {
      normalized.content = [
        { type: 'text', text: normalized.content }
      ];
    } else if (Array.isArray(normalized.content)) {
      normalized.content = normalized.content.map(part => {
        if (typeof part === 'string') {
          return { type: 'text', text: part };
        }
        return part;
      });
    }

    return normalized;
  }

  /**
   * 校验并归一化（组合方法）
   * @param {Object} input 
   * @returns {{valid: boolean, envelope: Object|null, errors: Array<string>}}
   */
  validateAndNormalize(input) {
    const { valid, errors } = this.validateEnvelope(input);
    
    if (!valid) {
      return { valid, envelope: null, errors };
    }

    const envelope = this.normalizeEnvelope(input);
    return { valid: true, envelope, errors: [] };
  }
}

module.exports = EventSchemaValidator;