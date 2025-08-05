"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.delCache = exports.setCache = exports.getCache = void 0;
const config_js_1 = require("../config.js");
const flatted_1 = require("flatted");
const logger_js_1 = __importDefault(require("./logger.js"));
const node_cache_1 = __importDefault(require("node-cache"));
const ioredis_1 = __importDefault(require("ioredis"));
// init NodeCache
const cache = new node_cache_1.default({
    // 缓存过期时间（ 秒 ）
    stdTTL: config_js_1.config.CACHE_TTL,
    // 定期检查过期缓存（ 秒 ）
    checkperiod: 600,
    // 克隆变量
    useClones: false,
    // 最大键值对
    maxKeys: 100,
});
// init Redis client
const redis = new ioredis_1.default({
    host: config_js_1.config.REDIS_HOST,
    port: config_js_1.config.REDIS_PORT,
    password: config_js_1.config.REDIS_PASSWORD,
    maxRetriesPerRequest: 5,
    // 重试策略：最小延迟 50ms，最大延迟 2s
    retryStrategy: (times) => Math.min(times * 50, 2000),
    // 仅在第一次建立连接
    lazyConnect: true,
});
// Redis 是否可用
let isRedisAvailable = false;
let isRedisTried = false;
// Redis 连接状态
const ensureRedisConnection = async () => {
    if (isRedisTried)
        return;
    try {
        if (redis.status !== "ready" && redis.status !== "connecting")
            await redis.connect();
        isRedisAvailable = true;
        isRedisTried = true;
        logger_js_1.default.info("📦 [Redis] connected successfully.");
    }
    catch (error) {
        isRedisAvailable = false;
        isRedisTried = true;
        logger_js_1.default.error(`📦 [Redis] connection failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
};
// Redis 事件监听
redis.on("error", (err) => {
    if (!isRedisTried) {
        isRedisAvailable = false;
        isRedisTried = true;
        logger_js_1.default.error(`📦 [Redis] connection failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
});
// NodeCache 事件监听
cache.on("expired", (key) => {
    logger_js_1.default.info(`⏳ [NodeCache] Key "${key}" has expired.`);
});
cache.on("del", (key) => {
    logger_js_1.default.info(`🗑️ [NodeCache] Key "${key}" has been deleted.`);
});
/**
 * 从缓存中获取数据
 * @param key 缓存键
 * @returns 缓存数据
 */
const getCache = async (key) => {
    await ensureRedisConnection();
    if (isRedisAvailable) {
        try {
            const redisResult = await redis.get(key);
            if (redisResult)
                return (0, flatted_1.parse)(redisResult);
        }
        catch (error) {
            logger_js_1.default.error(`📦 [Redis] get error: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
    }
    return cache.get(key);
};
exports.getCache = getCache;
/**
 * 将数据写入缓存
 * @param key 缓存键
 * @param value 缓存值
 * @param ttl 缓存过期时间（ 秒 ）
 * @returns 是否写入成功
 */
const setCache = async (key, value, ttl = config_js_1.config.CACHE_TTL) => {
    // 尝试写入 Redis
    if (isRedisAvailable && !Buffer.isBuffer(value?.data)) {
        try {
            await redis.set(key, (0, flatted_1.stringify)(value), "EX", ttl);
            if (logger_js_1.default)
                logger_js_1.default.info(`💾 [REDIS] ${key} has been cached`);
        }
        catch (error) {
            logger_js_1.default.error(`📦 [Redis] set error: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
    }
    const success = cache.set(key, value, ttl);
    if (logger_js_1.default)
        logger_js_1.default.info(`💾 [NodeCache] ${key} has been cached`);
    return success;
};
exports.setCache = setCache;
/**
 * 从缓存中删除数据
 * @param key 缓存键
 * @returns 是否删除成功
 */
const delCache = async (key) => {
    let redisSuccess = true;
    try {
        await redis.del(key);
        logger_js_1.default.info(`🗑️ [REDIS] ${key} has been deleted from Redis`);
    }
    catch (error) {
        redisSuccess = false;
        logger_js_1.default.error(`📦 [Redis] del error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    // 尝试删除 NodeCache
    const nodeCacheSuccess = cache.del(key) > 0;
    if (logger_js_1.default)
        logger_js_1.default.info(`🗑️ [CACHE] ${key} has been deleted from NodeCache`);
    return redisSuccess && nodeCacheSuccess;
};
exports.delCache = delCache;
