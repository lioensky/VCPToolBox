#!/usr/bin/env node

import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const API_KEY = process.env.SENSENOVA_API_KEY;
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY;
const VAR_HTTP_URL = process.env.VarHttpUrl;
const VAR_HTTPS_URL = process.env.VarHttpsUrl;
const USE_PUBLIC_URL = process.env.USE_PUBLIC_URL === 'true' || process.env.USE_PUBLIC_URL === '1';

const API_ENDPOINT = 'https://token.sensenova.cn/v1/images/generations';
const MODEL_NAME = 'sensenova-u1-fast';
const DEFAULT_SIZE = '2752x1536';
const DEFAULT_N = 1;

const ALLOWED_SIZES = new Set([
    '1664x2496',
    '2496x1664',
    '1760x2368',
    '2368x1760',
    '1824x2272',
    '2272x1824',
    '2048x2048',
    '2752x1536',
    '1536x2752',
    '3072x1376',
    '1344x3136'
]);

function normalizeBoolean(value, defaultValue = true) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return defaultValue;
}

function normalizeArgs(rawArgs) {
    if (!rawArgs || typeof rawArgs !== 'object') {
        throw new Error('SenseGen Plugin Error: 输入参数必须是 JSON 对象。');
    }

    const command = rawArgs.command || rawArgs.Command || 'SenseGenerateDocumentImage';
    const prompt = rawArgs.prompt || rawArgs.Prompt;
    const size = rawArgs.size || rawArgs.Size || rawArgs.resolution || rawArgs.Resolution || DEFAULT_SIZE;
    const showBase64 = normalizeBoolean(rawArgs.showbase64 ?? rawArgs.showBase64, true);

    return {
        command,
        prompt,
        size,
        showBase64
    };
}

function validateArgs(args) {
    if (args.command !== 'SenseGenerateDocumentImage') {
        throw new Error(`SenseGen Plugin Error: 不支持的 command: ${args.command}`);
    }

    if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
        throw new Error("SenseGen Plugin Error: 'prompt' 为必填字符串。");
    }

    if (args.prompt.length > 20000) {
        throw new Error("SenseGen Plugin Error: 'prompt' 过长，请控制在模型允许范围内。");
    }

    if (typeof args.size !== 'string' || !ALLOWED_SIZES.has(args.size)) {
        throw new Error(
            `SenseGen Plugin Error: 'size' 非法。仅支持以下固定值：${Array.from(ALLOWED_SIZES).join('、')}`
        );
    }
}

function ensureEnvironment() {
    if (!API_KEY) {
        throw new Error('SenseGen Plugin Error: 缺少 SENSENOVA_API_KEY，请在 config.env 中填写。');
    }
    if (!PROJECT_BASE_PATH) {
        throw new Error('SenseGen Plugin Error: 缺少 PROJECT_BASE_PATH 环境变量。');
    }
    if (!SERVER_PORT) {
        throw new Error('SenseGen Plugin Error: 缺少 SERVER_PORT 环境变量。');
    }
    if (!IMAGESERVER_IMAGE_KEY) {
        throw new Error('SenseGen Plugin Error: 缺少 IMAGESERVER_IMAGE_KEY 环境变量。');
    }
    if (!VAR_HTTP_URL) {
        throw new Error('SenseGen Plugin Error: 缺少 VarHttpUrl 环境变量。');
    }
    if (USE_PUBLIC_URL && !VAR_HTTPS_URL) {
        throw new Error('SenseGen Plugin Error: USE_PUBLIC_URL=true 时必须提供 VarHttpsUrl。');
    }
}

async function requestImageGeneration(args) {
    const payload = {
        model: MODEL_NAME,
        prompt: args.prompt,
        size: args.size,
        n: DEFAULT_N
    };

    const response = await axios.post(API_ENDPOINT, payload, {
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'VCPToolBox-SenseGen/1.0.0'
        },
        timeout: 180000
    });

    const firstItem = response?.data?.data?.[0];
    if (!firstItem || !firstItem.url) {
        throw new Error(`SenseGen Plugin Error: API 未返回图片 URL。响应：${JSON.stringify(response.data)}`);
    }

    return {
        remoteImageUrl: firstItem.url,
        created: response?.data?.created
    };
}

async function downloadImage(imageUrl) {
    const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 120000
    });

    const imageBuffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || 'image/png';

    return {
        imageBuffer,
        mimeType: contentType
    };
}

function getImageExtension(mimeType, imageUrl) {
    const extMap = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif'
    };

    const normalizedMimeType = String(mimeType).split(';')[0].trim().toLowerCase();
    if (extMap[normalizedMimeType]) {
        return extMap[normalizedMimeType];
    }

    const urlExtMatch = String(imageUrl).match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
    if (urlExtMatch?.[1]) {
        return urlExtMatch[1].toLowerCase();
    }

    return 'png';
}

async function saveImageLocally(imageBuffer, extension) {
    const generatedFileName = `${uuidv4()}.${extension}`;
    const imageDir = path.join(PROJECT_BASE_PATH, 'image', 'sensegen');
    const localImagePath = path.join(imageDir, generatedFileName);

    await fs.mkdir(imageDir, { recursive: true });
    await fs.writeFile(localImagePath, imageBuffer);

    return {
        generatedFileName,
        localImagePath,
        serverPath: `image/sensegen/${generatedFileName}`
    };
}

function buildAccessibleImageUrl(fileName) {
    const relativePathForUrl = path.join('sensegen', fileName).replace(/\\/g, '/');
    return USE_PUBLIC_URL
        ? `${VAR_HTTPS_URL}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`
        : `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`;
}

async function generateDocumentImage(rawArgs) {
    ensureEnvironment();

    const args = normalizeArgs(rawArgs);
    validateArgs(args);

    const apiResult = await requestImageGeneration(args);
    const downloaded = await downloadImage(apiResult.remoteImageUrl);
    const imageExtension = getImageExtension(downloaded.mimeType, apiResult.remoteImageUrl);
    const saved = await saveImageLocally(downloaded.imageBuffer, imageExtension);
    const accessibleImageUrl = buildAccessibleImageUrl(saved.generatedFileName);
    const base64Image = downloaded.imageBuffer.toString('base64');

    const imageMimeType = String(downloaded.mimeType).split(';')[0].trim().toLowerCase() || `image/${imageExtension}`;
    const altText = args.prompt
        ? args.prompt.substring(0, 80) + (args.prompt.length > 80 ? '...' : '')
        : (saved.generatedFileName || '生成的图片');
    const imageHtml = `<img src="${accessibleImageUrl}" alt="${altText}" width="300">`;

    const content = [
        {
            type: 'text',
            text:
                `图片已成功生成！\n` +
                `- 提示词: ${args.prompt}\n` +
                `- 分辨率: ${args.size}\n` +
                `- 可访问URL: ${accessibleImageUrl}\n` +
                `请将生成好的图片转发给用户哦。`
        }
    ];

    content.push({
        type: 'image_url',
        image_url: {
            url: `data:${imageMimeType};base64,${base64Image}`
        }
    });

    return {
        content,
        details: {
            serverPath: saved.serverPath,
            fileName: saved.generatedFileName,
            prompt: args.prompt,
            resolution: args.size,
            imageUrl: accessibleImageUrl,
            sourceImageUrl: apiResult.remoteImageUrl,
            model: MODEL_NAME,
            showBase64: args.showBase64,
            created: apiResult.created,
            html: imageHtml
        }
    };
}

async function main() {
    try {
        const inputChunks = [];
        for await (const chunk of process.stdin) {
            inputChunks.push(chunk);
        }

        const inputData = inputChunks.join('');
        if (!inputData.trim()) {
            throw new Error('SenseGen Plugin Error: 未从 stdin 接收到输入数据。');
        }

        const parsedArgs = JSON.parse(inputData);
        const result = await generateDocumentImage(parsedArgs);

        console.log(JSON.stringify({ status: 'success', result }));
    } catch (e) {
        let detailedError = e.message || 'Unknown error';
        if (e.response?.data) {
            detailedError += ` - API Response: ${JSON.stringify(e.response.data)}`;
        } else if (e.request) {
            detailedError += ' - No response received from API.';
        }

        console.log(JSON.stringify({
            status: 'error',
            error: detailedError.startsWith('SenseGen Plugin Error:')
                ? detailedError
                : `SenseGen Plugin Error: ${detailedError}`
        }));
        process.exit(1);
    }
}

main();