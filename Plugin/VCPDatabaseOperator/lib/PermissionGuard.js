'use strict';

/**
 * PermissionGuard.js
 * 对应 MyBatis 权限拦截器 + Druid WallFilter
 * 职责：表白名单校验 + CRUD权限位校验 + 标识符安全校验
 */

// 权限组预设 (启动时冻结，运行时不可篡改)
const PERMISSION_GROUPS = Object.freeze({
  READONLY:    Object.freeze({ S: true,  I: false, U: false, D: false }),
  READ_INSERT: Object.freeze({ S: true,  I: true,  U: false, D: false }),
  READ_WRITE:  Object.freeze({ S: true,  I: true,  U: true,  D: false }),
  FULL:        Object.freeze({ S: true,  I: true,  U: true,  D: true  }),
});

// 命令 → 权限位映射
const COMMAND_PERMISSION_MAP = Object.freeze({
  QueryTable: 'S',
  InsertRow:  'I',
  UpdateRow:  'U',
  DeleteRow:  'D',
});

// 标识符正则：只允许字母数字下划线（对应MyBatis ${}白名单）
const IDENTIFIER_REGEX = /^[a-zA-Z0-9_]+$/;

// ORDER BY 方向枚举白名单
const ORDER_DIRECTION_WHITELIST = Object.freeze(['ASC', 'DESC']);

class PermissionGuard {
  constructor(config) {
    this._matrix         = Object.freeze(this._buildMatrix(config));
    this._excludeColumns = Object.freeze(this._buildExcludeColumns(config));
    this._lazyColumns    = Object.freeze(this._buildLazyColumns(config));
  }

  _buildMatrix(config) {
    const matrix = {};
    for (const [key, value] of Object.entries(config)) {
      if (!key.startsWith('DB_TABLE_')) continue;
      const tableName = key.slice(9);
      if (!IDENTIFIER_REGEX.test(tableName)) {
        throw new Error(`配置错误: 表名 "${tableName}" 含非法字符`);
      }
      const group = value.trim().toUpperCase();
      if (!PERMISSION_GROUPS[group]) {
        throw new Error(`配置错误: 表 "${tableName}" 的权限组 "${group}" 不存在，可选: READONLY/READ_INSERT/READ_WRITE/FULL`);
      }
      matrix[tableName] = PERMISSION_GROUPS[group];
    }
    if (Object.keys(matrix).length === 0) {
      throw new Error('配置错误: 未配置任何表白名单，请至少配置一个 DB_TABLE_xxx=权限组');
    }
    return matrix;
  }

  _buildExcludeColumns(config) {
    const result = {};
    for (const [key, value] of Object.entries(config)) {
      if (!key.startsWith('DB_EXCLUDE_COLUMNS_')) continue;
      const tableName = key.slice(19);
      result[tableName] = value.split(',').map(f => f.trim()).filter(Boolean);
    }
    return result;
  }

  _buildLazyColumns(config) {
    const result = {};
    for (const [key, value] of Object.entries(config)) {
      if (!key.startsWith('DB_LAZY_COLUMNS_')) continue;
      const tableName = key.slice(16);
      result[tableName] = value.split(',').map(f => f.trim()).filter(Boolean);
    }
    return result;
  }

  // 闸1：表白名单
  checkTableAllowed(table) {
    if (!this._matrix[table]) {
      throw this._err('TABLE_NOT_ALLOWED', `表 "${table}" 不在白名单中，操作被拒绝`);
    }
  }

  // 闸2：CRUD权限位
  checkPermission(table, command) {
    this.checkTableAllowed(table);
    const permBit = COMMAND_PERMISSION_MAP[command];
    if (!permBit) throw this._err('UNKNOWN_COMMAND', `未知命令: ${command}`);
    if (!this._matrix[table][permBit]) {
      throw this._err('PERMISSION_DENIED',
        `表 "${table}" 的权限组 [${this._getGroupName(table)}] 不允许执行 ${command} 操作`);
    }
  }

  // 闸3：标识符安全校验（对应MyBatis ${}白名单 + 反引号包裹）
  validateIdentifier(name, context) {
    if (typeof name !== 'string' || !IDENTIFIER_REGEX.test(name)) {
      throw this._err('INVALID_IDENTIFIER', `${context} "${name}" 含非法字符，只允许字母数字下划线`);
    }
    return `\`${name}\``;
  }

  validateColumns(columns, table) {
    if (!Array.isArray(columns) || columns.length === 0) return ['*'];
    if (columns.length > 50) throw this._err('TOO_MANY_COLUMNS', '单次查询列数不能超过50个');
    return columns.map(col => this.validateIdentifier(col, '列名'));
  }

  // ORDER BY 结构化校验（对应漏洞2修复）
  validateOrderBy(orderBy) {
    if (!orderBy) return null;
    if (typeof orderBy !== 'object' || Array.isArray(orderBy)) {
      throw this._err('INVALID_ORDER_BY', 'order_by 必须是对象格式，如 {"created_at":"DESC"}');
    }
    const result = [];
    for (const [field, direction] of Object.entries(orderBy)) {
      const safeField = this.validateIdentifier(field, 'ORDER BY字段');
      const safeDir   = String(direction).toUpperCase();
      if (!ORDER_DIRECTION_WHITELIST.includes(safeDir)) {
        throw this._err('INVALID_ORDER_DIRECTION', `排序方向只允许 ASC 或 DESC，收到: ${direction}`);
      }
      result.push(`${safeField} ${safeDir}`);
    }
    return result.join(', ');
  }

  // WHERE key 校验（对应漏洞1修复：二阶注入防护）
  validateWhereKeys(where) {
    if (!where || typeof where !== 'object') return;
    const keys = Object.keys(where);
    if (keys.length > 20) throw this._err('TOO_MANY_WHERE_CONDITIONS', 'WHERE条件不能超过20个');
    for (const key of keys) this.validateIdentifier(key, 'WHERE字段名');
  }

  // 过滤敏感字段（对应MyBatis ResultMap）
  filterResultColumns(rows, table) {
    const excludes = this._excludeColumns[table] || [];
    if (excludes.length === 0) return rows;
    return rows.map(row => {
      const filtered = Object.assign({}, row);
      for (const col of excludes) delete filtered[col];
      return filtered;
    });
  }

  getLazyColumns(table)  { return this._lazyColumns[table]    || []; }
  getExcludeColumns(table) { return this._excludeColumns[table] || []; }

  _getGroupName(table) {
    const p = this._matrix[table];
    for (const [name, g] of Object.entries(PERMISSION_GROUPS)) {
      if (g.S === p.S && g.I === p.I && g.U === p.U && g.D === p.D) return name;
    }
    return 'UNKNOWN';
  }

  _err(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }
}

module.exports = PermissionGuard;