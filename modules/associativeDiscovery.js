const path = require('path');
const fs = require('fs').promises;
const KnowledgeBaseManager = require('../KnowledgeBaseManager');
const { getEmbeddingsBatch } = require('../EmbeddingUtils');

/**
 * 联想发现公共模块
 * 核心能力：利用向量数据库与 TagMemo 算法实现跨日记本的语义联想
 */
class AssociativeDiscovery {
    constructor() {
        this.kbm = KnowledgeBaseManager;
    }

    /**
     * 执行联想追溯
     * @param {Object} params
     * @param {string} params.sourceFilePath - 源文件相对路径 (相对于 dailynote 根目录)
     * @param {number} params.k - 联想深度 (召回数量)
     * @param {string[]} params.range - 联想范围 (文件夹名称列表，为空表示全局)
     * @param {number|string} params.tagBoost - TagMemo 增强因子 (0~1)。传入 "0.6+" 后缀可启用浪潮 v8 测地线重排
     */
    async discover(params) {
        const { sourceFilePath, k = 10, range = [], tagBoost = 0.15 } = params;
        
        // 1. 归一化路径 (统一使用正斜杠进行逻辑处理)
        const normalizedSourcePath = sourceFilePath.replace(/\\/g, '/');
        console.log(`[AssociativeDiscovery] Checking file: ${normalizedSourcePath}`);

        // 2. 检查该文件是否已在向量索引中并尝试获取已有向量
        let seedVector = null;
        let warning = null;
        
        // 使用归一化后的路径去数据库查找 (内部会处理斜杠差异)
        const existingVector = await this._getFileVectorFromDb(normalizedSourcePath);
        if (existingVector) {
            seedVector = existingVector;
            console.log(`[AssociativeDiscovery] Using existing vector from DB for: ${normalizedSourcePath}`);
        } else {
            console.log(`[AssociativeDiscovery] File not found in DB or no vector: ${normalizedSourcePath}`);
            warning = "⚠️ 该文件尚未被扫描或位于屏蔽目录，将使用即时向量化。";
            
            // 获取源文件内容进行即时向量化
            const fullSourcePath = path.join(this.kbm.config.rootPath, normalizedSourcePath);
            let content;
            try {
                content = await fs.readFile(fullSourcePath, 'utf-8');
            } catch (e) {
                console.error(`[AssociativeDiscovery] Failed to read source file: ${fullSourcePath}`, e);
                throw new Error(`无法读取源文件: ${e.message}`);
            }

            const seedText = content.substring(0, 2000);
            const [vector] = await getEmbeddingsBatch([seedText], {
                apiKey: this.kbm.config.apiKey,
                apiUrl: this.kbm.config.apiUrl,
                model: this.kbm.config.model
            });
            seedVector = vector;
        }

        if (!seedVector) {
            throw new Error("文件向量化失败，请检查 API 配置。");
        }

        // 4. 执行多路搜索
        let searchResults = [];
        const searchK = k * 3; // 扩大召回范围以便后续按文件去重

        if (range && range.length > 0) {
            // 指定范围搜索
            const rangePromises = range.map(diaryName => 
                this.kbm.search(diaryName, seedVector, searchK, tagBoost)
            );
            const nestedResults = await Promise.all(rangePromises);
            searchResults = nestedResults.flat();
        } else {
            // 全局搜索
            searchResults = await this.kbm.search(seedVector, searchK, tagBoost);
        }

        // 5. 按文件进行聚合与去重 (因为返回的是 chunk 级别的结果)
        const fileMap = new Map();
        
        for (const res of searchResults) {
            // 统一使用正斜杠处理路径
            const normalizedResPath = res.fullPath.replace(/\\/g, '/');
            const normalizedSourcePath = sourceFilePath.replace(/\\/g, '/');
            
            // 排除源文件自身
            if (normalizedResPath === normalizedSourcePath) continue;

            const filePath = normalizedResPath;
            if (!fileMap.has(filePath)) {
                fileMap.set(filePath, {
                    path: filePath,
                    name: res.sourceFile,
                    score: res.score, // 初始分数为最高分 chunk 的分数
                    chunks: [res.text.substring(0, 200) + '...'],
                    matchedTags: res.matchedTags || [],
                    tagMatchScore: res.tagMatchScore || 0
                });
            } else {
                const existing = fileMap.get(filePath);
                // 简单的评分聚合逻辑：取最大值 (也可以根据需求改为均值或加权)
                if (res.score > existing.score) {
                    existing.score = res.score;
                }
                // 收集不同 chunk 的预览
                if (existing.chunks.length < 3) {
                    existing.chunks.push(res.text.substring(0, 200) + '...');
                }
                // 合并匹配到的标签
                if (res.matchedTags) {
                    res.matchedTags.forEach(t => {
                        if (!existing.matchedTags.includes(t)) {
                            existing.matchedTags.push(t);
                        }
                    });
                }
            }
        }

        // 6. 排序并按 K 截断
        const finalResults = Array.from(fileMap.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, k);

        return {
            source: sourceFilePath.replace(/\\/g, '/'),
            warning,
            results: finalResults,
            metadata: {
                totalChunksFound: searchResults.length,
                uniqueFilesFound: fileMap.size,
                k: k,
                range: range.length > 0 ? range : 'All'
            }
        };
    }

    /**
     * 从数据库获取文件的已有向量
     */
    async _getFileVectorFromDb(relPath) {
        try {
            // 1. 准备路径变体以兼容不同系统的存储格式 (并确保能命中数据库索引)
            const variants = [
                relPath,                        // 原始路径
                relPath.replace(/\\/g, '/'),    // 强制正斜杠 (Linux/Web 风格)
                relPath.replace(/\//g, '\\')    // 强制反斜杠 (Windows 风格)
            ];
            
            // 去重
            const uniqueVariants = [...new Set(variants)];
            
            let fileRow = null;
            const stmt = this.kbm.db.prepare("SELECT id FROM files WHERE path = ?");
            
            // 依次尝试，直到命中索引
            for (const variant of uniqueVariants) {
                fileRow = stmt.get(variant);
                if (fileRow) {
                    console.log(`[AssociativeDiscovery] DB hit with variant: ${variant}`);
                    break;
                }
            }

            if (!fileRow) return null;

            // 2. 获取该文件的第一个分片的向量 (作为种子向量)
            const chunkRow = this.kbm.db.prepare("SELECT vector FROM chunks WHERE file_id = ? ORDER BY chunk_index ASC LIMIT 1").get(fileRow.id);
            if (!chunkRow || !chunkRow.vector) return null;

            // 3. 解析向量 (SQLite 存储为 BLOB/Buffer)
            const floatArray = new Float32Array(
                chunkRow.vector.buffer,
                chunkRow.vector.byteOffset,
                chunkRow.vector.byteLength / 4
            );
            return Array.from(floatArray);
        } catch (e) {
            console.error(`[AssociativeDiscovery] DB error: ${e.message}`);
            return null;
        }
    }
}

module.exports = new AssociativeDiscovery();
