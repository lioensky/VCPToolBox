/**
 * 简单的日志工具
 */

/**
 * 创建日志器
 * @param {string} level - 日志级别 (debug, info, warn, error)
 * @returns {Object} 日志器实例
 */
export function createLogger(level = 'info') {
  const levels = ['debug', 'info', 'warn', 'error'];
  const current = levels.indexOf(level.toLowerCase());

  const enabled = (target) => levels.indexOf(target) >= current;

  return {
    debug(...args) {
      if (enabled('debug')) {
        const timestamp = new Date().toISOString();
        console.debug(`[${timestamp}] [DEBUG]`, ...args);
      }
    },
    info(...args) {
      if (enabled('info')) {
        const timestamp = new Date().toISOString();
        console.info(`[${timestamp}] [INFO]`, ...args);
      }
    },
    warn(...args) {
      if (enabled('warn')) {
        const timestamp = new Date().toISOString();
        console.warn(`[${timestamp}] [WARN]`, ...args);
      }
    },
    error(...args) {
      if (enabled('error')) {
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] [ERROR]`, ...args);
      }
    },
  };
}