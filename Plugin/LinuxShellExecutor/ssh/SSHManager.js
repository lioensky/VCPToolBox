/**
 * SSHManager - SSH 连接管理器
 * 
 * 功能：
 * - 多主机 SSH 连接管理
 * - 支持密钥和密码认证
 * - 连接池和会话复用
 * - 跳板机（Jump Host）支持
 * - 自动重连和心跳保活
 * - 连接数量限制和重试机制
 *
 * @version 1.1.0
 */

const { Client } = require('ssh2');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { createSanitizedUserCommandEnv } = require('../../../modules/sensitiveEnv');

class SSHManager {
    constructor(hostsConfig) {
        this.hosts = hostsConfig.hosts || {};
        this.defaultHost = hostsConfig.defaultHost || 'local';
        this.globalSettings = hostsConfig.globalSettings || {};
        
        // 连接池
        this.connectionPool = new Map();
        
        // 连接状态
        this.connectionStatus = new Map();
        
        // 调试日志收集器（用于返回给调用者）
        this.debugLogs = [];
        
        // 连接限制配置
        this.maxConcurrentConnections = this.globalSettings.maxConcurrentConnections || 5;
        this.connectionPoolSize = this.globalSettings.connectionPoolSize || 10;
        this.activeConnections = 0;
        
        // 重试配置
        this.retryAttempts = this.globalSettings.retryAttempts || 3;
        this.retryDelay = this.globalSettings.retryDelay || 1000;
        
        // 连接等待队列
        this.connectionQueue = [];
    }
    
    /**
     * 添加调试日志（同时输出到 stderr 和收集到数组）
     */
    _log(message) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${message}`;
        console.error(logEntry);  // 输出到 stderr（VCP 会在 DebugMode 下显示）
        this.debugLogs.push(logEntry);  // 收集到数组
    }
    
    /**
     * 获取并清空调试日志
     */
    getAndClearDebugLogs() {
        const logs = [...this.debugLogs];
        this.debugLogs = [];
        return logs;
    }
    
    /**
     * 获取主机配置
     */
    getHostConfig(hostId) {
        const config = this.hosts[hostId];
        if (!config) {
            throw new Error(`主机 "${hostId}" 不存在`);
        }
        if (!config.enabled) {
            throw new Error(`主机 "${hostId}" 未启用`);
        }
        return config;
    }
    
    /**
     * 列出所有可用主机
     */
    listHosts() {
        const result = [];
        for (const [id, config] of Object.entries(this.hosts)) {
            result.push({
                id,
                name: config.name,
                description: config.description,
                type: config.type,
                enabled: config.enabled,
                host: config.host || 'localhost',
                securityLevel: config.securityLevel,
                tags: config.tags || []
            });
        }
        return result;
    }
    
    /**
     * 解析私钥路径（支持 ~ 展开和相对路径）
     */
    async resolveKeyPath(keyPath) {
        if (!keyPath) return null;
        
        let resolvedPath = keyPath;
        
        // 展开 ~ 为用户主目录
        if (keyPath.startsWith('~')) {
            resolvedPath = path.join(os.homedir(), keyPath.slice(1));
        }
        // 相对路径：相对于插件目录
        else if (keyPath.startsWith('./') || keyPath.startsWith('../') || !path.isAbsolute(keyPath)) {
            resolvedPath = path.join(__dirname, '..', keyPath);
        }
        
        // 规范化路径
        resolvedPath = path.normalize(resolvedPath);
        
        this._log(`解析私钥路径: ${keyPath} -> ${resolvedPath}`);
        
        try {
            const keyContent = await fs.readFile(resolvedPath, 'utf8');
            this._log(`私钥文件读取成功，长度: ${keyContent.length} 字符`);
            return keyContent;
        } catch (error) {
            throw new Error(`无法读取私钥文件: ${resolvedPath} (原始路径: ${keyPath}) - ${error.message}`);
        }
    }
    
    /**
     * 检查是否可以创建新连接
     */
    canCreateConnection() {
        return this.activeConnections < this.maxConcurrentConnections;
    }
    
    /**
     * 等待连接槽位可用
     */
    async waitForConnectionSlot() {
        if (this.canCreateConnection()) {
            return;
        }
        
        this._log(`连接数已达上限 (${this.activeConnections}/${this.maxConcurrentConnections})，等待槽位...`);
        
        return new Promise((resolve) => {
            this.connectionQueue.push(resolve);
        });
    }
    
    /**
     * 释放连接槽位
     */
    releaseConnectionSlot() {
        this.activeConnections = Math.max(0, this.activeConnections - 1);
        
        // 唤醒等待队列中的下一个
        if (this.connectionQueue.length > 0) {
            const next = this.connectionQueue.shift();
            next();
        }
    }
    
    /**
     * 带重试的连接方法
     */
    async connectWithRetry(hostId) {
        let lastError;
        
        for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
            try {
                this._log(`连接尝试 ${attempt}/${this.retryAttempts}: ${hostId}`);
                return await this._connectInternal(hostId);
            } catch (error) {
                lastError = error;
                this._log(`连接失败 (尝试 ${attempt}/${this.retryAttempts}): ${error.message}`);
                
                if (attempt < this.retryAttempts) {
                    this._log(`${this.retryDelay}ms 后重试...`);
                    await this._delay(this.retryDelay);
                }
            }
        }
        
        throw lastError;
    }
    
    /**
     * 延迟函数
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * 创建 SSH 连接（公共接口，带重试和连接限制）
     */
    async connect(hostId) {
        const config = this.getHostConfig(hostId);
        
        // 本地执行不需要 SSH 连接
        if (config.type === 'local') {
            return { type: 'local', hostId };
        }
        
        // 检查连接池中是否已有可用连接
        const existingConn = this.connectionPool.get(hostId);
        if (existingConn && existingConn.isConnected) {
            this._log(`复用现有连接: ${hostId}`);
            return existingConn;
        }
        
        // 等待连接槽位
        await this.waitForConnectionSlot();
        
        try {
            // 使用带重试的连接
            return await this.connectWithRetry(hostId);
        } catch (error) {
            // 连接失败，释放槽位
            this.releaseConnectionSlot();
            throw error;
        }
    }
    
    /**
     * 内部连接实现
     */
    async _connectInternal(hostId) {
        const config = this.getHostConfig(hostId);
        
        // 增加活跃连接计数
        this.activeConnections++;
        
        // 创建新连接
        const conn = new Client();
        
        // 构建连接配置
        const sshConfig = {
            host: config.host,
            port: config.port || 22,
            username: config.username,
            readyTimeout: config.timeout || this.globalSettings.defaultTimeout || 30000,
            keepaliveInterval: config.keepAliveInterval || 10000,
            keepaliveCountMax: 3
        };
        
        // 认证方式
        if (config.authMethod === 'key') {
            sshConfig.privateKey = await this.resolveKeyPath(config.privateKeyPath);
            if (config.passphrase) {
                sshConfig.passphrase = config.passphrase;
            }
        } else if (config.authMethod === 'password') {
            sshConfig.password = config.password;
        }
        
        // 如果有跳板机，先连接跳板机
        if (config.jumpHost) {
            const jumpConn = await this.connect(config.jumpHost);
            if (jumpConn.type !== 'local') {
                // 通过跳板机建立隧道
                const stream = await this.forwardConnection(jumpConn.client, config.host, config.port || 22);
                sshConfig.sock = stream;
                delete sshConfig.host;
                delete sshConfig.port;
            }
        }
        
        // 建立连接
        this._log(`开始连接 ${hostId}...`);
        this._log(`连接配置: host=${sshConfig.host}, port=${sshConfig.port}, user=${sshConfig.username}, timeout=${sshConfig.readyTimeout}ms`);
        this._log(`认证方式: ${config.authMethod}, 私钥长度: ${sshConfig.privateKey ? sshConfig.privateKey.length : 'N/A'}`);
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._log(`连接超时 (${sshConfig.readyTimeout}ms): ${hostId}`);
                conn.end();
                reject(new Error(`连接超时 (${sshConfig.readyTimeout}ms): ${hostId} - 请检查: 1) 网络连通性 2) 防火墙规则 3) SSH 服务状态 4) 私钥权限`));
            }, sshConfig.readyTimeout);
            
            conn.on('ready', () => {
                clearTimeout(timeout);
                this._log(`SSH 握手成功: ${hostId}`);
                
                const connection = {
                    type: 'ssh',
                    hostId,
                    client: conn,
                    isConnected: true,
                    connectedAt: new Date(),
                    config
                };
                
                // 检查连接池大小限制
                if (this.connectionPool.size >= this.connectionPoolSize) {
                    // 移除最旧的未使用连接
                    this._evictOldestConnection();
                }
                
                // 存入连接池
                this.connectionPool.set(hostId, connection);
                this.connectionStatus.set(hostId, 'connected');
                
                this._log(`已连接到 ${hostId} (${config.host})，当前连接数: ${this.activeConnections}/${this.maxConcurrentConnections}`);
                resolve(connection);
            });
            
            conn.on('error', (err) => {
                clearTimeout(timeout);
                this._log(`SSH 错误 (${hostId}): ${err.message}`);
                this._log(`错误详情: ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`);
                this.connectionStatus.set(hostId, 'error');
                this.releaseConnectionSlot();
                reject(new Error(`SSH 连接错误 (${hostId}): ${err.message}`));
            });
            
            conn.on('close', () => {
                const connection = this.connectionPool.get(hostId);
                if (connection) {
                    connection.isConnected = false;
                }
                this.connectionStatus.set(hostId, 'disconnected');
                this.releaseConnectionSlot();
                this._log(`连接已关闭: ${hostId}，当前连接数: ${this.activeConnections}/${this.maxConcurrentConnections}`);
            });
            
            conn.on('end', () => {
                const connection = this.connectionPool.get(hostId);
                if (connection) {
                    connection.isConnected = false;
                }
                this.connectionStatus.set(hostId, 'disconnected');
            });
            
            // 添加更多事件监听用于调试
            conn.on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
                this._log(`键盘交互认证请求: ${name}`);
                // 不支持键盘交互，直接失败
                finish([]);
            });
            
            conn.on('change password', (message, done) => {
                this._log(`密码更改请求: ${message}`);
                done();
            });
            
            conn.on('tcp connection', (details, accept, reject) => {
                this._log(`TCP 连接请求: ${JSON.stringify(details)}`);
            });
            
            this._log(`正在发起 SSH 连接...`);
            conn.connect(sshConfig);
        });
    }
    
    /**
     * 通过跳板机转发连接
     */
    forwardConnection(jumpClient, targetHost, targetPort) {
        return new Promise((resolve, reject) => {
            jumpClient.forwardOut(
                '127.0.0.1',
                0,
                targetHost,
                targetPort,
                (err, stream) => {
                    if (err) {
                        reject(new Error(`跳板机转发失败: ${err.message}`));
                    } else {
                        resolve(stream);
                    }
                }
            );
        });
    }
    
    /**
     * 执行远程命令
     */
    async execute(hostId, command, options = {}) {
        const connection = await this.connect(hostId);
        
        // 本地执行
        if (connection.type === 'local') {
            return this.executeLocal(command, options);
        }
        
        // SSH 远程执行
        return this.executeSSH(connection, command, options);
    }
    
    /**
     * 本地执行命令
     */
    async executeLocal(command, options = {}) {
        const { spawn } = require('child_process');
        const timeout = options.timeout || 30000;
        
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            
            const child = spawn('/bin/bash', ['-c', command], {
                timeout,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: createSanitizedUserCommandEnv()
            });
            
            const timeoutId = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error(`命令执行超时 (${timeout}ms)`));
            }, timeout);
            
            child.stdout.on('data', data => { stdout += data.toString(); });
            child.stderr.on('data', data => { stderr += data.toString(); });
            
            child.on('close', code => {
                clearTimeout(timeoutId);
                resolve({
                    stdout,
                    stderr,
                    code,
                    hostId: 'local',
                    executionType: 'local'
                });
            });
            
            child.on('error', err => {
                clearTimeout(timeoutId);
                reject(new Error(`本地执行失败: ${err.message}`));
            });
        });
    }
    
    /**
     * SSH 远程执行命令
     */
    async executeSSH(connection, command, options = {}) {
        const timeout = options.timeout || connection.config.timeout || 30000;
        
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            
            const timeoutId = setTimeout(() => {
                reject(new Error(`SSH 命令执行超时 (${timeout}ms)`));
            }, timeout);
            
            connection.client.exec(command, (err, stream) => {
                if (err) {
                    clearTimeout(timeoutId);
                    reject(new Error(`SSH 执行失败: ${err.message}`));
                    return;
                }
                
                stream.on('close', (code, signal) => {
                    clearTimeout(timeoutId);
                    resolve({
                        stdout,
                        stderr,
                        code,
                        signal,
                        hostId: connection.hostId,
                        executionType: 'ssh'
                    });
                });
                
                stream.on('data', data => {
                    stdout += data.toString();
                });
                
                stream.stderr.on('data', data => {
                    stderr += data.toString();
                });
            });
        });
    }
    
    /**
     * 测试主机连接
     */
    async testConnection(hostId) {
        try {
            const startTime = Date.now();
            const connection = await this.connect(hostId);
            
            // 执行简单命令测试
            const result = await this.execute(hostId, 'echo "VCP_CONNECTION_TEST"', { timeout: 10000 });
            const latency = Date.now() - startTime;
            
            return {
                success: true,
                hostId,
                latency,
                output: result.stdout.trim(),
                message: `连接成功，延迟 ${latency}ms`
            };
        } catch (error) {
            return {
                success: false,
                hostId,
                error: error.message,
                message: `连接失败: ${error.message}`
            };
        }
    }
    
    /**
     * 移除最旧的未使用连接
     */
    _evictOldestConnection() {
        let oldestHostId = null;
        let oldestTime = Date.now();
        
        for (const [hostId, connection] of this.connectionPool) {
            if (connection.connectedAt && connection.connectedAt < oldestTime) {
                oldestTime = connection.connectedAt;
                oldestHostId = hostId;
            }
        }
        
        if (oldestHostId) {
            this._log(`连接池已满，移除最旧连接: ${oldestHostId}`);
            this.disconnect(oldestHostId);
        }
    }
    
    /**
     * 断开指定主机连接
     */
    async disconnect(hostId) {
        const connection = this.connectionPool.get(hostId);
        if (connection && connection.client) {
            connection.client.end();
            connection.isConnected = false;
            this.connectionPool.delete(hostId);
            this.connectionStatus.set(hostId, 'disconnected');
            this._log(`已断开连接: ${hostId}`);
        }
    }
    
    /**
     * 断开所有连接
     */
    async disconnectAll() {
        for (const [hostId, connection] of this.connectionPool) {
            if (connection.client) {
                connection.client.end();
            }
        }
        this.connectionPool.clear();
        this.activeConnections = 0;
        this.connectionQueue = [];
        this._log('已断开所有连接');
    }
    
    /**
     * 获取连接状态
     */
    getStatus() {
        const status = {};
        for (const [hostId, config] of Object.entries(this.hosts)) {
            status[hostId] = {
                name: config.name,
                enabled: config.enabled,
                type: config.type,
                connectionStatus: this.connectionStatus.get(hostId) || 'not_connected',
                isConnected: this.connectionPool.get(hostId)?.isConnected || false
            };
        }
        return status;
    }
    
    /**
     * 获取连接池统计信息
     */
    getPoolStats() {
        return {
            activeConnections: this.activeConnections,
            maxConcurrentConnections: this.maxConcurrentConnections,
            poolSize: this.connectionPool.size,
            maxPoolSize: this.connectionPoolSize,
            queueLength: this.connectionQueue.length,
            retryAttempts: this.retryAttempts,
            retryDelay: this.retryDelay
        };
    }
}

module.exports = SSHManager;
