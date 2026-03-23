/**
 * SessionBindingStore.js
 * 
 * 职责：
 * - 统一管理 bindingKey、externalSessionKey、topicId、agentId 的映射关系
 * - 支持跨平台会话绑定
 * - 支持 topic 迁移和重绑
 * 
 * 数据结构：
 * - bindingKey: 平台会话唯一标识，格式为 "platform:conversationType:conversationId:userId"
 * - externalSessionKey: 外部平台会话标识
 * - topicId: VCP 内部话题 ID
 * - agentId: 绑定的 Agent ID
 * 
 * 依赖：
 * - StateStore.js
 */

const StateStore = require('./StateStore');
const { nowTimestamp, createRequestId } = require('./utils');

class SessionBindingStore {
  /**
   * @param {Object} options
   * @param {StateStore} options.stateStore - 状态存储实例
   * @param {boolean} options.debugMode - 调试模式
   */
  constructor(options = {}) {
    this.stateStore = options.stateStore;
    this.debugMode = options.debugMode || false;
    this.cache = new Map(); // 内存缓存
  }

  /**
   * 初始化存储
   */
  async initialize() {
    if (this.debugMode) {
      console.log('[SessionBindingStore] Initializing...');
    }
    
    // 预加载现有绑定到内存缓存
    const sessions = await this.stateStore.querySessions({});
    for (const session of sessions) {
      if (session.bindingKey) {
        this.cache.set(session.bindingKey, session);
      }
    }
    
    if (this.debugMode) {
      console.log(`[SessionBindingStore] Loaded ${this.cache.size} existing bindings`);
    }
  }

  /**
   * 解析或创建会话绑定
   * 
   * @param {Object} envelope - 事件信封
   * @returns {Object} 绑定记录
   */
  async resolveBinding(envelope) {
    const bindingKey = this._extractBindingKey(envelope);
    
    // 先查缓存
    if (this.cache.has(bindingKey)) {
      const existing = this.cache.get(bindingKey);
      if (this.debugMode) {
        console.log(`[SessionBindingStore] Found existing binding: ${bindingKey}`);
      }
      return existing;
    }
    
    // 查持久化存储
    const sessions = await this.stateStore.querySessions({ bindingKey });
    if (sessions.length > 0) {
      const existing = sessions[0];
      this.cache.set(bindingKey, existing);
      if (this.debugMode) {
        console.log(`[SessionBindingStore] Found persisted binding: ${bindingKey}`);
      }
      return existing;
    }
    
    // 创建新绑定
    const newBinding = await this._createBinding(envelope, bindingKey);
    return newBinding;
  }

  /**
   * 创建新的会话绑定
   * 
   * @param {Object} envelope - 事件信封
   * @param {string} bindingKey - 绑定键
   * @returns {Object} 新绑定记录
   */
  async _createBinding(envelope, bindingKey) {
    const record = {
      bindingKey,
      externalSessionKey: envelope.session?.externalSessionKey || bindingKey,
      platform: envelope.channel,
      adapterId: envelope.adapterId,
      conversationId: envelope.client?.conversationId,
      conversationType: envelope.client?.conversationType,
      userId: envelope.sender?.userId,
      topicId: envelope.session?.currentTopicId || null,
      agentId: envelope.target?.agentId || null,
      createdAt: nowTimestamp(),
      lastActiveAt: nowTimestamp(),
      messageCount: 0
    };
    
    // 持久化
    await this.stateStore.appendSession(record);
    
    // 更新缓存
    this.cache.set(bindingKey, record);
    
    if (this.debugMode) {
      console.log(`[SessionBindingStore] Created new binding: ${bindingKey}`);
    }
    
    return record;
  }

  /**
   * 绑定或更新会话
   * 
   * @param {Object} record - 绑定记录
   */
  async bindSession(record) {
    const bindingKey = record.bindingKey;
    
    // 更新持久化
    await this.stateStore.appendSession({
      ...record,
      updatedAt: nowTimestamp()
    });
    
    // 更新缓存
    this.cache.set(bindingKey, record);
    
    if (this.debugMode) {
      console.log(`[SessionBindingStore] Session bound: ${bindingKey}`);
    }
  }

  /**
   * 重新绑定会话
   * 
   * @param {string} bindingKey - 绑定键
   * @param {Object} patch - 更新字段
   */
  async rebindSession(bindingKey, patch) {
    const existing = this.cache.get(bindingKey);
    if (!existing) {
      throw new Error(`Binding not found: ${bindingKey}`);
    }
    
    const updated = {
      ...existing,
      ...patch,
      rebindAt: nowTimestamp()
    };
    
    // 追加新记录（不覆盖历史）
    await this.stateStore.appendSession(updated);
    
    // 更新缓存
    this.cache.set(bindingKey, updated);
    
    if (this.debugMode) {
      console.log(`[SessionBindingStore] Session rebound: ${bindingKey}`, patch);
    }
  }

  /**
   * 更新会话活跃时间
   * 
   * @param {string} bindingKey - 绑定键
   */
  async touchSession(bindingKey) {
    const existing = this.cache.get(bindingKey);
    if (existing) {
      existing.lastActiveAt = nowTimestamp();
      existing.messageCount = (existing.messageCount || 0) + 1;
      
      // 异步持久化，不阻塞主流程
      this.stateStore.appendSession(existing).catch(err => {
        console.error('[SessionBindingStore] Failed to persist session touch:', err);
      });
    }
  }

  /**
   * 查询绑定
   * 
   * @param {Object} filter - 过滤条件
   * @returns {Array} 绑定记录列表
   */
  async queryBindings(filter = {}) {
    // 先从缓存查
    if (filter.bindingKey) {
      const cached = this.cache.get(filter.bindingKey);
      return cached ? [cached] : [];
    }
    
    // 从持久化存储查
    return await this.stateStore.querySessions(filter);
  }

  /**
   * 获取绑定
   * 
   * @param {string} bindingKey - 绑定键
   * @returns {Object|null} 绑定记录
   */
  getBinding(bindingKey) {
    return this.cache.get(bindingKey) || null;
  }

  /**
   * 从事件信封提取绑定键
   * 
   * @param {Object} envelope - 事件信封
   * @returns {string} 绑定键
   */
  _extractBindingKey(envelope) {
    // 优先使用事件中的 bindingKey
    if (envelope.session?.bindingKey) {
      return envelope.session.bindingKey;
    }
    
    // 构造绑定键
    const platform = envelope.channel || 'unknown';
    const conversationType = envelope.client?.conversationType || 'unknown';
    const conversationId = envelope.client?.conversationId || 'unknown';
    const userId = envelope.sender?.userId || 'anonymous';
    
    return `${platform}:${conversationType}:${conversationId}:${userId}`;
  }

  /**
   * 获取统计信息
   * 
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      totalBindings: this.cache.size,
      cacheSize: this.cache.size
    };
  }
}

module.exports = SessionBindingStore;