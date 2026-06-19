'use strict';

/**
 * SQLBuilder.js
 * 对应 MyBatis SqlSource + TypeHandler
 * 职责：结构化参数 → 参数化SQL，所有值走占位符，禁止字符串拼接值
 */

// 对应 MyBatis TypeHandler：值类型强校验
function sanitizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!isFinite(value)) throw mkErr('TYPE_ERROR', '数字值不合法(Infinity/NaN)');
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) throw mkErr('TYPE_ERROR', '日期值不合法');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 65535) throw mkErr('TYPE_ERROR', '字符串值超过最大长度(65535字符)');
    return value;
  }
  const str = String(value);
  if (str.length > 65535) throw mkErr('TYPE_ERROR', '值超过最大长度限制');
  return str;
}

// 嵌套深度校验（对应漏洞13修复）
function checkDepth(obj, max, cur) {
  cur = cur || 0;
  if (cur > max) throw mkErr('OBJECT_TOO_DEEP', '对象嵌套深度不能超过' + max + '层');
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const v of Object.values(obj)) checkDepth(v, max, cur + 1);
  }
}

// LIMIT/OFFSET 夹紧（对应漏洞3修复）
function clampLimitOffset(limit, offset, maxRows) {
  return {
    safeLimit:  Math.min(Math.max(parseInt(limit)  || 100, 1), maxRows),
    safeOffset: Math.min(Math.max(parseInt(offset) || 0,   0), 1000000),
  };
}

// IN数组校验（对应漏洞12修复）
function validateInArray(arr) {
  if (!Array.isArray(arr))  throw mkErr('INVALID_IN_VALUE',   '$in 必须是数组');
  if (arr.length === 0)     throw mkErr('EMPTY_IN_ARRAY',     '$in 数组不能为空');
  if (arr.length > 1000)    throw mkErr('IN_ARRAY_TOO_LARGE', '$in 数组长度不能超过1000');
  return arr.map(v => sanitizeValue(v));
}

function mkErr(code, message) {
  const e = new Error(message);
  e.code  = code;
  return e;
}

class SQLBuilder {
  constructor(guard, config) {
    this._guard   = guard;
    this._maxRows = parseInt(config.DB_MAX_ROWS) || 1000;
  }

  // 构建 WHERE 子句（支持等值 + $in + null判断）
  _buildWhere(where) {
    if (!where || Object.keys(where).length === 0) {
      return { whereClause: '', whereParams: [] };
    }
    this._guard.validateWhereKeys(where);
    checkDepth(where, 3);

    const clauses = [];
    const params  = [];

    for (const [key, value] of Object.entries(where)) {
      const safeKey = this._guard.validateIdentifier(key, 'WHERE字段名');
      if (value && typeof value === 'object' && !Array.isArray(value) && value.$in) {
        const safeArr = validateInArray(value.$in);
        clauses.push(safeKey + ' IN (' + safeArr.map(() => '?').join(', ') + ')');
        params.push(...safeArr);
      } else if (value === null) {
        clauses.push(safeKey + ' IS NULL');
      } else {
        clauses.push(safeKey + ' = ?');
        params.push(sanitizeValue(value));
      }
    }

    return { whereClause: clauses.join(' AND '), whereParams: params };
  }

  // 构建 SELECT
  buildSelect(params) {
    const { table, columns, where, order_by, limit, offset } = params;
    const safeTable  = this._guard.validateIdentifier(table, '表名');
    const safeCols   = this._guard.validateColumns(columns, table);
    const { whereClause, whereParams } = this._buildWhere(where);
    const orderClause = this._guard.validateOrderBy(order_by);
    const { safeLimit, safeOffset } = clampLimitOffset(limit, offset, this._maxRows);

    let sql = 'SELECT ' + safeCols.join(', ') + ' FROM ' + safeTable;
    if (whereClause) sql += ' WHERE ' + whereClause;
    if (orderClause) sql += ' ORDER BY ' + orderClause;
    // safeLimit/safeOffset 已经是 parseInt+clamp 过的安全整数
    // 直接内联进 SQL，避免部分 MySQL 版本不支持 LIMIT/OFFSET 使用 ? 占位符的问题
    sql += ' LIMIT ' + safeLimit + ' OFFSET ' + safeOffset;

    return { sql, params: [...whereParams] };
  }

  // 构建 INSERT
  buildInsert(params) {
    const { table, values } = params;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw mkErr('INVALID_VALUES', 'values 必须是对象');
    }
    checkDepth(values, 2);
    const keys = Object.keys(values);
    if (keys.length === 0) throw mkErr('EMPTY_VALUES',    'values 不能为空');
    if (keys.length > 50)  throw mkErr('TOO_MANY_FIELDS', '单次插入字段数不能超过50个');

    const safeTable = this._guard.validateIdentifier(table, '表名');
    const safeCols  = keys.map(k => this._guard.validateIdentifier(k, '字段名'));
    const safeVals  = keys.map(k => sanitizeValue(values[k]));
    const sql = 'INSERT INTO ' + safeTable +
      ' (' + safeCols.join(', ') + ')' +
      ' VALUES (' + keys.map(() => '?').join(', ') + ')';
    return { sql, params: safeVals };
  }

  // 构建 UPDATE
  buildUpdate(params) {
    const { table, set, where } = params;
    if (!set || typeof set !== 'object' || Array.isArray(set)) {
      throw mkErr('INVALID_SET', 'set 必须是对象');
    }
    if (!where || Object.keys(where).length === 0) {
      throw mkErr('WHERE_REQUIRED', 'UPDATE 操作必须提供 where 条件，禁止全表更新');
    }
    checkDepth(set, 2);
    const keys = Object.keys(set);
    if (keys.length === 0) throw mkErr('EMPTY_SET',       'set 不能为空');
    if (keys.length > 50)  throw mkErr('TOO_MANY_FIELDS', 'set 字段数不能超过50个');

    const safeTable  = this._guard.validateIdentifier(table, '表名');
    const setClauses = keys.map(k => this._guard.validateIdentifier(k, 'SET字段名') + ' = ?');
    const setParams  = keys.map(k => sanitizeValue(set[k]));
    const { whereClause, whereParams } = this._buildWhere(where);

    const sql = 'UPDATE ' + safeTable +
      ' SET ' + setClauses.join(', ') +
      ' WHERE ' + whereClause;
    return { sql, params: [...setParams, ...whereParams] };
  }

  // 构建 DELETE
  buildDelete(params) {
    const { table, where } = params;
    if (!where || Object.keys(where).length === 0) {
      throw mkErr('WHERE_REQUIRED', 'DELETE 操作必须提供 where 条件，禁止全表删除');
    }
    const safeTable = this._guard.validateIdentifier(table, '表名');
    const { whereClause, whereParams } = this._buildWhere(where);
    const sql = 'DELETE FROM ' + safeTable + ' WHERE ' + whereClause;
    return { sql, params: whereParams };
  }

  // 构建 COUNT（用于写操作影响行数预估）
  buildCount(table, where) {
    const safeTable = this._guard.validateIdentifier(table, '表名');
    const { whereClause, whereParams } = this._buildWhere(where);
    let sql = 'SELECT COUNT(*) AS cnt FROM ' + safeTable;
    if (whereClause) sql += ' WHERE ' + whereClause;
    return { sql, params: whereParams };
  }
}

module.exports = SQLBuilder;