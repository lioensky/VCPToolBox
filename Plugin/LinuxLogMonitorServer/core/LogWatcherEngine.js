/**
 * LogWatcherEngine - 多日志文件轮询管理引擎
 *
 * 负责：
 * - 管理多个 LogWatcher 实例（Map<taskId, LogWatcher>）
 * - 统一注入 sshManager / anomalyDetector / callbackTrigger
 * - 生命周期管理（启动、停止、批量关闭）
 *
 * @version 1.0.0
 */

const LogWatcher = require('./LogWatcher');

class LogWatcherEngine {
    /**
     * @param {Object} options
     * @param {Object} options.sshManager - SSHManagerProxy 实例
     * @param {Object} options.anomalyDetector - AnomalyDetector 实例
     * @param {Object} options.callbackTrigger - CallbackTrigger 实例
     * @param {Function} options.onNotification - (type, data) => void
     */
    constructor(options = {}) {
        this.watchers = new Map(); // taskId -> LogWatcher
        this.startingWatchers = new Set(); // 正在 await start() 的 taskId
        this.pendingStopReasons = new Map(); // taskId -> reason
        this.sshManager = options.sshManager;
        this.anomalyDetector = options.anomalyDetector;
        this.callbackTrigger = options.callbackTrigger;
        this.onNotification = options.onNotification || (() => {});
        this._taskIdSeq = 0;
    }

    /**
     * 启动一个新的日志监控任务
     * @param {Object} config
     * @param {string} config.hostId
     * @param {string} config.logPath
     * @param {Array} config.rules - 规则列表（会自动注册到 anomalyDetector）
     * @param {Object} config.options - 传递给 LogWatcher 的额外选项
     * @returns {string} taskId
     */
    async startWatcher(config) {
        const taskId =
            config.taskId ||
            this._generateTaskId(config.hostId, config.logPath);

        if (this.watchers.has(taskId) || this.startingWatchers.has(taskId)) {
            throw new Error(`Watcher already exists for taskId: ${taskId}`);
        }

        // 注册规则
        if (config.rules && this.anomalyDetector) {
            for (const rule of config.rules) {
                this.anomalyDetector.addRule(rule, taskId);
            }
        }

        const watcherOptions = {
            sshManager: this.sshManager,
            anomalyDetector: this.anomalyDetector,
            callbackTrigger: this.callbackTrigger,
            onNotification: this.onNotification,
            taskId,
            prefetchLines: config.prefetchLines ?? config.contextLines,
            contextLines: config.contextLines,
            afterContextLines: config.afterContextLines,
            afterContextTimeoutMs: config.afterContextTimeoutMs,
            dedupe: config.dedupe,
            dedupeMode: config.dedupeMode,
            dedupeWindow: config.dedupeWindow,
            maxHashes: config.maxHashes,
            bufferCapacity: config.maxLines ?? config.bufferCapacity,
            maxBytes: config.maxBytes,
            ...(config.options || {})
        };

        const watcher = new LogWatcher(
            config.hostId,
            config.logPath,
            watcherOptions
        );
        this.startingWatchers.add(taskId);
        try {
            await watcher.start();
        } catch (err) {
            this.startingWatchers.delete(taskId);
            this.pendingStopReasons.delete(taskId);
            if (this.anomalyDetector) {
                this.anomalyDetector.removeTaskRules(taskId);
            }
            throw err;
        }
        this.startingWatchers.delete(taskId);

        const pendingStopReason = this.pendingStopReasons.get(taskId);
        if (pendingStopReason) {
            this.pendingStopReasons.delete(taskId);
            const result = await watcher.stop();
            if (this.anomalyDetector) {
                this.anomalyDetector.removeTaskRules(taskId);
            }
            this.onNotification('stopped', {
                taskId,
                hostId: watcher.hostId,
                logPath: watcher.logPath,
                reason: pendingStopReason,
                stats: result.stats
            });
            return taskId;
        }

        this.watchers.set(taskId, watcher);

        return taskId;
    }

    /**
     * 停止指定任务
     * @param {string} taskId
     * @returns {Object} stop 返回值
     */
    async stopWatcher(taskId, reason = 'stopped') {
        const watcher = this.watchers.get(taskId);
        if (!watcher) {
            if (this.startingWatchers.has(taskId)) {
                this.pendingStopReasons.set(taskId, reason);
                return {
                    taskId,
                    pendingStart: true,
                    stats: {}
                };
            }
            return null;
        }

        const result = await watcher.stop();
        this.watchers.delete(taskId);
        this.onNotification('stopped', {
            taskId,
            hostId: watcher.hostId,
            logPath: watcher.logPath,
            reason,
            stats: result.stats
        });

        // 清理任务规则
        if (this.anomalyDetector) {
            this.anomalyDetector.removeTaskRules(taskId);
        }

        return result;
    }

    /**
     * 获取指定 Watcher
     * @param {string} taskId
     * @returns {LogWatcher|null}
     */
    getWatcher(taskId) {
        return this.watchers.get(taskId) || null;
    }

    /**
     * 获取所有 Watcher
     * @returns {Array<{taskId: string, watcher: LogWatcher}>}
     */
    getAllWatchers() {
        return Array.from(this.watchers.entries()).map(([taskId, watcher]) => ({
            taskId,
            watcher
        }));
    }

    /**
     * 获取引擎状态
     * @returns {Object}
     */
    getStatus() {
        const statuses = [];
        for (const [taskId, watcher] of this.watchers) {
            statuses.push(watcher.getStatus());
        }
        return {
            watcherCount: this.watchers.size,
            watchers: statuses
        };
    }

    /**
     * 关闭所有 Watcher
     */
    async shutdown() {
        const promises = [];
        for (const [taskId] of this.watchers) {
            promises.push(this.stopWatcher(taskId, 'shutdown'));
        }
        await Promise.all(promises);
    }

    // ========== 内部 ==========

    _generateTaskId(hostId, logPath) {
        this._taskIdSeq++;
        const hash = `${hostId}-${logPath}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        return `lwe-${hash}-${this._taskIdSeq}`;
    }
}

module.exports = LogWatcherEngine;
