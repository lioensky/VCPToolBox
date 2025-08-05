#!/usr/bin/env node
import axios from "axios";
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid'; // For generating unique filenames

// --- Configuration (from environment variables set by Plugin.js) ---
const A4F_API_KEY = process.env.a4fkey;
const A4F_BASE_URL = process.env.a4furl;
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY; // Key for our own image server
const VAR_HTTP_URL = process.env.VarHttpUrl; // Read VarHttpUrl from env
const VAR_HTTPS_URL = process.env.VarHttpsUrl; // Read VarHttps Url from env

// API specific configurations
const A4F_API_CONFIG = {
    IMAGE_GENERATION_ENDPOINT: '/v1/images/generations',
    DEFAULT_PARAMS: {
        n: 1,
    }
};

const QWEN_ASPECT_RATIOS = {
    "1:1": "1328x1328",
    "16:9": "1664x928",
    "9:16": "928x1664",
    "4:3": "1472x1140",
    "3:4": "1140x1472"
};

const IMAGEN4_ASPECT_RATIOS = {
    "1:1": "1024x1024",
    "3:4": "896x1280",
    "4:3": "1280x896",
    "9:16": "768x1408",
    "16:9": "1408x768"
};


// Helper to validate input arguments
function isValidA4FGenArgs(args) {
    if (!args || typeof args !== 'object') return false;
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;
    if (typeof args.command !== 'string' || !args.command.trim()) return false; // Expect command

    if (typeof args.resolution !== 'string') return false;

    if (args.command === 'QwenGen') {
        if (!Object.values(QWEN_ASPECT_RATIOS).includes(args.resolution)) return false;
    } else if (args.command === 'Imagen4Gen') {
        if (!Object.values(IMAGEN4_ASPECT_RATIOS).includes(args.resolution)) return false;
    } else {
        return false; // Unknown command
    }

    return true;
}

// --- Assuming Bearer Token Authentication ---
async function signRequest() {
    if (!A4F_API_KEY) {
        console.warn("[A4FImageGen Plugin] WARN: a4fkey in config.env is not set. Authentication will likely fail.");
    }
    return {
        'Authorization': `Bearer ${A4F_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
}


async function generateImageAndSave(args) {
    // Check for essential environment variables
    if (!A4F_API_KEY || !A4F_BASE_URL) {
        throw new Error("A4FImageGen Plugin Error: a4fkey and a4furl in config.env are required.");
    }
    if (!PROJECT_BASE_PATH || !SERVER_PORT || !IMAGESERVER_IMAGE_KEY || !VAR_HTTP_URL) {
        throw new Error("A4FImageGen Plugin Error: Core environment variables (PROJECT_BASE_PATH, SERVER_PORT, etc.) are missing.");
    }

    if (!isValidA4FGenArgs(args)) {
        throw new Error(`A4FImageGen Plugin Error: Invalid arguments received: ${JSON.stringify(args)}.`);
    }

    let model;
    if (args.command === 'QwenGen') {
        model = 'provider-6/qwen-image';
    } else if (args.command === 'Imagen4Gen') {
        model = 'provider-4/imagen-4';
    }

    const payload = {
        model: model,
        prompt: args.prompt,
        n: A4F_API_CONFIG.DEFAULT_PARAMS.n,
        size: args.resolution,
    };

    const headers = await signRequest();

    const apiAxiosInstance = axios.create({
        baseURL: A4F_BASE_URL,
        headers: headers,
        timeout: 120000 // 120 second timeout
    });
    
    const fullApiUrl = A4F_API_CONFIG.IMAGE_GENERATION_ENDPOINT;

    const response = await apiAxiosInstance.post(
        fullApiUrl,
        payload
    );

    let generatedImageUrlOrBase64;
    const responseData = response.data?.data?.[0];

    if (responseData?.url) {
        generatedImageUrlOrBase64 = responseData.url;
    } else if (responseData?.b64_json) {
        generatedImageUrlOrBase64 = responseData.b64_json;
    }

    if (!generatedImageUrlOrBase64) {
        throw new Error("A4FImageGen Plugin Error: Failed to extract image data/URL from API response. Response: " + JSON.stringify(response.data));
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
            imageExtension = contentType.split('/')[1];
        } else {
            const urlExtMatch = generatedImageUrlOrBase64.match(/\.([^.?]+)(?:[?#]|$)/);
            if (urlExtMatch && urlExtMatch[1]) {
                imageExtension = urlExtMatch[1];
            }
        }
    } else {
        imageBuffer = Buffer.from(generatedImageUrlOrBase64, 'base64');
    }
    
    const generatedFileName = `${uuidv4()}.${imageExtension}`;
    const imageDir = path.join(PROJECT_BASE_PATH, 'image', 'a4fgen');
    const localImageServerPath = path.join(imageDir, generatedFileName);

    await fs.mkdir(imageDir, { recursive: true });
    await fs.writeFile(localImageServerPath, imageBuffer);

    const relativeServerPathForUrl = path.join('a4fgen', generatedFileName).replace(/\\\\/g, '/');
    const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;

    const base64Image = imageBuffer.toString('base64');
    const imageMimeType = `image/${imageExtension}`;

    const result = {
        content: [
            {
                type: 'text',
                text: `图片已成功生成！\n- 模型: ${payload.model}\n- 提示词: ${args.prompt}\n- 分辨率: ${args.resolution}\n- 可访问URL: ${accessibleImageUrl}\n请将生成好的图片转发给用户哦。`
            },
            {
                type: 'image_url',
                image_url: {
                    url: `data:${imageMimeType};base64,${base64Image}`
                }
            }
        ],
        details: {
            serverPath: `image/a4fgen/${generatedFileName}`,
            fileName: generatedFileName,
            prompt: args.prompt,
            resolution: args.resolution,
            model: payload.model,
            imageUrl: accessibleImageUrl
        }
    };

    return result;
}

async function main() {
    let inputChunks = [];
    process.stdin.setEncoding('utf8');

    for await (const chunk of process.stdin) {
        inputChunks.push(chunk);
    }
    const inputData = inputChunks.join('');
    let parsedArgs;

    try {
        if (!inputData.trim()) {
            console.log(JSON.stringify({ status: "error", error: "A4FImageGen Plugin Error: No input data received from stdin." }));
            process.exit(1);
            return;
        }
        parsedArgs = JSON.parse(inputData);
        const resultObject = await generateImageAndSave(parsedArgs);
        console.log(JSON.stringify({ status: "success", result: resultObject }));
    } catch (e) {
        let detailedError = e.message || "Unknown error in A4FImageGen plugin";
        if (e.response && e.response.data) {
            detailedError += ` - API Response: ${JSON.stringify(e.response.data)}`;
        } else if (e.request) {
            detailedError += ` - No response received from API.`;
        }
        const finalErrorMessage = detailedError.startsWith("A4FImageGen Plugin Error:") ? detailedError : `A4FImageGen Plugin Error: ${detailedError}`;
        console.log(JSON.stringify({ status: "error", error: finalErrorMessage }));
        process.exit(1);
    }
}

main();