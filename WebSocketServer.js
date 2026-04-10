// WebSocketServer.js
const WebSocket = require('ws');
const url = require('url');

let wssInstance;
let pluginManager = null; // 为 PluginManager 实例占位
let serverConfig = {
    debugMode: false,
    vcpKey: null,
    distToolDiagnosticsEnabled: false,
    distToolDiagnosticsIntervalMs: 60000
};

// 用于存储不同类型的客户端
const clients = new Map(); // VCPLog 等普通客户端
const distributedServers = new Map(); // 分布式服务器客户端
const chromeControlClients = new Map(); // ChromeControl 客户端
const chromeObserverClients = new Map(); // 新增：ChromeObserver 客户端
const adminPanelClients = new Map(); // 新增：管理面板客户端
const pendingToolRequests = new Map(); // 跨服务器工具调用的待处理请求
const distributedServerIPs = new Map(); // 新增：存储分布式服务器的IP信息
const waitingControlClients = new Map(); // 新增：存储等待页面更新的ChromeControl客户端 (clientId -> requestId)
const pluginClientHandlers = new Map(); // 插件注册的自定义 WebSocket 客户端类型 pathRegex → { clientType, onConnect, onMessage, onClose }
const pluginClients = new Map(); // 插件自定义客户端 clientId → { ws, clientType, handlerRef }
let runtimeSnapshotInterval = null;

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

function emitDistToolLog(prefix, event, payload = {}) {
    console.log(`${prefix} ${JSON.stringify({ event, ...payload })}`);
}

function emitRuntimeSnapshot(event = 'runtime_snapshot') {
    if (!serverConfig.distToolDiagnosticsEnabled) {
        return;
    }

    const snapshotAt = new Date().toISOString();
    const payload = {
        snapshotAt,
        distributedServerCount: distributedServers.size,
        pendingSize: pendingToolRequests.size,
        chromeObserverCount: chromeObserverClients.size,
        chromeControlCount: chromeControlClients.size,
        adminPanelCount: adminPanelClients.size,
        pluginClientCount: pluginClients.size
    };

    emitDistToolLog('[DistToolRuntime]', event, payload);

    if (pendingToolRequests.size >= 10) {
        emitDistToolLog('[DistToolRuntime]', 'runtime_pressure_warning', {
            ...payload,
            warningAt: snapshotAt,
            threshold: 10
        });
    }
}

function initialize(httpServer, config) {
    if (!httpServer) {
        console.error('[WebSocketServer] Cannot initialize without an HTTP server instance.');
        return;
    }
    serverConfig = { ...serverConfig, ...config };
    if (runtimeSnapshotInterval) {
        clearInterval(runtimeSnapshotInterval);
        runtimeSnapshotInterval = null;
    }
    if (serverConfig.distToolDiagnosticsEnabled) {
        runtimeSnapshotInterval = setInterval(() => {
            emitRuntimeSnapshot();
        }, serverConfig.distToolDiagnosticsIntervalMs);
    }

    if (!serverConfig.vcpKey && serverConfig.debugMode) {
        console.warn('[WebSocketServer] VCP_Key not set. WebSocket connections will not be authenticated if default path is used.');
    }

    wssInstance = new WebSocket.Server({ noServer: true });

    httpServer.on('upgrade', (request, socket, head) => {
        const parsedUrl = url.parse(request.url, true);
        const pathname = parsedUrl.pathname;

        const vcpLogPathRegex = /^\/VCPlog\/VCP_Key=(.+)$/;
        const vcpInfoPathRegex = /^\/vcpinfo\/VCP_Key=(.+)$/; // 新增：VCPInfo 通道
        const distServerPathRegex = /^\/vcp-distributed-server\/VCP_Key=(.+)$/;
        const chromeControlPathRegex = /^\/vcp-chrome-control\/VCP_Key=(.+)$/;
        const chromeObserverPathRegex = /^\/vcp-chrome-observer\/VCP_Key=(.+)$/;
        const adminPanelPathRegex = /^\/vcp-admin-panel\/VCP_Key=(.+)$/; // 新增

        const vcpMatch = pathname.match(vcpLogPathRegex);
        const vcpInfoMatch = pathname.match(vcpInfoPathRegex); // 新增匹配
        const distMatch = pathname.match(distServerPathRegex);
        const chromeControlMatch = pathname.match(chromeControlPathRegex);
        const chromeObserverMatch = pathname.match(chromeObserverPathRegex);
        const adminPanelMatch = pathname.match(adminPanelPathRegex); // 新增

        let isAuthenticated = false;
        let clientType = null;
        let connectionKey = null;

        if (vcpMatch && vcpMatch[1]) {
            clientType = 'VCPLog';
            connectionKey = vcpMatch[1];
            writeLog(`VCPLog client attempting to connect.`);
        } else if (vcpInfoMatch && vcpInfoMatch[1]) { // 新增 VCPInfo 客户端处理
            clientType = 'VCPInfo';
            connectionKey = vcpInfoMatch[1];
            writeLog(`VCPInfo client attempting to connect.`);
        } else if (distMatch && distMatch[1]) {
            clientType = 'DistributedServer';
            connectionKey = distMatch[1];
            writeLog(`Distributed Server attempting to connect.`);
        } else if (chromeObserverMatch && chromeObserverMatch[1]) {
           clientType = 'ChromeObserver';
           connectionKey = chromeObserverMatch[1];
           writeLog(`ChromeObserver client attempting to connect.`);
        } else if (chromeControlMatch && chromeControlMatch[1]) {
           clientType = 'ChromeControl';
           connectionKey = chromeControlMatch[1];
           writeLog(`Temporary ChromeControl client attempting to connect.`);
        } else if (adminPanelMatch && adminPanelMatch[1]) {
            clientType = 'AdminPanel';
            connectionKey = adminPanelMatch[1];
            writeLog(`Admin Panel client attempting to connect.`);
        } else {
            // 检查插件注册的自定义客户端类型
            let pluginHandlerMatched = false;
            for (const [regex, handler] of pluginClientHandlers) {
                const m = pathname.match(regex);
                if (m && m[1]) {
                    clientType = handler.clientType;
                    connectionKey = m[1];
                    pluginHandlerMatched = true;
                    break;
                }
            }
            if (!pluginHandlerMatched) {
                writeLog(`WebSocket upgrade request for unhandled path: ${pathname}. Ignoring.`);
                socket.destroy();
                return;
            }
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
                    distributedServers.set(serverId, { ws, tools: [], ips: {} }); // 初始化ips字段
                    writeLog(`Distributed Server ${serverId} authenticated and connected.`);
                } else if (clientType === 'ChromeObserver') {
                    console.log(`[WebSocketServer FORCE LOG] A client with type 'ChromeObserver' (ID: ${clientId}) has connected.`); // 强制日志
                   chromeObserverClients.set(clientId, ws); // 将客户端存入Map
                   writeLog(`ChromeObserver client ${clientId} connected and stored.`);
                   
                   // 优先尝试 ChromeBridge，回退到 ChromeObserver
                   const chromeBridgeModule = pluginManager.getServiceModule('ChromeBridge');
                   const chromeObserverModule = pluginManager.getServiceModule('ChromeObserver');
                   
                   if (chromeBridgeModule && typeof chromeBridgeModule.handleNewClient === 'function') {
                       console.log(`[WebSocketServer] ✅ Found ChromeBridge module. Calling handleNewClient...`);
                       chromeBridgeModule.handleNewClient(ws);
                   } else if (chromeObserverModule && typeof chromeObserverModule.handleNewClient === 'function') {
                       console.log(`[WebSocketServer] Found ChromeObserver module. Calling handleNewClient...`);
                       chromeObserverModule.handleNewClient(ws);
                   } else {
                        writeLog(`Warning: ChromeObserver client connected, but neither ChromeBridge nor ChromeObserver module found.`);
                        console.log(`[WebSocketServer FORCE LOG] Neither ChromeBridge nor ChromeObserver module found or handleNewClient is missing.`);
                   }
                } else if (clientType === 'ChromeControl') {
                   chromeControlClients.set(clientId, ws);
                   writeLog(`Temporary ChromeControl client ${clientId} connected.`);
                } else if (clientType === 'AdminPanel') {
                   adminPanelClients.set(clientId, ws);
                   writeLog(`Admin Panel client ${clientId} connected.`);
                } else {
                    // 检查是否是插件注册的自定义客户端类型
                    let isPluginClient = false;
                    for (const [, handler] of pluginClientHandlers) {
                        if (handler.clientType === clientType) {
                            pluginClients.set(clientId, { ws, clientType, handlerRef: handler });
                            if (typeof handler.onConnect === 'function') {
                                try { handler.onConnect(ws); } catch (e) {
                                    console.error(`[WebSocketServer] Plugin onConnect error for ${clientType}:`, e);
                                }
                            }
                            writeLog(`Plugin client ${clientId} (Type: ${clientType}) connected.`);
                            isPluginClient = true;
                            break;
                        }
                    }
                    if (!isPluginClient) {
                        clients.set(clientId, ws);
                        writeLog(`Client ${clientId} (Type: ${clientType}) authenticated and connected.`);
                    }
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
        } else if (ws.clientType === 'VCPInfo') { // 新增 VCPInfo 确认消息
            ws.send(JSON.stringify({ type: 'connection_ack', message: 'WebSocket connection successful for VCPInfo.' }));
        } else if (ws.clientType === 'DistributedServer') {
            // 分布式服务器连接确认，告知分配的 serverId
            ws.send(JSON.stringify({
                type: 'connection_ack',
                message: 'WebSocket connection successful for DistributedServer.',
                data: {
                    serverId: ws.serverId,
                    clientId: ws.clientId
                }
            }));
        }
        // 可以根据 ws.clientType 或其他标识符发送不同的欢迎消息

        ws.on('message', (message) => {
            const messageString = message.toString();
            
            try {
                const parsedMessage = JSON.parse(message);
                
                // 强制日志：ChromeObserver 的消息
                if (ws.clientType === 'ChromeObserver') {
                    console.log(`[WebSocketServer] 📨 收到 ChromeObserver 消息，类型: ${parsedMessage.type}`);
                }
                
                if (serverConfig.debugMode) {
                    console.log(`[WebSocketServer] Received message from ${ws.clientId} (${ws.clientType}): ${messageString.substring(0, 300)}...`);
                }
                if (ws.clientType === 'DistributedServer') {
                    module.exports.handleDistributedServerMessage(ws.serverId, parsedMessage);
                } else if (ws.clientType === 'ChromeObserver') {
                    if (parsedMessage.type === 'heartbeat') {
                        // 收到心跳包，发送确认
                        ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: Date.now() }));
                        if (serverConfig.debugMode) {
                            console.log(`[WebSocketServer] Received heartbeat from ChromeObserver client ${ws.clientId}, sent ack.`);
                        }
                    } else if (parsedMessage.type === 'command_result' && parsedMessage.data && parsedMessage.data.sourceClientId) {
                        // 如果是命令结果，则将其路由回原始的ChromeControl客户端
                        const sourceClientId = parsedMessage.data.sourceClientId;
                        
                        // 为ChromeControl客户端重新构建消息
                        const resultForClient = {
                            type: 'command_result',
                            data: {
                                requestId: parsedMessage.data.requestId,
                                status: parsedMessage.data.status,
                            }
                        };
                        if (parsedMessage.data.status === 'success') {
                            // 直接透传 message 字段，保持与 content_script 的一致性
                            resultForClient.data.message = parsedMessage.data.message;
                        } else {
                            resultForClient.data.error = parsedMessage.data.error;
                        }

                        const sent = sendMessageToClient(sourceClientId, resultForClient);
                        if (!sent) {
                            writeLog(`Warning: Could not find original ChromeControl client ${sourceClientId} to send command result.`);
                        }
                    }

                    // 无论如何，都让Chrome服务插件处理消息（优先ChromeBridge，回退ChromeObserver）
                    const chromeBridgeModule = pluginManager.getServiceModule('ChromeBridge');
                    const chromeObserverModule = pluginManager.getServiceModule('ChromeObserver');
                    const activeModule = chromeBridgeModule || chromeObserverModule;
                    
                    if (activeModule && typeof activeModule.handleClientMessage === 'function') {
                        // 避免将命令结果再次传递给状态处理器
                        if (parsedMessage.type !== 'command_result' && parsedMessage.type !== 'heartbeat') {
                            activeModule.handleClientMessage(ws.clientId, parsedMessage);

                            // 新增：检查是否有等待的Control客户端，并转发页面信息
                            if (parsedMessage.type === 'pageInfoUpdate') {
                                console.log(`[WebSocketServer] 🔔 收到 pageInfoUpdate, 当前等待客户端数: ${waitingControlClients.size}`);
                                
                                if (waitingControlClients.size > 0) {
                                    const pageInfoMarkdown = parsedMessage.data.markdown;
                                    console.log(`[WebSocketServer] 📤 准备转发页面信息，markdown 长度: ${pageInfoMarkdown?.length || 0}`);
                                    
                                    // 遍历所有等待的客户端
                                    waitingControlClients.forEach((requestId, clientId) => {
                                        console.log(`[WebSocketServer] 🎯 尝试转发给客户端 ${clientId}, requestId: ${requestId}`);
                                        const messageForControl = {
                                            type: 'page_info_update',
                                            data: {
                                                requestId: requestId, // 关联到原始请求
                                                markdown: pageInfoMarkdown
                                            }
                                        };
                                        const sent = sendMessageToClient(clientId, messageForControl);
                                        if (sent) {
                                            console.log(`[WebSocketServer] ✅ 成功转发页面信息给客户端 ${clientId}`);
                                            // 发送后即从等待列表移除
                                            waitingControlClients.delete(clientId);
                                        } else {
                                            console.log(`[WebSocketServer] ❌ 转发失败，客户端 ${clientId} 可能已断开`);
                                        }
                                    });
                                } else {
                                    console.log(`[WebSocketServer] ⚠️ 收到 pageInfoUpdate 但没有等待的客户端`);
                                }
                            }
                        }
                    }
                } else if (ws.clientType === 'ChromeControl') {
                    // ChromeControl客户端只应该发送'command'类型的消息
                    if (parsedMessage.type === 'command') {
                        const observerClient = Array.from(chromeObserverClients.values())[0]; // 假设只有一个Observer
                        if (observerClient) {
                            // 附加源客户端ID以便结果可以被路由回来
                            parsedMessage.data.sourceClientId = ws.clientId;

                            // 新增：如果命令请求等待页面信息，则注册该客户端
                            if (parsedMessage.data.wait_for_page_info) {
                                waitingControlClients.set(ws.clientId, parsedMessage.data.requestId);
                                console.log(`[WebSocketServer] 📝 客户端 ${ws.clientId} 注册等待页面信息，requestId: ${parsedMessage.data.requestId}`);
                                console.log(`[WebSocketServer] 📋 当前等待列表大小: ${waitingControlClients.size}`);
                            }

                            observerClient.send(JSON.stringify(parsedMessage));
                        } else {
                            // 如果没有找到浏览器插件，立即返回错误
                            ws.send(JSON.stringify({ type: 'command_result', data: { requestId: parsedMessage.data.requestId, status: 'error', error: 'No active Chrome browser extension found.' }}));
                        }
                    }
                } else if (parsedMessage.type === 'tool_approval_response') {
                    const { requestId, approved } = parsedMessage.data;
                    if (pluginManager) {
                        const success = pluginManager.handleApprovalResponse(requestId, approved);
                        if (serverConfig.debugMode) {
                            console.log(`[WebSocketServer] Approval response for ${requestId}: ${approved ? 'APPROVED' : 'REJECTED'}. Handled: ${success}`);
                        }
                    }
                } else if (ws.clientType === 'AdminPanel') {
                    // 保持原有的 AdminPanel 逻辑，如果将来有其他 AdminPanel 专用消息
                } else {
                    // 插件注册的自定义客户端消息路由
                    const pluginEntry = pluginClients.get(ws.clientId);
                    if (pluginEntry && typeof pluginEntry.handlerRef.onMessage === 'function') {
                        try { pluginEntry.handlerRef.onMessage(ws, parsedMessage); } catch (e) {
                            console.error(`[WebSocketServer] Plugin onMessage error for ${ws.clientType}:`, e);
                        }
                    }
                }
            } catch (e) {
                console.error(`[WebSocketServer] Failed to parse message from client ${ws.clientId}:`, message.toString(), e);
            }
        });

        ws.on('close', () => {
            if (ws.clientType === 'DistributedServer') {
                if (pluginManager) {
                    pluginManager.unregisterAllDistributedTools(ws.serverId);
                }
                distributedServers.delete(ws.serverId);
                distributedServerIPs.delete(ws.serverId); // 新增：移除IP信息
                writeLog(`Distributed Server ${ws.serverId} disconnected. Its tools and IP info have been unregistered.`);
            } else if (ws.clientType === 'ChromeObserver') {
              chromeObserverClients.delete(ws.clientId);
              writeLog(`ChromeObserver client ${ws.clientId} disconnected and removed.`);
           } else if (ws.clientType === 'ChromeControl') {
              chromeControlClients.delete(ws.clientId);
              waitingControlClients.delete(ws.clientId); // 新增：确保客户端断开连接时被清理
              writeLog(`ChromeControl client ${ws.clientId} disconnected and removed.`);
           } else if (ws.clientType === 'AdminPanel') {
              adminPanelClients.delete(ws.clientId);
              writeLog(`Admin Panel client ${ws.clientId} disconnected and removed.`);
           } else {
               // 插件注册的自定义客户端断开处理
               const pluginEntry = pluginClients.get(ws.clientId);
               if (pluginEntry) {
                   if (typeof pluginEntry.handlerRef.onClose === 'function') {
                       try { pluginEntry.handlerRef.onClose(ws); } catch (e) {
                           console.error(`[WebSocketServer] Plugin onClose error for ${ws.clientType}:`, e);
                       }
                   }
                   pluginClients.delete(ws.clientId);
                   writeLog(`Plugin client ${ws.clientId} (Type: ${ws.clientType}) disconnected.`);
               } else {
                   clients.delete(ws.clientId);
               }
           }
            if (serverConfig.debugMode) {
                console.log(`[WebSocketServer] Client ${ws.clientId} (${ws.clientType}) disconnected.`);
            }
        });

        ws.on('error', (error) => {
            console.error(`[WebSocketServer] Error with client ${ws.clientId}:`, error);
            writeLog(`WebSocket error for client ${ws.clientId}: ${error.message}`);
            // 确保在出错时也从对应的 Map 中移除（close 事件通常会紧随其后，做幂等处理）
            if (ws.clientId) {
                clients.delete(ws.clientId);
                pluginClients.delete(ws.clientId);
            }
        });
    });

    if (serverConfig.debugMode) {
        console.log(`[WebSocketServer] Initialized. Waiting for HTTP server upgrades.`);
    }
}

// 广播给所有已连接且认证的客户端，或者根据 clientType 筛选
function broadcast(data, targetClientType = null, abortController = null) {
    // 新增：检查中止信号，如果请求已被中止，则跳过广播
    if (abortController && abortController.signal && abortController.signal.aborted) {
        if (serverConfig.debugMode) {
            writeLog(`[Abort Check] Broadcast skipped due to aborted request.`);
        }
        return;
    }
    
    if (!wssInstance) return;
    const messageString = JSON.stringify(data);
    
    const clientsToBroadcast = new Map([
       ...clients,
       ...Array.from(distributedServers.values()).map(ds => [ds.ws.clientId, ds.ws])
   ]);

    clientsToBroadcast.forEach(clientWs => {
        if (clientWs.readyState === WebSocket.OPEN) {
            if (targetClientType === null || clientWs.clientType === targetClientType) {
                clientWs.send(messageString);
            }
        }
    });
    writeLog(`Broadcasted (Target: ${targetClientType || 'All'}): ${messageString.substring(0, 200)}...`);
}

// 新增：专门广播给 VCPInfo 客户端
function broadcastVCPInfo(data) {
    broadcast(data, 'VCPInfo');
}

// 发送给特定客户端
function sendMessageToClient(clientId, data) {
   // Check all client maps (including plugin clients)
   const clientWs = clients.get(clientId) ||
                    (Array.from(distributedServers.values()).find(ds => ds.ws.clientId === clientId) || {}).ws ||
                    chromeObserverClients.get(clientId) ||
                    chromeControlClients.get(clientId) ||
                    adminPanelClients.get(clientId) ||
                    (pluginClients.get(clientId) || {}).ws;

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
    if (runtimeSnapshotInterval) {
        clearInterval(runtimeSnapshotInterval);
        runtimeSnapshotInterval = null;
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
                // 过滤掉内部工具，不让它们显示在插件列表中
                const externalTools = message.data.tools.filter(t => t.name !== 'internal_request_file');
                const resolvedServerName = serverEntry.serverName || message.data.serverName || serverId;
                pluginManager.registerDistributedTools(serverId, resolvedServerName, externalTools);
                serverEntry.tools = externalTools.map(t => t.name);
                serverEntry.serverName = resolvedServerName;
                distributedServers.set(serverId, serverEntry);
                writeLog(`Registered ${externalTools.length} external tools from server ${serverId}.`);
            }
            break;
       case 'report_ip':
           const serverInfo = distributedServers.get(serverId);
           if (serverInfo && message.data) {
               const ipData = {
                   localIPs: message.data.localIPs || [],
                   publicIP: message.data.publicIP || null,
                   serverName: message.data.serverName || serverId
               };
               distributedServerIPs.set(serverId, ipData);
               
               // 将 serverName 也存储在主连接对象中，以便通过名字查找
               serverInfo.serverName = ipData.serverName;
               distributedServers.set(serverId, serverInfo);

               // 强制日志记录，无论debug模式如何
               console.log(`[IP Tracker] Received IP report from Distributed Server '${ipData.serverName}': Local IPs: [${ipData.localIPs.join(', ')}], Public IP: [${ipData.publicIP || 'N/A'}]`);
           }
           break;
        case 'update_static_placeholders':
            // 新增：处理分布式服务器发送的静态占位符更新
            if (message.data && message.data.placeholders) {
                const serverName = message.data.serverName || serverId;
                const placeholders = message.data.placeholders;
                
                if (serverConfig.debugMode) {
                    console.log(`[WebSocketServer] Received static placeholder update from ${serverName} with ${Object.keys(placeholders).length} placeholders.`);
                }
                
                // 将分布式服务器的静态占位符更新推送到主服务器的插件管理器
                pluginManager.updateDistributedStaticPlaceholders(serverId, serverName, placeholders);
            }
            break;
        case 'tool_result':
            const pending = pendingToolRequests.get(message.data.requestId);
            if (pending) {
                clearTimeout(pending.timeout);
                emitDistToolLog('[DistTool]', 'tool_result_received', {
                    requestId: message.data.requestId,
                    toolName: pending.toolName,
                    serverIdOrName: pending.serverIdOrName,
                    effectiveTimeout: pending.effectiveTimeout,
                    pendingSize: pendingToolRequests.size,
                    sentAt: pending.sentAt,
                    receivedAt: new Date().toISOString()
                });
                if (message.data.status === 'success') {
                    pending.resolve(message.data.result);
                } else {
                    pending.reject(new Error(message.data.error || 'Distributed tool execution failed.'));
                }
                pendingToolRequests.delete(message.data.requestId);
                emitDistToolLog('[DistToolPending]', 'pending_request_removed', {
                    requestId: message.data.requestId,
                    toolName: pending.toolName,
                    serverIdOrName: pending.serverIdOrName,
                    removedAt: new Date().toISOString(),
                    pendingSize: pendingToolRequests.size
                });
            } else {
                emitDistToolLog('[DistToolPending]', 'unmatched_tool_result', {
                    requestId: message.data.requestId,
                    serverIdOrName: serverId,
                    receivedAt: new Date().toISOString(),
                    pendingSize: pendingToolRequests.size
                });
            }
            break;
        default:
            writeLog(`Unknown message type '${message.type}' from server ${serverId}.`);
    }
}

async function executeDistributedTool(serverIdOrName, toolName, toolArgs, timeout, requestIdOverride) {
    // 优先从插件 manifest 获取超时设置
    const plugin = pluginManager.getPlugin(toolName);
    const defaultTimeout = plugin?.communication?.timeout || 60000;
    const effectiveTimeout = timeout ?? defaultTimeout;

    let server = distributedServers.get(serverIdOrName); // 优先尝试通过 ID 查找

    // 如果通过 ID 找不到，则遍历并尝试通过 name 查找
    if (!server) {
        for (const srv of distributedServers.values()) {
            if (srv.serverName === serverIdOrName) {
                server = srv;
                break;
            }
        }
    }

    if (!server || server.ws.readyState !== WebSocket.OPEN) {
        throw new Error(`Distributed server ${serverIdOrName} is not connected or ready.`);
    }

    const requestId = requestIdOverride || generateClientId();
    const sentAt = new Date().toISOString();
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
            emitDistToolLog('[DistToolTimeout]', 'distributed_tool_timeout', {
                requestId,
                toolName,
                serverIdOrName,
                effectiveTimeout,
                pendingSize: pendingToolRequests.size,
                sentAt,
                timedOutAt: new Date().toISOString()
            });
            emitDistToolLog('[DistToolPending]', 'pending_request_removed', {
                requestId,
                toolName,
                serverIdOrName,
                removedAt: new Date().toISOString(),
                pendingSize: pendingToolRequests.size
            });
            reject(new Error(`Request to distributed tool ${toolName} on server ${serverIdOrName} timed out after ${effectiveTimeout / 1000}s.`));
        }, effectiveTimeout);

        pendingToolRequests.set(requestId, {
            resolve,
            reject,
            timeout: timeoutId,
            toolName,
            serverIdOrName,
            effectiveTimeout,
            sentAt
        });
        emitDistToolLog('[DistToolPending]', 'pending_request_added', {
            requestId,
            toolName,
            serverIdOrName,
            effectiveTimeout,
            pendingSize: pendingToolRequests.size,
            sentAt
        });

        server.ws.send(JSON.stringify(payload));
        emitDistToolLog('[DistTool]', 'distributed_tool_sent', {
            requestId,
            toolName,
            serverIdOrName,
            effectiveTimeout,
            pendingSize: pendingToolRequests.size,
            sentAt
        });
        writeLog(`Sent tool execution request ${requestId} for ${toolName} to server ${serverIdOrName}.`);
    });
}

function findServerByIp(ip) {
   for (const [serverId, ipInfo] of distributedServerIPs.entries()) {
       if (ipInfo.publicIP === ip || (ipInfo.localIPs && ipInfo.localIPs.includes(ip))) {
           return ipInfo.serverName || serverId;
       }
   }
   return null;
}

// 新增：专门广播给管理面板
function broadcastToAdminPanel(data) {
    if (!wssInstance) return;
    const messageString = JSON.stringify(data);

    adminPanelClients.forEach(clientWs => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(messageString);
        }
    });
    console.log(`[WebSocketServer] Broadcasted to ${adminPanelClients.size} Admin Panel clients.`);
    if (serverConfig.debugMode) {
        writeLog(`Broadcasted to Admin Panel: ${messageString.substring(0, 200)}...`);
    }
}

/**
 * 注册插件自定义 WebSocket 客户端类型。
 * 插件在 registerApiRoutes 阶段调用此方法，即可让外部客户端通过自定义路径接入。
 *
 * @param {RegExp} pathRegex - 路径匹配正则，必须包含一个捕获组用于提取 VCP_Key。
 *                             例如：/^\/vcp-memo-inbox\/VCP_Key=(.+)$/
 * @param {string} clientType - 客户端类型标识，例如 'MemoInboxClient'
 * @param {object} handlers - 生命周期回调
 * @param {function} [handlers.onConnect] - 连接建立后回调 (ws) => void
 * @param {function} [handlers.onMessage] - 收到消息回调 (ws, parsedMessage) => void
 * @param {function} [handlers.onClose] - 连接关闭回调 (ws) => void
 */
function registerPluginClientType(pathRegex, clientType, handlers = {}) {
    if (!(pathRegex instanceof RegExp)) {
        console.error(`[WebSocketServer] registerPluginClientType: pathRegex must be a RegExp instance.`);
        return;
    }
    if (!clientType || typeof clientType !== 'string') {
        console.error(`[WebSocketServer] registerPluginClientType: clientType must be a non-empty string.`);
        return;
    }
    // 防止同一 clientType 重复注册，先清除旧的
    for (const [existingRegex, existingHandler] of pluginClientHandlers) {
        if (existingHandler.clientType === clientType) {
            pluginClientHandlers.delete(existingRegex);
            writeLog(`Plugin client type '${clientType}' was already registered, replacing.`);
            break;
        }
    }
    pluginClientHandlers.set(pathRegex, { clientType, ...handlers });
    console.log(`[WebSocketServer] Plugin client type '${clientType}' registered.`);
}

/**
 * 注销插件自定义 WebSocket 客户端类型，并断开该类型的所有已连接客户端。
 *
 * @param {string} clientType - 要注销的客户端类型标识
 */
function unregisterPluginClientType(clientType) {
    for (const [regex, handler] of pluginClientHandlers) {
        if (handler.clientType === clientType) {
            pluginClientHandlers.delete(regex);
            break;
        }
    }
    // 收集要清理的客户端 ID，避免遍历中删除
    const toRemove = [];
    for (const [clientId, entry] of pluginClients) {
        if (entry.clientType === clientType) {
            toRemove.push(clientId);
        }
    }
    for (const clientId of toRemove) {
        const entry = pluginClients.get(clientId);
        if (entry && entry.ws.readyState === WebSocket.OPEN) {
            entry.ws.close(1000, 'Plugin client type unregistered');
        }
        pluginClients.delete(clientId);
    }
    console.log(`[WebSocketServer] Plugin client type '${clientType}' unregistered.`);
}

/**
 * 向指定插件客户端类型的所有已连接客户端广播消息。
 *
 * @param {string} clientType - 目标客户端类型
 * @param {object} data - 要发送的数据（将被 JSON.stringify）
 */
function broadcastToPluginClients(clientType, data) {
    if (!wssInstance) return;
    const messageString = JSON.stringify(data);
    let count = 0;
    for (const [, entry] of pluginClients) {
        if (entry.clientType === clientType && entry.ws.readyState === WebSocket.OPEN) {
            entry.ws.send(messageString);
            count++;
        }
    }
    writeLog(`Broadcasted to ${count} plugin clients of type '${clientType}'.`);
}

module.exports = {
    initialize,
    setPluginManager,
    broadcast,
    broadcastVCPInfo, // 导出新的广播函数
    broadcastToAdminPanel, // 导出给管理面板的广播函数
    sendMessageToClient,
    executeDistributedTool,
    handleDistributedServerMessage,
    findServerByIp,
    registerPluginClientType,
    unregisterPluginClientType,
    broadcastToPluginClients,
    shutdown
};
