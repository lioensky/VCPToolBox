'use strict';

const WRITE_COMMANDS = new Set([
  'SET', 'DEL', 'EXPIRE', 'EXPIREAT', 'PEXPIRE', 'PEXPIREAT', 'PERSIST',
  'INCR', 'DECR', 'INCRBY', 'DECRBY', 'INCRBYFLOAT', 'SETNX', 'GETEX',
  'GETDEL', 'APPEND', 'GETSET',
  'HSET', 'HSETNX', 'HDEL', 'HMSET', 'HINCRBY', 'HINCRBYFLOAT',
  'LPUSH', 'RPUSH', 'LPUSHX', 'RPUSHX', 'LPOP', 'RPOP', 'LSET', 'LREM',
  'SADD', 'SREM', 'SPOP',
  'ZADD', 'ZREM', 'ZINCRBY', 'ZPOPMIN', 'ZPOPMAX',
]);

class RateLimiter {
  constructor(env) {
    this.totalLimit = parseInt(env.REDIS_RATE_LIMIT_PER_MINUTE || '120');
    this.writeLimit  = parseInt(env.REDIS_WRITE_RATE_LIMIT_PER_MINUTE || '60');
    this.buckets = new Map();
  }

  check(maid, command) {
    const now    = Date.now();
    const cutoff = now - 60000;

    if (!this.buckets.has(maid)) {
      this.buckets.set(maid, { all: [], writes: [] });
    }
    const b = this.buckets.get(maid);
    b.all    = b.all.filter(t => t > cutoff);
    b.writes = b.writes.filter(t => t > cutoff);

    const isWrite = WRITE_COMMANDS.has(command);

    if (isWrite && b.writes.length >= this.writeLimit) {
      throw new Error(JSON.stringify({
        plugin_error: 'RATE_LIMIT_EXCEEDED',
        message: '写操作频率超限 (' + this.writeLimit + '次/分钟)',
        current: b.writes.length,
        limit: this.writeLimit,
        maid
      }));
    }
    if (b.all.length >= this.totalLimit) {
      throw new Error(JSON.stringify({
        plugin_error: 'RATE_LIMIT_EXCEEDED',
        message: '请求频率超限 (' + this.totalLimit + '次/分钟)',
        current: b.all.length,
        limit: this.totalLimit,
        maid
      }));
    }

    b.all.push(now);
    if (isWrite) b.writes.push(now);
  }
}

module.exports = RateLimiter;
