// modules/channelHub/AgentRoutingPolicy.js
/**
 * Agent 路由策略
 * 
 * 职责：
 * - 统一决定本次事件应该进入哪个 agent、topic、model 和运行时配置
 * - 支持固定 agent
 * - 支持按 adapter / 平台 / 来源群组路由
 * - 支持 topic hint 与当前 topic 选择
 * - 支持 runtime override 合并
 * 
 * 依赖：
 * - SessionBindingStore.js
 * - 现有 agent 配置系统
 */

const { RoutingError } = require('./errors');

class AgentRoutingPolicy {
  /**
   * @param {Object} options
   * @param {Object} options.sessionBindingStore - 会话绑定存储实例
   * @param {Object} options.agentConfigs - Agent 配置映射 (可选，后续可从配置文件加载)
   * @param {Object} options.routingRules - 路由规则 (可选)
   * @param {boolean} options.debugMode - 调试模式
   */
  constructor(options = {}) {
    this.sessionBindingStore = options.sessionBindingStore || null;
    this.agentConfigs = options.agentConfigs || {};
    this.routingRules = options.routingRules || {};
    this.debugMode = options.debugMode || false;
  }

  /**
   * 解析完整的路由决策
   * @param {Object} envelope - 标准化事件信封
   * @param {Object} bindingRecord - 会话绑定记录 (可选)
   * @returns {Promise<Object>} 路由决策
   * 
   * 返回结构：
   * {
   *   agentId: string,
   *   agentName: string,
   *   topicId: string | null,
   *   model: string | null,
   *   runtimeOverrides: Object,
   *   routeReason: string
   * }
   */
  async resolveRoute(envelope, bindingRecord = null) {
    const routeDecision = {
      agentId: null,
      agentName: null,
      topicId: null,
      model: null,
      runtimeOverrides: {},
      routeReason: 'default'
    };

    try {
      // 1. 优先从事件目标获取 agentId
      if (envelope.target?.agentId) {
        routeDecision.agentId = envelope.target.agentId;
        routeDecision.routeReason = 'explicit_target';
      }
      // 2. 从绑定记录获取 agentId
      else if (bindingRecord?.agentId) {
        routeDecision.agentId = bindingRecord.agentId;
        routeDecision.routeReason = 'session_binding';
      }
      // 3. 从路由规则获取 agentId
      else if (this.routingRules.defaultAgent) {
        routeDecision.agentId = this.routingRules.defaultAgent;
        routeDecision.routeReason = 'routing_rule_default';
      }
      // 4. 使用全局默认
      else {
        routeDecision.agentId = 'default';
        routeDecision.routeReason = 'fallback_default';
      }

      // 解析 agent 名称
      routeDecision.agentName = this._resolveAgentName(routeDecision.agentId);

      // 解析 topic
      routeDecision.topicId = await this.resolveTopic(envelope, bindingRecord);

      // 解析运行时覆盖
      routeDecision.runtimeOverrides = this.resolveRuntimeOverrides(envelope);
      routeDecision.model = routeDecision.runtimeOverrides.model || null;

      if (this.debugMode) {
        console.log('[AgentRoutingPolicy] Route decision:', JSON.stringify(routeDecision, null, 2));
      }

      return routeDecision;
    } catch (error) {
      throw new RoutingError(
        `Failed to resolve route: ${error.message}`,
        { envelope, bindingRecord, originalError: error }
      );
    }
  }

  /**
   * 仅解析 agentId
   * @param {Object} envelope - 标准化事件信封
   * @returns {Promise<string>} agentId
   */
  async resolveAgent(envelope) {
    const route = await this.resolveRoute(envelope, null);
    return route.agentId;
  }

  /**
   * 解析 topic
   * @param {Object} envelope - 标准化事件信封
   * @param {Object} bindingRecord - 会话绑定记录
   * @returns {Promise<string|null>} topicId
   */
  async resolveTopic(envelope, bindingRecord = null) {
    // 1. 优先从事件获取 topic hint
    if (envelope.session?.currentTopicId) {
      return envelope.session.currentTopicId;
    }

    // 2. 从绑定记录获取
    if (bindingRecord?.currentTopicId) {
      return bindingRecord.currentTopicId;
    }

    // 3. 如果允许创建 topic，返回 null (后续由 runtime 处理)
    if (envelope.session?.allowCreateTopic !== false) {
      return null;
    }

    // 4. 不允许创建且无现有 topic
    return null;
  }

  /**
   * 解析运行时覆盖配置
   * @param {Object} envelope - 标准化事件信封
   * @returns {Object} 运行时覆盖配置
   */
  resolveRuntimeOverrides(envelope) {
    const overrides = {};

    if (envelope.runtime?.overrides) {
      // 复制所有覆盖配置
      Object.assign(overrides, envelope.runtime.overrides);
    }

    // 从 runtime 字段直接提取
    if (envelope.runtime?.model) {
      overrides.model = envelope.runtime.model;
    }

    if (envelope.runtime?.stream !== undefined) {
      overrides.stream = envelope.runtime.stream;
    }

    return overrides;
  }

  /**
   * 设置路由规则
   * @param {Object} rules - 路由规则
   */
  setRoutingRules(rules) {
    this.routingRules = { ...this.routingRules, ...rules };
  }

  async listPolicies() {
    return this.routingRules;
  }

  async setPolicy(policyConfig) {
    this.setRoutingRules(policyConfig);
    return this.routingRules;
  }

  /**
   * 设置 agent 配置
   * @param {string} agentId - Agent ID
   * @param {Object} config - Agent 配置
   */
  setAgentConfig(agentId, config) {
    this.agentConfigs[agentId] = config;
  }

  /**
   * 内部方法：解析 agent 名称
   * @param {string} agentId - Agent ID
   * @returns {string} Agent 名称
   */
  _resolveAgentName(agentId) {
    if (this.agentConfigs[agentId]?.name) {
      return this.agentConfigs[agentId].name;
    }
    return agentId;
  }
}

module.exports = AgentRoutingPolicy;
