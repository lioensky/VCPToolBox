// core/VcpCoreEngine.js
/**
 * @fileoverview VCP 方案 2 核心业务调度引擎 (VcpCoreEngine)
 * 纯六边形核心层：彻底解耦 req / res / Express。
 * 接收标准 JS 对象，通过 AsyncGenerator (chatStream) 产出结构化流式事件。
 * 内置 Proactive Wakeup Protocol，支持后台 AI 生命体主动唤醒与四级打扰。
 */

'use strict';

const EventEmitter = require('events');
const {
  ChatChunkType,
  WakeLevel,
  DaemonLifecycleState,
  ShutdownReason,
  validateChatRequest,
  createChatChunk,
  createWakeEvent
} = require('./types.js');
const {
  consumeVcpToolUseForbiddenPlaceholder,
  isTextOnlyModelByTag,
  messagesContainBase64Media,
  copyArrayMetadata,
  isToolResultError,
  formatToolResult,
  getRealAuthCode,
  _refreshRagBlocksIfNeeded,
  parseSseStream
} = require('./pipelineUtils.js');
const { fetchWithRetry, resolveApiVersionPrefix } = require('./upstreamFetch.js');
const { stripVcpPrivateFields } = require('../modules/handlers/upstreamBodySanitizer.js');
const { extractReasoningText } = require('../modules/reasoningContentAdapter.js');

class VcpCoreEngine extends EventEmitter {
  /**
   * @param {object} config - 核心配置注入
   */
  constructor(config = {}) {
    super();
    this.config = config;

    // 基础网络与凭证
    this.apiUrl = config.apiUrl || process.env.API_URL || 'http://127.0.0.1:11434';
    this.apiKey = config.apiKey || process.env.API_Key || '';
    const explicitPrefix = config.apiVersion || process.env.API_VERSION_PREFIX;
    this.apiVersion = resolveApiVersionPrefix(this.apiUrl, explicitPrefix);

    // 核心依赖组件
    this.modelRedirectHandler = config.modelRedirectHandler || {
      redirectModelForBackend: m => m
    };
    this.pluginManager = config.pluginManager || {
      messagePreprocessors: new Map(),
      preprocessorOrder: [],
      getIndividualPluginDescriptions: () => ({}),
      getAllPlaceholderValues: () => ({}),
      getResolvedPluginConfigValue: () => null,
      getPluginDescriptions: () => '',
      getPlugin: () => null,
      executeMessagePreprocessor: async (name, msgs) => msgs,
      processToolCall: async () => ({ status: 'error', message: 'No pluginManager' })
    };
    if (typeof this.pluginManager.getIndividualPluginDescriptions !== 'function') {
      this.pluginManager.getIndividualPluginDescriptions = () => ({});
    }
    if (typeof this.pluginManager.getAllPlaceholderValues !== 'function') {
      this.pluginManager.getAllPlaceholderValues = () => ({});
    }
    if (typeof this.pluginManager.getResolvedPluginConfigValue !== 'function') {
      this.pluginManager.getResolvedPluginConfigValue = () => null;
    }
    this.semanticModelRouter = config.semanticModelRouter || null;
    this.multiModalConfigStore = config.multiModalConfigStore || null;
    if (!this.multiModalConfigStore) {
      try {
        this.multiModalConfigStore = require('../modules/multiModalConfigStore.js');
      } catch (_) {
        this.multiModalConfigStore = null;
      }
    }

    // 上下文与分词管理
    try {
      this.contextManager = config.contextManager || require('../modules/contextManager.js');
    } catch (_) {
      this.contextManager = { pruneMessagesSmart: async msgs => msgs };
    }
    try {
      this.messageProcessor = config.messageProcessor || require('../modules/messageProcessor.js');
    } catch (_) {
      this.messageProcessor = {
        replaceAgentVariables: async c => c,
        injectStaticPluginPlaceholdersInMessages: async m => m,
        applyDetectorsToMessages: m => m
      };
    }
    try {
      this.roleDivider = config.roleDivider || require('../modules/roleDivider.js');
    } catch (_) {
      this.roleDivider = { process: m => m };
    }
    try {
      this.finalContextStore = config.finalContextStore || require('../modules/finalContextStore.js');
    } catch (_) {
      this.finalContextStore = { setLastFinalContext: () => {} };
    }

    // 工具调用解析与执行器
    try {
      this.ToolCallParser = config.ToolCallParser || require('../modules/vcpLoop/toolCallParser.js');
    } catch (_) {
      this.ToolCallParser = { parse: () => [] };
    }
    if (config.toolExecutor) {
      this.toolExecutor = config.toolExecutor;
    } else {
      try {
        const ToolExecutorClass = require('../modules/vcpLoop/toolExecutor.js');
        this.toolExecutor = new ToolExecutorClass({
          pluginManager: this.pluginManager,
          webSocketServer: config.webSocketServer || null,
          debugMode: Boolean(config.DEBUG_MODE),
          vcpToolCode: config.VCPToolCode,
          getRealAuthCode: getRealAuthCode
        });
      } catch (_) {
        this.toolExecutor = {
          execute: async () => ({ status: 'error', message: 'ToolExecutor not initialized' })
        };
      }
    }

    // 活跃请求映射表 (用于支持中途中止/打断)
    this.activeRequests = config.activeRequests || new Map();

    // 运行参数
    this.DEBUG_MODE = Boolean(config.DEBUG_MODE ?? (process.env.DEBUG_MODE === 'true'));
    this.SHOW_VCP_OUTPUT = Boolean(config.SHOW_VCP_OUTPUT ?? (process.env.SHOW_VCP_OUTPUT === 'true'));
    this.maxVCPLoopStream = parseInt(config.maxVCPLoopStream || process.env.MaxVCPLoopStream, 10) || 5;
    this.maxVCPLoopNonStream = parseInt(config.maxVCPLoopNonStream || process.env.MaxVCPLoopNonStream, 10) || 5;
    this.apiRetries = parseInt(config.apiRetries || process.env.ApiRetries, 10) || 3;
    this.apiRetryDelay = parseInt(config.apiRetryDelay || process.env.ApiRetryDelay, 10) || 1000;
    this.apiConnectionTimeoutMs = parseInt(config.apiConnectionTimeoutMs || process.env.ApiConnectionTimeoutMs, 10) || 900000;

    // 国产思维链模型控制
    this.chinaModel1 = config.chinaModel1 || [];
    this.chinaModel1Cot = Boolean(config.chinaModel1Cot);

    // 角色分割开关
    this.enableRoleDivider = Boolean(config.enableRoleDivider);
    this.enableRoleDividerInLoop = Boolean(config.enableRoleDividerInLoop);
    this.roleDividerIgnoreList = config.roleDividerIgnoreList || [];
    this.roleDividerSwitches = config.roleDividerSwitches || { system: true, assistant: true, user: true };
    this.roleDividerScanSwitches = config.roleDividerScanSwitches || { system: true, assistant: true, user: true };
    this.roleDividerRemoveDisabledTags = Boolean(config.roleDividerRemoveDisabledTags);

    // 日记刷新
    this.RAGMemoRefresh = Boolean(config.RAGMemoRefresh);

    // 可选自定义 fetch 实现 (用于离线单元测试)
    this.fetchImpl = config.fetchImpl || null;

    // 日志回调
    this.writeDebugLog = config.writeDebugLog || (async () => {});
    this.writeChatLog = config.writeChatLog || (() => {});

    // 后台生命周期状态
    this.lifecycleState = DaemonLifecycleState.RUNNING;
  }

  // =========================================================================
  // 1. 生命周期与状态管理
  // =========================================================================

  /**
   * 获取当前生命周期状态
   * @returns {string}
   */
  getState() {
    return this.lifecycleState;
  }

  /**
   * 切换生命周期状态并派发事件
   * @param {string} newState - DaemonLifecycleState
   * @param {string} [reason]
   */
  setState(newState, reason = '') {
    const previous = this.lifecycleState;
    if (previous === newState) return;
    this.lifecycleState = newState;
    this.emit('lifecycle:change', { previous, current: newState, reason });
  }

  /**
   * 优雅关机收尾 (提交事务、flush 索引、释放锁)
   * @param {string} [reason=ShutdownReason.USER_QUIT]
   * @param {number} [drainTimeoutMs=2000]
   * @returns {Promise<void>}
   */
  async shutdown(reason = ShutdownReason.USER_QUIT, drainTimeoutMs = 2000) {
    if (this.lifecycleState === DaemonLifecycleState.SHUTDOWN || this.lifecycleState === DaemonLifecycleState.DRAINING) {
      return;
    }

    this.setState(DaemonLifecycleState.DRAINING, reason);
    this.emit('shutdown:starting', { reason });

    // 中止所有活跃请求
    if (this.activeRequests.size > 0) {
      for (const [id, reqContext] of this.activeRequests.entries()) {
        try {
          if (reqContext.abortController && !reqContext.abortController.signal.aborted) {
            reqContext.abortController.abort();
          }
        } catch (_) {}
      }
    }

    // 优雅排空等待
    const startDrain = Date.now();
    while (this.activeRequests.size > 0 && Date.now() - startDrain < drainTimeoutMs) {
      await new Promise(r => setTimeout(r, 100));
    }

    this.activeRequests.clear();
    this.setState(DaemonLifecycleState.SHUTDOWN, reason);
    this.emit('shutdown:done', { reason });
  }

  // =========================================================================
  // 2. 主动唤醒协议 (Proactive Wakeup Protocol)
  // =========================================================================

  /**
   * 核心主动唤醒派发接口
   * 触发生命体对前端界面的主动插话、强弹或横幅通知
   * @param {object} eventOptions
   * @returns {object} ProactiveWakeEvent
   */
  emitProactiveWake(eventOptions) {
    const wakeEvent = createWakeEvent(eventOptions);
    this.emit('proactive:wake', wakeEvent);
    if (this.DEBUG_MODE) {
      console.log(`[VcpCoreEngine] Proactive wake emitted: level=${wakeEvent.level}, title=${wakeEvent.title}`);
    }
    return wakeEvent;
  }

  /**
   * 智能体自主唤醒前端的便捷方法
   * @param {object} options
   * @param {string} [options.level='urgent_popup'] - 'toast' | 'tray_pulse' | 'overlay_bubble' | 'urgent_popup'
   * @param {string} options.title - 通知标题
   * @param {string} options.content - 唤醒内容 / 问候语
   * @param {boolean} [options.audioTts=false] - 是否播放语音
   * @param {Array} [options.actions=[]] - 快捷操作按钮
   */
  wakeFrontend({ level = WakeLevel.URGENT_POPUP, title, content, audioTts = false, autoDismissMs = 0, actions = [] }) {
    return this.emitProactiveWake({
      level,
      title: title || '来自 VCP 生命体的主动唤醒',
      content: content || '',
      audioTts,
      autoDismissMs,
      actions,
      source: 'autonomous_entity'
    });
  }

  // =========================================================================
  // 3. 请求中断控制 (Interruption)
  // =========================================================================

  /**
   * 中断指定 ID 的请求
   * @param {string} requestId
   * @param {string} [reason='user_interrupted']
   * @returns {boolean} 是否成功找到并中断
   */
  interrupt(requestId, reason = 'user_interrupted') {
    if (!requestId) return false;
    const reqContext = this.activeRequests.get(requestId);
    if (!reqContext) return false;

    if (!reqContext.aborted) {
      reqContext.aborted = true;
      reqContext.abortReason = reason;
      if (reqContext.abortController && !reqContext.abortController.signal.aborted) {
        reqContext.abortController.abort();
      }
      this.emit('chat:interrupted', { id: requestId, reason });
      return true;
    }
    return false;
  }

  // =========================================================================
  // 4. 上下文准备管道 (Pure Context Preparation Pipeline)
  // =========================================================================

  /**
   * 纯业务上下文预处理管线
   * 从原始请求构造符合上游模型要求的请求体，不涉及任何 HTTP req/res。
   * @param {object} rawRequest - 输入请求
   * @param {object} [options={}]
   * @returns {Promise<object>} 处理完成的上游请求上下文
   */
  async prepareContext(rawRequest, options = {}) {
    let originalBody = JSON.parse(JSON.stringify(rawRequest));
    const clientIp = options.clientIp || rawRequest.clientIp || '127.0.0.1';
    const forceShowVCP = Boolean(options.forceShowVCP || rawRequest.forceShowVCP || this.SHOW_VCP_OUTPUT);

    // 1. 拦截并剔除 vcpchatExtensions
    const vcpchatExtensions = originalBody?.vcpchatExtensions;
    if (vcpchatExtensions !== undefined) {
      delete originalBody.vcpchatExtensions;
    }
    const requestPreprocessorConfig = vcpchatExtensions ? { vcpchatExtensions } : {};
    requestPreprocessorConfig.tavernInteraction = {};

    // 2. 拦截并执行 contextTokenLimit 修剪
    const contextTokenLimit = originalBody.contextTokenLimit;
    if (contextTokenLimit !== undefined) {
      delete originalBody.contextTokenLimit;
      if (originalBody.messages && Array.isArray(originalBody.messages)) {
        originalBody.messages = await this.contextManager.pruneMessagesSmart(
          originalBody.messages,
          contextTokenLimit,
          this.DEBUG_MODE
        );
      }
    }

    // 3. 模型重定向与国产模型思维链控制
    const applyChinaModelThinkingControl = (body) => {
      if (!body || !body.model || !this.chinaModel1 || !Array.isArray(this.chinaModel1) || this.chinaModel1.length === 0) {
        return body;
      }
      const modelLower = String(body.model).toLowerCase();
      const isChinaModel = this.chinaModel1.some(m => modelLower.includes(String(m).toLowerCase()));
      if (!isChinaModel) return body;
      if (this.chinaModel1Cot) {
        body.thinking = { type: 'enabled' };
      } else {
        delete body.thinking;
      }
      return body;
    };

    if (originalBody.model) {
      const originalModel = originalBody.model;
      const isSemanticRoutingModel = this.semanticModelRouter &&
        typeof this.semanticModelRouter.isRoutingModel === 'function' &&
        this.semanticModelRouter.isRoutingModel(originalModel);

      if (!isSemanticRoutingModel) {
        const redirectedModel = this.modelRedirectHandler.redirectModelForBackend(originalModel);
        if (redirectedModel !== originalModel) {
          originalBody.model = redirectedModel;
        }
        applyChinaModelThinkingControl(originalBody);
      }
    }

    await this.writeDebugLog('LogInput', originalBody);

    // 4. 检测禁止工具占位符
    const vcpToolUseForbidden = consumeVcpToolUseForbiddenPlaceholder(originalBody.messages);

    // 5. 多模态占位符扫描
    let shouldProcessMedia = false;
    let shouldProcessMediaPlus = false;
    if (Array.isArray(originalBody.messages)) {
      for (const msg of originalBody.messages) {
        let found = false;
        let foundPlus = false;
        if (msg.role === 'user' || msg.role === 'system') {
          if (typeof msg.content === 'string') {
            if (msg.content.includes('{{TransBase64+}}')) {
              foundPlus = true;
              msg.content = msg.content.replace(/\{\{TransBase64\+\}\}/g, '');
            } else if (msg.content.includes('{{TransBase64}}')) {
              found = true;
              msg.content = msg.content.replace(/\{\{TransBase64\}\}/g, '');
            }
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part?.type === 'text' && typeof part.text === 'string') {
                if (part.text.includes('{{TransBase64+}}')) {
                  foundPlus = true;
                  part.text = part.text.replace(/\{\{TransBase64\+\}\}/g, '');
                } else if (part.text.includes('{{TransBase64}}')) {
                  found = true;
                  part.text = part.text.replace(/\{\{TransBase64\}\}/g, '');
                }
              }
            }
          }
        }
        if (found || foundPlus) {
          shouldProcessMedia = true;
          if (foundPlus) shouldProcessMediaPlus = true;
        }
      }
    }

    // 6. VCPTavern 优先级预处理
    let tavernProcessedMessages = originalBody.messages;
    if (this.pluginManager.messagePreprocessors?.has?.('VCPTavern')) {
      try {
        tavernProcessedMessages = await this.pluginManager.executeMessagePreprocessor(
          'VCPTavern',
          originalBody.messages,
          requestPreprocessorConfig
        );
      } catch (pluginError) {
        if (this.DEBUG_MODE) console.error('[VcpCoreEngine] Error in preprocessor VCPTavern:', pluginError);
      }
    }

    // 7. 语义模型路由
    let semanticModelFallbackCandidates = null;
    if (this.semanticModelRouter &&
        typeof this.semanticModelRouter.isRoutingModel === 'function' &&
        this.semanticModelRouter.isRoutingModel(originalBody.model)) {
      const semanticRoutePlan = await this.semanticModelRouter.resolveRoute({
        requestedModel: originalBody.model,
        messages: tavernProcessedMessages,
        pluginManager: this.pluginManager
      });

      if (semanticRoutePlan && semanticRoutePlan.active) {
        const rawCandidates = Array.isArray(semanticRoutePlan.candidates) && semanticRoutePlan.candidates.length > 0
          ? semanticRoutePlan.candidates
          : [semanticRoutePlan.selectedModel];

        semanticModelFallbackCandidates = rawCandidates
          .map(model => this.modelRedirectHandler.redirectModelForBackend(model))
          .filter(Boolean)
          .filter((model, idx, arr) => arr.indexOf(model) === idx);

        const selectedBackendModel = semanticModelFallbackCandidates[0] ||
          this.modelRedirectHandler.redirectModelForBackend(semanticRoutePlan.selectedModel);

        originalBody.model = selectedBackendModel;
        applyChinaModelThinkingControl(originalBody);
      }
    }

    // 8. 纯文本模型强制翻译多模态判定
    let multiModalForceTranslateModels = this.config.multiModalForceTranslateModels || [];
    if (this.multiModalConfigStore) {
      try {
        const liveTags = this.multiModalConfigStore.getForceTranslateModels();
        if (Array.isArray(liveTags)) multiModalForceTranslateModels = liveTags;
      } catch (_) {}
    }

    const isTextOnlyForceTranslateModel = Array.isArray(multiModalForceTranslateModels) &&
      multiModalForceTranslateModels.length > 0 &&
      isTextOnlyModelByTag(originalBody.model, multiModalForceTranslateModels);

    if (isTextOnlyForceTranslateModel && messagesContainBase64Media(tavernProcessedMessages)) {
      shouldProcessMedia = true;
      shouldProcessMediaPlus = false;
    }

    // 9. 统一变量替换上下文
    const processingContext = {
      pluginManager: this.pluginManager,
      webSocketServer: this.config.webSocketServer || null,
      cachedEmojiLists: this.config.cachedEmojiLists || new Map(),
      detectors: this.config.detectors || [],
      superDetectors: this.config.superDetectors || [],
      DEBUG_MODE: this.DEBUG_MODE,
      messages: tavernProcessedMessages,
      deferStaticPluginPlaceholders: true,
      expandedAgentName: null,
      expandedToolboxes: new Set(),
      expandedVcpTools: new Set(),
      expandedStaticPlaceholders: new Set(),
      expandedGlobalPlaceholders: new Set()
    };

    // 顺序处理消息中的 Agent 变量
    let processedMessages = [];
    for (const msg of tavernProcessedMessages) {
      const newMessage = JSON.parse(JSON.stringify(msg));
      if (newMessage.content && typeof newMessage.content === 'string') {
        newMessage.content = await this.messageProcessor.replaceAgentVariables(
          newMessage.content,
          originalBody.model,
          msg.role,
          processingContext
        );
      } else if (Array.isArray(newMessage.content)) {
        const newParts = [];
        for (const part of newMessage.content) {
          if (part?.type === 'text' && typeof part.text === 'string') {
            const newPart = JSON.parse(JSON.stringify(part));
            newPart.text = await this.messageProcessor.replaceAgentVariables(
              newPart.text,
              originalBody.model,
              msg.role,
              processingContext
            );
            newParts.push(newPart);
          } else {
            newParts.push(part);
          }
        }
        newMessage.content = newParts;
      }
      processedMessages.push(newMessage);
    }

    // 10. 媒体备份 (用于 TransBase64+)
    if (shouldProcessMedia && shouldProcessMediaPlus) {
      for (const msg of processedMessages) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          const mediaParts = msg.content.filter(
            part => part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string' &&
            /^data:(image|audio|video)\/[^;]+;base64,/.test(part.image_url.url)
          );
          if (mediaParts.length > 0) {
            msg.__vcp_media_backup__ = JSON.parse(JSON.stringify(mediaParts));
          }
        }
      }
    }

    // 11. 消息预处理器管线
    const STATIC_PLACEHOLDER_INJECTION_STAGE = '$StaticPlaceholderInjection';
    const selectedMediaProcessor = this.pluginManager.messagePreprocessors?.has?.('MultiModalProcessor')
      ? 'MultiModalProcessor'
      : 'ImageProcessor';
    const orderedPipeline = Array.isArray(this.pluginManager.preprocessorOrder)
      ? this.pluginManager.preprocessorOrder
      : Array.from(this.pluginManager.messagePreprocessors?.keys?.() || []);

    for (const name of orderedPipeline) {
      if (name === 'VCPTavern') continue;

      if (name === STATIC_PLACEHOLDER_INJECTION_STAGE) {
        processedMessages = await this.messageProcessor.injectStaticPluginPlaceholdersInMessages(
          processedMessages,
          { ...processingContext, messages: processedMessages }
        );
        continue;
      }

      if (name === 'ImageProcessor' || name === 'MultiModalProcessor') {
        if (!shouldProcessMedia || name !== selectedMediaProcessor) continue;
      }

      if (!this.pluginManager.messagePreprocessors?.has?.(name)) continue;

      try {
        processedMessages = await this.pluginManager.executeMessagePreprocessor(
          name,
          processedMessages,
          requestPreprocessorConfig
        );
      } catch (pluginError) {
        if (this.DEBUG_MODE) console.error(`[VcpCoreEngine] Error in preprocessor ${name}:`, pluginError);
      }
    }

    // 12. TransBase64+ 清理与还原
    if (shouldProcessMediaPlus) {
      for (const msg of processedMessages) {
        if (msg.role === 'user') {
          if (typeof msg.content === 'string') {
            msg.content = msg.content.replace(/<VCP_MULTIMODAL_INFO>[\s\S]*?<\/VCP_MULTIMODAL_INFO>/g, '');
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part?.type === 'text' && typeof part.text === 'string') {
                part.text = part.text.replace(/<VCP_MULTIMODAL_INFO>[\s\S]*?<\/VCP_MULTIMODAL_INFO>/g, '');
              }
            }
          }

          if (msg.__vcp_media_backup__) {
            if (typeof msg.content === 'string') {
              msg.content = [{ type: 'text', text: msg.content }, ...msg.__vcp_media_backup__];
            } else if (Array.isArray(msg.content)) {
              msg.content = [...msg.content, ...msg.__vcp_media_backup__];
            }
            delete msg.__vcp_media_backup__;
          }
        }
      }
    }

    // 13. Detectors 与 SuperDetectors
    const messagesBeforeDetectors = processedMessages;
    processedMessages = copyArrayMetadata(
      messagesBeforeDetectors,
      this.messageProcessor.applyDetectorsToMessages(processedMessages, processingContext)
    );

    // 14. 角色分割处理 (Role Divider)
    if (this.enableRoleDivider) {
      processedMessages = this.roleDivider.process(processedMessages, {
        ignoreList: this.roleDividerIgnoreList,
        switches: this.roleDividerSwitches,
        scanSwitches: this.roleDividerScanSwitches,
        removeDisabledTags: this.roleDividerRemoveDisabledTags,
        skipCount: 1
      });
    }

    originalBody.messages = processedMessages;

    // 15. 提取 OneRing 元数据
    let oneRingResponseMeta = null;
    try {
      const oneRingModule = this.pluginManager?.messagePreprocessors?.get?.('OneRing');
      if (oneRingModule && typeof oneRingModule.extractMetaFromMessages === 'function') {
        oneRingResponseMeta = oneRingModule.extractMetaFromMessages(processedMessages);
      }
    } catch (_) {}

    // 16. 净化私有字段并登记最后上下文
    const finalUpstreamBody = stripVcpPrivateFields({
      ...originalBody,
      stream: rawRequest.stream !== false
    });

    this.finalContextStore.setLastFinalContext(finalUpstreamBody, {
      requestId: rawRequest.id || rawRequest.requestId || null,
      messageId: rawRequest.messageId || null,
      clientIp,
      forceShowVCP,
      capturedStage: 'before_upstream_fetch'
    });

    return {
      finalUpstreamBody,
      semanticModelFallbackCandidates,
      vcpToolUseForbidden,
      oneRingResponseMeta,
      clientIp,
      forceShowVCP,
      shouldProcessMedia,
      shouldProcessMediaPlus,
      isTextOnlyForceTranslateModel,
      requestPreprocessorConfig
    };
  }

  // =========================================================================
  // 5. 核心异步流式生成器 (Core Chat Stream Generator)
  // =========================================================================

  /**
   * 核心流式对话入口，返回 AsyncGenerator<ChatChunk>
   * 完全解耦传输协议，支持在 IPC、HTTP SSE、WebSocket 或测试中直接消费。
   * @param {object} chatRequest - 请求载荷
   * @param {object} [options={}] - 控制选项
   * @returns {AsyncGenerator<object>} 结构化流式事件块
   */
  async *chatStream(chatRequest, options = {}) {
    const validatedReq = validateChatRequest(chatRequest);
    const id = validatedReq.id;

    // 设置中止控制器并与外部 signal 级联
    const abortController = new AbortController();
    let externalAbortHandler = null;
    if (validatedReq.signal) {
      if (validatedReq.signal.aborted) {
        yield createChatChunk(ChatChunkType.ABORTED, { reason: 'caller_aborted_early' });
        return;
      }
      externalAbortHandler = () => abortController.abort();
      validatedReq.signal.addEventListener('abort', externalAbortHandler, { once: true });
    }

    const requestContext = {
      id,
      abortController,
      timestamp: Date.now(),
      aborted: false,
      abortReason: null
    };
    this.activeRequests.set(id, requestContext);
    this.emit('chat:start', { id, model: validatedReq.model });

    try {
      // 执行完整的上下文预处理管道
      const contextPlan = await this.prepareContext(validatedReq, options);
      const {
        finalUpstreamBody,
        semanticModelFallbackCandidates,
        vcpToolUseForbidden,
        clientIp,
        forceShowVCP,
        isTextOnlyForceTranslateModel,
        shouldProcessMediaPlus
      } = contextPlan;

      let currentMessagesForLoop = Array.isArray(finalUpstreamBody.messages)
        ? JSON.parse(JSON.stringify(finalUpstreamBody.messages))
        : [];
      let recursionDepth = 0;
      const maxRecursion = this.maxVCPLoopStream || 5;
      let totalAccumulatedContent = '';
      let totalAccumulatedReasoning = '';

      const endpointUrl = `${this.apiUrl}/${this.apiVersion}/chat/completions`;

      // 递归工具调用主循环
      while (recursionDepth < maxRecursion) {
        if (abortController.signal.aborted) {
          yield createChatChunk(ChatChunkType.ABORTED, { reason: requestContext.abortReason || 'aborted' });
          return;
        }

        const currentTurnBody = stripVcpPrivateFields({
          ...finalUpstreamBody,
          messages: currentMessagesForLoop,
          stream: true
        });

        // 发送上游请求
        let upstreamResponse;
        try {
          upstreamResponse = await fetchWithRetry(
            endpointUrl,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
                Accept: 'text/event-stream'
              },
              body: JSON.stringify(currentTurnBody),
              signal: abortController.signal
            },
            {
              retries: this.apiRetries,
              delay: this.apiRetryDelay,
              debugMode: this.DEBUG_MODE,
              connectionTimeout: this.apiConnectionTimeoutMs,
              modelFallbackCandidates: semanticModelFallbackCandidates,
              fetchImpl: this.fetchImpl
            }
          );
        } catch (fetchError) {
          if (fetchError.name === 'AbortError') {
            yield createChatChunk(ChatChunkType.ABORTED, { reason: 'fetch_aborted' });
            return;
          }
          yield createChatChunk(ChatChunkType.ERROR, {
            error: `Upstream connection failed: ${fetchError.message}`
          });
          return;
        }

        // 上游非 200 状态码
        if (upstreamResponse.status !== 200) {
          const errText = await upstreamResponse.text().catch(() => '');
          yield createChatChunk(ChatChunkType.ERROR, {
            status: upstreamResponse.status,
            error: `[UPSTREAM_ERROR] Status ${upstreamResponse.status}: ${errText}`
          });
          return;
        }

        // 解析并产出当前 turn 的流式响应
        let turnContent = '';
        let turnReasoning = '';
        let streamTerminated = false;
        let lastFinishReason = null;
        const bodyStream = upstreamResponse.body;

        for await (const sseItem of parseSseStream(bodyStream, abortController.signal)) {
          if (abortController.signal.aborted) break;

          if (sseItem.isDone) {
            streamTerminated = true;
            break;
          }

          const parsed = sseItem.data;
          if (!parsed) continue;

          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) {
            lastFinishReason = choice.finish_reason;
            streamTerminated = true;
          }

          const delta = choice?.delta;
          if (!delta) continue;

          // 1. 推理内容增量
          const reasoning = extractReasoningText(delta);
          if (reasoning) {
            turnReasoning += reasoning;
            totalAccumulatedReasoning += reasoning;
            yield createChatChunk(ChatChunkType.REASONING, {
              reasoning,
              raw: parsed
            });
          }

          // 2. 正文内容增量
          const content = delta.content || '';
          if (content) {
            turnContent += content;
            totalAccumulatedContent += content;
            yield createChatChunk(ChatChunkType.DELTA, {
              text: content,
              raw: parsed
            });
          }
        }

        if (abortController.signal.aborted) {
          yield createChatChunk(ChatChunkType.ABORTED, { reason: requestContext.abortReason || 'aborted' });
          return;
        }

        // 终态校验：若流非主动中止且未收到合法终止标记（[DONE] 或 finish_reason），作为非预期截断报错
        if (!streamTerminated) {
          yield createChatChunk(ChatChunkType.ERROR, {
            error: 'Upstream stream closed prematurely without completion marker'
          });
          return;
        }

        // 检查当前 turn 输出中是否包含 VCP 工具调用
        const toolCalls = vcpToolUseForbidden ? [] : this.ToolCallParser.parse(turnContent);

        if (!toolCalls || toolCalls.length === 0) {
          // 没有工具调用，正常结束
          yield createChatChunk(ChatChunkType.DONE, {
            finish_reason: lastFinishReason || 'stop',
            content: totalAccumulatedContent,
            reasoning: totalAccumulatedReasoning
          });
          this.emit('chat:done', {
            id,
            content: totalAccumulatedContent,
            reasoning: totalAccumulatedReasoning
          });
          return;
        }

        // 命中工具调用：派发工具调用事件并就地执行
        yield createChatChunk(ChatChunkType.TOOL_CALL, { toolCalls });

        let assistantTurnMessages = [{ role: 'assistant', content: turnContent }];
        if (this.enableRoleDivider && this.enableRoleDividerInLoop) {
          assistantTurnMessages = this.roleDivider.process(assistantTurnMessages, {
            ignoreList: this.roleDividerIgnoreList,
            switches: this.roleDividerSwitches,
            scanSwitches: this.roleDividerScanSwitches,
            removeDisabledTags: this.roleDividerRemoveDisabledTags,
            skipCount: 0
          });
        }
        currentMessagesForLoop.push(...assistantTurnMessages);

        // 顺序执行工具调用
        for (const toolCall of toolCalls) {
          if (abortController.signal.aborted) break;

          let toolResult;
          try {
            toolResult = await this.toolExecutor.execute(toolCall, clientIp, currentMessagesForLoop);
          } catch (execErr) {
            toolResult = {
              status: 'error',
              error: `Tool execution error (${toolCall.name}): ${execErr.message}`
            };
          }

          yield createChatChunk(ChatChunkType.TOOL_RESULT, {
            toolCall,
            result: toolResult
          });

          const formattedResult = formatToolResult(toolResult);
          currentMessagesForLoop.push({
            role: 'user',
            content: formattedResult
          });
        }

        // 如果配置了 RAG 刷新，按新上下文刷新对话历史中的日记区块
        if (this.RAGMemoRefresh) {
          currentMessagesForLoop = await _refreshRagBlocksIfNeeded(
            currentMessagesForLoop,
            turnContent,
            this.pluginManager,
            this.DEBUG_MODE
          );
        }

        recursionDepth++;
        yield createChatChunk(ChatChunkType.LOOP_CONTINUE, { depth: recursionDepth });
      }

      // 递归达到上限
      yield createChatChunk(ChatChunkType.DONE, {
        finish_reason: 'length',
        content: totalAccumulatedContent,
        reasoning: totalAccumulatedReasoning
      });
      this.emit('chat:done', { id, content: totalAccumulatedContent });

    } catch (err) {
      if (err.name === 'AbortError') {
        yield createChatChunk(ChatChunkType.ABORTED, { reason: requestContext.abortReason || 'aborted' });
      } else {
        yield createChatChunk(ChatChunkType.ERROR, { error: err.message || 'Unknown engine error' });
      }
    } finally {
      if (validatedReq.signal && externalAbortHandler) {
        try {
          validatedReq.signal.removeEventListener('abort', externalAbortHandler);
        } catch (_) {}
      }
      this.activeRequests.delete(id);
      this.emit('chat:end', { id });
    }
  }

  // =========================================================================
  // 6. 便捷包装器与 Sink 适配
  // =========================================================================

  /**
   * 非流式对话便捷包装器
   * @param {object} chatRequest
   * @param {object} [options={}]
   * @returns {Promise<object>} OpenAI 兼容的结果对象
   */
  async chat(chatRequest, options = {}) {
    let accumulatedContent = '';
    let accumulatedReasoning = '';
    let finishReason = 'stop';
    const toolCalls = [];

    for await (const chunk of this.chatStream(chatRequest, options)) {
      if (chunk.type === ChatChunkType.DELTA && chunk.text) {
        accumulatedContent += chunk.text;
      } else if (chunk.type === ChatChunkType.REASONING && chunk.reasoning) {
        accumulatedReasoning += chunk.reasoning;
      } else if (chunk.type === ChatChunkType.TOOL_CALL && Array.isArray(chunk.toolCalls)) {
        toolCalls.push(...chunk.toolCalls);
      } else if (chunk.type === ChatChunkType.DONE) {
        finishReason = chunk.finish_reason || 'stop';
      } else if (chunk.type === ChatChunkType.ERROR) {
        throw new Error(chunk.error || 'Chat request failed');
      }
    }

    return {
      id: chatRequest.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: chatRequest.model || 'unknown',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: accumulatedContent,
            reasoning_content: accumulatedReasoning || undefined,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined
          },
          finish_reason: finishReason
        }
      ]
    };
  }

  /**
   * 将 chatStream 管道输出到指定的 StreamEventSink (例如 HTTP SSE 适配器或 IPC 适配器)
   * @param {object} chatRequest
   * @param {StreamEventSink} sink
   * @param {object} [options={}]
   * @returns {Promise<void>}
   */
  async pipeChatStream(chatRequest, sink, options = {}) {
    try {
      for await (const chunk of this.chatStream(chatRequest, options)) {
        if (sink.isClosed && sink.isClosed()) break;
        sink.writeChunk(chunk);
      }
      sink.end();
    } catch (err) {
      sink.error(err);
    }
  }
}

module.exports = VcpCoreEngine;
