// Plugin/RAGDiaryPlugin/CacheManager.js
// 统一缓存管理器 - 支持多种缓存实例的创建和管理

const crypto = require('crypto');

class CacheManager {
    constructor() {
        this.caches = new Map();
        this.cleanupIntervals = new Map();
    }

    /**
     * 创建一个新的缓存实例
     * @param {string} name - 缓存名称
     * @param {object} options - 配置选项
     * @param {number} options.maxSize - 最大缓存条目数
     * @param {number} options.ttl - 缓存有效期(毫秒)
     */
    createCache(name, { maxSize = 100, ttl = 3600000 } = {}) {
        this.caches.set(name, {
            data: new Map(),
            maxSize,
            ttl,
            hits: 0,
            misses: 0
        });
        console.log(`[CacheManager] 创建缓存: ${name} (最大: ${maxSize}条, TTL: ${ttl}ms)`);
    }

    /**
     * 从缓存获取值
     * @param {string} cacheName - 缓存名称
     * @param {string} key - 缓存键
     * @returns {any|null} 缓存的值或null
     */
    get(cacheName, key) {
        const cache = this.caches.get(cacheName);
        if (!cache) return null;

        const entry = cache.data.get(key);
        if (!entry) {
            cache.misses++;
            return null;
        }

        // 检查是否过期
        const now = Date.now();
        if (now - entry.timestamp > cache.ttl) {
            cache.data.delete(key);
            cache.misses++;
            return null;
        }

        cache.hits++;
        return entry.value;
    }

    /**
     * 设置缓存值(带LRU淘汰)
     * @param {string} cacheName - 缓存名称
     * @param {string} key - 缓存键
     * @param {any} value - 要缓存的值
     */
    set(cacheName, key, value) {
        const cache = this.caches.get(cacheName);
        if (!cache) return;

        // LRU策略: 超过容量时删除最早的条目
        if (cache.data.size >= cache.maxSize) {
            const firstKey = cache.data.keys().next().value;
            cache.data.delete(firstKey);
        }

        cache.data.set(key, {
            value,
            timestamp: Date.now()
        });
    }

    /**
     * 清空指定缓存
     * @param {string} cacheName - 缓存名称
     */
    clear(cacheName) {
        const cache = this.caches.get(cacheName);
        if (!cache) return;

        const oldSize = cache.data.size;
        cache.data.clear();
        cache.hits = 0;
        cache.misses = 0;
        console.log(`[CacheManager] ${cacheName} 缓存已清空 (删除了 ${oldSize} 条记录)`);
    }

    /**
     * 启动定期清理任务
     * @param {string} cacheName - 缓存名称
     */
    startCleanup(cacheName) {
        const cache = this.caches.get(cacheName);
        if (!cache) return;

        // 避免重复启动
        if (this.cleanupIntervals.has(cacheName)) return;

        const interval = setInterval(() => {
            const now = Date.now();
            let expiredCount = 0;

            for (const [key, entry] of cache.data.entries()) {
                if (now - entry.timestamp > cache.ttl) {
                    cache.data.delete(key);
                    expiredCount++;
                }
            }

            if (expiredCount > 0) {
                console.log(`[CacheManager] ${cacheName}: 清理了 ${expiredCount} 条过期缓存`);
            }
        }, cache.ttl);

        this.cleanupIntervals.set(cacheName, interval);
    }

    /**
     * 获取缓存统计信息
     * @param {string} cacheName - 缓存名称
     * @returns {object|null} 统计信息
     */
    getStats(cacheName) {
        const cache = this.caches.get(cacheName);
        if (!cache) return null;

        const total = cache.hits + cache.misses;
        return {
            size: cache.data.size,
            maxSize: cache.maxSize,
            hits: cache.hits,
            misses: cache.misses,
            hitRate: total > 0 ? `${(cache.hits / total * 100).toFixed(1)}%` : '0%',
            ttl: cache.ttl
        };
    }

    /**
     * 生成缓存键(SHA256哈希)
     * @param {object} params - 键参数对象
     * @returns {string} 哈希键
     */
    generateKey(params) {
        const keyString = JSON.stringify(params);
        return crypto.createHash('sha256').update(keyString).digest('hex');
    }

    /**
     * 关闭所有清理任务
     */
    shutdown() {
        for (const [name, interval] of this.cleanupIntervals.entries()) {
            clearInterval(interval);
            console.log(`[CacheManager] ${name} 清理任务已停止`);
        }
        this.cleanupIntervals.clear();
    }
}

module.exports = CacheManager;