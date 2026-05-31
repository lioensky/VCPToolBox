/**
 * LogMonitor 共享模块 - 单例导出
 *
 * 用途：为 LinuxLogMonitor 提供统一的日志监控客户端入口
 * 自动检测环境：stdio 子进程读取 LOG_MONITOR_SOCK；hybrid/direct 模块读取主进程 global 中的 UDS 信息。
 *
 * @version 1.0.0
 * @author VCP Team
 */

let proxyInstance = null;
let proxySockPath = null;
let proxyAuthToken = null;

/**
 * 获取 LogMonitor 代理实例
 * @returns {LogMonitorProxy|null} 代理实例或 null（未设置环境变量时）
 */
function getLogMonitorProxy() {
    const sock = process.env.LOG_MONITOR_SOCK || global.__vcp_log_monitor_sock;
    if (sock) {
        const authToken = process.env.LOG_MONITOR_TOKEN || global.__vcp_log_monitor_token || '';
        if (proxyInstance && (proxySockPath !== sock || proxyAuthToken !== authToken)) {
            proxyInstance.destroy();
            proxyInstance = null;
        }

        if (!proxyInstance) {
            const { LogMonitorProxy } = require('./proxy');
            proxyInstance = new LogMonitorProxy(sock, authToken);
            proxySockPath = sock;
            proxyAuthToken = authToken;
        }
        return proxyInstance;
    }
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
        proxySockPath = null;
        proxyAuthToken = null;
    }
}

module.exports = { getLogMonitorProxy, resetLogMonitorProxy };
