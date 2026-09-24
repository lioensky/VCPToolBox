#!/usr/bin/env node
import https from 'https';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
//  Configuration & Environment
// ============================================================

// 1. API Endpoint & Subscription (Plan) Support
const RAW_API_URL = process.env.VOLCENGINE_API_URL || '';
const USE_PLAN_API = (process.env.USE_PLAN_API || 'false').toLowerCase() === 'true';

let apiProtocol = 'https:';
let apiBaseHost = 'ark.cn-beijing.volces.com';
let apiBasePort = 443;
let apiImagePath = USE_PLAN_API ? '/api/plan/v3/images/generations' : '/api/v3/images/generations';
let apiModelsPath = '/api/v3/models';

if (RAW_API_URL) {
    try {
        const parsedUrl = new URL(RAW_API_URL);
        apiProtocol = parsedUrl.protocol;
        apiBaseHost = parsedUrl.hostname;
        apiBasePort = parsedUrl.port ? parseInt(parsedUrl.port, 10) : (apiProtocol === 'http:' ? 80 : 443);
        apiImagePath = parsedUrl.pathname + parsedUrl.search;
        // 如果是 plan 路径，models 默认还是回退到 /api/v3/models
        apiModelsPath = '/api/v3/models';
    } catch (e) {
        console.error(`[DoubaoGen] 解析自定义 VOLCENGINE_API_URL 失败: ${e.message}，将使用默认配置`);
    }
}

const DEFAULT_MODEL_ID = process.env.SEEDREAM_MODEL_ID || (USE_PLAN_API ? 'doubao-seedream-5.0-lite' : 'doubao-seedream-5-0-260128');
const DEFAULT_RESOLUTION = process.env.DEFAULT_RESOLUTION || '2K';
const DEFAULT_OUTPUT_FORMAT = process.env.DEFAULT_OUTPUT_FORMAT || 'png';
const DEFAULT_WATERMARK = process.env.DEFAULT_WATERMARK === 'true';
const DEFAULT_SHOW_BASE64 = (process.env.DEFAULT_SHOW_BASE64 || 'false').toLowerCase() === 'true';
const DEFAULT_RESPONSE_FORMAT = process.env.DEFAULT_RESPONSE_FORMAT || (DEFAULT_SHOW_BASE64 ? 'b64_json' : 'url');
const DEBUG_MODE = (process.env.DebugMode || 'false').toLowerCase() === 'true';

const API_KEYS_STRING = process.env.VOLCENGINE_API_KEY || '';
const API_KEYS = API_KEYS_STRING.split(',').map(k => k.trim()).filter(Boolean);

const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH || process.cwd();
const SERVER_PORT = process.env.SERVER_PORT || '5000';
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY || '';
const VAR_HTTP_URL = process.env.VarHttpUrl || 'http://localhost';
const VAR_HTTPS_URL = process.env.VarHttpsUrl || '';

const CACHE_FILE_PATH = path.join(__dirname, '.doubao_api_cache.json');
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const VALID_RESOLUTIONS = [
    '1K', '2K', '4K', 'adaptive',
    '1024x1024', '864x1152', '1152x864',
    '1280x720', '720x1280', '832x1248',
    '1248x832', '1512x648',
    '1280x1280', '1536x1536', '2048x2048',
    '2048x1536', '1536x2048',
    '2304x1728', '1728x2304',
    '2560x1440', '1440x2560',
    '1920x1080', '1080x1920',
    '2496x1664', '1664x2496', '3024x1296'
];

// ============================================================
//  Utilities & Logging
// ============================================================

function debugLog(msg, ...args) {
    if (DEBUG_MODE) console.error(`[DoubaoGen][Debug] ${msg}`, ...args);
}

function log(level, msg) {
    console.error(`[${new Date().toISOString()}] [DoubaoGen] [${level}] ${msg}`);
}

function outputAndExit(result) {
    const code = result.status === 'success' ? 0 : 1;
    process.stdout.write(JSON.stringify(result), () => process.exit(code));
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&').replace(/"/g, '"')
              .replace(/</g, '<').replace(/>/g, '>');
}

function isPathWithinBase(target, base) {
    const rt = path.resolve(target);
    const rb = path.resolve(base);
    return rt === rb || rt.startsWith(rb + path.sep);
}

// ============================================================
//  API Key Pool (Multi-key load balancing & error recovery)
// ============================================================

class ApiKeyPool {
    constructor(keys) {
        this.state = this._load();
        const envSet = new Set(keys);
        const stateSet = new Set(this.state.keys.map(k => k.key));
        if (this.state.keys.length !== keys.length || ![...envSet].every(k => stateSet.has(k))) {
            log('info', `初始化 API 密钥池，共 ${keys.length} 个密钥`);
            this.state = {
                currentIndex: 0,
                keys: keys.map(key => ({ key, active: true, errorCount: 0, maxErrors: 3 }))
            };
            this._save();
        }
    }

    _load() {
        try {
            if (existsSync(CACHE_FILE_PATH)) {
                const raw = readFileSync(CACHE_FILE_PATH, 'utf8');
                const data = JSON.parse(raw);
                if (data.keyPool) return data.keyPool;
                if (data.keys) return data;
            }
        } catch { /* ignore */ }
        return { currentIndex: 0, keys: [] };
    }

    _save() {
        try {
            let cache = {};
            try {
                if (existsSync(CACHE_FILE_PATH)) {
                    cache = JSON.parse(readFileSync(CACHE_FILE_PATH, 'utf8'));
                }
            } catch { /* ignore */ }
            cache.keyPool = this.state;
            writeFileSync(CACHE_FILE_PATH, JSON.stringify(cache, null, 2));
        } catch (e) {
            log('error', `缓存写入失败: ${e.message}`);
        }
    }

    getNextKey() {
        let active = this.state.keys.filter(k => k.active);
        if (active.length === 0) {
            log('warn', '所有 API 密钥已禁用，尝试重置...');
            this._resetAll();
            active = this.state.keys.filter(k => k.active);
            if (active.length === 0) return null;
        }
        const idx = this.state.currentIndex % active.length;
        const kc = active[idx];
        this.state.currentIndex = (this.state.currentIndex + 1) % this.state.keys.length;
        log('info', `使用 API 密钥 #${this.state.keys.indexOf(kc) + 1}/${this.state.keys.length} (活跃: ${active.length}/${this.state.keys.length})`);
        this._save();
        return kc;
    }

    markError(key, type = 'general') {
        const kc = this.state.keys.find(k => k.key === key);
        if (!kc) return;
        kc.errorCount++;
        kc.lastError = new Date().toISOString();
        kc.lastErrorType = type;
        log('warn', `密钥错误(${type}): ${key.substring(0, 8)}... (${kc.errorCount}/${kc.maxErrors})`);
        if (kc.errorCount >= kc.maxErrors) {
            kc.active = false;
            log('error', `禁用密钥: ${key.substring(0, 8)}...`);
        }
        this._save();
    }

    markSuccess(key) {
        const kc = this.state.keys.find(k => k.key === key);
        if (!kc) return;
        kc.errorCount = 0;
        kc.lastSuccess = new Date().toISOString();
        this._save();
    }

    _resetAll() {
        log('info', '重置所有密钥状态');
        this.state.keys.forEach(kc => {
            if (kc.errorCount < kc.maxErrors * 2) {
                kc.active = true;
                kc.errorCount = Math.floor(kc.errorCount / 2);
            }
        });
        this._save();
    }
}

let apiKeyPool = null;

// ============================================================
//  Network Request Helpers (Native HTTP / HTTPS)
// ============================================================

function netRequest(options, postData) {
    return new Promise((resolve, reject) => {
        const client = options.protocol === 'http:' ? http : https;
        const req = client.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: JSON.parse(data) });
                } catch (e) {
                    reject(new Error(`响应解析失败: ${e.message} (原始数据: ${data.substring(0, 200)})`));
                }
            });
        });
        req.on('error', e => reject(new Error(`网络请求失败: ${e.message}`)));
        req.setTimeout(240000, () => { req.destroy(); reject(new Error('请求超时 (4分钟)')); });
        if (postData) req.write(postData);
        req.end();
    });
}

function downloadImage(url) {
    return new Promise((resolve, reject) => {
        const fullUrl = url.startsWith('http') ? url : `https:${url}`;
        const client = fullUrl.startsWith('http://') ? http : https;
        client.get(fullUrl, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                const redirectUrl = res.headers.location;
                if (!redirectUrl) return reject(new Error('收到重定向但无 Location 头'));
                return downloadImage(redirectUrl).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ data: Buffer.concat(chunks), contentType: res.headers['content-type'] }));
            res.on('error', reject);
        }).on('error', reject);
    });
}

// ============================================================
//  API Call Dispatcher & Fallback
// ============================================================

const MAX_MODEL_FALLBACK = 3;

async function callAPI(requestBody, retryCount = 0, _failedModels = null) {
    const kc = apiKeyPool.getNextKey();
    if (!kc) throw new Error('没有可用的 API 密钥（所有密钥都已失效）');
    const apiKey = kc.key;
    const postData = JSON.stringify(requestBody);

    debugLog(`发送请求至 ${apiProtocol}//${apiBaseHost}:${apiBasePort}${apiImagePath}`);
    debugLog(`请求体: ${postData.substring(0, 300)}...`);

    const res = await netRequest({
        protocol: apiProtocol,
        hostname: apiBaseHost,
        port: apiBasePort,
        path: apiImagePath,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(postData)
        }
    }, postData);

    if (res.statusCode === 200) {
        apiKeyPool.markSuccess(apiKey);
        return res.body;
    }

    const errMsg = res.body?.error?.message || `API 错误代码: ${res.statusCode}`;

    if (res.statusCode === 429) {
        apiKeyPool.markError(apiKey, 'quota_exceeded');
        if (retryCount < API_KEYS.length - 1) {
            log('info', `配额耗尽，切换密钥重试 (${retryCount + 1}/${API_KEYS.length - 1})`);
            return callAPI(requestBody, retryCount + 1, _failedModels);
        }
        throw new Error('所有 API 密钥的配额都已用完');
    }
    if (res.statusCode === 401) {
        apiKeyPool.markError(apiKey, 'auth_failed');
        throw new Error(`认证失败: ${errMsg}`);
    }

    if (res.statusCode === 400) {
        const failedModels = _failedModels || new Set();
        failedModels.add(requestBody.model);

        // 如果是订阅链接 (/api/plan/...)，通常模型绑定套餐，避免盲目向公共 v3 降级
        if (!apiImagePath.includes('/plan/') && failedModels.size <= MAX_MODEL_FALLBACK) {
            log('warn', `模型 "${requestBody.model}" 请求失败(400)，尝试自动降级... (${failedModels.size}/${MAX_MODEL_FALLBACK})`);
            const fallbackModel = await discoverFallbackModel(failedModels);
            if (fallbackModel) {
                log('info', `自动降级到模型: ${fallbackModel}`);
                requestBody.model = fallbackModel;
                return callAPI(requestBody, 0, failedModels);
            }
        }
        const triedList = _failedModels ? ` (已尝试模型: ${[..._failedModels].join(', ')})` : '';
        throw new Error(`请求参数错误: ${errMsg}${triedList}`);
    }

    apiKeyPool.markError(apiKey, 'api_error');
    throw new Error(errMsg);
}

async function discoverFallbackModel(excludeModels) {
    try {
        const cached = loadModelCache();
        if (cached && cached.length > 0) {
            const alt = cached.find(m => !excludeModels.has(m.id));
            if (alt) {
                log('info', `从缓存找到备选模型: ${alt.id}`);
                return alt.id;
            }
        }

        log('info', '缓存无可用备选模型，实时查询 API...');
        const kc = apiKeyPool.getNextKey();
        if (!kc) return null;

        const res = await netRequest({
            protocol: 'https:',
            hostname: 'ark.cn-beijing.volces.com',
            port: 443,
            path: apiModelsPath,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${kc.key}` }
        });

        if (res.statusCode !== 200) return null;

        const allModels = res.body?.data || [];
        const imageModels = allModels.filter(m =>
            m.id.includes('seedream') || m.id.includes('t2i') ||
            m.id.includes('image') || m.id.includes('img')
        );
        saveModelCache(imageModels);
        apiKeyPool.markSuccess(kc.key);

        if (imageModels.length === 0) return null;
        const alt = imageModels.find(m => !excludeModels.has(m.id));
        return alt ? alt.id : null;
    } catch (e) {
        log('error', `模型自动发现失败: ${e.message}`);
        return null;
    }
}

// ============================================================
//  Argument Normalization & Robust Input Extraction (Ported from DMX)
// ============================================================

function parseImageArrayInput(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value !== 'string') return value ? [value] : [];

    const trimmed = value.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed.filter(Boolean);
        } catch { /* ignore */ }
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

    pushImage(args.image || args.Image || args.image_url || args.source_image || args.images);
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

function normalizeResolution(input) {
    if (!input) return DEFAULT_RESOLUTION;
    const lower = String(input).trim().toLowerCase();
    if (lower === '1k') return '1K';
    if (lower === '2k') return '2K';
    if (lower === '4k') return '4K';
    if (lower === 'adaptive' || lower === 'auto') return 'adaptive';

    for (const res of VALID_RESOLUTIONS) {
        if (res.toLowerCase() === lower) return res;
    }
    if (/^\d+x\d+$/.test(input)) return input;
    log('warn', `未知分辨率 "${input}"，回退到默认分辨率 ${DEFAULT_RESOLUTION}`);
    return DEFAULT_RESOLUTION;
}

function normalizeDoubaoArgs(rawArgs) {
    const args = { ...(rawArgs || {}) };

    // 1. Prompt 归一化
    args.prompt = args.prompt || args.Prompt || args.text || args.description || '';

    // 2. Resolution 归一化 (兼容 size, Size, image_size, imageSize)
    const rawRes = args.resolution || args.Resolution || args.size || args.Size || args.image_size || args.imageSize;
    args.resolution = normalizeResolution(rawRes);

    // 3. Output Format 归一化
    args.output_format = (args.output_format || args.outputFormat || args.format || DEFAULT_OUTPUT_FORMAT).toLowerCase();

    // 4. Show Base64 标志 (按次动态控制)
    if (args.showbase64 !== undefined) {
        args.showbase64 = args.showbase64 === true || args.showbase64 === 'true';
    } else if (args.showBase64 !== undefined) {
        args.showbase64 = args.showBase64 === true || args.showBase64 === 'true';
    } else if (args.return_base64 !== undefined) {
        args.showbase64 = args.return_base64 === true || args.return_base64 === 'true';
    } else {
        args.showbase64 = DEFAULT_SHOW_BASE64;
    }

    // 5. Watermark 归一化
    if (args.watermark !== undefined) {
        args.watermark = args.watermark === true || args.watermark === 'true';
    } else {
        args.watermark = DEFAULT_WATERMARK;
    }

    // 6. Model 归一化
    args.model = args.model || args.Model || DEFAULT_MODEL_ID;

    // 7. 图片输入收集与智能意图纠偏
    const collectedImages = collectImageInputs(args);
    const rawCmd = String(args.command || args.Command || args.cmd || '').trim().toLowerCase();

    // 模式推断与容错映射
    const isModelList = rawCmd === 'list_models' || rawCmd === 'models';
    const isGroup = rawCmd === 'group' || rawCmd === 'sequential' || rawCmd === 'series' || rawCmd === 'doubaogroupimage';
    const wantsCompose = rawCmd.includes('compose') || rawCmd.includes('merge') || rawCmd.includes('fusion') || rawCmd.includes('融合') || rawCmd.includes('合成');
    const wantsEdit = rawCmd.includes('edit') || rawCmd.includes('image2image') || rawCmd.includes('i2i') || rawCmd.includes('修图') || rawCmd.includes('改图');
    const wantsGenerate = rawCmd.includes('generate') || rawCmd.includes('text2image') || rawCmd.includes('t2i') || rawCmd.includes('文生图');

    if (isModelList) {
        args.command = 'list_models';
    } else if (isGroup) {
        args.command = 'group';
    } else if (wantsCompose || (collectedImages.length > 1 && !wantsGenerate)) {
        args.command = 'compose';
    } else if (wantsEdit || (collectedImages.length === 1 && !wantsGenerate)) {
        args.command = 'edit';
    } else {
        args.command = 'generate';
    }

    args._collectedImages = collectedImages;
    return args;
}

// ============================================================
//  Image Processing & Remote Distributed Fetching (Hyper-Stack-Trace)
// ============================================================

async function processSingleImage(item, paramName = 'image') {
    if (!item) return null;
    if (item.image_base64) {
        const b64 = item.image_base64;
        return b64.startsWith('data:image') ? b64 : `data:image/png;base64,${b64}`;
    }
    const image = item.image;
    if (!image || typeof image !== 'string') return image;
    if (image.startsWith('data:image')) return image;
    if (image.startsWith('http://') || image.startsWith('https://')) return image;

    if (image.startsWith('file://')) {
        let filePath;
        if (image.startsWith('file:///')) {
            filePath = decodeURIComponent(image.substring(8));
            if (process.platform === 'win32') filePath = filePath.replace(/\//g, '\\');
        } else {
            filePath = decodeURIComponent(image.substring(7));
        }

        log('info', `读取本地/分布式文件: ${filePath}`);
        try {
            const buffer = await fs.readFile(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const mimeMap = {
                '.png': 'image/png', '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg', '.gif': 'image/gif',
                '.webp': 'image/webp', '.bmp': 'image/bmp'
            };
            const mime = mimeMap[ext] || 'image/jpeg';
            return `data:${mime};base64,${buffer.toString('base64')}`;
        } catch (e) {
            if (e.code === 'ENOENT') {
                log('warn', `本地文件不存在，触发分布式文件拉取: ${image}`);
                const err = new Error(`本地文件未找到，需要远程获取: ${image}`);
                err.code = 'FILE_NOT_FOUND_LOCALLY';
                err.fileUrl = image;
                err.failedParameter = paramName;
                throw err;
            }
            throw new Error(`读取本地文件失败: ${e.message}`);
        }
    }
    return image;
}

// ============================================================
//  Model Discovery
// ============================================================

function loadModelCache() {
    try {
        if (existsSync(CACHE_FILE_PATH)) {
            const data = JSON.parse(readFileSync(CACHE_FILE_PATH, 'utf8'));
            if (data.models && data.modelsCachedAt && Date.now() - data.modelsCachedAt < MODEL_CACHE_TTL_MS) {
                debugLog(`使用缓存的模型列表 (${data.models.length}个)`);
                return data.models;
            }
        }
    } catch { /* ignore */ }
    return null;
}

function saveModelCache(models) {
    try {
        let cache = {};
        try {
            if (existsSync(CACHE_FILE_PATH)) cache = JSON.parse(readFileSync(CACHE_FILE_PATH, 'utf8'));
        } catch { /* ignore */ }
        cache.models = models;
        cache.modelsCachedAt = Date.now();
        writeFileSync(CACHE_FILE_PATH, JSON.stringify(cache, null, 2));
    } catch (e) {
        log('warn', `模型缓存写入失败: ${e.message}`);
    }
}

async function handleListModels(args) {
    const forceRefresh = args.refresh === true;

    if (!forceRefresh) {
        const cached = loadModelCache();
        if (cached) {
            return {
                content: [{ type: 'text', text: formatModelList(cached, true) }],
                details: { models: cached, fromCache: true }
            };
        }
    }

    const kc = apiKeyPool.getNextKey();
    if (!kc) throw new Error('没有可用的 API 密钥');

    const res = await netRequest({
        protocol: 'https:',
        hostname: 'ark.cn-beijing.volces.com',
        port: 443,
        path: apiModelsPath,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${kc.key}` }
    });

    if (res.statusCode !== 200) {
        throw new Error(`获取模型列表失败: ${res.body?.error?.message || res.statusCode}`);
    }

    const allModels = res.body?.data || [];
    const imageModels = allModels.filter(m =>
        m.id.includes('seedream') || m.id.includes('t2i') ||
        m.id.includes('image') || m.id.includes('img')
    );

    saveModelCache(imageModels);
    apiKeyPool.markSuccess(kc.key);

    return {
        content: [{ type: 'text', text: formatModelList(imageModels, false) }],
        details: { models: imageModels, fromCache: false, totalModels: allModels.length }
    };
}

function formatModelList(models, fromCache) {
    if (models.length === 0) {
        return '未在方舟模型库中找到可用的图像生成模型。请确认火山方舟账户已授权开通相关模型服务。';
    }
    let text = `**火山引擎/方舟图像生成模型列表** (${fromCache ? '缓存' : '实时查询'})：\n\n`;
    text += `当前默认模型：\`${DEFAULT_MODEL_ID}\`\n\n`;
    models.forEach((m, i) => {
        text += `${i + 1}. \`${m.id}\``;
        if (m.id === DEFAULT_MODEL_ID) text += ' ← 当前默认';
        if (m.owned_by) text += ` (${m.owned_by})`;
        text += '\n';
    });
    text += '\n提示：您可在工具调用中使用 `model` 参数指定具体模型。';
    return text;
}

// ============================================================
//  Business Handlers (Generate, Edit, Compose, Group)
// ============================================================

async function handleGenerate(args) {
    if (!args.prompt) throw new Error('文生图必须提供 prompt 提示词');

    const body = {
        model: args.model,
        prompt: args.prompt,
        size: args.resolution,
        watermark: args.watermark,
        output_format: args.output_format,
        response_format: DEFAULT_RESPONSE_FORMAT
    };

    if (args.seed !== undefined && args.seed !== -1 && args.seed !== null) {
        body.seed = parseInt(args.seed, 10);
    }
    if (args.guidance_scale !== undefined) {
        body.guidance_scale = parseFloat(args.guidance_scale);
    }

    return callAPI(body);
}

async function handleEdit(args) {
    if (!args.prompt) throw new Error('图生图必须提供 prompt 提示词');
    const images = args._collectedImages || [];
    if (images.length === 0) throw new Error('图生图必须提供参考图片 (image 参数)');

    const processedImage = await processSingleImage(images[0], 'image');
    let resolution = args.resolution;
    if (resolution === 'adaptive') resolution = 'adaptive';

    const body = {
        model: args.model,
        prompt: args.prompt,
        image: processedImage,
        size: resolution,
        watermark: args.watermark,
        output_format: args.output_format,
        response_format: DEFAULT_RESPONSE_FORMAT
    };

    if (args.seed !== undefined && args.seed !== -1 && args.seed !== null) {
        body.seed = parseInt(args.seed, 10);
    }
    if (args.guidance_scale !== undefined) {
        body.guidance_scale = parseFloat(args.guidance_scale);
    }

    return callAPI(body);
}

async function handleCompose(args) {
    if (!args.prompt) throw new Error('多图融合必须提供 prompt 提示词');
    const images = args._collectedImages || [];
    if (images.length < 2) throw new Error('多图融合至少需要提供 2 张图片');
    if (images.length > 10) throw new Error('多图融合最多支持 10 张图片');

    const processedList = [];
    for (let i = 0; i < images.length; i++) {
        const pImg = await processSingleImage(images[i], `image_${i + 1}`);
        processedList.push(pImg);
    }

    let resolution = args.resolution;
    if (resolution === 'adaptive') resolution = 'adaptive';

    const body = {
        model: args.model,
        prompt: args.prompt,
        image: processedList,
        images: processedList, // 兼容部分网关对复数 images 的命名
        size: resolution,
        watermark: args.watermark,
        output_format: args.output_format,
        response_format: DEFAULT_RESPONSE_FORMAT,
        sequential_image_generation: 'disabled'
    };

    if (args.seed !== undefined && args.seed !== -1 && args.seed !== null) {
        body.seed = parseInt(args.seed, 10);
    }
    if (args.guidance_scale !== undefined) {
        body.guidance_scale = parseFloat(args.guidance_scale);
    }

    return callAPI(body);
}

async function handleGroup(args) {
    if (!args.prompt) throw new Error('组图生成必须提供 prompt 提示词');

    const maxImages = parseInt(args.max_images || args.maxImages || args.count || 4, 10);
    if (maxImages < 1 || maxImages > 15) throw new Error('max_images 必须在 1-15 范围内');

    const images = args._collectedImages || [];
    const image = images.length > 0 ? await processSingleImage(images[0], 'image') : null;

    const body = {
        model: args.model,
        prompt: args.prompt,
        size: args.resolution,
        watermark: args.watermark,
        output_format: args.output_format,
        response_format: DEFAULT_RESPONSE_FORMAT,
        sequential_image_generation: 'auto',
        sequential_image_generation_options: { max_images: maxImages }
    };
    if (image) body.image = image;

    return callAPI(body);
}

// ============================================================
//  Local Persistence & Standard OpenAI Multimodal Formatting
// ============================================================

async function saveImageToLocal(imageUrl, imageBase64, expectedExt = 'png') {
    try {
        let imageBuffer;
        let ext = expectedExt;

        if (imageBase64) {
            imageBuffer = Buffer.from(imageBase64, 'base64');
        } else if (imageUrl) {
            const resp = await downloadImage(imageUrl);
            imageBuffer = resp.data;
            const ct = resp.contentType || '';
            if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpg';
            else if (ct.includes('webp')) ext = 'webp';
            else if (ct.includes('png')) ext = 'png';
        } else {
            return null;
        }

        const fileName = `${crypto.randomUUID()}.${ext}`;
        const imageDir = path.join(PROJECT_BASE_PATH, 'image', 'doubaogen');
        const localPath = path.join(imageDir, fileName);

        if (!isPathWithinBase(localPath, PROJECT_BASE_PATH)) {
            log('error', `安全防护拦截: 路径逃逸 ${localPath}`);
            return null;
        }

        await fs.mkdir(imageDir, { recursive: true });
        await fs.writeFile(localPath, imageBuffer);

        const relUrl = path.join('doubaogen', fileName).replace(/\\/g, '/');
        const accessibleUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relUrl}`;

        log('info', `图片已安全持久化: ${localPath}`);
        return {
            localPath,
            fileName,
            accessibleUrl,
            serverPath: `image/doubaogen/${fileName}`,
            base64Data: imageBuffer.toString('base64'),
            mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`
        };
    } catch (e) {
        log('error', `保存图片到本地失败: ${e.message}`);
        return null;
    }
}

function getCommandDesc(cmd) {
    const map = {
        generate: '文生图',
        edit: '图生图',
        compose: '多图融合',
        group: '组图连续生成'
    };
    return map[cmd] || cmd;
}

async function buildStandardResponse(apiResult, command, args) {
    const images = apiResult.data || [];
    const usage = apiResult.usage || {};
    const prompt = args.prompt;
    const showBase64 = args.showbase64;

    const savedImages = [];

    for (const img of images) {
        if (img.error) continue;
        const saved = await saveImageToLocal(img.url, img.b64_json, args.output_format || 'png');
        if (saved) {
            savedImages.push(saved);
        }
    }

    const successCount = savedImages.length;
    const failedImages = images.filter(i => i.error);

    const primaryImage = savedImages[0] || null;
    const accessibleUrl = primaryImage ? primaryImage.accessibleUrl : '';
    const altText = prompt ? (prompt.length > 60 ? prompt.substring(0, 60) + '...' : prompt) : '豆包生成的图片';
    const imageHtml = primaryImage ? `<img src="${accessibleUrl}" alt="${escapeHtml(altText)}" width="300">` : '';

    // 1. 构建适合前端展示和 AI 阅读的结构化文本
    let text = `图片已成功生成！\n\n`;
    text += `- **生成模式**: ${getCommandDesc(command)}\n`;
    text += `- **使用模型**: ${apiResult.model || args.model}\n`;
    text += `- **分辨率规格**: ${args.resolution}\n`;
    text += `- **提示词**: ${prompt}\n`;
    if (primaryImage) {
        text += `- **访问链接**: ${accessibleUrl}\n`;
    }

    if (savedImages.length > 1) {
        text += `\n**所有图片链接 (${savedImages.length} 张)**：\n`;
        savedImages.forEach((img, idx) => {
            text += `- 图片 ${idx + 1}: ${img.accessibleUrl}\n`;
        });
    }

    if (failedImages.length > 0) {
        text += `\n**生成异常项**: ${failedImages.length} 个错误\n`;
        failedImages.forEach((img, idx) => {
            text += `  - 失败 ${idx + 1}: ${img.error?.message || '未知错误'}\n`;
        });
    }

    if (primaryImage) {
        text += `\n请在回复中使用以下 HTML 标签直接将图片展示给用户：\n${imageHtml}`;
    }

    // 2. 构建标准 OpenAI 兼容多模态 content 格式
    const content = [{ type: 'text', text }];

    // 只有在显式要求 showbase64 为 true 时，才追加大体积 Base64，保护大模型上下文
    if (showBase64 && savedImages.length > 0) {
        for (const item of savedImages) {
            content.push({
                type: 'image_url',
                image_url: {
                    url: `data:${item.mimeType};base64,${item.base64Data}`
                }
            });
        }
    }

    return {
        content,
        details: {
            serverPath: primaryImage?.serverPath || null,
            fileName: primaryImage?.fileName || null,
            imageUrl: accessibleUrl,
            imageUrls: savedImages.map(s => s.accessibleUrl),
            prompt,
            command,
            resolution: args.resolution,
            model: apiResult.model || args.model,
            seed: apiResult.data?.[0]?.seed ?? args.seed ?? 'N/A',
            created: apiResult.created,
            output_format: args.output_format,
            showBase64,
            image_count: successCount,
            usage
        }
    };
}

// ============================================================
//  Main Entry
// ============================================================

async function main() {
    try {
        if (API_KEYS.length === 0) {
            throw new Error('未配置 VOLCENGINE_API_KEY，请在 config.env 中设置火山引擎密钥');
        }
        if (!apiKeyPool) {
            apiKeyPool = new ApiKeyPool(API_KEYS);
            log('info', `API 密钥池就绪，共 ${API_KEYS.length} 个密钥`);
        }

        const input = await new Promise(resolve => {
            let data = '';
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', chunk => data += chunk);
            process.stdin.on('end', () => resolve(data));
        });

        if (!input.trim()) {
            outputAndExit({ status: 'error', error: 'DoubaoGen Plugin Error: 未收到标准输入数据' });
            return;
        }

        const rawArgs = JSON.parse(input);
        debugLog('收到原始参数:', JSON.stringify(rawArgs).substring(0, 300));

        // 参数归一化与意图自愈纠偏
        const args = normalizeDoubaoArgs(rawArgs);
        debugLog(`规范化后指令: [${args.command}], 模型: [${args.model}], 分辨率: [${args.resolution}]`);

        let result;

        switch (args.command) {
            case 'generate': {
                const apiResult = await handleGenerate(args);
                result = await buildStandardResponse(apiResult, 'generate', args);
                break;
            }
            case 'edit': {
                const apiResult = await handleEdit(args);
                result = await buildStandardResponse(apiResult, 'edit', args);
                break;
            }
            case 'compose': {
                const apiResult = await handleCompose(args);
                result = await buildStandardResponse(apiResult, 'compose', args);
                break;
            }
            case 'group': {
                const apiResult = await handleGroup(args);
                result = await buildStandardResponse(apiResult, 'group', args);
                break;
            }
            case 'list_models': {
                result = await handleListModels(args);
                break;
            }
            default:
                throw new Error(`未知指令类型: ${args.command}。支持: generate, edit, compose, group, list_models`);
        }

        log('info', `指令 "${args.command}" 处理完毕并成功输出`);
        outputAndExit({ status: 'success', result });

    } catch (error) {
        log('error', `执行异常: ${error.message}`);
        if (error.code === 'FILE_NOT_FOUND_LOCALLY') {
            outputAndExit({
                status: 'error',
                code: error.code,
                error: error.message,
                fileUrl: error.fileUrl,
                failedParameter: error.failedParameter
            });
        } else {
            outputAndExit({ status: 'error', error: `DoubaoGen Plugin Error: ${error.message}` });
        }
    }
}

main();
