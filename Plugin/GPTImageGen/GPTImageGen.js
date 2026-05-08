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
const DEFAULT_RESPONSE_FORMAT = process.env.DEFAULT_RESPONSE_FORMAT || 'b64_json';
const DEFAULT_BACKGROUND = process.env.DEFAULT_BACKGROUND || 'auto';
const DEBUG = process.env.DebugMode === 'true';

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
    process.stdout.write(JSON.stringify(result), () => process.exit(code));
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

        const req = transport.request(reqOptions, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString('utf-8');
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: responseBody
                });
            });
        });

        req.on('error', (err) => {
            reject(new Error(`HTTP request failed: ${err.message}`));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('HTTP request timed out'));
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

        if (!parsed.data || !Array.isArray(parsed.data) || parsed.data.length === 0) {
            throw new Error(`API 响应中缺少有效的图像数据。响应: ${JSON.stringify(parsed).substring(0, 300)}`);
        }

        return parsed;
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
        case 503:
            throw new Error(`API 服务不可用（503 Service Unavailable），已重试 ${MAX_RETRIES} 次仍失败。详情: ${errorDetail}`);
        default:
            throw new Error(`API 请求失败（HTTP ${response.statusCode}）。详情: ${errorDetail}`);
    }
}

/**
 * 调用 OpenAI 兼容的 images/generations API（文生图）
 *
 * @param {object} params - 生成参数
 * @returns {Promise<object>} API 响应体
 */
async function callImageAPI(params) {
    const apiUrl = `${OPENAI_BASE_URL}/v1/images/generations`;

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
    debugLog('API Request URL:', apiUrl);
    debugLog('API Request Body:', bodyStr.substring(0, 500));

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

    return parseApiResponse(response);
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

    for (let i = 0; i < apiResult.data.length; i++) {
        const item = apiResult.data[i];
        let imageBuffer = null;
        let contentType = '';

        if (item.b64_json) {
            // base64 模式：直接解码
            imageBuffer = Buffer.from(item.b64_json, 'base64');
            contentType = 'image/png'; // b64_json 模式下 gpt-image-2 默认返回 PNG
        } else if (item.url) {
            // URL 模式：下载图片（现在返回 contentType）
            debugLog(`Downloading image ${i} from URL: ${item.url}`);
            const downloaded = await downloadImage(item.url);
            imageBuffer = downloaded.data;
            contentType = downloaded.contentType;
        } else {
            debugLog(`Warning: Image ${i} has no b64_json or url field, skipping`);
            continue;
        }

        // 保存到本地（传入 contentType 用于推断扩展名）
        const savedInfo = saveImageToLocal(imageBuffer, i, contentType);
        savedImages.push(savedInfo);
        imageUrls.push(savedInfo.accessibleUrl);

        debugLog(`Image ${i}: saved as ${savedInfo.fileName}, accessible at ${savedInfo.accessibleUrl}`);
    }

    if (savedImages.length === 0) {
        throw new Error('API 未返回任何有效的图像数据');
    }

    // 构建文本内容
    const imageListText = savedImages.map((img, i) => {
        const idx = savedImages.length > 1 ? ` ${i + 1}` : '';
        return `- 图片${idx} URL: ${img.accessibleUrl}\n- 图片${idx} 服务器路径: ${img.serverPath}\n- 图片${idx} 文件名: ${img.fileName}`;
    }).join('\n');

    const textContent = `图片已成功生成！\n\n` +
        `生成信息：\n` +
        `- 提示词: ${params.prompt}\n` +
        `- 尺寸: ${params.size}\n` +
        `- 质量: ${params.quality}\n` +
        `- 背景: ${params.background}\n` +
        `- 数量: ${savedImages.length}\n\n` +
        `图片详情：\n${imageListText}\n\n` +
        `请将生成好的图片转发给用户哦。`;

    content.push({
        type: 'text',
        text: textContent
    });

    // 如果是 b64_json 模式，添加 image_url 类型的内容供多模态 AI 直接查看
    for (let i = 0; i < apiResult.data.length; i++) {
        const item = apiResult.data[i];
        if (item.b64_json) {
            content.push({
                type: 'image_url',
                image_url: {
                    url: `data:image/png;base64,${item.b64_json}`
                }
            });
        }
    }

    // 构建 details 对象
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
        const command = (args.command || args.Command || args.cmd || 'generate').toLowerCase();
        // 对 invocationCommands 的 commandIdentifier 做兼容
        const isEditMode = command === 'edit' || command === 'image2image' || command === 'i2i' || command === 'gpteditimage';

        // 获取 prompt 参数（兼容多种字段名）
        const prompt = args.prompt || args.Prompt || args.text || '';
        if (!prompt.trim()) {
            return outputAndExit({
                status: 'error',
                error: 'GPTImageGen: 缺少 prompt 参数。请提供图像描述文本。'
            });
        }

        // 解析并验证通用参数
        let size = args.size || args.Size || DEFAULT_SIZE;
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
            let imageInput = args.image || args.Image || args.image_url || args.source_image || '';
            if (!imageInput) {
                return outputAndExit({
                    status: 'error',
                    error: 'GPTImageGen [edit]: 缺少 image 参数。请提供要编辑的原始图片（支持 URL、base64 data URI 或本地文件路径）。'
                });
            }

            // ── 兼容 VCP 工具调用传入 JSON 数组字符串的情况 ──
            // VCP 的「始」「末」参数解析器可能将 ["a","b"] 作为纯字符串传入，
            // 而非 JS 原生数组。此处自动检测并解析。
            // Windows 路径中的 \ 需要转义为 \\ 才能被 JSON.parse 正确解析。
            if (typeof imageInput === 'string' && imageInput.trimStart().startsWith('[')) {
                try {
                    const sanitized = imageInput.replace(/\\/g, '\\\\');
                    const parsed = JSON.parse(sanitized);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        imageInput = parsed;
                        debugLog('Auto-parsed image JSON string to array, count:', parsed.length);
                    }
                } catch (e) {
                    debugLog('Image field starts with [ but failed to parse:', e.message);
                }
            }


            // 处理图片输入（可以是单张或数组）
            const imageInputs = Array.isArray(imageInput) ? imageInput : [imageInput];
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
            command: isEditMode ? 'GPTEditImage' : 'GPTGenerateImage'
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