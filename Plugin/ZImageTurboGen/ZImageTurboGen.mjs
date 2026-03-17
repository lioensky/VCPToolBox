#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// --- Configuration ---
const API_KEY = process.env.ZIMAGE_API_KEY || "apikey(填自己的密钥)";
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY;
const VAR_HTTP_URL = process.env.VarHttpUrl;

const API_ENDPOINT = 'https://ai.gitee.com/v1/images/generations';

// --- Helper Functions ---

function isValidArgs(args) {
    if (!args || typeof args !== 'object' || !args.command) return false;
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;
    if (args.command !== 'GenerateImage') return false;
    
    if (args.size && !/^\d+[:x]\d+$/.test(args.size)) return false;

    if (args.num_inference_steps !== undefined) {
        const steps = parseInt(args.num_inference_steps, 10);
        if (isNaN(steps) || steps < 4 || steps > 25) return false;
    }
    return true;
}

async function processApiRequest(args) {
    if (!PROJECT_BASE_PATH || !SERVER_PORT || !IMAGESERVER_IMAGE_KEY || !VAR_HTTP_URL) {
        throw new Error("Plugin Error: Missing one or more required environment variables (PROJECT_BASE_PATH, SERVER_PORT, etc).");
    }
    if (!isValidArgs(args)) {
        throw new Error(`Plugin Error: Invalid arguments provided: ${JSON.stringify(args)}.`);
    }

    const payload = {
        model: "Z-Image-Turbo",
        prompt: args.prompt,
        n: 1,
    };

    // --- Size Optimization Logic ---
    const allowedSizes = [
        { w: 1024, h: 1024, str: '1024x1024' },
        { w: 1024, h: 768, str: '1024x768' },
        { w: 768, h: 1024, str: '768x1024' },
        { w: 1024, h: 576, str: '1024x576' },
        { w: 576, h: 1024, str: '576x1024' },
        { w: 1024, h: 640, str: '1024x640' },
        { w: 640, h: 1024, str: '640x1024' },
        { w: 512, h: 512, str: '512x512' }
    ];

    if (args.size) {
        const [inputW, inputH] = args.size.split(/[:x]/).map(Number);
        const inputRatio = inputW / inputH;
        
        // Find the size with the closest aspect ratio
        let bestMatch = allowedSizes[0];
        let minDiff = Math.abs((bestMatch.w / bestMatch.h) - inputRatio);

        for (let i = 1; i < allowedSizes.length; i++) {
            const ratio = allowedSizes[i].w / allowedSizes[i].h;
            const diff = Math.abs(ratio - inputRatio);
            if (diff < minDiff) {
                minDiff = diff;
                bestMatch = allowedSizes[i];
            }
        }
        payload.size = bestMatch.str;
    } else {
        payload.size = '1024x1024';
    }

    if (args.negative_prompt && typeof args.negative_prompt === 'string' && args.negative_prompt.trim()) {
        payload.negative_prompt = args.negative_prompt.trim();
    }

    const steps = args.num_inference_steps !== undefined
        ? Math.max(4, Math.min(25, parseInt(args.num_inference_steps, 10) || 8))
        : 8;
    payload.num_inference_steps = steps;

    // Use native fetch (available in Node 18+)
    const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`API request failed with status ${response.status}: ${errorBody}`);
    }

    const responseJson = await response.json();

    // Gitee API returns data in format: { data: [{ b64_json: "...", type: "image/png" }], created: ... }
    // Also support url-based responses for future compatibility
    const responseData = responseJson?.data?.[0] || responseJson?.images?.[0];
    if (!responseData) {
        throw new Error("Plugin Error: No image data in API response. Response: " + JSON.stringify(responseJson));
    }

    let imageBuffer;
    let imageMimeType;

    if (responseData.b64_json) {
        // API returned base64 encoded image directly
        imageBuffer = Buffer.from(responseData.b64_json, 'base64');
        imageMimeType = responseData.type || 'image/png';
    } else if (responseData.url) {
        // API returned a URL to download
        const imageResponse = await fetch(responseData.url, {
            signal: AbortSignal.timeout(60000),
        });
        if (!imageResponse.ok) {
            throw new Error(`Failed to download image from URL: ${responseData.url}`);
        }
        const arrayBuf = await imageResponse.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuf);
        imageMimeType = imageResponse.headers.get('content-type') || 'image/png';
    } else {
        throw new Error("Plugin Error: API response contains neither b64_json nor url. Response: " + JSON.stringify(responseJson));
    }

    // Determine file extension from mime type
    const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
    const imageExtension = extMap[imageMimeType] || 'png';

    const generatedFileName = `${uuidv4()}.${imageExtension}`;
    const imageDir = path.join(PROJECT_BASE_PATH, 'image', 'zimageturbogen');
    const localImagePath = path.join(imageDir, generatedFileName);

    await fs.mkdir(imageDir, { recursive: true });
    await fs.writeFile(localImagePath, imageBuffer);

    const relativePathForUrl = path.join('zimageturbogen', generatedFileName).replace(/\\/g, '/');
    const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`;

    const base64Image = imageBuffer.toString('base64');

    return {
        content: [
            {
                type: 'text',
                text: `图片已成功生成！\n- 提示词: ${args.prompt}${args.negative_prompt ? `\n- 负面提示词: ${args.negative_prompt}` : ''}\n- 推理步数: ${payload.num_inference_steps}\n- 可访问URL: ${accessibleImageUrl}\n\n【重要】请将上面生成的图片Url转发给用户查看，不要只描述图片内容。`
            },
            {
                type: 'image_url',
                image_url: {
                    url: `data:${imageMimeType};base64,${base64Image}`
                }
            }
        ],
        details: {
            url: accessibleImageUrl
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
            throw new Error("No input data received from stdin.");
        }
        const parsedArgs = JSON.parse(inputData);
        const result = await processApiRequest(parsedArgs);
        console.log(JSON.stringify({ status: "success", result }));
    } catch (e) {
        let detailedError = e.message || "Unknown error";
        if (e.response && e.response.data) {
            detailedError += ` - API Response: ${JSON.stringify(e.response.data)}`;
        }
        console.log(JSON.stringify({ status: "error", error: `ZImageTurboGen Plugin Error: ${detailedError}` }));
        process.exit(1);
    }
}

main();