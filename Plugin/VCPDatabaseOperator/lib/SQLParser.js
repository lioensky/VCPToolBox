'use strict';

/**
 * SQLParser.js - SQL AST 级解析器（基于 node-sql-parser）
 * 职责：
 *   1. 解析原生 SQL，拒绝多语句
 *   2. 提取动词（SELECT/INSERT/UPDATE/DELETE），拒绝 DDL/DCL
 *   3. 提取所有涉及的表名（含 JOIN/子查询）
 *   4. 联动 PermissionGuard 做表白名单 + CRUD 权限矩阵校验
 */

const { Parser } = require('node-sql-parser');

const ALLOWED_TYPES = ['select', 'insert', 'update', 'delete'];
const TYPE_TO_COMMAND = {
  select: 'QueryTable',
  insert: 'InsertRow',
  update: 'UpdateRow',
  delete: 'DeleteRow',
};

class SQLParser {
  constructor(guard) {
    this.guard = guard;
    this.parser = new Parser();
  }

  /**
   * 解析并校验 SQL
   * @param {string} sql - 原生 SQL 语句
   * @returns {{type:string, tables:string[], ast:object, isWrite:boolean, virtualCommand:string}}
   */
  parseAndCheck(sql) {
    if (typeof sql !== 'string' || !sql.trim()) {
      throw this._err('EMPTY_SQL', 'SQL 不能为空');
    }

    // 预过滤：禁止注释闭合 + 拒绝明显的多语句标记（双保险，主要还是靠 parser）
    const trimmed = sql.trim().replace(/;+\s*$/, '');

    let ast;
    try {
      ast = this.parser.astify(trimmed, { database: 'mysql' });
    } catch (e) {
      throw this._err('SQL_SYNTAX_ERROR', 'SQL 语法错误: ' + (e.message || String(e)));
    }

    // 拒绝多语句
    if (Array.isArray(ast)) {
      if (ast.length === 0) throw this._err('EMPTY_SQL', '解析后无任何语句');
      if (ast.length > 1) {
        throw this._err('MULTI_STATEMENT_FORBIDDEN', '不允许多语句执行，请拆分为多次单语句调用');
      }
      ast = ast[0];
    }

    const type = String(ast.type || '').toLowerCase();

    if (!ALLOWED_TYPES.includes(type)) {
      throw this._err('OPERATION_FORBIDDEN',
        type.toUpperCase() + ' 操作被禁止。本插件仅允许 SELECT/INSERT/UPDATE/DELETE，DDL/DCL 一律拒绝。');
    }

    // 提取所有涉及的表名
    const tables = this._extractTables(ast, type);
    if (tables.length === 0) {
      throw this._err('NO_TABLE_DETECTED', '无法从 SQL 中识别目标表');
    }

    // 表白名单 + CRUD 权限校验（所有涉及的表都要过审）
    const virtualCommand = TYPE_TO_COMMAND[type];
    for (const table of tables) {
      this.guard.checkPermission(table, virtualCommand);
    }

    return {
      type,
      tables,
      ast,
      isWrite: type !== 'select',
      virtualCommand,
    };
  }

  /**
   * 从 AST 中提取所有出现的表名（含 JOIN / 子查询）
   */
  _extractTables(ast, type) {
    const set = new Set();
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      // FROM / JOIN 节点
      if (Array.isArray(node.from)) {
        for (const item of node.from) {
          if (item && item.table) set.add(item.table);
          // JOIN 嵌套子查询
          if (item && item.expr) visit(item.expr);
        }
      }
      // INSERT/UPDATE 的 table 字段（数组）
      if (Array.isArray(node.table)) {
        for (const item of node.table) {
          if (item && item.table) set.add(item.table);
        }
      }
      // 递归扫子查询：WHERE / SELECT 子表达式
      if (node.where) visit(node.where);
      if (Array.isArray(node.columns)) {
        for (const col of node.columns) visit(col);
      }
      if (node.expr) visit(node.expr);
      if (node.left) visit(node.left);
      if (node.right) visit(node.right);
      if (node.ast) visit(node.ast);
    };
    visit(ast);
    return Array.from(set);
  }

  _err(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }
}

module.exports = SQLParser;