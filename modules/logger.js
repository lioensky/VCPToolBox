// modules/logger.js
const fsSync = require('fs');
const path = require('path');

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';

const DEBUG_LOG_DIR = path.join(path.dirname(__dirname), 'DebugLog');
let currentServerLogPath = '';
let serverLogWriteStream = null;

// 保存原始 console 方法
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleInfo = console.info;

function ensureDebugLogDirSync() {
  if (!fsSync.existsSync(DEBUG_LOG_DIR)) {
    try {
      fsSync.mkdirSync(DEBUG_LOG_DIR, { recursive: true });
      originalConsoleLog(`[ServerSetup] DebugLog 目录已创建: ${DEBUG_LOG_DIR}`);
    } catch (error) {
      originalConsoleError(`[ServerSetup] 创建 DebugLog 目录失败: ${DEBUG_LOG_DIR}`, error);
    }
  }
}

function initializeServerLogger() {
  ensureDebugLogDirSync();

  // 诊断日志：确认时区配置
  originalConsoleLog(`[LoggerSetup] 使用的默认时区: ${DEFAULT_TIMEZONE}`);

  // 使用 Intl.DateTimeFormat 格式化时间戳，确保使用配置的时区
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: DEFAULT_TIMEZONE,
  });

  // 格式化输出: MM/DD/YYYY, HH:MM:SS
  const parts = formatter.formatToParts(now);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const hour = parts.find(p => p.type === 'hour').value;
  const minute = parts.find(p => p.type === 'minute').value;
  const second = parts.find(p => p.type === 'second').value;

  // 重新构建文件名时间戳 (YYYYMMDD_HHMMSS_ms)
  const timestamp = `${year}${month}${day}_${hour}${minute}${second}_${now
    .getMilliseconds()
    .toString()
    .padStart(3, '0')}`;
  currentServerLogPath = path.join(DEBUG_LOG_DIR, `ServerLog-${timestamp}.txt`);

  try {
    // 使用配置的时区格式化日志启动时间
    const logStartTime = new Date().toLocaleString('zh-CN', { timeZone: DEFAULT_TIMEZONE });
    fsSync.writeFileSync(currentServerLogPath, `[${logStartTime}] Server log started.\n`, 'utf-8');
    serverLogWriteStream = fsSync.createWriteStream(currentServerLogPath, { flags: 'a' });
    originalConsoleLog(`[ServerSetup] 服务器日志将记录到: ${currentServerLogPath}`);
  } catch (error) {
    originalConsoleError(`[ServerSetup] 初始化服务器日志文件失败: ${currentServerLogPath}`, error);
    serverLogWriteStream = null;
  }
}

function formatLogMessage(level, args) {
  // 使用配置的时区格式化日志时间戳
  const timestamp = new Date().toLocaleString('zh-CN', { timeZone: DEFAULT_TIMEZONE });
  const safeStringify = obj => {
    const cache = new Set();
    return JSON.stringify(
      obj,
      (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (cache.has(value)) {
            return '[Circular]';
          }
          cache.add(value);
        }
        return value;
      },
      2,
    );
  };
  const message = args.map(arg => (typeof arg === 'object' ? safeStringify(arg) : String(arg))).join(' ');
  return `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
}

function writeToLogFile(formattedMessage) {
  if (serverLogWriteStream) {
    serverLogWriteStream.write(formattedMessage, err => {
      if (err) {
        originalConsoleError('[Logger] 写入日志文件失败:', err);
      }
    });
  }
}

function overrideConsole() {
  console.log = (...args) => {
    originalConsoleLog.apply(console, args);
    const formattedMessage = formatLogMessage('log', args);
    writeToLogFile(formattedMessage);
  };

  console.error = (...args) => {
    originalConsoleError.apply(console, args);
    const formattedMessage = formatLogMessage('error', args);
    writeToLogFile(formattedMessage);
  };

  console.warn = (...args) => {
    originalConsoleWarn.apply(console, args);
    const formattedMessage = formatLogMessage('warn', args);
    writeToLogFile(formattedMessage);
  };

  console.info = (...args) => {
    originalConsoleInfo.apply(console, args);
    const formattedMessage = formatLogMessage('info', args);
    writeToLogFile(formattedMessage);
  };
}

function getServerLogPath() {
  return currentServerLogPath;
}

function getLogWriteStream() {
  return serverLogWriteStream;
}

module.exports = {
  initializeServerLogger,
  overrideConsole,
  getServerLogPath,
  getLogWriteStream,
  originalConsoleLog,
  originalConsoleError,
};
