#!/usr/bin/env node
import https from 'https';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const API_BASE_HOST = 'ark.cn-beijing.volces.com';
const API_IMAGE_PATH = '/api/v3/images/generations';
const API_MODELS_PATH = '/api/v3/models';
const DEFAULT_MODEL_ID = process.env.SEEDREAM_MODEL_ID || 'doubao-seedream-5-0-260128';

const API_KEYS_STRING = process.env.VOLCENGINE_API_KEY || '';
const API_KEYS = API_KEYS_STRING.split(',').map(k => k.trim()).filter(k => k);

const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH || process.cwd();
const SERVER_PORT = process.env.SERVER_PORT || '5000';
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY || '';
const VAR_HTTP_URL = process.env.VarHttpUrl || 'http://localhost';
const VAR_HTTPS_URL = process.env.VarHttpsUrl || '';

const DEFAULT_WATERMARK = process.env.DEFAULT_WATERMARK === 'true';
const DEFAULT_RESPONSE_FORMAT = process.env.DEFAULT_RESPONSE_FORMAT || 'url';
const DEBUG_MODE = (process.env.DebugMode || 'false').toLowerCase() === 'true';

const CACHE_FILE_PATH = path.join(__dirname, '.doubao_api_cache.json');
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const VALID_RESOLUTIONS = [
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
const DEFAULT_RESOLUTION = '1024x1024';

// ============================================================
//  Utilities
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
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
              .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isPathWithinBase(target, base) {
    const rt = path.resolve(target);
    const rb = path.resolve(base);
    return rt === rb || rt.startsWith(rb + path.sep);
}

// ============================================================
//  API Key Pool
// ============================================================

class ApiKeyPool {
    constructor(keys) {
        this.state = this._load();
        const envSet = new Set(keys);
        const stateSet = new Set(this.state.keys.map(k => k.key));
        if (this.state.keys.length !== keys.length || ![...envSet].every(k => stateSet.has(k))) {
            log('info', `初始化API密钥池，共${keys.length}个密钥`);
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
            log('warn', '所有API密钥已禁用，尝试重置...');
            this._resetAll();
            active = this.state.keys.filter(k => k.active);
            if (active.length === 0) return null;
        }
        const idx = this.state.currentIndex % active.length;
        const kc = active[idx];
        this.state.currentIndex = (this.state.currentIndex + 1) % this.state.keys.length;
        log('info', `使用API密钥 #${this.state.keys.indexOf(kc) + 1}/${this.state.keys.length} (活跃: ${active.length}/${this.state.keys.length})`);
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
//  HTTPS Request Helpers
// ============================================================

function httpsRequest(options, postData) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: JSON.parse(data) });
                } catch (e) {
                    reject(new Error(`响应解析失败: ${e.message}`));
                }
            });
        });
        req.on('error', e => reject(new Error(`网络请求失败: ${e.message}`)));
        req.setTimeout(240000, () => { req.destroy(); reject(new Error('请求超时(4分钟)')); });
        if (postData) req.write(postData);
        req.end();
    });
}

function httpsDownload(url) {
    return new Promise((resolve, reject) => {
        const fullUrl = url.startsWith('http') ? url : `https:${url}`;
        https.get(fullUrl, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                https.get(res.headers.location, (rr) => {
                    const chunks = [];
                    rr.on('data', c => chunks.push(c));
                    rr.on('end', () => resolve({ data: Buffer.concat(chunks), contentType: rr.headers['content-type'] }));
                    rr.on('error', reject);
                });
                return;
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ data: Buffer.concat(chunks), contentType: res.headers['content-type'] }));
            res.on('error', reject);
        }).on('error', reject);
    });
}

const MAX_MODEL_FALLBACK = 3;

async function callAPI(requestBody, retryCount = 0, _failedModels = null) {
    const kc = apiKeyPool.getNextKey();
    if (!kc) throw new Error('没有可用的API密钥（所有密钥都已失效）');
    const apiKey = kc.key;
    const postData = JSON.stringify(requestBody);

    debugLog(`API请求: ${postData.substring(0, 300)}...`);

    const res = await httpsRequest({
        hostname: API_BASE_HOST, port: 443, path: API_IMAGE_PATH, method: 'POST',
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

    const errMsg = res.body?.error?.message || `API错误: ${res.statusCode}`;

    if (res.statusCode === 429) {
        apiKeyPool.markError(apiKey, 'quota_exceeded');
        if (retryCount < API_KEYS.length - 1) {
            log('info', `配额耗尽，切换密钥重试 (${retryCount + 1}/${API_KEYS.length - 1})`);
            return callAPI(requestBody, retryCount + 1, _failedModels);
        }
        throw new Error('所有API密钥的配额都已用完');
    }
    if (res.statusCode === 401) { apiKeyPool.markError(apiKey, 'auth_failed'); throw new Error(`认证失败: ${errMsg}`); }

    if (res.statusCode === 400) {
        const failedModels = _failedModels || new Set();
        failedModels.add(requestBody.model);

        if (failedModels.size <= MAX_MODEL_FALLBACK) {
            log('warn', `模型 "${requestBody.model}" 请求失败(400)，尝试自动降级... (${failedModels.size}/${MAX_MODEL_FALLBACK})`);
            const fallbackModel = await discoverFallbackModel(failedModels);
            if (fallbackModel) {
                log('info', `自动降级到模型: ${fallbackModel}`);
                requestBody.model = fallbackModel;
                return callAPI(requestBody, 0, failedModels);
            }
        }
        const triedList = _failedModels ? ` 已尝试模型: ${[..._failedModels].join(', ')}` : '';
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
            if (alt) { log('info', `从缓存找到备选模型: ${alt.id}`); return alt.id; }
        }

        log('info', '缓存无可用备选模型，实时查询API...');
        const kc = apiKeyPool.getNextKey();
        if (!kc) return null;

        const res = await httpsRequest({
            hostname: API_BASE_HOST, port: 443, path: API_MODELS_PATH, method: 'GET',
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
//  Image Input Processing
// ============================================================

async function processImageInput(image) {
    if (!image) return null;
    if (Array.isArray(image)) return Promise.all(image.map(processImageInput));
    if (typeof image !== 'string') return image;
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
        log('info', `读取本地文件: ${filePath}`);
        try {
            const buffer = await fs.readFile(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const mimeMap = { '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
            const mime = mimeMap[ext] || 'image/jpeg';
            return `data:${mime};base64,${buffer.toString('base64')}`;
        } catch (e) {
            if (e.code === 'ENOENT') {
                const err = new Error('本地文件未找到，需要远程获取。');
                err.code = 'FILE_NOT_FOUND_LOCALLY';
                err.fileUrl = image;
                throw err;
            }
            throw new Error(`读取文件失败: ${e.message}`);
        }
    }
    return image;
}

// ============================================================
//  Model Discovery (with cache)
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
    if (!kc) throw new Error('没有可用的API密钥');

    const res = await httpsRequest({
        hostname: API_BASE_HOST, port: 443, path: API_MODELS_PATH, method: 'GET',
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
        return '未找到可用的图像生成模型。请确认火山方舟账户中已开通相关模型。';
    }
    let text = `**可用的图像生成模型** (${fromCache ? '缓存' : '实时查询'})：\n\n`;
    text += `当前默认模型：\`${DEFAULT_MODEL_ID}\`\n\n`;
    models.forEach((m, i) => {
        text += `${i + 1}. \`${m.id}\``;
        if (m.id === DEFAULT_MODEL_ID) text += ' ← 当前默认';
        if (m.owned_by) text += ` (${m.owned_by})`;
        text += '\n';
    });
    text += '\n使用 `model` 参数可指定生成时使用的模型。';
    return text;
}

// ============================================================
//  Command Handlers
// ============================================================

async function handleGenerate(args) {
    const prompt = args.prompt || args.Prompt;
    if (!prompt) throw new Error('必须提供 prompt 参数');

    const resolution = resolveResolution(args.resolution || args.size || args.Resolution);
    const watermark = args.watermark !== undefined ? args.watermark : DEFAULT_WATERMARK;
    const seed = args.seed ?? -1;
    const model = args.model || DEFAULT_MODEL_ID;

    const body = {
        model, prompt, size: resolution, watermark,
        response_format: DEFAULT_RESPONSE_FORMAT
    };
    if (seed !== -1) body.seed = seed;
    if (args.guidance_scale !== undefined) body.guidance_scale = args.guidance_scale;

    return callAPI(body);
}

async function handleEdit(args) {
    const prompt = args.prompt || args.Prompt;
    if (!prompt) throw new Error('必须提供 prompt 参数');
    const image = await processImageInput(args.image || args.Image || args.image_url);
    if (!image) throw new Error('图生图模式必须提供 image 参数');

    let resolution = args.resolution || args.size || args.Resolution;
    if (!resolution || resolution === 'adaptive' || resolution === 'auto') resolution = '1024x1024';
    resolution = resolveResolution(resolution);

    const watermark = args.watermark !== undefined ? args.watermark : DEFAULT_WATERMARK;
    const model = args.model || DEFAULT_MODEL_ID;

    const body = {
        model, prompt, image, size: resolution, watermark,
        response_format: DEFAULT_RESPONSE_FORMAT
    };
    if (args.seed !== undefined && args.seed !== -1) body.seed = args.seed;

    return callAPI(body);
}

async function handleCompose(args) {
    const prompt = args.prompt || args.Prompt;
    if (!prompt) throw new Error('必须提供 prompt 参数');

    let images = args.image || args.images || args.Image || args.Images;
    if (!images) throw new Error('多图融合模式必须提供 image 参数');
    if (!Array.isArray(images)) {
        if (typeof images === 'string' && images.startsWith('[')) {
            try { images = JSON.parse(images); } catch { images = [images]; }
        } else {
            images = [images];
        }
    }
    if (images.length < 2) throw new Error('多图融合至少需要2张图片');
    if (images.length > 10) throw new Error('多图融合最多支持10张图片');

    const processed = await processImageInput(images);

    let resolution = args.resolution || args.size || args.Resolution;
    if (!resolution || resolution === 'adaptive' || resolution === 'auto') resolution = '1024x1024';
    resolution = resolveResolution(resolution);

    const watermark = args.watermark !== undefined ? args.watermark : DEFAULT_WATERMARK;
    const model = args.model || DEFAULT_MODEL_ID;

    const body = {
        model, prompt, image: processed, size: resolution, watermark,
        response_format: DEFAULT_RESPONSE_FORMAT,
        sequential_image_generation: 'disabled'
    };

    return callAPI(body);
}

async function handleGroup(args) {
    const prompt = args.prompt || args.Prompt;
    if (!prompt) throw new Error('必须提供 prompt 参数');

    const maxImages = parseInt(args.max_images || args.maxImages || args.count || 4);
    if (maxImages < 1 || maxImages > 15) throw new Error('max_images 必须在 1-15 范围内');

    const resolution = resolveResolution(args.resolution || args.size || args.Resolution);
    const watermark = args.watermark !== undefined ? args.watermark : DEFAULT_WATERMARK;
    const model = args.model || DEFAULT_MODEL_ID;
    const image = args.image ? await processImageInput(args.image) : null;

    const body = {
        model, prompt, size: resolution, watermark,
        response_format: DEFAULT_RESPONSE_FORMAT,
        sequential_image_generation: 'auto',
        sequential_image_generation_options: { max_images: maxImages }
    };
    if (image) body.image = image;

    return callAPI(body);
}

function resolveResolution(input) {
    if (!input) return DEFAULT_RESOLUTION;
    const lower = input.toLowerCase();
    if (lower === '1k') return '1K';
    if (lower === '2k') return '2K';
    if (lower === '4k') return '4K';
    if (VALID_RESOLUTIONS.includes(input)) return input;
    if (/^\d+x\d+$/.test(input)) return input;
    log('warn', `无效的分辨率 "${input}"，使用默认值 ${DEFAULT_RESOLUTION}`);
    return DEFAULT_RESOLUTION;
}

// ============================================================
//  Save Image & Build Response
// ============================================================

async function saveImageToLocal(imageUrl, imageBase64) {
    try {
        let imageBuffer;
        let ext = 'png';

        if (imageBase64) {
            imageBuffer = Buffer.from(imageBase64, 'base64');
        } else if (imageUrl) {
            const resp = await httpsDownload(imageUrl);
            imageBuffer = resp.data;
            const ct = resp.contentType || '';
            if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpg';
            else if (ct.includes('webp')) ext = 'webp';
        } else {
            return null;
        }

        const fileName = `${crypto.randomUUID()}.${ext}`;
        const imageDir = path.join(PROJECT_BASE_PATH, 'image', 'doubaogen');
        const localPath = path.join(imageDir, fileName);

        if (!isPathWithinBase(localPath, PROJECT_BASE_PATH)) {
            log('error', `安全检查失败: 路径逃逸 ${localPath}`);
            return null;
        }

        await fs.mkdir(imageDir, { recursive: true });
        await fs.writeFile(localPath, imageBuffer);

        const relUrl = path.join('doubaogen', fileName).replace(/\\/g, '/');
        const accessibleUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relUrl}`;

        log('info', `图片已保存: ${localPath}`);
        return { localPath, fileName, accessibleUrl, serverPath: `image/doubaogen/${fileName}` };
    } catch (e) {
        log('error', `保存图片失败: ${e.message}`);
        return null;
    }
}

function getCommandDesc(cmd) {
    return { generate: '文生图', edit: '图生图', compose: '多图融合', group: '组图生成' }[cmd] || cmd;
}

async function buildResponse(apiResult, command, prompt) {
    const images = apiResult.data || [];
    const usage = apiResult.usage || {};
    const isB64 = DEFAULT_RESPONSE_FORMAT === 'b64_json';

    const savedImages = [];
    const base64Images = [];

    for (const img of images) {
        if (img.error) continue;
        let saved = null;
        let b64 = null;
        if (isB64 && img.b64_json) {
            saved = await saveImageToLocal(null, img.b64_json);
            b64 = img.b64_json;
        } else if (!isB64 && img.url) {
            saved = await saveImageToLocal(img.url, null);
        } else {
            saved = await saveImageToLocal(img.url, img.b64_json);
            b64 = img.b64_json;
        }
        if (saved) {
            savedImages.push(saved);
            if (b64) base64Images.push({ base64: `data:image/png;base64,${b64}`, localUrl: saved.accessibleUrl });
        }
    }

    const successCount = images.filter(i => !i.error).length;
    const failedImages = images.filter(i => i.error);

    let text = `**图像生成成功！**\n\n`;
    text += `**提示词**: ${prompt}\n`;
    text += `**生成方式**: ${getCommandDesc(command)}\n`;
    text += `**使用模型**: ${apiResult.model || DEFAULT_MODEL_ID}\n`;
    text += `**生成数量**: ${successCount} 张\n`;
    text += `**返回格式**: ${isB64 ? 'Base64' : 'URL'}\n`;

    if (savedImages.length > 0) {
        text += `**已保存到本地**: ${savedImages.length} 张\n`;
        text += `**保存路径**: image/doubaogen/\n\n`;
        text += `**可访问URL：**\n`;
        savedImages.forEach((s, i) => { text += `- 图片${i + 1}: ${s.accessibleUrl}\n`; });
        if (isB64 && base64Images.length > 0) text += `\nBase64格式：图片数据已嵌入，AI可以直接查看！`;
    }
    if (usage.output_tokens) text += `\n**Token消耗**: ${usage.output_tokens}\n`;
    if (failedImages.length > 0) {
        text += `\n**部分图片生成失败**: ${failedImages.length} 张\n`;
        failedImages.forEach((img, i) => { text += `  - 图片${i + 1}: ${img.error?.message || '未知错误'}\n`; });
    }
    if (!isB64 && successCount > 0) text += `\n**注意**: API返回的图片链接将在24小时后失效，但本地保存的图片永久有效！`;

    const contentArray = [{ type: 'text', text }];
    if (isB64 && base64Images.length > 0) {
        base64Images.forEach(img => {
            contentArray.push({ type: 'image_url', image_url: { url: img.base64 } });
        });
    }

    return {
        content: contentArray,
        details: {
            serverPath: savedImages[0]?.serverPath || null,
            fileName: savedImages[0]?.fileName || null,
            imageUrls: savedImages.map(s => s.accessibleUrl),
            prompt, command,
            model: apiResult.model,
            created: apiResult.created,
            usage,
            image_count: successCount,
            response_format: DEFAULT_RESPONSE_FORMAT
        }
    };
}

// ============================================================
//  Main
// ============================================================

async function main() {
    try {
        if (API_KEYS.length === 0) throw new Error('未配置 VOLCENGINE_API_KEY，请在 config.env 中设置');
        if (!apiKeyPool) {
            apiKeyPool = new ApiKeyPool(API_KEYS);
            log('info', `密钥池就绪，共${API_KEYS.length}个密钥`);
        }

        const input = await new Promise(resolve => {
            let data = '';
            process.stdin.on('data', chunk => data += chunk);
            process.stdin.on('end', () => resolve(data));
        });

        if (!input.trim()) {
            outputAndExit({ status: 'error', error: 'DoubaoGen Plugin Error: 未收到输入数据' });
            return;
        }

        const args = JSON.parse(input);
        debugLog('收到参数:', JSON.stringify(args).substring(0, 300));

        const command = (args.command || args.Command || args.cmd || 'generate').toLowerCase();

        let result;

        switch (command) {
            case 'generate': case 'text2image': case 't2i': {
                const apiResult = await handleGenerate(args);
                result = await buildResponse(apiResult, 'generate', args.prompt || args.Prompt || '');
                break;
            }
            case 'edit': case 'image2image': case 'i2i': {
                const apiResult = await handleEdit(args);
                result = await buildResponse(apiResult, 'edit', args.prompt || args.Prompt || '');
                break;
            }
            case 'compose': case 'merge': case 'fusion': {
                const apiResult = await handleCompose(args);
                result = await buildResponse(apiResult, 'compose', args.prompt || args.Prompt || '');
                break;
            }
            case 'group': case 'sequential': case 'series': {
                const apiResult = await handleGroup(args);
                result = await buildResponse(apiResult, 'group', args.prompt || args.Prompt || '');
                break;
            }
            case 'list_models': case 'models': {
                result = await handleListModels(args);
                break;
            }
            default:
                throw new Error(`未知命令: ${command}。可用: generate, edit, compose, group, list_models`);
        }

        log('info', `命令 "${command}" 执行成功`);
        outputAndExit({ status: 'success', result });

    } catch (error) {
        log('error', `错误: ${error.message}`);
        if (error.code === 'FILE_NOT_FOUND_LOCALLY') {
            outputAndExit({ status: 'error', code: error.code, error: error.message, fileUrl: error.fileUrl });
        } else {
            outputAndExit({ status: 'error', error: `DoubaoGen Plugin Error: ${error.message}` });
        }
    }
}

main();
