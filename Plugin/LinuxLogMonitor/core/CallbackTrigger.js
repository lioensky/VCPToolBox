/**
 * CallbackTrigger - 回调触发器
 *
 * 负责：
 * - 向 VCP 发送异常回调
 * - 指数退避重试机制
 * - 失败回调持久化
 *
 * @version 1.1.0
 */

const path = require('path');
const fs = require('fs').promises;
const util = require('util');

// 失败回调日志路径
const FAILED_CALLBACKS_PATH = path.join(__dirname, '..', 'state', 'failed_callbacks.jsonl');

let loggerModule = null;

function isServerLoggerActive() {
    try {
        loggerModule = loggerModule || require('../../../modules/logger');
        return Boolean(
            loggerModule.originalConsoleError &&
            console.error !== loggerModule.originalConsoleError
        );
    } catch (_) {
        return false;
    }
}

function logInfo(...args) {
    if (isServerLoggerActive()) {
        console.info(...args);
        return;
    }
    process.stderr.write(`${util.format(...args)}\n`);
}

class CallbackTrigger {
    /**
     * @param {Object} options
     * @param {string} options.baseUrl - VCP 回调基础 URL
     * @param {string} options.pluginName - 插件名称
     * @param {boolean} options.debug - 调试模式
     */
    constructor(options = {}) {
        this.baseUrl = options.baseUrl || 'http://localhost:5000';
        this.pluginName = options.pluginName || 'LinuxLogMonitor';
        this.debug = options.debug || false;
        
        // 重试配置
        this.maxRetries = 3;
        this.baseDelay = 1000; // 1秒
        this.maxDelay = 30000; // 30秒
        this.backoffMultiplier = 2;
        this.timeout = 10000; // 10秒请求超时
        
        // 统计
        this.stats = {
            totalCallbacks: 0,
            successfulCallbacks: 0,
            failedCallbacks: 0,
            retriedCallbacks: 0
        };
    }
    
    /**
     * 触发回调
     * @param {string} taskId - 任务 ID
     * @param {Object} data - 回调数据
     * @returns {boolean} 是否成功
     */
    async trigger(taskId, data) {
        this.stats.totalCallbacks++;
        
        // 智能构建回调 URL：检测 baseUrl 是否已包含 /plugin-callback
        let callbackUrl;
        if (this.baseUrl.endsWith('/plugin-callback') || this.baseUrl.includes('/plugin-callback/')) {
            // baseUrl 已包含 /plugin-callback，直接追加 pluginName 和 taskId
            const base = this.baseUrl.replace(/\/$/, ''); // 移除末尾斜杠
            callbackUrl = `${base}/${this.pluginName}/${taskId}`;
        } else {
            // baseUrl 不包含 /plugin-callback，需要追加完整路径
            const base = this.baseUrl.replace(/\/$/, ''); // 移除末尾斜杠
            callbackUrl = `${base}/plugin-callback/${this.pluginName}/${taskId}`;
        }
        
        this._log(`触发回调: ${callbackUrl}`);
        
        let lastError = null;
        
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    // 计算延迟（指数退避）
                    const delay = Math.min(
                        this.baseDelay * Math.pow(this.backoffMultiplier, attempt - 1),
                        this.maxDelay
                    );
                    
                    this._log(`第 ${attempt} 次重试，等待 ${delay}ms`);
                    this.stats.retriedCallbacks++;
                    
                    await this._sleep(delay);
                }
                
                // 发送请求
                const response = await this._sendRequest(callbackUrl, data);
                
                if (response.ok) {
                    this.stats.successfulCallbacks++;
                    this._log(`回调成功: ${response.status}`);
                    return true;
                }
                
                // HTTP 错误
                lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
                this._log(`回调失败: ${lastError.message}`);
                
                // 4xx 错误不重试
                if (response.status >= 400 && response.status < 500) {
                    break;
                }
                
            } catch (error) {
                lastError = error;
                this._log(`回调异常: ${error.message}`);
            }
        }
        
        // 所有重试都失败
        this.stats.failedCallbacks++;
        // 记录失败的回调
        await this._logFailedCallback(taskId, data, lastError);
        
        return false;
    }
    
    /**
     * 重试失败的回调
     * @returns {Object} 重试结果
     */
    async retryFailedCallbacks() {
        const results = {
            total: 0,
            success: 0,
            failed: 0
        };
        
        try {
            const content = await fs.readFile(FAILED_CALLBACKS_PATH, 'utf-8');
            const lines = content.trim().split('\n').filter(Boolean);
            
            results.total = lines.length;
            const remainingFailures = [];
            for (const line of lines) {
                try {
                    const record = JSON.parse(line);
                    if (record.retried) {
                        continue; // 已经重试过
                    }
                    
                    const success = await this.trigger(record.taskId, record.data);
                    
                    if (success) {
                        results.success++;
                    } else {
                        record.retried = true;
                        record.retryTime = new Date().toISOString();
                        remainingFailures.push(JSON.stringify(record));
                        results.failed++;
                    }
                    
                } catch (error) {
                    this._log(`解析失败记录错误: ${error.message}`);
                    results.failed++;
                }
            }
            
            // 更新失败记录文件
            if (remainingFailures.length > 0) {
                await fs.writeFile(FAILED_CALLBACKS_PATH, remainingFailures.join('\n') + '\n', 'utf-8');
            } else {
                // 清空文件
                await fs.writeFile(FAILED_CALLBACKS_PATH, '', 'utf-8');
            }
            
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this._log(`读取失败记录错误: ${error.message}`);
            }
        }
        
        return results;
    }
    
    /**
     * 获取统计信息
     * @returns {Object}
     */
    getStats() {
        return { ...this.stats };
    }
    
    // ==================== 私有方法 ====================
    
    /**
     * 发送 HTTP 请求
     */
    async _sendRequest(url, data) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Plugin-Name': this.pluginName,
                    'X-Callback-Type': 'anomaly'
                },
                body: JSON.stringify(data),
                signal: controller.signal
            });
            
            return response;
            
        } finally {
            clearTimeout(timeoutId);
        }
    }
    
    /**
     * 记录失败的回调
     */
    async _logFailedCallback(taskId, data, error) {
        const record = {
            timestamp: new Date().toISOString(),
            pluginName: this.pluginName,
            taskId,
            data,
            error: error ? error.message : 'Unknown error',
            retried: false
        };
        
        try {
            await fs.appendFile(
                FAILED_CALLBACKS_PATH,
                JSON.stringify(record) + '\n',
                'utf-8'
            );} catch (err) {
            this._log(`记录失败回调错误: ${err.message}`);
        }
    }
    
    /**
     * 睡眠
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * 日志输出
     */
    _log(msg, ...args) {
        if (this.debug) {
            logInfo(`[CallbackTrigger] ${msg}`, ...args);
        }
    }
}

module.exports = CallbackTrigger;
