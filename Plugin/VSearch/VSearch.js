const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const { HttpsProxyAgent } = require('https-proxy-agent');

// --- 1. 初始化与配置加载 ---
const configPath = path.resolve(__dirname, './config.env');
dotenv.config({ path: configPath });

const {
    VSearchKey: API_KEY,
    VSearchUrl: API_URL,
    VSearchModel: MODEL,
    VSearchMaxToken: MAX_TOKENS,
    MaxConcurrent: MAX_CONCURRENT,
    HTTP_PROXY: PROXY
} = process.env;

const CONCURRENCY = parseInt(MAX_CONCURRENT, 10) || 5;
const TOKENS = parseInt(MAX_TOKENS, 10) || 50000;

// --- 2. 辅助函数 ---
const log = (message) => {
    // 使用 console.error 以免干扰 stdout 的 JSON 输出
    console.error(`[VSearch] ${new Date().toISOString()}: ${message}`);
};

const sendResponse = (data) => {
    console.log(JSON.stringify(data));
    process.exit(0);
};

const resolveRedirect = async (url) => {
    if (!url || !url.includes('vertexaisearch.cloud.google.com/grounding-api-redirect')) {
        return url;
    }

    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http')) {
        targetUrl = 'https://' + targetUrl;
    }

    // 递归解析，最多跳转 3 次
    let currentUrl = targetUrl;
    for (let i = 0; i < 3; i++) {
        try {
            const axiosConfig = {
                maxRedirects: 0,
                timeout: 10000,
                validateStatus: (status) => status >= 200 && status < 400
            };

            if (PROXY) {
                axiosConfig.httpsAgent = new HttpsProxyAgent(PROXY);
                axiosConfig.proxy = false;
            }

            const response = await axios.get(currentUrl, axiosConfig);
            if (response.status >= 300 && response.status < 400 && response.headers.location) {
                currentUrl = response.headers.location;
                // 如果重定向到非 Vertex 链接，说明解析完成
                if (!currentUrl.includes('vertexaisearch.cloud.google.com/grounding-api-redirect')) {
                    return currentUrl;
                }
                continue;
            }
            return currentUrl;
        } catch (error) {
            if (error.response && error.response.status >= 300 && error.response.status < 400 && error.response.headers.location) {
                currentUrl = error.response.headers.location;
                if (!currentUrl.includes('vertexaisearch.cloud.google.com/grounding-api-redirect')) {
                    return currentUrl;
                }
                continue;
            }
            log(`解析重定向失败 (${currentUrl}): ${error.message}`);
            return currentUrl;
        }
    }
    return currentUrl;
};

const callSearchModel = async (topic, keyword, showURL = false) => {
    const now = new Date();
    const currentTime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const systemPrompt = `你是一个专业的语义搜索助手。当前系统时间: ${currentTime}。
你的任务是根据用户提供的【检索目标主题】和具体的【检索关键词】，从互联网获取最相关、最准确的信息。

行动指南：
1. 意图对齐：深入理解【检索目标主题】，确保搜索结果能直接服务于该主题的研究。
2. 深度检索：利用内置的 googleSearch 工具获取实时信息。
3. 信息精炼：不要简单堆砌搜索结果。请从网页中提取关键事实、核心数据、专家观点或最新进展。
4. 语言风格：专业、客观、精炼。
${showURL ? '5. 严格溯源：每一条重要信息必须附带来源 URL。如果你使用了引用标记（如 [cite: X]），请确保在回复末尾的 [参考来源] 部分列出这些标记对应的完整 URL。' : '5. 节省Token：除非特别重要，否则不需要在正文中列出 URL 链接。'}`;

    const outputRequirements = showURL
        ? '- 包含 [核心发现]、[关键数据/事实] 和 [参考来源] 三部分。'
        : '- 包含 [核心发现] 和 [关键数据/事实] 两部分。';

    const fullSystemPrompt = `${systemPrompt}\n\n输出要求：\n- 针对该关键词，提供一个结构化的总结。\n${outputRequirements}`;

    const userMessage = `【检索目标主题】：${topic}\n【当前检索关键词】：${keyword}`;

    const payload = {
        model: MODEL,
        messages: [
            { role: 'system', content: fullSystemPrompt },
            { role: 'user', content: userMessage }
        ],
        stream: false,
        max_tokens: TOKENS,
        tool_choice: "auto",
        tools: [{
            type: "function",
            function: { 
                name: "googleSearch", 
                description: "从谷歌搜索引擎获取实时信息。", 
                parameters: { type: "object", properties: { query: { type: "string" } } } 
            }
        }]
    };

    try {
        log(`正在搜索关键词: "${keyword}"...`);
        const response = await axios.post(API_URL, payload, {
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 180000 // 3分钟超时
        });
        let content = response.data.choices[0].message.content;
        
        // 尝试解析 Gemini 的 grounding_metadata (引证来源)
        if (showURL) {
            try {
                const metadata = response.data.choices[0].message.grounding_metadata || response.data.choices[0].grounding_metadata;
                
                // 1. 提取正文中所有可能的 Vertex 重定向 URL (包括没有协议头的)
                const vertexUrlRegex = /(?:https?:\/\/)?vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[a-zA-Z0-9_=-]+/g;
                const foundUrls = content.match(vertexUrlRegex) || [];
                
                // 2. 提取 grounding_metadata 中的 URL
                const metadataUrls = (metadata && metadata.grounding_chunks)
                    ? metadata.grounding_chunks.filter(chunk => chunk.web).map(chunk => chunk.web.uri)
                    : [];

                // 合并并去重
                const allVertexUrls = [...new Set([...foundUrls, ...metadataUrls])];
                const urlMap = new Map();

                // 并发解析所有发现的 URL
                await Promise.all(allVertexUrls.map(async (vUrl) => {
                    const realUrl = await resolveRedirect(vUrl);
                    if (realUrl !== vUrl) {
                        urlMap.set(vUrl, realUrl);
                    }
                }));

                // 3. 替换正文中的所有匹配项
                for (const [original, resolved] of urlMap.entries()) {
                    content = content.split(original).join(resolved);
                }

                // 4. 构建引证来源列表 (如果 metadata 存在)
                if (metadata && metadata.grounding_chunks) {
                    const citations = metadata.grounding_chunks
                        .map((chunk, index) => {
                            if (chunk.web) {
                                const realUrl = urlMap.get(chunk.web.uri) || chunk.web.uri;
                                return `[cite: ${index + 1}] ${chunk.web.title}: ${realUrl}`;
                            }
                            return null;
                        })
                        .filter(c => c !== null);

                    if (citations.length > 0) {
                        content += `\n\n**API 自动引证来源 (已解析真实URL):**\n${citations.join('\n')}`;
                    }
                }
            } catch (metaError) {
                log(`解析引证元数据时出错: ${metaError.message}`);
            }
        }

        return content;
    } catch (error) {
        log(`关键词 "${keyword}" 搜索失败: ${error.message}`);
        return `[搜索失败] 关键词: ${keyword}。错误原因: ${error.message}`;
    }
};

// --- 3. 主逻辑 ---
async function main(request) {
    const { SearchTopic, Keywords, ShowURL } = request;
    const showURL = ShowURL === true || ShowURL === 'true';

    if (!SearchTopic || !Keywords) {
        return sendResponse({ status: "error", error: "缺少必需参数: SearchTopic 或 Keywords。" });
    }

    // 解析关键词：支持逗号、换行、中文逗号分隔
    const keywordList = Keywords.split(/[,\n，]/)
        .map(k => k.trim())
        .filter(k => k.length > 0);

    if (keywordList.length === 0) {
        return sendResponse({ status: "error", error: "未识别到有效的关键词。" });
    }

    log(`启动 VSearch。主题: "${SearchTopic}"，关键词数量: ${keywordList.length}`);

    let allResults = [];
    // 分批执行并发搜索
    for (let i = 0; i < keywordList.length; i += CONCURRENCY) {
        const chunk = keywordList.slice(i, i + CONCURRENCY);
        const promises = chunk.map(kw => callSearchModel(SearchTopic, kw, showURL));
        const results = await Promise.all(promises);
        
        results.forEach((res, idx) => {
            allResults.push(`### 关键词: ${chunk[idx]}\n${res}\n\n---\n\n`);
        });
    }

    const finalOutput = `## VSearch 检索报告\n\n**研究主题**: ${SearchTopic}\n\n${allResults.join('')}`;
    
    sendResponse({ status: "success", result: finalOutput });
}

// 插件入口 (stdio)
let inputData = '';
process.stdin.on('data', chunk => { inputData += chunk; });
process.stdin.on('end', () => {
    try {
        if (!inputData) {
            throw new Error("未从 stdin 接收到任何数据。");
        }
        const request = JSON.parse(inputData);
        main(request);
    } catch (e) {
        log(`解析输入JSON时出错: ${e.message}`);
        sendResponse({ status: "error", error: "无法解析来自主服务的输入参数。" });
    }
});