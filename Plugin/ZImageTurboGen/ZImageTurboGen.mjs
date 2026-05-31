#!/usr/bin/env node
import dns from 'dns/promises';
import fs from 'fs/promises';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import fetch, { FormData } from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { fileURLToPath } from 'url';

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
const MAX_INPUT_IMAGE_SIZE = 10 * 1024 * 1024;
const ZIMAGE_INPUT_IMAGE_ROOT = path.resolve(PROJECT_BASE_PATH || process.cwd(), 'image');
const IMAGE_EXT_MIME = new Map([
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'],
    ['.gif', 'image/gif']
]);
const IMAGE_MIME_EXT = new Map([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif']
]);

// --- Proxy Setup ---
const proxyAgent = HTTP_PROXY ? new HttpsProxyAgent(HTTP_PROXY) : null;

function isPathInside(childPath, parentPath) {
    const relative = path.relative(parentPath, childPath);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isBlockedIPv4Address(ip) {
    const parts = ip.split('.').map(part => Number(part));
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
        return false;
    }

    const [a, b] = parts;
    return a === 0
        || a === 10
        || a === 127
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168);
}

function normalizeHostnameForIpCheck(hostname) {
    return String(hostname || '')
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/%25.+$/g, '')
        .replace(/%.+$/g, '');
}

function expandIpv6Address(ip) {
    let address = normalizeHostnameForIpCheck(ip);
    if (!address || !address.includes(':')) return null;

    const dottedIpv4Match = address.match(/(.+:)(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dottedIpv4Match) {
        const parts = dottedIpv4Match[2].split('.').map(part => Number(part));
        if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
            return null;
        }
        const high = ((parts[0] << 8) | parts[1]).toString(16);
        const low = ((parts[2] << 8) | parts[3]).toString(16);
        address = `${dottedIpv4Match[1]}${high}:${low}`;
    }

    const sections = address.split('::');
    if (sections.length > 2) return null;

    const left = sections[0] ? sections[0].split(':').filter(Boolean) : [];
    const right = sections.length === 2 && sections[1] ? sections[1].split(':').filter(Boolean) : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0 || (sections.length === 1 && missing !== 0)) return null;

    const hextets = [
        ...left,
        ...Array(sections.length === 2 ? missing : 0).fill('0'),
        ...right
    ];
    if (hextets.length !== 8) return null;

    const parsed = hextets.map(part => {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return NaN;
        return parseInt(part, 16);
    });

    return parsed.every(part => Number.isInteger(part) && part >= 0 && part <= 0xffff) ? parsed : null;
}

function extractIPv4FromIPv6(ip) {
    const hextets = expandIpv6Address(ip);
    if (!hextets) return null;

    const prefixIsZero = hextets.slice(0, 5).every(part => part === 0);
    const isMapped = prefixIsZero && hextets[5] === 0xffff;
    if (!isMapped) return null;

    const high = hextets[6];
    const low = hextets[7];
    return [
        (high >> 8) & 0xff,
        high & 0xff,
        (low >> 8) & 0xff,
        low & 0xff
    ].join('.');
}

function isBlockedIPv6Address(ip) {
    const hextets = expandIpv6Address(ip);
    if (!hextets) return false;

    const mappedIPv4 = extractIPv4FromIPv6(ip);
    if (mappedIPv4) {
        return isBlockedIPv4Address(mappedIPv4);
    }

    const first = hextets[0];
    const isUnspecified = hextets.every(part => part === 0);
    return isUnspecified
        || (hextets.slice(0, 7).every(part => part === 0) && hextets[7] === 1)
        || (first & 0xfe00) === 0xfc00
        || (first & 0xffc0) === 0xfe80;
}

function isBlockedLocalHostname(hostname) {
    const normalized = normalizeHostnameForIpCheck(hostname);
    if (!normalized) return false;

    if (normalized === 'localhost'
        || normalized.endsWith('.localhost')
        || normalized.endsWith('.local')) {
        return true;
    }

    const ipVersion = net.isIP(normalized);
    if (ipVersion === 4) {
        return isBlockedIPv4Address(normalized);
    }
    if (ipVersion === 6) {
        return isBlockedIPv6Address(normalized);
    }

    return false;
}

async function assertImageInputHostnameIsSafe(parsedUrl) {
    if (isAllowedVcpImageServerUrl(parsedUrl)) {
        return null;
    }

    const hostname = normalizeHostnameForIpCheck(parsedUrl.hostname);
    if (!hostname) {
        throw new Error("Plugin Error: Image input URL must include a hostname.");
    }

    if (isBlockedLocalHostname(hostname)) {
        throw new Error("Plugin Error: 不允许指向本机、链路本地或私有网段地址的图片输入。");
    }

    if (net.isIP(hostname)) return null;

    let records;
    try {
        records = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
        throw new Error(`Plugin Error: Failed to resolve input image hostname: ${hostname}. ${error.message}`);
    }

    if (!Array.isArray(records) || records.length === 0) {
        throw new Error(`Plugin Error: Failed to resolve input image hostname: ${hostname}.`);
    }

    const blockedRecord = records.find(record => record && isBlockedLocalHostname(record.address));
    if (blockedRecord) {
        throw new Error("Plugin Error: 不允许解析到本机、链路本地或私有网段地址的图片输入。");
    }

    return records[0];
}

function shouldBypassProxy(url) {
    try {
        const { hostname } = new URL(url);
        return isBlockedLocalHostname(hostname);
    } catch {
        return false;
    }
}

function createPinnedLookup(lookupAddress) {
    if (!lookupAddress?.address || !lookupAddress?.family) {
        return undefined;
    }

    return (_hostname, _options, callback) => {
        callback(null, lookupAddress.address, lookupAddress.family);
    };
}

function getFetchAgent(parsedUrl, lookupAddress = null) {
    const pinnedLookup = createPinnedLookup(lookupAddress);
    if (pinnedLookup) {
        const agentOptions = { lookup: pinnedLookup };
        return parsedUrl.protocol === 'https:'
            ? new https.Agent(agentOptions)
            : new http.Agent(agentOptions);
    }

    if (proxyAgent && !shouldBypassProxy(parsedUrl.href)) {
        return proxyAgent;
    }

    return undefined;
}

async function fetchWithProxy(url, options = {}, lookupAddress = null) {
    const parsedUrl = new URL(url);
    const agent = getFetchAgent(parsedUrl, lookupAddress);
    return fetch(url, agent ? { ...options, agent } : options);
}

// --- Helper Functions ---

function resolveImageInputUrl(rawUrl, baseUrl = undefined) {
    const parsedUrl = new URL(rawUrl, baseUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error("Plugin Error: Only HTTP(S) image input URLs are supported.");
    }
    if (isAllowedVcpImageServerUrl(parsedUrl)) {
        return parsedUrl;
    }
    if (isBlockedLocalHostname(parsedUrl.hostname)) {
        throw new Error("Plugin Error: 不允许指向本机、链路本地或私有网段地址的图片输入。");
    }
    return parsedUrl;
}

function safeDecodePathname(pathname) {
    try {
        return decodeURIComponent(pathname);
    } catch {
        return pathname;
    }
}

function getAllowedVcpImageServerOrigins() {
    const origins = new Set();

    if (VAR_HTTP_URL && SERVER_PORT) {
        try {
            const localUrl = new URL(VAR_HTTP_URL);
            if (localUrl.protocol === 'http:' || localUrl.protocol === 'https:') {
                localUrl.port = SERVER_PORT;
                origins.add(localUrl.origin);
            }
        } catch {
            // Ignore malformed optional URL configuration.
        }
    }

    if (VAR_HTTPS_URL) {
        try {
            const publicUrl = new URL(VAR_HTTPS_URL);
            if (publicUrl.protocol === 'http:' || publicUrl.protocol === 'https:') {
                origins.add(publicUrl.origin);
            }
        } catch {
            // Ignore malformed optional URL configuration.
        }
    }

    return origins;
}

function isAllowedVcpImageServerUrl(parsedUrl) {
    if (!parsedUrl || !IMAGESERVER_IMAGE_KEY) return false;

    const decodedPath = safeDecodePathname(parsedUrl.pathname);
    if (!decodedPath.startsWith(`/pw=${IMAGESERVER_IMAGE_KEY}/images/`)) {
        return false;
    }

    return getAllowedVcpImageServerOrigins().has(parsedUrl.origin);
}

function normalizeImageMimeType(mimeType, source = 'image input') {
    const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_MIME_EXT.has(normalized)) {
        throw new Error(`Plugin Error: ${source} must be a PNG, JPEG, WEBP, or GIF image.`);
    }
    return normalized;
}

function bufferToImageDataUri(buffer, mimeType, source = 'image input') {
    if (!Buffer.isBuffer(buffer)) {
        throw new Error(`Plugin Error: Invalid ${source} buffer.`);
    }
    if (buffer.length > MAX_INPUT_IMAGE_SIZE) {
        throw new Error(`Plugin Error: ${source} exceeds ${MAX_INPUT_IMAGE_SIZE} bytes.`);
    }
    const normalizedMime = normalizeImageMimeType(mimeType, source);
    return `data:${normalizedMime};base64,${buffer.toString('base64')}`;
}

function normalizeDataUriInput(input) {
    const match = input.match(/^data:(image\/[^;]+);base64,([\s\S]+)$/);
    if (!match) {
        throw new Error("Plugin Error: Invalid image data URI.");
    }
    const mimeType = normalizeImageMimeType(match[1], 'image data URI');
    const base64 = match[2].replace(/\s/g, '');
    const estimatedBytes = Math.floor((base64.length * 3) / 4);
    if (estimatedBytes > MAX_INPUT_IMAGE_SIZE) {
        throw new Error(`Plugin Error: image data URI exceeds ${MAX_INPUT_IMAGE_SIZE} bytes.`);
    }
    return `data:${mimeType};base64,${base64}`;
}

async function readResponseBodyWithLimit(response, maxBytes, source = 'response body') {
    const body = response.body;
    if (!body) {
        throw new Error(`Plugin Error: ${source} is missing a response body.`);
    }

    const chunks = [];
    let totalBytes = 0;

    try {
        for await (const chunk of body) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buffer.length;
            if (totalBytes > maxBytes) {
                if (typeof body.destroy === 'function') {
                    body.destroy();
                } else if (typeof body.cancel === 'function') {
                    await body.cancel().catch(() => {});
                }
                throw new Error(`Plugin Error: ${source} exceeds ${maxBytes} bytes.`);
            }
            chunks.push(buffer);
        }
    } catch (error) {
        if (typeof body.destroy === 'function' && !body.destroyed) {
            body.destroy();
        }
        throw error;
    }

    return Buffer.concat(chunks, totalBytes);
}

async function fetchRemoteImageInput(rawUrl, redirectCount = 0) {
    if (redirectCount > 5) {
        throw new Error("Plugin Error: 图片下载重定向次数过多。");
    }

    const parsedUrl = resolveImageInputUrl(rawUrl);
    const lookupAddress = await assertImageInputHostnameIsSafe(parsedUrl);
    const response = await fetchWithProxy(parsedUrl.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(60000),
    }, lookupAddress);

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        const redirectUrl = resolveImageInputUrl(response.headers.get('location'), parsedUrl.href);
        return fetchRemoteImageInput(redirectUrl.href, redirectCount + 1);
    }

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`Plugin Error: Failed to download input image from URL: ${parsedUrl.href}. HTTP ${response.status}. ${errorBody}`);
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_INPUT_IMAGE_SIZE) {
        throw new Error(`Plugin Error: remote image input exceeds ${MAX_INPUT_IMAGE_SIZE} bytes.`);
    }

    const mimeType = normalizeImageMimeType(response.headers.get('content-type') || '', 'remote image input');
    const buffer = await readResponseBodyWithLimit(response, MAX_INPUT_IMAGE_SIZE, 'remote image input');
    return bufferToImageDataUri(buffer, mimeType, 'remote image input');
}

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
    const showBase64 = args.showbase64 === true || args.showbase64 === 'true' || args.showBase64 === true || args.showBase64 === 'true';

    if (!PROJECT_BASE_PATH || !SERVER_PORT || !IMAGESERVER_IMAGE_KEY || !VAR_HTTP_URL) {
        throw new Error("Plugin Error: Missing one or more required environment variables (PROJECT_BASE_PATH, SERVER_PORT, etc).");
    }
    if (!isValidArgs(args)) {
        throw new Error(`Plugin Error: Invalid arguments provided: ${JSON.stringify(rawArgs)}.`);
    }

    if (args.command === 'EditImage') {
        return await processEditRequest(args, showBase64);
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

    const content = [
        {
            type: 'text',
            text: `图片已成功生成！\n- 提示词: ${args.prompt}${payload.negative_prompt ? `\n- 负面提示词: ${payload.negative_prompt}` : ''}\n- 分辨率: ${payload.size}\n- 推理步数: ${payload.num_inference_steps}\n- 随机种子(Seed): ${payload.seed}\n- 可访问URL: ${accessibleImageUrl}\n\n【重要】请将上面生成的图片Url转发给用户查看，不要只描述图片内容。`
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

    return {
        content,
        details: {
            url: accessibleImageUrl
        }
    };
}

function dataUriToBlob(dataUri, index) {
    const match = dataUri.match(/^data:(image\/[^;]+);base64,([\s\S]+)$/);
    if (!match) {
        throw new Error("Plugin Error: Invalid image data URI.");
    }

    const mimeType = normalizeImageMimeType(match[1], 'image data URI');
    const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (buffer.length > MAX_INPUT_IMAGE_SIZE) {
        throw new Error(`Plugin Error: image data URI exceeds ${MAX_INPUT_IMAGE_SIZE} bytes.`);
    }
    const extension = IMAGE_MIME_EXT.get(mimeType) || 'png';
    return {
        blob: new Blob([buffer], { type: mimeType }),
        filename: `input_${index + 1}.${extension}`
    };
}

async function imageInputToDataUri(imageInput) {
    if (!imageInput || typeof imageInput !== 'string') {
        throw new Error("Plugin Error: Image input must be a non-empty string.");
    }

    const input = imageInput.trim();
    if (input.startsWith('data:image/')) {
        return normalizeDataUriInput(input);
    }

    if (input.startsWith('http://') || input.startsWith('https://')) {
        return fetchRemoteImageInput(input);
    }

    if (input.startsWith('file://')) {
        try {
            const filePath = fileURLToPath(input);
            const resolved = path.resolve(filePath);
            if (!isPathInside(resolved, ZIMAGE_INPUT_IMAGE_ROOT)) {
                throw new Error("Plugin Error: 本地图片路径仅允许位于项目 image/ 目录下。");
            }
            const stat = await fs.stat(resolved);
            if (!stat.isFile()) {
                throw new Error("Plugin Error: Local image input must be a file.");
            }
            if (stat.size > MAX_INPUT_IMAGE_SIZE) {
                throw new Error(`Plugin Error: local image input exceeds ${MAX_INPUT_IMAGE_SIZE} bytes.`);
            }
            const ext = path.extname(resolved).toLowerCase();
            const mimeType = IMAGE_EXT_MIME.get(ext);
            if (!mimeType) {
                throw new Error("Plugin Error: Local image input must be a PNG, JPEG, WEBP, or GIF file.");
            }
            const buffer = await fs.readFile(resolved);
            return bufferToImageDataUri(buffer, mimeType, 'local image input');
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
        const base64 = input.replace(/\s/g, '');
        const estimatedBytes = Math.floor((base64.length * 3) / 4);
        if (estimatedBytes > MAX_INPUT_IMAGE_SIZE) {
            throw new Error(`Plugin Error: raw base64 image input exceeds ${MAX_INPUT_IMAGE_SIZE} bytes.`);
        }
        return `data:image/png;base64,${base64}`;
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

async function processEditRequest(args, showBase64 = false) {
    const dataUris = [];
    for (const imageInput of args.images) {
        dataUris.push(await imageInputToDataUri(imageInput));
    }

    const formData = new FormData();
    const editSize = args.size || args.resolution || '2048x2048';
    const editModel = args.model || args.edit_model || 'LongCat-Image-Edit';

    formData.append('model', editModel);
    formData.append('prompt', args.prompt);
    formData.append('mask', args.mask || '');
    formData.append('size', editSize);
    formData.append('user', args.user || 'VCPToolBox');
    formData.append('n', String(Math.min(Math.max(parseInt(args.n || args.count || '1', 10) || 1, 1), 1)));
    formData.append('response_format', args.response_format || 'b64_json');
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

    dataUris.forEach((dataUri, index) => {
        // Do not submit local/LAN image-server URLs to Gitee.
        // Convert every input to base64/data URI first, then upload it as a multipart file field.
        const { blob, filename } = dataUriToBlob(dataUri, index);
        formData.append('image', blob, filename);
    });

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
    const outputBase64 = task.output?.b64_json || task.output?.image_base64 || task.output?.base64;
    let imageBuffer;
    let imageMimeType = 'image/png';

    if (outputBase64) {
        imageBuffer = Buffer.from(String(outputBase64).replace(/^data:image\/[^;]+;base64,/, '').replace(/\s/g, ''), 'base64');
    } else if (outputUrl) {
        const imageResponse = await fetchWithProxy(outputUrl, {
            signal: AbortSignal.timeout(60000),
        });
        if (!imageResponse.ok) {
            throw new Error(`Failed to download edited image from URL: ${outputUrl}`);
        }

        const arrayBuf = await imageResponse.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuf);
        imageMimeType = imageResponse.headers.get('content-type') || 'image/png';
    } else {
        throw new Error("Plugin Error: Edit task succeeded but no output.file_url or output base64 was returned. Response: " + JSON.stringify(task));
    }
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

    const content = [
        {
            type: 'text',
            text: `图片已成功编辑！\n- 提示词: ${args.prompt}\n- 参考图数量: ${dataUris.length}\n- 模型: ${editModel}\n- 尺寸: ${editSize}\n- 任务ID: ${taskId}\n- 可访问URL: ${accessibleImageUrl}\n\n【重要】请将上面生成的图片Url转发给用户查看，不要只描述图片内容。`
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

    return {
        content,
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
