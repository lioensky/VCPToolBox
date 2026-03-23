/**
 * modules/channelHub/utils.js
 * 
 * ChannelHub 通用工具函数
 * 抽离文件读写、路径校验、ID 生成等细节
 * 
 * @description 目标：文件与目录处理逻辑不再分散在服务类中，所有状态文件读写都走统一工具
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { STATE_DIRNAME, AUDIT_DIRNAME, MEDIA_DIRNAME } = require('./constants');

/**
 * 确保目录存在，不存在则创建
 * @param {string} dirPath - 目录路径
 * @returns {Promise<void>}
 */
async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * 读取 JSON 文件
 * @param {string} filePath - 文件路径
 * @param {*} defaultValue - 文件不存在时的默认值
 * @returns {Promise<*>}
 */
async function readJsonFile(filePath, defaultValue = null) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return defaultValue;
    }
    throw error;
  }
}

/**
 * 写入 JSON 文件（格式化）
 * @param {string} filePath - 文件路径
 * @param {*} data - 要写入的数据
 * @returns {Promise<void>}
 */
async function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 追加写入 JSONL 文件
 * @param {string} filePath - 文件路径
 * {object} record - 要追加的记录
 * @returns {Promise<void>}
 */
async function appendJsonLine(filePath, record) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const line = JSON.stringify(record) + '\n';
  await fs.appendFile(filePath, line, 'utf-8');
}

/**
 * 检查路径是否存在
 * @param {string} targetPath - 目标路径
 * @returns {Promise<boolean>}
 */
async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 安全解析路径，确保路径在指定目录内（防止路径遍历攻击）
 * @param {string} basePath - 基础目录
 * @param {string} relativePath - 相对路径
 * @returns {string|null} - 安全的绝对路径，如果不安全返回 null
 */
function resolvePathInside(basePath, relativePath) {
  // 规范化路径
  const normalizedBase = path.resolve(basePath);
  const resolved = path.resolve(basePath, relativePath);
  
  // 检查解析后的路径是否在基础目录内
  if (resolved.startsWith(normalizedBase + path.sep) || resolved === normalizedBase) {
    return resolved;
  }
  return null;
}

/**
 * 生成唯一请求 ID
 * @param {string} [prefix='req'] - 前缀
 * @returns {string}
 */
function createRequestId(prefix = 'req') {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(8).toString('hex');
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * 生成投递任务 ID
 * @returns {string}
 */
function createDeliveryJobId() {
  return createRequestId('job');
}

/**
 * 获取当前时间戳（毫秒）
 * @returns {number}
 */
function nowTimestamp() {
  return Date.now();
}

/**
 * 安全解析 JSON
 * @param {string} str - JSON 字符串
 * @param {*} defaultValue - 解析失败时的默认值
 * @returns {*}
 */
function safeParseJson(str, defaultValue = null) {
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}

/**
 * 构建去重键
 * @param {string} adapterId - 适配器 ID
 * @param {string} eventId - 事件 ID
 * @returns {string}
 */
function buildDedupKey(adapterId, eventId) {
  return `${adapterId}:${eventId}`;
}

/**
 * 构建次级去重键（基于平台消息）
 * @param {string} channel - 通道标识
 * @param {string} conversationId - 会话 ID
 * @param {string} messageId - 消息 ID
 * @returns {string}
 */
function buildSecondaryDedupKey(channel, conversationId, messageId) {
  return `${channel}:${conversationId}:${messageId}`;
}

/**
 * 构建会话绑定键
 * @param {string} channel - 通道标识
 * @param {string} conversationType - 会话类型
 * @param {string} conversationId - 会话 ID
 * @param {string} [userId] - 用户 ID（可选）
 * @returns {string}
 */
function buildBindingKey(channel, conversationType, conversationId, userId = null) {
  if (userId) {
    return `${channel}:${conversationType}:${conversationId}:${userId}`;
  }
  return `${channel}:${conversationType}:${conversationId}`;
}

/**
 * 获取状态文件完整路径
 * @param {string} filename - 文件名
 * @param {string} [baseDir] - 基础目录（默认为项目根目录）
 * @returns {string}
 */
function getStateFilePath(filename, baseDir = process.cwd()) {
  return path.join(baseDir, STATE_DIRNAME, filename);
}

/**
 * 获取审计日志文件完整路径
 * @param {string} [dateStr] - 日期字符串（YYYY-MM-DD），默认今天
 * @param {string} [baseDir] - 基础目录
 * @returns {string}
 */
function getAuditFilePath(dateStr, baseDir = process.cwd()) {
  const date = dateStr || new Date().toISOString().split('T')[0];
  return path.join(baseDir, STATE_DIRNAME, AUDIT_DIRNAME, `${date}.jsonl`);
}

/**
 * 获取媒体文件存储目录
 * @param {string} [baseDir] - 基础目录
 * @returns {string}
 */
function getMediaDir(baseDir = process.cwd()) {
  return path.join(baseDir, STATE_DIRNAME, MEDIA_DIRNAME);
}

/**
 * 延迟执行
 * @param {number} ms - 延迟毫秒数
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 计算重试延迟（指数退避）
 * @param {number} attempt - 当前尝试次数（从 1 开始）
 * @param {number} initialDelay - 初始延迟（毫秒）
 * @param {number} maxDelay - 最大延迟（毫秒）
 * @param {number} multiplier - 退避倍数
 * @returns {number}
 */
function calculateBackoff(attempt, initialDelay = 1000, maxDelay = 30000, multiplier = 2) {
  const delay = initialDelay * Math.pow(multiplier, attempt - 1);
  return Math.min(delay, maxDelay);
}

/**
 * 深拷贝对象
 * @param {*} obj - 要拷贝的对象
 * @returns {*}
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * 截断文本到指定长度
 * @param {string} text - 原文本
 * @param {number} maxLength - 最大长度
 * @param {string} [suffix='...'] - 截断后缀
 * @returns {string}
 */
function truncateText(text, maxLength, suffix = '...') {
  if (!text || text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - suffix.length) + suffix;
}

/**
 * 安全获取嵌套属性
 * @param {object} obj - 对象
 * @param {string} path - 属性路径（用点号分隔）
 * @param {*} [defaultValue=undefined] - 默认值
 * @returns {*}
 */
function getNestedValue(obj, path, defaultValue = undefined) {
  const keys = path.split('.');
  let result = obj;
  
  for (const key of keys) {
    if (result === null || result === undefined || typeof result !== 'object') {
      return defaultValue;
    }
    result = result[key];
  }
  
  return result !== undefined ? result : defaultValue;
}

module.exports = {
  // 文件操作
  ensureDir,
  readJsonFile,
  writeJsonFile,
  appendJsonLine,
  pathExists,
  resolvePathInside,
  
  // ID 生成
  createRequestId,
  createDeliveryJobId,
  
  // 时间
  nowTimestamp,
  
  // JSON 处理
  safeParseJson,
  
  // 去重键
  buildDedupKey,
  buildSecondaryDedupKey,
  
  // 绑定键
  buildBindingKey,
  
  // 路径获取
  getStateFilePath,
  getAuditFilePath,
  getMediaDir,
  
  // 辅助函数
  delay,
  calculateBackoff,
  deepClone,
  truncateText,
  getNestedValue
};
