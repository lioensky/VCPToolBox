#!/usr/bin/env node
import axios from "axios";
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import mime from 'mime-types';

// --- Configuration ---
const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY;
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY;
const VAR_HTTP_URL = process.env.VarHttpUrl;

const API_CONFIG = {
    BASE_URL: 'https://api.siliconflow.cn/v1',
    ENDPOINT: '/images/generations',
    MODELS: {
        GENERATE: 'Qwen/Qwen-Image',
        EDIT: 'Qwen/Qwen-Image-Edit-2509'
    }
};

// --- Helper Functions ---

function isValidArgs(args) {
    if (!args || typeof args !== 'object' || !args.command) return false;
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;

    switch (args.command) {
        case 'GenerateImage':
            if (args.image_size && !/^\d+x\d+$/.test(args.image_size)) return false;
            if (args.cfg && (typeof args.cfg !== 'number' || args.cfg < 0.1 || args.cfg > 20)) return false;
            break;
        case 'EditImage':
            if (typeof args.image !== 'string' || !args.image.trim()) return false;
            break;
        default:
            return false;
    }
    if (args.seed !== undefined && (typeof args.seed !== 'number' || !Number.isInteger(args.seed))) return false;
    if (args.num_inference_steps !== undefined && (typeof args.num_inference_steps !== 'number' || !Number.isInteger(args.num_inference_steps) || args.num_inference_steps < 1 || args.num_inference_steps > 100)) return false;

    return true;
}

async function getImageData(imageUrl, imageBase64) {
    if (imageBase64) {
        return imageBase64;
    }
    if (!imageUrl) {
        return null;
    }

    if (imageUrl.startsWith('data:image/')) {
        return imageUrl;
    }

    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        return imageUrl;
    }

    if (imageUrl.startsWith('file://')) {
        const filePath = fileURLToPath(imageUrl);
        try {
            const buffer = await fs.readFile(filePath);
            const mimeType = mime.lookup(filePath) || 'application/octet-stream';
            if (buffer.length > 10 * 1024 * 1024) {
                throw new Error("Image size exceeds the 10MB limit.");
            }
            const base64Image = buffer.toString('base64');
            return `data:${mimeType};base64,${base64Image}`;
        } catch (e) {
            if (e.code === 'ENOENT') {
                const structuredError = new Error(`File not found locally, requesting remote fetch for: ${imageUrl}`);
                structuredError.code = 'FILE_NOT_FOUND_LOCALLY';
                structuredError.fileUrl = imageUrl;
                throw structuredError;
            } else {
                throw new Error(`Error reading local file: ${e.message}`);
            }
        }
    }
    throw new Error(`Unsupported image format or protocol. Please use an https:// or file:// URL.`);
}

async function processApiRequest(args) {
    if (!SILICONFLOW_API_KEY || !PROJECT_BASE_PATH || !SERVER_PORT || !IMAGESERVER_IMAGE_KEY || !VAR_HTTP_URL) {
        throw new Error("QwenImageGen Plugin Error: Missing one or more required environment variables.");
    }
    if (!isValidArgs(args)) {
        throw new Error(`QwenImageGen Plugin Error: Invalid arguments provided: ${JSON.stringify(args)}.`);
    }

    const payload = {
        prompt: args.prompt,
        model: args.command === 'GenerateImage' ? API_CONFIG.MODELS.GENERATE : API_CONFIG.MODELS.EDIT,
    };

    // Add optional parameters
    if (args.negative_prompt) payload.negative_prompt = args.negative_prompt;
    if (args.seed) payload.seed = args.seed;
    if (args.num_inference_steps) payload.num_inference_steps = args.num_inference_steps;

    // Command-specific parameters
    if (args.command === 'GenerateImage') {
        if (args.image_size) payload.image_size = args.image_size;
        if (args.cfg) payload.cfg = args.cfg;
    } else if (args.command === 'EditImage') {
        payload.image = await getImageData(args.image, args.image_base64);
        if (args.image2) payload.image2 = await getImageData(args.image2, args.image_base64_2);
        if (args.image3) payload.image3 = await getImageData(args.image3, args.image_base64_3);
    }

    const headers = {
        'Authorization': `Bearer ${SILICONFLOW_API_KEY}`,
        'Content-Type': 'application/json',
    };

    const response = await axios.post(
        `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINT}`,
        payload,
        { headers, timeout: 120000 }
    );

    const responseData = response.data?.images?.[0];
    if (!responseData || !responseData.url) {
        throw new Error("QwenImageGen Plugin Error: Failed to extract image URL from API response. Response: " + JSON.stringify(response.data));
    }

    const generatedImageUrl = responseData.url;
    const imageResponse = await axios.get(generatedImageUrl, { responseType: 'arraybuffer', timeout: 60000 });
    const imageBuffer = imageResponse.data;
    const contentType = imageResponse.headers['content-type'];
    const imageExtension = mime.extension(contentType) || 'png';

    const generatedFileName = `${uuidv4()}.${imageExtension}`;
    const imageDir = path.join(PROJECT_BASE_PATH, 'image', 'qwenimagegen');
    const localImagePath = path.join(imageDir, generatedFileName);

    await fs.mkdir(imageDir, { recursive: true });
    await fs.writeFile(localImagePath, imageBuffer);

    const relativePathForUrl = path.join('qwenimagegen', generatedFileName).replace(/\\/g, '/');
    const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`;
    
    const base64Image = imageBuffer.toString('base64');
    const imageMimeType = `image/${imageExtension}`;

    return {
        content: [
            {
                type: 'text',
                text: `图片已成功生成！\n- 提示词: ${args.prompt}\n- Seed: ${response.data.seed || 'N/A'}\n- 可访问URL: ${accessibleImageUrl}`
            },
            {
                type: 'image_url',
                image_url: {
                    url: `data:${imageMimeType};base64,${base64Image}`
                }
            }
        ]
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
        if (e.code === 'FILE_NOT_FOUND_LOCALLY') {
            const errorPayload = {
                status: "error",
                code: e.code,
                error: e.message,
                fileUrl: e.fileUrl
            };
            if (e.failedParameter) {
                errorPayload.failedParameter = e.failedParameter;
            }
            console.log(JSON.stringify(errorPayload));
        } else {
            let detailedError = e.message || "Unknown error";
            if (e.response && e.response.data) {
                detailedError += ` - API Response: ${JSON.stringify(e.response.data)}`;
            }
            console.log(JSON.stringify({ status: "error", error: `QwenImageGen Plugin Error: ${detailedError}` }));
        }
        process.exit(1);
    }
}

main();