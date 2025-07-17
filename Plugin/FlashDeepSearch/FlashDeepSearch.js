const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

// --- 1. 初始化与配置加载 ---

const configPath = path.resolve(__dirname, './config.env');
dotenv.config({ path: configPath });

const {
    DeepSearchKey: API_KEY,
    DeepSearchUrl: API_URL,
    DeepSearchModel,
    GoogleSearchModel,
    MaxSearchList,
    DeepSearchModelMaxToken,
    GoogleSearchModelMaxToken
} = process.env;

const MAX_CONCURRENT_SEARCHES = parseInt(MaxSearchList, 10) || 5;
const DEEP_SEARCH_MAX_TOKENS = parseInt(DeepSearchModelMaxToken, 10) || 60000;
const GOOGLE_SEARCH_MAX_TOKENS = parseInt(GoogleSearchModelMaxToken, 10) || 50000;
const FILE_SAVE_PATH = path.resolve(__dirname, '../../file/document');

// --- 2. 辅助函数 ---

const logFilePath = path.join(__dirname, `log_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
const logStream = require('fs').createWriteStream(logFilePath, { flags: 'a' });

const log = (message) => {
    const logMessage = `[FlashDeepSearch] ${new Date().toISOString()}: ${message}`;
    console.error(logMessage); // 保留控制台错误输出，以便主进程通信
    logStream.write(`${logMessage}\n`);
};

// 确保在进程退出时优雅地关闭日志流
process.on('exit', () => {
    logStream.end();
});

const sendResponse = (data) => {
    console.log(JSON.stringify(data));
    process.exit(0);
};

const callLanguageModel = async (model, messages, systemPrompt = null, maxTokens) => {
    const payload = {
        model,
        messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages,
        stream: false,
        max_tokens: maxTokens
    };

    // 如果是搜索模型，则添加 tools 参数
    if (model === GoogleSearchModel) {
        payload.tool_choice = "auto";
        payload.tools = [{
            type: "function",
            function: { name: "googleSearch", description: "从谷歌搜索引擎获取实时信息。", parameters: { type: "object", properties: { query: { type: "string" } } } }
        }];
    }
    
    log(`调用模型: ${model}`);
    const response = await axios.post(API_URL, payload, {
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 180000 // 3分钟超时
    });
    return response.data.choices[0].message.content;
};

const saveReport = async (topic, content) => {
    try {
        await fs.mkdir(FILE_SAVE_PATH, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        // 将主题截断为20个字符，并移除所有可能导致文件名非法的字符
        const safeTopic = topic.substring(0, 20).replace(/[\\/:*?"<>|]/g, '_');
        const filename = `${timestamp}_${safeTopic}.txt`;
        const fullPath = path.join(FILE_SAVE_PATH, filename);
        await fs.writeFile(fullPath, content, 'utf-8');
        log(`报告已成功保存到: ${fullPath}`);
    } catch (error) {
        log(`警告：保存报告文件失败: ${error.message}`);
        // 不中断主流程，只记录警告
    }
};


// --- 3. 核心工作流函数 ---

async function generateKeywords(topic, broadness) {
    log('步骤 1: 生成研究关键词...');
    const systemPrompt = `您是一个专攻研究规划的AI，名为“跨域研究织网者”。您的核心任务是接收一个自然语言描述的【研究主题】和一个【搜索广度】参数(SearchBroadness, 范围5-20)，并将其解构为一系列具有高度多样性和探索性的检索关键词。\n您的行动协议如下:\n主题解构 (Deconstruction): 首先，对用户提供的【研究主题】进行深度分析，识别其核心概念、潜在的子领域和关键实体。\n多维扩展 (Expansion): 以核心概念为基础，从多个维度进行发散性思考，必须涵盖但不限于以下视角：技术/科学视角、社会/经济视角、历史/文化视角、哲学/伦理视角、批判/反方视角。\n关键词合成 (Synthesis): 根据上述扩展，生成一系列关键词。这些关键词必须具备以下特点：语言多样性(必须同时包含【中文】和【英文】关键词)、领域多样性(必须跨越至少三个不同的学科领域)、视角多样性(必须体现上述不同的思考维度)。\n首先，用户将会像你请求研究内容，和【搜索广度】(SearchBroadness)，你需要仔细斟酌需要获取的信息，然后详细构建一套检索关键词列表。\n关键词列表格式化输出 (Formatting): 您的首次输出必须严格包含关键词列表。关键词的数量必须严格等于【搜索广度】(SearchBroadness)参数的值。\n输出格式为：\n[KeyWord1:] [KeyWord2:] [KeyWord3:] ... [KeyWordN:]\n每个关键词都由 [KeyWordX:] 包裹。\n当你首次输出结束后，系统会根据您的检索词列表构建详细的检索报告，请将所有信息汇总，构建为具体详实的论文阐述您的思考，研究观点和具有参考价值的结论。`;
    const userMessage = `Agent请求内容字段(${topic})，请求【搜索广度】(SearchBroadness)为:${broadness}`;
    
    const responseText = await callLanguageModel(DeepSearchModel, [{ role: 'user', content: userMessage }], systemPrompt, DEEP_SEARCH_MAX_TOKENS);
    log(`DeepSearchModel 原始响应: ${responseText}`);
    
    // 兼容两种关键词格式: [keyword:] 或 [KeyWord1:] keyword
    let keywords;
    const newRegex = /\[([^\]:]+):\]/g; // 格式: [keyword:]
    const newMatches = [...responseText.matchAll(newRegex)];

    if (newMatches.length > 0) {
        keywords = newMatches.map(match => match[1].trim());
    } else {
        const oldRegex = /\[KeyWord\d*?:\s*\]([^\[\]]+)(?=\s*\[KeyWord\d*?:\]|$)/g; // 格式: [KeyWord1:] keyword
        keywords = [...responseText.matchAll(oldRegex)].map(match => match[1].trim());
    }

    if (keywords.length === 0) {
        throw new Error("未能从DeepSearchModel的响应中提取任何关键词。");
    }
    log(`成功提取到 ${keywords.length} 个关键词。`);
    
    // 返回关键词和此次对话历史
    return {
        keywords,
        history: [
            { role: 'user', content: userMessage },
            { role: 'assistant', content: responseText }
        ]
    };
}

async function executeConcurrentSearches(topic, keywords) {
    log(`步骤 2: 并发执行 ${keywords.length} 个搜索任务...`);
    const systemPrompt = "你是一个谷歌联网搜索信息获取小助手，你的工作是根据用户的需求和具体提供的检索关键词，从互联网获取重要信息，返回的信息必须严格标注引用的url。";
    let searchResults = [];
    
    for (let i = 0; i < keywords.length; i += MAX_CONCURRENT_SEARCHES) {
        const chunk = keywords.slice(i, i + MAX_CONCURRENT_SEARCHES);
        const promises = chunk.map(async (keyword) => {
            try {
                const userMessage = `Agent请求内容字段(${topic}),请求搜索[KeyWord:] ${keyword}`;
                const result = await callLanguageModel(GoogleSearchModel, [{ role: 'user', content: userMessage }], systemPrompt, GOOGLE_SEARCH_MAX_TOKENS);
                return `[参考信息: 关键词="${keyword}"]\n${result}\n\n`;
            } catch (error) {
                log(`警告: 关键词 "${keyword}" 的搜索失败: ${error.message}`);
                return null; // 返回 null 表示失败
            }
        });
        
        const chunkResults = await Promise.all(promises);
        searchResults = searchResults.concat(chunkResults.filter(r => r !== null)); // 过滤掉失败的搜索
    }
    
    log(`成功完成 ${searchResults.length} 个搜索任务。`);
    return searchResults.join('');
}

async function generateFinalReport(searchData, history) {
    log('步骤 3: 生成最终研究报告...');
    // 沿用第一步的系统提示词，确保角色连贯性
    const systemPrompt = `您是一个专攻研究规划的AI，名为“跨域研究织网者”。您的核心任务是接收一个自然语言描述的【研究主题】和一个【搜索广度】参数(SearchBroadness, 范围5-20)，并将其解构为一系列具有高度多样性和探索性的检索关键词。\n您的行动协议如下:\n主题解构 (Deconstruction): 首先，对用户提供的【研究主题】进行深度分析，识别其核心概念、潜在的子领域和关键实体。\n多维扩展 (Expansion): 以核心概念为基础，从多个维度进行发散性思考，必须涵盖但不限于以下视角：技术/科学视角、社会/经济视角、历史/文化视角、哲学/伦理视角、批判/反方视角。\n关键词合成 (Synthesis): 根据上述扩展，生成一系列关键词。这些关键词必须具备以下特点：语言多样性(必须同时包含【中文】和【英文】关键词)、领域多样性(必须跨越至少三个不同的学科领域)、视角多样性(必须体现上述不同的思考维度)。\n首先，用户将会像你请求研究内容，和【搜索广度】(SearchBroadness)，你需要仔细斟酌需要获取的信息，然后详细构建一套检索关键词列表。\n关键词列表格式化输出 (Formatting): 您的首次输出必须严格包含关键词列表。关键词的数量必须严格等于【搜索广度】(SearchBroadness)参数的值。\n输出格式为：\n[KeyWord1:] [KeyWord2:] [KeyWord3:] ... [KeyWordN:]\n每个关键词都由 [KeyWordX:] 包裹。\n当你首次输出结束后，系统会根据您的检索词列表构建详细的检索报告，请将所有信息汇总，构建为具体详实的论文阐述您的思考，研究观点和具有参考价值的结论。`;
    
    // 构建最终的用户指令，清晰地告知模型进入第二阶段
    const finalUserMessage = `${searchData}\n[你已经完成了关键词的生成。现在，请基于以上所有参考信息和你之前的思考过程（完整的对话历史），撰写最终的研究论文。]`;
    const messages = [...history, { role: 'user', content: finalUserMessage }];

    const finalReport = await callLanguageModel(DeepSearchModel, messages, systemPrompt, DEEP_SEARCH_MAX_TOKENS);
    log('最终报告已生成。');
    return finalReport;
}


// --- 4. 主函数与入口 ---

async function main(request) {
    log('插件启动，接收到请求。');
    const { SearchContent, SearchBroadness } = request;

    if (!SearchContent || !SearchBroadness) {
        return sendResponse({ status: "error", error: "请求缺少必需的参数: SearchContent 和 SearchBroadness。" });
    }
    const broadness = parseInt(SearchBroadness, 10);
    if (isNaN(broadness) || broadness < 5 || broadness > 20) {
        return sendResponse({ status: "error", error: "参数 SearchBroadness 必须是5到20之间的整数。" });
    }

    log(`研究主题: "${SearchContent}", 搜索广度: ${broadness}`);

    try {
        // 完整工作流
        const { keywords, history } = await generateKeywords(SearchContent, broadness);
        const searchData = await executeConcurrentSearches(SearchContent, keywords);
        if (!searchData) {
            throw new Error("所有关键词搜索均失败，无法生成报告。");
        }
        const finalReport = await generateFinalReport(searchData, history);
        
        // 保存并返回
        await saveReport(SearchContent, finalReport);
        sendResponse({ status: "success", result: finalReport });

    } catch (error) {
        log(`发生严重错误: ${error.message}`);
        sendResponse({ status: "error", error: error.message || "插件执行时发生未知错误。" });
    }
}

// 插件入口
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
