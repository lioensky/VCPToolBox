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
     * @param {number} params.tagBoost - TagMemo 增强因子 (0~1)
     */
    async discover(params) {
        const { sourceFilePath, k = 10, range = [], tagBoost = 0.15 } = params;

        // 1. 获取源文件内容与元数据
        const fullSourcePath = path.join(this.kbm.config.rootPath, sourceFilePath);
        let content;
        try {
            content = await fs.readFile(fullSourcePath, 'utf-8');
        } catch (e) {
            throw new Error(`无法读取源文件: ${e.message}`);
        }

        // 2. 检查该文件是否已在向量索引中
        const fileInDb = await this._checkFileIndexed(sourceFilePath);
        let warning = null;
        if (!fileInDb) {
            warning = "⚠️ 该文件位于屏蔽目录或尚未被扫描，将使用即时向量化进行联想。";
        }

        // 3. 获取源文件向量 (如果文件很大，取前 2000 字作为种子)
        const seedText = content.substring(0, 2000);
        const [seedVector] = await getEmbeddingsBatch([seedText], {
            apiKey: this.kbm.config.apiKey,
            apiUrl: this.kbm.config.apiUrl,
            model: this.kbm.config.model
        });

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
            // 排除源文件自身
            if (res.fullPath === sourceFilePath || path.basename(res.fullPath) === path.basename(sourceFilePath)) continue;

            const filePath = res.fullPath;
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
            source: sourceFilePath,
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
     * 检查文件是否已被索引
     */
    async _checkFileIndexed(relPath) {
        try {
            const row = this.kbm.db.prepare("SELECT id FROM files WHERE path = ?").get(relPath);
            return !!row;
        } catch (e) {
            return false;
        }
    }
}

module.exports = new AssociativeDiscovery();
