'use strict';

const path = require('path');
const { getEmbeddingsBatch } = require('../../EmbeddingUtils');

// 实现函数以 KnowledgeBaseManager 作为 this 执行，使状态所有权保持唯一；
// 本模块拥有摄取行为，Manager 仅保留兼容门面。
const implementations = {
async search(arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
        try {
            let diaryName = null;
            let diaryNames = null;
            let queryVec = null;
            let k = 5;
            let tagBoost = 0;
            let coreTags = [];
            let coreBoostFactor = 1.33; // 默认 33% 提升
            let options = null; // V9.1 扩展选项（geodesicRerank 等）

            // 必须先于 _isVectorLike 判断：字符串数组代表“虚拟联合索引”，不是查询向量。
            const isDiaryNameArray = Array.isArray(arg1) && arg1.every(name => typeof name === 'string');
            if ((typeof arg1 === 'string' || isDiaryNameArray) && this._isVectorLike(arg2)) {
                if (isDiaryNameArray) {
                    diaryNames = [...new Set(arg1.map(name => name.trim()).filter(Boolean))];
                } else {
                    diaryName = arg1;
                }
                queryVec = arg2;
                k = arg3 || 5;
                tagBoost = arg4 || 0;
                coreTags = arg5 || [];

                // 解析 tagBoost 增强语法（字符串 "0.6+" 表示启用 V9.1 势能场重排）
                if (typeof tagBoost === 'string' && tagBoost.endsWith('+')) {
                    tagBoost = parseFloat(tagBoost.slice(0, -1)) || 0;
                    if (!options) options = {};
                    options.geodesicRerank = true;
                } else {
                    tagBoost = parseFloat(tagBoost) || 0;
                }

                // arg6 可以是 coreBoostFactor (number) 或 options (object)
                if (typeof arg6 === 'object' && arg6 !== null && !Array.isArray(arg6)) {
                    options = { ...options, ...arg6 };
                } else {
                    coreBoostFactor = arg6 || 1.33;
                    options = (typeof arg7 === 'object' && arg7 !== null) ? { ...options, ...arg7 } : options;
                }
            } else if (typeof arg1 === 'string') {
                // 纯文本搜索暂略，通常插件会先向量化
                return [];
            } else if (this._isVectorLike(arg1)) {
                queryVec = arg1;
                k = arg2 || 5;
                tagBoost = arg3 || 0;

                // 全局搜索路径也解析 "0.6+" 语法
                if (typeof tagBoost === 'string' && tagBoost.endsWith('+')) {
                    tagBoost = parseFloat(tagBoost.slice(0, -1)) || 0;
                    if (!options) options = {};
                    options.geodesicRerank = true;
                } else {
                    tagBoost = parseFloat(tagBoost) || 0;
                }
            }

            if (!queryVec) return [];

            if (diaryNames) {
                if (diaryNames.length === 0) return [];
                if (diaryNames.length === 1) {
                    return await this._searchSpecificIndex(diaryNames[0], queryVec, k, tagBoost, coreTags, coreBoostFactor, options);
                }
                return await this._searchSelectedIndices(diaryNames, queryVec, k, tagBoost, coreTags, coreBoostFactor, options);
            }
            if (diaryName) {
                return await this._searchSpecificIndex(diaryName, queryVec, k, tagBoost, coreTags, coreBoostFactor, options);
            }
            return await this._searchAllIndices(queryVec, k, tagBoost, coreTags, coreBoostFactor, options);
        } catch (e) {
            console.error('[KnowledgeBase] Search Error:', e);
            return [];
        }
    },

_resolveTagMemoRequest(options = null) {
        if (!this.tagMemoEngine) return null;
        const requestedVersion = options?.tagMemoVersion ?? options?.tagmemoVersion ?? null;
        return this.tagMemoEngine.resolveArtifactBundle({
            // null 表示当前唯一生产版本；显式旧版本由引擎返回 TAGMEMO_VERSION_RETIRED。
            version: requestedVersion,
            strictVersion: true
        });
    },

_resolveGeodesicCandidateK(k, options = null) {
        const requestedK = Math.max(1, Math.round(Number(k) || 1));
        if (!options?.geodesicRerank) {
            return { requestedK, candidateK: requestedK, multiplier: 1 };
        }

        const geoConfig = this.ragParams?.KnowledgeBaseManager?.geodesicRerank || {};
        const rawMultiplier = options.geoCandidateMultiplier
            ?? options.candidateMultiplier
            ?? geoConfig.candidateKMultiplier
            ?? 2;
        const multiplier = Math.max(1, Math.min(10, Number(rawMultiplier) || 2));
        return {
            requestedK,
            candidateK: Math.max(requestedK, Math.ceil(requestedK * multiplier)),
            multiplier
        };
    },

async _searchSpecificIndex(diaryName, vector, k, tagBoost, coreTags = [], coreBoostFactor = 1.33, options = null) {
        const idx = await this._getOrLoadDiaryIndex(diaryName);

        // 如果索引为空，直接返回
        // 注意：vexus-lite-js 可能没有 size() 方法，用 catch 捕获
        try {
            const stats = idx.stats ? idx.stats() : { totalVectors: 1 };
            if (stats.totalVectors === 0) return [];
        } catch (e) { }

        // 🛠️ 修复 1: 安全的 Float32Array 转换
        let searchVecFloat;
        let tagInfo = null;
        let preparedMemoObservation = null;

        try {
            if (tagBoost > 0 && this.tagMemoEngine) {
                const preparedBoostResult =
                    options?.preparedBoostResult
                    || options?.boostResult
                    || null;
                if (preparedBoostResult?.vector) {
                    // 调用方可继续传入旧 BoostResult；若它携带统一原生观测，
                    // 后续 DTSC 将直接复用，不会执行第二次 Spike 感应。
                    searchVecFloat = preparedBoostResult.vector instanceof Float32Array
                        ? preparedBoostResult.vector
                        : new Float32Array(preparedBoostResult.vector);
                    tagInfo = preparedBoostResult.info || null;
                    preparedMemoObservation =
                        preparedBoostResult.preparedMemoObservation || null;
                } else {
                    const boostResult = await this.applyTagBoostAsync(
                        new Float32Array(vector),
                        tagBoost,
                        coreTags,
                        coreBoostFactor,
                        {
                            ...options,
                            queryText: options?.queryText || ''
                        }
                    );
                    searchVecFloat = boostResult.vector;
                    tagInfo = boostResult.info;
                    preparedMemoObservation =
                        boostResult.preparedMemoObservation || null;
                }
            } else {
                searchVecFloat = vector instanceof Float32Array ? vector : new Float32Array(vector);
            }

            // ⚠️ 维度检查
            if (searchVecFloat.length !== this.config.dimension) {
                console.error(`[KnowledgeBase] Dimension mismatch! Expected ${this.config.dimension}, got ${searchVecFloat.length}`);
                return [];
            }
        } catch (err) {
            console.error(`[KnowledgeBase] Vector processing failed: ${err.message}`);
            return [];
        }

        const geoCandidatePlan = this._resolveGeodesicCandidateK(k, options);
        let results = [];
        try {
            results = idx.search(searchVecFloat, geoCandidatePlan.candidateK);
        } catch (e) {
            // 🛠️ 修复 2: 详细的错误日志
            console.error(`[KnowledgeBase] Vexus search failed for "${diaryName}":`, e.message || e);
            return [];
        }

        // DTSC 在统一 Rust MemoRuntime 上消费与增强阶段相同的 QueryObservation。
        // 不再把 JS energyField/Map 作为生产计算输入；这些字段仅保留旧返回兼容。
        if (options?.geodesicRerank) {
            const geoConfig =
                this.ragParams?.KnowledgeBaseManager?.geodesicRerank || {};
            const reranked = await this.rerankWithTagMemoAsync(
                {
                    text: String(options?.queryText || ''),
                    vector: vector instanceof Float32Array
                        ? vector
                        : new Float32Array(vector)
                },
                results,
                { diaryNames: [diaryName] },
                {
                    ...options,
                    topK: geoCandidatePlan.candidateK,
                    ...(preparedMemoObservation
                        ? { preparedMemoObservation }
                        : {}),
                    config: geoConfig
                }
            );
            results = Array.isArray(reranked?.results)
                ? reranked.results
                : results;
        }
        // 候选池可放大，但公共 search 契约仍只返回调用方请求的 K。
        results = results.slice(0, geoCandidatePlan.requestedK);
        if (geoCandidatePlan.multiplier > 1) {
            console.log(
                `[KnowledgeBase] 🌊 Geodesic candidate expansion: diary="${diaryName}", ` +
                `requestedK=${geoCandidatePlan.requestedK}, candidateK=${geoCandidatePlan.candidateK}, ` +
                `multiplier=${geoCandidatePlan.multiplier}.`
            );
        }

        // Hydrate results（批量回填，避免每个候选一次同步 SQLite 往返）
        const resultChunkIds = results.map(res => Number(res.id)).filter(Number.isFinite);
        const rows = this._queryByChunks(`
            SELECT c.id, c.content as text, f.path as sourceFile, f.updated_at, f.id as file_id
            FROM chunks c
            JOIN files f ON c.file_id = f.id
            WHERE c.id`, resultChunkIds);
        const rowByChunkId = new Map(rows.map(row => [row.id, row]));

        // 🛠️ V8.1 修复：per-chunk 标签关联（替代全局 tagInfo 覆盖）
        const hydratedResults = [];
        const fileIdsForTagLookup = new Map(); // chunkId → file_id

        for (const res of results) {
            const chunkId = Number(res.id);
            const row = rowByChunkId.get(chunkId);
            if (!row) {
                console.warn(`[KnowledgeBase] 👻 Ghost Index detected for ID ${chunkId} in "${diaryName}". Cleaning up...`);
                if (idx.remove) idx.remove(res.id);
                continue;
            }
            fileIdsForTagLookup.set(chunkId, row.file_id);
            hydratedResults.push({
                chunkId,
                _fileId: row.file_id,
                text: row.text,
                score: res.score,
                original_knn_score: res.original_knn_score,
                geo_score: res.geo_score,
                normalized_geo: res.normalized_geo,
                geo_bonus: res.geo_bonus,
                geo_base_bonus: res.geo_base_bonus,
                geo_aux_bonus: res.geo_aux_bonus,
                geo_aux_target_floor: res.geo_aux_target_floor,
                geo_aux_geometry_floor: res.geo_aux_geometry_floor,
                geo_aux_identity_floor: res.geo_aux_identity_floor,
                geo_aux_enabled: res.geo_aux_enabled,
                geo_aux_eligible: res.geo_aux_eligible,
                geo_aux_reliability: res.geo_aux_reliability,
                geo_aux_reason: res.geo_aux_reason,
                geo_identity_anchor_eligible: res.geo_identity_anchor_eligible,
                geo_identity_anchor_strength: res.geo_identity_anchor_strength,
                geo_identity_anchor_reliability: res.geo_identity_anchor_reliability,
                geo_direct_exact_max_potential: res.geo_direct_exact_max_potential,
                geo_direct_exact_best_specificity: res.geo_direct_exact_best_specificity,
                geo_direct_exact_best_closure: res.geo_direct_exact_best_closure,
                geo_bonus_cap: res.geo_bonus_cap,
                geo_effect: res.geo_effect,
                geo_evidence_class: res.geo_evidence_class,
                geo_evidence_reason: res.geo_evidence_reason,
                geo_reward_eligible: res.geo_reward_eligible,
                geo_hit_count: res.geo_hit_count,
                geo_confidence: res.geo_confidence,
                geo_curve_samples: res.geo_curve_samples,
                geo_exact_hits: res.geo_exact_hits,
                geo_direct_exact_hits: res.geo_direct_exact_hits,
                geo_emergent_exact_hits: res.geo_emergent_exact_hits,
                geo_direct_semantic_hits: res.geo_direct_semantic_hits,
                geo_direct_semantic_strength: res.geo_direct_semantic_strength,
                geo_reward_strength: res.geo_reward_strength,
                geo_reward_confidence: res.geo_reward_confidence,
                geo_strong_hits: res.geo_strong_hits,
                geo_weighted_coverage: res.geo_weighted_coverage,
                geo_mean_potential: res.geo_mean_potential,
                geo_max_potential: res.geo_max_potential,
                geo_continuity: res.geo_continuity,
                geo_isolated_ratio: res.geo_isolated_ratio,
                geo_raw_isolated_ratio: res.geo_raw_isolated_ratio,
                geo_sparse_association_confidence: res.geo_sparse_association_confidence,
                geo_sparse_association_pairs: res.geo_sparse_association_pairs,
                geo_sparse_association_connected_nodes: res.geo_sparse_association_connected_nodes,
                geo_action_quality: res.geo_action_quality,
                geo_closure_quality: res.geo_closure_quality,
                geo_contact_tags: res.geo_contact_tags,
                geo_guard_reason: res.geo_guard_reason,
                geo_geometry_shadow: res.geo_geometry_shadow,
                geo_direct_score: res.geo_direct_score,
                geo_structural_score: res.geo_structural_score,
                geo_thematic_score: res.geo_thematic_score,
                geo_closure_score: res.geo_closure_score,
                geo_fused_shadow_score: res.geo_fused_shadow_score,
                geo_direction_consistency: res.geo_direction_consistency,
                geo_vector_lift: res.geo_vector_lift,
                sourceFile: path.basename(row.sourceFile),
                fullPath: row.sourceFile,
                // 🌟 V8.1: 查询级元数据保持不变
                boostFactor: tagInfo ? tagInfo.boostFactor : 0,
                tagMatchScore: tagInfo ? tagInfo.totalSpikeScore : 0,
            });
        }

        // 🌟 V8.1: 批量查询 per-chunk 真实标签
        if (hydratedResults.length > 0 && tagInfo) {
            const uniqueFileIds = [...new Set(hydratedResults.map(r => r._fileId))];
            if (uniqueFileIds.length > 0) {
                const fileTagRows = this._queryByChunks(
                    'SELECT ft.file_id, t.name FROM file_tags ft JOIN tags t ON ft.tag_id = t.id WHERE ft.file_id',
                    uniqueFileIds
                );

                // 构建 file_id → [tagName, ...] 映射
                const fileTagNameMap = new Map();
                for (const row of fileTagRows) {
                    if (!fileTagNameMap.has(row.file_id)) fileTagNameMap.set(row.file_id, []);
                    fileTagNameMap.get(row.file_id).push(row.name);
                }

                // 将查询级 coreTags 转为 Set（用于交叉匹配）
                const queryCoreTags = new Set((tagInfo.coreTagsMatched || []).map(t => t.toLowerCase()));
                const queryAllTags = new Set((tagInfo.matchedTags || []).map(t => t.toLowerCase()));

                for (const r of hydratedResults) {
                    const chunkRealTags = fileTagNameMap.get(r._fileId) || [];
                    // 🌟 V8.1: per-chunk matchedTags = 该 chunk 文件的全部真实标签
                    r.matchedTags = chunkRealTags;
                    r.tagMatchCount = chunkRealTags.length;
                    // per-chunk coreTagsMatched = 该 chunk 的标签 ∩ 查询的核心标签
                    r.coreTagsMatched = chunkRealTags.filter(t => queryCoreTags.has(t.toLowerCase()));
                }
            }
        } else {
            // 无 TagMemo 模式：标签字段为空
            for (const r of hydratedResults) {
                r.matchedTags = [];
                r.tagMatchCount = 0;
                r.coreTagsMatched = [];
            }
        }

        // 清理内部字段；保留公开 chunkId，供 Associate 等后续管线直接回取向量，避免 content 精确回查。
        for (const r of hydratedResults) {
            delete r._fileId;
        }

        return hydratedResults;
    },

async _searchAllIndices(vector, k, tagBoost, coreTags = [], coreBoostFactor = 1.33, options = null) {
        const diaryNames = this.db.prepare('SELECT DISTINCT diary_name FROM files').all()
            .map(row => row.diary_name)
            .filter(Boolean);
        return await this._searchSelectedIndices(
            diaryNames, vector, k, tagBoost, coreTags, coreBoostFactor, options
        );
    },

async _searchSelectedIndices(diaryNames, vector, k, tagBoost, coreTags = [], coreBoostFactor = 1.33, options = null) {
        const selectedDiaries = [...new Set(
            (Array.isArray(diaryNames) ? diaryNames : [])
                .map(name => String(name || '').trim())
                .filter(Boolean)
        )];
        if (selectedDiaries.length === 0) return [];

        let searchVecFloat;
        let tagInfo = null;
        let preparedMemoObservation = null;

        if (tagBoost > 0 && this.tagMemoEngine) {
            const preparedBoostResult =
                options?.preparedBoostResult
                || options?.boostResult
                || null;
            if (preparedBoostResult?.vector) {
                searchVecFloat = preparedBoostResult.vector instanceof Float32Array
                    ? preparedBoostResult.vector
                    : new Float32Array(preparedBoostResult.vector);
                tagInfo = preparedBoostResult.info || null;
                preparedMemoObservation =
                    preparedBoostResult.preparedMemoObservation || null;
            } else {
                const boostResult = await this.applyTagBoostAsync(
                    new Float32Array(vector),
                    tagBoost,
                    coreTags,
                    coreBoostFactor,
                    {
                        ...options,
                        queryText: options?.queryText || ''
                    }
                );
                searchVecFloat = boostResult.vector;
                tagInfo = boostResult.info;
                preparedMemoObservation =
                    boostResult.preparedMemoObservation || null;
            }
        } else {
            searchVecFloat = vector instanceof Float32Array ? vector : new Float32Array(vector);
        }

        if (searchVecFloat.length !== this.config.dimension) {
            console.error(`[KnowledgeBase] Dimension mismatch! Expected ${this.config.dimension}, got ${searchVecFloat.length}`);
            return [];
        }

        const geoCandidatePlan = this._resolveGeodesicCandidateK(
            options?.globalK ?? k,
            options
        );
        const perIndexK = Math.max(
            geoCandidatePlan.candidateK,
            Math.max(1, Math.round(Number(options?.perIndexK) || 0))
        );
        const globalK = geoCandidatePlan.requestedK;

        const searchPromises = selectedDiaries.map(async diaryName => {
            try {
                const idx = await this._getOrLoadDiaryIndex(diaryName);
                const stats = idx.stats ? idx.stats() : { totalVectors: 1 };
                if (stats.totalVectors === 0) return [];
                return idx.search(searchVecFloat, perIndexK);
            } catch (e) {
                console.error(`[KnowledgeBase] Vexus search error in selected-index search (${diaryName}):`, e);
                return [];
            }
        });

        const resultsPerIndex = await Promise.all(searchPromises);
        let allResults = resultsPerIndex.flat();
        allResults.sort((a, b) => (b.score || 0) - (a.score || 0));

        // 测地读出只在物理索引结果合并后执行一次，并复用增强阶段的
        // 原生 QueryObservation，确保所有成员共享同一图代际和排序口径。
        if (options?.geodesicRerank) {
            const geoConfig =
                this.ragParams?.KnowledgeBaseManager?.geodesicRerank || {};
            const reranked = await this.rerankWithTagMemoAsync(
                {
                    text: String(options?.queryText || ''),
                    vector: vector instanceof Float32Array
                        ? vector
                        : new Float32Array(vector)
                },
                allResults,
                { diaryNames: selectedDiaries },
                {
                    ...options,
                    topK: allResults.length,
                    ...(preparedMemoObservation
                        ? { preparedMemoObservation }
                        : {}),
                    config: geoConfig
                }
            );
            allResults = Array.isArray(reranked?.results)
                ? reranked.results
                : allResults;
        }

        const topK = allResults.slice(0, globalK);
        const topChunkIds = topK.map(res => Number(res.id)).filter(Number.isFinite);
        const rows = this._queryByChunks(`
            SELECT c.id, c.content as text, f.path as sourceFile, f.diary_name, f.id as file_id
            FROM chunks c JOIN files f ON c.file_id = f.id WHERE c.id`, topChunkIds);
        const rowByChunkId = new Map(rows.map(row => [row.id, row]));

        const hydratedResults = [];
        for (const res of topK) {
            const chunkId = Number(res.id);
            const row = rowByChunkId.get(chunkId);
            if (!row) continue;
            hydratedResults.push({
                chunkId,
                _fileId: row.file_id,
                diaryName: row.diary_name,
                text: row.text,
                score: res.score,
                original_knn_score: res.original_knn_score,
                geo_score: res.geo_score,
                normalized_geo: res.normalized_geo,
                geo_bonus: res.geo_bonus,
                geo_base_bonus: res.geo_base_bonus,
                geo_aux_bonus: res.geo_aux_bonus,
                geo_aux_target_floor: res.geo_aux_target_floor,
                geo_aux_geometry_floor: res.geo_aux_geometry_floor,
                geo_aux_identity_floor: res.geo_aux_identity_floor,
                geo_aux_enabled: res.geo_aux_enabled,
                geo_aux_eligible: res.geo_aux_eligible,
                geo_aux_reliability: res.geo_aux_reliability,
                geo_aux_reason: res.geo_aux_reason,
                geo_identity_anchor_eligible: res.geo_identity_anchor_eligible,
                geo_identity_anchor_strength: res.geo_identity_anchor_strength,
                geo_identity_anchor_reliability: res.geo_identity_anchor_reliability,
                geo_direct_exact_max_potential: res.geo_direct_exact_max_potential,
                geo_direct_exact_best_specificity: res.geo_direct_exact_best_specificity,
                geo_direct_exact_best_closure: res.geo_direct_exact_best_closure,
                geo_bonus_cap: res.geo_bonus_cap,
                geo_effect: res.geo_effect,
                geo_evidence_class: res.geo_evidence_class,
                geo_evidence_reason: res.geo_evidence_reason,
                geo_reward_eligible: res.geo_reward_eligible,
                geo_hit_count: res.geo_hit_count,
                geo_confidence: res.geo_confidence,
                geo_curve_samples: res.geo_curve_samples,
                geo_exact_hits: res.geo_exact_hits,
                geo_direct_exact_hits: res.geo_direct_exact_hits,
                geo_emergent_exact_hits: res.geo_emergent_exact_hits,
                geo_direct_semantic_hits: res.geo_direct_semantic_hits,
                geo_direct_semantic_strength: res.geo_direct_semantic_strength,
                geo_reward_strength: res.geo_reward_strength,
                geo_reward_confidence: res.geo_reward_confidence,
                geo_strong_hits: res.geo_strong_hits,
                geo_weighted_coverage: res.geo_weighted_coverage,
                geo_mean_potential: res.geo_mean_potential,
                geo_max_potential: res.geo_max_potential,
                geo_continuity: res.geo_continuity,
                geo_isolated_ratio: res.geo_isolated_ratio,
                geo_raw_isolated_ratio: res.geo_raw_isolated_ratio,
                geo_sparse_association_confidence: res.geo_sparse_association_confidence,
                geo_sparse_association_pairs: res.geo_sparse_association_pairs,
                geo_sparse_association_connected_nodes: res.geo_sparse_association_connected_nodes,
                geo_action_quality: res.geo_action_quality,
                geo_closure_quality: res.geo_closure_quality,
                geo_contact_tags: res.geo_contact_tags,
                geo_guard_reason: res.geo_guard_reason,
                geo_geometry_shadow: res.geo_geometry_shadow,
                geo_direct_score: res.geo_direct_score,
                geo_structural_score: res.geo_structural_score,
                geo_thematic_score: res.geo_thematic_score,
                geo_closure_score: res.geo_closure_score,
                geo_fused_shadow_score: res.geo_fused_shadow_score,
                geo_direction_consistency: res.geo_direction_consistency,
                geo_vector_lift: res.geo_vector_lift,
                sourceFile: path.basename(row.sourceFile),
                fullPath: row.sourceFile,
                boostFactor: tagInfo ? tagInfo.boostFactor : 0,
                tagMatchScore: tagInfo ? tagInfo.totalSpikeScore : 0
            });
        }

        if (hydratedResults.length > 0 && tagInfo) {
            const uniqueFileIds = [...new Set(hydratedResults.map(r => r._fileId))];
            const fileTagRows = uniqueFileIds.length > 0
                ? this._queryByChunks(
                    'SELECT ft.file_id, t.name FROM file_tags ft JOIN tags t ON ft.tag_id = t.id WHERE ft.file_id',
                    uniqueFileIds
                )
                : [];
            const fileTagNameMap = new Map();
            for (const row of fileTagRows) {
                if (!fileTagNameMap.has(row.file_id)) fileTagNameMap.set(row.file_id, []);
                fileTagNameMap.get(row.file_id).push(row.name);
            }

            const queryCoreTags = new Set((tagInfo.coreTagsMatched || []).map(t => t.toLowerCase()));
            for (const result of hydratedResults) {
                const chunkRealTags = fileTagNameMap.get(result._fileId) || [];
                result.matchedTags = chunkRealTags;
                result.tagMatchCount = chunkRealTags.length;
                result.coreTagsMatched = chunkRealTags.filter(tag => queryCoreTags.has(tag.toLowerCase()));
            }
        } else {
            for (const result of hydratedResults) {
                result.matchedTags = [];
                result.tagMatchCount = 0;
                result.coreTagsMatched = [];
            }
        }

        for (const result of hydratedResults) delete result._fileId;
        console.log(
            `[KnowledgeBase] 🔗 Virtual index search: ${selectedDiaries.length} indices, ` +
            `perIndexK=${perIndexK}, globalK=${globalK}, geoMultiplier=${geoCandidatePlan.multiplier}, ` +
            `candidates=${allResults.length}, returned=${hydratedResults.length}`
        );
        return hydratedResults;
    },

async getChunksByFilePaths(filePaths) {
        if (!filePaths || filePaths.length === 0) return [];

        // 考虑到 SQLite 参数限制（通常为 999），如果路径过多需要分批
        const batchSize = 500;
        let allResults = [];

        for (let i = 0; i < filePaths.length; i += batchSize) {
            const batch = filePaths.slice(i, i + batchSize);
            const placeholders = batch.map(() => '?').join(',');
            const stmt = this.db.prepare(`
                SELECT c.id, c.content as text, c.vector, f.path as sourceFile
                FROM chunks c
                JOIN files f ON c.file_id = f.id
                WHERE f.path IN (${placeholders})
            `);

            const rows = stmt.all(...batch);
            const processed = rows.map(r => ({
                id: r.id,
                chunkId: r.id,
                text: r.text,
                vector: this._decodeVectorBlob(r.vector, this.config.dimension, `chunk:${r.id}`),
                sourceFile: r.sourceFile,
                fullPath: r.sourceFile
            }));
            allResults.push(...processed);
        }

        return allResults;
    },

async searchSimilarTags(input, k = 10) {
        // 兼容旧接口
        let queryVec;
        if (typeof input === 'string') {
            try {
                const [vec] = await getEmbeddingsBatch([input], {
                    apiKey: this.config.apiKey, apiUrl: this.config.apiUrl, model: this.config.model
                });
                queryVec = vec;
            } catch (e) { return []; }
        } else {
            queryVec = input;
        }

        if (!queryVec) return [];

        try {
            const searchVecFloat = queryVec instanceof Float32Array ? queryVec : new Float32Array(queryVec);
            const results = this.tagIndex.search(searchVecFloat, k);

            // 需要 hydrate tag 名称
            const hydrate = this.db.prepare("SELECT name FROM tags WHERE id = ?");
            return results.map(r => {
                const tagId = Number(r.id);
                const row = hydrate.get(tagId);
                return row ? { tag: row.name, score: r.score } : null;
            }).filter(Boolean);
        } catch (e) {
            return [];
        }
    }
};

class SearchService {
    constructor(owner) {
        if (!owner) {
            throw new TypeError('SearchService requires an owner');
        }
        this.owner = owner;
    }

    async search(...args) {
        return await implementations.search.apply(
            this.owner,
            args
        );
    }

    _resolveTagMemoRequest(...args) {
        return implementations._resolveTagMemoRequest.apply(
            this.owner,
            args
        );
    }

    _resolveGeodesicCandidateK(...args) {
        return implementations._resolveGeodesicCandidateK.apply(
            this.owner,
            args
        );
    }

    async _searchSpecificIndex(...args) {
        return await implementations._searchSpecificIndex.apply(
            this.owner,
            args
        );
    }

    async _searchAllIndices(...args) {
        return await implementations._searchAllIndices.apply(
            this.owner,
            args
        );
    }

    async _searchSelectedIndices(...args) {
        return await implementations._searchSelectedIndices.apply(
            this.owner,
            args
        );
    }

    async getChunksByFilePaths(...args) {
        return await implementations.getChunksByFilePaths.apply(
            this.owner,
            args
        );
    }

    async searchSimilarTags(...args) {
        return await implementations.searchSimilarTags.apply(
            this.owner,
            args
        );
    }
}

module.exports = SearchService;
