
/**
 * MonitorTask - 单个监控任务实例
 *
 * 负责：
 * - UDS 代理模式：通过 LogMonitorProxy 调用 Server（v1.4.0 默认）
 * - Legacy 模式：管理单个 SSH 流式会话（fallback）
 * - 上下文维护（before/after 上下文）
 * - 状态机管理
 * - 日志去重（可配置策略）
 * - 异常上下文增强（v1.3.0）
 *
 * @version 1.4.0
 *
 * v1.4.0 更新：
 * - 新增 UDS 代理模式，优先通过 LogMonitorProxy 调用 Server
 * - 保留 legacy tail -f 模式作为 fallback
 * - Server 模式下移除看门狗、旁路探测、重连逻辑（Server 内部处理）
 *
 * v1.3.0 更新：
 * - 新增 after 上下文收集机制
 * - 新增 pendingAnomalies 队列管理待完成的异常
 * - 新增 onAnomaly 回调，传递完整的 before/after 上下文
 * - 回调 payload 结构增强：context.before[], context.after[]
 * - 新增 registerAnomaly() 方法供外部调用
 * - 新增 getContextBefore() 方法返回数组格式上下文
 */

const path = require('path');
const crypto = require('crypto');
const util = require('util');

let loggerModule = null;

function isServerLoggerActive() {
    try {
        loggerModule = loggerModule || require('../../../modules/logger');
        return Boolean(
            loggerModule.originalConsoleError &&
            console.error !== loggerModule.originalConsoleError
        );
    } catch (_) {
        return false;
    }
}

function logInfo(...args) {
    if (isServerLoggerActive()) {
        console.info(...args);
        return;
    }
    process.stderr.write(`${util.format(...args)}\n`);
}

// ==================== 状态枚举 (MEU-1.2) ====================
const TaskState = {
    IDLE: 'IDLE',               // 空闲，未启动
    CONNECTING: 'CONNECTING',   // 正在连接
    CONNECTED: 'CONNECTED',     // 已连接，正常运行
    RECONNECTING: 'RECONNECTING', // 重连中
    DISCONNECTED: 'DISCONNECTED', // 已断开
    ERROR: 'ERROR'              // 错误状态
};

// ==================== 常量配置 ====================
const MAX_RECONNECT_DELAY = 5 * 60 * 1000;  // 最大重连延迟：5分钟 (MEU-1.1)
const WATCHDOG_TIMEOUT = 30 * 60 * 1000;    // 看门狗超时：30分钟 (MEU-2.2)
const WATCHDOG_CHECK_INTERVAL = 60 * 1000;  // 看门狗检查间隔：1分钟
const PROBE_INTERVAL = 60 * 1000;           // 旁路探测间隔：60秒 (MEU-3.1)
const PROBE_TIMEOUT = 10 * 1000;            // 探测超时：10秒
const MAX_SEEN_HASHES = 10000;              // 最大哈希记录数 (MEU-4.1)
const RECONNECT_TAIL_LINES = 50;            // 重连时读取的行数 (MEU-4.2)

// 获取共享 SSHManager
let sshManager = null;

function getSSHManager() {
    if (!sshManager) {
        try {
            const sharedModule = require('../../../modules/SSHManager');
            sshManager = sharedModule.getSSHManager();
        } catch (error) {
            console.error('[MonitorTask] 无法加载共享 SSHManager:', error.message);
            throw new Error('SSHManager 模块不可用');
        }
    }
    return sshManager;
}

class MonitorTask {
    /**
     * @param {Object} options
     * @param {string} options.taskId - 任务 ID
     * @param {string} options.hostId - 目标主机 ID
     * @param {string} options.logPath - 日志文件路径
     * @param {number} options.contextLines - 上下文行数（before 上下文）
     * @param {number} options.afterContextLines - after 上下文行数（v1.3.0，默认等于 contextLines）
     * @param {boolean} options.debug - 调试模式
     * @param {Function} options.onData - 数据回调
     * @param {Function} options.onError - 错误回调
     * @param {Function} options.onClose - 关闭回调
     * @param {Function} options.onStatusChange - 状态变更回调 (MEU-1.4)
     * @param {Function} options.onAnomaly - 异常回调（v1.3.0，带完整 before/after 上下文）
     * @param {boolean} options.dedupe - 是否启用去重（默认 true）
     * @param {string} options.dedupeMode - 去重模式: 'permanent' | 'time-window' | 'disabled'（默认 'time-window'）
     * @param {number} options.dedupeWindow - 时间窗口秒数（默认 60）
     * @param {number} options.maxHashes - 最大哈希记录数（默认 10000）
     */
    constructor(options) {
        this.taskId = options.taskId;
        this.hostId = options.hostId;
        this.logPath = options.logPath;
        this.contextLines = options.contextLines ?? 10;
        this.afterContextLines = options.afterContextLines ?? this.contextLines; // v1.3.0: after 上下文行数
        this.debug = options.debug || false;
        
        // v1.4.0: 规则（UDS 模式传递给 Server）
        this.rules = options.rules || [];
        
        // 回调函数
        this.onData = options.onData || (() => {});
        this.onError = options.onError || (() => {});
        this.onClose = options.onClose || (() => {});
        this.onStatusChange = options.onStatusChange || (() => {}); // MEU-1.4
        this.onAnomaly = options.onAnomaly || (() => {}); // v1.3.0: 异常回调（带完整上下文）
        
        // 状态机 (MEU-1.2)
        this.state = TaskState.IDLE;
        this.lastMessage = '';
        
        // 会话状态（保持 isActive 兼容性）
        this.session = null;
        this.isActive = false;
        this.startTime = null;
        
        // v1.4.0: Server 任务 ID（UDS 模式）
        this.serverTaskId = null;
        
        // 行缓冲
        this.lineBuffer = '';
        this.maxLineBufferSize = 64 * 1024; // 64KB
        
        // 上下文缓冲（最近 N 行，用于 before 上下文）
        this.contextBuffer = [];
        // v1.3.0: 待完成的异常队列（等待收集 after 上下文）
        this.pendingAnomalies = [];
        
        // 统计信息
        this.stats = {
            linesProcessed: 0,
            bytesReceived: 0,
            reconnectCount: 0,
            duplicatesSkipped: 0,  // v1.2: 跳过的重复行数
            anomaliesDetected: 0   // v1.3.0: 检测到的异常数
        };
        
        // 重连配置 (MEU-1.1: 移除 maxReconnectAttempts 限制)
        this.reconnectAttempts = 0;
        this.reconnectDelay = 5000; // 初始重连延迟：5秒
        this.reconnectTimer = null;
        
        // 看门狗配置 (MEU-2.2)
        this.lastDataTime = Date.now();
        this.watchdogTimeout = WATCHDOG_TIMEOUT;
        this.watchdogInterval = null;
        
        // 旁路探测配置 (MEU-3.1)
        this.probeInterval = PROBE_INTERVAL;
        this.probeTimer = null;
        
        // 日志去重配置 (v1.2: 可配置去重策略)
        this.dedupeConfig = {
            enabled: options.dedupe !== false,                    // 默认开启
            mode: options.dedupeMode || 'time-window',            // 'permanent' | 'time-window' | 'disabled'
            windowSeconds: options.dedupeWindow || 60,            // 时间窗口：60秒内相同内容才去重
            maxHashes: options.maxHashes || MAX_SEEN_HASHES       // 最大哈希记录数
        };
        
        // 使用 Map 存储哈希和时间戳（支持时间窗口去重）
        this.seenHashes = new Map();  // hash -> timestamp
        
        // 连接池复用信息
        this._connectionPoolInfo = null;
        
        // v1.4.0: 代理实例缓存
        this._proxy = null;
    }
    
    // ==================== 状态管理方法 (MEU-1.2, MEU-1.4) ====================
    
    /**
     * 更新状态并触发回调
     * @param {string} newState - 新状态
     * @param {string} message - 状态消息
     */
    _updateState(newState, message = '') {
        const oldState = this.state;
        this.state = newState;
        this.lastMessage = message;
        
        // 同步 isActive 状态（保持兼容性）
        this.isActive = (newState === TaskState.CONNECTED || newState === TaskState.RECONNECTING);
        
        this._log(`状态变更: ${oldState} -> ${newState}${message ? ` (${message})` : ''}`);
        
        // 触发状态变更回调 (MEU-1.4)
        try {
            this.onStatusChange({
                taskId: this.taskId,
                oldState,
                newState,
                message,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            this._log(`状态变更回调失败: ${error.message}`);
        }
    }
    
    /**
     * 启动监控
     */
    async start() {
        this._log(`启动监控: ${this.hostId}:${this.logPath}`);
        
        // 状态检查
        if (this.state !== TaskState.IDLE && this.state !== TaskState.DISCONNECTED && this.state !== TaskState.ERROR) {
            throw new Error(`无法从状态 ${this.state} 启动监控`);
        }
        
        // v1.4.0: 优先尝试 UDS 代理模式
        const { getLogMonitorProxy } = require('../../../modules/LogMonitor');
        this._proxy = getLogMonitorProxy();
        
        if (this._proxy) {
            return this._startUDS();
        }
        
        // Fallback: legacy tail -f 模式
        return this._startLegacy();
    }
    
    /**
     * v1.4.0: UDS 代理模式启动
     */
    async _startUDS() {
        this._updateState(TaskState.CONNECTING, '正在连接日志监控服务');
        const requestedTaskId = this.taskId;
        
        try {
            this._proxy.subscribeNotifications(requestedTaskId, {
                onAnomaly: (data) => this._handleServerAnomaly(data),
                onError: (error) => this._handleServerError(error),
                onStopped: (data) => this._handleServerStopped(data)
            });

            const result = await this._proxy.startMonitor({
                taskId: this.taskId,
                hostId: this.hostId,
                logPath: this.logPath,
                rules: this.rules,
                contextLines: this.contextLines,
                prefetchLines: this.contextLines,
                afterContextLines: this.afterContextLines,
                dedupeMode: this.dedupeConfig.mode,
                dedupeWindow: this.dedupeConfig.windowSeconds,
                maxLines: 5000,
                maxBytes: 10 * 1024 * 1024
            });
            
            this.serverTaskId = result.taskId;
            
            if (this.serverTaskId !== requestedTaskId) {
                this._proxy.unsubscribeNotifications(requestedTaskId);
                this._proxy.subscribeNotifications(this.serverTaskId, {
                    onAnomaly: (data) => this._handleServerAnomaly(data),
                    onError: (error) => this._handleServerError(error),
                    onStopped: (data) => this._handleServerStopped(data)
                });
            }

            // 确认 Server 侧订阅；Server 会在启动期间预订阅 owner，避免首批通知丢失。
            const subscribeResult = await this._proxy.subscribe({
                taskId: this.serverTaskId
            });
            if (!subscribeResult || subscribeResult.error) {
                this._proxy.unsubscribeNotifications(this.serverTaskId);
                throw new Error(subscribeResult?.error || 'Server 订阅失败');
            }
            
            this.startTime = new Date().toISOString();
            this.reconnectAttempts = 0;
            this.lastDataTime = Date.now();
            
            this._updateState(TaskState.CONNECTED, '监控已启动（Server 模式）');
            this._log('监控已启动（Server 模式）');
        } catch (error) {
            if (this.serverTaskId) {
                const taskId = this.serverTaskId;
                this._proxy.unsubscribeNotifications(taskId);
                try {
                    await this._proxy.unsubscribe({ taskId });
                } catch (e) {
                    this._log(`取消 Server 订阅失败: ${e.message}`);
                }
                try {
                    await this._proxy.stopMonitor({
                        taskId,
                        reason: 'client_start_failed',
                        requireOwner: true
                    });
                } catch (e) {
                    this._log(`清理 Server 任务失败: ${e.message}`);
                }
                this.serverTaskId = null;
            } else {
                this._proxy.unsubscribeNotifications(requestedTaskId);
            }
            this._updateState(TaskState.ERROR, `UDS 启动失败: ${error.message}`);
            this._log(`UDS 启动失败: ${error.message}`);
            throw error;
        }
    }
    
    /**
     * Legacy 模式启动（保留兼容）
     */
    async _startLegacy() {
        this._updateState(TaskState.CONNECTING, '正在建立 SSH 连接');
        
        const manager = getSSHManager();
        // 构建 tail -f 命令
        const command = `tail -f -n ${this.contextLines} "${this.logPath}"`;
        
        try {
            // 检查连接池状态（如果支持）
            let poolStatsBefore = null;
            if (manager.getPoolStats) {
                poolStatsBefore = manager.getPoolStats();
                this._log(`连接池状态: 活跃连接=${poolStatsBefore.activeConnections}, 池大小=${poolStatsBefore.poolSize}/${poolStatsBefore.maxPoolSize}, 队列=${poolStatsBefore.queueLength}`);
            }
            
            // 创建流式会话
            this.session = await manager.createStreamSession(this.hostId, command, {
                timeout: 0 // 无超时
            });
            
            // 记录连接复用信息
            if (manager.getPoolStats && poolStatsBefore) {
                const poolStatsAfter = manager.getPoolStats();
                const connectionReused = poolStatsAfter.activeConnections === poolStatsBefore.activeConnections && poolStatsAfter.poolSize > 0;
                this._log(`连接复用: ${connectionReused ? '是' : '否'} (池大小: ${poolStatsBefore.poolSize} -> ${poolStatsAfter.poolSize})`);
                this._connectionPoolInfo = {
                    connectionReused,
                    poolSizeBefore: poolStatsBefore.poolSize,
                    poolSizeAfter: poolStatsAfter.poolSize,
                    activeConnectionsBefore: poolStatsBefore.activeConnections,
                    activeConnectionsAfter: poolStatsAfter.activeConnections
                };
            }
            
            // 设置回调
            this.session.onData = (data) => this._handleData(data);
            this.session.onError = (error) => this._handleError(error);
            this.session.onClose = () => this._handleClose();
            
            // 启动会话
            await this.session.start();
            
            this.startTime = new Date().toISOString();
            this.reconnectAttempts = 0;
            this.lastDataTime = Date.now();
            
            // 启动看门狗 (MEU-2.2)
            this._startWatchdog();
            
            // 启动旁路探测 (MEU-3.1)
            this._startProbe();
            
            this._updateState(TaskState.CONNECTED, '监控已启动');
            this._log('监控已启动');
            
        } catch (error) {
            this._updateState(TaskState.ERROR, `启动失败: ${error.message}`);
            this._log(`启动失败: ${error.message}`);
            throw error;
        }
    }
    
    /**
     * 停止监控
     * @returns {Object} 统计信息
     */
    async stop() {
        this._log('停止监控...');
        
        // 清除重连定时器
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        // 清除看门狗定时器 (MEU-2.3)
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = null;
        }
        
        // 清除旁路探测定时器 (MEU-3.2)
        if (this.probeTimer) {
            clearInterval(this.probeTimer);
            this.probeTimer = null;
        }
        
        // v1.3.0: 强制完成所有待处理的异常
        if (this.pendingAnomalies.length > 0) {
            this._log(`停止前强制完成 ${this.pendingAnomalies.length} 个待处理异常`);
            this.flushPendingAnomalies();
        }
        
        // v1.4.0: UDS 模式停止
        if (this._proxy && this.serverTaskId) {
            const taskId = this.serverTaskId;
            try {
                await this._proxy.stopMonitor({ taskId, requireOwner: true });
                this._log('Server 监控任务已停止');
            } catch (e) {
                this._log(`停止 Server 任务失败: ${e.message}`);
            }
            try {
                await this._proxy.unsubscribe({ taskId });
            } catch (e) {
                this._log(`取消 Server 订阅失败: ${e.message}`);
            }
            this._proxy.unsubscribeNotifications(taskId);
            this.serverTaskId = null;
        }
        
        // Legacy 模式停止
        if (this.session) {
            try {
                await this.session.stop();
                this._log('流式会话已停止，底层 SSH 连接保留在连接池中');
            } catch (error) {
                this._log(`停止会话失败: ${error.message}`);
            }
            this.session = null;
        }
        
        this._updateState(TaskState.DISCONNECTED, '监控已停止');
        this._log('监控已停止');
        
        return {
            ...this.stats,
            duration: this.startTime ? Date.now() - new Date(this.startTime).getTime() : 0
        };
    }
    
    /**
     * 获取状态
     * @returns {Object}
     */
    getStatus() {
        return {
            taskId: this.taskId,
            hostId: this.hostId,
            logPath: this.logPath,
            state: this.state,              // MEU-2.1: 新增状态字段
            lastMessage: this.lastMessage,  // MEU-2.1: 新增消息字段
            isActive: this.isActive,
            startTime: this.startTime,
            stats: { ...this.stats },
            contextLines: this.contextLines,
            afterContextLines: this.afterContextLines, // v1.3.0
            reconnectAttempts: this.reconnectAttempts,  // MEU-2.1: 新增重连次数
            lastDataTime: this.lastDataTime,            // MEU-2.1: 新增最后数据时间
            dedupeConfig: { ...this.dedupeConfig },     // v1.2: 新增去重配置
            pendingAnomalies: this.pendingAnomalies.length, // v1.3.0: 待处理异常数
            serverTaskId: this.serverTaskId, // v1.4.0
            mode: this.serverTaskId ? 'uds' : this.session ? 'legacy' : 'none' // v1.4.0
        };
    }
    
    /**
     * 获取连接池复用信息
     * @returns {Object}
     */
    getConnectionPoolInfo() {
        return {
            taskId: this.taskId,
            hostId: this.hostId,
            logPath: this.logPath,
            ...this._connectionPoolInfo
        };
    }
    
    /**
     * 获取上下文（字符串格式，向后兼容）
     * @returns {string}
     */
    getContext() {
        return this.contextBuffer.join('\n');
    }
    
    /**
     * 获取 before 上下文（数组格式）
     * v1.3.0: 用于异常上下文增强
     * @param {number} lines - 行数（默认使用 contextLines）
     * @returns {string[]}
     */
    getContextBefore(lines = this.contextLines) {
        const count = Math.min(lines, this.contextBuffer.length);
        return this.contextBuffer.slice(-count);
    }
    
    /**
     * 添加到上下文
     * @param {string} line
     */
    addToContext(line) {
        this.contextBuffer.push(line);
        
        // 保持上下文大小（使用较大的值以支持 before 和 after）
        const maxSize = Math.max(this.contextLines, this.afterContextLines) * 2;
        while (this.contextBuffer.length > maxSize) {
            this.contextBuffer.shift();
        }
    }
    
    // ==================== 异常上下文增强 (v1.3.0) ====================
    
    /**
     * 注册异常（v1.3.0）
     * 将异常加入待处理队列，等待收集 after 上下文
     * @param {Object} anomaly - 异常信息
     * @param {string} anomaly.line - 触发异常的日志行
     * @param {string} anomaly.matchedRule - 匹配的规则名
     * @param {string} anomaly.severity - 严重级别
     * @param {Object} anomaly.ruleDetails - 规则详情（可选）
     */
    registerAnomaly(anomaly) {
        const pendingAnomaly = {
            ...anomaly,
            timestamp: new Date().toISOString(),
            contextBefore: this.getContextBefore(),
            contextAfter: [],
            afterLinesNeeded: this.afterContextLines,
            afterLinesCollected: 0
        };
        
        this.pendingAnomalies.push(pendingAnomaly);
        this.stats.anomaliesDetected++;
        
        this._log(`注册异常: ${anomaly.matchedRule}, 等待收集 ${this.afterContextLines} 行 after 上下文`);
    }
    
    /**
     * 处理待完成的异常（收集 after 上下文）
     * v1.3.0: 在每行处理时调用
     * @param {string} line - 当前处理的日志行
     */
    _processPendingAnomalies(line) {
        const completedAnomalies = [];
        
        for (const pending of this.pendingAnomalies) {
            if (pending.afterLinesCollected < pending.afterLinesNeeded) {
                pending.contextAfter.push(line);
                pending.afterLinesCollected++;
                
                // 检查是否收集完成
                if (pending.afterLinesCollected >= pending.afterLinesNeeded) {
                    completedAnomalies.push(pending);
                }
            }
        }
        
        // 触发已完成异常的回调
        for (const completed of completedAnomalies) {
            this._triggerAnomalyCallback(completed);// 从队列中移除
            const index = this.pendingAnomalies.indexOf(completed);
            if (index > -1) {
                this.pendingAnomalies.splice(index, 1);
            }
        }
    }
    
    /**
     * 触发异常回调
     * v1.3.0: 构建完整的异常 payload
     * @param {Object} pending - 待完成的异常对象
     */
    _triggerAnomalyCallback(pending) {
        const payload = {
            taskId: this.taskId,
            hostId: this.hostId,
            logPath: this.logPath,
            anomaly: {
                line: pending.line,
                matchedRule: pending.matchedRule,
                severity: pending.severity,
                timestamp: pending.timestamp,
                ruleDetails: pending.ruleDetails
            },
            context: {
                before: pending.contextBefore,
                after: pending.contextAfter
            }
        };
        
        this._log(`触发异常回调: ${pending.matchedRule}, before=${pending.contextBefore.length}行, after=${pending.contextAfter.length}行`);
        
        try {
            this.onAnomaly(payload);
        } catch (error) {
            this._log(`异常回调失败: ${error.message}`);
        }
    }
    
    /**
     * 强制完成所有待处理的异常（用于停止监控时）
     * v1.3.0
     */
    flushPendingAnomalies() {
        for (const pending of this.pendingAnomalies) {
            this._log(`强制完成异常: ${pending.matchedRule}, after 上下文不完整 (${pending.afterLinesCollected}/${pending.afterLinesNeeded})`);
            this._triggerAnomalyCallback(pending);
        }
        this.pendingAnomalies = [];
    }
    
    // ==================== v1.4.0 Server 通知处理 ====================
    
    /**
     * 处理 Server 异常通知
     * @param {Object} data - { taskId, line, anomaly, rule, severity, timestamp, context: {before, after} }
     */
    _handleServerAnomaly(data) {
        this.lastDataTime = Date.now();
        this.stats.linesProcessed++;
        
        const serverContext = data.context || {};
        const beforeContext = Array.isArray(serverContext)
            ? serverContext
            : Array.isArray(serverContext.before)
                ? serverContext.before
                : [];
        const afterContext =
            !Array.isArray(serverContext) && Array.isArray(serverContext.after)
                ? serverContext.after
                : [];
        const context = beforeContext.join('\n');
        const anomaly = data.anomaly || {
            rule: data.rule,
            severity: data.severity
        };
        
        // 调用数据回调（与现有 onData 兼容）
        try {
            this.onData(data.line, {
                anomaly,
                rule: data.rule ?? anomaly.rule,
                severity: data.severity ?? anomaly.severity,
                context,
                afterContext,
                timestamp: data.timestamp ?? anomaly.timestamp
            });
        } catch (error) {
            this._log(`数据回调错误: ${error.message}`);
        }
    }
    
    /**
     * 处理 Server 错误通知
     * @param {Object} error
     */
    _handleServerError(error) {
        this._log(`Server 错误: ${error.message || error}`);
        try {
            this.onError(new Error(error.message || 'Server error'));
        } catch (e) {
            this._log(`错误回调失败: ${e.message}`);
        }
    }
    
    /**
     * 处理 Server 停止通知
     * @param {string} reason
     */
    _handleServerStopped(data) {
        const taskId = data && data.taskId ? data.taskId : this.serverTaskId;
        const reason = data && data.reason ? data.reason : 'stopped';
        this._log(`Server 监控已停止: ${reason}`);
        this.isActive = false;
        if (taskId) {
            if (this._proxy) {
                this._proxy.unsubscribe({ taskId }).catch((error) => {
                    this._log(`清理 Server 订阅失败: ${error.message}`);
                });
                this._proxy.unsubscribeNotifications(taskId);
            }
        }
        this.serverTaskId = null;
        try {
            this.onClose();
        } catch (error) {
            this._log(`关闭回调失败: ${error.message}`);
        }
        this._updateState(TaskState.DISCONNECTED, `Server 停止: ${reason}`);
    }
    
    // ==================== 看门狗机制 (MEU-2.2, MEU-2.3) ====================
    
    /**
     * 启动看门狗
     */
    _startWatchdog() {
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
        }
        
        this.watchdogInterval = setInterval(() => {
            const timeSinceLastData = Date.now() - this.lastDataTime;
            
            if (timeSinceLastData > this.watchdogTimeout) {
                this._log(`看门狗触发: ${Math.round(timeSinceLastData / 1000)}秒 无数据`);
                this._updateState(TaskState.ERROR, '看门狗超时');
                
                // 触发进程退出，让外部进程管理器重启
                process.exit(1);
            }}, WATCHDOG_CHECK_INTERVAL);
        
        this._log('看门狗已启动');
    }
    
    // ==================== 旁路探测机制 (MEU-3.1, MEU-3.2) ====================
    
    /**
     * 启动旁路探测
     */
    _startProbe() {
        if (this.probeTimer) {
            clearInterval(this.probeTimer);
        }
        
        this.probeTimer = setInterval(async () => {
            try {
                const manager = getSSHManager();
                await manager.execute(this.hostId, 'echo keepalive', { timeout: PROBE_TIMEOUT });
                this._log('旁路探测成功');
            } catch (error) {
                this._log(`旁路探测失败: ${error.message}`);
                
                // 探测失败，触发重连
                if (this.session) {
                    try {
                        await this.session.stop();
                    } catch (e) {
                        // 忽略停止错误
                    }
                }
                this._scheduleReconnect();
            }
        }, this.probeInterval);
        
        this._log('旁路探测已启动');
    }
    
    // ==================== 日志去重机制 (MEU-4.1, v1.2) ====================
    
    /**
     * 计算行哈希
     * @param {string} line - 日志行
     * @returns {string} 哈希值（前16位）
     */
    _hashLine(line) {
        return crypto.createHash('md5').update(line).digest('hex').slice(0, 16);
    }
    
    // ==================== 私有方法 ====================
    
    /**
     * 处理接收到的数据
     */
    _handleData(data) {
        // 更新最后数据时间 (MEU-2.2)
        this.lastDataTime = Date.now();
        
        this.stats.bytesReceived += data.length;
        
        // 调试日志：记录收到的数据
        this._log(`收到数据: ${data.length} 字节, 总计: ${this.stats.bytesReceived} 字节`);
        this._log(`数据内容(前100字符): ${data.substring(0, 100).replace(/\n/g, '\\n').replace(/\r/g, '\\r')}`);
        
        // 添加到行缓冲
        this.lineBuffer += data;
        
        // 检查缓冲区大小
        if (this.lineBuffer.length > this.maxLineBufferSize) {
            this._log('行缓冲区溢出，强制处理');
            // 强制处理当前缓冲区
            this._processLine(this.lineBuffer);
            this.lineBuffer = '';
            return;
        }
        
        // 按行处理
        const lines = this.lineBuffer.split('\n');
        // 最后一个元素可能是不完整的行
        this.lineBuffer = lines.pop() || '';
        
        // 处理完整的行
        for (const line of lines) {
            if (line.trim()) {
                this._processLine(line);
            }
        }
    }
    
    /**
     * 处理单行日志
     * v1.2: 支持可配置的去重策略
     * v1.3.0: 支持异常上下文收集
     */
    _processLine(line) {
        const lineHash = this._hashLine(line);
        const now = Date.now();
        
        // 去重检查 (v1.2: 可配置去重策略)
        if (this.dedupeConfig.enabled && this.dedupeConfig.mode !== 'disabled') {
            const lastSeen = this.seenHashes.get(lineHash);
            if (lastSeen !== undefined) {
                if (this.dedupeConfig.mode === 'permanent') {
                    // 永久去重（原逻辑）
                    this.stats.duplicatesSkipped++;
                    this._log(`跳过重复行(永久): ${lineHash}`);
                    return;
                } else if (this.dedupeConfig.mode === 'time-window') {
                    // 时间窗口去重
                    const elapsed = (now - lastSeen) / 1000;
                    if (elapsed < this.dedupeConfig.windowSeconds) {
                        this.stats.duplicatesSkipped++;
                        this._log(`跳过重复行(${elapsed.toFixed(1)}s内): ${lineHash}`);
                        return;
                    }// 超过时间窗口，允许通过并更新时间戳
                }
            }
        }
        
        // 更新哈希时间戳
        this.seenHashes.set(lineHash, now);
        
        // LRU 淘汰：超过最大数量时删除最早的
        if (this.seenHashes.size > this.dedupeConfig.maxHashes) {
            const oldest = this.seenHashes.keys().next().value;
            this.seenHashes.delete(oldest);
        }
        
        this.stats.linesProcessed++;
        
        // v1.3.0: 处理待完成的异常（收集 after 上下文）
        if (this.pendingAnomalies.length > 0) {
            this._processPendingAnomalies(line);
        }
        
        // 添加到上下文缓冲（用于 before 上下文）
        this.addToContext(line);
        
        // 调试日志：记录处理的行
        this._log(`处理第 ${this.stats.linesProcessed} 行: ${line.substring(0, 80)}...`);
        
        // 调用数据回调
        try {
            this.onData(line);
        } catch (error) {
            this._log(`数据回调错误: ${error.message}`);
        }
    }
    
    /**
     * 处理错误
     */
    _handleError(error) {
        this._log(`会话错误: ${error.message}`);
        
        // 调用错误回调
        try {
            this.onError(error);
        } catch (e) {
            this._log(`错误回调失败: ${e.message}`);
        }
        
        // 尝试重连
        this._scheduleReconnect();
    }
    
    /**
     * 处理关闭
     */
    _handleClose() {
        this._log('会话已关闭');
        
        if (this.state === TaskState.CONNECTED || this.state === TaskState.RECONNECTING) {
            // 非预期关闭，尝试重连
            this._scheduleReconnect();
        } else {
            // 预期关闭，调用关闭回调
            try {
                this.onClose();
            } catch (error) {
                this._log(`关闭回调失败: ${error.message}`);
            }
        }
    }
    
    /**
     * 安排重连 (MEU-1.1: 无限重连机制)
     */
    _scheduleReconnect() {
        // 检查是否应该重连
        if (this.state === TaskState.DISCONNECTED || this.state === TaskState.IDLE) {
            return;
        }
        
        this._updateState(TaskState.RECONNECTING, '准备重连');
        
        this.reconnectAttempts++;
        this.stats.reconnectCount++;
        
        // 计算延迟：指数退避，最大 5 分钟 (MEU-1.1)
        const delay = Math.min(
            this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1),
            MAX_RECONNECT_DELAY
        );
        
        this._log(`将在 ${Math.round(delay / 1000)}秒 后尝试第 ${this.reconnectAttempts} 次重连...`);
        
        this.reconnectTimer = setTimeout(async () => {
            try {
                await this._reconnect();
            } catch (error) {
                this._log(`重连失败: ${error.message}`);
                this._scheduleReconnect();
            }
        }, delay);
    }
    
    /**
     * 执行重连 (MEU-4.2: 重连时读取最近50行)
     */
    async _reconnect() {
        this._log('尝试重连...');
        
        const manager = getSSHManager();
        
        // 检查连接池状态（如果支持）
        let poolStatsBefore = null;
        if (manager.getPoolStats) {
            poolStatsBefore = manager.getPoolStats();
            this._log(`重连前连接池状态: 活跃连接=${poolStatsBefore.activeConnections}, 池大小=${poolStatsBefore.poolSize}/${poolStatsBefore.maxPoolSize}`);
        }
        
        // 重连时读取最近 50 行，通过哈希去重 (MEU-4.2)
        const command = `tail -f -n ${RECONNECT_TAIL_LINES} "${this.logPath}"`;
        
        this.session = await manager.createStreamSession(this.hostId, command, {
            timeout: 0
        });
        
        // 记录连接复用信息
        if (manager.getPoolStats && poolStatsBefore) {
            const poolStatsAfter = manager.getPoolStats();
            const connectionReused = poolStatsAfter.activeConnections === poolStatsBefore.activeConnections && poolStatsAfter.poolSize > 0;
            this._log(`重连连接复用: ${connectionReused ? '是' : '否'} (池大小: ${poolStatsBefore.poolSize} -> ${poolStatsAfter.poolSize})`);
            this._connectionPoolInfo = {
                connectionReused,
                poolSizeBefore: poolStatsBefore.poolSize,
                poolSizeAfter: poolStatsAfter.poolSize,
                activeConnectionsBefore: poolStatsBefore.activeConnections,
                activeConnectionsAfter: poolStatsAfter.activeConnections
            };
        }
        
        this.session.onData = (data) => this._handleData(data);
        this.session.onError = (error) => this._handleError(error);
        this.session.onClose = () => this._handleClose();
        
        await this.session.start();
        
        // 重置重连计数
        this.reconnectAttempts = 0;
        this.lastDataTime = Date.now();
        this._updateState(TaskState.CONNECTED, '重连成功');
        this._log('重连成功');}
    
    /**
     * 日志输出
     */
    _log(message) {
        if (this.debug) {
            logInfo(`[MonitorTask:${this.taskId}] ${message}`);
        }
    }
}

module.exports = { MonitorTask, TaskState };
