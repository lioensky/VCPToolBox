// WebSocketServer.js
const WebSocket = require('ws');
const url = require('url');

let wssInstance;
let serverConfig = {
    debugMode: false,
    vcpKey: null
};

// 用于存储已连接并认证的客户端
const clients = new Map(); // 使用 Map 存储，key 可以是 clientId, value 是 ws 连接实例

function generateClientId() {
    return Math.random().toString(36).substring(2, 15);
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
        
        // 示例：VCPLog 的路径和认证，可以扩展为更通用的路径处理和认证机制
        // 例如，路径可以指示消息的目标插件或频道
        const vcpLogPathRegex = /^\/VCPlog\/VCP_Key=(.+)$/;
        const vcpMatch = pathname.match(vcpLogPathRegex);

        let isAuthenticated = false;
        let clientId = null;
        let clientType = null; // 可以用来区分不同类型的客户端或插件订阅

        if (vcpMatch && vcpMatch[1]) {
            const providedKey = vcpMatch[1];
            if (serverConfig.vcpKey && providedKey === serverConfig.vcpKey) {
                isAuthenticated = true;
                clientType = 'VCPLog'; // 标记这个连接是为 VCPLog 服务的
                writeLog(`VCPLog client attempting to connect with key: ${providedKey}`);
            } else {
                writeLog(`VCPLog client connection denied. Invalid or missing VCP_Key. Provided: ${providedKey}`);
                socket.destroy();
                return;
            }
        } else {
            // 未来可以为其他插件或通用 WebSocket 连接定义不同的路径和认证
            // 例如: /ws/pluginName?token=xxx
            // 对于未知路径，可以选择拒绝或允许（如果不需要认证）
            writeLog(`WebSocket upgrade request for unhandled path: ${pathname}. Ignoring.`);
            // socket.destroy(); // 如果只允许特定路径，则销毁
            return; // 当前只处理 VCPLog 路径
        }

        if (isAuthenticated) {
            wssInstance.handleUpgrade(request, socket, head, (ws) => {
                clientId = generateClientId();
                ws.clientId = clientId;
                ws.clientType = clientType; // 存储客户端类型
                clients.set(clientId, ws);
                wssInstance.emit('connection', ws, request);
                writeLog(`Client ${clientId} (Type: ${clientType}) authenticated and connected.`);
            });
        } else {
            // 此处理论上不会到达，因为上面已经 destroy 或 return
            writeLog(`WebSocket authentication failed for path: ${pathname}.`);
            socket.destroy();
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
                console.log(`[WebSocketServer] Received message from ${ws.clientId}: ${message}`);
            }
            // TODO: 处理来自客户端的消息
            // 例如，根据消息内容或 ws.clientType 将消息路由到特定插件
            // let parsedMessage;
            // try {
            //     parsedMessage = JSON.parse(message);
            //     if (parsedMessage.targetPlugin && parsedMessage.payload) {
            //         // Route to pluginManager.callPluginMethod(parsedMessage.targetPlugin, parsedMessage.payload)
            //     }
            // } catch (e) {
            //     console.error('[WebSocketServer] Failed to parse message from client:', message, e);
            // }
        });

        ws.on('close', () => {
            clients.delete(ws.clientId);
            if (serverConfig.debugMode) {
                console.log(`[WebSocketServer] Client ${ws.clientId} disconnected.`);
            }
            writeLog(`Client ${ws.clientId} disconnected.`);
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
    if (wssInstance && wssInstance.clients) {
        const messageString = JSON.stringify(data);
        clients.forEach(clientWs => {
            if (clientWs.readyState === WebSocket.OPEN) {
                if (targetClientType === null || clientWs.clientType === targetClientType) {
                    clientWs.send(messageString);
                }
            }
        });
        writeLog(`Broadcasted (Target: ${targetClientType || 'All'}): ${JSON.stringify(data)}`);
    }
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

module.exports = {
    initialize,
    broadcast,
    sendMessageToClient,
    shutdown
};