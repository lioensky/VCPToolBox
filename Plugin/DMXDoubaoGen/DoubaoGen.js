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
    MODEL_ID: "doubao-seedream-4-5-251128", // New unified model
    DEFAULT_PARAMS: {
        n: 1, // Number of images to generate, typically fixed at 1 for this API
    }
};

// Helper to validate input arguments
function parseImageArrayInput(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value !== 'string') return value ? [value] : [];

    const trimmed = value.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed.filter(Boolean);
        } catch {
            // Keep as a single image string if JSON parsing fails.
        }
    }

    return [trimmed];
}

function collectImageInputs(args) {
    const images = [];
    const pushImage = (value) => {
        for (const item of parseImageArrayInput(value)) {
            if (typeof item === 'string' && item.trim()) {
                images.push({ image: item.trim(), image_base64: null });
            }
        }
    };
    const pushBase64 = (value) => {
        for (const item of parseImageArrayInput(value)) {
            if (typeof item === 'string' && item.trim()) {
                images.push({ image: null, image_base64: item.trim() });
            }
        }
    };

    pushImage(args.image || args.Image || args.image_url || args.source_image);
    pushBase64(args.image_base64);

    const indexedKeys = Object.keys(args)
        .map((key) => {
            const match = key.match(/^image(?:_url)?_(\d+)$/i) || key.match(/^image_base64_(\d+)$/i);
            return match ? { key, index: parseInt(match[1], 10) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.index - b.index || a.key.localeCompare(b.key));

    for (const { key } of indexedKeys) {
        if (/^image_base64_/i.test(key)) {
            pushBase64(args[key]);
        } else {
            pushImage(args[key]);
        }
    }

    return images;
}

function normalizeDoubaoArgs(rawArgs) {
    const args = { ...(rawArgs || {}) };
    args.prompt = args.prompt || args.Prompt || args.text || '';
    args.resolution = args.resolution || args.Resolution || args.size || args.Size || args.image_size || args.imageSize || '2K';

    const collectedImages = collectImageInputs(args);
    const rawCommand = String(args.command || args.Command || args.cmd || '').toLowerCase();
    const wantsCompose = rawCommand.includes('compose') || rawCommand.includes('合成');
    const wantsEdit = rawCommand.includes('edit') || rawCommand.includes('image2image') || rawCommand.includes('i2i') || rawCommand.includes('修图') || rawCommand.includes('改图');
    const wantsGenerate = rawCommand.includes('generate') || rawCommand.includes('txt2img') || rawCommand.includes('t2i') || rawCommand.includes('生成');

    if (wantsCompose || (wantsEdit && collectedImages.length > 1) || (!wantsGenerate && collectedImages.length > 1)) {
        args.command = 'DoubaoComposeImage';
    } else if (wantsEdit || (wantsCompose && collectedImages.length === 1) || (!wantsGenerate && collectedImages.length === 1)) {
        args.command = 'DoubaoEditImage';
    } else {
        args.command = 'DoubaoGenerateImage';
    }

    if (collectedImages.length > 0) {
        args.image = collectedImages[0].image || args.image;
        args.image_base64 = collectedImages[0].image_base64 || args.image_base64;

        collectedImages.forEach((item, index) => {
            const n = index + 1;
            if (item.image) args[`image_${n}`] = item.image;
            if (item.image_base64) args[`image_base64_${n}`] = item.image_base64;
        });
    }

    return args;
}

function isValidDoubaoGenArgs(args) {
    if (!args || typeof args !== 'object' || !args.command) return false;

    // Common validation
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;
    if (args.seed !== undefined && (typeof args.seed !== 'number' || !Number.isInteger(args.seed) || args.seed < 0)) return false;

    const isResolutionValid = (res, command) => {
        if (typeof res !== 'string') return false;
        const upperRes = res.toUpperCase();
        // Support 2K, 4K
        if (upperRes === '2K' || upperRes === '4K') return true;
        // Support adaptive for edit/compose
        if (upperRes === 'ADAPTIVE' && (command === 'DoubaoEditImage' || command === 'DoubaoComposeImage')) return true;
        
        // Support WxH format
        const parts = res.split('x');
        if (parts.length === 2) {
            const width = parseInt(parts[0], 10);
            const height = parseInt(parts[1], 10);
            // Relaxed range for new model (up to 4K pixels)
            return !isNaN(width) && !isNaN(height) && width >= 512 && width <= 4096 && height >= 512 && height <= 4096;
        }
        return false;
    };

    // Command-specific validation
    if (args.command === 'DoubaoGenerateImage') {
        if (!isResolutionValid(args.resolution, args.command)) return false;

    } else if (args.command === 'DoubaoEditImage') {
        if (!((typeof args.image === 'string' && args.image.trim()) || (typeof args.image_base64 === 'string' && args.image_base64.trim()))) return false;
        if (!isResolutionValid(args.resolution, args.command)) return false;
        if (args.guidance_scale !== undefined) {
            const scale = parseFloat(args.guidance_scale);
            if (isNaN(scale) || scale < 0 || scale > 10) return false;
        }
    
    } else if (args.command === 'DoubaoComposeImage') {
        if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;
        
        // Find at least one image parameter
        const imageKeys = Object.keys(args).filter(k => k.startsWith('image_'));
        if (imageKeys.length === 0) return false;

        if (!isResolutionValid(args.resolution, args.command)) return false;
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

    args = normalizeDoubaoArgs(args);
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
        const imageKeys = Object.keys(args).filter(k => /^image(?:_base64)?_\d+$/i.test(k));
        
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
    // --- Payload Construction ---
    let size = args.resolution;
    if (typeof size === 'string') {
        const upperSize = size.toUpperCase();
        if (upperSize === '2K' || upperSize === '4K') {
            size = upperSize;
        } else if (upperSize === 'ADAPTIVE') {
            size = 'adaptive';
        }
    }

    const payload = {
        model: DMX_API_CONFIG.MODEL_ID,
        prompt: args.prompt,
        n: DMX_API_CONFIG.DEFAULT_PARAMS.n,
        size: size,
        watermark: false
    };

    if (command === 'DoubaoEditImage') {
        payload.image = imageData; // For single image edit
        if (args.guidance_scale !== undefined) {
            payload.guidance_scale = args.guidance_scale;
        }
    } else if (command === 'DoubaoComposeImage') {
        payload.images = imagesData; // For multiple image composition
        if (args.guidance_scale !== undefined) {
            payload.guidance_scale = args.guidance_scale;
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

    const imageMimeType = `image/${imageExtension}`;
    const showBase64 = args.showbase64 === true || args.showbase64 === 'true' || args.showBase64 === true || args.showBase64 === 'true';

    // Attempt to get the seed from the API response, fallback to payload or N/A
    const responseSeed = response.data?.data?.[0]?.seed;
    const payloadSeed = payload.seed;
    const finalSeed = responseSeed !== undefined ? responseSeed : (payloadSeed !== undefined ? payloadSeed : 'N/A');


    const content = [
        {
            type: 'text',
            text: `图片已成功生成！\n- 提示词: ${args.prompt}\n- 分辨率: ${size}\n- Seed: ${finalSeed}\n- 可访问URL: ${accessibleImageUrl}\n请将生成好的图片转发给用户哦。`
        }
    ];

    if (showBase64) {
        content.push({
            type: 'image_url',
            image_url: {
                url: `data:${imageMimeType};base64,${imageBuffer.toString('base64')}`
            }
        });
    }

    const result = {
        content,
        details: { // Keep details for logging or other purposes if needed
            serverPath: `image/doubaogen/${generatedFileName}`,
            fileName: generatedFileName,
            prompt: args.prompt,
            resolution: size,
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
