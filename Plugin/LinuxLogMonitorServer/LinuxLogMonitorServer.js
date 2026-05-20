/**
 * LinuxLogMonitorServer - Linux 日志监控常驻服务
 *
 * 功能：
 * - 在 VCP 主进程内常驻运行
 * - 通过 Unix Domain Socket 暴露 JSON-RPC 服务
 * - 管理 LogWatcherEngine 生命周期
 * - 支持内存查询 + SSH fallback
 *
 * @version 1.0.0
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const LogWatcherEngine = require('./core/LogWatcherEngine');
const AnomalyDetector = require('../LinuxLogMonitor/core/AnomalyDetector');
const CallbackTrigger = require('../LinuxLogMonitor/core/CallbackTrigger');
const { getSSHManager } = require('../../modules/SSHManager');

/**
 * 加载主机配置文件
 * @returns {Object} 主机配置对象
 */
function loadHostsConfig() {
    const configPath = path.join(
        __dirname,
        '..',
        '..',
        'Plugin',
        'LinuxShellExecutor',
        'hosts.json'
    );
    try {
        if (fs.existsSync(configPath)) {
            delete require.cache[require.resolve(configPath)];
            return require(configPath);
        }
    } catch (e) {
        console.error(
            `[LinuxLogMonitorServer] 无法加载主机配置: ${configPath}: ${e.message}`
        );
    }
    return { hosts: {}, globalSettings: {} };
}

/**
 * 加载默认检测规则
 * @returns {Array} 规则列表
 */
function loadDefaultRules() {
    const rulesPath = path.join(
        __dirname,
        '..',
        'LinuxLogMonitor',
        'rules',
        'default-rules.json'
    );
    try {
        if (fs.existsSync(rulesPath)) {
            delete require.cache[require.resolve(rulesPath)];
            const rulesData = require(rulesPath);
            return (rulesData.rules || []).map(r => ({
                ...r,
                isDefault: true
            }));
        }
    } catch (e) {
        console.error(
            `[LinuxLogMonitorServer] 无法加载默认规则: ${rulesPath}: ${e.message}`
        );
    }
    return [];
}

/**
 * 加载用户自定义检测规则
 * @returns {Array} 规则列表
 */
function loadCustomRules() {
    const rulesPath = path.join(
        __dirname,
        '..',
        'LinuxLogMonitor',
        'rules',
        'custom-rules.json'
    );
    try {
        if (fs.existsSync(rulesPath)) {
            delete require.cache[require.resolve(rulesPath)];
            const rulesData = require(rulesPath);
            return rulesData.rules || [];
        }
    } catch (e) {
        console.error(
            `[LinuxLogMonitorServer] 无法加载自定义规则: ${rulesPath}: ${e.message}`
        );
    }
    return [];
}

/**
 * 解析时间偏移量字符串为毫秒
 * @param {string} str - 如 "1h", "30m", "1d"
 * @returns {number} 毫秒数
 */
function parseSince(str) {
    if (!str) return 0;
    if (typeof str === 'number') return str;
    const match = str.match(/^(\d+)([smhd])$/i);
    if (!match) return 0;
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return value * (multipliers[unit] || 0);
}

function escapeShell(str) {
    return `'${String(str ?? '').replace(/'/g, "'\\''")}'`;
}

function normalizeTailLines(value, defaultValue = 100, maxValue = 5000) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
    return Math.min(parsed, maxValue);
}

function normalizeContextLines(value, defaultValue = 0, maxValue = 50) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
    return Math.min(parsed, maxValue);
}

function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeLevels(value) {
    const defaultLevels = ['ERROR', 'FATAL', 'CRIT', 'CRITICAL'];
    let levels = value;

    if (typeof levels === 'string') {
        try {
            levels = JSON.parse(levels);
        } catch (_) {
            levels = levels.split(/[,\s|]+/);
        }
    }

    if (typeof levels === 'string') {
        levels = levels.split(/[,\s|]+/);
    }

    if (!Array.isArray(levels)) {
        return defaultLevels;
    }

    const normalized = levels
        .map(level => String(level).trim())
        .filter(Boolean);
    return normalized.length > 0 ? normalized : defaultLevels;
}

function estimateSinceToLines(since) {
    const ms = parseSince(since);
    if (!ms) return 100000;
    const minutes = Math.ceil(ms / 60000);
    return Math.min(Math.max(minutes * 100, 1000), 100000);
}

function createIpcPath(prefix) {
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\${prefix}-${process.pid}`;
    }
    return `/tmp/${prefix}-${process.pid}.sock`;
}

class LinuxLogMonitorServer {
    constructor() {
        this.engine = null;
        this.anomalyDetector = null;
        this.callbackTrigger = null;
        this.server = null;
        this.sockPath = null;
        this.clients = new Map(); // socket -> { id, subscriptions: Set<taskId> }
        this.nextClientId = 1;
        this.sshManager = null;
        this.authToken = crypto.randomBytes(32).toString('hex');
    }

    async initialize(config, dependencies) {
        if (this.server || this.engine || this.clients.size > 0) {
            await this.shutdown();
        }

        // 1. 加载 hosts.json
        const hostsConfig = loadHostsConfig();
        if (!hostsConfig.globalSettings) {
            hostsConfig.globalSettings = {};
        }
        hostsConfig.globalSettings.usePool = true;

        // 2. 获取 SSHManager（用于 LogWatcher 内部轮询）
        this.sshManager = getSSHManager(hostsConfig, { basePath: __dirname });
        if (!this.sshManager) {
            console.error('[LinuxLogMonitorServer] 创建 SSHManager 实例失败');
            return;
        }

        // 3. 初始化 AnomalyDetector
        this._reloadGlobalRules();

        // 4. 初始化 CallbackTrigger
        this.callbackTrigger = new CallbackTrigger({
            baseUrl:
                config.callbackBaseUrl ||
                process.env.CALLBACK_BASE_URL ||
                'http://localhost:5000',
            pluginName: 'LinuxLogMonitor',
            debug: config.debug || false
        });

        // 5. 初始化 LogWatcherEngine
        this.engine = new LogWatcherEngine({
            sshManager: this.sshManager,
            anomalyDetector: this.anomalyDetector,
            callbackTrigger: this.callbackTrigger,
            onNotification: (type, data) =>
                this._broadcastNotification(type, data)
        });

        // 6. 启动 IPC 服务器（Linux/macOS 使用 UDS，Windows 使用命名管道）
        this.sockPath = createIpcPath('vcp-log-monitor');
        await this._startUDSServer();
        global.__vcp_log_monitor_sock = this.sockPath;
        global.__vcp_log_monitor_token = this.authToken;

        // 7. 进程退出清理；SIGINT/SIGTERM 由主进程 gracefulShutdown 统一调度
        process.on('exit', () => this._syncShutdown());

        console.log('[LinuxLogMonitorServer] 初始化完成');
    }

    async _startUDSServer() {
        // 清理旧 socket
        if (process.platform !== 'win32') {
            try {
                fs.unlinkSync(this.sockPath);
            } catch (e) {}
        }

        this.server = net.createServer(socket => {
            const clientId = this.nextClientId++;
            this.clients.set(socket, {
                id: clientId,
                subscriptions: new Set(),
                ownedTasks: new Set()
            });

            let buffer = '';
            socket.on('data', data => {
                buffer += data.toString();
                let lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (line.trim()) this._handleRPC(socket, line);
                }
            });

            socket.on('close', () => {
                this._cleanupClient(socket, 'client_disconnect').catch(e => {
                    console.error(
                        `[LinuxLogMonitorServer] 清理客户端 ${clientId} 失败: ${e.message}`
                    );
                });
            });

            socket.on('error', err => {
                console.error(
                    `[LinuxLogMonitorServer] 客户端 ${clientId} 错误:`,
                    err.message
                );
                this._cleanupClient(socket, 'client_error').catch(e => {
                    console.error(
                        `[LinuxLogMonitorServer] 清理客户端 ${clientId} 失败: ${e.message}`
                    );
                });
            });
        });

        return new Promise((resolve, reject) => {
            this.server.listen(this.sockPath, () => {
                if (process.platform !== 'win32') {
                    try {
                        fs.chmodSync(this.sockPath, 0o600);
                    } catch (e) {
                        console.error(`[LinuxLogMonitorServer] 设置 socket 权限失败: ${e.message}`);
                    }
                }
                console.log(
                    `[LinuxLogMonitorServer] IPC 服务器已启动: ${this.sockPath}`
                );
                resolve();
            });
            this.server.on('error', reject);
        });
    }

    async _handleRPC(socket, line) {
        let reqId = null;
        try {
            const req = JSON.parse(line);
            const { id, method, params } = req;
            reqId = id;

            if (!req.authToken || req.authToken !== this.authToken) {
                socket.write(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id,
                        error: {
                            message: 'LogMonitor authentication failed',
                            code: -32001
                        }
                    }) + '\n'
                );
                return;
            }

            if (!this.engine) {
                socket.write(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id,
                        error: {
                            message: 'Engine not initialized',
                            code: -32000
                        }
                    }) + '\n'
                );
                return;
            }

            let result;
            switch (method) {
                case 'startMonitor':
                    result = await this._rpcStartMonitor(socket, params);
                    break;
                case 'stopMonitor':
                    result = await this._rpcStopMonitor(socket, params);
                    break;
                case 'searchLog':
                    result = await this._rpcSearchLog(params);
                    break;
                case 'lastErrors':
                    result = await this._rpcLastErrors(params);
                    break;
                case 'logStats':
                    result = await this._rpcLogStats(params);
                    break;
                case 'getStatus':
                    result = this.engine.getStatus();
                    break;
                case 'getBufferStats': {
                    const watcher = this.engine.getWatcher(params.taskId);
                    result = watcher
                        ? watcher.getStatus()
                        : { error: 'Watcher not found' };
                    break;
                }
                case 'subscribe':
                    result = this._rpcSubscribe(socket, params);
                    break;
                case 'unsubscribe':
                    result = this._rpcUnsubscribe(socket, params);
                    break;
                default:
                    result = { error: `Unknown method: ${method}` };
            }

            socket.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
        } catch (e) {
            console.error('[LinuxLogMonitorServer] RPC 处理错误:', e.message);
            try {
                const req = JSON.parse(line);
                socket.write(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: req.id,
                        error: { message: e.message, code: -32603 }
                    }) + '\n'
                );
            } catch {}
        }
    }

    async _rpcStartMonitor(socket, params) {
        this._reloadGlobalRules();
        const taskId =
            params.taskId ||
            this.engine._generateTaskId(params.hostId, params.logPath);
        const client = this.clients.get(socket);
        if (!client) {
            throw new Error('Client not found');
        }

        const hadOwned = client.ownedTasks.has(taskId);
        const hadSubscribed = client.subscriptions.has(taskId);
        client.ownedTasks.add(taskId);
        client.subscriptions.add(taskId);

        try {
            await this.engine.startWatcher({
                ...params,
                taskId
            });
        } catch (error) {
            if (!hadOwned) client.ownedTasks.delete(taskId);
            if (!hadSubscribed) client.subscriptions.delete(taskId);
            throw error;
        }

        if (this.clients.get(socket) !== client || socket.destroyed) {
            const stopResult = await this.engine.stopWatcher(
                taskId,
                'client_disconnect_before_start_complete'
            );
            return {
                taskId,
                state: 'stopped',
                stats: stopResult ? stopResult.stats : {}
            };
        }

        const watcher = this.engine.getWatcher(taskId);
        return {
            taskId,
            state: watcher ? watcher.state : 'unknown'
        };
    }

    async _rpcStopMonitor(socket, params) {
        const client = this.clients.get(socket);
        if (params.requireOwner && (!client || !client.ownedTasks.has(params.taskId))) {
            return {
                success: false,
                skipped: true,
                error: 'Watcher is not owned by this client'
            };
        }

        const result = await this.engine.stopWatcher(
            params.taskId,
            params.reason || 'client_stop'
        );
        if (!result) {
            return { error: 'Watcher not found' };
        }
        this._removeTaskFromClients(params.taskId);
        return { success: true, stats: result.stats };
    }

    async _rpcSearchLog(params) {
        const { hostId, logPath, pattern, since, lines = 100, context = 0 } = params;
        const watcher = this._findWatcherByHostAndPath(hostId, logPath);
        const safeLines = normalizeTailLines(lines);
        const safeContext = normalizeContextLines(context);

        if (watcher) {
            const sinceMs = since ? Date.now() - parseSince(since) : undefined;
            const allEntries = watcher.buffer.getAllLines();
            const entries = watcher.buffer.find(pattern, {
                since: sinceMs,
                maxResults: 5000
            }).slice(-safeLines);
            const bufferCoversSince =
                sinceMs !== undefined &&
                allEntries.length > 0 &&
                allEntries[0].timestamp <= sinceMs;
            const memoryResult = entries.length > 0
                ? {
                    lines: entries.map(entry => entry.raw),
                    matchCount: entries.length,
                    source: 'memory',
                    taskId: watcher.taskId
                }
                : null;
            if (memoryResult && bufferCoversSince && safeContext === 0) {
                return memoryResult;
            }

            const remoteResult = await this._remoteSearchLog(
                hostId,
                logPath,
                pattern,
                since,
                safeLines,
                safeContext
            );
            if (remoteResult.error && memoryResult) {
                return {
                    ...memoryResult,
                    partial: true,
                    fallbackError: remoteResult.error
                };
            }
            return remoteResult;
        }

        // fallback: 远程 SSH grep
        return await this._remoteSearchLog(
            hostId,
            logPath,
            pattern,
            since,
            safeLines,
            safeContext
        );
    }

    async _rpcLastErrors(params) {
        const { hostId, logPath, since, count, lines, levels } = params;
        const watcher = this._findWatcherByHostAndPath(hostId, logPath);
        const safeLines = normalizeTailLines(count ?? lines, 20);
        const safeLevels = normalizeLevels(levels);
        const levelPattern = safeLevels.map(escapeRegExp).join('|');
        const searchPattern = `\\b(${levelPattern})\\b`;

        if (watcher) {
            const sinceMs = since ? Date.now() - parseSince(since) : undefined;
            const allEntries = watcher.buffer.getAllLines();
            const entries = watcher.buffer.find(new RegExp(searchPattern, 'i'), {
                since: sinceMs,
                maxResults: 5000
            }).slice(-safeLines);
            const bufferCoversSince =
                sinceMs !== undefined &&
                allEntries.length > 0 &&
                allEntries[0].timestamp <= sinceMs;
            const memoryResult = entries.length > 0
                ? {
                    lines: entries.map(e => e.raw),
                    matchCount: entries.length,
                    source: 'memory',
                    taskId: watcher.taskId
                }
                : null;
            if (memoryResult && bufferCoversSince) {
                return memoryResult;
            }

            const remoteResult = await this._remoteSearchLog(
                hostId,
                logPath,
                searchPattern,
                since,
                safeLines
            );
            if (remoteResult.error && memoryResult) {
                return {
                    ...memoryResult,
                    partial: true,
                    fallbackError: remoteResult.error
                };
            }
            return remoteResult;
        }

        // fallback: 远程 SSH grep
        return await this._remoteSearchLog(
            hostId,
            logPath,
            searchPattern,
            since,
            safeLines
        );
    }

    async _rpcLogStats(params) {
        const { hostId, logPath, since, groupBy = 'level' } = params;
        const watcher = this._findWatcherByHostAndPath(hostId, logPath);

        if (!watcher) {
            return this._remoteLogStats(hostId, logPath, since, groupBy);
        }

        const sinceMs = since ? Date.now() - parseSince(since) : undefined;
        const allEntries = watcher.buffer.getAllLines();
        const filtered = sinceMs
            ? allEntries.filter(e => e.timestamp >= sinceMs)
            : allEntries;
        const bufferCoversSince =
            sinceMs !== undefined &&
            allEntries.length > 0 &&
            allEntries[0].timestamp <= sinceMs;
        const memoryResult = this._buildLogStatsResult({
            hostId,
            logPath,
            since,
            groupBy,
            entries: filtered,
            source: 'memory',
            taskId: watcher.taskId
        });

        if (sinceMs !== undefined && bufferCoversSince) {
            return memoryResult;
        }

        const remoteResult = await this._remoteLogStats(
            hostId,
            logPath,
            since,
            groupBy
        );
        if (remoteResult.error && filtered.length > 0) {
            return {
                ...memoryResult,
                partial: true,
                fallbackError: remoteResult.error
            };
        }
        return remoteResult;
    }

    _buildLogStatsResult({ hostId, logPath, since, groupBy, entries, source, taskId, command }) {
        const aggregates = this._aggregateLogStats(entries);
        const stats = this._statsForGroup(groupBy, aggregates);
        return {
            success: true,
            hostId,
            logPath,
            groupBy,
            since: since || 'all',
            stats,
            totalEntries: stats.reduce((sum, item) => sum + item.count, 0),
            totalLines: entries.length,
            source,
            taskId,
            command,
            ...aggregates
        };
    }

    _aggregateLogStats(entries) {
        const levelStats = { error: 0, warn: 0, info: 0, debug: 0, other: 0 };
        const hourStats = {};
        const statusCodeStats = {};
        const ipStats = {};

        for (const entry of entries) {
            const raw = entry.raw;
            const lower = raw.toLowerCase();

            // 级别
            if (
                lower.includes('error') ||
                lower.includes('fatal') ||
                lower.includes('critical') ||
                lower.includes('crit')
            ) {
                levelStats.error++;
            } else if (lower.includes('warn')) {
                levelStats.warn++;
            } else if (lower.includes('debug')) {
                levelStats.debug++;
            } else if (lower.includes('info')) {
                levelStats.info++;
            } else {
                levelStats.other++;
            }

            const hour = this._extractLogHour(entry);
            if (hour !== null) {
                hourStats[hour] = (hourStats[hour] || 0) + 1;
            }

            // 状态码 (匹配类似 200, 404, 500 等)
            const statusMatch = raw.match(/\b(\d{3})\b/);
            if (statusMatch) {
                const code = statusMatch[1];
                if (code >= '100' && code <= '599') {
                    statusCodeStats[code] = (statusCodeStats[code] || 0) + 1;
                }
            }

            // IP 地址
            const ipMatch = raw.match(
                /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/
            );
            if (ipMatch) {
                ipStats[ipMatch[1]] = (ipStats[ipMatch[1]] || 0) + 1;
            }
        }

        return {
            levelStats,
            hourStats,
            statusCodeStats,
            ipStats
        };
    }

    _extractLogHour(entry) {
        if (typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)) {
            return new Date(entry.timestamp).getHours();
        }
        const match = String(entry.raw || '').match(/\b(\d{2}):\d{2}(?::\d{2})?\b/);
        if (!match) return null;
        const hour = Number.parseInt(match[1], 10);
        return hour >= 0 && hour <= 23 ? hour : null;
    }

    _statsForGroup(groupBy, statsByType) {
        const sourceByGroup = {
            level: statsByType.levelStats,
            hour: statsByType.hourStats,
            status_code: statsByType.statusCodeStats,
            ip: statsByType.ipStats
        };
        const selected = sourceByGroup[groupBy];
        if (!selected) {
            return [];
        }
        const stats = Object.entries(selected)
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

    async _remoteSearchLog(hostId, logPath, pattern, since, lines, context = 0) {
        try {
            const safeLines = normalizeTailLines(lines);
            const safeContext = normalizeContextLines(context);
            const safeLogPath = escapeShell(logPath);
            const safePattern = escapeShell(pattern);
            let cmd;
            const grepContext = safeContext > 0 ? ` -C ${safeContext}` : '';
            if (since) {
                const tailLines = Math.min(safeLines * 10, 10000);
                cmd = `tail -n ${tailLines} ${safeLogPath} | grep -E${grepContext} -- ${safePattern} | tail -n ${safeLines}`;
            } else {
                cmd = `grep -E${grepContext} -- ${safePattern} ${safeLogPath} | tail -n ${safeLines}`;
            }
            const result = await this.sshManager.execute(hostId, cmd, {
                timeout: 30000
            });
            const stdout = result.stdout || '';
            const matched = stdout.split('\n').filter(l => l.trim());
            return {
                lines: matched,
                matchCount: matched.length,
                source: 'remote',
                hostId,
                logPath,
                command: cmd,
                since,
                context: safeContext
            };
        } catch (e) {
            const errorMessage = e && e.message ? e.message : String(e);
            if (errorMessage.includes('exit code 1') || errorMessage.includes('code: 1')) {
                return {
                    lines: [],
                    matchCount: 0,
                    source: 'remote',
                    hostId,
                    logPath,
                    since,
                    context: normalizeContextLines(context)
                };
            }
            return {
                error: `Remote search failed: ${errorMessage}`,
                source: 'remote',
                hostId,
                logPath
            };
        }
    }

    async _remoteLogStats(hostId, logPath, since, groupBy = 'level') {
        try {
            const cmd = this._buildRemoteLogStatsCommand(logPath, since, groupBy);
            const result = await this.sshManager.execute(hostId, cmd, {
                timeout: 60000
            });
            const parsed = this._parseRemoteLogStatsOutput(result.stdout || '', groupBy);
            return {
                success: true,
                hostId,
                logPath,
                groupBy,
                since: since || 'all',
                stats: parsed.stats,
                totalEntries: parsed.stats.reduce((sum, item) => sum + item.count, 0),
                totalLines: parsed.totalLines,
                source: 'remote',
                command: cmd,
                ...parsed.aggregates
            };
        } catch (e) {
            const errorMessage = e && e.message ? e.message : String(e);
            return {
                error: `Remote stats failed: ${errorMessage}`,
                source: 'remote',
                hostId,
                logPath
            };
        }
    }

    _buildRemoteLogStatsCommand(logPath, since, groupBy) {
        const safeLogPath = escapeShell(logPath);
        const awkScript = this._remoteLogStatsAwkScript(groupBy);
        if (since) {
            return `tail -n ${estimateSinceToLines(since)} ${safeLogPath} | awk '${awkScript}'`;
        }
        return `awk '${awkScript}' ${safeLogPath}`;
    }

    _remoteLogStatsAwkScript(groupBy) {
        switch (groupBy) {
            case 'level':
                return [
                    'BEGIN { error=0; warn=0; debug=0; info=0; other=0; total=0 }',
                    '{ total++; line=tolower($0); if (line ~ /(error|fatal|critical|crit)/) error++; else if (line ~ /warn/) warn++; else if (line ~ /debug/) debug++; else if (line ~ /info/) info++; else other++ }',
                    'END { printf "error\\t%d\\n", error; printf "warn\\t%d\\n", warn; printf "debug\\t%d\\n", debug; printf "info\\t%d\\n", info; printf "other\\t%d\\n", other; printf "__total__\\t%d\\n", total }'
                ].join(' ');
            case 'hour':
                return [
                    'BEGIN { total=0 }',
                    '{ total++; for (i=1; i<=NF; i++) { token=$i; if (token ~ /^[0-9][0-9]:[0-9][0-9](:[0-9][0-9])?/) { hour=substr(token,1,2); if ((hour + 0) >= 0 && (hour + 0) <= 23) count[hour]++; break } } }',
                    'END { for (key in count) printf "%s\\t%d\\n", key, count[key]; printf "__total__\\t%d\\n", total }'
                ].join(' ');
            case 'status_code':
                return [
                    'BEGIN { total=0 }',
                    '{ total++; for (i=1; i<=NF; i++) { token=$i; gsub(/^[^0-9]+|[^0-9]+$/, "", token); if (token ~ /^[1-5][0-9][0-9]$/) { count[token]++; break } } }',
                    'END { for (key in count) printf "%s\\t%d\\n", key, count[key]; printf "__total__\\t%d\\n", total }'
                ].join(' ');
            case 'ip':
                return [
                    'BEGIN { total=0 }',
                    '{ total++; for (i=1; i<=NF; i++) { token=$i; gsub(/^[^0-9]+|[^0-9.]+$/, "", token); if (token ~ /^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$/) { count[token]++; break } } }',
                    'END { for (key in count) printf "%s\\t%d\\n", key, count[key]; printf "__total__\\t%d\\n", total }'
                ].join(' ');
            default:
                throw new Error(`Unsupported groupBy: ${groupBy}`);
        }
    }

    _parseRemoteLogStatsOutput(stdout, groupBy) {
        let totalLines = 0;
        const stats = [];
        for (const line of String(stdout || '').split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const [key, rawCount] = trimmed.split(/\s+/, 2);
            const count = Number.parseInt(rawCount, 10);
            if (!Number.isFinite(count)) continue;
            if (key === '__total__') {
                totalLines = count;
                continue;
            }
            if (count > 0) {
                stats.push({ key: String(key), count });
            }
        }

        const sorted = this._sortLogStats(groupBy, stats);
        return {
            stats: sorted,
            totalLines: totalLines || sorted.reduce((sum, item) => sum + item.count, 0),
            aggregates: this._aggregatesFromStats(groupBy, sorted)
        };
    }

    _sortLogStats(groupBy, stats) {
        if (groupBy === 'hour') {
            return stats.sort((a, b) => Number(a.key) - Number(b.key));
        }
        return stats.sort((a, b) => b.count - a.count);
    }

    _aggregatesFromStats(groupBy, stats) {
        const levelStats = { error: 0, warn: 0, info: 0, debug: 0, other: 0 };
        const hourStats = {};
        const statusCodeStats = {};
        const ipStats = {};

        const targetByGroup = {
            level: levelStats,
            hour: hourStats,
            status_code: statusCodeStats,
            ip: ipStats
        };
        const target = targetByGroup[groupBy];
        if (target) {
            for (const item of stats) {
                target[item.key] = item.count;
            }
        }

        return {
            levelStats,
            hourStats,
            statusCodeStats,
            ipStats
        };
    }

    _rpcSubscribe(socket, params) {
        const client = this.clients.get(socket);
        if (!client) return { error: 'Client not found' };
        const taskId = params.taskId;
        if (!taskId) return { error: 'taskId required' };
        client.subscriptions.add(taskId);
        return { success: true, subscribed: Array.from(client.subscriptions) };
    }

    _rpcUnsubscribe(socket, params) {
        const client = this.clients.get(socket);
        if (!client) return { error: 'Client not found' };
        const taskId = params.taskId;
        if (!taskId) return { error: 'taskId required' };
        client.subscriptions.delete(taskId);
        return { success: true, subscribed: Array.from(client.subscriptions) };
    }

    async _cleanupClient(socket, reason) {
        const client = this.clients.get(socket);
        if (!client) return;
        this.clients.delete(socket);

        const taskIds = new Set([
            ...Array.from(client.ownedTasks || []),
            ...Array.from(client.subscriptions || [])
        ]);

        for (const taskId of taskIds) {
            if (this._hasActiveClientForTask(taskId)) continue;
            try {
                await this.engine.stopWatcher(taskId, reason);
            } catch (e) {
                console.error(
                    `[LinuxLogMonitorServer] 停止孤儿 watcher ${taskId} 失败: ${e.message}`
                );
            }
        }
    }

    _hasActiveClientForTask(taskId) {
        for (const client of this.clients.values()) {
            if (
                (client.ownedTasks && client.ownedTasks.has(taskId)) ||
                (client.subscriptions && client.subscriptions.has(taskId))
            ) {
                return true;
            }
        }
        return false;
    }

    _removeTaskFromClients(taskId) {
        for (const client of this.clients.values()) {
            if (client.ownedTasks) client.ownedTasks.delete(taskId);
            if (client.subscriptions) client.subscriptions.delete(taskId);
        }
    }

    _findWatcherByHostAndPath(hostId, logPath) {
        for (const [, watcher] of this.engine.watchers) {
            if (watcher.hostId === hostId && watcher.logPath === logPath) {
                return watcher;
            }
        }
        return null;
    }

    _broadcastNotification(type, data) {
        const taskId = data && data.taskId;
        if (!taskId) return;

        let notification;
        if (type === 'anomaly') {
            const anomaly = data.anomaly || null;
            notification = {
                jsonrpc: '2.0',
                method: 'anomaly.detected',
                params: {
                    ...data,
                    taskId,
                    line: data.line,
                    anomaly,
                    rule: anomaly?.rule ?? data.rule ?? null,
                    severity: anomaly?.severity ?? data.severity ?? null,
                    timestamp: data.timestamp ?? anomaly?.timestamp,
                    context: this._normalizeAnomalyContext(data.context)
                }
            };
        } else if (type === 'error') {
            notification = {
                jsonrpc: '2.0',
                method: 'watcher.error',
                params: {
                    ...data,
                    taskId,
                    message: data.error || data.message || 'Watcher error'
                }
            };
        } else if (type === 'stopped') {
            notification = {
                jsonrpc: '2.0',
                method: 'watcher.stopped',
                params: {
                    ...data,
                    taskId,
                    reason: data.reason || 'stopped'
                }
            };
        } else {
            // 其他类型通知（rotation, truncation）
            notification = {
                jsonrpc: '2.0',
                method: `log.${type}`,
                params: data
            };
        }

        const payload = JSON.stringify(notification) + '\n';
        for (const [socket, client] of this.clients) {
            if (client.subscriptions.has(taskId)) {
                try {
                    if (!socket.destroyed) {
                        socket.write(payload);
                    }
                } catch (e) {
                    // 忽略写入错误
                }
            }
        }
    }

    _reloadGlobalRules() {
        const detector = new AnomalyDetector();
        const defaultRules = loadDefaultRules();
        for (const rule of defaultRules) {
            detector.addRule(rule);
        }
        const customRules = loadCustomRules();
        for (const rule of customRules) {
            detector.addRule(rule);
        }

        this.anomalyDetector = detector;
        if (this.engine) {
            this.engine.anomalyDetector = detector;
        }

        console.log(
            `[LinuxLogMonitorServer] 已加载 ${defaultRules.length} 条默认规则，${customRules.length} 条自定义规则`
        );
        return { defaultRules: defaultRules.length, customRules: customRules.length };
    }

    _normalizeAnomalyContext(context) {
        if (context && typeof context === 'object' && !Array.isArray(context)) {
            return {
                before: Array.isArray(context.before) ? context.before : [],
                after: Array.isArray(context.after) ? context.after : []
            };
        }
        return {
            before: Array.isArray(context) ? context : [],
            after: []
        };
    }

    async shutdown() {
        // 关闭 engine
        const engine = this.engine;
        this.engine = null;
        if (engine) {
            try {
                await engine.shutdown();
            } catch (e) {
                console.error('[LinuxLogMonitorServer] 关闭 engine 失败:', e.message);
            }
        }

        // 关闭所有客户端连接
        for (const [socket] of this.clients.entries()) {
            try {
                socket.destroy();
            } catch (e) {}
        }
        this.clients.clear();

        const server = this.server;
        this.server = null;
        if (server) {
            await new Promise(resolve => {
                const done = err => {
                    if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
                        console.error('[LinuxLogMonitorServer] 关闭 IPC 服务器失败:', err.message);
                    }
                    resolve();
                };
                try {
                    server.close(done);
                } catch (err) {
                    done(err);
                }
            });
            if (process.platform !== 'win32') {
                try {
                    fs.unlinkSync(this.sockPath);
                } catch (e) {}
            }
        }
        this.sshManager = null;
        this.anomalyDetector = null;
        this.callbackTrigger = null;

        if (global.__vcp_log_monitor_sock === this.sockPath) {
            delete global.__vcp_log_monitor_sock;
        }
        if (global.__vcp_log_monitor_token === this.authToken) {
            delete global.__vcp_log_monitor_token;
        }

        console.log('[LinuxLogMonitorServer] 已关闭');
    }

    _syncShutdown() {
        // 关闭所有客户端连接
        for (const [socket] of this.clients.entries()) {
            try {
                socket.destroy();
            } catch (e) {}
        }
        this.clients.clear();

        if (this.server) {
            try {
                this.server.close();
            } catch (e) {}
            this.server = null;
            if (process.platform !== 'win32') {
                try {
                    fs.unlinkSync(this.sockPath);
                } catch (e) {}
            }
        }
        this.engine = null;
        this.sshManager = null;
        this.anomalyDetector = null;
        this.callbackTrigger = null;

        if (global.__vcp_log_monitor_sock === this.sockPath) {
            delete global.__vcp_log_monitor_sock;
        }
        if (global.__vcp_log_monitor_token === this.authToken) {
            delete global.__vcp_log_monitor_token;
        }

        console.log('[LinuxLogMonitorServer] 已同步关闭');
    }
}

module.exports = new LinuxLogMonitorServer();
