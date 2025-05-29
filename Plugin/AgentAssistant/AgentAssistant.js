#!/usr/bin/env node
// AgentAssistant.js
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid'); // For unique session IDs if needed

// --- 配置加载 ---
// 优先加载插件目录下的 config.env, 然后是项目根目录的 config.env
// VCP Server 启动时会通过环境变量传递 PROJECT_BASE_PATH
const projectBasePath = process.env.PROJECT_BASE_PATH || path.join(__dirname, '..', '..'); // 退到项目根目录
const pluginConfigEnvPath = path.join(__dirname, 'config.env');
const rootConfigEnvPath = path.join(projectBasePath, 'config.env');

let envConfig = {};
if (fs.existsSync(pluginConfigEnvPath)) {
    envConfig = { ...envConfig, ...dotenv.parse(fs.readFileSync(pluginConfigEnvPath)) };
}
if (fs.existsSync(rootConfigEnvPath)) {
    // 根目录的配置优先级较低，如果插件有同名配置，则插件的优先
    const rootEnv = dotenv.parse(fs.readFileSync(rootConfigEnvPath));
    for (const key in rootEnv) {
        if (!envConfig.hasOwnProperty(key)) {
            envConfig[key] = rootEnv[key];
        }
    }
}

// 从环境变量或解析的envConfig中获取配置
const API_URL = process.env.API_URL || envConfig.API_URL;
const API_Key = process.env.API_Key || envConfig.API_Key;
const MAX_HISTORY_ROUNDS = parseInt(process.env.AGENT_ASSISTANT_MAX_HISTORY_ROUNDS || envConfig.AGENT_ASSISTANT_MAX_HISTORY_ROUNDS || '5', 10);
const CONTEXT_TTL_HOURS = parseInt(process.env.AGENT_ASSISTANT_CONTEXT_TTL_HOURS || envConfig.AGENT_ASSISTANT_CONTEXT_TTL_HOURS || '12', 10);
const DEBUG_MODE = (process.env.DebugMode || envConfig.DebugMode || "False").toLowerCase() === "true";

// --- Agent 定义 ---
// 从 config.env 中动态加载 Agent 配置
// Agent 配置格式: AGENT_{NAME}_ID, AGENT_{NAME}_SYSTEM_PROMPT, AGENT_{NAME}_MAX_OUTPUT_TOKENS, AGENT_{NAME}_TEMPERATURE
const AGENTS = {};
for (const key in envConfig) {
    if (key.startsWith('AGENT_') && key.endsWith('_ID')) {
        const nameMatch = key.match(/^AGENT_(.+)_ID$/);
        if (nameMatch && nameMatch[1]) {
            const agentName = nameMatch[1];
            const agentId = envConfig[key];
            const systemPrompt = envConfig[`AGENT_${agentName}_SYSTEM_PROMPT`] || `You are a helpful AI assistant named ${agentName}.`;
            const maxOutputTokens = parseInt(envConfig[`AGENT_${agentName}_MAX_OUTPUT_TOKENS`] || '2048', 10);
            const temperature = parseFloat(envConfig[`AGENT_${agentName}_TEMPERATURE`] || '0.7');
            const description = envConfig[`AGENT_${agentName}_DESCRIPTION`] || `Consult with ${agentName}.`;
            // 更多特性可以按需添加，例如 webSearch (布尔值)
            // const webSearch = (envConfig[`AGENT_${agentName}_WEB_SEARCH`] || "false").toLowerCase() === "true";

            if (agentId) {
                AGENTS[agentName] = {
                    id: agentId,
                    name: agentName, // Agent 的友好名称，用于日志等
                    systemPrompt: systemPrompt,
                    maxOutputTokens: maxOutputTokens,
                    temperature: temperature,
                    description: description, // 用于可能的工具列表描述
                    // webSearch: webSearch
                };
                if (DEBUG_MODE) {
                    console.error(`[AgentAssistant] Loaded agent: ${agentName} (ID: ${agentId})`);
                }
            }
        }
    }
}

if (Object.keys(AGENTS).length === 0 && DEBUG_MODE) {
    console.error("[AgentAssistant] Warning: No agents loaded from config.env. Please define agents like AGENT_MyHelper_ID, AGENT_MyHelper_SYSTEM_PROMPT etc.");
}


// --- 上下文记忆管理 ---
// key: agentName, value: Map<sessionId, {timestamp: number, history: Array<{role: string, content: string}>}>
const agentContexts = new Map();

function getAgentSessionHistory(agentName, sessionId = 'default_user_session') {
    if (!agentContexts.has(agentName)) {
        agentContexts.set(agentName, new Map());
    }
    const agentSessions = agentContexts.get(agentName);
    if (!agentSessions.has(sessionId) || isContextExpired(agentSessions.get(sessionId).timestamp)) {
        agentSessions.set(sessionId, { timestamp: Date.now(), history: [] });
    }
    return agentSessions.get(sessionId).history;
}

function updateAgentSessionHistory(agentName, userMessage, assistantMessage, sessionId = 'default_user_session') {
    const agentSessions = agentContexts.get(agentName);
    if (!agentSessions) return; // Should not happen if getAgentSessionHistory was called

    const sessionData = agentSessions.get(sessionId);
    if (!sessionData || isContextExpired(sessionData.timestamp)) {
        // 如果会话不存在或已过期，则创建新的
        agentSessions.set(sessionId, { timestamp: Date.now(), history: [userMessage, assistantMessage] });
    } else {
        sessionData.history.push(userMessage, assistantMessage);
        sessionData.timestamp = Date.now(); // 更新时间戳
        // 保持最近 N 轮对话 (N*2 条消息)
        const maxMessages = MAX_HISTORY_ROUNDS * 2;
        if (sessionData.history.length > maxMessages) {
            sessionData.history = sessionData.history.slice(-maxMessages);
        }
    }
}

function isContextExpired(timestamp) {
    return (Date.now() - timestamp) > (CONTEXT_TTL_HOURS * 60 * 60 * 1000);
}

// 定期清理过期上下文 (虽然每次访问时也会检查，但这里可以主动清理)
setInterval(() => {
    if (DEBUG_MODE) console.error(`[AgentAssistant] Running periodic context cleanup...`);
    const now = Date.now();
    for (const [agentName, sessions] of agentContexts) {
        for (const [sessionId, sessionData] of sessions) {
            if (isContextExpired(sessionData.timestamp)) {
                sessions.delete(sessionId);
                if (DEBUG_MODE) console.error(`[AgentAssistant] Cleared expired context for agent ${agentName}, session ${sessionId}`);
            }
        }
        if (sessions.size === 0) {
            agentContexts.delete(agentName);
        }
    }
}, 60 * 60 * 1000); // 每小时检查一次

// --- 占位符替换 ---
// 这个函数需要从 VCP 主服务获取日记等动态数据，
// 但插件是独立进程，不能直接访问主服务的 pluginManager。
// 解决方案：
// 1. 主服务在调用插件时，预先替换一部分占位符，或者将相关数据作为参数传递。
// 2. 插件通过某种方式回调主服务查询（复杂，不推荐stdio插件）。
// 3. 简化：插件只处理它能独立处理的占位符（Date, Time），日记本等由主服务处理。
// 目前 server.js 的 replaceCommonVariables 已经很完善，理想情况下应该复用。
// 但由于插件独立性，这里先实现一个简化的版本，主要处理 {{Date}} 和 {{Time}}
// {{XX日记本}} 的替换逻辑将依赖于主服务在将用户输入传递给此插件前进行处理。
async function replacePlaceholders(text, agentConfig) {
    if (text == null) return '';
    let processedText = String(text);

    const now = new Date();
    const date = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    processedText = processedText.replace(/\{\{Date\}\}/g, date);
    const time = now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
    processedText = processedText.replace(/\{\{Time\}\}/g, time);
    const today = now.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: 'Asia/Shanghai' });
    processedText = processedText.replace(/\{\{Today\}\}/g, today);
    
    // 对于 {{XX日记本}} 这类需要从其他插件获取数据的占位符，
    // AgentAssistant 插件本身无法直接获取。
    // VCP 主服务的 server.js 中的 replaceCommonVariables 函数会在调用AI之前处理这些。
    // 因此，传递到 AgentAssistant 的 prompt 理论上应该已经替换了这些。
    // 如果 Agent 的 systemPrompt 中也包含这类占位符，那么它们将不会被这个插件替换。
    // 这是一个设计上的权衡，除非我们建立更复杂的插件间通信机制。

    // 也可以考虑替换 Agent 特定的占位符，如果定义了的话
    // 例如，如果 agentConfig 中有 `agentConfig.customPlaceholders = { "{{AgentName}}": agentConfig.name }`
    if (agentConfig && agentConfig.name) {
        processedText = processedText.replace(/\{\{AgentName\}\}/g, agentConfig.name);
    }

    return processedText;
}


// --- 主逻辑：处理来自 VCP 的请求 ---
async function handleRequest(input) {
    if (!API_URL || !API_Key) {
        return {
            status: "error",
            error: "AgentAssistant plugin is not configured with API_URL or API_Key."
        };
    }

    let requestData;
    try {
        requestData = JSON.parse(input);
    } catch (e) {
        return { status: "error", error: "Invalid JSON input to AgentAssistant." };
    }

    const { agent_name, prompt } = requestData;

    if (!agent_name || !prompt) {
        return { status: "error", error: "Missing 'agent_name' or 'prompt' in request." };
    }

    const agentConfig = AGENTS[agent_name];
    if (!agentConfig) {
        return { status: "error", error: `Agent '${agent_name}' not found or not configured.` };
    }

    const userSessionId = requestData.session_id || 'default_user_session'; // 可以从请求中获取会话ID

    try {
        // 1. 替换用户输入中的占位符 (主要是 Date/Time)
        const processedPrompt = await replacePlaceholders(prompt, agentConfig);
        // 2. 替换 Agent 系统提示中的占位符 (主要是 Date/Time)
        const processedSystemPrompt = await replacePlaceholders(agentConfig.systemPrompt, agentConfig);

        // 3. 获取/构建上下文历史
        const history = getAgentSessionHistory(agent_name, userSessionId);
        const messages = [
            { role: 'system', content: processedSystemPrompt },
            ...history,
            { role: 'user', content: processedPrompt }
        ];

        // 4. 构建 API Payload
        const payload = {
            model: agentConfig.id,
            messages: messages,
            max_tokens: agentConfig.maxOutputTokens,
            temperature: agentConfig.temperature,
            stream: false // AgentAssistant 内部调用，通常是非流式的
        };
        
        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] Sending request to API for agent ${agent_name}:`);
            console.error(`[AgentAssistant] Payload (model: ${payload.model}, temp: ${payload.temperature}, max_tokens: ${payload.max_tokens}):`);
            messages.forEach(msg => console.error(`  ${msg.role}: ${(msg.content || '').substring(0,100)}...`));
        }

        // 5. 发起 API 调用
        const response = await axios.post(`${API_URL}/v1/chat/completions`, payload, {
            headers: {
                'Authorization': `Bearer ${API_Key}`,
                'Content-Type': 'application/json'
            },
            timeout: (process.env.PLUGIN_EXECUTION_TIMEOUT || envConfig.PLUGIN_EXECUTION_TIMEOUT || 58000) // 略小于插件清单中的超时
        });
        
        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] Received API response for agent ${agent_name}. Status: ${response.status}`);
            // console.error(`[AgentAssistant] Response data (partial): ${JSON.stringify(response.data).substring(0,200)}...`);
        }

        const assistantResponseContent = response.data?.choices?.[0]?.message?.content;

        if (typeof assistantResponseContent !== 'string') {
            if (DEBUG_MODE) console.error("[AgentAssistant] API response did not contain valid assistant content.", response.data);
            return {
                status: "error",
                error: `Agent '${agent_name}' API response was invalid or missing content.`
            };
        }

        // 6. 更新上下文记忆
        updateAgentSessionHistory(
            agent_name,
            { role: 'user', content: processedPrompt },
            { role: 'assistant', content: assistantResponseContent },
            userSessionId
        );

        // 7. 返回结果
        return {
            status: "success",
            result: assistantResponseContent // VCP 期望的是一个结果字符串
        };

    } catch (error) {
        let errorMessage = `Error calling agent '${agent_name}'.`;
        if (axios.isAxiosError(error)) {
            errorMessage += ` API Status: ${error.response?.status}.`;
            if (error.response?.data?.error?.message) {
                 errorMessage += ` Message: ${error.response.data.error.message}`;
            } else if (typeof error.response?.data === 'string') {
                 errorMessage += ` Data: ${error.response.data.substring(0,100)}`;
            }
        } else if (error instanceof Error) {
            errorMessage += ` ${error.message}`;
        }
        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] Error handling request for agent ${agent_name}:`, error.message);
            if (error.stack) console.error(error.stack.substring(0,500));
        }
        return {
            status: "error",
            error: errorMessage
        };
    }
}

// --- STDIO 通信 ---
let accumulatedInput = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
    accumulatedInput += chunk;
    // 简单地假设一次性接收所有输入，或者用分隔符
    // 对于VCP的stdio插件，通常是完整的JSON输入后关闭stdin
});

process.stdin.on('end', async () => {
    if (accumulatedInput.trim()) {
        try {
            const output = await handleRequest(accumulatedInput.trim());
            process.stdout.write(JSON.stringify(output));
        } catch (e) {
            // 这个 catch 理论上不应该被触发，因为 handleRequest 内部会捕获错误并返回JSON
            process.stdout.write(JSON.stringify({ status: "error", error: `Critical error in AgentAssistant: ${e.message}` }));
        }
    } else {
        process.stdout.write(JSON.stringify({ status: "error", error: "No input received by AgentAssistant." }));
    }
    process.exit(0); // 确保插件在处理完一次请求后退出
});

// 优雅退出处理 (可选，但对于清理资源有好处)
process.on('SIGINT', () => {
    if (DEBUG_MODE) console.error('[AgentAssistant] Received SIGINT. Exiting.');
    process.exit(0);
});
process.on('SIGTERM', () => {
    if (DEBUG_MODE) console.error('[AgentAssistant] Received SIGTERM. Exiting.');
    process.exit(0);
});

// 初始日志，表明插件已启动（主要用于调试）
if (DEBUG_MODE) {
    console.error(`[AgentAssistant] Plugin started. API_URL: ${API_URL ? 'Configured' : 'NOT CONFIGURED'}, API_Key: ${API_Key ? 'Configured' : 'NOT CONFIGURED'}`);
    console.error(`[AgentAssistant] MAX_HISTORY_ROUNDS: ${MAX_HISTORY_ROUNDS}, CONTEXT_TTL_HOURS: ${CONTEXT_TTL_HOURS}`);
    console.error(`[AgentAssistant] Loaded agents: ${Object.keys(AGENTS).join(', ') || 'None'}`);
}
