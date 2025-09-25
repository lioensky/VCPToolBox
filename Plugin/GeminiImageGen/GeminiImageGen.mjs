#!/usr/bin/env node

import axios from 'axios';
import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// --- 1. 配置加载与初始化 ---

const {
    GEMINI_API_KEYS,
    PROXY_AGENT,
    DIST_IMAGE_SERVERS,
    PROJECT_BASE_PATH,
    SERVER_PORT,
    IMAGESERVER_IMAGE_KEY,
    VAR_HTTP_URL
} = (() => {
    const keys = (process.env.GeminiImageKey || '').split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) {
        console.error("[GeminiImageGen] 警告: config.env 中未配置 GeminiImageKey。API 调用将会失败。");
    }

    const proxyUrl = process.env.GeminiImageProxy;
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
    if (agent) {
        console.error(`[GeminiImageGen] 使用代理: ${proxyUrl}`);
    }

    const distServers = (process.env.DIST_IMAGE_SERVERS || '').split(',').map(s => s.trim()).filter(Boolean);

    return {
        GEMINI_API_KEYS: keys,
        PROXY_AGENT: agent,
        DIST_IMAGE_SERVERS: distServers,
        PROJECT_BASE_PATH: process.env.PROJECT_BASE_PATH,
        SERVER_PORT: process.env.SERVER_PORT,
        IMAGESERVER_IMAGE_KEY: process.env.IMAGESERVER_IMAGE_KEY,
        VAR_HTTP_URL: process.env.VarHttpUrl
    };
})();

const API_BASE_URL = 'https://generativelanguage.googleapis.com';
const API_ENDPOINT_GENERATE = '/v1beta/models/gemini-2.5-flash-image-preview:generateContent'; // 使用 flash 预览模型

function getRandomApiKey() {
    if (GEMINI_API_KEYS.length === 0) {
        throw new Error("Gemini API 密钥未配置。");
    }
    const randomIndex = Math.floor(Math.random() * GEMINI_API_KEYS.length);
    return GEMINI_API_KEYS[randomIndex];
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

        // 1. 优先尝试直接读取本地文件
        try {
            const buffer = await fs.readFile(filePath);
            const mimeType = mime.lookup(filePath) || 'application/octet-stream';
            console.error(`[GeminiImageGen] 成功直接读取本地文件: ${filePath}`);
            return { buffer, mimeType };
        } catch (e) {
            // 仅当错误是文件不存在时才记录为警告并继续，否则直接抛出。
            if (e.code === 'ENOENT') {
                console.warn(`[GeminiImageGen] 直接读取本地文件失败: ${e.message}。将尝试降级到分布式图床。`);
            } else {
                // 对于其他类型的错误 (如权限问题), 直接抛出。
                throw new Error(`读取本地文件时发生意外错误: ${e.message}`);
            }
        }

        // 2. 如果直接读取失败，则降级到分布式图床
        if (DIST_IMAGE_SERVERS.length === 0) {
            throw new Error('直接读取本地文件失败，且未配置任何分布式图床地址 (DIST_IMAGE_SERVERS)。');
        }

        const fileName = path.basename(filePath);
        for (const serverBaseUrl of DIST_IMAGE_SERVERS) {
            const fullHttpUrl = `${serverBaseUrl.trim().replace(/\/$/, '')}/${fileName}`;
            try {
                console.error(`[GeminiImageGen] 尝试从分布式图床下载: ${fullHttpUrl}`);
                const response = await axios.get(fullHttpUrl, { responseType: 'arraybuffer', httpsAgent: PROXY_AGENT });
                console.error(`[GeminiImageGen] 成功从分布式图床下载图片。`);
                return { buffer: response.data, mimeType: response.headers['content-type'] || 'image/jpeg' };
            } catch (httpError) {
                console.warn(`[GeminiImageGen] 访问分布式图床失败: ${serverBaseUrl}. 错误: ${httpError.message}`);
                // 继续尝试下一个地址
            }
        }

        // 如果所有地址都尝试失败
        throw new Error(`无法从任何配置的分布式图床地址下载文件: ${fileName}`);
    }

    throw new Error('不支持的 URL 协议。请使用 http, https, data URI, 或 file://。');
}

/**
 * 调用 Gemini API 并返回所有响应部分
 * @param {string} endpoint - API 端点
 * @param {object} payload - 发送给 API 的请求体
 * @returns {Promise<Array<object>>} - 包含 text 和 inline_data 的 parts 数组
 */
async function callGeminiApi(endpoint, payload) {
    const apiKey = getRandomApiKey();
    const fullApiUrl = `${API_BASE_URL}${endpoint}?key=${apiKey}&alt=json`;

    const response = await axios.post(fullApiUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        httpsAgent: PROXY_AGENT,
        timeout: 300000, // 5分钟超时
        maxBodyLength: Infinity,
        maxContentLength: Infinity
    });
    
    const parts = response.data?.candidates?.[0]?.content?.parts;
    if (!parts || !Array.isArray(parts) || parts.length === 0) {
        const detailedError = `从 Gemini API 响应中未能提取到任何内容部分。收到的响应: ${JSON.stringify(response.data, null, 2)}`;
        throw new Error(detailedError);
    }
    
    const imagePart = parts.find(p => p.inlineData);
    if (!imagePart) {
        const textPart = parts.find(p => p.text);
        if (textPart) {
             throw new Error(`API 未能生成图片，但返回了文本信息: ${textPart.text}`);
        }
        throw new Error('从 Gemini API 响应中未能提取到图像数据，也没有文本回复。');
    }
    
    return parts;
}

/**
 * 处理API响应，保存图像并格式化最终结果
 * @param {Array<object>} parts - 来自 Gemini API 的 parts 数组
 * @param {object} originalArgs - 原始的工具调用参数
 * @returns {Promise<object>} - 格式化后的成功结果对象
 */
async function processApiResponseAndSaveImage(parts, originalArgs) {
    const textPart = parts.find(p => p.text);
    const imagePart = parts.find(p => p.inlineData);

    // imagePart 已经在 callGeminiApi 中被验证存在
    const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
    const mimeType = imagePart.inlineData.mimeType;
    
    const extension = mimeType.split('/')[1] || 'png';
    const generatedFileName = `${uuidv4()}.${extension}`;
    const imageDir = path.join(PROJECT_BASE_PATH, 'image', 'geminiimagegen');
    const localImagePath = path.join(imageDir, generatedFileName);

    await fs.mkdir(imageDir, { recursive: true });
    await fs.writeFile(localImagePath, imageBuffer);

    const relativePathForUrl = path.join('geminiimagegen', generatedFileName).replace(/\\/g, '/');
    const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`;

    // 优先使用 Gemini 返回的文本，如果没有则使用默认文本
    const modelResponseText = textPart ? textPart.text : "图片已成功处理！";
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
            serverPath: `image/geminiimagegen/${generatedFileName}`,
            fileName: generatedFileName,
            ...originalArgs,
            imageUrl: accessibleImageUrl,
            modelResponseText: textPart ? textPart.text : null
        }
    };
}

// --- 3. 命令处理函数 ---

async function generateImage(args) {
    if (!args.prompt || typeof args.prompt !== 'string') {
        throw new Error("参数错误: 'prompt' 是必需的字符串。");
    }

    // 严格按照官方SDK示例，构建包含完整对话历史的 contents 数组
    const payload = {
        "contents": [
            {
                "role": "user",
                "parts": [{ "text": args.prompt }]
            }
        ],
        "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] }
    };

    const parts = await callGeminiApi(API_ENDPOINT_GENERATE, payload);
    return await processApiResponseAndSaveImage(parts, args);
}

async function editImage(args) {
    if (!args.prompt || typeof args.prompt !== 'string') {
        throw new Error("参数错误: 'prompt' 是必需的字符串。");
    }

    let imageUrls = [];

    // Unico的修改点1: 兼容旧的 'image_url' 单个字符串参数
    if (typeof args.image_url === 'string' && args.image_url.length > 0) {
        imageUrls.push(args.image_url);
    }

    // Unico的修改点2: 检查并收集多个独立的 'image_url_N' 参数
    // 允许最多3个额外的图片URL，因为Gemini模型最佳处理是3张图
    for (let i = 1; i <= 3; i++) {
        const paramName = `image_url_${i}`;
        if (typeof args[paramName] === 'string' && args[paramName].length > 0) {
            imageUrls.push(args[paramName]);
        }
    }

    if (imageUrls.length === 0) {
        throw new Error("参数错误: 至少需要提供一个图片 URL (通过 'image_url' 参数，或 'image_url_1'/'image_url_2'/'image_url_3' 等参数)。");
    }

    // 后续处理逻辑与之前保持一致
    const imageParts = [];
    for (const url of imageUrls) {
        try {
            const { buffer: imgBuffer, mimeType: imgMimeType } = await getImageDataFromUrl(url);
            imageParts.push({
                "inlineData": { "mimeType": imgMimeType, "data": imgBuffer.toString('base64') }
            });
        } catch (error) {
            console.error(`[GeminiImageGen] 警告: 无法处理图片 URL ${url}，跳过。错误: ${error.message}`);
            // 如果某个图片处理失败，选择跳过它，而不是立即报错中断整个任务。
            // 您可以根据需要调整此行为。
        }
    }

    if (imageParts.length === 0) {
        throw new Error("参数错误: 提供的所有图片 URL 都无法处理，无法进行编辑。");
    }

    // 构建 payload，将所有图片部分放在文本提示词之前，符合Gemini文档示例
    const payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    ...imageParts, // 展开所有处理好的图片部分
                    { "text": args.prompt } // 最后是文本提示词
                ]
            }
        ],
        "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] }
    };

    const parts = await callGeminiApi(API_ENDPOINT_GENERATE, payload);
    return await processApiResponseAndSaveImage(parts, args);
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
            default:
                throw new Error(`未知的命令: '${parsedArgs.command}'。请使用 'generate' 或 'edit'。`);
        }
        
        console.log(JSON.stringify({ status: "success", result: resultObject }));

    } catch (e) {
        let detailedError = e.message || "未知的插件错误";
        if (e.response && e.response.data) {
            detailedError += ` - API 响应: ${JSON.stringify(e.response.data)}`;
        }
        const finalErrorMessage = `GeminiImageGen 插件错误: ${detailedError}`;
        console.log(JSON.stringify({ status: "error", error: finalErrorMessage }));
        process.exit(1);
    }
}

main();