/**
 * SSHManagerService - SSH 连接池常驻服务
 *
 * 功能：
 * - 在 VCP 主进程内常驻运行
 * - 通过 Unix Domain Socket 暴露 JSON-RPC 服务
 * - 为 stdio 插件提供 SSH 连接复用
 *
 * @version 2.0.0
 */

const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { getSSHManager, resetSSHManager } = require('../../modules/SSHManager');

function createIpcPath(prefix) {
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\${prefix}-${process.pid}`;
    }
    return `/tmp/${prefix}-${process.pid}.sock`;
}

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
            `[SSHManagerService] 无法加载主机配置: ${configPath}: ${e.message}`
        );
    }
    return { hosts: {}, globalSettings: {} };
}

function serializeError(error) {
    if (!error) return { message: 'Unknown error' };
    if (typeof error === 'string') return { message: error };
    return {
        message: error.message || String(error),
        ...(error.code !== undefined ? { code: error.code } : {})
    };
}

function sanitizeConnectionResult(connection, hostId) {
    return {
        success: true,
        type: connection?.type || 'unknown',
        hostId: connection?.hostId || hostId,
        isConnected: connection?.type === 'local'
            ? true
            : connection?.isConnected === true,
        isPooled: connection?.isPooled === true,
        ...(connection?.connectedAt
            ? { connectedAt: connection.connectedAt instanceof Date ? connection.connectedAt.toISOString() : connection.connectedAt }
            : {}),
        ...(connection?.lastUsedAt !== undefined ? { lastUsedAt: connection.lastUsedAt } : {})
    };
}

class SSHManagerService {
    constructor() {
        this.sshManager = null;
        this.server = null;
        this.sockPath = null;
        this.clients = new Map(); // socket -> {id}
        this.nextClientId = 1;
        this.streamSessions = new Map();
        this.authToken = crypto.randomBytes(32).toString('hex');
    }

    async initialize(config, dependencies) {
        if (this.server || this.sshManager || this.clients.size > 0 || this.streamSessions.size > 0) {
            await this.shutdown();
        }
        this.authToken = crypto.randomBytes(32).toString('hex');

        // 加载 hosts.json
        const hostsConfig = loadHostsConfig();

        // 常驻服务是单进程环境，安全启用连接池持久化
        if (!hostsConfig.globalSettings) {
            hostsConfig.globalSettings = {};
        }
        hostsConfig.globalSettings.usePool = true;

        // 资产存在性判断：检查是否有 type === 'ssh' 且配置完整的主机
        if (!this._hasValidAssets(hostsConfig)) {
            console.log(
                '[SSHManagerService] 未检测到有效的 SSH 资产，服务静默跳过初始化'
            );
            return;
        }

        // 创建 SSHManager 实例（启用连接池）
        this.sshManager = getSSHManager(hostsConfig, { basePath: __dirname });
        if (!this.sshManager) {
            console.error('[SSHManagerService] 创建 SSHManager 实例失败');
            return;
        }

        // 启动 IPC 服务器：Linux/macOS 使用 UDS，Windows 使用命名管道
        this.sockPath = createIpcPath('vcp-ssh-manager');
        await this._startUDSServer();

        // 将 sockPath 保存到全局，供 PluginManager 读取
        global.__vcp_ssh_manager_sock = this.sockPath;
        global.__vcp_ssh_manager_token = this.authToken;

        // 进程退出时清理 socket；SIGINT/SIGTERM 由主进程 gracefulShutdown 统一调度
        process.on('exit', () => this._syncShutdown());
    }

    _hasValidAssets(hostsConfig) {
        if (!hostsConfig || !hostsConfig.hosts) return false;
        const sshHosts = Object.entries(hostsConfig.hosts).filter(
            ([id, cfg]) => {
                return (
                    cfg.type === 'ssh' &&
                    cfg.host &&
                    cfg.username &&
                    (cfg.password || cfg.privateKeyPath)
                );
            }
        );
        return sshHosts.length > 0;
    }

    async _warmupConnections(hostsConfig) {
        const warmupHosts = hostsConfig.globalSettings?.warmupHosts || [];
        for (const hostId of warmupHosts) {
            try {
                await this.sshManager.connect(hostId);
                console.log(`[SSHManagerService] 预热连接成功: ${hostId}`);
            } catch (e) {
                console.warn(
                    `[SSHManagerService] 预热连接失败: ${hostId}: ${e.message}`
                );
            }
        }
    }

    async _closeServer() {
        const server = this.server;
        if (!server) return;

        await new Promise(resolve => {
            const done = err => {
                if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
                    console.error('[SSHManagerService] 关闭 IPC 服务器失败:', err.message);
                }
                resolve();
            };
            try {
                server.close(done);
            } catch (err) {
                done(err);
            }
        });
        this.server = null;

        if (process.platform !== 'win32' && this.sockPath) {
            try {
                fs.unlinkSync(this.sockPath);
            } catch (e) {}
        }
    }

    async _resetSSHManager() {
        if (!this.sshManager) return;

        await resetSSHManager();
        this.sshManager = null;
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
            this.clients.set(socket, { id: clientId });

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
                this.clients.delete(socket);
                this._cleanupClientSessions(socket).catch(() => {});
            });

            socket.on('error', err => {
                console.error(
                    `[SSHManagerService] 客户端 ${clientId} 错误:`,
                    err.message
                );
                this.clients.delete(socket);
                this._cleanupClientSessions(socket).catch(() => {});
            });
        });

        return new Promise((resolve, reject) => {
            this.server.listen(this.sockPath, () => {
                console.log(
                    `[SSHManagerService] IPC 服务器已启动: ${this.sockPath}`
                );
                if (process.platform !== 'win32') {
                    fs.chmodSync(this.sockPath, 0o600);
                }
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
                            message: 'SSHManager authentication failed',
                            code: -32001
                        }
                    }) + '\n'
                );
                return;
            }

            if (!this.sshManager) {
                socket.write(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id,
                        error: {
                            message: 'SSHManager not initialized',
                            code: -32000
                        }
                    }) + '\n'
                );
                return;
            }

            let result;
            switch (method) {
                case 'execute':
                    result = await this.sshManager.execute(
                        params.hostId,
                        params.command,
                        params.options
                    );
                    break;
                case 'testConnection':
                    result = await this.sshManager.testConnection(
                        params.hostId
                    );
                    break;
                case 'getStatus':
                    result = this.sshManager.getStatus();
                    break;
                case 'getPoolStats':
                    result = this.sshManager.getPoolStats();
                    break;
                case 'connect':
                    result = sanitizeConnectionResult(await this.sshManager.connect(
                        params.hostId,
                        params.options
                    ), params.hostId);
                    break;
                case 'disconnect':
                    await this.sshManager.disconnect(params.hostId);
                    result = { success: true };
                    break;
                case 'disconnectAll':
                    await this.sshManager.disconnectAll();
                    result = { success: true };
                    break;
                case 'listHosts':
                    result = this.sshManager.listHosts();
                    break;
                case 'createStreamSession': {
                    if (
                        typeof this.sshManager.createStreamSession !==
                        'function'
                    ) {
                        result = {
                            error: 'Stream sessions not supported by current SSHManager'
                        };
                        break;
                    }
                    const session = await this.sshManager.createStreamSession(
                        params.hostId,
                        params.command,
                        params.options
                    );
                    const sessionId = `uds-${crypto.randomUUID()}`;
                    this._registerStreamSession(sessionId, session, socket);
                    result = {
                        sessionId,
                        hostId: params.hostId,
                        command: params.command
                    };
                    break;
                }
                case 'stream.start': {
                    const sess = this.streamSessions.get(params.sessionId);
                    if (sess && typeof sess.session.start === 'function') {
                        await sess.session.start();
                        result = { success: true };
                    } else {
                        result = {
                            error: 'Session not found or not startable'
                        };
                    }
                    break;
                }
                case 'stream.stop': {
                    const sess = this.streamSessions.get(params.sessionId);
                    if (sess && typeof sess.session.stop === 'function') {
                        await sess.session.stop();
                        result = { success: true };
                    } else {
                        result = {
                            error: 'Session not found or not stoppable'
                        };
                    }
                    break;
                }
                case 'stream.destroy': {
                    const sess = this.streamSessions.get(params.sessionId);
                    if (sess) {
                        if (typeof sess.session.destroy === 'function') {
                            await sess.session.destroy();
                        }
                        this.streamSessions.delete(params.sessionId);
                        result = { success: true };
                    } else {
                        result = { error: 'Session not found' };
                    }
                    break;
                }
                case 'stream.getStats': {
                    const sess = this.streamSessions.get(params.sessionId);
                    if (sess && typeof sess.session.getStats === 'function') {
                        result = sess.session.getStats();
                    } else if (sess) {
                        result = { error: 'Session does not support getStats' };
                    } else {
                        result = { error: 'Session not found' };
                    }
                    break;
                }
                default:
                    result = { error: `Unknown method: ${method}` };
            }

            socket.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
        } catch (e) {
            console.error('[SSHManagerService] RPC 处理错误:', e.message);
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

    // 注册流式会话：将 session 的数据事件转发到客户端 socket
    _registerStreamSession(sessionId, session, clientSocket) {
        this.streamSessions.set(sessionId, { session, clientSocket });

        if (typeof session.on === 'function') {
            // EventEmitter 风格
            session.on('data', data => {
                if (!clientSocket.destroyed) {
                    clientSocket.write(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            method: 'stream.data',
                            params: { sessionId, data }
                        }) + '\n'
                    );
                }
            });
            session.on('error', error => {
                if (!clientSocket.destroyed) {
                    clientSocket.write(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            method: 'stream.error',
                            params: { sessionId, error: serializeError(error) }
                        }) + '\n'
                    );
                }
            });
            session.on('close', () => {
                if (!clientSocket.destroyed) {
                    clientSocket.write(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            method: 'stream.close',
                            params: { sessionId }
                        }) + '\n'
                    );
                }
                this.streamSessions.delete(sessionId);
            });
        } else {
            // 回调风格（如任务描述中的 onData / onError / onClose）
            if (session.onData !== undefined) {
                const originalOnData = session.onData;
                session.onData = data => {
                    if (!clientSocket.destroyed) {
                        clientSocket.write(
                            JSON.stringify({
                                jsonrpc: '2.0',
                                method: 'stream.data',
                                params: { sessionId, data }
                            }) + '\n'
                        );
                    }
                    if (typeof originalOnData === 'function')
                        originalOnData(data);
                };
            }
            if (session.onError !== undefined) {
                const originalOnError = session.onError;
                session.onError = error => {
                    if (!clientSocket.destroyed) {
                        clientSocket.write(
                            JSON.stringify({
                                jsonrpc: '2.0',
                                method: 'stream.error',
                                params: { sessionId, error: serializeError(error) }
                            }) + '\n'
                        );
                    }
                    if (typeof originalOnError === 'function')
                        originalOnError(error);
                };
            }
            if (session.onClose !== undefined) {
                const originalOnClose = session.onClose;
                session.onClose = () => {
                    if (!clientSocket.destroyed) {
                        clientSocket.write(
                            JSON.stringify({
                                jsonrpc: '2.0',
                                method: 'stream.close',
                                params: { sessionId }
                            }) + '\n'
                        );
                    }
                    this.streamSessions.delete(sessionId);
                    if (typeof originalOnClose === 'function')
                        originalOnClose();
                };
            }
        }
    }

    async _cleanupClientSessions(clientSocket) {
        for (const [sessionId, sess] of this.streamSessions.entries()) {
            if (sess.clientSocket === clientSocket) {
                try {
                    if (typeof sess.session.destroy === 'function') {
                        await sess.session.destroy();
                    } else if (typeof sess.session.stop === 'function') {
                        await sess.session.stop();
                    }
                } catch (e) {}
                this.streamSessions.delete(sessionId);
            }
        }
    }

    _syncShutdown() {
        // 清理所有流式会话
        for (const [sessionId, sess] of this.streamSessions.entries()) {
            try {
                if (typeof sess.session.destroy === 'function') {
                    sess.session.destroy();
                }
            } catch (e) {}
        }
        this.streamSessions.clear();

        // 关闭所有客户端连接
        for (const [socket] of this.clients.entries()) {
            try {
                socket.destroy();
            } catch (e) {}
        }
        this.clients.clear();

        if (this.server) {
            this.server.close();
            this.server = null;
            if (process.platform !== 'win32') {
                try {
                    fs.unlinkSync(this.sockPath);
                } catch (e) {}
            }
        }
        if (this.sshManager) {
            if (typeof this.sshManager._stopTimers === 'function') {
                try {
                    this.sshManager._stopTimers();
                } catch (e) {}
            }
            this.sshManager = null;
        }
        if (global.__vcp_ssh_manager_sock === this.sockPath) {
            delete global.__vcp_ssh_manager_sock;
        }
        if (global.__vcp_ssh_manager_token === this.authToken) {
            delete global.__vcp_ssh_manager_token;
        }
        console.log('[SSHManagerService] 已关闭');
    }

    async shutdown() {
        // 清理所有流式会话
        for (const [sessionId, sess] of this.streamSessions.entries()) {
            try {
                if (typeof sess.session.destroy === 'function') {
                    await sess.session.destroy();
                }
            } catch (e) {}
        }
        this.streamSessions.clear();

        // 关闭所有客户端连接
        for (const [socket] of this.clients.entries()) {
            try {
                socket.destroy();
            } catch (e) {}
        }
        this.clients.clear();

        await this._closeServer();
        await this._resetSSHManager();
        if (global.__vcp_ssh_manager_sock === this.sockPath) {
            delete global.__vcp_ssh_manager_sock;
        }
        if (global.__vcp_ssh_manager_token === this.authToken) {
            delete global.__vcp_ssh_manager_token;
        }
        console.log('[SSHManagerService] 已关闭');
    }
}

module.exports = new SSHManagerService();
