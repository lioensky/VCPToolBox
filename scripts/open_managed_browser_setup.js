'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');

const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(projectRoot, 'config.env');

if (fs.existsSync(configPath)) {
    dotenv.config({ path: configPath, override: false });
} else {
    console.warn('[Managed Browser Setup] 未找到 config.env，将使用当前环境变量。');
}

function readRequiredConfig(name) {
    const value = String(process.env[name] || '').trim();
    if (!value) {
        throw new Error(`config.env 缺少必要配置 ${name}`);
    }
    return value;
}

function buildOpenChromeToolRequest() {
    return [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」ManagedBrowserSetup「末」,',
        'tool_name:「始」ChromeBridge「末」,',
        'command:「始」open_chrome「末」,',
        'interactiveSetup:「始」true「末」,',
        'timeoutMs:「始」30000「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
}

function extractErrorMessage(statusCode, body) {
    try {
        const parsed = JSON.parse(body);
        return parsed.plugin_error ||
            parsed.plugin_execution_error ||
            parsed.error ||
            parsed.details ||
            parsed.message ||
            `HTTP ${statusCode}`;
    } catch (_) {
        return body.trim() || `HTTP ${statusCode}`;
    }
}

function postHumanTool({ port, key, body, timeoutMs = 45000 }) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/v1/human/tool',
            method: 'POST',
            timeout: timeoutMs,
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'text/plain;charset=UTF-8',
                'Content-Length': Buffer.byteLength(body)
            }
        }, response => {
            let responseBody = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                responseBody += chunk;
            });
            response.on('end', () => {
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    try {
                        resolve(JSON.parse(responseBody));
                    } catch (_) {
                        resolve({ status: 'success', raw: responseBody });
                    }
                    return;
                }

                reject(new Error(extractErrorMessage(response.statusCode, responseBody)));
            });
        });

        request.on('timeout', () => {
            request.destroy(new Error(`HumanTool 请求在 ${timeoutMs}ms 后超时`));
        });
        request.on('error', error => {
            reject(new Error(
                `无法调用 VCP HumanTool（127.0.0.1:${port}）：${error.message}。` +
                '请确认 VCP 服务器已经启动且 PORT/Key 配置正确。'
            ));
        });

        request.write(body);
        request.end();
    });
}

async function main() {
    const port = readRequiredConfig('PORT');
    const key = readRequiredConfig('Key');
    const requestBody = buildOpenChromeToolRequest();

    console.log('============================================================');
    console.log(' VCP Managed Chrome - 人工基础设置模式');
    console.log('============================================================');
    console.log('');
    console.log(`正在通过服务器 HumanTool 调用 ChromeBridge open_chrome……`);
    console.log(`Endpoint: http://127.0.0.1:${port}/v1/human/tool`);
    console.log('');

    const result = await postHumanTool({
        port,
        key,
        body: requestBody
    });

    console.log('[Managed Browser Setup] 服务器已接受请求并启动托管浏览器。');
    console.log('');
    console.log('浏览器生命周期现由 VCP 服务器主进程管理。');
    console.log('可在浏览器中设置扩展、登录态、语言、麦克风、摄像头及站点权限。');
    console.log('设置完成后可以正常关闭浏览器窗口。');
    console.log('');
    console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
    console.error('');
    console.error(`[Managed Browser Setup] 请求失败：${error.message}`);
    process.exitCode = 1;
});