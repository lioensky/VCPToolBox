const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');

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
command:「始」ScreenCapture「末」,
ocr:「始」false「末」`;

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

/**
 * 使用 ffmpeg 将图片分辨率降低一半
 * @param {string} base64WithPrefix 带有 MIME 前缀的 base64 字符串
 * @returns {Promise<string>} 处理后的带有 MIME 前缀的 base64 字符串
 */
function resizeImageHalf(base64WithPrefix) {
    return new Promise((resolve, reject) => {
        const matches = base64WithPrefix.match(/^data:([^;]+);base64,(.+)$/);
        if (!matches) {
            return reject(new Error('Invalid base64 format'));
        }

        const mimeType = matches[1];
        const base64Data = matches[2];
        let inputBuffer = Buffer.from(base64Data, 'base64');

        const ffmpeg = spawn('ffmpeg', [
            '-i', 'pipe:0',
            '-vf', 'scale=iw/2:ih/2',
            '-f', 'image2pipe',
            '-vcodec', mimeType.includes('png') ? 'png' : 'mjpeg',
            'pipe:1'
        ]);

        let outputChunks = [];
        let errorData = '';

        const timeout = setTimeout(() => {
            ffmpeg.kill('SIGKILL');
            reject(new Error('ffmpeg process timed out'));
        }, 15000); // 15秒超时

        ffmpeg.stdout.on('data', (chunk) => {
            outputChunks.push(chunk);
        });

        ffmpeg.stderr.on('data', (chunk) => {
            errorData += chunk.toString();
        });

        const cleanup = () => {
            clearTimeout(timeout);
            inputBuffer = null;
            outputChunks = null;
        };

        ffmpeg.on('error', (err) => {
            cleanup();
            reject(new Error(`ffmpeg spawn error: ${err.message}`));
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                const finalBuffer = Buffer.concat(outputChunks);
                const resizedBase64 = finalBuffer.toString('base64');
                resolve(`data:${mimeType};base64,${resizedBase64}`);
            } else {
                reject(new Error(`ffmpeg failed with code ${code}: ${errorData}`));
            }
            cleanup();
        });

        ffmpeg.stdin.on('error', (err) => {
            console.error(`[CapturePreprocessor] stdin error: ${err.message}`);
        });

        ffmpeg.stdin.write(inputBuffer);
        ffmpeg.stdin.end();
    });
}

class CapturePreprocessor {
    _extractTextFromContent(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .filter(part => part && part.type === 'text' && typeof part.text === 'string')
                .map(part => part.text)
                .join('\n')
                .trim();
        }
        if (content && typeof content === 'object' && typeof content.text === 'string') {
            return content.text;
        }
        return '';
    }

    _replaceTextInContent(content, replacer) {
        if (typeof replacer !== 'function') return content;

        if (typeof content === 'string') {
            return replacer(content);
        }

        if (Array.isArray(content)) {
            const textIndices = [];
            const textValues = [];

            content.forEach((part, index) => {
                if (part && part.type === 'text' && typeof part.text === 'string') {
                    textIndices.push(index);
                    textValues.push(part.text);
                }
            });

            const mergedText = textValues.join('\n').trim();
            const replacedText = replacer(mergedText);

            if (textIndices.length > 0) {
                const firstIndex = textIndices[0];
                return content
                    .map((part, index) => {
                        if (!textIndices.includes(index)) return part;
                        if (index === firstIndex) {
                            return { ...part, text: replacedText };
                        }
                        return null;
                    })
                    .filter(Boolean);
            }

            return [{ type: 'text', text: replacedText }, ...content];
        }

        if (content && typeof content === 'object' && typeof content.text === 'string') {
            return { ...content, text: replacer(content.text) };
        }

        return content;
    }

    async processMessages(messages, requestConfig = {}) {
        const currentConfig = { ...vcpConfig, ...requestConfig };
        let systemPrompt = messages.find(m => m.role === 'system');
        let lastUserMessage = messages.findLast(m => m.role === 'user');

        if (!systemPrompt || !lastUserMessage) {
            return messages;
        }

        const systemPromptText = this._extractTextFromContent(systemPrompt.content);
        if (!systemPromptText) {
            return messages;
        }

        // 新正则支持 {{VCPScreenShot}}, {{VCPScreenShotMini}}, {{VCPScreenShot:窗口}} 和 {{VCPCameraCapture(N)}}
        const placeholderRegex = /{{\s*(VCPScreenShotMini(?::([^}]+))?|VCPScreenShot(?::([^}]+))?|VCPCameraCapture(?:\((\d+)\))?)\s*}}/g;
        const matches = [...systemPromptText.matchAll(placeholderRegex)];

        if (matches.length === 0) {
            return messages;
        }

        // --- Parallel Execution Logic ---
        const captureTasks = [];
        const seenTargets = new Set(); // 防止对同一个窗口截获多次

        for (const match of matches) {
            const fullMatch = match[1];

            if (fullMatch.startsWith('VCPScreenShot')) {
                const isMini = fullMatch.startsWith('VCPScreenShotMini');
                // 如果是 Mini，windowTitle 在 match[2]；如果是标准，在 match[3]
                const windowTitle = isMini ? (match[2] ? match[2].trim() : null) : (match[3] ? match[3].trim() : null);
                const taskKey = `${isMini ? 'mini_' : ''}${windowTitle ? `screen_${windowTitle}` : 'screen_full'}`;

                if (!seenTargets.has(taskKey)) {
                    seenTargets.add(taskKey);
                    captureTasks.push({
                        type: 'screen',
                        isMini: isMini,
                        params: windowTitle ? { windowTitle } : {}
                    });
                }
            } else if (fullMatch.startsWith('VCPCameraCapture')) {
                const cameraIndex = match[4] ? parseInt(match[4], 10) : 0;
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
                    .then(async result => {
                        let finalData = result;
                        if (task.isMini && result && Array.isArray(result.content)) {
                            // 遍历内容，对 image_url 进行处理
                            for (let i = 0; i < result.content.length; i++) {
                                const item = result.content[i];
                                if (item.type === 'image_url' && item.image_url && typeof item.image_url.url === 'string') {
                                    try {
                                        item.image_url.url = await resizeImageHalf(item.image_url.url);
                                    } catch (e) {
                                        console.error(`[CapturePreprocessor] Resize failed: ${e.message}`);
                                    }
                                }
                            }
                        }
                        return { type: 'screen', title: task.params.windowTitle || 'FullScreen', status: 'success', data: finalData, isMini: task.isMini };
                    })
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
        } else if (Array.isArray(userContent)) {
            userContent = [...userContent];
        } else if (userContent && typeof userContent === 'object' && typeof userContent.text === 'string') {
            userContent = [{ type: 'text', text: userContent.text }];
        } else {
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
        systemPrompt.content = this._replaceTextInContent(systemPrompt.content, (text) =>
            text.replace(placeholderRegex, '').trim()
        );

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