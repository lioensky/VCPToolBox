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

// --- Task Delegation Config Variables ---
let DELEGATION_MAX_ROUNDS;
let DELEGATION_TIMEOUT;
let DELEGATION_SYSTEM_PROMPT;
let DELEGATION_HEARTBEAT_PROMPT;

const AGENTS = {};
const agentContexts = new Map();
const activeSessionLocks = new Set(); // 追踪正在进行中的持久对话 session
const activeDelegations = new Map(); // delegationId -> { status, agentName, currentRound, startTime }

let pushVcpInfo = () => { }; // Default no-op function
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
    DEBUG_MODE = String(config.DebugMode || 'false').toLowerCase() === 'true';
    // 使用 127.0.0.1 避开某些系统上 localhost 解析到 IPv6 (::1) 导致的延迟
    VCP_API_TARGET_URL = `http://127.0.0.1:${VCP_SERVER_PORT}/v1`;

    DELEGATION_MAX_ROUNDS = parseInt(config.DELEGATION_MAX_ROUNDS || '15', 10);
    DELEGATION_TIMEOUT = parseInt(config.DELEGATION_TIMEOUT || '300000', 10);
    DELEGATION_SYSTEM_PROMPT = config.DELEGATION_SYSTEM_PROMPT || "[异步委托模式]\n你当前正在接受来自 {{SenderName}} 的一项异步委托任务。请专注于完成以下委托内容，按照任务要求认真执行。你可以自由使用你所拥有的的所有工具来完成任务。\n\n[长执行任务优化机制]\n如果当前步骤涉及需要长时间等待的任务（如：视频生成、大型文件处理等），你可以在输出中包含 `[[NextHeartbeat::秒数]]` 占位符。系统将推迟下一次心跳（心跳即：再次唤醒你）的到来，在这段时间内不会产生额外的轮次和Token消耗。例如：如果你预计渲染需要3分钟，可以输出 `[[NextHeartbeat::180]]`。\n\n委托任务内容:\n{{TaskPrompt}}\n\n当你确认任务已经彻底完成后，请输出委托完成报告，格式如下:\n[[TaskComplete]]\n（此处写上你的任务完成报告，详细描述你完成了什么、执行过程和最终结果）\n\n如果你认为任务由于缺少工具、信息或其他原因【完全无法完成】，请输出失败报告，格式如下:\n[[TaskFailed]]\n（此处写上失败原因）";
    DELEGATION_HEARTBEAT_PROMPT = config.DELEGATION_HEARTBEAT_PROMPT || "[系统提示:]当前委托任务仍在进行中。请继续执行你的委托任务。如果你在等待长执行任务，请根据需要输出 `[[NextHeartbeat::秒数]]` 进行推迟。如果任务已完成，请输出 [[TaskComplete]] 及完成报告。如果确认无法完成，请输出 [[TaskFailed]] 及失败原因。";

    if (DEBUG_MODE) {
        console.error(`[AgentAssistant Service] Initializing...`);
        console.error(`[AgentAssistant Service] VCP PORT: ${VCP_SERVER_PORT}, VCP Key: ${VCP_SERVER_ACCESS_KEY ? 'FOUND' : 'NOT FOUND'}`);
        console.error(`[AgentAssistant Service] History rounds: ${MAX_HISTORY_ROUNDS}, Context TTL: ${CONTEXT_TTL_HOURS}h.`);
        console.error(`[AgentAssistant Service] Delegation Max Rounds: ${DELEGATION_MAX_ROUNDS}, Timeout: ${DELEGATION_TIMEOUT}ms`);
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

// --- Agent Score System ---
const AGENT_SCORES_FILE = path.join(__dirname, 'agent_scores.json');

function awardAgentPoints(agentBaseName, agentName, points, reason) {
    try {
        let scores = {};
        if (fs.existsSync(AGENT_SCORES_FILE)) {
            const fileContent = fs.readFileSync(AGENT_SCORES_FILE, 'utf-8');
            if (fileContent.trim()) {
                scores = JSON.parse(fileContent);
            }
        }
        
        if (!scores[agentBaseName]) {
            scores[agentBaseName] = { name: agentName, totalPoints: 0, history: [] };
        }
        
        scores[agentBaseName].totalPoints += points;
        scores[agentBaseName].history.push({
            time: new Date().toISOString(),
            pointsDelta: points,
            reason: reason
        });
        
        // 保留最近 50 条历史获取记录
        if (scores[agentBaseName].history.length > 50) {
            scores[agentBaseName].history.shift();
        }
        
        fs.writeFileSync(AGENT_SCORES_FILE, JSON.stringify(scores, null, 4), 'utf-8');
        if (DEBUG_MODE) console.error(`[AgentAssistant] Awarded ${points} points to ${agentName}. Total: ${scores[agentBaseName].totalPoints}`);
    } catch (e) {
        console.error(`[AgentAssistant] Error updating agent scores: ${e.message}`);
    }
}

// --- Helper Functions ---

/**
 * 移除文本中的 VCP 思维链内容
 * @param {string} text - 需要处理的文本
 * @returns {string} 清理后的文本
 */
function removeVCPThinkingChain(text) {
    if (typeof text !== 'string') return text;

    let result = text;
    const startMarker = '[--- VCP元思考链:';
    const endMarker = '[--- 元思考链结束 ---]';

    // 循环移除所有思维链（可能存在多个）
    while (true) {
        const startIndex = result.indexOf(startMarker);
        if (startIndex === -1) break;

        const endIndex = result.indexOf(endMarker, startIndex);
        if (endIndex === -1) {
            // 找不到结束标记时，移除从开始标记到末尾的内容
            result = result.substring(0, startIndex).trimEnd();
            break;
        }

        // 移除从开始标记到结束标记（包括结束标记）的内容
        result = result.substring(0, startIndex) + result.substring(endIndex + endMarker.length);
    }

    // 清理多余的连续空白行
    result = result.replace(/\n{3,}/g, '\n\n').trim();

    return result;
}

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

function parseInjectTools(injectToolsRaw) {
    if (!injectToolsRaw) return [];
    if (Array.isArray(injectToolsRaw)) {
        return injectToolsRaw.map(item => String(item || '').trim()).filter(Boolean);
    }
    return String(injectToolsRaw)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function buildTemporaryToolsSystemPrompt(injectToolsRaw) {
    const toolNames = parseInjectTools(injectToolsRaw);
    if (toolNames.length === 0) {
        return '';
    }

    try {
        const pluginManager = require('../../Plugin.js');
        const descriptionsMap = pluginManager.getIndividualPluginDescriptions();
        const sections = [];

        for (const toolName of toolNames) {
            const plugin = pluginManager.getPlugin(toolName);
            const placeholderKey = `VCP${toolName}`;
            const description = descriptionsMap && descriptionsMap.get(placeholderKey);

            if (description) {
                sections.push(`### ${plugin?.displayName || toolName} (${toolName})\n${description}`);
            } else {
                const fallbackDescription = plugin?.description
                    ? `${plugin.description}\n\n[警告] 该工具缺少 invocationCommands 级别的详细描述，当前仅注入 manifest 描述。`
                    : '[警告] 未找到该工具的详细描述信息，请谨慎使用。';
                sections.push(`### ${plugin?.displayName || toolName} (${toolName})\n${fallbackDescription}`);
            }
        }

        return [
            '[临时工具组注入]',
            '以下工具仅在本次通讯/委托中临时提供给你使用，不代表你的长期固定工具集。',
            '请只在确实需要时调用这些工具，并优先依据下方工具说明中的格式与约束进行使用。',
            '',
            ...sections
        ].join('\n');
    } catch (error) {
        if (DEBUG_MODE) {
            console.error('[AgentAssistant Service] Failed to build temporary tools system prompt:', error.message);
        }
        return '';
    }
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

    const { agent_name, prompt, timely_contact, temporary_contact, maid, task_delegation, query_delegation, inject_tools } = args;

    // Handle querying a delegation status
    if (query_delegation) {
        if (activeDelegations.has(query_delegation)) {
            const state = activeDelegations.get(query_delegation);
            return {
                status: "success",
                result: {
                    content: [{
                        type: "text",
                        text: `委托任务 (ID: ${query_delegation}) 仍在进行中。当前状态: ${state.status}。被委托 Agent: ${state.agentName}。已执行轮数: ${state.currentRound}/${DELEGATION_MAX_ROUNDS}。已运行时长: ${Math.round((Date.now() - state.startTime) / 1000)}s。`
                    }]
                }
            };
        } else {
            // Check if the result file already exists signaling completion
            try {
                // Check long-term persistence MD file first
                const agentNameMatch = query_delegation.match(/^aa-delegation-\d+-([a-f0-9]+)$/); // Best effort, although we don't know agent name exactly from ID alone. Wait, we can regex it from the file names if we list dir, but better just check JSON first.
                const jsonFilePath = path.join(__dirname, '..', '..', 'VCPAsyncResults', `AgentAssistant-${query_delegation}.json`);

                let completionMsg = "";

                if (fs.existsSync(jsonFilePath)) {
                    completionMsg = `委托任务 (ID: ${query_delegation}) 已在此前处理完毕！相关的完成报告已经被保存到系统中。\n这个结果会在您的所有上下文中动态生效，您可以直接认为该任务已经完成。`;
                }

                // Also check if we have the MD file
                const docsDir = path.join(__dirname, '..', '..', 'file', 'document', 'AgentTask');
                if (fs.existsSync(docsDir)) {
                    const files = fs.readdirSync(docsDir);
                    const matchedFile = files.find(f => f.includes(query_delegation) && f.endsWith('.md'));
                    if (matchedFile) {
                        const mdContent = fs.readFileSync(path.join(docsDir, matchedFile), 'utf-8');
                        completionMsg = `委托任务 (ID: ${query_delegation}) 已经完成！\n\n文件已永久归档至: \`file/document/AgentTask/${matchedFile}\`\n\n**文档内容速览:**\n\n${mdContent}`;
                    }
                }

                if (completionMsg) {
                    return {
                        status: "success",
                        result: {
                            content: [{
                                type: "text",
                                text: completionMsg
                            }]
                        }
                    };
                }
            } catch (err) {
                // Ignore file access errors
            }

            return { status: "error", error: `未能找到委托任务 (ID: ${query_delegation})。系统内存中已不存在此任务且未查询到完成记录，可能是遇到错误崩溃或ID无效。` };
        }
    }

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
                tool_call: { tool_name: "AgentAssistant", arguments: { agent_name, prompt, maid } }
            };
            if (DEBUG_MODE) console.error(`[AgentAssistant Service] Calling /v1/schedule_task with payload:`, JSON.stringify(schedulerPayload, null, 2));

            const response = await axios.post(`${VCP_API_TARGET_URL}/schedule_task`, schedulerPayload, {
                headers: { 'Authorization': `Bearer ${VCP_SERVER_ACCESS_KEY}`, 'Content-Type': 'application/json' },
                timeout: 15000
            });

            if (response.data && response.data.status === "success") {
                const formattedDate = `${targetDate.getFullYear()}年${targetDate.getMonth() + 1}月${targetDate.getDate()}日 ${targetDate.getHours().toString().padStart(2, '0')}:${targetDate.getMinutes().toString().padStart(2, '0')}`;
                const friendlyReceipt = `您预定于 ${formattedDate} 发给 ${agent_name} 的未来通讯已经被系统记录，届时会自动发送。`;
                return { status: "success", result: { content: [{ type: "text", text: friendlyReceipt }] } };
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

    // Handle basic Task Delegation request
    if (String(task_delegation).toLowerCase() === 'true') {
        const delegationId = `aa-delegation-${Date.now()}-${uuidv4().slice(0, 8)}`;
        const senderName = maid || "系统任务中心";
        const temporaryToolsSystemPrompt = buildTemporaryToolsSystemPrompt(inject_tools);

        activeDelegations.set(delegationId, {
            status: 'running',
            agentName: agent_name,
            currentRound: 0,
            startTime: Date.now()
        });

        if (DEBUG_MODE) console.error(`[AgentAssistant Service] Starting async delegation ${delegationId} for ${agent_name}`);

        // Launch the background task un-awaited
        executeDelegation(delegationId, agentConfig, prompt, senderName, temporaryToolsSystemPrompt).catch(async err => {
            console.error(`[AgentAssistant Service] Background delegation task ${delegationId} failed:`, err);
            const state = activeDelegations.get(delegationId);
            if (state) state.status = 'failed';
            await sendDelegationCallback(delegationId, 'Failed', `任务执行过程中发生异常: ${err.message}`, agent_name);
            activeDelegations.delete(delegationId);
        });

        const successMessage = `委托任务 (ID: ${delegationId}) 已成功提交给 ${agent_name} 进行后台处理。\n您可以使用带有 \`query_delegation: "${delegationId}"\` 参数的工具调用来查询其进度。\n这是一个动态上下文占位符，当任务完全完成时，它会被自动替换为实际的最终报告。\n请在你的回复中包含以下占位符原文：{{VCP_ASYNC_RESULT::AgentAssistant::${delegationId}}}`;

        return {
            status: "success",
            result: { content: [{ type: "text", text: successMessage }] }
        };
    }

    // Handle immediate chat
    const useContext = !temporary_contact; // Check if temporary_contact is provided and truthy
    const userSessionId = args.session_id || `agent_${agentConfig.baseName}_default_user_session`;

    // 占线检查：仅对持久对话生效
    if (useContext) {
        const lockKey = `${agent_name}::${userSessionId}`;
        if (activeSessionLocks.has(lockKey)) {
            const busyMsg = `[AgentAssistant] ${agent_name} 目前正在与他人进行通讯，暂时无法接听。请稍后再试。`;
            if (DEBUG_MODE) console.error(`[AgentAssistant Service] Session busy, rejecting request for ${agent_name} (session: ${userSessionId}).`);
            return { status: "error", error: busyMsg };
        }
        activeSessionLocks.add(lockKey);
        if (DEBUG_MODE) console.error(`[AgentAssistant Service] Session lock acquired for ${agent_name} (session: ${userSessionId}).`);
    }

    try {
        // 注入来源提示词，防止 AI 之间产生“套娃”式工具调用
        const senderName = maid || "系统助手";
        const communicationTip = `[Tips:这是一条来自AgentAssistant通讯中心 ${senderName} 的联络，你可以直接正常回复而无需通过调用AA插件的方式进行回复]\n\n`;
        const finalPrompt = communicationTip + prompt;

        const processedUserPrompt = await replacePlaceholdersInUserPrompt(finalPrompt, agentConfig);

        let history = [];
        if (useContext) {
            history = getAgentSessionHistory(agent_name, userSessionId);
        } else if (DEBUG_MODE) {
            console.error(`[AgentAssistant Service] Temporary contact requested for ${agent_name}. Skipping context loading.`);
        }

        const temporaryToolsSystemPrompt = buildTemporaryToolsSystemPrompt(inject_tools);
        const finalSystemPrompt = temporaryToolsSystemPrompt
            ? `${agentConfig.systemPrompt}\n\n${temporaryToolsSystemPrompt}`
            : agentConfig.systemPrompt;

        if (DEBUG_MODE && temporaryToolsSystemPrompt) {
            console.error(`[AgentAssistant Service] Temporary tools injected for ${agent_name}: ${parseInjectTools(inject_tools).join(', ')}`);
        }

        const messagesForVCP = [
            { role: 'system', content: finalSystemPrompt },
            { role: 'user', content: processedUserPrompt }
        ];
        if (history.length > 0) {
            messagesForVCP.splice(1, 0, ...history); // Insert history after system prompt
        }
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

        // 移除 VCP 思维链内容
        const cleanedAssistantResponse = removeVCPThinkingChain(assistantResponseContent);

        if (useContext) {
            // 存储到历史记录时使用清理后的内容
            updateAgentSessionHistory(agent_name, { role: 'user', content: processedUserPrompt }, { role: 'assistant', content: cleanedAssistantResponse }, userSessionId);
        } else if (DEBUG_MODE) {
            console.error(`[AgentAssistant Service] Temporary contact requested for ${agent_name}. Skipping context update.`);
        }

        // VCP Info Broadcast - 使用清理后的内容
        const broadcastData = {
            type: 'AGENT_PRIVATE_CHAT_PREVIEW',
            agentName: agent_name,
            sessionId: userSessionId,
            query: processedUserPrompt,
            response: cleanedAssistantResponse,
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

        return { status: "success", result: { content: [{ type: "text", text: cleanedAssistantResponse }] } };

    } catch (error) {
        let errorMessage = `调用 Agent '${agent_name}' 时发生错误。`;
        if (axios.isAxiosError(error)) {
            if (error.response) {
                errorMessage += ` API Status: ${error.response.status}.`;
                if (error.response.data?.error?.message) errorMessage += ` Message: ${error.response.data.error.message}`;
                else if (typeof error.response.data === 'string') errorMessage += ` Data: ${error.response.data.substring(0, 150)}`;
            } else if (error.request) {
                // 请求已发出但未收到响应
                errorMessage += ` No response received. Code: ${error.code || 'N/A'}.`;
                if (error.message && error.message.includes('timeout')) {
                    errorMessage += ` Request timed out after ${error.config?.timeout}ms. (Local VCP Server is too slow to respond)`;
                }
            } else {
                errorMessage += ` Request setup error: ${error.message}`;
            }
        } else if (error instanceof Error) {
            errorMessage += ` ${error.message}`;
        }
        if (DEBUG_MODE) console.error(`[AgentAssistant Service] Error in processToolCall for ${agent_name}: ${errorMessage}`);
        return { status: "error", error: errorMessage };
    } finally {
        // 确保无论成功或失败，持久对话的锁都会被释放
        if (useContext) {
            const lockKey = `${agent_name}::${userSessionId}`;
            activeSessionLocks.delete(lockKey);
            if (DEBUG_MODE) console.error(`[AgentAssistant Service] Session lock released for ${agent_name} (session: ${userSessionId}).`);
        }
    }
}

/**
 * Executes a delegated task asynchronously by running a bounded conversation loop
 */
async function executeDelegation(delegationId, agentConfig, taskPrompt, senderName, temporaryToolsSystemPrompt = '') {
    const userSessionId = `agent_${agentConfig.baseName}_delegation_session`;
    const lockKey = `${agentConfig.baseName}::${userSessionId}`;

    // 我们对于代理任务也是一个持久会话，因此需要占线锁保护
    while (activeSessionLocks.has(lockKey)) {
        if (DEBUG_MODE) console.error(`[AgentAssistant Delegation] Wait for lock: ${lockKey}`);
        await new Promise(r => setTimeout(r, 2000));
        const state = activeDelegations.get(delegationId);
        if (Date.now() - state.startTime > DELEGATION_TIMEOUT) {
            throw new Error("Acquiring session lock timed out");
        }
    }

    activeSessionLocks.add(lockKey);

    let finalReport = null;
    let completionStatus = 'Failed';

    try {
        const delegationPrompt = DELEGATION_SYSTEM_PROMPT
            .replace(/\{\{SenderName\}\}/g, senderName)
            .replace(/\{\{TaskPrompt\}\}/g, taskPrompt);

        const injectedSystemPrompt = temporaryToolsSystemPrompt
            ? `${agentConfig.systemPrompt}\n\n${temporaryToolsSystemPrompt}\n\n${delegationPrompt}`
            : `${agentConfig.systemPrompt}\n\n${delegationPrompt}`;

        // 我们使用独立的历史记录
        let messagesForVCP = [
            { role: 'system', content: injectedSystemPrompt },
            { role: 'user', content: taskPrompt }
        ];

        let state = activeDelegations.get(delegationId);

        while (state.currentRound < DELEGATION_MAX_ROUNDS) {
            if (Date.now() - state.startTime > DELEGATION_TIMEOUT) {
                completionStatus = 'Failed';
                finalReport = '委托任务执行超时。';
                break;
            }

            if (DEBUG_MODE) console.error(`[AgentAssistant Delegation] Round ${state.currentRound + 1}/${DELEGATION_MAX_ROUNDS} for ${delegationId}`);

            const payloadForVCP = {
                model: agentConfig.id,
                messages: messagesForVCP,
                max_tokens: agentConfig.maxOutputTokens,
                temperature: agentConfig.temperature,
                stream: false
            };

            const responseFromVCP = await axios.post(`${VCP_API_TARGET_URL}/chat/completions`, payloadForVCP, {
                headers: { 'Authorization': `Bearer ${VCP_SERVER_ACCESS_KEY}`, 'Content-Type': 'application/json' },
                timeout: (parseInt(process.env.PLUGIN_COMMUNICATION_TIMEOUT) || 118000)
            });

            const assistantResponseContent = responseFromVCP.data?.choices?.[0]?.message?.content;
            if (typeof assistantResponseContent !== 'string') {
                throw new Error(`Agent '${agentConfig.baseName}' 返回了无效或缺失的后续内容。`);
            }

            const cleanedAssistantResponse = removeVCPThinkingChain(assistantResponseContent);

            // 检查完成标记的容错正则
            const completionMatch = cleanedAssistantResponse.match(/\[\[TaskComplete(?:\s*\]\]|\s[\s\S]*?\]\])/i);
            const failureMatch = cleanedAssistantResponse.match(/\[\[TaskFailed(?:\s*\]\]|\s[\s\S]*?\]\])/i);

            if (completionMatch) {
                // Task is completed
                completionStatus = 'Succeed';
                // 提取标记后面的内容作为报告
                const reportStartIndex = completionMatch.index + completionMatch[0].length;
                let potentialReport = cleanedAssistantResponse.substring(reportStartIndex).trim();

                // 如果标记后面没有内容，把整个回复当做报告
                if (!potentialReport) {
                    potentialReport = cleanedAssistantResponse;
                }
                finalReport = potentialReport;
                break; // Exit the loop
            } else if (failureMatch) {
                // Task is explicitly failed by the agent
                completionStatus = 'Failed';
                // 提取标记后面的内容作为报告
                const reportStartIndex = failureMatch.index + failureMatch[0].length;
                let potentialReport = cleanedAssistantResponse.substring(reportStartIndex).trim();

                // 如果标记后面没有内容，把整个回复当做报告
                if (!potentialReport) {
                    potentialReport = cleanedAssistantResponse;
                }
                finalReport = "【Agent主动放弃任务】\n" + potentialReport;
                break; // Exit the loop
            } else {
                // Task is not completed yet, push history and add heartbeat prompt
                messagesForVCP.push({ role: 'assistant', content: cleanedAssistantResponse });

                // 处理心跳延迟占位符: [[NextHeartbeat::秒数]]
                const delayMatch = cleanedAssistantResponse.match(/\[\[NextHeartbeat::(\d+)\]\]/i);
                if (delayMatch && delayMatch[1]) {
                    const delaySeconds = parseInt(delayMatch[1], 10);
                    if (!isNaN(delaySeconds) && delaySeconds > 0) {
                        // 确保总延迟不超过剩余超时时间，避免永久挂起
                        const elapsed = Date.now() - state.startTime;
                        const remainingTimeout = DELEGATION_TIMEOUT - elapsed;
                        const actualDelayMs = Math.min(delaySeconds * 1000, Math.max(0, remainingTimeout - 10000)); // 预留10s缓冲

                        if (actualDelayMs > 0) {
                            if (DEBUG_MODE) console.error(`[AgentAssistant Delegation] AI requested heartbeat delay: ${delaySeconds}s. Actual delay: ${Math.round(actualDelayMs / 1000)}s.`);
                            await new Promise(resolve => setTimeout(resolve, actualDelayMs));
                        }
                    }
                }

                messagesForVCP.push({ role: 'user', content: DELEGATION_HEARTBEAT_PROMPT });
            }

            state.currentRound++;
            activeDelegations.set(delegationId, state);
        }

        if (!finalReport && completionStatus === 'Failed') {
            finalReport = `达到最大轮数限制 (${DELEGATION_MAX_ROUNDS} 轮)，任务尚未自动上报完成。`;
        }

    } finally {
        activeSessionLocks.delete(lockKey);
        activeDelegations.delete(delegationId);

        const secureReport = finalReport || "未知错误导致无报告";

        // 给成功完成任务的 Agent 发放积分奖励
        if (completionStatus === 'Succeed') {
            awardAgentPoints(agentConfig.baseName, agentConfig.name, 5, `成功完成异步委托任务: ${delegationId}`);
        }

        // Save to AgentTask Document Directory
        await archiveDelegationReport(delegationId, agentConfig.baseName, completionStatus, secureReport, taskPrompt);

        await sendDelegationCallback(delegationId, completionStatus, secureReport, agentConfig.baseName);
    }
}

/**
 * Archives the completed task report as a Markdown file.
 */
async function archiveDelegationReport(delegationId, agentName, status, report, taskPrompt) {
    try {
        const docDir = path.join(__dirname, '..', '..', 'file', 'document', 'AgentTask');
        // Ensure directory exists
        if (!fs.existsSync(docDir)) {
            fs.mkdirSync(docDir, { recursive: true });
        }

        const fileName = `${agentName}_${delegationId}.md`;
        const filePath = path.join(docDir, fileName);

        const now = new Date();
        const dateString = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        const fileContent = `# 委托任务归档报告: ${delegationId}\n\n` +
            `- **执行者:** ${agentName}\n` +
            `- **生成时间:** ${dateString}\n` +
            `- **任务状态:** ${status}\n\n` +
            `## 原始委托要求\n\n> ${String(taskPrompt).split('\n').join('\n> ')}\n\n` +
            `---\n\n` +
            `## 最终执行结果\n\n${report}\n`;

        fs.writeFileSync(filePath, fileContent, 'utf-8');
        if (DEBUG_MODE) console.error(`[AgentAssistant Delegation] Archived report to ${filePath}`);
    } catch (e) {
        console.error(`[AgentAssistant Delegation] Failed to archive report file for ${delegationId}:`, e.message);
    }
}

/**
 * Sends the completion notification via VCP's plugin callback webhook
 */
async function sendDelegationCallback(delegationId, status, report, agentName) {
    const callbackUrl = `${VCP_API_TARGET_URL.replace('/v1', '')}/plugin-callback/AgentAssistant/${delegationId}`;
    const payload = {
        requestId: delegationId,
        pluginName: 'AgentAssistant',
        status: status,  // 'Succeed' | 'Failed'
        message: `### 委托任务完成报告 (${agentName})\n\n${report}`, // message Processor requires message or status+string
    };

    try {
        if (DEBUG_MODE) console.error(`[AgentAssistant Delegation] Sending callback for ${delegationId} to ${callbackUrl}`);
        await axios.post(callbackUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        if (DEBUG_MODE) console.error(`[AgentAssistant Delegation] Callback sent successfully.`);

        // Additionally broadcast VCP info
        pushVcpInfo({
            type: 'warning',
            source: 'AgentAssistant',
            message: `异步委托任务 [${delegationId}] 由 ${agentName} 处理完毕。状态: ${status}`
        });

    } catch (error) {
        console.error(`[AgentAssistant Delegation] Failed to send callback for ${delegationId}:`, error.message);
    }
}

module.exports = {
    initialize,
    shutdown,
    processToolCall
};
