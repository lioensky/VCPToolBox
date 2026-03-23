/**
 * AdapterAuthManager.js
 * 
 * 职责：
 * - 负责适配器级别的鉴权，而不是继续依赖全局 Key
 * - 支持独立 adapter secret
 * - 支持来源 IP / 网段白名单
 * - 支持停用 adapter 后拒绝请求
 * - 预留 secret 轮换逻辑
 * 
 * 背景：
 * 当前 /internal/channel-ingest 实际鉴权仍使用全局 Key 或 x-channel-bridge-key。
 * 证据：server.js:931
 */

const { AdapterAuthError } = require('./errors');

class AdapterAuthManager {
  /**
   * @param {Object} options
   * @param {Object} options.adapterRegistry - AdapterRegistry 实例
   * @param {Object} options.stateStore - StateStore 实例
   * @param {Object} options.config - 配置对象
   * @param {boolean} options.debugMode - 调试模式
   */
  constructor(options = {}) {
    this.adapterRegistry = options.adapterRegistry;
    this.stateStore = options.stateStore;
    this.config = options.config || {};
    this.debugMode = options.debugMode || false;
    
    // 全局备用密钥（向后兼容 B1）
    this.globalKey = this.config.VCP_CHANNEL_BRIDGE_KEY || this.config.Key || null;
  }

  /**
   * 初始化
   */
  async initialize() {
    if (this.debugMode) {
      console.log('[AdapterAuthManager] Initialized');
    }
  }

  /**
   * 认证请求
   * @param {Object} headers - 请求头
   * @param {string} [sourceIp] - 来源 IP
   * @returns {Promise<{authenticated: boolean, adapterId?: string, error?: string}>}
   */
  async authenticate(headers, sourceIp = null) {
    // TODO: 实现认证逻辑
    // 1. 从 headers 中提取 adapterId 和签名
    // 2. 查询 adapter 配置
    // 3. 验证密钥
    // 4. 验证 IP 白名单
    // 5. 检查 adapter 是否启用
    
    const adapterId = headers['x-channel-adapter-id'];
    const signature = headers['x-channel-signature'];
    const timestamp = headers['x-channel-request-timestamp'];
    const bridgeKey = headers['x-channel-bridge-key'];
    const authorization = headers['authorization'];
    
    // B1 兼容模式：使用全局 Key
    if (!adapterId && this.globalKey) {
      const isGlobalAuth = this._validateGlobalKey(bridgeKey, authorization);
      if (isGlobalAuth) {
        return { authenticated: true, adapterId: 'legacy-b1' };
      }
    }
    
    // B2 模式：adapter 专属认证
    if (adapterId) {
      const adapter = await this.adapterRegistry.getAdapter(adapterId);
      
      if (!adapter) {
        return { authenticated: false, error: 'Adapter not found' };
      }
      
      if (!adapter.enabled) {
        return { authenticated: false, error: 'Adapter is disabled' };
      }
      
      // 验证密钥
      const keyValid = await this._validateAdapterKey(adapter, bridgeKey, authorization);
      if (!keyValid) {
        return { authenticated: false, error: 'Invalid adapter key' };
      }
      
      // 验证 IP 白名单
      if (sourceIp && adapter.ipWhitelist && adapter.ipWhitelist.length > 0) {
        const ipValid = this._validateIpWhitelist(sourceIp, adapter.ipWhitelist);
        if (!ipValid) {
          return { authenticated: false, error: 'IP not in whitelist' };
        }
      }
      
      return { authenticated: true, adapterId };
    }
    
    return { authenticated: false, error: 'Missing authentication' };
  }

  /**
   * 根据 headers 获取 adapter
   * @param {Object} headers - 请求头
   * @returns {Promise<Object|null>}
   */
  async getAdapterByHeaders(headers) {
    const adapterId = headers['x-channel-adapter-id'];
    if (!adapterId) return null;
    
    return await this.adapterRegistry.getAdapter(adapterId);
  }

  /**
   * 轮换 adapter 密钥
   * @param {string} adapterId - 适配器 ID
   * @param {string} nextSecret - 新密钥
   * @returns {Promise<boolean>}
   */
  async rotateAdapterSecret(adapterId, nextSecret) {
    // TODO: 实现密钥轮换逻辑
    // 1. 验证 adapter 存在
    // 2. 更新密钥
    // 3. 记录审计日志
    if (this.debugMode) {
      console.log(`[AdapterAuthManager] Rotating secret for adapter: ${adapterId}`);
    }
    
    const adapter = await this.adapterRegistry.getAdapter(adapterId);
    if (!adapter) {
      throw new AdapterAuthError(`Adapter not found: ${adapterId}`);
    }
    
    // 更新密钥
    await this.adapterRegistry.upsertAdapter({
      ...adapter,
      secret: nextSecret,
      secretRotatedAt: Date.now()
    });
    
    return true;
  }

  /**
   * 验证来源 IP
   * @param {string} adapterId - 适配器 ID
   * @param {string} sourceIp - 来源 IP
   * @returns {Promise<boolean>}
   */
  async validateSourceIp(adapterId, sourceIp) {
    const adapter = await this.adapterRegistry.getAdapter(adapterId);
    if (!adapter) return false;
    
    if (!adapter.ipWhitelist || adapter.ipWhitelist.length === 0) {
      return true; // 未配置白名单则允许所有
    }
    
    return this._validateIpWhitelist(sourceIp, adapter.ipWhitelist);
  }

  /**
   * 验证全局密钥（B1 兼容）
   * @private
   */
  _validateGlobalKey(bridgeKey, authorization) {
    if (bridgeKey && bridgeKey === this.globalKey) {
      return true;
    }
    
    if (authorization) {
      const token = authorization.replace(/^Bearer\s+/i, '');
      if (token === this.globalKey) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * 验证 adapter 密钥
   * @private
   */
  async _validateAdapterKey(adapter, bridgeKey, authorization) {
    const adapterSecret = adapter.secret;
    
    if (bridgeKey && bridgeKey === adapterSecret) {
      return true;
    }
    
    if (authorization) {
      const token = authorization.replace(/^Bearer\s+/i, '');
      if (token === adapterSecret) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * 验证 IP 白名单
   * @private
   */
  _validateIpWhitelist(sourceIp, whitelist) {
    // 支持 CIDR 和精确匹配
    for (const pattern of whitelist) {
      if (pattern === sourceIp) {
        return true;
      }
      
      // 简单的 CIDR 匹配（如 192.168.1.0/24）
      if (pattern.includes('/')) {
        const [network, bits] = pattern.split('/');
        if (this._ipInCidr(sourceIp, network, parseInt(bits))) {
          return true;
        }
      }
      
      // 通配符匹配（如 192.168.1.*）
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
        if (regex.test(sourceIp)) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * 检查 IP 是否在 CIDR 范围内
   * @private
   */
  _ipInCidr(ip, network, bits) {
    // 简化实现，完整实现需要处理 IPv6
    const ipNum = this._ipToNumber(ip);
    const networkNum = this._ipToNumber(network);
    
    if (ipNum === null || networkNum === null) return false;
    
    const mask = (0xFFFFFFFF << (32 - bits)) >>> 0;
    return (ipNum & mask) === (networkNum & mask);
  }

  /**
   * IP 地址转数字
   * @private
   */
  _ipToNumber(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    
    return parts.reduce((acc, part) => {
      const num = parseInt(part, 10);
      if (isNaN(num) || num < 0 || num > 255) return null;
      return (acc << 8) + num;
    }, 0);
  }
}

module.exports = AdapterAuthManager;