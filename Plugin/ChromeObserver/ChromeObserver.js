// Plugin/ChromeObserver/ChromeObserver.js

const pluginManager = require('../../Plugin.js');
const webSocketServer = require('../../WebSocketServer.js');

let pluginConfig = {};
let debugMode = false;

// 用于存储连接的Chrome插件客户端
// key: clientId, value: ws instance
const connectedChromes = new Map();

function initialize(config) {
    pluginConfig = config;
    debugMode = pluginConfig.DebugMode || false;
    if (debugMode) {
        console.log('[ChromeObserver] Initializing with config:', pluginConfig);
    }
    // 初始时，占位符可以为一个默认值
    pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", "Chrome观察者已加载，等待浏览器连接...");
}

function registerRoutes(app, config, projectBasePath) {
    // 目前主要通过WebSocket通信
    if (debugMode) {
        console.log('[ChromeObserver] Registering routes...');
    }
}

// 当WebSocketServer接收到新的ChromeObserver客户端时，会调用此函数
function handleNewClient(ws) {
    const clientId = ws.clientId;
    connectedChromes.set(clientId, ws);
    if (debugMode) {
        console.log(`[ChromeObserver] New Chrome client connected: ${clientId}. Total: ${connectedChromes.size}`);
    }
    pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", "浏览器已连接，等待页面信息...");

    ws.on('close', () => {
        connectedChromes.delete(clientId);
        if (debugMode) {
            console.log(`[ChromeObserver] Chrome client disconnected: ${clientId}. Total: ${connectedChromes.size}`);
        }
        if (connectedChromes.size === 0) {
            pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", "浏览器连接已断开。");
        }
    });
}

// 当从Chrome插件接收到消息时调用
function handleClientMessage(clientId, message) {
    if (debugMode) {
        if (message.type === 'pageInfoUpdate' && message.data && typeof message.data.markdown === 'string') {
            // 对于页面更新，只记录长度以避免日志泛滥
            console.log(`[ChromeObserver] Received 'pageInfoUpdate' from client ${clientId}. Markdown length: ${message.data.markdown.length}`);
        } else {
            // 对于其他类型的消息，记录完整内容
            console.log(`[ChromeObserver] Received message from client ${clientId}:`, message);
        }
    }

    if (message.type === 'pageInfoUpdate') {
        // 更新页面信息占位符
        pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", message.data.markdown);
    }
}

function shutdown() {
    if (debugMode) {
        console.log('[ChromeObserver] Shutting down.');
    }
    connectedChromes.clear();
}

module.exports = {
    initialize,
    registerRoutes,
    handleNewClient,
    handleClientMessage,
    shutdown
};