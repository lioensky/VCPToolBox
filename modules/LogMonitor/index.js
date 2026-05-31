/**
 * LogMonitor 共享模块 - 单例导出
 *
 * 用途：为 LinuxLogMonitor 提供统一的日志监控客户端入口
 * 自动检测环境：如果在 stdio 插件子进程内（LOG_MONITOR_SOCK 存在），使用带 token 的 UDS 代理模式
 *
 * @version 1.0.0
 * @author VCP Team
 */

const { AsyncLocalStorage } = require('async_hooks');

let proxyInstance = null;
const serviceEnvStorage = new AsyncLocalStorage();

function getServiceEnvValue(key) {
    const serviceEnv = serviceEnvStorage.getStore();
    if (serviceEnv && typeof serviceEnv[key] === 'string' && serviceEnv[key]) {
        return serviceEnv[key];
    }
    return process.env[key];
}

function runWithLogMonitorServiceEnv(serviceEnv, fn) {
    return serviceEnvStorage.run({ ...(serviceEnv || {}) }, fn);
}

function hasLogMonitorServiceEnv() {
    return Boolean(getServiceEnvValue('LOG_MONITOR_SOCK'));
}

/**
 * 获取 LogMonitor 代理实例
 * @returns {LogMonitorProxy|null} 代理实例或 null（未设置环境变量时）
 */
function getLogMonitorProxy() {
    const sock = getServiceEnvValue('LOG_MONITOR_SOCK');
    const token = getServiceEnvValue('LOG_MONITOR_TOKEN') || '';
    if (sock) {
        if (
            proxyInstance &&
            (proxyInstance.sockPath !== sock || proxyInstance.authToken !== token)
        ) {
            resetLogMonitorProxy();
        }
        if (!proxyInstance) {
            const { LogMonitorProxy } = require('./proxy');
            proxyInstance = new LogMonitorProxy(sock, token);
        }
        return proxyInstance;
    }
    resetLogMonitorProxy();
    // 未设置环境变量 → 返回 null（后续由调用方处理 fallback）
    return null;
}

/**
 * 重置 LogMonitor 代理实例
 */
function resetLogMonitorProxy() {
    if (proxyInstance) {
        proxyInstance.destroy();
        proxyInstance = null;
    }
}

module.exports = {
    getLogMonitorProxy,
    hasLogMonitorServiceEnv,
    resetLogMonitorProxy,
    runWithLogMonitorServiceEnv
};
