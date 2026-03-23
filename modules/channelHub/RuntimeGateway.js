// modules/channelHub/RuntimeGateway.js
/**
 * 运行时网关 - 负责将 ChannelHub 事件桥接到 VCP 运行时
 * 
 * 职责:
 * - 把通道请求转换为运行时可消费的标准格式
 * - 调用现有 chatCompletionHandler.handle() 并捕获输出
 * - 返回结构化的 ChannelRuntimeReply
 * 
 * 当前实现: Phase A — 通过模拟 Express req/res 调用 chatCompletionHandler
 * 这与 server.js 的 /internal/channel-ingest 端点使用相同的拦截模式，
 * 但封装在独立模块中，消除对路由层的耦合。
 */

const crypto = require('crypto');
const { RuntimeGatewayError } = require('./errors');
const { createRequestId, nowTimestamp } = require('./utils');

class RuntimeGateway {
  /**
   * @param {Object} options
   * @param {Object} options.chatCompletionHandler - ChatCompletionHandler 实例
   * @param {Object} options.pluginManager - 插件管理器（预留）
   * @param {Object} options.config - 配置
   * @param {boolean} [options.debugMode] - 调试模式
   */
  constructor(options = {}) {
    this.chatCompletionHandler = options.chatCompletionHandler;
    this.pluginManager = options.pluginManager;
    this.config = options.config || {};
    this.debugMode = options.debugMode || false;
    
    // 响应捕获的最大大小（防止内存爆炸）
    this.maxCaptureSize = this.config.maxCaptureSize || 512 * 1024; // 512KB
  }

  /**
   * 调用运行时处理事件
   * @param {Object} envelope - 标准化的事件信封
   * @param {Object} routeDecision - 路由决策
   * @returns {Promise<Object>} ChannelRuntimeReply
   */
  async invoke(envelope, routeDecision) {
    const startTime = Date.now();
    const replyId = `reply_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    
    if (this.debugMode) {
      console.log('[RuntimeGateway] 开始调用运行时:', {
        requestId: envelope.requestId || envelope.eventId,
        agentId: routeDecision.agentId,
        messageCount: envelope.payload?.messages?.length || 0
      });
    }

    try {
      if (!this.chatCompletionHandler) {
        throw new RuntimeGatewayError('chatCompletionHandler 未初始化');
      }

      // 1. 构建 chatCompletionHandler 需要的请求体
      const fakeBody = this._buildFakeBody(envelope, routeDecision);
      
      // 2. 构造模拟的 Express req/res 对象
      const { mockReq, mockRes, getCapturedOutput } = this._createMockReqRes(fakeBody);
      
      // 3. 调用 chatCompletionHandler.handle()
      await this.chatCompletionHandler.handle(mockReq, mockRes, false);
      
      // 4. 解析捕获的输出
      const capturedOutput = getCapturedOutput();
      const replyText = this._extractReplyText(capturedOutput);
      
      if (this.debugMode) {
        console.log('[RuntimeGateway] 运行时调用完成:', {
          replyId,
          duration: Date.now() - startTime,
          replyLength: replyText.length,
          capturedBytes: capturedOutput.rawData.length
        });
      }

      // 5. 构建标准化回复
      return {
        replyId,
        messages: [{
          role: 'assistant',
          content: [{ type: 'text', text: replyText }]
        }],
        toolEvents: [],
        topic: {
          resolvedTopicId: routeDecision.topicId || null
        },
        usage: capturedOutput.usage || null,
        meta: {
          agentId: routeDecision.agentId,
          model: capturedOutput.model || routeDecision.model || null,
          duration: Date.now() - startTime,
          statusCode: capturedOutput.statusCode
        }
      };

    } catch (error) {
      console.error('[RuntimeGateway] 运行时调用失败:', error.message);
      
      // 返回错误回复而非抛出异常
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
   * 构建 chatCompletionHandler 需要的请求体
   * 与 server.js /internal/channel-ingest 的 fakeBody 构造逻辑一致
   */
  _buildFakeBody(envelope, routeDecision) {
    const agentId = routeDecision.agentId;
    const model = routeDecision.model 
      || envelope.runtime?.overrides?.model 
      || envelope.runtime?.model 
      || process.env.API_Model 
      || 'gpt-4o';
    
    // 从 envelope 的 messages 中提取用户消息
    const userMessages = (envelope.payload?.messages || []).map(msg => {
      // 确保 content 是字符串（chatCompletionHandler 期望字符串 content）
      if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter(p => p.type === 'text')
          .map(p => p.text);
        return {
          role: msg.role || 'user',
          content: textParts.join('\n') || ''
        };
      }
      return {
        role: msg.role || 'user',
        content: typeof msg.content === 'string' ? msg.content : String(msg.content || '')
      };
    });

    // 构造完整消息列表：系统消息使用 {{agentId}} 占位符
    const syntheticMessages = [
      { role: 'system', content: `{{${agentId}}}` },
      ...userMessages
    ];

    const sessionKey = envelope.session?.externalSessionKey 
      || envelope.session?.bindingKey 
      || null;
    
    const apiKeyOverride = envelope.runtime?.overrides?.apiKey || '';
    const apiBaseOverride = envelope.runtime?.overrides?.apiBase || '';

    return {
      model,
      messages: syntheticMessages,
      stream: false, // ChannelHub 始终使用非流式
      ...(sessionKey ? { externalSessionKey: sessionKey } : {}),
      ...(apiKeyOverride ? { apiKeyOverride } : {}),
      ...(apiBaseOverride ? { apiBaseOverride } : {}),
      // 标记来源，方便 chatCompletionHandler 内部识别
      _channelHubRequest: true,
      requestId: envelope.requestId || envelope.eventId || createRequestId('ch')
    };
  }

  /**
   * 创建模拟的 Express req/res 对象
   * 拦截 chatCompletionHandler 的所有输出
   */
  _createMockReqRes(fakeBody) {
    // 捕获的输出数据
    const captured = {
      statusCode: 200,
      rawData: '',
      jsonData: null,
      headers: {},
      ended: false,
      model: null,
      usage: null
    };

    const maxSize = this.maxCaptureSize;

    // 模拟 Express Request
    const mockReq = {
      body: fakeBody,
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json'
      },
      ip: '127.0.0.1',
      path: '/internal/channelHub/runtime'
    };

    // 模拟 Express Response
    // 需要完整实现 chatCompletionHandler 内部用到的所有方法
    const mockRes = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      
      // 状态码
      _statusCode: 200,
      statusCode: 200,
      
      status(code) {
        mockRes._statusCode = code;
        mockRes.statusCode = code;
        captured.statusCode = code;
        return mockRes;
      },
      
      // Header 操作
      setHeader(name, value) {
        captured.headers[name.toLowerCase()] = value;
        return mockRes;
      },
      getHeader(name) {
        return captured.headers[name.toLowerCase()] || null;
      },
      set(name, value) {
        if (typeof name === 'string') {
          captured.headers[name.toLowerCase()] = value;
        }
        return mockRes;
      },
      header(name, value) {
        if (typeof name === 'string') {
          captured.headers[name.toLowerCase()] = value;
        }
        return mockRes;
      },
      type(contentType) {
        captured.headers['content-type'] = contentType;
        return mockRes;
      },
      
      // 数据写入
      write(chunk) {
        if (captured.ended) return false;
        if (chunk) {
          const str = chunk.toString();
          if (captured.rawData.length + str.length <= maxSize) {
            captured.rawData += str;
          }
        }
        return true;
      },
      
      // JSON 响应
      json(obj) {
        captured.jsonData = obj;
        captured.ended = true;
        mockRes.headersSent = true;
        mockRes.writableEnded = true;
        return mockRes;
      },
      
      // 结束响应
      end(chunk, encoding, callback) {
        if (chunk && typeof chunk === 'string') {
          if (captured.rawData.length + chunk.length <= maxSize) {
            captured.rawData += chunk;
          }
        } else if (chunk && Buffer.isBuffer(chunk)) {
          const str = chunk.toString();
          if (captured.rawData.length + str.length <= maxSize) {
            captured.rawData += str;
          }
        }
        
        // 处理回调
        if (typeof chunk === 'function') {
          callback = chunk;
        } else if (typeof encoding === 'function') {
          callback = encoding;
        }
        
        captured.ended = true;
        mockRes.headersSent = true;
        mockRes.writableEnded = true;
        
        if (typeof callback === 'function') {
          callback();
        }
        
        return mockRes;
      },
      
      // 事件监听（chatCompletionHandler 可能会用 res.on('finish', ...)）
      on(event, handler) {
        // 忽略事件绑定，我们不需要在模拟对象上触发事件
        return mockRes;
      },
      once(event, handler) {
        return mockRes;
      },
      removeListener(event, handler) {
        return mockRes;
      },
      emit(event, ...args) {
        return mockRes;
      }
    };

    // 返回获取捕获数据的闭包
    function getCapturedOutput() {
      return captured;
    }

    return { mockReq, mockRes, getCapturedOutput };
  }

  /**
   * 从捕获的输出中提取 AI 回复文本
   * 兼容 SSE 流式输出和普通 JSON 两种格式
   */
  _extractReplyText(capturedOutput) {
    let replyText = '';

    // 1. 如果有 JSON 数据（非流式响应）
    if (capturedOutput.jsonData) {
      const data = capturedOutput.jsonData;
      
      // 处理错误响应
      if (data.error) {
        return `[上游错误] ${typeof data.error === 'string' ? data.error : JSON.stringify(data.error)}`;
      }
      
      // 提取 choices[0].message.content
      replyText = data.choices?.[0]?.message?.content
        || data.choices?.[0]?.delta?.content
        || '';
      
      // 保存 model 和 usage
      capturedOutput.model = data.model;
      capturedOutput.usage = data.usage;
      
      if (replyText) return replyText;
    }

    // 2. 尝试解析 SSE 流（data: {...} 格式）
    const rawOutput = capturedOutput.rawData.trim();
    
    if (rawOutput.includes('data: ')) {
      const sseParts = [];
      
      for (const line of rawOutput.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        
        const jsonStr = trimmed.slice(6).trim();
        if (jsonStr === '[DONE]') continue;
        
        try {
          const parsed = JSON.parse(jsonStr);
          
          // 提取内容
          const content = parsed.choices?.[0]?.delta?.content
            || parsed.choices?.[0]?.message?.content
            || '';
          if (content) sseParts.push(content);
          
          // 提取 model（从第一个有效 chunk）
          if (!capturedOutput.model && parsed.model) {
            capturedOutput.model = parsed.model;
          }
          
          // 提取 usage（通常在最后一个 chunk）
          if (parsed.usage) {
            capturedOutput.usage = parsed.usage;
          }
        } catch (_) {
          // 忽略格式错误的 SSE 行
        }
      }
      
      replyText = sseParts.join('');
      if (replyText) return replyText;
    }

    // 3. 尝试作为普通 JSON 解析
    if (rawOutput && !replyText) {
      try {
        const parsed = JSON.parse(rawOutput);
        if (parsed.error) {
          return `[上游错误] ${typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)}`;
        }
        replyText = parsed.choices?.[0]?.message?.content
          || parsed.choices?.[0]?.delta?.content
          || '';
        capturedOutput.model = parsed.model;
        capturedOutput.usage = parsed.usage;
        if (replyText) return replyText;
      } catch (_) {
        // 不是 JSON
      }
    }

    // 4. 兜底：直接使用原始输出
    if (rawOutput && !replyText) {
      return rawOutput;
    }

    return replyText || '(无回复内容)';
  }
}

module.exports = RuntimeGateway;