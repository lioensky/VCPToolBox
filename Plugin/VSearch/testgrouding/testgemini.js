const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, 'test.env') });

const {
    GEMINI_API_KEY,
    GEMINI_API_URL,
    GEMINI_MODEL,
    GEMINI_MAX_TOKENS,
    TEST_QUERY,
    TEST_TIMEOUT_MS
} = process.env;

const apiKey = GEMINI_API_KEY;
const apiUrl = GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const model = GEMINI_MODEL || 'gemini-2.5-flash';
const maxTokens = parseInt(GEMINI_MAX_TOKENS, 10) || 4096;
const timeoutMs = parseInt(TEST_TIMEOUT_MS, 10) || 120000;

const now = new Date();
const currentTime = now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false
});
const topic = TEST_QUERY || '今天的伊朗美国新闻';
const keyword = `${topic} 当前北京时间：${currentTime}`;

const stringifySafe = (value) => {
    try {
        return JSON.stringify(value, null, 2);
    } catch (error) {
        return String(value);
    }
};

async function main() {
    if (!apiKey) {
        throw new Error('缺少 GEMINI_API_KEY，请在 test.env 中配置。');
    }

    console.error(`[testgemini] API URL: ${apiUrl}`);
    console.error(`[testgemini] Model: ${model}`);
    console.error(`[testgemini] Topic: ${topic}`);
    console.error(`[testgemini] Keyword: ${keyword}`);

    const showURL = true;
    const systemPrompt = `你是一个专业的语义搜索助手。当前系统时间: ${currentTime}。
你的任务是根据用户提供的【检索目标主题】和具体的【检索关键词】，从互联网获取最相关、最准确的信息。

行动指南：
1. 意图对齐：深入理解【检索目标主题】，确保搜索结果能直接服务于该主题的研究。
2. 深度检索：利用内置的 Google Search grounding 工具获取实时信息。
3. 信息精炼：不要简单堆砌搜索结果。请从网页中提取关键事实、核心数据、专家观点或最新进展。
4. 语言风格：专业、客观、精炼。
${showURL ? '5. 严格溯源：每一条重要信息必须附带来源 URL。如果你使用了引用标记（如 [cite: X]），请确保在回复末尾的 [参考来源] 部分列出这些标记对应的完整 URL。' : '5. 节省Token：除非特别重要，否则不需要在正文中列出 URL 链接。'}`;

    const outputRequirements = showURL
        ? '- 包含 [核心发现]、[关键数据/事实] 和 [参考来源] 三部分。'
        : '- 包含 [核心发现] 和 [关键数据/事实] 两部分。';

    const fullSystemPrompt = `${systemPrompt}\n\n输出要求：\n- 针对该关键词，提供一个结构化的总结。\n${outputRequirements}`;
    const userMessage = `【检索目标主题】：${topic}\n【当前检索关键词】：${keyword}`;

    const payload = {
        model,
        messages: [
            { role: 'system', content: fullSystemPrompt },
            { role: 'user', content: userMessage }
        ],
        stream: false,
        max_tokens: maxTokens,
        // 与 VSearch.js 的 Grounding 模式保持一致：OpenAI-compatible tool 外壳 + 禁用 function calling。
        tools: [{
            type: "function",
            function: {
                name: "googleSearch",
                description: "从谷歌搜索引擎获取实时信息。",
                parameters: { type: "object", properties: { query: { type: "string" } } }
            }
        }],
        tool_config: {
            function_calling_config: {
                mode: "NONE"
            }
        }
    };

    const response = await axios.post(apiUrl, payload, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: timeoutMs,
        proxy: false
    });

    const choice = response.data?.choices?.[0];
    const message = choice?.message || {};
    const groundingMetadata = message.grounding_metadata || choice?.grounding_metadata;

    console.log('\n========== Gemini Grounding 测试结果 ==========\n');
    console.log(message.content || '[无正文返回]');

    console.log('\n========== Grounding Metadata 检测 ==========\n');
    if (groundingMetadata) {
        console.log('检测到 grounding_metadata，模型/渠道大概率支持 Grounding。');
        console.log(stringifySafe(groundingMetadata));
    } else {
        console.log('未检测到 grounding_metadata。请结合正文是否包含实时新闻与来源判断渠道是否实际启用了 Grounding。');
    }

    console.log('\n========== 原始响应关键信息 ==========\n');
    console.log(stringifySafe({
        id: response.data?.id,
        model: response.data?.model,
        usage: response.data?.usage,
        finish_reason: choice?.finish_reason
    }));
}

main().catch((error) => {
    const status = error.response?.status || 'N/A';
    const data = error.response?.data;
    console.error('\n[testgemini] 测试失败');
    console.error(`HTTP Status: ${status}`);
    console.error(`Error: ${error.message}`);
    if (data) {
        console.error('Response Data:');
        console.error(typeof data === 'string' ? data : stringifySafe(data));
    }
    process.exit(1);
});