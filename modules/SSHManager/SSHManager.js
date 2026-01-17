/**
 * SSHManager - SSH 连接管理器（共享模块版本）
 *
 * 功能：
 * - 多主机 SSH 连接管理
 * - 支持密钥和密码认证
 * - 连接池和会话复用
 * - 跳板机（Jump Host）支持
 * - 自动重连和心跳保活
 * - 连接数量限制和重试机制
 * - 流式会话支持（用于 tail -f 等长时命令）
 * - 资产状态持久化（host_status.json）
 * - 主机级认证锁（PAM 保护机制）
 *
 * @version 1.1.9
 * @author VCP Team
 */

const { Client } = require('ssh2');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

class SSHManager {
    constructor(hostsConfig) {
        this.hosts = hostsConfig.hosts || {};
        this.defaultHost = hostsConfig.defaultHost || 'local';
        this.globalSettings = hostsConfig.globalSettings || {};
        this.statusCachePath = path.join(__dirname, 'host_status.json');
        
        // 连接池配置 (v1.2.5: 默认关闭池化，适应 VCP 多进程架构)
        this.usePool = this.globalSettings.usePool === true;
        this.connectionPool = new Map();
        
        // 连接状态（运行时）
        this.connectionStatus = new Map();
        
        // 状态缓存（持久化）
        this.statusCache = this._loadStatusCache();

        // 状态缓存写入队列：串行化写入，避免并行 writeFile 产生 0 字节文件
        this._statusCacheWriteQueue = Promise.resolve();

        // testConnection 并发去重：同一 hostId 只允许一个探测在途
        this._inFlightTestConnections = new Map();
        
        // 流式会话池
        this.streamSessions = new Map();
        
        // 调试日志收集器（用于返回给调用者）
        this.debugLogs = this.debugLogs || [];
        
        // 连接限制配置
        this.maxConcurrentConnections = this.globalSettings.maxConcurrentConnections || 5;
        this.connectionPoolSize = this.globalSettings.connectionPoolSize || 10;
        this.activeConnections = 0;
        
        // 重试配置
        this.retryAttempts = this.globalSettings.retryAttempts || 3;
        this.retryDelay = this.globalSettings.retryDelay || 1000;
        
        // 连接等待队列
        this.connectionQueue = [];

        // 主机级并发队列 (防止针对同一主机的认证冲击导致 PAM 锁定)
        this.hostQueues = new Map();
    }
    
    /**
     * 添加调试日志（同时输出到 stderr 和收集到数组）
     */
    _log(message) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] [SSHManager] ${message}`;
        console.error(logEntry);  // 输出到 stderr（VCP 会在 DebugMode 下显示）
        if (!this.debugLogs) {
            this.debugLogs = [];
        }
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
     * 加载状态缓存文件
     */
    _loadStatusCache() {
        const fsSync = require('fs');
        try {
            const backupPath = `${this.statusCachePath}.bak`;

            if (!fsSync.existsSync(this.statusCachePath) && fsSync.existsSync(backupPath)) {
                this._log('状态缓存文件缺失，检测到 host_status.json.bak，尝试使用备份恢复');
                const rawBak = fsSync.readFileSync(backupPath, 'utf8').trim();
                const dataBak = rawBak ? JSON.parse(rawBak) : {};
                if (dataBak && typeof dataBak === 'object') {
                    this._log(`已从备份恢复资产状态缓存: ${Object.keys(dataBak).length} 条记录`);
                    return dataBak;
                }
            }

            if (fsSync.existsSync(this.statusCachePath)) {
                const stat = fsSync.statSync(this.statusCachePath);
                if (stat.size === 0) {
                    if (fsSync.existsSync(backupPath) && fsSync.statSync(backupPath).size > 0) {
                        try {
                            const rawBak = fsSync.readFileSync(backupPath, 'utf8').trim();
                            const dataBak = rawBak ? JSON.parse(rawBak) : {};
                            if (dataBak && typeof dataBak === 'object') {
                                fsSync.writeFileSync(this.statusCachePath, JSON.stringify(dataBak, null, 2), 'utf8');
                                this._log(`已从备份恢复资产状态缓存: ${Object.keys(dataBak).length} 条记录`);
                                return dataBak;
                            }
                        } catch {
                            // ignore
                        }
                    }
                    this._log('状态缓存文件 host_status.json 为空(0字节)，已忽略并准备重置');
                    fs.writeFile(this.statusCachePath, JSON.stringify({}, null, 2)).catch(err =>
                        this._log(`重置状态缓存失败: ${err.message}`)
                    );
                    return {};
                }

                const raw = fsSync.readFileSync(this.statusCachePath, 'utf8').trim();
                if (!raw) {
                    this._log('状态缓存文件 host_status.json 为空内容，已忽略');
                    return {};
                }

                const data = JSON.parse(raw);
                if (!data || typeof data !== 'object') {
                    this._log('状态缓存内容无效(非对象)，已忽略');
                    return {};
                }

                this._log(`已加载资产状态缓存: ${Object.keys(data).length} 条记录`);
                return data;
            }
        } catch (error) {
            this._log(`加载状态缓存失败: ${error.message}`);
        }
        return {};
    }

    /**
     * 更新并保存状态缓存
     */
    async _updateStatusCache(hostId, statusData) {
        if (!this.statusCache || typeof this.statusCache !== 'object') {
            this.statusCache = {};
        }

        this.statusCache[hostId] = {
            ...(statusData && typeof statusData === 'object' ? statusData : { success: false, message: '状态数据无效' }),
            updatedAt: new Date().toISOString()
        };

        await this._enqueueStatusCacheWrite();
    }

    /**
     * 将状态缓存写入操作串行化，并使用临时文件 + 重命名的方式落盘。
     * 目的：避免并行 writeFile 导致 host_status.json 被截断为 0 字节。
     */
    _enqueueStatusCacheWrite() {
        const writeTask = async () => {
            try {
                const payload = this.statusCache && typeof this.statusCache === 'object' ? this.statusCache : {};
                const content = JSON.stringify(payload, null, 2);

                if (typeof content !== 'string' || content.length === 0) {
                    throw new Error('状态缓存序列化为空');
                }

                const tmpPath = `${this.statusCachePath}.tmp-${process.pid}-${Date.now()}`;
                await fs.writeFile(tmpPath, content, 'utf8');

                try {
                    await fs.rename(tmpPath, this.statusCachePath);
                } catch (renameError) {
                    // Windows 下 rename 覆盖可能失败：先备份旧文件，再替换
                    const backupPath = `${this.statusCachePath}.bak`;
                    let backedUp = false;

                    try {
                        await Promise.resolve();
                    } catch {
                        // ignore
                    }

                    try {
                        await fs.copyFile(this.statusCachePath, backupPath);
                        backedUp = true;
                    } catch {
                        // ignore
                    }

                    try {
                        await fs.copyFile(tmpPath, this.statusCachePath);
                        await fs.unlink(tmpPath);
                    } catch (replaceError) {
                        if (backedUp) {
                            try {
                                await fs.copyFile(backupPath, this.statusCachePath);
                            } catch {
                                // ignore
                            }
                        }
                        throw replaceError;
                    }

                    if (backedUp) {
                        // 保留备份文件用于自愈恢复
                    }
                }
            } catch (error) {
                this._log(`保存状态缓存失败: ${error.message}`);
            }
        };

        this._statusCacheWriteQueue = this._statusCacheWriteQueue
            .then(writeTask)
            .catch(() => writeTask());

        return this._statusCacheWriteQueue;
    }

    /**
     * 列出所有可用主机（集成缓存状态）
     */
    listHosts(onlyConnectable = false) {
        const result = [];
        for (const [id, config] of Object.entries(this.hosts)) {
            const cache = config.type === 'local'
                ? { success: true, message: '本地执行', latency: 0, updatedAt: new Date().toISOString() }
                : (this.statusCache[id] || { success: false, message: '未探测' });
            
            // 如果要求只列出可连接资产
            if (onlyConnectable && !cache.success) {
                continue;
            }

            result.push({
                id,
                name: config.name,
                description: config.description,
                type: config.type,
                enabled: config.enabled,
                host: config.host || 'localhost',
                securityLevel: config.securityLevel,
                tags: config.tags || [],
                status: {
                    online: cache.success,
                    latency: cache.latency,
                    lastCheck: cache.updatedAt,
                    message: cache.message
                }
            });
        }
        return result;
    }
    
    /**
     * 解析私钥路径（支持 ~ 展开和相对路径）
     * @param {string} keyPath - 私钥路径
     * @param {string} [basePath] - 基础查找路径（可选）
     */
    async resolveKeyPath(keyPath, basePath) {
        if (!keyPath) return null;
        
        let resolvedPath = keyPath;
        
        // 展开 ~ 为用户主目录
        if (keyPath.startsWith('~')) {
            resolvedPath = path.join(os.homedir(), keyPath.slice(1));
        }
        // 绝对路径
        else if (path.isAbsolute(keyPath)) {
            resolvedPath = keyPath;
        }
        // 相对路径
        else {
            const root = basePath || path.join(__dirname, '..', '..', 'Plugin', 'LinuxShellExecutor');
            resolvedPath = path.join(root, keyPath);
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
     * @param {string} hostId - 主机ID
     * @param {Object} [options] - 连接选项
     * @param {boolean} [options.bypassPool] - 是否强制跳过连接池（新建连接）
     */
    async connect(hostId, options = {}) {
        const config = this.getHostConfig(hostId);
        const bypassPool = options.bypassPool === true || !this.usePool;
        
        // 本地执行不需要 SSH 连接
        if (config.type === 'local') {
            return { type: 'local', hostId };
        }
        
        // 检查连接池中是否已有可用连接
        if (!bypassPool) {
            const existingConn = this.connectionPool.get(hostId);
            if (existingConn && existingConn.isConnected) {
                this._log(`复用现有连接: ${hostId}`);
                return existingConn;
            }
        } else {
            this._log(`非池化模式: 将为 ${hostId} 创建独立连接`);
        }
        
        // 1. 等待全局连接槽位
        await this.waitForConnectionSlot();
        
        // 2. 获取主机级锁 (主机串行化，防止 PAM 并发错误)
        await this.acquireHostLock(hostId);
        
        try {
            // 使用带重试的连接
            const connection = await this.connectWithRetry(hostId, options);
            return connection;
        } catch (error) {
            // 连接失败，释放全局槽位
            throw error;
        } finally {
            // 无论成功失败，都必须释放主机锁
            this.releaseHostLock(hostId);
        }
    }

    /**
     * 获取针对特定主机的认证锁
     */
    async acquireHostLock(hostId) {
        if (!this.hostQueues.has(hostId)) {
            this.hostQueues.set(hostId, { locked: false, queue: [] });
        }
        
        const hostState = this.hostQueues.get(hostId);
        if (!hostState.locked) {
            hostState.locked = true;
            this._log(`[Lock] 获得主机锁: ${hostId}`);
            return;
        }

        this._log(`[Lock] 主机认证冲突，正在排队: ${hostId}`);
        return new Promise(resolve => {
            hostState.queue.push(resolve);
        });
    }

    /**
     * 释放特定主机的认证锁
     */
    releaseHostLock(hostId) {
        const hostState = this.hostQueues.get(hostId);
        if (!hostState) return;

        if (hostState.queue.length > 0) {
            const next = hostState.queue.shift();
            this._log(`[Lock] 移交主机锁给下一个等待者: ${hostId}`);
            next();
        } else {
            hostState.locked = false;
            this._log(`[Lock] 释放主机锁 (队列空): ${hostId}`);
        }
    }
    
    /**
     * 内部连接实现
     */
    async _connectInternal(hostId, options = {}) {
        const config = this.getHostConfig(hostId);
        const bypassPool = options.bypassPool === true || !this.usePool;
        
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
            keepaliveCountMax: 3,
            // 核心修复：显式禁用键盘交互探测，防止 PAM 记录 authentication failure
            tryKeyboard: false
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
            let slotReleased = false;
            let connected = false;
            const releaseSlotOnce = () => {
                if (slotReleased) return;
                slotReleased = true;
                this.releaseConnectionSlot();
            };

            const timeout = setTimeout(() => {
                this._log(`连接超时 (${sshConfig.readyTimeout}ms): ${hostId}`);
                conn.end();
                releaseSlotOnce();
                reject(new Error(`连接超时 (${sshConfig.readyTimeout}ms): ${hostId} - 请检查: 1) 网络连通性 2) 防火墙规则 3) SSH 服务状态 4) 私钥权限`));
            }, sshConfig.readyTimeout);
            
            conn.on('ready', () => {
                clearTimeout(timeout);
                connected = true;
                this._log(`SSH 握手成功: ${hostId}`);
                
                const connection = {
                    type: 'ssh',
                    hostId,
                    client: conn,
                    isConnected: true,
                    isPooled: !bypassPool, // 标记是否为池化连接
                    connectedAt: new Date(),
                    config
                };
                
                if (!bypassPool) {
                    // 检查连接池大小限制
                    if (this.connectionPool.size >= this.connectionPoolSize) {
                        // 移除最旧的未使用连接
                        this._evictOldestConnection();
                    }
                    
                    // 存入连接池
                    this.connectionPool.set(hostId, connection);
                    this._log(`连接已存入池中: ${hostId}`);
                }
                
                this.connectionStatus.set(hostId, 'connected');
                
                this._log(`已连接到 ${hostId} (${config.host})，当前连接数: ${this.activeConnections}/${this.maxConcurrentConnections}`);
                resolve(connection);
            });
            
            conn.on('error', (err) => {
                clearTimeout(timeout);
                this._log(`SSH 错误 (${hostId}): ${err.message}`);
                this._log(`错误详情: ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`);
                this.connectionStatus.set(hostId, 'error');
                if (!connected) {
                    releaseSlotOnce();
                }
                reject(new Error(`SSH 连接错误 (${hostId}): ${err.message}`));
            });
            
            conn.on('close', () => {
                const connection = this.connectionPool.get(hostId);
                if (connection) {
                    connection.isConnected = false;
                }
                this.connectionStatus.set(hostId, 'disconnected');
                releaseSlotOnce();
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
        // 如果是批量执行或显式要求池化，则不 bypass
        const connection = await this.connect(hostId, {
            bypassPool: options.usePool === undefined ? !this.usePool : !options.usePool
        });
        
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
        const maxOutputLength = options.maxOutputLength || 5 * 1024 * 1024; // 默认 5MB
        
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let totalLength = 0;
            
            const child = spawn('/bin/bash', ['-c', command], {
                timeout,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            const timeoutId = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error(`命令执行超时 (${timeout}ms)`));
            }, timeout);
            
            child.stdout.on('data', data => {
                if (totalLength < maxOutputLength) {
                    const chunk = data.toString();
                    stdout += chunk;
                    totalLength += chunk.length;
                    if (totalLength >= maxOutputLength) {
                        stdout += "\n[Output Truncated due to length limit]";
                    }
                }
            });
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
        const maxOutputLength = options.maxOutputLength || 5 * 1024 * 1024; // 默认 5MB
        
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let totalLength = 0;
            
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

                    // 如果是非池化连接，执行完毕后立即断开
                    if (!connection.isPooled && connection.client) {
                        this._log(`非池化连接任务完成，正在断开: ${connection.hostId}`);
                        connection.client.end();
                        connection.isConnected = false;
                    }

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
                    if (totalLength < maxOutputLength) {
                        const chunk = data.toString();
                        stdout += chunk;
                        totalLength += chunk.length;
                        if (totalLength >= maxOutputLength) {
                            stdout += "\n[Output Truncated due to length limit]";
                        }
                    }
                });
                
                stream.stderr.on('data', data => {
                    stderr += data.toString();
                });
            });
        });
    }
    
    // ==================== 流式会话支持（新增） ====================
    
    /**
     * 创建流式会话（用于 tail -f 等永不结束的命令）
     * 
     * @param {string} hostId - 主机ID
     * @param {string} command - 要执行的命令
     * @param {Object} options - 选项
     * @param {number} options.timeout - 会话超时时间（默认不超时）
     * @param {number} options.maxLineBuffer - 最大行缓冲大小（默认 64KB）
     * @returns {Promise<StreamSession>} 流式会话对象
     */
    async createStreamSession(hostId, command, options = {}) {
        const connection = await this.connect(hostId);
        
        if (connection.type === 'local') {
            return this._createLocalStreamSession(command, options);
        }
        
        return this._createSSHStreamSession(connection, command, options);
    }
    
    /**
     * 创建 SSH 流式会话
     * @private
     */
    async _createSSHStreamSession(connection, command, options = {}) {
        const sessionId = `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const maxLineBuffer = options.maxLineBuffer || 65536;  // 64KB
        
        return new Promise((resolve, reject) => {
            connection.client.shell((err, stream) => {
                if (err) {
                    this._log(`创建 shell 会话失败: ${err.message}`);
                    return reject(new Error(`创建 shell 会话失败: ${err.message}`));
                }
                
                // 行缓冲器
                let lineBuffer = '';
                
                const session = {
                    sessionId,
                    stream,
                    hostId: connection.hostId,
                    command,
                    isActive: true,
                    startedAt: null,
                    linesProcessed: 0,
                    bytesReceived: 0,
                    
                    // 事件回调
                    onLine: null,      // 每行数据回调
                    onData: null,      // 原始数据回调
                    onError: null,     // 错误回调
                    onClose: null,     // 关闭回调
                    
                    /**
                     * 启动命令执行
                     */
                    start: () => {
                        session.startedAt = new Date();
                        stream.write(command + '\n');
                        this._log(`流式会话已启动: ${sessionId} - ${command}`);
                    },
                    
                    /**
                     * 停止命令执行（发送 Ctrl+C）
                     */
                    stop: () => {
                        if (session.isActive) {
                            stream.write('\x03'); // Ctrl+C
                            setTimeout(() => {
                                if (session.isActive) {
                                    stream.end('exit\n');
                                }
                            }, 500);
                            this._log(`流式会话已停止: ${sessionId}`);
                        }
                    },
                    
                    /**
                     * 强制关闭会话
                     */
                    destroy: () => {
                        session.isActive = false;
                        stream.destroy();
                        this.streamSessions.delete(sessionId);
                        this._log(`流式会话已销毁: ${sessionId}`);
                    },
                    
                    /**
                     * 获取会话统计信息
                     */
                    getStats: () => ({
                        sessionId,
                        hostId: connection.hostId,
                        command,
                        isActive: session.isActive,
                        startedAt: session.startedAt,
                        duration: session.startedAt ? Date.now() - session.startedAt.getTime() : 0,
                        linesProcessed: session.linesProcessed,
                        bytesReceived: session.bytesReceived
                    })
                };
                
                // 处理数据流
                stream.on('data', (data) => {
                    const text = data.toString();
                    session.bytesReceived += data.length;
                    
                    // 调试日志：记录每次收到的数据
                    this._log(`[StreamSession:${sessionId}] 收到数据: ${data.length} 字节, 总计: ${session.bytesReceived} 字节`);
                    this._log(`[StreamSession:${sessionId}] 数据内容(前100字符): ${text.substring(0, 100).replace(/\n/g, '\\n').replace(/\r/g, '\\r')}`);
                    
                    // 原始数据回调
                    if (session.onData) {
                        session.onData(text);
                    } else {
                        this._log(`[StreamSession:${sessionId}] 警告: onData 回调未设置!`);
                    }
                    
                    // 行处理
                    if (session.onLine) {
                        lineBuffer += text;
                        
                        // 防止缓冲区溢出
                        if (lineBuffer.length > maxLineBuffer) {
                            this._log(`行缓冲区溢出，强制刷新: ${sessionId}`);
                            session.onLine(lineBuffer);
                            session.linesProcessed++;
                            lineBuffer = '';
                        }
                        
                        // 按行分割
                        const lines = lineBuffer.split('\n');
                        lineBuffer = lines.pop() || '';  // 保留最后一个不完整的行
                        
                        for (const line of lines) {
                            if (line.trim()) {
                                session.onLine(line);
                                session.linesProcessed++;
                            }
                        }
                    }
                });
                
                stream.stderr.on('data', (data) => {
                    const text = data.toString();
                    if (session.onError) {
                        session.onError(text);
                    }
                });
                
                stream.on('close', () => {
                    session.isActive = false;
                    
                    // 刷新剩余的行缓冲
                    if (session.onLine && lineBuffer.trim()) {
                        session.onLine(lineBuffer);
                        session.linesProcessed++;
                    }
                    
                    if (session.onClose) {
                        session.onClose();
                    }
                    
                    this.streamSessions.delete(sessionId);
                    this._log(`流式会话已关闭: ${sessionId}`);
                });
                
                stream.on('error', (err) => {
                    session.isActive = false;
                    if (session.onError) {
                        session.onError(err.message);
                    }
                    this.streamSessions.delete(sessionId);
                });
                
                // 存储会话
                this.streamSessions.set(sessionId, session);
                
                this._log(`流式会话已创建: ${sessionId} (${connection.hostId})`);
                resolve(session);
            });
        });
    }
    
    /**
     * 创建本地流式会话
     * @private
     */
    _createLocalStreamSession(command, options = {}) {
        const { spawn } = require('child_process');
        const sessionId = `stream-local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const maxLineBuffer = options.maxLineBuffer || 65536;
        
        return new Promise((resolve, reject) => {
            // 行缓冲器
            let lineBuffer = '';
            
            const session = {
                sessionId,
                process: null,
                hostId: 'local',
                command,
                isActive: false,
                startedAt: null,
                linesProcessed: 0,
                bytesReceived: 0,
                
                onLine: null,
                onData: null,
                onError: null,
                onClose: null,
                
                start: () => {
                    session.process = spawn('/bin/bash', ['-c', command], {
                        stdio: ['pipe', 'pipe', 'pipe']
                    });
                    session.isActive = true;
                    session.startedAt = new Date();
                    
                    session.process.stdout.on('data', (data) => {
                        const text = data.toString();
                        session.bytesReceived += data.length;
                        
                        if (session.onData) {
                            session.onData(text);
                        }
                        
                        if (session.onLine) {
                            lineBuffer += text;
                            
                            if (lineBuffer.length > maxLineBuffer) {
                                session.onLine(lineBuffer);
                                session.linesProcessed++;
                                lineBuffer = '';
                            }
                            
                            const lines = lineBuffer.split('\n');
                            lineBuffer = lines.pop() || '';
                            
                            for (const line of lines) {
                                if (line.trim()) {
                                    session.onLine(line);
                                    session.linesProcessed++;
                                }
                            }
                        }
                    });
                    
                    session.process.stderr.on('data', (data) => {
                        if (session.onError) {
                            session.onError(data.toString());
                        }
                    });
                    
                    session.process.on('close', (code) => {
                        session.isActive = false;
                        
                        if (session.onLine && lineBuffer.trim()) {
                            session.onLine(lineBuffer);
                            session.linesProcessed++;
                        }
                        
                        if (session.onClose) {
                            session.onClose(code);
                        }
                        
                        this.streamSessions.delete(sessionId);
                        this._log(`本地流式会话已关闭: ${sessionId}`);
                    });
                    
                    session.process.on('error', (err) => {
                        session.isActive = false;
                        if (session.onError) {
                            session.onError(err.message);
                        }
                        this.streamSessions.delete(sessionId);
                    });
                    
                    this._log(`本地流式会话已启动: ${sessionId} - ${command}`);
                },
                
                stop: () => {
                    if (session.process && session.isActive) {
                        session.process.kill('SIGINT');
                        setTimeout(() => {
                            if (session.isActive && session.process) {
                                session.process.kill('SIGTERM');
                            }
                        }, 500);
                    }
                },
                
                destroy: () => {
                    if (session.process) {
                        session.process.kill('SIGKILL');
                    }
                    session.isActive = false;
                    this.streamSessions.delete(sessionId);
                },
                
                getStats: () => ({
                    sessionId,
                    hostId: 'local',
                    command,
                    isActive: session.isActive,
                    startedAt: session.startedAt,
                    duration: session.startedAt ? Date.now() - session.startedAt.getTime() : 0,
                    linesProcessed: session.linesProcessed,
                    bytesReceived: session.bytesReceived
                })
            };
            
            this.streamSessions.set(sessionId, session);
            this._log(`本地流式会话已创建: ${sessionId}`);
            resolve(session);
        });
    }
    
    /**
     * 获取所有活跃的流式会话
     */
    getActiveStreamSessions() {
        const sessions = [];
        for (const [sessionId, session] of this.streamSessions) {
            if (session.isActive) {
                sessions.push(session.getStats());
            }
        }
        return sessions;
    }
    
    /**
     * 停止所有流式会话
     */
    async stopAllStreamSessions() {
        for (const [sessionId, session] of this.streamSessions) {
            try {
                session.stop();
            } catch (e) {
                this._log(`停止流式会话失败: ${sessionId} - ${e.message}`);
            }
        }
        this._log(`已停止所有流式会话`);
    }
    
    // ==================== 流式会话支持结束 ====================
    
    /**
     * 测试主机连接（并更新缓存）
     */
    async testConnection(hostId) {
        if (this._inFlightTestConnections && this._inFlightTestConnections.has(hostId)) {
            return this._inFlightTestConnections.get(hostId);
        }

        const task = this._testConnectionInternal(hostId);
        if (this._inFlightTestConnections) {
            this._inFlightTestConnections.set(hostId, task);
        }

        try {
            return await task;
        } finally {
            if (this._inFlightTestConnections) {
                this._inFlightTestConnections.delete(hostId);
            }
        }
    }

    /**
     * 内部测试连接逻辑（优化：仅握手，不执行额外命令）
     */
    async _testConnectionInternal(hostId) {
        let testResult;
        try {
            const startTime = Date.now();
            // 仅执行 connect，握手成功即代表通路
            await this.connect(hostId);
            const latency = Date.now() - startTime;

            testResult = {
                success: true,
                hostId,
                latency,
                output: "SSH_HANDSHAKE_OK",
                message: `连接成功，延迟 ${latency}ms`
            };
        } catch (error) {
            testResult = {
                success: false,
                hostId,
                error: error.message,
                message: `连接失败: ${error.message}`
            };
        }

        // 写入缓存后再返回：避免 Windows 下进程提前退出导致缓存未落盘
        try {
            await this._updateStatusCache(hostId, testResult);
        } catch (err) {
            this._log(`缓存更新失败: ${err.message}`);
        }

        return testResult;
    }

    async refreshAllStatuses() {
        this._log('开始批量刷新主机状态...');
        const tasks = Object.keys(this.hosts)
            .filter(id => this.hosts[id].enabled)
            .map(id => this.testConnection(id));
        
        return Promise.allSettled(tasks);
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
        // 先停止所有流式会话
        await this.stopAllStreamSessions();
        
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
            retryDelay: this.retryDelay,
            activeStreamSessions: this.streamSessions.size
        };
    }
    
    /**
     * 获取活跃连接数量
     */
    getActiveConnectionCount() {
        return this.activeConnections;
    }
}

module.exports = SSHManager;
