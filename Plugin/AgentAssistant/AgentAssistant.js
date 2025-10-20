// AgentAssistant.js (Service Module)
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// --- State and Config Variables ---
let VCP_SERVER_PORT;
let VCP_SERVER_ACCESS_KEY;
let MAX_HISTORY_ROUNDS;
let CONTEXT_TTL_HOURS;
let DEBUG_MODE;
let VCP_API_TARGET_URL;

const AGENTS = {};
const agentContexts = new Map();
let pushVcpInfo = () => {}; // Default no-op function
let cleanupInterval;

// --- Core Module Functions ---

/**
 * Initializes the AgentAssistant service module.
 * This is called by the PluginManager when the plugin is loaded.
 * @param {object} config - The configuration object passed from PluginManager.
 * @param {object} dependencies - An object containing dependencies, like vcpLogFunctions.
 */
function initialize(config, dependencies) {
    VCP_SERVER_PORT = config.PORT;
    VCP_SERVER_ACCESS_KEY = config.Key;
    MAX_HISTORY_ROUNDS = parseInt(config.AGENT_ASSISTANT_MAX_HISTORY_ROUNDS || '7', 10);
    CONTEXT_TTL_HOURS = parseInt(config.AGENT_ASSISTANT_CONTEXT_TTL_HOURS || '24', 10);
    DEBUG_MODE = (config.DebugMode || "False").toLowerCase() === "true";
    VCP_API_TARGET_URL = `http://localhost:${VCP_SERVER_PORT}/v1`;

    if (DEBUG_MODE) {
        console.error(`[AgentAssistant Service] Initializing...`);
        console.error(`[AgentAssistant Service] VCP PORT: ${VCP_SERVER_PORT}, VCP Key: ${VCP_SERVER_ACCESS_KEY ? 'FOUND' : 'NOT FOUND'}`);
        console.error(`[AgentAssistant Service] History rounds: ${MAX_HISTORY_ROUNDS}, Context TTL: ${CONTEXT_TTL_HOURS}h.`);
    }

    loadAgentsFromLocalConfig();

    if (dependencies && dependencies.vcpLogFunctions && typeof dependencies.vcpLogFunctions.pushVcpInfo === 'function') {
        pushVcpInfo = dependencies.vcpLogFunctions.pushVcpInfo;
        if (DEBUG_MODE) console.error('[AgentAssistant Service] pushVcpInfo dependency injected successfully.');
    } else {
        console.error('[AgentAssistant Service] Warning: pushVcpInfo dependency injection failed. Broadcasts will be ignored.');
    }

    if (cleanupInterval) clearInterval(cleanupInterval);
    cleanupInterval = setInterval(periodicCleanup, 60 * 60 * 1000);
    
    console.log('[AgentAssistant Service] Initialized successfully.');
}

/**
 * Shuts down the service, clearing any intervals.
 */
function shutdown() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        if (DEBUG_MODE) console.error('[AgentAssistant Service] Context cleanup interval stopped.');
    }
    console.log('[AgentAssistant Service] Shutdown complete.');
}

/**
 * Loads agent definitions from the plugin's local config.env file.
 */
function loadAgentsFromLocalConfig() {
    const pluginConfigEnvPath = path.join(__dirname, 'config.env');
    let pluginLocalEnvConfig = {};

    if (fs.existsSync(pluginConfigEnvPath)) {
        try {
            const fileContent = fs.readFileSync(pluginConfigEnvPath, { encoding: 'utf8' });
            pluginLocalEnvConfig = dotenv.parse(fileContent);
        } catch (e) {
            console.error(`[AgentAssistant Service] Error parsing plugin's local config.env (${pluginConfigEnvPath}): ${e.message}.`);
            return;
        }
    } else {
        if (DEBUG_MODE) console.error(`[AgentAssistant Service] Plugin's local config.env not found at: ${pluginConfigEnvPath}.`);
        return;
    }

    const AGENT_ALL_SYSTEM_PROMPT = pluginLocalEnvConfig.AGENT_ALL_SYSTEM_PROMPT || "";
    const agentBaseNames = new Set();
    Object.keys(AGENTS).forEach(key => delete AGENTS[key]); // Clear existing agents

    for (const key in pluginLocalEnvConfig) {
        if (key.startsWith('AGENT_') && key.endsWith('_MODEL_ID')) {
            const nameMatch = key.match(/^AGENT_([A-Z0-9_]+)_MODEL_ID$/i);
            if (nameMatch && nameMatch[1]) agentBaseNames.add(nameMatch[1].toUpperCase());
        }
    }

    if (DEBUG_MODE) console.error(`[AgentAssistant Service] Identified agent base names: ${[...agentBaseNames].join(', ') || 'None'}`);

    for (const baseName of agentBaseNames) {
        const modelId = pluginLocalEnvConfig[`AGENT_${baseName}_MODEL_ID`];
        const chineseName = pluginLocalEnvConfig[`AGENT_${baseName}_CHINESE_NAME`];

        if (!modelId || !chineseName) {
            if (DEBUG_MODE) console.error(`[AgentAssistant Service] Skipping agent ${baseName}: Missing MODEL_ID or CHINESE_NAME.`);
            continue;
        }

        const systemPromptTemplate = pluginLocalEnvConfig[`AGENT_${baseName}_SYSTEM_PROMPT`] || `You are a helpful AI assistant named {{MaidName}}.`;
        let finalSystemPrompt = systemPromptTemplate.replace(/\{\{MaidName\}\}/g, chineseName);
        if (AGENT_ALL_SYSTEM_PROMPT) finalSystemPrompt += `\n\n${AGENT_ALL_SYSTEM_PROMPT}`;

        AGENTS[chineseName] = {
            id: modelId,
            name: chineseName,
            baseName: baseName,
            systemPrompt: finalSystemPrompt,
            maxOutputTokens: parseInt(pluginLocalEnvConfig[`AGENT_${baseName}_MAX_OUTPUT_TOKENS`] || '40000', 10),
            temperature: parseFloat(pluginLocalEnvConfig[`AGENT_${baseName}_TEMPERATURE`] || '0.7'),
            description: pluginLocalEnvConfig[`AGENT_${baseName}_DESCRIPTION`] || `Assistant ${chineseName}.`,
        };
        if (DEBUG_MODE) console.error(`[AgentAssistant Service] Loaded agent: '${chineseName}' (Base: ${baseName}, ModelID: ${modelId})`);
    }
    if (Object.keys(AGENTS).length === 0 && DEBUG_MODE) {
        console.error("[AgentAssistant Service] Warning: No agents were loaded.");
    }
}

// --- Context Management ---

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
    let sessionData = agentSessions.get(sessionId);
    if (!sessionData || isContextExpired(sessionData.timestamp)) {
        sessionData = { timestamp: Date.now(), history: [] };
        agentSessions.set(sessionId, sessionData);
    }
    sessionData.history.push(userMessage, assistantMessage);
    sessionData.timestamp = Date.now();
    const maxMessages = MAX_HISTORY_ROUNDS * 20;
    if (sessionData.history.length > maxMessages) {
        sessionData.history = sessionData.history.slice(-maxMessages);
    }
}

function isContextExpired(timestamp) {
    return (Date.now() - timestamp) > (CONTEXT_TTL_HOURS * 60 * 60 * 1000);
}

function periodicCleanup() {
    if (DEBUG_MODE && agentContexts.size > 0) console.error(`[AgentAssistant Service] Running periodic context cleanup...`);
    for (const [agentName, sessions] of agentContexts) {
        for (const [sessionId, sessionData] of sessions) {
            if (isContextExpired(sessionData.timestamp)) {
                sessions.delete(sessionId);
                if (DEBUG_MODE) console.error(`[AgentAssistant Service] Cleared expired context for agent ${agentName}, session ${sessionId}`);
            }
        }
        if (sessions.size === 0) {
            agentContexts.delete(agentName);
        }
    }
}

// --- Helper Functions ---

async function replacePlaceholdersInUserPrompt(text, agentConfig) {
    if (text == null) return '';
    let processedText = String(text);
    if (agentConfig && agentConfig.name) {
        processedText = processedText.replace(/\{\{AgentName\}\}/g, agentConfig.name).replace(/\{\{MaidName\}\}/g, agentConfig.name);
    }
    return processedText;
}

function parseAndValidateDate(dateString) {
    if (!dateString) return null;
    const standardizedString = String(dateString).replace(/[/\.]/g, '-');
    const regex = /^(\d{4})-(\d{1,2})-(\d{1,2})-(\d{1,2}):(\d{1,2})$/;
    const match = standardizedString.match(regex);
    if (!match) return null;
    const [, year, month, day, hour, minute] = match.map(Number);
    const date = new Date(year, month - 1, day, hour, minute);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    if (date.getTime() <= Date.now()) return 'past';
    return date;
}

/**
 * This is the main entry point for handling tool calls from PluginManager.
 * @param {object} args - The arguments for the tool call.
 * @returns {Promise<object>} A promise that resolves to the result of the tool call.
 */
async function processToolCall(args) {
    if (!VCP_SERVER_PORT || !VCP_SERVER_ACCESS_KEY) {
        const errorMsg = "AgentAssistant Critical Error: VCP Server PORT or Access Key is not configured.";
        if (DEBUG_MODE) console.error(`[AgentAssistant Service] ${errorMsg}`);
        return { status: "error", error: errorMsg };
    }

    const { agent_name, prompt, timely_contact } = args;
    if (!agent_name || !prompt) {
        return { status: "error", error: "Missing 'agent_name' or 'prompt' in request." };
    }

    const agentConfig = AGENTS[agent_name];
    if (!agentConfig) {
        const availableAgentNames = Object.keys(AGENTS);
        let errorMessage = `请求的 Agent '${agent_name}' 未找到。`;
        errorMessage += availableAgentNames.length > 0 ? ` 当前可用的 Agent 有: ${availableAgentNames.join(', ')}。` : ` 当前没有加载任何 Agent。`;
        if (DEBUG_MODE) console.error(`[AgentAssistant Service] Failed to find agent: '${agent_name}'.`);
        return { status: "error", error: errorMessage };
    }

    // Handle future calls (timely_contact)
    if (timely_contact) {
        const targetDate = parseAndValidateDate(timely_contact);
        if (!targetDate) return { status: "error", error: `无效的 'timely_contact' 时间格式: '${timely_contact}'。请使用 YYYY-MM-DD-HH:mm 格式。` };
        if (targetDate === 'past') return { status: "error", error: `无效的 'timely_contact' 时间: '${timely_contact}'。不能设置为过去的时间。` };

        try {
            const schedulerPayload = {
                schedule_time: targetDate.toISOString(),
                task_id: `task-${targetDate.getTime()}-${uuidv4()}`,
                tool_call: { tool_name: "AgentAssistant", arguments: { agent_name, prompt } }
            };
            if (DEBUG_MODE) console.error(`[AgentAssistant Service] Calling /v1/schedule_task with payload:`, JSON.stringify(schedulerPayload, null, 2));

            const response = await axios.post(`${VCP_API_TARGET_URL}/schedule_task`, schedulerPayload, {
                headers: { 'Authorization': `Bearer ${VCP_SERVER_ACCESS_KEY}`, 'Content-Type': 'application/json' },
                timeout: 15000
            });

            if (response.data && response.data.status === "success") {
                const formattedDate = `${targetDate.getFullYear()}年${targetDate.getMonth() + 1}月${targetDate.getDate()}日 ${targetDate.getHours().toString().padStart(2, '0')}:${targetDate.getMinutes().toString().padStart(2, '0')}`;
                const friendlyReceipt = `您预定于 ${formattedDate} 发给 ${agent_name} 的未来通讯已经被系统记录，届时会自动发送。`;
                return { status: "success", result: friendlyReceipt };
            } else {
                const errorMessage = `调度任务失败: ${response.data?.error || '服务器返回未知错误'}`;
                if (DEBUG_MODE) console.error(`[AgentAssistant Service] ${errorMessage}`, response.data);
                return { status: "error", error: errorMessage };
            }
        } catch (error) {
            let errorMessage = "调用任务调度API时发生网络或内部错误。";
            if (axios.isAxiosError(error)) errorMessage += ` API Status: ${error.response?.status}. Message: ${error.response?.data?.error || error.message}`;
            else errorMessage += ` ${error.message}`;
            if (DEBUG_MODE) console.error(`[AgentAssistant Service] Error calling /v1/schedule_task:`, errorMessage);
            return { status: "error", error: errorMessage };
        }
    }

    // Handle immediate chat
    const userSessionId = args.session_id || `agent_${agentConfig.baseName}_default_user_session`;
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
        
        if (DEBUG_MODE) console.error(`[AgentAssistant Service] Sending request to VCP Server for agent ${agent_name}`);

        const responseFromVCP = await axios.post(`${VCP_API_TARGET_URL}/chat/completions`, payloadForVCP, {
            headers: { 'Authorization': `Bearer ${VCP_SERVER_ACCESS_KEY}`, 'Content-Type': 'application/json' },
            timeout: (parseInt(process.env.PLUGIN_COMMUNICATION_TIMEOUT) || 118000)
        });
        
        const assistantResponseContent = responseFromVCP.data?.choices?.[0]?.message?.content;
        if (typeof assistantResponseContent !== 'string') {
            if (DEBUG_MODE) console.error("[AgentAssistant Service] Response from VCP Server did not contain valid assistant content for agent " + agent_name, responseFromVCP.data);
            return { status: "error", error: `Agent '${agent_name}' 从VCP服务器获取的响应无效或缺失内容。` };
        }

        updateAgentSessionHistory(agent_name, { role: 'user', content: processedUserPrompt }, { role: 'assistant', content: assistantResponseContent }, userSessionId);
        
        // VCP Info Broadcast
        const broadcastData = {
            type: 'AGENT_PRIVATE_CHAT_PREVIEW',
            agentName: agent_name,
            sessionId: userSessionId,
            query: processedUserPrompt,
            response: assistantResponseContent,
            timestamp: new Date().toISOString()
        };
        try {
            // 关键修复：在调用时动态获取最新的 PluginManager 实例和 VCPLog 函数，以避免初始化阶段的陈旧引用。
            const pluginManager = require('../../Plugin.js');
            const freshVcpLogFunctions = pluginManager.getVCPLogFunctions();
            if (freshVcpLogFunctions && typeof freshVcpLogFunctions.pushVcpInfo === 'function') {
                freshVcpLogFunctions.pushVcpInfo(broadcastData);
                if (DEBUG_MODE) console.error(`[AgentAssistant Service] VCP Info broadcasted for chat with ${agent_name}.`);
            } else {
                if (DEBUG_MODE) console.error(`[AgentAssistant Service] Could not get fresh pushVcpInfo function.`);
            }
        } catch (e) {
            console.error('[AgentAssistant Service] Error broadcasting VCP Info:', e.message);
        }
        
        return { status: "success", result: assistantResponseContent };

    } catch (error) {
        let errorMessage = `调用 Agent '${agent_name}' 时发生错误。`;
        if (axios.isAxiosError(error)) {
            errorMessage += ` API Status: ${error.response?.status}.`;
            if (error.response?.data?.error?.message) errorMessage += ` Message: ${error.response.data.error.message}`;
            else if (typeof error.response?.data === 'string') errorMessage += ` Data: ${error.response.data.substring(0,150)}`;
            else if (error.message.includes('timeout')) errorMessage += ` Request to VCP server timed out.`;
        } else if (error instanceof Error) {
            errorMessage += ` ${error.message}`;
        }
        if (DEBUG_MODE) console.error(`[AgentAssistant Service] Error in processToolCall for ${agent_name}: ${errorMessage}`);
        return { status: "error", error: errorMessage };
    }
}

module.exports = {
    initialize,
    shutdown,
    processToolCall
};
