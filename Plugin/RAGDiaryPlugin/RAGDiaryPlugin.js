// Plugin/MessagePreprocessor/RAGDiaryPlugin/index.js

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto'); // <--- 引入加密模块

// 从 DailyNoteGet 插件借鉴的常量和路径逻辑
const projectBasePath = process.env.PROJECT_BASE_PATH;
const dailyNoteRootPath = projectBasePath ? path.join(projectBasePath, 'dailynote') : path.join(__dirname, '..', '..', 'dailynote');

const GLOBAL_SIMILARITY_THRESHOLD = 0.6; // 全局默认余弦相似度阈值

class RAGDiaryPlugin {
    constructor() {
        this.name = 'RAGDiaryPlugin';
        this.vectorDBManager = null;
        this.ragConfig = {};
        this.enhancedVectorCache = {}; // <--- 新增：用于存储增强向量的缓存
        this.loadConfig();
    }

    async loadConfig() {
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

    // processMessages 是 messagePreprocessor 的标准接口
    async processMessages(messages, pluginConfig) {
        const systemMessage = messages.find(m => m.role === 'system');
        if (!systemMessage || typeof systemMessage.content !== 'string') {
            return messages;
        }

        const ragDeclarations = [...systemMessage.content.matchAll(/\[\[(.*?)日记本\]\]/g)];
        const fullTextDeclarations = [...systemMessage.content.matchAll(/<<(.*?)日记本>>/g)];

        if (ragDeclarations.length === 0 && fullTextDeclarations.length === 0) {
            return messages; // 没有发现RAG声明，直接返回
        }
        
        // --- V2.0 优化：构建更丰富的查询 ---
        let queryText = '';
        const lastUserMessageIndex = messages.findLastIndex(m => m.role === 'user');

        if (lastUserMessageIndex > -1) {
            const lastUserMessage = messages[lastUserMessageIndex];
            const userContent = typeof lastUserMessage.content === 'string'
                ? lastUserMessage.content
                : lastUserMessage.content.find(p => p.type === 'text')?.text || '';
            
            queryText = userContent;

            // 检查前一条消息是否是AI的回复
            if (lastUserMessageIndex > 0 && messages[lastUserMessageIndex - 1].role === 'assistant') {
                const lastAiMessage = messages[lastUserMessageIndex - 1];
                const aiContent = typeof lastAiMessage.content === 'string' ? lastAiMessage.content : '';
                if (aiContent) {
                    // 拼接AI和用户的最后对话
                    queryText = `${aiContent}\n${userContent}`;
                }
            }
        }

        if (!queryText) {
            console.log('[RAGDiaryPlugin] 未能构建有效的查询文本，跳过处理。');
            // 如果没有查询文本，则直接移除所有占位符
             let contentWithoutPlaceholders = systemMessage.content;
            ragDeclarations.forEach(match => { contentWithoutPlaceholders = contentWithoutPlaceholders.replace(match[0], ''); });
            fullTextDeclarations.forEach(match => { contentWithoutPlaceholders = contentWithoutPlaceholders.replace(match[0], ''); });
            messages.find(m => m.role === 'system').content = contentWithoutPlaceholders;
            return messages;
        }

        console.log(`[RAGDiaryPlugin] 发现RAG声明，构建的组合查询文本: "${queryText.substring(0, 80)}..."`);
        
        const queryVector = await this.getSingleEmbedding(queryText);
        if (!queryVector) {
            console.error('[RAGDiaryPlugin] 查询向量化失败，跳过RAG处理。');
            // 安全起见，直接移除占位符
            let contentWithoutPlaceholders = systemMessage.content;
            ragDeclarations.forEach(match => { contentWithoutPlaceholders = contentWithoutPlaceholders.replace(match[0], ''); });
            fullTextDeclarations.forEach(match => { contentWithoutPlaceholders = contentWithoutPlaceholders.replace(match[0], ''); });
            messages.find(m => m.role === 'system').content = contentWithoutPlaceholders;
            return messages;
        }

        let processedSystemContent = systemMessage.content;

        // --- 处理 [[...]] RAG 片段检索 ---
        for (const match of ragDeclarations) {
            const placeholder = match[0]; // 例如 [[公共日记本]]
            const dbName = match[1];      // 例如 "公共"
            const displayName = dbName + '日记本';

            console.log(`[RAGDiaryPlugin] 正在为 "${displayName}" 检索相关信息 (数据库键: ${dbName})...`);
            const searchResults = await this.vectorDBManager.search(dbName, queryVector, 3);

            let retrievedContent = `\n[--- 从"${displayName}"中检索到的相关记忆片段 ---]\n`;
            if (searchResults && searchResults.length > 0) {
                retrievedContent += searchResults.map(r => `* ${r.text.trim()}`).join('\n');
            } else {
                retrievedContent += "没有找到直接相关的记忆片段。";
            }
            retrievedContent += `\n[--- 记忆片段结束 ---]\n`;
            
            processedSystemContent = processedSystemContent.replace(placeholder, retrievedContent);
        }

        // --- 处理 <<...>> RAG 全文检索 (加权标签和独立阈值增强版) ---
        for (const match of fullTextDeclarations) {
            const placeholder = match[0];
            const dbName = match[1];
            const diaryConfig = this.ragConfig[dbName] || {};
            const localThreshold = diaryConfig.threshold || GLOBAL_SIMILARITY_THRESHOLD;

            console.log(`[RAGDiaryPlugin] 正在为 <<${dbName}日记本>> 进行相关性评估 (阈值: ${localThreshold})...`);

            // 1. 基础名称向量
            const dbNameVector = await this.getSingleEmbedding(dbName);
            if (!dbNameVector) {
                console.error(`[RAGDiaryPlugin] 日记本名称 "${dbName}" 向量化失败，跳过。`);
                processedSystemContent = processedSystemContent.replace(placeholder, '');
                continue;
            }
            const baseSimilarity = this.cosineSimilarity(queryVector, dbNameVector);
            console.log(`[RAGDiaryPlugin] 基础名称 "${dbName}" 的相关度: ${baseSimilarity.toFixed(4)}`);

            // 2. 如果有标签，则计算加权增强向量的相似度
            let enhancedSimilarity = 0;
            // const tagsConfig = diaryConfig.tags; // 不再需要这行
            
            // 从缓存中直接获取预计算的向量
            const enhancedVector = this.enhancedVectorCache[dbName];

            if (enhancedVector) {
                enhancedSimilarity = this.cosineSimilarity(queryVector, enhancedVector);
                console.log(`[RAGDiaryPlugin] (从缓存) 加权增强文本的相关度: ${enhancedSimilarity.toFixed(4)}`);
            }

            // 3. 取两种相似度中的最大值作为最终决策依据
            const finalSimilarity = Math.max(baseSimilarity, enhancedSimilarity);
            console.log(`[RAGDiaryPlugin] <<${dbName}日记本>> 的最终决策相关度: ${finalSimilarity.toFixed(4)}`);

            // 4. 使用局部或全局阈值进行决策
            if (finalSimilarity >= localThreshold) {
                console.log(`[RAGDiaryPlugin] 相关度高于阈值 ${localThreshold}，将注入 "${dbName}" 的完整日记内容。`);
                const diaryContent = await this.getDiaryContent(dbName);
                processedSystemContent = processedSystemContent.replace(placeholder, diaryContent);
            } else {
                console.log(`[RAGDiaryPlugin] 相关度低于阈值，将忽略 <<${dbName}日记本>>。`);
                processedSystemContent = processedSystemContent.replace(placeholder, '');
            }
        }

        const newMessages = messages.map(m =>
            m.role === 'system' ? { ...m, content: processedSystemContent } : m
        );

        return newMessages;
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