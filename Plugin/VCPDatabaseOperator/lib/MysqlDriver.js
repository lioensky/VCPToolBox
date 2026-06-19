'use strict';

/**
 * MysqlDriver.js
 * 对应 Druid 连接池管理
 * 职责：连接池创建、执行查询、写操作事务、超时控制、慢查询监控
 */

const mysql = require('mysql2/promise');

class MysqlDriver {
  constructor(config) {
    this._config       = config;
    this._pool         = null;
    this._queryTimeout = parseInt(config.DB_QUERY_TIMEOUT)        || 30000;
    this._slowThreshold= parseInt(config.DB_SLOW_QUERY_THRESHOLD) || 2000;
    this._returnDuration = config.DB_RETURN_DURATION === 'true';
    this._maxResponseBytes = parseInt(config.DB_MAX_RESPONSE_BYTES) || 5242880;
  }

  // 懒初始化连接池（对应Druid连接池配置）
  _getPool() {
    if (!this._pool) {
      this._pool = mysql.createPool({
        host:               this._config.DB_HOST,
        port:               parseInt(this._config.DB_PORT) || 3306,
        user:               this._config.DB_USER,
        password:           this._config.DB_PASSWORD,
        database:           this._config.DB_NAME,
        charset:            this._config.DB_CHARSET || 'utf8mb4',
        timezone:           this._config.DB_TIMEZONE || '+08:00',
        connectionLimit:    parseInt(this._config.DB_POOL_SIZE) || 5,
        connectTimeout:     parseInt(this._config.DB_POOL_ACQUIRE_TIMEOUT) || 5000,
        // 对应漏洞11修复：连接保活，防断线假死
        enableKeepAlive:    true,
        keepAliveInitialDelay: parseInt(this._config.DB_KEEPALIVE_INTERVAL) || 10000,
        waitForConnections: true,
        queueLimit:         0,
      });
    }
    return this._pool;
  }

  // 执行查询（只读，对应漏洞4修复：pool.execute自动归还连接）
  async executeQuery(sql, params) {
    const pool      = this._getPool();
    const startTime = Date.now();
    let rows;

    try {
      // 超时控制（对应Druid查询超时）
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('SQL执行超过' + this._queryTimeout + 'ms已强制终止，请缩小查询范围'), { code: 'QUERY_TIMEOUT' })),
          this._queryTimeout)
      );
      const queryPromise = pool.execute(sql, params);
      [rows] = await Promise.race([queryPromise, timeoutPromise]);
    } catch (e) {
      // 对应漏洞5修复：错误信息脱敏，不透传mysql原始错误
      throw this._sanitizeError(e);
    }

    const duration = Date.now() - startTime;
    const warning  = duration > this._slowThreshold ? 'SLOW_QUERY' : null;

    // 对应漏洞7修复：返回数据大小限制
    const responseStr = JSON.stringify(rows);
    if (Buffer.byteLength(responseStr, 'utf8') > this._maxResponseBytes) {
      throw Object.assign(new Error('返回数据超过大小限制(' + (this._maxResponseBytes / 1048576).toFixed(1) + 'MB)，请缩小查询范围或指定具体列'), { code: 'RESPONSE_TOO_LARGE' });
    }

    return { rows, duration, warning };
  }

  // 执行写操作（带事务，对应@Transactional + 漏洞4修复：finally归还连接）
  async executeWrite(sql, params) {
    const pool      = this._getPool();
    const startTime = Date.now();
    const conn      = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('SQL执行超时已强制终止'), { code: 'QUERY_TIMEOUT' })),
          this._queryTimeout)
      );
      const [result] = await Promise.race([conn.execute(sql, params), timeoutPromise]);

      await conn.commit();
      const duration = Date.now() - startTime;
      const warning  = duration > this._slowThreshold ? 'SLOW_QUERY' : null;
      return { result, duration, warning };
    } catch (e) {
      // 失败自动回滚，不留脏数据（对应@Transactional rollback）
      await conn.rollback();
      throw this._sanitizeError(e);
    } finally {
      // 对应漏洞4修复：finally保证连接必归还
      conn.release();
    }
  }

  // 执行COUNT预估（用于写操作影响行数检查）
  async executeCount(sql, params) {
    const pool = this._getPool();
    try {
      const [rows] = await pool.execute(sql, params);
      return parseInt(rows[0].cnt) || 0;
    } catch (e) {
      throw this._sanitizeError(e);
    }
  }

  // 错误信息脱敏（对应漏洞5修复：不暴露库结构）
  _sanitizeError(e) {
    if (e.code === 'QUERY_TIMEOUT' || e.code === 'RESPONSE_TOO_LARGE') return e;
    // mysql2原始错误码映射为语义化错误，不透传原始message
    const codeMap = {
      'ER_NO_SUCH_TABLE':      { code: 'TABLE_NOT_FOUND',    message: '目标表不存在，请检查表名配置' },
      'ER_BAD_FIELD_ERROR':    { code: 'COLUMN_NOT_FOUND',   message: '指定的列名不存在，请检查列名' },
      'ER_DUP_ENTRY':          { code: 'DUPLICATE_ENTRY',    message: '数据重复，违反唯一约束' },
      'ER_DATA_TOO_LONG':      { code: 'DATA_TOO_LONG',      message: '数据超过字段最大长度' },
      'ER_ACCESS_DENIED_ERROR':{ code: 'DB_AUTH_FAILED',     message: '数据库认证失败，请检查账号密码配置' },
      'ECONNREFUSED':          { code: 'DB_CONNECT_FAILED',  message: '无法连接数据库，请检查主机和端口配置' },
      'ETIMEDOUT':             { code: 'DB_CONNECT_TIMEOUT', message: '连接数据库超时' },
    };
    const mapped = codeMap[e.code];
    if (mapped) {
      return Object.assign(new Error(mapped.message), { code: mapped.code });
    }
    // 未知错误：只返回通用提示，原始错误写stderr供运维排查
    process.stderr.write('[VCPDatabaseOperator] DB Error: ' + e.message + ' (code: ' + e.code + ')\n');
    return Object.assign(new Error('数据库操作失败，请检查参数或联系管理员'), { code: 'QUERY_FAILED' });
  }

  async close() {
    if (this._pool) {
      await this._pool.end();
      this._pool = null;
    }
  }
}

module.exports = MysqlDriver;