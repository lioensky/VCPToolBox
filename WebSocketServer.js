// WebSocketServer.js
const WebSocket = require('ws');
const url = require('url');

let wssInstance;
let pluginManager = null; // 为 PluginManager 实例占位
let serverConfig = {
    debugMode: false,
    vcpKey: null
};

// 用于存储不同类型的客户端
const clients = new Map(); // VCPLog 等普通客户端
const distributedServers = new Map(); // 分布式服务器客户端
const pendingToolRequests = new Map(); // 跨服务器工具调用的待处理请求

function generateClientId() {
    // 用于生成客户端ID和请求ID
    return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`;
}

async function writeLog(message) {
    // 实际项目中，这里可以对接更完善的日志系统
    // 为了简化，暂时只在 debugMode 开启时打印到控制台
    if (serverConfig.debugMode) {
        console.log(`[WebSocketServer] ${new Date().toISOString()} - ${message}`);
    }
}

function initialize(httpServer, config) {
    if (!httpServer) {
        console.error('[WebSocketServer] Cannot initialize without an HTTP server instance.');
        return;
    }
    serverConfig = { ...serverConfig, ...config };

    if (!serverConfig.vcpKey && serverConfig.debugMode) {
        console.warn('[WebSocketServer] VCP_Key not set. WebSocket connections will not be authenticated if default path is used.');
    }

    wssInstance = new WebSocket.Server({ noServer: true });

    httpServer.on('upgrade', (request, socket, head) => {
        const parsedUrl = url.parse(request.url, true);
        const pathname = parsedUrl.pathname;

        const vcpLogPathRegex = /^\/VCPlog\/VCP_Key=(.+)$/;
        const distServerPathRegex = /^\/vcp-distributed-server\/VCP_Key=(.+)$/;

        const vcpMatch = pathname.match(vcpLogPathRegex);
        const distMatch = pathname.match(distServerPathRegex);

        let isAuthenticated = false;
        let clientType = null;
        let connectionKey = null;

        if (vcpMatch && vcpMatch[1]) {
            clientType = 'VCPLog';
            connectionKey = vcpMatch[1];
            writeLog(`VCPLog client attempting to connect.`);
        } else if (distMatch && distMatch[1]) {
            clientType = 'DistributedServer';
            connectionKey = distMatch[1];
            writeLog(`Distributed Server attempting to connect.`);
        } else {
            writeLog(`WebSocket upgrade request for unhandled path: ${pathname}. Ignoring.`);
            socket.destroy();
            return;
        }

        if (serverConfig.vcpKey && connectionKey === serverConfig.vcpKey) {
            isAuthenticated = true;
        } else {
            writeLog(`${clientType} connection denied. Invalid or missing VCP_Key.`);
            socket.destroy();
            return;
        }

        if (isAuthenticated) {
            wssInstance.handleUpgrade(request, socket, head, (ws) => {
                const clientId = generateClientId();
                ws.clientId = clientId;
                ws.clientType = clientType;

                if (clientType === 'DistributedServer') {
                    const serverId = `dist-${clientId}`;
                    ws.serverId = serverId;
                    distributedServers.set(serverId, { ws, tools: [] });
                    writeLog(`Distributed Server ${serverId} authenticated and connected.`);
                } else {
                    clients.set(clientId, ws);
                    writeLog(`Client ${clientId} (Type: ${clientType}) authenticated and connected.`);
                }
                
                wssInstance.emit('connection', ws, request);
            });
        }
    });

    wssInstance.on('connection', (ws, request) => {
        if (serverConfig.debugMode) {
            console.log(`[WebSocketServer] Client ${ws.clientId} connected.`);
        }

        // 发送连接确认消息给特定类型的客户端
        if (ws.clientType === 'VCPLog') {
            ws.send(JSON.stringify({ type: 'connection_ack', message: 'WebSocket connection successful for VCPLog.' }));
        }
        // 可以根据 ws.clientType 或其他标识符发送不同的欢迎消息

        ws.on('message', (message) => {
            if (serverConfig.debugMode) {
                // Buffer转为String以便日志记录
                const messageString = message.toString();
                console.log(`[WebSocketServer] Received message from ${ws.clientId} (${ws.clientType}): ${messageString.substring(0, 300)}...`);
            }
            try {
                const parsedMessage = JSON.parse(message);
                if (ws.clientType === 'DistributedServer') {
                    handleDistributedServerMessage(ws.serverId, parsedMessage);
                } else {
                    // 未来处理其他客户端类型的消息
                }
            } catch (e) {
                console.error(`[WebSocketServer] Failed to parse message from client ${ws.clientId}:`, message.toString(), e);
            }
        });

        ws.on('close', () => {
            if (ws.clientType === 'DistributedServer') {
                if (pluginManager) {
                    if (pluginManager) {
                        pluginManager.unregisterAllDistributedTools(ws.serverId);
                    }
                }
                distributedServers.delete(ws.serverId);
                writeLog(`Distributed Server ${ws.serverId} disconnected. Its tools have been unregistered.`);
            } else {
                clients.delete(ws.clientId);
            }
            if (serverConfig.debugMode) {
                console.log(`[WebSocketServer] Client ${ws.clientId} (${ws.clientType}) disconnected.`);
            }
        });

        ws.on('error', (error) => {
            console.error(`[WebSocketServer] Error with client ${ws.clientId}:`, error);
            writeLog(`WebSocket error for client ${ws.clientId}: ${error.message}`);
            // 确保在出错时也从 clients Map 中移除
            if(ws.clientId) clients.delete(ws.clientId);
        });
    });

    if (serverConfig.debugMode) {
        console.log(`[WebSocketServer] Initialized. Waiting for HTTP server upgrades.`);
    }
}

// 广播给所有已连接且认证的客户端，或者根据 clientType 筛选
function broadcast(data, targetClientType = null) {
    if (!wssInstance) return;
    const messageString = JSON.stringify(data);
    
    const clientsToBroadcast = new Map([...clients, ...Array.from(distributedServers.values()).map(ds => [ds.ws.clientId, ds.ws])]);

    clientsToBroadcast.forEach(clientWs => {
        if (clientWs.readyState === WebSocket.OPEN) {
            if (targetClientType === null || clientWs.clientType === targetClientType) {
                clientWs.send(messageString);
            }
        }
    });
    writeLog(`Broadcasted (Target: ${targetClientType || 'All'}): ${messageString.substring(0, 200)}...`);
}

// 发送给特定客户端
function sendMessageToClient(clientId, data) {
    const clientWs = clients.get(clientId);
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(data));
        writeLog(`Sent message to client ${clientId}: ${JSON.stringify(data)}`);
        return true;
    }
    writeLog(`Failed to send message to client ${clientId}: Not found or not open.`);
    return false;
}

function shutdown() {
    if (serverConfig.debugMode) {
        console.log('[WebSocketServer] Shutting down...');
    }
    if (wssInstance) {
        wssInstance.clients.forEach(client => {
            client.close();
        });
        wssInstance.close(() => {
            if (serverConfig.debugMode) {
                console.log('[WebSocketServer] Server closed.');
            }
        });
    }
    writeLog('WebSocketServer shutdown.');
}

// --- 新增分布式服务器相关函数 ---

function setPluginManager(pm) {
    pluginManager = pm;
    if (serverConfig.debugMode) console.log('[WebSocketServer] PluginManager instance has been set.');
}

function handleDistributedServerMessage(serverId, message) {
    if (!pluginManager) {
        console.error('[WebSocketServer] PluginManager not set, cannot handle distributed server message.');
        return;
    }
    writeLog(`Received message from Distributed Server ${serverId}: ${JSON.stringify(message).substring(0, 200)}...`);
    switch (message.type) {
        case 'register_tools':
            const serverEntry = distributedServers.get(serverId);
            if (serverEntry && message.data && Array.isArray(message.data.tools)) {
                pluginManager.registerDistributedTools(serverId, message.data.tools);
                serverEntry.tools = message.data.tools.map(t => t.name);
                distributedServers.set(serverId, serverEntry);
                writeLog(`Registered ${message.data.tools.length} tools from server ${serverId}.`);
            }
            break;
        case 'tool_result':
            const pending = pendingToolRequests.get(message.data.requestId);
            if (pending) {
                clearTimeout(pending.timeout);
                if (message.data.status === 'success') {
                    pending.resolve(message.data.result);
                } else {
                    pending.reject(new Error(message.data.error || 'Distributed tool execution failed.'));
                }
                pendingToolRequests.delete(message.data.requestId);
            }
            break;
        default:
            writeLog(`Unknown message type '${message.type}' from server ${serverId}.`);
    }
}

async function executeDistributedTool(serverId, toolName, toolArgs, timeout = 60000) {
    const server = distributedServers.get(serverId);
    if (!server || server.ws.readyState !== WebSocket.OPEN) {
        throw new Error(`Distributed server ${serverId} is not connected or ready.`);
    }

    const requestId = generateClientId();
    const payload = {
        type: 'execute_tool',
        data: {
            requestId,
            toolName,
            toolArgs
        }
    };

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            pendingToolRequests.delete(requestId);
            reject(new Error(`Request to distributed tool ${toolName} on server ${serverId} timed out after ${timeout / 1000}s.`));
        }, timeout);

        pendingToolRequests.set(requestId, { resolve, reject, timeout: timeoutId });

        server.ws.send(JSON.stringify(payload));
        writeLog(`Sent tool execution request ${requestId} for ${toolName} to server ${serverId}.`);
    });
}


module.exports = {
    initialize,
    setPluginManager,
    broadcast,
    sendMessageToClient,
    executeDistributedTool,
    shutdown
};