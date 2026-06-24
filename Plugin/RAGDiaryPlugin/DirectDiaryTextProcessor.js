const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let Jieba = null;
let jiebaDict = null;
try {
    ({ Jieba } = require('@node-rs/jieba'));
    ({ dict: jiebaDict } = require('@node-rs/jieba/dict'));
} catch (error) {
    // jieba 是 BM25 模式的增强依赖；缺失时自动降级到正则分词。
}

class BM25Ranker {
    constructor() {
        this.k1 = 1.5;
        this.b = 0.75;
    }

    calculateIDF(allDocs) {
        const totalDocs = allDocs.length;
        const documentFrequency = {};

        for (const docTokens of allDocs) {
            const uniqueTokens = new Set(docTokens);
            for (const token of uniqueTokens) {
                documentFrequency[token] = (documentFrequency[token] || 0) + 1;
            }
        }

        const idfScores = {};
        for (const token in documentFrequency) {
            idfScores[token] = Math.log((totalDocs - documentFrequency[token] + 0.5) / (documentFrequency[token] + 0.5) + 1);
        }

        return idfScores;
    }

    score(queryTokens, docTokens, avgDocLength, idfScores) {
        if (!queryTokens.length || !docTokens.length || avgDocLength <= 0) return 0;

        const termFrequency = {};
        for (const token of docTokens) {
            termFrequency[token] = (termFrequency[token] || 0) + 1;
        }

        let score = 0;
        for (const token of queryTokens) {
            const tf = termFrequency[token] || 0;
            if (tf === 0) continue;

            const idf = idfScores[token] || 0;
            const numerator = tf * (this.k1 + 1);
            const denominator = tf + this.k1 * (1 - this.b + this.b * (docTokens.length / avgDocLength));
            score += idf * (numerator / denominator);
        }

        return score;
    }
}

/**
 * 纯文本日记占位符处理器。
 *
 * 目标：
 * - 专门处理 {{xx日记本}} / {{xx日记本::LastN}} / {{xx日记本::RandomN}} / {{xx日记本::BM25}} / {{xx日记本::BM25+}} 直接文本引入。
 * - 不依赖向量库、不调用 Embedding API、不参与 RAG 查询向量构建。
 * - 支持用净化后的用户输入对候选日记底部 Tag 行或正文做 BM25 匹配。
 */
class DirectDiaryTextProcessor {
    constructor(options = {}) {
        this.dailyNoteRootPath = options.dailyNoteRootPath;
        this.logger = options.logger || console;
        this.stopWords = new Set([
            '的', '了', '在', '是', '我', '你', '他', '她', '它',
            '这', '那', '有', '个', '就', '不', '人', '都', '一',
            '上', '也', '很', '到', '说', '要', '去', '能', '会',
            '和', '与', '或', '及', '吗', '呢', '啊', '吧', '被',
            '把', '给', '对', '从', '为', '以', '并', '但'
        ]);

        try {
            this.jiebaInstance = Jieba && jiebaDict ? Jieba.withDict(jiebaDict) : null;
            if (this.jiebaInstance) {
                this.logger.log('[DirectDiaryTextProcessor] Jieba initialized for ::BM25 tag matching.');
            }
        } catch (error) {
            this.logger.warn('[DirectDiaryTextProcessor] Jieba initialization failed, falling back to regex tokenizer:', error.message);
            this.jiebaInstance = null;
        }
    }

    getDailyNoteSearcherExecutableCandidates() {
        const pluginDir = path.resolve(__dirname, '..', 'DailyNoteSearcher');
        if (process.platform === 'win32') {
            return [path.join(pluginDir, 'DailyNoteSearcher.exe')];
        }

        return [
            path.join(pluginDir, 'DailyNoteSearcher'),
            path.join(pluginDir, 'DailyNoteSearcher-aarch64-unknown-linux-musl')
        ];
    }

    async resolveDailyNoteSearcherExecutable() {
        if (this.dailyNoteSearcherExecutablePath) {
            return this.dailyNoteSearcherExecutablePath;
        }

        for (const executablePath of this.getDailyNoteSearcherExecutableCandidates()) {
            try {
                await fs.access(executablePath);
                this.dailyNoteSearcherExecutablePath = executablePath;
                return executablePath;
            } catch (_) {
                // 继续尝试下一个平台候选产物。
            }
        }

        return null;
    }

    buildDailyNoteSearcherBM25Payload(characterName, queryText, queryTokens, limit, mode) {
        const normalizedMode = mode === 'body' ? 'body' : 'tag';
        return {
            mode: 'bm25',
            query: String(queryText || ''),
            folder: characterName,
            root_path: this.dailyNoteRootPath,
            allowed_extensions: 'md,txt',
            max_results: limit,
            bm25_limit: limit,
            bm25_search_mode: normalizedMode,
            query_tokens: queryTokens,
            tag_blacklist: String(process.env.TAG_BLACKLIST || '')
        };
    }

    normalizeRustBM25Output(parsed, queryTokens, recentFiles, acceleratedBy) {
        if (parsed.status !== 'success') {
            throw new Error(parsed.error || 'Rust BM25 returned non-success status');
        }

        const result = parsed.result || {};
        const matchedCount = Number(result.total || 0);
        if (matchedCount <= 0 || !result.content) {
            return {
                matched: false,
                content: null,
                matchedCount: 0,
                queryTokens,
                acceleratedBy
            };
        }

        return {
            matched: true,
            content: result.content,
            matchedCount,
            queryTokens: Array.isArray(result.query_tokens) ? result.query_tokens : queryTokens,
            acceleratedBy
        };
    }

    async tryRustBM25DiaryContentViaHttp(characterName, queryText, queryTokens, recentFiles, limit, mode) {
        const host = String(process.env.DAILY_NOTE_SEARCHER_HOST || '127.0.0.1');
        const port = parseInt(process.env.DAILY_NOTE_SEARCHER_PORT || '38765', 10) || 38765;
        const timeoutMs = parseInt(process.env.DAILY_NOTE_SEARCHER_TIMEOUT || '60000', 10) || 60000;
        const payload = this.buildDailyNoteSearcherBM25Payload(characterName, queryText, queryTokens, limit, mode);

        try {
            const parsed = await this.postDailyNoteSearcherHttp(host, port, payload, timeoutMs);
            const normalized = this.normalizeRustBM25Output(parsed, queryTokens, recentFiles, 'rust-dailynote-searcher-http');
            if (!normalized.matched && normalized.content === null) {
                normalized.content = await this.readDiaryFileMetas(recentFiles);
            }
            return normalized;
        } catch (error) {
            this.logger.warn(`[DirectDiaryTextProcessor] Rust DailyNoteSearcher HTTP BM25 failed, falling back to stdio executable: ${error.message}`);
            return null;
        }
    }

    async tryRustBM25DiaryContent(characterName, queryText, queryTokens, recentFiles, limit, mode) {
        const executablePath = await this.resolveDailyNoteSearcherExecutable();
        if (!executablePath) {
            return null;
        }

        const payload = this.buildDailyNoteSearcherBM25Payload(characterName, queryText, queryTokens, limit, mode);

        try {
            const stdout = await this.runDailyNoteSearcherExecutable(executablePath, payload);
            const parsed = JSON.parse(String(stdout || '').trim());
            const normalized = this.normalizeRustBM25Output(parsed, queryTokens, recentFiles, 'rust-dailynote-searcher-stdio');
            if (!normalized.matched && normalized.content === null) {
                normalized.content = await this.readDiaryFileMetas(recentFiles);
            }
            return normalized;
        } catch (error) {
            this.logger.warn(`[DirectDiaryTextProcessor] Rust DailyNoteSearcher stdio BM25 failed, falling back to JS BM25: ${error.message}`);
            return null;
        }
    }

    postDailyNoteSearcherHttp(host, port, payload, timeoutMs) {
        const body = JSON.stringify(payload || {});
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: host,
                port,
                path: '/search',
                method: 'POST',
                timeout: timeoutMs,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            }, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => {
                    data += chunk;
                    if (data.length > 64 * 1024 * 1024) {
                        req.destroy(new Error('DailyNoteSearcher HTTP response exceeded 64MB'));
                    }
                });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(String(data || '').trim()));
                    } catch (error) {
                        reject(new Error(`DailyNoteSearcher HTTP returned invalid JSON: ${error.message}`));
                    }
                });
            });

            req.on('timeout', () => req.destroy(new Error(`DailyNoteSearcher HTTP timed out after ${timeoutMs}ms`)));
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    runDailyNoteSearcherExecutable(executablePath, payload) {
        return new Promise((resolve, reject) => {
            const child = spawn(executablePath, [], {
                cwd: path.resolve(__dirname, '..', '..'),
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill();
                reject(new Error('Rust DailyNoteSearcher BM25 timed out'));
            }, 30000);

            child.stdout.on('data', chunk => {
                stdout += chunk.toString('utf8');
                if (stdout.length > 64 * 1024 * 1024) {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        child.kill();
                        reject(new Error('Rust DailyNoteSearcher BM25 stdout exceeded 64MB'));
                    }
                }
            });

            child.stderr.on('data', chunk => {
                stderr += chunk.toString('utf8');
            });

            child.on('error', error => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            });

            child.on('close', code => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (code !== 0) {
                    reject(new Error(`Rust DailyNoteSearcher exited with code ${code}: ${stderr.trim()}`));
                    return;
                }
                resolve(stdout);
            });

            child.stdin.end(JSON.stringify(payload));
        });
    }

    setDailyNoteRootPath(dailyNoteRootPath) {
        this.dailyNoteRootPath = dailyNoteRootPath;
    }

    hasDirectDiaryPlaceholder(text) {
        return typeof text === 'string' && /\{\{.*?日记本.*?\}\}/.test(text);
    }

    hasVectorOrSemanticPlaceholder(text) {
        if (!text || typeof text !== 'string') return false;
        return /\[\[.*日记本.*\]\]|<<.*日记本.*>>|《《.*日记本.*》》|\[\[.*知识库.*\]\]|《《.*知识库.*》》|\[\[VCP元思考.*\]\]|\[\[AIMemo=True\]\]/.test(text);
    }

    isDirectOnlyText(text) {
        return this.hasDirectDiaryPlaceholder(text) && !this.hasVectorOrSemanticPlaceholder(text);
    }

    /**
     * 解析全量召回专用的 ::Last 后缀。
     * 支持 ::Last（默认10）、::Last5、::Last20。
     */
    extractLastLimit(modifiers) {
        if (!modifiers || typeof modifiers !== 'string') return null;
        const lastMatch = modifiers.match(/::Last(\d*)\b/i);
        if (!lastMatch) return null;

        if (!lastMatch[1]) return 10;

        const limit = parseInt(lastMatch[1], 10);
        if (!Number.isFinite(limit) || limit <= 0) return 10;
        return limit;
    }

    /**
     * 解析随机召回专用的 ::Random 后缀。
     * 支持 ::Random（默认1）、::Random5、::Random10。
     */
    extractRandomLimit(modifiers) {
        if (!modifiers || typeof modifiers !== 'string') return null;
        const randomMatch = modifiers.match(/::Random(\d*)\b/i);
        if (!randomMatch) return null;

        if (!randomMatch[1]) return 1;

        const limit = parseInt(randomMatch[1], 10);
        if (!Number.isFinite(limit) || limit <= 0) return 1;
        return limit;
    }

    getBM25Mode(modifiers) {
        if (typeof modifiers !== 'string') return null;
        if (/::BM25\+/i.test(modifiers)) return 'body';
        if (/::BM25\b/i.test(modifiers)) return 'tag';
        return null;
    }

    hasBM25Modifier(modifiers) {
        return this.getBM25Mode(modifiers) !== null;
    }

    parseTagBlacklist() {
        return new Set(String(process.env.TAG_BLACKLIST || '')
            .split(/[,，、|｜\n\r\t]/)
            .map(word => word.toLowerCase().trim())
            .filter(Boolean));
    }

    isBM25TokenLikeWord(token) {
        return /[\p{Script=Han}a-z0-9_]/iu.test(String(token || ''));
    }

    tokenize(text) {
        const blacklist = this.parseTagBlacklist();
        const normalizedText = String(text || '').toLowerCase();

        let words = [];
        if (this.jiebaInstance) {
            words = this.jiebaInstance.cut(normalizedText, false);
        } else {
            words = normalizedText.match(/[\u4e00-\u9fa5]+|[a-z0-9_]+/gi) || [];
        }

        return words
            .map(word => String(word || '').toLowerCase().trim())
            .filter(Boolean)
            .filter(word => word.length >= 1)
            .filter(word => this.isBM25TokenLikeWord(word))
            .filter(word => !this.stopWords.has(word))
            .filter(word => !blacklist.has(word));
    }

    sanitizeUserInputForBM25(text) {
        return String(text || '')
            .replace(/\{\{.*?\}\}/gs, ' ')
            .replace(/\[\[.*?\]\]/gs, ' ')
            .replace(/<<.*?>>/gs, ' ')
            .replace(/《《.*?》》/gs, ' ')
            .replace(/<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g, ' ')
            .replace(/「始」[\s\S]*?「末」/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    normalizeBM25QueryInput(text) {
        return this.sanitizeUserInputForBM25(text);
    }

    extractTagLine(content) {
        const lines = String(content || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);

        for (let index = lines.length - 1; index >= 0; index--) {
            const line = lines[index];
            if (/^tags?\s*[:：]/i.test(line) || /^标签\s*[:：]/.test(line)) {
                return line.replace(/^tags?\s*[:：]\s*/i, '').replace(/^标签\s*[:：]\s*/, '').trim();
            }
        }

        return '';
    }

    extractBodyForBM25(content) {
        const lines = String(content || '').split(/\r?\n/);
        if (lines.length === 0) return '';

        const withoutHeader = lines.slice(1);
        return withoutHeader
            .filter(line => !/^\s*tags?\s*[:：]/i.test(line) && !/^\s*标签\s*[:：]/.test(line))
            .join('\n')
            .trim();
    }

    async getRecentDiaryFileMetas(characterName, limit = 10) {
        const characterDirPath = path.join(this.dailyNoteRootPath, characterName);
        const safeLimit = Math.max(1, parseInt(limit, 10) || 10);

        const files = await fs.readdir(characterDirPath);
        const diaryFiles = files.filter(file => {
            const lowerCaseFile = file.toLowerCase();
            return lowerCaseFile.endsWith('.txt') || lowerCaseFile.endsWith('.md');
        });

        const fileMetas = await Promise.all(
            diaryFiles.map(async (file) => {
                const filePath = path.join(characterDirPath, file);
                try {
                    const stat = await fs.stat(filePath);
                    return {
                        file,
                        filePath,
                        relativePath: path.join(characterName, file),
                        timeMs: Math.max(stat.mtimeMs || 0, stat.birthtimeMs || 0, stat.ctimeMs || 0)
                    };
                } catch (statErr) {
                    this.logger.warn(`[DirectDiaryTextProcessor] ::Last stat failed for ${filePath}:`, statErr.message);
                    return null;
                }
            })
        );

        return fileMetas
            .filter(Boolean)
            .sort((a, b) => b.timeMs - a.timeMs)
            .slice(0, safeLimit);
    }

    async getDiaryContent(characterName) {
        const characterDirPath = path.join(this.dailyNoteRootPath, characterName);
        let characterDiaryContent = `[${characterName}日记本内容为空]`;
        try {
            const files = await fs.readdir(characterDirPath);
            const relevantFiles = files.filter(file => {
                const lowerCaseFile = file.toLowerCase();
                return lowerCaseFile.endsWith('.txt') || lowerCaseFile.endsWith('.md');
            }).sort();

            if (relevantFiles.length > 0) {
                const fileContents = await Promise.all(
                    relevantFiles.map(async (file) => {
                        const filePath = path.join(characterDirPath, file);
                        try {
                            return await fs.readFile(filePath, 'utf-8');
                        } catch (readErr) {
                            return `[Error reading file: ${file}]`;
                        }
                    })
                );
                characterDiaryContent = fileContents.join('\n\n---\n\n');
            }
        } catch (charDirError) {
            if (charDirError.code !== 'ENOENT') {
                this.logger.error(`[DirectDiaryTextProcessor] Error reading character directory ${characterDirPath}:`, charDirError.message);
            }
            characterDiaryContent = `[无法读取“${characterName}”的日记本，可能不存在]`;
        }
        return characterDiaryContent;
    }

    /**
     * 获取指定日记本内最近创建/编辑的 N 个日记文件内容。
     * 排序依据为文件系统时间：max(mtimeMs, birthtimeMs, ctimeMs)，不读取文件名和内容做判定。
     */
    async getLastDiaryContent(characterName, limit = 10) {
        const characterDirPath = path.join(this.dailyNoteRootPath, characterName);
        const safeLimit = Math.max(1, parseInt(limit, 10) || 10);

        try {
            const recentFiles = await this.getRecentDiaryFileMetas(characterName, safeLimit);

            if (recentFiles.length === 0) {
                return `[${characterName}日记本内容为空]`;
            }

            if (safeLimit > recentFiles.length) {
                this.logger.warn(`[DirectDiaryTextProcessor] ::Last${safeLimit}: "${characterName}" 仅有 ${recentFiles.length} 个日记文件，将返回全部可用文件。`);
            }

            return await this.readDiaryFileMetas(recentFiles);
        } catch (charDirError) {
            if (charDirError.code !== 'ENOENT') {
                this.logger.error(`[DirectDiaryTextProcessor] Error reading recent diary files in ${characterDirPath}:`, charDirError.message);
            }
            return `[无法读取“${characterName}”的日记本，可能不存在]`;
        }
    }

    async getRandomDiaryContent(characterName, limit = 1) {
        const characterDirPath = path.join(this.dailyNoteRootPath, characterName);
        const safeLimit = Math.max(1, parseInt(limit, 10) || 1);

        try {
            const files = await fs.readdir(characterDirPath);
            const diaryFiles = files.filter(file => {
                const lowerCaseFile = file.toLowerCase();
                return lowerCaseFile.endsWith('.txt') || lowerCaseFile.endsWith('.md');
            });

            if (diaryFiles.length === 0) {
                return `[${characterName}日记本内容为空]`;
            }

            if (safeLimit > diaryFiles.length) {
                this.logger.warn(`[DirectDiaryTextProcessor] ::Random${safeLimit}: "${characterName}" 仅有 ${diaryFiles.length} 个日记文件，将返回全部可用文件。`);
            }

            const shuffledFiles = diaryFiles
                .map(file => ({ file, random: Math.random() }))
                .sort((a, b) => a.random - b.random)
                .slice(0, safeLimit)
                .map(({ file }) => ({
                    file,
                    filePath: path.join(characterDirPath, file)
                }));

            return await this.readDiaryFileMetas(shuffledFiles);
        } catch (charDirError) {
            if (charDirError.code !== 'ENOENT') {
                this.logger.error(`[DirectDiaryTextProcessor] Error reading random diary files in ${characterDirPath}:`, charDirError.message);
            }
            return `[无法读取“${characterName}”的日记本，可能不存在]`;
        }
    }

    async readDiaryFileMetas(fileMetas) {
        const fileContents = await Promise.all(
            fileMetas.map(async ({ file, filePath }) => {
                try {
                    return await fs.readFile(filePath, 'utf-8');
                } catch (readErr) {
                    return `[Error reading file: ${file}]`;
                }
            })
        );

        return fileContents.join('\n\n---\n\n');
    }

    async getBM25DiaryCandidates(characterName, queryText, limit = 10, mode = 'tag') {
        const safeLimit = Math.max(1, parseInt(limit, 10) || 10);
        const normalizedMode = mode === 'body' ? 'body' : 'tag';
        const modeLabel = normalizedMode === 'body' ? '正文' : 'Tag 行';
        const recentFiles = await this.getRecentDiaryFileMetas(characterName, safeLimit);

        if (recentFiles.length === 0) {
            return {
                matched: false,
                entries: [],
                matchedCount: 0,
                queryTokens: [],
                fallbackFiles: recentFiles,
                reason: 'empty'
            };
        }

        const queryTokens = this.tokenize(queryText);
        if (queryTokens.length === 0) {
            this.logger.warn(`[DirectDiaryTextProcessor] ::BM25${normalizedMode === 'body' ? '+' : ''} query tokens are empty after sanitization/blacklist. Fallback to ::Last${safeLimit}.`);
            return {
                matched: false,
                entries: [],
                matchedCount: 0,
                queryTokens,
                fallbackFiles: recentFiles,
                reason: 'empty-query'
            };
        }

        const candidates = await Promise.all(
            recentFiles.map(async (meta) => {
                try {
                    const content = await fs.readFile(meta.filePath, 'utf-8');
                    const matchText = normalizedMode === 'body'
                        ? this.extractBodyForBM25(content)
                        : this.extractTagLine(content);
                    return {
                        ...meta,
                        content,
                        matchText,
                        tokens: this.tokenize(matchText)
                    };
                } catch (readErr) {
                    return {
                        ...meta,
                        content: `[Error reading file: ${meta.file}]`,
                        matchText: '',
                        tokens: []
                    };
                }
            })
        );

        const docsWithTokens = candidates.filter(candidate => candidate.tokens.length > 0);
        if (docsWithTokens.length === 0) {
            this.logger.warn(`[DirectDiaryTextProcessor] ::BM25${normalizedMode === 'body' ? '+' : ''} found no ${modeLabel} tokens in "${characterName}". Fallback to ::Last${safeLimit}.`);
            return {
                matched: false,
                entries: [],
                matchedCount: 0,
                queryTokens,
                fallbackFiles: recentFiles,
                reason: 'empty-doc-tokens'
            };
        }

        const ranker = new BM25Ranker();
        const allDocs = docsWithTokens.map(candidate => candidate.tokens);
        const idfScores = ranker.calculateIDF(allDocs);
        const avgDocLength = allDocs.reduce((sum, tokens) => sum + tokens.length, 0) / allDocs.length;

        const rankedCandidates = docsWithTokens
            .map(candidate => ({
                ...candidate,
                bm25Score: ranker.score(queryTokens, candidate.tokens, avgDocLength, idfScores)
            }))
            .filter(candidate => candidate.bm25Score > 0)
            .sort((a, b) => {
                if (b.bm25Score !== a.bm25Score) return b.bm25Score - a.bm25Score;
                return b.timeMs - a.timeMs;
            });

        if (rankedCandidates.length === 0) {
            this.logger.warn(`[DirectDiaryTextProcessor] ::BM25${normalizedMode === 'body' ? '+' : ''} no positive ${modeLabel} match for "${characterName}". Fallback to ::Last${safeLimit}.`);
            return {
                matched: false,
                entries: [],
                matchedCount: 0,
                queryTokens,
                fallbackFiles: recentFiles,
                reason: 'no-positive-score'
            };
        }

        return {
            matched: true,
            entries: rankedCandidates,
            matchedCount: rankedCandidates.length,
            queryTokens,
            fallbackFiles: recentFiles,
            reason: 'matched'
        };
    }

    async getBM25DiaryContent(characterName, queryText, limit = 10, mode = 'tag') {
        const safeLimit = Math.max(1, parseInt(limit, 10) || 10);
        const normalizedMode = mode === 'body' ? 'body' : 'tag';

        try {
            const recentFiles = await this.getRecentDiaryFileMetas(characterName, safeLimit);
            if (recentFiles.length === 0) {
                return {
                    matched: false,
                    content: `[${characterName}日记本内容为空]`,
                    matchedCount: 0,
                    queryTokens: []
                };
            }

            const queryTokens = this.tokenize(queryText);
            if (queryTokens.length === 0) {
                this.logger.warn(`[DirectDiaryTextProcessor] ::BM25${normalizedMode === 'body' ? '+' : ''} query tokens are empty after sanitization/blacklist. Fallback to ::Last${safeLimit}.`);
                return {
                    matched: false,
                    content: await this.readDiaryFileMetas(recentFiles),
                    matchedCount: 0,
                    queryTokens
                };
            }

            const rustHttpBM25Result = await this.tryRustBM25DiaryContentViaHttp(
                characterName,
                queryText,
                queryTokens,
                recentFiles,
                safeLimit,
                normalizedMode
            );
            if (rustHttpBM25Result) {
                this.logger.log(`[DirectDiaryTextProcessor] ::BM25${normalizedMode === 'body' ? '+' : ''} used Rust DailyNoteSearcher HTTP service for "${characterName}".`);
                return rustHttpBM25Result;
            }

            const rustBM25Result = await this.tryRustBM25DiaryContent(
                characterName,
                queryText,
                queryTokens,
                recentFiles,
                safeLimit,
                normalizedMode
            );
            if (rustBM25Result) {
                this.logger.log(`[DirectDiaryTextProcessor] ::BM25${normalizedMode === 'body' ? '+' : ''} used Rust DailyNoteSearcher stdio fallback for "${characterName}".`);
                return rustBM25Result;
            }

            const bm25Candidates = await this.getBM25DiaryCandidates(characterName, queryText, safeLimit, normalizedMode);
            if (!bm25Candidates.matched) {
                return {
                    matched: false,
                    content: await this.readDiaryFileMetas(recentFiles),
                    matchedCount: 0,
                    queryTokens: bm25Candidates.queryTokens || queryTokens
                };
            }

            return {
                matched: true,
                content: bm25Candidates.entries.map(candidate => candidate.content).join('\n\n---\n\n'),
                matchedCount: bm25Candidates.matchedCount,
                queryTokens: bm25Candidates.queryTokens || queryTokens
            };
        } catch (charDirError) {
            if (charDirError.code !== 'ENOENT') {
                this.logger.error(`[DirectDiaryTextProcessor] Error reading BM25 diary files in ${path.join(this.dailyNoteRootPath, characterName)}:`, charDirError.message);
            }
            return {
                matched: false,
                content: `[无法读取“${characterName}”的日记本，可能不存在]`,
                matchedCount: 0,
                queryTokens: []
            };
        }
    }

    sanitizeNestedPlaceholders(diaryContent) {
        return String(diaryContent || '')
            .replace(/\[\[.*日记本.*\]\]/g, '[循环占位符已移除]')
            .replace(/<<.*日记本.*>>/g, '[循环占位符已移除]')
            .replace(/《《.*日记本.*》》/g, '[循环占位符已移除]')
            .replace(/\{\{.*日记本.*\}\}/g, '[循环占位符已移除]')
            .replace(/\[\[.*知识库.*\]\]/g, '[循环占位符已移除]')
            .replace(/《《.*知识库.*》》/g, '[循环占位符已移除]');
    }

    async processContent(content, options = {}) {
        let processedContent = String(content || '');
        const declarations = [...processedContent.matchAll(/\{\{(.*?)日记本(.*?)\}\}/g)];

        if (declarations.length === 0) {
            return processedContent;
        }

        const processedDiaries = options.processedDiaries || new Set();
        const messages = Array.isArray(options.messages) ? options.messages : [];
        const evaluateRoleValve = typeof options.evaluateRoleValve === 'function'
            ? options.evaluateRoleValve
            : () => true;
        const pushVcpInfo = typeof options.pushVcpInfo === 'function'
            ? options.pushVcpInfo
            : null;

        const results = await Promise.all(declarations.map(async (match) => {
            const placeholder = match[0];
            const dbName = (match[1] || '').trim();
            const modifiers = match[2] || '';

            this.logger.log(`[DirectDiaryTextProcessor] Processing {{...}} placeholder: "${placeholder}", dbName: "${dbName}", modifiers: "${modifiers}"`);

            if (!evaluateRoleValve(modifiers, messages)) {
                this.logger.log(`[DirectDiaryTextProcessor] RoleValve blocked {{${dbName}}} retrieval.`);
                return { placeholder, content: '' };
            }

            if (processedDiaries.has(dbName)) {
                this.logger.warn(`[DirectDiaryTextProcessor] Detected circular reference to "${dbName}" in {{...}}. Skipping.`);
                return { placeholder, content: `[检测到循环引用，已跳过"${dbName}日记本"的解析]` };
            }

            processedDiaries.add(dbName);

            try {
                const requestedLastLimit = this.extractLastLimit(modifiers);
                const requestedRandomLimit = this.extractRandomLimit(modifiers);
                const bm25Mode = this.getBM25Mode(modifiers);
                const useBM25 = bm25Mode !== null;
                const useRandom = requestedRandomLimit !== null && !useBM25;
                const effectiveLastLimit = requestedLastLimit || (useBM25 ? 10 : null);
                const sanitizedUserInput = this.normalizeBM25QueryInput(
                    typeof options.sanitizedUserInput === 'string' ? options.sanitizedUserInput : ''
                );

                let diaryContent;
                let bm25Result = null;

                if (useBM25) {
                    bm25Result = await this.getBM25DiaryContent(dbName, sanitizedUserInput, effectiveLastLimit || 10, bm25Mode);
                    diaryContent = bm25Result.content;
                } else if (useRandom) {
                    diaryContent = await this.getRandomDiaryContent(dbName, requestedRandomLimit);
                } else {
                    diaryContent = effectiveLastLimit
                        ? await this.getLastDiaryContent(dbName, effectiveLastLimit)
                        : await this.getDiaryContent(dbName);
                }

                const safeContent = this.sanitizeNestedPlaceholders(diaryContent);

                if (pushVcpInfo) {
                    let message;
                    if (useBM25 && bm25Result?.matched) {
                        const bm25Label = bm25Mode === 'body' ? '正文 BM25+' : 'Tag 行 BM25';
                        message = `[RAGDiary] 已按 ${bm25Label} 引入日记本：${dbName}，候选范围为最新 ${effectiveLastLimit} 条，命中 ${bm25Result.matchedCount} 条`;
                    } else if (useBM25) {
                        const bm25Label = bm25Mode === 'body' ? '正文 BM25+' : 'Tag 行 BM25';
                        message = `[RAGDiary] ${bm25Label} 未命中，已兜底引入日记本：${dbName}，按文件时间召回最新 ${effectiveLastLimit} 条记录`;
                    } else if (useRandom) {
                        message = `[RAGDiary] 已随机引入日记本：${dbName}，随机召回 ${requestedRandomLimit} 条记录`;
                    } else if (effectiveLastLimit) {
                        message = `[RAGDiary] 已直接引入日记本：${dbName}，按文件时间召回最新 ${effectiveLastLimit} 条记录`;
                    } else {
                        message = `[RAGDiary] 已直接引入日记本：${dbName}，共 1 条全量记录`;
                    }

                    pushVcpInfo({
                        type: 'DailyNote',
                        action: useBM25 ? (bm25Mode === 'body' ? 'BM25BodyRecall' : 'BM25TagRecall') : (useRandom ? 'RandomRecall' : 'DirectRecall'),
                        dbName,
                        message
                    });
                }

                return { placeholder, content: safeContent };
            } catch (error) {
                this.logger.error(`[DirectDiaryTextProcessor] 处理 {{...日记本}} 直接引入模式出错 (${dbName}):`, error);
                return { placeholder, content: `[处理失败: ${error.message}]` };
            }
        }));

        for (const result of results) {
            processedContent = processedContent.replace(result.placeholder, result.content ?? '');
        }

        return processedContent;
    }

    /**
     * 纯文本快速路径：仅当所有需要处理的虚拟 system 消息都只包含 {{...日记本...}}
     * 直接引入占位符时才接管，避免触发 RAGDiaryPlugin 主向量流程。
     */
    async tryProcessMessages(messages, helpers = {}) {
        if (!Array.isArray(messages) || messages.length === 0) {
            return { processed: false, messages };
        }

        const extractTextFromContent = helpers.extractTextFromContent;
        const replaceTextInContent = helpers.replaceTextInContent;
        const isVirtualSystemUser = helpers.isVirtualSystemUser || helpers.isBetaSystemUser || (() => false);

        if (typeof extractTextFromContent !== 'function' || typeof replaceTextInContent !== 'function') {
            return { processed: false, messages };
        }

        const targetIndices = [];
        for (let index = 0; index < messages.length; index++) {
            const message = messages[index];
            let isVirtualSystem = false;

            if (message.role === 'system') {
                isVirtualSystem = true;
            } else if (message.role === 'user') {
                const userText = extractTextFromContent(message.content);
                if (isVirtualSystemUser(userText)) {
                    isVirtualSystem = true;
                }
            }

            if (!isVirtualSystem) continue;

            const text = extractTextFromContent(message.content);
            if (!text) continue;

            if (this.hasVectorOrSemanticPlaceholder(text)) {
                return { processed: false, messages };
            }

            if (this.hasDirectDiaryPlaceholder(text)) {
                targetIndices.push(index);
            }
        }

        if (targetIndices.length === 0) {
            return { processed: false, messages };
        }

        const newMessages = JSON.parse(JSON.stringify(messages));
        const processedDiaries = new Set();

        await Promise.all(targetIndices.map(async (index) => {
            const currentMessage = newMessages[index];
            const rawText = extractTextFromContent(currentMessage.content);
            const processedContent = await this.processContent(rawText, {
                processedDiaries,
                messages,
                sanitizedUserInput: helpers.sanitizedUserInput,
                evaluateRoleValve: helpers.evaluateRoleValve,
                pushVcpInfo: helpers.pushVcpInfo
            });

            currentMessage.content = replaceTextInContent(
                currentMessage.content,
                () => processedContent
            );
        }));

        this.logger.log(`[DirectDiaryTextProcessor] 纯文本快速路径完成：处理 ${targetIndices.length} 条 {{...日记本...}} 承载消息，未触发向量化流程。`);
        return { processed: true, messages: newMessages };
    }
}

module.exports = DirectDiaryTextProcessor;