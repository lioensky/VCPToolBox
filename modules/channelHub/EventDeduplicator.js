// modules/channelHub/EventDeduplicator.js
/**
 * 入站事件去重器
 * 
 * 职责：
 * - 防止同一事件重复触发 runtime
 * - 支持主键和次键两级去重
 * - 支持 TTL 自动过期清理
 * - 支持平台重试消息识别
 * 
 * 去重键策略：
 * - 主键: adapterId + eventId（平台唯一事件ID）
 * - 次键: channel + conversationId + messageId（消息级别去重）
 */

const { buildDedupKey, buildSecondaryDedupKey, nowTimestamp } = require('./utils');
const { DEDUP_TTL_MS } = require('./constants');

class EventDeduplicator {
  /**
   * @param {Object} options
   * @param {import('./StateStore')} options.stateStore - 状态存储实例
   * @param {number} [options.ttlMs] - 去重缓存TTL（毫秒）
   * @param {boolean} [options.debugMode] - 调试模式
   * @param {number} [options.cleanupIntervalMs] - 清理间隔（毫秒）
   */
  constructor(options = {}) {
    this.stateStore = options.stateStore;
    this.ttlMs = options.ttlMs || DEDUP_TTL_MS || 300000;
    this.debugMode = options.debugMode || false;
    this.cleanupIntervalMs = options.cleanupIntervalMs || 60000; // 每分钟清理一次

    // 内存缓存：key -> timestamp
    this._cache = new Map();

    // 清理定时器
    this._cleanupTimer = null;
  }

  /**
   * 启动定时清理
   */
  start() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => {
      this.cleanupExpiredEntries();
    }, this.cleanupIntervalMs);

    // 不阻止进程退出
    if (this._cleanupTimer.unref) {
      this._cleanupTimer.unref();
    }
  }

  /**
   * 停止定时清理
   */
  stop() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  /**
   * 检查事件是否重复，如果不重复则标记为已处理
   * @param {Object} envelope - 标准化事件信封
   * @returns {Promise<{isDuplicate: boolean, reason?: string, keys: string[]}>}
   */
  async checkAndMark(envelope) {
    const keys = this.buildDedupKeys(envelope);

    if (this.debugMode) {
      console.log('[EventDeduplicator] 检查去重键:', keys);
    }

    // 检查每个键是否已存在
    for (const key of keys) {
      if (this._cache.has(key)) {
        const cachedAt = this._cache.get(key);
        const age = nowTimestamp() - cachedAt;

        // 检查是否在 TTL 内
        if (age < this.ttlMs) {
          if (this.debugMode) {
            console.log(`[EventDeduplicator] 命中去重: ${key} (age: ${age}ms)`);
          }
          return {
            isDuplicate: true,
            reason: `Duplicate key hit: ${key} (age: ${age}ms)`,
            keys
          };
        } else {
          // 已过期，移除
          this._cache.delete(key);
        }
      }
    }

    // 未命中，标记所有键
    const now = nowTimestamp();
    for (const key of keys) {
      this._cache.set(key, now);
    }

    // 异步持久化到 StateStore（不阻塞主流程）
    this._persistAsync(keys, now).catch(err => {
      if (this.debugMode) {
        console.error('[EventDeduplicator] 持久化失败:', err.message);
      }
    });

    return {
      isDuplicate: false,
      keys
    };
  }

  /**
   * 构建去重键
   * @param {Object} envelope - 标准化事件信封
   * @returns {string[]} 去重键数组
   */
  buildDedupKeys(envelope) {
    const keys = [];

    // 主键：adapterId + eventId
    if (envelope.adapterId && envelope.eventId) {
      keys.push(buildDedupKey(envelope.adapterId, envelope.eventId));
    }

    // 次键：channel + conversationId + messageId
    const channel = envelope.channel;
    const conversationId = envelope.client?.conversationId;
    const messageId = envelope.client?.messageId;
    if (channel && conversationId && messageId) {
      keys.push(buildSecondaryDedupKey(channel, conversationId, messageId));
    }

    // 如果没有任何可用键，用整个 body 的哈希
    if (keys.length === 0) {
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256')
        .update(JSON.stringify(envelope))
        .digest('hex')
        .substring(0, 16);
      keys.push(`fallback:${hash}`);
    }

    return keys;
  }

  /**
   * 清理过期的去重缓存
   * @returns {number} 清理的条目数量
   */
  cleanupExpiredEntries() {
    const now = nowTimestamp();
    let cleaned = 0;

    for (const [key, timestamp] of this._cache.entries()) {
      if (now - timestamp > this.ttlMs) {
        this._cache.delete(key);
        cleaned++;
      }
    }

    if (this.debugMode && cleaned > 0) {
      console.log(`[EventDeduplicator] 清理 ${cleaned} 个过期条目，剩余 ${this._cache.size}`);
    }

    return cleaned;
  }

  /**
   * 强制标记某个事件为已处理（用于手动去重）
   * @param {Object} envelope - 标准化事件信封
   * @returns {Promise<void>}
   */
  async markAsProcessed(envelope) {
    const keys = this.buildDedupKeys(envelope);
    const now = nowTimestamp();

    for (const key of keys) {
      this._cache.set(key, now);
    }

    if (this.debugMode) {
      console.log('[EventDeduplicator] 强制标记为已处理:', keys);
    }
  }

  /**
   * 清除去重缓存（用于测试或重置）
   * @returns {Promise<void>}
   */
  async clearCache() {
    this._cache.clear();

    if (this.debugMode) {
      console.log('[EventDeduplicator] 去重缓存已清除');
    }
  }

  /**
   * 获取缓存统计
   * @returns {Object}
   */
  getStats() {
    return {
      cacheSize: this._cache.size,
      ttlMs: this.ttlMs
    };
  }

  /**
   * 异步持久化去重记录到 StateStore
   * @param {string[]} keys - 去重键
   * @param {number} timestamp - 时间戳
   * @private
   */
  async _persistAsync(keys, timestamp) {
    if (!this.stateStore) return;

    try {
      const cache = await this.stateStore.getDedupCache();
      const entries = cache.entries || {};

      for (const key of keys) {
        entries[key] = timestamp;
      }

      // 顺便清理持久化存储中的过期条目
      const now = nowTimestamp();
      for (const [k, ts] of Object.entries(entries)) {
        if (now - ts > this.ttlMs) {
          delete entries[k];
        }
      }

      cache.entries = entries;
      cache.lastCleanup = now;
      await this.stateStore.saveDedupCache(cache);
    } catch (err) {
      // 持久化失败不影响主流程，内存缓存仍然有效
      console.error('[EventDeduplicator] 持久化去重缓存失败:', err.message);
    }
  }

  /**
   * 从持久化存储恢复缓存（启动时调用）
   * @returns {Promise<number>} 恢复的条目数
   */
  async restoreFromStore() {
    if (!this.stateStore) return 0;

    try {
      const cache = await this.stateStore.getDedupCache();
      const entries = cache.entries || {};
      const now = nowTimestamp();
      let restored = 0;

      for (const [key, timestamp] of Object.entries(entries)) {
        // 只恢复未过期的条目
        if (now - timestamp < this.ttlMs) {
          this._cache.set(key, timestamp);
          restored++;
        }
      }

      if (this.debugMode) {
        console.log(`[EventDeduplicator] 从存储恢复 ${restored} 个去重条目`);
      }

      return restored;
    } catch (err) {
      console.error('[EventDeduplicator] 恢复去重缓存失败:', err.message);
      return 0;
    }
  }
}

module.exports = EventDeduplicator;