'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { chunkText } = require('../../TextChunker');
const { getEmbeddingsBatch } = require('../../EmbeddingUtils');

// 实现函数以 KnowledgeBaseManager 作为 this 执行，使状态所有权保持唯一；
// 本模块拥有摄取行为，Manager 仅保留兼容门面。
const implementations = {
_hasCompleteStoredVectorsForFile(relPath) {
        try {
            const expectedBytes = this.config.dimension * Float32Array.BYTES_PER_ELEMENT;
            const row = this.db.prepare(`
                SELECT
                    COUNT(c.id) AS chunks,
                    SUM(CASE WHEN c.vector IS NOT NULL THEN 1 ELSE 0 END) AS vectors,
                    SUM(CASE WHEN c.vector IS NOT NULL AND length(c.vector) = ? THEN 1 ELSE 0 END) AS valid_vectors,
                    SUM(CASE WHEN c.vector IS NOT NULL AND length(c.vector) != ? THEN 1 ELSE 0 END) AS bad_vectors
                FROM files f
                LEFT JOIN chunks c ON c.file_id = f.id
                WHERE f.path = ?
                GROUP BY f.id
            `).get(expectedBytes, expectedBytes, relPath);

            if (!row) return false;
            const chunks = row.chunks || 0;
            const vectors = row.vectors || 0;
            const validVectors = row.valid_vectors || 0;
            const badVectors = row.bad_vectors || 0;

            return chunks > 0 && chunks === vectors && vectors === validVectors && badVectors === 0;
        } catch (e) {
            console.warn(`[KnowledgeBase] ⚠️ Failed to check stored vectors for "${relPath}": ${e.message}`);
            return false;
        }
    },

_queueDelete(filePath) {
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
        if (this.rustWriteLease || this.indexRecoveryActive) {
            this._deferBatchForRustLease('delete');
            return;
        }
        this.isProcessingDeletes = true;

        const batchFiles = Array.from(this.pendingDeletes).slice(0, this.config.maxDeleteBatchSize);
        if (this.deleteBatchTimer) {
            clearTimeout(this.deleteBatchTimer);
            this.deleteBatchTimer = null;
        }

        try {
            await this._handleDeleteBatch(batchFiles);
            batchFiles.forEach(f => this.pendingDeletes.delete(f));
        } catch (e) {
            console.error('[KnowledgeBase] ❌ Delete batch failed:', e);
            if (this._isSqliteCorruptionError(e)) {
                await this._handleRuntimeSqliteCorruption(e, []);
            }
        } finally {
            this.isProcessingDeletes = false;
            this.lastJsWriteFinishedAt = Date.now();
            if (!this.databaseCorruptionDetected && this.pendingDeletes.size > 0) {
                setImmediate(() => this._flushDeleteBatch());
            }
        }
    },

_scheduleBatch() {
        // 固定收集窗口：首个文件启动计时，后续文件只加入 pendingFiles，
        // 不重置截止时间，避免持续写入导致索引任务无限延期。
        if (this.batchTimer) return;
        this.batchTimer = setTimeout(() => {
            this.batchTimer = null;
            this._flushBatch();
        }, this.config.batchWindow);
    },

async _flushBatch() {
        if (this.isProcessing || this.pendingFiles.size === 0) return;
        if (this.externalMutationActive) {
            this.externalMutationBatchDeferred = true;
            return;
        }
        if (this.rustWriteLease || this.indexRecoveryActive) {
            this._deferBatchForRustLease('batch');
            return;
        }
        this.isProcessing = true;

        // 1. 📋 准备批次：先从队列中取出，但不立即永久删除
        const batchFiles = Array.from(this.pendingFiles).slice(0, this.config.maxBatchSize);
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }

        console.log(`[KnowledgeBase] 🚌 Processing ${batchFiles.length} files...`);

        try {
            // 1. 解析文件并按日记本分组
            const docsByDiary = new Map(); // Map<DiaryName, Array<Doc>>
            const unstableFiles = new Set();
            const checkFile = this.db.prepare('SELECT checksum, mtime, size FROM files WHERE path = ?');

            await Promise.all(batchFiles.map(async (filePath) => {
                try {
                    const stats = await fs.stat(filePath);
                    const relPath = path.relative(this.config.rootPath, filePath);
                    const parts = relPath.split(path.sep);
                    const diaryName = parts.length > 1 ? parts[0] : 'Root';

                    const row = checkFile.get(relPath);
                    if (row && row.mtime === stats.mtimeMs && row.size === stats.size && this._hasCompleteStoredVectorsForFile(relPath)) return;

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

                    if (row && row.checksum === checksum && this._hasCompleteStoredVectorsForFile(relPath)) {
                        this.db.prepare('UPDATE files SET mtime = ?, size = ? WHERE path = ?').run(stats.mtimeMs, stats.size, relPath);
                        return;
                    }

                    if (!docsByDiary.has(diaryName)) docsByDiary.set(diaryName, []);
                    docsByDiary.get(diaryName).push({
                        relPath, diaryName, checksum, mtime: stats.mtimeMs, size: stats.size,
                        chunks: chunkText(content),
                        tags: this._extractTags(content)
                    });
                } catch (e) { if (e.code !== 'ENOENT') console.warn(`Read error ${filePath}:`, e.message); }
            }));

            if (docsByDiary.size === 0) {
                // 稳定且无变更的文件可安全出队；读取期间变化的文件必须保留并重试。
                batchFiles.forEach(f => {
                    if (unstableFiles.has(f)) return;
                    this.pendingFiles.delete(f);
                    this.fileRetryCount.delete(f);
                });
                this.isProcessing = false;
                return;
            }

            // 2. 收集所有文本进行 Embedding
            const allChunksWithMeta = [];
            const uniqueTags = new Set();

            let reusedChunkVectorCount = 0;
            for (const [dName, docs] of docsByDiary) {
                docs.forEach((doc, dIdx) => {
                    const validChunks = doc.chunks.map(c => this._prepareTextForEmbedding(c)).filter(c => c !== '[EMPTY_CONTENT]');
                    doc.chunks = validChunks;

                    const reusableVectors = this._findReusableChunkVectors(doc);
                    if (reusableVectors) {
                        doc.reusedChunkVectors = reusableVectors;
                        doc.migrationCacheId = reusableVectors._migrationCacheId || null;
                        reusedChunkVectorCount += reusableVectors.length;
                    } else {
                        validChunks.forEach((txt, cIdx) => {
                            allChunksWithMeta.push({ text: txt, diaryName: dName, doc: doc, chunkIdx: cIdx });
                        });
                    }

                    doc.tags.forEach(t => uniqueTags.add(t));
                });
            }

            if (reusedChunkVectorCount > 0) {
                console.log(`[KnowledgeBase] ♻️ Reused ${reusedChunkVectorCount} chunk vector(s) from SQLite cache; skipped embedding for matching moved/copied content.`);
            }

            // Tag 处理
            const newTagsSet = new Set();
            const tagCache = new Map();
            const checkTag = this.db.prepare('SELECT id, vector FROM tags WHERE name = ?');
            for (const t of uniqueTags) {
                const row = checkTag.get(t);
                if (row && row.vector) tagCache.set(t, { id: row.id, vector: row.vector });
                else {
                    const cleanedTag = this._prepareTextForEmbedding(t);
                    if (cleanedTag !== '[EMPTY_CONTENT]') newTagsSet.add(cleanedTag);
                }
            }

            const newTags = Array.from(newTagsSet);
            // 3. Embedding API Calls
            const embeddingConfig = { apiKey: this.config.apiKey, apiUrl: this.config.apiUrl, model: this.config.model };

            let chunkVectors = [];
            if (allChunksWithMeta.length > 0) {
                const texts = allChunksWithMeta.map(i => i.text);
                chunkVectors = await getEmbeddingsBatch(texts, embeddingConfig);
                // 🛡️ getEmbeddingsBatch 现在保证 chunkVectors.length === texts.length
                // 失败/超长的位置为 null，后续写入 DB 时会跳过这些 null 向量
            }

            let tagVectors = [];
            if (newTags.length > 0) {
                const tagLimit = 100;
                for (let i = 0; i < newTags.length; i += tagLimit) {
                    const batch = newTags.slice(i, i + tagLimit);
                    const batchVectors = await getEmbeddingsBatch(batch, embeddingConfig);
                    // 同样保证长度对齐，null 表示失败
                    tagVectors.push(...batchVectors);
                }
            }

            // 4. 写入 DB 和 索引
            const transaction = this.db.transaction(() => {
                const updates = new Map();
                const deletions = new Map(); // 💡 新增：记录待删除的 chunk ID
                const tagUpdates = [];
                const newTagIds = [];

                const insertTag = this.db.prepare('INSERT INTO tags (name, vector) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET vector = excluded.vector');
                const getTagId = this.db.prepare('SELECT id FROM tags WHERE name = ?');
                // V9.1 向量更新失效钩子 — 正值、负缓存和处理状态必须一起失效，
                // 由 Rust 增量补回，防止陈旧 artifact 或 below_threshold 状态掩盖重算。
                const invalidatePairSim = this.db.prepare(
                    'DELETE FROM tag_pair_similarity WHERE tag_a = ? OR tag_b = ?'
                );
                const invalidatePairSimStatus = this.db.prepare(
                    'DELETE FROM tag_pair_similarity_status WHERE tag_a = ? OR tag_b = ?'
                );
                const invalidateIntrinsicResidual = this.db.prepare(
                    'DELETE FROM tag_intrinsic_residuals WHERE tag_id = ?'
                );
                const invalidateIntrinsicResidualStatus = this.db.prepare(
                    'DELETE FROM tag_intrinsic_residual_status WHERE tag_id = ?'
                );

                newTags.forEach((t, i) => {
                    if (!tagVectors[i]) return; // 🛡️ 跳过向量化失败的 tag
                    const vecFloat = new Float32Array(tagVectors[i]);
                    const vecBuf = Buffer.from(vecFloat.buffer, vecFloat.byteOffset, vecFloat.byteLength);
                    insertTag.run(t, vecBuf);
                    const id = getTagId.get(t).id;
                    tagCache.set(t, { id, vector: vecBuf });
                    tagUpdates.push({ id, vec: vecFloat });
                    newTagIds.push(id);
                    // 失效旧的 pairwise similarity / intrinsic residual 记录及其状态缓存
                    invalidatePairSim.run(id, id);
                    invalidatePairSimStatus.run(id, id);
                    invalidateIntrinsicResidual.run(id);
                    invalidateIntrinsicResidualStatus.run(id);
                });

                const insertFile = this.db.prepare('INSERT INTO files (path, diary_name, checksum, mtime, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
                const updateFile = this.db.prepare('UPDATE files SET checksum = ?, mtime = ?, size = ?, updated_at = ?, diary_name = ? WHERE id = ?');
                const getFile = this.db.prepare('SELECT id, diary_name FROM files WHERE path = ?');
                const getOldChunkIds = this.db.prepare('SELECT id FROM chunks WHERE file_id = ?'); // 💡 新增
                const delChunks = this.db.prepare('DELETE FROM chunks WHERE file_id = ?');
                const delRels = this.db.prepare('DELETE FROM file_tags WHERE file_id = ?');
                const addChunk = this.db.prepare('INSERT INTO chunks (file_id, chunk_index, content, vector) VALUES (?, ?, ?, ?)');
                const addRel = this.db.prepare('INSERT OR IGNORE INTO file_tags (file_id, tag_id, position) VALUES (?, ?, ?)');
                const consumeMigrationCache = this.db.prepare('DELETE FROM migration_deleted_files WHERE id = ?');

                // 在事务前构建索引
                const metaMap = new Map();
                allChunksWithMeta.forEach((meta, i) => {
                    meta.vector = chunkVectors[i];
                    // meta.doc 和 root meta.chunkIdx 是唯一标识一个 chunk的特征属性
                    const key = `${meta.doc.relPath}:${meta.chunkIdx}`;
                    metaMap.set(key, meta);
                });

                for (const [dName, docs] of docsByDiary) {
                    if (!updates.has(dName)) updates.set(dName, []);

                    docs.forEach(doc => {
                        let fileId;
                        const fRow = getFile.get(doc.relPath);
                        const now = Math.floor(Date.now() / 1000);

                        if (fRow) {
                            fileId = fRow.id;

                            // 💡 核心修复：在删除数据库记录前，先收集旧 chunk ID 用于后续的索引清理
                            const oldChunkIds = getOldChunkIds.all(fileId).map(c => c.id);
                            if (oldChunkIds.length > 0) {
                                if (!deletions.has(dName)) deletions.set(dName, []);
                                deletions.get(dName).push(...oldChunkIds);
                            }

                            if (fRow.diary_name !== doc.diaryName) {
                                if (!deletions.has(fRow.diary_name)) deletions.set(fRow.diary_name, []);
                                deletions.get(fRow.diary_name).push(...oldChunkIds);
                            }

                            updateFile.run(doc.checksum, doc.mtime, doc.size, now, doc.diaryName, fileId);
                            delChunks.run(fileId);
                            delRels.run(fileId);
                        } else {
                            const res = insertFile.run(doc.relPath, doc.diaryName, doc.checksum, doc.mtime, doc.size, now);
                            fileId = res.lastInsertRowid;
                        }

                        doc.chunks.forEach((txt, i) => {
                            const meta = metaMap.get(`${doc.relPath}:${i}`);
                            const vectorSource = doc.reusedChunkVectors?.[i] || meta?.vector;
                            if (vectorSource) { // 🛡️ null 向量的 chunk 自然被跳过，不会写入错误数据
                                const vecFloat = vectorSource instanceof Float32Array ? vectorSource : new Float32Array(vectorSource);
                                const vecBuf = Buffer.from(vecFloat.buffer, vecFloat.byteOffset, vecFloat.byteLength);
                                const r = addChunk.run(fileId, i, txt, vecBuf);
                                updates.get(dName).push({ id: r.lastInsertRowid, vec: vecFloat });
                            }
                        });

                        doc.tags.forEach((t, index) => {
                            const tInfo = tagCache.get(t);
                            if (tInfo) {
                                addRel.run(fileId, tInfo.id, index + 1);
                            }
                        });

                        if (doc.migrationCacheId) {
                            consumeMigrationCache.run(doc.migrationCacheId);
                        }
                    });
                }

                return { updates, tagUpdates, deletions, newTagIds };
            });

            const { updates, tagUpdates, deletions, newTagIds } = transaction();

            // 💡 核心修复：在添加新向量之前，先从 Vexus 索引中移除所有旧的向量
            if (deletions && deletions.size > 0) {
                for (const [dName, chunkIds] of deletions) {
                    const idx = await this._getOrLoadDiaryIndex(dName, { allowJsProcessing: true });
                    if (idx && idx.remove) {
                        chunkIds.forEach(id => {
                            try {
                                idx.remove(id);
                            } catch (e) {
                                // usearch 对不存在的 id 可能抛错；删除路径必须保持幂等，避免批处理重试循环。
                                if (e.message && !/not found|missing|absent/i.test(e.message)) {
                                    console.warn(`[KnowledgeBase] ⚠️ Failed to remove stale vector ${id} from "${dName}": ${e.message}`);
                                }
                            }
                        });
                        this._scheduleIndexSave(dName);
                    }
                }
            }

            // 🛠️ 修复：针对 Tag Index 的安全写入
            tagUpdates.forEach(u => {
                try {
                    this.tagIndex.add(u.id, u.vec);
                } catch (e) {
                    if (e.message && e.message.includes('Duplicate')) {
                        try {
                            if (this.tagIndex.remove) this.tagIndex.remove(u.id);
                            this.tagIndex.add(u.id, u.vec);
                        } catch (retryErr) {
                            console.error(`[KnowledgeBase] ❌ Failed to upsert tag ${u.id}:`, retryErr.message);
                        }
                    }
                }
            });
            this._scheduleIndexSave('global_tags');

            // 🛠️ 修复：针对 Diary Index 的安全写入
            for (const [dName, chunks] of updates) {
                const idx = await this._getOrLoadDiaryIndex(dName, { allowJsProcessing: true });

                chunks.forEach(u => {
                    try {
                        // 尝试直接添加
                        idx.add(u.id, u.vec);
                    } catch (e) {
                        // 捕获 "Duplicate keys" 错误
                        if (e.message && e.message.includes('Duplicate')) {
                            // console.warn(`[KnowledgeBase] ⚠️ ID Collision detected for ${u.id} in ${dName}. Performing upsert.`);
                            try {
                                // 策略：先移除冲突的 ID，再重新添加 (Upsert)
                                if (idx.remove) idx.remove(u.id);
                                idx.add(u.id, u.vec);
                            } catch (retryErr) {
                                console.error(`[KnowledgeBase] ❌ Failed to upsert vector ${u.id} in ${dName}:`, retryErr.message);
                            }
                        } else {
                            // 如果是其他错误（如维度不对），则抛出
                            console.error(`[KnowledgeBase] ❌ Vector add error detected:`, e);
                        }
                    }
                });

                this._scheduleIndexSave(dName);
            }

            // 5. ✅ 成功处理后，移除文件并清空重试计数
            batchFiles.forEach(f => {
                if (unstableFiles.has(f)) return;
                this.pendingFiles.delete(f);
                this.fileRetryCount.delete(f); // 清空重试计数
            });

            for (const dName of updates.keys()) {
                this.invalidateDiaryDateIndex(dName);
                if (this.diaryIndices.has(dName)) {
                    this._ensureDiaryDateIndexCached(dName);
                }
            }

            console.log(`[KnowledgeBase] ✅ Batch complete. Updated ${updates.size} diary indices.`);

            // 数据更新后，检查是否需要重建 V9.1 矩阵（防抖 + 阈值）。
            // 使用“成功新增的唯一 tag id”累计触发 1% 阈值；
            // file_tags 组关系仍是共现矩阵真相，但不再作为“新增 1% tag”的计数依据。
            if (this.tagMemoEngine) this.tagMemoEngine.scheduleMatrixRebuildForNewTags(newTagIds);

        } catch (e) {
            console.error('[KnowledgeBase] ❌ Batch processing failed catastrophically.');
            console.error('Error Details:', e);
            if (e.stack) {
                console.error('Stack Trace:', e.stack);
            }

            if (this._isSqliteCorruptionError(e)) {
                await this._handleRuntimeSqliteCorruption(e, batchFiles);
            } else {
                // 🛡️ 核心修复：重试计数，防止确定性失败导致无限循环
                const MAX_FILE_RETRIES = 3;
                batchFiles.forEach(f => {
                    const count = (this.fileRetryCount.get(f) || 0) + 1;
                    if (count >= MAX_FILE_RETRIES) {
                        console.error(`[KnowledgeBase] ⛔ File "${f}" failed ${MAX_FILE_RETRIES} times. Removing from queue permanently.`);
                        this.pendingFiles.delete(f);
                        this.fileRetryCount.delete(f);
                    } else {
                        this.fileRetryCount.set(f, count);
                        console.warn(`[KnowledgeBase] ⚠️ File "${f}" retry ${count}/${MAX_FILE_RETRIES}.`);
                    }
                });
            }
        }
        finally {
            this.isProcessing = false;
            this.lastJsWriteFinishedAt = Date.now();
            if (!this.databaseCorruptionDetected && this.pendingFiles.size > 0) setImmediate(() => this._flushBatch());
        }
    },

async _handleDelete(filePath) {
        await this._handleDeleteBatch([filePath]);
    },

async _handleDeleteBatch(filePaths) {
        const relPaths = [...new Set(filePaths.map(filePath => path.relative(this.config.rootPath, filePath)))];
        if (relPaths.length === 0) return;

        try {
            const rows = this._queryByChunks(
                'SELECT id, path, diary_name, checksum, size FROM files WHERE path',
                relPaths
            );
            if (rows.length === 0) return;

            const fileIds = rows.map(row => row.id);
            const diaryByFileId = new Map(rows.map(row => [row.id, row.diary_name]));
            const chunkRows = this._queryByChunks(
                'SELECT c.id, c.file_id, c.chunk_index, c.vector, f.diary_name FROM chunks c JOIN files f ON c.file_id = f.id WHERE c.file_id',
                fileIds
            );

            const chunkIdsByDiary = new Map();
            for (const row of chunkRows) {
                const diaryName = row.diary_name || diaryByFileId.get(row.file_id);
                if (!diaryName) continue;
                if (!chunkIdsByDiary.has(diaryName)) chunkIdsByDiary.set(diaryName, []);
                chunkIdsByDiary.get(diaryName).push(row.id);
            }

            const deleteTransaction = this.db.transaction(() => {
                // 墓碑与主记录删除必须处于同一个 SQLite 事务；
                // 具体表结构和写入语义由 MigrationVectorCache 独占维护。
                this.migrationVectorCache.cacheDeletedFiles(
                    rows,
                    chunkRows,
                    Date.now()
                );

                const deleteFileTags = (ids) => {
                    if (ids.length === 0) return;
                    const placeholders = ids.map(() => '?').join(',');
                    this.db.prepare(`DELETE FROM file_tags WHERE file_id IN (${placeholders})`).run(...ids);
                };
                const deleteChunks = (ids) => {
                    if (ids.length === 0) return;
                    const placeholders = ids.map(() => '?').join(',');
                    this.db.prepare(`DELETE FROM chunks WHERE file_id IN (${placeholders})`).run(...ids);
                };
                const deleteFiles = (ids) => {
                    if (ids.length === 0) return;
                    const placeholders = ids.map(() => '?').join(',');
                    this.db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...ids);
                };

                for (let i = 0; i < fileIds.length; i += 500) {
                    const batch = fileIds.slice(i, i + 500);
                    // 🛡️ 不依赖 SQLite 外键级联：历史数据库/连接若未开启 foreign_keys，会留下 file_tags/chunks 垃圾。
                    deleteFileTags(batch);
                    deleteChunks(batch);
                    deleteFiles(batch);
                }
            });
            deleteTransaction();

            let totalChunks = 0;
            for (const chunkIds of chunkIdsByDiary.values()) totalChunks += chunkIds.length;

            if (rows.length > 1) {
                console.warn(`[KnowledgeBase] 🧹 Batched delete removed ${rows.length} file record(s), ${totalChunks} chunk vector(s).`);
            }

            for (const diaryName of chunkIdsByDiary.keys()) {
                this.invalidateDiaryDateIndex(diaryName);
            }

            for (const [diaryName, chunkIds] of chunkIdsByDiary) {
                if (chunkIds.length >= this.config.deleteRebuildThreshold) {
                    // 大目录删除时逐个 remove 上万向量会长时间阻塞事件循环；直接丢弃该日记索引，后续从 SQLite 干净重建。
                    this.diaryIndices.delete(diaryName);
                    this.diaryIndexLastUsed.delete(diaryName);
                    this._deletePersistedDiaryIndex(diaryName);
                    console.warn(
                        `[KnowledgeBase] 🧹 Large delete in "${diaryName}" (${chunkIds.length} vectors). ` +
                        'Dropped in-memory/persisted diary index; it will be rebuilt from SQLite on next search.'
                    );
                    continue;
                }

                const idx = await this._getOrLoadDiaryIndex(diaryName, { allowJsDeleteProcessing: true });
                if (idx && idx.remove) {
                    chunkIds.forEach(id => {
                        try {
                            idx.remove(id);
                        } catch (e) {
                            // 删除事件可能乱序/重复；向量不存在不应导致错误风暴或后续处理停滞。
                            if (e.message && !/not found|missing|absent/i.test(e.message)) {
                                console.warn(`[KnowledgeBase] ⚠️ Failed to remove vector ${id} from "${diaryName}": ${e.message}`);
                            }
                        }
                    });
                    this._scheduleIndexSave(diaryName);
                }
            }
        } catch (e) {
            console.error(`[KnowledgeBase] Delete error:`, e);
            if (this._isSqliteCorruptionError(e)) throw e;
        }
    }
};

class IngestionPipeline {
    constructor(owner) {
        if (!owner) {
            throw new TypeError('IngestionPipeline requires an owner');
        }
        this.owner = owner;
    }

    _hasCompleteStoredVectorsForFile(...args) {
        return implementations._hasCompleteStoredVectorsForFile.apply(
            this.owner,
            args
        );
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
        return await implementations._flushDeleteBatch.apply(
            this.owner,
            args
        );
    }

    _scheduleBatch(...args) {
        return implementations._scheduleBatch.apply(
            this.owner,
            args
        );
    }

    async _flushBatch(...args) {
        return await implementations._flushBatch.apply(
            this.owner,
            args
        );
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
