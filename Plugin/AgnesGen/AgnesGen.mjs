#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

// --- Configuration ---
const API_KEY = process.env.AGNES_API_KEY || process.env.SAPIENS_API_KEY || "";
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY;
const VAR_HTTP_URL = process.env.VarHttpUrl;
const VAR_HTTPS_URL = process.env.VarHttpsUrl;
const USE_PUBLIC_URL = process.env.USE_PUBLIC_URL === 'true' || process.env.USE_PUBLIC_URL === '1';
const HTTP_PROXY = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy;

const API_ENDPOINT = process.env.AGNES_API_ENDPOINT || 'https://apihub.agnes-ai.com/v1/images/generations';
const MODEL_ID = process.env.AGNES_MODEL_ID || 'agnes-image-2.1-flash';
const DEFAULT_SIZE = process.env.AGNES_DEFAULT_SIZE || '1024x1024';

// --- Proxy Setup ---
const proxyAgent = HTTP_PROXY ? new HttpsProxyAgent(HTTP_PROXY) : null;

function shouldBypassProxy(url) {
    try {
        const { hostname } = new URL(url);
        return hostname === 'localhost'
            || hostname === '127.0.0.1'
            || hostname === '::1'
            || hostname.startsWith('10.')
            || hostname.startsWith('192.168.')
            || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
    } catch {
        return false;
    }
}

async function fetchWithProxy(url, options = {}) {
    if (proxyAgent && !shouldBypassProxy(url)) {
        return fetch(url, { ...options, agent: proxyAgent });
    }
    return fetch(url, options);
}

// --- Input Normalization ---
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

function normalizeArgs(rawArgs) {
    const args = { ...(rawArgs || {}) };
    const images = collectImageInputs(args);
    const rawCommand = String(args.command || args.Command || args.cmd || '').toLowerCase();

    args.prompt = args.prompt || args.Prompt || args.text || '';
    args.size = args.size || args.Size || args.resolution || args.Resolution || args.image_size || args.imageSize || DEFAULT_SIZE;
    args.images = images;

    const wantsEdit = rawCommand.includes('edit')
        || rawCommand.includes('image2image')
        || rawCommand.includes('i2i')
        || rawCommand.includes('修图')
        || rawCommand.includes('改图');
    const wantsCompose = rawCommand.includes('compose') || rawCommand.includes('合成');
    const wantsGenerate = rawCommand.includes('generate') || rawCommand.includes('txt2img') || rawCommand.includes('t2i') || rawCommand.includes('生成');

    if (wantsCompose || (images.length > 1 && !wantsGenerate)) {
        args.command = 'compose';
    } else if (wantsEdit || (images.length === 1 && !wantsGenerate)) {
        args.command = 'edit';
    } else {
        args.command = 'generate';
    }

    return args;
}

function isValidSize(size) {
    if (typeof size !== 'string') return false;
    const trimmed = size.trim();
    if (!trimmed) return false;
    if (/^adaptive$/i.test(trimmed)) return true;
    if (/^\d{2,5}x\d{2,5}$/i.test(trimmed)) {
        const [width, height] = trimmed.toLowerCase().split('x').map(Number);
        return width >= 64 && height >= 64 && width <= 8192 && height <= 8192;
    }
    return false;
}

function isValidArgs(args) {
    if (!args || typeof args !== 'object') return false;
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return false;
    if (!['generate', 'edit', 'compose'].includes(args.command)) return false;
    if ((args.command === 'edit' || args.command === 'compose') && (!Array.isArray(args.images) || args.images.length === 0)) return false;
    if (args.size && !isValidSize(args.size)) return false;
    return true;
}

// --- Image Processing ---
function mimeTypeToExtension(mimeType) {
    const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
    const extMap = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/bmp': 'bmp',
        'image/tiff': 'tiff',
        'image/avif': 'avif'
    };
    return extMap[normalized] || 'png';
}

function extensionToMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.bmp') return 'image/bmp';
    if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
    if (ext === '.avif') return 'image/avif';
    return 'image/png';
}

function normalizeBase64Image(input) {
    const trimmed = String(input || '').trim();
    if (trimmed.startsWith('data:image/')) return trimmed;
    return `data:image/png;base64,${trimmed.replace(/\s/g, '')}`;
}

async function imageInputToApiValue(imageInput) {
    if (!imageInput || typeof imageInput !== 'string') {
        throw new Error("AgnesGen Plugin Error: Image input must be a non-empty string.");
    }

    const input = imageInput.trim();

    if (input.startsWith('data:image/')) {
        return input;
    }

    if (input.startsWith('http://') || input.startsWith('https://')) {
        return input;
    }

    if (input.startsWith('file://')) {
        try {
            const filePath = fileURLToPath(input);
            const buffer = await fs.readFile(filePath);
            const mimeType = extensionToMimeType(filePath);
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
        return normalizeBase64Image(input);
    }

    throw new Error("AgnesGen Plugin Error: Unsupported image input. Please use image URL, data URI, file:// URL, or raw base64.");
}

function extractImageData(responseJson) {
    const candidates = [
        responseJson?.data?.[0],
        responseJson?.images?.[0],
        responseJson?.output?.[0],
        responseJson?.result?.[0],
        responseJson
    ].filter(Boolean);

    for (const item of candidates) {
        if (typeof item === 'string') {
            return item;
        }
        if (item.url) return item.url;
        if (item.image_url) return item.image_url;
        if (item.file_url) return item.file_url;
        if (item.b64_json) return item.b64_json;
        if (item.image_base64) return item.image_base64;
        if (item.base64) return item.base64;
    }

    return null;
}

async function imageResultToBuffer(imageData) {
    if (!imageData || typeof imageData !== 'string') {
        throw new Error("AgnesGen Plugin Error: Empty image result.");
    }

    const value = imageData.trim();

    if (value.startsWith('http://') || value.startsWith('https://')) {
        const imageResponse = await fetchWithProxy(value, {
            signal: AbortSignal.timeout(60000)
        });

        if (!imageResponse.ok) {
            const errorBody = await imageResponse.text().catch(() => '');
            throw new Error(`AgnesGen Plugin Error: Failed to download generated image. HTTP ${imageResponse.status}. ${errorBody}`);
        }

        const arrayBuf = await imageResponse.arrayBuffer();
        const mimeType = imageResponse.headers.get('content-type') || 'image/png';
        return {
            buffer: Buffer.from(arrayBuf),
            mimeType,
            sourceUrl: value
        };
    }

    const dataUriMatch = value.match(/^data:(image\/[^;]+);base64,([\s\S]+)$/);
    if (dataUriMatch) {
        return {
            buffer: Buffer.from(dataUriMatch[2].replace(/\s/g, ''), 'base64'),
            mimeType: dataUriMatch[1],
            sourceUrl: null
        };
    }

    return {
        buffer: Buffer.from(value.replace(/\s/g, ''), 'base64'),
        mimeType: 'image/png',
        sourceUrl: null
    };
}

function buildAccessibleImageUrl(fileName) {
    const relativePathForUrl = path.join('agnesgen', fileName).replace(/\\/g, '/');
    return USE_PUBLIC_URL && VAR_HTTPS_URL
        ? `${VAR_HTTPS_URL}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`
        : `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`;
}

// --- Core Request ---
async function processApiRequest(rawArgs) {
    const showBase64 = rawArgs?.showbase64 === 'true' || rawArgs?.showbase64 === true;
    const args = normalizeArgs(rawArgs);

    if (!API_KEY) {
        throw new Error("AgnesGen Plugin Error: AGNES_API_KEY environment variable is required.");
    }
    if (!PROJECT_BASE_PATH || !SERVER_PORT || !IMAGESERVER_IMAGE_KEY || !VAR_HTTP_URL) {
        throw new Error("AgnesGen Plugin Error: Missing one or more required environment variables (PROJECT_BASE_PATH, SERVER_PORT, IMAGESERVER_IMAGE_KEY, VarHttpUrl).");
    }
    if (!isValidArgs(args)) {
        throw new Error(`AgnesGen Plugin Error: Invalid arguments provided: ${JSON.stringify(rawArgs)}.`);
    }

    const payload = {
        model: MODEL_ID,
        prompt: args.prompt.trim(),
        size: args.size,
        extra_body: {
            response_format: args.response_format || 'url'
        }
    };

    if (args.command === 'edit' || args.command === 'compose') {
        const processedImages = [];
        for (const imageInput of args.images) {
            processedImages.push(await imageInputToApiValue(imageInput));
        }
        payload.extra_body.image = processedImages;
    }

    if (rawArgs?.extra_body && typeof rawArgs.extra_body === 'object' && !Array.isArray(rawArgs.extra_body)) {
        payload.extra_body = {
            ...rawArgs.extra_body,
            ...payload.extra_body
        };
    }

    const response = await fetchWithProxy(API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180000)
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`AgnesGen Plugin Error: API request failed with status ${response.status}: ${errorBody}`);
    }

    const responseJson = await response.json();
    const imageData = extractImageData(responseJson);
    if (!imageData) {
        throw new Error("AgnesGen Plugin Error: Failed to extract image URL/base64 from API response. Response: " + JSON.stringify(responseJson));
    }

    const { buffer: imageBuffer, mimeType } = await imageResultToBuffer(imageData);
    const imageExtension = mimeTypeToExtension(mimeType);
    const generatedFileName = `${uuidv4()}.${imageExtension}`;
    const imageDir = path.join(PROJECT_BASE_PATH, 'image', 'agnesgen');
    const localImagePath = path.join(imageDir, generatedFileName);

    await fs.mkdir(imageDir, { recursive: true });
    await fs.writeFile(localImagePath, imageBuffer);

    const accessibleImageUrl = buildAccessibleImageUrl(generatedFileName);
    const modeLabel = args.command === 'generate' ? '文生图' : (args.command === 'compose' ? '多图合成/图生图' : '图生图');
    const content = [
        {
            type: 'text',
            text: `图片已成功生成！\n- 工具: AgnesGen\n- 模型: ${MODEL_ID}\n- 模式: ${modeLabel}\n- 提示词: ${args.prompt}\n- 尺寸: ${args.size}\n- 参考图数量: ${args.images.length}\n- 可访问URL: ${accessibleImageUrl}\n\n【重要】请将上面生成的图片URL转发给用户查看，不要只描述图片内容。`
        }
    ];

    if (showBase64) {
        content.push({
            type: 'image_url',
            image_url: {
                url: `data:${mimeType};base64,${imageBuffer.toString('base64')}`
            }
        });
    }

    return {
        content,
        details: {
            url: accessibleImageUrl,
            serverPath: `image/agnesgen/${generatedFileName}`,
            fileName: generatedFileName,
            model: MODEL_ID,
            mode: args.command,
            prompt: args.prompt,
            size: args.size,
            imageCount: args.images.length,
            showBase64
        }
    };
}

async function main() {
    try {
        const inputChunks = [];
        process.stdin.setEncoding('utf8');

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
            console.log(JSON.stringify({
                status: "error",
                code: e.code,
                error: e.message,
                fileUrl: e.fileUrl
            }));
        } else {
            let detailedError = e.message || "Unknown error";
            if (e.response && e.response.data) {
                detailedError += ` - API Response: ${JSON.stringify(e.response.data)}`;
            }
            const finalErrorMessage = detailedError.startsWith("AgnesGen Plugin Error:")
                ? detailedError
                : `AgnesGen Plugin Error: ${detailedError}`;
            console.log(JSON.stringify({ status: "error", error: finalErrorMessage }));
        }
        process.exit(1);
    }
}

main();