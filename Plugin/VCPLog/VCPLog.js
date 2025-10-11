const fs = require('fs').promises;
const path = require('path');
// WebSocket 和 vcpKey 的管理将移至 WebSocketServer.js
// let wss; //不再需要
// let vcpKey; //不再需要

const LOG_DIR_NAME = 'log';
const LOG_FILE_NAME = 'VCPlog.txt';
let logFilePath;
let pluginConfigInstance; // 用于存储插件配置
let broadcastVCPInfoFunction = null; // 新增：用于存储 WebSocketServer 的 broadcastVCPInfo 函数
// let serverInstance; // 不再直接存储 Express app 实例，WebSocketServer 将处理

// 引入 WebSocketServer 模块以调用其广播功能
// 注意：这里不能直接 require('../WebSocketServer.js') 因为插件和主服务器的依赖关系
// 插件应该通过 pluginManager 或 server.js 暴露的接口与 WebSocketServer 交互
// 为了简化，我们假设 server.js 会在调用 pushVcpLog 时已经初始化了 WebSocketServer
// 并且 pushVcpLog 的调用者 (server.js) 会负责调用 WebSocketServer.broadcast

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

// function broadcastToClients(data) { // 此功能移至 WebSocketServer.js
//     // ...
// }

// 暴露一个函数供 server.js 调用来推送 VCP 信息
// server.js 会负责调用 WebSocketServer.broadcast
function pushVcpLog(vcpData) {
    if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
        console.log('[VCPLog] Received VCP data for logging:', vcpData);
    }

    let logPrefix = "";
    let mainLogContent = `VCP Event: ${JSON.stringify(vcpData)}`;

    if (vcpData && typeof vcpData.content === 'string') {
        try {
            const parsedContent = JSON.parse(vcpData.content);
            if (parsedContent && typeof parsedContent === 'object') {
                if (parsedContent.MaidName) {
                    logPrefix += `[Maid: ${parsedContent.MaidName}] `;
                }
                if (parsedContent.timestamp) {
                    logPrefix += `[EventTime: ${parsedContent.timestamp}] `;
                }
                // 可选：如果希望主日志内容不重复显示已提取的MaidName和timestamp，
                // 可以从parsedContent中删除它们再重新stringify，但这会改变原始vcpData的记录。
                // 目前保持vcpData的完整性，将提取信息作为前缀。
            }
        } catch (e) {
            if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
                console.warn('[VCPLog] Failed to parse vcpData.content for MaidName/timestamp extraction:', e.message);
            }
            // 解析失败，则不添加额外前缀，只记录原始vcpData
        }
    }
    
    writeToLog(logPrefix + mainLogContent);
}

// 新增：暴露一个函数供 server.js 调用来推送 VCP Info 信息
function pushVcpInfo(infoData) {
    if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
        console.log('[VCPLog] Received VCP Info data for broadcast:', infoData);
    }
    
    if (broadcastVCPInfoFunction) {
        broadcastVCPInfoFunction(infoData);
    } else if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
        console.warn('[VCPLog] broadcastVCPInfoFunction is not set. Cannot broadcast VCP Info.');
    }
}

// 新增：用于注入 WebSocketServer 的广播函数
function setBroadcastFunctions(broadcastInfoFunc) {
    broadcastVCPInfoFunction = broadcastInfoFunc;
    if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
        console.log('[VCPLog] broadcastVCPInfoFunction has been set.');
    }
}


function initialize(config) {
    pluginConfigInstance = config; // 存储配置
    // vcpKey = pluginConfigInstance.VCP_Key; // VCP_Key 的使用移至 WebSocketServer
    if (pluginConfigInstance.DebugMode) {
        console.log('[VCPLog] Initializing with config:', pluginConfigInstance);
        // if (vcpKey) { // VCP_Key 检查移至 WebSocketServer
        //     console.log('[VCPLog] VCP_Key configured (though WebSocketServer will manage its use).');
        // } else {
        //     console.warn('[VCPLog] VCP_Key is not configured in plugin settings. WebSocketServer might deny connections.');
        // }
    }
}

function registerRoutes(app, config, projectBasePath) {
    // serverInstance = app; //不再需要
    if (!pluginConfigInstance) pluginConfigInstance = config;
    // if (!vcpKey) vcpKey = config.VCP_Key; //不再需要

    const pluginBasePath = path.join(projectBasePath, 'Plugin', 'VCPLog');
    ensureLogDirAndFile(pluginBasePath); // 初始化日志目录和文件

    // WebSocket 服务器的创建和管理已移至 WebSocketServer.js
    // attachWebSocketServer 方法也不再需要
    if (pluginConfigInstance.DebugMode) {
        console.log('[VCPLog] registerRoutes called. Log file initialized. WebSocket setup is handled by WebSocketServer.js.');
    }
}

// attachWebSocketServer 函数不再需要，其功能已移至 WebSocketServer.js
// function attachWebSocketServer(httpServer) {
//     // ...
// }


async function shutdown() {
    if (pluginConfigInstance && pluginConfigInstance.DebugMode) {
        console.log('[VCPLog] Shutting down VCPLog plugin (logging only)...');
    }
    // WebSocket server shutdown is handled by WebSocketServer.js
    // if (wss) {
    //     // ...
    // }
    await writeToLog('VCPLog plugin shutdown.');
}

module.exports = {
    initialize,
    registerRoutes,
    // attachWebSocketServer, // 不再导出
    shutdown,
    pushVcpLog, // 暴露给 server.js 或其他插件调用
    pushVcpInfo, // 暴露新的 VCP Info 推送函数
    setBroadcastFunctions // 暴露依赖注入函数
};