const WebSocket = require('ws');
const fs = require('fs').promises;
const path = require('path');

let wss;
let vcpKey;
const LOG_DIR_NAME = 'log';
const LOG_FILE_NAME = 'VCPlog.txt';
let logFilePath;
let pluginConfigInstance; // 用于存储插件配置
let serverInstance; // 用于存储 Express app 实例

async function ensureLogDirAndFile(basePath) {
    const pluginLogDirPath = path.join(basePath, LOG_DIR_NAME);
    try {
        await fs.mkdir(pluginLogDirPath, { recursive: true });
        logFilePath = path.join(pluginLogDirPath, LOG_FILE_NAME);
        // 确保文件存在，如果不存在则创建
        await fs.access(logFilePath).catch(async () => {
            await fs.writeFile(logFilePath, `Log initialized at ${new Date().toISOString()}\n`, 'utf-8');
        });
        console.log(`[VCPLog] Log directory and file ensured at: ${logFilePath}`);
    } catch (error) {
        console.error(`[VCPLog] Error ensuring log directory/file: ${pluginLogDirPath}`, error);
        // 如果日志目录创建失败，后续的日志写入会失败，但服务应继续运行
    }
}

async function writeToLog(message) {
    if (!logFilePath) {
        console.error('[VCPLog] Log file path not initialized. Cannot write log.');
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
        writeToLog(`Broadcasted: ${JSON.stringify(data)}`);
    }
}

// 暴露一个函数供 server.js 调用来推送 VCP 信息
function pushVcpLog(vcpData) {
    if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
        console.log('[VCPLog] Received VCP data to push:', vcpData);
    }
    broadcastToClients({ type: 'vcp_log', data: vcpData });
}


function initialize(config) {
    pluginConfigInstance = config; // 存储配置
    vcpKey = pluginConfigInstance.VCP_Key; // 从配置中获取 VCP_Key
    if (pluginConfigInstance.DebugMode) {
        console.log('[VCPLog] Initializing with config:', pluginConfigInstance);
        if (vcpKey) {
            console.log('[VCPLog] VCP_Key configured.');
        } else {
            console.warn('[VCPLog] VCP_Key is not configured in plugin settings. Authentication will fail.');
        }
    }
}

function registerRoutes(app, config, projectBasePath) {
    serverInstance = app; // 存储 Express app 实例
    // pluginConfigInstance 已在 initialize 中设置，但也可以在这里再次确认或使用传入的 config
    if (!pluginConfigInstance) pluginConfigInstance = config;
    if (!vcpKey) vcpKey = config.VCP_Key;

    const pluginBasePath = path.join(projectBasePath, 'Plugin', 'VCPLog');
    ensureLogDirAndFile(pluginBasePath); // 初始化日志目录和文件

    // 创建 WebSocket 服务器
    // 我们需要 HTTP 服务器实例来附加 WebSocket 服务器
    // 通常 Express app 本身就是一个 HTTP 服务器的回调，但直接附加到 app 可能不行
    // 需要获取到 app.listen 返回的 server 实例
    // 这里的实现假设 server.js 会将 http.Server 实例传递过来，或者我们自己创建一个
    // 但更常见的做法是在 server.js 中创建 WebSocket 服务器并传递给插件，或者插件自己监听一个新端口

    // 简单的做法：在 server.js 中，当 app.listen() 后，将 server 实例传递给插件
    // 或者，插件自己创建一个新的 HTTP 服务器专门用于 WebSocket
    // 为了简单起见，我们假设 WebSocket 服务器将与主 Express 服务器共享端口，
    // 这需要 server.js 的配合来正确设置。

    // 这里的 /VCPlog/:key 路由是用于 WebSocket 连接的升级请求
    // Express 本身不直接处理 ws:// 请求，但 WebSocket 服务器库 (如 'ws') 可以处理 HTTP Upgrade 请求

    // 注意：直接在插件的 registerRoutes 中创建和管理 WebSocket 服务器可能与主服务器的生命周期管理冲突。
    // 一个更健壮的方法是在 server.js 中创建 WebSocket 服务器，并让插件通过某种方式注册处理器。
    // 但根据请求，我们尝试在这里创建。

    // 获取 HTTP server 实例。这通常在 server.js 的 app.listen 之后获得。
    // 由于我们无法直接从这里访问 server.js 的 server 实例，
    // 我们将假设 server.js 会在调用 initializeServices 后，
    // 通过某种方式将 server 实例传递给这个插件，或者我们在这里创建一个新的。
    // 为了演示，我们将在 server.js 中进行修改以支持此模式。

    // 此处仅定义 WebSocket 服务器的逻辑，实际启动依赖于 server.js 的集成
    if (pluginConfigInstance.DebugMode) {
        console.log('[VCPLog] registerRoutes called. Waiting for HTTP server to be available for WebSocket setup.');
    }
}

// 这个函数需要由 server.js 在 HTTP 服务器启动后调用
function attachWebSocketServer(httpServer) {
    if (!httpServer) {
        console.error('[VCPLog] Cannot attach WebSocket server without an HTTP server instance.');
        return;
    }
    if (!vcpKey) {
        console.warn('[VCPLog] VCP_Key not set. WebSocket connections will not be authenticated.');
    }

    wss = new WebSocket.Server({ noServer: true }); // 我们将手动处理 upgrade 请求

    httpServer.on('upgrade', (request, socket, head) => {
        // 校验 URL，例如 /VCPlog/VCP_Key=actual_key
        const pathname = request.url;
        const expectedPathPrefix = '/VCPlog/VCP_Key=';

        if (pathname && pathname.startsWith(expectedPathPrefix)) {
            const providedKey = pathname.substring(expectedPathPrefix.length);
            if (vcpKey && providedKey === vcpKey) {
                wss.handleUpgrade(request, socket, head, (ws) => {
                    ws.isAuthenticated = true; // 标记为已认证
                    wss.emit('connection', ws, request);
                    if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                        console.log('[VCPLog] WebSocket client authenticated and connected.');
                    }
                    writeToLog(`Client connected with key: ${providedKey}`);
                });
            } else {
                if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                    console.warn(`[VCPLog] WebSocket authentication failed. Provided key: ${providedKey}`);
                }
                writeToLog(`Client connection denied. Invalid key: ${providedKey}`);
                socket.destroy();
            }
        } else {
            // 如果路径不匹配，可以选择忽略或销毁 socket
             if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                console.log(`[VCPLog] WebSocket upgrade request for unknown path: ${pathname}. Ignoring.`);
            }
            // socket.destroy(); // 或者不处理，让其他 upgrade 处理器有机会处理
        }
    });

    wss.on('connection', (ws) => {
        if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
            // console.log('[VCPLog] New client connected (already logged if authenticated).');
        }

        ws.on('message', (message) => {
            if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                console.log('[VCPLog] Received message from client (should not happen with current design):', message);
            }
            // 当前设计是服务器单向推送，客户端不发送消息
        });

        ws.on('close', () => {
            if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
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

    if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
        console.log(`[VCPLog] WebSocket server attached to HTTP server. Listening for upgrades on /VCPlog/VCP_Key=...`);
    }
}


async function shutdown() {
    if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
        console.log('[VCPLog] Shutting down VCPLog plugin...');
    }
    if (wss) {
        wss.clients.forEach(client => {
            client.close();
        });
        wss.close(() => {
            if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                console.log('[VCPLog] WebSocket server closed.');
            }
        });
    }
    await writeToLog('VCPLog plugin shutdown.');
}

module.exports = {
    initialize,
    registerRoutes,
    attachWebSocketServer, // 暴露此函数供 server.js 调用
    shutdown,
    pushVcpLog // 暴露给 server.js 或其他插件调用
};