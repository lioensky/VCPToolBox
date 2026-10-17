'use strict';

const { decodeVectorBlob, encodeVectorBlob } = require('./vectorCodec');

class DiaryMetadataCache {
    constructor(options = {}) {
        this.getNativeRuntime = options.getNativeRuntime;
        this.getDbPath = options.getDbPath;
        this.dimension = options.dimension;
        this.getEmbeddingsBatch = options.getEmbeddingsBatch;
        this.getEmbeddingConfig = options.getEmbeddingConfig;
        this.nameVectorCache = options.nameVectorCache || new Map();
        this.dateIndexCache = options.dateIndexCache || new Map();
        this.logPrefix = options.logPrefix || 'KnowledgeBase';
    }

    extractDateFromText(text) {
        if (!text || typeof text !== 'string') return null;
        const firstLine = text.split('\n')[0] || '';
        const match = firstLine.match(/^\[?(\d{4}[-.]\d{2}[-.]\d{2})\]?/);
        return match ? match[1].replace(/\./g, '-') : null;
    }

    async buildDateIndex(diaryName) {
        if (!diaryName) return [];

        const nativeRuntime = this.getNativeRuntime?.();
        const dbPath = this.getDbPath?.();
        if (
            !nativeRuntime
            || typeof nativeRuntime.getDiaryDateIndex !== 'function'
            || !dbPath
        ) {
            const error = new Error(
                'NativeKnowledgeRuntime diary date index ABI is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }

        try {
            const raw = await nativeRuntime.getDiaryDateIndex(dbPath, diaryName);
            const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return (Array.isArray(rows) ? rows : [])
                .filter(row => row && row.relativePath && row.date)
                .map(row => ({
                    relativePath: String(row.relativePath),
                    date: String(row.date)
                }))
                .sort((left, right) => new Date(right.date) - new Date(left.date));
        } catch (error) {
            console.warn(
                `[${this.logPrefix}] ⚠️ Failed to build diary date index for ` +
                `"${diaryName}": ${error.message}`
            );
            throw error;
        }
    }

    async ensureDateIndex(diaryName) {
        if (!diaryName) return [];
        if (this.dateIndexCache.has(diaryName)) {
            return this.dateIndexCache.get(diaryName);
        }
        const items = await this.buildDateIndex(diaryName);
        this.dateIndexCache.set(diaryName, items);
        if (items.length > 0) {
            console.log(
                `[${this.logPrefix}] 🗓️ Diary date index cached for ` +
                `"${diaryName}": ${items.length} file(s).`
            );
        }
        return items;
    }

    async getDateIndex(diaryName) {
        const items = await this.ensureDateIndex(diaryName);
        return items.map(item => ({ ...item }));
    }

    invalidateDateIndex(diaryName) {
        if (diaryName) this.dateIndexCache.delete(diaryName);
    }

    async getNameVector(diaryName) {
        if (!diaryName) return null;
        if (this.nameVectorCache.has(diaryName)) {
            return this.nameVectorCache.get(diaryName);
        }

        const nativeRuntime = this.getNativeRuntime?.();
        const dbPath = this.getDbPath?.();
        if (
            !nativeRuntime
            || typeof nativeRuntime.getKvVector !== 'function'
            || !dbPath
        ) {
            const error = new Error(
                'NativeKnowledgeRuntime KV vector ABI is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }

        try {
            const key = `diary_name:${diaryName}`;
            const raw = await nativeRuntime.getKvVector(dbPath, key);
            const encoded = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (typeof encoded === 'string' && encoded.length > 0) {
                const decoded = decodeVectorBlob(
                    Buffer.from(encoded, 'base64'),
                    this.dimension,
                    key
                );
                if (decoded) {
                    const vector = Array.from(decoded);
                    this.nameVectorCache.set(diaryName, vector);
                    return vector;
                }
            }
        } catch (error) {
            console.warn(
                `[${this.logPrefix}] Native KV lookup failed for diary name: ` +
                `${diaryName}: ${error.message || error}`
            );
        }

        console.warn(
            `[${this.logPrefix}] Cache MISS for diary name vector: ` +
            `"${diaryName}". Fetching now...`
        );
        return this.fetchAndCacheNameVector(diaryName);
    }

    async hydrateNameCache() {
        console.log(`[${this.logPrefix}] Hydrating diary name vectors through Rust...`);
        const nativeRuntime = this.getNativeRuntime?.();
        const dbPath = this.getDbPath?.();
        if (
            !nativeRuntime
            || typeof nativeRuntime.listKvVectors !== 'function'
            || !dbPath
        ) {
            const error = new Error(
                'NativeKnowledgeRuntime KV vector list ABI is unavailable'
            );
            error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
            throw error;
        }

        const raw = await nativeRuntime.listKvVectors(dbPath, 'diary_name:');
        const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
        let count = 0;
        for (const row of Array.isArray(rows) ? rows : []) {
            const name = String(row?.key || '').slice('diary_name:'.length);
            const encoded = row?.vector;
            if (!name || typeof encoded !== 'string' || !encoded) continue;
            const decoded = decodeVectorBlob(
                Buffer.from(encoded, 'base64'),
                this.dimension,
                `diary_name:${name}`
            );
            if (!decoded) continue;
            this.nameVectorCache.set(name, Array.from(decoded));
            count++;
        }
        console.log(`[${this.logPrefix}] Hydrated ${count} diary name vectors.`);
        return count;
    }

    async fetchAndCacheNameVector(name) {
        try {
            const nativeRuntime = this.getNativeRuntime?.();
            const dbPath = this.getDbPath?.();
            if (
                !nativeRuntime
                || typeof nativeRuntime.setKvVector !== 'function'
                || !dbPath
            ) {
                const error = new Error(
                    'NativeKnowledgeRuntime KV vector ABI is unavailable'
                );
                error.code = 'NATIVE_STORAGE_ABI_UNAVAILABLE';
                throw error;
            }

            const [vector] = await this.getEmbeddingsBatch(
                [name],
                this.getEmbeddingConfig()
            );
            if (!vector) return null;
            const normalized = vector instanceof Float32Array
                ? vector
                : new Float32Array(vector);
            if (normalized.length !== this.dimension) {
                throw new RangeError(
                    `Diary name vector dimension mismatch: expected ` +
                    `${this.dimension}, got ${normalized.length}`
                );
            }
            this.nameVectorCache.set(name, Array.from(normalized));
            await nativeRuntime.setKvVector(
                dbPath,
                `diary_name:${name}`,
                normalized
            );
            return Array.from(normalized);
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