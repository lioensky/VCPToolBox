#!/usr/bin/env node
import axios from "axios";
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid'; // For generating unique filenames

// --- Configuration (from environment variables set by Plugin.js) ---
const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY;
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY; // Key for our own image server
const VAR_HTTP_URL = process.env.VarHttpUrl; // Read VarHttpUrl from env

// SiliconFlow API specific configurations
const SILICONFLOW_API_CONFIG = {
    BASE_URL: 'https://api.siliconflow.cn',
    ENDPOINTS: {
        IMAGE_GENERATION: '/v1/images/generations'
    },
    MODEL_ID: "black-forest-labs/FLUX.1-dev",
    MODEL_ID_IMG2IMG: "siliconflow/kaiwei-flux-kontext-dev/d20v0cs50mis73faguu0",
    DEFAULT_PARAMS: {
        num_inference_steps: 24,
        guidance_scale: 7.5, // May not be used by Flux, but API might accept
        batch_size: 1
    }
};

// Helper to validate input arguments
function isValidFluxGenArgs(args) {
    if (!args || typeof args !== 'object') return false;
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;
    if (typeof args.resolution !== 'string' || !["1024x1024", "960x1280", "768x1024", "720x1440", "720x1280"].includes(args.resolution)) return false;
    if (args.seed !== undefined && (typeof args.seed !== 'number' || !Number.isInteger(args.seed) || args.seed < 0)) return false;
    return true;
}

function isValidFluxGenImg2ImgArgs(args) {
    if (!args || typeof args !== 'object') return false;
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;
    if (typeof args.image_url !== 'string' || !args.image_url.trim()) return false;
    if (args.seed !== undefined && (typeof args.seed !== 'number' || !Number.isInteger(args.seed) || args.seed < 0)) return false;
    if (args.prompt_enhancement !== undefined && typeof args.prompt_enhancement !== 'boolean') return false;
    return true;
}

// Helper to get image data from various URL types, inspired by GeminiImageGen
async function getImageDataFromUrl(url) {
    if (url.startsWith('data:')) {
        const match = url.match(/^data:(image\/\w+);base64,(.*)$/);
        if (!match) throw new Error('Invalid data URI format.');
        return { buffer: Buffer.from(match[2], 'base64'), mimeType: match[1] };
    }

    if (url.startsWith('http')) {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return { buffer: response.data, mimeType: response.headers['content-type'] || 'image/jpeg' };
    }

    if (url.startsWith('file://')) {
        // This is the pattern from GeminiImageGen: delegate file fetching to the main server
        // by throwing a structured error. This is for security and centralization of file access.
        const structuredError = new Error("Local file access must be handled by the main server.");
        structuredError.code = 'FILE_NOT_FOUND_LOCALLY'; // Use a consistent error code
        structuredError.fileUrl = url;
        throw structuredError;
    }

    throw new Error('Unsupported URL protocol. Please use http, https, data URI, or file://.');
}

async function generateImageAndSave(args) {
    // Check for essential environment variables
    if (!SILICONFLOW_API_KEY) {
        throw new Error("FluxGen Plugin Error: SILICONFLOW_API_KEY environment variable is required and not set.");
    }
    if (!PROJECT_BASE_PATH) {
        throw new Error("FluxGen Plugin Error: PROJECT_BASE_PATH environment variable is required for saving images.");
    }
    if (!SERVER_PORT) {
        throw new Error("FluxGen Plugin Error: SERVER_PORT environment variable is required for constructing image URL.");
    }
    if (!IMAGESERVER_IMAGE_KEY) {
        throw new Error("FluxGen Plugin Error: IMAGESERVER_IMAGE_KEY environment variable is required for constructing image URL.");
    }
    if (!VAR_HTTP_URL) {
        throw new Error("FluxGen Plugin Error: VarHttpUrl environment variable is required for constructing image URL.");
    }

    if (!isValidFluxGenArgs(args)) {
        throw new Error(`FluxGen Plugin Error: Invalid arguments received: ${JSON.stringify(args)}. Required: prompt (string), resolution (enum). Optional: seed (integer).`);
    }

    const siliconflowAxiosInstance = axios.create({
        baseURL: SILICONFLOW_API_CONFIG.BASE_URL,
        headers: {
            'Authorization': `Bearer ${SILICONFLOW_API_KEY}`,
            'Content-Type': 'application/json'
        },
        timeout: 60000 // 60 second timeout for API call
    });

    const payload = {
        model: SILICONFLOW_API_CONFIG.MODEL_ID,
        prompt: args.prompt,
        image_size: args.resolution,
        batch_size: SILICONFLOW_API_CONFIG.DEFAULT_PARAMS.batch_size,
        num_inference_steps: SILICONFLOW_API_CONFIG.DEFAULT_PARAMS.num_inference_steps,
        guidance_scale: SILICONFLOW_API_CONFIG.DEFAULT_PARAMS.guidance_scale
    };
    if (args.seed !== undefined) {
        payload.seed = args.seed;
    }

    // console.error(`[FluxGen Plugin] Sending payload to SiliconFlow: ${JSON.stringify(payload)}`);

    const response = await siliconflowAxiosInstance.post(
        SILICONFLOW_API_CONFIG.ENDPOINTS.IMAGE_GENERATION,
        payload
    );

    // console.error(`[FluxGen Plugin] Received response from SiliconFlow: ${JSON.stringify(response.data)}`);

    const siliconflowImageUrl = response.data?.images?.[0]?.url;
    if (!siliconflowImageUrl) {
        throw new Error("FluxGen Plugin Error: Failed to extract image URL from SiliconFlow API response.");
    }

    // Download the image from SiliconFlow URL
    const imageResponse = await axios({
        method: 'get',
        url: siliconflowImageUrl,
        responseType: 'arraybuffer',
        timeout: 60000 // 60 second timeout for image download
    });

    let imageExtension = 'png'; // Default extension
    const contentType = imageResponse.headers['content-type'];
    if (contentType && contentType.startsWith('image/')) {
        imageExtension = contentType.split('/')[1];
    } else {
        // Fallback to extract from URL if content-type is not helpful
        const urlExtMatch = siliconflowImageUrl.match(/\.([^.?]+)(?:[?#]|$)/);
        if (urlExtMatch && urlExtMatch[1]) {
            imageExtension = urlExtMatch[1];
        }
    }
    
    const generatedFileName = `${uuidv4()}.${imageExtension}`;
    const fluxGenImageDir = path.join(PROJECT_BASE_PATH, 'image', 'fluxgen');
    const localImageServerPath = path.join(fluxGenImageDir, generatedFileName);

    await fs.mkdir(fluxGenImageDir, { recursive: true });
    await fs.writeFile(localImageServerPath, imageResponse.data);
    // console.error(`[FluxGen Plugin] Image saved to: ${localImageServerPath}`);

    // Construct the URL accessible via our own ImageServer plugin
    // Ensure path separators are URL-friendly (/)
    const relativeServerPathForUrl = path.join('fluxgen', generatedFileName).replace(/\\/g, '/');
    const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;

    const altText = args.prompt ? args.prompt.substring(0, 80) + (args.prompt.length > 80 ? "..." : "") : (generatedFileName || "生成的图片");
    const imageHtml = `<img src="${accessibleImageUrl}" alt="${altText}" width="300">`;
    const successMessage = `图片已成功生成！`;
    const aiInstructions = `图片已成功生成！\n\n` +
        `详细信息：\n` +
        `- 图片URL: ${accessibleImageUrl}\n` +
        `- 服务器路径: image/fluxgen/${generatedFileName}\n` +
        `- 文件名: ${generatedFileName}\n\n` +
        `请务必使用以下HTML <img> 标签将图片直接展示给用户 (您可以调整width属性，建议200-500像素)：\n` +
        `${imageHtml}\n`;

    const imageBuffer = imageResponse.data;
    const base64Image = Buffer.from(imageBuffer).toString('base64');
    const imageMimeType = `image/${imageExtension}`;

    const responseSeed = response.data?.seed;
    const payloadSeed = payload.seed;
    const finalSeed = responseSeed !== undefined ? responseSeed : (payloadSeed !== undefined ? payloadSeed : 'N/A');

    const result = {
        content: [
            {
                type: 'text',
                text: `图片已成功生成！\n- 提示词: ${args.prompt}\n- 分辨率: ${args.resolution}\n- Seed: ${finalSeed}\n- 可访问URL: ${accessibleImageUrl}`
            },
            {
                type: 'image_url',
                image_url: {
                    url: `data:${imageMimeType};base64,${base64Image}`
                }
            }
        ],
        details: { // Keep details for logging or other purposes if needed
            serverPath: `image/fluxgen/${generatedFileName}`,
            fileName: generatedFileName,
            prompt: args.prompt,
            resolution: args.resolution,
            seed: finalSeed,
            imageUrl: accessibleImageUrl
        }
    };

    return result;
}

async function generateImageFromImage(args) {
    // Check for essential environment variables
    if (!SILICONFLOW_API_KEY) {
        throw new Error("FluxGen Plugin Error: SILICONFLOW_API_KEY environment variable is required and not set.");
    }
    if (!PROJECT_BASE_PATH) {
        throw new Error("FluxGen Plugin Error: PROJECT_BASE_PATH environment variable is required for saving images.");
    }
    if (!SERVER_PORT) {
        throw new Error("FluxGen Plugin Error: SERVER_PORT environment variable is required for constructing image URL.");
    }
    if (!IMAGESERVER_IMAGE_KEY) {
        throw new Error("FluxGen Plugin Error: IMAGESERVER_IMAGE_KEY environment variable is required for constructing image URL.");
    }
    if (!VAR_HTTP_URL) {
        throw new Error("FluxGen Plugin Error: VarHttpUrl environment variable is required for constructing image URL.");
    }

    if (!isValidFluxGenImg2ImgArgs(args)) {
        throw new Error(`FluxGen Plugin Error: Invalid arguments for image-to-image. Received: ${JSON.stringify(args)}. Required: prompt (string), image_url (string). Optional: seed (integer), prompt_enhancement (boolean).`);
    }

    // Get image data
    const { buffer, mimeType } = await getImageDataFromUrl(args.image_url);
    const base64Image = buffer.toString('base64');
    const imageDataUri = `data:${mimeType};base64,${base64Image}`;

    // Setup for API call
    const siliconflowAxiosInstance = axios.create({
        baseURL: SILICONFLOW_API_CONFIG.BASE_URL,
        headers: {
            'Authorization': `Bearer ${SILICONFLOW_API_KEY}`,
            'Content-Type': 'application/json'
        },
        timeout: 120000 // 120 seconds for img2img
    });

    const payload = {
        model: SILICONFLOW_API_CONFIG.MODEL_ID_IMG2IMG,
        prompt: args.prompt,
        image: imageDataUri,
        prompt_enhancement: args.prompt_enhancement === true, // default to false
    };
    if (args.seed !== undefined) {
        payload.seed = args.seed;
    }

    // Make API call
    const response = await siliconflowAxiosInstance.post(
        SILICONFLOW_API_CONFIG.ENDPOINTS.IMAGE_GENERATION,
        payload
    );

    // Process response
    const siliconflowImageUrl = response.data?.images?.[0]?.url;
    if (!siliconflowImageUrl) {
        throw new Error("FluxGen Plugin Error: Failed to extract image URL from SiliconFlow API response.");
    }

    // Download the image from SiliconFlow URL
    const imageResponse = await axios({
        method: 'get',
        url: siliconflowImageUrl,
        responseType: 'arraybuffer',
        timeout: 60000
    });

    let imageExtension = 'png';
    const contentType = imageResponse.headers['content-type'];
    if (contentType && contentType.startsWith('image/')) {
        imageExtension = contentType.split('/')[1];
    }

    const generatedFileName = `${uuidv4()}.${imageExtension}`;
    const fluxGenImageDir = path.join(PROJECT_BASE_PATH, 'image', 'fluxgen');
    const localImageServerPath = path.join(fluxGenImageDir, generatedFileName);

    await fs.mkdir(fluxGenImageDir, { recursive: true });
    await fs.writeFile(localImageServerPath, imageResponse.data);

    const relativeServerPathForUrl = path.join('fluxgen', generatedFileName).replace(/\\/g, '/');
    const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;

    const imageBuffer = imageResponse.data;
    const responseBase64Image = Buffer.from(imageBuffer).toString('base64');
    const responseMimeType = `image/${imageExtension}`;

    const responseSeed = response.data?.seed;
    const payloadSeed = payload.seed;
    const finalSeed = responseSeed !== undefined ? responseSeed : (payloadSeed !== undefined ? payloadSeed : 'N/A');

    const result = {
        content: [
            {
                type: 'text',
                text: `图生图已成功生成！\n- 提示词: ${args.prompt}\n- Seed: ${finalSeed}\n- 可访问URL: ${accessibleImageUrl}`
            },
            {
                type: 'image_url',
                image_url: {
                    url: `data:${responseMimeType};base64,${responseBase64Image}`
                }
            }
        ],
        details: {
            serverPath: `image/fluxgen/${generatedFileName}`,
            fileName: generatedFileName,
            prompt: args.prompt,
            seed: finalSeed,
            imageUrl: accessibleImageUrl,
            original_image_url: args.image_url
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
            // Output error as JSON to stdout
            console.log(JSON.stringify({ status: "error", error: "FluxGen Plugin Error: No input data received from stdin." }));
            process.exit(1);
            return;
        }
        parsedArgs = JSON.parse(inputData);
        let resultObject;
        if (parsedArgs.image_url) {
            resultObject = await generateImageFromImage(parsedArgs);
        } else {
            resultObject = await generateImageAndSave(parsedArgs);
        }
        console.log(JSON.stringify({ status: "success", result: resultObject })); // Output success as JSON
    } catch (e) {
        // Handle specific error for remote file fetching
        if (e.code === 'FILE_NOT_FOUND_LOCALLY') {
            console.log(JSON.stringify({
                status: "error",
                code: e.code,
                error: e.message,
                fileUrl: e.fileUrl
            }));
        } else {
            // General error handling
            const errorMessage = e.message || "Unknown error in FluxGen plugin";
            console.log(JSON.stringify({ status: "error", error: errorMessage.startsWith("FluxGen Plugin Error:") ? errorMessage : `FluxGen Plugin Error: ${errorMessage}` }));
        }
        process.exit(1); // Indicate failure
    }
}

main();
