'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { getEmbeddingsBatch } = require('../../EmbeddingUtils');

// 实现函数以 KnowledgeBaseManager 作为 this 执行，使状态所有权保持唯一；
// 本模块拥有摄取行为，Manager 仅保留兼容门面。
const implementations = {
_queueDelete(filePath) {
        if (this._shuttingDown) return;
        this.pendingDeletes.add(filePath);
        if (this.pendingDeletes.size >= this.config.maxDeleteBatchSize) {
            this._flushDeleteBatch();
        } else {
            this._scheduleDeleteBatch();
        }
    },

_scheduleDeleteBatch() {
        if (this.deleteBatchTimer) clearTimeout(this.deleteBatchTimer);
        this.deleteBatchTimer = setTimeout(() => this._flushDeleteBatch(), this.config.deleteBatchWindow);
    },

async _flushDeleteBatch() {
        if (this.isProcessingDeletes || this.pendingDeletes.size === 0 || this.databaseCorruptionDetected) return;
        if (this.externalMutationActive) {
            this.externalMutationDeleteBatchDeferred = true;
            return;
        }
        if (this.indexRecoveryActive) {
            return;
        }
        this.isProcessingDeletes = true;
        this.touchActivity?.();
        let retryDelayMs = 0;

        const batchFiles = Array.from(this.pendingDeletes).slice(0, this.config.maxDeleteBatchSize);
        if (this.deleteBatchTimer) {
            clearTimeout(this.deleteBatchTimer);
            this.deleteBatchTimer = null;
        }

        try {
            await this._handleDeleteBatch(batchFiles);
            batchFiles.forEach(f => this.pendingDeletes.delete(f));
            this.databaseCoordinator?.notifyDeletedFilePaths(batchFiles);
            this.touchActivity?.();
        } catch (e) {
            console.error('[KnowledgeBase] ❌ Delete batch failed:', e);
            if (this._isSqliteCorruptionError(e)) {
                this.databaseCoordinator?.notifyDeletedFilePaths(batchFiles, e);
                await this._handleRuntimeSqliteCorruption(e, []);
            } else {
                retryDelayMs = Math.max(1000, this.config.sqliteBusyRetryDelayMs);
                console.warn(
                    `[KnowledgeBase] Delete verification/commit deferred; ` +
                    `${batchFiles.length} delete(s) remain queued and will retry in ${retryDelayMs}ms.`
                );
            }
        } finally {
            this.isProcessingDeletes = false;
            if (!this._shuttingDown && !this.databaseCorruptionDetected && this.pendingDeletes.size > 0) {
                if (retryDelayMs > 0) {
                    setTimeout(() => this._flushDeleteBatch(), retryDelayMs);
                } else {
                    setImmediate(() => this._flushDeleteBatch());
                }
            }
        }
    },

_scheduleBatch() {
        // 固定收集窗口：首个文件启动计时，后续文件只加入 pendingFiles，
        // 不重置截止时间，避免持续写入导致索引任务无限延期。
        if (this._shuttingDown || this.batchTimer) return;
        this.batchTimer = setTimeout(() => {
            this.batchTimer = null;
            this._flushBatch();
        }, this.config.batchWindow);
    },

async _flushBatch() {
        if (this._shuttingDown || this.isProcessing || this.pendingFiles.size === 0) return;
        if (this.externalMutationActive) {
            this.externalMutationBatchDeferred = true;
            return;
        }
        if (this.indexRecoveryActive) {
            return;
        }
        this.isProcessing = true;
        this.touchActivity?.();
        let retryDelayMs = 0;

        // 1. 📋 准备批次：先从队列中取出，但不立即永久删除
        const batchFiles = Array.from(this.pendingFiles).slice(0, this.config.maxBatchSize);
        const batchIdentity = {
            operationId: crypto.randomUUID(),
            batchId: crypto.randomUUID(),
            createdAt: Date.now(),
            expiresAt: Date.now() + 30 * 60 * 1000,
            dimension: this.config.dimension,
            modelSig: this.config.modelSig
        };
        const batchPathGenerations = new Map(batchFiles.map(filePath => [
            path.resolve(filePath), this.watcherPathGenerations.get(path.resolve(filePath)) || 0
        ]));
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }

        console.log(`[KnowledgeBase] 🚌 Processing ${batchFiles.length} files...`);

        try {
            // 1. 解析文件并按日记本分组
            const docsByDiary = new Map(); // Map<DiaryName, Array<Doc>>
            const unstableFiles = new Set();
            const terminalFiles = new Map();
            const finishTerminalFiles = () => {
                for (const [filePath, error] of terminalFiles) {
                    const absolute = path.resolve(filePath);
                    if ((this.watcherPathGenerations.get(absolute) || 0)
                        !== (batchPathGenerations.get(absolute) || 0)) continue;
                    this.pendingFiles.delete(filePath);
                    this.fileRetryCount.delete(filePath);
                    this.databaseCoordinator?.notifyIndexedFilePaths([filePath], error);
                }
                terminalFiles.clear();
            };
            const relativePaths = batchFiles.map(filePath =>
                path.relative(this.config.rootPath, filePath).replace(/\\/g, '/')
            );
            const probeRows = await this.probeIngestionFiles(relativePaths);
            const probeByPath = new Map(
                probeRows.map(row => [row.path, row])
            );

            await Promise.all(batchFiles.map(async (filePath) => {
                try {
                    const stats = await fs.stat(filePath);
                    const relPath = path.relative(this.config.rootPath, filePath).replace(/\\/g, '/');
                    const parts = relPath.split('/');
                    const diaryName = parts.length > 1 ? parts[0] : 'Root';

                    const row = probeByPath.get(relPath);
                    const storedMtime = Number(row?.mtime);
                    const storedSize = Number(row?.size);
                    if (
                        row?.exists
                        && storedMtime === Math.floor(stats.mtimeMs)
                        && storedSize === stats.size
                        && row.completeVectors === true
                        && row.chunkCount === row.validVectorCount
                        && row.completeTags === true
                        && row.tagCount === row.validTagVectorCount
                    ) {
                        terminalFiles.set(filePath, null);
                        return;
                    }

                    const content = await fs.readFile(filePath, 'utf-8');
                    const statsAfterRead = await fs.stat(filePath);

                    // 文件真相快照防线：任何写入者（包括尚未接入协调器的外部程序）
                    // 只要在读取窗口内改变文件，就不能把这次中间态写进 SQLite/向量索引。
                    if (
                        stats.size !== statsAfterRead.size ||
                        stats.mtimeMs !== statsAfterRead.mtimeMs
                    ) {
                        unstableFiles.add(filePath);
                        console.warn(`[KnowledgeBase] 🛡️ File changed while being read; deferring unstable snapshot: "${filePath}"`);
                        return;
                    }

                    const checksum = crypto.createHash('md5').update(content).digest('hex');

                    if (
                        row?.exists
                        && row.checksum === checksum
                        && row.completeVectors === true
                        && row.chunkCount === row.validVectorCount
                        && row.completeTags === true
                        && row.tagCount === row.validTagVectorCount
                    ) {
                        await this.nativeKnowledgeRuntime.refreshFileMetadata(
                            this.dbPath,
                            JSON.stringify({
                                path: relPath, checksum, version: row.version,
                                mtime: Math.floor(stats.mtimeMs), size: stats.size
                            })
                        );
                        terminalFiles.set(filePath, null);
                        return;
                    }

                    const prepared = await this.prepareIngestionText(content);
                    if (!docsByDiary.has(diaryName)) docsByDiary.set(diaryName, []);
                    docsByDiary.get(diaryName).push({
                        relPath,
                        diaryName,
                        checksum,
                        mtime: stats.mtimeMs,
                        size: stats.size,
                        tagsOnly: row?.exists === true && row.checksum === checksum
                            && storedSize === stats.size && row.completeVectors === true
                            && row.chunkCount === row.validVectorCount && row.completeTags !== true,
                        chunks: prepared.chunks,
                        tags: prepared.tags,
                        textRulesVersion: prepared.rulesVersion
                    });
                } catch (e) {
                    // 元数据快路径也可能执行 UPDATE。忙锁属于数据库级瞬态失败，
                    // 必须交给批次错误边界统一保留队列，不能伪装成单文件读取失败后出队。
                    if (this._isSqliteBusyError(e) || this._isSqliteCorruptionError(e)
                        || /KNOWLEDGE_STORE_/.test(String(e.message))) throw e;
                    if (e.code !== 'ENOENT') console.warn(`Read error ${filePath}:`, e.message);
                    terminalFiles.set(filePath, e);
                }
            }));

            // 快路径和读取失败已到终态，不依赖其他文件能否进入提交计划。
            finishTerminalFiles();
            if (unstableFiles.size > 0) {
                retryDelayMs = Math.max(500, Number(this.config.batchWindow) || 0);
            }
            if (docsByDiary.size === 0) return;

            // 2. 收集文本并在 Rust 内部解析可复用向量来源。
            const allChunksWithMeta = [];
            const uniqueTags = new Set();
            const migrationRequests = [];

            for (const [, docs] of docsByDiary) {
                docs.forEach(doc => {
                    if (!doc.tagsOnly) migrationRequests.push({
                        path: doc.relPath,
                        checksum: doc.checksum,
                        size: doc.size,
                        chunkCount: doc.chunks.length
                    });
                    doc.tags.forEach(t => uniqueTags.add(t));
                });
            }

            const migrationCandidates = await this.probeMigrationReuse(
                migrationRequests
            );
            const migrationByPath = new Map(
                migrationCandidates.map(candidate => [candidate.path, candidate])
            );
            const reusedDiaries = new Set();
            let reusedChunkVectorCount = 0;

            for (const [dName, docs] of docsByDiary) {
                docs.forEach(doc => {
                    if (doc.tagsOnly) return;
                    const candidate = this._migrationEmbeddingFallbacks?.has(doc.relPath)
                        ? null : migrationByPath.get(doc.relPath);
                    if (candidate) {
                        doc.migrationSourceFileId = candidate.liveFileId || null;
                        doc.migrationCacheId = candidate.migrationCacheId || null;
                        reusedChunkVectorCount += doc.chunks.length;
                        reusedDiaries.add(dName);
                    } else {
                        doc.chunks.forEach((txt, cIdx) => {
                            allChunksWithMeta.push({
                                text: txt,
                                diaryName: dName,
                                doc,
                                chunkIdx: cIdx
                            });
                        });
                    }
                });
            }

            if (reusedChunkVectorCount > 0) {
                console.log(`[KnowledgeBase] ♻️ Reused ${reusedChunkVectorCount} chunk vector(s) from SQLite cache; skipped embedding for matching moved/copied content.`);
            }

            // Tag 处理：只从 Rust 获取轻量状态摘要，不把 tags.vector 读入 V8。
            const tagProbeRows = await this.probeIngestionTags(
                Array.from(uniqueTags)
            );
            const tagProbeByName = new Map(
                tagProbeRows.map(row => [row.name, row])
            );
            const newTagsSet = new Set();
            const tagEmbeddingTextByName = new Map();
            for (const t of uniqueTags) {
                const row = tagProbeByName.get(t);
                if (!row?.hasVector) {
                    const cleanedTag = this._prepareTextForEmbedding(t);
                    if (cleanedTag !== '[EMPTY_CONTENT]') {
                        newTagsSet.add(cleanedTag);
                        tagEmbeddingTextByName.set(t, cleanedTag);
                    }
                }
            }

            const newTags = Array.from(newTagsSet);
            // 3. Embedding API Calls
            const embeddingConfig = { apiKey: this.config.apiKey, apiUrl: this.config.apiUrl, model: this.config.model };

            let chunkVectors = [];
            if (allChunksWithMeta.length > 0) {
                const texts = allChunksWithMeta.map(i => i.text);
                chunkVectors = await getEmbeddingsBatch(texts, embeddingConfig);
                if (!Array.isArray(chunkVectors) || chunkVectors.length !== texts.length) {
                    const error = new Error(
                        `Embedding chunk response length mismatch: expected ${texts.length}, ` +
                        `got ${Array.isArray(chunkVectors) ? chunkVectors.length : 'non-array'}`
                    );
                    error.code = 'EMBEDDING_RESPONSE_MISMATCH';
                    throw error;
                }
                // null 仅表示对应位置失败；数量不匹配必须拒绝整个批次。
                this.touchActivity?.();
            }

            let tagVectors = [];
            if (newTags.length > 0) {
                const tagLimit = 100;
                for (let i = 0; i < newTags.length; i += tagLimit) {
                    const batch = newTags.slice(i, i + tagLimit);
                    const batchVectors = await getEmbeddingsBatch(batch, embeddingConfig);
                    if (!Array.isArray(batchVectors) || batchVectors.length !== batch.length) {
                        const error = new Error(
                            `Embedding Tag response length mismatch: expected ${batch.length}, ` +
                            `got ${Array.isArray(batchVectors) ? batchVectors.length : 'non-array'}`
                        );
                        error.code = 'EMBEDDING_RESPONSE_MISMATCH';
                        throw error;
                    }
                    // null 仅表示对应位置失败；数量不匹配必须拒绝整个批次。
                    tagVectors.push(...batchVectors);
                }
                this.touchActivity?.();
            }

            const missingChunkEmbeddingIndexes = new Set(
                chunkVectors
                    .map((vector, index) => vector ? null : index)
                    .filter(index => index !== null)
            );
            const missingTagEmbeddingIndexes = new Set(
                tagVectors
                    .map((vector, index) => vector ? null : index)
                    .filter(index => index !== null)
            );
            const incompleteFiles = new Set();

            allChunksWithMeta.forEach((meta, index) => {
                if (missingChunkEmbeddingIndexes.has(index)) {
                    incompleteFiles.add(meta.doc.relPath);
                }
            });
            newTags.forEach((tagText, index) => {
                if (!missingTagEmbeddingIndexes.has(index)) return;
                for (const [, docs] of docsByDiary) {
                    for (const doc of docs) {
                        if (doc.tags.some(name =>
                            tagEmbeddingTextByName.get(name) === tagText
                        )) {
                            incompleteFiles.add(doc.relPath);
                        }
                    }
                }
            });

            const tagVectorSlotByText = new Map();
            const successfulTagVectors = [];
            newTags.forEach((tagText, index) => {
                const vector = tagVectors[index];
                if (!vector) return;
                const normalizedVector = vector instanceof Float32Array
                    ? vector
                    : new Float32Array(vector);
                if (normalizedVector.length !== this.config.dimension) {
                    throw new RangeError(
                        `Tag vector dimension mismatch for "${tagText}"`
                    );
                }
                tagVectorSlotByText.set(tagText, successfulTagVectors.length);
                successfulTagVectors.push(normalizedVector);
            });

            // 4. 将 JS 已完成的切分、Tag 与 Embedding 结果提交给 Rust Write Actor。
            // 每个向量槽保持稳定位置；失败项使用 null，不会挤压后续槽位。
            const metaMap = new Map();
            allChunksWithMeta.forEach((meta, index) => {
                meta.vector = chunkVectors[index];
                metaMap.set(`${meta.doc.relPath}:${meta.chunkIdx}`, meta);
            });

            const planChunks = [];
            const planTags = [];
            const planFiles = [];
            const chunkVectorValues = [];

            for (const [diaryName, docs] of docsByDiary) {
                for (const doc of docs) {
                    const absolute = path.resolve(this.config.rootPath, doc.relPath);
                    try {
                        const current = await fs.stat(absolute);
                        const expectedGeneration = batchPathGenerations.get(absolute) || 0;
                        const currentGeneration = this.watcherPathGenerations.get(absolute) || 0;
                        if (current.size !== doc.size || current.mtimeMs !== doc.mtime
                            || currentGeneration !== expectedGeneration) {
                            console.warn(
                                `[KnowledgeBase] 🛡️ Pre-commit snapshot changed: ${JSON.stringify({
                                    path: doc.relPath,
                                    size: { expected: doc.size, actual: current.size },
                                    mtimeMs: { expected: doc.mtime, actual: current.mtimeMs },
                                    generation: { expected: expectedGeneration, actual: currentGeneration }
                                })}`
                            );
                            unstableFiles.add(absolute);
                            retryDelayMs = Math.max(1000, this.config.sqliteBusyRetryDelayMs);
                            continue;
                        }
                    } catch (error) {
                        // 单文件消失或暂时无法读取不应丢弃其他文件已完成的向量。
                        unstableFiles.add(absolute);
                        retryDelayMs = Math.max(1000, this.config.sqliteBusyRetryDelayMs);
                        if (error.code === 'ENOENT') this._queueDelete(absolute);
                        else console.warn(`[KnowledgeBase] Source verification deferred: ${absolute}`, error);
                        continue;
                    }
                    const chunkStart = planChunks.length;
                    const tagStart = planTags.length;

                    (doc.tagsOnly ? [] : doc.chunks).forEach((text, chunkIndex) => {
                        const meta = metaMap.get(`${doc.relPath}:${chunkIndex}`);
                        const source = meta?.vector;
                        let vectorSlot = null;
                        if (source) {
                            const vector = source instanceof Float32Array
                                ? source
                                : new Float32Array(source);
                            if (vector.length !== this.config.dimension) {
                                throw new RangeError(
                                    `Chunk vector dimension mismatch for ${doc.relPath}:${chunkIndex}`
                                );
                            }
                            vectorSlot = chunkVectorValues.length / this.config.dimension;
                            chunkVectorValues.push(...vector);
                        }
                        planChunks.push({ content: text, chunkIndex, vectorSlot });
                    });

                    doc.tags.forEach((name, position) => {
                        const embeddingText = tagEmbeddingTextByName.get(name);
                        planTags.push({
                            name,
                            position: position + 1,
                            vectorSlot: embeddingText !== undefined
                                ? tagVectorSlotByText.get(embeddingText) ?? null
                                : null
                        });
                    });

                    planFiles.push({
                        path: doc.relPath,
                        diaryName,
                        checksum: doc.checksum,
                        mtime: Math.floor(Number(doc.mtime) || 0),
                        expectedVersion: Math.max(
                            0,
                            Math.floor(Number(probeByPath.get(doc.relPath)?.version) || 0)
                        ),
                        size: Math.floor(Number(doc.size) || 0),
                        chunkStart,
                        chunkCount: doc.tagsOnly ? 0 : doc.chunks.length,
                        tagsOnly: doc.tagsOnly === true,
                        tagStart,
                        tagCount: doc.tags.length,
                        migrationCacheId: doc.migrationCacheId || null,
                        migrationSourceFileId: doc.migrationSourceFileId || null
                    });
                }
            }

            if (this.config.dimension !== batchIdentity.dimension
                || this.config.modelSig !== batchIdentity.modelSig) {
                throw new Error('KNOWLEDGE_STORE_MODEL_CHANGED_DURING_EMBEDDING');
            }
            if (planFiles.length === 0) {
                console.warn(
                    `[KnowledgeBase] ⏳ Batch deferred without commit: ` +
                    `selected=${batchFiles.length}, unstable=${unstableFiles.size}, ` +
                    `pending=${this.pendingFiles.size}, retryIn=${retryDelayMs}ms. ` +
                    'Embedding results were not committed; inspect snapshot diagnostics above.'
                );
                return;
            }
            // 过滤文件后压紧 Tag 槽位；不能提交被排除文件独有的 Tag 或尾部向量。
            const retainedTagVectors = [];
            const retainedTagSlots = new Map();
            for (const tag of planTags) {
                if (tag.vectorSlot === null) continue;
                const oldSlot = tag.vectorSlot;
                if (!retainedTagSlots.has(oldSlot)) {
                    retainedTagSlots.set(oldSlot, retainedTagVectors.length);
                    retainedTagVectors.push(successfulTagVectors[oldSlot]);
                }
                tag.vectorSlot = retainedTagSlots.get(oldSlot);
            }
            const commitPlan = {
                ...batchIdentity,
                files: planFiles,
                chunks: planChunks,
                tags: planTags
            };

            const tagVectorValues = new Float32Array(
                retainedTagVectors.length * this.config.dimension
            );
            retainedTagVectors.forEach((vector, index) => {
                tagVectorValues.set(
                    vector,
                    index * this.config.dimension
                );
            });

            if (this._shuttingDown) return;
            const _tPhaseStart = Date.now();
            const receipt = await this.commitIngestionBatch(
                commitPlan,
                new Float32Array(chunkVectorValues),
                tagVectorValues
            );
            const _tSqliteMs = Date.now() - _tPhaseStart;
            this.touchActivity?.();

            const _tRustStart = Date.now();
            const _tRustMs = Date.now() - _tRustStart;
            this.touchActivity?.();

            // Rust Write Actor 已在事实事务成功后，使用 Runtime 内部持有的
            // 日记/Tag 索引 Arc 应用 Delta。Node.js 不再接收或重放向量，
            // 也不再通过 JS IndexRepository 维护第二套索引真相。
            if (receipt.indexReady !== true) {
                console.log(
                    '[KnowledgeBase] 🧊 Rust ingestion committed facts; ' +
                    'one or more affected indices were not resident and remain ' +
                    'scheduled for native recovery.'
                );
            } else {
                console.log(
                    '[KnowledgeBase] 🔐 Rust ingestion committed facts and published ' +
                    'all resident index deltas.'
                );
            }

            const _tTagStart = Date.now();
            const newTagIds = receipt.newTagIds || [];
            for (const diaryName of receipt.affectedDiaries || Object.keys(receipt.diaryIndexDeltas || {})) {
                if (this.diaryIndices.has(diaryName)) this._scheduleIndexSave?.(diaryName);
            }
            if (newTagIds.length > 0) this._scheduleIndexSave?.('global_tags');
            const retryablePaths = new Set();
            for (const file of receipt.retryableFiles || []) {
                if (file.code !== 'KNOWLEDGE_STORE_MIGRATION_SOURCE_CHANGED') continue;
                retryablePaths.add(file.path);
                this._migrationEmbeddingFallbacks ||= new Set();
                this._migrationEmbeddingFallbacks.add(file.path);
            }
            if (retryablePaths.size > 0) {
                retryDelayMs = Math.max(1000, this.config.sqliteBusyRetryDelayMs);
            }

            // 5. ✅ 成功处理后，移除文件并清空重试计数
            batchFiles.forEach(f => {
                if (!this.pendingFiles.has(f)) return;
                if (unstableFiles.has(f) || unstableFiles.has(path.resolve(f))
                    || (this.watcherPathGenerations.get(path.resolve(f)) || 0)
                        !== (batchPathGenerations.get(path.resolve(f)) || 0)) return;
                const relativePath = path.relative(this.config.rootPath, f).replace(/\\/g, '/');
                if (retryablePaths.has(relativePath)) return;
                if (incompleteFiles.has(relativePath)) {
                    console.warn(
                        `[KnowledgeBase] ⚠️ File "${relativePath}" committed with ` +
                        'missing embeddings; retaining it for the next repair pass.'
                    );
                    return;
                }
                this.pendingFiles.delete(f);
                this._migrationEmbeddingFallbacks?.delete(relativePath);
                this.fileRetryCount.delete(f); // 清空重试计数
                this.databaseCoordinator?.notifyIndexedFilePaths([f]);
            });

            if (incompleteFiles.size > 0) {
                retryDelayMs = Math.max(
                    retryDelayMs,
                    this.config.sqliteBusyRetryDelayMs,
                    1000
                );
                console.warn(
                    `[KnowledgeBase] 🛠️ ${incompleteFiles.size} file(s) remain queued ` +
                    `for vector repair; retrying in ${retryDelayMs}ms.`
                );
            }

            for (const dName of receipt.affectedDiaries || []) {
                this.invalidateDiaryDateIndex(dName);
                if (this.diaryIndices.has(dName)) {
                    await this._ensureDiaryDateIndexCached(dName);
                }
            }
            const _tTagAndDateMs = Date.now() - _tTagStart;

            // Rust 持久化累计唯一变动 Tag（含关联变化），达到训练基线 1% 后后台重算。
            // 查询始终保留最后成功发布的图；检查失败不影响已提交的日记。
            const _tMatrixStart = Date.now();
            if (this.tagMemoEngine) await this.tagMemoEngine.scheduleMatrixRebuildForNewTags(newTagIds);
            const _tMatrixMs = Date.now() - _tMatrixStart;

            console.log(
                `[KnowledgeBase] ⏱️ Phase Breakdown: ` +
                `SQLite=${_tSqliteMs}ms, ` +
                `applyChunkDelta=${_tRustMs}ms, ` +
                `Tag&Date=${_tTagAndDateMs}ms, ` +
                `scheduleMatrix=${_tMatrixMs}ms (Total=${Date.now() - _tPhaseStart}ms)`
            );
            console.log(
                `[KnowledgeBase] ✅ Batch complete. Updated ` +
                `${Object.keys(receipt.diaryIndexDeltas || {}).length} diary indices.`
            );

        } catch (e) {
            console.error('[KnowledgeBase] ❌ Batch processing failed catastrophically.');
            console.error('Error Details:', e);
            if (e.stack) {
                console.error('Stack Trace:', e.stack);
            }

            if (this._isSqliteCorruptionError(e)) {
                this.databaseCoordinator?.notifyIndexedFilePaths(batchFiles, e);
                await this._handleRuntimeSqliteCorruption(e, batchFiles);
            } else if (this._isSqliteBusyError(e)) {
                // SQLITE_BUSY/LOCKED 是共享数据库级竞争，不是任一文件的确定性错误。
                // 文件全部保留，且不消耗 fileRetryCount，防止短暂外部写锁导致永久丢索引。
                retryDelayMs = this.config.sqliteBusyRetryDelayMs;
                console.warn(
                    `[KnowledgeBase] ⏳ SQLite remained busy after ${this.config.sqliteBusyTimeoutMs}ms; ` +
                    `${batchFiles.length} file(s) remain queued without consuming retry budget. ` +
                    `Retrying in ${retryDelayMs}ms.`
                );
            } else if (/KNOWLEDGE_STORE_(?:SOURCE_SNAPSHOT_CHANGED|MODEL_CHANGED_DURING_EMBEDDING|FILE_VERSION_CONFLICT|BATCH_EXPIRED)/.test(String(e?.message))) {
                retryDelayMs = Math.max(1000, this.config.sqliteBusyRetryDelayMs);
            } else if (e?.code === 'EMBEDDING_RESPONSE_MISMATCH') {
                // 响应数量错位无法建立稳定 descriptor 映射，整批保留。
                retryDelayMs = Math.max(
                    this.config.sqliteBusyRetryDelayMs,
                    1000
                );
                console.warn(
                    `[KnowledgeBase] ⚠️ Embedding response shape mismatch; ` +
                    `${batchFiles.length} file(s) remain queued and will retry ` +
                    `in ${retryDelayMs}ms.`
                );
            } else {
                // 🛡️ 核心修复：重试计数，防止确定性失败导致无限循环
                const MAX_FILE_RETRIES = 3;
                batchFiles.forEach(f => {
                    const count = (this.fileRetryCount.get(f) || 0) + 1;
                    if (count >= MAX_FILE_RETRIES) {
                        console.error(`[KnowledgeBase] ⛔ File "${f}" failed ${MAX_FILE_RETRIES} times. Removing from queue permanently.`);
                        this.pendingFiles.delete(f);
                        this.fileRetryCount.delete(f);
                        this.databaseCoordinator?.notifyIndexedFilePaths([f], e);
                    } else {
                        this.fileRetryCount.set(f, count);
                        console.warn(`[KnowledgeBase] ⚠️ File "${f}" retry ${count}/${MAX_FILE_RETRIES}.`);
                    }
                });
            }
        }
        finally {
            this.isProcessing = false;
            if (!this._shuttingDown && !this.databaseCorruptionDetected && this.pendingFiles.size > 0) {
                if (retryDelayMs > 0) {
                    setTimeout(() => this._flushBatch(), retryDelayMs);
                } else {
                    setImmediate(() => this._flushBatch());
                }
            }
        }
    },

async _handleDelete(filePath) {
        await this._handleDeleteBatch([filePath]);
    },

async _handleDeleteBatch(filePaths) {
        const relPaths = [...new Set(filePaths.map(filePath =>
            path.relative(this.config.rootPath, filePath).replace(/\\/g, '/')
        ))];
        if (relPaths.length === 0) return;

        try {
            const receipt = await this.commitDeleteBatch(
                relPaths,
                this.config.migrationCacheTtlMs
            );
            const diaryIndexDeltas = receipt.diaryIndexDeltas || {};
            const affectedDiaries = Object.keys(diaryIndexDeltas);

            if (receipt.removedChunkIds.length > 0) {
                console.log(
                    `[KnowledgeBase] 🧹 Rust delete removed ` +
                    `${receipt.affectedFiles.length} file record(s), ` +
                    `${receipt.removedChunkIds.length} chunk vector(s).`
                );
            }

            for (const diaryName of affectedDiaries) {
                this.invalidateDiaryDateIndex(diaryName);
                if (this.diaryIndices.has(diaryName)) this._scheduleIndexSave?.(diaryName);
            }

            if (receipt.indexReady !== true) {
                console.warn(
                    '[KnowledgeBase] 🧊 Rust delete committed facts, but one or more ' +
                    'resident diary indices are not ready; native recovery remains required.'
                );
            } else {
                console.log(
                    '[KnowledgeBase] 🔐 Rust delete committed facts and published ' +
                    'all resident diary index removals.'
                );
            }
            await this.tagMemoEngine?.scheduleMatrixRebuildForNewTags([]);
        } catch (e) {
            console.error(`[KnowledgeBase] Delete error:`, e);
            // 忙锁与损坏都必须交给队列拥有者处理。吞掉 SQLITE_BUSY 会让
            // _flushDeleteBatch() 误删 pendingDeletes，造成 SQLite 中的幽灵记录。
            throw e;
        }
    }
};

class IngestionPipeline {
    constructor(owner) {
        if (!owner) {
            throw new TypeError('IngestionPipeline requires an owner');
        }
        this.owner = owner;
        this.inFlight = new Set();
    }

    _track(operation) {
        const pending = Promise.resolve().then(operation);
        this.inFlight.add(pending);
        pending.then(
            () => this.inFlight.delete(pending),
            () => this.inFlight.delete(pending)
        );
        return pending;
    }

    async drain() {
        while (this.inFlight.size > 0) {
            await Promise.allSettled([...this.inFlight]);
        }
    }

    _queueDelete(...args) {
        return implementations._queueDelete.apply(
            this.owner,
            args
        );
    }

    _scheduleDeleteBatch(...args) {
        return implementations._scheduleDeleteBatch.apply(
            this.owner,
            args
        );
    }

    async _flushDeleteBatch(...args) {
        return await this._track(() => implementations._flushDeleteBatch.apply(
            this.owner,
            args
        ));
    }

    _scheduleBatch(...args) {
        return implementations._scheduleBatch.apply(
            this.owner,
            args
        );
    }

    async _flushBatch(...args) {
        return await this._track(() => implementations._flushBatch.apply(
            this.owner,
            args
        ));
    }

    async _handleDelete(...args) {
        return await implementations._handleDelete.apply(
            this.owner,
            args
        );
    }

    async _handleDeleteBatch(...args) {
        return await implementations._handleDeleteBatch.apply(
            this.owner,
            args
        );
    }
}

module.exports = IngestionPipeline;
