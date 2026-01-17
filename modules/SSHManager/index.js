/**
 * SSHManager 共享模块 - 单例导出
 *
 * 用途：为 LinuxShellExecutor 和 LinuxLogMonitor 提供统一的 SSH 连接管理
 *
 * @version 1.1.0
 * @author VCP Team
 */

const path = require('path');
const fs = require('fs');

let SSHManagerClass = null;
let instance = null;
let hostsConfig = null;

let lastError = null;
let lastConfigPath = null;
let lastConfigError = null;
let lastClassPath = null;
let lastClassError = null;

/**
 * 加载主机配置
 * @returns {Object} 主机配置对象
 */
function loadHostsConfig() {
    if (hostsConfig) return hostsConfig;

    lastConfigPath = null;
    lastConfigError = null;
    
    // 配置文件搜索路径（优先级从高到低）
    const configPaths = [
        path.join(__dirname, 'hosts.json'),  // 共享模块目录
        path.join(__dirname, '..', '..', 'Plugin', 'LinuxShellExecutor', 'hosts.json')  // LinuxShellExecutor 目录
    ];
    
    for (const configPath of configPaths) {
        try {
            if (fs.existsSync(configPath)) {
                // 清除 require 缓存以支持热重载
                delete require.cache[require.resolve(configPath)];
                hostsConfig = require(configPath);
                lastConfigPath = configPath;
                console.error(`[SSHManager Module] 加载主机配置: ${configPath}`);
                return hostsConfig;
            }
        } catch (e) {
            lastClassError = e.message;
            lastConfigError = e.message;
            console.error(`[SSHManager Module] 无法加载配置 ${configPath}: ${e.message}`);
        }
    }
    
    // 默认配置（仅本地执行）
    console.error('[SSHManager Module] 未找到主机配置文件，使用默认配置');
    hostsConfig = {
        hosts: {
            local: {
                name: '本地执行',
                type: 'local',
                enabled: true,
                securityLevel: 'standard'
            }
        },
        defaultHost: 'local',
        globalSettings: {
            connectionPoolSize: 5,
            maxConcurrentConnections: 10,
            connectionTimeout: 30000,
            keepAliveInterval: 10000,
            retryAttempts: 3,
            retryDelay: 1000
        }
    };
    
    return hostsConfig;
}

/**
 * 加载 SSHManager 类
 * @returns {Function|null} SSHManager 类或 null
 */
function loadSSHManagerClass() {
    if (SSHManagerClass) return SSHManagerClass;

    lastClassPath = null;
    lastClassError = null;
    
    // SSHManager 类文件搜索路径
    const classPaths = [
        path.join(__dirname, 'SSHManager.js'),  // 共享模块目录
        path.join(__dirname, '..', '..', 'Plugin', 'LinuxShellExecutor', 'ssh', 'SSHManager.js')  // LinuxShellExecutor 目录
    ];
    
    for (const classPath of classPaths) {
        try {
            if (fs.existsSync(classPath)) {
                // 清除 require 缓存以支持热重载
                delete require.cache[require.resolve(classPath)];
                SSHManagerClass = require(classPath);
                lastClassPath = classPath;
                console.error(`[SSHManager Module] 加载 SSHManager 类: ${classPath}`);
                return SSHManagerClass;
            }
        } catch (e) {
            console.error(`[SSHManager Module] 无法加载 SSHManager 类 ${classPath}: ${e.message}`);
        }
    }
    
    console.error('[SSHManager Module] 未找到 SSHManager 类文件');
    lastClassError = lastClassError || '未找到 SSHManager 类文件';
    return null;
}

/**
 * 获取 SSHManager 单例实例
 * @param {Object} [providedConfig] 可选的主机配置，若提供则优先使用
 * @param {Object} [options] 初始化选项，如 { basePath: __dirname }
 * @returns {Object|null} SSHManager 实例或 null
 */
function getSSHManager(providedConfig = null, options = {}) {
    if (instance) return instance;

    lastError = null;
    
    const ManagerClass = loadSSHManagerClass();
    if (!ManagerClass) {
        lastError = `无法创建 SSHManager 实例：类未加载 (${lastClassError || 'unknown'})`;
        console.error('[SSHManager Module] 无法创建 SSHManager 实例：类未加载');
        return null;
    }
    
    // 优先级：显式提供的配置 > 自动加载的配置
    const config = providedConfig || loadHostsConfig();
    
    try {
        // 将 config 和 options (包含 basePath) 传递给构造函数
        instance = new ManagerClass(config, options);
        console.error('[SSHManager Module] 创建新的 SSHManager 单例实例', options.basePath ? `(basePath: ${options.basePath})` : '');
        return instance;
    } catch (e) {
        lastError = e.message;
        console.error(`[SSHManager Module] 创建 SSHManager 实例失败: ${e.message}`);
        return null;
    }
}

/**
 * 重置 SSHManager 实例（用于测试或重新加载配置）
 * @returns {Promise<void>}
 */
async function resetSSHManager() {
    if (instance) {
        try {
            if (typeof instance.disconnectAll === 'function') {
                await instance.disconnectAll();
            }
            console.error('[SSHManager Module] SSHManager 实例已断开所有连接');
        } catch (e) {
            console.error(`[SSHManager Module] 断开连接时出错: ${e.message}`);
        }
        
        instance = null;
        hostsConfig = null;
        SSHManagerClass = null;
        console.error('[SSHManager Module] SSHManager 实例已重置');
    }
}

/**
 * 获取主机配置（只读）
 * @returns {Object} 主机配置对象的副本
 */
function getHostsConfig() {
    const config = loadHostsConfig();
    return JSON.parse(JSON.stringify(config));  // 返回深拷贝，防止外部修改
}

/**
 * 重新加载配置（不重置连接）
 * @returns {Object} 新的主机配置
 */
function reloadConfig() {
    hostsConfig = null;
    return loadHostsConfig();
}

/**
 * 检查 SSH 模块是否可用
 * @returns {boolean}
 */
function isAvailable() {
    return loadSSHManagerClass() !== null;
}

/**
 * 获取模块状态信息
 * @returns {Object} 状态信息
 */
function getStatus() {
    return {
        available: isAvailable(),
        instanceCreated: instance !== null,
        configLoaded: hostsConfig !== null,
        activeConnections: instance ? (instance.getActiveConnectionCount?.() || 0) : 0,
        lastError,
        configPath: lastConfigPath,
        configError: lastConfigError,
        classPath: lastClassPath,
        classError: lastClassError
    };
}

module.exports = {
    getSSHManager,
    resetSSHManager,
    getHostsConfig,
    reloadConfig,
    isAvailable,
    getStatus,
    // 导出类本身，供需要独立实例的场景使用
    get SSHManager() {
        return loadSSHManagerClass();
    }
};
