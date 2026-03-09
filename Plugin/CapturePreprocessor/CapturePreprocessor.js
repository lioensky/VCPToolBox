const http = require('http');
const path = require('path');
const fs = require('fs').promises;

let vcpConfig = {};
let vcpProjectBasePath = '';
let serverPort = '8080';
let serverKey = '';

/**
 * 通过 /v1/human/tool 端点调用分布式 ScreenPilot
 * @param {Object} params ScreenPilot 的参数
 * @returns {Promise<Object>} 包含 base64 图片结果的数据对象
 */
function callScreenPilot(params) {
    return new Promise((resolve, reject) => {
        if (!serverKey) {
            return reject(new Error('VCP Server API Key is missing.'));
        }

        const timeoutMs = parseInt(vcpConfig.MONITOR_TIMEOUT_MS || '30000', 10);

        let toolRequestBody = `<<<[TOOL_REQUEST]>>>
tool_name:「始」ScreenPilot「末」,
command:「始」ScreenCapture「末」`;

        if (params.windowTitle) {
            toolRequestBody += `,\nwindowTitle:「始」${params.windowTitle}「末」`;
        }

        toolRequestBody += `\n<<<[END_TOOL_REQUEST]>>>`;

        const options = {
            hostname: '127.0.0.1',
            port: serverPort,
            path: '/v1/human/tool',
            method: 'POST',
            timeout: timeoutMs,
            headers: {
                'Content-Type': 'text/plain;charset=UTF-8',
                'Authorization': `Bearer ${serverKey}`,
                'Content-Length': Buffer.byteLength(toolRequestBody)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed);
                    } catch (e) {
                        reject(new Error(`Failed to parse response: ${e.message}. Raw: ${data.substring(0, 100)}`));
                    }
                } else {
                    let errorMessage = `HTTP Error ${res.statusCode}`;
                    try {
                        const parsed = JSON.parse(data);
                        errorMessage = parsed.error || parsed.plugin_error || parsed.plugin_execution_error || errorMessage;
                    } catch (e) { }
                    reject(new Error(errorMessage));
                }
            });
        });

        req.on('error', (e) => {
            reject(new Error(`Request failed: ${e.message}`));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`ScreenPilot request timed out after ${timeoutMs}ms.`));
        });

        req.write(toolRequestBody);
        req.end();
    });
}

class CapturePreprocessor {
    async processMessages(messages, requestConfig = {}) {
        const currentConfig = { ...vcpConfig, ...requestConfig };
        let systemPrompt = messages.find(m => m.role === 'system');
        let lastUserMessage = messages.findLast(m => m.role === 'user');

        if (!systemPrompt || typeof systemPrompt.content !== 'string' || !lastUserMessage) {
            return messages;
        }

        // 新正则支持 {{VCPScreenShot}}, {{VCPScreenShot:窗口标题}} 和 {{VCPCameraCapture(N)}}
        const placeholderRegex = /{{\s*(VCPScreenShot(?::([^}]+))?|VCPCameraCapture(?:\((\d+)\))?)\s*}}/g;
        const matches = [...systemPrompt.content.matchAll(placeholderRegex)];

        if (matches.length === 0) {
            return messages;
        }

        // --- Parallel Execution Logic ---
        const captureTasks = [];
        const seenTargets = new Set(); // 防止对同一个窗口截获多次

        for (const match of matches) {
            const fullMatch = match[1];

            if (fullMatch.startsWith('VCPScreenShot')) {
                const windowTitle = match[2] ? match[2].trim() : null;
                const taskKey = windowTitle ? `screen_${windowTitle}` : 'screen_full';

                if (!seenTargets.has(taskKey)) {
                    seenTargets.add(taskKey);
                    captureTasks.push({
                        type: 'screen',
                        params: windowTitle ? { windowTitle } : {}
                    });
                }
            } else if (fullMatch.startsWith('VCPCameraCapture')) {
                const cameraIndex = match[3] ? parseInt(match[3], 10) : 0;
                const taskKey = `camera_${cameraIndex}`;

                if (!seenTargets.has(taskKey)) {
                    seenTargets.add(taskKey);
                    captureTasks.push({
                        type: 'camera',
                        cameraIndex: cameraIndex
                    });
                }
            }
        }

        const promises = captureTasks.map(task => {
            if (task.type === 'screen') {
                return callScreenPilot(task.params)
                    .then(result => ({ type: 'screen', title: task.params.windowTitle || 'FullScreen', status: 'success', data: result }))
                    .catch(e => ({ type: 'screen', title: task.params.windowTitle || 'FullScreen', status: 'error', message: e.message }));
            } else {
                // 目前分布式架构仅接管了屏幕截图，未开发分布式的摄像头工具。
                return Promise.resolve({
                    type: 'camera',
                    index: task.cameraIndex,
                    status: 'error',
                    message: "Distributed VCPCameraCapture is not yet implemented."
                });
            }
        });

        const settledResults = await Promise.all(promises);

        // --- Inject results into user message ---
        let userContent = lastUserMessage.content;
        if (typeof userContent === 'string') {
            userContent = [{ type: 'text', text: userContent }];
        } else if (!Array.isArray(userContent)) {
            return messages;
        }

        for (const result of settledResults) {
            if (result.status === 'success') {
                if (result.data && Array.isArray(result.data.content)) {
                    userContent.push(...result.data.content);
                }
            } else {
                const taskName = result.type === 'screen' ? `ScreenShot(${result.title})` : `CameraCapture(${result.index})`;
                userContent.push({ type: 'text', text: `[Capture Error for ${taskName}: ${result.message}]` });
            }
        }

        // Clean the system prompt and merge user message content
        systemPrompt.content = systemPrompt.content.replace(placeholderRegex, '').trim();

        const mergedContent = [];
        for (const part of userContent) {
            const lastPart = mergedContent[mergedContent.length - 1];
            if (part.type === 'text' && lastPart && lastPart.type === 'text') {
                lastPart.text += '\n' + part.text;
            } else {
                mergedContent.push(part);
            }
        }

        lastUserMessage.content = mergedContent;

        return messages;
    }

    initialize(initialConfig, dependencies) {
        vcpConfig = initialConfig;
        if (dependencies && dependencies.projectBasePath) {
            vcpProjectBasePath = dependencies.projectBasePath;
        } else {
            vcpProjectBasePath = path.join(__dirname, '..', '..');
        }

        // Caching PORT and Key for the internal HTTP requests
        if (initialConfig.PORT) serverPort = initialConfig.PORT;
        if (initialConfig.Key) serverKey = initialConfig.Key;

        console.log('[CapturePreprocessor] Initialized as distributed facade using ScreenPilot.');
    }
}

module.exports = new CapturePreprocessor();