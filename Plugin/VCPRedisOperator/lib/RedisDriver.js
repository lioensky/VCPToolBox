'use strict';

const Redis = require('ioredis');

class RedisDriver {
  constructor(env) {
    this.client = null;
    this.config = {
      host:            env.REDIS_HOST     || '127.0.0.1',
      port:            parseInt(env.REDIS_PORT || '6379'),
      password:        env.REDIS_PASSWORD || undefined,
      db:              parseInt(env.REDIS_DB   || '0'),
      connectTimeout:  parseInt(env.REDIS_CONNECT_TIMEOUT || '5000'),
      commandTimeout:  parseInt(env.REDIS_COMMAND_TIMEOUT || '5000'),
      maxRetriesPerRequest: 2,
      lazyConnect:     true,
    };
    this.debug = env.REDIS_DEBUG === 'true';
  }

  async connect() {
    this.client = new Redis(this.config);
    this.client.on('error', err => {
      console.error('[VCPRedisOperator] Redis error:', err.message);
    });
    await this.client.connect();
    if (this.debug) console.log('[VCPRedisOperator] Redis connected');
  }

  async disconnect() {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      if (this.debug) console.log('[VCPRedisOperator] Redis disconnected');
    }
  }

  /**
   * 执行单条 Redis 命令
   * @param {string} command - 大写命令名，如 'INCR'
   * @param {string} key     - 目标 Key
   * @param {any[]}  args    - 附加参数列表
   * @returns {Promise<{result: any, type: string}>}
   */
  async execute(command, key, args = []) {
    if (!this.client) throw new Error('Redis 未连接');

    const start = Date.now();
    const allArgs = [key, ...args];

    if (this.debug) {
      console.log(`[VCPRedisOperator] CMD: ${command} ${allArgs.map(a => JSON.stringify(a)).join(' ')}`);
    }

    const raw = await this.client[command.toLowerCase()](...allArgs);
    const duration = Date.now() - start;

    const type = raw === null ? 'null'
               : Array.isArray(raw) ? 'array'
               : typeof raw;

    if (this.debug) {
      console.log(`[VCPRedisOperator] RESULT (${duration}ms): ${JSON.stringify(raw)}`);
    }

    return { result: raw, type, duration_ms: duration };
  }
}

module.exports = RedisDriver;
