const net = require('net');

function formatRpcError(error) {
    if (!error) return 'Unknown RPC error';
    if (typeof error === 'string') return error;
    if (error.message) return error.message;
    try {
        return JSON.stringify(error);
    } catch (_) {
        return String(error);
    }
}

function createRpcError(error) {
    const wrapped = new Error(formatRpcError(error));
    if (error && typeof error === 'object' && error.code !== undefined) {
        wrapped.code = error.code;
    }
    return wrapped;
}

class SSHManagerProxy {
    constructor(sockPath, authToken = process.env.SSH_MANAGER_TOKEN || '') {
        this.sockPath = sockPath;
        this.authToken = authToken;
        this.socket = null;
        this.connected = false;
        this.nextId = 1;
        this.pending = new Map(); // id -> {resolve, reject, timer}
        this.streamCallbacks = new Map(); // sessionId -> {onData, onError, onClose}
        this.debugLogs = [];
        this._destroyed = false;
        this._reconnectAttempt = 0;
        this.isProxy = true;
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
        if (this._destroyed) throw new Error('SSHManager proxy destroyed');
        let timer = null;
        try {
            await Promise.race([
                this.ready,
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error('SSHManager proxy not connected')),
                        timeoutMs
                    );
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
        if (this._destroyed) throw new Error('SSHManager proxy destroyed');
        if (!this.connected) throw new Error('SSHManager proxy not connected');
    }

    _connect() {
        this.socket = net.createConnection(this.sockPath);
        this.socket.setEncoding('utf8');

        let buffer = '';
        this.socket.on('data', data => {
            buffer += data;
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (line.trim()) this._handleMessage(line);
            }
        });

        this.socket.on('connect', () => {
            this.connected = true;
            this._reconnectAttempt = 0;
            this._resolveReady();
        });
        this.socket.on('error', err => {
            this._log(`Socket error: ${err.message}`);
            this.connected = false;
            this._rejectReady(new Error(`SSHManager proxy not connected: ${err.message}`));
        });
        this.socket.on('close', () => {
            this.connected = false;
            if (this._destroyed) return;
            this._failStreamSessions(new Error('SSHManager proxy disconnected'));
            for (const { reject, timer } of this.pending.values()) {
                clearTimeout(timer);
                reject(new Error('SSHManager proxy disconnected'));
            }
            this.pending.clear();
            if (this._reconnectAttempt < 3) {
                this._reconnectAttempt++;
                this._log(`Connection lost, reconnecting in 2s (attempt ${this._reconnectAttempt})`);
                this._resetReady();
                setTimeout(() => this._connect(), 2000);
            } else {
                this._log('Max reconnect attempts reached');
                this._rejectReady(new Error('SSHManager proxy not connected'));
            }
        });
    }

    _handleMessage(line) {
        try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const { resolve, reject, timer } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                clearTimeout(timer);
                if (msg.error) reject(createRpcError(msg.error));
                else resolve(msg.result);
            } else if (msg.method) {
                // 流式会话的推送通知
                this._handleNotification(msg.method, msg.params);
            }
        } catch (e) {
            console.error('[SSHManagerProxy] 消息解析错误:', e.message);
        }
    }

    _failStreamSessions(error) {
        for (const [sessionId, cb] of this.streamCallbacks.entries()) {
            try {
                if (cb.onError) cb.onError(error.message || String(error));
            } catch (_) {}
            try {
                if (cb.onClose) cb.onClose();
            } catch (_) {}
            this.streamCallbacks.delete(sessionId);
        }
    }

    _handleNotification(method, params) {
        if (method === 'stream.data') {
            const cb = this.streamCallbacks.get(params.sessionId);
            if (cb && cb.onData) cb.onData(params.data);
        } else if (method === 'stream.error') {
            const cb = this.streamCallbacks.get(params.sessionId);
            if (cb && cb.onError) cb.onError(formatRpcError(params.error));
        } else if (method === 'stream.close') {
            const cb = this.streamCallbacks.get(params.sessionId);
            if (cb && cb.onClose) cb.onClose();
            this.streamCallbacks.delete(params.sessionId);
        }
    }

    async _call(method, params = {}, timeoutMs = 30000) {
        await this._waitUntilReady(timeoutMs);
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`SSHManager proxy timeout: ${method}`));
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

    _rpcTimeoutFromCommandOptions(options = {}) {
        const commandTimeout = Number.parseInt(options.timeout, 10);
        if (!Number.isFinite(commandTimeout) || commandTimeout <= 0) {
            return 30000;
        }
        return commandTimeout + 1000;
    }

    // === 与真实 SSHManager 一致的 API ===

    async execute(hostId, command, options = {}) {
        return this._call(
            'execute',
            { hostId, command, options },
            this._rpcTimeoutFromCommandOptions(options)
        );
    }

    async testConnection(hostId) {
        return this._call('testConnection', { hostId });
    }

    getStatus() {
        return this._call('getStatus');
    }

    getPoolStats() {
        return this._call('getPoolStats');
    }

    async connect(hostId, options = {}) {
        return this._call('connect', { hostId, options });
    }

    async disconnect(hostId) {
        return this._call('disconnect', { hostId });
    }

    async disconnectAll() {
        this.destroy();
        return { success: true, mode: 'proxy-local-disconnect' };
    }

    listHosts() {
        return this._call('listHosts');
    }

    async createStreamSession(hostId, command, options = {}) {
        const result = await this._call('createStreamSession', {
            hostId,
            command,
            options
        });
        if (result && result.error) {
            throw createRpcError(result.error);
        }
        if (!result || !result.sessionId) {
            throw new Error('createStreamSession failed: missing sessionId');
        }
        // 返回 ProxyStreamSession，API 与真实 session 一致
        return new ProxyStreamSession(
            this,
            result.sessionId,
            result.hostId,
            result.command
        );
    }

    getAndClearDebugLogs() {
        const logs = [...this.debugLogs];
        this.debugLogs = [];
        return logs;
    }

    _log(msg) {
        const entry = `[${new Date().toISOString()}] [SSHManagerProxy] ${msg}`;
        console.error(entry);
        this.debugLogs.push(entry);
    }

    destroy() {
        this._destroyed = true;
        this._failStreamSessions(new Error('SSHManager proxy destroyed'));
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error('SSHManager proxy destroyed'));
        }
        this.pending.clear();
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
    }
}

class ProxyStreamSession {
    constructor(proxy, sessionId, hostId, command) {
        this.proxy = proxy;
        this.sessionId = sessionId;
        this.hostId = hostId;
        this.command = command;
        this.isActive = false;
        this.startedAt = null;
        this.linesProcessed = 0;
        this.bytesReceived = 0;

        this.onData = null;
        this.onError = null;
        this.onClose = null;
    }

    async start() {
        // 注册回调
        this.proxy.streamCallbacks.set(this.sessionId, {
            onData: data => {
                this.bytesReceived += data.length;
                if (this.onData) this.onData(data);
            },
            onError: error => {
                if (this.onError) this.onError(error);
            },
            onClose: () => {
                this.isActive = false;
                if (this.onClose) this.onClose();
            }
        });
        let result;
        try {
            result = await this.proxy._call('stream.start', { sessionId: this.sessionId });
        } catch (error) {
            this.proxy.streamCallbacks.delete(this.sessionId);
            this.isActive = false;
            throw error;
        }
        if (result && result.error) {
            this.proxy.streamCallbacks.delete(this.sessionId);
            this.isActive = false;
            throw createRpcError(result.error);
        }
        this.startedAt = new Date();
        this.isActive = true;
        return result;
    }

    async stop() {
        const result = await this.proxy._call('stream.stop', { sessionId: this.sessionId });
        if (result && result.error) {
            throw createRpcError(result.error);
        }
        this.isActive = false;
        return result;
    }

    async destroy() {
        this.isActive = false;
        this.proxy.streamCallbacks.delete(this.sessionId);
        const result = await this.proxy._call('stream.destroy', {
            sessionId: this.sessionId
        });
        if (result && result.error) {
            throw createRpcError(result.error);
        }
        return result;
    }

    getStats() {
        return {
            sessionId: this.sessionId,
            hostId: this.hostId,
            command: this.command,
            isActive: this.isActive,
            startedAt: this.startedAt,
            duration: this.startedAt
                ? Date.now() - this.startedAt.getTime()
                : 0,
            linesProcessed: this.linesProcessed,
            bytesReceived: this.bytesReceived
        };
    }
}

module.exports = { SSHManagerProxy };
