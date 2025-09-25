// modules/logger.js
const fsSync = require('fs');
const path = require('path');

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
    const now = new Date();
    const timestamp = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}_${now.getMilliseconds().toString().padStart(3, '0')}`;
    currentServerLogPath = path.join(DEBUG_LOG_DIR, `ServerLog-${timestamp}.txt`);
    
    try {
        fsSync.writeFileSync(currentServerLogPath, `[${new Date().toLocaleString()}] Server log started.\n`, 'utf-8');
        serverLogWriteStream = fsSync.createWriteStream(currentServerLogPath, { flags: 'a' });
        originalConsoleLog(`[ServerSetup] 服务器日志将记录到: ${currentServerLogPath}`);
    } catch (error) {
        originalConsoleError(`[ServerSetup] 初始化服务器日志文件失败: ${currentServerLogPath}`, error);
        serverLogWriteStream = null;
    }
}

function formatLogMessage(level, args) {
    const timestamp = new Date().toLocaleString();
    const safeStringify = (obj) => {
        const cache = new Set();
        return JSON.stringify(obj, (key, value) => {
            if (typeof value === 'object' && value !== null) {
                if (cache.has(value)) {
                    return '[Circular]';
                }
                cache.add(value);
            }
            return value;
        }, 2);
    };
    const message = args.map(arg => (typeof arg === 'object' ? safeStringify(arg) : String(arg))).join(' ');
    return `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
}

function writeToLogFile(formattedMessage) {
    if (serverLogWriteStream) {
        serverLogWriteStream.write(formattedMessage, (err) => {
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
    originalConsoleError
};