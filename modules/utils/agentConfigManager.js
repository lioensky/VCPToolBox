// modules/utils/agentConfigManager.js
const fs = require('fs-extra');
const path = require('path');
const { EventEmitter } = require('events');

class AgentConfigManager extends EventEmitter {
    constructor(agentDir) {
        super();
        this.agentDir = agentDir;
        this.queues = new Map(); // 每个agent一个队列
        this.processing = new Map(); // 每个agent的处理状态
        this.locks = new Map(); // 每个agent的锁文件路径
        this.caches = new Map(); // 每个agent的缓存
        this.cacheTimestamps = new Map(); // 每个agent的缓存时间戳
    }

    getAgentPaths(agentId) {
        const agentPath = path.join(this.agentDir, agentId);
        const configPath = path.join(agentPath, 'config.json');
        const lockFile = configPath + '.lock';
        return { agentPath, configPath, lockFile };
    }

    async acquireLock(agentId, timeout = 5000) {
        const { lockFile } = this.getAgentPaths(agentId);
        const startTime = Date.now();
        
        while (await fs.pathExists(lockFile)) {
            if (Date.now() - startTime > timeout) {
                console.warn(`Agent ${agentId} lock acquisition timeout, removing stale lock`);
                await fs.remove(lockFile).catch(() => {});
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        await fs.writeFile(lockFile, `${process.pid}-${Date.now()}`);
    }

    async releaseLock(agentId) {
        const { lockFile } = this.getAgentPaths(agentId);
        await fs.remove(lockFile).catch(() => {});
    }

    async readAgentConfig(agentId) {
        const { configPath } = this.getAgentPaths(agentId);
        
        try {
            // 使用缓存机制减少文件读取
            const stats = await fs.stat(configPath).catch(() => null);
            const cacheKey = agentId;
            const cachedConfig = this.caches.get(cacheKey);
            const cacheTimestamp = this.cacheTimestamps.get(cacheKey) || 0;
            
            if (stats && cachedConfig && stats.mtimeMs <= cacheTimestamp) {
                return { ...cachedConfig };
            }

            const content = await fs.readFile(configPath, 'utf8');
            const config = JSON.parse(content);
            
            // 更新缓存
            this.caches.set(cacheKey, config);
            this.cacheTimestamps.set(cacheKey, stats ? stats.mtimeMs : Date.now());
            
            return { ...config };
        } catch (error) {
            if (error.code === 'ENOENT') {
                // 返回默认配置
                const defaultConfig = {
                    name: agentId,
                    systemPrompt: `你是 ${agentId}。`,
                    model: 'gemini-2.5-flash-preview-05-20',
                    temperature: 0.7,
                    contextTokenLimit: 1000000,
                    maxOutputTokens: 60000,
                    topics: [{ id: "default", name: "主要对话", createdAt: Date.now() }]
                };
                return { ...defaultConfig };
            }
            
            console.error(`Error reading agent ${agentId} config, attempting recovery:`, error);
            
            // 尝试从备份恢复
            const backupPath = configPath + '.backup';
            if (await fs.pathExists(backupPath)) {
                try {
                    const backupContent = await fs.readFile(backupPath, 'utf8');
                    const backupConfig = JSON.parse(backupContent);
                    console.log(`Recovered agent ${agentId} config from backup`);
                    return { ...backupConfig };
                } catch (backupError) {
                    console.error(`Agent ${agentId} backup also corrupted:`, backupError);
                }
            }
            
            // 最后的手段：返回默认配置
            const defaultConfig = {
                name: agentId,
                systemPrompt: `你是 ${agentId}。`,
                model: 'gemini-2.5-flash-preview-05-20',
                temperature: 0.7,
                contextTokenLimit: 1000000,
                maxOutputTokens: 60000,
                topics: [{ id: "default", name: "主要对话", createdAt: Date.now() }]
            };
            return { ...defaultConfig };
        }
    }

    async writeAgentConfig(agentId, config) {
        const { agentPath, configPath } = this.getAgentPaths(agentId);
        const tempFile = configPath + '.tmp';
        const backupFile = configPath + '.backup';
        
        try {
            // 确保agent目录存在
            await fs.ensureDir(agentPath);
            
            // 写入临时文件
            await fs.writeJson(tempFile, config, { spaces: 2 });
            
            // 验证临时文件
            const verifyContent = await fs.readFile(tempFile, 'utf8');
            JSON.parse(verifyContent);
            
            // 创建备份（如果原文件存在）
            if (await fs.pathExists(configPath)) {
                await fs.copy(configPath, backupFile, { overwrite: true });
            }
            
            // 原子性替换
            await fs.move(tempFile, configPath, { overwrite: true });
            
            // 更新缓存
            this.caches.set(agentId, { ...config });
            this.cacheTimestamps.set(agentId, Date.now());
            
            // 触发更新事件
            this.emit('agent-config-updated', agentId, config);
            
            return true;
        } catch (error) {
            console.error(`Error writing agent ${agentId} config:`, error);
            
            // 清理临时文件
            await fs.remove(tempFile).catch(() => {});
            
            throw error;
        }
    }

    async updateAgentConfig(agentId, updater) {
        return new Promise((resolve, reject) => {
            // 为每个agent维护独立的队列
            if (!this.queues.has(agentId)) {
                this.queues.set(agentId, []);
            }
            
            this.queues.get(agentId).push({ updater, resolve, reject });
            this.processQueue(agentId);
        });
    }

    async processQueue(agentId) {
        const queue = this.queues.get(agentId);
        if (!queue || this.processing.get(agentId) || queue.length === 0) {
            return;
        }

        this.processing.set(agentId, true);
        const { updater, resolve, reject } = queue.shift();

        try {
            await this.acquireLock(agentId);
            
            const currentConfig = await this.readAgentConfig(agentId);
            const newConfig = typeof updater === 'function' 
                ? await updater(currentConfig)
                : { ...currentConfig, ...updater };
            
            await this.writeAgentConfig(agentId, newConfig);
            
            resolve({ success: true, config: newConfig });
        } catch (error) {
            reject(error);
        } finally {
            await this.releaseLock(agentId);
            this.processing.set(agentId, false);
            
            // 继续处理队列
            if (queue.length > 0) {
                setImmediate(() => this.processQueue(agentId));
            }
        }
    }

    // 定期清理过期的锁文件
    startCleanupTimer() {
        setInterval(async () => {
            for (const [agentId] of this.queues) {
                const { lockFile } = this.getAgentPaths(agentId);
                if (await fs.pathExists(lockFile)) {
                    try {
                        const lockContent = await fs.readFile(lockFile, 'utf8');
                        const [pid, timestamp] = lockContent.split('-');
                        
                        // 如果锁文件超过10秒，认为是过期的
                        if (Date.now() - parseInt(timestamp) > 10000) {
                            console.log(`Removing stale lock file for agent ${agentId}`);
                            await fs.remove(lockFile);
                        }
                    } catch (error) {
                        console.error(`Error checking lock file for agent ${agentId}:`, error);
                    }
                }
            }
        }, 30000); // 每30秒检查一次
    }

    // 清理指定agent的缓存
    clearCache(agentId) {
        this.caches.delete(agentId);
        this.cacheTimestamps.delete(agentId);
    }

    // 清理所有缓存
    clearAllCaches() {
        this.caches.clear();
        this.cacheTimestamps.clear();
    }
}

module.exports = AgentConfigManager;