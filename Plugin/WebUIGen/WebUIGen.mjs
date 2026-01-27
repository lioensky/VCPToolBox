#!/usr/bin/env node

import { fetch, ProxyAgent, setGlobalDispatcher } from 'undici';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// --- 1. 配置加载与初始化 ---

const {
    PROJECT_BASE_PATH,
    SERVER_PORT,
    IMAGESERVER_IMAGE_KEY,
    VAR_HTTP_URL,
    WEBUI_API_KEY,
    HTTPS_PROXY
} = (() => {
    return {
        PROJECT_BASE_PATH: process.env.PROJECT_BASE_PATH || '.',
        SERVER_PORT: process.env.SERVER_PORT || '3000',
        IMAGESERVER_IMAGE_KEY: process.env.IMAGESERVER_IMAGE_KEY || 'default_key',
        VAR_HTTP_URL: process.env.VarHttpUrl || 'http://localhost',
        WEBUI_API_KEY: process.env.WEBUI_API_KEY,
        HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    };
})();

// 配置全局代理
if (HTTPS_PROXY) {
    const proxyAgent = new ProxyAgent(HTTPS_PROXY);
    setGlobalDispatcher(proxyAgent);
}

const API_URL = 'https://sd.exacg.cc/api/v1/generate_image';

// --- 2. 核心功能函数 ---

/**
 * 解析分辨率字符串为宽高
 * @param {string} resolution - 分辨率字符串，如 "512x512", "landscape", "portrait"
 * @returns {{width: number, height: number}}
 */
function parseResolution(resolution) {
    if (!resolution) return { width: 512, height: 512 };
    
    const res = resolution.toLowerCase().trim();
    
    // 预设比例
    const presets = {
        'square': { width: 512, height: 512 },
        'landscape': { width: 768, height: 512 },
        'portrait': { width: 512, height: 768 },
        '1024': { width: 1024, height: 1024 }
    };
    
    if (presets[res]) return presets[res];
    
    // 解析 WxH 格式
    const match = res.match(/(\d+)\s*[x×]\s*(\d+)/i);
    if (match) {
        return { width: parseInt(match[1]), height: parseInt(match[2]) };
    }
    
    return { width: 512, height: 512 };
}

/**
 * 调用 WebUI API 生成图像
 * @param {object} args - 生成参数
 * @returns {Promise<object>} - API 响应数据
 */
async function callWebUIAPI(args) {
    if (!WEBUI_API_KEY || WEBUI_API_KEY === 'YOUR_API_KEY_HERE') {
        throw new Error("未配置有效的 WEBUI_API_KEY，请在 config.env 中设置。");
    }

    const { width, height } = parseResolution(args.resolution || args.size);
    
    const payload = {
        prompt: args.prompt,
        negative_prompt: args.negative_prompt || args.negativePrompt || "",
        width: width,
        height: height,
        steps: parseInt(args.steps) || 20,
        cfg: parseFloat(args.cfg) || 7.0,
        model_index: parseInt(args.model_index) || parseInt(args.modelIndex) || 0,
        seed: parseInt(args.seed) || -1
    };

    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${WEBUI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    const contentType = response.headers.get('content-type');
    
    if (contentType && contentType.includes('application/json')) {
        const result = await response.json();
        
        if (response.ok && result.success) {
            return result.data;
        } else {
            throw new Error(result.error || result.message || "未知 API 错误");
        }
    } else {
        const text = await response.text();
        throw new Error(`API 返回非 JSON 响应 (${response.status}): ${text.substring(0, 200)}`);
    }
}

/**
 * 下载并保存图像
 * @param {string} imageUrl - 图像下载 URL
 * @returns {Promise<object>} - 本地文件信息
 */
async function saveImage(imageUrl) {
    const response = await fetch(imageUrl);
    
    if (!response.ok) {
        throw new Error(`下载图片失败: ${response.status} ${response.statusText}`);
    }
    
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get('content-type') || 'image/jpeg';
    const extension = mimeType.split('/')[1]?.split(';')[0] || 'jpg';
    
    const generatedFileName = `${uuidv4()}.${extension}`;
    const imageDir = path.join(PROJECT_BASE_PATH, 'image', 'webuigen');
    const localImagePath = path.join(imageDir, generatedFileName);

    await fs.mkdir(imageDir, { recursive: true });
    await fs.writeFile(localImagePath, buffer);

    const relativePathForUrl = path.join('webuigen', generatedFileName).replace(/\\/g, '/');
    const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`;

    return {
        serverPath: `image/webuigen/${generatedFileName}`,
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

    // 1. 调用 API 生成
    const apiResult = await callWebUIAPI(args);

    // 2. 下载并保存
    const savedImage = await saveImage(apiResult.image_url);

    // 3. 构造返回结果
    const { width, height } = parseResolution(args.resolution);
    const finalResponseText = `图片已成功生成！\n\n**图片详情:**\n- 模型: ${apiResult.model_name}\n- 分辨率: ${width}x${height}\n- 消耗点数: ${apiResult.points_used}\n- 剩余点数: ${apiResult.remaining_points}\n- 可访问URL: ${savedImage.imageUrl}\n\n请利用可访问url将图片转发给用户`;

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
            ...apiResult,
            prompt: args.prompt,
            showBase64: showBase64
        }
    };
}

async function main() {
    let inputData = '';
    
    // 设置全局超时
    const timeout = setTimeout(() => {
        console.log(JSON.stringify({ status: "error", error: "WebUIGen 插件执行超时 (3分钟)" }));
        process.exit(1);
    }, 180000);

    try {
        for await (const chunk of process.stdin) {
            inputData += chunk;
        }

        if (!inputData.trim()) {
            throw new Error("未从 stdin 接收到任何输入数据。");
        }
        
        const parsedArgs = JSON.parse(inputData);
        let resultObject;

        const command = parsedArgs.command || (parsedArgs.prompt ? 'generate' : undefined);
        
        if (command === 'generate' || command === 'WebUIGenerate') {
            resultObject = await generateImage(parsedArgs);
        } else {
            throw new Error(`未知的命令: '${command}'`);
        }

        console.log(JSON.stringify({ status: "success", result: resultObject }));
        clearTimeout(timeout);

    } catch (e) {
        console.log(JSON.stringify({ status: "error", error: `WebUIGen 插件错误: ${e.message}` }));
        process.exit(1);
    }
}

main();