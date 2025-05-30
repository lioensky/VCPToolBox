const WebSocket = require('ws');
const fs = require('fs').promises;
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)); // 添加 node-fetch

let wss;
let vcpKey;
const LOG_DIR_NAME = 'log';
const LOG_FILE_NAME = 'VCPlog.txt';
let logFilePath;
let pluginConfigInstance; // 用于存储插件配置
let serverInstance; // 用于存储 Express app 实例

// Gotify 配置
let gotifyUrl;
let gotifyToken;
let gotifyPriority;
let enableGotifyPush = false; // Default to false

async function ensureLogDirAndFile(basePath) {
    const pluginLogDirPath = path.join(basePath, LOG_DIR_NAME);
    try {
        await fs.mkdir(pluginLogDirPath, { recursive: true });
        logFilePath = path.join(pluginLogDirPath, LOG_FILE_NAME);
        // 确保文件存在，如果不存在则创建
        await fs.access(logFilePath).catch(async () => {
            await fs.writeFile(logFilePath, `Log initialized at ${new Date().toISOString()}\n`, 'utf-8');
        });
        // console.log(`[VCPLog] Log directory and file ensured at: ${logFilePath}`); // Reduced verbosity
    } catch (error) {
        console.error(`[VCPLog] Error ensuring log directory/file: ${pluginLogDirPath}`, error);
        // 如果日志目录创建失败，后续的日志写入会失败，但服务应继续运行
    }
}

async function writeToLog(message) {
    if (!logFilePath) {
        // console.error('[VCPLog] Log file path not initialized. Cannot write log.'); // Can be noisy
        return;
    }
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${message}\n`;
    try {
        await fs.appendFile(logFilePath, logMessage, 'utf-8');
    } catch (error) {
        console.error(`[VCPLog] Error writing to log file ${logFilePath}:`, error);
    }
}

function broadcastToClients(data) {
    if (wss && wss.clients) {
        const messageString = JSON.stringify(data);
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
                client.send(messageString);
            }
        });
        // 同时记录到日志文件
        writeToLog(`Broadcasted to WebSocket: ${JSON.stringify(data)}`);
    }
}

// 新增：发送到 Gotify
async function sendToGotify(vcpData) {
    if (!enableGotifyPush) {
        return;
    }
    if (!gotifyUrl || !gotifyToken) {
        // Initialization logs will cover this if DebugMode is on
        return;
    }

    const title = `VCP Log: ${vcpData.tool_name || 'General Event'}`;
    let messageContent = vcpData.content;
    if (typeof messageContent === 'object') {
        messageContent = JSON.stringify(messageContent, null, 2);
    } else if (messageContent === undefined || messageContent === null) {
        messageContent = 'N/A';
    } else {
        messageContent = String(messageContent);
    }
    
    const message = `Source: ${vcpData.source || 'N/A'}\nStatus: ${vcpData.status || 'N/A'}\nContent: ${messageContent}`;
    
    const gotifyPayload = {
        title: title,
        message: message,
        priority: gotifyPriority || 2,
    };

    try {
        const response = await fetch(`${gotifyUrl}/message?token=${gotifyToken}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(gotifyPayload),
        });

        if (response.ok) {
            if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                console.log('[VCPLog] Successfully sent notification to Gotify.');
            }
            writeToLog(`Successfully sent to Gotify: ${title}`);
        } else {
            const errorBody = await response.text();
            console.error(`[VCPLog] Error sending to Gotify: ${response.status} ${response.statusText}. Body: ${errorBody}`);
            writeToLog(`Gotify Error: ${response.status} - ${errorBody}`);
        }
    } catch (error) {
        console.error('[VCPLog] Exception sending to Gotify:', error);
        writeToLog(`Gotify Exception: ${error.message}`);
    }
}


// 修改 pushVcpLog
function pushVcpLog(vcpData) {
    const isDebugMode = pluginConfigInstance && (pluginConfigInstance.DebugMode === true || String(pluginConfigInstance.DebugMode).toLowerCase() === 'true');
    if (isDebugMode) {
        console.log('[VCPLog] Received VCP data to push:', vcpData);
    }
    broadcastToClients({ type: 'vcp_log', data: vcpData });
    
    // 调用 Gotify 推送，不等待完成 (fire-and-forget)
    sendToGotify(vcpData).catch(err => {
        // 虽然 sendToGotify 内部有 catch, 但为了确保这里的异步操作未捕获的 Promise rejection 被处理
        console.error('[VCPLog] Background error from sendToGotify promise:', err); // Keep as error
        writeToLog(`[VCPLog] Background error from sendToGotify: ${err.message}`);
    });
}


function initialize(config) {
    const isDebugMode = config && (config.DebugMode === true || String(config.DebugMode).toLowerCase() === 'true');
    if (isDebugMode) { 
        console.log('[VCPLog] "initialize" function called with config:', config); // Corrected string literal
    }
    // pluginConfigInstance = config; // 这行不再是设置 Gotify 变量的主要途径
    // vcpKey = pluginConfigInstance.VCP_Key; 
    // Gotify 配置的读取逻辑已移至 registerRoutes
}

function registerRoutes(app, config, projectBasePath) {
    serverInstance = app; 
    pluginConfigInstance = config; // 使用传入的 config 来设置 pluginConfigInstance

    const isGlobalDebugMode = process.env.DebugMode === 'true'; // Check global debug mode as fallback for initial logs

    if (isGlobalDebugMode || (pluginConfigInstance && pluginConfigInstance.DebugMode)){
        console.log('[VCPLog] DEBUG: registerRoutes called. Raw config received:', JSON.stringify(config, null, 2));
    }

    if (pluginConfigInstance) {
        vcpKey = pluginConfigInstance.VCP_Key;
        console.log('[VCPLog] DEBUG: Attempting to read VCP_Key from config. Value:', vcpKey);

        enableGotifyPush = (String(pluginConfigInstance.Enable_Gotify_Push).toLowerCase() === 'true');
        gotifyUrl = pluginConfigInstance.Gotify_Url;
        gotifyToken = pluginConfigInstance.Gotify_App_Token;
        gotifyPriority = pluginConfigInstance.Gotify_Priority;

        // Ensure DebugMode is checked safely
        const isPluginDebugMode = pluginConfigInstance.DebugMode === true || String(pluginConfigInstance.DebugMode).toLowerCase() === 'true';

        if (isPluginDebugMode) {
            console.log('[VCPLog] Running in DebugMode. Config in registerRoutes:', pluginConfigInstance);
            if (vcpKey) {
                console.log('[VCPLog] VCP_Key configured in registerRoutes.');
            } else {
                console.warn('[VCPLog] VCP_Key is NOT configured (registerRoutes). WebSocket auth will fail.');
            }
            console.log(`[VCPLog] Gotify Push Enabled (registerRoutes): ${enableGotifyPush}`);
            if (enableGotifyPush) {
                if (gotifyUrl && gotifyToken) {
                    console.log(`[VCPLog] Gotify configured (registerRoutes): URL=${gotifyUrl}, Token=****, Priority=${gotifyPriority === undefined ? 'Default (2)' : gotifyPriority}`);
                } else {
                    console.warn('[VCPLog] Gotify push enabled, but URL/Token not set (registerRoutes). Push will be skipped.'); 
                }
            }
        } else if (isGlobalDebugMode && !isPluginDebugMode) {
             // If global debug is on, but plugin debug is off, still give some basic info
            console.log(`[VCPLog] VCP_Key (registerRoutes): ${vcpKey ? 'Set' : 'NOT SET'}`);
            console.log(`[VCPLog] Gotify Push Enabled (registerRoutes): ${enableGotifyPush}`);
        }
    } else {
        console.error('[VCPLog] CRITICAL: No config for registerRoutes. VCPLog/Gotify will not function.');
        vcpKey = undefined;
        enableGotifyPush = false; 
    }

    const pluginBasePath = path.join(projectBasePath, 'Plugin', 'VCPLog');
    ensureLogDirAndFile(pluginBasePath); 

    const finalDebugCheck = pluginConfigInstance && (pluginConfigInstance.DebugMode === true || String(pluginConfigInstance.DebugMode).toLowerCase() === 'true');
    if (finalDebugCheck) {
        console.log('[VCPLog] registerRoutes VCPLog part setup complete.');
    }
}

function attachWebSocketServer(httpServer) {
    const isDebugMode = pluginConfigInstance && (pluginConfigInstance.DebugMode === true || String(pluginConfigInstance.DebugMode).toLowerCase() === 'true');
    if (!httpServer) {
        console.error('[VCPLog] Cannot attach WebSocket server without an HTTP server instance.');
        return;
    }
    if (!vcpKey && pluginConfigInstance) { 
        vcpKey = pluginConfigInstance.VCP_Key;
        if (isDebugMode) {
            console.warn('[VCPLog] vcpKey was re-fetched in attachWebSocketServer. Ideally set in registerRoutes. Value:', vcpKey);
        }
    }
    
    if (!vcpKey) { 
        console.warn('[VCPLog] VCP_Key not set for WebSocket. Connections will not be authenticated properly.');
    }

    wss = new WebSocket.Server({ noServer: true }); 

    httpServer.on('upgrade', (request, socket, head) => {
        const pathname = request.url;
        const expectedPathPrefix = '/VCPlog/VCP_Key=';

        if (pathname && pathname.startsWith(expectedPathPrefix)) {
            const providedKey = pathname.substring(expectedPathPrefix.length);
            if (vcpKey && providedKey === vcpKey) {
                wss.handleUpgrade(request, socket, head, (ws) => {
                    ws.isAuthenticated = true; 
                    wss.emit('connection', ws, request);
                    if (isDebugMode) {
                        console.log('[VCPLog] WebSocket client authenticated and connected.');
                    }
                    writeToLog(`Client connected with key: ${providedKey}`);
                });
            } else {
                if (isDebugMode) {
                    console.warn(`[VCPLog] WebSocket authentication failed. Provided key: ${providedKey}. Expected key: ${vcpKey}`);
                }
                writeToLog(`Client connection denied. Invalid key: ${providedKey}`);
                socket.destroy();
            }
        } else {
            if (isDebugMode) {
                console.log(`[VCPLog] WebSocket upgrade request for unknown path: ${pathname}. Ignoring.`);
            }
        }
    });

    wss.on('connection', (ws) => {
        ws.on('message', (message) => {
            if (isDebugMode) {
                console.log('[VCPLog] Received message from client (should not happen):', message);
            }
        });

        ws.on('close', () => {
            if (isDebugMode) {
                console.log('[VCPLog] Client disconnected.');
            }
            writeToLog('Client disconnected.');
        });

        ws.on('error', (error) => {
            console.error('[VCPLog] WebSocket error:', error);
            writeToLog(`WebSocket error: ${error.message}`);
        });

        if (ws.isAuthenticated) {
             ws.send(JSON.stringify({ type: 'connection_ack', message: 'VCPLog connection successful.' }));
        }
    });

    if (isDebugMode) {
        console.log(`[VCPLog] WebSocket server attached. Listening for upgrades on /VCPlog/VCP_Key=...`);
    }
}


async function shutdown() {
    const isDebugMode = pluginConfigInstance && (pluginConfigInstance.DebugMode === true || String(pluginConfigInstance.DebugMode).toLowerCase() === 'true');
    if (isDebugMode) {
        console.log('[VCPLog] Shutting down VCPLog plugin...');
    }
    if (wss) {
        wss.clients.forEach(client => {
            client.close();
        });
        wss.close(() => {
            if (isDebugMode) {
                console.log('[VCPLog] WebSocket server closed.');
            }
        });
    }
    await writeToLog('VCPLog plugin shutdown.');
}

module.exports = {
    initialize,
    registerRoutes,
    attachWebSocketServer,
    shutdown,
    pushVcpLog
};