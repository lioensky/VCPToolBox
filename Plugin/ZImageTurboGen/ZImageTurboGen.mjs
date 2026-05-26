#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import fetch, { FormData } from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

// --- Configuration ---
const API_KEY = process.env.ZIMAGE_API_KEY || "apikey(填自己的密钥)";
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY;
const VAR_HTTP_URL = process.env.VarHttpUrl;
const VAR_HTTPS_URL = process.env.VarHttpsUrl;
const USE_PUBLIC_URL = process.env.USE_PUBLIC_URL === 'true' || process.env.USE_PUBLIC_URL === '1';
const HTTP_PROXY = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy;

const API_ENDPOINT = 'https://ai.gitee.com/v1/images/generations';
const EDIT_API_ENDPOINT = 'https://ai.gitee.com/v1/async/images/edits';
const TASK_API_ENDPOINT = 'https://ai.gitee.com/v1/task';

// --- Proxy Setup ---
const proxyAgent = HTTP_PROXY ? new HttpsProxyAgent(HTTP_PROXY) : null;

async function fetchWithProxy(url, options = {}) {
    if (proxyAgent) {
        return fetch(url, { ...options, agent: proxyAgent });
    }
    return fetch(url, options);
}

// --- Helper Functions ---

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
    const seen = new Set();
    const pushImage = (value) => {
        for (const item of parseImageArrayInput(value)) {
            if (typeof item === 'string' && item.trim()) {
                const image = item.trim();
                if (!seen.has(image)) {
                    seen.add(image);
                    images.push(image);
                }
            }
        }
    };

    pushImage(args.image || args.Image || args.image_url || args.source_image || args.image_base64);

    const indexedKeys = Object.keys(args)
        .map((key) => {
            const match = key.match(/^image(?:_url)?_(\d+)$/i) || key.match(/^image_base64_(\d+)$/i);
            return match ? { key, index: parseInt(match[1], 10) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.index - b.index || a.key.localeCompare(b.key));

    for (const { key } of indexedKeys) {
        pushImage(args[key]);
    }

    return images;
}

function normalizeArgs(args) {
    const normalized = { ...(args || {}) };
    const images = collectImageInputs(normalized);
    const rawCommand = String(normalized.command || normalized.Command || normalized.cmd || '').toLowerCase();

    normalized.prompt = normalized.prompt || normalized.Prompt || normalized.text || '';
    normalized.size = normalized.size || normalized.Size || normalized.resolution || normalized.Resolution || normalized.image_size || normalized.imageSize;
    normalized.images = images;

    const wantsEdit = rawCommand.includes('edit') || rawCommand.includes('compose') || rawCommand.includes('image2image') || rawCommand.includes('i2i') || rawCommand.includes('修图') || rawCommand.includes('改图') || rawCommand.includes('合成');
    normalized.command = (wantsEdit || images.length > 0) ? 'EditImage' : 'GenerateImage';

    return normalized;
}

function isValidArgs(args) {
    if (!args || typeof args !== 'object') return false;
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;
    if (args.command === 'EditImage' && (!Array.isArray(args.images) || args.images.length === 0)) return false;
    
    if (args.command === 'GenerateImage' && args.size && !/^\d+[:x]\d+$/.test(args.size)) return false;

    if (args.num_inference_steps !== undefined) {
        const steps = parseInt(args.num_inference_steps, 10);
        if (isNaN(steps) || steps < 4 || steps > 25) return false;
    }
    if (args.seed !== undefined) {
        const seed = parseInt(args.seed, 10);
        if (isNaN(seed)) return false;
    }
    return true;
}

async function processApiRequest(rawArgs) {
    const args = normalizeArgs(rawArgs);

    if (!PROJECT_BASE_PATH || !SERVER_PORT || !IMAGESERVER_IMAGE_KEY || !VAR_HTTP_URL) {
        throw new Error("Plugin Error: Missing one or more required environment variables (PROJECT_BASE_PATH, SERVER_PORT, etc).");
    }
    if (!isValidArgs(args)) {
        throw new Error(`Plugin Error: Invalid arguments provided: ${JSON.stringify(rawArgs)}.`);
    }

    if (args.command === 'EditImage') {
        return await processEditRequest(args);
    }

    const payload = {
        model: "z-image-turbo",
        prompt: args.prompt,
        n: 1,
    };

    // --- Size Optimization Logic ---
    const allowedSizes1k = [
        { w: 1024, h: 1024, str: '1024x1024' },
        { w: 1024, h: 768, str: '1024x768' },
        { w: 768, h: 1024, str: '768x1024' },
        { w: 1024, h: 576, str: '1024x576' },
        { w: 576, h: 1024, str: '576x1024' },
        { w: 1024, h: 640, str: '1024x640' },
        { w: 640, h: 1024, str: '640x1024' },
        { w: 512, h: 512, str: '512x512' }
    ];

    const allowedSizes2k = [
        { w: 2048, h: 2048, str: '2048x2048' },
        { w: 2048, h: 1536, str: '2048x1536' },
        { w: 1536, h: 2048, str: '1536x2048' },
        { w: 2048, h: 1152, str: '2048x1152' },
        { w: 1152, h: 2048, str: '1152x2048' },
        { w: 2048, h: 1280, str: '2048x1280' },
        { w: 1280, h: 2048, str: '1280x2048' }
    ];

    let width = 1024;
    let height = 1024;

    if (args.size) {
        const [inputW, inputH] = args.size.split(/[:x]/).map(Number);
        const inputRatio = inputW / inputH;
        
        // Determine whether to use 1k or 2k sizes based on input dimensions
        const use2k = (inputW > 1024 || inputH > 1024 || (inputW * inputH) > 1048576);
        const allowedSizes = use2k ? allowedSizes2k : allowedSizes1k;
        
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
        width = bestMatch.w;
        height = bestMatch.h;
    } else {
        payload.size = '1024x1024';
        width = 1024;
        height = 1024;
    }

    // --- Extra Body Parameters ---
    payload.width = width;
    payload.height = height;
    payload.lora_weights = Array.isArray(args.lora_weights) ? args.lora_weights : [];
    payload.lora_scale = parseFloat(args.lora_scale) || 0;

    if (args.seed !== undefined) {
        payload.seed = parseInt(args.seed, 10) || 0;
    } else {
        payload.seed = 0;
    }

    if (args.negative_prompt && typeof args.negative_prompt === 'string' && args.negative_prompt.trim()) {
        payload.negative_prompt = args.negative_prompt.trim();
    } else {
        payload.negative_prompt = "";
    }

    const steps = args.num_inference_steps !== undefined
        ? Math.max(4, Math.min(25, parseInt(args.num_inference_steps, 10) || 9))
        : 9;
    payload.num_inference_steps = steps;

    // Double insurance: provide both root-level and extra_body parameters
    payload.extra_body = {
        negative_prompt: payload.negative_prompt,
        width: payload.width,
        height: payload.height,
        num_inference_steps: payload.num_inference_steps,
        seed: payload.seed,
        lora_weights: payload.lora_weights,
        lora_scale: payload.lora_scale
    };

    const response = await fetchWithProxy(API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            'X-Failover-Enabled': 'true',
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
        const imageResponse = await fetchWithProxy(responseData.url, {
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
    const accessibleImageUrl = USE_PUBLIC_URL
        ? `${VAR_HTTPS_URL}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`
        : `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`;

    const base64Image = imageBuffer.toString('base64');

    return {
        content: [
            {
                type: 'text',
                text: `图片已成功生成！\n- 提示词: ${args.prompt}${payload.negative_prompt ? `\n- 负面提示词: ${payload.negative_prompt}` : ''}\n- 分辨率: ${payload.size}\n- 推理步数: ${payload.num_inference_steps}\n- 随机种子(Seed): ${payload.seed}\n- 可访问URL: ${accessibleImageUrl}\n\n【重要】请将上面生成的图片Url转发给用户查看，不要只描述图片内容。`
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

async function imageInputToDataUri(imageInput) {
    if (!imageInput || typeof imageInput !== 'string') {
        throw new Error("Plugin Error: Image input must be a non-empty string.");
    }

    const input = imageInput.trim();
    if (input.startsWith('data:image/')) {
        return input;
    }

    if (input.startsWith('http://') || input.startsWith('https://')) {
        const response = await fetchWithProxy(input, {
            signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) {
            throw new Error(`Plugin Error: Failed to download input image from URL: ${input}`);
        }
        const arrayBuf = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        const mimeType = response.headers.get('content-type') || 'image/png';
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    }

    if (input.startsWith('file://')) {
        try {
            const { fileURLToPath } = await import('url');
            const filePath = fileURLToPath(input);
            const buffer = await fs.readFile(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                ext === '.webp' ? 'image/webp' :
                    ext === '.gif' ? 'image/gif' : 'image/png';
            return `data:${mimeType};base64,${buffer.toString('base64')}`;
        } catch (e) {
            if (e.code === 'ENOENT' || e.code === 'ERR_INVALID_FILE_URL_PATH') {
                const structuredError = new Error(`File not found locally, requesting remote fetch for: ${input}`);
                structuredError.code = 'FILE_NOT_FOUND_LOCALLY';
                structuredError.fileUrl = input;
                throw structuredError;
            }
            throw e;
        }
    }

    // Bare base64 compatibility.
    if (/^[A-Za-z0-9+/=\s]+$/.test(input) && input.length > 100) {
        return `data:image/png;base64,${input.replace(/\s/g, '')}`;
    }

    throw new Error("Plugin Error: Unsupported image input. Please use image data URI, HTTP(S) URL, file:// URL, or raw base64.");
}

async function pollEditTask(taskId) {
    const retryIntervalMs = 10000;
    const maxAttempts = 180;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const response = await fetchWithProxy(`${TASK_API_ENDPOINT}/${taskId}`, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
            },
            signal: AbortSignal.timeout(60000),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Task polling failed with status ${response.status}: ${errorBody}`);
        }

        const result = await response.json();
        if (result.error) {
            throw new Error(`${result.error}: ${result.message || "Unknown task error"}`);
        }

        const status = result.status || "unknown";
        if (status === "success" || status === "failed" || status === "cancelled") {
            return result;
        }

        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
    }

    throw new Error(`Task polling timed out after ${maxAttempts} attempts.`);
}

async function processEditRequest(args) {
    const dataUris = [];
    for (const imageInput of args.images) {
        dataUris.push(await imageInputToDataUri(imageInput));
    }

    const formData = new FormData();
    formData.append('prompt', args.prompt);
    formData.append('model', args.model || 'Qwen-Image-Edit-2511');
    formData.append('num_inference_steps', String(Math.max(4, Math.min(25, parseInt(args.num_inference_steps, 10) || 4))));
    formData.append('seed', String(parseInt(args.seed, 10) || 0));
    formData.append('guidance_scale', String(parseFloat(args.guidance_scale) || 1));
    formData.append('negative_prompt', typeof args.negative_prompt === 'string' ? args.negative_prompt : '');

    const taskTypes = Array.isArray(args.task_types)
        ? args.task_types
        : (dataUris.length > 1 ? ['id', 'style'].slice(0, dataUris.length) : ['id']);
    for (const taskType of taskTypes) {
        formData.append('task_types', taskType);
    }

    for (const dataUri of dataUris) {
        // Gitee async edit accepts image references through multipart form fields.
        // We deliberately submit base64/data URI strings here instead of local URLs,
        // because local image-server URLs are meaningless to the remote API.
        formData.append('image', dataUri);
    }

    const taskResponse = await fetchWithProxy(EDIT_API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
        },
        body: formData,
        signal: AbortSignal.timeout(120000),
    });

    if (!taskResponse.ok) {
        const errorBody = await taskResponse.text();
        throw new Error(`Edit API request failed with status ${taskResponse.status}: ${errorBody}`);
    }

    const taskJson = await taskResponse.json();
    const taskId = taskJson.task_id;
    if (!taskId) {
        throw new Error("Plugin Error: Edit API did not return task_id. Response: " + JSON.stringify(taskJson));
    }

    const task = await pollEditTask(taskId);
    if (task.status !== 'success') {
        throw new Error(`Plugin Error: Edit task ${taskId} ended with status ${task.status}. Response: ${JSON.stringify(task)}`);
    }

    const outputUrl = task.output?.file_url;
    if (!outputUrl) {
        throw new Error("Plugin Error: Edit task succeeded but no output.file_url was returned. Response: " + JSON.stringify(task));
    }

    const imageResponse = await fetchWithProxy(outputUrl, {
        signal: AbortSignal.timeout(60000),
    });
    if (!imageResponse.ok) {
        throw new Error(`Failed to download edited image from URL: ${outputUrl}`);
    }

    const arrayBuf = await imageResponse.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuf);
    const imageMimeType = imageResponse.headers.get('content-type') || 'image/png';
    const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
    const imageExtension = extMap[imageMimeType] || 'png';

    const generatedFileName = `${uuidv4()}.${imageExtension}`;
    const imageDir = path.join(PROJECT_BASE_PATH, 'image', 'zimageturbogen');
    const localImagePath = path.join(imageDir, generatedFileName);

    await fs.mkdir(imageDir, { recursive: true });
    await fs.writeFile(localImagePath, imageBuffer);

    const relativePathForUrl = path.join('zimageturbogen', generatedFileName).replace(/\\/g, '/');
    const accessibleImageUrl = USE_PUBLIC_URL
        ? `${VAR_HTTPS_URL}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`
        : `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`;

    const base64Image = imageBuffer.toString('base64');

    return {
        content: [
            {
                type: 'text',
                text: `图片已成功编辑！\n- 提示词: ${args.prompt}\n- 参考图数量: ${dataUris.length}\n- 模型: ${args.model || 'Qwen-Image-Edit-2511'}\n- 任务ID: ${taskId}\n- 可访问URL: ${accessibleImageUrl}\n\n【重要】请将上面生成的图片Url转发给用户查看，不要只描述图片内容。`
            },
            {
                type: 'image_url',
                image_url: {
                    url: `data:${imageMimeType};base64,${base64Image}`
                }
            }
        ],
        details: {
            url: accessibleImageUrl,
            taskId,
            mode: dataUris.length > 1 ? 'compose' : 'edit'
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
