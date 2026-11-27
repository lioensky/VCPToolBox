'use strict';

const path = require('path');
const FoldingStore = require('./FoldingStore.js');
const { projectContextEmbeddingInput } = require('../../modules/contextEmbeddingInput');
const { findLastRealUserMessage } = require('../../modules/messageProcessor.js');

function createContextBridge(self) {
    const BRIDGE_VERSION = '1.4';

    return Object.freeze({
        /** 接口版本号，用于未来兼容性检查 */
        version: BRIDGE_VERSION,

        // ═══════════════════════════════════════════════════
        // 上下文向量查询
        // ═══════════════════════════════════════════════════

        /**
         * 获取当前会话的衰减聚合上下文向量
         * 近期楼层权重更高，远期楼层指数衰减
         * @param {string} [role='assistant'] - 'assistant' 或 'user'
         * @returns {Float32Array|null} 聚合后的向量，无数据时返回 null
         */
        getAggregatedVector(role = 'assistant') {
            return self.contextVectorManager.aggregateContext(role);
        },

        /**
         * 获取所有历史 AI 输出的向量列表（按时间顺序）
         * @returns {Array<Float32Array>} 向量数组，可能为空
         */
        getHistoryAssistantVectors() {
            return self.contextVectorManager.getHistoryAssistantVectors();
        },

        /**
         * 获取所有历史用户输入的向量列表（按时间顺序）
         * @returns {Array<Float32Array>} 向量数组，可能为空
         */
        getHistoryUserVectors() {
            return self.contextVectorManager.getHistoryUserVectors();
        },

        /**
         * 获取语义分段后的主题向量列表
         * 将连续的、高相似度的消息归并为一个段落 (Segment/Topic)
         * @param {Array} messages - 消息列表
         * @param {number} [similarityThreshold=0.70] - 分段阈值
         * @returns {Array<{vector: Float32Array, text: string, roles: string[], range: [number, number], count: number}>}
         */
        getContextSegments(messages, similarityThreshold) {
            if (!Array.isArray(messages)) return [];
            return self.contextVectorManager.segmentContext(messages, similarityThreshold);
        },

        // ═══════════════════════════════════════════════════
        // EPA 指标计算
        // ═══════════════════════════════════════════════════

        /**
         * 计算向量的逻辑深度指数 L
         * L ≈ 1 → 能量集中在少数维度，逻辑聚焦
         * L ≈ 0 → 能量分散，逻辑模糊
         * @param {Array|Float32Array} vector - 输入向量
         * @returns {number} L ∈ [0, 1]
         */
        computeLogicDepth(vector) {
            if (!vector) return 0;
            return self.contextVectorManager.computeLogicDepth(vector);
        },

        /**
         * 计算向量的语义宽度指数 S
         * S ≈ 1 → 能量均匀分布，语义宽泛
         * S ≈ 0 → 能量集中少数维度，语义精准
         * @param {Array|Float32Array} vector - L2归一化向量
         * @returns {number} S ∈ [0, 1]
         */
        computeSemanticWidth(vector) {
            if (!vector) return 0;
            return self.contextVectorManager.computeSemanticWidth(vector);
        },

        // ═══════════════════════════════════════════════════
        // 向量化工具
        // ═══════════════════════════════════════════════════

        /**
         * 带缓存的单文本向量化（缓存未命中时会触发 Embedding API）
         * @param {string} text - 要向量化的文本
         * @returns {Promise<Array<number>|null>} 向量数组或 null
         */
        async embedText(text, options) {
            return self.getSingleEmbeddingCached(text, options);
        },

        /**
         * 带缓存的批量向量化（缓存未命中时会触发 Embedding API）
         * @param {string[]} texts - 要向量化的文本数组
         * @returns {Promise<Array<Array<number>|null>>} 向量数组，失败位置为 null
         */
        async embedBatch(texts) {
            if (!Array.isArray(texts) || texts.length === 0) return [];
            return self.getBatchEmbeddingsCached(texts);
        },

        /**
         * 仅从内存缓存获取向量（不触发 API，适合高频调用场景）
         * @param {string} text - 要查询的文本
         * @returns {Array<number>|null} 缓存中的向量或 null
         */
        getEmbeddingFromCache(text, contextRole) {
            return self._getEmbeddingFromCacheOnly(text, contextRole);
        },

        /**
         * 从 RAGDiaryPlugin 的 embedding 文本索引中按高阈值模糊匹配缓存向量（不触发 API）。
         * 主要供 ContextFoldingV2 在 RAG 主链路之后复用近似相同的最新 AI 向量。
         * @param {string} text - 要查询的文本
         * @param {object} [options] - { threshold, minLength, maxScan, maxLengthDiffRatio, maxLengthDiffAbs }
         * @returns {{vector:Array<number>, similarity:number, textPreview:string, length:number}|null}
         */
        getFuzzyEmbeddingFromCache(text, options = {}) {
            if (!text || typeof text !== 'string') return null;
            return self._findFuzzyEmbeddingFromCache(projectContextEmbeddingInput(text, options?.contextRole), options);
        },

        /**
         * 在指定 dailynote 索引中执行只读向量检索。
         * 供需要复用现有知识库向量、且不得重复向量化文档的插件使用。
         * @param {string|string[]} diaryNames - 日记本/索引名称
         * @param {Array|Float32Array} queryVector - 已生成的查询向量
         * @param {number} [k=10] - 最大 chunk 数
         * @returns {Promise<Array>} KnowledgeBaseManager 搜索结果
         */
        async searchDiary(diaryNames, queryVector, k = 10) {
            if (!queryVector || !self.vectorDBManager || typeof self.vectorDBManager.searchKnn !== 'function') {
                return [];
            }
            const names = Array.isArray(diaryNames)
                ? diaryNames.map(name => String(name || '').trim()).filter(Boolean)
                : String(diaryNames || '').trim();
            if ((Array.isArray(names) && names.length === 0) || !names) return [];
            const safeK = Math.max(1, Math.min(1000, Math.floor(Number(k) || 10)));
            return self.vectorDBManager.searchKnn(names, queryVector, safeK);
        },

        /**
         * 执行结构化日记检索，可优先使用 Rust 原生 RiverMemo，并在不可用时回退
         * 到 TagMemo/普通 KNN。此接口只返回候选及检索元数据，不生成展示文本，
         * 也不重新向量化日记文档。
         *
         * RiverMemo 路径复用 KnowledgeBaseManager 的显式日记本权限作用域和
         * Native Query Plan；ANN、候选合并、向量 hydrate、语义去重与
         * Topology V3 均在原生链路完成。TagMemo 回退路径仍只计算一次
         * TagBoost，并通过 preparedBoostResult 复用同一次感应。
         *
         * @param {object} options
         * @param {string|string[]} options.diaryNames - 日记本/索引名称
         * @param {Array|Float32Array} options.queryVector - 已生成的查询向量
         * @param {number} [options.k=10] - 最大候选 chunk 数
         * @param {'rivermemo'|'knn'} [options.engine='rivermemo'] - 明确选择检索引擎
         * @param {'none'|'knn'} [options.fallback='none'] - 仅异常或能力不可用时允许纯 KNN 回退
         * @param {number} [options.candidateK] - RiverMemo 原生候选超集大小
         * @param {string} [options.queryText=''] - RiverMemo 查询文本
         * 正常空召回不触发回退；纯 KNN 不进行感应、增强或 Memo 重排。
         * @param {string} [options.userText=''] - 动态参数计算使用的用户文本
         * @param {string} [options.aiText=''] - 动态参数计算使用的 AI 文本
         * @param {Array} [options.coreTags=[]] - 显式核心 Tag 或幽灵节点
         * @returns {Promise<{results:Array, meta:object}>}
         */
        async retrieveDiary(options = {}) {
            const { diaryNames, queryVector, k = 10, candidateK,
                queryText = '', userText = '', coreTags = [],
                engine = 'rivermemo', fallback = 'none' } = options;
            if (!['rivermemo', 'knn'].includes(engine)) throw new RangeError('Unsupported retrieval engine');
            if (!['none', 'knn'].includes(fallback)) throw new RangeError('Unsupported fallback policy');
            const names = [...new Set((Array.isArray(diaryNames) ? diaryNames : [diaryNames])
                .map(name => String(name || '').trim()).filter(Boolean))];
            if (!queryVector || names.length === 0) return { results: [], meta: { engine, riverMemoUsed: false } };
            const safeK = Math.max(1, Math.min(1000, Math.floor(Number(k) || 10)));
            let fallbackReason = null;
            if (engine === 'rivermemo') {
                try {
                    if (typeof self.vectorDBManager?.executeNativeRiverQuery !== 'function') throw new Error('rivermemo-unavailable');
                    const result = await self.vectorDBManager.executeNativeRiverQuery(
                        { text: String(queryText || userText), vector: queryVector },
                        { diaryNames: names, topK: safeK, candidateK, coreTags, enabled: true, fallbackToLegacy: true }
                    );
                    if (!Array.isArray(result?.results)) throw new Error('Invalid RiverMemo result');
                    return { results: result.results, meta: {
                        engine: 'rivermemo', riverMemoUsed: true,
                        nativeJointQueryUsed: result.diagnostics?.nativeTopologyV3?.jointUsed === true,
                        artifactSig: result.artifactSig || null, queryId: result.queryId || null,
                        omega: Number(result.omega?.omega) || 0, regime: result.omega?.regime || null,
                        matchedTags: result.queryTags?.matchedTags || [], fallbackReason: null
                    } };
                } catch (error) {
                    if (fallback !== 'knn') throw error;
                    fallbackReason = 'rivermemo-failed: ' + error.message;
                    console.warn('[ContextBridge] engine=knn fallback:', fallbackReason);
                }
            }
            if (typeof self.vectorDBManager?.searchKnn !== 'function') throw new Error('Pure KNN unavailable');
            const results = await self.vectorDBManager.searchKnn(names, queryVector, safeK);
            return { results, meta: { engine: 'knn', riverMemoUsed: false, nativeJointQueryUsed: false, fallbackReason } };
        },

        /**
         * 统一内容净化器 - 移除 HTML、Emoji、工具调用标记等噪音
         * 确保向量化输入的一致性
         * @param {string} content - 原始文本
         * @param {string} role - 角色 ('user' 或 'assistant')
         * @returns {string} 净化后的文本
         */
        sanitize(content, role) {
            return self.sanitizeForEmbedding(content, role);
        },

        // ═══════════════════════════════════════════════════
        // 向量数学工具
        // ═══════════════════════════════════════════════════

        /**
         * 余弦相似度计算
         * @param {Array|Float32Array} vecA - 向量 A
         * @param {Array|Float32Array} vecB - 向量 B
         * @returns {number} 相似度 ∈ [-1, 1]，无效输入返回 0
         */
        cosineSimilarity(vecA, vecB) {
            return self.cosineSimilarity(vecA, vecB);
        },

        /**
         * 加权平均向量计算
         * @param {Array<Array<number>>} vectors - 向量数组
         * @param {Array<number>} weights - 对应权重数组
         * @returns {Array<number>|null} 加权平均向量或 null
         */
        weightedAverage(vectors, weights) {
            if (!Array.isArray(vectors) || !Array.isArray(weights)) return null;
            return self._getWeightedAverageVector(vectors, weights);
        },

        /**
         * 多向量平均值计算
         * @param {Array<Array<number>>} vectors - 向量数组
         * @returns {Array<number>|null} 平均向量或 null
         */
        averageVector(vectors) {
            if (!Array.isArray(vectors)) return null;
            return self._getAverageVector(vectors);
        },

        // ═══════════════════════════════════════════════════
        // 结构化记忆召回（/v1/memory/search 等只读 HTTP 接口专用）
        // ═══════════════════════════════════════════════════

        /**
         * 解析元思考 V3 星池作用域为日记库名数组，供调用方在嵌入与检索之前
         * 做授权范围校验。空作用域回落到默认池。
         * @param {string} [poolScope] - 星池作用域（|、,、， 分隔）
         * @returns {string[]} 日记库名数组
         */
        resolveStarPoolDiaries(poolScope) {
            if (typeof self.metaThinkingManager?._resolveV3StarPoolDiaries !== 'function') return [];
            return self.metaThinkingManager._resolveV3StarPoolDiaries(poolScope);
        },

        /**
         * 结构化记忆召回：复用与聊天完全相同的原生召回管线（RiverMemo 原生
         * 联合查询、shotgun 历史主题段、幽灵锚、联想共现、服务端排名修饰符），
         * 返回整形后的结构化结果而非占位符文本。只读：不 broadcast、不写日记、
         * 不改动检索索引；embedding 缓存与聊天共用。
         *
         * @param {object} options
         * @param {string} options.query - 当前用户消息原文（必填）
         * @param {string[]} options.diaries - 目标日记库（必填，授权校验在调用方）
         * @param {number} [options.k=10] - 主召回条数
         * @param {Array<{role:string,content:string}>} [options.conversation] - 多轮上下文；
         *   提供时按用户/助手加权投影查询向量，并启用历史主题段补充检索与上下文去重
         * @param {string[]} [options.coreTags] - 显式幽灵锚（按强引力处理）
         * @param {boolean} [options.associate=false] - 跨种子联想共现
         * @param {string} [options.rankModifiers=''] - 服务端排名修饰符（'::Jev' / '::Rerank' / ''）
         * @param {{pool?:string, group?:boolean}|null} [options.metaThinking] - 元思考 V3 公式
         * @returns {Promise<{direct:Array, associated?:Array, metaFormula?:string|null}>}
         */
        async recallMemory(options = {}) {
            const {
                query,
                diaries,
                k = 10,
                conversation = null,
                coreTags = [],
                associate = false,
                rankModifiers = '',
                metaThinking = null
            } = options;
            const diaryNames = [...new Set((Array.isArray(diaries) ? diaries : [diaries])
                .map(name => String(name || '').trim()).filter(Boolean))];
            if (!diaryNames.length) throw new Error('diaries required');
            if (typeof query !== 'string' || !query.trim()) throw new Error('query required');

            // ── 1. 查询投影：单句或与聊天同构的多轮加权投影 ──
            let userContent = query.trim();
            let aiContent = null;
            let userVector = null;
            let aiVector = null;
            let queryVector = null;
            let historySegments = [];
            let historyAssistantVectors = [];
            let contextDiaryPrefixes = new Set();
            let combinedQueryForDisplay = userContent;

            if (Array.isArray(conversation) && conversation.length > 0) {
                const messages = conversation
                    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
                    .map(m => ({ role: m.role, content: m.content }));
                const lastUser = findLastRealUserMessage(messages, {
                    sanitize: self.sanitizeForEmbedding.bind(self)
                });
                if (lastUser.sanitizedContent) userContent = lastUser.sanitizedContent;
                const lastAiIndex = messages.findLastIndex(m => m.role === 'assistant');
                if (lastAiIndex > -1) {
                    const rawAi = self._extractTextFromContent(messages[lastAiIndex].content);
                    aiContent = rawAi ? self.sanitizeForEmbedding(rawAi, 'assistant') : null;
                }
                combinedQueryForDisplay = aiContent
                    ? `[AI]: ${aiContent}\n[User]: ${userContent}`
                    : userContent;
                const weights = Array.isArray(self.ragParams?.RAGDiaryPlugin?.mainSearchWeights)
                    ? self.ragParams.RAGDiaryPlugin.mainSearchWeights
                    : [0.7, 0.3];
                [userVector, aiVector] = await Promise.all([
                    userContent ? self.getSingleEmbeddingCached(userContent, { contextRole: 'user' }) : null,
                    aiContent ? self.getSingleEmbeddingCached(aiContent, { contextRole: 'assistant' }) : null
                ]);
                queryVector = self._getWeightedAverageVector([userVector, aiVector], weights);
                if (self.shotgunHistoryEnabled !== false) {
                    const snapshot = await self.contextVectorManager.updateContext(messages, {
                        allowApi: self.contextVectorAllowApi
                    });
                    historySegments = self.contextVectorManager.segmentContext(
                        messages, 0.70, snapshot?.snapshotVectorByHash || null
                    ) || [];
                    historyAssistantVectors = Array.isArray(snapshot?.historyAssistantVectors)
                        ? snapshot.historyAssistantVectors
                        : [];
                }
                contextDiaryPrefixes = self._extractContextDiaryPrefixes(messages);
            } else {
                userVector = queryVector = await self.getSingleEmbeddingCached(userContent, { contextRole: 'user' });
            }
            if (!queryVector || !queryVector.length) throw new Error('Memory query embedding unavailable');

            // ── 2. 显式幽灵锚（强引力）──
            const ghostTags = Array.isArray(coreTags) && coreTags.length > 0
                ? await self._resolveGhostAnchors(coreTags.slice(0, 16), true)
                : [];

            // ── 3. 请求级缓存与元思考观测共享（与聊天同一条河流）──
            const wantMeta = Boolean(metaThinking)
                && typeof self.metaThinkingManager?.processMetaThinkingV3 === 'function';
            const requestCache = self._createRequestCache();
            if (wantMeta && self.riverThinkingConfig?.enabled) {
                const ready = [false, true].map(() => {
                    let resolve;
                    const promise = new Promise(done => { resolve = done; });
                    return { promise, resolve };
                });
                requestCache.riverThinking = {
                    config: self.riverThinkingConfig,
                    observations: [],
                    deferred: [],
                    ready
                };
                requestCache.ownedMemoObservations = new Set();
            }

            const modifiers = `::RiverMemo${rankModifiers || ''}${associate ? '::Associate' : ''}`;
            let rawResults = [];
            let metaFormula;
            try {
                rawResults = await self._processRAGPlaceholder({
                    dbName: diaryNames,
                    modifiers,
                    queryVector,
                    userContent,
                    aiContent,
                    combinedQueryForDisplay,
                    dynamicK: k,
                    historySegments,
                    contextDiaryPrefixes,
                    ghostTags,
                    associateDiaries: diaryNames,
                    requestCache,
                    returnRawResults: true
                }) || [];

                if (wantMeta) {
                    const poolScope = typeof metaThinking.pool === 'string' && metaThinking.pool.trim()
                        ? metaThinking.pool.trim()
                        : undefined;
                    try {
                        metaFormula = await self.metaThinkingManager.processMetaThinkingV3(
                            poolScope,
                            queryVector,
                            userContent,
                            aiContent || '',
                            combinedQueryForDisplay,
                            Boolean(metaThinking.group),
                            {
                                config: self.riverThinkingConfig,
                                getObservation: async () => requestCache.riverThinking?.observations?.[0]?.prepared || null,
                                getActiveDiaryChunks: async () => Array.isArray(requestCache.v3ActiveDiaryChunks)
                                    ? requestCache.v3ActiveDiaryChunks
                                    : [],
                                userVector,
                                aiVector,
                                mainSearchWeights: Array.isArray(self.ragParams?.RAGDiaryPlugin?.mainSearchWeights)
                                    ? self.ragParams.RAGDiaryPlugin.mainSearchWeights
                                    : null,
                                coreTags: ghostTags,
                                historySegments,
                                historyAssistantVectors
                            }
                        ) ?? null;
                    } catch (error) {
                        console.warn('[RAGDiaryPlugin] recallMemory meta thinking unavailable:', error.message);
                        metaFormula = null;
                    }
                }
            } finally {
                if (requestCache.ownedMemoObservations) {
                    for (const prepared of requestCache.ownedMemoObservations) {
                        try {
                            self.vectorDBManager.releaseMemoObservation(prepared);
                        } catch (releaseError) {
                            console.warn('[RAGDiaryPlugin] memo observation release failed:', releaseError.message);
                        }
                    }
                }
            }

            // ── 4. 整形：只暴露安全字段，永不泄漏 fullPath/向量/内部签名 ──
            const shape = (row, index) => {
                const item = {
                    rank: index + 1,
                    diary: row.diaryName,
                    file: path.win32.basename(row.sourceFile || row.fullPath || ''),
                    text: row.text,
                    score: row.rrf_score ?? row.rerank_score ?? row.score ?? 0,
                    scoreSource: row.rrf_score != null ? 'rrf' : (row.rerank_score != null ? 'rerank' : 'retrieval')
                };
                if (typeof row.chunkId === 'string' || typeof row.chunkId === 'number') item.chunkId = row.chunkId;
                return item;
            };
            const directRows = [];
            const associateRows = [];
            for (const row of rawResults) {
                if (!row || !row.text) continue;
                if (row.source === 'associate') associateRows.push(row);
                else directRows.push(row);
            }
            const result = { direct: directRows.map((row, index) => shape(row, index)) };
            if (associate) {
                result.associated = associateRows.map((row, index) => ({
                    ...shape(row, index),
                    seedCount: row._associateCoCount || 1
                }));
            }
            if (wantMeta) result.metaFormula = metaFormula ?? null;
            return result;
        },


        // ═══════════════════════════════════════════════════
        // 🌟 V2折叠：FoldingStore 接口（动态 Getter，解决初始化时序竞态）
        // ═══════════════════════════════════════════════════

        /** FoldingStore 读写接口，供 ContextFoldingV2 使用
         *  使用 getter 动态获取，避免静态快照导致的初始化竞态：
         *  即使 getContextBridge() 被调用时 foldingStore 尚为 null，
         *  后续访问时仍能拿到正确的实例。
         */
        get foldingStore() {
            if (!self.foldingStore) return null;
            return Object.freeze({
                /**
                 * 获取条目
                 * @param {string} contentHash - SHA-256 哈希
                 * @returns {object|null} 条目数据
                 */
                getEntry(contentHash) {
                    return self.foldingStore.getEntry(contentHash);
                },

                /**
                 * 写入/更新向量
                 * @param {string} contentHash
                 * @param {object} data - { textPreview, vector }
                 */
                upsertVector(contentHash, data) {
                    self.foldingStore.upsertVector(contentHash, data);
                },

                /**
                 * 写入摘要结果
                 * @param {string} contentHash
                 * @param {string} summary
                 * @param {string} status - 'ready' | 'failed'
                 */
                upsertSummary(contentHash, summary, status) {
                    self.foldingStore.upsertSummary(contentHash, summary, status);
                },

                /**
                 * 标记为摘要生成中
                 * @param {string} contentHash
                 */
                markPending(contentHash) {
                    self.foldingStore.markPending(contentHash);
                },

                /**
                 * 获取统计信息
                 * @returns {{ count, maxEntries, available }}
                 */
                getStats() {
                    return self.foldingStore.getStats();
                },

                /**
                 * 生成内容哈希的静态工具方法
                 * @param {string} sanitizedContent
                 * @returns {string}
                 */
                hashContent(sanitizedContent) {
                    return FoldingStore.hashContent(sanitizedContent);
                }
            });
        }
    });
}

module.exports = createContextBridge;
