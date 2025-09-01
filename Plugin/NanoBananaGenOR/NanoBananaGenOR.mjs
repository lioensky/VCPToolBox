#!/usr/bin/env node

import axios from 'axios';
import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// --- 1. 配置加载与初始化 ---

const {
    OPENROUTER_API_KEYS,
    PROXY_AGENT,
    DIST_IMAGE_SERVERS,
    PROJECT_BASE_PATH,
    SERVER_PORT,
    IMAGESERVER_IMAGE_KEY,
    VAR_HTTP_URL
} = (() => {
    const keys = (process.env.OpenRouterKeyImage || '').split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) {
        console.error("[NanoBananaGenOR] 警告: config.env 中未配置 OpenRouterKeyImage。API 调用将会失败。");
    }

    const proxyUrl = process.env.OpenRouterProxy;
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
    if (agent) {
        console.error(`[NanoBananaGenOR] 使用代理: ${proxyUrl}`);
    }

    const distServers = (process.env.DIST_IMAGE_SERVERS || '').split(',').map(s => s.trim()).filter(Boolean);

    return {
        OPENROUTER_API_KEYS: keys,
        PROXY_AGENT: agent,
        DIST_IMAGE_SERVERS: distServers,
        PROJECT_BASE_PATH: process.env.PROJECT_BASE_PATH,
        SERVER_PORT: process.env.SERVER_PORT,
        IMAGESERVER_IMAGE_KEY: process.env.IMAGESERVER_IMAGE_KEY,
        VAR_HTTP_URL: process.env.VarHttpUrl
    };
})();

const API_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL_NAME = 'google/gemini-2.5-flash-image-preview:free';

function getRandomApiKey() {
    if (OPENROUTER_API_KEYS.length === 0) {
        throw new Error("OpenRouter API 密钥未配置。");
    }
    const randomIndex = Math.floor(Math.random() * OPENROUTER_API_KEYS.length);
    return OPENROUTER_API_KEYS[randomIndex];
}

// --- 2. 核心功能函数 ---

/**
 * 从 URL (http/https/data) 获取图像数据
 * @param {string} url - 图像的 URL
 * @returns {Promise<{buffer: Buffer, mimeType: string}>}
 */
async function getImageDataFromUrl(url) {
    if (url.startsWith('data:')) {
        const match = url.match(/^data:(image\/\w+);base64,(.*)$/);
        if (!match) throw new Error('无效的 data URI 格式。');
        return { buffer: Buffer.from(match[2], 'base64'), mimeType: match[1] };
    }

    if (url.startsWith('http')) {
        const response = await axios.get(url, { responseType: 'arraybuffer', httpsAgent: PROXY_AGENT });
        return { buffer: response.data, mimeType: response.headers['content-type'] || 'image/jpeg' };
    }

    if (url.startsWith('file://')) {
        const { fileURLToPath } = await import('url');
        const { default: mime } = await import('mime-types');
        const filePath = fileURLToPath(url);

        try {
            const buffer = await fs.readFile(filePath);
            const mimeType = mime.lookup(filePath) || 'application/octet-stream';
            console.error(`[NanoBananaGenOR] 成功直接读取本地文件: ${filePath}`);
            return { buffer, mimeType };
        } catch (e) {
            if (e.code === 'ENOENT') {
                // 文件在本地未找到。抛出一个特定结构的错误，让主服务器处理。
                const structuredError = new Error("本地文件未找到，需要远程获取。");
                structuredError.code = 'FILE_NOT_FOUND_LOCALLY';
                structuredError.fileUrl = url;
                throw structuredError;
            } else {
                // 对于其他错误（如权限问题），正常抛出。
                throw new Error(`读取本地文件时发生意外错误: ${e.message}`);
            }
        }
    }

    throw new Error('不支持的 URL 协议。请使用 http, https, data URI, 或 file://。');
}

/**
 * 调用 OpenRouter API 并返回响应
 * @param {object} payload - 发送给 API 的请求体
 * @returns {Promise<object>} - API 响应数据
 */
async function callOpenRouterApi(payload) {
    const apiKey = getRandomApiKey();

    const response = await axios.post(API_BASE_URL, payload, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        httpsAgent: PROXY_AGENT,
        timeout: 300000, // 5分钟超时
        maxBodyLength: Infinity,
        maxContentLength: Infinity
    });
    
    const message = response.data?.choices?.[0]?.message;
    if (!message) {
        const detailedError = `从 OpenRouter API 响应中未能提取到消息内容。收到的响应: ${JSON.stringify(response.data, null, 2)}`;
        throw new Error(detailedError);
    }
    
    return message;
}

/**
 * 处理API响应，保存图像并格式化最终结果
 * @param {object} message - 来自 OpenRouter API 的消息对象
 * @param {object} originalArgs - 原始的工具调用参数
 * @returns {Promise<object>} - 格式化后的成功结果对象
 */
async function processApiResponseAndSaveImage(message, originalArgs) {
    // OpenRouter 返回结构：message.content 是字符串，图像在 message.images 数组中
    const textContent = message.content || '';
    
    if (!message.images || !Array.isArray(message.images) || message.images.length === 0) {
        throw new Error(`API 未能生成图片，返回信息: ${textContent}`);
    }

    const imageData = message.images[0];
    if (!imageData || !imageData.image_url || !imageData.image_url.url) {
        throw new Error('API 返回的图像数据格式无效。');
    }

    // 处理图像数据
    const imageUrl = imageData.image_url.url;
    let imageBuffer, mimeType;

    if (imageUrl.startsWith('data:')) {
        const match = imageUrl.match(/^data:(image\/\w+);base64,(.*)$/);
        if (!match) throw new Error('API 返回的图像数据格式无效。');
        imageBuffer = Buffer.from(match[2], 'base64');
        mimeType = match[1];
    } else {
        // 如果是 URL，需要下载
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer', httpsAgent: PROXY_AGENT });
        imageBuffer = response.data;
        mimeType = response.headers['content-type'] || 'image/png';
    }
    
    const extension = mimeType.split('/')[1] || 'png';
    const generatedFileName = `${uuidv4()}.${extension}`;
    const imageDir = path.join(PROJECT_BASE_PATH, 'image', 'nanobananagen');
    const localImagePath = path.join(imageDir, generatedFileName);

    await fs.mkdir(imageDir, { recursive: true });
    await fs.writeFile(localImagePath, imageBuffer);

    const relativePathForUrl = path.join('nanobananagen', generatedFileName).replace(/\\/g, '/');
    const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`;

    // 优先使用 API 返回的文本，如果没有则使用默认文本
    const modelResponseText = textContent || "图片已成功处理！";
    const finalResponseText = `${modelResponseText}\n\n**图片详情:**\n- 提示词: ${originalArgs.prompt}\n- 可访问URL: ${accessibleImageUrl}\n\n请利用可访问url将图片转发给用户`;

    const base64Image = imageBuffer.toString('base64');

    return {
        content: [
            {
                type: 'text',
                text: finalResponseText
            },
            {
                type: 'image_url',
                image_url: {
                    url: `data:${mimeType};base64,${base64Image}`
                }
            }
        ],
        details: {
            serverPath: `image/nanobananagen/${generatedFileName}`,
            fileName: generatedFileName,
            ...originalArgs,
            imageUrl: accessibleImageUrl,
            modelResponseText: textContent || null
        }
    };
}

// --- 3. 命令处理函数 ---

async function generateImage(args) {
    if (!args.prompt || typeof args.prompt !== 'string') {
        throw new Error("参数错误: 'prompt' 是必需的字符串。");
    }

    // 按照 OpenRouter 的格式构建请求
    const payload = {
        "model": MODEL_NAME,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": args.prompt
                    }
                ]
            }
        ],
        "safety_settings": [
            {
                "category": "HARM_CATEGORY_HARASSMENT",
                "threshold": "BLOCK_NONE"
            },
            {
                "category": "HARM_CATEGORY_HATE_SPEECH",
                "threshold": "BLOCK_NONE"
            },
            {
                "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "threshold": "BLOCK_NONE"
            },
            {
                "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                "threshold": "BLOCK_NONE"
            }
        ]
    };

    const message = await callOpenRouterApi(payload);
    return await processApiResponseAndSaveImage(message, args);
}

async function editImage(args) {
    if (!args.prompt || typeof args.prompt !== 'string') {
        throw new Error("参数错误: 'prompt' 是必需的字符串。");
    }
    
    // 优先使用 image_base64, 其次是 image_url
    let imageUrlInput = args.image_base64 || args.image_url;

    if (!imageUrlInput) {
        throw new Error("参数错误: 必须提供 'image_url' 或 'image_base64'。");
    }

    // 获取图像数据
    let imageUrl;
    if (imageUrlInput.startsWith('data:')) {
        // 如果已经是 base64 URI, 直接使用
        imageUrl = imageUrlInput;
    } else {
        // 否则, 视作 URL 处理
        const { buffer, mimeType } = await getImageDataFromUrl(imageUrlInput);
        const base64Data = buffer.toString('base64');
        imageUrl = `data:${mimeType};base64,${base64Data}`;
    }

    // 按照 OpenRouter 的格式构建请求
    const payload = {
        "model": MODEL_NAME,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": args.prompt
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": imageUrl
                        }
                    }
                ]
            }
        ],
        "safety_settings": [
            {
                "category": "HARM_CATEGORY_HARASSMENT",
                "threshold": "BLOCK_NONE"
            },
            {
                "category": "HARM_CATEGORY_HATE_SPEECH",
                "threshold": "BLOCK_NONE"
            },
            {
                "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "threshold": "BLOCK_NONE"
            },
            {
                "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                "threshold": "BLOCK_NONE"
            }
        ]
    };

    const message = await callOpenRouterApi(payload);
    return await processApiResponseAndSaveImage(message, args);
}

async function composeImage(args) {
    if (!args.prompt || typeof args.prompt !== 'string') {
        throw new Error("参数错误: 'prompt' 是必需的字符串。");
    }

    // --- 向后兼容逻辑 ---
    // 如果存在旧的 'image_url' 或 'image_base64'，并且不存在新的 'image_url_1'，则自动转换
    const effectiveArgs = { ...args };
    if (!args.image_url_1 && !args.image_base64_1) {
        if (args.image_url) {
            effectiveArgs.image_url_1 = args.image_url;
        }
        if (args.image_base64) {
            effectiveArgs.image_base64_1 = args.image_base64;
        }
    }
    // --- 兼容逻辑结束 ---

    // 1. 找出有多少个图片参数 (使用处理过的 effectiveArgs)
    const imageKeys = Object.keys(effectiveArgs).filter(k => k.startsWith('image_url') || k.startsWith('image_base64'));
    
    // 提取所有索引并找到最大值
    const indices = imageKeys.map(k => {
        const num = k.split('_').pop();
        return isNaN(num) ? 0 : parseInt(num, 10);
    }).filter(n => n > 0);

    if (indices.length === 0) {
        throw new Error("参数错误: 未找到有效的 'image_url_N' 或 'image_base64_N' (N>0) 参数，也未找到可兼容的 'image_url' 参数。");
    }
    const maxIndex = Math.max(...indices);

    const contentArray = [{ "type": "text", "text": args.prompt }];

    // 2. 按顺序处理 1 到 maxIndex 的所有图片
    for (let i = 1; i <= maxIndex; i++) {
        const base64Key = `image_base64_${i}`;
        const urlKey = `image_url_${i}`;
        
        let processedImageUrl;

        if (effectiveArgs[base64Key]) {
            // 优先使用 base64 数据
            processedImageUrl = effectiveArgs[base64Key];
        } else if (effectiveArgs[urlKey]) {
            const imageUrl = effectiveArgs[urlKey];
            if (imageUrl.startsWith('data:')) {
                processedImageUrl = imageUrl;
            } else {
                try {
                    const { buffer, mimeType } = await getImageDataFromUrl(imageUrl);
                    const base64Data = buffer.toString('base64');
                    processedImageUrl = `data:${mimeType};base64,${base64Data}`;
                } catch (e) {
                    if (e.code === 'FILE_NOT_FOUND_LOCALLY') {
                        const enhancedError = new Error(`多图片合成中第 ${i} 张图片 (参数: ${urlKey}) 本地未找到，需要远程获取。`);
                        enhancedError.code = 'FILE_NOT_FOUND_LOCALLY';
                        enhancedError.fileUrl = e.fileUrl;
                        enhancedError.failedParameter = urlKey; // 关键：报告正确的失败参数
                        throw enhancedError;
                    }
                    throw new Error(`处理第 ${i} 张图片时发生错误: ${e.message}`);
                }
            }
        } else {
            // 如果索引不连续，报错
            throw new Error(`参数不连续: 缺少第 ${i} 张图片的 'image_url_${i}' 或 'image_base64_${i}'。`);
        }

        contentArray.push({
            "type": "image_url",
            "image_url": { "url": processedImageUrl }
        });
    }

    // 按照 OpenRouter 的格式构建请求
    const payload = {
        "model": MODEL_NAME,
        "messages": [
            {
                "role": "user",
                "content": contentArray
            }
        ],
        "safety_settings": [
            {
                "category": "HARM_CATEGORY_HARASSMENT",
                "threshold": "BLOCK_NONE"
            },
            {
                "category": "HARM_CATEGORY_HATE_SPEECH",
                "threshold": "BLOCK_NONE"
            },
            {
                "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "threshold": "BLOCK_NONE"
            },
            {
                "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                "threshold": "BLOCK_NONE"
            }
        ]
    };

    const message = await callOpenRouterApi(payload);
    return await processApiResponseAndSaveImage(message, args);
}

// --- 4. 主入口函数 ---

async function main() {
    let inputData = '';
    try {
        for await (const chunk of process.stdin) {
            inputData += chunk;
        }

        if (!inputData.trim()) {
            throw new Error("未从 stdin 接收到任何输入数据。");
        }
        const parsedArgs = JSON.parse(inputData);

        let resultObject;
        switch (parsedArgs.command) {
            case 'generate':
                resultObject = await generateImage(parsedArgs);
                break;
            case 'edit':
                resultObject = await editImage(parsedArgs);
                break;
            case 'compose':
                resultObject = await composeImage(parsedArgs);
                break;
            default:
                throw new Error(`未知的命令: '${parsedArgs.command}'。请使用 'generate'、'edit' 或 'compose'。`);
        }
        
        console.log(JSON.stringify({ status: "success", result: resultObject }));

    } catch (e) {
        // 如果是我们自定义的结构化错误，就按特定格式输出
        if (e.code === 'FILE_NOT_FOUND_LOCALLY') {
            const errorPayload = {
                status: "error",
                code: e.code,
                error: e.message,
                fileUrl: e.fileUrl
            };
            // 关键修复：将 failedParameter 传递给主控，以便它知道要替换哪个参数
            if (e.failedParameter) {
                errorPayload.failedParameter = e.failedParameter;
            }
            console.log(JSON.stringify(errorPayload));
        } else {
            let detailedError = e.message || "未知的插件错误";
            if (e.response && e.response.data) {
                detailedError += ` - API 响应: ${JSON.stringify(e.response.data)}`;
            }
            const finalErrorMessage = `NanoBananaGenOR 插件错误: ${detailedError}`;
            console.log(JSON.stringify({ status: "error", error: finalErrorMessage }));
        }
        process.exit(1);
    }
}

main();