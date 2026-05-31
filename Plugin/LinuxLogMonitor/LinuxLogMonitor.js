/**
 * LinuxLogMonitor - 事件驱动的 Linux 日志监控系统
 *
 * 功能特性：
 * - 实时日志流监控（tail -f）
 * - 多规则异常检测（regex/keyword/threshold）
 * - Agent 回调通知
 * - 状态持久化与恢复
 * - 跨进程任务管理（通过文件信号）
 * - 主动日志查询（searchLog、lastErrors、logStats）
 * - 可配置的去重策略
 *
 * @version 1.2.0
 * @author VCP Team
 */

const path = require('path');

// 加载配置
require('dotenv').config({ path: path.join(__dirname, 'config.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', 'config.env') });

// 核心模块
const MonitorManager = require('./core/MonitorManager');

// 环境变量
const DEBUG_MODE = (process.env.DebugMode || 'false').toLowerCase() === 'true';
const CALLBACK_BASE_URL = process.env.CALLBACK_BASE_URL || `http://localhost:${process.env.SERVER_PORT || 5000}`;
const PLUGIN_NAME = 'LinuxLogMonitor';

let directManager = null;
let directManagerInitPromise = null;
let directManagerTransitionPromise = null;
let directManagerMode = null;
let pluginConfig = {};
let monitorManagerFactory = createMonitorManager;

/**
 * 格式化 VCP 标准响应
 * 重要：VCP 核心 Plugin.js 期望的格式是 { status, result }
 * - status: 'success' | 'error'
 * - result: 成功时的数据（VCP 读取此字段）
 * - error: 错误时的消息
 *
 * @param {string} status - 状态: 'success' | 'error'
 * @param {object|null} data - 成功时的数据
 * @param {string|null} error - 错误时的消息
 * @returns {object} VCP 标准格式响应
 */
function formatVCPResponse(status, data = null, error = null) {
    return {
        status: status,
        result: data,  // VCP 核心读取 'result' 字段，不是 'data'
        error: error
    };
}

/**
 * 调试日志
 */
function debugLog(msg, ...args) {
    if (DEBUG_MODE) {
        console.error(`[${PLUGIN_NAME}][Debug] ${msg}`, ...args);
    }
}

/**
 * 信息日志
 */
function infoLog(msg, ...args) {
    console.error(`[${PLUGIN_NAME}] ${msg}`, ...args);
}

function resolveDebugMode(config = {}) {
    if (typeof config.DebugMode === 'boolean') {
        return config.DebugMode;
    }
    if (typeof config.DebugMode === 'string') {
        return config.DebugMode.toLowerCase() === 'true';
    }
    return DEBUG_MODE;
}

function createMonitorManager() {
    return new MonitorManager({
        callbackBaseUrl: pluginConfig.CALLBACK_BASE_URL || CALLBACK_BASE_URL,
        pluginName: PLUGIN_NAME,
        debug: resolveDebugMode(pluginConfig)
    });
}

function getDirectServiceEnvFromGlobals() {
    const serviceEnv = {};
    if (typeof global.__vcp_log_monitor_sock === 'string' && global.__vcp_log_monitor_sock) {
        serviceEnv.LOG_MONITOR_SOCK = global.__vcp_log_monitor_sock;
    }
    if (typeof global.__vcp_log_monitor_token === 'string' && global.__vcp_log_monitor_token) {
        serviceEnv.LOG_MONITOR_TOKEN = global.__vcp_log_monitor_token;
    }
    if (typeof global.__vcp_ssh_manager_sock === 'string' && global.__vcp_ssh_manager_sock) {
        serviceEnv.SSH_MANAGER_SOCK = global.__vcp_ssh_manager_sock;
    }
    if (typeof global.__vcp_ssh_manager_token === 'string' && global.__vcp_ssh_manager_token) {
        serviceEnv.SSH_MANAGER_TOKEN = global.__vcp_ssh_manager_token;
    }
    return serviceEnv;
}

function withDirectServiceEnv(fn) {
    const serviceEnv = getDirectServiceEnvFromGlobals();
    const { runWithLogMonitorServiceEnv } = require('../../modules/LogMonitor');
    const { runWithSSHManagerServiceEnv } = require('../../modules/SSHManager');
    return runWithLogMonitorServiceEnv(serviceEnv, () =>
        runWithSSHManagerServiceEnv(serviceEnv, fn)
    );
}

async function initializeDirectManager(mode) {
    directManager = monitorManagerFactory();
    directManagerMode = mode;
    directManagerInitPromise = withDirectServiceEnv(() => Promise.resolve(directManager.init({ mode })))
        .then(() => {
            directManagerInitPromise = null;
            return directManager;
        })
        .catch(error => {
            directManager = null;
            directManagerMode = null;
            directManagerInitPromise = null;
            throw error;
        });
    return directManagerInitPromise;
}

async function ensureDirectManager(mode = 'readonly') {
    if (directManagerInitPromise) {
        await directManagerInitPromise;
    }

    if (directManagerTransitionPromise) {
        return directManagerTransitionPromise;
    }

    if (!directManager) {
        return initializeDirectManager(mode);
    }

    if (mode === 'full' && directManagerMode !== 'full') {
        if (!directManagerTransitionPromise) {
            directManagerTransitionPromise = (async () => {
                if (directManagerMode === 'full') {
                    return directManager;
                }
                if (directManager) {
                    await directManager.stopAll();
                }
                directManager = null;
                directManagerMode = null;
                return initializeDirectManager('full');
            })().finally(() => {
                directManagerTransitionPromise = null;
            });
        }
        return directManagerTransitionPromise;
    }

    return directManager;
}

async function createCliManager(command) {
    const manager = createMonitorManager();
    const initMode = getInitMode(command);
    debugLog(`初始化模式: ${initMode}`);
    await manager.init({ mode: initMode });
    return manager;
}

function unwrapVCPResponse(response) {
    if (!response || response.status !== 'success') {
        throw new Error(response?.error || 'LinuxLogMonitor 执行失败');
    }
    return response.result;
}

async function dispatchCommand(manager, args, options = {}) {
    const command = args.command || args.action;
    debugLog(`执行命令: ${command}`, args);

    switch (command) {
        case 'start':
            return handleStart(manager, args);

        case 'stop':
            return handleStop(manager, args);

        case 'status':
            return handleStatus(manager, args, options);

        case 'list_rules':
            return handleListRules(manager, args);

        case 'add_rule':
            return handleAddRule(manager, args);

        case 'searchLog':
            return handleSearchLog(manager, args);

        case 'lastErrors':
            return handleLastErrors(manager, args);

        case 'logStats':
            return handleLogStats(manager, args);

        default:
            return formatVCPResponse('error', null, `未知命令: ${command}。可用命令: start, stop, status, list_rules, add_rule, searchLog, lastErrors, logStats`);
    }
}

async function initialize(config = {}) {
    pluginConfig = config || {};
    await ensureDirectManager('readonly');
}

async function processToolCall(args = {}) {
    return withDirectServiceEnv(async () => {
        const command = args.command || args.action;
        const manager = await ensureDirectManager(command === 'start' ? 'full' : 'readonly');
        const response = await dispatchCommand(manager, args, {
            direct: true,
            serviceMode: directManagerMode
        });
        return unwrapVCPResponse(response);
    });
}

async function shutdown() {
    if (!directManager) return;

    await directManager.stopAll();
    directManager = null;
    directManagerInitPromise = null;
    directManagerTransitionPromise = null;
    directManagerMode = null;
}

/**
 * 根据命令确定 init 模式
 * - start: 'full' - 完整初始化，恢复任务，写入 PID
 * - stop: 'signal' - 信号模式，发送停止信号
 * - status/list_rules/add_rule: 'readonly' - 只读模式
 */
function getInitMode(command) {
    switch (command) {
        case 'start':
            return 'full';
        case 'stop':
            return 'signal';
        case 'status':
        case 'list_rules':
        case 'add_rule':
        case 'searchLog':
        case 'lastErrors':
        case 'logStats':
        default:
            return 'readonly';
    }
}

/**
 * 主入口
 */
async function main() {
    infoLog('插件启动...');
    
    let input = '';
    
    // 设置输入超时
    const inputTimeout = setTimeout(() => {
        infoLog('输入超时，未收到任何数据');
        console.log(JSON.stringify(formatVCPResponse('error', null, '插件输入超时，未收到参数数据')));
        process.exit(1);
    }, 10000);
    
    process.stdin.on('data', chunk => {
        clearTimeout(inputTimeout);
        input += chunk;
        debugLog(`收到输入: ${input.substring(0, 100)}...`);
    });
    
    process.stdin.on('end', async () => {
        infoLog('输入结束，开始处理...');
        
        try {
            const args = JSON.parse(input);
            const command = args.command || args.action;
            const manager = await createCliManager(command);
            const result = await dispatchCommand(manager, args, { direct: false });
            
            console.log(JSON.stringify(result));
            
            // 异步插件：start 命令后不退出，保持运行
            if (command === 'start' && result.status === 'success') {
                const taskId = result.result?.taskId || 'unknown';
                infoLog(`监控任务 ${taskId} 已启动，保持运行...`);
                
                // 设置优雅退出处理
                process.on('SIGINT', async () => {
                    infoLog('收到 SIGINT，正在停止所有监控任务...');
                    await manager.stopAll();
                    process.exit(0);
                });
                
                process.on('SIGTERM', async () => {
                    infoLog('收到 SIGTERM，正在停止所有监控任务...');
                    await manager.stopAll();
                    process.exit(0);
                });
                
                // 不退出，让监控任务继续运行
            } else {
                process.exit(result.status === 'success' ? 0 : 1);
            }
            
        } catch (error) {
            infoLog(`处理错误: ${error.message}`);
            const errorData = DEBUG_MODE ? { stack: error.stack } : null;
            console.log(JSON.stringify(formatVCPResponse('error', errorData, error.message)));
            process.exit(1);
        }
    });
}

/**
 * 处理 start 命令 - 启动监控任务
 * 使用 'full' 模式初始化，会恢复之前的任务
 */
async function handleStart(manager, args) {
    const { hostId, logPath, rules, contextLines, afterContextLines } = args;
    
    if (!hostId) {
        return formatVCPResponse('error', null, '缺少必需参数: hostId');
    }
    
    if (!logPath) {
        return formatVCPResponse('error', null, '缺少必需参数: logPath');
    }
    
    try {
        const effectiveContextLines = contextLines ?? 10;
        const effectiveAfterContextLines = afterContextLines ?? effectiveContextLines;
        const taskId = await manager.startMonitor({
            hostId,
            logPath,
            rules: rules || [],
            contextLines: effectiveContextLines,
            afterContextLines: effectiveAfterContextLines
        });
        
        return formatVCPResponse('success', {
            taskId,
            message: `监控任务已启动`,
            config: {
                hostId,
                logPath,
                contextLines: effectiveContextLines,
                afterContextLines: effectiveAfterContextLines,
                rulesCount: (rules || []).length || 'default'
            }
        }, null);
    } catch (error) {
        return formatVCPResponse('error', null, error.message);
    }
}

/**
 * 处理 stop 命令 - 停止监控任务
 * 使用 'signal' 模式，通过文件信号通知运行中的进程停止任务
 */
async function handleStop(manager, args) {
    const { taskId } = args;
    
    if (!taskId) {
        return formatVCPResponse('error', null, '缺少必需参数: taskId');
    }
    
    try {
        // 使用 sendStopSignal 发送停止信号，而不是直接调用 stopMonitor
        // 因为任务可能在另一个进程中运行
        const result = await manager.sendStopSignal(taskId, { timeout: 10000 });
        
        if (result.success) {
            return formatVCPResponse('success', {
                taskId,
                message: '监控任务已停止',
                method: result.method
            }, null);
        } else {
            return formatVCPResponse('error', null, result.error || '停止任务失败');
        }
    } catch (error) {
        return formatVCPResponse('error', null, error.message);
    }
}

/**
 * 处理 status 命令 - 查询状态
 * 使用 'readonly' 模式，从状态文件读取，不启动任务
 */
async function handleStatus(manager, args) {
    try {
        // 使用 getStatusFromFile 从文件读取状态
        // 而不是 getStatus()，以保持 UDS/proxy-backed 查询路径。
        const status = await manager.getStatusFromFile();
        return formatVCPResponse('success', status, null);
    } catch (error) {
        return formatVCPResponse('error', null, error.message);
    }
}

/**
 * 处理 list_rules 命令 - 列出规则
 * 使用 'readonly' 模式
 */
async function handleListRules(manager, args) {
    try {
        const rules = manager.listRules();
        return formatVCPResponse('success', { rules }, null);
    } catch (error) {
        return formatVCPResponse('error', null, error.message);
    }
}

/**
 * 处理 add_rule 命令 - 添加规则
 * 使用 'readonly' 模式（规则保存到文件，下次启动时加载）
 */
async function handleAddRule(manager, args) {
    const { name, type, pattern, severity, cooldown, operator, threshold } = args;
    
    if (!name) {
        return formatVCPResponse('error', null, '缺少必需参数: name');
    }
    
    if (!type) {
        return formatVCPResponse('error', null, '缺少必需参数: type');
    }
    
    if (!pattern) {
        return formatVCPResponse('error', null, '缺少必需参数: pattern');
    }
    
    try {
        const rule = await manager.addRule({
            name,
            type,
            pattern,
            severity: severity || 'warning',
            cooldown: cooldown || 60000,
            operator,
            threshold
        });
        
        return formatVCPResponse('success', {
            message: '规则已添加',
            rule
        }, null);
    } catch (error) {
        return formatVCPResponse('error', null, error.message);
    }
}

/**
 * 处理 searchLog 命令 - 搜索日志文件
 * 使用 'readonly' 模式
 */
async function handleSearchLog(manager, args) {
    const { hostId, logPath, pattern, lines, since, context } = args;
    
    if (!hostId) {
        return formatVCPResponse('error', null, '缺少必需参数: hostId');
    }
    
    if (!logPath) {
        return formatVCPResponse('error', null, '缺少必需参数: logPath');
    }
    
    if (!pattern) {
        return formatVCPResponse('error', null, '缺少必需参数: pattern');
    }
    
    try {
        const result = await manager.searchLog({
            hostId,
            logPath,
            pattern,
            lines: lines || 100,
            since,
            context: context || 0
        });
        
        return formatVCPResponse('success', result, null);
    } catch (error) {
        return formatVCPResponse('error', null, error.message);
    }
}

/**
 * 处理 lastErrors 命令 - 获取最近错误
 * 使用 'readonly' 模式
 */
async function handleLastErrors(manager, args) {
    const { hostId, logPath, count, levels } = args;
    
    if (!hostId) {
        return formatVCPResponse('error', null, '缺少必需参数: hostId');
    }
    
    if (!logPath) {
        return formatVCPResponse('error', null, '缺少必需参数: logPath');
    }
    
    try {
        const result = await manager.lastErrors({
            hostId,
            logPath,
            count: count || 20,
            levels: levels || ['ERROR', 'FATAL', 'CRIT', 'CRITICAL']
        });
        
        return formatVCPResponse('success', result, null);
    } catch (error) {
        return formatVCPResponse('error', null, error.message);
    }
}

/**
 * 处理 logStats 命令 - 日志统计分析
 * 使用 'readonly' 模式
 */
async function handleLogStats(manager, args) {
    const { hostId, logPath, since, groupBy } = args;
    
    if (!hostId) {
        return formatVCPResponse('error', null, '缺少必需参数: hostId');
    }
    
    if (!logPath) {
        return formatVCPResponse('error', null, '缺少必需参数: logPath');
    }
    
    try {
        const result = await manager.logStats({
            hostId,
            logPath,
            since,
            groupBy: groupBy || 'level'
        });
        
        return formatVCPResponse('success', result, null);
    } catch (error) {
        return formatVCPResponse('error', null, error.message);
    }
}

function resetForTests() {
    directManager = null;
    directManagerInitPromise = null;
    directManagerTransitionPromise = null;
    directManagerMode = null;
    pluginConfig = {};
    monitorManagerFactory = createMonitorManager;
}

function setMonitorManagerFactoryForTests(factory) {
    monitorManagerFactory = factory || createMonitorManager;
}

module.exports = {
    initialize,
    processToolCall,
    shutdown,
    _private: {
        dispatchCommand,
        ensureDirectManager,
        getInitMode,
        getDirectServiceEnvFromGlobals,
        resetForTests,
        withDirectServiceEnv,
        setMonitorManagerFactoryForTests
    }
};

if (require.main === module) {
    main();
}
