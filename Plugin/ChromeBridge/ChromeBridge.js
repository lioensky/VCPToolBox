// Plugin/ChromeBridge/ChromeBridge.js
// 混合插件：既是Service（常驻监控），又支持Direct调用（执行命令）

const pluginManager = require('../../Plugin.js');
const webSocketServer = require('../../WebSocketServer.js');

let pluginConfig = {};
let debugMode = false;

// 存储连接的Chrome插件客户端
const connectedChromes = new Map();

// 存储等待响应的命令
// key: requestId, value: { resolve, reject, timeout, waitForPageInfo }
const pendingCommands = new Map();

function initialize(config) {
    pluginConfig = config;
    debugMode = pluginConfig.DebugMode || false;
    
    if (debugMode) {
        console.log('[ChromeBridge] Initializing hybrid plugin...');
    }
    
    pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", "Chrome桥接已加载，等待浏览器连接...");
}

function registerRoutes(app, config, projectBasePath) {
    if (debugMode) {
        console.log('[ChromeBridge] Registering routes...');
    }
}

// WebSocketServer调用：新Chrome客户端连接
function handleNewClient(ws) {
    const clientId = ws.clientId;
    connectedChromes.set(clientId, ws);
    
    console.log(`[ChromeBridge] ✅ Chrome客户端已连接: ${clientId}, 总数: ${connectedChromes.size}`);
    pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", "浏览器已连接，等待页面信息...");

    ws.on('close', () => {
        connectedChromes.delete(clientId);
        console.log(`[ChromeBridge] ❌ Chrome客户端断开: ${clientId}, 剩余: ${connectedChromes.size}`);
        
        if (connectedChromes.size === 0) {
            pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", "浏览器连接已断开。");
        }
    });
}

// WebSocketServer调用：收到Chrome客户端的消息
function handleClientMessage(clientId, message) {
    if (message.type === 'pageInfoUpdate') {
        const markdown = message.data.markdown;
        
        // 更新占位符
        pluginManager.staticPlaceholderValues.set("{{VCPChromePageInfo}}", markdown);
        
        if (debugMode) {
            console.log(`[ChromeBridge] 📄 收到页面更新，长度: ${markdown?.length || 0}`);
        }
        
        // 检查是否有等待此页面信息的命令
        pendingCommands.forEach((pendingCmd, requestId) => {
            if (pendingCmd.waitForPageInfo && pendingCmd.commandExecuted) {
                console.log(`[ChromeBridge] 🎉 命令 ${requestId} 收到页面信息，准备返回`);
                clearTimeout(pendingCmd.timeout);
                pendingCmd.resolve({
                    success: true,
                    message: pendingCmd.executionMessage,
                    result: pendingCmd.commandResult,
                    page_info: markdown
                });
                pendingCommands.delete(requestId);
            }
        });
    }
}

// 执行单个命令的辅助函数（内部使用）
async function executeSingleCommand(chromeWs, cmdParams, waitForPageInfo = false, isInCommandChain = false) {
    const bridgeRequestId = `cb-req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const { command } = cmdParams;
    
    // 只有会导致页面导航/交互变化的命令才默认等待页面信息；CDP/查询/脚本执行类指令直接返回结构化结果
    const pageChangingCommands = new Set(['open_url', 'click', 'type']);
    const needsPageLoad = (command === 'open_url' && isInCommandChain);
    const actualWaitForPageInfo = (waitForPageInfo && pageChangingCommands.has(command)) || needsPageLoad || cmdParams.wait_for_page_info === true;
    
    console.log(`[ChromeBridge] 🚀 执行命令: ${command}, requestId: ${bridgeRequestId}, 等待页面加载: ${actualWaitForPageInfo}`);
    
    // 构建命令消息，透传所有参数，但内部回调 requestId 必须最后写入，避免被 CDP 的网络 requestId 覆盖
    const commandMessage = {
        type: 'command',
        data: {
            ...cmdParams,
            requestId: bridgeRequestId,
            wait_for_page_info: actualWaitForPageInfo
        }
    };
    
    // 发送命令到Chrome
    chromeWs.send(JSON.stringify(commandMessage));
    
    // 创建Promise等待响应
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingCommands.delete(bridgeRequestId);
            reject(new Error(`命令执行超时 (${command})`));
        }, 30000); // 30秒超时
        
        // 注册等待
        pendingCommands.set(bridgeRequestId, {
            resolve,
            reject,
            timeout,
            waitForPageInfo: actualWaitForPageInfo,
            commandExecuted: false,
            executionMessage: null,
            commandResult: null
        });
        
        // 监听命令执行结果
        const messageListener = (message) => {
            try {
                const msg = JSON.parse(message);
                
                if (msg.type === 'command_result' && msg.data?.requestId === bridgeRequestId) {
                    const pending = pendingCommands.get(bridgeRequestId);
                    if (!pending) return;
                    
                    if (msg.data.status === 'error') {
                        clearTimeout(pending.timeout);
                        pendingCommands.delete(bridgeRequestId);
                        chromeWs.removeListener('message', messageListener);
                        reject(new Error(msg.data.error || '命令执行失败'));
                    } else if (!actualWaitForPageInfo) {
                        // 不需要等待页面信息，直接返回
                        clearTimeout(pending.timeout);
                        pendingCommands.delete(bridgeRequestId);
                        chromeWs.removeListener('message', messageListener);
                        resolve({
                            success: true,
                            message: msg.data.message || '命令执行成功',
                            result: msg.data.result // 透传执行结果（如 HTML, JS 返回值, 网络日志等）
                        });
                    } else {
                        // 命令执行成功，标记并等待页面信息
                        console.log(`[ChromeBridge] ✅ 命令执行成功，等待页面加载/刷新...`);
                        pending.commandExecuted = true;
                        pending.executionMessage = msg.data.message || '命令执行成功';
                        pending.commandResult = msg.data.result;
                        // 不移除监听器，继续等待pageInfoUpdate
                    }
                }
            } catch (e) {
                console.error('[ChromeBridge] 解析消息失败:', e);
            }
        };
        
        chromeWs.on('message', messageListener);
    });
}

// Direct调用接口（hybridservice 使用 processToolCall）
async function processToolCall(params) {
    // 检查是否有连接的Chrome客户端
    if (connectedChromes.size === 0) {
        throw new Error('没有连接的Chrome浏览器。请确保VCPChrome扩展已安装并连接。');
    }
    
    // 选择第一个连接的客户端
    const chromeWs = Array.from(connectedChromes.values())[0];
    
    // 提取所有命令参数
    const commands = [];
    let commandIndex = 1;
    
    // 检查是否有编号的命令（command1, command2, ...）
    while (params[`command${commandIndex}`]) {
        const cmd = {
            command: params[`command${commandIndex}`],
            target: params[`target${commandIndex}`],
            text: params[`text${commandIndex}`],
            url: params[`url${commandIndex}`],
            urlIncludes: params[`urlIncludes${commandIndex}`],
            cdpRequestId: params[`requestId${commandIndex}`] || params[`cdpRequestId${commandIndex}`],
            query: params[`query${commandIndex}`],
            scope: params[`scope${commandIndex}`],
            useRegex: params[`useRegex${commandIndex}`],
            caseSensitive: params[`caseSensitive${commandIndex}`],
            contextChars: params[`contextChars${commandIndex}`],
            maxResults: params[`maxResults${commandIndex}`]
        };
        // 移除未定义的参数
        Object.keys(cmd).forEach(key => cmd[key] === undefined && delete cmd[key]);
        commands.push(cmd);
        commandIndex++;
    }
    
    // 如果没有编号命令，检查单个命令
    if (commands.length === 0 && params.command) {
        const cmd = {
            command: params.command,
            target: params.target,
            text: params.text,
            url: params.url,
            urlIncludes: params.urlIncludes,
            cdpRequestId: params.requestId || params.cdpRequestId,
            query: params.query,
            scope: params.scope,
            useRegex: params.useRegex,
            caseSensitive: params.caseSensitive,
            contextChars: params.contextChars,
            maxResults: params.maxResults
        };
        Object.keys(cmd).forEach(key => cmd[key] === undefined && delete cmd[key]);
        commands.push(cmd);
    }
    
    if (commands.length === 0) {
        throw new Error('未提供任何命令参数');
    }
    
    console.log(`[ChromeBridge] 📋 收到 ${commands.length} 个命令，准备串行执行`);
    
    const isCommandChain = commands.length > 1;
    
    // 串行执行所有命令
    for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        const isLastCommand = (i === commands.length - 1);
        
        console.log(`[ChromeBridge] 执行命令 ${i + 1}/${commands.length}: ${cmd.command}`);
        
        // 最后一个命令需要等待并返回页面信息
        // open_url 在命令链中时总是需要等待页面加载完成（通过 isInCommandChain 参数）
        const result = await executeSingleCommand(
            chromeWs,
            cmd,
            isLastCommand,  // waitForPageInfo - 只有最后一个命令返回页面信息
            isCommandChain  // isInCommandChain - 命令链中的 open_url 需要等待页面加载
        );
        
        console.log(`[ChromeBridge] ✅ 命令 ${i + 1}/${commands.length} 完成`);
        
        // 如果是最后一个命令，它的 Promise 已经 resolve 并返回结果
        if (isLastCommand) {
            return result;
        }
    }
    
    // executeSingleCommand的最后一个调用已经返回了包含页面信息的结果
    // 这里实际上永远不会到达，因为最后一个命令的Promise会resolve
}

function shutdown() {
    console.log('[ChromeBridge] 关闭中...');
    
    // 清理所有待处理的命令
    pendingCommands.forEach((pending, requestId) => {
        clearTimeout(pending.timeout);
        pending.reject(new Error('插件正在关闭'));
    });
    pendingCommands.clear();
    
    connectedChromes.clear();
}

module.exports = {
    initialize,
    registerRoutes,
    handleNewClient,
    handleClientMessage,
    processToolCall,
    shutdown
};