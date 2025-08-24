// Plugin/MessagePreprocessor/RAGDiaryPlugin/index.js

const axios = require('axios');

class RAGDiaryPlugin {
    constructor() {
        this.name = 'RAGDiaryPlugin';
        this.vectorDBManager = null;
    }

    setDependencies(dependencies) {
        if (dependencies.vectorDBManager) {
            this.vectorDBManager = dependencies.vectorDBManager;
            console.log('[RAGDiaryPlugin] VectorDBManager 依赖已注入。');
        }
    }
    
    // processMessages 是 messagePreprocessor 的标准接口
    async processMessages(messages, pluginConfig) {
        const systemMessage = messages.find(m => m.role === 'system');
        if (!systemMessage || typeof systemMessage.content !== 'string') {
            return messages;
        }

        const ragDeclarations = [...systemMessage.content.matchAll(/\[\[(.*?)日记本\]\]/g)];
        if (ragDeclarations.length === 0) {
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
            return messages;
        }

        console.log(`[RAGDiaryPlugin] 发现RAG声明，构建的组合查询文本: "${queryText.substring(0, 80)}..."`);
        
        const queryVector = await this.getSingleEmbedding(queryText);
        if (!queryVector) {
            console.error('[RAGDiaryPlugin] 查询向量化失败，跳过RAG处理。');
            // 安全起见，直接移除占位符，避免将其发送给上游
            let contentWithoutPlaceholder = systemMessage.content;
            ragDeclarations.forEach(match => {
                contentWithoutPlaceholder = contentWithoutPlaceholder.replace(match[0], ''); 
            });
            messages.find(m => m.role === 'system').content = contentWithoutPlaceholder;
            return messages;
        }

        let processedSystemContent = systemMessage.content;
        for (const match of ragDeclarations) {
            const placeholder = match[0]; // 例如 [[公共日记本]]
            const dbName = match[1];      // 例如 "公共" -> 用于文件名和数据库查找
            const displayName = dbName + '日记本'; // 例如 "公共日记本" -> 用于日志和显示

            console.log(`[RAGDiaryPlugin] 正在为 "${displayName}" 检索相关信息 (数据库键: ${dbName})...`);
            // 使用基础名称 `dbName` 进行搜索, 这应该与 .bin 文件名对应
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