#!/usr/bin/env node
// AgentAssistant.js (Layered Config Loading)
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// --- VCP 主服务器配置 (for self-calling, from main env passed as process.env) ---
const VCP_SERVER_PORT = process.env.PORT;
const VCP_SERVER_ACCESS_KEY = process.env.Key; // Assuming 'Key' is the env var name for VCP access key

// --- AgentAssistant 插件行为配置 (from main env via configSchema, passed as process.env) ---
const MAX_HISTORY_ROUNDS = parseInt(process.env.AGENT_ASSISTANT_MAX_HISTORY_ROUNDS || '7', 10);
const CONTEXT_TTL_HOURS = parseInt(process.env.AGENT_ASSISTANT_CONTEXT_TTL_HOURS || '24', 10);
const DEBUG_MODE = (process.env.DebugMode || "False").toLowerCase() === "true";

// --- Agent 定义 (从插件自身的 config.env 加载) ---
const AGENTS = {};
const pluginConfigEnvPath = path.join(__dirname, 'config.env'); // Expects Plugin/AgentAssistant/config.env
let pluginLocalEnvConfig = {}; // This will hold content from the plugin's own config.env

if (fs.existsSync(pluginConfigEnvPath)) {
    try {
        const fileContent = fs.readFileSync(pluginConfigEnvPath, { encoding: 'utf8' });
        pluginLocalEnvConfig = dotenv.parse(fileContent);
        if (DEBUG_MODE) console.error(`[AgentAssistant] Successfully parsed plugin's local config.env: ${pluginConfigEnvPath}`); // MODIFIED
    } catch (e) {
        console.error(`[AgentAssistant] Error parsing plugin's local config.env (${pluginConfigEnvPath}): ${e.message}. No agents will be loaded from it.`);
    }
} else {
    if (DEBUG_MODE) console.error(`[AgentAssistant] Plugin's local config.env not found at: ${pluginConfigEnvPath}. No agents will be loaded.`); // MODIFIED (was warn)
}

const agentBaseNames = new Set();
// First pass: Identify base names from the plugin's local config (pluginLocalEnvConfig)
for (const key in pluginLocalEnvConfig) {
    if (key.startsWith('AGENT_') && key.endsWith('_MODEL_ID')) {
        const nameMatch = key.match(/^AGENT_([A-Z0-9_]+)_MODEL_ID$/i); // ASCII base names
        if (nameMatch && nameMatch[1]) {
            agentBaseNames.add(nameMatch[1].toUpperCase());
        }
    }
}

if (DEBUG_MODE) {
    console.error(`[AgentAssistant] Identified agent base names from plugin's local config: ${[...agentBaseNames].join(', ') || 'None'}`); // MODIFIED
}

// Second pass: Load full agent configuration using base name from plugin's local config (pluginLocalEnvConfig)
for (const baseName of agentBaseNames) {
    const modelId = pluginLocalEnvConfig[`AGENT_${baseName}_MODEL_ID`];
    const chineseName = pluginLocalEnvConfig[`AGENT_${baseName}_CHINESE_NAME`]; // Or any display name

    if (!modelId) {
        if (DEBUG_MODE) console.error(`[AgentAssistant] Skipping agent ${baseName} from local config: Missing AGENT_${baseName}_MODEL_ID.`); // MODIFIED (was warn)
        continue;
    }
    if (!chineseName) {
        if (DEBUG_MODE) console.error(`[AgentAssistant] Skipping agent ${baseName} from local config: Missing AGENT_${baseName}_CHINESE_NAME.`); // MODIFIED (was warn)
        continue;
    }

    const agentKeyForInvocation = chineseName;
    const systemPromptTemplate = pluginLocalEnvConfig[`AGENT_${baseName}_SYSTEM_PROMPT`] || `You are a helpful AI assistant named {{MaidName}}.`;
    const finalSystemPrompt = systemPromptTemplate.replace(/\{\{MaidName\}\}/g, chineseName);
    const maxOutputTokens = parseInt(pluginLocalEnvConfig[`AGENT_${baseName}_MAX_OUTPUT_TOKENS`] || '40000', 10);
    const temperature = parseFloat(pluginLocalEnvConfig[`AGENT_${baseName}_TEMPERATURE`] || '0.7');
    const description = pluginLocalEnvConfig[`AGENT_${baseName}_DESCRIPTION`] || `Assistant ${agentKeyForInvocation}.`;

    AGENTS[agentKeyForInvocation] = {
        id: modelId,
        name: agentKeyForInvocation,
        baseName: baseName,
        systemPrompt: finalSystemPrompt,
        maxOutputTokens: maxOutputTokens,
        temperature: temperature,
        description: description,
    };
    if (DEBUG_MODE) {
        console.error(`[AgentAssistant] Loaded agent from local config: '${agentKeyForInvocation}' (Base: ${baseName}, ModelID: ${modelId})`); // MODIFIED
    }
}
// --- End of Agent 加载逻辑 ---

if (Object.keys(AGENTS).length === 0 && DEBUG_MODE) {
    console.error("[AgentAssistant] Warning: No agents were loaded. Check plugin's local config.env for AGENT_BASENAME_MODEL_ID and AGENT_BASENAME_CHINESE_NAME definitions."); // MODIFIED (was warn)
}

const agentContexts = new Map(); // 上下文管理逻辑保持不变

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
    if (DEBUG_MODE && Object.keys(agentContexts).length > 0) console.error(`[AgentAssistant] Running periodic context cleanup...`); // MODIFIED
    for (const [agentName, sessions] of agentContexts) {
        for (const [sessionId, sessionData] of sessions) {
            if (isContextExpired(sessionData.timestamp)) {
                sessions.delete(sessionId);
                if (DEBUG_MODE) console.error(`[AgentAssistant] Cleared expired context for agent ${agentName}, session ${sessionId}`); // MODIFIED
            }
        }
        if (sessions.size === 0) {
            agentContexts.delete(agentName);
        }
    }
}, 60 * 60 * 1000);

async function replacePlaceholdersInUserPrompt(text, agentConfig) {
    if (text == null) return '';
    let processedText = String(text);
    if (agentConfig && agentConfig.name) {
        processedText = processedText.replace(/\{\{AgentName\}\}/g, agentConfig.name);
        processedText = processedText.replace(/\{\{MaidName\}\}/g, agentConfig.name);
    }
    return processedText;
}

async function handleRequest(input) {
    if (!VCP_SERVER_PORT || !VCP_SERVER_ACCESS_KEY) {
        const errorMsg = "AgentAssistant Critical Error: VCP Server PORT or Access Key is not available in the plugin's environment. Cannot make self-calls to VCP server.";
        if (DEBUG_MODE) console.error(`[AgentAssistant] ${errorMsg}`); // This was already console.error
        return { status: "error", error: errorMsg };
    }
    const VCP_API_TARGET_URL = `http://localhost:${VCP_SERVER_PORT}/v1`;

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
        const availableAgentNames = Object.keys(AGENTS);
        let errorMessage = `请求的 Agent '${agent_name}' 未找到或未正确配置。`;
        if (availableAgentNames.length > 0) {
            errorMessage += ` 当前插件本地 config.env 中已成功加载的 Agent 有: ${availableAgentNames.join(', ')}。`;
        } else {
            errorMessage += ` 当前插件本地 config.env 中没有加载任何 Agent。请检查 Plugin/AgentAssistant/config.env 文件，确保 AGENT_BASENAME_MODEL_ID 和 AGENT_BASENAME_CHINESE_NAME 定义正确无误。`;
        }
        errorMessage += " 请确认您请求的 Agent 名称是否准确。";
        if (DEBUG_MODE) console.error(`[AgentAssistant] Failed to find agent: '${agent_name}'. Loaded from local: ${availableAgentNames.join(', ') || 'None'}`); // This was already console.error
        return { status: "error", error: errorMessage };
    }

    const userSessionId = requestData.session_id || `agent_${agentConfig.baseName}_default_user_session`;

    try {
        const processedUserPrompt = await replacePlaceholdersInUserPrompt(prompt, agentConfig);
        const history = getAgentSessionHistory(agent_name, userSessionId);
        const messagesForVCP = [
            { role: 'system', content: agentConfig.systemPrompt },
            ...history,
            { role: 'user', content: processedUserPrompt }
        ];
        const payloadForVCP = {
            model: agentConfig.id,
            messages: messagesForVCP,
            max_tokens: agentConfig.maxOutputTokens,
            temperature: agentConfig.temperature,
            stream: false
        };
        
        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] Sending request to VCP Server (${VCP_API_TARGET_URL}/chat/completions) for agent ${agent_name} (Base: ${agentConfig.baseName})`); // MODIFIED
            // console.error(`[AgentAssistant] Payload for VCP:`, JSON.stringify(payloadForVCP, null, 2)); // MODIFIED (if uncommented)
        }

        const responseFromVCP = await axios.post(`${VCP_API_TARGET_URL}/chat/completions`, payloadForVCP, {
            headers: { 
                'Authorization': `Bearer ${VCP_SERVER_ACCESS_KEY}`, 
                'Content-Type': 'application/json' 
            },
            timeout: (parseInt(process.env.PLUGIN_COMMUNICATION_TIMEOUT) || 118000)
        });
        
        const assistantResponseContent = responseFromVCP.data?.choices?.[0]?.message?.content;
        if (typeof assistantResponseContent !== 'string') {
            if (DEBUG_MODE) console.error("[AgentAssistant] Response from VCP Server did not contain valid assistant content for agent " + agent_name, responseFromVCP.data); // This was already console.error
            return { status: "error", error: `Agent '${agent_name}' 从VCP服务器获取的响应无效或缺失内容。` };
        }

        updateAgentSessionHistory(
            agent_name,
            { role: 'user', content: processedUserPrompt },
            { role: 'assistant', content: assistantResponseContent },
            userSessionId
        );
        return { status: "success", result: assistantResponseContent };

    } catch (error) {
        let errorMessage = `调用 Agent '${agent_name}' (Base: ${agentConfig.baseName}, via VCP callback) 时发生错误。`;
        if (axios.isAxiosError(error)) {
            errorMessage += ` API Status: ${error.response?.status}.`;
            if (error.response?.data?.error?.message) {
                 errorMessage += ` Message: ${error.response.data.error.message}`;
            } else if (typeof error.response?.data === 'string') {
                 errorMessage += ` Data: ${error.response.data.substring(0,150)}`;
            } else if (error.message.includes('timeout')) {
                errorMessage += ` Request to VCP server timed out.`;
            }
        } else if (error instanceof Error) {
            errorMessage += ` ${error.message}`;
        }
        if (DEBUG_MODE) console.error(`[AgentAssistant] Error in handleRequest for ${agent_name}: ${errorMessage}`, error.stack ? error.stack.substring(0, 500) : ''); // This was already console.error
        return { status: "error", error: errorMessage };
    }
}

// --- STDIO 通信 ---
let accumulatedInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { accumulatedInput += chunk; });
process.stdin.on('end', async () => {
    if (accumulatedInput.trim()) {
        try {
            const output = await handleRequest(accumulatedInput.trim());
            process.stdout.write(JSON.stringify(output));
        } catch (e) {
            const criticalErrorMsg = `AgentAssistant plugin encountered a critical internal error: ${e.message}`;
            if (DEBUG_MODE) console.error(`[AgentAssistant] ${criticalErrorMsg}`); // This was already console.error
            process.stdout.write(JSON.stringify({ status: "error", error: criticalErrorMsg }));
        }
    } else {
        const noInputMsg = "AgentAssistant received no input.";
        if (DEBUG_MODE) console.error(`[AgentAssistant] ${noInputMsg}`); // MODIFIED (was warn)
        process.stdout.write(JSON.stringify({ status: "error", error: noInputMsg }));
    }
    if (DEBUG_MODE) { setTimeout(() => process.exit(0), 100); } 
    else { process.exit(0); }
});

if (DEBUG_MODE) {
    console.error(`[AgentAssistant] Plugin starting (Layered Config Mode). VCP PORT: ${VCP_SERVER_PORT || 'NOT FOUND IN ENV'}, VCP Key: ${VCP_SERVER_ACCESS_KEY ? 'FOUND' : 'NOT FOUND IN ENV'}.`); // MODIFIED
    console.error(`[AgentAssistant] History rounds from env: ${MAX_HISTORY_ROUNDS}, Context TTL from env: ${CONTEXT_TTL_HOURS}h.`); // MODIFIED
    console.error(`[AgentAssistant] Attempting to load agent definitions from plugin's local config.env: ${pluginConfigEnvPath}`); // MODIFIED
    setTimeout(() => {
        const loadedAgentNames = Object.keys(AGENTS);
        if (loadedAgentNames.length > 0) {
            console.error(`[AgentAssistant] Agents loaded from local config: ${loadedAgentNames.join(', ')}`); // MODIFIED
        } else {
            console.error(`[AgentAssistant] No agents loaded from local config. Check ${pluginConfigEnvPath} and its AGENT_BASENAME_MODEL_ID / AGENT_BASENAME_CHINESE_NAME definitions.`); // MODIFIED (was warn)
        }
        if (!VCP_SERVER_PORT || !VCP_SERVER_ACCESS_KEY) {
            console.error(`[AgentAssistant] CRITICAL: Plugin may not function correctly for VCP self-calls without VCP_SERVER_PORT and VCP_SERVER_ACCESS_KEY from its environment.`); // This was already console.error
        }
    }, 150);
}
