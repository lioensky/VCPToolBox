'use strict';

const { decodeVectorBlob, encodeVectorBlob } = require('./vectorCodec');

class DiaryMetadataCache {
    constructor(options = {}) {
        this.getDb = options.getDb;
        this.dimension = options.dimension;
        this.getEmbeddingsBatch = options.getEmbeddingsBatch;
        this.getEmbeddingConfig = options.getEmbeddingConfig;
        this.nameVectorCache = options.nameVectorCache || new Map();
        this.dateIndexCache = options.dateIndexCache || new Map();
        this.logPrefix = options.logPrefix || 'KnowledgeBase';
    }

    _db() {
        const db = this.getDb?.();
        if (!db) throw new Error('DiaryMetadataCache database is unavailable');
        return db;
    }

    extractDateFromText(text) {
        if (!text || typeof text !== 'string') return null;
        const firstLine = text.split('\n')[0] || '';
        const match = firstLine.match(/^\[?(\d{4}[-.]\d{2}[-.]\d{2})\]?/);
        return match ? match[1].replace(/\./g, '-') : null;
    }

    buildDateIndex(diaryName) {
        if (!diaryName) return [];
        try {
            const rows = this._db().prepare(`
                SELECT f.path AS relativePath, c.content AS content
                FROM files f
                JOIN chunks c ON c.file_id = f.id AND c.chunk_index = 0
                WHERE f.diary_name = ?
                ORDER BY f.path ASC
            `).all(diaryName);
            const items = [];
            for (const row of rows) {
                const date = this.extractDateFromText(row.content);
                if (date) items.push({ relativePath: row.relativePath, date });
            }
            items.sort((left, right) => new Date(right.date) - new Date(left.date));
            return items;
        } catch (error) {
            console.warn(
                `[${this.logPrefix}] ⚠️ Failed to build diary date index for ` +
                `"${diaryName}": ${error.message}`
            );
            return [];
        }
    }

    ensureDateIndex(diaryName) {
        if (!diaryName) return [];
        if (this.dateIndexCache.has(diaryName)) {
            return this.dateIndexCache.get(diaryName);
        }
        const items = this.buildDateIndex(diaryName);
        this.dateIndexCache.set(diaryName, items);
        if (items.length > 0) {
            console.log(
                `[${this.logPrefix}] 🗓️ Diary date index cached for ` +
                `"${diaryName}": ${items.length} file(s).`
            );
        }
        return items;
    }

    getDateIndex(diaryName) {
        return this.ensureDateIndex(diaryName).map(item => ({ ...item }));
    }

    invalidateDateIndex(diaryName) {
        if (diaryName) this.dateIndexCache.delete(diaryName);
    }

    async getNameVector(diaryName) {
        if (!diaryName) return null;
        if (this.nameVectorCache.has(diaryName)) {
            return this.nameVectorCache.get(diaryName);
        }

        try {
            const row = this._db()
                .prepare('SELECT vector FROM kv_store WHERE key = ?')
                .get(`diary_name:${diaryName}`);
            if (row?.vector) {
                const decoded = decodeVectorBlob(
                    row.vector,
                    this.dimension,
                    `diary_name:${diaryName}`
                );
                if (decoded) {
                    const vector = Array.from(decoded);
                    this.nameVectorCache.set(diaryName, vector);
                    return vector;
                }
            }
        } catch (error) {
            console.warn(
                `[${this.logPrefix}] DB lookup failed for diary name: ${diaryName}`
            );
        }

        console.warn(
            `[${this.logPrefix}] Cache MISS for diary name vector: ` +
            `"${diaryName}". Fetching now...`
        );
        return this.fetchAndCacheNameVector(diaryName);
    }

    hydrateNameCacheSync() {
        console.log(`[${this.logPrefix}] Hydrating diary name vectors (Sync)...`);
        const statement = this._db().prepare(
            "SELECT key, vector FROM kv_store WHERE key LIKE 'diary_name:%'"
        );
        let count = 0;
        for (const row of statement.iterate()) {
            const name = row.key.slice('diary_name:'.length);
            const decoded = decodeVectorBlob(
                row.vector,
                this.dimension,
                row.key
            );
            if (!decoded) continue;
            this.nameVectorCache.set(name, Array.from(decoded));
            count++;
        }
        console.log(
            `[${this.logPrefix}] Hydrated ${count} diary name vectors.`
        );
        return count;
    }

    async fetchAndCacheNameVector(name) {
        try {
            const [vector] = await this.getEmbeddingsBatch(
                [name],
                this.getEmbeddingConfig()
            );
            if (!vector) return null;
            this.nameVectorCache.set(name, vector);
            this._db().prepare(
                'INSERT OR REPLACE INTO kv_store (key, vector) VALUES (?, ?)'
            ).run(`diary_name:${name}`, encodeVectorBlob(vector));
            return vector;
        } catch (error) {
            console.error(
                `[${this.logPrefix}] Failed to vectorize diary name ${name}: ` +
                `${error.message || error}`
            );
            return null;
        }
    }
}

module.exports = DiaryMetadataCache;