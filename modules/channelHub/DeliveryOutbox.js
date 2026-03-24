/**
 * DeliveryOutbox - 出站消息队列管理器
 *
 * 职责：
 * - 管理出站消息队列（FIFO + 优先级）
 * - 提供消息重试机制（指数退避）
 * - 处理死信队列（Dead Letter Queue）
 * - 跟踪消息投递状态
 * - 支持批量投递优化
 * - 自动死信清理和告警
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
   * @param {number} options.deadLetterRetentionDays - 死信保留天数（默认7天）
   * @param {boolean} options.enableDeadLetterAutoCleanup - 启用死信自动清理
   * @param {boolean} options.enableDeadLetterNotification - 启用死信告警
   * @param {Function} options.onDeadLetter - 死信产生时的回调
   */
  constructor(options = {}) {
    super();

    this.store = options.store;
    this.logger = options.logger || console;
    this.maxAttempts = options.maxAttempts || 5;
    this.baseRetryDelay = options.baseRetryDelay || 1000;
    this.maxRetryDelay = options.maxRetryDelay || 60000;
    this.batchSize = options.batchSize || 10;

    // 死信配置
    this.deadLetterRetentionDays = options.deadLetterRetentionDays || 7;
    this.enableDeadLetterAutoCleanup = options.enableDeadLetterAutoCleanup !== false;
    this.enableDeadLetterNotification = options.enableDeadLetterNotification !== false;
    this.onDeadLetter = options.onDeadLetter || null;

    // 重试策略配置
    this.retryStrategy = options.retryStrategy || 'exponential';
    this.enableJitter = options.enableJitter !== false; // 默认启用
    this.enableSmartRetry = options.enableSmartRetry !== false; // 默认启用

    // 内存队列
    this.queue = [];
    this.deadLetterQueue = [];

    // 处理状态
    this.isProcessing = false;
    this.processTimer = null;
    this.cleanupTimer = null;
  }

  /**
   * 初始化出站队列
   */
  async initialize() {
    // 从持久化存储恢复未完成任务
    await this._restorePendingJobs();
    this._startProcessing();

    // 启动死信自动清理（每天检查一次）
    if (this.enableDeadLetterAutoCleanup) {
      this._startDeadLetterCleanup();
    }

    this.logger.info('[DeliveryOutbox] 初始化完成');
  }

  /**
   * 启动死信自动清理
   * @private
   */
  _startDeadLetterCleanup() {
    // 每天凌晨 3 点执行清理
    const scheduleNextCleanup = () => {
      const now = new Date();
      let nextRun = new Date(now);
      nextRun.setHours(3, 0, 0, 0);

      if (nextRun <= now) {
        nextRun.setDate(nextRun.getDate() + 1);
      }

      const delay = nextRun.getTime() - now.getTime();

      this.cleanupTimer = setTimeout(async () => {
        await this._cleanupExpiredDeadLetters();
        scheduleNextCleanup();
      }, delay);

      this.logger.debug(`[DeliveryOutbox] 死信清理任务计划在 ${nextRun.toISOString()} 执行`);
    };

    scheduleNextCleanup();
  }

  /**
   * 清理过期死信
   * @private
   */
  async _cleanupExpiredDeadLetters() {
    const now = Date.now();
    const retentionMs = this.deadLetterRetentionDays * 24 * 60 * 60 * 1000;
    const toRemove = [];

    for (let i = this.deadLetterQueue.length - 1; i >= 0; i--) {
      const job = this.deadLetterQueue[i];
      const jobTime = job.failedAt ? new Date(job.failedAt).getTime() : 0;

      if (now - jobTime > retentionMs) {
        toRemove.push(job);
        this.deadLetterQueue.splice(i, 1);
      }
    }

    if (toRemove.length > 0) {
      this.logger.info(`[DeliveryOutbox] 自动清理 ${toRemove.length} 个过期死信`);

      // 触发告警通知
      if (this.enableDeadLetterNotification && this.onDeadLetter) {
        try {
          await this.onDeadLetter({
            type: 'auto_cleanup',
            count: toRemove.length,
            jobs: toRemove.map(j => ({ jobId: j.jobId, channel: j.channel, error: j.finalError }))
          });
        } catch (e) {
          this.logger.warn('[DeliveryOutbox] 死信告警回调失败:', e.message);
        }
      }

      this.emit('deadLetter:cleanup', { removed: toRemove.length });
    }
  }

  /**
   * 获取死信统计信息
   * @returns {Object}
   */
  getDeadLetterStats() {
    const now = Date.now();
    const retentionMs = this.deadLetterRetentionDays * 24 * 60 * 60 * 1000;

    const stats = {
      total: this.deadLetterQueue.length,
      byChannel: {},
      byError: {},
      expiredCount: 0,
      oldest: null,
      newest: null
    };

    for (const job of this.deadLetterQueue) {
      // 按渠道统计
      const channel = job.channel || 'unknown';
      stats.byChannel[channel] = (stats.byChannel[channel] || 0) + 1;

      // 按错误类型统计
      const errorKey = job.finalError?.substring(0, 50) || 'unknown';
      stats.byError[errorKey] = (stats.byError[errorKey] || 0) + 1;

      // 检查过期
      if (job.failedAt) {
        const jobTime = new Date(job.failedAt).getTime();
        if (now - jobTime > retentionMs) {
          stats.expiredCount++;
        }

        if (!stats.oldest || jobTime < new Date(stats.oldest).getTime()) {
          stats.oldest = job.failedAt;
        }
        if (!stats.newest || jobTime > new Date(stats.newest).getTime()) {
          stats.newest = job.failedAt;
        }
      }
    }

    return stats;
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
      errorCode: error.code || null,
      timestamp: new Date().toISOString()
    });

    // 如果启用智能重试，检查错误类型决定是否重试
    if (this.enableSmartRetry && !this._shouldRetry(error)) {
      // 不可重试的错误，直接移入死信队列
      this.logger.warn(`[DeliveryOutbox] 任务错误不支持重试，直接移入死信: ${jobId}, error: ${error.message}`);
      await this._moveToDeadLetter(job, error);
      return;
    }

    // 检查是否超过最大重试次数
    if (job.attempts >= job.maxAttempts) {
      await this._moveToDeadLetter(job, error);
    } else {
      // 计算下次重试时间（使用配置的策略）
      const delay = this._calculateRetryDelay(job.attempts, this.retryStrategy);
      job.status = DELIVERY_STATUS.PENDING;
      job.nextRetryAt = new Date(Date.now() + delay).toISOString();

      await this._persistJob(job);
      this.emit('job:retry', job);
      this.logger.warn(`[DeliveryOutbox] 任务将在 ${Math.round(delay/1000)}秒 后重试 (策略: ${this.retryStrategy}, 尝试 ${job.attempts + 1}/${job.maxAttempts}): ${jobId}`);
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

  async listJobs(filter = {}) {
    if (this.store?.queryOutbox) {
      return this.store.queryOutbox(filter);
    }

    let jobs = [...this.queue, ...this.deadLetterQueue];
    if (filter.status) {
      jobs = jobs.filter((job) => job.status === filter.status);
    }
    if (filter.adapterId) {
      jobs = jobs.filter((job) => job.adapterId === filter.adapterId);
    }
    return jobs.slice(filter.offset || 0, (filter.offset || 0) + (filter.limit || 100));
  }

  async countJobs(filter = {}) {
    const jobs = await this.listJobs({ ...filter, offset: 0, limit: Number.MAX_SAFE_INTEGER });
    return jobs.length;
  }

  async getJob(jobId) {
    const job = this.getStatus(jobId);
    if (job) {
      return job;
    }

    if (!this.store?.queryOutbox) {
      return null;
    }

    const records = await this.store.queryOutbox({
      limit: Number.MAX_SAFE_INTEGER
    });
    return records.find((item) => item.jobId === jobId) || null;
  }

  async cancelJob(jobId) {
    return this.cancel(jobId);
  }

  async retryJob(jobId) {
    const deadLetterJob = this.deadLetterQueue.find((item) => item.jobId === jobId);
    if (deadLetterJob) {
      return this.replayDeadLetter(jobId);
    }

    let queued = this._findJob(jobId);
    if (!queued) {
      queued = await this.getJob(jobId);
    }
    if (!queued) {
      throw new DeliveryError(`浠诲姟涓嶅瓨鍦? ${jobId}`);
    }

    if (!this._findJob(jobId)) {
      this._insertByPriority(queued);
    }

    queued.status = DELIVERY_STATUS.PENDING;
    queued.nextRetryAt = null;
    queued.failedAt = null;
    queued.finalError = null;
    await this._persistJob(queued);
    return queued;
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
      deadLetter: this.deadLetterQueue.length,
      cancelled: 0,
      total: this.queue.length + this.deadLetterQueue.length
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
    job.failedAt = null;
    job.finalError = null;
    job.replayCount = (job.replayCount || 0) + 1;

    // 重新入队
    this._insertByPriority(job);
    await this._persistJob(job);

    this.emit('job:replayed', job);
    this.logger.info(`[DeliveryOutbox] 死信任务已重放: ${jobId}`);
  }

  /**
   * 手动清理过期死信
   * @param {number} [retentionDays] - 自定义保留天数
   * @returns {Promise<number>} 清理数量
   */
  async manualCleanup(retentionDays = null) {
    const days = retentionDays || this.deadLetterRetentionDays;
    const retentionMs = days * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const toRemove = [];

    for (let i = this.deadLetterQueue.length - 1; i >= 0; i--) {
      const job = this.deadLetterQueue[i];
      const jobTime = job.failedAt ? new Date(job.failedAt).getTime() : 0;

      if (now - jobTime > retentionMs) {
        toRemove.push(job);
        this.deadLetterQueue.splice(i, 1);
      }
    }

    this.logger.info(`[DeliveryOutbox] 手动清理 ${toRemove.length} 个过期死信 (保留 ${days} 天)`);
    this.emit('deadLetter:manual_cleanup', { removed: toRemove.length, retentionDays: days });

    return toRemove.length;
  }

  /**
   * 批量重试死信（按渠道）
   * @param {string} channel - 渠道过滤
   * @param {number} limit - 最大重试数量
   * @returns {Promise<number>} 重试数量
   */
  async batchReplayByChannel(channel, limit = 10) {
    const toReplay = this.deadLetterQueue
      .filter(job => !channel || job.channel === channel)
      .slice(0, limit);

    let replayed = 0;
    for (const job of toReplay) {
      try {
        await this.replayDeadLetter(job.jobId);
        replayed++;
      } catch (e) {
        this.logger.warn(`[DeliveryOutbox] 重放死信失败: ${job.jobId}`, e.message);
      }
    }

    this.logger.info(`[DeliveryOutbox] 批量重放死信: ${replayed}/${toReplay.length}`);
    return replayed;
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
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
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
   * @param {string} strategy - 退避策略: 'exponential', 'linear', 'fibonacci'
   * @returns {number} 延迟毫秒数
   * @private
   */
  _calculateRetryDelay(attempt, strategy = 'exponential') {
    let delay;

    switch (strategy) {
      case 'linear':
        // 线性退避：baseDelay * attempt
        delay = this.baseRetryDelay * attempt;
        break;

      case 'fibonacci':
        // 斐波那契退避
        delay = this.baseRetryDelay * this._fibonacci(attempt);
        break;

      case 'exponential':
      default:
        // 指数退避：baseDelay * 2^(attempt-1)
        delay = this.baseRetryDelay * Math.pow(2, attempt - 1);
        break;
    }

    // 添加随机抖动（±25%），防止惊群效应
    const jitterFactor = 0.75 + Math.random() * 0.5;
    delay = delay * jitterFactor;

    return Math.min(delay, this.maxRetryDelay);
  }

  /**
   * 斐波那契数列计算
   * @param {number} n - 第n项
   * @returns {number}
   * @private
   */
  _fibonacci(n) {
    if (n <= 1) return 1;
    let a = 1, b = 1;
    for (let i = 2; i <= n; i++) {
      const temp = a + b;
      a = b;
      b = temp;
    }
    return b;
  }

  /**
   * 根据错误类型判断是否应该重试
   * @param {Error} error - 错误对象
   * @returns {boolean}
   * @private
   */
  _shouldRetry(error) {
    const nonRetryableErrors = [
      'INVALID_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'VALIDATION_ERROR'
    ];

    // 检查错误码
    if (error.code && nonRetryableErrors.includes(error.code)) {
      return false;
    }

    // 检查错误消息中的关键词
    const message = (error.message || '').toLowerCase();
    const nonRetryablePatterns = [
      'invalid request',
      'unauthorized',
      'forbidden',
      'not found',
      'validation error',
      'invalid parameter'
    ];

    for (const pattern of nonRetryablePatterns) {
      if (message.includes(pattern)) {
        return false;
      }
    }

    // 网络错误、超时等应该重试
    const retryablePatterns = [
      'timeout',
      'econnrefused',
      'enetunreach',
      'socket',
      'network',
      '503',
      '502',
      '504'
    ];

    for (const pattern of retryablePatterns) {
      if (message.includes(pattern)) {
        return true;
      }
    }

    // 默认重试
    return true;
  }

  /**
   * 配置重试策略
   * @param {Object} options
   * @param {string} options.strategy - 退避策略
   * @param {boolean} options.enableJitter - 是否启用抖动
   * @param {boolean} options.enableSmartRetry - 是否启用智能重试（根据错误类型）
   */
  configureRetryStrategy(options = {}) {
    if (options.strategy) {
      this.retryStrategy = options.strategy;
    }
    if (typeof options.enableJitter === 'boolean') {
      this.enableJitter = options.enableJitter;
    }
    if (typeof options.enableSmartRetry === 'boolean') {
      this.enableSmartRetry = options.enableSmartRetry;
    }
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

    // 触发死信告警
    if (this.enableDeadLetterNotification && this.onDeadLetter) {
      try {
        await this.onDeadLetter({
          type: 'job_dead',
          jobId: job.jobId,
          adapterId: job.adapterId,
          channel: job.channel,
          attempts: job.attempts,
          error: error.message,
          payload: job.payload ? { hasContent: true } : null
        });
      } catch (e) {
        this.logger.warn('[DeliveryOutbox] 死信告警回调失败:', e.message);
      }
    }
  }

  /**
   * 持久化任务
   * @param {OutboxJob} job
   * @private
   */
  async _persistJob(job) {
    if (this.store) {
      try {
        await this.store.updateOutboxJob(job.jobId, job);
      } catch (e) {
        // 如果更新失败（例如任务不存在于 JSONL），追加新记录
        await this.store.appendOutboxJob(job);
      }
    }
  }

  /**
   * 恢复未完成任务
   * @private
   */
  async _restorePendingJobs() {
    if (!this.store) return;
    
    try {
      const jobs = await this.store.queryOutbox({
        limit: Number.MAX_SAFE_INTEGER
      });
      
      for (const job of jobs) {
        if (!job?.jobId) {
          continue;
        }

        if (job.status === DELIVERY_STATUS.DELIVERED || job.status === DELIVERY_STATUS.CANCELLED) {
          continue;
        }

        if (job.status === DELIVERY_STATUS.FAILED || job.status === DELIVERY_STATUS.DEAD_LETTER) {
          if (!this.deadLetterQueue.some((item) => item.jobId === job.jobId)) {
            this.deadLetterQueue.push(job);
          }
          continue;
        }

        if (job.status === DELIVERY_STATUS.PROCESSING) {
          job.status = DELIVERY_STATUS.PENDING;
          job.nextRetryAt = null;
          await this._persistJob(job);
        }

        if (!this.queue.some((item) => item.jobId === job.jobId)) {
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
