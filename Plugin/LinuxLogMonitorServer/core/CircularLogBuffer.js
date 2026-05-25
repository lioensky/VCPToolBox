const crypto = require('crypto');

/**
 * CircularLogBuffer - 环形日志缓冲区
 *
 * 双限制 LRU：同时满足行数上限和字节上限。
 * 内部存储格式: { raw: string, timestamp: number, hash: string }
 * hash 用于 LogWatcher 外部的去重支持，本类仅提供 hasHash 快速查询。
 */
class CircularLogBuffer {
    constructor(options = {}) {
        this.maxLines = options.maxLines || 5000;
        this.maxBytes = options.maxBytes || 10 * 1024 * 1024; // 10MB

        // 使用预分配数组实现真正的 O(1) push / evict
        this._buffer = new Array(this.maxLines);
        this._head = 0; // 最旧元素的下标
        this._count = 0; // 当前有效元素数
        this._totalBytes = 0;
        this._hashSet = new Set();
    }

    push(rawLine) {
        const bytes = Buffer.byteLength(rawLine, 'utf8');
        const hash = crypto
            .createHash('md5')
            .update(rawLine)
            .digest('hex')
            .slice(0, 16);

        const entry = {
            raw: rawLine,
            timestamp: Date.now(),
            hash
        };

        // 若已达行数上限，先淘汰头部
        if (this._count === this.maxLines) {
            this._evictHead();
        }

        // 写入尾部（O(1)）
        const tail = (this._head + this._count) % this.maxLines;
        this._buffer[tail] = entry;
        this._count++;
        this._totalBytes += bytes;
        this._hashSet.add(hash);

        // 若超出字节上限，从头部继续淘汰
        while (this._totalBytes > this.maxBytes && this._count > 0) {
            this._evictHead();
        }
    }

    _evictHead() {
        if (this._count === 0) return;

        const entry = this._buffer[this._head];
        this._totalBytes -= Buffer.byteLength(entry.raw, 'utf8');
        this._hashSet.delete(entry.hash);
        this._buffer[this._head] = undefined; // 解除引用，允许 GC

        this._head = (this._head + 1) % this.maxLines;
        this._count--;
    }

    _getEntry(logicalIndex) {
        return this._buffer[(this._head + logicalIndex) % this.maxLines];
    }

    /**
     * 返回完整 lines 数组（浅拷贝，按时间顺序）
     */
    getAllLines() {
        const result = new Array(this._count);
        for (let i = 0; i < this._count; i++) {
            result[i] = this._getEntry(i);
        }
        return result;
    }

    /**
     * 返回最后 n 行
     */
    getRecent(n) {
        const start = Math.max(0, this._count - n);
        const len = this._count - start;
        const result = new Array(len);
        for (let i = 0; i < len; i++) {
            result[i] = this._getEntry(start + i);
        }
        return result;
    }

    /**
     * 返回指定索引范围 [startIndex, endIndex]（含）
     */
    getLinesBetween(startIndex, endIndex) {
        if (startIndex < 0) startIndex = 0;
        if (endIndex >= this._count) endIndex = this._count - 1;
        if (startIndex > endIndex || this._count === 0) {
            return [];
        }

        const len = endIndex - startIndex + 1;
        const result = new Array(len);
        for (let i = 0; i < len; i++) {
            result[i] = this._getEntry(startIndex + i);
        }
        return result;
    }

    clear() {
        this._buffer = new Array(this.maxLines);
        this._head = 0;
        this._count = 0;
        this._totalBytes = 0;
        this._hashSet.clear();
    }

    getStats() {
        return {
            lines: this._count,
            bytes: this._totalBytes,
            maxLines: this.maxLines,
            maxBytes: this.maxBytes
        };
    }

    /**
     * 基于 hash 的快速存在性检查
     */
    hasHash(hash) {
        return this._hashSet.has(hash);
    }

    /**
     * 搜索匹配的行
     * @param {string|RegExp} pattern
     * @param {Object} options
     *   @param {number} [options.since] 毫秒时间戳，只返回 timestamp >= since 的条目
     *   @param {string[]} [options.levels] 日志级别过滤，如 ['error', 'warn']
     *   @param {number} [options.maxResults=1000] 最大返回条数
     */
    find(pattern, options = {}) {
        const { since, levels, maxResults = 1000 } = options;
        const results = [];
        const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);

        for (let i = 0; i < this._count; i++) {
            if (results.length >= maxResults) break;

            const entry = this._getEntry(i);

            if (since !== undefined && entry.timestamp < since) {
                continue;
            }

            if (levels && levels.length > 0) {
                const hasLevel = levels.some(level =>
                    entry.raw.toLowerCase().includes(level.toLowerCase())
                );
                if (!hasLevel) continue;
            }

            if (regex.test(entry.raw)) {
                results.push(entry);
            }
        }

        return results;
    }
}

module.exports = CircularLogBuffer;
