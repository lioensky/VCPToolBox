const path = require('path');
const fs = require('fs').promises;
const KnowledgeBaseManager = require('../KnowledgeBaseManager');
const { getEmbeddingsBatch } = require('../EmbeddingUtils');

/**
 * 联想发现公共模块
 * 核心能力：利用 Rust RiverMemo Topology V3 实现跨日记本的拓扑语义联想
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
     * @param {number|string} params.tagBoost - RiverMemo 源观测的 Tag 增强因子 (0~1)；兼容历史 "0.6+" 输入
     */
    async discover(params) {
        const { sourceFilePath, k = 10, range = [], tagBoost = 0.15 } = params;
        
        // 1. 归一化路径 (统一使用正斜杠进行逻辑处理)
        const normalizedSourcePath = sourceFilePath.replace(/\\/g, '/');
        console.log(`[AssociativeDiscovery] Checking file: ${normalizedSourcePath}`);

        if (!this.kbm?.db || typeof this.kbm.executeNativeRiverQuery !== 'function') {
            const error = new Error('Rust RiverMemo 尚未初始化或原生联合查询接口不可用');
            error.code = 'RIVERMEMO_UNAVAILABLE';
            throw error;
        }

        // 2. 读取源文件文本。RiverMemo 使用正文作为查询观测文本；已有首个
        // chunk 向量优先作为查询坐标，未摄取文件才调用 Embedding API。
        const fullSourcePath = path.join(this.kbm.config.rootPath, normalizedSourcePath);
        let content;
        try {
            content = await fs.readFile(fullSourcePath, 'utf-8');
        } catch (e) {
            console.error(`[AssociativeDiscovery] Failed to read source file: ${fullSourcePath}`, e);
            throw new Error(`无法读取源文件: ${e.message}`);
        }

        const seedText = content.substring(0, 2000);
        let seedVector = await this._getFileVectorFromDb(normalizedSourcePath);
        let warning = null;

        if (seedVector) {
            console.log(`[AssociativeDiscovery] Using existing vector from DB for: ${normalizedSourcePath}`);
        } else {
            console.log(`[AssociativeDiscovery] File not found in DB or no vector: ${normalizedSourcePath}`);
            warning = '⚠️ 该文件尚未被扫描或位于屏蔽目录，将使用即时向量化。';

            const [vector] = await getEmbeddingsBatch([seedText], {
                apiKey: this.kbm.config.apiKey,
                apiUrl: this.kbm.config.apiUrl,
                model: this.kbm.config.model
            });
            seedVector = vector;
        }

        if (!seedVector) {
            throw new Error('文件向量化失败，请检查 API 配置。');
        }

        // 3. RiverMemo 强制要求显式权限域。range 为空时也不使用隐式全局
        // 权限，而是从已摄取文件中枚举全部日记本。
        const requestedRange = Array.isArray(range)
            ? range.map(name => String(name || '').trim()).filter(Boolean)
            : [];
        const diaryNames = requestedRange.length > 0
            ? [...new Set(requestedRange)]
            : this.kbm.db.prepare(
                'SELECT DISTINCT diary_name FROM files WHERE diary_name IS NOT NULL ORDER BY diary_name'
            ).all()
                .map(row => String(row.diary_name || '').trim())
                .filter(Boolean);

        if (diaryNames.length === 0) {
            const error = new Error('没有可用于 RiverMemo 联想的已索引日记本');
            error.code = 'RIVERMEMO_EMPTY_DIARY_SCOPE';
            throw error;
        }

        const safeK = Math.max(1, Math.min(200, Math.floor(Number(k) || 10)));
        const searchK = Math.min(600, Math.max(safeK, safeK * 3));
        const numericTagBoost = Number.parseFloat(String(tagBoost).replace(/\+$/, ''));
        const baseTagBoost = Number.isFinite(numericTagBoost)
            ? Math.max(0, Math.min(1, numericTagBoost))
            : 0.15;

        // 4. 单次进入 Rust Native Query Plan：
        // ANN → 合并 → hydrate → 去重 → RiverMemo Topology V3/Rayon。
        const riverResult = await this.kbm.executeNativeRiverQuery(
            {
                text: seedText,
                vector: seedVector instanceof Float32Array
                    ? seedVector
                    : new Float32Array(seedVector)
            },
            {
                diaryNames,
                topK: searchK,
                sourceObservationConfig: {
                    baseTagBoost,
                    coreBoostFactor: 1.33
                },
                enabled: true,
                fallbackToLegacy: true
            }
        );
        const searchResults = Array.isArray(riverResult?.results)
            ? riverResult.results
            : [];

        // 5. 按文件进行聚合与去重 (因为返回的是 chunk 级别的结果)
        const fileMap = new Map();
        
        for (const res of searchResults) {
            // 统一使用正斜杠处理路径
            const resultPath = res.fullPath || res.sourceFile;
            if (!resultPath) continue;
            const normalizedResPath = resultPath.replace(/\\/g, '/');

            // 排除源文件自身
            if (normalizedResPath === normalizedSourcePath) continue;

            const filePath = normalizedResPath;
            const resultText = String(res.text || '');
            if (!fileMap.has(filePath)) {
                fileMap.set(filePath, {
                    path: filePath,
                    name: path.basename(filePath),
                    score: Number(res.score) || 0, // 初始分数为最高分 chunk 的分数
                    chunks: [resultText.substring(0, 200) + (resultText.length > 200 ? '...' : '')],
                    matchedTags: Array.isArray(res.matchedTags) ? [...res.matchedTags] : [],
                    tagMatchScore: Number(res.tagMatchScore) || 0,
                    riverMemo: {
                        omega: Number(res.omega) || 0,
                        regime: res.riverRegime || riverResult?.omega?.regime || null,
                        role: res.role || null,
                        topologyBonus: Number(res.topologyBonus) || 0,
                        anchorBonus: Number(res.anchorBonus) || 0
                    }
                });
            } else {
                const existing = fileMap.get(filePath);
                // 文件分数取其中最高的 RiverMemo chunk 分数。
                if ((Number(res.score) || 0) > existing.score) {
                    existing.score = Number(res.score) || 0;
                    existing.riverMemo = {
                        omega: Number(res.omega) || 0,
                        regime: res.riverRegime || riverResult?.omega?.regime || null,
                        role: res.role || null,
                        topologyBonus: Number(res.topologyBonus) || 0,
                        anchorBonus: Number(res.anchorBonus) || 0
                    };
                }
                // 收集不同 chunk 的预览
                if (existing.chunks.length < 3) {
                    existing.chunks.push(
                        resultText.substring(0, 200) + (resultText.length > 200 ? '...' : '')
                    );
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
            .slice(0, safeK);

        return {
            source: normalizedSourcePath,
            warning,
            results: finalResults,
            metadata: {
                engine: 'RiverMemo Topology V3 [Rust/Rayon]',
                nativeJointQueryUsed:
                    riverResult?.diagnostics?.nativeTopologyV3?.jointUsed === true,
                artifactSig: riverResult?.artifactSig || null,
                queryId: riverResult?.queryId || null,
                omega: Number(riverResult?.omega?.omega) || 0,
                regime: riverResult?.omega?.regime || null,
                totalChunksFound: searchResults.length,
                uniqueFilesFound: fileMap.size,
                k: safeK,
                range: requestedRange.length > 0 ? diaryNames : 'All'
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

            // 2. 获取该文件的第一个分片向量作为查询种子。
            const chunkRow = this.kbm.db.prepare(
                'SELECT id, vector FROM chunks WHERE file_id = ? ORDER BY chunk_index ASC LIMIT 1'
            ).get(fileRow.id);
            if (!chunkRow || !chunkRow.vector) return null;

            // 3. 复用 KBM 的向量解码与维度校验，避免 Buffer byteOffset、
            // 模型维度变化或损坏 BLOB 进入 Rust N-API。
            if (typeof this.kbm.getVectorByChunkId === 'function') {
                return await this.kbm.getVectorByChunkId(chunkRow.id);
            }

            const floatArray = new Float32Array(
                chunkRow.vector.buffer,
                chunkRow.vector.byteOffset,
                chunkRow.vector.byteLength / 4
            );
            return floatArray.length === Number(this.kbm.config.dimension)
                ? floatArray
                : null;
        } catch (e) {
            console.error(`[AssociativeDiscovery] DB error: ${e.message}`);
            return null;
        }
    }
}

module.exports = new AssociativeDiscovery();
