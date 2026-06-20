'use strict';

// 仅允许以下命令，其他一律拒绝（白名单策略，比黑名单更安全）
const ALLOWED_COMMANDS = new Set([
  // String / 通用
  'GET', 'SET', 'DEL', 'EXISTS', 'EXPIRE', 'EXPIREAT', 'PEXPIRE', 'PEXPIREAT',
  'TTL', 'PTTL', 'PERSIST', 'INCR', 'DECR', 'INCRBY', 'DECRBY', 'INCRBYFLOAT',
  'SETNX', 'GETEX', 'GETDEL', 'STRLEN', 'APPEND', 'GETSET', 'MGET', 'TYPE',
  // Hash
  'HGET', 'HSET', 'HSETNX', 'HDEL', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN',
  'HEXISTS', 'HMSET', 'HMGET', 'HINCRBY', 'HINCRBYFLOAT',
  // List
  'LPUSH', 'RPUSH', 'LPUSHX', 'RPUSHX', 'LPOP', 'RPOP',
  'LRANGE', 'LLEN', 'LINDEX', 'LSET', 'LREM',
  // Set
  'SADD', 'SREM', 'SMEMBERS', 'SCARD', 'SISMEMBER', 'SMISMEMBER', 'SPOP', 'SRANDMEMBER',
  // ZSet
  'ZADD', 'ZREM', 'ZSCORE', 'ZRANK', 'ZREVRANK', 'ZRANGE', 'ZREVRANGE',
  'ZRANGEBYSCORE', 'ZREVRANGEBYSCORE', 'ZCARD', 'ZINCRBY', 'ZCOUNT', 'ZPOPMIN', 'ZPOPMAX',
]);

class CommandValidator {
  constructor(env) {
    // 解析 key 前缀白名单：REDIS_KEY_PREFIX_0=user:unread:  REDIS_KEY_PREFIX_1=captcha:ticket:
    this.keyPrefixes = [];
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith('REDIS_KEY_PREFIX_') && typeof v === 'string' && v.trim()) {
        this.keyPrefixes.push(v.trim());
      }
    }
    this.strictPrefixMode = this.keyPrefixes.length > 0;
  }

  checkCommand(command) {
    if (!ALLOWED_COMMANDS.has(command)) {
      throw new Error(JSON.stringify({
        plugin_error: 'COMMAND_NOT_ALLOWED',
        message: '命令 ' + command + ' 不在白名单内，拒绝执行',
        hint: '被禁止的命令包括：FLUSHDB / FLUSHALL / KEYS / EVAL / CONFIG / SHUTDOWN 等危险指令',
        allowed_commands: [...ALLOWED_COMMANDS].sort().join(', ')
      }));
    }
  }

  checkKeyPrefix(key) {
    if (!this.strictPrefixMode) return;
    const allowed = this.keyPrefixes.some(prefix => key.startsWith(prefix));
    if (!allowed) {
      throw new Error(JSON.stringify({
        plugin_error: 'KEY_PREFIX_NOT_ALLOWED',
        message: 'Key "' + key + '" 不匹配任何已授权前缀，拒绝操作',
        allowed_prefixes: this.keyPrefixes,
        hint: '在 config.env 中增加 REDIS_KEY_PREFIX_N=你的前缀 来授权新前缀'
      }));
    }
  }
}

module.exports = CommandValidator;
