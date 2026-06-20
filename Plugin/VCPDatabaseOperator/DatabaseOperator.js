'use strict';

/**
 * DatabaseOperator.js - VCP数据库操作插件主程序
 * 对应 MyBatis Interceptor Chain 统一拦截链
 * 所有命令必须经过：权限校验→标识符校验→类型校验→频率限制→SQL构建→执行→结果过滤
 */

const path   = require('path');
const fs     = require('fs');
require('dotenv').config({ path: path.join(__dirname, 'config.env') });

const PermissionGuard = require('./lib/PermissionGuard');
const RateLimiter     = require('./lib/RateLimiter');
const SQLBuilder      = require('./lib/SQLBuilder');
const MysqlDriver     = require('./lib/MysqlDriver');

// ── 启动初始化 ──────────────────────────────────────────────
let guard, limiter, builder, driver;
try {
  guard   = new PermissionGuard(process.env);
  limiter = new RateLimiter(process.env);
  driver  = new MysqlDriver(process.env);
  builder = new SQLBuilder(guard, process.env);
} catch (e) {
  process.stderr.write('[VCPDatabaseOperator] 启动失败: ' + e.message + '\n');
  process.exit(1);
}

const WRITE_MAX_AFFECT = parseInt(process.env.DB_WRITE_MAX_AFFECT_ROWS) || 100;
const RETURN_DURATION  = process.env.DB_RETURN_DURATION === 'true';

// ── 统一响应构建 ────────────────────────────────────────────
function ok(data, extra) {
  return Object.assign({ status: 'success' }, data, extra || {});
}

function fail(code, message, extra) {
  return Object.assign({ status: 'error', code, message }, extra || {});
}

// ── 核心拦截链（对应MyBatis Interceptor Chain）──────────────
async function executeWithChain(command, params, maid) {
  const table = params.table;

  // 拦截器1：表白名单 + CRUD权限位（L1+L2）
  guard.checkPermission(table, command);

  // 拦截器2：频率限制（按maid分桶，对应漏洞9修复）
  limiter.check(maid, command);

  let result;

  switch (command) {

    case 'QueryTable': {
      const { sql, params: sqlParams } = builder.buildSelect(params);
      const { rows, duration, warning } = await driver.executeQuery(sql, sqlParams);
      // 拦截器3：结果字段过滤（对应MyBatis ResultMap）
      const filtered = guard.filterResultColumns(rows, table);
      result = ok(
        { rows: filtered, count: filtered.length },
        Object.assign(
          warning ? { warning } : {},
          RETURN_DURATION ? { duration_ms: duration } : {}
        )
      );
      break;
    }

    case 'InsertRow': {
      const { sql, params: sqlParams } = builder.buildInsert(params);
      const { result: dbResult, duration, warning } = await driver.executeWrite(sql, sqlParams);
      result = ok(
        { inserted_id: dbResult.insertId, affected_rows: dbResult.affectedRows },
        Object.assign(
          warning ? { warning } : {},
          RETURN_DURATION ? { duration_ms: duration } : {}
        )
      );
      break;
    }

    case 'UpdateRow': {
      // 影响行数预估（对应DB_WRITE_MAX_AFFECT_ROWS熔断）
      if (!params.confirm) {
        const { sql: cntSql, params: cntParams } = builder.buildCount(table, params.where);
        const cnt = await driver.executeCount(cntSql, cntParams);
        if (cnt > WRITE_MAX_AFFECT) {
          return fail('WRITE_AFFECT_TOO_MANY',
            '此操作将影响 ' + cnt + ' 行，超过安全阈值(' + WRITE_MAX_AFFECT + '行)，如需继续请带 confirm:true 重试',
            { affected_rows_estimate: cnt }
          );
        }
      }
      const { sql, params: sqlParams } = builder.buildUpdate(params);
      const { result: dbResult, duration, warning } = await driver.executeWrite(sql, sqlParams);
      result = ok(
        { affected_rows: dbResult.affectedRows },
        Object.assign(
          warning ? { warning } : {},
          RETURN_DURATION ? { duration_ms: duration } : {}
        )
      );
      break;
    }

    case 'DeleteRow': {
      // 影响行数预估
      if (!params.confirm) {
        const { sql: cntSql, params: cntParams } = builder.buildCount(table, params.where);
        const cnt = await driver.executeCount(cntSql, cntParams);
        if (cnt > WRITE_MAX_AFFECT) {
          return fail('WRITE_AFFECT_TOO_MANY',
            '此操作将影响 ' + cnt + ' 行，超过安全阈值(' + WRITE_MAX_AFFECT + '行)，如需继续请带 confirm:true 重试',
            { affected_rows_estimate: cnt }
          );
        }
      }
      const { sql, params: sqlParams } = builder.buildDelete(params);
      const { result: dbResult, duration, warning } = await driver.executeWrite(sql, sqlParams);
      result = ok(
        { affected_rows: dbResult.affectedRows },
        Object.assign(
          warning ? { warning } : {},
          RETURN_DURATION ? { duration_ms: duration } : {}
        )
      );
      break;
    }

    default:
      return fail('UNKNOWN_COMMAND', '未知命令: ' + command + '，支持: QueryTable/InsertRow/UpdateRow/DeleteRow');
  }

  return result;
}

// ── stdio 消息处理（VCP插件标准协议）──────────────────────────
let inputBuffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  inputBuffer += chunk;
  const lines = inputBuffer.split('\n');
  inputBuffer  = lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    handleMessage(trimmed);
  }
});

async function handleMessage(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stdout.write(JSON.stringify(fail('PARSE_ERROR', '输入不是合法JSON')) + '\n');
    return;
  }

  const { command, maid } = parsed;
  const params = parsed.params || {};

  // 基础参数校验
  if (!command) {
    process.stdout.write(JSON.stringify(fail('MISSING_COMMAND', '缺少 command 字段，支持: QueryTable/InsertRow/UpdateRow/DeleteRow')) + '\n');
    return;
  }
  if (!params.table || typeof params.table !== 'string') {
    process.stdout.write(JSON.stringify(fail('MISSING_TABLE', '缺少 params.table 字段')) + '\n');
    return;
  }

  try {
    const result = await executeWithChain(command, params, maid || 'anonymous');
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify(fail(e.code || 'INTERNAL_ERROR', e.message)) + '\n');
  }
}

process.on('SIGTERM', async () => {
  await driver.close();
  process.exit(0);
});