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
            : [];
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
        if (request.names.length === 0) {
            request.names = await this.owner.listDistinctDiaries();
        }
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
        const request = this._parse(args);
        const owner = this.owner;
        const names = request.names.length > 0
            ? request.names
            : await owner.listDistinctDiaries();
        const { vector, k, options } = request;
        if (!vector || names.length === 0) return [];
        if (vector.length !== owner.config.dimension) {
            throw new RangeError(`KNN query dimension must be ${owner.config.dimension}, got ${vector.length}`);
        }
        let perIndexK = Math.max(k, Math.floor(Number(options.perIndexK) || k));
        await Promise.all(names.map(name => owner._getOrLoadDiaryIndex(name)));
        const runtime = owner.nativeKnowledgeRuntime;
        if (typeof runtime?.searchDiaryIndices !== 'function') {
            throw new Error('NativeKnowledgeRuntime ANN ABI unavailable');
        }
        const allowed = Array.isArray(options.allowedFileIds) ? new Set(options.allowedFileIds.map(Number)) : null;
        const denied = new Set((options.deniedFileIds || []).map(Number));
        if (allowed?.size === 0) return [];
        let parsed;
        // 权限过滤必须有补召回机会；每轮重新消费同一原生查询内的冻结 hydrate。
        // 设置有限预算，防止极窄权限集合触发无界扫描。
        const maxFetchK = Math.max(perIndexK, Math.min(10000, Number(options.maxFilterCandidates) || 4096));
        for (;;) {
            const raw = await runtime.searchDiaryIndices(
                names, vector, perIndexK, perIndexK * names.length
            );
            parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!Array.isArray(parsed?.hydratedChunks)) {
                throw new Error('Native ANN hydration ABI unavailable; rebuild rust-vexus-lite');
            }
            const visible = parsed.hydratedChunks.filter(row =>
                names.includes(row.diaryName) && !denied.has(Number(row.fileId))
                && (!allowed || allowed.has(Number(row.fileId))));
            const exhausted = Array.isArray(parsed?.diagnostics?.indices)
                ? parsed.diagnostics.indices.every(item => Number(item.candidates) < perIndexK)
                : (parsed.results || []).length < perIndexK;
            if ((!allowed && denied.size === 0) || visible.length >= k
                || exhausted || perIndexK >= maxFetchK) break;
            perIndexK = Math.min(maxFetchK, perIndexK * 2);
        }
        const pools = [Array.isArray(parsed?.results) ? parsed.results : []];
        const byId = new Map();
        for (const item of pools.flat()) {
            const id = Number(item.id);
            if (!Number.isSafeInteger(id) || id <= 0) continue;
            if (!byId.has(id) || item.score > byId.get(id).score) byId.set(id, { ...item, id });
        }
        const ranked = [...byId.values()].sort((a, b) => b.score - a.score || a.id - b.id);
        if (!Array.isArray(parsed?.hydratedChunks)) {
            throw new Error('Native ANN hydration ABI unavailable; rebuild rust-vexus-lite');
        }
        const rows = parsed.hydratedChunks;
        const rowsById = new Map(rows.map(row => [Number(row.id), row]));
        const scope = new Set(names);
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
        const rows = await this.owner.hydrateChunksByFilePaths(filePaths);
        return rows.map(row => ({
            id: row.id,
            chunkId: row.chunkId,
            text: row.text,
            vector: row.vector,
            sourceFile: row.sourceFile,
            fullPath: row.sourceFile,
            diaryName: row.diaryName,
            fileId: row.fileId
        }));
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

        const limit = Math.min(1000, Math.max(1, Math.floor(Number(k) || 10)));
        const runtime = owner.nativeKnowledgeRuntime;
        if (typeof runtime?.searchGlobalTags !== 'function') {
            throw new Error('Native global Tag search ABI unavailable; rebuild rust-vexus-lite');
        }
        const raw = await runtime.searchGlobalTags(
            vector instanceof Float32Array ? vector : new Float32Array(vector),
            limit
        );
        const results = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(results)) throw new Error('Invalid native global Tag search result');
        return results;
    }
}

module.exports = SearchService;
