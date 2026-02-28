// Plugin/RAGDiaryPlugin/AIMemoHandler.js
// AI驱动的记忆召回处理器

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const dayjs = require('dayjs');
const crypto = require('crypto');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';

class AIMemoHandler {
    constructor(ragPlugin, cache) {
        this.ragPlugin = ragPlugin;
        this.config = {};
        this.promptTemplate = '';
        this.cache = cache; // ✅ 使用注入的缓存
        // 不在构造函数中调用 loadConfig，而是在主插件初始化时调用
    }

    async loadConfig() {
        // 从环境变量加载配置
        this.config = {
            model: process.env.AIMemoModel || '',
            batchSize: parseInt(process.env.AIMemoBatch) || 5,
            url: process.env.AIMemoUrl || '',
            apiKey: process.env.AIMemoApi || '',
            maxTokensPerBatch: parseInt(process.env.AIMemoMaxTokensPerBatch) || 60000,
            promptFile: process.env.AIMemoPrompt || 'AIMemoPrompt.txt'
        };

        console.log('[AIMemoHandler] Configuration loaded successfully.');

        // 加载提示词模板
        try {
            const promptPath = path.join(__dirname, this.config.promptFile);
            this.promptTemplate = await fs.readFile(promptPath, 'utf-8');
            console.log('[AIMemoHandler] Prompt template loaded successfully.');
        } catch (error) {
            console.error('[AIMemoHandler] Failed to load prompt template:', error);
            this.promptTemplate = '';
        }
    }

    isConfigured() {
        return !!(this.config.url && this.config.apiKey && this.config.model && this.promptTemplate);
    }

    /**
     * 聚合处理多个日记本的 AIMemo 请求（新增）
     * @param {Array<string>} dbNames - 日记本名称数组
     * @param {string} userContent - 用户输入
     * @param {string} aiContent - AI回复
     * @param {string} combinedQueryForDisplay - 用于VCP广播的组合查询
     * @returns {string} - 格式化的聚合AI召回结果
     */
    async processAIMemoAggregated(dbNames, userContent, aiContent, combinedQueryForDisplay) {
        if (!this.isConfigured()) {
            console.warn('[AIMemoHandler] AIMemo is not configured. Skipping.');
            return '[AIMemo功能未配置]';
        }

        console.log(`[AIMemoHandler] 聚合处理 ${dbNames.length} 个日记本: ${dbNames.join(', ')}`);

        try {
            // --- 缓存机制 ---
            const cacheKey = this._getCacheKey(dbNames, userContent, aiContent);
            const cached = this._getCache(cacheKey);
            if (cached) {
                console.log(`[AIMemoHandler] 命中缓存，直接返回结果。Key: ${cacheKey}`);
                if (this.ragPlugin.pushVcpInfo && cached.vcpInfo) {
                    this.ragPlugin.pushVcpInfo({
                        ...cached.vcpInfo,
                        fromCache: true
                    });
                }
                return cached.content;
            }
            console.log(`[AIMemoHandler] 未命中缓存，继续处理。Key: ${cacheKey}`);
            // --- 缓存机制结束 ---

            // 1. 收集所有日记文件（基于文件级别，而非合并后的字符串）
            const allDiaryFiles = [];
            const loadedDiaries = [];

            for (const dbName of dbNames) {
                const files = await this._getDiaryFiles(dbName);
                if (files.length === 0) {
                    console.warn(`[AIMemoHandler] 跳过空日记本: ${dbName}`);
                    continue;
                }
                allDiaryFiles.push(...files.map(f => ({ ...f, dbName })));
                loadedDiaries.push(dbName);
            }

            if (allDiaryFiles.length === 0) {
                return '[所有日记本均为空或无法访问]';
            }

            console.log(`[AIMemoHandler] 成功加载 ${loadedDiaries.length} 个日记本，共 ${allDiaryFiles.length} 个文件`);

            // 2. 估算总token并决定处理方式
            const totalFileTokens = allDiaryFiles.reduce((sum, f) => sum + f.tokens, 0);
            const FIXED_OVERHEAD = 10000; // 固定预留10k给提示词和上下文
            const totalTokens = totalFileTokens + FIXED_OVERHEAD;

            console.log(`[AIMemoHandler] Token估算 - 文件总计: ${totalFileTokens}, 固定开销: ${FIXED_OVERHEAD}, 总计: ${totalTokens}`);

            // 3. 处理（单次或分批）
            let resultObject;
            if (totalTokens > this.config.maxTokensPerBatch) {
                resultObject = await this._processBatchedAggregated(loadedDiaries, allDiaryFiles, userContent, aiContent, combinedQueryForDisplay);
            } else {
                resultObject = await this._processSingleAggregated(loadedDiaries, allDiaryFiles, userContent, aiContent, combinedQueryForDisplay);
            }

            // VCP Info 广播 (非缓存)
            if (this.ragPlugin.pushVcpInfo && resultObject.vcpInfo) {
                try {
                    this.ragPlugin.pushVcpInfo(resultObject.vcpInfo);
                } catch (e) {
                    console.error('[MetaThinkingManager] Cache hit broadcast failed:', e.message);
                }
            }

            this._setCache(cacheKey, resultObject);
            return resultObject.content;

        } catch (error) {
            console.error(`[AIMemoHandler] 聚合处理失败:`, error);
            return `[AIMemo聚合处理失败: ${error.message}]`;
        }
    }

    // --- 缓存辅助方法 ---

    _getCacheKey(dbNames, userContent, aiContent) {
        const sortedDbNames = [...dbNames].sort().join(',');
        const combined = `${sortedDbNames}|${userContent}|${aiContent}`;
        return crypto.createHash('sha256').update(combined).digest('hex');
    }

    _getCache(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            return null;
        }

        if (Date.now() - entry.timestamp > this.ragPlugin.aiMemoCacheTTL) {
            console.log(`[AIMemoHandler] 缓存条目已过期，删除。Key: ${key}`);
            this.cache.delete(key);
            return null;
        }

        return entry.result;
    }

    _setCache(key, result) {
        if (this.cache.size >= this.ragPlugin.aiMemoCacheMaxSize) {
            // 删除最旧的条目 (Map an insertion order)
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
            console.log(`[AIMemoHandler] 缓存已满，删除最旧条目。Key: ${oldestKey}`);
        }
        this.cache.set(key, { result, timestamp: Date.now() });
        console.log(`[AIMemoHandler] 结果已存入缓存。Key: ${key}`);
    }

    // --- 缓存辅助方法结束 ---

    /**
     * 单次聚合处理
     */
    async _processSingleAggregated(dbNames, diaryFiles, userContent, aiContent, combinedQueryForDisplay) {
        console.log(`[AIMemoHandler] 单次聚合处理 ${dbNames.length} 个日记本，共 ${diaryFiles.length} 个文件`);

        // 将所有文件内容合并
        const knowledgeBase = this._combineFiles(diaryFiles);
        const prompt = this._buildPrompt(knowledgeBase, userContent, aiContent);
        const aiResponse = await this._callAIModel(prompt);

        if (!aiResponse) {
            return '[AI模型调用失败]';
        }

        const extractedMemories = this._extractMemories(aiResponse);

        const content = `[跨库联合检索: ${dbNames.join(' + ')}]\n${extractedMemories}`;
        const vcpInfo = {
            type: 'AI_MEMO_RETRIEVAL',
            dbNames: dbNames,
            query: combinedQueryForDisplay,
            mode: 'aggregated_single',
            diaryCount: dbNames.length,
            fileCount: diaryFiles.length,
            rawResponse: aiResponse,
            extractedMemories: extractedMemories
        };

        return { content, vcpInfo };
    }

    /**
     * 分批聚合处理
     */
    async _processBatchedAggregated(dbNames, diaryFiles, userContent, aiContent, combinedQueryForDisplay) {
        console.log(`[AIMemoHandler] 分批聚合处理 ${dbNames.length} 个日记本，共 ${diaryFiles.length} 个文件`);

        const batches = this._splitFilesIntoBatches(diaryFiles);
        console.log(`[AIMemoHandler] 文件分割为 ${batches.length} 个批次`);

        // 打印每个批次的统计信息
        batches.forEach((batch, idx) => {
            const batchTokens = batch.reduce((sum, f) => sum + f.tokens, 0);
            console.log(`[AIMemoHandler] 批次 ${idx + 1}: ${batch.length} 个文件, ${batchTokens} tokens`);
        });

        const batchResults = [];
        for (let i = 0; i < batches.length; i += this.config.batchSize) {
            const batchGroup = batches.slice(i, i + this.config.batchSize);
            const promises = batchGroup.map((batch, idx) =>
                this._processBatch(batch, userContent, aiContent, i + idx + 1, batches.length)
            );

            const groupResults = await Promise.all(promises);
            batchResults.push(...groupResults);
        }

        const mergedMemories = this._mergeBatchResults(batchResults);

        const content = `[跨库联合检索: ${dbNames.join(' + ')}]\n${mergedMemories}`;
        const vcpInfo = {
            type: 'AI_MEMO_RETRIEVAL',
            dbNames: dbNames,
            query: combinedQueryForDisplay,
            mode: 'aggregated_batched',
            diaryCount: dbNames.length,
            fileCount: diaryFiles.length,
            batchCount: batches.length,
            extractedMemories: mergedMemories
        };

        return { content, vcpInfo };
    }

    /**
     * 处理 ::AIMemo 占位符（保留用于向后兼容）
     * @param {string} dbName - 日记本名称
     * @param {string} userContent - 用户输入（已清理HTML）
     * @param {string} aiContent - AI回复（已清理HTML，可能为null）
     * @param {string} combinedQueryForDisplay - 用于VCP广播的组合查询
     * @returns {string} - 格式化的AI召回结果
     */
    async processAIMemo(dbName, userContent, aiContent, combinedQueryForDisplay) {
        // 直接调用聚合方法，传入单个日记本
        return await this.processAIMemoAggregated([dbName], userContent, aiContent, combinedQueryForDisplay);
    }


    /**
     * 处理单个批次（基于文件数组）
     */
    async _processBatch(batchFiles, userContent, aiContent, batchIndex, totalBatches) {
        console.log(`[AIMemoHandler] Processing batch ${batchIndex}/${totalBatches} (${batchFiles.length} files)`);

        const knowledgeBase = this._combineFiles(batchFiles);
        const prompt = this._buildPrompt(knowledgeBase, userContent, aiContent);
        const aiResponse = await this._callAIModel(prompt);

        if (!aiResponse) {
            console.warn(`[AIMemoHandler] Batch ${batchIndex} failed, returning empty`);
            return '';
        }

        return this._extractMemories(aiResponse);
    }

    /**
     * 获取日记本的所有文件（基于文件级别）
     */
    async _getDiaryFiles(dbName) {
        const projectBasePath = process.env.PROJECT_BASE_PATH;
        const dailyNoteRootPath = process.env.KNOWLEDGEBASE_ROOT_PATH || (projectBasePath ? path.join(projectBasePath, 'dailynote') : path.join(__dirname, '..', '..', 'dailynote'));

        const characterDirPath = path.join(dailyNoteRootPath, dbName);
        const files = [];

        try {
            const fileList = await fs.readdir(characterDirPath);
            const relevantFiles = fileList.filter(file => {
                const lowerCaseFile = file.toLowerCase();
                return lowerCaseFile.endsWith('.txt') || lowerCaseFile.endsWith('.md');
            }).sort();

            for (const file of relevantFiles) {
                const filePath = path.join(characterDirPath, file);
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    const tokens = this._estimateTokens(content);
                    files.push({
                        name: file,
                        content: content,
                        tokens: tokens
                    });
                } catch (readErr) {
                    console.warn(`[AIMemoHandler] 无法读取文件 ${file}:`, readErr.message);
                }
            }
        } catch (dirError) {
            if (dirError.code !== 'ENOENT') {
                console.error(`[AIMemoHandler] 读取目录失败 ${characterDirPath}:`, dirError.message);
            }
        }

        return files;
    }

    /**
     * 将文件数组分割成多个批次（基于文件级别的贪心打包）
     */
    _splitFilesIntoBatches(files) {
        const FIXED_OVERHEAD = 10000; // 固定预留10k给提示词和上下文
        const maxTokensPerBatch = this.config.maxTokensPerBatch - FIXED_OVERHEAD;
        const batches = [];

        let currentBatch = [];
        let currentTokens = 0;

        for (const file of files) {
            // 如果当前批次为空，或者加入这个文件不会超限，就加入
            if (currentBatch.length === 0 || currentTokens + file.tokens <= maxTokensPerBatch) {
                currentBatch.push(file);
                currentTokens += file.tokens;
            } else {
                // 当前批次已满，保存并开启新批次
                batches.push(currentBatch);
                currentBatch = [file];
                currentTokens = file.tokens;
            }
        }

        // 添加最后一个批次
        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }

        return batches.length > 0 ? batches : [files]; // 至少返回一个批次
    }

    /**
     * 将文件数组合并成单个知识库字符串
     */
    _combineFiles(files) {
        return files.map(f => {
            const dbPrefix = f.dbName ? `=== ${f.dbName}日记本 ===\n` : '';
            return dbPrefix + f.content;
        }).join('\n\n---\n\n');
    }

    /**
     * 合并多个批次的结果
     */
    _mergeBatchResults(results) {
        // 过滤掉空结果和"未找到"结果
        const validResults = results.filter(r =>
            r &&
            !r.includes('[[未找到相关记忆]]') &&
            !r.includes('[[知识库为空]]')
        );

        if (validResults.length === 0) {
            return '这是我获取的所有相关知识/记忆[[未找到相关记忆]]';
        }

        // 提取所有[[...]]块
        const allBlocks = [];
        for (const result of validResults) {
            const blocks = this._extractMemoryBlocks(result);
            allBlocks.push(...blocks);
        }

        if (allBlocks.length === 0) {
            return '这是我获取的所有相关知识/记忆[[未找到相关记忆]]';
        }

        // 去重并合并
        const uniqueBlocks = [...new Set(allBlocks)];
        return '这是我获取的所有相关知识/记忆' + uniqueBlocks.join('');
    }

    /**
     * 从AI响应中提取[[...]]块
     */
    _extractMemoryBlocks(text) {
        const blocks = [];
        const regex = /\[\[([\s\S]*?)\]\]/g;
        let match;

        while ((match = regex.exec(text)) !== null) {
            blocks.push(`[[${match[1]}]]`);
        }

        return blocks;
    }

    /**
     * 构建发送给AI的提示词
     */
    _buildPrompt(knowledgeBase, userContent, aiContent) {
        const now = dayjs().tz(DEFAULT_TIMEZONE);

        let prompt = this.promptTemplate;

        // 替换占位符
        prompt = prompt.replace(/\{\{knowledge_base\}\}/g, knowledgeBase);
        prompt = prompt.replace(/\{\{current_user_prompt\}\}/g, userContent || '');
        prompt = prompt.replace(/\{\{last_assistant_response\}\}/g, aiContent || '[无AI回复]');
        prompt = prompt.replace(/\{\{Date\}\}/g, now.format('YYYY-MM-DD'));
        prompt = prompt.replace(/\{\{Time\}\}/g, now.format('HH:mm:ss'));

        return prompt;
    }

    /**
     * 调用AI模型
     */
    async _callAIModel(prompt) {
        const maxRetries = 3;
        const retryDelay = 2000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`[AIMemoHandler] Calling AI model (attempt ${attempt}/${maxRetries})...`);

                const response = await axios.post(
                    `${this.config.url}v1/chat/completions`,
                    {
                        model: this.config.model,
                        messages: [
                            {
                                role: 'user',
                                content: prompt
                            }
                        ],
                        temperature: 0.3, // 较低温度以保持一致性
                        max_tokens: 40000 // 足够的输出空间，特别是对于思考模型
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${this.config.apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 120000 // 2分钟超时
                    }
                );

                const content = response.data?.choices?.[0]?.message?.content;
                if (!content) {
                    console.error('[AIMemoHandler] AI response has no content');
                    return null;
                }

                const cleanedContent = this._handleRepetitiveOutput(content);
                if (cleanedContent.length < content.length) {
                    console.log(`[AIMemoHandler] AI model response was cleaned from repetition. Original length: ${content.length}, Cleaned length: ${cleanedContent.length}`);
                }

                console.log(`[AIMemoHandler] AI model responded successfully (${cleanedContent.length} chars)`);
                return cleanedContent;

            } catch (error) {
                const status = error.response?.status;

                if ((status === 500 || status === 503 || error.code === 'ECONNABORTED') && attempt < maxRetries) {
                    console.warn(`[AIMemoHandler] AI call failed (${status || error.code}). Retrying in ${retryDelay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                }

                if (error.response) {
                    console.error(`[AIMemoHandler] AI API error (${error.response.status}): ${error.message}`);
                } else if (error.request) {
                    console.error('[AIMemoHandler] No response from AI API:', error.message);
                } else {
                    console.error('[AIMemoHandler] Error setting up AI request:', error.message);
                }

                return null;
            }
        }

        return null;
    }

    /**
     * 从AI响应中提取记忆内容（带降级机制）
     */
    _extractMemories(aiResponse) {
        if (!aiResponse) {
            return '[AI未返回有效响应]';
        }

        // 1. 尝试匹配标准格式："这是我获取的所有相关知识/记忆[[...]]"
        const standardMatch = aiResponse.match(/这是我获取的所有相关知识\/记忆(\[\[[\s\S]*?\]\])+/);
        if (standardMatch) {
            console.log('[AIMemoHandler] Successfully extracted memories in standard format');
            return standardMatch[0];
        }

        // 2. 降级：尝试提取所有[[...]]
        const blocks = this._extractMemoryBlocks(aiResponse);
        if (blocks.length > 0) {
            console.log(`[AIMemoHandler] Degraded extraction: Found ${blocks.length} memory blocks`);
            return '这是我获取的所有相关知识/记忆' + blocks.join('');
        }

        // 3. 最终降级：返回AI的全部响应，并包装
        console.warn('[AIMemoHandler] Final degradation: Returning full AI response');
        return `这是我获取的所有相关知识/记忆[[${aiResponse}]]`;
    }

    /**
     * Helper for token estimation
     */
    _estimateTokens(text) {
        if (!text) return 0;
        // 更准确的中英文混合估算
        const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
        const otherChars = text.length - chineseChars;
        // 中文: ~1.5 token/char, 英文: ~0.25 token/char (1 word ≈ 4 chars)
        return Math.ceil(chineseChars * 1.5 + otherChars * 0.25);
    }

    /**
     * 处理AI模型输出中的循环重复内容
     * @param {string} text - AI模型的原始输出
     * @returns {string} - 清理重复内容后的文本
     */
    _handleRepetitiveOutput(text) {
        // 1. 将文本按换行符分割成行，过滤掉空行
        const lines = text.split('\n').filter(line => line.trim().length > 0);
        if (lines.length < 10) { // 如果行数太少，不太可能出现有意义的重复
            return text;
        }

        // 2. 寻找重复的文本块。我们假设重复单元至少包含2行
        const minRepeatUnitSize = 2;
        let repetitionFound = false;
        let firstOccurrenceEndIndex = -1;
        let repeatUnitSize = 0;

        // 从可能的重复单元大小开始迭代
        for (let unitSize = minRepeatUnitSize; unitSize <= Math.floor(lines.length / 2); unitSize++) {
            // 检查从末尾开始的两个连续单元是否相同
            const lastUnit = lines.slice(lines.length - unitSize).join('\n');
            const secondLastUnit = lines.slice(lines.length - 2 * unitSize, lines.length - unitSize).join('\n');

            if (lastUnit === secondLastUnit) {
                // 发现了重复，现在从头开始找到这个重复单元第一次出现的位置
                const unitToFind = lastUnit;
                for (let i = 0; i <= lines.length - 2 * unitSize; i++) {
                    const currentSlice = lines.slice(i, i + unitSize).join('\n');
                    if (currentSlice === unitToFind) {
                        // 确认这确实是一个重复序列的开始
                        const nextSlice = lines.slice(i + unitSize, i + 2 * unitSize).join('\n');
                        if (nextSlice === unitToFind) {
                            repetitionFound = true;
                            firstOccurrenceEndIndex = i + unitSize;
                            repeatUnitSize = unitSize;
                            break; // 找到第一次出现就跳出内层循环
                        }
                    }
                }
            }
            if (repetitionFound) {
                break; // 找到任何一个重复模式就跳出外层循环
            }
        }

        // 3. 如果找到了重复，截断文本
        if (repetitionFound) {
            console.log(`[AIMemoHandler] Repetition detected. Unit size: ${repeatUnitSize}. Truncating content.`);
            // 保留到第一个重复单元结束的部分
            const cleanedLines = lines.slice(0, firstOccurrenceEndIndex);
            return cleanedLines.join('\n');
        }

        // 4. 如果没有找到重复，返回原始文本
        return text;
    }
}

module.exports = AIMemoHandler;