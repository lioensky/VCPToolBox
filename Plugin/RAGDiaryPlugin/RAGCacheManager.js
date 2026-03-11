// Plugin/RAGDiaryPlugin/RAGCacheManager.js

const crypto = require('crypto');

/**
 * RAG 缓存管理组件 (LRU + TTL)
 */
class RAGCacheManager {
    /**
     * @param {string} name 缓存名称 (用于日志)
     * @param {object} options { maxSize, ttl, enabled }
     */
    constructor(name, options = {}) {
        this.name = name;
        this.maxSize = options.maxSize || 100;
        this.ttl = options.ttl || 3600000;
        this.enabled = options.enabled !== false;

        this.cache = new Map();
        this.hits = 0;
        this.misses = 0;
        this.cleanupInterval = null;
    }

    /**
     * 获取缓存
     */
    get(key) {
        if (!this.enabled) return null;
        const cached = this.cache.get(key);
        if (!cached) {
            this.misses++;
            return null;
        }

        // 检查过期
        if (Date.now() - cached.timestamp > this.ttl) {
            this.cache.delete(key);
            this.misses++;
            return null;
        }

        this.hits++;
        // LRU: 更新位置
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.data;
    }

    /**
     * 设置缓存
     */
    set(key, data) {
        if (!this.enabled) return;

        // LRU 淘汰
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }

    /**
     * 清空缓存
     */
    clear() {
        const oldSize = this.cache.size;
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
        return oldSize;
    }

    /**
     * 启动定时清理任务
     */
    startCleanupTask() {
        if (this.cleanupInterval) return;
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            let expiredCount = 0;
            for (const [key, value] of this.cache.entries()) {
                if (now - value.timestamp > this.ttl) {
                    this.cache.delete(key);
                    expiredCount++;
                }
            }
            if (expiredCount > 0) {
                console.log(`[RAGCacheManager:${this.name}] 清理了 ${expiredCount} 条过期内容`);
            }
        }, this.ttl);
    }

    /**
     * 关闭清理任务
     */
    stopCleanupTask() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    /**
     * 获取统计信息
     */
    getStats() {
        const total = this.hits + this.misses;
        return {
            name: this.name,
            size: this.cache.size,
            maxSize: this.maxSize,
            hits: this.hits,
            misses: this.misses,
            hitRate: total > 0 ? (this.hits / total * 100).toFixed(1) + '%' : '0.0%',
            ttl: this.ttl
        };
    }

    /**
     * 静态辅助：生成哈希键
     */
    static generateHashKey(content) {
        return crypto.createHash('sha256').update(String(content).trim()).digest('hex');
    }
}

module.exports = RAGCacheManager;
