/**
 * AuditLogger - 全链路审计日志器
 * 
 * 职责：
 * - 记录入站事件的完整处理链路
 * - 记录出站消息的投递过程
 * - 提供结构化日志查询能力
 * - 支持日志归档和清理
 * 
 * 设计原则：
 * - 每个事件生成唯一 traceId
 * - 支持按时间、channel、agent 等维度查询
 * - 异步写入不阻塞主流程
 */

const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

class AuditLogger {
  /**
   * @param {Object} options - 配置选项
   * @param {string} options.logDir - 日志目录
   * @param {number} options.maxFileSize - 单文件最大大小 (字节)
   * @param {number} options.retentionDays - 日志保留天数
   * @param {boolean} options.enableConsole - 是否同时输出到控制台
   */
  constructor(options = {}) {
    this.logDir = options.logDir || './state/channelHub/logs';
    this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB
    this.retentionDays = options.retentionDays || 30;
    this.enableConsole = options.enableConsole ?? true;
    
    this.currentLogFile = null;
    this.currentFileSize = 0;
    this.writeQueue = [];
    this.isWriting = false;
    
    // 日志级别定义
    this.levels = {
      DEBUG: 10,
      INFO: 20,
      WARN: 30,
      ERROR: 40
    };
    
    this.minLevel = this.levels[options.level] || this.levels.INFO;
  }

  /**
   * 初始化日志器
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
      await this._rotateLogFile();
      this._startCleanupTimer();
      console.log('[AuditLogger] Initialized with log dir:', this.logDir);
    } catch (error) {
      console.error('[AuditLogger] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * 生成追踪ID
   * @returns {string} traceId
   */
  generateTraceId() {
    return `trace-${Date.now()}-${uuidv4().substring(0, 8)}`;
  }

  /**
   * 记录入站事件
   * @param {Object} event - ChannelEventEnvelope
   * @param {string} traceId - 追踪ID
   * @param {Object} context - 额外上下文
   */
  logInboundEvent(event, traceId, context = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: 'INFO',
      traceId,
      type: 'INBOUND_EVENT',
      channel: event.channel,
      adapterId: event.adapterId,
      eventId: event.eventId,
      eventType: event.eventType,
      sender: event.sender,
      sessionId: event.session?.sessionId,
      context
    };
    
    this._writeLog(logEntry);
  }

  /**
   * 记录运行时调用
   * @param {string} traceId - 追踪ID
   * @param {string} agentId - Agent ID
   * @param {string} sessionId - 会话ID
   * @param {Object} request - 请求详情
   * @param {Object} response - 响应详情
   * @param {number} durationMs - 耗时(毫秒)
   */
  logRuntimeInvocation(traceId, agentId, sessionId, request, response, durationMs) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: 'INFO',
      traceId,
      type: 'RUNTIME_INVOCATION',
      agentId,
      sessionId,
      request: {
        model: request.model,
        messageCount: request.messages?.length
      },
      response: {
        success: response.success,
        finishReason: response.finishReason,
        tokenUsage: response.usage
      },
      durationMs
    };
    
    this._writeLog(logEntry);
  }

  /**
   * 记录出站投递
   * @param {string} traceId - 追踪ID
   * @param {Object} outboxJob - 投递任务
   * @param {string} status - 投递状态
   * @param {Object} result - 投递结果
   */
  logOutboundDelivery(traceId, outboxJob, status, result = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: status === 'FAILED' ? 'ERROR' : 'INFO',
      traceId,
      type: 'OUTBOUND_DELIVERY',
      jobId: outboxJob.jobId,
      channel: outboxJob.channel,
      adapterId: outboxJob.adapterId,
      targetUserId: outboxJob.targetUserId,
      status,
      attemptCount: outboxJob.attemptCount,
      result: {
        success: result.success,
        messageId: result.messageId,
        error: result.error
      }
    };
    
    this._writeLog(logEntry);
  }

  /**
   * 记录错误
   * @param {string} traceId - 追踪ID
   * @param {Error|string} error - 错误对象或消息
   * @param {Object} context - 上下文信息
   */
  logError(traceId, error, context = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      traceId,
      type: 'ERROR',
      error: {
        message: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined
      },
      context
    };
    
    this._writeLog(logEntry);
  }

  /**
   * 记录适配器状态变更
   * @param {string} adapterId - 适配器ID
   * @param {string} status - 新状态
   * @param {Object} details - 详情
   */
  logAdapterStatusChange(adapterId, status, details = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: 'INFO',
      traceId: this.generateTraceId(),
      type: 'ADAPTER_STATUS_CHANGE',
      adapterId,
      status,
      details
    };
    
    this._writeLog(logEntry);
  }

  /**
   * 记录会话绑定
   * @param {string} traceId - 追踪ID
   * @param {string} bindingKey - 绑定键
   * @param {string} externalSessionKey - 外部会话键
   * @param {string} vcpSessionId - VCP会话ID
   * @param {string} agentId - Agent ID
   */
  logSessionBinding(traceId, bindingKey, externalSessionKey, vcpSessionId, agentId) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: 'INFO',
      traceId,
      type: 'SESSION_BINDING',
      bindingKey,
      externalSessionKey,
      vcpSessionId,
      agentId
    };
    
    this._writeLog(logEntry);
  }

  /**
   * 写入日志条目
   * @param {Object} entry - 日志条目
   * @private
   */
  async _writeLog(entry) {
    // 检查日志级别
    const entryLevel = this.levels[entry.level] || this.levels.INFO;
    if (entryLevel < this.minLevel) {
      return;
    }
    
    // 控制台输出
    if (this.enableConsole) {
      const logLine = JSON.stringify(entry);
      if (entry.level === 'ERROR') {
        console.error('[AuditLogger]', logLine);
      } else if (entry.level === 'WARN') {
        console.warn('[AuditLogger]', logLine);
      } else {
        console.log('[AuditLogger]', logLine);
      }
    }
    
    // 加入写入队列
    this.writeQueue.push(entry);
    this._processWriteQueue();
  }

  /**
   * 处理写入队列
   * @private
   */
  async _processWriteQueue() {
    if (this.isWriting || this.writeQueue.length === 0) {
      return;
    }
    
    this.isWriting = true;
    
    try {
      while (this.writeQueue.length > 0) {
        const entry = this.writeQueue.shift();
        const logLine = JSON.stringify(entry) + '\n';
        const buffer = Buffer.from(logLine, 'utf-8');
        
        // 检查文件大小，必要时轮转
        if (this.currentFileSize + buffer.length > this.maxFileSize) {
          await this._rotateLogFile();
        }
        
        // 写入文件
        if (this.currentLogFile) {
          await fs.appendFile(this.currentLogFile, buffer);
          this.currentFileSize += buffer.length;
        }
      }
    } catch (error) {
      console.error('[AuditLogger] Write error:', error);
    } finally {
      this.isWriting = false;
    }
  }

  /**
   * 轮转日志文件
   * @private
   */
  async _rotateLogFile() {
    const dateStr = new Date().toISOString().split('T')[0];
    const timestamp = Date.now();
    const filename = `audit-${dateStr}-${timestamp}.log`;
    this.currentLogFile = path.join(this.logDir, filename);
    this.currentFileSize = 0;
    
    // 确保文件存在
    await fs.writeFile(this.currentLogFile, '');
    console.log('[AuditLogger] Rotated to new log file:', this.currentLogFile);
  }

  /**
   * 启动清理定时器
   * @private
   */
  _startCleanupTimer() {
    // 每天凌晨执行一次清理
    const cleanup = async () => {
      try {
        await this._cleanupOldLogs();
      } catch (error) {
        console.error('[AuditLogger] Cleanup error:', error);
      }
    };
    
    // 立即执行一次
    cleanup();
    
    // 设置定时器（每小时检查一次）
    setInterval(cleanup, 60 * 60 * 1000);
  }

  /**
   * 清理过期日志
   * @private
   */
  async _cleanupOldLogs() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);
    
    const files = await fs.readdir(this.logDir);
    let deletedCount = 0;
    
    for (const file of files) {
      if (!file.startsWith('audit-') || !file.endsWith('.log')) {
        continue;
      }
      
      const filePath = path.join(this.logDir, file);
      const stat = await fs.stat(filePath);
      
      if (stat.mtime < cutoffDate) {
        await fs.unlink(filePath);
        deletedCount++;
      }
    }
    
    if (deletedCount > 0) {
      console.log(`[AuditLogger] Cleaned up ${deletedCount} old log files`);
    }
  }

  /**
   * 查询日志
   * @param {Object} query - 查询条件
   * @param {string} query.traceId - 按追踪ID查询
   * @param {string} query.channel - 按渠道查询
   * @param {string} query.agentId - 按Agent查询
   * @param {Date} query.startTime - 开始时间
   * @param {Date} query.endTime - 结束时间
   * @param {string} query.type - 日志类型
   * @param {number} query.limit - 结果数量限制
   * @returns {Promise<Array>} 日志条目数组
   */
  async queryLogs(query = {}) {
    const results = [];
    const limit = query.limit || 100;
    const offset = query.offset || 0;
    let skipped = 0;
    
    const files = await fs.readdir(this.logDir);
    const logFiles = files
      .filter(f => f.startsWith('audit-') && f.endsWith('.log'))
      .sort()
      .reverse(); // 从最新的开始
    
    for (const file of logFiles) {
      if (results.length >= limit) {
        break;
      }
      
      const filePath = path.join(this.logDir, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      
      for (const line of lines) {
        if (results.length >= limit) {
          break;
        }
        
        try {
          const entry = JSON.parse(line);
          
          // 应用过滤条件
          if (query.traceId && entry.traceId !== query.traceId) continue;
          if (query.adapterId && entry.adapterId !== query.adapterId) continue;
          if (query.channel && entry.channel !== query.channel) continue;
          if (query.agentId && entry.agentId !== query.agentId) continue;
          if (query.type && entry.type !== query.type) continue;
          if (query.startTime && new Date(entry.timestamp) < query.startTime) continue;
          if (query.endTime && new Date(entry.timestamp) > query.endTime) continue;

          if (skipped < offset) {
            skipped += 1;
            continue;
          }

          results.push(entry);
        } catch (e) {
          // 跳过解析错误的行
        }
      }
    }
    
    return results;
  }

  async query(filter = {}) {
    return this.queryLogs({
      traceId: filter.requestId,
      adapterId: filter.adapterId,
      channel: filter.channel,
      agentId: filter.agentId,
      type: filter.eventType,
      startTime: filter.startTime,
      endTime: filter.endTime,
      limit: filter.limit,
      offset: filter.offset
    });
  }

  async count(filter = {}) {
    const records = await this.query({
      ...filter,
      limit: Number.MAX_SAFE_INTEGER
    });
    return records.length;
  }

  /**
   * 获取追踪链
   * @param {string} traceId - 追踪ID
   * @returns {Promise<Array>} 该追踪ID的所有日志条目
   */
  async getTraceChain(traceId) {
    return this.queryLogs({ traceId, limit: 1000 });
  }

  /**
   * 关闭日志器
   */
  async close() {
    // 处理剩余队列
    while (this.writeQueue.length > 0) {
      await this._processWriteQueue();
    }
    console.log('[AuditLogger] Closed');
  }
}

module.exports = AuditLogger;
