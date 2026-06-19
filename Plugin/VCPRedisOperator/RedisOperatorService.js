'use strict';

require('dotenv').config({ path: __dirname + '/config.env' });

const RedisDriver      = require('./lib/RedisDriver');
const CommandValidator = require('./lib/CommandValidator');
const RateLimiter      = require('./lib/RateLimiter');

let driver    = null;
let validator = null;
let limiter   = null;

// ──────────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────────

function createTextResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function throwToolError(message) {
  throw new Error(message);
}

// ──────────────────────────────────────────────────────────────────
// hybridservice 三个必须导出的函数
// ──────────────────────────────────────────────────────────────────

async function initialize(config, dependencies) {
  const env = process.env;

  validator = new CommandValidator(env);
  limiter   = new RateLimiter(env);
  driver    = new RedisDriver(env);

  await driver.connect();
  console.log('[VCPRedisOperator] 插件已初始化，Redis 已连接');
}

async function shutdown() {
  if (driver) {
    await driver.disconnect();
    console.log('[VCPRedisOperator] 插件已关闭');
  }
}

async function processToolCall(args) {
  // 归一化参数
  const command      = (args.command || '').trim();
  const redisCommand = (args.redis_command || '').trim().toUpperCase();
  const key          = (args.key || '').trim();
  const extraArgs    = Array.isArray(args.args) ? args.args : [];
  const maid         = (args.maid || 'unknown').trim();

  // 唯一支持的 command 入口
  if (command !== 'ExecuteRedis') {
    return createTextResult({
      plugin_error: 'UNKNOWN_COMMAND',
      message: `未知命令 "${command}"，目前仅支持 ExecuteRedis`,
      supported_commands: ['ExecuteRedis'],
    });
  }

  if (!redisCommand) {
    return createTextResult({
      plugin_error: 'MISSING_PARAM',
      message: '缺少必填参数 redis_command',
    });
  }

  if (!key) {
    return createTextResult({
      plugin_error: 'MISSING_PARAM',
      message: '缺少必填参数 key',
    });
  }

  try {
    // 安全三道闸
    validator.checkCommand(redisCommand);
    validator.checkKeyPrefix(key);
    limiter.check(maid, redisCommand);

    // 执行
    const { result, type, duration_ms } = await driver.execute(redisCommand, key, extraArgs);

    return createTextResult({
      status: 'ok',
      command: redisCommand,
      key,
      result,
      type,
      duration_ms,
    });

  } catch (err) {
    // 安全拒绝（throwToolError）或 Redis 执行异常
    let parsed;
    try { parsed = JSON.parse(err.message); } catch (_) { parsed = null; }

    if (parsed && parsed.plugin_error) {
      // 结构化安全拒绝，原样返回给 Agent
      throwToolError(err.message);
    }

    // Redis 执行时遇到的底层错误
    return createTextResult({
      status: 'error',
      command: redisCommand,
      key,
      error: err.message,
    });
  }
}

module.exports = { initialize, shutdown, processToolCall };
