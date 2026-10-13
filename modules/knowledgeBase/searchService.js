'use strict';

const path = require('path');
const { getEmbeddingsBatch } = require('../../EmbeddingUtils');

class SearchService {
    constructor(owner) {
        if (!owner) throw new TypeError('SearchService requires an owner');
        this.owner = owner;
    }

    // 保持历史位置参数契约；现代调用可把配置放在 K 后或第六/七参数。
    _parse(args) {
        const owner = this.owner;
        const scoped = typeof args[0] === 'string'
            || (Array.isArray(args[0]) && args[0].every(name => typeof name === 'string'));
        const vector = scoped ? args[1] : args[0];
        const k = scoped ? args[2] : args[1];
        const boost = scoped ? args[3] : args[2];
        const optionValues = scoped ? [args[3], args[5], args[6]] : [args[2], args[3]];
        const options = Object.assign({}, ...optionValues.filter(value =>
            value && typeof value === 'object' && !Array.isArray(value)
            && !ArrayBuffer.isView(value)));
        const names = scoped
            ? [...new Set((Array.isArray(args[0]) ? args[0] : [args[0]])
                .map(name => name.trim()).filter(Boolean))]
            : owner.db.prepare('SELECT DISTINCT diary_name FROM files').all()
                .map(row => row.diary_name).filter(Boolean);
        return {
            names,
            vector: owner._isVectorLike(vector)
                ? (vector instanceof Float32Array ? vector : new Float32Array(vector))
                : null,
            k: Math.max(1, Math.floor(Number(options.globalK ?? k) || 5)),
            coreTags: options.coreTags ?? (scoped ? args[4] : []) ?? [],
            coreBoostFactor: Number(scoped ? args[5] : undefined) || 1.33,
            boost: typeof boost === 'number' ? boost : undefined,
            options
        };
    }

    async search(...args) {
        const request = this._parse(args);
        if (!request.vector || request.names.length === 0) return [];
        const { options } = request;
        if (options.geodesicRerank || options.tagMemoVersion || options.tagmemoVersion
            || args.some(value => typeof value === 'string' && /^\d*\.?\d+\+$/.test(value))) {
            const error = new Error('TagMemo/DTSC 检索已退休，请使用 RiverMemo 或 searchKnn');
            error.code = 'TAGMEMO_RETRIEVAL_RETIRED';
            throw error;
        }
        const result = await this.owner.executeNativeRiverQuery(
            { text: String(options.queryText || ''), vector: request.vector },
            {
                ...options,
                diaryNames: request.names,
                topK: request.k,
                coreTags: request.coreTags,
                preparedMemoObservation: options.preparedMemoObservation
                    || options.preparedBoostResult?.preparedMemoObservation,
                sourceObservationConfig: {
                    ...(request.boost === undefined ? {} : { baseTagBoost: request.boost }),
                    coreBoostFactor: request.coreBoostFactor,
                    ...(options.sourceObservationConfig || {})
                }
            }
        );
        if (!Array.isArray(result?.results)) throw new Error('RiverMemo returned invalid search results');
        return result.results.slice(0, request.k);
    }

    async searchMany(diaryNames, vector, k = 5, options = {}) {
        return this.search(diaryNames, vector, k, options);
    }

    // 纯 ANN：不感应、不增强、不调用任何 Memo 读出或语义去重。
    async searchKnn(...args) {
        const { names, vector, k, options } = this._parse(args);
        if (!vector || names.length === 0) return [];
        const owner = this.owner;
        if (vector.length !== owner.config.dimension) {
            throw new RangeError(`KNN query dimension must be ${owner.config.dimension}, got ${vector.length}`);
        }
        const perIndexK = Math.max(k, Math.floor(Number(options.perIndexK) || k));
        const pools = await Promise.all(names.map(async name => {
            const index = await owner._getOrLoadDiaryIndex(name);
            if (!index || (index.stats && index.stats().totalVectors === 0)) return [];
            return index.search(vector, perIndexK);
        }));
        const byId = new Map();
        for (const item of pools.flat()) {
            const id = Number(item.id);
            if (!Number.isSafeInteger(id) || id <= 0) continue;
            if (!byId.has(id) || item.score > byId.get(id).score) byId.set(id, { ...item, id });
        }
        const ranked = [...byId.values()].sort((a, b) => b.score - a.score || a.id - b.id);
        const rows = owner._queryByChunks(`
            SELECT c.id, c.content AS text, f.path AS sourceFile,
                   f.diary_name AS diaryName, f.id AS fileId, f.updated_at
            FROM chunks c JOIN files f ON c.file_id = f.id WHERE c.id`,
        ranked.map(item => item.id));
        const rowsById = new Map(rows.map(row => [Number(row.id), row]));
        const scope = new Set(names);
        const allowed = Array.isArray(options.allowedFileIds) ? new Set(options.allowedFileIds.map(Number)) : null;
        const denied = new Set((options.deniedFileIds || []).map(Number));
        return ranked.map(item => {
            const row = rowsById.get(item.id);
            if (!row || !scope.has(row.diaryName) || denied.has(Number(row.fileId))
                || (allowed && !allowed.has(Number(row.fileId)))) return null;
            return {
                ...row,
                id: item.id,
                chunkId: item.id,
                score: Number(item.score) || 0,
                vectorScore: Number(item.score) || 0,
                sourceFile: path.basename(row.sourceFile),
                fullPath: row.sourceFile,
                matchedTags: [],
                coreTagsMatched: [],
                tagMatchCount: 0,
                boostFactor: 0,
                tagMatchScore: 0,
                retrievalEngine: 'knn'
            };
        }).filter(Boolean).slice(0, k);
    }

    async searchKnnMany(diaryNames, vector, k = 5, options = {}) {
        return this.searchKnn(diaryNames, vector, k, options);
    }

    async getChunksByFilePaths(filePaths) {
        if (!filePaths || filePaths.length === 0) return [];
        const owner = this.owner;
        const results = [];
        for (let i = 0; i < filePaths.length; i += 500) {
            const batch = filePaths.slice(i, i + 500);
            const rows = owner.db.prepare(`
                SELECT c.id, c.content AS text, c.vector, f.path AS sourceFile
                FROM chunks c JOIN files f ON c.file_id = f.id
                WHERE f.path IN (${batch.map(() => '?').join(',')})
            `).all(...batch);
            results.push(...rows.map(row => ({
                id: row.id,
                chunkId: row.id,
                text: row.text,
                vector: owner._decodeVectorBlob(row.vector, owner.config.dimension, `chunk:${row.id}`),
                sourceFile: row.sourceFile,
                fullPath: row.sourceFile
            })));
        }
        return results;
    }

    async searchSimilarTags(input, k = 10) {
        const owner = this.owner;
        let vector = input;
        if (typeof input === 'string') {
            const vectors = await getEmbeddingsBatch([input], {
                apiKey: owner.config.apiKey, apiUrl: owner.config.apiUrl, model: owner.config.model
            });
            vector = vectors[0];
        }
        if (!vector) return [];
        const results = owner.tagIndex.search(
            vector instanceof Float32Array ? vector : new Float32Array(vector), k);
        const hydrate = owner.db.prepare('SELECT name FROM tags WHERE id = ?');
        return results.map(item => {
            const row = hydrate.get(Number(item.id));
            return row ? { tag: row.name, score: item.score } : null;
        }).filter(Boolean);
    }
}

module.exports = SearchService;
