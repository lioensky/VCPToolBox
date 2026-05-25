/**
 * LogMonitor 共享模块 - 单例导出
 *
 * 用途：为 LinuxLogMonitor 提供统一的日志监控客户端入口
 * 自动检测环境：如果在 stdio 插件子进程内（LOG_MONITOR_SOCK 存在），使用带 token 的 UDS 代理模式
 *
 * @version 1.0.0
 * @author VCP Team
 */

let proxyInstance = null;

/**
 * 获取 LogMonitor 代理实例
 * @returns {LogMonitorProxy|null} 代理实例或 null（未设置环境变量时）
 */
function getLogMonitorProxy() {
    const sock = process.env.LOG_MONITOR_SOCK;
    if (sock) {
        if (!proxyInstance) {
            const { LogMonitorProxy } = require('./proxy');
            proxyInstance = new LogMonitorProxy(sock);
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
    }
}

module.exports = { getLogMonitorProxy, resetLogMonitorProxy };
