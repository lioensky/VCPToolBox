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
 * Inbound: Webhook -> SignatureValidator -> EventDeduplicator -> B1CompatTranslator 
 *          -> EventSchemaValidator -> MessageNormalizer -> SessionBindingStore 
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
   * @param {Object} options.runtimeBridge - VCP Runtime Bridge 实例
   */
  constructor(options = {}) {
    super();
    
    this.options = options;
    this.config = options.config || {};
    this.logger = options.logger || console;
    this.runtimeBridge = options.runtimeBridge;
    
    // 服务状态
    this.initialized = false;
    this.starting = false;
    this.stopping = false;
    
    // 子模块实例
    this.modules = {
      stateStore: null,
      adapterRegistry: null,
      adapterAuthManager: null,
      signatureValidator: null,
      eventSchemaValidator: null,
      b1CompatTranslator: null,
      eventDeduplicator: null,
      messageNormalizer: null,
      sessionBindingStore: null,
      identityMappingStore: null,
      agentRoutingPolicy: null,
      runtimeGateway: null,
      replyNormalizer: null,
      capabilityRegistry: null,
      capabilityDowngrader: null,
      mediaGateway: null,
      deliveryOutbox: null,
      auditLogger: null,
      metricsCollector: null
    };
    
    // 绑定方法
    this.handleInboundEvent = this.handleInboundEvent.bind(this);
    this.processOutboundJob = this.processOutboundJob.bind(this);
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
    this.logger.info('[ChannelHub] Starting initialization...');
    
    try {
      // 1. 初始化基础设施层
      await this._initializeInfrastructure();
      
      // 2. 初始化安全与验证层
      await this._initializeSecurity();
      
      // 3. 初始化入站处理层
      await this._initializeInboundPipeline();
      
      // 4. 初始化上下文与路由层
      await this._initializeContextRouting();
      
      // 5. 初始化出站处理层
      await this._initializeOutboundPipeline();
      
      // 6. 初始化监控与审计层
      await this._initializeMonitoring();
      
      // 7. 启动出站队列处理器
      await this.modules.deliveryOutbox.start(this.processOutboundJob);
      
      this.initialized = true;
      this.starting = false;
      
      this.logger.info('[ChannelHub] Initialization complete');
      this.emit('initialized');
      
    } catch (error) {
      this.starting = false;
      this.logger.error('[ChannelHub] Initialization failed:', error);
      throw error;
    }
  }
  
  /**
   * 初始化基础设施层
   */
  async _initializeInfrastructure() {
    this.logger.debug('[ChannelHub] Initializing infrastructure...');
    
    // 状态存储
    this.modules.stateStore = new StateStore({
      dataDir: this.config.dataDir,
      logger: this.logger
    });
    await this.modules.stateStore.initialize();
    
    // 适配器注册表
    this.modules.adapterRegistry = new AdapterRegistry({
      stateStore: this.modules.stateStore,
      logger: this.logger
    });
    await this.modules.adapterRegistry.initialize();
    
    // 适配器认证管理
    this.modules.adapterAuthManager = new AdapterAuthManager({
      adapterRegistry: this.modules.adapterRegistry,
      stateStore: this.modules.stateStore,
      logger: this.logger
    });
    await this.modules.adapterAuthManager.initialize();
    
    this.logger.debug('[ChannelHub] Infrastructure initialized');
  }
  
  /**
   * 初始化安全与验证层
   */
  async _initializeSecurity() {
    this.logger.debug('[ChannelHub] Initializing security...');
    
    // 签名验证器
    this.modules.signatureValidator = new SignatureValidator({
      adapterRegistry: this.modules.adapterRegistry,
      logger: this.logger
    });
    
    // 事件模式验证器
    this.modules.eventSchemaValidator = new EventSchemaValidator({
      schemaDir: this.config.schemaDir,
      logger: this.logger
    });
    
    // B1兼容翻译器
    this.modules.b1CompatTranslator = new B1CompatTranslator({
      logger: this.logger
    });
    
    // 事件去重器
    this.modules.eventDeduplicator = new EventDeduplicator({
      stateStore: this.modules.stateStore,
      ttl: this.config.dedupTTL || 300000, // 默认5分钟
      logger: this.logger
    });
    
    this.logger.debug('[ChannelHub] Security initialized');
  }
  
  /**
   * 初始化入站处理层
   */
  async _initializeInboundPipeline() {
    this.logger.debug('[ChannelHub] Initializing inbound pipeline...');
    
    // 消息标准化器
    this.modules.messageNormalizer = new MessageNormalizer({
      adapterRegistry: this.modules.adapterRegistry,
      logger: this.logger
    });
    
    this.logger.debug('[ChannelHub] Inbound pipeline initialized');
  }
  
  /**
   * 初始化上下文与路由层
   */
  async _initializeContextRouting() {
    this.logger.debug('[ChannelHub] Initializing context and routing...');
    
    // 会话绑定存储
    this.modules.sessionBindingStore = new SessionBindingStore({
      stateStore: this.modules.stateStore,
      logger: this.logger
    });
    await this.modules.sessionBindingStore.initialize();
    
    // 身份映射存储
    this.modules.identityMappingStore = new IdentityMappingStore({
      stateStore: this.modules.stateStore,
      logger: this.logger
    });
    await this.modules.identityMappingStore.initialize();
    
    // Agent路由策略
    this.modules.agentRoutingPolicy = new AgentRoutingPolicy({
      stateStore: this.modules.stateStore,
      logger: this.logger
    });
    await this.modules.agentRoutingPolicy.initialize();
    
    // Runtime网关
    this.modules.runtimeGateway = new RuntimeGateway({
      runtimeBridge: this.runtimeBridge,
      logger: this.logger
    });
    
    // 回复标准化器
    this.modules.replyNormalizer = new ReplyNormalizer({
      logger: this.logger
    });
    
    this.logger.debug('[ChannelHub] Context and routing initialized');
  }
  
  /**
   * 初始化出站处理层
   */
  async _initializeOutboundPipeline() {
    this.logger.debug('[ChannelHub] Initializing outbound pipeline...');
    
    // 能力注册表
    this.modules.capabilityRegistry = new CapabilityRegistry({
      adapterRegistry: this.modules.adapterRegistry,
      logger: this.logger
    });
    
    // 能力降级器
    this.modules.capabilityDowngrader = new CapabilityDowngrader({
      capabilityRegistry: this.modules.capabilityRegistry,
      logger: this.logger
    });
    
    // 媒体网关
    this.modules.mediaGateway = new MediaGateway({
      adapterRegistry: this.modules.adapterRegistry,
      tempDir: this.config.tempDir,
      logger: this.logger
    });
    
    // 出站队列
    this.modules.deliveryOutbox = new DeliveryOutbox({
      stateStore: this.modules.stateStore,
      concurrency: this.config.outboxConcurrency || 5,
      retryPolicy: this.config.retryPolicy,
      logger: this.logger
    });
    await this.modules.deliveryOutbox.initialize();
    
    this.logger.debug('[ChannelHub] Outbound pipeline initialized');
  }
  
  /**
   * 初始化监控与审计层
   */
  async _initializeMonitoring() {
    this.logger.debug('[ChannelHub] Initializing monitoring...');
    
    // 审计日志器
    this.modules.auditLogger = new AuditLogger({
      logDir: this.config.auditLogDir,
      logger: this.logger
    });
    await this.modules.auditLogger.initialize();
    
    // 指标收集器
    this.modules.metricsCollector = new MetricsCollector({
      prefix: 'channelhub_',
      logger: this.logger
    });
    
    this.logger.debug('[ChannelHub] Monitoring initialized');
  }
  
  /**
   * 处理入站事件 - 主入口
   * @param {string} adapterId - 适配器ID
   * @param {Object} rawEvent - 原始事件数据
   * @param {Object} context - 请求上下文
   * @returns {Promise<Object>} 处理结果
   */
  async handleInboundEvent(adapterId, rawEvent, context = {}) {
    const startTime = Date.now();
    const traceId = context.traceId || Utils.generateId();
    
    try {
      // 记录入站事件开始
      this.modules.auditLogger.logInboundStart(traceId, adapterId, rawEvent);
      this.modules.metricsCollector.increment('inbound.events.total');
      
      // 1. 获取适配器配置
      const adapter = this.modules.adapterRegistry.getAdapter(adapterId);
      if (!adapter || adapter.status !== Constants.AdapterStatus.ACTIVE) {
        throw new Errors.AdapterNotFoundError(`Adapter not found or inactive: ${adapterId}`);
      }
      
      // 2. 签名验证
      await this.modules.signatureValidator.validate(adapterId, rawEvent, context);
      
      // 3. B1兼容翻译（如果需要）
      let event = rawEvent;
      if (this._isB1Format(rawEvent)) {
        event = await this.modules.b1CompatTranslator.translate(rawEvent, adapterId);
      }
      
      // 4. 事件去重
      const isDuplicate = await this.modules.eventDeduplicator.checkAndRecord(
        event.eventId || Utils.hash(JSON.stringify(event))
      );
      if (isDuplicate) {
        this.logger.info(`[ChannelHub] Duplicate event detected: ${event.eventId}`);
        this.modules.metricsCollector.increment('inbound.events.duplicate');
        return { status: 'duplicate', eventId: event.eventId };
      }
      
      // 5. 事件模式验证
      const validatedEvent = await this.modules.eventSchemaValidator.validate(event);
      
      // 6. 消息标准化
      const normalizedMessage = await this.modules.messageNormalizer.normalize(
        adapterId, 
        validatedEvent
      );
      
      // 7. 解析/更新会话绑定
      const sessionBinding = await this.modules.sessionBindingStore.resolveOrCreate(
        normalizedMessage.bindingKey,
        {
          adapterId,
          channel: validatedEvent.channel,
          externalSessionKey: normalizedMessage.externalSessionKey
        }
      );
      
      // 8. 解析/创建身份映射
      const identityMapping = await this.modules.identityMappingStore.resolveOrCreate(
        normalizedMessage.sender,
        adapterId
      );
      
      // 9. Agent路由决策
      const routingDecision = await this.modules.agentRoutingPolicy.decide({
        sessionBinding,
        identityMapping,
        message: normalizedMessage,
        event: validatedEvent
      });
      
      // 10. 调用Runtime
      const runtimeResponse = await this.modules.runtimeGateway.invoke({
        agentId: routingDecision.agentId,
        sessionId: sessionBinding.vcpSessionId,
        message: normalizedMessage,
        context: {
          channel: validatedEvent.channel,
          adapterId,
          identityMapping,
          traceId
        }
      });
      
      // 11. 标准化回复
      const reply = await this.modules.replyNormalizer.normalize(runtimeResponse);
      
      // 12. 投递到出站队列
      const outboxJob = await this.modules.deliveryOutbox.enqueue({
        adapterId,
        sessionBinding,
        reply,
        traceId
      });
      
      // 记录成功
      const duration = Date.now() - startTime;
      this.modules.auditLogger.logInboundSuccess(traceId, outboxJob.jobId, duration);
      this.modules.metricsCollector.timing('inbound.events.duration', duration);
      this.modules.metricsCollector.increment('inbound.events.success');
      
      return {
        status: 'success',
        jobId: outboxJob.jobId,
        sessionId: sessionBinding.vcpSessionId
      };
      
    } catch (error) {
      // 记录失败
      const duration = Date.now() - startTime;
      this.modules.auditLogger.logInboundError(traceId, error, duration);
      this.modules.metricsCollector.increment('inbound.events.error');
      
      this.logger.error(`[ChannelHub] Inbound event error: ${error.message}`, error);
      
      throw error;
    }
  }
  
  /**
   * 处理出站任务
   * @param {Object} job - 出站任务
   * @returns {Promise<void>}
   */
  async processOutboundJob(job) {
    const startTime = Date.now();
    
    try {
      this.modules.metricsCollector.increment('outbound.jobs.total');
      
      // 1. 获取适配器
      const adapter = this.modules.adapterRegistry.getAdapter(job.adapterId);
      if (!adapter) {
        throw new Errors.AdapterNotFoundError(`Adapter not found: ${job.adapterId}`);
      }
      
      // 2. 获取平台能力
      const capabilities = this.modules.capabilityRegistry.getCapabilities(
        adapter.channel,
        adapter.platformVersion
      );
      
      // 3. 能力降级（如果需要）
      const deliverableReply = await this.modules.capabilityDowngrader.downgrade(
        job.reply,
        capabilities
      );
      
      // 4. 处理媒体文件
      const processedReply = await this.modules.mediaGateway.processMedia(
        deliverableReply,
        job.adapterId
      );
      
      // 5. 调用适配器发送
      const adapterInstance = this.modules.adapterRegistry.getAdapterInstance(job.adapterId);
      await adapterInstance.send(processedReply, job.sessionBinding);
      
      // 记录成功
      const duration = Date.now() - startTime;
      this.modules.auditLogger.logOutboundSuccess(job.jobId, duration);
      this.modules.metricsCollector.timing('outbound.jobs.duration', duration);
      this.modules.metricsCollector.increment('outbound.jobs.success');
      
    } catch (error) {
      const duration = Date.now() - startTime;
      this.modules.auditLogger.logOutboundError(job.jobId, error, duration);
      this.modules.metricsCollector.increment('outbound.jobs.error');
      
      throw error;
    }
  }
  
  /**
   * 判断是否为B1格式事件
   * @param {Object} event - 事件对象
   * @returns {boolean}
   */
  _isB1Format(event) {
    // B1格式特征检测
    return event && !event.version && event.platform && event.payload;
  }
  
  /**
   * 注册适配器
   * @param {string} adapterId - 适配器ID
   * @param {Object} config - 适配器配置
   * @returns {Promise<void>}
   */
  async registerAdapter(adapterId, config) {
    await this.modules.adapterRegistry.register(adapterId, config);
    this.modules.auditLogger.logAdapterRegistered(adapterId, config);
  }
  
  /**
   * 注销适配器
   * @param {string} adapterId - 适配器ID
   * @returns {Promise<void>}
   */
  async unregisterAdapter(adapterId) {
    await this.modules.adapterRegistry.unregister(adapterId);
    this.modules.auditLogger.logAdapterUnregistered(adapterId);
  }
  
  /**
   * 获取服务健康状态
   * @returns {Object} 健康状态
   */
  getHealthStatus() {
    return {
      initialized: this.initialized,
      uptime: process.uptime(),
      modules: Object.keys(this.modules).reduce((acc, key) => {
        acc[key] = this.modules[key] !== null;
        return acc;
      }, {}),
      metrics: this.modules.metricsCollector?.snapshot() || {},
      adapters: this.modules.adapterRegistry?.getAdapterCount() || 0,
      outbox: {
        pending: this.modules.deliveryOutbox?.getPendingCount() || 0,
        processing: this.modules.deliveryOutbox?.getProcessingCount() || 0
      }
    };
  }
  
  /**
   * 优雅关闭
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (!this.initialized) {
      return;
    }
    
    if (this.stopping) {
      throw new Errors.ChannelHubError('Service is already stopping');
    }
    
    this.stopping = true;
    this.logger.info('[ChannelHub] Starting graceful shutdown...');
    
    try {
      // 1. 停止接收新事件
      this.emit('stopping');
      
      // 2. 停止出站队列处理器
      if (this.modules.deliveryOutbox) {
        await this.modules.deliveryOutbox.stop();
      }
      
      // 3. 关闭各模块
      for (const [name, module] of Object.entries(this.modules)) {
        if (module && typeof module.shutdown === 'function') {
          try {
            await module.shutdown();
          } catch (error) {
            this.logger.error(`[ChannelHub] Error shutting down ${name}:`, error);
          }
        }
      }
      
      this.initialized = false;
      this.stopping = false;
      
      this.logger.info('[ChannelHub] Shutdown complete');
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