#!/usr/bin/env node
import axios from "axios";
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid'; // For generating unique filenames
// VolcEngine SDK (if needed for signing or other functionalities - to be determined)
// import * as VolcEngineSDK from '@volcengine/openapi-sdk'; // Example, actual import may vary

// --- Configuration (from environment variables set by Plugin.js) ---
const VOLCENGINE_API_KEY = process.env.VOLCENGINE_API_KEY; // Single API Key for Bearer token auth
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY; // Key for our own image server
const VAR_HTTP_URL = process.env.VarHttpUrl; // Read VarHttpUrl from env
const VAR_HTTPS_URL = process.env.VarHttpsUrl; // Read VarHttps Url from env

// VolcEngine API specific configurations for Seedream 3 (V3 OpenAI-compatible style)
const VOLCENGINE_API_CONFIG = {
    // V3 API Domain for Beijing region
    BASE_URL: 'https://ark.cn-beijing.volces.com',
    // Specific path for OpenAI-compatible image generation under V3
    IMAGE_GENERATION_ENDPOINT: '/api/v3/images/generations',
    // SERVICE_ID and REGION are typically for AK/SK signing, may not be needed for Bearer auth
    // SERVICE_ID: 'ark', 
    // REGION: 'cn-beijing', 
    MODEL_ID: "doubao-seedream-3-0-t2i-250415", // Using the specific version ID from documentation
    DEFAULT_PARAMS: {
        n: 1, // Corresponds to batch_size
        guidance_scale: 2.5, // Default guidance_scale
        watermark: false // Default watermark
    }
};

// Helper to validate input arguments
function isValidDoubaoGenArgs(args) {
    if (!args || typeof args !== 'object') return false;
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;

    // Resolution validation is now removed. The API will handle invalid resolutions.
    // if (typeof args.resolution !== 'string') return false; // Example of removed check
    // const parts = args.resolution.split('x'); // Example of removed check
    // if (parts.length !== 2) return false; // Example of removed check
    // const width = parseInt(parts[0], 10); // Example of removed check
    // const height = parseInt(parts[1], 10); // Example of removed check
    // if (isNaN(width) || isNaN(height)) return false; // Example of removed check
    // if (width !== height) return false; // Example of removed check (if square was required)
    // if (width < 512 || width > 2048) return false; // Example of removed check

    if (args.seed !== undefined && (typeof args.seed !== 'number' || !Number.isInteger(args.seed) || args.seed < 0)) return false;
    if (args.guidance_scale !== undefined && (typeof args.guidance_scale !== 'number' || args.guidance_scale < 1 || args.guidance_scale > 10)) return false;
    if (args.watermark !== undefined && typeof args.watermark !== 'boolean') return false;
    return true;
}

// TODO: Implement VolcEngine API request signing if required
// This is a simplified placeholder and will likely need a proper signing mechanism
// based on VolcEngine's official SDK or documentation.
// --- Assuming Bearer Token Authentication based on user feedback ---
async function signRequest(requestPayload) { // requestPayload might not be needed for simple Bearer token
    if (!VOLCENGINE_API_KEY) {
        // This warning is important if the key is missing
        console.warn("[DoubaoGen Plugin] WARN: VOLCENGINE_API_KEY is not set. Authentication will likely fail.");
        // Decide if to throw an error or let the API call fail
        // throw new Error("DoubaoGen Plugin Error: VOLCENGINE_API_KEY is required for authentication.");
    }
    return {
        'Authorization': `Bearer ${VOLCENGINE_API_KEY}`,
        'Content-Type': 'application/json'
    };
}


async function generateImageAndSave(args) {
    // Check for essential environment variables
    if (!VOLCENGINE_API_KEY) { // Simplified check for only one API key
        throw new Error("DoubaoGen Plugin Error: VOLCENGINE_API_KEY environment variable is required.");
    }
    if (!PROJECT_BASE_PATH) {
        throw new Error("DoubaoGen Plugin Error: PROJECT_BASE_PATH environment variable is required for saving images.");
    }
    if (!SERVER_PORT) {
        throw new Error("DoubaoGen Plugin Error: SERVER_PORT environment variable is required for constructing image URL.");
    }
    if (!IMAGESERVER_IMAGE_KEY) {
        throw new Error("DoubaoGen Plugin Error: IMAGESERVER_IMAGE_KEY environment variable is required for constructing image URL.");
    }
    if (!VAR_HTTP_URL) {
        throw new Error("DoubaoGen Plugin Error: VarHttpUrl environment variable is required for constructing image URL.");
    }

    if (!isValidDoubaoGenArgs(args)) {
        throw new Error(`DoubaoGen Plugin Error: Invalid arguments received: ${JSON.stringify(args)}. Required: prompt (string), resolution (enum). Optional: seed (integer), guidance_scale (float, 1-10), watermark (boolean). If optional parameters are not provided, defaults will be used.`);
    }

    // Construct the payload according to OpenAI image generation API specs
    const payload = {
        model: VOLCENGINE_API_CONFIG.MODEL_ID,
        prompt: args.prompt,
        n: VOLCENGINE_API_CONFIG.DEFAULT_PARAMS.n, // Number of images to generate
        size: args.resolution, // Resolution like "1024x1024"
        guidance_scale: VOLCENGINE_API_CONFIG.DEFAULT_PARAMS.guidance_scale, // Default
        watermark: VOLCENGINE_API_CONFIG.DEFAULT_PARAMS.watermark // Default
    };
    if (args.seed !== undefined) {
        payload.seed = args.seed; // Add seed if provided and supported
    }
    if (args.guidance_scale !== undefined) {
        payload.guidance_scale = args.guidance_scale; // Override default if provided
    }
    if (args.watermark !== undefined) {
        payload.watermark = args.watermark; // Override default if provided
    }
    // TODO: If Seedream 3 supports other OpenAI-compatible parameters like
    // 'quality', 'style', or extended params like 'steps', 'cfg_scale' via this endpoint,
    // they should be added to the payload here.

    // console.error(`[DoubaoGen Plugin] Sending payload to VolcEngine (V3 OpenAI-style): ${JSON.stringify(payload)}`);

    // TODO: Implement proper request signing for VolcEngine API (AK/SK)
    // The 'signRequest' function is a placeholder. VolcEngine's standard auth requires
    // signing the request with Access Key ID and Secret Access Key.
    // Even for OpenAI-compatible APIs, this is likely the case unless their docs explicitly state Bearer token auth.
    // --- Updated based on assumption of Bearer Token --- 
    const headers = await signRequest(); // No payload needed if just constructing Bearer token

    const volcengineAxiosInstance = axios.create({
        // BASE_URL is set for the instance, endpoint path will be used in post request
        baseURL: VOLCENGINE_API_CONFIG.BASE_URL,
        headers: headers,
        timeout: 120000 // 120 second timeout, image generation can be slow
    });
    
    const fullApiUrl = VOLCENGINE_API_CONFIG.IMAGE_GENERATION_ENDPOINT;

    const response = await volcengineAxiosInstance.post(
        fullApiUrl,
        payload
    );

    // console.error(`[DoubaoGen Plugin] Received response from VolcEngine: ${JSON.stringify(response.data)}`);

    // Parse the response according to OpenAI API V1 spec for images:
    // response.data usually contains { created: ..., data: [ { url: ... } or { b64_json: ... } ] }
    let generatedImageUrlOrBase64;
    const responseData = response.data?.data?.[0];

    if (responseData?.url) { // Check for a URL
        generatedImageUrlOrBase64 = responseData.url;
    } else if (responseData?.b64_json) { // Check for base64 data
        generatedImageUrlOrBase64 = responseData.b64_json;
        // TODO: VolcEngine might specify the image format if returning b64_json (e.g., 'png', 'jpeg')
        // For now, we default to 'png' later if extension not found, but API might provide this.
    }

    if (!generatedImageUrlOrBase64) {
        throw new Error("DoubaoGen Plugin Error: Failed to extract image data/URL from VolcEngine API response. Response: " + JSON.stringify(response.data));
    }

    let imageBuffer;
    let imageExtension = 'png'; // Default extension, adjust if VolcEngine specifies or returns different types

    if (generatedImageUrlOrBase64.startsWith('http')) {
        // If it's a URL, download it
        const imageResponse = await axios({
            method: 'get',
            url: generatedImageUrlOrBase64,
            responseType: 'arraybuffer',
            timeout: 60000 // 60 second timeout for image download
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
        // If it's base64 data
        imageBuffer = Buffer.from(generatedImageUrlOrBase64, 'base64');
        // TODO: Determine image type from API response if possible, otherwise default (e.g., 'png')
        // imageExtension = response.data.result.image_format || 'png';
    }
    
    const generatedFileName = `${uuidv4()}.${imageExtension}`;
    const doubaoGenImageDir = path.join(PROJECT_BASE_PATH, 'image', 'doubaogen'); // Dir name can be kept or changed
    const localImageServerPath = path.join(doubaoGenImageDir, generatedFileName);

    await fs.mkdir(doubaoGenImageDir, { recursive: true });
    await fs.writeFile(localImageServerPath, imageBuffer);
    // console.error(`[DoubaoGen Plugin] Image saved to: ${localImageServerPath}`);

    const relativeServerPathForUrl = path.join('doubaogen', generatedFileName).replace(/\\\\/g, '/');
    const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;
    // const accessibleImageUrl = `${VAR_HTTPS_URL}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;

    const altText = args.prompt ? args.prompt.substring(0, 80) + (args.prompt.length > 80 ? "..." : "") : (generatedFileName || "生成的图片");
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
    let parsedArgs;

    try {
        if (!inputData.trim()) {
            console.log(JSON.stringify({ status: "error", error: "DoubaoGen Plugin Error: No input data received from stdin." }));
            process.exit(1);
            return;
        }
        parsedArgs = JSON.parse(inputData);
        const formattedResultString = await generateImageAndSave(parsedArgs);
        console.log(JSON.stringify({ status: "success", result: formattedResultString }));
    } catch (e) {
        let detailedError = e.message || "Unknown error in DoubaoGen plugin";
        if (e.response && e.response.data) {
            // If the API returned a specific error message, include it.
            detailedError += ` - API Response: ${JSON.stringify(e.response.data)}`;
        }
        const finalErrorMessage = detailedError.startsWith("DoubaoGen Plugin Error:") ? detailedError : `DoubaoGen Plugin Error: ${detailedError}`;
        console.log(JSON.stringify({ status: "error", error: finalErrorMessage }));
        process.exit(1);
    }
}

main();
