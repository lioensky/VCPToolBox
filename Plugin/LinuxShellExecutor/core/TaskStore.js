'use strict';

/**
 * TaskStore - LinuxShellExecutor 次世代任务追踪器
 *
 * 职责：
 * 1. 维护 runId -> TaskMetadata 的内存注册表；
 * 2. 生成 POSIX 原子回执包装脚本（log + json + pid 三件套）；
 * 3. 将任务元数据以原子写方式落盘，支持跨进程 queryTask；
 * 4. 提供 query / list / cancel 所需的探针命令构造。
 *
 * 设计要点：
 * - 完成判据只看 /tmp/vcp_{runId}.json 是否存在；
 * - 回执先写 .tmp 再 mv，读取方永远不会看到半截 JSON；
 * - 日志与回执分离，支持 tail / 增量读取，不依赖任何第三方插件。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const DEFAULT_STATE_DIR = path.join(__dirname, '..', 'state');
const STATE_VERSION = 1;
const MAX_TASKS = 300;
const FINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'error']);
const STALE_TASK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LOG_TAIL_BYTES = 256 * 1024;
const PROBE_LOG_TAIL_BYTES = 512 * 1024;

function buildWarnLog() {
    return (...args) => {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
            console.warn('[TaskStore]', ...args);
        }
    };
}

const warn = buildWarnLog();

function sanitizeHostId(hostId) {
    const safe = String(hostId || 'local')
        .replace(/[^a-zA-Z0-9_.-]/g, '_')
        .slice(0, 48);
    return safe || 'local';
}

function createRunId(hostId) {
    const safeHost = sanitizeHostId(hostId);
    const stamp = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    return `task_${safeHost}_${stamp}_${rand}`;
}

function isFinalStatus(status) {
    return FINAL_STATUSES.has(status);
}

function normalizeTask(raw = {}) {
    const hostId = raw.hostId || 'local';
    const runId = raw.runId || createRunId(hostId);
    const startTime = Number(raw.startTime) || Date.now();
    const terminalId = raw.terminalId || 'default';
    const task = {
        runId,
        taskId: runId,
        hostId,
        command: raw.command || '',
        execCommand: raw.execCommand || raw.command || '',
        terminalId,
        mode: raw.mode || 'detached',
        status: raw.status || 'running_detached',
        logPath: raw.logPath || `/tmp/vcp_${runId}.log`,
        receiptPath: raw.receiptPath || `/tmp/vcp_${runId}.json`,
        receiptTempPath: raw.receiptTempPath || `/tmp/vcp_${runId}.json.tmp`,
        pidPath: raw.pidPath || `/tmp/vcp_${runId}.pid`,
        scriptPath: raw.scriptPath || `/tmp/vcp_${runId}.sh`,
        startTime,
        endTime: raw.endTime || null,
        exitCode: raw.exitCode === undefined ? null : raw.exitCode,
        durationMs: Number(raw.durationMs) || Math.max(0, Date.now() - startTime),
        timeout: Number(raw.timeout) || null,
        lastOutput: typeof raw.lastOutput === 'string' ? raw.lastOutput : '',
        lastCheckedAt: Number(raw.lastCheckedAt) || null,
        createdAt: Number(raw.createdAt) || startTime,
        updatedAt: Number(raw.updatedAt) || Date.now()
    };
    return task;
}

class TaskStore {
    constructor(options = {}) {
        this.stateDir = options.stateDir || DEFAULT_STATE_DIR;
        this.stateFile = path.join(this.stateDir, 'tasks.json');
        this.tasks = new Map();
        this._persistTimer = null;
        this._persistQueue = Promise.resolve();
        this._loaded = false;
        if (options.autoLoad !== false) {
            this.load();
        }
    }

    load() {
        if (this._loaded) return;
        this._loaded = true;
        try {
            const raw = fs.readFileSync(this.stateFile, 'utf8');
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
            for (const item of list) {
                if (!item || !item.runId) continue;
                const task = normalizeTask(item);
                this.tasks.set(task.runId, task);
            }
            this.prune();
        } catch (error) {
            if (error && error.code !== 'ENOENT') {
                warn(`加载任务状态失败: ${error.message}`);
            }
        }
    }

    _schedulePersist() {
        if (this._persistTimer) return;
        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            this._persistNow();
        }, 250);
        if (typeof this._persistTimer.unref === 'function') {
            this._persistTimer.unref();
        }
    }

    _persistNow() {
        // 落盘只保留尾部日志快照，避免 300 个任务把 state 文件撑到百 MB 级。
        const tasks = Array.from(this.tasks.values()).map((task) => ({
            ...task,
            lastOutput: typeof task.lastOutput === 'string'
                ? task.lastOutput.slice(-16 * 1024)
                : ''
        }));
        const payload = JSON.stringify(
            {
                version: STATE_VERSION,
                savedAt: new Date().toISOString(),
                tasks
            },
            null,
            2
        );
        this._persistQueue = this._persistQueue
            .then(async () => {
                await fsp.mkdir(this.stateDir, { recursive: true });
                const tempFile = `${this.stateFile}.tmp`;
                await fsp.writeFile(tempFile, payload, 'utf8');
                await fsp.rename(tempFile, this.stateFile);
            })
            .catch((error) => {
                warn(`持久化任务状态失败: ${error.message}`);
            });
        return this._persistQueue;
    }

    async flush() {
        if (this._persistTimer) {
            clearTimeout(this._persistTimer);
            this._persistTimer = null;
        }
        this._persistNow();
        await this._persistQueue;
    }

    prune() {
        const now = Date.now();
        const all = Array.from(this.tasks.values());
        const active = [];
        const finished = [];
        for (const task of all) {
            if (isFinalStatus(task.status)) {
                if (task.endTime && now - task.endTime > STALE_TASK_MAX_AGE_MS) {
                    this.tasks.delete(task.runId);
                    continue;
                }
                finished.push(task);
            } else if (now - task.startTime > STALE_TASK_MAX_AGE_MS) {
                // 长期未更新的非终态任务视为失联，保留记录但标记 error
                task.status = 'error';
                task.endTime = task.lastCheckedAt || now;
                task.durationMs = Math.max(0, task.endTime - task.startTime);
                task.updatedAt = now;
                finished.push(task);
            } else {
                active.push(task);
            }
        }
        finished.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
        const keepFinished = Math.max(0, MAX_TASKS - active.length);
        for (const task of finished.slice(keepFinished)) {
            this.tasks.delete(task.runId);
        }
    }

    createTask({
        hostId,
        command,
        execCommand = null,
        terminalId = 'default',
        timeout = null,
        mode = 'detached'
    } = {}) {
        const runId = createRunId(hostId);
        const task = normalizeTask({
            runId,
            hostId,
            command,
            execCommand: execCommand || command,
            terminalId,
            mode,
            timeout,
            status: mode === 'terminal' ? 'running' : 'running_detached',
            startTime: Date.now()
        });
        this.tasks.set(runId, task);
        this.prune();
        this._schedulePersist();
        return task;
    }

    getTask(taskId) {
        if (!taskId) return null;
        const id = String(taskId).trim();
        if (!id) return null;
        if (this.tasks.has(id)) return this.tasks.get(id);

        const matches = [];
        for (const task of this.tasks.values()) {
            if (task.runId === id || task.runId.startsWith(id)) {
                matches.push(task);
            }
        }
        return matches.length === 1 ? matches[0] : null;
    }

    updateTask(taskId, patch = {}) {
        const task = this.getTask(taskId);
        if (!task) return null;

        Object.assign(task, patch, { updatedAt: Date.now() });

        if (isFinalStatus(task.status)) {
            if (!task.endTime) {
                task.endTime = task.lastCheckedAt || Date.now();
            }
            task.durationMs = Math.max(0, task.endTime - task.startTime);
        } else {
            task.durationMs = Math.max(0, Date.now() - task.startTime);
        }

        this._schedulePersist();
        return task;
    }

    removeTask(taskId) {
        const task = this.getTask(taskId);
        if (!task) return false;
        const removed = this.tasks.delete(task.runId);
        if (removed) this._schedulePersist();
        return removed;
    }

    listTasks({ hostId = null, status = null, limit = 50 } = {}) {
        let hostFilter = null;
        if (Array.isArray(hostId)) {
            hostFilter = new Set(hostId.map((item) => String(item).trim()).filter(Boolean));
        } else if (hostId !== null && hostId !== undefined && String(hostId).trim()) {
            hostFilter = new Set(
                String(hostId)
                    .split(/[,\s]+/)
                    .map((item) => item.trim())
                    .filter(Boolean)
            );
        }

        let statusFilter = null;
        if (Array.isArray(status)) {
            statusFilter = new Set(status.map((item) => String(item).trim()).filter(Boolean));
        } else if (status) {
            statusFilter = new Set(
                String(status)
                    .split(/[,\s]+/)
                    .map((item) => item.trim())
                    .filter(Boolean)
            );
        }

        let list = Array.from(this.tasks.values());
        if (hostFilter) {
            list = list.filter((task) => hostFilter.has(task.hostId));
        }
        if (statusFilter) {
            list = list.filter((task) => statusFilter.has(task.status));
        }
        list.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
        const max = Number.isFinite(Number(limit)) && Number(limit) > 0
            ? Number(limit)
            : 50;
        return list.slice(0, max);
    }

    getStats() {
        const counts = {};
        for (const task of this.tasks.values()) {
            counts[task.status] = (counts[task.status] || 0) + 1;
        }
        return {
            total: this.tasks.size,
            counts,
            stateFile: this.stateFile
        };
    }

    // ==================== POSIX 包装脚本构造 ====================

    /**
     * 生成在目标主机上落盘的执行脚本。
     * 该脚本通过 trap EXIT 保证无论命令如何退出都会写入原子回执。
     */
    buildScript(task) {
        const runId = task.runId;
        return [
            '#!/bin/bash',
            `# VCP detached task: ${runId}`,
            '_vcp_finish() {',
            '  _vcp_ec=$?',
            '  _vcp_ts=$(date +%s%3N 2>/dev/null)',
            '  case "$_vcp_ts" in *[!0-9]*|"") _vcp_ts="$(date +%s)000" ;; esac',
            `  printf '{"exit":%s,"ts":%s,"status":"completed"}\\n' "$_vcp_ec" "$_vcp_ts" > '/tmp/vcp_${runId}.json.tmp'`,
            `  mv -f '/tmp/vcp_${runId}.json.tmp' '/tmp/vcp_${runId}.json'`,
            '}',
            'trap _vcp_finish EXIT',
            task.execCommand || task.command,
            ''
        ].join('\n');
    }

    /**
     * 只启动任务并立刻返回 PID（用于 isLongRunning 立即挂机）。
     */
    buildStartCommand(task) {
        const runId = task.runId;
        const delimiter = `VCP_DETACH_${runId}`;
        return [
            'umask 077',
            `cat > '/tmp/vcp_${runId}.sh' <<'${delimiter}'`,
            this.buildScript(task),
            delimiter,
            '_vcp_shell=/bin/bash',
            '[ -x /bin/bash ] || _vcp_shell=/bin/sh',
            `nohup "$_vcp_shell" '/tmp/vcp_${runId}.sh' </dev/null >'/tmp/vcp_${runId}.log' 2>&1 &`,
            `echo $! > '/tmp/vcp_${runId}.pid'`,
            `cat '/tmp/vcp_${runId}.pid'`
        ].join('\n');
    }

    /**
     * 启动任务并在同一个通道内等待回执，最多 syncWaitMs。
     * 超时后通道由调用方关闭，但 nohup 子进程继续运行。
     */
    buildStartAndWaitCommand(task, syncWaitMs = 30000) {
        const runId = task.runId;
        const ticks = Math.max(1, Math.ceil(Number(syncWaitMs) / 200));
        return [
            this.buildStartCommand(task),
            '_vcp_i=0',
            `while [ ! -f '/tmp/vcp_${runId}.json' ] && [ "$_vcp_i" -lt ${ticks} ]; do sleep 0.2; _vcp_i=$((_vcp_i + 1)); done`,
            `if [ -f '/tmp/vcp_${runId}.json' ]; then`,
            "  printf '__VCP_READY__\\n'",
            `  cat '/tmp/vcp_${runId}.json'`,
            "  printf '\\n__VCP_LOG__\\n'",
            `  tail -c ${DEFAULT_LOG_TAIL_BYTES} '/tmp/vcp_${runId}.log' 2>/dev/null || true`,
            'else',
            "  printf '__VCP_TIMEOUT__\\n'",
            `  tail -c 65536 '/tmp/vcp_${runId}.log' 2>/dev/null || true`,
            'fi'
        ].join('\n');
    }

    /**
     * 非阻塞探针：检查回执并读取尾部日志。
     */
    buildProbeCommand(task, options = {}) {
        const runId = task.runId;
        const tailBytes = Math.max(
            4096,
            Math.min(
                Number(options.tailBytes) || PROBE_LOG_TAIL_BYTES,
                4 * 1024 * 1024
            )
        );
        return [
            `if [ -f '/tmp/vcp_${runId}.json' ]; then`,
            "  printf '__VCP_READY__\\n'",
            `  cat '/tmp/vcp_${runId}.json'`,
            'else',
            "  printf '__VCP_PENDING__\\n'",
            'fi',
            "printf '\\n__VCP_LOG__\\n'",
            `tail -c ${tailBytes} '/tmp/vcp_${runId}.log' 2>/dev/null || true`
        ].join('\n');
    }

    /**
     * 终止任务并清理哨兵文件，输出被终止的 PID。
     */
    buildCancelCommand(task) {
        const runId = task.runId;
        return [
            '_vcp_pid=""',
            `if [ -f '/tmp/vcp_${runId}.pid' ]; then _vcp_pid=$(cat '/tmp/vcp_${runId}.pid' 2>/dev/null); fi`,
            'if [ -n "$_vcp_pid" ]; then',
            '  pkill -TERM -P "$_vcp_pid" 2>/dev/null || true',
            '  kill -TERM "$_vcp_pid" 2>/dev/null || true',
            '  sleep 0.3',
            '  pkill -KILL -P "$_vcp_pid" 2>/dev/null || true',
            '  kill -KILL "$_vcp_pid" 2>/dev/null || true',
            'fi',
            `rm -f '/tmp/vcp_${runId}.log' '/tmp/vcp_${runId}.json' '/tmp/vcp_${runId}.json.tmp' '/tmp/vcp_${runId}.pid' '/tmp/vcp_${runId}.sh'`,
            "printf '__VCP_PID__%s\\n' \"$_vcp_pid\""
        ].join('\n');
    }
}

const taskStore = new TaskStore();

module.exports = {
    TaskStore,
    taskStore,
    createRunId,
    isFinalStatus,
    FINAL_STATUSES
};
