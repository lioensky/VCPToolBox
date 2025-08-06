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
    PROJECT_BASE_PATH,
    SERVER_PORT,
    IMAGESERVER_IMAGE_KEY,
    VAR_HTTP_URL
} = (() => {
    const keys = (process.env.GeminiImageKey || '').split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) {
        console.warn("[GeminiImageGen] 警告: config.env 中未配置 GeminiImageKey。API 调用将会失败。");
    }

    const proxyUrl = process.env.GeminiImageProxy;
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
    if (agent) {
        console.log(`[GeminiImageGen] 使用代理: ${proxyUrl}`);
    }

    return {
        GEMINI_API_KEYS: keys,
        PROXY_AGENT: agent,
        PROJECT_BASE_PATH: process.env.PROJECT_BASE_PATH,
        SERVER_PORT: process.env.SERVER_PORT,
        IMAGESERVER_IMAGE_KEY: process.env.IMAGESERVER_IMAGE_KEY,
        VAR_HTTP_URL: process.env.VarHttpUrl
    };
})();

const API_BASE_URL = 'https://generativelanguage.googleapis.com';
const API_ENDPOINT = '/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent';

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
        if (!match) {
            throw new Error('无效的 data URI 格式。');
        }
        return {
            buffer: Buffer.from(match[2], 'base64'),
            mimeType: match[1]
        };
    } else if (url.startsWith('http')) {
        const response = await axios.get(url, { responseType: 'arraybuffer', httpsAgent: PROXY_AGENT });
        return {
            buffer: response.data,
            mimeType: response.headers['content-type'] || 'image/jpeg'
        };
    } else {
        throw new Error('不支持的 URL 协议。请使用 http, https, 或 data URI。');
    }
}

/**
 * 调用 Gemini API 并返回所有响应部分
 * @param {object} payload - 发送给 API 的请求体
 * @returns {Promise<Array<object>>} - 包含 text 和 inline_data 的 parts 数组
 */
async function callGeminiApi(payload) {
    const apiKey = getRandomApiKey();
    const fullApiUrl = `${API_BASE_URL}${API_ENDPOINT}?key=${apiKey}`;

    const response = await axios.post(fullApiUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        httpsAgent: PROXY_AGENT,
        timeout: 180000 // 3分钟超时
    });
    
    const parts = response.data?.contents?.[0]?.parts;
    if (!parts || !Array.isArray(parts) || parts.length === 0) {
        throw new Error('从 Gemini API 响应中未能提取到任何内容部分。');
    }
    
    const imagePart = parts.find(p => p.inline_data);
    if (!imagePart) {
        // 如果API只返回了文本（例如，拒绝生成图片），我们也需要处理
        const textPart = parts.find(p => p.text);
        if (textPart) {
             throw new Error(`API 未能生成图片，但返回了文本信息: ${textPart.text}`);
        }
        throw new Error('从 Gemini API 响应中未能提取到图像数据，也没有文本回复。');
    }
    
    return parts; // 返回完整的 parts 数组
}

/**
 * 处理API响应，保存图像并格式化最终结果
 * @param {Array<object>} parts - 来自 Gemini API 的 parts 数组
 * @param {object} originalArgs - 原始的工具调用参数
 * @returns {Promise<object>} - 格式化后的成功结果对象
 */
async function processApiResponseAndSaveImage(parts, originalArgs) {
    const textPart = parts.find(p => p.text);
    const imagePart = parts.find(p => p.inline_data);

    // imagePart 已经在 callGeminiApi 中被验证存在
    const imageBuffer = Buffer.from(imagePart.inline_data.data, 'base64');
    const mimeType = imagePart.inline_data.mime_type;
    
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
    const finalResponseText = `${modelResponseText}\n\n**图片详情:**\n- 提示词: ${originalArgs.prompt}\n- 可访问URL: ${accessibleImageUrl}`;

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

    const payload = {
        "contents": [{
            "parts": [{ "text": args.prompt }]
        }],
        "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] }
    };

    const parts = await callGeminiApi(payload);
    return await processApiResponseAndSaveImage(parts, args);
}

async function editImage(args) {
    if (!args.prompt || typeof args.prompt !== 'string') {
        throw new Error("参数错误: 'prompt' 是必需的字符串。");
    }
    if (!args.image_url || typeof args.image_url !== 'string') {
        throw new Error("参数错误: 'image_url' 是必需的字符串。");
    }

    const { buffer: imageBuffer, mimeType } = await getImageDataFromUrl(args.image_url);
    const imageBase64 = imageBuffer.toString('base64');

    const payload = {
        "contents": [{
            "parts": [
                { "text": args.prompt },
                { "inline_data": { "mime_type": mimeType, "data": imageBase64 } }
            ]
        }],
        "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] }
    };

    const parts = await callGeminiApi(payload);
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