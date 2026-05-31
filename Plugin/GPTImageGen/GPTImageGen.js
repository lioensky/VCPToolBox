#!/usr/bin/env node
/**
 * GPTImageGen - GPT Image 2 图像生成插件
 * 
 * 通过 OpenAI 兼容 API 调用 gpt-image-2 模型进行图像生成。
 * 零外部依赖，仅使用 Node.js 原生模块。
 * 
 * 通信协议：stdio JSON（VCP 插件标准协议）
 * 流程：stdin 接收 JSON 参数 → 解析命令 → 调用 API → 保存图像到本地 → stdout 输出 JSON 结果
 * 
 * @author 小飒 (Xiaosa) & infinite-vector
 * @version 1.1.0
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { URL } from 'url';

// ============================================================
// 环境变量读取
// ============================================================

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
const GPT_IMAGE_MODEL = process.env.GPT_IMAGE_MODEL || 'gpt-image-2';
const DEFAULT_SIZE = process.env.DEFAULT_SIZE || '1024x1024';
const DEFAULT_QUALITY = process.env.DEFAULT_QUALITY || 'auto';
const DEFAULT_RESPONSE_FORMAT = process.env.DEFAULT_RESPONSE_FORMAT || 'url';
const DEFAULT_BACKGROUND = process.env.DEFAULT_BACKGROUND || 'auto';
const DEBUG = process.env.DebugMode === 'true';

// Chat Completions 模式：某些兼容渠道不支持 /v1/images/generations，
// 而是通过 /v1/chat/completions + 内置 image_generation tool 来生成图片
const USE_CHAT_COMPLETIONS_MODE = process.env.USE_CHAT_COMPLETIONS_MODE === 'true';

// 重试配置
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '2', 10);
const RETRY_BASE_DELAY_MS = parseInt(process.env.RETRY_BASE_DELAY_MS || '2000', 10);

// 图生图单图大小限制 (bytes)
const MAX_IMAGE_SIZE = 4 * 1024 * 1024; // 4MB — OpenAI /v1/images/edits 端点限制

// VCP 全局注入的环境变量
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH || process.cwd();
const SERVER_PORT = process.env.SERVER_PORT || '5000';
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY || '';
const VAR_HTTP_URL = process.env.VarHttpUrl || 'http://localhost';

// ============================================================
// 工具函数
// ============================================================

/**
 * 输出结果并退出进程
 * @param {object} result - 包含 status 和 result/error 的结果对象
 */
function outputAndExit(result) {
    const code = result.status === 'success' ? 0 : 1;
    const payload = JSON.stringify(result);

    // 先结束 stdout，尽量确保父进程在 Windows/shell 场景下稳定收到完整 JSON
    process.stdout.write(payload);
    process.stdout.end(() => {
        process.exit(code);
    });
}

/**
 * 调试日志（仅在 DebugMode=true 时输出到 stderr）
 */
function debugLog(...args) {
    if (DEBUG) console.error('[GPTImageGen DEBUG]', ...args);
}

/**
 * 验证尺寸参数
 * gpt-image-2 支持灵活尺寸，规则：最长边 ≤ 3840，格式为 WIDTHxHEIGHT
 * @param {string} size - 尺寸字符串
 * @returns {boolean}
 */
function isValidSize(size) {
    const match = size.match(/^(\d+)x(\d+)$/);
    if (!match) return false;
    const width = parseInt(match[1], 10);
    const height = parseInt(match[2], 10);
    // gpt-image-2 规则：最长边不超过 3840，最短边至少 256
    return width >= 256 && height >= 256 && Math.max(width, height) <= 3840;
}

/**
 * 验证质量参数
 * @param {string} quality - 质量字符串
 * @returns {boolean}
 */
function isValidQuality(quality) {
    const validQualities = ['low', 'medium', 'high', 'auto'];
    return validQualities.includes(quality);
}

/**
 * 验证背景参数
 * 注意：gpt-image-2 官方 API 不支持 transparent，仅 opaque/auto。
 * 此处保留 transparent 以兼容部分反代实现，但实际效果取决于 API 端点。
 * @param {string} background - 背景字符串
 * @returns {boolean}
 */
function isValidBackground(background) {
    const validBackgrounds = ['transparent', 'opaque', 'auto'];
    return validBackgrounds.includes(background);
}

/**
 * 根据 Content-Type 或文件扩展名推断图片扩展名
 * @param {string} [contentType] - HTTP Content-Type header
 * @param {string} [urlOrPath] - URL 或文件路径（fallback）
 * @returns {string} 文件扩展名（不含点号）
 */
function inferImageExtension(contentType, urlOrPath) {
    // 优先从 Content-Type 推断（学 DoubaoGen 的 httpsDownload 模式）
    if (contentType) {
        const ct = contentType.toLowerCase();
        if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
        if (ct.includes('webp')) return 'webp';
        if (ct.includes('gif')) return 'gif';
        if (ct.includes('png')) return 'png';
    }
    // fallback: 从 URL/路径的扩展名推断
    if (urlOrPath) {
        if (/\.jpe?g/i.test(urlOrPath)) return 'jpg';
        if (/\.webp/i.test(urlOrPath)) return 'webp';
        if (/\.gif/i.test(urlOrPath)) return 'gif';
        if (/\.png/i.test(urlOrPath)) return 'png';
    }
    return 'png'; // 默认 PNG
}

// ============================================================
// HTTP 请求封装
// ============================================================

/**
 * 通用 HTTP/HTTPS 请求函数（零依赖）
 * 根据 URL 协议自动选择 http 或 https 模块
 * 
 * @param {string} url - 完整请求 URL
 * @param {object} options - 请求选项（method, headers 等）
 * @param {string|Buffer|null} body - 请求体
 * @returns {Promise<{statusCode: number, headers: object, body: string}>}
 */
function tryExtractCompleteJson(text) {
    if (!text || typeof text !== 'string') return null;

    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

    try {
        return JSON.parse(trimmed);
    } catch {
        // 继续尝试从前缀中提取完整 JSON
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    const opening = trimmed[0];
    const closing = opening === '{' ? '}' : ']';

    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }

        if (ch === opening) depth++;
        if (ch === closing) {
            depth--;
            if (depth === 0) {
                const candidate = trimmed.slice(0, i + 1);
                try {
                    return JSON.parse(candidate);
                } catch {
                    return null;
                }
            }
        }
    }

    return null;
}

function httpRequest(url, options = {}, body = null) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const transport = parsedUrl.protocol === 'https:' ? https : http;

        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || 'GET',
            headers: options.headers || {},
            timeout: options.timeout || 300000 // 默认 5 分钟超时
        };

        debugLog(`HTTP ${reqOptions.method} ${url}`);

        let settled = false;
        const settle = (fn, value) => {
            if (settled) return;
            settled = true;
            fn(value);
        };

        const req = transport.request(reqOptions, (res) => {
            const chunks = [];
            let chunkCount = 0;

            const finalize = () => {
                const responseBody = Buffer.concat(chunks).toString('utf-8');
                settle(resolve, {
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: responseBody
                });
            };

            res.on('data', (chunk) => {
                if (settled) return;

                chunks.push(chunk);
                chunkCount++;

                // 对 200 + JSON 响应尝试提前提取完整 JSON，避免兼容渠道迟迟不结束连接
                const contentType = String(res.headers['content-type'] || '').toLowerCase();
                const shouldTryEarlyJson =
                    res.statusCode === 200 &&
                    (contentType.includes('application/json') || contentType.includes('text/json') || contentType === '');

                if (shouldTryEarlyJson) {
                    const partialBody = Buffer.concat(chunks).toString('utf-8');
                    const parsed = tryExtractCompleteJson(partialBody);

                    if (parsed) {
                        debugLog(`HTTP early JSON extraction succeeded after ${chunkCount} chunk(s), destroying response stream early.`);
                        settled = true;
                        res.destroy();
                        req.destroy();
                        resolve({
                            statusCode: res.statusCode,
                            headers: res.headers,
                            body: JSON.stringify(parsed)
                        });
                    }
                }
            });

            res.on('end', () => {
                if (settled) return;
                finalize();
            });

            res.on('error', (err) => {
                if (settled) return;
                settle(reject, new Error(`HTTP response failed: ${err.message}`));
            });
        });

        req.on('error', (err) => {
            if (settled) return;
            settle(reject, new Error(`HTTP request failed: ${err.message}`));
        });

        req.on('timeout', () => {
            if (settled) return;
            req.destroy();
            settle(reject, new Error('HTTP request timed out'));
        });

        if (body) {
            req.write(body);
        }

        req.end();
    });
}

/**
 * 带指数退避重试的 HTTP 请求包装器
 * 对 429 (Rate Limit) 和 503 (Service Unavailable) 自动重试
 * 
 * @param {string} url - 完整请求 URL
 * @param {object} options - 请求选项
 * @param {string|Buffer|null} body - 请求体
 * @returns {Promise<{statusCode: number, headers: object, body: string}>}
 */
async function httpRequestWithRetry(url, options = {}, body = null) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const response = await httpRequest(url, options, body);

        // 对可重试的状态码进行指数退避重试
        if ((response.statusCode === 429 || response.statusCode === 503) && attempt < MAX_RETRIES) {
            const delay = RETRY_BASE_DELAY_MS * Math.pow(3, attempt); // 2s → 6s → 18s
            debugLog(`Received ${response.statusCode}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
            await new Promise(r => setTimeout(r, delay));
            continue;
        }

        return response;
    }
    // 理论上不会到达这里，但以防万一
    return httpRequest(url, options, body);
}

/**
 * 下载远程图片
 * 返回 Buffer 和 Content-Type（学 DoubaoGen 的 httpsDownload 模式）
 * 
 * @param {string} url - 图片 URL
 * @returns {Promise<{data: Buffer, contentType: string}>}
 */
function downloadImage(url) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const transport = parsedUrl.protocol === 'https:' ? https : http;

        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            timeout: 60000
        };

        const req = transport.request(reqOptions, (res) => {
            // 处理重定向
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                downloadImage(res.headers.location).then(resolve).catch(reject);
                return;
            }

            if (res.statusCode !== 200) {
                reject(new Error(`Failed to download image: HTTP ${res.statusCode}`));
                return;
            }

            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                data: Buffer.concat(chunks),
                contentType: res.headers['content-type'] || ''
            }));
        });

        req.on('error', (err) => reject(new Error(`Image download failed: ${err.message}`)));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Image download timed out'));
        });
        req.end();
    });
}

// ============================================================
// 图片输入处理
// ============================================================

function parseImageArrayInput(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value !== 'string') return value ? [value] : [];

    const trimmed = value.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('[')) {
        try {
            const sanitized = trimmed.replace(/\\/g, '\\\\');
            const parsed = JSON.parse(sanitized);
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
            if (typeof item === 'string' && item.trim()) images.push(item.trim());
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

/**
 * 处理图片输入，支持多种格式：
 * - data:image/... base64 data URI
 * - http:// 或 https:// URL
 * - 本地文件路径（相对于 PROJECT_BASE_PATH）
 *
 * 返回 data URI 格式（API 需要的格式）
 *
 * @param {string} imageInput - 图片输入
 * @returns {Promise<string>} data URI 格式的图片
 */
async function processImageInput(imageInput) {
    if (!imageInput || typeof imageInput !== 'string') {
        throw new Error('图片输入不能为空');
    }

    const input = imageInput.trim();

    // 已经是 data URI
    if (input.startsWith('data:image/')) {
        debugLog('Image input: data URI (direct pass-through)');
        // 校验 data URI 的大小
        const commaIdx = input.indexOf(',');
        if (commaIdx > 0) {
            const base64Part = input.substring(commaIdx + 1);
            const estimatedSize = Math.ceil(base64Part.length * 3 / 4);
            if (estimatedSize > MAX_IMAGE_SIZE) {
                throw new Error(`图片大小约 ${(estimatedSize / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_IMAGE_SIZE / 1024 / 1024}MB 限制。请压缩后重试。`);
            }
        }
        return input;
    }

    // HTTP/HTTPS URL
    if (input.startsWith('http://') || input.startsWith('https://')) {
        debugLog('Image input: URL, downloading...', input.substring(0, 100));
        const { data: buffer, contentType } = await downloadImage(input);
        // 校验下载后的文件大小
        if (buffer.length > MAX_IMAGE_SIZE) {
            throw new Error(`下载的图片大小 ${(buffer.length / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_IMAGE_SIZE / 1024 / 1024}MB 限制。请使用更小的图片或压缩后重试。`);
        }
        const base64 = buffer.toString('base64');
        // 从 Content-Type 推断 MIME，fallback 到 URL 扩展名
        const ext = inferImageExtension(contentType, input);
        const mimeMap = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
        const mime = mimeMap[ext] || 'image/png';
        return `data:${mime};base64,${base64}`;
    }

    // 本地文件路径
    let filePath = input;
    if (input.startsWith('file:///')) {
        filePath = input.replace('file:///', '');
    }

    // 相对路径转绝对路径
    if (!path.isAbsolute(filePath)) {
        filePath = path.join(PROJECT_BASE_PATH, filePath);
    }

    // 安全检查
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`图片文件不存在: ${filePath}`);
    }

    debugLog('Image input: local file', resolved);
    const buffer = fs.readFileSync(resolved);
    // 校验本地文件大小
    if (buffer.length > MAX_IMAGE_SIZE) {
        throw new Error(`图片文件大小 ${(buffer.length / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_IMAGE_SIZE / 1024 / 1024}MB 限制。请压缩后重试。`);
    }
    const base64 = buffer.toString('base64');
    const ext = path.extname(resolved).toLowerCase();
    const mime = ext === '.png' ? 'image/png' :
        ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
            ext === '.webp' ? 'image/webp' :
                ext === '.gif' ? 'image/gif' : 'image/png';
    return `data:${mime};base64,${base64}`;
}

// ============================================================
// 核心 API 调用
// ============================================================

function normalizeImageItem(item) {
    if (!item) return {};

    if (typeof item === 'string') {
        if (/^https?:\/\//i.test(item)) return { url: item };
        if (/^data:image\/[^;]+;base64,/i.test(item)) return { data_uri: item };
        return { b64_json: item };
    }

    if (typeof item !== 'object') return {};

    return {
        b64_json: item.b64_json || item.base64 || item.image_base64,
        data_uri: item.data_uri || item.dataUrl || item.image_data || item.image,
        url: item.url || item.image_url
    };
}

function normalizeImageApiResponseBody(parsed) {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('API 响应不是有效对象');
    }

    if (Array.isArray(parsed.data) && parsed.data.length > 0) {
        return {
            ...parsed,
            data: parsed.data.map(normalizeImageItem)
        };
    }

    // 兼容部分 OpenAI 兼容渠道：直接返回单个图片对象而不是 { data: [...] }
    if (parsed.b64_json || parsed.base64 || parsed.image_base64 || parsed.url || parsed.data_uri || parsed.image) {
        return {
            ...parsed,
            data: [normalizeImageItem(parsed)]
        };
    }

    // 兼容部分渠道：返回 images/imageUrls/urls 数组
    const candidateArrays = [parsed.images, parsed.imageUrls, parsed.urls];
    for (const arr of candidateArrays) {
        if (Array.isArray(arr) && arr.length > 0) {
            return {
                ...parsed,
                data: arr.map(normalizeImageItem)
            };
        }
    }

    throw new Error(`API 响应中缺少有效的图像数据。响应: ${JSON.stringify(parsed).substring(0, 300)}`);
}

/**
 * 通用 API 响应解析器
 * @param {object} response - httpRequest 返回的响应
 * @returns {object} 解析后的 API 响应体
 */
function parseApiResponse(response) {
    debugLog('API Response Status:', response.statusCode);
    debugLog('API Response Body (first 500 chars):', response.body.substring(0, 500));

    if (response.statusCode === 200) {
        let parsed;
        try {
            parsed = JSON.parse(response.body);
        } catch (e) {
            throw new Error(`API 返回了无效的 JSON 响应: ${response.body.substring(0, 200)}`);
        }

        return normalizeImageApiResponseBody(parsed);
    }

    // 错误处理
    let errorDetail = '';
    try {
        const errorBody = JSON.parse(response.body);
        errorDetail = errorBody.error?.message || errorBody.message || JSON.stringify(errorBody);
    } catch {
        errorDetail = response.body.substring(0, 300);
    }

    switch (response.statusCode) {
        case 429:
            throw new Error(`API 请求被限流（429 Too Many Requests），已重试 ${MAX_RETRIES} 次仍失败。详情: ${errorDetail}`);
        case 401:
            throw new Error(`API 认证失败（401 Unauthorized），请检查 OPENAI_API_KEY 配置。详情: ${errorDetail}`);
        case 403:
            throw new Error(`API 访问被拒绝（403 Forbidden），请检查 API Key 权限。详情: ${errorDetail}`);
        case 400:
            throw new Error(`API 请求参数错误（400 Bad Request）。详情: ${errorDetail}`);
        case 404:
            throw new Error(`API 端点不存在（404 Not Found）。详情: ${errorDetail}`);
        case 405:
            throw new Error(`API 方法不被允许（405 Method Not Allowed）。详情: ${errorDetail}`);
        case 503:
            throw new Error(`API 服务不可用（503 Service Unavailable），已重试 ${MAX_RETRIES} 次仍失败。详情: ${errorDetail}`);
        default:
            throw new Error(`API 请求失败（HTTP ${response.statusCode}）。详情: ${errorDetail}`);
    }
}

function buildImageGenerationUrls() {
    const normalizedBase = OPENAI_BASE_URL.replace(/\/+$/, '');
    const urls = [];

    // 标准 OpenAI 兼容写法
    urls.push(`${normalizedBase}/v1/images/generations`);

    // 某些兼容渠道直接把文生图挂在 /v1/images
    if (!/\/v1\/images$/i.test(normalizedBase)) {
        urls.push(`${normalizedBase}/v1/images`);
    }

    return [...new Set(urls)];
}

/**
 * 判断错误是否属于"渠道不支持 images 端点，需要走 Chat Completions 模式"的情况
 * @param {Error|string} error - 错误对象或错误消息
 * @returns {boolean}
 */
function shouldFallbackToChatCompletions(error) {
    const msg = error && error.message ? error.message : String(error);
    // 典型特征：渠道把图像生成实现为 chat completions 的内置 tool
    return /tool.?choice.*not found|image_generation.*not found|tools.*parameter/i.test(msg);
}

/**
 * 通过 Chat Completions API + 内置 image_generation tool 生成图片
 *
 * 某些 OpenAI 兼容渠道不提供 /v1/images/generations 端点，
 * 而是要求通过 /v1/chat/completions 配合 tool_choice 来触发图像生成。
 *
 * @param {object} params - 生成参数
 * @returns {Promise<object>} 标准化的图像 API 响应体（与 images/generations 格式一致）
 */
async function callImageAPIViaChatCompletions(params) {
    const normalizedBase = OPENAI_BASE_URL.replace(/\/+$/, '');
    const apiUrl = `${normalizedBase}/v1/chat/completions`;

    debugLog('Chat Completions mode: using', apiUrl);

    // 构建 Chat Completions 请求体，使用内置 image_generation tool
    const requestBody = {
        model: GPT_IMAGE_MODEL,
        messages: [
            {
                role: 'user',
                content: params.prompt
            }
        ],
        tools: [
            {
                type: 'function',
                function: {
                    name: 'image_generation',
                    description: 'Generate an image based on the prompt',
                    parameters: {
                        type: 'object',
                        properties: {
                            prompt: {
                                type: 'string',
                                description: 'The image generation prompt'
                            },
                            size: {
                                type: 'string',
                                description: 'Image size in WIDTHxHEIGHT format'
                            },
                            quality: {
                                type: 'string',
                                description: 'Image quality: low, medium, high, auto'
                            },
                            background: {
                                type: 'string',
                                description: 'Background: transparent, opaque, auto'
                            },
                            n: {
                                type: 'number',
                                description: 'Number of images to generate'
                            }
                        },
                        required: ['prompt']
                    }
                }
            }
        ],
        tool_choice: {
            type: 'function',
            function: { name: 'image_generation' }
        }
    };

    const bodyStr = JSON.stringify(requestBody);
    debugLog('Chat Completions Request Body:', bodyStr.substring(0, 800));

    const response = await httpRequestWithRetry(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Accept': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr)
        },
        timeout: 300000
    }, bodyStr);

    debugLog('Chat Completions Response Status:', response.statusCode);
    debugLog('Chat Completions Response Body (first 800 chars):', response.body.substring(0, 800));

    if (response.statusCode !== 200) {
        // 复用标准错误解析
        parseApiResponse(response);
    }

    let parsed;
    try {
        parsed = JSON.parse(response.body);
    } catch (e) {
        throw new Error(`Chat Completions API 返回了无效的 JSON 响应: ${response.body.substring(0, 200)}`);
    }

    // 从 Chat Completions 响应中提取图像数据
    // 响应格式可能有多种变体，需要逐一尝试
    return extractImageFromChatResponse(parsed);
}

/**
 * 从 Chat Completions 响应中提取图像数据，转换为标准 images API 格式
 *
 * 兼容多种渠道的响应格式：
 * 1. choices[0].message.tool_calls[0].function.arguments 中包含图片数据
 * 2. choices[0].message.content 中直接包含 base64 或 URL
 * 3. 响应顶层直接包含 data 数组（某些渠道的透传模式）
 *
 * @param {object} parsed - 解析后的 Chat Completions 响应
 * @returns {object} 标准化的 { data: [{b64_json?, url?}] } 格式
 */
function extractImageFromChatResponse(parsed) {
    // 情况 0：响应本身已经是标准 images API 格式（某些渠道直接透传）
    if (Array.isArray(parsed.data) && parsed.data.length > 0) {
        debugLog('Chat Completions: response already in standard images format');
        return normalizeImageApiResponseBody(parsed);
    }

    // 情况 1：从 tool_calls 中提取
    const choices = parsed.choices;
    if (Array.isArray(choices) && choices.length > 0) {
        const message = choices[0].message;

        if (message) {
            // 1a: tool_calls 中的 function arguments
            if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                for (const toolCall of message.tool_calls) {
                    if (toolCall.function && toolCall.function.name === 'image_generation') {
                        let toolArgs;
                        try {
                            toolArgs = JSON.parse(toolCall.function.arguments);
                        } catch {
                            toolArgs = {};
                        }

                        // 某些渠道在 arguments 中返回图片数据
                        if (toolArgs.url || toolArgs.b64_json || toolArgs.image_url || toolArgs.base64) {
                            debugLog('Chat Completions: extracted image from tool_calls arguments');
                            return { data: [normalizeImageItem(toolArgs)] };
                        }

                        // 某些渠道在 arguments.result 中返回
                        if (toolArgs.result) {
                            if (typeof toolArgs.result === 'string') {
                                return { data: [normalizeImageItem(toolArgs.result)] };
                            }
                            if (typeof toolArgs.result === 'object') {
                                return normalizeImageApiResponseBody(toolArgs.result);
                            }
                        }
                    }
                }
            }

            // 1b: message.content 中包含图片数据
            if (message.content) {
                // content 可能是字符串或数组
                if (typeof message.content === 'string') {
                    const content = message.content.trim();

                    // 尝试解析为 JSON
                    try {
                        const contentParsed = JSON.parse(content);
                        if (contentParsed.data || contentParsed.url || contentParsed.b64_json) {
                            debugLog('Chat Completions: extracted image from message.content (JSON string)');
                            return normalizeImageApiResponseBody(contentParsed);
                        }
                    } catch {
                        // 不是 JSON，检查是否是 URL 或 base64
                    }

                    // 检查是否直接是 URL
                    if (/^https?:\/\/.+\.(png|jpg|jpeg|webp|gif)/i.test(content)) {
                        debugLog('Chat Completions: extracted image URL from message.content');
                        return { data: [{ url: content }] };
                    }

                    // 检查是否是 base64 数据
                    if (/^data:image\/[^;]+;base64,/i.test(content)) {
                        debugLog('Chat Completions: extracted data URI from message.content');
                        return { data: [normalizeImageItem(content)] };
                    }

                    // 尝试从文本中提取 URL
                    const urlMatch = content.match(/https?:\/\/[^\s"'<>]+\.(png|jpg|jpeg|webp|gif)(\?[^\s"'<>]*)?/i);
                    if (urlMatch) {
                        debugLog('Chat Completions: extracted image URL from message.content text');
                        return { data: [{ url: urlMatch[0] }] };
                    }
                }

                // content 是数组格式（multimodal response）
                if (Array.isArray(message.content)) {
                    const imageItems = [];
                    for (const part of message.content) {
                        if (part.type === 'image_url' && part.image_url?.url) {
                            imageItems.push(normalizeImageItem(part.image_url.url));
                        } else if (part.type === 'image' && (part.url || part.b64_json || part.data)) {
                            imageItems.push(normalizeImageItem(part));
                        }
                    }
                    if (imageItems.length > 0) {
                        debugLog('Chat Completions: extracted', imageItems.length, 'image(s) from multimodal content');
                        return { data: imageItems };
                    }
                }
            }
        }
    }

    // 情况 2：某些渠道在顶层返回非标准字段
    if (parsed.image || parsed.image_url || parsed.b64_json || parsed.url) {
        debugLog('Chat Completions: extracted image from top-level fields');
        return { data: [normalizeImageItem(parsed)] };
    }

    // 无法提取图像数据
    throw new Error(`Chat Completions 模式：无法从响应中提取图像数据。响应结构: ${JSON.stringify(parsed).substring(0, 500)}`);
}

/**
 * 调用 OpenAI 兼容的 images/generations API（文生图）
 *
 * 兼容三类渠道：
 * 1. 标准端点：/v1/images/generations
 * 2. 某些反代端点：/v1/images
 * 3. Chat Completions 模式：/v1/chat/completions + image_generation tool
 *
 * @param {object} params - 生成参数
 * @returns {Promise<object>} API 响应体
 */
async function callImageAPI(params) {
    // 如果配置了直接使用 Chat Completions 模式，跳过标准端点尝试
    if (USE_CHAT_COMPLETIONS_MODE) {
        debugLog('USE_CHAT_COMPLETIONS_MODE=true, directly using Chat Completions path');
        return await callImageAPIViaChatCompletions(params);
    }

    const apiUrls = buildImageGenerationUrls();

    const requestBody = {
        model: GPT_IMAGE_MODEL,
        prompt: params.prompt,
        n: params.n,
        size: params.size,
        quality: params.quality,
        background: params.background,
        response_format: params.response_format
    };

    const bodyStr = JSON.stringify(requestBody);
    debugLog('API Request Candidate URLs:', JSON.stringify(apiUrls));
    debugLog('API Request Body:', bodyStr.substring(0, 500));

    let lastError = null;

    for (let i = 0; i < apiUrls.length; i++) {
        const apiUrl = apiUrls[i];
        try {
            debugLog(`Trying image generation endpoint [${i + 1}/${apiUrls.length}]:`, apiUrl);

            const response = await httpRequestWithRetry(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Accept': 'application/json',
                    'Content-Length': Buffer.byteLength(bodyStr)
                },
                timeout: 300000
            }, bodyStr);

            // 若当前候选端点返回 404/405，则自动尝试下一个候选端点
            if ((response.statusCode === 404 || response.statusCode === 405) && i < apiUrls.length - 1) {
                debugLog(`Endpoint ${apiUrl} returned ${response.statusCode}, trying next candidate endpoint.`);
                continue;
            }

            return parseApiResponse(response);
        } catch (error) {
            lastError = error;
            const msg = error && error.message ? error.message : String(error);

            // 检测是否需要回退到 Chat Completions 模式
            if (shouldFallbackToChatCompletions(error)) {
                debugLog(`Standard images endpoint failed with tool_choice error, falling back to Chat Completions mode. Error: ${msg}`);
                return await callImageAPIViaChatCompletions(params);
            }

            // 仅对明显的"端点不匹配"错误尝试下一个候选端点
            if ((/HTTP 404|HTTP 405|404 Not Found|405 Method Not Allowed/i.test(msg)) && i < apiUrls.length - 1) {
                debugLog(`Endpoint ${apiUrl} failed with endpoint-like error, trying next candidate. Error: ${msg}`);
                continue;
            }

            throw error;
        }
    }

    throw lastError || new Error('图像生成请求失败：没有可用的 API 端点');
}

/**
 * 构建 multipart/form-data 请求体（零依赖实现）
 *
 * @param {string} boundary - multipart 边界字符串
 * @param {Array<{name: string, value: string|Buffer, filename?: string, contentType?: string}>} fields - 表单字段
 * @returns {Buffer} 完整的 multipart 请求体
 */
function buildMultipartBody(boundary, fields) {
    const parts = [];

    for (const field of fields) {
        let header = `--${boundary}\r\n`;

        if (field.filename) {
            // 文件字段
            header += `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\n`;
            header += `Content-Type: ${field.contentType || 'application/octet-stream'}\r\n`;
        } else {
            // 普通文本字段
            header += `Content-Disposition: form-data; name="${field.name}"\r\n`;
        }

        header += '\r\n';
        parts.push(Buffer.from(header, 'utf-8'));

        if (Buffer.isBuffer(field.value)) {
            parts.push(field.value);
        } else {
            parts.push(Buffer.from(String(field.value), 'utf-8'));
        }

        parts.push(Buffer.from('\r\n', 'utf-8'));
    }

    // 结束边界
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));

    return Buffer.concat(parts);
}

/**
 * 将 data URI 解析为 Buffer 和 MIME 类型
 *
 * @param {string} dataURI - data:image/png;base64,... 格式的 URI
 * @returns {{buffer: Buffer, mimeType: string, extension: string}}
 */
function parseDataURI(dataURI) {
    const match = dataURI.match(/^data:(image\/(\w+));base64,(.+)$/s);
    if (!match) {
        throw new Error('无效的 data URI 格式');
    }
    return {
        mimeType: match[1],           // e.g. "image/png"
        extension: match[2],           // e.g. "png"
        buffer: Buffer.from(match[3], 'base64')
    };
}

/**
 * 调用 OpenAI 兼容的 images/edits API（图生图/垫图）
 *
 * 注意：OpenAI 的 /v1/images/edits 端点要求使用 multipart/form-data 格式，
 * 图片必须以二进制文件字段（image[] 或 image）方式上传，不支持 JSON body。
 *
 * @param {object} params - 编辑参数
 * @param {string} params.prompt - 编辑描述提示词
 * @param {string[]} params.imageDataURIs - 输入图片的 data URI 数组
 * @param {string} params.size - 输出图片尺寸
 * @param {string} params.quality - 图片质量
 * @returns {Promise<object>} API 响应体
 */
async function callEditAPI(params) {
    const apiUrl = `${OPENAI_BASE_URL}/v1/images/edits`;
    const boundary = `----VCPBoundary${crypto.randomUUID().replace(/-/g, '')}`;

    debugLog('Edit API Request URL:', apiUrl);
    debugLog('Edit API Request (prompt + size):', JSON.stringify({ prompt: params.prompt, size: params.size, quality: params.quality, imageCount: params.imageDataURIs.length }));

    // 构建 multipart 表单字段
    const fields = [];

    // 文本字段
    fields.push({ name: 'model', value: GPT_IMAGE_MODEL });
    fields.push({ name: 'prompt', value: params.prompt });
    fields.push({ name: 'size', value: params.size });
    fields.push({ name: 'quality', value: params.quality });
    fields.push({ name: 'response_format', value: DEFAULT_RESPONSE_FORMAT });

    // 图片字段 — 使用 image[] 数组形式上传多张图片
    for (let i = 0; i < params.imageDataURIs.length; i++) {
        const { buffer, mimeType, extension } = parseDataURI(params.imageDataURIs[i]);
        fields.push({
            name: 'image[]',
            value: buffer,
            filename: `input_${i}.${extension}`,
            contentType: mimeType
        });
        debugLog(`Edit API: attached image[${i}], size=${buffer.length} bytes, type=${mimeType}`);
    }

    const body = buildMultipartBody(boundary, fields);
    debugLog('Edit API: multipart body size =', body.length, 'bytes');

    const response = await httpRequestWithRetry(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Accept': 'application/json',
            'Content-Length': body.length
        },
        timeout: 300000
    }, body);

    return parseApiResponse(response);
}

// ============================================================
// 图像保存
// ============================================================

/**
 * 将图像数据保存到本地文件系统
 * 
 * @param {Buffer} imageBuffer - 图像二进制数据
 * @param {number} index - 图片序号（用于多图场景的日志标识）
 * @param {string} [contentType] - HTTP Content-Type（用于推断扩展名）
 * @returns {object} { localPath, accessibleUrl, serverPath, fileName }
 */
function saveImageToLocal(imageBuffer, index = 0, contentType = '') {
    const imageDir = path.join(PROJECT_BASE_PATH, 'image', 'gptimagegen');
    const ext = inferImageExtension(contentType);
    const fileName = `${crypto.randomUUID()}.${ext}`;
    const localPath = path.join(imageDir, fileName);

    // 路径安全检查 — 防止路径逃逸
    const resolvedDir = path.resolve(imageDir);
    const resolvedPath = path.resolve(localPath);
    if (!resolvedPath.startsWith(resolvedDir)) {
        throw new Error('路径安全检查失败：检测到路径逃逸尝试');
    }

    // 确保目录存在
    fs.mkdirSync(imageDir, { recursive: true });

    // 写入文件
    fs.writeFileSync(localPath, imageBuffer);
    debugLog(`Image ${index} saved to: ${localPath}`);

    // 构建可访问的 HTTP URL
    const relativeServerPath = `gptimagegen/${fileName}`;
    const serverPath = `image/gptimagegen/${fileName}`;
    const accessibleUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPath}`;

    return {
        localPath,
        accessibleUrl,
        serverPath,
        fileName
    };
}

// ============================================================
// 响应构建
// ============================================================

/**
 * 根据 API 结果构建标准化的 VCP 插件响应
 * 
 * @param {object} apiResult - API 返回的响应体
 * @param {object} params - 原始请求参数
 * @returns {Promise<object>} VCP 标准响应对象
 */
async function buildResponse(apiResult, params) {
    const content = [];
    const imageUrls = [];
    const savedImages = [];
    const savedBuffers = []; // 仅在 showBase64 时使用

    for (let i = 0; i < apiResult.data.length; i++) {
        const item = apiResult.data[i];
        let imageBuffer = null;
        let contentType = '';

        if (item.b64_json) {
            // base64 模式：直接解码
            imageBuffer = Buffer.from(item.b64_json, 'base64');
            contentType = 'image/png'; // b64_json 模式下 gpt-image-2 默认返回 PNG
        } else if (item.data_uri && typeof item.data_uri === 'string' && item.data_uri.startsWith('data:image/')) {
            const match = item.data_uri.match(/^data:(image\/[^;]+);base64,(.+)$/s);
            if (!match) {
                debugLog(`Warning: Image ${i} data_uri format invalid, skipping`);
                continue;
            }
            imageBuffer = Buffer.from(match[2], 'base64');
            contentType = match[1];
        } else if (item.url) {
            // URL 模式：下载图片（现在返回 contentType）
            debugLog(`Downloading image ${i} from URL: ${item.url}`);
            const downloaded = await downloadImage(item.url);
            imageBuffer = downloaded.data;
            contentType = downloaded.contentType;
        } else {
            debugLog(`Warning: Image ${i} has no b64_json, data_uri or url field, skipping`);
            continue;
        }

        // 保存到本地（传入 contentType 用于推断扩展名）
        const savedInfo = saveImageToLocal(imageBuffer, i, contentType);
        savedImages.push(savedInfo);
        imageUrls.push(savedInfo.accessibleUrl);

        // 仅在需要 showBase64 时保留 buffer 引用
        if (params.showBase64) {
            savedBuffers.push({ buffer: imageBuffer, contentType });
        }

        debugLog(`Image ${i}: saved as ${savedInfo.fileName}, accessible at ${savedInfo.accessibleUrl}`);
    }

    if (savedImages.length === 0) {
        throw new Error('API 未返回任何有效的图像数据');
    }

    // 构建文本内容（与 DoubaoGen 风格一致，简洁明了）
    const imageListText = savedImages.map((img, i) => {
        const idx = savedImages.length > 1 ? ` ${i + 1}` : '';
        return `- 图片${idx} URL: ${img.accessibleUrl}\n- 图片${idx} 服务器路径: ${img.serverPath}\n- 图片${idx} 文件名: ${img.fileName}`;
    }).join('\n');

    const textContent = `图片已成功生成！\n` +
        `- 提示词: ${params.prompt}\n` +
        `- 尺寸: ${params.size}\n` +
        `- 质量: ${params.quality}\n` +
        `- 背景: ${params.background}\n` +
        `- 数量: ${savedImages.length}\n` +
        `${imageListText}\n` +
        `请将生成好的图片转发给用户哦。`;

    content.push({
        type: 'text',
        text: textContent
    });

    // 只有当 showbase64 为 true 时才添加 base64 图片数据
    if (params.showBase64) {
        for (let i = 0; i < savedBuffers.length; i++) {
            const { buffer, contentType: ct } = savedBuffers[i];
            const ext = inferImageExtension(ct);
            const mimeMap = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
            const imageMimeType = mimeMap[ext] || 'image/png';
            content.push({
                type: 'image_url',
                image_url: {
                    url: `data:${imageMimeType};base64,${buffer.toString('base64')}`
                }
            });
        }
    }

    // 构建 details 对象（不包含任何 base64 数据，避免输出膨胀）
    const details = {
        serverPath: savedImages.map(img => img.serverPath),
        fileName: savedImages.map(img => img.fileName),
        imageUrls: imageUrls,
        prompt: params.prompt,
        command: params.command || 'GPTGenerateImage',
        model: GPT_IMAGE_MODEL,
        size: params.size,
        quality: params.quality,
        background: params.background,
        image_count: savedImages.length
    };

    // 单图时简化 details 字段为字符串
    if (savedImages.length === 1) {
        details.serverPath = savedImages[0].serverPath;
        details.fileName = savedImages[0].fileName;
    }

    return {
        status: 'success',
        result: {
            content,
            details
        }
    };
}

// ============================================================
// 主函数
// ============================================================

async function main() {
    try {
        // 读取 stdin
        const input = await new Promise((resolve, reject) => {
            let data = '';
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (chunk) => { data += chunk; });
            process.stdin.on('end', () => resolve(data));
            process.stdin.on('error', (err) => reject(err));
        });

        if (!input.trim()) {
            return outputAndExit({ status: 'error', error: 'GPTImageGen: 未收到任何输入数据' });
        }

        let args;
        try {
            args = JSON.parse(input);
        } catch (e) {
            return outputAndExit({ status: 'error', error: `GPTImageGen: 输入数据 JSON 解析失败 - ${e.message}` });
        }

        debugLog('Received args:', JSON.stringify(args));

        // 检查 API Key
        if (!OPENAI_API_KEY) {
            return outputAndExit({
                status: 'error',
                error: 'GPTImageGen: OPENAI_API_KEY 未配置。请在 Plugin/GPTImageGen/config.env 中设置 API 密钥。'
            });
        }

        // 检查必要的 VCP 环境变量
        if (!PROJECT_BASE_PATH) {
            return outputAndExit({ status: 'error', error: 'GPTImageGen: PROJECT_BASE_PATH 环境变量未设置' });
        }

        // 获取命令类型（默认 generate）
        // 解析 showbase64 参数，默认为 false
        const showBase64 = args.showbase64 === 'true' || args.showbase64 === true;

        const command = (args.command || args.Command || args.cmd || 'generate').toLowerCase();
        // 对 invocationCommands 的 commandIdentifier 做兼容
        const isEditMode = command === 'edit' || command === 'compose' || command === 'image2image' || command === 'i2i' || command === 'gpteditimage';

        // 获取 prompt 参数（兼容多种字段名）
        const prompt = args.prompt || args.Prompt || args.text || '';
        if (!prompt.trim()) {
            return outputAndExit({
                status: 'error',
                error: 'GPTImageGen: 缺少 prompt 参数。请提供图像描述文本。'
            });
        }

        // 解析并验证通用参数
        let size = args.size || args.Size || args.resolution || args.Resolution || args.image_size || args.imageSize || DEFAULT_SIZE;
        // 兼容纯数字输入（如 "1024"），自动转为正方形尺寸
        if (/^\d+$/.test(size)) {
            size = `${size}x${size}`;
            debugLog(`Size auto-corrected to square: ${size}`);
        }
        if (!isValidSize(size)) {
            return outputAndExit({
                status: 'error',
                error: `GPTImageGen: 无效的 size 参数 "${size}"。格式为 WIDTHxHEIGHT，最长边 ≤ 3840，最短边 ≥ 256。常用尺寸: 1024x1024, 1536x1024, 1024x1536, 2048x2048, 3840x2160`
            });
        }

        const quality = args.quality || args.Quality || DEFAULT_QUALITY;
        if (!isValidQuality(quality)) {
            return outputAndExit({
                status: 'error',
                error: `GPTImageGen: 无效的 quality 参数 "${quality}"。支持的值: low, medium, high, auto`
            });
        }

        const background = args.background || args.Background || DEFAULT_BACKGROUND;
        const n = Math.min(Math.max(parseInt(args.n || args.count || '1', 10) || 1, 1), 4);
        const response_format = args.response_format || DEFAULT_RESPONSE_FORMAT;

        // ---- 根据命令类型分派 ----
        let apiResult;

        if (isEditMode) {
            // ======== 图生图（Edit）模式 ========
            const imageInputs = collectImageInputs(args);
            if (imageInputs.length === 0) {
                return outputAndExit({
                    status: 'error',
                    error: 'GPTImageGen [edit]: 缺少 image 参数。请提供要编辑的原始图片（支持 URL、base64 data URI 或本地文件路径）。'
                });
            }

            const imageDataURIs = [];
            for (const img of imageInputs) {
                const dataURI = await processImageInput(img);
                imageDataURIs.push(dataURI);
            }

            debugLog('Edit mode: processed', imageDataURIs.length, 'input image(s)');
            debugLog('Parsed params:', { prompt: prompt.substring(0, 100), size, quality, imageCount: imageDataURIs.length });

            apiResult = await callEditAPI({
                prompt,
                imageDataURIs,
                size,
                quality
            });
        } else {
            // ======== 文生图（Generate）模式 ========
            if (!isValidBackground(background)) {
                return outputAndExit({
                    status: 'error',
                    error: `GPTImageGen: 无效的 background 参数 "${background}"。支持的值: transparent, opaque, auto`
                });
            }

            debugLog('Generate mode');
            debugLog('Parsed params:', { prompt: prompt.substring(0, 100), size, quality, background, n, response_format });

            apiResult = await callImageAPI({
                prompt,
                size,
                quality,
                n,
                background,
                response_format
            });
        }

        // 处理结果并构建响应
        const response = await buildResponse(apiResult, {
            prompt,
            size,
            quality,
            n,
            background,
            command: isEditMode ? 'GPTEditImage' : 'GPTGenerateImage',
            showBase64
        });

        outputAndExit(response);

    } catch (err) {
        debugLog('Error:', err.message, err.stack);
        outputAndExit({
            status: 'error',
            error: `GPTImageGen Plugin Error: ${err.message}`
        });
    }
}

main();