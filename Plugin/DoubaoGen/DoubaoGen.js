#!/usr/bin/env node
import axios from "axios";
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

// --- Configuration (from environment variables set by Plugin.js) ---
const VOLCENGINE_API_KEY = process.env.VOLCENGINE_API_KEY;
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY;
const VAR_HTTP_URL = process.env.VarHttpUrl;
const VAR_HTTPS_URL = process.env.VarHttpsUrl;
const DEBUG_MODE = (process.env.DebugMode || "false").toLowerCase() === "true";

// --- Debug Logging (to stderr, never pollutes stdout JSON) ---
function debugLog(message, ...args) {
    if (DEBUG_MODE) {
        console.error(`[DoubaoGen][Debug] ${message}`, ...args);
    }
}

// VolcEngine API specific configurations for Seedream 3 (V3 OpenAI-compatible style)
const VOLCENGINE_API_CONFIG = {
    BASE_URL: 'https://ark.cn-beijing.volces.com',
    IMAGE_GENERATION_ENDPOINT: '/api/v3/images/generations',
    MODEL_ID: "doubao-seedream-3-0-t2i-250415",
    DEFAULT_PARAMS: {
        n: 1,
        guidance_scale: 2.5,
        watermark: false
    }
};

const VALID_RESOLUTIONS = [
    '1024x1024', '864x1152', '1152x864',
    '1280x720', '720x1280', '832x1248',
    '1248x832', '1512x648'
];
const DEFAULT_RESOLUTION = '1024x1024';

// --- Helper: HTML 特殊字符转义 ---
function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// --- Helper: 路径安全验证 ---
function isPathWithinBase(targetPath, basePath) {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedBase = path.resolve(basePath);
    return resolvedTarget === resolvedBase ||
        resolvedTarget.startsWith(resolvedBase + path.sep);
}

// --- Helper: 输出结果并退出 ---
function outputAndExit(result) {
    const exitCode = result.status === "success" ? 0 : 1;
    process.stdout.write(JSON.stringify(result), () => {
        process.exit(exitCode);
    });
}

// Helper to validate input arguments
function isValidDoubaoGenArgs(args) {
    if (!args || typeof args !== 'object') return false;
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;

    if (args.resolution !== undefined && !VALID_RESOLUTIONS.includes(args.resolution)) {
        debugLog(`Invalid resolution "${args.resolution}", valid: ${VALID_RESOLUTIONS.join(', ')}`);
        return false;
    }

    if (args.seed !== undefined && (typeof args.seed !== 'number' || !Number.isInteger(args.seed) || args.seed < 0)) return false;
    if (args.guidance_scale !== undefined && (typeof args.guidance_scale !== 'number' || args.guidance_scale < 1 || args.guidance_scale > 10)) return false;
    if (args.watermark !== undefined && typeof args.watermark !== 'boolean') return false;
    return true;
}

function getAuthHeaders() {
    if (!VOLCENGINE_API_KEY) {
        throw new Error("VOLCENGINE_API_KEY is not set.");
    }
    return {
        'Authorization': `Bearer ${VOLCENGINE_API_KEY}`,
        'Content-Type': 'application/json'
    };
}


async function generateImageAndSave(args) {
    if (!VOLCENGINE_API_KEY) {
        throw new Error("VOLCENGINE_API_KEY environment variable is required.");
    }
    if (!PROJECT_BASE_PATH) {
        throw new Error("PROJECT_BASE_PATH environment variable is required for saving images.");
    }
    if (!SERVER_PORT) {
        throw new Error("SERVER_PORT environment variable is required for constructing image URL.");
    }
    if (!IMAGESERVER_IMAGE_KEY) {
        throw new Error("IMAGESERVER_IMAGE_KEY environment variable is required for constructing image URL.");
    }
    if (!VAR_HTTP_URL) {
        throw new Error("VarHttpUrl environment variable is required for constructing image URL.");
    }

    if (!isValidDoubaoGenArgs(args)) {
        throw new Error(
            `Invalid arguments: ${JSON.stringify(args)}. ` +
            `Required: prompt (string). Optional: resolution (${VALID_RESOLUTIONS.join('|')}, default ${DEFAULT_RESOLUTION}), ` +
            `seed (integer >= 0), guidance_scale (1-10), watermark (boolean).`
        );
    }

    const resolution = args.resolution || DEFAULT_RESOLUTION;
    debugLog(`Using resolution: ${resolution}`);

    const payload = {
        model: VOLCENGINE_API_CONFIG.MODEL_ID,
        prompt: args.prompt,
        n: VOLCENGINE_API_CONFIG.DEFAULT_PARAMS.n,
        size: resolution,
        guidance_scale: args.guidance_scale ?? VOLCENGINE_API_CONFIG.DEFAULT_PARAMS.guidance_scale,
        watermark: args.watermark ?? VOLCENGINE_API_CONFIG.DEFAULT_PARAMS.watermark
    };
    if (args.seed !== undefined) {
        payload.seed = args.seed;
    }

    debugLog(`Sending payload to VolcEngine: ${JSON.stringify(payload)}`);

    const headers = getAuthHeaders();
    const volcengineAxiosInstance = axios.create({
        baseURL: VOLCENGINE_API_CONFIG.BASE_URL,
        headers: headers,
        timeout: 120000
    });

    const response = await volcengineAxiosInstance.post(
        VOLCENGINE_API_CONFIG.IMAGE_GENERATION_ENDPOINT,
        payload
    );

    debugLog(`Received response from VolcEngine: ${JSON.stringify(response.data)}`);

    let generatedImageUrlOrBase64;
    const responseData = response.data?.data?.[0];

    if (responseData?.url) {
        generatedImageUrlOrBase64 = responseData.url;
    } else if (responseData?.b64_json) {
        generatedImageUrlOrBase64 = responseData.b64_json;
    }

    if (!generatedImageUrlOrBase64) {
        throw new Error("Failed to extract image data/URL from VolcEngine API response. Response: " + JSON.stringify(response.data));
    }

    let imageBuffer;
    let imageExtension = 'png';

    if (generatedImageUrlOrBase64.startsWith('http')) {
        const imageResponse = await axios({
            method: 'get',
            url: generatedImageUrlOrBase64,
            responseType: 'arraybuffer',
            timeout: 60000
        });
        imageBuffer = imageResponse.data;
        const contentType = imageResponse.headers['content-type'];
        if (contentType && contentType.startsWith('image/')) {
            imageExtension = contentType.split('/')[1].split(';')[0].trim();
        } else {
            const urlExtMatch = generatedImageUrlOrBase64.match(/\.([^.?]+)(?:[?#]|$)/);
            if (urlExtMatch && urlExtMatch[1]) {
                imageExtension = urlExtMatch[1];
            }
        }
    } else {
        imageBuffer = Buffer.from(generatedImageUrlOrBase64, 'base64');
    }

    const generatedFileName = `${crypto.randomUUID()}.${imageExtension}`;
    const doubaoGenImageDir = path.join(PROJECT_BASE_PATH, 'image', 'doubaogen');
    const localImageServerPath = path.join(doubaoGenImageDir, generatedFileName);

    if (!isPathWithinBase(localImageServerPath, PROJECT_BASE_PATH)) {
        throw new Error("Security error: image save path escapes PROJECT_BASE_PATH.");
    }

    await fs.mkdir(doubaoGenImageDir, { recursive: true });
    await fs.writeFile(localImageServerPath, imageBuffer);
    debugLog(`Image saved to: ${localImageServerPath}`);

    const relativeServerPathForUrl = path.join('doubaogen', generatedFileName).replace(/\\/g, '/');
    const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;
    // const accessibleImageUrl = `${VAR_HTTPS_URL}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;

    const altText = escapeHtml(
        args.prompt ? args.prompt.substring(0, 80) + (args.prompt.length > 80 ? "..." : "") : (generatedFileName || "生成的图片")
    );
    const successMessage =
        `图片已成功生成！\n\n` +
        `详细信息：\n` +
        `- 图片URL: ${accessibleImageUrl}\n` +
        `- 服务器路径: image/doubaogen/${generatedFileName}\n` +
        `- 文件名: ${generatedFileName}\n\n` +
        `请务必使用以下HTML <img> 标签将图片直接展示给用户 (您可以调整width属性，建议200-500像素)：\n` +
        `<img src="${accessibleImageUrl}" alt="${altText}" width="300">\n`;

    return successMessage;
}

async function main() {
    let inputChunks = [];
    process.stdin.setEncoding('utf8');

    for await (const chunk of process.stdin) {
        inputChunks.push(chunk);
    }
    const inputData = inputChunks.join('');

    try {
        if (!inputData.trim()) {
            outputAndExit({ status: "error", error: "DoubaoGen Plugin Error: No input data received from stdin." });
            return;
        }
        const parsedArgs = JSON.parse(inputData);
        debugLog('Received args:', JSON.stringify(parsedArgs));
        const formattedResultString = await generateImageAndSave(parsedArgs);
        outputAndExit({ status: "success", result: formattedResultString });
    } catch (e) {
        let detailedError = e.message || "Unknown error in DoubaoGen plugin";
        if (e.response && e.response.data) {
            detailedError += ` - API Response: ${JSON.stringify(e.response.data)}`;
        }
        console.error(`[DoubaoGen] Error: ${detailedError}`);
        outputAndExit({ status: "error", error: `DoubaoGen Plugin Error: ${detailedError}` });
    }
}

main();
