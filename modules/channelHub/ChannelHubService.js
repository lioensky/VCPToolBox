/**
 * ChannelHubService.js
 * 
 * ChannelHub主编排服务 - 统一入口点
 * 
 * 职责：
 * - 统一初始化所有子模块
 * - 协调入站事件处理流水线
 * - 协调出站消息投递流水线
 * - 提供健康检查和状态查询接口
 * - 管理适配器生命周期
 * - 提供优雅关闭机制
 * 
 * 流水线：
 * Inbound: Webhook -> AdapterAuth -> B1CompatTranslator -> EventSchemaValidator
 *          -> EventDeduplicator -> MessageNormalizer -> SessionBindingStore 
 *          -> AgentRoutingPolicy -> RuntimeGateway -> ReplyNormalizer -> DeliveryOutbox
 * 
 * Outbound: DeliveryOutbox -> CapabilityDowngrader -> MediaGateway -> Adapter
 */

const EventEmitter = require('events');

// 导入所有子模块
const Constants = require('./constants');
const Errors = require('./errors');
const Utils = require('./utils');
const StateStore = require('./StateStore');
const AdapterRegistry = require('./AdapterRegistry');
const AdapterAuthManager = require('./AdapterAuthManager');
const SignatureValidator = require('./SignatureValidator');
const EventSchemaValidator = require('./EventSchemaValidator');
const B1CompatTranslator = require('./B1CompatTranslator');
const EventDeduplicator = require('./EventDeduplicator');
const MessageNormalizer = require('./MessageNormalizer');
const SessionBindingStore = require('./SessionBindingStore');
const IdentityMappingStore = require('./IdentityMappingStore');
const AgentRoutingPolicy = require('./AgentRoutingPolicy');
const RuntimeGateway = require('./RuntimeGateway');
const ReplyNormalizer = require('./ReplyNormalizer');
const CapabilityRegistry = require('./CapabilityRegistry');
const CapabilityDowngrader = require('./CapabilityDowngrader');
const MediaGateway = require('./MediaGateway');
const DeliveryOutbox = require('./DeliveryOutbox');
const AuditLogger = require('./AuditLogger');
const MetricsCollector = require('./MetricsCollector');

/**
 * ChannelHubService 主服务类
 */
class ChannelHubService extends EventEmitter {
  /**
   * @param {Object} options - 配置选项
   * @param {Object} options.config - 全局配置
   * @param {Object} options.logger - 日志实例
   * @param {Object} options.chatCompletionHandler - VCP ChatCompletionHandler 实例
   * @param {Object} options.pluginManager - VCP PluginManager 实例
   */
  constructor(options = {}) {
    super();
    
    this.options = options;
    this.config = options.config || {};
    // 规范化 logger：兼容 VCP logger 模块（无 .log）和原生 console（有 .log）
    const rawLogger = options.logger || console;
    this.logger = rawLogger.log
      ? rawLogger  // console 或已有 .log 的 logger，直接用
      : Object.assign(Object.create(rawLogger), {
          log: (...args) => rawLogger.info(...args)  // VCP logger 没有 .log，代理到 .info
        });
    this.chatCompletionHandler = options.chatCompletionHandler;
    this.pluginManager = options.pluginManager;
    
    // 服务状态
    this.initialized = false;
    this.starting = false;
    this.stopping = false;
    
    // 子模块实例（公开访问，供路由层使用）
    this.stateStore = null;
    this.adapterRegistry = null;
    this.adapterAuthManager = null;
    this.signatureValidator = null;
    this.eventSchemaValidator = null;
    this.b1CompatTranslator = null;
    this.eventDeduplicator = null;
    this.messageNormalizer = null;
    this.sessionBindingStore = null;
    this.identityMappingStore = null;
    this.agentRoutingPolicy = null;
    this.runtimeGateway = null;
    this.replyNormalizer = null;
    this.capabilityRegistry = null;
    this.capabilityDowngrader = null;
    this.mediaGateway = null;
    this.deliveryOutbox = null;
    this.auditLogger = null;
    this.metricsCollector = null;
    
    // 绑定方法
    this.handleInboundEvent = this.handleInboundEvent.bind(this);
    this.processOutboundJob = this.processOutboundJob.bind(this);
  }

  /**
   * 向后兼容：admin 路由仍按 channelHubService.modules.xxx 取模块
   */
  get modules() {
    return {
      stateStore: this.stateStore,
      adapterRegistry: this.adapterRegistry,
      adapterAuthManager: this.adapterAuthManager,
      signatureValidator: this.signatureValidator,
      eventSchemaValidator: this.eventSchemaValidator,
      b1CompatTranslator: this.b1CompatTranslator,
      eventDeduplicator: this.eventDeduplicator,
      messageNormalizer: this.messageNormalizer,
      sessionBindingStore: this.sessionBindingStore,
      identityMappingStore: this.identityMappingStore,
      agentRoutingPolicy: this.agentRoutingPolicy,
      runtimeGateway: this.runtimeGateway,
      replyNormalizer: this.replyNormalizer,
      capabilityRegistry: this.capabilityRegistry,
      capabilityDowngrader: this.capabilityDowngrader,
      mediaGateway: this.mediaGateway,
      deliveryOutbox: this.deliveryOutbox,
      auditLogger: this.auditLogger,
      metricsCollector: this.metricsCollector
    };
  }

  getModule(moduleName) {
    if (!moduleName) {
      return null;
    }

    return this[moduleName] || this.modules[moduleName] || null;
  }
  
  /**
   * 初始化服务
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) {
      throw new Errors.ChannelHubError('Service already initialized');
    }
    
    if (this.starting) {
      throw new Errors.ChannelHubError('Service is starting');
    }
    
    this.starting = true;
    this.logger.log('[ChannelHub] Starting initialization...');
    
    try {
      // 1. 初始化基础设施层
      await this._initializeInfrastructure();
      
      // 2. 初始化安全与验证层
      this._initializeSecurity();
      
      // 3. 初始化入站处理层
      this._initializeInboundPipeline();
      
      // 4. 初始化上下文与路由层
      await this._initializeContextRouting();
      
      // 5. 初始化出站处理层
      await this._initializeOutboundPipeline();
      
      // 6. 初始化监控与审计层
      await this._initializeMonitoring();
      
      this.initialized = true;
      this.starting = false;
      
      this.logger.log('[ChannelHub] Initialization complete');
      this.emit('initialized');
      
    } catch (error) {
      this.starting = false;
      this.logger.error('[ChannelHub] Initialization failed:', error);
      throw error;
    }
  }
  
  // ==================== 初始化各层 ====================
  
  async _initializeInfrastructure() {
    this.logger.log('[ChannelHub] Initializing infrastructure...');
    
    this.stateStore = new StateStore({
      baseDir: this.config.baseDir,
      debugMode: this.config.debugMode
    });
    await this.stateStore.initialize();
    
    this.adapterRegistry = new AdapterRegistry({
      stateStore: this.stateStore,
      logger: this.logger,
      debugMode: this.config.debugMode
    });
    await this.adapterRegistry.initialize();
    
    this.adapterAuthManager = new AdapterAuthManager({
      adapterRegistry: this.adapterRegistry,
      stateStore: this.stateStore,
      config: this.config,
      debugMode: this.config.debugMode
    });
    await this.adapterAuthManager.initialize();
  }
  
  _initializeSecurity() {
    this.logger.log('[ChannelHub] Initializing security...');
    
    this.signatureValidator = new SignatureValidator({
      stateStore: this.stateStore,
      adapterRegistry: this.adapterRegistry,
      config: {
        timestampTolerance: this.config.timestampTolerance || 300000,
        nonceTTL: this.config.nonceTTL || 300000
      }
    });
    
    this.eventSchemaValidator = new EventSchemaValidator({
      strictMode: this.config.strictSchemaMode || false
    });
    
    this.b1CompatTranslator = new B1CompatTranslator({
      debugMode: this.config.debugMode
    });
    
    this.eventDeduplicator = new EventDeduplicator({
      stateStore: this.stateStore,
      ttlMs: this.config.dedupTTL || Constants.DEDUP_TTL_MS,
      debugMode: this.config.debugMode
    });
  }
  
  _initializeInboundPipeline() {
    this.logger.log('[ChannelHub] Initializing inbound pipeline...');
    
    this.messageNormalizer = new MessageNormalizer({
      debugMode: this.config.debugMode
    });
  }
  
  async _initializeContextRouting() {
    this.logger.log('[ChannelHub] Initializing context and routing...');
    
    this.sessionBindingStore = new SessionBindingStore({
      stateStore: this.stateStore,
      debugMode: this.config.debugMode
    });
    await this.sessionBindingStore.initialize();
    
    this.identityMappingStore = new IdentityMappingStore({
      stateStore: this.stateStore,
      debugMode: this.config.debugMode
    });
    
    this.agentRoutingPolicy = new AgentRoutingPolicy({
      sessionBindingStore: this.sessionBindingStore,
      debugMode: this.config.debugMode
    });
    
    this.runtimeGateway = new RuntimeGateway({
      chatCompletionHandler: this.chatCompletionHandler,
      pluginManager: this.pluginManager,
      config: this.config,
      debugMode: this.config.debugMode
    });
    
    this.replyNormalizer = new ReplyNormalizer({
      debugMode: this.config.debugMode
    });
  }
  
  async _initializeOutboundPipeline() {
    this.logger.log('[ChannelHub] Initializing outbound pipeline...');
    
    this.capabilityRegistry = new CapabilityRegistry({
      adapterRegistry: this.adapterRegistry,
      logger: this.logger
    });
    
    this.capabilityDowngrader = new CapabilityDowngrader({
      capabilityRegistry: this.capabilityRegistry,
      logger: this.logger
    });
    
    this.mediaGateway = new MediaGateway({
      storagePath: this.config.mediaStoragePath || './state/channelHub/media',
      baseUrl: this.config.mediaBaseUrl || '/media'
    });
    await this.mediaGateway.initialize();
    
    this.deliveryOutbox = new DeliveryOutbox({
      store: this.stateStore,
      logger: this.logger,
      maxAttempts: this.config.maxDeliveryAttempts || 5,
      baseRetryDelay: this.config.baseRetryDelay || 1000,
      maxRetryDelay: this.config.maxRetryDelay || 60000
    });
    await this.deliveryOutbox.initialize();

    // 将出站队列与实际处理逻辑接通
    this.deliveryOutbox.on('batch:ready', async (jobs) => {
      for (const job of jobs) {
        try {
          await this.deliveryOutbox.markProcessing(job.jobId);
          await this.processOutboundJob(job);
          await this.deliveryOutbox.markSuccess(job.jobId, { success: true });
        } catch (error) {
          this.logger.error('[ChannelHub] Outbound job failed:', error);
          await this.deliveryOutbox.markFailed(job.jobId, error);
        }
      }
    });
  }
  
  async _initializeMonitoring() {
    this.logger.log('[ChannelHub] Initializing monitoring...');
    
    this.auditLogger = new AuditLogger({
      logDir: this.config.auditLogDir || './state/channelHub/logs',
      enableConsole: this.config.debugMode || false
    });
    await this.auditLogger.initialize();
    
    this.metricsCollector = new MetricsCollector({
      logger: this.logger
    });
    await this.metricsCollector.initialize();
  }
  
  // ==================== 入站处理主流程 ====================
  
  /**
   * 处理入站事件 - 主入口
   * 
   * @param {string} adapterId - 适配器ID
   * @param {Object} rawEvent - 原始事件数据（B1 或 B2 格式）
   * @param {Object} context - 请求上下文
   * @param {string} [context.traceId] - 追踪 ID
   * @param {Object} [context.headers] - 原始请求头
   * @param {string} [context.sourceIp] - 来源 IP
   * @returns {Promise<Object>} 处理结果
   */
  async handleInboundEvent(adapterId, rawEvent, context = {}) {
    const startTime = Date.now();
    const traceId = context.traceId || this.auditLogger.generateTraceId();
    
    try {
      // 记录入站事件
      this.metricsCollector.recordEventReceived(adapterId, rawEvent.channel || 'unknown');
      
      // 1. B1 兼容翻译（如果需要）
      let envelope = rawEvent;
      if (this._isB1Format(rawEvent)) {
        envelope = this.b1CompatTranslator.translateRequest(rawEvent, context.headers || {});
      }
      
      // 2. Schema 校验与归一化
      const validation = this.eventSchemaValidator.validateAndNormalize(envelope);
      if (!validation.valid) {
        throw new Errors.EventValidationError(
          `Schema validation failed: ${validation.errors.join('; ')}`,
          { details: validation.errors }
        );
      }
      envelope = validation.envelope;
      
      // 3. 事件去重
      const dedupResult = await this.eventDeduplicator.checkAndMark(envelope);
      if (dedupResult.isDuplicate) {
        this.logger.log(`[ChannelHub] Duplicate event detected: ${envelope.eventId}`);
        this.metricsCollector.incrementCounter('events_deduplicated', 1, { adapterId });
        return { status: 'duplicate', eventId: envelope.eventId };
      }
      
      // 4. 消息归一化
      const normalizedMessages = this.messageNormalizer.normalizeMessages(envelope);
      envelope.payload.messages = normalizedMessages;
      
      // 5. 解析/创建会话绑定
      const sessionBinding = await this.sessionBindingStore.resolveBinding(envelope);
      
      // 6. 解析/创建身份映射
      const identityMapping = await this.identityMappingStore.findOrCreateIdentity({
        platform: envelope.channel,
        platformUserId: envelope.sender?.userId || 'unknown',
        displayName: envelope.sender?.nick || 'User',
        metadata: { adapterId }
      });
      
      // 7. Agent 路由决策
      const routeDecision = await this.agentRoutingPolicy.resolveRoute(envelope, sessionBinding);
      
      // 8. 审计：记录入站事件
      this.auditLogger.logInboundEvent(envelope, traceId, {
        adapterId,
        routeDecision: {
          agentId: routeDecision.agentId,
          topicId: routeDecision.topicId,
          reason: routeDecision.routeReason
        }
      });
      
      // 9. 调用 Runtime
      const runtimeResponse = await this.runtimeGateway.invoke(envelope, routeDecision);
      
      // 10. 归一化回复
      const normalizedReply = this.replyNormalizer.normalize(runtimeResponse, {
        requestId: envelope.requestId || envelope.eventId,
        agentId: routeDecision.agentId,
        sessionKey: sessionBinding.bindingKey,
        resolvedTopicId: routeDecision.topicId
      });
      
      // 11. 更新会话活跃时间
      await this.sessionBindingStore.touchSession(sessionBinding.bindingKey);
      
      // 12. 投递到出站队列
      const jobId = await this.deliveryOutbox.enqueue({
        adapterId,
        channel: envelope.channel,
        payload: normalizedReply,
        priority: Constants.PRIORITY.NORMAL
      });
      
      // 记录成功
      const duration = Date.now() - startTime;
      this.auditLogger.logRuntimeInvocation(
        traceId, routeDecision.agentId, sessionBinding.bindingKey,
        { model: routeDecision.model, messageCount: normalizedMessages.length },
        { success: true, finishReason: 'stop', usage: normalizedReply.usage },
        duration
      );
      this.metricsCollector.recordEventProcessed(adapterId, envelope.channel, duration);
      
      return {
        status: 'success',
        jobId,
        eventId: envelope.eventId,
        sessionId: sessionBinding.bindingKey,
        reply: normalizedReply
      };
      
    } catch (error) {
      // 记录失败
      const duration = Date.now() - startTime;
      this.auditLogger.logError(traceId, error, { adapterId, phase: 'inbound' });
      this.metricsCollector.recordEventFailed(adapterId, rawEvent.channel || 'unknown', error);
      
      this.logger.error(`[ChannelHub] Inbound event error: ${error.message}`, error);
      
      throw error;
    }
  }
  
  // ==================== 出站处理主流程 ====================
  
  /**
   * 处理出站任务
   * @param {Object} job - 出站任务
   * @returns {Promise<void>}
   */
  async processOutboundJob(job) {
    const startTime = Date.now();
    const traceId = this.auditLogger.generateTraceId();
    
    try {
      this.metricsCollector.incrementCounter('outbound_jobs_total', 1, { adapterId: job.adapterId });
      
      // 1. 获取适配器
      const adapter = await this.adapterRegistry.getAdapter(job.adapterId);
      if (!adapter) {
        throw new Errors.AdapterNotFoundError(`Adapter not found: ${job.adapterId}`);
      }
      
      // 2. 获取平台能力
      const capabilities = await this.capabilityRegistry.getProfile(job.adapterId);
      
      // 3. 能力降级（如果需要）
      // 注意：当前 CapabilityDowngrader 期望 reply.parts，但我们用 messages[].content[]
      // 这里做一层适配
      let deliverableReply = job.payload;
      if (deliverableReply.messages && Array.isArray(deliverableReply.messages)) {
        for (const msg of deliverableReply.messages) {
          if (msg.content && Array.isArray(msg.content)) {
            msg.content = msg.content.map(part => {
              const result = this.capabilityDowngrader.downgradePart(
                part, job.channel, capabilities
              );
              return result.part;
            });
          }
        }
      }
      
      // 4. 记录出站投递
      this.auditLogger.logOutboundDelivery(traceId, job, 'PROCESSING');
      this.metricsCollector.recordOutboundMessage(job.adapterId, job.channel, {
        parts: deliverableReply.messages?.length || 0
      });
      
      // 5. 标记成功（实际投递由适配器完成，此处先标记）
      const duration = Date.now() - startTime;
      this.auditLogger.logOutboundDelivery(traceId, job, 'DELIVERED', { success: true });
      this.metricsCollector.incrementCounter('outbound_jobs_success', 1, { adapterId: job.adapterId });
      
    } catch (error) {
      const duration = Date.now() - startTime;
      this.auditLogger.logOutboundDelivery(traceId, job, 'FAILED', { 
        success: false, error: error.message 
      });
      this.metricsCollector.incrementCounter('outbound_jobs_error', 1, { adapterId: job.adapterId });
      
      throw error;
    }
  }
  
  // ==================== 辅助方法 ====================
  
  /**
   * 判断是否为B1格式事件
   */
  _isB1Format(event) {
    // B1 格式特征：没有 version 字段，有 platform/payload 或直接有 agentId + messages
    return event && !event.version && (
      (event.platform && event.payload) ||
      (event.agentId && event.messages)
    );
  }
  
  /**
   * 注册适配器
   */
  async registerAdapter(adapterId, config) {
    const result = await this.adapterRegistry.upsertAdapter({
      adapterId,
      ...config
    });
    this.auditLogger.logAdapterStatusChange(adapterId, 'registered', config);
    return result;
  }
  
  /**
   * 注销适配器
   */
  async unregisterAdapter(adapterId) {
    await this.adapterRegistry.disableAdapter(adapterId);
    this.auditLogger.logAdapterStatusChange(adapterId, 'unregistered');
  }
  
  /**
   * 获取服务健康状态
   */
  getHealthStatus() {
    return {
      initialized: this.initialized,
      uptime: process.uptime(),
      modules: {
        stateStore: !!this.stateStore,
        adapterRegistry: !!this.adapterRegistry,
        adapterAuthManager: !!this.adapterAuthManager,
        signatureValidator: !!this.signatureValidator,
        eventSchemaValidator: !!this.eventSchemaValidator,
        b1CompatTranslator: !!this.b1CompatTranslator,
        eventDeduplicator: !!this.eventDeduplicator,
        messageNormalizer: !!this.messageNormalizer,
        sessionBindingStore: !!this.sessionBindingStore,
        identityMappingStore: !!this.identityMappingStore,
        agentRoutingPolicy: !!this.agentRoutingPolicy,
        runtimeGateway: !!this.runtimeGateway,
        replyNormalizer: !!this.replyNormalizer,
        capabilityRegistry: !!this.capabilityRegistry,
        capabilityDowngrader: !!this.capabilityDowngrader,
        mediaGateway: !!this.mediaGateway,
        deliveryOutbox: !!this.deliveryOutbox,
        auditLogger: !!this.auditLogger,
        metricsCollector: !!this.metricsCollector
      },
      metrics: this.metricsCollector?.getSummary() || {},
      adapters: this.adapterRegistry?._cache?.size || 0,
      sessions: this.sessionBindingStore?.getStats() || {},
      outbox: this.deliveryOutbox?.getStats() || {}
    };
  }
  
  /**
   * 优雅关闭
   */
  async shutdown() {
    if (!this.initialized) return;
    if (this.stopping) {
      throw new Errors.ChannelHubError('Service is already stopping');
    }
    
    this.stopping = true;
    this.logger.log('[ChannelHub] Starting graceful shutdown...');
    
    try {
      this.emit('stopping');
      
      // 停止出站队列
      if (this.deliveryOutbox) {
        this.deliveryOutbox.stop();
      }
      
      // 关闭审计日志
      if (this.auditLogger) {
        await this.auditLogger.close();
      }
      
      // 关闭指标收集器
      if (this.metricsCollector) {
        await this.metricsCollector.shutdown();
      }
      
      this.initialized = false;
      this.stopping = false;
      
      this.logger.log('[ChannelHub] Shutdown complete');
      this.emit('shutdown');
      
    } catch (error) {
      this.stopping = false;
      this.logger.error('[ChannelHub] Shutdown error:', error);
      throw error;
    }
  }
}

// 导出
module.exports = {
  ChannelHubService,
  Constants,
  Errors,
  Utils
};
