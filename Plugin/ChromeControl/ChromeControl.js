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

// --- Main Execution Logic ---
async function main() {
    let ws;
    try {
        const inputString = await readInput();
        const inputData = JSON.parse(inputString);
        const { command, ...args } = inputData;

        if (!command) {
            throw new Error("命令 'command' 不能为空。");
        }

        const fullUrl = `${SERVER_URL}/vcp-chrome-control/VCP_Key=${VCP_KEY}`;
        ws = new WebSocket(fullUrl);

        const result = await new Promise((resolve, reject) => {
            const requestId = generateRequestId();
            
            const timeout = setTimeout(() => {
                reject(new Error('命令执行超时。'));
            }, 10000); // 10秒超时

            ws.on('open', () => {
                const payload = {
                    type: 'command',
                    data: {
                        requestId,
                        command,
                        ...args
                    }
                };
                ws.send(JSON.stringify(payload));
            });

            ws.on('message', (message) => {
                const msg = JSON.parse(message);
                if (msg.data && msg.data.requestId === requestId) {
                    clearTimeout(timeout);
                    if (msg.type === 'command_result') {
                        if (msg.data.status === 'success') {
                            // 接受 result 或 message 字段作为成功信息
                            resolve({ status: 'success', result: msg.data.result || msg.data.message });
                        } else {
                            reject(new Error(msg.data.error || 'Chrome端执行命令失败。'));
                        }
                    } else {
                        reject(new Error(`收到意外的消息类型: ${msg.type}`));
                    }
                }
            });

            ws.on('error', (err) => {
                clearTimeout(timeout);
                reject(new Error(`WebSocket连接错误: ${err.message}`));
            });

            ws.on('close', (code, reason) => {
                clearTimeout(timeout);
                reject(new Error(`WebSocket连接意外关闭。代码: ${code}, 原因: ${reason}`));
            });
        });

        writeOutput(result);

    } catch (error) {
        writeOutput({ status: 'error', error: error.message });
    } finally {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
        process.exit(0);
    }
}

main();