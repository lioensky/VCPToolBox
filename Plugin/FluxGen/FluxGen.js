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
    MODEL_ID: "black-forest-labs/FLUX.1-schnell",
    DEFAULT_PARAMS: {
        num_inference_steps: 20,
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

    // Construct a message that strongly guides the AI to use an HTML img tag
    const altText = args.prompt ? args.prompt.substring(0, 80) + (args.prompt.length > 80 ? "..." : "") : (generatedFileName || "生成的图片");
    const successMessage =
        `图片已成功生成！\n\n` +
        `详细信息：\n` +
        `- 图片URL: ${accessibleImageUrl}\n` +
        `- 服务器路径: image/fluxgen/${generatedFileName}\n` +
        `- 文件名: ${generatedFileName}\n\n` +
        `请务必使用以下HTML <img> 标签将图片直接展示给用户 (您可以调整width属性，建议200-500像素)：\n` +
        `<img src=\"${accessibleImageUrl}\" alt=\"${altText}\" width=\"300\">`;
    
    return successMessage;
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
        const formattedResultString = await generateImageAndSave(parsedArgs);
        console.log(JSON.stringify({ status: "success", result: formattedResultString })); // Output success as JSON
    } catch (e) {
        // Output error as JSON to stdout
        // Ensure error message is somewhat consistent with what might have been thrown by generateImageAndSave or parsing
        const errorMessage = e.message || "Unknown error in FluxGen plugin";
        console.log(JSON.stringify({ status: "error", error: errorMessage.startsWith("FluxGen Plugin Error:") ? errorMessage : `FluxGen Plugin Error: ${errorMessage}` }));
        process.exit(1); // Indicate failure
    }
}

main();
