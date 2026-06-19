'use strict';

/**
 * DatabaseOperatorService.js - hybridservice 入口
 * v1.0.2: SQL-First 重构
 *   - 新增 ExecuteSQL：AI 直接写 SQL，AST 解析后过五道安全闸
 *   - 保留 QueryTable/InsertRow/UpdateRow/DeleteRow（兼容旧调用）
 * 标准合约: initialize / shutdown / processToolCall
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'config.env') });

const PermissionGuard = require('./lib/PermissionGuard');
const RateLimiter     = require('./lib/RateLimiter');
const SQLBuilder      = require('./lib/SQLBuilder');
const MysqlDriver     = require('./lib/MysqlDriver');
const SQLParser       = require('./lib/SQLParser');

let guard, limiter, builder, driver, sqlParser;
let DEBUG_MODE       = false;
let WRITE_MAX_AFFECT = 100;
let RETURN_DURATION  = false;
let MAX_ROWS         = 1000;
let initialized      = false;

// ============ 命令别名表（容错低算力模型，仅命令名层，安全边界不放宽） ============
const COMMAND_ALIAS = {
  // 推荐路径：所有泛义查询导向 ExecuteSQL（最强、最简单）
  'executesql':   'ExecuteSQL',
  'execute_sql':  'ExecuteSQL',
  'sql':          'ExecuteSQL',
  'query':        'ExecuteSQL',
  'select':       'ExecuteSQL',
  'rawsql':       'ExecuteSQL',
  'raw_sql':      'ExecuteSQL',
  'run':          'ExecuteSQL',
  'exec':         'ExecuteSQL',
  // 结构化命令同义词
  'querytable':   'QueryTable',
  'query_table':  'QueryTable',
  'find':         'QueryTable',
  'list':         'QueryTable',
  'get':          'QueryTable',
  'insertrow':    'InsertRow',
  'insert_row':   'InsertRow',
  'insert':       'InsertRow',
  'create':       'InsertRow',
  'add':          'InsertRow',
  'updaterow':    'UpdateRow',
  'update_row':   'UpdateRow',
  'update':       'UpdateRow',
  'modify':       'UpdateRow',
  'set':          'UpdateRow',
  'deleterow':    'DeleteRow',
  'delete_row':   'DeleteRow',
  'delete':       'DeleteRow',
  'remove':       'DeleteRow',
  'drop_row':     'DeleteRow'
};

// 错误回执推荐示例（自带教学，让低算力模型一次自纠错）
const RECOMMENDED_EXAMPLE = {
  tool_name: 'VCPDatabaseOperator',
  command: 'ExecuteSQL',
  maid: '调用方Agent名',
  sql: 'SELECT * FROM sys_access_log ORDER BY id DESC LIMIT 10'
};
const SUPPORTED_COMMANDS = ['ExecuteSQL', 'QueryTable', 'InsertRow', 'UpdateRow', 'DeleteRow'];

function initialize(config, dependencies) {
  DEBUG_MODE = String((config && config.DebugMode) || 'false').toLowerCase() === 'true';
  try {
    guard     = new PermissionGuard(process.env);
    limiter   = new RateLimiter(process.env);
    driver    = new MysqlDriver(process.env);
    builder   = new SQLBuilder(guard, process.env);
    sqlParser = new SQLParser(guard);
    WRITE_MAX_AFFECT = parseInt(process.env.DB_WRITE_MAX_AFFECT_ROWS) || 100;
    RETURN_DURATION  = process.env.DB_RETURN_DURATION === 'true';
    MAX_ROWS         = parseInt(process.env.DB_MAX_ROWS) || 1000;
    initialized = true;
    console.log('[VCPDatabaseOperator] Initialized successfully (SQL-First mode enabled).');
  } catch (e) {
    console.error('[VCPDatabaseOperator] Initialization failed: ' + e.message);
    throw e;
  }
}

function shutdown() {
  if (driver && typeof driver.close === 'function') {
    driver.close().catch(function(){});
  }
  console.log('[VCPDatabaseOperator] Shutdown complete.');
}

function throwToolError(message) {
  // 若 message 已是 JSON 对象字符串（富错误），直接透传，避免双重包裹
  if (typeof message === 'string' && message.charAt(0) === '{') {
    throw new Error(message);
  }
  throw new Error(JSON.stringify({ plugin_error: String(message || 'VCPDatabaseOperator unknown error') }));
}

function createTextResult(obj) {
  return {
    content: [{
      type: 'text',
      text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
    }]
  };
}

// ============ 旧版结构化命令路由（兼容保留 + 平铺友好） ============
async function executeStructured(command, params, maid) {
  // 双轨参数兼容：低算力模型可平铺写 table=xxx limit=10，等价于 params:{table,limit}
  const p = (params && typeof params === 'object' && Object.keys(params).length > 0) ? params : {};
  const table = p.table;
  if (!table || typeof table !== 'string') {
    throwToolError(JSON.stringify({
      plugin_error: command + ' 缺少 table 字段',
      hint: '可以平铺写在顶层 (table:"xxx") 或包在 params 对象内 (params:{table:"xxx"})，两种都支持',
      example_flat: {
        tool_name: 'VCPDatabaseOperator',
        command: command,
        table: 'sys_access_log',
        limit: 10
      },
      example_nested: {
        tool_name: 'VCPDatabaseOperator',
        command: command,
        params: { table: 'sys_access_log', limit: 10 }
      },
      tips: '推荐直接用 ExecuteSQL 命令写原生 SQL，更简单'
    }));
  }
  // 后续逻辑统一用 p（兼容平铺与嵌套）
  params = p;
  guard.checkPermission(table, command);
  limiter.check(maid, command);

  switch (command) {
    case 'QueryTable': {
      const built = builder.buildSelect(params);
      const r = await driver.executeQuery(built.sql, built.params);
      const filtered = guard.filterResultColumns(r.rows, table);
      const out = { status: 'success', rows: filtered, count: filtered.length };
      if (r.warning) out.warning = r.warning;
      if (RETURN_DURATION) out.duration_ms = r.duration;
      return out;
    }
    case 'InsertRow': {
      const built = builder.buildInsert(params);
      const r = await driver.executeWrite(built.sql, built.params);
      const out = { status: 'success', inserted_id: r.result.insertId, affected_rows: r.result.affectedRows };
      if (r.warning) out.warning = r.warning;
      if (RETURN_DURATION) out.duration_ms = r.duration;
      return out;
    }
    case 'UpdateRow': {
      if (!params.confirm) {
        const cnt_built = builder.buildCount(table, params.where);
        const cnt = await driver.executeCount(cnt_built.sql, cnt_built.params);
        if (cnt > WRITE_MAX_AFFECT) {
          return {
            status: 'error',
            code: 'WRITE_AFFECT_TOO_MANY',
            message: '此操作将影响 ' + cnt + ' 行，超过安全阈值(' + WRITE_MAX_AFFECT + '行)，如需继续请带 confirm:true 重试',
            affected_rows_estimate: cnt
          };
        }
      }
      const built = builder.buildUpdate(params);
      const r = await driver.executeWrite(built.sql, built.params);
      const out = { status: 'success', affected_rows: r.result.affectedRows };
      if (r.warning) out.warning = r.warning;
      if (RETURN_DURATION) out.duration_ms = r.duration;
      return out;
    }
    case 'DeleteRow': {
      if (!params.confirm) {
        const cnt_built = builder.buildCount(table, params.where);
        const cnt = await driver.executeCount(cnt_built.sql, cnt_built.params);
        if (cnt > WRITE_MAX_AFFECT) {
          return {
            status: 'error',
            code: 'WRITE_AFFECT_TOO_MANY',
            message: '此操作将影响 ' + cnt + ' 行，超过安全阈值(' + WRITE_MAX_AFFECT + '行)，如需继续请带 confirm:true 重试',
            affected_rows_estimate: cnt
          };
        }
      }
      const built = builder.buildDelete(params);
      const r = await driver.executeWrite(built.sql, built.params);
      const out = { status: 'success', affected_rows: r.result.affectedRows };
      if (r.warning) out.warning = r.warning;
      if (RETURN_DURATION) out.duration_ms = r.duration;
      return out;
    }
    default:
      throwToolError('未知命令: ' + command);
  }
}

// ============ ExecuteSQL 路由（SQL-First 主入口） ============
async function executeSQL(args, maid) {
  const sql = args.sql;
  if (typeof sql !== 'string' || !sql.trim()) {
    throwToolError('ExecuteSQL 缺少 sql 字段（必需，原生 MySQL 语句）');
  }

  // sql_params 解析：支持 JSON 字符串或数组
  let sqlParams = args.sql_params;
  if (sqlParams === undefined || sqlParams === null || sqlParams === '') {
    sqlParams = [];
  } else if (typeof sqlParams === 'string') {
    try {
      sqlParams = JSON.parse(sqlParams);
    } catch (e) {
      throwToolError('sql_params 必须是 JSON 数组或合法 JSON 字符串: ' + e.message);
    }
  }
  if (!Array.isArray(sqlParams)) {
    throwToolError('sql_params 必须是数组');
  }

  // 闸 ①②③④：解析 SQL → 拒绝多语句/DDL → 提取表 → 校验白名单+CRUD权限
  const parsed = sqlParser.parseAndCheck(sql);
  // parsed: { type, tables, ast, isWrite, virtualCommand }

  // 频率限制（按虚拟命令分桶）
  limiter.check(maid, parsed.virtualCommand);

  // 闸 ⑤：写操作熔断（UPDATE/DELETE 用 EXPLAIN 预估影响行数）
  const isUpdateOrDelete = parsed.type === 'update' || parsed.type === 'delete';
  if (isUpdateOrDelete && !args.confirm) {
    const explained = await estimateAffectRows(sql, sqlParams);
    if (explained > WRITE_MAX_AFFECT) {
      return {
        status: 'error',
        code: 'WRITE_AFFECT_TOO_MANY',
        message: '此操作预估将影响 ' + explained + ' 行，超过安全阈值(' + WRITE_MAX_AFFECT + '行)，如需继续请带 confirm:true 重试',
        affected_rows_estimate: explained,
        sql_type: parsed.type.toUpperCase(),
        target_tables: parsed.tables
      };
    }
  }

  // 实际执行
  if (parsed.type === 'select') {
    const r = await driver.executeQuery(sql, sqlParams);
    let rows = r.rows;
    let truncated = false;
    if (Array.isArray(rows) && rows.length > MAX_ROWS) {
      rows = rows.slice(0, MAX_ROWS);
      truncated = true;
    }
    // 过滤敏感字段（多表联查时按所有命中表逐一过滤）
    for (const t of parsed.tables) {
      rows = guard.filterResultColumns(rows, t);
    }
    const out = {
      status: 'success',
      mode: 'sql',
      sql_type: 'SELECT',
      target_tables: parsed.tables,
      rows: rows,
      count: rows.length
    };
    if (truncated) out.truncated = { original_count: r.rows.length, returned: MAX_ROWS };
    if (r.warning) out.warning = r.warning;
    if (RETURN_DURATION) out.duration_ms = r.duration;
    return out;
  } else {
    // INSERT/UPDATE/DELETE 走写事务
    const r = await driver.executeWrite(sql, sqlParams);
    const out = {
      status: 'success',
      mode: 'sql',
      sql_type: parsed.type.toUpperCase(),
      target_tables: parsed.tables,
      affected_rows: r.result.affectedRows
    };
    if (parsed.type === 'insert' && r.result.insertId !== undefined) {
      out.inserted_id = r.result.insertId;
    }
    if (r.warning) out.warning = r.warning;
    if (RETURN_DURATION) out.duration_ms = r.duration;
    return out;
  }
}

// 用 EXPLAIN 预估 UPDATE/DELETE 影响行数
async function estimateAffectRows(sql, sqlParams) {
  try {
    const explainSQL = 'EXPLAIN ' + sql;
    const r = await driver.executeQuery(explainSQL, sqlParams);
    if (Array.isArray(r.rows) && r.rows.length > 0) {
      // 累加所有执行计划行的 rows 字段
      let total = 0;
      for (const row of r.rows) {
        const v = row && (row.rows !== undefined ? row.rows : row.ROWS);
        if (typeof v === 'number') total += v;
        else if (typeof v === 'string' && /^\d+$/.test(v)) total += parseInt(v);
      }
      return total;
    }
    return 0;
  } catch (e) {
    // EXPLAIN 失败时保守返回 0（让操作通过），真实失败会在执行阶段被捕获
    if (DEBUG_MODE) console.error('[VCPDatabaseOperator] EXPLAIN failed: ' + e.message);
    return 0;
  }
}

// ============ 总路由 ============
async function processToolCall(args) {
  if (!initialized) {
    throwToolError('插件尚未完成初始化');
  }
  if (!args || typeof args !== 'object') {
    throwToolError('参数对象缺失');
  }

  const rawCommand = args.command;
  const maid       = args.maid || 'anonymous';

  if (!rawCommand || typeof rawCommand !== 'string') {
    throwToolError(JSON.stringify({
      plugin_error: '缺少 command 字段',
      supported: SUPPORTED_COMMANDS,
      example_recommended: RECOMMENDED_EXAMPLE,
      tips: '推荐使用 ExecuteSQL 命令直接写 SQL，无需记忆参数结构'
    }));
  }

  // 命令别名归一化（容错大小写、下划线、同义词）
  const aliasKey = String(rawCommand).toLowerCase().replace(/[\s\-]+/g, '_').replace(/_+/g, '_');
  const command = COMMAND_ALIAS[aliasKey] || COMMAND_ALIAS[String(rawCommand).toLowerCase()] || rawCommand;
  const aliasResolved = (command !== rawCommand) ? { alias_resolved: rawCommand + ' → ' + command } : null;

  try {
    if (command === 'ExecuteSQL') {
      const result = await executeSQL(args, maid);
      if (aliasResolved) Object.assign(result, aliasResolved);
      return createTextResult(result);
    }

    // 旧版结构化命令
    let params = args.params;
    if (typeof params === 'string') {
      try {
        params = JSON.parse(params);
      } catch (e) {
        throwToolError(JSON.stringify({
          plugin_error: 'params 字段必须是 JSON 对象或合法 JSON 字符串',
          parse_error: e.message,
          hint: '也可以不用 params，直接平铺：command:QueryTable, table:"xxx", limit:10',
          example_recommended: RECOMMENDED_EXAMPLE
        }));
      }
    }
    params = params || {};

    // 平铺回退：如果 params 为空 但 args 顶层有 table/values/where 等字段，直接把 args 当 params
    // 低算力模型常忘记 params 包裹，这里无损兼容（command/maid/sql/sql_params 不属于 params 字段）
    if (Object.keys(params).length === 0) {
      const FLAT_EXCLUDED = new Set(['command', 'maid', 'sql', 'sql_params', 'params']);
      const flatArgs = {};
      for (const k of Object.keys(args)) {
        if (!FLAT_EXCLUDED.has(k)) flatArgs[k] = args[k];
      }
      if (Object.keys(flatArgs).length > 0) params = flatArgs;
    }

    if (SUPPORTED_COMMANDS.indexOf(command) >= 0 && command !== 'ExecuteSQL') {
      const result = await executeStructured(command, params, maid);
      if (aliasResolved) Object.assign(result, aliasResolved);
      return createTextResult(result);
    }

    // 未知命令——给完整教学回执
    const lower = String(rawCommand).toLowerCase();
    let didYouMean = 'ExecuteSQL';
    if (lower.indexOf('insert') >= 0 || lower.indexOf('add') >= 0 || lower.indexOf('create') >= 0) didYouMean = 'InsertRow';
    else if (lower.indexOf('update') >= 0 || lower.indexOf('modify') >= 0 || lower.indexOf('set') >= 0) didYouMean = 'UpdateRow';
    else if (lower.indexOf('delete') >= 0 || lower.indexOf('remove') >= 0 || lower.indexOf('drop') >= 0) didYouMean = 'DeleteRow';
    else if (lower.indexOf('list') >= 0 || lower.indexOf('find') >= 0 || lower.indexOf('get') >= 0) didYouMean = 'QueryTable';

    throwToolError(JSON.stringify({
      plugin_error: '未知命令: ' + rawCommand,
      did_you_mean: didYouMean,
      supported: SUPPORTED_COMMANDS,
      example_recommended: RECOMMENDED_EXAMPLE,
      tips: '推荐用 ExecuteSQL 直接写 SQL；命令名大小写不敏感，支持别名（query/sql/select 都会路由到 ExecuteSQL）'
    }));
  } catch (e) {
    if (e && e.message && e.message.charAt(0) === '{') {
      throw e;
    }
    throwToolError((e && e.message) ? e.message : String(e));
  }
}

module.exports = {
  initialize,
  shutdown,
  processToolCall
};