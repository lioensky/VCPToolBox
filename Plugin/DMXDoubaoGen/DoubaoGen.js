#!/usr/bin/env node
import axios from "axios";
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid'; // For generating unique filenames
import { fileURLToPath } from 'url'; // Needed for file:// URLs
import mime from 'mime-types'; // To determine MIME type from file path
// VolcEngine SDK (if needed for signing or other functionalities - to be determined)
// import * as VolcEngineSDK from '@volcengine/openapi-sdk'; // Example, actual import may vary

// --- Configuration (from environment variables set by Plugin.js) ---
const VOLCENGINE_API_KEY = process.env.VOLCENGINE_API_KEY; // API Key for the image generation service (e.g., DMXAPI). Ensure this is set in config.env.
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY; // Key for our own image server
const VAR_HTTP_URL = process.env.VarHttpUrl; // Read VarHttpUrl from env
const VAR_HTTPS_URL = process.env.VarHttpsUrl; // Read VarHttps Url from env

// API specific configurations for DMXAPI
const DMX_API_CONFIG = {
    BASE_URL: 'https://www.dmxapi.cn', // New API Host
    IMAGE_GENERATION_ENDPOINT: '/v1/images/generations', // New API Endpoint
    MODEL_ID: "doubao-seedream-4-0-250828", // New unified model
    DEFAULT_PARAMS: {
        n: 1, // Number of images to generate, typically fixed at 1 for this API
    }
};

// Helper to validate input arguments
function isValidDoubaoGenArgs(args) {
    if (!args || typeof args !== 'object' || !args.command) return false;

    // Common validation
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;
    if (args.seed !== undefined && (typeof args.seed !== 'number' || !Number.isInteger(args.seed) || args.seed < 0)) return false;

    // Command-specific validation
    if (args.command === 'DoubaoGenerateImage') {
        if (typeof args.resolution !== 'string') return false;
        const parts = args.resolution.split('x');
        if (parts.length !== 2) return false;
        const width = parseInt(parts[0], 10);
        const height = parseInt(parts[1], 10);
        if (isNaN(width) || isNaN(height)) return false;
        if (width < 512 || width > 2048 || height < 512 || height > 2048) return false;

    } else if (args.command === 'DoubaoEditImage') {
        if (typeof args.image !== 'string' || !args.image.trim()) return false;
        if (typeof args.resolution !== 'string') return false; // Can be "adaptive" or "WxH"
        if (args.guidance_scale !== undefined) {
            const scale = parseFloat(args.guidance_scale);
            if (isNaN(scale) || scale < 0 || scale > 10) return false;
        }
    
    } else if (args.command === 'DoubaoComposeImage') {
        if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;
        
        // Find at least one image parameter
        const imageKeys = Object.keys(args).filter(k => k.startsWith('image_'));
        if (imageKeys.length === 0) return false;

        if (typeof args.resolution !== 'string') return false; // Can be "adaptive" or "WxH"
        if (args.guidance_scale !== undefined) {
            const scale = parseFloat(args.guidance_scale);
            if (isNaN(scale) || scale < 0 || scale > 10) return false;
        }

    } else {
        return false; // Unknown command
    }
    
    return true;
}

// --- Assuming Bearer Token Authentication ---
async function signRequest() {
    if (!VOLCENGINE_API_KEY) {
        // This warning is important if the key is missing
        console.warn("[DoubaoGen Plugin] WARN: API_KEY (e.g., VOLCENGINE_API_KEY in config.env) is not set. Authentication will likely fail.");
        // Decide if to throw an error or let the API call fail
        // throw new Error("DoubaoGen Plugin Error: API_KEY (e.g., VOLCENGINE_API_KEY in config.env) is required for authentication.");
    }
    return {
        'Authorization': `Bearer ${VOLCENGINE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json', // Added based on DMXAPI example
        'User-Agent': 'DMXAPI/1.0.0 (https://www.dmxapi.cn)' // Added based on DMXAPI example
    };
}

// --- Helper function to process the 'image' parameter ---
async function getImageData(imageUrl, imageBase64) {
    // Priority to imageBase64 if provided (on retry from file fetch)
    if (imageBase64) {
        // The provided data is a full Data URI, e.g., "data:image/png;base64,..."
        // The API expects this full string.
        return imageBase64;
    }

    if (!imageUrl) {
        return null;
    }

    // Handle Data URI
    if (imageUrl.startsWith('data:image/')) {
        return imageUrl;
    }

    // Handle public https URL
    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        return imageUrl;
    }

    // Handle local file URL
    if (imageUrl.startsWith('file://')) {
        const filePath = fileURLToPath(imageUrl);
        try {
            const buffer = await fs.readFile(filePath);
            const mimeType = mime.lookup(filePath) || 'application/octet-stream';
            
            // Check file size (10MB limit)
            if (buffer.length > 10 * 1024 * 1024) {
                throw new Error("Image size exceeds the 10MB limit.");
            }

            const base64Image = buffer.toString('base64');
            // Construct the Data URI format required by the API
            return `data:${mimeType};base64,${base64Image}`;
        } catch (e) {
            if (e.code === 'ENOENT') {
                // Hyper-Stack-Trace: File not found locally, request remote fetch.
                const structuredError = new Error(`File not found locally, requesting remote fetch for: ${imageUrl}`);
                structuredError.code = 'FILE_NOT_FOUND_LOCALLY';
                structuredError.fileUrl = imageUrl;
                throw structuredError;
            } else {
                throw new Error(`Error reading local file: ${e.message}`);
            }
        }
    }

    // If the format is unrecognized, treat it as an error.
    throw new Error(`Unsupported image format or protocol. Please use an https:// or file:// URL.`);
}


async function generateImageAndSave(args) {
    // Check for essential environment variables
    if (!VOLCENGINE_API_KEY) {
        throw new Error("DoubaoGen Plugin Error: API_KEY (e.g., VOLCENGINE_API_KEY in config.env) environment variable is required.");
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

    const command = args.command;
    if (!command) {
        throw new Error(`DoubaoGen Plugin Error: 'command' not specified in arguments.`);
    }

    if (!isValidDoubaoGenArgs(args)) {
        throw new Error(`DoubaoGen Plugin Error: Invalid arguments for command '${command}': ${JSON.stringify(args)}.`);
    }

    // --- Image Data Processing (only for EditImage command) ---
    let imageData = null;
    let imagesData = [];

    if (command === 'DoubaoEditImage') {
        imageData = await getImageData(args.image, args.image_base64);
        if (!imageData) {
            // This case should ideally not be hit if validation is correct, but as a safeguard.
            throw new Error("DoubaoGen Plugin Error: 'image' parameter is required and must be processed for the DoubaoEditImage command.");
        }
    } else if (command === 'DoubaoComposeImage') {
        const imageKeys = Object.keys(args).filter(k => k.startsWith('image_'));
        
        const indices = imageKeys.map(k => {
            const num = k.split('_').pop();
            return isNaN(num) ? 0 : parseInt(num, 10);
        }).filter(n => n > 0);

        if (indices.length === 0) {
            throw new Error("DoubaoGen Plugin Error: For DoubaoComposeImage, at least one 'image_N' or 'image_base64_N' (N>0) parameter is required.");
        }
        const maxIndex = Math.max(...indices);

        for (let i = 1; i <= maxIndex; i++) {
            const imageUrlKey = `image_${i}`;
            const imageBase64Key = `image_base64_${i}`;
            
            const imageUrl = args[imageUrlKey];
            const imageBase64 = args[imageBase64Key];

            if (!imageUrl && !imageBase64) {
                throw new Error(`DoubaoGen Plugin Error: Image parameters are not continuous. Missing 'image_${i}' or 'image_base64_${i}'.`);
            }

            try {
                const processedImage = await getImageData(imageUrl, imageBase64);
                imagesData.push(processedImage);
            } catch (e) {
                if (e.code === 'FILE_NOT_FOUND_LOCALLY') {
                    const enhancedError = new Error(`In multi-image composition, image ${i} (parameter: ${imageUrlKey}) was not found locally and requires remote fetching.`);
                    enhancedError.code = 'FILE_NOT_FOUND_LOCALLY';
                    enhancedError.fileUrl = e.fileUrl;
                    enhancedError.failedParameter = imageUrlKey;
                    throw enhancedError;
                }
                throw new Error(`Error processing image ${i} ('${imageUrlKey}'): ${e.message}`);
            }
        }
    }

    // --- Payload Construction ---
    const payload = {
        model: DMX_API_CONFIG.MODEL_ID,
        prompt: args.prompt,
        n: DMX_API_CONFIG.DEFAULT_PARAMS.n,
        size: args.resolution,
        watermark: false
    };

    if (command === 'DoubaoEditImage') {
        payload.image = imageData; // For single image edit
        if (args.guidance_scale !== undefined) {
            payload.guidance_scale = args.guidance_scale;
        }
        if (args.resolution.toLowerCase() === 'adaptive') {
            payload.size = 'adaptive';
        }
    } else if (command === 'DoubaoComposeImage') {
        payload.images = imagesData; // For multiple image composition
        if (args.guidance_scale !== undefined) {
            payload.guidance_scale = args.guidance_scale;
        }
        if (args.resolution.toLowerCase() === 'adaptive') {
            payload.size = 'adaptive';
        }
    }
    
    if (args.seed !== undefined) {
        payload.seed = args.seed; // Add seed if provided
    }

    // console.error(`[DoubaoGen Plugin] Sending payload to DMXAPI: ${JSON.stringify(payload)}`);

    // --- Bearer Token Authentication ---
    const headers = await signRequest();

    const dmxApiAxiosInstance = axios.create({
        baseURL: DMX_API_CONFIG.BASE_URL,
        headers: headers,
        timeout: 120000 // 120 second timeout, image generation can be slow
    });
    
    const fullApiUrl = DMX_API_CONFIG.IMAGE_GENERATION_ENDPOINT;

    const response = await dmxApiAxiosInstance.post(
        fullApiUrl,
        payload
    );

    // console.error(`[DoubaoGen Plugin] Received response from DMXAPI: ${JSON.stringify(response.data)}`);

    // Parse the response (assuming OpenAI API V1 compatible structure for images)
    // response.data usually contains { created: ..., data: [ { url: ... } or { b64_json: ... } ] }
    // If DMXAPI has a different response structure, this part needs adjustment.
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
        throw new Error("DoubaoGen Plugin Error: Failed to extract image data/URL from DMXAPI response. Response: " + JSON.stringify(response.data));
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
        // TODO: Determine image type from DMXAPI response if possible, otherwise default (e.g., 'png')
        // For example, if API returns content-type for base64 or an explicit format field.
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
    const imageHtml = `<img src="${accessibleImageUrl}" alt="${altText}" width="300">`;
    const successMessage = `图片已成功生成！`;
    const aiInstructions = `图片已成功生成！\n\n` +
        `详细信息：\n` +
        `- 图片URL: ${accessibleImageUrl}\n` +
        `- 服务器路径: image/doubaogen/${generatedFileName}\n` +
        `- 文件名: ${generatedFileName}\n\n` +
        `请务必使用以下HTML <img> 标签将图片直接展示给用户 (您可以调整width属性，建议200-500像素)：\n` +
        `${imageHtml}\n`;

    const base64Image = imageBuffer.toString('base64');
    const imageMimeType = `image/${imageExtension}`;

    // Attempt to get the seed from the API response, fallback to payload or N/A
    const responseSeed = response.data?.data?.[0]?.seed;
    const payloadSeed = payload.seed;
    const finalSeed = responseSeed !== undefined ? responseSeed : (payloadSeed !== undefined ? payloadSeed : 'N/A');


    const result = {
        content: [
            {
                type: 'text',
                text: `图片已成功生成！\n- 提示词: ${args.prompt}\n- 分辨率: ${args.resolution}\n- Seed: ${finalSeed}\n- 可访问URL: ${accessibleImageUrl}\n请将生成好的图片转发给用户哦。`
            },
            {
                type: 'image_url',
                image_url: {
                    url: `data:${imageMimeType};base64,${base64Image}`
                }
            }
        ],
        details: { // Keep details for logging or other purposes if needed
            serverPath: `image/doubaogen/${generatedFileName}`,
            fileName: generatedFileName,
            prompt: args.prompt,
            resolution: args.resolution,
            seed: finalSeed,
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
            console.log(JSON.stringify({ status: "error", error: "DoubaoGen Plugin Error: No input data received from stdin." }));
            process.exit(1);
            return;
        }
        parsedArgs = JSON.parse(inputData);
        const resultObject = await generateImageAndSave(parsedArgs);
        // The result from the plugin should be a string for Plugin.js to parse, so we stringify our result object.
        console.log(JSON.stringify({ status: "success", result: resultObject }));
    } catch (e) {
        // Handle Hyper-Stack-Trace for remote file fetching
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
            let detailedError = e.message || "Unknown error in DoubaoGen plugin";
            if (e.response && e.response.data) {
                // If the API returned a specific error message, include it.
                detailedError += ` - API Response: ${JSON.stringify(e.response.data)}`;
            } else if (e.request) {
                detailedError += ` - No response received from API.`;
            }
            const finalErrorMessage = detailedError.startsWith("DoubaoGen Plugin Error:") ? detailedError : `DoubaoGen Plugin Error: ${detailedError}`;
            console.log(JSON.stringify({ status: "error", error: finalErrorMessage }));
        }
        process.exit(1);
    }
}

main();
