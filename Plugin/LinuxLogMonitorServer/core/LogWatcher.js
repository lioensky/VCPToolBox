/**
 * LogWatcher - 单日志文件流式监控器
 *
 * 功能：
 * - 通过 SSH 远程流式读取日志（tail -f）
 * - 内存环形缓冲区（CircularLogBuffer）
 * - 行边界处理
 * - 日志轮转检测（inode 变化）
 * - 异常检测 + 回调触发
 * - 启动预读（prefetchLines）
 *
 * @version 1.1.0
 */

const CircularLogBuffer = require('./CircularLogBuffer');
const crypto = require('crypto');

const MAX_SEEN_HASHES = 10000;

class LogWatcher {
    /**
     * @param {string} hostId - 主机 ID
     * @param {string} logPath - 远程日志路径
     * @param {Object} options
     * @param {Object} options.sshManager - 提供 execute(hostId, command, options) 和 createStreamSession(hostId, command) 的对象
     * @param {Object} options.anomalyDetector - { detect(line, taskId) => anomalies[] }
     * @param {Object} options.callbackTrigger - { trigger(taskId, data) => Promise<boolean> }
     * @param {Function} options.onNotification - (type, data) => void
     * @param {number} [options.prefetchLines=0] - 启动时预读末尾行数
     * @param {number} [options.contextLines=10] - 异常上下文行数
     * @param {number} [options.afterContextLines] - 异常后文行数，默认等于 contextLines
     * @param {number} [options.afterContextTimeoutMs=5000] - 等待后文日志的最长时间
     * @param {string} [options.taskId] - 任务 ID
     * @param {number} [options.bufferCapacity=1000] - 循环缓冲区容量
     * @param {number} [options.maxBytes] - 循环缓冲区字节上限
     */
    constructor(hostId, logPath, options = {}) {
        this.hostId = hostId;
        this.logPath = logPath;

        this.sshManager = options.sshManager;
        this.anomalyDetector = options.anomalyDetector || { detect: () => [] };
        this.callbackTrigger = options.callbackTrigger || {
            trigger: async () => true
        };
        this.onNotification = options.onNotification || (() => {});

        this.prefetchLines = options.prefetchLines ?? 0;
        this.contextLines = options.contextLines ?? 10;
        this.afterContextLines = options.afterContextLines ?? this.contextLines;
        this.afterContextTimeoutMs = options.afterContextTimeoutMs ?? 5000;
        this.taskId = options.taskId || `lw-${crypto.randomUUID()}`;
        this.dedupeConfig = {
            enabled: options.dedupe !== false,
            mode: options.dedupeMode || 'time-window',
            windowSeconds: options.dedupeWindow ?? 60,
            maxHashes: options.maxHashes ?? MAX_SEEN_HASHES
        };
        this.seenHashes = new Map();

        // 状态
        this.state = 'stopped'; // stopped | running | error
        this.offset = 0;
        this.lastInode = null;
        this.lastMtime = null;
        this._stopping = false;

        // 流式会话
        this._streamSession = null;
        this._streamBuffer = '';
        this._rotationChecker = null;
        this._restartTimer = null;
        this._restartAttempts = 0;
        this._restartBaseDelayMs = options.restartBaseDelayMs ?? 2000;
        this._restartMaxDelayMs = options.restartMaxDelayMs ?? 60000;
        this._suppressCloseRestartSessions = new WeakSet();
        this.pendingAnomalies = [];

        // 缓冲区
        this.buffer = new CircularLogBuffer({
            maxLines: options.bufferCapacity ?? options.maxLines ?? 1000,
            maxBytes: options.maxBytes
        });

        // 统计
        this.stats = {
            polls: 0,
            linesRead: 0,
            bytesRead: 0,
            anomaliesDetected: 0,
            callbacksTriggered: 0,
            rotations: 0,
            truncations: 0,
            duplicatesSkipped: 0,
            errors: 0,
            lastPollTime: null,
            startTime: null
        };
    }

    // ========== 公共 API ==========

    async start() {
        if (this.state === 'running') return;
        this.state = 'running';
        this._stopping = false;
        this.stats.startTime = Date.now();

        try {
            const stat = await this._statFile();
            this.lastInode = stat.inode;
            this.lastMtime = stat.mtime;
            this.offset = stat.size;

            await this._startTailStream();

            // 启动后台轮转检测（每 30 秒）
            this._rotationChecker = setInterval(
                () => this._checkRotation(),
                30000
            );
        } catch (err) {
            this.state = 'error';
            this.stats.errors++;
            this._notify('error', { taskId: this.taskId, error: err.message });
            throw err;
        }
    }

    async stop() {
        this._stopping = true;

        if (this._rotationChecker) {
            clearInterval(this._rotationChecker);
            this._rotationChecker = null;
        }

        this._clearRestartTimer();

        await this._closeStreamSession({ suppressRestart: true });

        // 刷新剩余的行缓冲
        if (this._streamBuffer.trim()) {
            this._processLine(this._streamBuffer);
            this._streamBuffer = '';
        }
        this._flushPendingAnomalies();

        this.state = 'stopped';
        return {
            taskId: this.taskId,
            stats: { ...this.stats },
            bufferSize: this.buffer.getStats().lines
        };
    }

    getStatus() {
        return {
            taskId: this.taskId,
            hostId: this.hostId,
            logPath: this.logPath,
            state: this.state,
            linesBuffered: this.buffer.getStats().lines,
            bytesBuffered: this._estimateBytesBuffered(),
            polls: this.stats.polls,
            lastPollTime: this.stats.lastPollTime,
            anomalies: this.stats.anomaliesDetected,
            offset: this.offset,
            lastInode: this.lastInode
        };
    }

    getBuffer() {
        return this.buffer;
    }

    // ========== 内部流式逻辑 ==========

    async _startTailStream() {
        this._clearRestartTimer();
        if (this._streamSession) {
            await this._closeStreamSession({ suppressRestart: true });
        }

        const tailLines = this.prefetchLines > 0 ? this.prefetchLines : 0;
        const tailCmd =
            tailLines > 0
                ? `tail -n ${tailLines} -f ${this._escapeShell(this.logPath)}`
                : `tail -n 0 -f ${this._escapeShell(this.logPath)}`;

        const session = await this.sshManager.createStreamSession(
            this.hostId,
            tailCmd
        );
        this._streamSession = session;

        // 优先使用 onLine（真实 SSHManager），否则退回到 onData + 行分割
        if (session.onLine !== undefined) {
            session.onLine = (line) => {
                this._processLine(line);
            };
        }

        session.onData = (text) => {
            this._ingestStreamData(text);
        };

        session.onClose = () => {
            const suppressRestart = this._suppressCloseRestartSessions.has(session);
            if (this._streamSession === session) {
                this._streamSession = null;
            }
            if (!suppressRestart && this.state === 'running' && !this._stopping) {
                this._notify('streamClosed', {
                    taskId: this.taskId,
                    hostId: this.hostId,
                    logPath: this.logPath
                });
                this._scheduleRestart();
            }
        };

        session.onError = (errText) => {
            this.stats.errors++;
            this._notify('error', { taskId: this.taskId, error: errText });
        };

        try {
            await session.start();
            this._streamSession = session;
            this._restartAttempts = 0;
        } catch (err) {
            if (this._streamSession === session) {
                await this._closeStreamSession({ suppressRestart: true, graceful: false });
            }
            throw err;
        }
    }

    _processLine(line) {
        const trimmed = line.trimEnd();
        if (!trimmed) return;
        if (this._shouldSkipDuplicate(trimmed)) return;

        if (this.pendingAnomalies.length > 0) {
            this._processPendingAnomalies(trimmed);
        }

        const beforeContext = this.buffer
            .getRecent(this.contextLines)
            .map(entry => entry.raw);
        this.buffer.push(trimmed);
        this.stats.linesRead++;
        this.stats.bytesRead += Buffer.byteLength(trimmed, 'utf8') + 1;

        // 异常检测
        const anomalies = this.anomalyDetector.detect(trimmed, this.taskId);
        for (const a of anomalies) {
            this._registerAnomaly(trimmed, a, beforeContext);
        }
    }

    _ingestStreamData(text) {
        // 如果 onLine 已设置，onData 仅用于统计原始字节
        if (this._streamSession && this._streamSession.onLine) {
            this.stats.bytesRead += text.length;
            return;
        }

        // onData 模式：自己做行分割
        this._streamBuffer += text;
        this.stats.bytesRead += text.length;

        const lines = this._streamBuffer.split('\n');
        this._streamBuffer = lines.pop() || '';

        for (const line of lines) {
            this._processLine(line);
        }
    }

    // ========== 轮转 / 截断检测 ==========

    async _checkRotation() {
        if (this._stopping || this.state !== 'running') return;
        try {
            const stat = await this._statFile();

            if (this.lastInode !== null && stat.inode !== this.lastInode) {
                await this._handleLogRotation(stat);
                return;
            }

            if (stat.size < this.offset) {
                await this._handleTruncation(stat.size);
                return;
            }

            this.lastInode = stat.inode;
            this.lastMtime = stat.mtime;
            this.offset = stat.size;
            this.stats.lastPollTime = Date.now();
        } catch (err) {
            // 静默忽略 stat 失败
        }
    }

    async _handleLogRotation(stat) {
        this.stats.rotations++;
        this._flushPendingAnomalies();
        this._notify('rotation', {
            taskId: this.taskId,
            oldInode: this.lastInode,
            newInode: stat.inode,
            logPath: this.logPath
        });

        // 停止旧 tail 流，轮转路径会立即启动新流，避免 onClose 再安排一次重启。
        await this._closeStreamSession({ suppressRestart: true });
        this._clearRestartTimer();

        this.offset = 0;
        this.lastInode = stat.inode;
        this.lastMtime = stat.mtime;
        this._streamBuffer = '';
        this.buffer.clear();

        // 启动新 tail 流（不预读历史）
        await this._startTailStream();
    }

    async _handleTruncation(newSize) {
        this.stats.truncations++;
        this._flushPendingAnomalies();
        this._notify('truncation', {
            taskId: this.taskId,
            oldOffset: this.offset,
            newSize,
            logPath: this.logPath
        });

        // 截断时统一由显式 restart 重建 tail 流，避免 destroy 的 onClose 重复排队。
        await this._closeStreamSession({ suppressRestart: true, graceful: false });

        this.offset = newSize;
        this._streamBuffer = '';
        this.buffer.clear();

        this._scheduleRestart();
    }

    _scheduleRestart() {
        if (this._stopping || this.state !== 'running') return;
        this._clearRestartTimer();
        const delayMs = Math.min(
            this._restartBaseDelayMs * (2 ** this._restartAttempts),
            this._restartMaxDelayMs
        );
        this._restartTimer = setTimeout(() => {
            this._restartTimer = null;
            if (this.state === 'running' && !this._stopping) {
                this._startTailStream().catch((err) => {
                    this.stats.errors++;
                    this._restartAttempts = Math.min(this._restartAttempts + 1, 10);
                    this._notify('error', {
                        taskId: this.taskId,
                        error: err.message,
                        nextRetryMs: Math.min(
                            this._restartBaseDelayMs * (2 ** this._restartAttempts),
                            this._restartMaxDelayMs
                        )
                    });
                    this._scheduleRestart();
                });
            }
        }, delayMs);
    }

    _clearRestartTimer() {
        if (this._restartTimer) {
            clearTimeout(this._restartTimer);
            this._restartTimer = null;
        }
    }

    async _closeStreamSession({ suppressRestart = false, graceful = true } = {}) {
        const session = this._streamSession;
        if (!session) return;

        if (suppressRestart) {
            this._suppressCloseRestartSessions.add(session);
        }

        try {
            if (graceful && typeof session.stop === 'function') {
                await session.stop();
                await new Promise((r) => setTimeout(r, 500));
            }
            if (typeof session.destroy === 'function') {
                await session.destroy();
            }
        } catch (_) {
        } finally {
            if (this._streamSession === session) {
                this._streamSession = null;
            }
        }
    }

    // ========== 异常触发 ==========

    _registerAnomaly(line, anomaly, beforeContext = null) {
        this.stats.anomaliesDetected++;

        const before = beforeContext || this.buffer
            .getRecent(this.contextLines)
            .map(entry => entry.raw);
        const data = {
            taskId: this.taskId,
            hostId: this.hostId,
            logPath: this.logPath,
            line,
            anomaly,
            context: {
                before,
                after: []
            },
            timestamp: Date.now()
        };

        if (this.afterContextLines > 0) {
            const pending = {
                data,
                afterLinesNeeded: this.afterContextLines,
                afterLinesCollected: 0,
                timeout: null
            };
            if (this.afterContextTimeoutMs > 0) {
                pending.timeout = setTimeout(() => {
                    this._flushPendingAnomaly(pending);
                }, this.afterContextTimeoutMs);
                if (typeof pending.timeout.unref === 'function') {
                    pending.timeout.unref();
                }
            }
            this.pendingAnomalies.push(pending);
            return;
        }

        this._notify('anomaly', data);
    }

    _triggerAnomaly(line, anomaly, beforeContext = null) {
        this._registerAnomaly(line, anomaly, beforeContext);
    }

    _processPendingAnomalies(line) {
        const completed = [];
        for (const pending of this.pendingAnomalies) {
            if (pending.afterLinesCollected < pending.afterLinesNeeded) {
                pending.data.context.after.push(line);
                pending.afterLinesCollected++;
            }
            if (pending.afterLinesCollected >= pending.afterLinesNeeded) {
                completed.push(pending);
            }
        }

        for (const pending of completed) {
            this._flushPendingAnomaly(pending);
        }
    }

    _flushPendingAnomalies() {
        const pendingAnomalies = this.pendingAnomalies.splice(0);
        for (const pending of pendingAnomalies) {
            this._emitPendingAnomaly(pending);
        }
    }

    _flushPendingAnomaly(pending) {
        const index = this.pendingAnomalies.indexOf(pending);
        if (index < 0) return;
        this.pendingAnomalies.splice(index, 1);
        this._emitPendingAnomaly(pending);
    }

    _emitPendingAnomaly(pending) {
        if (pending.timeout) {
            clearTimeout(pending.timeout);
            pending.timeout = null;
        }
        this._notify('anomaly', pending.data);
    }

    // ========== 文件信息 ==========

    async _statFile() {
        const safeLogPath = this._escapeShell(this.logPath);
        const cmd = `(stat -c '%s %i %Y' ${safeLogPath} 2>/dev/null || stat -f '%z %i %m' ${safeLogPath} 2>/dev/null || echo "STAT_FAILED")`;
        const result = await this.sshManager.execute(this.hostId, cmd, {
            timeout: 5000
        });
        return this._parseStatOutput(result.stdout || '');
    }

    _parseStatOutput(stdout) {
        const fields = String(stdout || '')
            .trim()
            .replace(/\\n/g, ' ')
            .split(/\s+/)
            .filter(Boolean);

        if (fields[0] === 'STAT_FAILED' || fields.length < 3) {
            throw new Error(`Failed to stat file: ${this.logPath}`);
        }

        const size = Number.parseInt(fields[0], 10);
        const mtime = Number.parseInt(fields[2], 10);
        if (!Number.isFinite(size) || !fields[1] || !Number.isFinite(mtime)) {
            throw new Error(`Failed to stat file: ${this.logPath}`);
        }

        return {
            size,
            inode: fields[1],
            mtime
        };
    }

    // ========== 工具 ==========

    _escapeShell(str) {
        return `'${str.replace(/'/g, "'\\''")}'`;
    }

    _hashLine(line) {
        return crypto.createHash('md5').update(line).digest('hex').slice(0, 16);
    }

    _shouldSkipDuplicate(line) {
        if (!this.dedupeConfig.enabled || this.dedupeConfig.mode === 'disabled') {
            return false;
        }

        const lineHash = this._hashLine(line);
        const now = Date.now();
        const lastSeen = this.seenHashes.get(lineHash);
        if (lastSeen !== undefined) {
            if (this.dedupeConfig.mode === 'permanent') {
                this.stats.duplicatesSkipped++;
                return true;
            }
            if (this.dedupeConfig.mode === 'time-window') {
                const elapsed = (now - lastSeen) / 1000;
                if (elapsed < this.dedupeConfig.windowSeconds) {
                    this.stats.duplicatesSkipped++;
                    return true;
                }
            }
        }

        this.seenHashes.set(lineHash, now);
        if (this.seenHashes.size > this.dedupeConfig.maxHashes) {
            const oldest = this.seenHashes.keys().next().value;
            this.seenHashes.delete(oldest);
        }
        return false;
    }

    _estimateBytesBuffered() {
        return this.buffer.getAllLines().reduce(
            (sum, entry) => sum + Buffer.byteLength(entry.raw, 'utf8') + 1,
            0
        );
    }

    _notify(type, data) {
        try {
            this.onNotification(type, data);
        } catch (_) {
            // 通知回调不应影响引擎
        }
    }
}

module.exports = LogWatcher;
