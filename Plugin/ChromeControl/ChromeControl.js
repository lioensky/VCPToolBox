// Plugin/ChromeControl/ChromeControl.js
// A synchronous stdio plugin that acts as a temporary WebSocket client.

const WebSocket = require('ws');

// --- Configuration ---
// These should match your server's settings.
const PORT = process.env.PORT || '8088';
const SERVER_URL = process.env.WEBSOCKET_URL || `ws://localhost:${PORT}`;
const VCP_KEY = process.env.VCP_Key || '123456';

// --- Helper Functions ---
function readInput() {
    return new Promise((resolve) => {
        const chunks = [];
        process.stdin.on('data', chunk => chunks.push(chunk));
        process.stdin.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
    });
}

function generateRequestId() {
    return `cc-req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function writeOutput(data) {
    process.stdout.write(JSON.stringify(data));
}

// --- Command Parsing ---
function parseCommands(inputData) {
    const commands = [];
    // 兼容旧的、单个命令的格式
    if (inputData.command) {
        const { command, ...args } = inputData;
        commands.push({ command, ...args });
        return commands;
    }

    // 处理新的、支持序列的命令格式 (command1, target1, command2, target2, ...)
    const commandGroups = {};
    for (const key in inputData) {
        // 匹配 key 中的指令名称和序号 (例如: "command1", "target2")
        const match = key.match(/^([a-zA-Z_]+)(\d+)$/);
        if (match) {
            const [, name, index] = match;
            if (!commandGroups[index]) {
                commandGroups[index] = {};
            }
            // 将指令和参数按序号分组 (例如: {1: {command: 'type'}, 2: {target: 'vcp-id-26'}})
            commandGroups[index][name] = inputData[key];
        }
    }

    // 按序号从小到大排序，确保指令按顺序执行
    const sortedIndexes = Object.keys(commandGroups).sort((a, b) => parseInt(a) - parseInt(b));
    for (const index of sortedIndexes) {
        commands.push(commandGroups[index]);
    }

    return commands;
}

// --- Main Execution Logic ---
async function main() {
    let ws;
    try {
        const inputString = await readInput();
        const inputData = JSON.parse(inputString);

        const commands = parseCommands(inputData);

        if (commands.length === 0) {
            throw new Error("输入数据中未找到有效命令。");
        }

        const fullUrl = `${SERVER_URL}/vcp-chrome-control/VCP_Key=${VCP_KEY}`;
        ws = new WebSocket(fullUrl);

        // 等待 WebSocket 连接成功
        await new Promise((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', (err) => reject(new Error(`WebSocket连接建立失败: ${err.message}`)));
            ws.on('close', (code, reason) => {
                // 1000 是正常关闭
                if (code !== 1000) {
                    reject(new Error(`WebSocket连接在建立前关闭。代码: ${code}, 原因: ${reason}`));
                }
            });
        });

        const allResults = [];
        try {
            // 按顺序执行所有解析出的命令
            for (const commandData of commands) {
                const { command, ...args } = commandData;
                if (!command) {
                    throw new Error(`序列中的一个命令缺少 'command' 字段: ${JSON.stringify(commandData)}`);
                }

                // 为每个命令创建一个新的 Promise 来处理其生命周期
                const currentResult = await new Promise((resolve, reject) => {
                    let isResolvedOrRejected = false;
                    const requestId = generateRequestId();

                    const timeout = setTimeout(() => {
                        if (!isResolvedOrRejected) {
                            isResolvedOrRejected = true;
                            reject(new Error(`命令 '${command}' 执行超时。`));
                        }
                    }, 30000); // 30秒超时

                    const payload = {
                        type: 'command',
                        data: { requestId, command, ...args }
                    };
                    ws.send(JSON.stringify(payload));

                    const messageHandler = (message) => {
                        try {
                            const msg = JSON.parse(message);
                            if (msg.data && msg.data.requestId === requestId) {
                                cleanup();
                                if (!isResolvedOrRejected) {
                                    isResolvedOrRejected = true;
                                    if (msg.type === 'command_result') {
                                        if (msg.data.status === 'success') {
                                            resolve({ status: 'success', result: msg.data.result || msg.data.message });
                                        } else {
                                            reject(new Error(msg.data.error || `Chrome端执行命令'${command}'失败。`));
                                        }
                                    } else {
                                        reject(new Error(`收到意外的消息类型: ${msg.type}`));
                                    }
                                }
                            }
                        } catch (e) {
                            // 忽略无效的JSON或结构不匹配的消息
                        }
                    };

                    const errorHandler = (err) => {
                        cleanup();
                        if (!isResolvedOrRejected) {
                            isResolvedOrRejected = true;
                            reject(new Error(`WebSocket连接错误: ${err.message}`));
                        }
                    };

                    const closeHandler = (code, reason) => {
                        cleanup();
                        if (code !== 1000 && !isResolvedOrRejected) { // 1000 是正常关闭
                            isResolvedOrRejected = true;
                            reject(new Error(`WebSocket连接意外关闭。代码: ${code}, 原因: ${reason}`));
                        }
                    };

                    // 清理此命令的所有监听器
                    const cleanup = () => {
                        clearTimeout(timeout);
                        ws.removeListener('message', messageHandler);
                        ws.removeListener('error', errorHandler);
                        ws.removeListener('close', closeHandler);
                    };

                    ws.on('message', messageHandler);
                    ws.on('error', errorHandler);
                    ws.on('close', closeHandler);
                });

                // 收集成功的步骤结果
                allResults.push({
                    command: command,
                    ...args,
                    result: currentResult.result
                });
            }

            writeOutput({
                status: 'success',
                message: `成功执行全部 ${allResults.length} 个指令。`,
                results: allResults
            });

        } catch (error) {
            const errorMessage = `序列指令执行失败。${allResults.length > 0 ? `已成功执行 ${allResults.length} 个步骤。` : ''}错误详情: ${error.message}`;
            writeOutput({
                status: 'error',
                error: errorMessage,
                successful_steps: allResults
            });
        }
    } finally {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
        process.exit(0);
    }
}

main();