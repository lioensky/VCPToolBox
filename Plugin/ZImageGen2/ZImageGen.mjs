#!/usr/bin/env node

import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { HttpsProxyAgent } from 'https-proxy-agent';

// --- 1. 配置加载与初始化 ---

const {
    PROJECT_BASE_PATH,
    SERVER_PORT,
    IMAGESERVER_IMAGE_KEY,
    VAR_HTTP_URL
} = (() => {
    return {
        PROJECT_BASE_PATH: process.env.PROJECT_BASE_PATH || '.',
        SERVER_PORT: process.env.SERVER_PORT || '3000',
        IMAGESERVER_IMAGE_KEY: process.env.IMAGESERVER_IMAGE_KEY || 'default_key',
        VAR_HTTP_URL: process.env.VarHttpUrl || 'http://localhost'
    };
})();

const API_BASE_URL = 'https://aisudo-z-image-base.hf.space/gradio_api';

// 代理配置 (根据需要调整)
const PROXY_URL = 'http://127.0.0.1:7890';
const httpsAgent = new HttpsProxyAgent(PROXY_URL);
// 如果不需要代理，可以将此设为 null
const USE_PROXY = false;

const axiosConfig = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://aisudo-z-image-base.hf.space',
        'Referer': 'https://aisudo-z-image-base.hf.space/'
    },
    httpsAgent: USE_PROXY ? httpsAgent : undefined,
    proxy: false // 禁用 axios 默认代理处理，使用 httpsAgent
};

// --- 2. 核心功能函数 ---

/**
 * 解析分辨率字符串为宽高
 * @param {string} resolution - 分辨率字符串，如 "1024x1024", "16:9", "landscape"
 * @returns {{width: number, height: number}}
 */
function parseResolution(resolution) {
    if (!resolution) return { width: 1024, height: 1024 };
    
    const res = resolution.toLowerCase().trim();
    
    // 预设比例
    const presets = {
        'square': { width: 1024, height: 1024 },
        'landscape': { width: 1280, height: 720 },
        'portrait': { width: 720, height: 1280 },
        '16:9': { width: 1280, height: 720 },
        '9:16': { width: 720, height: 1280 },
        '4:3': { width: 1152, height: 864 },
        '3:4': { width: 864, height: 1152 },
        '1:1': { width: 1024, height: 1024 }
    };
    
    if (presets[res]) return presets[res];
    
    // 解析 WxH 格式
    const match = res.match(/(\d+)\s*[x×]\s*(\d+)/i);
    if (match) {
        return { width: parseInt(match[1]), height: parseInt(match[2]) };
    }
    
    return { width: 1024, height: 1024 };
}

/**
 * 调用 Gradio API 生成图像 (新版API格式)
 * @param {object} args - 生成参数
 * @returns {Promise<{imageUrl: string, seed: number}>} - 生成的图像 URL 和 seed
 */
async function callGradioApi(args) {
    const prompt = args.prompt;
    const negativePrompt = args.negative_prompt || "";
    const { width, height } = parseResolution(args.resolution);
    const seed = parseInt(args.seed) || 42;
    const steps = parseInt(args.steps) || 28;
    const cfg = parseFloat(args.cfg) || 4;
    const cfgNormalization = args.cfg_normalization === 'true' || args.cfg_normalization === true;
    const randomSeed = args.random_seed !== 'false' && args.random_seed !== false;

    // 生成随机 session_hash 和 trigger_id
    const sessionHash = Math.random().toString(36).substring(2, 15);
    const triggerId = Math.floor(Math.random() * 1000);

    // 使用网页版相同的 API 格式
    const payload = {
        data: [
            prompt,           // 0: prompt: string
            negativePrompt,   // 1: negative_prompt: string
            width,            // 2: width: number
            height,           // 3: height: number
            seed,             // 4: seed: number
            steps,            // 5: num_inference_steps: number
            cfg,              // 6: guidance_scale: number
            cfgNormalization, // 7: cfg_normalization: boolean
            randomSeed,       // 8: randomize_seed: boolean
            []                // 9: unknown empty array
        ],
        fn_index: 1,
        trigger_id: 22,
        session_hash: sessionHash
    };

    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.error(`尝试调用 Gradio API (第 ${attempt} 次)`);
            
            // 使用网页版相同的端点
            const response = await axios.post(`${API_BASE_URL}/queue/join`, payload, {
                ...axiosConfig,
                headers: {
                    ...axiosConfig.headers,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 30000
            });

            if (!response.data || !response.data.event_id) {
                throw new Error('API 响应格式错误，缺少 event_id');
            }

            const eventId = response.data.event_id;
            console.error(`获得事件ID: ${eventId}`);

            // 监听结果
            return await listenForResult(eventId, sessionHash);
            
        } catch (error) {
            lastError = error;
            console.error(`第 ${attempt} 次尝试失败: ${error.message}`);
            
            if (attempt < maxRetries) {
                const delay = attempt * 2000;
                console.error(`等待 ${delay}ms 后重试...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw new Error(`Gradio API 调用失败 (已重试 ${maxRetries} 次): ${lastError.message}`);
}

/**
 * 监听 Gradio 任务结果
 * @param {string} eventId - 任务 ID
 * @param {string} sessionHash - 会话 hash
 * @returns {Promise<{imageUrl: string, seed: number}>} - 图像 URL 和 seed
 */
async function listenForResult(eventId, sessionHash) {
    const eventSourceUrl = `${API_BASE_URL}/queue/data?session_hash=${sessionHash}`;
    
    try {
        const response = await axios.get(eventSourceUrl, {
            ...axiosConfig,
            responseType: 'stream',
            headers: {
                ...axiosConfig.headers,
                'Accept': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            },
            timeout: 300000
        });

        const stream = response.data;
        let buffer = '';

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('等待图片生成超时 (2分钟)'));
            }, 120000);

            stream.on('data', (chunk) => {
                buffer += chunk.toString();
                
                // SSE 消息以 \n\n 分隔
                let boundary;
                while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                    const message = buffer.substring(0, boundary);
                    buffer = buffer.substring(boundary + 2);
                    
                    // 处理每一行
                    const lines = message.split('\n');
                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;
                        
                        const dataStr = line.substring(6).trim();
                        if (!dataStr) continue;

                        try {
                            const data = JSON.parse(dataStr);
                            
                            // 根据 msg 类型处理
                            switch (data.msg) {
                                case 'heartbeat':
                                    // 心跳，忽略
                                    break;
                                    
                                case 'estimation':
                                    if (data.rank !== undefined) {
                                        console.error(`队列位置: ${data.rank}, 预计等待: ${data.queue_size} 个任务`);
                                    }
                                    break;
                                    
                                case 'process_starts':
                                    console.error('任务开始处理...');
                                    break;
                                    
                                case 'progress':
                                    // 进度更新
                                    if (data.progress_data && data.progress_data[0]) {
                                        const progress = data.progress_data[0];
                                        console.error(`生成进度: ${progress.index || 0}/${progress.length || '?'}`);
                                    }
                                    break;
                                    
                                case 'process_completed':
                                    console.error('任务完成！');
                                    clearTimeout(timeoutId);
                                    
                                    // 提取结果
                                    if (data.output && data.output.data && Array.isArray(data.output.data)) {
                                        const outputData = data.output.data;
                                        const imageResult = outputData[0];
                                        const seedUsed = outputData[1];
                                        
                                        let downloadUrl = null;
                                        
                                        // 处理不同的返回格式
                                        if (typeof imageResult === 'string') {
                                            if (imageResult.startsWith('/tmp/')) {
                                                downloadUrl = `https://aisudo-z-image-base.hf.space/gradio_api/file=${imageResult}`;
                                            } else {
                                                downloadUrl = imageResult;
                                            }
                                        } else if (imageResult && imageResult.url) {
                                            // 可能直接是完整URL
                                            downloadUrl = imageResult.url;
                                        } else if (imageResult && imageResult.path) {
                                            downloadUrl = `https://aisudo-z-image-base.hf.space/gradio_api/file=${imageResult.path}`;
                                        }
                                        
                                        if (downloadUrl) {
                                            console.error(`图片URL: ${downloadUrl.substring(0, 80)}...`);
                                            resolve({ imageUrl: downloadUrl, seed: seedUsed });
                                            return;
                                        }
                                    }
                                    reject(new Error('无法从响应中提取图片URL: ' + JSON.stringify(data.output).substring(0, 200)));
                                    return;
                                    
                                case 'error':
                                case 'process_error':
                                    clearTimeout(timeoutId);
                                    reject(new Error(`API返回错误: ${JSON.stringify(data)}`));
                                    return;
                                    
                                case 'queue_full':
                                    clearTimeout(timeoutId);
                                    reject(new Error('服务器队列已满，请稍后重试'));
                                    return;
                                    
                                default:
                                    // 忽略其他未知事件
                                    break;
                            }
                            
                        } catch (parseError) {
                            if (!(parseError instanceof SyntaxError)) {
                                clearTimeout(timeoutId);
                                reject(parseError);
                                return;
                            }
                        }
                    }
                }
            });

            stream.on('end', () => {
                clearTimeout(timeoutId);
                // 检查缓冲区是否还有未处理的数据
                if (buffer.trim()) {
                    console.error(`流结束时剩余数据: ${buffer.substring(0, 100)}`);
                }
                reject(new Error('SSE 流意外结束，未收到 process_completed'));
            });

            stream.on('error', (err) => {
                clearTimeout(timeoutId);
                reject(new Error(`SSE 流错误: ${err.message}`));
            });
        });

    } catch (err) {
        if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
            throw new Error(`网络连接问题: ${err.message}`);
        }
        throw new Error(`SSE 监听失败: ${err.message}`);
    }
}

/**
 * 下载并保存图像
 * @param {string} imageUrl - 图像下载 URL
 * @returns {Promise<object>} - 本地文件信息
 */
async function saveImage(imageUrl) {
    const response = await axios.get(imageUrl, {
        ...axiosConfig,
        responseType: 'arraybuffer'
    });
    const buffer = response.data;
    const mimeType = response.headers['content-type'] || 'image/png';
    const extension = mimeType.split('/')[1] || 'png';
    
    const generatedFileName = `${uuidv4()}.${extension}`;
    const imageDir = path.join(PROJECT_BASE_PATH, 'image', 'zimagegen');
    const localImagePath = path.join(imageDir, generatedFileName);

    await fs.mkdir(imageDir, { recursive: true });
    await fs.writeFile(localImagePath, buffer);

    const relativePathForUrl = path.join('zimagegen', generatedFileName).replace(/\\/g, '/');
    const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`;

    return {
        serverPath: `image/zimagegen/${generatedFileName}`,
        fileName: generatedFileName,
        imageUrl: accessibleImageUrl,
        base64: buffer.toString('base64'),
        mimeType: mimeType
    };
}

// --- 3. 主逻辑 ---

async function generateImage(args) {
    if (!args.prompt) {
        throw new Error("参数错误: 'prompt' 是必需的。");
    }

    // 解析 showbase64 参数，默认为 false
    const showBase64 = args.showbase64 === 'true' || args.showbase64 === true;

    // 1. 调用 API 生成 (新API返回 {imageUrl, seed})
    const apiResult = await callGradioApi(args);

    // 2. 下载并保存
    const savedImage = await saveImage(apiResult.imageUrl);

    // 3. 构造返回结果
    const { width, height } = parseResolution(args.resolution);
    const finalResponseText = `图片已成功生成！\n\n**图片详情:**\n- 提示词: ${args.prompt}\n- 分辨率: ${width}x${height}\n- Seed: ${apiResult.seed}\n- 可访问URL: ${savedImage.imageUrl}\n- ShowBase64: ${showBase64}\n\n请利用可访问url将图片转发给用户`;

    // 根据 showbase64 参数决定返回内容
    const content = [
        {
            type: 'text',
            text: finalResponseText
        }
    ];

    // 只有当 showbase64 为 true 时才添加 base64 图片数据
    if (showBase64) {
        content.push({
            type: 'image_url',
            image_url: {
                url: `data:${savedImage.mimeType};base64,${savedImage.base64}`
            }
        });
    }

    return {
        content: content,
        details: {
            ...savedImage,
            prompt: args.prompt,
            seed: apiResult.seed,
            showBase64: showBase64
        }
    };
}

async function main() {
    let inputData = '';
    
    // 设置全局超时，防止进程无限挂起
    const timeout = setTimeout(() => {
        console.log(JSON.stringify({ status: "error", error: "ZImageGen 插件执行超时 (5分钟)" }));
        process.exit(1);
    }, 300000); // 5分钟超时

    try {
        for await (const chunk of process.stdin) {
            inputData += chunk;
        }

        if (!inputData.trim()) {
            throw new Error("未从 stdin 接收到任何输入数据。");
        }
        
        const parsedArgs = JSON.parse(inputData);
        let resultObject;

        // 兼容多种命令格式：command='generate' 或直接传prompt
        const command = parsedArgs.command || (parsedArgs.prompt ? 'generate' : undefined);
        
        if (command === 'generate' || command === 'ZImageGenerate') {
            resultObject = await generateImage(parsedArgs);
        } else {
            throw new Error(`未知的命令: '${command}'. 输入数据: ${JSON.stringify(parsedArgs).substring(0, 200)}`);
        }

        console.log(JSON.stringify({ status: "success", result: resultObject }));
        clearTimeout(timeout);

    } catch (e) {
        console.log(JSON.stringify({ status: "error", error: `ZImageGen 插件错误: ${e.message}` }));
        process.exit(1);
    }
}

main();