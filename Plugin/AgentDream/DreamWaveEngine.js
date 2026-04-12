// Plugin/AgentDream/DreamWaveEngine.js
// 记忆涟漪浪潮引擎 - 实现基于多级时间线和共振的梦境召回
// 🌊 核心算法: 种子记忆 → L0联想 → L1共振桥梁 → L2下探 → 深渊浪潮
// 🔑 设计原则: 纯本地向量操作，零网络依赖

const fsPromises = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const DREAM_MAX_RECALL_TOKENS = parseInt(process.env.DREAM_MAX_RECALL_TOKENS || '60000', 10);
const DAILY_NOTE_ROOT = process.env.KNOWLEDGEBASE_ROOT_PATH ||
    (process.env.PROJECT_BASE_PATH ? path.join(process.env.PROJECT_BASE_PATH, 'dailynote') : path.join(__dirname, '..', '..', 'dailynote'));

// 时间桶初始边界（天）— 设计规范
const INITIAL_RECENT_DAYS = 7;      // 近期初始: 0~7天
const INITIAL_MID_DAYS = 90;        // 中期初始: 7天~90天
// 深远: 90天+
// 弹性放宽步长
const RECENT_EXPAND_STEP = 7;       // 近期每次放宽7天
const RECENT_EXPAND_MAX = 30;       // 近期最多放宽到30天
const MID_EXPAND_STEP = 30;         // 中期每次放宽30天
const MID_EXPAND_MAX = 180;         // 中期最多放宽到180天

class DreamWaveEngine {
    constructor(knowledgeBaseManager) {
        this.kb = knowledgeBaseManager;
        this.db = knowledgeBaseManager ? knowledgeBaseManager.db : null;
    }

    // =========================================================================
    // 工具方法
    // =========================================================================

    /**
     * 优雅截断字符串，确保不超 token，同时尽量不截断半句话
     */
    _truncateContent(content, maxChars) {
        if (!content || content.length <= maxChars) return content;
        const truncated = content.substring(0, maxChars);
        const lastPunctuation = Math.max(
            truncated.lastIndexOf('。'), truncated.lastIndexOf('！'),
            truncated.lastIndexOf('？'), truncated.lastIndexOf('\n')
        );
        if (lastPunctuation > maxChars * 0.8) {
            return truncated.substring(0, lastPunctuation + 1) + '\n... [部分记忆由于潜意识模糊已丢失]';
        }
        return truncated + '... [部分记忆由于潜意识模糊已丢失]';
    }

    /**
     * 随机抽取数组里的 N 个元素
     */
    _sample(array, count) {
        if (!array || array.length === 0) return [];
        if (array.length <= count) return array.slice();
        const shuffled = array.slice().sort(() => 0.5 - Math.random());
        return shuffled.slice(0, count);
    }

    /**
     * 根据内容长度决定 k 值 (3, 5, 或 7) — 3/5/7 原则
     * 短记忆联想少，长记忆联想多
     */
    _determineK(contentLen) {
        if (contentLen < 300) return 3;
        if (contentLen < 1200) return 5;
        return 7;
    }

    /**
     * 从日记正文头部提取署名
     * 格式: [2026-03-23] - Nova  →  返回 "Nova"
     * 格式: [2026-03-23] - 可可  →  返回 "可可"
     * 无署名返回 null
     */
    _extractAuthor(contentHead) {
        if (!contentHead) return null;
        // 匹配第一行的 "- 署名" 部分
        // 支持: [日期] - 名字 / [日期] — 名字 / [日期]-名字
        const match = contentHead.match(/\]\s*[-—]\s*(.+?)[\s\n\r]/);
        if (match && match[1]) {
            return match[1].trim();
        }
        // 也尝试匹配没有方括号的格式: 2026-03-23 - Nova
        const match2 = contentHead.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*[-—]\s*(.+?)[\s\n\r]/);
        if (match2 && match2[1]) {
            return match2[1].trim();
        }
        return null;
    }

    /**
     * 检查一篇日记是否属于指定 agent（通过署名判断）
     * 对于 agent 专属文件夹里的日记，默认属于该 agent
     * 对于公共文件夹里的日记，需要检查署名
     */
    async _isDiaryBelongsToAgent(filePath, agentName) {
        // 判断文件是否在公共文件夹中
        const relToRoot = path.relative(DAILY_NOTE_ROOT, filePath);
        const topDir = relToRoot.split(path.sep)[0] || '';

        // 如果在 agent 专属文件夹中，直接属于该 agent
        if (topDir === agentName || topDir.includes(agentName)) {
            return true;
        }

        // 如果在公共文件夹中，检查署名
        if (topDir.startsWith('公共')) {
            try {
                const fd = await fsPromises.open(filePath, 'r');
                const buffer = Buffer.alloc(256);
                const { bytesRead } = await fd.read(buffer, 0, 256, 0);
                await fd.close();
                const head = buffer.toString('utf-8', 0, bytesRead);
                const author = this._extractAuthor(head);
                // 署名包含 agent 名字即可（模糊匹配，如 "Nova" 匹配 "Nova"）
                if (author && author.includes(agentName)) {
                    return true;
                }
                // 无署名的公共日记也算（可能是共享知识）
                if (!author) {
                    return true;
                }
                return false;
            } catch (e) {
                return true; // 读取失败时宽容处理
            }
        }

        // 其他文件夹，默认不属于
        return false;
    }

    // =========================================================================
    // 日记文件夹发现
    // =========================================================================

    /**
     * 获取 agent 的种子日记本文件夹名列表（用于文件扫描）
     * 包含: agentName 本身、包含 agentName 的文件夹、公共文件夹
     */
    _getSeedDiaryDirs(agentName) {
        const names = [agentName];
        try {
            const dirs = fsSync.readdirSync(DAILY_NOTE_ROOT, { withFileTypes: true });
            for (const dir of dirs) {
                if (!dir.isDirectory()) continue;
                if (dir.name.includes(agentName) && dir.name !== agentName) {
                    names.push(dir.name);
                }
                if (dir.name.startsWith('公共')) {
                    names.push(dir.name);
                }
            }
        } catch (e) { /* 忽略 */ }
        return Array.from(new Set(names));
    }

    /**
     * 获取 agent 可搜索的所有日记本索引名（用于向量召回）
     */
    _getSearchableIndexNames(agentName) {
        // 与 _getSeedDiaryDirs 相同逻辑
        return this._getSeedDiaryDirs(agentName);
    }

    // =========================================================================
    // 动态时间桶分类
    // =========================================================================

    /**
     * 获取指定 agent 的所有日记文件，按动态时间桶分类
     * 
     * 核心逻辑：
     * 1. 初始边界: 近期=7天, 中期=7~90天, 深远=90天+
     * 2. 如果近期不够3篇，放宽近期边界（+7天步进，最多30天）
     * 3. 放宽后中期起点跟着动: 近期放宽到14天 → 中期从15天开始
     * 4. 如果中期不够2篇，放宽中期边界（+30天步进，最多180天）
     * 5. 放宽后深远起点跟着动: 中期放宽到120天 → 深远从121天开始
     */
    async _getTimelineBuckets(agentName) {
        const seedDirs = this._getSeedDiaryDirs(agentName);
        const targetDirs = seedDirs.map(name => path.join(DAILY_NOTE_ROOT, name));
        let allFiles = [];

        // 收集所有日记文件
        for (const diaryDir of targetDirs) {
            try {
                const entries = await fsPromises.readdir(diaryDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isFile() && /\.(txt|md)$/i.test(entry.name)) {
                        allFiles.push({ dir: diaryDir, name: entry.name });
                    } else if (entry.isDirectory()) {
                        try {
                            const subEntries = await fsPromises.readdir(path.join(diaryDir, entry.name));
                            for (const subFile of subEntries) {
                                if (/\.(txt|md)$/i.test(subFile)) {
                                    allFiles.push({ dir: path.join(diaryDir, entry.name), name: subFile });
                                }
                            }
                        } catch (e) { /* 忽略 */ }
                    }
                }
            } catch (e) { /* 忽略不存在的文件夹 */ }
        }

        if (allFiles.length === 0) {
            return { recent: [], mid: [], deep: [], recentBoundary: INITIAL_RECENT_DAYS, midBoundary: INITIAL_MID_DAYS };
        }

        // 解析所有文件的时间和署名
        const now = Date.now();
        const dateRegex = /(\d{4})[-_年]?(\d{1,2})[-_月]?(\d{1,2})/;
        const parsedFiles = [];

        for (const fileObj of allFiles) {
            const absFilePath = path.join(fileObj.dir, fileObj.name);
            try {
                const stat = await fsPromises.stat(absFilePath);
                let recordTimeMs = stat.mtimeMs;

                // 读取正文头部匹配日期和署名
                let contentHead = '';
                try {
                    const fd = await fsPromises.open(absFilePath, 'r');
                    const buffer = Buffer.alloc(256);
                    const { bytesRead } = await fd.read(buffer, 0, 256, 0);
                    await fd.close();
                    contentHead = buffer.toString('utf-8', 0, bytesRead);

                    const match = contentHead.match(dateRegex);
                    if (match) {
                        const year = parseInt(match[1], 10);
                        const month = parseInt(match[2], 10) - 1;
                        const day = parseInt(match[3], 10);
                        const extractedDate = new Date(year, month, day);
                        if (!isNaN(extractedDate.getTime())) {
                            recordTimeMs = extractedDate.getTime();
                        }
                    }
                } catch (e) { /* 按 mtime 回退 */ }

                // 署名过滤: 公共文件夹中排除非本人署名
                const relToRoot = path.relative(DAILY_NOTE_ROOT, absFilePath);
                const topDir = relToRoot.split(path.sep)[0] || '';
                if (topDir.startsWith('公共')) {
                    const author = this._extractAuthor(contentHead);
                    // 有署名但不是本人 → 跳过
                    if (author && !author.includes(agentName)) {
                        continue;
                    }
                }

                const ageDays = (now - recordTimeMs) / (1000 * 60 * 60 * 24);
                parsedFiles.push({
                    filePath: absFilePath,
                    mtime: recordTimeMs,
                    size: stat.size,
                    ageDays: ageDays
                });
            } catch (e) { /* 忽略 */ }
        }

        if (parsedFiles.length === 0) {
            return { recent: [], mid: [], deep: [], recentBoundary: INITIAL_RECENT_DAYS, midBoundary: INITIAL_MID_DAYS };
        }

        // 按时间排序（最新在前）
        parsedFiles.sort((a, b) => a.ageDays - b.ageDays);

        // ===== 动态时间桶分配 =====
        let recentBoundary = INITIAL_RECENT_DAYS;
        let midBoundary = INITIAL_MID_DAYS;

        // Step 1: 尝试用初始边界分桶
        const countInRange = (minDays, maxDays) =>
            parsedFiles.filter(f => f.ageDays >= minDays && f.ageDays <= maxDays).length;

        // Step 2: 近期不够3篇 → 逐步放宽
        while (countInRange(0, recentBoundary) < 3 && recentBoundary < RECENT_EXPAND_MAX) {
            recentBoundary += RECENT_EXPAND_STEP;
        }
        recentBoundary = Math.min(recentBoundary, RECENT_EXPAND_MAX);

        // 中期起点跟着近期边界动
        const midStart = recentBoundary + 1;

        // Step 3: 中期不够2篇 → 逐步放宽
        while (countInRange(midStart, midBoundary) < 2 && midBoundary < MID_EXPAND_MAX) {
            midBoundary += MID_EXPAND_STEP;
        }
        midBoundary = Math.min(midBoundary, MID_EXPAND_MAX);

        // 深远起点跟着中期边界动
        const deepStart = midBoundary + 1;

        // Step 4: 最终分桶
        const buckets = { recent: [], mid: [], deep: [] };
        for (const f of parsedFiles) {
            if (f.ageDays <= recentBoundary) {
                buckets.recent.push(f);
            } else if (f.ageDays <= midBoundary) {
                buckets.mid.push(f);
            } else {
                buckets.deep.push(f);
            }
        }

        // 确保时间倒序
        buckets.recent.sort((a, b) => b.mtime - a.mtime);
        buckets.mid.sort((a, b) => b.mtime - a.mtime);
        buckets.deep.sort((a, b) => b.mtime - a.mtime);

        console.log(`[DreamWave] 时间桶 (${agentName}): 近期=${buckets.recent.length}篇(≤${recentBoundary}天), 中期=${buckets.mid.length}篇(${midStart}~${midBoundary}天), 深远=${buckets.deep.length}篇(>${midBoundary}天)`);

        return {
            recent: buckets.recent,
            mid: buckets.mid,
            deep: buckets.deep,
            recentBoundary,
            midBoundary
        };
    }

    // =========================================================================
    // 向量操作（纯本地，无网络依赖）
    // =========================================================================

    /**
     * 直接从 DB 获取文件的第一个 chunk 向量
     * 🔧 修复: 路径匹配使用多种格式尝试
     */
    _getLocalVector(absFilePath) {
        if (!this.db) return null;
        try {
            const relPath = path.relative(DAILY_NOTE_ROOT, absFilePath);
            const relPathPosix = relPath.replace(/\\/g, '/');
            const relPathWin = relPath.replace(/\//g, '\\');

            const fileRow = this.db.prepare(
                "SELECT id FROM files WHERE path = ? OR path = ? OR path = ? OR path = ?"
            ).get(relPathPosix, relPathWin, '/' + relPathPosix, '\\' + relPathWin);

            if (!fileRow) return null;

            const chunkRow = this.db.prepare(
                "SELECT vector FROM chunks WHERE file_id = ? ORDER BY chunk_index ASC LIMIT 1"
            ).get(fileRow.id);

            if (!chunkRow || !chunkRow.vector) return null;

            const vecDim = Math.floor(chunkRow.vector.length / 4);
            return new Float32Array(chunkRow.vector.buffer, chunkRow.vector.byteOffset, vecDim);
        } catch (e) {
            console.error(`[DreamWave] _getLocalVector 失败 (${path.basename(absFilePath)}):`, e.message);
            return null;
        }
    }

    /**
     * 从 search 返回的 fullPath（相对路径）获取向量
     * fullPath 是相对于 DAILY_NOTE_ROOT 的路径
     */
    _getVectorByRelPath(relPath) {
        if (!this.db || !relPath) return null;
        try {
            const relPathPosix = relPath.replace(/\\/g, '/');
            const relPathWin = relPath.replace(/\//g, '\\');

            const fileRow = this.db.prepare(
                "SELECT id FROM files WHERE path = ? OR path = ? OR path = ? OR path = ?"
            ).get(relPathPosix, relPathWin, '/' + relPathPosix, '\\' + relPathWin);

            if (!fileRow) return null;

            const chunkRow = this.db.prepare(
                "SELECT vector FROM chunks WHERE file_id = ? ORDER BY chunk_index ASC LIMIT 1"
            ).get(fileRow.id);

            if (!chunkRow || !chunkRow.vector) return null;

            const vecDim = Math.floor(chunkRow.vector.length / 4);
            return new Float32Array(chunkRow.vector.buffer, chunkRow.vector.byteOffset, vecDim);
        } catch (e) {
            return null;
        }
    }

    // =========================================================================
    // 向量召回（核心联想）
    // =========================================================================

    /**
     * 对某篇向量在多个日记本索引中进行召回
     * 🔧 关键修复: Float32Array → Array.from() 以匹配 KnowledgeBaseManager.search() 签名
     * 🔧 署名过滤: 召回结果中排除非本人署名的公共日记
     * 🌊 V8 升级: 测地线重排 — 过采样 2×k 候选，经 geodesicRerank 后截断回 k
     *    tagBoost 使用 "0.6+" 语法触发 KnowledgeBaseManager 内置的测地线重排管线
     */
    async _recallForVector(agentName, vector, k) {
        if (!vector || !this.kb) return [];

        const indices = this._getSearchableIndexNames(agentName);
        let allResults = [];

        // 🌊 V8 测地线重排: 过采样 2×k，让 geodesicRerank 有足够候选做地形感知排序
        const oversampleK = k * 2;

        // 🔧 核心修复: KnowledgeBaseManager.search(diaryName, queryVec, k, tagBoost)
        // queryVec 必须是 Array (Array.isArray 检查)，不能是 Float32Array！
        const queryVecArray = Array.from(vector);

        // 🌊 tagBoost = "0.6+" — 尾部 "+" 触发 V8 geodesicRerank 管线
        const tagBoostWithGeodesic = '0.6+';

        for (const idxName of indices) {
            try {
                const results = await this.kb.search(idxName, queryVecArray, oversampleK, tagBoostWithGeodesic);
                if (results && results.length > 0) {
                    allResults = allResults.concat(results);
                }
            } catch (e) {
                // 静默跳过搜索失败的索引
            }
        }

        // 按分数排序（分数已包含测地线重排融合后的 finalScore）
        allResults.sort((a, b) => (b.score || 0) - (a.score || 0));

        // 去重（按 fullPath）
        const unique = [];
        const seen = new Set();
        for (const r of allResults) {
            const key = r.fullPath || r.sourceFile || '';
            if (key && !seen.has(key)) {
                seen.add(key);
                unique.push(r);
            }
        }

        // 🔧 署名过滤: 排除公共日记本中非本人署名的记忆
        const filtered = [];
        for (const r of unique) {
            const relPath = r.fullPath || '';
            const topDir = relPath.split('/')[0] || relPath.split('\\')[0] || '';

            if (topDir.startsWith('公共')) {
                // 公共日记本 → 检查署名
                const absPath = path.join(DAILY_NOTE_ROOT, relPath);
                try {
                    const fd = await fsPromises.open(absPath, 'r');
                    const buffer = Buffer.alloc(256);
                    const { bytesRead } = await fd.read(buffer, 0, 256, 0);
                    await fd.close();
                    const head = buffer.toString('utf-8', 0, bytesRead);
                    const author = this._extractAuthor(head);
                    // 有署名但不是本人 → 跳过
                    if (author && !author.includes(agentName)) {
                        continue;
                    }
                } catch (e) {
                    // 读取失败时宽容处理，保留
                }
            }
            filtered.push(r);
        }

        return filtered.slice(0, k);
    }

    /**
     * 读取文件完整文本内容
     */
    async _readContent(filePath) {
        try {
            return await fsPromises.readFile(filePath, 'utf-8');
        } catch (e) {
            return '';
        }
    }

    /**
     * 为 search 返回的结果补充完整文本内容
     * search 返回的 text 只是 chunk 片段，我们需要完整文件内容用于梦境
     */
    async _hydrateSearchResult(result) {
        if (!result) return null;

        const relPath = result.fullPath || '';
        const absPath = path.join(DAILY_NOTE_ROOT, relPath);

        let content = '';
        try {
            content = await fsPromises.readFile(absPath, 'utf-8');
        } catch (e) {
            // 读取失败，回退到 chunk text
            content = result.text || '';
        }

        return {
            filePath: absPath,
            fullPath: relPath,
            content: content,
            score: result.score || 0,
            sourceFile: result.sourceFile || path.basename(relPath)
        };
    }

    // =========================================================================
    // 🌊 主涟漪浪潮算法
    // =========================================================================

    async generateDreamWave(agentName) {
        if (!this.kb || !this.db) {
            throw new Error("知识库未就绪，无法生成梦境浪潮");
        }

        console.log(`[DreamWave] 🌊 开始为 ${agentName} 生成记忆涟漪浪潮 (V8 测地线重排已启用, tagBoost=0.6+, 过采样=2×k)...`);

        const buckets = await this._getTimelineBuckets(agentName);

        // ================= Phase 1: 近期涟漪 =================
        // 随机抽取3篇种子记忆 L0
        const recentSeedsRaw = this._sample(buckets.recent, 3);
        const recentSeeds = [];
        const recentL1Hits = new Map();   // fullPath -> hitCount
        const recentL1Dict = new Map();   // fullPath -> searchResult
        const allCollectedVectors = [];   // 收集所有 L1/L2 向量用于深渊浪潮

        console.log(`[DreamWave] Phase 1: 近期种子 ${recentSeedsRaw.length} 篇 (≤${buckets.recentBoundary}天)`);

        for (const seed of recentSeedsRaw) {
            const content = await this._readContent(seed.filePath);
            if (!content || content.length < 10) continue;

            recentSeeds.push({ filePath: seed.filePath, content });

            const vector = this._getLocalVector(seed.filePath);
            if (!vector) {
                console.log(`[DreamWave]   种子 ${path.basename(seed.filePath)} 无向量，跳过联想`);
                continue;
            }

            // 3/5/7 原则
            const k = this._determineK(content.length);
            console.log(`[DreamWave]   种子 ${path.basename(seed.filePath)} (${content.length}字) → k=${k} (过采样${k * 2}→重排→${k})`);

            const recalls = await this._recallForVector(agentName, vector, k);
            console.log(`[DreamWave]   → 测地线重排后召回 ${recalls.length} 条结果`);

            // 收集命中计数，用于找共振桥梁
            const seedRelPath = path.relative(DAILY_NOTE_ROOT, seed.filePath).replace(/\\/g, '/');
            for (const r of recalls) {
                const rPath = r.fullPath || '';
                if (rPath === seedRelPath) continue; // 排除自己
                recentL1Hits.set(rPath, (recentL1Hits.get(rPath) || 0) + 1);
                if (!recentL1Dict.has(rPath)) {
                    recentL1Dict.set(rPath, r);
                }
            }
        }

        // 提取共振桥梁 L1: 被多个种子重复命中的记忆
        let resonantL1 = [];
        for (const [rPath, count] of recentL1Hits.entries()) {
            if (count >= 2) {
                resonantL1.push(recentL1Dict.get(rPath));
            }
        }

        // 如果没有交叉共振，取分数最高的2个作为替补
        if (resonantL1.length === 0 && recentL1Dict.size > 0) {
            resonantL1 = Array.from(recentL1Dict.values())
                .sort((a, b) => (b.score || 0) - (a.score || 0))
                .slice(0, 2);
            console.log(`[DreamWave]   无共振交叉，取 Top-${resonantL1.length} 替补`);
        } else {
            console.log(`[DreamWave]   共振桥梁 L1: ${resonantL1.length} 篇 (命中≥2次)`);
        }

        // Hydrate L1 结果（补充完整文本）
        const hydratedL1 = [];
        for (const r of resonantL1) {
            const hydrated = await this._hydrateSearchResult(r);
            if (hydrated) hydratedL1.push(hydrated);
        }

        // 基于 L1 下探 L2 (k=3)
        const recentL2Raw = [];
        const seenL2Paths = new Set(resonantL1.map(r => r.fullPath || ''));
        for (const seed of recentSeeds) {
            seenL2Paths.add(path.relative(DAILY_NOTE_ROOT, seed.filePath).replace(/\\/g, '/'));
        }

        for (const l1 of resonantL1) {
            const vec = this._getVectorByRelPath(l1.fullPath);
            if (vec) {
                allCollectedVectors.push(vec);
                const l2Recalls = await this._recallForVector(agentName, vec, 3);
                for (const r of l2Recalls) {
                    const rPath = r.fullPath || '';
                    if (!seenL2Paths.has(rPath)) {
                        seenL2Paths.add(rPath);
                        recentL2Raw.push(r);
                    }
                }
            }
        }

        console.log(`[DreamWave]   L2 下探: ${recentL2Raw.length} 篇`);

        // Hydrate L2 结果
        const hydratedL2 = [];
        for (const r of recentL2Raw) {
            const hydrated = await this._hydrateSearchResult(r);
            if (hydrated) {
                hydratedL2.push(hydrated);
                const vec = this._getVectorByRelPath(r.fullPath);
                if (vec) allCollectedVectors.push(vec);
            }
        }

        // ================= Phase 2: 中期涟漪 =================
        const midSeedsRaw = this._sample(buckets.mid, 2);
        const midSeeds = [];
        const midL1Raw = [];
        const seenMidPaths = new Set();

        console.log(`[DreamWave] Phase 2: 中期种子 ${midSeedsRaw.length} 篇 (${buckets.recentBoundary + 1}~${buckets.midBoundary}天)`);

        for (const seed of midSeedsRaw) {
            const content = await this._readContent(seed.filePath);
            if (!content || content.length < 10) continue;

            midSeeds.push({ filePath: seed.filePath, content });
            const seedRelPath = path.relative(DAILY_NOTE_ROOT, seed.filePath).replace(/\\/g, '/');
            seenMidPaths.add(seedRelPath);

            const vector = this._getLocalVector(seed.filePath);
            if (!vector) continue;

            const k = this._determineK(content.length);
            const recalls = await this._recallForVector(agentName, vector, k);

            for (const r of recalls) {
                const rPath = r.fullPath || '';
                if (rPath === seedRelPath) continue;
                if (!seenMidPaths.has(rPath)) {
                    seenMidPaths.add(rPath);
                    midL1Raw.push(r);
                    const rVec = this._getVectorByRelPath(rPath);
                    if (rVec) allCollectedVectors.push(rVec);
                }
            }
        }

        console.log(`[DreamWave]   中期 L1: ${midL1Raw.length} 篇`);

        // Hydrate 中期 L1
        const hydratedMidL1 = [];
        for (const r of midL1Raw) {
            const hydrated = await this._hydrateSearchResult(r);
            if (hydrated) hydratedMidL1.push(hydrated);
        }

        // ================= Phase 3: 深渊浪潮 =================
        // 将所有 L1/L2 向量归一化合并，形成浪潮向量，在深远记忆中召回
        let deepRecalls = [];

        if (allCollectedVectors.length > 0 && this.kb.config) {
            const dim = this.kb.config.dimension;
            console.log(`[DreamWave] Phase 3: 深渊浪潮 (${allCollectedVectors.length} 个向量合并, dim=${dim})`);

            // 归一化向量合并
            const waveVector = new Float32Array(dim);
            for (const vec of allCollectedVectors) {
                const vecDim = Math.min(vec.length, dim);
                for (let i = 0; i < vecDim; i++) waveVector[i] += vec[i];
            }

            // L2 归一化
            let mag = 0;
            for (let i = 0; i < dim; i++) mag += waveVector[i] * waveVector[i];
            mag = Math.sqrt(mag);
            if (mag > 1e-9) {
                for (let i = 0; i < dim; i++) waveVector[i] /= mag;
            }

            // 用浪潮向量召回 k=5，取前3
            const deepRaw = await this._recallForVector(agentName, waveVector, 5);
            const deepTop = deepRaw.slice(0, 3);

            for (const r of deepTop) {
                const hydrated = await this._hydrateSearchResult(r);
                if (hydrated) deepRecalls.push(hydrated);
            }

            console.log(`[DreamWave]   深渊召回: ${deepRecalls.length} 篇 (>${buckets.midBoundary}天)`);
        } else {
            console.log(`[DreamWave] Phase 3: 无可用向量，跳过深渊浪潮`);
        }

        // ================= 封箱与防爆 Token =================
        const maxChars = DREAM_MAX_RECALL_TOKENS * 1.5;
        let usedChars = 0;

        const processGroup = (group) => {
            const safeGroup = [];
            for (const item of group) {
                const text = item.content || item.text || '';
                if (!text || text.length < 5) continue;

                if (usedChars + text.length > maxChars) {
                    const room = maxChars - usedChars;
                    if (room > 200) {
                        item._safeText = this._truncateContent(text, room);
                        usedChars += item._safeText.length;
                        safeGroup.push(item);
                    }
                    break;
                } else {
                    item._safeText = text;
                    usedChars += text.length;
                    safeGroup.push(item);
                }
            }
            return safeGroup;
        };

        const result = {
            recent: {
                seeds: processGroup(recentSeeds),
                resonanceL1: processGroup(hydratedL1),
                cascadeL2: processGroup(hydratedL2)
            },
            mid: {
                seeds: processGroup(midSeeds),
                cascadeL1: processGroup(hydratedMidL1)
            },
            deep: {
                recalls: processGroup(deepRecalls)
            }
        };

        const totalMemories =
            result.recent.seeds.length + result.recent.resonanceL1.length + result.recent.cascadeL2.length +
            result.mid.seeds.length + result.mid.cascadeL1.length +
            result.deep.recalls.length;

        console.log(`[DreamWave] 🌊 浪潮完成: 总计 ${totalMemories} 篇记忆, ${usedChars} 字符`);
        console.log(`[DreamWave]   近期: ${result.recent.seeds.length} 种子 + ${result.recent.resonanceL1.length} L1共振 + ${result.recent.cascadeL2.length} L2下探`);
        console.log(`[DreamWave]   中期: ${result.mid.seeds.length} 种子 + ${result.mid.cascadeL1.length} L1`);
        console.log(`[DreamWave]   深渊: ${result.deep.recalls.length} 召回`);

        return result;
    }
}

module.exports = DreamWaveEngine;
