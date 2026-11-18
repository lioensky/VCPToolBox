const net = require('net');

const START_MONITOR_TIMEOUT_MS = 180000;

/**
 * LogMonitor UDS JSON-RPC 代理客户端
 * 通过 Unix Domain Socket 与常驻 LogMonitorServer 通信
 */
class LogMonitorProxy {
    constructor(sockPath, authToken = process.env.LOG_MONITOR_TOKEN || '') {
        this.sockPath = sockPath;
        this.authToken = authToken;
        this.socket = null;
        this.connected = false;
        this.nextId = 1;
        this.pending = new Map(); // id -> {resolve, reject, timer}
        this.subscriptions = new Map(); // taskId -> {onAnomaly, onError, onStopped}
        this.buffer = '';
        this._destroyed = false;
        this._resetReady();
        this._connect();
    }

    _resetReady() {
        this.ready = new Promise((resolve, reject) => {
            this._resolveReady = resolve;
            this._rejectReady = reject;
        });
        this.ready.catch(() => {});
    }

    async _waitUntilReady(timeoutMs) {
        if (this.connected) return;
        if (this._destroyed) throw new Error('LogMonitor proxy destroyed');
        let timer = null;
        try {
            await Promise.race([
                this.ready,
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error('LogMonitor proxy not connected')),
                        timeoutMs
                    );
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
        if (this._destroyed) throw new Error('LogMonitor proxy destroyed');
        if (!this.connected) throw new Error('LogMonitor proxy not connected');
    }

    _connect() {
        this.socket = net.createConnection(this.sockPath);
        this.socket.setEncoding('utf8');
        this.socket.on('data', data => {
            this.buffer += data;
            const lines = this.buffer.split('\n');
            this.buffer = lines.pop();
            for (const line of lines) {
                if (line.trim()) this._handleMessage(line);
            }
        });
        this.socket.on('connect', () => {
            this.connected = true;
            this._resolveReady();
        });
        this.socket.on('error', err => {
            console.error('[LogMonitorProxy] Socket error:', err.message);
            this.connected = false;
            this._rejectReady(new Error(`LogMonitor proxy not connected: ${err.message}`));
        });
        this.socket.on('close', () => {
            this.connected = false;
            if (this._destroyed) return;
            for (const { reject, timer } of this.pending.values()) {
                clearTimeout(timer);
                reject(new Error('LogMonitor proxy disconnected'));
            }
            this.pending.clear();
            this._rejectReady(new Error('LogMonitor proxy not connected'));
        });
    }

    _handleMessage(line) {
        try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const { resolve, reject, timer } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                clearTimeout(timer);
                if (msg.error)
                    reject(new Error(msg.error.message || msg.error));
                else resolve(msg.result);
            } else if (msg.method) {
                // 通知（无 id）
                this._handleNotification(msg.method, msg.params);
            }
        } catch (e) {
            console.error('[LogMonitorProxy] 消息解析错误:', e.message);
        }
    }

    _handleNotification(method, params) {
        const taskId = params && params.taskId;
        if (!taskId) return;
        const cb = this.subscriptions.get(taskId);
        if (!cb) return;

        if (method === 'anomaly.detected') {
            if (cb.onAnomaly) cb.onAnomaly(params);
        } else if (method === 'watcher.error') {
            if (cb.onError) cb.onError(params);
        } else if (method === 'watcher.stopped') {
            if (cb.onStopped) cb.onStopped(params);
            // 自动取消订阅，避免内存泄漏
            this.subscriptions.delete(taskId);
        }
    }

    async _call(method, params = {}, timeoutMs = 30000) {
        await this._waitUntilReady(timeoutMs);
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`LogMonitor proxy timeout: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            const line =
                JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    method,
                    params,
                    authToken: this.authToken
                }) + '\n';
            this.socket.write(line, err => {
                if (!err) return;
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err);
            });
        });
    }

    // === JSON-RPC API ===

    async startMonitor(params) {
        try {
            return await this._call('startMonitor', params, START_MONITOR_TIMEOUT_MS);
        } catch (error) {
            if (params && params.taskId) {
                try {
                    await this._call('stopMonitor', {
                        taskId: params.taskId,
                        reason: 'client_start_rpc_failed',
                        requireOwner: true
                    });
                } catch (_) {}
            }
            throw error;
        }
    }
    async stopMonitor(params) {
        const result = await this._call('stopMonitor', params);
        if (result && result.error) {
            throw new Error(result.error);
        }
        return result;
    }
    async searchLog(params) {
        return this._call('searchLog', params);
    }
    async lastErrors(params) {
        return this._call('lastErrors', params);
    }
    async logStats(params) {
        return this._call('logStats', params);
    }
    async getStatus() {
        return this._call('getStatus', {});
    }
    async getBufferStats(params) {
        return this._call('getBufferStats', params);
    }
    async subscribe(params) {
        return this._call('subscribe', params);
    }
    async unsubscribe(params) {
        return this._call('unsubscribe', params);
    }

    // === 长连接订阅 ===

    subscribeNotifications(taskId, callbacks) {
        this.subscriptions.set(taskId, callbacks);
    }

    unsubscribeNotifications(taskId) {
        this.subscriptions.delete(taskId);
    }

    destroy() {
        this._destroyed = true;
        // 清理所有 pending Promise
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error('LogMonitor proxy destroyed'));
        }
        this.pending.clear();
        this.subscriptions.clear();
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
    }
}

module.exports = { LogMonitorProxy };
