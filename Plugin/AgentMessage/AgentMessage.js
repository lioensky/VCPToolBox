#!/usr/bin/env node
const stdin = require('process').stdin;
const stdout = require('process').stdout;

async function main() {
    let inputData = '';
    stdin.setEncoding('utf8');

    stdin.on('data', function(chunk) {
        inputData += chunk;
    });

    stdin.on('end', async function() {
        let outputJson;

        try {
            if (!inputData.trim()) {
                throw new Error("No input data received from stdin.");
            }

            const params = JSON.parse(inputData);

            const maidName = params.Maid;
            const message = params.message;

            if (!message) {
                throw new Error("Missing required argument: message (消息内容)");
            }

            const now = new Date();
            const dateTimeString = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
            
            const formattedMessage = maidName ? `${dateTimeString} - ${maidName}\n${message}` : `${dateTimeString}\n${message}`;

            // 插件成功执行，将格式化后的消息作为结果返回
            // server.js 将会捕获这个结果，并通过 WebSocketServer 发送
            outputJson = {
                status: "success",
                result: { // 将消息包装在一个对象中，方便 server.js 识别和处理
                    type: "agent_message", // 定义一个消息类型
                    message: formattedMessage,
                    recipient: maidName || null, // 可以用于更精确的路由或前端显示
                    originalContent: message,
                    timestamp: now.toISOString()
                }
            };

        } catch (e) {
            let errorMessage;
            if (e instanceof SyntaxError) {
                errorMessage = "Invalid JSON input for AgentMessage plugin.";
            } else if (e instanceof Error) {
                errorMessage = e.message;
            } else {
                errorMessage = "An unknown error occurred in AgentMessage plugin.";
            }
            outputJson = { status: "error", error: `AgentMessage Plugin Error: ${errorMessage}` };
        }

        stdout.write(JSON.stringify(outputJson, null, 2));
    });
}

main().catch(error => {
    stdout.write(JSON.stringify({ status: "error", error: `Unhandled Plugin Error in AgentMessage: ${error.message || error}` }));
    process.exit(1);
});