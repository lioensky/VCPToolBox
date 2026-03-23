/**
 * modules/channelHub/StateStore.js
 * 
 * ChannelHub 状态存储统一入口
 * 管理 state/channelHub/ 下所有状态文件的读写
 * 
 * @description 目标：其他服务类不直接操作 state/channelHub/*，所有状态写入都落到统一入口
 * 
 * 管理文件：
 * - state/channelHub/adapters.json
 * - state/channelHub/identity-map.json
 * - state/channelHub/dedup-cache.json
 * - state/channelHub/sessions.jsonl
 * - state/channelHub/outbox.jsonl
 * - state/channelHub/tasks.jsonl
 * - state/channelHub/audit/*.jsonl
 */

const path = require('path');
const { 
  ensureDir, 
  readJsonFile, 
  writeJsonFile, 
  appendJsonLine, 
  pathExists,
  getStateFilePath,
  getAuditFilePath,
  createRequestId
} = require('./utils');
const { 
  STATE_DIRNAME, 
  AUDIT_DIRNAME, 
  MEDIA_DIRNAME,
  CHANNEL_HUB_STATE_VERSION 
} = require('./constants');
const { StateStoreError } = require('./errors');

/**
 * 默认适配器配置结构
 */
const DEFAULT_ADAPTERS = {
  version: CHANNEL_HUB_STATE_VERSION,
  adapters: {},
  lastUpdated: null
};

/**
 * 默认身份映射结构
 */
const DEFAULT_IDENTITY_MAP = {
  version: CHANNEL_HUB_STATE_VERSION,
  mappings: {},
  lastUpdated: null
};

/**
 * 默认去重缓存结构
 */
const DEFAULT_DEDUP_CACHE = {
  version: CHANNEL_HUB_STATE_VERSION,
  entries: {},
  lastCleanup: null
};

/**
 * StateStore 类
 * 所有状态文件读写的统一入口
 */
class StateStore {
  /**
   * @param {object} options - 配置选项
   * @param {string} [options.baseDir] - 基础目录（默认项目根目录）
   * @param {boolean} [options.debugMode] - 调试模式
   */
  constructor(options = {}) {
    this.baseDir = options.baseDir || process.cwd();
    this.debugMode = options.debugMode || false;
    this.stateDir = path.join(this.baseDir, STATE_DIRNAME);
    
    // 写入锁，防止并发写入
    this._writeLocks = new Map();
  }

  /**
   * 初始化状态存储（确保目录和文件存在）
   */
  async initialize() {
    try {
      // 创建主目录
      await ensureDir(this.stateDir);
      
      // 创建子目录
      await ensureDir(path.join(this.stateDir, AUDIT_DIRNAME));
      await ensureDir(path.join(this.stateDir, MEDIA_DIRNAME));
      
      // 初始化 JSON 文件（如果不存在）
      const adaptersPath = path.join(this.stateDir, 'adapters.json');
      if (!await pathExists(adaptersPath)) {
        await writeJsonFile(adaptersPath, DEFAULT_ADAPTERS);
      }
      
      const identityMapPath = path.join(this.stateDir, 'identity-map.json');
      if (!await pathExists(identityMapPath)) {
        await writeJsonFile(identityMapPath, DEFAULT_IDENTITY_MAP);
      }
      
      const dedupCachePath = path.join(this.stateDir, 'dedup-cache.json');
      if (!await pathExists(dedupCachePath)) {
        await writeJsonFile(dedupCachePath, DEFAULT_DEDUP_CACHE);
      }
      
      // 创建空的 JSONL 文件（如果不存在）
      const jsonlFiles = ['sessions.jsonl', 'outbox.jsonl', 'tasks.jsonl'];
      for (const filename of jsonlFiles) {
        const filePath = path.join(this.stateDir, filename);
        if (!await pathExists(filePath)) {
          await appendJsonLine(filePath, { 
            _init: true, 
            version: CHANNEL_HUB_STATE_VERSION,
            createdAt: Date.now()
          });
        }
      }
      
      if (this.debugMode) {
        console.log('[StateStore] 初始化完成，状态目录:', this.stateDir);
      }
      
      return true;
    } catch (error) {
      throw new StateStoreError(`StateStore 初始化失败: ${error.message}`, {
        cause: error
      });
    }
  }

  // ==================== 适配器管理 ====================

  /**
   * 获取适配器配置
   * @returns {Promise<object>}
   */
  async getAdapters() {
    const filePath = path.join(this.stateDir, 'adapters.json');
    return await readJsonFile(filePath, DEFAULT_ADAPTERS);
  }

  /**
   * 保存适配器配置
   * @param {object} data - 适配器数据
   */
  async saveAdapters(data) {
    const filePath = path.join(this.stateDir, 'adapters.json');
    const payload = Array.isArray(data)
      ? {
          version: CHANNEL_HUB_STATE_VERSION,
          adapters: Object.fromEntries(data.filter(item => item?.adapterId).map(item => [item.adapterId, item])),
          lastUpdated: Date.now()
        }
      : {
          ...data,
          lastUpdated: Date.now()
        };
    await writeJsonFile(filePath, payload);
  }

  // ==================== 身份映射管理 ====================

  /**
   * 获取身份映射
   * @returns {Promise<object>}
   */
  async getIdentityMap() {
    const filePath = path.join(this.stateDir, 'identity-map.json');
    return await readJsonFile(filePath, DEFAULT_IDENTITY_MAP);
  }

  /**
   * 保存身份映射
   * @param {object} data - 身份映射数据
   */
  async saveIdentityMap(data) {
    const filePath = path.join(this.stateDir, 'identity-map.json');
    data.lastUpdated = Date.now();
    await writeJsonFile(filePath, data);
  }

  // ==================== 去重缓存管理 ====================

  /**
   * 获取去重缓存
   * @returns {Promise<object>}
   */
  async getDedupCache() {
    const filePath = path.join(this.stateDir, 'dedup-cache.json');
    return await readJsonFile(filePath, DEFAULT_DEDUP_CACHE);
  }

  /**
   * 保存去重缓存
   * @param {object} data - 去重缓存数据
   */
  async saveDedupCache(data) {
    const filePath = path.join(this.stateDir, 'dedup-cache.json');
    data.lastCleanup = data.lastCleanup || Date.now();
    await writeJsonFile(filePath, data);
  }

  // ==================== 会话记录管理 (JSONL) ====================

  /**
   * 追加会话记录
   * @param {object} record - 会话记录
   */
  async appendSession(record) {
    const filePath = path.join(this.stateDir, 'sessions.jsonl');
    record._timestamp = Date.now();
    await appendJsonLine(filePath, record);
  }

  /**
   * 查询会话记录
   * @param {object} filter - 过滤条件
   * @param {string} [filter.bindingKey] - 绑定键
   * @param {string} [filter.channel] - 通道
   * @param {number} [filter.limit=100] - 返回条数限制
   * @returns {Promise<Array>}
   */
  async querySessions(filter = {}) {
    const filePath = path.join(this.stateDir, 'sessions.jsonl');
    
    if (!await pathExists(filePath)) {
      return [];
    }
    
    const fs = require('fs');
    const readline = require('readline');
    const results = [];
    
    const fileStream = fs.createReadStream(filePath, 'utf-8');
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    // 从后往前读取，获取最新记录
    const allRecords = [];
    for await (const line of rl) {
      if (line.trim()) {
        try {
          const record = JSON.parse(line);
          if (!record._init) {
            allRecords.push(record);
          }
        } catch (e) {
          // 跳过解析错误的行
        }
      }
    }
    
    // 反转并过滤
    allRecords.reverse();
    
    const seenBindingKeys = new Set();

    for (const record of allRecords) {
      if (record.bindingKey) {
        if (seenBindingKeys.has(record.bindingKey)) continue;
        seenBindingKeys.add(record.bindingKey);
      }

      if (filter.bindingKey && record.bindingKey !== filter.bindingKey) continue;
      if (filter.channel && record.channel !== filter.channel && record.platform !== filter.channel) continue;
      if (filter.platform && record.platform !== filter.platform) continue;
      if (filter.adapterId && record.adapterId !== filter.adapterId) continue;
      if (filter.agentId && record.agentId !== filter.agentId) continue;
      if (filter.userId && record.userId !== filter.userId) continue;
      if (filter.deleted !== undefined && Boolean(record.deleted) !== Boolean(filter.deleted)) continue;
      
      results.push(record);
      if (results.length >= (filter.limit || 100)) break;
    }
    
    return results;
  }

  // ==================== 出站任务管理 (JSONL) ====================

  /**
   * 追加出站任务
   * @param {object} job - 任务对象
   */
  async appendOutboxJob(job) {
    const filePath = path.join(this.stateDir, 'outbox.jsonl');
    job._timestamp = Date.now();
    await appendJsonLine(filePath, job);
  }

  /**
   * 更新出站任务状态
   * @param {string} jobId - 任务 ID
   * @param {object} patch - 更新字段
   */
  async updateOutboxJob(jobId, patch) {
    const filePath = path.join(this.stateDir, 'outbox.jsonl');
    
    if (!await pathExists(filePath)) {
      throw new StateStoreError(`出站任务文件不存在`);
    }
    
    // 读取所有记录
    const fs = require('fs');
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    
    let found = false;
    const updatedLines = lines.map(line => {
      if (!line.trim()) return line;
      try {
        const record = JSON.parse(line);
        if (record.jobId === jobId) {
          found = true;
          return JSON.stringify({ ...record, ...patch, _updatedAt: Date.now() });
        }
      } catch (e) {}
      return line;
    });
    
    if (!found) {
      throw new StateStoreError(`出站任务不存在: ${jobId}`);
    }
    
    await fs.promises.writeFile(filePath, updatedLines.join('\n'), 'utf-8');
  }

  /**
   * 查询出站任务
   * @param {object} filter - 过滤条件
   * @returns {Promise<Array>}
   */
  async queryOutbox(filter = {}) {
    const filePath = path.join(this.stateDir, 'outbox.jsonl');
    
    if (!await pathExists(filePath)) {
      return [];
    }
    
    const fs = require('fs');
    const readline = require('readline');
    const results = [];
    
    const fileStream = fs.createReadStream(filePath, 'utf-8');
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    const allRecords = [];
    for await (const line of rl) {
      if (line.trim()) {
        try {
          const record = JSON.parse(line);
          if (!record._init) {
            allRecords.push(record);
          }
        } catch (e) {}
      }
    }
    
    allRecords.reverse();

    const offset = filter.offset || 0;
    let skipped = 0;

    const seenJobIds = new Set();

    for (const record of allRecords) {
      if (record.jobId) {
        if (seenJobIds.has(record.jobId)) continue;
        seenJobIds.add(record.jobId);
      }

      if (filter.status && record.status !== filter.status) continue;
      if (filter.adapterId && record.adapterId !== filter.adapterId) continue;

      if (skipped < offset) {
        skipped += 1;
        continue;
      }

      results.push(record);
      if (results.length >= (filter.limit || 100)) break;
    }
    
    return results;
  }

  // ==================== 任务历史管理 (JSONL) ====================

  /**
   * 追加任务记录
   * @param {object} record - 任务记录
   */
  async appendTask(record) {
    const filePath = path.join(this.stateDir, 'tasks.jsonl');
    record._timestamp = Date.now();
    await appendJsonLine(filePath, record);
  }

  /**
   * 查询任务记录
   * @param {object} filter - 过滤条件
   * @returns {Promise<Array>}
   */
  async queryTasks(filter = {}) {
    const filePath = path.join(this.stateDir, 'tasks.jsonl');
    
    if (!await pathExists(filePath)) {
      return [];
    }
    
    const fs = require('fs');
    const readline = require('readline');
    const results = [];
    
    const fileStream = fs.createReadStream(filePath, 'utf-8');
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    const allRecords = [];
    for await (const line of rl) {
      if (line.trim()) {
        try {
          const record = JSON.parse(line);
          if (!record._init) {
            allRecords.push(record);
          }
        } catch (e) {}
      }
    }
    
    allRecords.reverse();
    
    for (const record of allRecords) {
      if (filter.requestId && record.requestId !== filter.requestId) continue;
      
      results.push(record);
      if (results.length >= (filter.limit || 100)) break;
    }
    
    return results;
  }

  // ==================== 审计日志管理 ====================

  /**
   * 追加审计记录
   * @param {string} type - 审计类型
   * @param {object} record - 审计记录
   */
  async appendAuditRecord(type, record) {
    const filePath = getAuditFilePath(undefined, this.baseDir);
    record._type = type;
    record._timestamp = Date.now();
    await appendJsonLine(filePath, record);
  }

  /**
   * 查询审计记录
   * @param {object} filter - 过滤条件
   * @param {string} [filter.requestId] - 请求 ID
   * @param {string} [filter.type] - 审计类型
   * @param {string} [filter.date] - 日期 (YYYY-MM-DD)
   * @param {number} [filter.limit=100] - 返回条数限制
   * @returns {Promise<Array>}
   */
  async queryAudit(filter = {}) {
    // 确定要查询的文件
    let filePath;
    if (filter.date) {
      filePath = getAuditFilePath(filter.date, this.baseDir);
    } else {
      filePath = getAuditFilePath(undefined, this.baseDir);
    }
    
    if (!await pathExists(filePath)) {
      return [];
    }
    
    const fs = require('fs');
    const readline = require('readline');
    const results = [];
    
    const fileStream = fs.createReadStream(filePath, 'utf-8');
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    const allRecords = [];
    for await (const line of rl) {
      if (line.trim()) {
        try {
          allRecords.push(JSON.parse(line));
        } catch (e) {}
      }
    }
    
    allRecords.reverse();
    
    for (const record of allRecords) {
      if (filter.requestId && record.requestId !== filter.requestId) continue;
      if (filter.type && record._type !== filter.type) continue;
      
      results.push(record);
      if (results.length >= (filter.limit || 100)) break;
    }
    
    return results;
  }

  /**
   * 按请求 ID 获取完整追踪链
   * @param {string} requestId - 请求 ID
   * @returns {Promise<Array>}
   */
  async getTraceByRequestId(requestId) {
    // 搜索最近几天的审计日志
    const results = [];
    const today = new Date();
    
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      const records = await this.queryAudit({
        requestId,
        date: dateStr,
        limit: 1000
      });
      
      results.push(...records);
      
      // 如果找到了足够的记录，可以提前结束
      if (records.length > 0) {
        break;
      }
    }
    
    // 按时间排序
    results.sort((a, b) => (a._timestamp || 0) - (b._timestamp || 0));
    
    return results;
  }
}

module.exports = StateStore;
