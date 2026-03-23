// modules/channelHub/SignatureValidator.js
/**
 * 平台签名校验器
 * 
 * 职责：
 * - 验证来自钉钉、企业微信、飞书、QQ等平台的回调签名
 * - 支持时间戳过期校验
 * - 支持 nonce 重放保护
 * 
 * @module SignatureValidator
 */

const crypto = require('crypto');
const { SignatureValidationError } = require('./errors');
const { nowTimestamp } = require('./utils');

/**
 * 平台签名校验器类
 */
class SignatureValidator {
  /**
   * @param {Object} options
   * @param {Object} options.stateStore - 状态存储实例
   * @param {Object} options.adapterRegistry - 适配器注册中心
   * @param {Object} [options.config] - 配置项
   * @param {number} [options.config.timestampTolerance=300000] - 时间戳容忍误差（毫秒）
   * @param {number} [options.config.nonceTTL=300000] - nonce 有效期（毫秒）
   */
  constructor(options = {}) {
    this.stateStore = options.stateStore;
    this.adapterRegistry = options.adapterRegistry;
    this.config = {
      timestampTolerance: 300000, // 5分钟
      nonceTTL: 300000,
      ...options.config
    };
    
    // 内存中的 nonce 缓存（生产环境应使用 Redis）
    this.nonceCache = new Map();
  }

  /**
   * 统一签名校验入口
   * @param {Object} adapter - 适配器配置
   * @param {Object} headers - 请求头
   * @param {string|Buffer} rawBody - 原始请求体
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  async validate(adapter, headers, rawBody) {
    if (!adapter) {
      return { valid: false, reason: 'Adapter not found' };
    }

    const channel = adapter.channel;
    
    // 根据平台类型分发到具体校验器
    switch (channel) {
      case 'dingtalk':
        return this.validateDingTalk(headers, rawBody, adapter);
      case 'wecom':
        return this.validateWeCom(headers, rawBody, adapter);
      case 'feishu':
      case 'lark':
        return this.validateFeishu(headers, rawBody, adapter);
      case 'qq':
      case 'onebot':
        return this.validateOneBot(headers, rawBody, adapter);
      case 'wechat':
        return this.validateWeChat(headers, rawBody, adapter);
      default:
        // 未知平台，跳过签名校验（依赖 adapter 自行配置）
        if (adapter.skipSignatureValidation) {
          return { valid: true };
        }
        return { valid: false, reason: `Unsupported channel: ${channel}` };
    }
  }

  /**
   * 钉钉签名校验
   * 文档: https://open.dingtalk.com/document/develop/receive-message
   * @param {Object} headers - 请求头
   * @param {string|Buffer} rawBody - 原始请求体
   * @param {Object} adapter - 适配器配置
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  async validateDingTalk(headers, rawBody, adapter) {
    const timestamp = headers['timestamp'];
    const sign = headers['sign'];
    const appSecret = adapter.appSecret || adapter.secret;

    if (!timestamp || !sign) {
      return { valid: false, reason: 'Missing timestamp or sign header' };
    }

    // 时间戳校验
    const timestampNum = parseInt(timestamp, 10);
    const now = nowTimestamp();
    if (Math.abs(now - timestampNum) > this.config.timestampTolerance) {
      return { valid: false, reason: 'Timestamp expired' };
    }

    if (!appSecret) {
      // 无 secret 配置，跳过签名校验
      return { valid: true };
    }

    // 签名计算: 把timestamp+"\n"+appSecret当做签名字符串
    const stringToSign = timestamp + '\n' + appSecret;
    const computedSign = crypto
      .createHmac('sha256', appSecret)
      .update(stringToSign)
      .digest('base64');

    if (computedSign !== sign) {
      return { valid: false, reason: 'Signature mismatch' };
    }

    return { valid: true };
  }

  /**
   * 企业微信签名校验
   * 文档: https://developer.work.weixin.qq.com/document/path/90307
   * @param {Object} headers - 请求头
   * @param {string|Buffer} rawBody - 原始请求体
   * @param {Object} adapter - 适配器配置
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  async validateWeCom(headers, rawBody, adapter) {
    const msgSignature = headers['msg_signature'] || headers['x-wework-msg_signature'];
    const timestamp = headers['timestamp'] || headers['x-wework-timestamp'];
    const nonce = headers['nonce'] || headers['x-wework-nonce'];
    const token = adapter.token || adapter.encodingAESKey;

    if (!msgSignature || !timestamp || !nonce) {
      return { valid: false, reason: 'Missing required headers' };
    }

    // 时间戳校验
    const timestampNum = parseInt(timestamp, 10);
    const now = Math.floor(nowTimestamp() / 1000);
    if (Math.abs(now - timestampNum) > this.config.timestampTolerance / 1000) {
      return { valid: false, reason: 'Timestamp expired' };
    }

    // nonce 校验（防重放）
    const nonceKey = `wecom:${nonce}`;
    if (this.nonceCache.has(nonceKey)) {
      return { valid: false, reason: 'Nonce replay detected' };
    }

    if (!token) {
      return { valid: true }; // 无 token 配置，跳过
    }

    // 签名计算: sha1(sort(token, timestamp, nonce, encrypt))
    const encrypt = typeof rawBody === 'string' ? rawBody : rawBody.toString();
    const arr = [token, timestamp, nonce, encrypt].sort();
    const computedSign = crypto.createHash('sha1').update(arr.join('')).digest('hex');

    if (computedSign !== msgSignature) {
      return { valid: false, reason: 'Signature mismatch' };
    }

    // 记录 nonce
    this._recordNonce(nonceKey);

    return { valid: true };
  }

  /**
   * 飞书签名校验
   * 文档: https://open.feishu.cn/document/ukTMukTMukTM/uYjNwUjL2YDM14iN2ATN
   * @param {Object} headers - 请求头
   * @param {string|Buffer} rawBody - 原始请求体
   * @param {Object} adapter - 适配器配置
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  async validateFeishu(headers, rawBody, adapter) {
    const timestamp = headers['x-lark-request-timestamp'] || headers['x-feishu-request-timestamp'];
    const nonce = headers['x-lark-request-nonce'] || headers['x-feishu-request-nonce'];
    const signature = headers['x-lark-signature'] || headers['x-feishu-signature'];
    const appSecret = adapter.appSecret || adapter.secret;

    if (!timestamp || !signature) {
      return { valid: false, reason: 'Missing timestamp or signature' };
    }

    // 时间戳校验（飞书要求小于 60 秒）
    const timestampNum = parseInt(timestamp, 10);
    const now = Math.floor(nowTimestamp() / 1000);
    if (Math.abs(now - timestampNum) > 60) {
      return { valid: false, reason: 'Timestamp expired (>60s)' };
    }

    // nonce 校验
    if (nonce) {
      const nonceKey = `feishu:${nonce}`;
      if (this.nonceCache.has(nonceKey)) {
        return { valid: false, reason: 'Nonce replay detected' };
      }
      this._recordNonce(nonceKey);
    }

    if (!appSecret) {
      return { valid: true };
    }

    // 签名计算: sha256(timestamp + nonce + appSecret + body)
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString();
    const stringToSign = timestamp + (nonce || '') + appSecret + body;
    const computedSign = crypto.createHash('sha256').update(stringToSign).digest('hex');

    if (computedSign !== signature) {
      return { valid: false, reason: 'Signature mismatch' };
    }

    return { valid: true };
  }

  /**
   * OneBot (QQ) 签名校验
   * 文档: https://github.com/botuniverse/onebot-11
   * @param {Object} headers - 请求头
   * @param {string|Buffer} rawBody - 原始请求体
   * @param {Object} adapter - 适配器配置
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  async validateOneBot(headers, rawBody, adapter) {
    const accessToken = headers['authorization'] || headers['access-token'];
    const expectedToken = adapter.accessToken || adapter.token;

    if (!expectedToken) {
      return { valid: true }; // 无 token 配置，跳过
    }

    // Bearer token 格式
    const token = accessToken?.startsWith('Bearer ') 
      ? accessToken.slice(7) 
      : accessToken;

    if (token !== expectedToken) {
      return { valid: false, reason: 'Access token mismatch' };
    }

    // OneBot 通常使用 HMAC 签名（可选）
    const xSignature = headers['x-signature'];
    if (xSignature && adapter.secret) {
      const body = typeof rawBody === 'string' ? rawBody : rawBody.toString();
      const computedSign = crypto
        .createHmac('sha1', adapter.secret)
        .update(body)
        .digest('hex');
      
      const expectedSign = xSignature.startsWith('sha1=') 
        ? xSignature.slice(5) 
        : xSignature;

      if (computedSign !== expectedSign) {
        return { valid: false, reason: 'HMAC signature mismatch' };
      }
    }

    return { valid: true };
  }

  /**
   * 微信公众号签名校验
   * 文档: https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Get_access_token.html
   * @param {Object} headers - 请求头
   * @param {string|Buffer} rawBody - 原始请求体
   * @param {Object} adapter - 适配器配置
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  async validateWeChat(headers, rawBody, adapter) {
    const signature = headers['signature'] || headers['x-wechat-signature'];
    const timestamp = headers['timestamp'] || headers['x-wechat-timestamp'];
    const nonce = headers['nonce'] || headers['x-wechat-nonce'];
    const token = adapter.token;

    if (!signature || !timestamp || !nonce) {
      return { valid: false, reason: 'Missing required headers' };
    }

    // 时间戳校验
    const timestampNum = parseInt(timestamp, 10);
    const now = Math.floor(nowTimestamp() / 1000);
    if (Math.abs(now - timestampNum) > this.config.timestampTolerance / 1000) {
      return { valid: false, reason: 'Timestamp expired' };
    }

    // nonce 校验
    const nonceKey = `wechat:${nonce}`;
    if (this.nonceCache.has(nonceKey)) {
      return { valid: false, reason: 'Nonce replay detected' };
    }

    if (!token) {
      return { valid: true };
    }

    // 签名计算: sha1(sort(token, timestamp, nonce))
    const arr = [token, timestamp, nonce].sort();
    const computedSign = crypto.createHash('sha1').update(arr.join('')).digest('hex');

    if (computedSign !== signature) {
      return { valid: false, reason: 'Signature mismatch' };
    }

    this._recordNonce(nonceKey);

    return { valid: true };
  }

  /**
   * 记录 nonce（防重放）
   * @param {string} key - nonce 键
   * @private
   */
  _recordNonce(key) {
    this.nonceCache.set(key, nowTimestamp());
    
    // 清理过期 nonce
    this._cleanupNonceCache();
  }

  /**
   * 清理过期的 nonce 缓存
   * @private
   */
  _cleanupNonceCache() {
    const now = nowTimestamp();
    const ttl = this.config.nonceTTL;
    
    for (const [key, timestamp] of this.nonceCache.entries()) {
      if (now - timestamp > ttl) {
        this.nonceCache.delete(key);
      }
    }
  }

  /**
   * 验证时间戳是否在容忍范围内
   * @param {number} timestamp - 待验证的时间戳（毫秒）
   * @param {number} [tolerance] - 容忍误差（毫秒）
   * @returns {boolean}
   */
  validateTimestamp(timestamp, tolerance = this.config.timestampTolerance) {
    const now = nowTimestamp();
    return Math.abs(now - timestamp) <= tolerance;
  }

  /**
   * 验证 nonce 是否未被使用过
   * @param {string} nonce - nonce 值
   * @param {string} [prefix] - 前缀（区分不同平台）
   * @returns {boolean}
   */
  isNonceUnique(nonce, prefix = '') {
    const key = prefix ? `${prefix}:${nonce}` : nonce;
    return !this.nonceCache.has(key);
  }
}

module.exports = SignatureValidator;