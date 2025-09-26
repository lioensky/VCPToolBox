// modules/utils/settingsManager.js
const fs = require('fs-extra');
const path = require('path');
const { EventEmitter } = require('events');

class SettingsValidator {
    static validate(settings, defaultSettings) {
        const validated = { ...settings };
        let hasIssues = false;
        
        // 检查必要字段
        for (const [key, defaultValue] of Object.entries(defaultSettings)) {
            if (!(key in validated)) {
                validated[key] = defaultValue;
                hasIssues = true;
                console.log(`Added missing field: ${key}`);
            }
            
            // 类型检查
            if (typeof validated[key] !== typeof defaultValue) {
                validated[key] = defaultValue;
                hasIssues = true;
                console.log(`Fixed type for field: ${key}`);
            }
        }
        
        // 数值范围检查
        if (validated.sidebarWidth < 100 || validated.sidebarWidth > 800) {
            validated.sidebarWidth = 260;
            hasIssues = true;
        }
        
        // 数组检查
        if (!Array.isArray(validated.networkNotesPaths)) {
            validated.networkNotesPaths = [];
            hasIssues = true;
        }
        
        return { validated, hasIssues };
    }
}

class SettingsManager extends EventEmitter {
    constructor(settingsPath) {
        super();
        this.settingsPath = settingsPath;
        this.queue = [];
        this.processing = false;
        this.cache = null;
        this.cacheTimestamp = 0;
        this.lockFile = settingsPath + '.lock';
        
        // 默认设置模板
        this.defaultSettings = {
            sidebarWidth: 260,
            notificationsSidebarWidth: 300,
            userName: '用户',
            vcpServerUrl: '',
            vcpApiKey: '',
            vcpLogUrl: '',
            vcpLogKey: '',
            networkNotesPaths: [],
            enableAgentBubbleTheme: false,
            enableSmoothStreaming: false,
            minChunkBufferSize: 1,
            smoothStreamIntervalMs: 25,
            assistantAgent: '',
            enableDistributedServer: true,
            agentMusicControl: false,
            enableDistributedServerLogs: false,
            enableVcpToolInjection: false
        };
    }

    async acquireLock(timeout = 5000) {
        const startTime = Date.now();
        while (await fs.pathExists(this.lockFile)) {
            if (Date.now() - startTime > timeout) {
                console.warn('Lock acquisition timeout, removing stale lock');
                await fs.remove(this.lockFile).catch(() => {});
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        await fs.writeFile(this.lockFile, `${process.pid}-${Date.now()}`);
    }

    async releaseLock() {
        await fs.remove(this.lockFile).catch(() => {});
    }

    async readSettings() {
        try {
            // 使用缓存机制减少文件读取
            const stats = await fs.stat(this.settingsPath).catch(() => null);
            if (stats && this.cache && stats.mtimeMs <= this.cacheTimestamp) {
                return { ...this.cache };
            }

            const content = await fs.readFile(this.settingsPath, 'utf8');
            const settings = JSON.parse(content);
            
            // 更新缓存
            this.cache = settings;
            this.cacheTimestamp = stats ? stats.mtimeMs : Date.now();
            
            return { ...settings };
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { ...this.defaultSettings };
            }
            
            console.error('Error reading settings, attempting recovery:', error);
            
            // 尝试从备份恢复
            const backupPath = this.settingsPath + '.backup';
            if (await fs.pathExists(backupPath)) {
                try {
                    const backupContent = await fs.readFile(backupPath, 'utf8');
                    const backupSettings = JSON.parse(backupContent);
                    console.log('Recovered settings from backup');
                    return { ...backupSettings };
                } catch (backupError) {
                    console.error('Backup also corrupted:', backupError);
                }
            }
            
            // 最后的手段：返回默认设置
            return { ...this.defaultSettings };
        }
    }

    async writeSettings(settings) {
        const tempFile = this.settingsPath + '.tmp';
        const backupFile = this.settingsPath + '.backup';
        
        try {
            // 验证设置
            const { validated } = SettingsValidator.validate(settings, this.defaultSettings);
            
            // 写入临时文件
            await fs.writeJson(tempFile, validated, { spaces: 2 });
            
            // 验证临时文件
            const verifyContent = await fs.readFile(tempFile, 'utf8');
            JSON.parse(verifyContent);
            
            // 创建备份（如果原文件存在）
            if (await fs.pathExists(this.settingsPath)) {
                await fs.copy(this.settingsPath, backupFile, { overwrite: true });
            }
            
            // 原子性替换
            await fs.move(tempFile, this.settingsPath, { overwrite: true });
            
            // 更新缓存 - 确保原子性
            const newTimestamp = Date.now();
            this.cache = { ...validated };
            this.cacheTimestamp = newTimestamp;
            
            // 触发更新事件
            this.emit('settings-updated', validated);
            
            return true;
        } catch (error) {
            console.error('Error writing settings:', error);
            
            // 清理临时文件
            await fs.remove(tempFile).catch(() => {});
            
            throw error;
        }
    }

    async updateSettings(updater) {
        return new Promise((resolve, reject) => {
            this.queue.push({ updater, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;
        const { updater, resolve, reject } = this.queue.shift();

        try {
            await this.acquireLock();
            
            const currentSettings = await this.readSettings();
            const newSettings = typeof updater === 'function' 
                ? await updater(currentSettings)
                : { ...currentSettings, ...updater };
            
            await this.writeSettings(newSettings);
            
            resolve({ success: true, settings: newSettings });
        } catch (error) {
            reject(error);
        } finally {
            await this.releaseLock();
            this.processing = false;
            
            // 继续处理队列
            if (this.queue.length > 0) {
                setImmediate(() => this.processQueue());
            }
        }
    }

    // 定期清理过期的锁文件
    startCleanupTimer() {
        setInterval(async () => {
            if (await fs.pathExists(this.lockFile)) {
                try {
                    const lockContent = await fs.readFile(this.lockFile, 'utf8');
                    const [pid, timestamp] = lockContent.split('-');
                    
                    // 如果锁文件超过10秒，认为是过期的
                    if (Date.now() - parseInt(timestamp) > 10000) {
                        console.log('Removing stale lock file');
                        await fs.remove(this.lockFile);
                    }
                } catch (error) {
                    console.error('Error checking lock file:', error);
                }
            }
        }, 30000); // 每30秒检查一次
    }

    // 自动备份机制
    startAutoBackup(userDataDir) {
        setInterval(async () => {
            try {
                if (await fs.pathExists(this.settingsPath)) {
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const backupDir = path.join(userDataDir, 'backups');
                    await fs.ensureDir(backupDir);
                    
                    const backupPath = path.join(backupDir, `settings-${timestamp}.json`);
                    await fs.copy(this.settingsPath, backupPath);
                    
                    // 只保留最近7天的备份
                    const files = await fs.readdir(backupDir);
                    const backupFiles = files.filter(f => f.startsWith('settings-'));
                    if (backupFiles.length > 7) {
                        backupFiles.sort((a, b) => b.localeCompare(a)); // 降序，最新在前
                        for (let i = 7; i < backupFiles.length; i++) {
                            await fs.remove(path.join(backupDir, backupFiles[i]));
                        }
                    }
                }
            } catch (error) {
                console.error('Auto backup failed:', error);
            }
        }, 24 * 60 * 60 * 1000); // 每天备份一次
    }

    // 清理缓存
    clearCache() {
        this.cache = null;
        this.cacheTimestamp = 0;
    }

    // 强制刷新缓存
    async refreshCache() {
        this.clearCache();
        return await this.readSettings();
    }
}
module.exports = SettingsManager;