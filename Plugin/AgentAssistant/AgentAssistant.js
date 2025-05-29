#!/usr/bin/env node
// AgentAssistant.js (DisplayName Enhanced)
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// --- 配置加载 ---
const projectBasePath = process.env.PROJECT_BASE_PATH || path.join(__dirname, '..', '..');
const pluginConfigEnvPath = path.join(__dirname, 'config.env');
const rootConfigEnvPath = path.join(projectBasePath, 'config.env');

let envConfig = {};
if (fs.existsSync(pluginConfigEnvPath)) {
    try {
        envConfig = { ...envConfig, ...dotenv.parse(fs.readFileSync(pluginConfigEnvPath, { encoding: 'utf8' })) };
    } catch (e) {
        console.error(`[AgentAssistant] Error parsing plugin config.env (${pluginConfigEnvPath}):`, e.message);
    }
}
if (fs.existsSync(rootConfigEnvPath)) {
    try {
        const rootEnv = dotenv.parse(fs.readFileSync(rootConfigEnvPath, { encoding: 'utf8' }));
        for (const key in rootEnv) {
            if (!envConfig.hasOwnProperty(key)) {
                envConfig[key] = rootEnv[key];
            }
        }
    } catch (e) {
        console.error(`[AgentAssistant] Error parsing root config.env (${rootConfigEnvPath}):`, e.message);
    }
}

const API_URL = process.env.API_URL || envConfig.API_URL;
const API_KEY = process.env.API_KEY || envConfig.API_KEY;
const MAX_HISTORY_ROUNDS = parseInt(process.env.AGENT_ASSISTANT_MAX_HISTORY_ROUNDS || envConfig.AGENT_ASSISTANT_MAX_HISTORY_ROUNDS || '7', 10);
const CONTEXT_TTL_HOURS = parseInt(process.env.AGENT_ASSISTANT_CONTEXT_TTL_HOURS || envConfig.AGENT_ASSISTANT_CONTEXT_TTL_HOURS || '24', 10);
const DEBUG_MODE = (process.env.DebugMode || envConfig.DebugMode || "False").toLowerCase() === "true";

// --- Agent 加载逻辑 (DisplayName 增强) ---
const AGENTS = {};
const agentBaseNames = new Set();

// First pass: Identify all unique agent base names (e.g., NYNA, CLEO)
for (const key in envConfig) {
    if (key.startsWith('AGENT_') && key.endsWith('_MODEL_ID')) {
        const nameMatch = key.match(/^AGENT_([A-Z0-9_]+)_MODEL_ID$/i); // Regex for ASCII base names
        if (nameMatch && nameMatch[1]) {
            agentBaseNames.add(nameMatch[1].toUpperCase()); // Store base name in uppercase for consistency
        }
    }
}

if (DEBUG_MODE) {
    console.error(`[AgentAssistant] Identified agent base names from config: ${[...agentBaseNames].join(', ') || 'None'}`);
}

// Second pass: Load full agent configuration using the base name
for (const baseName of agentBaseNames) { // e.g., baseName = "NYNA"
    const modelId = envConfig[`AGENT_${baseName}_MODEL_ID`];
    const chineseName = envConfig[`AGENT_${baseName}_CHINESE_NAME`]; // e.g., "小娜"

    if (!modelId) {
        if (DEBUG_MODE) console.error(`[AgentAssistant] Skipping ${baseName}: Missing AGENT_${baseName}_MODEL_ID.`);
        continue;
    }
    if (!chineseName) {
        if (DEBUG_MODE) console.error(`[AgentAssistant] Skipping ${baseName}: Missing AGENT_${baseName}_CHINESE_NAME. This agent won't be callable by its Chinese name.`);
        continue;
    }

    const agentKeyForInvocation = chineseName; // Use "小娜" as the key for AGENTS and for invocation

    const systemPromptTemplate = envConfig[`AGENT_${baseName}_SYSTEM_PROMPT`] || `You are a helpful AI assistant named {{MaidName}}.`;
    // Replace {{MaidName}} in the template with the actual chineseName
    const finalSystemPrompt = systemPromptTemplate.replace(/\{\{MaidName\}\}/g, chineseName);

    const maxOutputTokens = parseInt(envConfig[`AGENT_${baseName}_MAX_OUTPUT_TOKENS`] || '40000', 10);
    const temperature = parseFloat(envConfig[`AGENT_${baseName}_TEMPERATURE`] || '0.7');
    const description = envConfig[`AGENT_${baseName}_DESCRIPTION`] || `Assistant ${agentKeyForInvocation}.`;

    AGENTS[agentKeyForInvocation] = { // Store with "小娜" as key
        id: modelId,
        name: agentKeyForInvocation, // This will be the Chinese name, e.g., "小娜"
        baseName: baseName, // Store "NYNA" for reference if needed
        systemPrompt: finalSystemPrompt, // Store the processed system prompt
        maxOutputTokens: maxOutputTokens,
        temperature: temperature,
        description: description,
    };
    if (DEBUG_MODE) {
        console.error(`[AgentAssistant] Loaded agent: '${agentKeyForInvocation}' (Base: ${baseName}, ModelID: ${modelId})`);
    }
}
// --- End of Agent 加载逻辑 ---

if (Object.keys(AGENTS).length === 0 && DEBUG_MODE) {
    console.error("[AgentAssistant] Warning: No agents were loaded. Please check config.env for AGENT_BASENAME_MODEL_ID and AGENT_BASENAME_CHINESE_NAME definitions.");
}

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
    if (!agentSessions) return;

    const sessionData = agentSessions.get(sessionId);
    if (!sessionData || isContextExpired(sessionData.timestamp)) {
        agentSessions.set(sessionId, { timestamp: Date.now(), history: [userMessage, assistantMessage] });
    } else {
        sessionData.history.push(userMessage, assistantMessage);
        sessionData.timestamp = Date.now();
        const maxMessages = MAX_HISTORY_ROUNDS * 2;
        if (sessionData.history.length > maxMessages) {
            sessionData.history = sessionData.history.slice(-maxMessages);
        }
    }
}

function isContextExpired(timestamp) {
    return (Date.now() - timestamp) > (CONTEXT_TTL_HOURS * 60 * 60 * 1000);
}

setInterval(() => {
    if (DEBUG_MODE) console.error(`[AgentAssistant] Running periodic context cleanup...`);
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
}, 60 * 60 * 1000);

async function replacePlaceholders(text, agentConfig) { // agentConfig.name is the Chinese Name
    if (text == null) return '';
    let processedText = String(text);
    const now = new Date();
    processedText = processedText.replace(/\{\{Date\}\}/g, now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }));
    processedText = processedText.replace(/\{\{Time\}\}/g, now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }));
    processedText = processedText.replace(/\{\{Today\}\}/g, now.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: 'Asia/Shanghai' }));
    
    // {{AgentName}} can be used in user prompts to refer to the maid being called.
    // The system prompt uses {{MaidName}} which is pre-processed during agent loading.
    if (agentConfig && agentConfig.name) { // agentConfig.name is the Chinese name
        processedText = processedText.replace(/\{\{AgentName\}\}/g, agentConfig.name);
         // For consistency if {{MaidName}} is also used in user prompts.
        processedText = processedText.replace(/\{\{MaidName\}\}/g, agentConfig.name);
    }
    // {{VarHome}}, {{公共日记本}}, {{小X日记本}} are expected to be replaced by VCP server.
    return processedText;
}

async function handleRequest(input) {
    if (!API_URL || !API_KEY) {
        return { status: "error", error: "AgentAssistant plugin is not configured with API_URL or API_KEY." };
    }

    let requestData;
    try {
        requestData = JSON.parse(input);
    } catch (e) {
        return { status: "error", error: "Invalid JSON input to AgentAssistant." };
    }

    const { agent_name, prompt } = requestData; // agent_name is expected to be Chinese Name, e.g., "小娜"

    if (!agent_name || !prompt) {
        return { status: "error", error: "Missing 'agent_name' or 'prompt' in request." };
    }

    const agentConfig = AGENTS[agent_name]; // Lookup using Chinese Name

    if (!agentConfig) {
        const availableAgentNames = Object.keys(AGENTS);
        let errorMessage = `请求的 Agent '${agent_name}' 未找到或未正确配置。`;
        if (availableAgentNames.length > 0) {
            errorMessage += ` 当前已成功加载的 Agent 有: ${availableAgentNames.join(', ')}。`;
        } else {
            errorMessage += ` 系统当前没有加载任何 Agent。请检查 AgentAssistant 的 config.env 配置文件，确保 AGENT_BASENAME_MODEL_ID 和 AGENT_BASENAME_CHINESE_NAME 定义正确无误。`;
        }
        errorMessage += " 请确认您请求的 Agent 名称是否准确。";
        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] Failed to find agent: '${agent_name}'. Loaded agents: ${availableAgentNames.join(', ') || '无'}`);
        }
        return { status: "error", error: errorMessage };
    }

    const userSessionId = requestData.session_id || `agent_${agentConfig.baseName}_default_user_session`; // Use baseName for session ID consistency

    try {
        // SystemPrompt is already processed with Chinese name during agent loading.
        // We only need to process placeholders in the user's prompt here.
        const processedPrompt = await replacePlaceholders(prompt, agentConfig);
        
        const history = getAgentSessionHistory(agent_name, userSessionId); // Use Chinese name for context key
        const messages = [
            { role: 'system', content: agentConfig.systemPrompt }, // Already processed
            ...history,
            { role: 'user', content: processedPrompt }
        ];
        
        const payload = {
            model: agentConfig.id,
            messages: messages,
            max_tokens: agentConfig.maxOutputTokens,
            temperature: agentConfig.temperature,
            stream: false
        };
        
        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] Sending request to API for agent ${agent_name} (Base: ${agentConfig.baseName}):`);
            console.error(`[AgentAssistant] Payload (model: ${payload.model}, temp: ${payload.temperature}, max_tokens: ${payload.max_tokens}):`);
            messages.forEach(msg => console.error(`  ${msg.role}: ${(msg.content || '').substring(0,100)}...`));
        }

        const response = await axios.post(`${API_URL}/v1/chat/completions`, payload, {
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            timeout: (parseInt(process.env.PLUGIN_COMMUNICATION_TIMEOUT) || 118000)
        });
        
        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] Received API response for agent ${agent_name}. Status: ${response.status}`);
        }

        const assistantResponseContent = response.data?.choices?.[0]?.message?.content;

        if (typeof assistantResponseContent !== 'string') {
            if (DEBUG_MODE) console.error("[AgentAssistant] API response did not contain valid assistant content for agent " + agent_name, response.data);
            return { status: "error", error: `Agent '${agent_name}' 的 API 响应无效或缺失内容。` };
        }

        updateAgentSessionHistory(
            agent_name, // Use Chinese name for context key
            { role: 'user', content: processedPrompt },
            { role: 'assistant', content: assistantResponseContent },
            userSessionId
        );

        return { status: "success", result: assistantResponseContent };

    } catch (error) {
        let errorMessage = `调用 Agent '${agent_name}' (Base: ${agentConfig.baseName}) 时发生错误。`;
        // ... (rest of error handling from previous version)
        if (axios.isAxiosError(error)) {
            errorMessage += ` API 状态: ${error.response?.status}.`;
            if (error.response?.data?.error?.message) {
                 errorMessage += ` 错误信息: ${error.response.data.error.message}`;
            } else if (typeof error.response?.data === 'string') {
                 errorMessage += ` 返回数据: ${error.response.data.substring(0,150)}`;
            } else if (error.message.includes('timeout')) {
                errorMessage += ` 请求超时 (超过 ${ (parseInt(process.env.PLUGIN_COMMUNICATION_TIMEOUT) || 118000)/1000 }s)。`;
            }
        } else if (error instanceof Error) {
            errorMessage += ` ${error.message}`;
        }
        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] Error handling request for agent ${agent_name}:`, error.message);
            if (error.stack && !axios.isAxiosError(error)) console.error(error.stack.substring(0,500));
        }
        return { status: "error", error: errorMessage };
    }
}

// --- STDIO 通信 和 启动日志 (与上一版本类似) ---
let accumulatedInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { accumulatedInput += chunk; });
process.stdin.on('end', async () => {
    if (accumulatedInput.trim()) {
        try {
            const output = await handleRequest(accumulatedInput.trim());
            process.stdout.write(JSON.stringify(output));
        } catch (e) {
            process.stdout.write(JSON.stringify({ status: "error", error: `AgentAssistant 插件发生严重内部错误: ${e.message}` }));
        }
    } else {
        process.stdout.write(JSON.stringify({ status: "error", error: "AgentAssistant 未收到任何输入。" }));
    }
    process.exit(0);
});

if (DEBUG_MODE) {
    console.error(`[AgentAssistant] Plugin started. API_URL: ${API_URL ? 'Configured' : 'NOT CONFIGURED'}, API_KEY: ${API_KEY ? 'Configured' : 'NOT CONFIGURED'}`);
    console.error(`[AgentAssistant] MAX_HISTORY_ROUNDS: ${MAX_HISTORY_ROUNDS}, CONTEXT_TTL_HOURS: ${CONTEXT_TTL_HOURS}`);
    console.error(`[AgentAssistant] Attempting to load agents using AGENT_BASENAME_MODEL_ID and AGENT_BASENAME_CHINESE_NAME from config.env.`);
}

if (DEBUG_MODE) {
    setTimeout(() => {
        const loadedAgentNames = Object.keys(AGENTS);
        if (loadedAgentNames.length > 0) {
            console.error(`[AgentAssistant] Successfully loaded agents (callable by Chinese Name): ${loadedAgentNames.join(', ')}`);
        } else {
            console.error(`[AgentAssistant] Warning: No agents were loaded. Please check config.env for AGENT_BASENAME_MODEL_ID and AGENT_BASENAME_CHINESE_NAME definitions.`);
        }
    }, 100);
}
