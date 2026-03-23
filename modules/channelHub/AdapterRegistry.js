/**
 * AdapterRegistry.js
 * 
 * 维护所有适配器定义、能力声明、启停状态和优先级。
 * 
 * 职责：
 * - 定义 adapter 配置结构
 * - 支持启用和停用
 * - 支持查询能力矩阵
 * - 支持仓库内置 adapter 和手工注册 adapter 共存
 * 
 * 输入：
 * - adapterId
 * - adapterConfig
 * 
 * 输出：
 * - adapter metadata
 * - capability profile
 */

const { ADAPTER_STATUS, DEFAULT_CAPABILITY_PROFILE } = require('./constants');

/**
 * 适配器配置结构
 * @typedef {Object} AdapterConfig
 * @property {string} adapterId - 适配器唯一标识
 * @property {string} channel - 平台类型 (dingtalk, wework, feishu, qq, wechat)
 * @property {string} name - 适配器显示名称
 * @property {string} description - 适配器描述
 * @property {string} status - 状态 (active, inactive, error)
 * @property {Object} capabilityProfile - 能力矩阵
 * @property {Object} authConfig - 认证配置
 * @property {string} authConfig.secret - 适配器密钥
 * @property {string[]} authConfig.ipWhitelist - IP 白名单
 * @property {Object} platformConfig - 平台特定配置
 * @property {number} priority - 优先级 (数字越小优先级越高)
 * @property {Date} createdAt - 创建时间
 * @property {Date} updatedAt - 更新时间
 * @property {Object} metadata - 扩展元数据
 */

class AdapterRegistry {
  /**
   * @param {Object} options
   * @param {Object} options.stateStore - StateStore 实例
   * @param {Object} options.logger - 日志器
   * @param {boolean} options.debugMode - 调试模式
   */
  constructor(options = {}) {
    this.stateStore = options.stateStore;
    this.logger = options.logger || console;
    this.debugMode = options.debugMode || false;
    
    // 内存缓存
    this._cache = new Map();
    this._initialized = false;
  }

  /**
   * 初始化适配器注册中心
   */
  async initialize() {
    if (this._initialized) return;
    
    try {
      // 从状态存储加载适配器列表
      const adapters = await this.stateStore.getAdapters();
      
      if (adapters && Array.isArray(adapters)) {
        for (const adapter of adapters) {
          this._cache.set(adapter.adapterId, adapter);
        }
      }
      
      this._initialized = true;
      this.logger.log('[AdapterRegistry] Initialized with', this._cache.size, 'adapters');
    } catch (error) {
      this.logger.error('[AdapterRegistry] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * 列出所有适配器
   * @param {Object} filter - 过滤条件
   * @returns {AdapterConfig[]}
   */
  async listAdapters(filter = {}) {
    await this._ensureInitialized();
    
    let adapters = Array.from(this._cache.values());
    
    // 应用过滤条件
    if (filter.channel) {
      adapters = adapters.filter(a => a.channel === filter.channel);
    }
    if (filter.status) {
      adapters = adapters.filter(a => a.status === filter.status);
    }
    if (filter.enabled !== undefined) {
      adapters = adapters.filter(a => 
        filter.enabled ? a.status === ADAPTER_STATUS.ACTIVE : a.status !== ADAPTER_STATUS.ACTIVE
      );
    }
    
    // 按优先级排序
    adapters.sort((a, b) => (a.priority || 100) - (b.priority || 100));
    
    return adapters;
  }

  /**
   * 获取单个适配器
   * @param {string} adapterId
   * @returns {AdapterConfig|null}
   */
  async getAdapter(adapterId) {
    await this._ensureInitialized();
    return this._cache.get(adapterId) || null;
  }

  /**
   * 创建或更新适配器
   * @param {AdapterConfig} adapterConfig
   * @returns {AdapterConfig}
   */
  async upsertAdapter(adapterConfig) {
    await this._ensureInitialized();
    
    const now = new Date().toISOString();
    const existing = this._cache.get(adapterConfig.adapterId);
    
    const adapter = {
      ...adapterConfig,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      status: adapterConfig.status || ADAPTER_STATUS.INACTIVE,
      capabilityProfile: this._mergeCapabilityProfile(adapterConfig.capabilityProfile),
      priority: adapterConfig.priority || 100
    };
    
    // 更新内存缓存
    this._cache.set(adapter.adapterId, adapter);
    
    // 持久化到状态存储
    await this._persist();
    
    this.logger.log('[AdapterRegistry] Upserted adapter:', adapter.adapterId);
    return adapter;
  }

  /**
   * 启用适配器
   * @param {string} adapterId
   */
  async enableAdapter(adapterId) {
    await this._ensureInitialized();
    
    const adapter = this._cache.get(adapterId);
    if (!adapter) {
      throw new Error(`Adapter not found: ${adapterId}`);
    }
    
    adapter.status = ADAPTER_STATUS.ACTIVE;
    adapter.updatedAt = new Date().toISOString();
    
    await this._persist();
    this.logger.log('[AdapterRegistry] Enabled adapter:', adapterId);
  }

  /**
   * 停用适配器
   * @param {string} adapterId
   */
  async disableAdapter(adapterId) {
    await this._ensureInitialized();
    
    const adapter = this._cache.get(adapterId);
    if (!adapter) {
      throw new Error(`Adapter not found: ${adapterId}`);
    }
    
    adapter.status = ADAPTER_STATUS.INACTIVE;
    adapter.updatedAt = new Date().toISOString();
    
    await this._persist();
    this.logger.log('[AdapterRegistry] Disabled adapter:', adapterId);
  }

  /**
   * 获取适配器能力矩阵
   * @param {string} adapterId
   * @returns {Object}
   */
  async getCapabilityProfile(adapterId) {
    await this._ensureInitialized();
    
    const adapter = this._cache.get(adapterId);
    if (!adapter) {
      return { ...DEFAULT_CAPABILITY_PROFILE };
    }
    
    return adapter.capabilityProfile || { ...DEFAULT_CAPABILITY_PROFILE };
  }

  /**
   * 检查适配器是否支持某能力
   * @param {string} adapterId
   * @param {string} capabilityName
   * @returns {boolean}
   */
  async supports(adapterId, capabilityName) {
    const profile = await this.getCapabilityProfile(adapterId);
    return profile[capabilityName] === true;
  }

  /**
   * 合并能力矩阵（使用默认值填充缺失字段）
   * @param {Object} customProfile
   * @returns {Object}
   */
  _mergeCapabilityProfile(customProfile = {}) {
    return {
      ...DEFAULT_CAPABILITY_PROFILE,
      ...customProfile
    };
  }

  /**
   * 持久化到状态存储
   */
  async _persist() {
    const adapters = Array.from(this._cache.values());
    await this.stateStore.saveAdapters(adapters);
  }

  /**
   * 确保已初始化
   */
  async _ensureInitialized() {
    if (!this._initialized) {
      await this.initialize();
    }
  }
}

module.exports = AdapterRegistry;