/**
 * DeliveryOutbox - 出站消息队列管理器
 * 
 * 职责：
 * - 管理出站消息队列（FIFO + 优先级）
 * - 提供消息重试机制（指数退避）
 * - 处理死信队列（Dead Letter Queue）
 * - 跟踪消息投递状态
 * - 支持批量投递优化
 */

const { EventEmitter } = require('events');
const { DELIVERY_STATUS, PRIORITY } = require('./constants');
const { DeliveryError } = require('./errors');

/**
 * @typedef {Object} OutboxJob
 * @property {string} jobId - 任务唯一ID
 * @property {string} adapterId - 目标适配器ID
 * @property {string} channel - 目标渠道
 * @property {Object} payload - 投递负载
 * @property {number} priority - 优先级
 * @property {string} status - 状态
 * @property {number} attempts - 尝试次数
 * @property {number} maxAttempts - 最大尝试次数
 * @property {Date} createdAt - 创建时间
 * @property {Date} lastAttemptAt - 最后尝试时间
 * @property {Date} nextRetryAt - 下次重试时间
 * @property {string[]} errors - 错误记录
 */

class DeliveryOutbox extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} options.store - StateStore实例
   * @param {Object} options.logger - 日志器
   * @param {number} options.maxAttempts - 最大重试次数
   * @param {number} options.baseRetryDelay - 基础重试延迟（毫秒）
   * @param {number} options.maxRetryDelay - 最大重试延迟（毫秒）
   * @param {number} options.batchSize - 批量处理大小
   */
  constructor(options = {}) {
    super();
    
    this.store = options.store;
    this.logger = options.logger || console;
    this.maxAttempts = options.maxAttempts || 5;
    this.baseRetryDelay = options.baseRetryDelay || 1000;
    this.maxRetryDelay = options.maxRetryDelay || 60000;
    this.batchSize = options.batchSize || 10;
    
    // 内存队列
    this.queue = [];
    this.deadLetterQueue = [];
    
    // 处理状态
    this.isProcessing = false;
    this.processTimer = null;
  }

  /**
   * 初始化出站队列
   */
  async initialize() {
    // 从持久化存储恢复未完成任务
    await this._restorePendingJobs();
    this._startProcessing();
    this.logger.info('[DeliveryOutbox] 初始化完成');
  }

  /**
   * 添加投递任务
   * @param {Object} options
   * @param {string} options.adapterId - 适配器ID
   * @param {string} options.channel - 渠道
   * @param {Object} options.payload - 投递负载
   * @param {number} options.priority - 优先级
   * @param {number} options.maxAttempts - 最大尝试次数
   * @returns {Promise<string>} 任务ID
   */
  async enqueue(options) {
    const job = {
      jobId: this._generateJobId(),
      adapterId: options.adapterId,
      channel: options.channel,
      payload: options.payload,
      priority: options.priority || PRIORITY.NORMAL,
      status: DELIVERY_STATUS.PENDING,
      attempts: 0,
      maxAttempts: options.maxAttempts || this.maxAttempts,
      createdAt: new Date().toISOString(),
      lastAttemptAt: null,
      nextRetryAt: null,
      errors: []
    };
    
    // 持久化
    if (this.store) {
      await this.store.appendOutboxJob(job);
    }
    
    // 加入内存队列
    this._insertByPriority(job);
    
    this.emit('job:enqueued', job);
    this.logger.debug(`[DeliveryOutbox] 任务入队: ${job.jobId}`);
    
    return job.jobId;
  }

  /**
   * 获取下一个待处理任务
   * @returns {OutboxJob|null}
   */
  peek() {
    const now = new Date();
    
    for (const job of this.queue) {
      if (job.status === DELIVERY_STATUS.PENDING) {
        // 检查是否到达重试时间
        if (!job.nextRetryAt || new Date(job.nextRetryAt) <= now) {
          return job;
        }
      }
    }
    
    return null;
  }

  /**
   * 批量获取待处理任务
   * @param {number} limit - 数量限制
   * @returns {OutboxJob[]}
   */
  peekBatch(limit = this.batchSize) {
    const now = new Date();
    const jobs = [];
    
    for (const job of this.queue) {
      if (jobs.length >= limit) break;
      
      if (job.status === DELIVERY_STATUS.PENDING) {
        if (!job.nextRetryAt || new Date(job.nextRetryAt) <= now) {
          jobs.push(job);
        }
      }
    }
    
    return jobs;
  }

  /**
   * 标记任务开始处理
   * @param {string} jobId - 任务ID
   */
  async markProcessing(jobId) {
    const job = this._findJob(jobId);
    if (!job) {
      throw new DeliveryError(`任务不存在: ${jobId}`);
    }
    
    job.status = DELIVERY_STATUS.PROCESSING;
    job.lastAttemptAt = new Date().toISOString();
    job.attempts += 1;
    
    await this._persistJob(job);
    this.emit('job:processing', job);
  }

  /**
   * 标记任务成功
   * @param {string} jobId - 任务ID
   * @param {Object} result - 投递结果
   */
  async markSuccess(jobId, result = {}) {
    const job = this._findJob(jobId);
    if (!job) {
      throw new DeliveryError(`任务不存在: ${jobId}`);
    }
    
    job.status = DELIVERY_STATUS.DELIVERED;
    job.deliveredAt = new Date().toISOString();
    job.result = result;
    
    // 从队列移除
    this._removeJob(jobId);
    
    await this._persistJob(job);
    this.emit('job:success', job);
    this.logger.info(`[DeliveryOutbox] 任务投递成功: ${jobId}`);
  }

  /**
   * 标记任务失败
   * @param {string} jobId - 任务ID
   * @param {Error} error - 错误信息
   */
  async markFailed(jobId, error) {
    const job = this._findJob(jobId);
    if (!job) {
      throw new DeliveryError(`任务不存在: ${jobId}`);
    }
    
    job.errors.push({
      attempt: job.attempts,
      error: error.message,
      timestamp: new Date().toISOString()
    });
    
    // 检查是否超过最大重试次数
    if (job.attempts >= job.maxAttempts) {
      await this._moveToDeadLetter(job, error);
    } else {
      // 计算下次重试时间（指数退避）
      const delay = this._calculateRetryDelay(job.attempts);
      job.status = DELIVERY_STATUS.PENDING;
      job.nextRetryAt = new Date(Date.now() + delay).toISOString();
      
      await this._persistJob(job);
      this.emit('job:retry', job);
      this.logger.warn(`[DeliveryOutbox] 任务将在 ${delay}ms 后重试: ${jobId}`);
    }
  }

  /**
   * 取消任务
   * @param {string} jobId - 任务ID
   */
  async cancel(jobId) {
    const job = this._findJob(jobId);
    if (!job) {
      throw new DeliveryError(`任务不存在: ${jobId}`);
    }
    
    job.status = DELIVERY_STATUS.CANCELLED;
    this._removeJob(jobId);
    
    await this._persistJob(job);
    this.emit('job:cancelled', job);
    this.logger.info(`[DeliveryOutbox] 任务已取消: ${jobId}`);
  }

  /**
   * 获取任务状态
   * @param {string} jobId - 任务ID
   * @returns {OutboxJob|null}
   */
  getStatus(jobId) {
    return this._findJob(jobId);
  }

  /**
   * 获取队列统计
   * @returns {Object}
   */
  getStats() {
    const stats = {
      pending: 0,
      processing: 0,
      delivered: 0,
      failed: this.deadLetterQueue.length,
      total: this.queue.length
    };
    
    for (const job of this.queue) {
      if (stats[job.status] !== undefined) {
        stats[job.status]++;
      }
    }
    
    return stats;
  }

  /**
   * 获取死信队列
   * @param {Object} options
   * @param {number} options.limit - 数量限制
   * @param {string} options.channel - 渠道过滤
   * @returns {OutboxJob[]}
   */
  getDeadLetters(options = {}) {
    let result = [...this.deadLetterQueue];
    
    if (options.channel) {
      result = result.filter(job => job.channel === options.channel);
    }
    
    if (options.limit) {
      result = result.slice(0, options.limit);
    }
    
    return result;
  }

  /**
   * 重放死信任务
   * @param {string} jobId - 任务ID
   */
  async replayDeadLetter(jobId) {
    const index = this.deadLetterQueue.findIndex(job => job.jobId === jobId);
    if (index === -1) {
      throw new DeliveryError(`死信任务不存在: ${jobId}`);
    }
    
    const job = this.deadLetterQueue.splice(index, 1)[0];
    
    // 重置任务状态
    job.status = DELIVERY_STATUS.PENDING;
    job.attempts = 0;
    job.errors = [];
    job.nextRetryAt = null;
    job.replayCount = (job.replayCount || 0) + 1;
    
    // 重新入队
    this._insertByPriority(job);
    await this._persistJob(job);
    
    this.emit('job:replayed', job);
    this.logger.info(`[DeliveryOutbox] 死信任务已重放: ${jobId}`);
  }

  /**
   * 启动处理循环
   * @private
   */
  _startProcessing() {
    this.isProcessing = true;
    this._scheduleNextProcess();
  }

  /**
   * 停止处理循环
   */
  stop() {
    this.isProcessing = false;
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
    }
  }

  /**
   * 调度下次处理
   * @private
   */
  _scheduleNextProcess() {
    if (!this.isProcessing) return;
    
    this.processTimer = setTimeout(() => {
      this._processQueue();
    }, 1000);
  }

  /**
   * 处理队列
   * @private
   */
  async _processQueue() {
    try {
      const jobs = this.peekBatch();
      
      if (jobs.length > 0) {
        this.emit('batch:ready', jobs);
      }
    } catch (error) {
      this.logger.error('[DeliveryOutbox] 处理队列失败:', error);
    }
    
    this._scheduleNextProcess();
  }

  /**
   * 计算重试延迟
   * @param {number} attempt - 尝试次数
   * @returns {number} 延迟毫秒数
   * @private
   */
  _calculateRetryDelay(attempt) {
    // 指数退避：baseDelay * 2^(attempt-1)
    const delay = this.baseRetryDelay * Math.pow(2, attempt - 1);
    return Math.min(delay, this.maxRetryDelay);
  }

  /**
   * 按优先级插入队列
   * @param {OutboxJob} job
   * @private
   */
  _insertByPriority(job) {
    // 优先级越高，数字越小，排在前面
    let insertIndex = this.queue.length;
    
    for (let i = 0; i < this.queue.length; i++) {
      if (job.priority < this.queue[i].priority) {
        insertIndex = i;
        break;
      }
    }
    
    this.queue.splice(insertIndex, 0, job);
  }

  /**
   * 查找任务
   * @param {string} jobId
   * @returns {OutboxJob|null}
   * @private
   */
  _findJob(jobId) {
    return this.queue.find(job => job.jobId === jobId) || 
           this.deadLetterQueue.find(job => job.jobId === jobId);
  }

  /**
   * 从队列移除任务
   * @param {string} jobId
   * @private
   */
  _removeJob(jobId) {
    const index = this.queue.findIndex(job => job.jobId === jobId);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }
  }

  /**
   * 移动到死信队列
   * @param {OutboxJob} job
   * @param {Error} error
   * @private
   */
  async _moveToDeadLetter(job, error) {
    job.status = DELIVERY_STATUS.FAILED;
    job.failedAt = new Date().toISOString();
    job.finalError = error.message;
    
    this._removeJob(job.jobId);
    this.deadLetterQueue.push(job);
    
    await this._persistJob(job);
    this.emit('job:dead', job);
    this.logger.error(`[DeliveryOutbox] 任务已进入死信队列: ${job.jobId}`);
  }

  /**
   * 持久化任务
   * @param {OutboxJob} job
   * @private
   */
  async _persistJob(job) {
    if (this.store) {
      await this.store.updateOutboxJob(job);
    }
  }

  /**
   * 恢复未完成任务
   * @private
   */
  async _restorePendingJobs() {
    if (!this.store) return;
    
    try {
      const jobs = await this.store.getPendingOutboxJobs();
      
      for (const job of jobs) {
        if (job.status === DELIVERY_STATUS.FAILED) {
          this.deadLetterQueue.push(job);
        } else {
          this._insertByPriority(job);
        }
      }
      
      this.logger.info(`[DeliveryOutbox] 恢复 ${jobs.length} 个未完成任务`);
    } catch (error) {
      this.logger.error('[DeliveryOutbox] 恢复任务失败:', error);
    }
  }

  /**
   * 生成任务ID
   * @returns {string}
   * @private
   */
  _generateJobId() {
    return `outbox_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

module.exports = DeliveryOutbox;