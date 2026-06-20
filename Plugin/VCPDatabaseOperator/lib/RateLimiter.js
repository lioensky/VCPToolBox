'use strict';

/**
 * RateLimiter.js
 * 对应 Druid WallFilter 频率限制
 * 滑动窗口算法，按 maid(调用方Agent) 分桶，各Agent独立计数
 */

class RateLimiter {
  constructor(config) {
    this._readLimit  = parseInt(config.DB_RATE_LIMIT_PER_MINUTE)       || 60;
    this._writeLimit = parseInt(config.DB_WRITE_RATE_LIMIT_PER_MINUTE) || 20;
    this._buckets    = new Map();
    this._writeCommands = new Set(['InsertRow', 'UpdateRow', 'DeleteRow']);
  }

  check(maid, command) {
    const key         = maid || 'anonymous';
    const now         = Date.now();
    const windowStart = now - 60000;

    if (!this._buckets.has(key)) this._buckets.set(key, { read: [], write: [] });
    const bucket = this._buckets.get(key);

    // 清理窗口外旧记录
    bucket.read  = bucket.read.filter(t  => t > windowStart);
    bucket.write = bucket.write.filter(t => t > windowStart);

    const isWrite = this._writeCommands.has(command);

    if (bucket.read.length >= this._readLimit) {
      throw this._err('RATE_LIMIT_EXCEEDED',
        `Agent [${key}] 每分钟请求超过限制(${this._readLimit}次)，请稍后再试`);
    }
    if (isWrite && bucket.write.length >= this._writeLimit) {
      throw this._err('WRITE_RATE_LIMIT_EXCEEDED',
        `Agent [${key}] 写操作每分钟超过限制(${this._writeLimit}次)，请稍后再试`);
    }

    bucket.read.push(now);
    if (isWrite) bucket.write.push(now);
  }

  getStatus(maid) {
    const key         = maid || 'anonymous';
    const windowStart = Date.now() - 60000;
    if (!this._buckets.has(key)) {
      return { read: 0, write: 0, read_limit: this._readLimit, write_limit: this._writeLimit };
    }
    const b = this._buckets.get(key);
    return {
      read:        b.read.filter(t  => t > windowStart).length,
      write:       b.write.filter(t => t > windowStart).length,
      read_limit:  this._readLimit,
      write_limit: this._writeLimit,
    };
  }

  _err(code, message) {
    const e = new Error(message);
    e.code  = code;
    return e;
  }
}

module.exports = RateLimiter;