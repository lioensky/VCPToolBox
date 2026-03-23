// modules/channelHub/RuntimeGateway.js
/**
 * 运行时网关 - 负责将 ChannelHub 事件桥接到 VCP 运行时
 * 
 * 职责:
 * - 把通道请求转换为运行时可消费的标准格式
 * - 调用现有 chatCompletionHandler 或未来的内部 API
 * - 返回结构化的 ChannelRuntimeReply
 * 
 * 背景:
 * 当前旧桥接直接伪造 req.body 并覆盖 res.write/res.json/res.end
 * 本模块的目标是消除这种对 HTTP 控制流的强耦合
 * 
 * 演进阶段:
 * - 阶段A: 封装现有 chatCompletionHandler，但隔离 req/res 改写逻辑
 * - 阶段B: 抽出内部 handleChannelRequest() 风格的无 HTTP 入口
 * - 阶段C: 将通道 runtime 与 OpenAI 兼容 HTTP runtime 完全解耦
 */

const { v4: uuidv4 } = require('crypto');
const { RuntimeGatewayError } = require('./errors');
const { createRequestId, nowTimestamp } = require('./utils');
const { CHANNEL_EVENT_VERSION } = require('./constants');

/**
 * @typedef {Object} ChannelRuntimeRequest
 * @property {string} agentId - 目标 Agent ID
 * @property {Array} messages - 标准化的消息数组
 * @property {string} externalSessionKey - 外部会话标识
 * @property {Object} topic - 话题绑定信息
 * @property {Object} clientContext - 客户端上下文
 * @property {Object} runtimeOverrides - 运行时覆盖配置
 */

/**
 * @typedef {Object} ChannelRuntimeReply
 * @property {string} replyId - 回复 ID
 * @property {Array} messages - 回复消息列表
 * @property {Array} toolEvents - 工具调用事件
 * @property {Object} topic - 话题信息
 * @property {Object} usage - Token 使用统计
 * @property {Object} meta - 元数据
 */

class RuntimeGateway {
  /**
   * @param {Object} options
   * @param {Object} options.chatCompletionHandler - 现有的 ChatCompletionHandler 实例
   * @param {Object} options.pluginManager - 插件管理器
   * @param {Object} options.config - 全局配置
   * @param {boolean} [options.debugMode] - 调试模式
   */
  constructor(options = {}) {
    this.chatCompletionHandler = options.chatCompletionHandler;
    this.pluginManager = options.pluginManager;
    this.config = options.config || {};
    this.debugMode = options.debugMode || false;
    
    // 阶段标记: 当前处于哪个演进阶段
    this.evolutionPhase = 'A'; // 'A' | 'B' | 'C'
  }

  /**
   * 调用运行时处理事件
   * @param {Object} envelope - 标准化的事件信封
   * @param {Object} routeDecision - 路由决策
   * @returns {Promise<ChannelRuntimeReply>}
   */
  async invoke(envelope, routeDecision) {
    const startTime = Date.now();
    const replyId = `reply_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    
    if (this.debugMode) {
      console.log('[RuntimeGateway] 开始调用运行时:', {
        requestId: envelope.requestId,
        agentId: routeDecision.agentId,
        evolutionPhase: this.evolutionPhase
      });
    }

    try {
      // 构建运行时请求
      const runtimeRequest = this.buildRuntimeRequest(envelope, routeDecision);
      
      // 根据演进阶段选择调用方式
      let rawOutput;
      switch (this.evolutionPhase) {
        case 'A':
          rawOutput = await this._invokePhaseA(runtimeRequest, envelope);
          break;
        case 'B':
          rawOutput = await this._invokePhaseB(runtimeRequest, envelope);
          break;
        case 'C':
          rawOutput = await this._invokePhaseC(runtimeRequest, envelope);
          break;
        default:
          throw new RuntimeGatewayError(`未知的演进阶段: ${this.evolutionPhase}`, { phase: this.evolutionPhase });
      }

      // 归一化输出
      const reply = this._normalizeReply(rawOutput, {
        replyId,
        requestId: envelope.requestId,
        agentId: routeDecision.agentId,
        startTime
      });

      if (this.debugMode) {
        console.log('[RuntimeGateway] 运行时调用完成:', {
          replyId,
          duration: Date.now() - startTime,
          messageCount: reply.messages?.length || 0
        });
      }

      return reply;
    } catch (error) {
      console.error('[RuntimeGateway] 运行时调用失败:', error);
      
      // 返回错误回复而非抛出异常，确保上层可以正常响应
      return {
        replyId,
        messages: [{
          role: 'assistant',
          content: [{ type: 'text', text: `[运行时错误] ${error.message}` }]
        }],
        toolEvents: [],
        topic: null,
        usage: null,
        meta: {
          agentId: routeDecision.agentId,
          error: true,
          errorMessage: error.message,
          duration: Date.now() - startTime
        }
      };
    }
  }

  /**
   * 构建运行时请求
   * @param {Object} envelope - 事件信封
   * @param {Object} routeDecision - 路由决策
   * @returns {ChannelRuntimeRequest}
   */
  buildRuntimeRequest(envelope, routeDecision) {
    return {
      agentId: routeDecision.agentId,
      messages: envelope.payload?.messages || [],
      externalSessionKey: envelope.session?.externalSessionKey || null,
      topic: {
        bindingKey: envelope.session?.bindingKey || null,
        currentTopicId: envelope.session?.currentTopicId || null,
        resolvedTopicId: routeDecision.resolvedTopicId || null
      },
      clientContext: {
        platform: envelope.channel,
        conversationId: envelope.client?.conversationId,
        userId: envelope.sender?.userId,
        conversationType: envelope.client?.conversationType
      },
      runtimeOverrides: {
        apiKey: envelope.runtime?.overrides?.apiKey || '',
        apiBase: envelope.runtime?.overrides?.apiBase || '',
        model: routeDecision.model || envelope.runtime?.model,
        timeoutMs: envelope.runtime?.overrides?.timeoutMs || 90000,
        stream: envelope.runtime?.stream || false
      }
    };
  }

  /**
   * 阶段A: 通过模拟 HTTP 请求调用现有 chatCompletionHandler
   * @param {ChannelRuntimeRequest} runtimeRequest
   * @param {Object} envelope
   * @returns {Promise<Object>}
   * @private
   */
  async _invokePhaseA(runtimeRequest, envelope) {
    // TODO: 实现阶段A逻辑
    // 1. 构造模拟的 req/res 对象
    // 2. 调用 chatCompletionHandler.handle()
    // 3. 从捕获的输出中提取结构化回复
    
    if (!this.chatCompletionHandler) {
      throw new RuntimeGatewayError('chatCompletionHandler 未初始化');
    }

    // 创建一个用于捕获输出的响应对象
    const capturedOutput = {
      content: '',
      chunks: [],
      ended: false
    };

    // 构造模拟请求
    const mockReq = {
      body: {
        model: runtimeRequest.runtimeOverrides.model || 'default',
        messages: runtimeRequest.messages,
        stream: runtimeRequest.runtimeOverrides.stream,
        requestId: envelope.requestId,
        // 添加 channel-hub 特定字段
        _channelHubContext: {
          agentId: runtimeRequest.agentId,
          externalSessionKey: runtimeRequest.externalSessionKey,
          topic: runtimeRequest.topic,
          clientContext: runtimeRequest.clientContext
        }
      },
      headers: {},
      ip: '127.0.0.1'
    };

    // 构造模拟响应对象
    const mockRes = {
      headersSent: false,
      writableEnded: false,
      status: (code) => {
        mockRes._statusCode = code;
        return mockRes;
      },
      setHeader: () => mockRes,
      getHeader: () => null,
      write: (data) => {
        capturedOutput.chunks.push(data);
        capturedOutput.content += data;
      },
      json: (data) => {
        capturedOutput.jsonData = data;
        capturedOutput.ended = true;
      },
      end: () => {
        capturedOutput.ended = true;
      }
    };

    // 调用现有 handler
    await this.chatCompletionHandler.handle(mockReq, mockRes);

    // 解析输出
    return this._parseCapturedOutput(capturedOutput, runtimeRequest.runtimeOverrides.stream);
  }

  /**
   * 阶段B: 直接调用内部 API (无 HTTP)
   * @param {ChannelRuntimeRequest} runtimeRequest
   * @param {Object} envelope
   * @returns {Promise<Object>}
   * @private
   */
  async _invokePhaseB(runtimeRequest, envelope) {
    // TODO: 阶段B 实现
    // 需要先在 chatCompletionHandler 中抽出 handleChannelRequest() 方法
    throw new RuntimeGatewayError('阶段B尚未实现', { phase: 'B' });
  }

  /**
   * 阶段C: 完全解耦的通道运行时
   * @param {ChannelRuntimeRequest} runtimeRequest
   * @param {Object} envelope
   * @returns {Promise<Object>}
   * @private
   */
  async _invokePhaseC(runtimeRequest, envelope) {
    // TODO: 阶段C 实现
    // 独立的通道运行时，与 OpenAI HTTP runtime 完全分离
    throw new RuntimeGatewayError('阶段C尚未实现', { phase: 'C' });
  }

  /**
   * 解析捕获的输出
   * @param {Object} capturedOutput
   * @param {boolean} isStream
   * @returns {Object}
   * @private
   */
  _parseCapturedOutput(capturedOutput, isStream) {
    if (capturedOutput.jsonData) {
      // 非流式响应
      return {
        type: 'json',
        data: capturedOutput.jsonData
      };
    }

    if (capturedOutput.chunks.length > 0 && isStream) {
      // 流式响应
      return {
        type: 'stream',
        chunks: capturedOutput.chunks,
        rawContent: capturedOutput.content
      };
    }

    return {
      type: 'unknown',
      rawContent: capturedOutput.content
    };
  }

  /**
   * 归一化运行时输出为标准回复格式
   * @param {Object} rawOutput
   * @param {Object} context
   * @returns {ChannelRuntimeReply}
   * @private
   */
  _normalizeReply(rawOutput, context) {
    const { replyId, requestId, agentId, startTime } = context;

    // 基础结构
    const reply = {
      replyId,
      messages: [],
      toolEvents: [],
      topic: null,
      usage: null,
      meta: {
        agentId,
        model: null,
        duration: Date.now() - startTime
      }
    };

    // 根据输出类型解析
    if (rawOutput.type === 'json' && rawOutput.data) {
      const data = rawOutput.data;
      
      // 提取消息
      if (data.choices && data.choices[0]) {
        const choice = data.choices[0];
        const message = choice.message || {};
        
        reply.messages.push({
          role: message.role || 'assistant',
          content: this._parseContent(message.content)
        });
        
        // 提取工具调用
        if (message.tool_calls) {
          reply.toolEvents = message.tool_calls.map(tc => ({
            id: tc.id,
            type: tc.type,
            function: tc.function
          }));
        }
      }
      
      // 提取 usage
      reply.usage = data.usage || null;
      reply.meta.model = data.model;
    } else if (rawOutput.type === 'stream') {
      // 流式输出需要更复杂的解析
      // TODO: 实现 SSE 解析
      reply.messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: rawOutput.rawContent || '(流式输出待解析)' }]
      });
    } else {
      // 未知格式，作为原始文本处理
      reply.messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: rawOutput.rawContent || '(无内容)' }]
      });
    }

    return reply;
  }

  /**
   * 解析消息内容
   * @param {*} content
   * @returns {Array}
   * @private
   */
  _parseContent(content) {
    if (!content) {
      return [];
    }

    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }

    if (Array.isArray(content)) {
      return content;
    }

    return [{ type: 'text', text: String(content) }];
  }

  /**
   * 设置演进阶段
   * @param {'A'|'B'|'C'} phase
   */
  setEvolutionPhase(phase) {
    if (!['A', 'B', 'C'].includes(phase)) {
      throw new Error(`无效的演进阶段: ${phase}`);
    }
    this.evolutionPhase = phase;
    console.log(`[RuntimeGateway] 演进阶段已设置为: ${phase}`);
  }
}

module.exports = RuntimeGateway;