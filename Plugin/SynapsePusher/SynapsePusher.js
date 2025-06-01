const WebSocket = require('ws');
const axios = require('axios');
const path = require('path'); // May not be strictly needed but good for future path operations

let pluginConfigInstance;
let wsClient;
let synapseTxnId = 0;
let wsReconnectTimer;
let parsedMaidAccessTokens = {}; // To store the parsed JSON from MaidAccessTokensJSON
let parsedMaidToolWhitelists = {}; // To store parsed JSON for tool whitelists

async function sendToSynapse(logEvent) {
    const logData = logEvent.data; 
    const serverBroadcastTimestamp = logEvent.timestamp;
    
    let maidName = logData.extractedMaidName; // 从 onMessage 预处理中获取
    const toolName = logData.tool_name;
    let accessToken;

    if (!maidName) {
        if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
            console.warn(`[SynapsePusher] sendToSynapse: MaidName could not be extracted from logData.content. Skipping send for tool '${toolName || 'N/A'}'. Log data:`, logData);
        }
        return;
    }

    // 检查是否启用测试模式
    if (pluginConfigInstance.BypassWhitelistForTesting === true) {
        if (pluginConfigInstance.DebugMode) {
            console.log(`[SynapsePusher] DEBUG: Whitelist bypass for testing is ENABLED. Using SynapseAccessTokenForTestingOnly.`);
        }
        accessToken = pluginConfigInstance.SynapseAccessTokenForTestingOnly;
        if (!accessToken) {
            if (pluginConfigInstance.DebugMode) {
                console.warn(`[SynapsePusher] BypassWhitelistForTesting is true, but SynapseAccessTokenForTestingOnly is not configured. Cannot send.`);
            }
            return;
        }
    } else {
        // 正常严格匹配逻辑
        // 1. Maid 必须在 MaidAccessTokensJSON 中有明确配置的 AccessToken
        accessToken = parsedMaidAccessTokens[maidName];
        if (!accessToken) {
            if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                console.warn(`[SynapsePusher] STRICT MODE: No specific Synapse Access Token found for Maid: '${maidName || 'Unknown'}' in MaidAccessTokensJSON. Skipping send for tool '${toolName || 'N/A'}'.`);
            }
            return;
        }

        // 3. Maid 必须在 MaidToolWhitelistJSON 中有明确配置的白名单，且 tool_name 必须在其中
        const maidWhitelist = parsedMaidToolWhitelists[maidName];
        if (maidWhitelist) {
            if (!maidWhitelist.includes(toolName)) {
                if (pluginConfigInstance.DebugMode) {
                    console.log(`[SynapsePusher] STRICT MODE: Tool '${toolName || 'N/A'}' for Maid '${maidName || 'Unknown'}' is NOT in their whitelist. Skipping Synapse push.`);
                }
                return;
            }
        } else {
            if (pluginConfigInstance.DebugMode) {
                console.log(`[SynapsePusher] STRICT MODE: Maid '${maidName || 'Unknown'}' does NOT have a configured tool whitelist in MaidToolWhitelistJSON. Skipping Synapse push for tool '${toolName || 'N/A'}'.`);
            }
            return;
        }
    }

    // 共同的检查点：基础 Synapse 配置和最终确定的 accessToken
    if (!pluginConfigInstance || !pluginConfigInstance.SynapseHomeserver || !pluginConfigInstance.SynapseRoomID) {
        if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
            console.warn(`[SynapsePusher] Basic Synapse configuration (Homeserver, RoomID) is missing. Skipping send for Maid: '${maidName || 'Unknown'}', Tool: '${toolName || 'N/A'}'.`);
        }
        return;
    }
    if (!accessToken) { // 这个检查理论上在上面分支中已覆盖，但双重保险
        if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
            console.warn(`[SynapsePusher] No valid AccessToken determined (should not happen if logic above is correct). Maid: '${maidName || 'Unknown'}'. Skipping.`);
        }
        return;
    }

    // 如果代码执行到这里，意味着：
    // 1. Maid 在 MaidAccessTokensJSON 中有特定的 accessToken。
    // 2. 基础 Synapse 配置存在。
    // 3. Maid 在 MaidToolWhitelistJSON 中有配置白名单，并且 tool_name 在白名单内。

    const { status, content, source } = logData;
    let formattedMessage = `**VCP Log Event (${source || 'N/A'})** [${serverBroadcastTimestamp || new Date().toISOString()}] (Maid: ${maidName || 'N/A'})\\n`;
    formattedMessage += `**Tool:** ${toolName || 'N/A'}\\n`;
    formattedMessage += `**Status:** ${status || 'N/A'}\\n`;
    
    let contentString = content;
    if (typeof content === 'object') {
        contentString = JSON.stringify(content, null, 2);
    }

    if (contentString && contentString.length > 3000) {
        contentString = contentString.substring(0, 3000) + "... (truncated)";
    }
    formattedMessage += `**Content:**\\n\`\`\`\\n${contentString || 'N/A'}\\n\`\`\``;

    const synapseUrl = `${pluginConfigInstance.SynapseHomeserver}/_matrix/client/r0/rooms/${encodeURIComponent(pluginConfigInstance.SynapseRoomID)}/send/m.room.message/${synapseTxnId++}`;

    try {
        if (pluginConfigInstance.DebugMode) {
            console.log(`[SynapsePusher] Sending to Synapse room ${pluginConfigInstance.SynapseRoomID} for Maid '${maidName || 'Unknown'}', Tool '${toolName || 'N/A'}': ${formattedMessage.substring(0, 100)}...`);
        }
        await axios.put(synapseUrl, {
            msgtype: 'm.text',
            body: formattedMessage,
            format: "org.matrix.custom.html",
            formatted_body: formattedMessage.replace(/\\n/g, '<br/>')
        }, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        if (pluginConfigInstance.DebugMode) {
            console.log(`[SynapsePusher] Successfully sent log to Synapse for Maid '${maidName || 'Unknown'}', Tool '${toolName || 'N/A'}'`);
        }
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error(`[SynapsePusher] Error sending log to Synapse for Maid '${maidName || 'Unknown'}', Tool '${toolName || 'N/A'}': ${errorMessage}`);
    }
}

function connectToWebSocketLogSource() {
    if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
        console.log(`[SynapsePusher] DEBUG: Current VCP_Key from config: "${pluginConfigInstance.VCP_Key}"`);
        console.log(`[SynapsePusher] DEBUG: Current SERVER_PORT from config: "${pluginConfigInstance.SERVER_PORT}"`);
    }
    if (!pluginConfigInstance || !pluginConfigInstance.VCP_Key || !pluginConfigInstance.SERVER_PORT) {
        console.error('[SynapsePusher] Cannot connect to WebSocket server: VCP_Key or SERVER_PORT missing in config.');
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(connectToWebSocketLogSource, 15000);
        if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
             console.log('[SynapsePusher] Retrying WebSocket connection in 15 seconds due to missing VCP_Key or SERVER_PORT.');
        }
        return;
    }

    // Corrected path to /VCPlog/ (lowercase L) to match WebSocketServer.js regex
    const wsUrl = `ws://localhost:${pluginConfigInstance.SERVER_PORT}/VCPlog/VCP_Key=${pluginConfigInstance.VCP_Key}`;
    if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
        console.log(`[SynapsePusher] Attempting to connect to VCPLog WebSocket source at: ${wsUrl}`);
    }

    if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
        if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
            console.log('[SynapsePusher] WebSocket client already open or connecting to log source.');
        }
        return;
    }

    wsClient = new WebSocket(wsUrl);

    wsClient.on('open', () => {
        if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
            console.log('[SynapsePusher] Successfully connected to VCPLog WebSocket source.');
        }
        clearTimeout(wsReconnectTimer);
    });

    wsClient.on('message', async (data) => {
        try {
            const messageString = data.toString();
            const message = JSON.parse(messageString);
            if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                console.log('[SynapsePusher] Received message from VCPLog WebSocket source:', message);
            }

            if (message.type === 'vcp_log') {
                let extractedMaidName = null;
                if (message.data && typeof message.data.content === 'string') {
                    try {
                        const contentData = JSON.parse(message.data.content);
                        if (contentData && contentData.MaidName) {
                            extractedMaidName = contentData.MaidName;
                            if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                                console.log(`[SynapsePusher] Extracted MaidName: '${extractedMaidName}' from message.data.content`);
                            }
                        } else {
                            if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                                console.warn('[SynapsePusher] MaidName not found within parsed message.data.content or contentData is null.');
                            }
                        }
                    } catch (e) {
                        if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                            console.error('[SynapsePusher] Error parsing message.data.content to JSON:', e.message, "Content was:", message.data.content);
                        }
                    }
                } else {
                    if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                        console.warn('[SynapsePusher] message.data.content is missing or not a string. Cannot extract MaidName.');
                    }
                }
                
                // 将提取的 MaidName (可能为 null) 附加到 message.data 以便 sendToSynapse 使用
                if (message.data) {
                    message.data.extractedMaidName = extractedMaidName;
                } else {
                     // 如果 message.data 本身就不存在，创建一个包含 extractedMaidName 的对象
                     // 这种情况理论上不应发生，因为 tool_name 等也需要从 message.data 获取
                    message.data = { extractedMaidName: extractedMaidName };
                     if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                        console.warn('[SynapsePusher] Original message.data was null or undefined. Created new data object.');
                    }
                }

                // 移除之前对顶层 maid 和 tool_name 的检查，因为 maidName 现在从 content 提取
                // tool_name 的检查仍然保留，因为它直接来自顶层 logData.tool_name
                 if (!message.data || !message.data.tool_name) { 
                    if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                        console.warn('[SynapsePusher] Received vcp_log without tool_name in data. Whitelist check might be affected.', message.data);
                    }
                }
                await sendToSynapse(message);
            } else if (message.type === 'connection_ack') {
                 if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                    console.log(`[SynapsePusher] Connection acknowledgement from VCPLog source: ${message.message}`);
                }
            }
        } catch (error) {
            console.error('[SynapsePusher] Error processing message from VCPLog WebSocket source:', error);
        }
    });

    wsClient.on('close', (code, reason) => {
        if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
            console.warn(`[SynapsePusher] WebSocket client to VCPLog source disconnected. Code: ${code}, Reason: ${String(reason)}. Attempting to reconnect...`);
        }
        wsClient = null;
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(connectToWebSocketLogSource, 5000); 
    });

    wsClient.on('error', (error) => {
        console.error('[SynapsePusher] WebSocket client error connecting to VCPLog source:', error.message);
        if (wsClient && wsClient.readyState !== WebSocket.OPEN && wsClient.readyState !== WebSocket.CONNECTING) {
             wsClient = null;
             clearTimeout(wsReconnectTimer);
             wsReconnectTimer = setTimeout(connectToWebSocketLogSource, 7000);
             if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                 console.log('[SynapsePusher] Attempting WebSocket reconnect to VCPLog source due to direct error.');
             }
        }
    });
}

// registerRoutes is the entry point for 'service' plugins with 'direct' communication.
function registerRoutes(app, config, projectBasePath) {
    pluginConfigInstance = config;

    if (pluginConfigInstance.MaidAccessTokensJSON) {
        try {
            parsedMaidAccessTokens = JSON.parse(pluginConfigInstance.MaidAccessTokensJSON);
            if (pluginConfigInstance.DebugMode) {
                console.log('[SynapsePusher] Successfully parsed MaidAccessTokensJSON:', parsedMaidAccessTokens);
            }
        } catch (e) {
            console.error('[SynapsePusher] Failed to parse MaidAccessTokensJSON. Error:', e.message);
            parsedMaidAccessTokens = {}; 
        }
    } else {
        if (pluginConfigInstance.DebugMode) {
            console.warn('[SynapsePusher] MaidAccessTokensJSON is not defined in config.');
        }
        parsedMaidAccessTokens = {};
    }

    // Parse MaidToolWhitelistJSON
    if (pluginConfigInstance.MaidToolWhitelistJSON) {
        try {
            parsedMaidToolWhitelists = JSON.parse(pluginConfigInstance.MaidToolWhitelistJSON);
            if (pluginConfigInstance.DebugMode) {
                console.log('[SynapsePusher] Successfully parsed MaidToolWhitelistJSON:', parsedMaidToolWhitelists);
            }
        } catch (e) {
            console.error('[SynapsePusher] Failed to parse MaidToolWhitelistJSON. Error:', e.message);
            parsedMaidToolWhitelists = {}; // Use empty object on error, meaning default allow for all maids
        }
    } else {
        if (pluginConfigInstance.DebugMode) {
            console.warn('[SynapsePusher] MaidToolWhitelistJSON is not defined in config. All tools will be allowed by default for maids with valid tokens.');
        }
        parsedMaidToolWhitelists = {}; // Default to empty, meaning allow all tools for all maids
    }

    if (!pluginConfigInstance.SERVER_PORT && process.env.PORT) {
        pluginConfigInstance.SERVER_PORT = process.env.PORT;
    }
    if (!pluginConfigInstance.PROJECT_BASE_PATH) {
        pluginConfigInstance.PROJECT_BASE_PATH = projectBasePath;
    }

    if (pluginConfigInstance.DebugMode) {
        console.log('[SynapsePusher] registerRoutes called. Initialized config:', pluginConfigInstance);
    }

    console.log('[SynapsePusher] Plugin loaded. Attempting to connect to WebSocket log source if config is present.');
    connectToWebSocketLogSource();
}

function shutdown() {
    if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
        console.log('[SynapsePusher] Shutting down...');
    }
    clearTimeout(wsReconnectTimer);
    if (wsClient) {
        wsClient.removeAllListeners();
        wsClient.close();
        wsClient = null;
        if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
            console.log('[SynapsePusher] WebSocket client connection to VCPLog source closed.');
        }
    }
    if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
        console.log('[SynapsePusher] Shutdown complete.');
    }
}

module.exports = {
    registerRoutes,
    shutdown
}; 