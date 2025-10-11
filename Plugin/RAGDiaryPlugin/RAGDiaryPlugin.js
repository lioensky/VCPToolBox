// Plugin/MessagePreprocessor/RAGDiaryPlugin/index.js

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto'); // <--- 引入加密模块
const dotenv = require('dotenv');
const cheerio = require('cheerio'); // <--- 新增：用于解析和清理HTML
const TIME_EXPRESSIONS = require('./timeExpressions.config.js');
const SemanticGroupManager = require('./SemanticGroupManager.js');

// 从 DailyNoteGet 插件借鉴的常量和路径逻辑
const projectBasePath = process.env.PROJECT_BASE_PATH;
const dailyNoteRootPath = projectBasePath ? path.join(projectBasePath, 'dailynote') : path.join(__dirname, '..', '..', 'dailynote');

const GLOBAL_SIMILARITY_THRESHOLD = 0.6; // 全局默认余弦相似度阈值

//####################################################################################
//## TimeExpressionParser - 时间表达式解析器
//####################################################################################
class TimeExpressionParser {
    constructor(locale = 'zh-CN') {
        this.setLocale(locale);
    }

    setLocale(locale) {
        this.locale = locale;
        this.expressions = TIME_EXPRESSIONS[locale] || TIME_EXPRESSIONS['zh-CN'];
    }

    // 将日期设置为北京时间 (UTC+8) 的开始
    _getBeijingTime(date = new Date()) {
        // 获取本地时间与UTC的时差（分钟）
        const localOffset = date.getTimezoneOffset() * 60000;
        // 北京时间是UTC+8
        const beijingOffset = 8 * 60 * 60 * 1000;
        // 转换为北京时间
        const beijingTime = new Date(date.getTime() + localOffset + beijingOffset);
        return beijingTime;
    }

    // 获取一天的开始和结束
    _getDayBoundaries(date) {
        const start = new Date(date);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 1);
        end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
        return { start, end };
    }
    
    // 核心解析函数 - V2 (支持多表达式)
    parse(text) {
        console.log(`[TimeParser] Parsing text for all time expressions: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
        const now = this._getBeijingTime(new Date());
        let remainingText = text;
        const results = [];

        // 1. 检查硬编码表达式 (从长到短排序)
        const sortedHardcodedKeys = Object.keys(this.expressions.hardcoded).sort((a, b) => b.length - a.length);
        for (const expr of sortedHardcodedKeys) {
            if (remainingText.includes(expr)) {
                const config = this.expressions.hardcoded[expr];
                console.log(`[TimeParser] Matched hardcoded expression: "${expr}"`);
                let result = null;
                if (config.days !== undefined) {
                    const targetDate = new Date(now);
                    targetDate.setUTCDate(now.getUTCDate() - config.days);
                    result = this._getDayBoundaries(targetDate);
                } else if (config.type) {
                    result = this._getSpecialRange(now, config.type);
                }
                if (result) {
                    results.push(result);
                    remainingText = remainingText.replace(expr, ''); // 消费掉匹配的部分
                }
            }
        }

        // 2. 检查动态模式
        for (const pattern of this.expressions.patterns) {
            const globalRegex = new RegExp(pattern.regex.source, 'g');
            let match;
            while ((match = globalRegex.exec(remainingText)) !== null) {
                console.log(`[TimeParser] Matched pattern: "${pattern.regex}" with text "${match[0]}"`);
                const result = this._handleDynamicPattern(match, pattern.type, now);
                if (result) {
                    results.push(result);
                    // 简单替换，可能不完美但能处理多数情况
                    remainingText = remainingText.replace(match[0], '');
                }
            }
        }

        if (results.length > 0) {
            // --- V2.1: 去重 ---
            const uniqueRanges = new Map();
            results.forEach(r => {
                const key = `${r.start.toISOString()}|${r.end.toISOString()}`;
                if (!uniqueRanges.has(key)) {
                    uniqueRanges.set(key, r);
                }
            });
            const finalResults = Array.from(uniqueRanges.values());

            if (finalResults.length < results.length) {
                console.log(`[TimeParser] Deduplicated ranges from ${results.length} to ${finalResults.length}.`);
            }
            
            console.log(`[TimeParser] Found ${finalResults.length} unique time expressions.`);
            finalResults.forEach((r, i) => {
                console.log(`  [${i+1}] Range: ${r.start.toISOString()} to ${r.end.toISOString()}`);
            });
            return finalResults;
        } else {
            console.log(`[TimeParser] No time expression found in text`);
            return []; // 始终返回数组
        }
    }

    _getSpecialRange(now, type) {
        let start = new Date(now);
        let end = new Date(now);
        start.setUTCHours(0, 0, 0, 0); // 所有计算都从当天的开始算起

        switch (type) {
            case 'thisWeek':
                const dayOfWeek = now.getUTCDay(); // 0=Sunday, 1=Monday...
                const diff = now.getUTCDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // adjust when sunday
                start.setUTCDate(diff);
                end = new Date(start);
                end.setUTCDate(start.getUTCDate() + 7);
                end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
                break;
            case 'lastWeek':
                const lastWeekDay = now.getUTCDay();
                const lastWeekDiff = now.getUTCDate() - lastWeekDay - 6;
                start.setUTCDate(lastWeekDiff);
                end = new Date(start);
                end.setUTCDate(start.getUTCDate() + 7);
                end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
                break;
            case 'thisMonth':
                start.setUTCDate(1);
                end = new Date(start);
                end.setUTCMonth(end.getUTCMonth() + 1);
                end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
                break;
            case 'lastMonth':
                start.setUTCDate(1);
                start.setUTCMonth(start.getUTCMonth() - 1);
                end = new Date(start);
                end.setUTCMonth(end.getUTCMonth() + 1);
                end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
                break;
            case 'thisMonthStart': // 本月初（1-10号）
                start.setUTCDate(1);
                end = new Date(start);
                end.setUTCDate(10);
                end.setUTCHours(23, 59, 59, 999);
                break;
            case 'lastMonthStart': // 上月初（1-10号）
                start.setUTCMonth(start.getUTCMonth() - 1);
                start.setUTCDate(1);
                end = new Date(start);
                end.setUTCDate(10);
                end.setUTCHours(23, 59, 59, 999);
                break;
            case 'lastMonthMid': // 上月中（11-20号）
                start.setUTCMonth(start.getUTCMonth() - 1);
                start.setUTCDate(11);
                end = new Date(start);
                end.setUTCDate(20);
                end.setUTCHours(23, 59, 59, 999);
                break;
            case 'lastMonthEnd': // 上月末（21号到月底）
                start.setUTCMonth(start.getUTCMonth() - 1);
                start.setUTCDate(21);
                end = new Date(start.getUTCFullYear(), start.getUTCMonth() + 1, 0); // 月底
                end.setUTCHours(23, 59, 59, 999);
                break;
        }
        return { start, end };
    }

    _handleDynamicPattern(match, type, now) {
        const numStr = match[1];
        const num = this.chineseToNumber(numStr);

        switch(type) {
            case 'daysAgo':
                const targetDate = new Date(now);
                targetDate.setUTCDate(now.getUTCDate() - num);
                return this._getDayBoundaries(targetDate);
            
            case 'weeksAgo':
                const weekStart = new Date(now);
                weekStart.setUTCDate(now.getUTCDate() - (num * 7) - now.getUTCDay() + 1);
                weekStart.setUTCHours(0, 0, 0, 0);
                const weekEnd = new Date(weekStart);
                weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
                weekEnd.setUTCHours(23, 59, 59, 999);
                return { start: weekStart, end: weekEnd };
            
            case 'monthsAgo':
                const monthsAgoDate = new Date(now);
                monthsAgoDate.setUTCMonth(now.getUTCMonth() - num);
                monthsAgoDate.setUTCDate(1);
                monthsAgoDate.setUTCHours(0, 0, 0, 0);
                const monthEnd = new Date(monthsAgoDate.getUTCFullYear(), monthsAgoDate.getUTCMonth() + 1, 0);
                monthEnd.setUTCHours(23, 59, 59, 999);
                return { start: monthsAgoDate, end: monthEnd };
            
            case 'lastWeekday':
                const weekdayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
                const targetWeekday = weekdayMap[match[1]];
                if (targetWeekday === undefined) return null;

                const lastWeekDate = new Date(now);
                const currentDay = now.getUTCDay(); // 0 = Sunday
                
                // 计算上周对应星期几的日期
                let daysToSubtract;
                if (targetWeekday === 0) { // 周日
                    daysToSubtract = currentDay === 0 ? 7 : (currentDay + 7);
                } else {
                    daysToSubtract = currentDay >= targetWeekday
                        ? (currentDay - targetWeekday + 7)
                        : (currentDay + 7 - targetWeekday);
                }
                
                lastWeekDate.setUTCDate(now.getUTCDate() - daysToSubtract);
                return this._getDayBoundaries(lastWeekDate);
        }
        
        return null;
    }

    chineseToNumber(chinese) {
        const numMap = {
            '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
            '六': 6, '七': 7, '八': 8, '九': 9,
            '日': 7, '天': 7 // 特殊映射
        };

        if (numMap[chinese] !== undefined) {
            return numMap[chinese];
        }

        if (chinese === '十') return 10;

        // 处理 "十一" 到 "九十九"
        if (chinese.includes('十')) {
            const parts = chinese.split('十');
            const tensPart = parts[0];
            const onesPart = parts[1];

            let total = 0;

            if (tensPart === '') { // "十"开头, e.g., "十三"
                total = 10;
            } else { // "二"开头, e.g., "二十三"
                total = (numMap[tensPart] || 1) * 10;
            }

            if (onesPart) { // e.g., "二十三" 的 "三"
                total += numMap[onesPart] || 0;
            }
            
            return total;
        }

        return parseInt(chinese, 10) || 0;
    }
}


class RAGDiaryPlugin {
    constructor() {
        this.name = 'RAGDiaryPlugin';
        this.vectorDBManager = null;
        this.ragConfig = {};
        this.rerankConfig = {}; // <--- 新增：用于存储Rerank配置
        this.pushVcpInfo = null; // 新增：用于推送 VCP Info
        this.enhancedVectorCache = {}; // <--- 新增：用于存储增强向量的缓存
        this.timeParser = new TimeExpressionParser('zh-CN'); // 实例化时间解析器
        this.semanticGroups = new SemanticGroupManager(this); // 实例化语义组管理器
        this.loadConfig();
    }

    async loadConfig() {
        // --- 加载插件独立的 .env 文件 ---
        const envPath = path.join(__dirname, 'config.env');
        dotenv.config({ path: envPath });

        // --- 加载 Rerank 配置 ---
        this.rerankConfig = {
            url: process.env.RerankUrl || '',
            apiKey: process.env.RerankApi || '',
            model: process.env.RerankModel || '',
            multiplier: parseFloat(process.env.RerankMultiplier) || 2.0,
            maxTokens: parseInt(process.env.RerankMaxTokensPerBatch) || 30000
        };
        // 移除启动时检查，改为在调用时实时检查
        if (this.rerankConfig.url && this.rerankConfig.apiKey && this.rerankConfig.model) {
            console.log('[RAGDiaryPlugin] Rerank feature is configured.');
        }

        const configPath = path.join(__dirname, 'rag_tags.json');
        const cachePath = path.join(__dirname, 'vector_cache.json');

        try {
            const currentConfigHash = await this._getFileHash(configPath);
            if (!currentConfigHash) {
                console.log('[RAGDiaryPlugin] 未找到 rag_tags.json 文件，跳过缓存处理。');
                this.ragConfig = {};
                return;
            }

            let cache = null;
            try {
                const cacheData = await fs.readFile(cachePath, 'utf-8');
                cache = JSON.parse(cacheData);
            } catch (e) {
                console.log('[RAGDiaryPlugin] 缓存文件不存在或已损坏，将重新构建。');
            }

            if (cache && cache.sourceHash === currentConfigHash) {
                // --- 缓存命中 ---
                console.log('[RAGDiaryPlugin] 缓存有效，从磁盘加载向量...');
                this.ragConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
                this.enhancedVectorCache = cache.vectors;
                console.log(`[RAGDiaryPlugin] 成功从缓存加载 ${Object.keys(this.enhancedVectorCache).length} 个向量。`);
            } else {
                // --- 缓存失效或未命中 ---
                if (cache) {
                    console.log('[RAGDiaryPlugin] rag_tags.json 已更新，正在重建缓存...');
                } else {
                    console.log('[RAGDiaryPlugin] 未找到有效缓存，首次构建向量缓存...');
                }

                const configData = await fs.readFile(configPath, 'utf-8');
                this.ragConfig = JSON.parse(configData);
                
                // 调用 _buildAndSaveCache 来生成向量
                await this._buildAndSaveCache(currentConfigHash, cachePath);
            }

        } catch (error) {
            console.error('[RAGDiaryPlugin] 加载配置文件或处理缓存时发生严重错误:', error);
            this.ragConfig = {};
        }
    }

    async _buildAndSaveCache(configHash, cachePath) {
        console.log('[RAGDiaryPlugin] 正在为所有日记本请求 Embedding API...');
        this.enhancedVectorCache = {}; // 清空旧的内存缓存

        for (const dbName in this.ragConfig) {
            // ... (这里的逻辑和之前 _buildEnhancedVectorCache 内部的 for 循环完全一样)
            const diaryConfig = this.ragConfig[dbName];
            const tagsConfig = diaryConfig.tags;

            if (Array.isArray(tagsConfig) && tagsConfig.length > 0) {
                let weightedTags = [];
                tagsConfig.forEach(tagInfo => {
                    const parts = tagInfo.split(':');
                    const tagName = parts[0].trim();
                    let weight = 1.0;
                    if (parts.length > 1) {
                        const parsedWeight = parseFloat(parts[1]);
                        if (!isNaN(parsedWeight)) weight = parsedWeight;
                    }
                    if (tagName) {
                        const repetitions = Math.max(1, Math.round(weight));
                        for (let i = 0; i < repetitions; i++) weightedTags.push(tagName);
                    }
                });
                
                const enhancedText = `${dbName} 的相关主题：${weightedTags.join(', ')}`;
                const enhancedVector = await this.getSingleEmbedding(enhancedText);

                if (enhancedVector) {
                    this.enhancedVectorCache[dbName] = enhancedVector;
                    console.log(`[RAGDiaryPlugin] -> 已为 "${dbName}" 成功获取向量。`);
                } else {
                    console.error(`[RAGDiaryPlugin] -> 为 "${dbName}" 获取向量失败。`);
                }
            }
        }
        
        // 构建新的缓存对象并保存到磁盘
        const newCache = {
            sourceHash: configHash,
            createdAt: new Date().toISOString(),
            vectors: this.enhancedVectorCache,
        };

        try {
            await fs.writeFile(cachePath, JSON.stringify(newCache, null, 2), 'utf-8');
            console.log(`[RAGDiaryPlugin] 向量缓存已成功写入到 ${cachePath}`);
        } catch (writeError) {
            console.error('[RAGDiaryPlugin] 写入缓存文件失败:', writeError);
        }
    }

    async _getFileHash(filePath) {
        try {
            const fileContent = await fs.readFile(filePath, 'utf-8');
            return crypto.createHash('sha256').update(fileContent).digest('hex');
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null; // 文件不存在则没有哈希
            }
            throw error; // 其他错误则抛出
        }
    }

    setDependencies(dependencies) {
        if (dependencies.vectorDBManager) {
            this.vectorDBManager = dependencies.vectorDBManager;
            console.log('[RAGDiaryPlugin] VectorDBManager 依赖已注入。');
        }
        if (dependencies.vcpLogFunctions && typeof dependencies.vcpLogFunctions.pushVcpInfo === 'function') {
            this.pushVcpInfo = dependencies.vcpLogFunctions.pushVcpInfo;
            console.log('[RAGDiaryPlugin] pushVcpInfo 依赖已成功注入。');
        } else {
            console.error('[RAGDiaryPlugin] 警告：pushVcpInfo 依赖注入失败或未提供。');
        }
    }
    
    cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) {
            return 0;
        }
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) {
            return 0;
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    _getWeightedAverageVector(vectors, weights) {
        const [vecA, vecB] = vectors;
        const [weightA, weightB] = weights;

        if (!vecA && !vecB) return null;
        // If one vector is missing, return the other one, effectively not averaging.
        if (vecA && !vecB) return vecA;
        if (!vecA && vecB) return vecB;

        if (vecA.length !== vecB.length) {
            console.error('[RAGDiaryPlugin] Vector dimensions do not match for weighted average.');
            return null;
        }

        const dimension = vecA.length;
        const result = new Array(dimension);

        for (let i = 0; i < dimension; i++) {
            result[i] = (vecA[i] * weightA) + (vecB[i] * weightB);
        }
        
        return result;
    }

    async getDiaryContent(characterName) {
        const characterDirPath = path.join(dailyNoteRootPath, characterName);
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
                 console.error(`[RAGDiaryPlugin] Error reading character directory ${characterDirPath}:`, charDirError.message);
            }
            characterDiaryContent = `[无法读取“${characterName}”的日记本，可能不存在]`;
        }
        return characterDiaryContent;
    }

    _calculateDynamicK(userText, aiText = null) {
        // 1. 根据用户输入的长度计算 k_user
        const userLen = userText ? userText.length : 0;
        let k_user = 3;
        if (userLen > 100) {
            k_user = 7;
        } else if (userLen > 30) {
            k_user = 5;
        }

        // 如果没有 aiText (通常是首轮对话)，直接返回 k_user
        if (!aiText) {
            console.log(`[RAGDiaryPlugin] User-only turn. User query length (${userLen}), setting k=${k_user}.`);
            return k_user;
        }

        // 2. 根据 AI 回复的不重复【词元】数计算 k_ai，以更准确地衡量信息密度
        //    这个正则表达式会匹配连续的英文单词/数字，或单个汉字/符号，能同时兼容中英文。
        const tokens = aiText.match(/[a-zA-Z0-9]+|[^\s\x00-\xff]/g) || [];
        const uniqueTokens = new Set(tokens).size;
        
        let k_ai = 3;
        if (uniqueTokens > 100) {      // 阈值: 高信息密度 (>100个不同词元)
            k_ai = 7;
        } else if (uniqueTokens > 40) { // 阈值: 中等信息密度 (>40个不同词元)
            k_ai = 5;
        }

        // 3. 计算平均 k 值，并四舍五入
        const finalK = Math.round((k_user + k_ai) / 2);
        
        console.log(`[RAGDiaryPlugin] User len (${userLen})->k_user=${k_user}. AI unique tokens (${uniqueTokens})->k_ai=${k_ai}. Final averaged k=${finalK}.`);
        return finalK;
    }

    _stripHtml(html) {
        if (!html || typeof html !== 'string') {
            return html;
        }
        // 1. 使用 cheerio 加载 HTML 并提取纯文本
        const $ = cheerio.load(html);
        const plainText = $.text();
        
        // 2. 将连续的换行符（两个或更多）替换为单个换行符，并移除首尾空白，以减少噪音
        return plainText.replace(/\n{2,}/g, '\n').trim();
    }

    // processMessages 是 messagePreprocessor 的标准接口
    async processMessages(messages, pluginConfig) {
        // V3.0: 支持多system消息处理
        // 1. 识别所有需要处理的 system 消息
        const targetSystemMessageIndices = messages.reduce((acc, m, index) => {
            if (m.role === 'system' &&
                typeof m.content === 'string' &&
                /\[\[.*日记本.*\]\]|<<.*日记本.*>>|《《.*日记本.*》》/.test(m.content)) {
                acc.push(index);
            }
            return acc;
        }, []);

        // 如果没有找到任何包含RAG占位符的system消息，则直接返回
        if (targetSystemMessageIndices.length === 0) {
            return messages;
        }

        // 2. 准备共享资源 (V3.3: 精准上下文提取)
        // 始终寻找最后一个用户消息和最后一个AI消息，以避免注入污染。
        // V3.4: 跳过特殊的 "系统邀请指令" user 消息
        const lastUserMessageIndex = messages.findLastIndex(m => {
            if (m.role !== 'user') {
                return false;
            }
            const content = typeof m.content === 'string'
                ? m.content
                : (Array.isArray(m.content) ? m.content.find(p => p.type === 'text')?.text : '') || '';
            return !content.startsWith('[系统邀请指令:]') && !content.startsWith('[系统提示:]');
        });
        const lastAiMessageIndex = messages.findLastIndex(m => m.role === 'assistant');

        let userContent = '';
        let aiContent = null;

        if (lastUserMessageIndex > -1) {
            const lastUserMessage = messages[lastUserMessageIndex];
            userContent = typeof lastUserMessage.content === 'string'
                ? lastUserMessage.content
                : (Array.isArray(lastUserMessage.content) ? lastUserMessage.content.find(p => p.type === 'text')?.text : '') || '';
        }

        if (lastAiMessageIndex > -1) {
            const lastAiMessage = messages[lastAiMessageIndex];
            aiContent = typeof lastAiMessage.content === 'string'
                ? lastAiMessage.content
                : (Array.isArray(lastAiMessage.content) ? lastAiMessage.content.find(p => p.type === 'text')?.text : '') || '';
        }

        // V3.1: 在向量化之前，清理userContent和aiContent中的HTML标签
        if (userContent) {
            const originalUserContent = userContent;
            userContent = this._stripHtml(userContent);
            if (originalUserContent.length !== userContent.length) {
                console.log('[RAGDiaryPlugin] User content was sanitized from HTML.');
            }
        }
        if (aiContent) {
            const originalAiContent = aiContent;
            aiContent = this._stripHtml(aiContent);
            if (originalAiContent.length !== aiContent.length) {
                console.log('[RAGDiaryPlugin] AI content was sanitized from HTML.');
            }
        }

        // V3.5: 为 VCP Info 创建一个更清晰的组合查询字符串
        const combinedQueryForDisplay = aiContent
            ? `[AI]: ${aiContent}\n[User]: ${userContent}`
            : userContent;

        const userVector = userContent ? await this.getSingleEmbedding(userContent) : null;
        const aiVector = aiContent ? await this.getSingleEmbedding(aiContent) : null;

        let queryVector = null;
        if (aiVector && userVector) {
            queryVector = this._getWeightedAverageVector([userVector, aiVector], [0.7, 0.3]);
        } else {
            queryVector = userVector || aiVector;
        }

        if (!queryVector) {
            console.error('[RAGDiaryPlugin] 查询向量化失败，跳过RAG处理。');
            // 安全起见，移除所有占位符
            const newMessages = JSON.parse(JSON.stringify(messages));
            for (const index of targetSystemMessageIndices) {
                newMessages[index].content = newMessages[index].content
                    .replace(/\[\[.*日记本.*\]\]/g, '')
                    .replace(/<<.*日记本>>/g, '')
                    .replace(/《《.*日记本.*》》/g, '');
            }
            return newMessages;
        }
        
        const dynamicK = this._calculateDynamicK(userContent, aiContent);
        const combinedTextForTimeParsing = [userContent, aiContent].filter(Boolean).join('\n');
        const timeRanges = this.timeParser.parse(combinedTextForTimeParsing);

        // 3. 循环处理每个识别到的 system 消息
        const newMessages = JSON.parse(JSON.stringify(messages));
        for (const index of targetSystemMessageIndices) {
            console.log(`[RAGDiaryPlugin] Processing system message at index: ${index}`);
            const systemMessage = newMessages[index];
            
            // 调用新的辅助函数处理单个消息
            const processedContent = await this._processSingleSystemMessage(
                systemMessage.content,
                queryVector,
                userContent, // 传递 userContent 用于语义组和时间解析
                combinedQueryForDisplay, // V3.5: 传递组合后的查询字符串用于广播
                dynamicK,
                timeRanges
            );
            
            newMessages[index].content = processedContent;
        }

        return newMessages;
    }

    // V3.0 新增: 处理单条 system 消息内容的辅助函数
    async _processSingleSystemMessage(content, queryVector, userContent, combinedQueryForDisplay, dynamicK, timeRanges) {
        if (!this.pushVcpInfo) {
            console.warn('[RAGDiaryPlugin] _processSingleSystemMessage: pushVcpInfo is null. Cannot broadcast RAG details.');
        }
        let processedContent = content;
        const processedDiaries = new Set(); // 用于跟踪已处理的日记本，防止循环引用

        const ragDeclarations = [...processedContent.matchAll(/\[\[(.*?)日记本(.*?)\]\]/g)];
        const fullTextDeclarations = [...processedContent.matchAll(/<<(.*?)日记本>>/g)];
        const hybridDeclarations = [...processedContent.matchAll(/《《(.*?)日记本(.*?)》》/g)];

        // --- 1. 处理 [[...]] RAG 片段检索 ---
        for (const match of ragDeclarations) {
            const placeholder = match[0];
            const dbName = match[1];
            if (processedDiaries.has(dbName)) {
                console.warn(`[RAGDiaryPlugin] Detected circular reference to "${dbName}" in [[...]]. Skipping.`);
                processedContent = processedContent.replace(placeholder, `[检测到循环引用，已跳过“${dbName}日记本”的解析]`);
                continue;
            }
            processedDiaries.add(dbName); // 标记为已处理

            const modifiers = match[2] || '';
            
            const kMultiplierMatch = modifiers.match(/:(\d+\.?\d*)/);
            const kMultiplier = kMultiplierMatch ? parseFloat(kMultiplierMatch[1]) : 1.0;
            const useTime = modifiers.includes('::Time');
            const useGroup = modifiers.includes('::Group');
            const useRerank = modifiers.includes('::Rerank');

            const displayName = dbName + '日记本';
            // The final number of documents we want is based on the original K
            const finalK = Math.max(1, Math.round(dynamicK * kMultiplier));
            // For reranking, we fetch more documents initially
            const kForSearch = useRerank
                ? Math.max(1, Math.round(finalK * this.rerankConfig.multiplier))
                : finalK;

            let retrievedContent = '';
            let finalQueryVector = queryVector;
            let activatedGroups = null;
            let finalResultsForBroadcast = null; // 新增：用于广播的最终结果

            if (useGroup) {
                activatedGroups = this.semanticGroups.detectAndActivateGroups(userContent);
                if (activatedGroups.size > 0) {
                    const enhancedVector = await this.semanticGroups.getEnhancedVector(userContent, activatedGroups);
                    if (enhancedVector) finalQueryVector = enhancedVector;
                }
            }

            if (useTime && timeRanges && timeRanges.length > 0) {
                // --- Time-aware path ---
                // 1. Perform RAG search ONCE.
                let ragResults = await this.vectorDBManager.search(dbName, finalQueryVector, kForSearch);

                // 2. Apply reranking if specified.
                if (useRerank) {
                    ragResults = await this._rerankDocuments(userContent, ragResults, finalK);
                }

                // 3. Collect all unique entries, starting with the (potentially reranked) RAG results.
                const allEntries = new Map();
                ragResults.forEach(entry => {
                    if (!allEntries.has(entry.text.trim())) {
                        // Add source marker for formatting
                        allEntries.set(entry.text.trim(), { ...entry, source: 'rag' });
                    }
                });

                // 4. Loop through time ranges to gather time-specific documents.
                for (const timeRange of timeRanges) {
                    const timeResults = await this.getTimeRangeDiaries(dbName, timeRange);
                    timeResults.forEach(entry => {
                        if (!allEntries.has(entry.text.trim())) {
                            // getTimeRangeDiaries already adds the source marker
                            allEntries.set(entry.text.trim(), entry);
                        }
                    });
                }

                // 5. Format the combined results.
                finalResultsForBroadcast = Array.from(allEntries.values());
                retrievedContent = this.formatCombinedTimeAwareResults(finalResultsForBroadcast, timeRanges, dbName);

            } else {
                // --- Standard path (no time filter) ---
                let searchResults = await this.vectorDBManager.search(dbName, finalQueryVector, kForSearch);
                
                // Apply reranking if specified
                if (useRerank) {
                    searchResults = await this._rerankDocuments(userContent, searchResults, finalK);
                }

                // 为标准 RAG 结果添加 'source' 属性以修复前端显示 [undefined] 的问题
                finalResultsForBroadcast = searchResults.map(r => ({ ...r, source: 'rag' }));

                if (useGroup) {
                    retrievedContent = this.formatGroupRAGResults(searchResults, displayName, activatedGroups);
                } else {
                    retrievedContent = this.formatStandardResults(searchResults, displayName);
                }
            }
            
            // VCPInfo 广播：发送详细的 RAG 检索结果
            if (this.pushVcpInfo && finalResultsForBroadcast) {
                try {
                    const cleanedResults = this._cleanResultsForBroadcast(finalResultsForBroadcast);
                    const infoData = {
                        type: 'RAG_RETRIEVAL_DETAILS',
                        dbName: dbName,
                        query: combinedQueryForDisplay,
                        k: finalK,
                        useTime: useTime,
                        useGroup: useGroup,
                        useRerank: useRerank,
                        timeRanges: useTime ? timeRanges.map(r => ({ start: r.start.toISOString(), end: r.end.toISOString() })) : undefined,
                        results: cleanedResults
                    };
                    this.pushVcpInfo(infoData);
                } catch (broadcastError) {
                    console.error(`[RAGDiaryPlugin] Error during VCPInfo broadcast (RAG path):`, broadcastError);
                }
            }
            
            processedContent = processedContent.replace(placeholder, retrievedContent);
        }

        // --- 2. 处理 <<...>> RAG 全文检索 ---
        for (const match of fullTextDeclarations) {
            const placeholder = match[0];
            const dbName = match[1];
            if (processedDiaries.has(dbName)) {
                console.warn(`[RAGDiaryPlugin] Detected circular reference to "${dbName}" in <<...>>. Skipping.`);
                processedContent = processedContent.replace(placeholder, `[检测到循环引用，已跳过“${dbName}日记本”的解析]`);
                continue;
            }
            processedDiaries.add(dbName); // 标记为已处理

            const diaryConfig = this.ragConfig[dbName] || {};
            const localThreshold = diaryConfig.threshold || GLOBAL_SIMILARITY_THRESHOLD;

            const dbNameVector = await this.getSingleEmbedding(dbName);
            if (!dbNameVector) {
                processedContent = processedContent.replace(placeholder, '');
                continue;
            }
            
            const baseSimilarity = this.cosineSimilarity(queryVector, dbNameVector);
            const enhancedVector = this.enhancedVectorCache[dbName];
            const enhancedSimilarity = enhancedVector ? this.cosineSimilarity(queryVector, enhancedVector) : 0;
            const finalSimilarity = Math.max(baseSimilarity, enhancedSimilarity);

            if (finalSimilarity >= localThreshold) {
                const diaryContent = await this.getDiaryContent(dbName);
                // 安全措施：在注入的内容中递归地移除占位符，防止循环
                const safeContent = diaryContent
                    .replace(/\[\[.*日记本.*\]\]/g, '[循环占位符已移除]')
                    .replace(/<<.*日记本>>/g, '[循环占位符已移除]')
                    .replace(/《《.*日记本.*》》/g, '[循环占位符已移除]');
                processedContent = processedContent.replace(placeholder, safeContent);
            } else {
                processedContent = processedContent.replace(placeholder, '');
            }
        }

        // --- 3. 处理 《《...》》 混合模式 ---
        for (const match of hybridDeclarations) {
            const placeholder = match[0];
            const dbName = match[1];
            if (processedDiaries.has(dbName)) {
                console.warn(`[RAGDiaryPlugin] Detected circular reference to "${dbName}" in 《《...》》. Skipping.`);
                processedContent = processedContent.replace(placeholder, `[检测到循环引用，已跳过“${dbName}日记本”的解析]`);
                continue;
            }
            processedDiaries.add(dbName); // 标记为已处理
            
            const modifiers = match[2] || '';
            const kMultiplierMatch = modifiers.match(/:(\d+\.?\d*)/);
            const kMultiplier = kMultiplierMatch ? parseFloat(kMultiplierMatch[1]) : 1.0;
            const useRerank = modifiers.includes('::Rerank');

            const diaryConfig = this.ragConfig[dbName] || {};
            const localThreshold = diaryConfig.threshold || GLOBAL_SIMILARITY_THRESHOLD;

            const dbNameVector = await this.getSingleEmbedding(dbName);
            if (!dbNameVector) {
                processedContent = processedContent.replace(placeholder, '');
                continue;
            }

            const baseSimilarity = this.cosineSimilarity(queryVector, dbNameVector);
            const enhancedVector = this.enhancedVectorCache[dbName];
            const enhancedSimilarity = enhancedVector ? this.cosineSimilarity(queryVector, enhancedVector) : 0;
            const finalSimilarity = Math.max(baseSimilarity, enhancedSimilarity);

            if (finalSimilarity >= localThreshold) {
                const finalK = Math.max(1, Math.round(dynamicK * kMultiplier));
                const kForSearch = useRerank
                    ? Math.max(1, Math.round(finalK * this.rerankConfig.multiplier))
                    : finalK;

                let searchResults = await this.vectorDBManager.search(dbName, queryVector, kForSearch);

                if (useRerank) {
                    searchResults = await this._rerankDocuments(userContent, searchResults, finalK);
                }

                const retrievedContent = this.formatStandardResults(searchResults, dbName + '日记本');
                
                // VCPInfo 广播：发送详细的 RAG 检索结果 (混合模式)
                if (this.pushVcpInfo) {
                    try {
                        const cleanedResults = this._cleanResultsForBroadcast(searchResults);
                        const infoData = {
                            type: 'RAG_RETRIEVAL_DETAILS',
                            dbName: dbName,
                            query: combinedQueryForDisplay,
                            k: finalK,
                            useTime: false,
                            useGroup: false,
                            useRerank: useRerank,
                            results: cleanedResults
                        };
                        this.pushVcpInfo(infoData);
                    } catch (broadcastError) {
                        console.error(`[RAGDiaryPlugin] Error during VCPInfo broadcast (Hybrid path):`, broadcastError);
                    }
                }

                processedContent = processedContent.replace(placeholder, retrievedContent);
            } else {
                processedContent = processedContent.replace(placeholder, '');
            }
        }

        return processedContent;
    }
    
    //####################################################################################
    //## Time-Aware RAG Logic - 时间感知RAG逻辑
    //####################################################################################

    async getTimeRangeDiaries(dbName, timeRange) {
        const characterDirPath = path.join(dailyNoteRootPath, dbName);
        let diariesInRange = [];

        // 确保时间范围有效
        if (!timeRange || !timeRange.start || !timeRange.end) {
            console.error('[RAGDiaryPlugin] Invalid time range provided');
            return diariesInRange;
        }

        try {
            const files = await fs.readdir(characterDirPath);
            const diaryFiles = files.filter(file => file.toLowerCase().endsWith('.txt'));

            for (const file of diaryFiles) {
                const filePath = path.join(characterDirPath, file);
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    const firstLine = content.split('\n')[0];
                    // V2.6: 兼容 [YYYY-MM-DD] 和 YYYY.MM.DD 两种日记时间戳格式
                    const match = firstLine.match(/^\[?(\d{4}[-.]\d{2}[-.]\d{2})\]?/);
                    if (match) {
                        const dateStr = match[1];
                        // 将 YYYY.MM.DD 格式规范化为 YYYY-MM-DD
                        const normalizedDateStr = dateStr.replace(/\./g, '-');
                        
                        // 确保使用UTC时间比较，避免时区问题
                        const diaryDate = new Date(normalizedDateStr + 'T00:00:00.000Z');
                        
                        if (diaryDate >= timeRange.start && diaryDate <= timeRange.end) {
                            diariesInRange.push({
                                date: normalizedDateStr, // 使用规范化后的日期
                                text: content,
                                source: 'time'
                            });
                        }
                    }
                } catch (readErr) {
                    // ignore individual file read errors
                }
            }
        } catch (dirError) {
            if (dirError.code !== 'ENOENT') {
                 console.error(`[RAGDiaryPlugin] Error reading character directory for time filter ${characterDirPath}:`, dirError.message);
            }
        }
        return diariesInRange;
    }

    formatStandardResults(searchResults, displayName) {
        let content = `\n[--- 从"${displayName}"中检索到的相关记忆片段 ---]\n`;
        if (searchResults && searchResults.length > 0) {
            content += searchResults.map(r => `* ${r.text.trim()}`).join('\n');
        } else {
            content += "没有找到直接相关的记忆片段。";
        }
        content += `\n[--- 记忆片段结束 ---]\n`;
        return content;
    }

    formatCombinedTimeAwareResults(results, timeRanges, dbName) {
        const displayName = dbName + '日记本';
        const formatDate = (date) => {
            const d = new Date(date);
            return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        }
    
        let content = `\n[--- "${displayName}" 多时间感知检索结果 ---]\n`;
        
        const formattedRanges = timeRanges.map(tr => `"${formatDate(tr.start)} ~ ${formatDate(tr.end)}"`).join(' 和 ');
        content += `[合并查询的时间范围: ${formattedRanges}]\n`;
    
        const ragEntries = results.filter(e => e.source === 'rag');
        const timeEntries = results.filter(e => e.source === 'time');
        
        content += `[统计: 共找到 ${results.length} 条不重复记忆 (语义相关 ${ragEntries.length}条, 时间范围 ${timeEntries.length}条)]\n\n`;
    
        if (ragEntries.length > 0) {
            content += '【语义相关记忆】\n';
            ragEntries.forEach(entry => {
                const dateMatch = entry.text.match(/^\[(\d{4}-\d{2}-\d{2})\]/);
                const datePrefix = dateMatch ? `[${dateMatch[1]}] ` : '';
                content += `* ${datePrefix}${entry.text.replace(/^\[.*?\]\s*-\s*.*?\n?/, '').trim()}\n`;
            });
        }
    
        if (timeEntries.length > 0) {
            content += '\n【时间范围记忆】\n';
            // 按日期从新到旧排序
            timeEntries.sort((a, b) => new Date(b.date) - new Date(a.date));
            timeEntries.forEach(entry => {
                content += `* [${entry.date}] ${entry.text.replace(/^\[.*?\]\s*-\s*.*?\n?/, '').trim()}\n`;
            });
        }
    
        content += `[--- 检索结束 ---]\n`;
        return content;
    }

    formatGroupRAGResults(searchResults, displayName, activatedGroups) {
        let content = `\n[--- "${displayName}" 语义组增强检索结果 ---]\n`;
        
        if (activatedGroups && activatedGroups.size > 0) {
            content += `[激活的语义组:]\n`;
            for (const [groupName, data] of activatedGroups) {
                content += `  • ${groupName} (${(data.strength * 100).toFixed(0)}%激活): 匹配到 "${data.matchedWords.join(', ')}"\n`;
            }
            content += '\n';
        } else {
            content += `[未激活特定语义组]\n\n`;
        }
        
        content += `[检索到 ${searchResults ? searchResults.length : 0} 条相关记忆]\n`;
        if (searchResults && searchResults.length > 0) {
            content += searchResults.map(r => `* ${r.text.trim()}`).join('\n');
        } else {
            content += "没有找到直接相关的记忆片段。";
        }
        content += `\n[--- 检索结束 ---]\n`;
        
        return content;
    }

    // Helper for token estimation
    _estimateTokens(text) {
        if (!text) return 0;
        // A simple heuristic: average 2 chars per token for mixed language.
        // This is a conservative estimate to avoid hitting API limits.
        return Math.ceil(text.length / 2);
    }

    async _rerankDocuments(query, documents, originalK) {
        // JIT (Just-In-Time) check for configuration instead of relying on a startup flag
        if (!this.rerankConfig.url || !this.rerankConfig.apiKey || !this.rerankConfig.model) {
            console.warn('[RAGDiaryPlugin] Rerank called, but is not configured. Skipping.');
            return documents.slice(0, originalK);
        }
        console.log(`[RAGDiaryPlugin] Starting rerank process for ${documents.length} documents.`);

        const rerankUrl = new URL('v1/rerank', this.rerankConfig.url).toString();
        const headers = {
            'Authorization': `Bearer ${this.rerankConfig.apiKey}`,
            'Content-Type': 'application/json',
        };
        const maxTokens = this.rerankConfig.maxTokens;
        const queryTokens = this._estimateTokens(query);

        let batches = [];
        let currentBatch = [];
        let currentTokens = queryTokens;

        for (const doc of documents) {
            const docTokens = this._estimateTokens(doc.text);
            if (currentTokens + docTokens > maxTokens && currentBatch.length > 0) {
                // Current batch is full, push it and start a new one
                batches.push(currentBatch);
                currentBatch = [doc];
                currentTokens = queryTokens + docTokens;
            } else {
                // Add to current batch
                currentBatch.push(doc);
                currentTokens += docTokens;
            }
        }
        // Add the last batch if it's not empty
        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }

        console.log(`[RAGDiaryPlugin] Split documents into ${batches.length} batches for reranking.`);

        let allRerankedDocs = [];
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const docTexts = batch.map(d => d.text);
            
            try {
                const body = {
                    model: this.rerankConfig.model,
                    query: query,
                    documents: docTexts,
                    top_n: docTexts.length // Rerank all documents within the batch
                };

                console.log(`[RAGDiaryPlugin] Reranking batch ${i + 1}/${batches.length} with ${docTexts.length} documents.`);
                const response = await axios.post(rerankUrl, body, { headers });

                if (response.data && Array.isArray(response.data.results)) {
                    const rerankedResults = response.data.results;
                    // The rerankedResults are sorted by relevance. We map them back to our original
                    // document objects using the returned index.
                    const orderedBatch = rerankedResults
                        .map(result => batch[result.index])
                        .filter(Boolean); // Filter out any potential misses (e.g., if an index is invalid)
                    
                    allRerankedDocs.push(...orderedBatch);
                } else {
                    console.warn(`[RAGDiaryPlugin] Rerank for batch ${i + 1} returned invalid data. Appending original batch documents.`);
                    allRerankedDocs.push(...batch); // Fallback: use original order for this batch
                }
            } catch (error) {
                console.error(`[RAGDiaryPlugin] Rerank API call failed for batch ${i + 1}. Appending original batch documents.`);
                if (error.response) {
                    console.error(`[RAGDiaryPlugin] Rerank API Error - Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
                } else {
                    console.error('[RAGDiaryPlugin] Rerank API Error - Message:', error.message);
                }
                allRerankedDocs.push(...batch); // Fallback: use original order for this batch
            }
        }

        // Finally, truncate the combined, reranked list to the original K value.
        const finalDocs = allRerankedDocs.slice(0, originalK);
        console.log(`[RAGDiaryPlugin] Rerank process finished. Returning ${finalDocs.length} documents.`);
        return finalDocs;
    }
    
    _cleanResultsForBroadcast(results) {
        if (!Array.isArray(results)) return [];
        return results.map(r => {
            // 仅保留可序列化的关键属性
            return {
                text: r.text || '',
                score: r.score || undefined,
                source: r.source || undefined,
                date: r.date || undefined,
                // 移除所有可能导致 JSON.stringify 失败的复杂对象或循环引用
            };
        });
    }

    async getSingleEmbedding(text) {
        if (!text) {
            console.error('[RAGDiaryPlugin] getSingleEmbedding was called with no text.');
            return null;
        }

        const apiKey = process.env.API_Key;
        const apiUrl = process.env.API_URL;
        const embeddingModel = process.env.WhitelistEmbeddingModel;

        if (!apiKey || !apiUrl || !embeddingModel) {
            console.error('[RAGDiaryPlugin] Embedding API credentials or model is not configured in environment variables.');
            return null;
        }

        try {
            const response = await axios.post(`${apiUrl}/v1/embeddings`, {
                model: embeddingModel,
                input: [text]
            }, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            const vector = response.data?.data?.[0]?.embedding;
            if (!vector) {
                console.error('[RAGDiaryPlugin] Valid embedding vector was not found in the API response.');
                return null;
            }
            return vector;
        } catch (error) {
            if (error.response) {
                console.error(`[RAGDiaryPlugin] Embedding API call failed with status ${error.response.status}: ${JSON.stringify(error.response.data)}`);
            } else if (error.request) {
                console.error('[RAGDiaryPlugin] Embedding API call made but no response received:', error.request);
            } else {
                console.error('[RAGDiaryPlugin] An error occurred while setting up the embedding request:', error.message);
            }
            return null;
        }
    }
}

// 导出实例以供 Plugin.js 加载
module.exports = new RAGDiaryPlugin();
