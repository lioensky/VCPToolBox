/**
 * MonitorManager - 监控任务管理器
 *
 * 负责：
 * - 管理所有监控任务的生命周期
 * - 任务状态持久化与恢复
 * - 规则管理
 * - 统计信息
 * - 主动日志查询（searchLog、lastErrors、logStats）
 *
 * @version 1.2.0
 *
 * v1.2.0 更新：
 * - 新增 searchLog() 方法：搜索日志文件
 * - 新增 lastErrors() 方法：获取最近错误
 * - 新增 logStats() 方法：日志统计分析
 *
 * v1.1.0 更新：
 * - MEU-2.1: 扩展状态持久化，增加 state、lastMessage、reconnectAttempts、lastDataTime 字段
 * - MEU-2.1: 新增 updateTaskState() 方法，接收 MonitorTask 状态变更回调
 * - MEU-2.1: startMonitor() 传递 onStatusChange 回调
 * - MEU-5.1: init() 启动时自动重试失败的回调
 */

const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

const { MonitorTask } = require('./MonitorTask');
const AnomalyDetector = require('./AnomalyDetector');
const CallbackTrigger = require('./CallbackTrigger');

// SSHManager 用于主动查询命令
const SSHManager = require('../../LinuxShellExecutor/ssh/SSHManager');

// 默认规则文件路径
const DEFAULT_RULES_PATH = path.join(__dirname, '..', 'rules', 'default-rules.json');
const CUSTOM_RULES_PATH = path.join(__dirname, '..', 'rules', 'custom-rules.json');
const STATE_FILE_PATH = path.join(__dirname, '..', 'state', 'active-monitors.json');
const PID_FILE_PATH = path.join(__dirname, '..', 'state', 'monitor.pid');
const STOP_SIGNAL_PATH = path.join(__dirname, '..', 'state', 'stop-requests.json');

class MonitorManager {
    /**
     * @param {Object} options
     * @param {string} options.callbackBaseUrl - VCP 回调基础 URL
     * @param {string} options.pluginName - 插件名称
     * @param {boolean} options.debug - 调试模式
     */
    constructor(options = {}) {
        this.callbackBaseUrl = options.callbackBaseUrl || 'http://localhost:5000';
        this.pluginName = options.pluginName || 'LinuxLogMonitor';
        this.debug = options.debug || false;
        
        // 活跃任务 Map<taskId, MonitorTask>
        this.tasks = new Map();
        
        // 异常检测器
        this.anomalyDetector = new AnomalyDetector();
        
        // 回调触发器
        this.callbackTrigger = new CallbackTrigger({
            baseUrl: this.callbackBaseUrl,
            pluginName: this.pluginName,
            debug: this.debug
        });
        
        // 统计信息
        this.stats = {
            totalAnomalies: 0,
            totalCallbacks: 0,
            startTime: new Date().toISOString()
        };

        this._stateWriteQueue = Promise.resolve();
    }
    
    /**
     * 初始化管理器
     * @param {Object} options
     * @param {string} options.mode - 初始化模式: 'full' | 'readonly' | 'signal'
     *   - 'full': 完整初始化，恢复任务（用于 start 命令）
     *   - 'readonly': 只读模式，不恢复任务（用于 status/list_rules 命令）
     *   - 'signal': 信号模式，用于发送停止信号（用于 stop 命令）
     */
    async init(options = {}) {
        const mode = options.mode || 'full';
        this._log(`初始化监控管理器 (模式: ${mode})...`);
        
        // readonly 模式只准备规则目录，避免插件 direct 初始化写入真实 state 路径。
        await this._ensureDirectories({ includeState: mode !== 'readonly' });
        
        // 加载规则（所有模式都需要）
        await this._loadRules();
        
        if (mode === 'full') {
            if (!this._isServerModeConfigured()) {
                await this._recoverTasks();
                await this._writePidFile();
                this._startStopSignalWatcher();
            }

            // MEU-5.1: 启动时重试失败的回调
            const retryResult = await this.callbackTrigger.retryFailedCallbacks();
            if (retryResult.total > 0) {
                this._log(`重试了 ${retryResult.total} 个失败回调，成功 ${retryResult.success}，失败 ${retryResult.failed}`);
            }

            // 记录连接池状态（如果支持）
            try {
                const manager = await this._getSSHManager();
                if (manager && manager.getPoolStats) {
                    const poolStats = manager.getPoolStats();
                    this._log(`连接池状态: 活跃连接=${poolStats.activeConnections}, 池大小=${poolStats.poolSize}/${poolStats.maxPoolSize}, 流式会话=${poolStats.activeStreamSessions}`);
                }
            } catch (error) {
                this._log(`获取连接池状态失败: ${error.message}`);
            }
        }
        
        this._log('监控管理器初始化完成');
    }
    
    /**
     * 启动监控任务
     * @param {Object} config
     * @param {string} config.hostId - 目标主机 ID
     * @param {string} config.logPath - 日志文件路径
     * @param {Array} config.rules - 自定义规则（可选）
     * @param {number} config.contextLines - 上下文行数
     * @returns {string} taskId
     */
    async startMonitor(config) {
        const { hostId, logPath, rules, contextLines, afterContextLines } = config;
        
        // 生成任务 ID
        const taskId = this._generateTaskId(hostId, logPath);
        
        // 检查是否已存在相同任务
        if (this.tasks.has(taskId)) {
            throw new Error(`监控任务已存在: ${taskId}`);
        }
        
        this._log(`启动监控任务: ${taskId}`);
        
        // 创建任务实例
        // MEU-2.1: 传递 onStatusChange 回调
        const effectiveContextLines = contextLines ?? 10;
        const effectiveAfterContextLines = afterContextLines ?? effectiveContextLines;
        const task = new MonitorTask({
            taskId,
            hostId,
            logPath,
            contextLines: effectiveContextLines,
            afterContextLines: effectiveAfterContextLines,
            debug: this.debug,
            rules: rules || [], // v1.4.0: 传递规则给 Server
            onData: (line, meta) => this._handleLogLine(taskId, line, meta),
            onError: (error) => this._handleTaskError(taskId, error),
            onClose: () => this._handleTaskClose(taskId),
            onStatusChange: (statusInfo) => this._handleTaskStatusChange(taskId, statusInfo)
        });
        
        // 如果有自定义规则，添加到检测器
        if (rules && rules.length > 0) {
            for (const rule of rules) {
                this.anomalyDetector.addRule(rule, taskId);
            }
        }
        
        // 先登记任务，确保 Server 模式启动预读阶段的异常通知能找到回调上下文。
        this.tasks.set(taskId, task);
        try {
            await task.start();
        } catch (error) {
            this.tasks.delete(taskId);
            this.anomalyDetector.removeTaskRules(taskId);
            throw error;
        }
        
        // 持久化状态
        await this._saveState();
        
        return taskId;
    }
    
    /**
     * 停止监控任务
     * @param {string} taskId
     * @returns {Object} 任务统计信息
     */
    async stopMonitor(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) {
            throw new Error(`任务不存在: ${taskId}`);
        }
        
        this._log(`停止监控任务: ${taskId}`);
        
        // 停止任务
        const stats = await task.stop();
        
        // 移除任务
        this.tasks.delete(taskId);
        
        // 清理任务相关的自定义规则
        this.anomalyDetector.removeTaskRules(taskId);
        
        // 持久化状态
        await this._saveState();
        
        return stats;
    }
    
    /**
     * 停止所有任务
     */
    async stopAll() {
        this._log('停止所有监控任务...');
        
        const taskIds = Array.from(this.tasks.keys());
        
        for (const taskId of taskIds) {
            try {
                await this.stopMonitor(taskId);
            } catch (error) {
                this._log(`停止任务 ${taskId} 失败: ${error.message}`);
            }
        }
    }
    
    /**
     * 获取状态
     * @returns {Object}
     */
    getStatus() {
        const activeTasks = [];
        for (const [taskId, task] of this.tasks) {
            activeTasks.push({
                taskId,
                ...task.getStatus()
            });
        }
        // 获取连接池状态（如果支持）
        let connectionPool = null;
        if (this.sshManager && this.sshManager.getPoolStats) {
            try {
                connectionPool = this.sshManager.getPoolStats();
            } catch (error) {
                this._log(`获取连接池状态失败: ${error.message}`);
            }
        }

        return {
            activeTasks,
            taskCount: this.tasks.size,
            stats: this.stats,
            rulesCount: this.anomalyDetector.getRulesCount(),
            connectionPool
        };
    }
    
    /**
     * 列出所有规则
     * @returns {Object}
     */
    listRules() {
        return this.anomalyDetector.listRules();
    }
    
    /**
     * 添加规则
     * @param {Object} rule
     * @returns {Object} 添加的规则
     */
    async addRule(rule) {
        const addedRule = this.anomalyDetector.addRule(rule);
        
        // 保存到自定义规则文件
        await this._saveCustomRules();
        
        return addedRule;
    }
    
    // ==================== 主动查询命令 (v1.2.0) ====================
    /**
     * 获取 SSHManager 实例（延迟初始化）
     * 使用共享模块以确保复用同一个连接池
     * @returns {SSHManager}
     */
    async _getSSHManager() {
        if (!this.sshManager) {
            try {
                // 优先使用共享模块，确保连接池复用
                const sharedModule = require('../../../modules/SSHManager');
                this.sshManager = sharedModule.getSSHManager();

                if (!this.sshManager) {
                    throw new Error('共享模块返回 null');
                }

                this._log('SSHManager 初始化成功（共享模块）');
            } catch (error) {
                // 降级：使用旧的直接实例化方式
                this._log(`共享模块加载失败，降级到直接实例化: ${error.message}`);
                try {
                    const SSHManager = require('../../LinuxShellExecutor/ssh/SSHManager');
                    const hostsPath = path.join(__dirname, '..', '..', 'LinuxShellExecutor', 'hosts.json');
                    const hostsContent = await fs.readFile(hostsPath, 'utf-8');
                    const hostsConfig = JSON.parse(hostsContent);
                    this.sshManager = new SSHManager(hostsConfig);
                    this._log('SSHManager 降级初始化成功');
                } catch (fallbackError) {
                    throw new Error(`无法初始化 SSHManager: ${fallbackError.message}`);
                }
            }
        }
        return this.sshManager;
    }
    
    /**
     * 搜索日志文件
     * @param {Object} params
     * @param {string} params.hostId - 目标主机 ID
     * @param {string} params.logPath - 日志文件路径
     * @param {string} params.pattern - grep 正则表达式
     * @param {number} params.lines - 最多返回行数（默认 100）
     * @param {string} params.since - 时间范围：1h, 30m, 1d（可选）
     * @param {number} params.context - 上下文行数（默认 0）
     * @returns {Object} 搜索结果
     */
    async searchLog(params) {
        const { getLogMonitorProxy } = require('../../../modules/LogMonitor');
        const proxy = getLogMonitorProxy();

        // 先尝试内存查询
        if (proxy) {
            try {
                const result = await proxy.searchLog(params);
                if (result.source === 'memory' && !result.error) {
                    return this._formatSearchLogResult(result, params);
                }
                if (result.source === 'remote' && !result.error) {
                    return this._formatSearchLogResult(result, params);
                }
                // partial/error 结果继续 fallback 到本地远程 grep
            } catch (e) {
                this._log(`内存查询失败，fallback 远程: ${e.message}`);
            }
        }

        // Fallback：原有 SSH 查询逻辑
        return this._searchLogRemote(params);
    }

    /**
     * Fallback: 远程 SSH 搜索日志文件
     */
    async _searchLogRemote(params) {
        const { hostId, logPath, pattern, lines = 100, since, context = 0 } = params;
        
        if (!hostId) throw new Error('缺少必需参数: hostId');
        if (!logPath) throw new Error('缺少必需参数: logPath');
        if (!pattern) throw new Error('缺少必需参数: pattern');
        
        this._log(`searchLog: hostId=${hostId}, logPath=${logPath}, pattern=${pattern}`);
        
        const sshManager = await this._getSSHManager();
        
        // 构建命令
        let command;
        
        if (since) {
            // 使用时间范围过滤
            // 将 since 转换为分钟数
            const minutes = this._parseSinceToMinutes(since);
            // 使用 find + xargs + grep 或 awk 过滤时间
            // 简化实现：使用 tail + grep
            const tailLines = Math.min(lines * 10, 10000); // 预取更多行以便过滤
            command = `tail -n ${tailLines} ${this._escapeShellArg(logPath)} | grep -E ${this._escapeShellArg(pattern)}`;
            if (context > 0) {
                command = `tail -n ${tailLines} ${this._escapeShellArg(logPath)} | grep -E -C ${context} ${this._escapeShellArg(pattern)}`;
            }
            command += ` | tail -n ${lines}`;
        } else {
            // 不使用时间范围
            if (context > 0) {
                command = `grep -E -C ${context} ${this._escapeShellArg(pattern)} ${this._escapeShellArg(logPath)} | tail -n ${lines}`;
            } else {
                command = `grep -E ${this._escapeShellArg(pattern)} ${this._escapeShellArg(logPath)} | tail -n ${lines}`;
            }
        }
        
        this._log(`执行命令: ${command}`);
        
        try {
            const result = await sshManager.execute(hostId, command, { timeout: 30000 });
            
            const outputLines = result.stdout.trim().split('\n').filter(line => line.length > 0);
            
            return {
                success: true,
                hostId,
                logPath,
                pattern,
                matchCount: outputLines.length,
                lines: outputLines,
                command,
                executionTime: new Date().toISOString()
            };
        } catch (error) {
            // grep 没有匹配时返回 exit code 1，这不是错误
            if (error.message.includes('exit code 1') || error.message.includes('code: 1')) {
                return {
                    success: true,
                    hostId,
                    logPath,
                    pattern,
                    matchCount: 0,
                    lines: [],
                    command,
                    executionTime: new Date().toISOString(),
                    note: '没有匹配的日志行'
                };
            }
            throw error;
        }
    }
    
    /**
     * 获取最近的错误日志
     * @param {Object} params
     * @param {string} params.hostId - 目标主机 ID
     * @param {string} params.logPath - 日志文件路径
     * @param {number} params.count - 最近 N 条（默认 20）
     * @param {Array} params.levels - 错误级别（默认 ['ERROR', 'FATAL', 'CRIT']）
     * @returns {Object} 错误日志
     */
    async lastErrors(params) {
        const { getLogMonitorProxy } = require('../../../modules/LogMonitor');
        const proxy = getLogMonitorProxy();

        // 先尝试内存查询
        if (proxy) {
            try {
                const result = await proxy.lastErrors(params);
                if ((result.source === 'memory' || result.source === 'remote') && !result.error) {
                    return this._formatLastErrorsResult(result, params);
                }
                // partial/error 结果继续 fallback 到本地远程 grep
            } catch (e) {
                this._log(`内存查询失败，fallback 远程: ${e.message}`);
            }
        }

        // Fallback：原有 SSH 查询逻辑
        return this._lastErrorsRemote(params);
    }

    /**
     * Fallback: 远程 SSH 获取最近错误日志
     */
    async _lastErrorsRemote(params) {
        const { hostId, logPath, count = 20, levels = ['ERROR', 'FATAL', 'CRIT', 'CRITICAL'] } = params;
        
        if (!hostId) throw new Error('缺少必需参数: hostId');
        if (!logPath) throw new Error('缺少必需参数: logPath');
        
        this._log(`lastErrors: hostId=${hostId}, logPath=${logPath}, count=${count}`);
        
        const sshManager = await this._getSSHManager();
        
        // 修复: 如果 levels 是 JSON 字符串，先解析为数组
        const levelsArray = typeof levels === 'string' ? JSON.parse(levels) : levels;
        
        // 构建 grep 模式
        const pattern = levelsArray.join('|');
        // 使用 grep + tail 获取最近的错误
        const command = `grep -E '\\b(${pattern})\\b' ${this._escapeShellArg(logPath)} | tail -n ${count}`;
        
        this._log(`执行命令: ${command}`);
        
        try {
            const result = await sshManager.execute(hostId, command, { timeout: 30000 });
            
            const outputLines = result.stdout.trim().split('\n').filter(line => line.length > 0);
            
            // 解析每行，提取时间戳和级别
            const errors = outputLines.map(line => {
                // 尝试解析常见的日志格式
                const parsed = this._parseLogLine(line);
                return {
                    raw: line,
                    ...parsed
                };
            });
            
            return {
                success: true,
                hostId,
                logPath,
                levels,
                errorCount: errors.length,
                errors,
                command,
                executionTime: new Date().toISOString()
            };
        } catch (error) {
            if (error.message.includes('exit code 1') || error.message.includes('code: 1')) {
                return {
                    success: true,
                    hostId,
                    logPath,
                    levels,
                    errorCount: 0,
                    errors: [],
                    command,
                    executionTime: new Date().toISOString(),
                    note: '没有找到错误日志'
                };
            }
            throw error;
        }
    }
    
    /**
     * 日志统计分析
     * @param {Object} params
     * @param {string} params.hostId - 目标主机 ID
     * @param {string} params.logPath - 日志文件路径
     * @param {string} params.since - 时间范围：1h, 30m, 1d（可选）
     * @param {string} params.groupBy - 分组方式：level, hour, status_code, ip（默认 level）
     * @returns {Object} 统计结果
     */
    async logStats(params) {
        const { getLogMonitorProxy } = require('../../../modules/LogMonitor');
        const proxy = getLogMonitorProxy();

        // 先尝试内存查询
        if (proxy) {
            try {
                const result = await proxy.logStats(params);
                if ((result.source === 'memory' || result.source === 'remote') && !result.error) {
                    return this._formatLogStatsResult(result, params);
                }
                // source === 'none'/error，继续 fallback
            } catch (e) {
                this._log(`内存查询失败，fallback 远程: ${e.message}`);
            }
        }

        // Fallback：原有 SSH 查询逻辑
        return this._logStatsRemote(params);
    }

    /**
     * Fallback: 远程 SSH 日志统计分析
     */
    async _logStatsRemote(params) {
        const { hostId, logPath, since, groupBy = 'level' } = params;
        
        if (!hostId) throw new Error('缺少必需参数: hostId');
        if (!logPath) throw new Error('缺少必需参数: logPath');
        
        this._log(`logStats: hostId=${hostId}, logPath=${logPath}, groupBy=${groupBy}`);
        
        const sshManager = await this._getSSHManager();
        
        let command;
        
        switch (groupBy) {
            case 'level':
                // 按日志级别统计
                command = `cat ${this._escapeShellArg(logPath)} | grep -oE '\\b(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRIT|CRITICAL)\\b' | sort | uniq -c | sort -rn`;
                break;
                
            case 'hour':
                // 按小时统计（假设日志格式包含时间戳）
                command = `cat ${this._escapeShellArg(logPath)} | grep -oE '[0-9]{2}:[0-9]{2}' | cut -d: -f1 | sort | uniq -c | sort -k2`;
                break;
                
            case 'status_code':
                // 按 HTTP 状态码统计（适用于 access log）
                command = `awk '{print $9}' ${this._escapeShellArg(logPath)} | grep -E '^[0-9]{3}$' | sort | uniq -c | sort -rn`;
                break;
                
            case 'ip':
                // 按 IP 地址统计（适用于 access log）
                command = `awk '{print $1}' ${this._escapeShellArg(logPath)} | sort | uniq -c | sort -rn | head -20`;
                break;
                
            default:
                throw new Error(`不支持的 groupBy 类型: ${groupBy}`);
        }
        
        // 如果指定了时间范围，使用 tail 限制行数
        if (since) {
            const tailLines = this._parseSinceToLines(since);
            command = `tail -n ${tailLines} ${this._escapeShellArg(logPath)} | ` + command.replace(`cat ${this._escapeShellArg(logPath)} | `, '').replace(` ${this._escapeShellArg(logPath)}`, '');
        }
        
        this._log(`执行命令: ${command}`);
        
        try {
            const result = await sshManager.execute(hostId, command, { timeout: 60000 });
            
            // 解析统计结果
            const stats = this._parseStatsOutput(result.stdout, groupBy);
            
            return {
                success: true,
                hostId,
                logPath,
                groupBy,
                since: since || 'all',
                stats,
                totalEntries: stats.reduce((sum, s) => sum + s.count, 0),
                command,
                executionTime: new Date().toISOString()
            };
        } catch (error) {
            throw error;
        }
    }

    _formatSearchLogResult(result, params) {
        const lines = Array.isArray(result.lines) ? result.lines : [];
        return {
            success: true,
            hostId: result.hostId ?? params.hostId,
            logPath: result.logPath ?? params.logPath,
            pattern: result.pattern ?? params.pattern,
            matchCount: result.matchCount ?? lines.length,
            lines,
            command: result.command,
            source: result.source,
            taskId: result.taskId,
            executionTime: result.executionTime || new Date().toISOString(),
            ...(result.partial ? { partial: result.partial } : {}),
            ...(result.fallbackError ? { fallbackError: result.fallbackError } : {}),
            ...(result.note ? { note: result.note } : {})
        };
    }

    _formatLastErrorsResult(result, params) {
        const lines = Array.isArray(result.lines) ? result.lines : [];
        const errors = Array.isArray(result.errors)
            ? result.errors
            : lines.map(line => ({
                raw: line,
                ...this._parseLogLine(line)
            }));
        return {
            success: true,
            hostId: result.hostId ?? params.hostId,
            logPath: result.logPath ?? params.logPath,
            levels: params.levels ?? result.levels ?? ['ERROR', 'FATAL', 'CRIT', 'CRITICAL'],
            errorCount: result.errorCount ?? result.matchCount ?? errors.length,
            errors,
            command: result.command,
            source: result.source,
            taskId: result.taskId,
            executionTime: result.executionTime || new Date().toISOString(),
            ...(result.partial ? { partial: result.partial } : {}),
            ...(result.fallbackError ? { fallbackError: result.fallbackError } : {}),
            ...(result.note ? { note: result.note } : {})
        };
    }

    _formatLogStatsResult(result, params) {
        const groupBy = result.groupBy ?? params.groupBy ?? 'level';
        const stats = Array.isArray(result.stats)
            ? result.stats
            : this._statsFromServerResult(result, groupBy);
        return {
            success: true,
            hostId: result.hostId ?? params.hostId,
            logPath: result.logPath ?? params.logPath,
            groupBy,
            since: result.since ?? params.since ?? 'all',
            stats,
            totalEntries: result.totalEntries ?? stats.reduce((sum, s) => sum + s.count, 0),
            command: result.command,
            source: result.source,
            taskId: result.taskId,
            executionTime: result.executionTime || new Date().toISOString(),
            ...(result.partial ? { partial: result.partial } : {}),
            ...(result.fallbackError ? { fallbackError: result.fallbackError } : {})
        };
    }

    _statsFromServerResult(result, groupBy) {
        const mapByGroup = {
            level: result.levelStats,
            hour: result.hourStats,
            status_code: result.statusCodeStats,
            ip: result.ipStats
        };
        const statsMap = mapByGroup[groupBy] || {};
        const stats = Object.entries(statsMap)
            .filter(([, count]) => Number(count) > 0)
            .map(([key, count]) => ({
                count: Number(count),
                key: String(key)
            }));
        if (groupBy === 'hour') {
            return stats.sort((a, b) => Number(a.key) - Number(b.key));
        }
        return stats.sort((a, b) => b.count - a.count);
    }
    
    /**
     * 解析 since 参数为分钟数
     * @param {string} since - 如 '1h', '30m', '1d'
     * @returns {number} 分钟数
     */
    _parseSinceToMinutes(since) {
        const match = since.match(/^(\d+)([mhd])$/);
        if (!match) {
            throw new Error(`无效的 since 格式: ${since}，支持格式: 30m, 1h, 1d`);
        }
        
        const value = parseInt(match[1], 10);
        const unit = match[2];
        
        switch (unit) {
            case 'm': return value;
            case 'h': return value * 60;
            case 'd': return value * 60 * 24;
            default: return value;
        }
    }
    
    /**
     * 解析 since 参数为预估行数
     * @param {string} since - 如 '1h', '30m', '1d'
     * @returns {number} 预估行数
     */
    _parseSinceToLines(since) {
        const minutes = this._parseSinceToMinutes(since);
        // 假设每分钟约 100 行日志
        return Math.min(minutes * 100, 100000);
    }
    
    /**
     * 转义 shell 参数
     * @param {string} arg
     * @returns {string}
     */
    _escapeShellArg(arg) {
        // 使用单引号包裹，并转义内部的单引号
        return "'" + arg.replace(/'/g, "'\\''") + "'";
    }
    
    /**
     * 解析日志行
     * @param {string} line
     * @returns {Object}
     */
    _parseLogLine(line) {
        const result = {
            timestamp: null,
            level: null,
            message: line
        };
        
        // 尝试匹配常见的时间戳格式
        // 格式1: 2025-12-21 10:30:45
        // 格式2: Dec 21 10:30:45
        // 格式3: [2025-12-21T10:30:45.123Z]
        
        const timestampPatterns = [
            /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/,
            /([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/,
            /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\]]*)\]/
        ];
        
        for (const pattern of timestampPatterns) {
            const match = line.match(pattern);
            if (match) {
                result.timestamp = match[1];
                break;
            }
        }
        
        // 尝试匹配日志级别
        const levelMatch = line.match(/\b(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRIT|CRITICAL)\b/i);
        if (levelMatch) {
            result.level = levelMatch[1].toUpperCase();
        }
        
        return result;
    }
    
    /**
     * 解析统计输出
     * @param {string} output
     * @param {string} groupBy
     * @returns {Array}
     */
    _parseStatsOutput(output, groupBy) {
        const lines = output.trim().split('\n').filter(line => line.length > 0);
        const stats = [];
        
        for (const line of lines) {
            // 格式: "  123 ERROR" 或 "123 ERROR"
            const match = line.trim().match(/^\s*(\d+)\s+(.+)$/);
            if (match) {
                stats.push({
                    count: parseInt(match[1], 10),
                    key: match[2].trim()
                });
            }
        }
        
        return stats;
    }
    
    /**
     * MEU-2.1: 更新任务状态
     * 由 MonitorTask 的 onStatusChange 回调触发
     * @param {string} taskId - 任务 ID
     * @param {Object} stateUpdate - 状态更新信息
     */
    async updateTaskState(taskId, stateUpdate) {
        const task = this.tasks.get(taskId);
        if (!task) {
            this._log(`updateTaskState: 任务不存在 ${taskId}`);
            return;
        }
        
        this._log(`任务 ${taskId} 状态更新: ${stateUpdate.oldState} → ${stateUpdate.newState} ${stateUpdate.message || ''}`);
        
        // 立即持久化状态
        await this._saveState();
    }
    
    // ==================== 私有方法 ====================
    
    /**
     * 生成任务 ID
     * 重要：使用确定性哈希，相同的 hostId + logPath 总是生成相同的 taskId
     * 这样从文件恢复任务时能正确匹配原始任务
     */
    _generateTaskId(hostId, logPath) {
        const hash = crypto.createHash('md5')
            .update(`${hostId}:${logPath}`)  // 移除 Date.now()，使用确定性哈希
            .digest('hex')
            .substring(0, 8);
        return `monitor-${hostId}-${hash}`;
    }
    
    /**
     * MEU-2.1: 处理任务状态变更
     * @param {string} taskId - 任务 ID
     * @param {Object} statusInfo - 状态信息
     */
    async _handleTaskStatusChange(taskId, statusInfo) {
        await this.updateTaskState(taskId, statusInfo);
    }
    
    /**
     * 处理日志行
     */
    async _handleLogLine(taskId, line, meta) {
        const task = this.tasks.get(taskId);
        if (!task) return;
        
        // v1.4.0: UDS 模式，Server 已检测异常，直接触发回调
        if (meta && (meta.rule || meta.anomaly)) {
            this.stats.totalAnomalies++;
            const context =
                meta.context !== undefined
                    ? this._normalizeContext(meta.context)
                    : task.getContext();
            const anomaly = meta.anomaly || {};
            await this._triggerCallback(taskId, {
                ...anomaly,
                rule: meta.rule ?? anomaly.rule,
                severity: meta.severity ?? anomaly.severity,
                logLine: line,
                hostId: task.hostId,
                logPath: task.logPath,
                context,
                afterContext: meta.afterContext || [],
                timestamp: meta.timestamp || new Date().toISOString()
            });
            task.addToContext(line);
            return;
        }
        
        // Legacy 模式：本地检测异常
        const anomalies = this.anomalyDetector.detect(line, taskId);
        
        if (anomalies.length > 0) {
            this.stats.totalAnomalies += anomalies.length;
            
            for (const anomaly of anomalies) {
                // 获取上下文
                const context = task.getContext();
                
                // 触发回调
                await this._triggerCallback(taskId, {
                    ...anomaly,
                    logLine: line,
                    hostId: task.hostId,
                    logPath: task.logPath,
                    context,
                    timestamp: new Date().toISOString()
                });
            }
        }
        
        // 更新任务上下文
        task.addToContext(line);
    }
    
    /**
     * 处理任务错误
     */
    async _handleTaskError(taskId, error) {
        this._log(`任务 ${taskId} 错误: ${error.message}`);
        
        // 触发错误回调
        await this._triggerCallback(taskId, {
            type: 'task_error',
            severity: 'critical',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
    
    /**
     * 处理任务关闭
     */
    async _handleTaskClose(taskId) {
        this._log(`任务 ${taskId} 已关闭`);
        
        // 从任务列表中移除
        this.tasks.delete(taskId);
        
        // 持久化状态
        await this._saveState();
    }
    
    /**
     * 触发回调
     */
    async _triggerCallback(taskId, anomaly) {
        this.stats.totalCallbacks++;
        
        await this.callbackTrigger.trigger(taskId, {
            pluginName: this.pluginName,
            requestId: taskId,
            status: 'anomaly_detected',
            anomaly
        });
    }
    
    /**
     * 确保目录存在
     */
    async _ensureDirectories(options = {}) {
        const { includeState = true } = options;
        const dirs = [
            path.join(__dirname, '..', 'rules')
        ];
        if (includeState) {
            dirs.push(path.join(__dirname, '..', 'state'));
        }
        
        for (const dir of dirs) {
            try {
                await fs.mkdir(dir, { recursive: true });
            } catch (error) {
                // 忽略已存在的目录
            }
        }
    }
    
    /**
     * 加载规则
     */
    async _loadRules() {
        // 加载默认规则
        try {
            const defaultRulesContent = await fs.readFile(DEFAULT_RULES_PATH, 'utf-8');
            const defaultRules = JSON.parse(defaultRulesContent);
            
            for (const rule of defaultRules.rules || []) {
                this.anomalyDetector.addRule(rule);
            }
            
            this._log(`加载了 ${(defaultRules.rules || []).length} 条默认规则`);
        } catch (error) {
            this._log(`加载默认规则失败: ${error.message}，将创建默认规则文件`);
            await this._createDefaultRules();
        }
        
        // 加载自定义规则
        try {
            const customRulesContent = await fs.readFile(CUSTOM_RULES_PATH, 'utf-8');
            const customRules = JSON.parse(customRulesContent);
            
            for (const rule of customRules.rules || []) {
                this.anomalyDetector.addRule(rule);
            }
            
            this._log(`加载了 ${(customRules.rules || []).length} 条自定义规则`);
        } catch (error) {
            // 自定义规则文件不存在是正常的
            this._log('无自定义规则文件');
        }
    }
    
    /**
     * 创建默认规则文件
     */
    async _createDefaultRules() {
        const defaultRules = {
            version: '1.0.0',
            description: 'LinuxLogMonitor 默认检测规则',
            rules: [
                {
                    name: 'error_keyword',
                    type: 'regex',
                    pattern: '\\b(ERROR|FATAL|CRITICAL)\\b',
                    severity: 'critical',
                    cooldown: 30000,
                    description: '检测 ERROR/FATAL/CRITICAL 关键词'
                },
                {
                    name: 'warning_keyword',
                    type: 'regex',
                    pattern: '\\b(WARN|WARNING)\\b',
                    severity: 'warning',
                    cooldown: 60000,
                    description: '检测 WARN/WARNING 关键词'
                },
                {
                    name: 'oom_killer',
                    type: 'keyword',
                    pattern: 'Out of memory',
                    severity: 'critical',
                    cooldown: 60000,
                    description: '检测内存不足'
                },
                {
                    name: 'disk_full',
                    type: 'keyword',
                    pattern: 'No space left on device',
                    severity: 'critical',
                    cooldown: 300000,
                    description: '检测磁盘空间不足'
                },
                {
                    name: 'connection_error',
                    type: 'regex',
                    pattern: 'Connection refused|Connection timed out|Connection reset',
                    severity: 'warning',
                    cooldown: 60000,
                    description: '检测连接错误'
                },
                {
                    name: 'permission_denied',
                    type: 'keyword',
                    pattern: 'Permission denied',
                    severity: 'warning',
                    cooldown: 60000,
                    description: '检测权限拒绝'
                },
                {
                    name: 'segfault',
                    type: 'keyword',
                    pattern: 'segfault',
                    severity: 'critical',
                    cooldown: 30000,
                    description: '检测段错误'
                },
                {
                    name: 'kernel_panic',
                    type: 'keyword',
                    pattern: 'Kernel panic',
                    severity: 'critical',
                    cooldown: 0,
                    description: '检测内核崩溃'
                }
            ]
        };
        
        await fs.writeFile(DEFAULT_RULES_PATH, JSON.stringify(defaultRules, null, 4), 'utf-8');
        
        // 重新加载
        for (const rule of defaultRules.rules) {
            this.anomalyDetector.addRule(rule);
        }
        
        this._log(`创建了 ${defaultRules.rules.length} 条默认规则`);
    }
    
    /**
     * 保存自定义规则
     */
    async _saveCustomRules() {
        const customRules = this.anomalyDetector.getCustomRules();
        
        await this._atomicWrite(CUSTOM_RULES_PATH, JSON.stringify({
            version: '1.0.0',
            description: '用户自定义检测规则',
            rules: customRules
        }, null, 4));
    }
    
    /**
     * MEU-2.1: 保存状态
     * v1.4.0: Server-backed 任务由常驻服务持有，只持久化 legacy tail -f 任务。
     */
    async _saveState() {
        this._stateWriteQueue = this._stateWriteQueue
            .catch(() => {})
            .then(async () => {
                const state = {
                    tasks: [],
                    lastUpdated: new Date().toISOString()
                };

                for (const [taskId, task] of this.tasks) {
                    if (task.serverTaskId) {
                        continue;
                    }
                    state.tasks.push({
                        taskId,
                        hostId: task.hostId,
                        logPath: task.logPath,
                        contextLines: task.contextLines,
                        afterContextLines: task.afterContextLines,
                        startTime: task.startTime,
                        status: task.state || 'UNKNOWN',
                        lastMessage: task.lastMessage || '',
                        reconnectAttempts: task.reconnectAttempts || 0,
                        lastDataTime: task.lastDataTime || null
                    });
                }

                await this._atomicWrite(STATE_FILE_PATH, JSON.stringify(state, null, 4));
            });
        return this._stateWriteQueue;
    }

    /**
     * 恢复任务
     */
    async _recoverTasks() {
        try {
            const stateContent = await fs.readFile(STATE_FILE_PATH, 'utf-8');
            const state = JSON.parse(stateContent);

            if (state.tasks && state.tasks.length > 0) {
                this._log(`发现 ${state.tasks.length} 个待恢复的任务`);

                for (const taskConfig of state.tasks) {
                    try {
                        await this.startMonitor({
                            hostId: taskConfig.hostId,
                            logPath: taskConfig.logPath,
                            contextLines: taskConfig.contextLines,
                            afterContextLines: taskConfig.afterContextLines
                        });
                        this._log(`任务 ${taskConfig.taskId} 恢复成功`);
                    } catch (error) {
                        this._log(`任务 ${taskConfig.taskId} 恢复失败: ${error.message}`);
                    }
                }
            }
        } catch (error) {
            this._log('无待恢复的任务');
        }
    }

    /**
     * 原子写入文件
     */
    async _atomicWrite(filePath, content) {
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        try {
            await fs.writeFile(tempPath, content, 'utf-8');
            await fs.rename(tempPath, filePath);
        } catch (error) {
            // 清理临时文件
            try {
                await fs.unlink(tempPath);
            } catch (e) {
                // 忽略
            }
            throw error;
        }
    }

    /**
     * 从状态文件读取状态（用于 status 命令，不启动任务）
     * v1.4.0: 优先返回内存状态
     * @returns {Object} 状态信息
     */
    async getStatusFromFile() {
        // v1.4.0: UDS 模式下优先查询常驻 Server 的真实状态
        const { getLogMonitorProxy } = require('../../../modules/LogMonitor');
        const proxy = getLogMonitorProxy();
        if (proxy) {
            try {
                const serverStatus = await proxy.getStatus();
                const activeTasks =
                    serverStatus.activeTasks ||
                    serverStatus.watchers ||
                    [];
                return {
                    activeTasks,
                    taskCount:
                        serverStatus.taskCount ??
                        serverStatus.watcherCount ??
                        activeTasks.length,
                    lastUpdated: new Date().toISOString(),
                    monitorProcessRunning: true,
                    stats: this.stats,
                    rulesCount: this.anomalyDetector.getRulesCount(),
                    serverStatus
                };
            } catch (e) {
                this._log(`Proxy 查询状态失败，fallback 本地状态: ${e.message}`);
            }
        }

        return this._readLegacyStatusFromFile();
    }

    /**
     * 发送停止信号（用于 stop 命令）
     * v1.4.0: UDS 优先使用 proxy，非 UDS 保留 legacy 文件信号
     * @param {string} taskId - 要停止的任务 ID
     * @param {Object} options
     * @param {number} options.timeout - 等待超时时间（毫秒）
     * @returns {Object} 停止结果
     */
    async sendStopSignal(taskId, options = {}) {
        const task = this.tasks.get(taskId);
        if (task) {
            await this.stopMonitor(taskId);
            return { success: true, method: 'direct' };
        }

        // 如果任务不在当前管理器中，尝试通过 proxy 停止
        const { getLogMonitorProxy } = require('../../../modules/LogMonitor');
        const proxy = getLogMonitorProxy();
        if (proxy) {
            try {
                const result = await proxy.stopMonitor({ taskId });
                if (!result || result.error || result.success !== true) {
                    const message = result?.error || 'Proxy 未确认停止任务';
                    throw new Error(message);
                }
                return { success: true, method: 'proxy' };
            } catch (e) {
                this._log(`Proxy 停止任务失败: ${e.message}`);
            }
        }

        return await this._sendLegacyStopSignal(taskId, options);
    }

    _isServerModeConfigured() {
        const { hasLogMonitorServiceEnv } = require('../../../modules/LogMonitor');
        return hasLogMonitorServiceEnv();
    }

    _normalizeContext(context) {
        if (Array.isArray(context)) {
            return context.join('\n');
        }
        if (
            context &&
            typeof context === 'object' &&
            Array.isArray(context.before)
        ) {
            return context.before.join('\n');
        }
        if (typeof context === 'string') {
            return context;
        }
        return '';
    }

    async _readLegacyStatusFromFile() {
        try {
            const stateContent = await fs.readFile(STATE_FILE_PATH, 'utf-8');
            const state = JSON.parse(stateContent);
            return {
                activeTasks: state.tasks || [],
                taskCount: (state.tasks || []).length,
                lastUpdated: state.lastUpdated,
                monitorProcessRunning: await this._isMonitorProcessRunning(),
                stats: this.stats,
                rulesCount: this.anomalyDetector.getRulesCount(),
                fallback: true
            };
        } catch (error) {
            return {
                activeTasks: [],
                taskCount: 0,
                lastUpdated: null,
                monitorProcessRunning: false,
                stats: this.stats,
                rulesCount: this.anomalyDetector.getRulesCount(),
                fallback: true
            };
        }
    }

    async _sendLegacyStopSignal(taskId, options = {}) {
        const timeout = options.timeout || 10000;

        let taskExists = false;
        try {
            const stateContent = await fs.readFile(STATE_FILE_PATH, 'utf-8');
            const state = JSON.parse(stateContent);
            taskExists = (state.tasks || []).some(t => t.taskId === taskId);
        } catch (e) {
            // 状态文件不存在
        }

        if (!taskExists) {
            throw new Error(`任务不存在: ${taskId}`);
        }

        const monitorProcessRunning = await this._isMonitorProcessRunning();
        if (!monitorProcessRunning) {
            this._log('监控进程未运行，直接清理状态文件');
            try {
                const stateContent = await fs.readFile(STATE_FILE_PATH, 'utf-8');
                const state = JSON.parse(stateContent);
                state.tasks = (state.tasks || []).filter(t => t.taskId !== taskId);
                state.lastUpdated = new Date().toISOString();
                await this._atomicWrite(STATE_FILE_PATH, JSON.stringify(state, null, 4));
                return { success: true, method: 'direct_cleanup' };
            } catch (e) {
                throw new Error(`清理状态文件失败: ${e.message}`);
            }
        }

        this._log(`发送停止信号: ${taskId}`);

        let stopRequests = [];
        try {
            const content = await fs.readFile(STOP_SIGNAL_PATH, 'utf-8');
            stopRequests = JSON.parse(content);
        } catch (e) {
            // 文件不存在
        }

        stopRequests.push({
            taskId,
            requestTime: new Date().toISOString()
        });

        await this._atomicWrite(STOP_SIGNAL_PATH, JSON.stringify(stopRequests, null, 4));

        const stopped = await this._waitForTaskStop(taskId, timeout);
        if (stopped) {
            return { success: true, method: 'signal' };
        }
        return { success: false, method: 'signal', error: '等待超时，任务可能仍在运行' };
    }

    async _writePidFile() {
        await this._atomicWrite(PID_FILE_PATH, process.pid.toString());
        this._log(`PID 文件已写入: ${process.pid}`);
    }

    async _cleanupPidFile() {
        try {
            await fs.unlink(PID_FILE_PATH);
        } catch (e) {
            // 忽略
        }
    }

    async _isMonitorProcessRunning() {
        try {
            const pidContent = await fs.readFile(PID_FILE_PATH, 'utf-8');
            const pid = parseInt(pidContent.trim(), 10);
            return this._isProcessRunning(pid);
        } catch (e) {
            return false;
        }
    }

    _isProcessRunning(pid) {
        try {
            process.kill(pid, 0);
            return true;
        } catch (e) {
            return false;
        }
    }

    _startStopSignalWatcher() {
        if (this._stopSignalInterval) {
            return;
        }
        this._stopSignalInterval = setInterval(async () => {
            await this._checkStopSignals();
        }, 1000);

        process.once('exit', () => {
            if (this._stopSignalInterval) {
                clearInterval(this._stopSignalInterval);
            }
            try {
                require('fs').unlinkSync(PID_FILE_PATH);
            } catch (e) {
                // 忽略
            }
        });
    }

    async _checkStopSignals() {
        try {
            const content = await fs.readFile(STOP_SIGNAL_PATH, 'utf-8');
            const stopRequests = JSON.parse(content);

            if (stopRequests.length === 0) return;

            const remainingRequests = [];
            for (const request of stopRequests) {
                if (this.tasks.has(request.taskId)) {
                    this._log(`收到停止信号，停止任务: ${request.taskId}`);
                    try {
                        await this.stopMonitor(request.taskId);
                    } catch (error) {
                        this._log(`停止任务失败: ${error.message}`);
                    }
                } else {
                    const requestAge = Date.now() - new Date(request.requestTime).getTime();
                    if (requestAge < 30000) {
                        remainingRequests.push(request);
                    }
                }
            }

            await this._atomicWrite(STOP_SIGNAL_PATH, JSON.stringify(remainingRequests, null, 4));
        } catch (error) {
            // 文件不存在或解析失败，忽略
        }
    }

    async _waitForTaskStop(taskId, timeout) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            await new Promise(resolve => setTimeout(resolve, 500));

            try {
                const stateContent = await fs.readFile(STATE_FILE_PATH, 'utf-8');
                const state = JSON.parse(stateContent);
                const taskExists = (state.tasks || []).some(t => t.taskId === taskId);
                if (!taskExists) {
                    return true;
                }
            } catch (e) {
                return true;
            }
        }
        return false;
    }
    
    /**
     * 日志输出
     */
    _log(msg, ...args) {
        console.error(`[MonitorManager] ${msg}`, ...args);  
    }  
}  
  
module.exports = MonitorManager; 
