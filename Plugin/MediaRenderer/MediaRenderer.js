const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns/promises');
const net = require('net');
const { spawn } = require('child_process');
const { fileURLToPath } = require('url');
const mime = require('mime-types');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const browserRuntimeManager = require('../../modules/browserRuntimeManager.js');
const {
    CORE_CURSOR_ROLES,
    OPTIONAL_CURSOR_ROLES,
    DEFAULT_CURSOR_SIZES,
    sanitizeThemeName,
    sanitizePackageStem,
    parseHotspot,
    scaleHotspot,
    validateCursorRoles,
    encodeCur,
    encodeAni,
    buildThemeZip
} = require('./CursorThemePackager.js');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_SUBDIR = 'media-renderer';
const MIN_DIMENSION = 64;
const MAX_DIMENSION = 4096;
const MAX_PIXELS = MAX_DIMENSION * MAX_DIMENSION;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_BATCH_SIZE = 16;
const DEFAULT_TIMEOUT_MS = 45000;
const MAX_TIMEOUT_MS = 120000;
const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const ANIMATION_FORMATS = new Set(['gif', 'mp4', 'webm']);
const SUPPORTED_FORMATS = new Set([...IMAGE_FORMATS, ...ANIMATION_FORMATS]);
const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_ASSET_COUNT = 24;
const MAX_FFMPEG_ERROR_BYTES = 64 * 1024;
const DEFAULT_DURATION_MS = 5000;
const DEFAULT_FPS = 30;
const DEFAULT_MAX_FRAMES = 600;
const DEFAULT_AUDIO_DURATION_MS = 10000;
const DEFAULT_AUDIO_SAMPLE_RATE = 44100;
const DEFAULT_AUDIO_TIMEOUT_MS = 30000;
const MAX_AUDIO_CODE_BYTES = 1024 * 1024;
const MAX_AUDIO_TOTAL_SAMPLES = 30 * 1000 * 1000;
const MAX_AUDIO_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_AUDIO_PROCESS_OUTPUT_BYTES = 256 * 1024;
const AUDIO_WORKER_PATH = path.join(__dirname, 'AudioSynthesisWorker.js');
const MAX_CURSOR_THEME_FRAMES = 240;
const MAX_CURSOR_ROLE_FRAMES = 120;
const DEFAULT_CURSOR_FPS = 24;
const CURSOR_PREVIEW_CELL_WIDTH = 168;
const CURSOR_PREVIEW_CELL_HEIGHT = 132;
const TRUSTED_LIBRARY_CDN_HOSTS = new Set([
    'cdn.jsdelivr.net',
    'unpkg.com',
    'cdnjs.cloudflare.com'
]);
const BUILTIN_LIBRARIES = Object.freeze({
    anime: {
        path: path.join(PROJECT_ROOT, 'AdminPanel-Vue', 'vendor', 'anime.min.js'),
        global: 'anime'
    },
    animejs: {
        path: path.join(PROJECT_ROOT, 'AdminPanel-Vue', 'vendor', 'anime.min.js'),
        global: 'anime'
    },
    three: {
        path: path.join(PROJECT_ROOT, 'AdminPanel-Vue', 'vendor', 'three.min.js'),
        global: 'THREE'
    },
    threejs: {
        path: path.join(PROJECT_ROOT, 'AdminPanel-Vue', 'vendor', 'three.min.js'),
        global: 'THREE'
    }
});
const ASSET_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MEDIA_RENDERER_BOOTSTRAP = `
<script>
(() => {
    const state = {
        ready: false,
        readyPromise: null,
        readyResolve: null,
        frameRenderer: null
    };
    state.readyPromise = new Promise(resolve => { state.readyResolve = resolve; });
    window.__MEDIA_RENDERER__ = {
        get ready() { return state.ready; },
        setReady() {
            if (!state.ready) {
                state.ready = true;
                state.readyResolve();
            }
        },
        waitUntilReady() { return state.readyPromise; },
        setFrameRenderer(renderer) {
            if (typeof renderer !== 'function') throw new Error('frameRenderer 必须是函数。');
            state.frameRenderer = renderer;
        },
        async renderFrame(timeMs, frameIndex, fps) {
            if (state.frameRenderer) {
                await state.frameRenderer(timeMs, frameIndex, fps);
            } else if (typeof window.__MEDIA_RENDERER_RENDER_FRAME__ === 'function') {
                await window.__MEDIA_RENDERER_RENDER_FRAME__(timeMs, frameIndex, fps);
            } else {
                for (const animation of document.getAnimations()) {
                    animation.pause();
                    animation.currentTime = timeMs;
                }
            }
            await new Promise(resolve => requestAnimationFrame(() =>
                requestAnimationFrame(resolve)
            ));
        }
    };
})();
</script>`;
const CURSOR_THEME_BOOTSTRAP = `
<script>
(() => {
    const state = {
        ready: false,
        readyPromise: null,
        readyResolve: null,
        renderer: null
    };
    state.readyPromise = new Promise(resolve => { state.readyResolve = resolve; });
    window.__CURSOR_THEME__ = {
        get ready() { return state.ready; },
        setReady() {
            if (!state.ready) {
                state.ready = true;
                state.readyResolve();
            }
        },
        waitUntilReady() { return state.readyPromise; },
        setRenderer(renderer) {
            if (typeof renderer !== 'function') {
                throw new Error('Cursor theme renderer 必须是函数。');
            }
            state.renderer = renderer;
        },
        async render(role, timeMs, root) {
            if (state.renderer) {
                await state.renderer(role, timeMs, root);
            } else {
                for (const animation of root.getAnimations({ subtree: true })) {
                    animation.pause();
                    animation.currentTime = timeMs;
                }
            }
            await new Promise(resolve => requestAnimationFrame(() =>
                requestAnimationFrame(resolve)
            ));
        }
    };
})();
</script>`;

let pluginConfig = {};
let hostPluginManager = null;
let debugMode = false;
let renderQueue = Promise.resolve();
let builtinLibrarySourceCache = new Map();
let ffmpegAvailabilityPromise = null;
const activeAudioChildren = new Set();

function initialize(config = {}, dependencies = {}) {
    pluginConfig = config;
    hostPluginManager = dependencies.pluginManager || null;
    debugMode = parseBoolean(config.DebugMode ?? process.env.DebugMode, false);
    builtinLibrarySourceCache = new Map();
    ffmpegAvailabilityPromise = null;
}

function parseBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    return defaultValue;
}

function parseInteger(value, fallback, min, max, fieldName) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        if (fallback !== undefined) return fallback;
        throw new Error(`${fieldName} 必须是整数。`);
    }
    if (parsed < min || parsed > max) {
        throw new Error(`${fieldName} 必须在 ${min}-${max} 之间，当前值为 ${parsed}。`);
    }
    return parsed;
}

function parseNumber(value, fallback, min, max, fieldName) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        if (fallback !== undefined) return fallback;
        throw new Error(`${fieldName} 必须是数字。`);
    }
    if (parsed < min || parsed > max) {
        throw new Error(`${fieldName} 必须在 ${min}-${max} 之间，当前值为 ${parsed}。`);
    }
    return parsed;
}

function normalizeFormat(value, transparent) {
    let format = String(value || (transparent ? 'png' : 'jpg')).trim().toLowerCase();
    if (format === 'jpeg') format = 'jpg';
    if (!SUPPORTED_FORMATS.has(format)) {
        throw new Error(`不支持输出格式 ${format}，可选 png、jpg、webp、gif、mp4、webm。`);
    }
    if (transparent && format === 'jpg') {
        format = 'png';
    }
    if (transparent && format === 'mp4') {
        throw new Error('MP4/H.264 不支持透明通道；请使用 GIF、WebM，或设置 transparent=false。');
    }
    return format;
}

function normalizeLibraries(value) {
    const values = Array.isArray(value)
        ? value
        : String(value || '').split(/[\s,;]+/);
    const normalized = [];
    for (const item of values) {
        const name = String(item || '').trim().toLowerCase();
        if (!name) continue;
        if (!BUILTIN_LIBRARIES[name]) {
            throw new Error(`未知内置库 ${name}，当前支持 anime、three。`);
        }
        const canonicalName = name.startsWith('anime') ? 'anime' : 'three';
        if (!normalized.includes(canonicalName)) normalized.push(canonicalName);
    }
    return normalized;
}

function decodeHtmlUrl(value) {
    const ampersand = String.fromCharCode(38);
    return String(value || '').split(`${ampersand}amp;`).join(ampersand);
}

function detectBuiltinLibraryFromUrl(rawUrl) {
    let url;
    try {
        url = new URL(decodeHtmlUrl(rawUrl));
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || !TRUSTED_LIBRARY_CDN_HOSTS.has(url.hostname.toLowerCase())) {
        return null;
    }

    const pathname = decodeURIComponent(url.pathname).toLowerCase();
    if (
        /(?:^|\/)animejs(?:@[^/]+)?\/lib\/anime(?:\.min)?\.js$/.test(pathname) ||
        /(?:^|\/)anime(?:\.min)?\.js$/.test(pathname)
    ) {
        return 'anime';
    }
    if (
        /(?:^|\/)three(?:@[^/]+)?\/build\/three(?:\.min)?\.js$/.test(pathname) ||
        /(?:^|\/)three(?:\.min)?\.js$/.test(pathname)
    ) {
        return 'three';
    }
    return null;
}

function findBuiltinCdnLibraries(source) {
    const libraries = [];
    const scriptPattern = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>\s*<\/script\s*>/gi;
    for (const match of String(source || '').matchAll(scriptPattern)) {
        const name = detectBuiltinLibraryFromUrl(match[2]);
        if (name && !libraries.includes(name)) libraries.push(name);
    }
    return libraries;
}

function normalizeAssets(value) {
    if (value === undefined || value === null || value === '') return [];
    let assets = value;
    if (typeof assets === 'string') {
        try {
            assets = JSON.parse(assets);
        } catch (error) {
            throw new Error(`assets 必须是 JSON 数组: ${error.message}`);
        }
    }
    if (!Array.isArray(assets)) throw new Error('assets 必须是数组。');
    if (assets.length > MAX_ASSET_COUNT) {
        throw new Error(`单步最多声明 ${MAX_ASSET_COUNT} 个素材。`);
    }

    const seenIds = new Set();
    return assets.map((asset, index) => {
        if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
            throw new Error(`第 ${index + 1} 个素材必须是对象。`);
        }
        const id = String(asset.id || '').trim();
        if (!ASSET_ID_PATTERN.test(id)) {
            throw new Error(`第 ${index + 1} 个素材 id 无效；需以字母开头且只含字母、数字、_、-。`);
        }
        if (seenIds.has(id)) throw new Error(`素材 id 重复: ${id}`);
        seenIds.add(id);

        const source = String(asset.source || asset.url || '').trim();
        if (!/^(?:data:|file:|https?:)/i.test(source)) {
            throw new Error(`素材 ${id} 仅支持 data:、file://、http:// 或 https://。`);
        }
        const type = String(asset.type || 'auto').trim().toLowerCase();
        if (!['auto', 'image', 'audio', 'video', 'font', 'json', 'binary'].includes(type)) {
            throw new Error(`素材 ${id} 使用了未知 type: ${type}`);
        }
        return { id, type, source };
    });
}

function isAnimationFormat(format) {
    return ANIMATION_FORMATS.has(format);
}

function normalizeColor(value, fallback) {
    const color = String(value || fallback).trim();
    if (!color || color.length > 100) {
        throw new Error('background 必须是有效且不超过 100 字符的 CSS 颜色。');
    }
    return color;
}

function sanitizeFileStem(value) {
    const stem = String(value || '')
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/\s+/g, '-')
        .replace(/^\.+|\.+$/g, '')
        .slice(0, 80);
    return stem || crypto.randomUUID();
}

function normalizeSourceImage(value) {
    const sourceImage = String(value || '').trim();
    if (!sourceImage) return null;
    if (
        sourceImage.startsWith('data:image/') ||
        sourceImage.startsWith('http://') ||
        sourceImage.startsWith('https://') ||
        sourceImage.startsWith('file://')
    ) {
        return sourceImage;
    }
    throw new Error('sourceImage 仅支持 data:image、http://、https:// 或 file://。');
}

function normalizeRequest(raw = {}) {
    const html = typeof raw.html === 'string' ? raw.html : '';
    const svg = typeof raw.svg === 'string' ? raw.svg : '';
    if ((!html && !svg) || (html && svg)) {
        throw new Error('每一步必须且只能提供 html 或 svg 参数之一。');
    }

    const source = html || svg;
    if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
        throw new Error(`源码超过 ${MAX_SOURCE_BYTES / 1024 / 1024}MB 限制。`);
    }

    const width = parseInteger(raw.width, undefined, MIN_DIMENSION, MAX_DIMENSION, 'width');
    const height = parseInteger(raw.height, undefined, MIN_DIMENSION, MAX_DIMENSION, 'height');
    if (width * height > MAX_PIXELS) {
        throw new Error(`总像素数不能超过 ${MAX_PIXELS}。`);
    }

    const transparent = parseBoolean(raw.transparent ?? raw.transparentBackground, false);
    const format = normalizeFormat(raw.format || raw.imageFormat, transparent);
    const animation = isAnimationFormat(format);
    const quality = parseInteger(raw.quality, 90, 1, 100, 'quality');
    const timeoutMs = parseInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS, 'timeoutMs');
    const background = normalizeColor(raw.background || raw.backgroundColor, '#ffffff');
    const showBase64 = parseBoolean(raw.showBase64 ?? raw.showbase64, false);
    const libraries = normalizeLibraries(raw.libraries || raw.library || raw.libs);
    for (const name of findBuiltinCdnLibraries(source)) {
        if (!libraries.includes(name)) libraries.push(name);
    }
    const assets = normalizeAssets(raw.assets);
    const audioUrl = String(raw.audioUrl || raw.audio_url || '').trim() || null;
    if (audioUrl && !/^(?:data:|file:|https?:)/i.test(audioUrl)) {
        throw new Error('audioUrl 仅支持 data:、file://、http:// 或 https://。');
    }
    const allowJavaScript = animation || libraries.length > 0 ||
        parseBoolean(raw.allowJavaScript, false);
    const waitMs = parseInteger(raw.waitMs, 0, 0, 10000, 'waitMs');
    const durationMs = parseInteger(raw.durationMs, DEFAULT_DURATION_MS, 100, 60000, 'durationMs');
    const fps = parseInteger(raw.fps, DEFAULT_FPS, 1, 60, 'fps');
    const maxFrames = parseInteger(
        pluginConfig.MaxAnimationFrames ?? process.env.MediaRendererMaxAnimationFrames,
        DEFAULT_MAX_FRAMES,
        1,
        3600,
        'MaxAnimationFrames'
    );
    const frameCount = animation ? Math.ceil(durationMs * fps / 1000) : 1;
    if (frameCount > maxFrames) {
        throw new Error(`动画需要 ${frameCount} 帧，超过当前 ${maxFrames} 帧上限。`);
    }
    const readyMode = String(raw.readyMode || (animation ? 'auto' : 'load')).trim().toLowerCase();
    if (!['load', 'auto', 'signal'].includes(readyMode)) {
        throw new Error('readyMode 仅支持 load、auto、signal。');
    }

    return {
        sourceType: html ? 'html' : 'svg',
        source,
        width,
        height,
        transparent,
        format,
        requestedFormat: String(raw.format || raw.imageFormat || '').toLowerCase() || null,
        quality,
        timeoutMs,
        background,
        showBase64,
        allowJavaScript,
        waitMs,
        animation,
        durationMs,
        fps,
        frameCount,
        readyMode,
        libraries,
        assets,
        audioUrl,
        audioAssetId: String(raw.audioAssetId || raw.audio || '').trim() || null,
        sourceImage: normalizeSourceImage(
            raw.sourceImage || raw.source_image || raw.image || raw.image_url
        ),
        fileStem: sanitizeFileStem(raw.fileName || raw.filename || raw.name)
    };
}

function normalizeAudioRequest(raw = {}) {
    const code = String(raw.code || raw.audioCode || raw.javascript || '').trim();
    if (!code) throw new Error('GenerateAudio 必须提供 code 参数。');
    if (Buffer.byteLength(code, 'utf8') > MAX_AUDIO_CODE_BYTES) {
        throw new Error(`音频合成代码超过 ${MAX_AUDIO_CODE_BYTES / 1024 / 1024}MB 限制。`);
    }

    const maxDurationMs = parseInteger(
        pluginConfig.MaxAudioDurationMs ?? process.env.MediaRendererMaxAudioDurationMs,
        300000,
        1000,
        900000,
        'MaxAudioDurationMs'
    );
    const durationMs = parseInteger(
        raw.durationMs,
        DEFAULT_AUDIO_DURATION_MS,
        100,
        maxDurationMs,
        'durationMs'
    );
    const sampleRate = parseInteger(
        raw.sampleRate,
        DEFAULT_AUDIO_SAMPLE_RATE,
        8000,
        48000,
        'sampleRate'
    );
    const channels = parseInteger(raw.channels, 2, 1, 2, 'channels');
    const totalSamples = Math.ceil(durationMs * sampleRate / 1000) * channels;
    if (totalSamples > MAX_AUDIO_TOTAL_SAMPLES) {
        throw new Error(
            `音频需要 ${totalSamples} 个声道采样，超过 ${MAX_AUDIO_TOTAL_SAMPLES} 上限；` +
            '请降低时长、采样率或声道数。'
        );
    }

    const timeoutLimitMs = parseInteger(
        pluginConfig.AudioSynthesisTimeoutMs ?? process.env.MediaRendererAudioSynthesisTimeoutMs,
        DEFAULT_AUDIO_TIMEOUT_MS,
        1000,
        300000,
        'AudioSynthesisTimeoutMs'
    );

    return {
        code,
        durationMs,
        sampleRate,
        channels,
        tempo: parseNumber(raw.tempo, 120, 20, 400, 'tempo'),
        seed: parseInteger(raw.seed, 1, 0, 0x7fffffff, 'seed'),
        masterVolume: parseNumber(raw.masterVolume ?? raw.volume, 0.8, 0, 1, 'masterVolume'),
        fadeOutMs: parseInteger(raw.fadeOutMs, 30, 0, Math.min(durationMs, 10000), 'fadeOutMs'),
        timeoutMs: parseInteger(raw.timeoutMs, timeoutLimitMs, 1000, timeoutLimitMs, 'timeoutMs'),
        fileStem: sanitizeFileStem(raw.fileName || raw.filename || raw.name || 'generated-audio'),
        format: 'wav'
    };
}

function validateAdminForAudio(params, context = {}) {
    const supplied = String(params.requireAdmin || '').trim();
    const realCode = String(context.decryptedAuthCode || '').trim();
    if (!realCode) {
        throw new Error('无法获取管理员验证码。请确保主服务器配置正确。');
    }
    if (!/^\d{6}$/.test(supplied)) {
        throw new Error('GenerateAudio 必须提供 requireAdmin 参数（6位管理员验证码）。');
    }
    if (supplied !== realCode) {
        throw new Error('管理员验证码错误。');
    }
}

function escapeHtmlAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeInlineScript(value) {
    return String(value).replace(/<\/script/gi, '<\\/script');
}

function isPrivateAddress(address) {
    const normalized = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (net.isIPv4(normalized)) {
        const octets = normalized.split('.').map(Number);
        return octets[0] === 10 ||
            octets[0] === 127 ||
            (octets[0] === 169 && octets[1] === 254) ||
            (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
            (octets[0] === 192 && octets[1] === 168);
    }
    if (net.isIPv6(normalized)) {
        return normalized === '::1' ||
            normalized.startsWith('fc') ||
            normalized.startsWith('fd') ||
            normalized.startsWith('fe8') ||
            normalized.startsWith('fe9') ||
            normalized.startsWith('fea') ||
            normalized.startsWith('feb');
    }
    return false;
}

function isForbiddenMetadataAddress(address) {
    const normalized = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
    return normalized === '169.254.169.254' ||
        normalized === '100.100.100.200' ||
        normalized === 'fd00:ec2::254';
}

async function assertRemoteAssetUrlAllowed(rawUrl) {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error(`远程素材协议不受支持: ${url.protocol}`);
    }
    if (url.username || url.password) {
        throw new Error('远程素材 URL 不允许包含用户名或密码。');
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const allowPrivate = parseBoolean(
        pluginConfig.AllowPrivateNetworkAssets ?? process.env.MediaRendererAllowPrivateNetworkAssets,
        true
    );
    const addresses = net.isIP(hostname)
        ? [{ address: hostname }]
        : await dns.lookup(hostname, { all: true, verbatim: true });

    if (!addresses.length) throw new Error(`无法解析素材主机: ${hostname}`);
    for (const entry of addresses) {
        if (isForbiddenMetadataAddress(entry.address)) {
            throw new Error(`禁止访问云元数据地址: ${entry.address}`);
        }
        if (isPrivateAddress(entry.address) && !allowPrivate) {
            throw new Error(`当前配置禁止访问内网素材地址: ${entry.address}`);
        }
    }
    return url;
}

function parseDataUri(source, assetId) {
    const match = String(source).match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
    if (!match) throw new Error(`素材 ${assetId} 的 Data URI 无效。`);
    const mimeType = match[1] || 'application/octet-stream';
    const buffer = match[2]
        ? Buffer.from(match[3], 'base64')
        : Buffer.from(decodeURIComponent(match[3]), 'utf8');
    return { buffer, mimeType };
}

async function readResponseBufferWithLimit(response, limitBytes, assetId) {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limitBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(`素材 ${assetId} 超过 ${limitBytes / 1024 / 1024}MB 限制。`);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
}

async function downloadRemoteAsset(source, assetId, timeoutMs) {
    let currentUrl = source;
    for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
        await assertRemoteAssetUrlAllowed(currentUrl);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            response = await fetch(currentUrl, {
                redirect: 'manual',
                signal: controller.signal,
                headers: { 'User-Agent': 'VCPToolBox-MediaRenderer/1.0' }
            });
        } finally {
            clearTimeout(timer);
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location) throw new Error(`素材 ${assetId} 重定向缺少 Location。`);
            currentUrl = new URL(location, currentUrl).href;
            continue;
        }
        if (!response.ok) {
            throw new Error(`素材 ${assetId} 下载失败: HTTP ${response.status}`);
        }
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_ASSET_BYTES) {
            throw new Error(`素材 ${assetId} 超过 ${MAX_ASSET_BYTES / 1024 / 1024}MB 限制。`);
        }
        return {
            buffer: await readResponseBufferWithLimit(response, MAX_ASSET_BYTES, assetId),
            mimeType: String(response.headers.get('content-type') || '').split(';')[0] ||
                mime.lookup(new URL(currentUrl).pathname) ||
                'application/octet-stream',
            sourceUrl: currentUrl
        };
    }
    throw new Error(`素材 ${assetId} 重定向次数超过 5 次。`);
}

async function resolveAsset(asset, timeoutMs) {
    let buffer;
    let mimeType;
    let localPath = null;

    if (asset.source.startsWith('data:')) {
        ({ buffer, mimeType } = parseDataUri(asset.source, asset.id));
    } else if (asset.source.startsWith('file:')) {
        localPath = fileURLToPath(asset.source);
        const stat = await fs.stat(localPath);
        if (!stat.isFile()) throw new Error(`素材 ${asset.id} 不是普通文件。`);
        if (stat.size > MAX_ASSET_BYTES) {
            throw new Error(`素材 ${asset.id} 超过 ${MAX_ASSET_BYTES / 1024 / 1024}MB 限制。`);
        }
        buffer = await fs.readFile(localPath);
        mimeType = mime.lookup(localPath) || 'application/octet-stream';
    } else {
        const remote = await downloadRemoteAsset(asset.source, asset.id, timeoutMs);
        buffer = remote.buffer;
        mimeType = remote.mimeType;
    }

    if (buffer.length > MAX_ASSET_BYTES) {
        throw new Error(`素材 ${asset.id} 超过 ${MAX_ASSET_BYTES / 1024 / 1024}MB 限制。`);
    }
    return {
        ...asset,
        buffer,
        mimeType,
        localPath,
        dataUri: `data:${mimeType};base64,${buffer.toString('base64')}`
    };
}

async function resolveAssets(request) {
    const resolved = [];
    let totalBytes = 0;
    const declaredAssets = [...request.assets];
    if (request.audioUrl) {
        if (declaredAssets.some(asset => asset.id === '__directAudio')) {
            throw new Error('素材 id __directAudio 为插件保留名称。');
        }
        declaredAssets.push({
            id: '__directAudio',
            type: 'audio',
            source: request.audioUrl
        });
        request.audioAssetId = '__directAudio';
    }
    if (declaredAssets.length > MAX_ASSET_COUNT) {
        throw new Error(`单步最多使用 ${MAX_ASSET_COUNT} 个素材。`);
    }

    for (const asset of declaredAssets) {
        const item = await resolveAsset(asset, request.timeoutMs);
        totalBytes += item.buffer.length;
        if (totalBytes > MAX_TOTAL_ASSET_BYTES) {
            throw new Error(`素材总大小超过 ${MAX_TOTAL_ASSET_BYTES / 1024 / 1024}MB 限制。`);
        }
        resolved.push(item);
    }
    if (request.audioAssetId) {
        const audio = resolved.find(asset => asset.id === request.audioAssetId);
        if (!audio) throw new Error(`audioAssetId 指向不存在的素材: ${request.audioAssetId}`);
        if (audio.type !== 'audio' && !audio.mimeType.startsWith('audio/')) {
            throw new Error(`素材 ${audio.id} 不是音频素材。`);
        }
    }
    return resolved;
}

function rewriteBuiltinCdnScriptTags(source) {
    return String(source).replace(
        /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>\s*<\/script\s*>/gi,
        (tag, _quote, rawUrl) => {
            const library = detectBuiltinLibraryFromUrl(rawUrl);
            return library
                ? `<!-- MediaRenderer: ${library} CDN redirected to bundled local script -->`
                : tag;
        }
    );
}

function assertNoExternalScripts(source) {
    const match = String(source).match(
        /<script\b[^>]*\bsrc\s*=\s*(["'])(?:https?:\/\/|file:\/\/)[\s\S]*?\1[^>]*>/i
    );
    if (match) {
        throw new Error('仅允许通过可信 CDN script 标签引用 Anime.js/Three.js；其他外部脚本禁止执行。');
    }
}

function collectDirectSourceUrls(source) {
    const found = new Map();
    const add = rawValue => {
        const original = String(rawValue || '').trim();
        const fetchUrl = decodeHtmlUrl(original);
        if (/^(?:https?:|file:)/i.test(fetchUrl) && !found.has(original)) {
            found.set(original, fetchUrl);
        }
    };

    const assetTagPattern = /<(?:img|image|video|audio|source|track|link|input|use)\b[^>]*>/gi;
    for (const tagMatch of String(source).matchAll(assetTagPattern)) {
        const tag = tagMatch[0];
        const attributePattern = /\b(?:src|poster|href|xlink:href)\s*=\s*(["'])(.*?)\1/gi;
        for (const attributeMatch of tag.matchAll(attributePattern)) add(attributeMatch[2]);

        const srcsetPattern = /\bsrcset\s*=\s*(["'])(.*?)\1/gi;
        for (const srcsetMatch of tag.matchAll(srcsetPattern)) {
            for (const candidate of srcsetMatch[2].split(',')) {
                add(candidate.trim().split(/\s+/)[0]);
            }
        }
    }

    const cssUrlPattern = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
    for (const match of String(source).matchAll(cssUrlPattern)) add(match[2]);
    return [...found.entries()].map(([original, fetchUrl]) => ({ original, fetchUrl }));
}

async function resolveDirectSourceAssets(source, existingAssets, timeoutMs) {
    let rewrittenSource = rewriteBuiltinCdnScriptTags(source);
    assertNoExternalScripts(rewrittenSource);
    const references = collectDirectSourceUrls(rewrittenSource);
    if (references.length + existingAssets.length > MAX_ASSET_COUNT) {
        throw new Error(
            `源码直引资源与兼容 assets 合计最多 ${MAX_ASSET_COUNT} 个，当前为 ` +
            `${references.length + existingAssets.length} 个。`
        );
    }

    let totalBytes = existingAssets.reduce((sum, asset) => sum + asset.buffer.length, 0);
    const directAssets = [];
    for (const [index, reference] of references.entries()) {
        const asset = await resolveAsset({
            id: `direct${index + 1}`,
            type: 'auto',
            source: reference.fetchUrl
        }, timeoutMs);
        totalBytes += asset.buffer.length;
        if (totalBytes > MAX_TOTAL_ASSET_BYTES) {
            throw new Error(`素材总大小超过 ${MAX_TOTAL_ASSET_BYTES / 1024 / 1024}MB 限制。`);
        }
        rewrittenSource = rewrittenSource.split(reference.original).join(asset.dataUri);
        directAssets.push(asset);
    }

    return { source: rewrittenSource, directAssets };
}

function applyAssetPlaceholders(source, assets) {
    let result = source;
    for (const asset of assets) {
        const placeholder = `{{ASSET:${asset.id}}}`;
        if (result.includes(placeholder)) {
            result = result.replaceAll(placeholder, escapeHtmlAttribute(asset.dataUri));
        }
    }
    const unresolved = result.match(/{{ASSET:([^}]+)}}/);
    if (unresolved) throw new Error(`源码引用了未声明素材: ${unresolved[1]}`);
    return result;
}

async function getBuiltinLibraryScripts(libraries) {
    const scripts = [];
    for (const name of libraries) {
        const library = BUILTIN_LIBRARIES[name];
        if (!builtinLibrarySourceCache.has(name)) {
            builtinLibrarySourceCache.set(name, await fs.readFile(library.path, 'utf8'));
        }
        scripts.push(`<script>${escapeInlineScript(builtinLibrarySourceCache.get(name))}</script>`);
    }
    return scripts.join('\n');
}

async function resolveSourceImage(request) {
    if (!request.sourceImage) {
        return { resolvedSourceImage: null, allowedRemoteUrl: null };
    }

    if (request.sourceImage.startsWith('data:image/')) {
        if (Buffer.byteLength(request.sourceImage, 'utf8') > MAX_SOURCE_IMAGE_BYTES * 1.5) {
            throw new Error(`sourceImage Data URI 超过约 ${MAX_SOURCE_IMAGE_BYTES / 1024 / 1024}MB 限制。`);
        }
        return {
            resolvedSourceImage: request.sourceImage,
            allowedRemoteUrl: null
        };
    }

    if (request.sourceImage.startsWith('http://') || request.sourceImage.startsWith('https://')) {
        const image = await resolveAsset({
            id: 'sourceImage',
            type: 'image',
            source: request.sourceImage
        }, request.timeoutMs);
        if (!image.mimeType.startsWith('image/')) {
            throw new Error(`sourceImage 远程资源不是图片: ${image.mimeType}`);
        }
        await sharp(image.buffer, { limitInputPixels: MAX_PIXELS }).metadata();
        return {
            resolvedSourceImage: image.dataUri,
            allowedRemoteUrl: null
        };
    }

    const fileUrl = new URL(request.sourceImage);
    let localPath = decodeURIComponent(fileUrl.pathname);
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(localPath)) {
        localPath = localPath.slice(1);
    }

    const stat = await fs.stat(localPath);
    if (!stat.isFile()) {
        throw new Error('sourceImage 的 file:// 地址不是普通文件。');
    }
    if (stat.size > MAX_SOURCE_IMAGE_BYTES) {
        throw new Error(`sourceImage 文件超过 ${MAX_SOURCE_IMAGE_BYTES / 1024 / 1024}MB 限制。`);
    }

    const imageBuffer = await fs.readFile(localPath);
    const metadata = await sharp(imageBuffer, { limitInputPixels: MAX_PIXELS }).metadata();
    const mimeMap = {
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        tiff: 'image/tiff',
        avif: 'image/avif'
    };
    const mimeType = mimeMap[metadata.format];
    if (!mimeType) {
        throw new Error(`sourceImage 文件不是受支持的图片格式: ${metadata.format || 'unknown'}`);
    }

    return {
        resolvedSourceImage: `data:${mimeType};base64,${imageBuffer.toString('base64')}`,
        allowedRemoteUrl: null
    };
}

function applySourceImagePlaceholder(source, resolvedSourceImage) {
    if (!resolvedSourceImage) return source;
    if (!source.includes('{{SOURCE_IMAGE}}')) {
        throw new Error('提供 sourceImage 时，html/svg 源码中必须包含 {{SOURCE_IMAGE}} 占位符。');
    }
    return source.replaceAll('{{SOURCE_IMAGE}}', escapeHtmlAttribute(resolvedSourceImage));
}

async function buildHtmlDocument(request, resolvedSourceImage, assets, preparedSource = null) {
    let source = applySourceImagePlaceholder(preparedSource || request.source, resolvedSourceImage);
    source = applyAssetPlaceholders(source, assets);
    const libraryScripts = await getBuiltinLibraryScripts(request.libraries);
    const runtimeHead = `${MEDIA_RENDERER_BOOTSTRAP}\n${CURSOR_THEME_BOOTSTRAP}\n${libraryScripts}`;

    if (request.sourceType === 'svg') {
        return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${runtimeHead}
<style>
html, body {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    overflow: hidden;
    background: transparent !important;
}
body {
    display: flex;
    align-items: center;
    justify-content: center;
}
body > svg {
    display: block;
    width: 100%;
    height: 100%;
}
</style>
</head>
<body>${source}</body>
</html>`;
    }

    if (/<head(?:\s[^>]*)?>/i.test(source)) {
        return source.replace(/<head(\s[^>]*)?>/i, match => `${match}\n${runtimeHead}`);
    }
    if (/<html(?:\s[^>]*)?>/i.test(source)) {
        return source.replace(/<html(\s[^>]*)?>/i, match =>
            `${match}\n<head><meta charset="utf-8">${runtimeHead}</head>`
        );
    }
    return `<!doctype html><html><head><meta charset="utf-8">${runtimeHead}</head><body>${source}</body></html>`;
}

async function waitForPageReady(page, request) {
    const sourceRequestsSignal = /__MEDIA_RENDERER__(?:_READY__|\.setReady|\[['"]setReady['"]\])/i
        .test(request.source);
    if (request.readyMode === 'load' || (request.readyMode === 'auto' && !sourceRequestsSignal)) {
        return;
    }
    await page.waitForFunction(
        () => window.__MEDIA_RENDERER__?.ready === true ||
            window.__MEDIA_RENDERER_READY__ === true,
        { timeout: request.timeoutMs }
    );
}

async function applyCanvasPolicy(page, request) {
    await page.addStyleTag({
        content: `
html, body {
    width: 100% !important;
    height: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    ${request.transparent ? 'background: transparent !important;' : ''}
}
`
    });
}

async function installNetworkPolicy(page, allowedRemoteUrl = null) {
    await page.setRequestInterception(true);
    page.on('request', request => {
        const url = request.url();
        if (
            url === 'about:blank' ||
            url.startsWith('data:') ||
            url.startsWith('blob:') ||
            (allowedRemoteUrl && url === allowedRemoteUrl)
        ) {
            request.continue().catch(() => {});
            return;
        }
        request.abort('blockedbyclient').catch(() => {});
    });
}

async function waitForImages(page, timeoutMs) {
    await page.evaluate(async (imageTimeoutMs) => {
        const images = Array.from(document.images);
        await Promise.all(images.map(image => new Promise((resolve, reject) => {
            if (image.complete) {
                if (image.naturalWidth > 0) {
                    image.decode?.().then(resolve, resolve);
                } else {
                    reject(new Error(`图片加载失败: ${image.currentSrc || image.src || 'unknown'}`));
                }
                return;
            }

            const timer = setTimeout(() => {
                reject(new Error(`等待图片超时: ${image.currentSrc || image.src || 'unknown'}`));
            }, imageTimeoutMs);

            image.addEventListener('load', () => {
                clearTimeout(timer);
                image.decode?.().then(resolve, resolve);
            }, { once: true });
            image.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error(`图片加载失败: ${image.currentSrc || image.src || 'unknown'}`));
            }, { once: true });
        })));
    }, timeoutMs);
}

async function encodeImage(pngBuffer, request) {
    let pipeline = sharp(pngBuffer, { limitInputPixels: MAX_PIXELS });

    if (!request.transparent || request.format === 'jpg') {
        pipeline = pipeline.flatten({ background: request.background });
    }

    if (request.format === 'jpg') {
        return pipeline.jpeg({
            quality: request.quality,
            chromaSubsampling: '4:4:4',
            mozjpeg: true
        }).toBuffer();
    }

    if (request.format === 'webp') {
        return pipeline.webp({
            quality: request.quality,
            alphaQuality: 100,
            smartSubsample: true
        }).toBuffer();
    }

    return pipeline.png({
        compressionLevel: 9,
        adaptiveFiltering: true
    }).toBuffer();
}

function runProcess(command, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const stdout = [];
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            reject(new Error(`${command} 执行超过 ${timeoutMs}ms。`));
        }, timeoutMs);

        child.stdout.on('data', chunk => stdout.push(chunk));
        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
            if (stderr.length > MAX_FFMPEG_ERROR_BYTES) {
                stderr = stderr.slice(-MAX_FFMPEG_ERROR_BYTES);
            }
        });
        child.on('error', error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`无法启动 ${command}: ${error.message}`));
        });
        child.on('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code === 0) {
                resolve({ stdout: Buffer.concat(stdout), stderr });
            } else {
                reject(new Error(`${command} 退出码 ${code}: ${stderr.trim().slice(-4000)}`));
            }
        });
    });
}

function killProcessTree(child) {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore'
        });
        killer.unref();
        return;
    }
    try {
        process.kill(-child.pid, 'SIGKILL');
    } catch {
        try {
            child.kill('SIGKILL');
        } catch {}
    }
}

function runAudioWorker(request, outputPath) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            '--max-old-space-size=512',
            AUDIO_WORKER_PATH
        ], {
            cwd: path.dirname(outputPath),
            shell: false,
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                PATH: process.env.PATH || '',
                SystemRoot: process.env.SystemRoot || '',
                WINDIR: process.env.WINDIR || '',
                TEMP: process.env.TEMP || os.tmpdir(),
                TMP: process.env.TMP || os.tmpdir()
            }
        });
        activeAudioChildren.add(child);

        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            activeAudioChildren.delete(child);
            if (error) reject(error);
            else resolve(result);
        };
        const appendLimited = (current, chunk) => {
            const next = current + chunk.toString('utf8');
            return next.length > MAX_AUDIO_PROCESS_OUTPUT_BYTES
                ? next.slice(-MAX_AUDIO_PROCESS_OUTPUT_BYTES)
                : next;
        };
        const timer = setTimeout(() => {
            killProcessTree(child);
            finish(new Error(`音乐合成子进程执行超过 ${request.timeoutMs}ms，已强制终止。`));
        }, request.timeoutMs);

        child.stdout.on('data', chunk => {
            stdout = appendLimited(stdout, chunk);
        });
        child.stderr.on('data', chunk => {
            stderr = appendLimited(stderr, chunk);
        });
        child.on('error', error => {
            finish(new Error(`无法启动音乐合成子进程: ${error.message}`));
        });
        child.on('close', code => {
            if (code !== 0) {
                finish(new Error(
                    `音乐合成子进程退出码 ${code}: ${stderr.trim().slice(-8000) || '无错误输出'}`
                ));
                return;
            }
            try {
                const result = JSON.parse(stdout.trim());
                if (result.status !== 'success') throw new Error('Worker 未报告成功状态。');
                finish(null, result);
            } catch (error) {
                finish(new Error(`音乐合成子进程返回无效结果: ${error.message}`));
            }
        });

        const payload = JSON.stringify({ ...request, outputPath });
        child.stdin.on('error', error => {
            finish(new Error(`向音乐合成子进程写入参数失败: ${error.message}`));
        });
        child.stdin.end(payload);
    });
}

function inspectPcm16Wav(buffer, request) {
    if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' ||
        buffer.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('音乐合成子进程没有生成有效的 WAV 文件。');
    }
    if (buffer.length > MAX_AUDIO_OUTPUT_BYTES) {
        throw new Error(`WAV 文件超过 ${MAX_AUDIO_OUTPUT_BYTES / 1024 / 1024}MB 限制。`);
    }
    if (buffer.toString('ascii', 12, 16) !== 'fmt ' ||
        buffer.readUInt16LE(20) !== 1 ||
        buffer.readUInt16LE(34) !== 16 ||
        buffer.toString('ascii', 36, 40) !== 'data') {
        throw new Error('WAV 必须是标准 16-bit PCM 格式。');
    }

    const channels = buffer.readUInt16LE(22);
    const sampleRate = buffer.readUInt32LE(24);
    const dataSize = buffer.readUInt32LE(40);
    if (channels !== request.channels || sampleRate !== request.sampleRate) {
        throw new Error('WAV 声道数或采样率与请求不一致。');
    }
    if (44 + dataSize !== buffer.length) {
        throw new Error('WAV data chunk 长度无效。');
    }
    const frameCount = dataSize / (channels * 2);
    const durationMs = frameCount * 1000 / sampleRate;
    if (Math.abs(durationMs - request.durationMs) > 2) {
        throw new Error(`WAV 时长 ${durationMs.toFixed(3)}ms 与请求不一致。`);
    }
    return { channels, sampleRate, frameCount, durationMs };
}

async function ensureFfmpegAvailable() {
    if (!ffmpegAvailabilityPromise) {
        const executable = String(
            pluginConfig.FfmpegPath ||
            process.env.MediaRendererFfmpegPath ||
            'ffmpeg'
        ).trim();
        ffmpegAvailabilityPromise = runProcess(executable, ['-version'], 10000)
            .then(() => executable)
            .catch(error => {
                ffmpegAvailabilityPromise = null;
                throw new Error(`FFmpeg 不可用: ${error.message}`);
            });
    }
    return ffmpegAvailabilityPromise;
}

function buildFfmpegArgs(request, framePattern, outputPath, audioPath = null) {
    const args = [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-framerate', String(request.fps),
        '-i', framePattern
    ];
    if (audioPath && request.format !== 'gif') {
        args.push('-stream_loop', '-1', '-i', audioPath);
    }

    if (request.format === 'gif') {
        args.push(
            '-filter_complex',
            '[0:v]split[v1][v2];[v1]palettegen=reserve_transparent=1:stats_mode=diff[p];[v2][p]paletteuse=dither=sierra2_4a:alpha_threshold=1',
            '-loop', '0'
        );
    } else if (request.format === 'mp4') {
        args.push(
            '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-crf', String(Math.max(0, Math.min(51, Math.round((100 - request.quality) * 0.45 + 2)))),
            '-movflags', '+faststart'
        );
        if (audioPath) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    } else if (request.format === 'webm') {
        args.push(
            '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2:color=black@0',
            '-c:v', 'libvpx-vp9',
            '-pix_fmt', request.transparent ? 'yuva420p' : 'yuv420p',
            '-crf', String(Math.max(0, Math.min(63, Math.round((100 - request.quality) * 0.5 + 8)))),
            '-b:v', '0'
        );
        if (request.transparent) {
            args.push('-auto-alt-ref', '0', '-metadata:s:v:0', 'alpha_mode=1');
        }
        if (audioPath) args.push('-c:a', 'libopus', '-b:a', '160k', '-shortest');
    }
    args.push('-t', (request.durationMs / 1000).toFixed(3), outputPath);
    return args;
}

async function capturePng(page, request) {
    return page.screenshot({
        type: 'png',
        omitBackground: request.transparent,
        captureBeyondViewport: false,
        clip: {
            x: 0,
            y: 0,
            width: request.width,
            height: request.height
        }
    });
}

async function encodeAnimation(page, request, assets) {
    const ffmpeg = await ensureFfmpegAvailable();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-media-renderer-'));
    const framePattern = path.join(tempDir, 'frame-%06d.png');
    const outputPath = path.join(tempDir, `output.${request.format}`);
    let audioPath = null;

    try {
        for (let frameIndex = 0; frameIndex < request.frameCount; frameIndex++) {
            const timeMs = frameIndex * 1000 / request.fps;
            await page.evaluate(
                async ({ timeMs, frameIndex, fps }) => {
                    await window.__MEDIA_RENDERER__.renderFrame(timeMs, frameIndex, fps);
                },
                { timeMs, frameIndex, fps: request.fps }
            );
            const frameBuffer = await capturePng(page, request);
            const framePath = path.join(tempDir, `frame-${String(frameIndex).padStart(6, '0')}.png`);
            await fs.writeFile(framePath, frameBuffer);
        }

        if (request.audioAssetId && request.format !== 'gif') {
            const audio = assets.find(asset => asset.id === request.audioAssetId);
            const extension = mime.extension(audio.mimeType) || 'bin';
            audioPath = path.join(tempDir, `audio.${extension}`);
            await fs.writeFile(audioPath, audio.buffer);
        }

        const ffmpegTimeoutMs = parseInteger(
            pluginConfig.FfmpegTimeoutMs ?? process.env.MediaRendererFfmpegTimeoutMs,
            180000,
            10000,
            600000,
            'FfmpegTimeoutMs'
        );
        await runProcess(
            ffmpeg,
            buildFfmpegArgs(request, framePattern, outputPath, audioPath),
            ffmpegTimeoutMs
        );
        return await fs.readFile(outputPath);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

function getOutputEnvironment() {
    const projectBasePath = process.env.PROJECT_BASE_PATH || PROJECT_ROOT;
    const serverPort = process.env.SERVER_PORT || process.env.PORT || pluginConfig.PORT;
    const imageKey = process.env.IMAGESERVER_IMAGE_KEY ||
        process.env.Image_Key ||
        hostPluginManager?.getResolvedPluginConfigValue?.('ImageServer', 'Image_Key');
    const fileKey = process.env.IMAGESERVER_FILE_KEY ||
        process.env.File_Key ||
        hostPluginManager?.getResolvedPluginConfigValue?.('ImageServer', 'File_Key');
    const httpBase = process.env.VarHttpUrl || 'http://localhost';

    if (!serverPort) throw new Error('缺少 SERVER_PORT/PORT，无法构造媒体 URL。');

    return {
        projectBasePath,
        serverPort,
        imageKey,
        fileKey,
        httpBase: httpBase.replace(/\/+$/, '')
    };
}

async function saveArtifact(buffer, request) {
    const env = getOutputEnvironment();
    const extension = request.format;
    const fileName = `${request.fileStem}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${extension}`;
    const useFileService = ['mp4', 'webm', 'wav', 'zip'].includes(request.format);
    if (useFileService && !env.fileKey) {
        throw new Error('缺少 ImageServer.File_Key，无法托管音频或视频文件。');
    }
    if (!useFileService && !env.imageKey) {
        throw new Error('缺少 ImageServer.Image_Key，无法托管图片文件。');
    }

    const serviceRoot = useFileService ? 'file' : 'image';
    const serviceRoute = useFileService ? 'files' : 'images';
    const serviceKey = useFileService ? env.fileKey : env.imageKey;
    const outputDir = path.join(env.projectBasePath, serviceRoot, OUTPUT_SUBDIR);
    const outputPath = path.join(outputDir, fileName);

    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(outputPath, buffer);

    const relativeUrlPath = `${OUTPUT_SUBDIR}/${encodeURIComponent(fileName)}`;
    const mediaUrl = `${env.httpBase}:${env.serverPort}/pw=${serviceKey}/${serviceRoute}/${relativeUrlPath}`;

    return {
        fileName,
        outputPath,
        serverPath: `${serviceRoot}/${OUTPUT_SUBDIR}/${fileName}`,
        mediaUrl,
        imageUrl: mediaUrl,
        serviceType: useFileService ? 'file' : 'image'
    };
}

async function renderOne(browser, rawRequest, stepIndex) {
    const request = normalizeRequest(rawRequest);
    const [sourceImageAsset, assets] = await Promise.all([
        resolveSourceImage(request),
        resolveAssets(request)
    ]);
    const directSource = await resolveDirectSourceAssets(
        request.source,
        assets,
        request.timeoutMs
    );
    const allAssets = [...assets, ...directSource.directAssets];
    const context = await browser.createBrowserContext();
    let page;

    try {
        page = await context.newPage();
        page.setDefaultTimeout(request.timeoutMs);
        await page.setViewport({
            width: request.width,
            height: request.height,
            deviceScaleFactor: 1
        });
        await page.setJavaScriptEnabled(request.allowJavaScript);
        await installNetworkPolicy(page, sourceImageAsset.allowedRemoteUrl);

        const documentHtml = await buildHtmlDocument(
            request,
            sourceImageAsset.resolvedSourceImage,
            assets,
            directSource.source
        );
        await page.setContent(documentHtml, {
            waitUntil: 'domcontentloaded',
            timeout: request.timeoutMs
        });
        await applyCanvasPolicy(page, request);

        await page.evaluate(async () => {
            if (document.fonts?.ready) await document.fonts.ready;
        });
        await waitForImages(page, request.timeoutMs);
        await waitForPageReady(page, request);

        if (request.waitMs > 0) {
            await new Promise(resolve => setTimeout(resolve, request.waitMs));
        }

        let mediaBuffer;
        let metadata = { width: request.width, height: request.height };
        if (request.animation) {
            mediaBuffer = await encodeAnimation(page, request, allAssets);
        } else {
            const pngBuffer = await capturePng(page, request);
            mediaBuffer = await encodeImage(pngBuffer, request);
            metadata = await sharp(mediaBuffer).metadata();
        }

        const artifact = await saveArtifact(mediaBuffer, request);
        const mimeTypes = {
            jpg: 'image/jpeg',
            png: 'image/png',
            webp: 'image/webp',
            gif: 'image/gif',
            mp4: 'video/mp4',
            webm: 'video/webm'
        };
        const mimeType = mimeTypes[request.format];

        const formatAdjusted = request.transparent &&
            ['jpg', 'jpeg'].includes(String(request.requestedFormat || '').toLowerCase());
        const mediaLabel = request.animation ? '动画' : '图片';
        const displayHint = request.format === 'gif'
            ? `请使用 <img src="${artifact.imageUrl}" alt="渲染动画"> 展示给用户。`
            : request.animation
                ? `请使用 <video src="${artifact.imageUrl}" controls autoplay loop></video> 展示给用户。`
                : `请使用 <img src="${artifact.imageUrl}" alt="渲染图片"> 展示给用户。`;

        const text = [
            `第 ${stepIndex} 个${mediaLabel}渲染成功。`,
            `- 类型: ${request.sourceType.toUpperCase()}`,
            `- 分辨率: ${metadata.width}x${metadata.height}`,
            `- 格式: ${request.format.toUpperCase()}`,
            request.animation ? `- 时长/FPS/帧数: ${request.durationMs}ms / ${request.fps} / ${request.frameCount}` : null,
            `- 透明背景: ${request.transparent ? '是' : '否'}`,
            request.libraries.length ? `- 本地库: ${request.libraries.join(', ')}` : null,
            allAssets.length ? `- 素材数: ${allAssets.length}` : null,
            formatAdjusted ? '- 格式调整: JPEG 不支持透明通道，已自动改为 PNG。' : null,
            `- 文件大小: ${(mediaBuffer.length / 1024).toFixed(1)} KB`,
            `- 可访问URL: ${artifact.imageUrl}`,
            displayHint
        ].filter(Boolean).join('\n');

        const content = [{ type: 'text', text }];
        if (request.showBase64 && !request.animation) {
            content.push({
                type: 'image_url',
                image_url: {
                    url: `data:${mimeType};base64,${mediaBuffer.toString('base64')}`
                }
            });
        }

        return {
            content,
            details: {
                step: stepIndex,
                sourceType: request.sourceType,
                width: metadata.width,
                height: metadata.height,
                format: request.format,
                mimeType,
                transparent: request.transparent,
                quality: request.quality,
                animation: request.animation,
                durationMs: request.animation ? request.durationMs : null,
                fps: request.animation ? request.fps : null,
                frameCount: request.animation ? request.frameCount : null,
                libraries: request.libraries,
                assetCount: allAssets.length,
                directSourceAssetCount: directSource.directAssets.length,
                sourceImageUsed: Boolean(request.sourceImage),
                byteLength: mediaBuffer.length,
                showBase64: request.showBase64 && !request.animation,
                ...artifact
            }
        };
    } finally {
        if (page) {
            await page.close().catch(() => {});
        }
        await context.close().catch(() => {});
    }
}

const STEP_FIELDS = [
    'command', 'html', 'svg', 'width', 'height', 'format', 'imageFormat',
    'transparent', 'transparentBackground', 'background', 'backgroundColor',
    'quality', 'showBase64', 'showbase64', 'allowJavaScript', 'waitMs',
    'timeoutMs', 'fileName', 'filename', 'name', 'sourceImage',
    'source_image', 'image', 'image_url', 'libraries', 'library', 'libs',
    'assets', 'durationMs', 'fps', 'readyMode', 'audioAssetId', 'audio',
    'audioUrl', 'audio_url'
];

function buildStep(params, suffix = '') {
    const step = {};
    for (const field of STEP_FIELDS) {
        const suffixedKey = `${field}${suffix}`;
        if (suffix && params[suffixedKey] !== undefined) {
            step[field] = params[suffixedKey];
        } else if (params[field] !== undefined) {
            step[field] = params[field];
        }
    }
    return step;
}

function collectSteps(params = {}) {
    const steps = [];
    if (params.command1 !== undefined || params.html1 !== undefined || params.svg1 !== undefined) {
        for (let index = 1; index <= MAX_BATCH_SIZE; index++) {
            const suffix = String(index);
            const hasStep = params[`command${suffix}`] !== undefined ||
                params[`html${suffix}`] !== undefined ||
                params[`svg${suffix}`] !== undefined;
            if (!hasStep) break;
            steps.push(buildStep(params, suffix));
        }

        const nextIndex = steps.length + 1;
        if (params[`command${nextIndex}`] !== undefined ||
            params[`html${nextIndex}`] !== undefined ||
            params[`svg${nextIndex}`] !== undefined) {
            throw new Error(`单次最多串行渲染 ${MAX_BATCH_SIZE} 张图片。`);
        }
    } else {
        steps.push(buildStep(params));
    }

    if (steps.length === 0) {
        throw new Error('未提供可执行的渲染步骤。');
    }

    for (const [index, step] of steps.entries()) {
        const command = String(step.command || 'RenderImage').trim().toLowerCase();
        if (![
            'renderimage', 'render', 'htmltoscreenshot', 'svgtoscreenshot',
            'renderanimation', 'rendergif', 'rendervideo'
        ].includes(command)) {
            throw new Error(`第 ${index + 1} 步使用了未知 command: ${step.command}`);
        }
    }

    return steps;
}

async function connectToManagedBrowser(maxWaitMs = 10000) {
    const startedAt = Date.now();
    let lastError = null;

    while (Date.now() - startedAt < maxWaitMs) {
        try {
            const browserWSEndpoint = await browserRuntimeManager.getManagedBrowserWebSocketEndpoint();
            if (browserWSEndpoint) {
                return await puppeteer.connect({ browserWSEndpoint });
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    const suffix = lastError ? ` 最后一次错误: ${lastError.message}` : '';
    throw new Error(`无法在 ${maxWaitMs}ms 内连接托管 Chrome 的 DevTools WebSocket Endpoint。${suffix}`);
}

async function executeRenderBatch(params) {
    const steps = collectSteps(params);
    await browserRuntimeManager.ensureManagedBrowser();

    let browser;
    try {
        browser = await connectToManagedBrowser();
        const results = [];
        for (let index = 0; index < steps.length; index++) {
            if (debugMode) {
                console.log(`[MediaRenderer] rendering step ${index + 1}/${steps.length}`);
            }
            results.push(await renderOne(browser, steps[index], index + 1));
            browserRuntimeManager.touchManagedBrowser();
        }

        const content = [];
        for (const result of results) {
            content.push(...result.content);
        }

        return {
            content,
            details: {
                count: results.length,
                sequential: results.length > 1,
                artifacts: results.map(result => result.details)
            }
        };
    } finally {
        if (browser) {
            await browser.disconnect().catch(() => {});
        }
        browserRuntimeManager.touchManagedBrowser();
    }
}

function normalizeCursorThemeRequest(raw = {}) {
    const html = String(raw.html || '').trim();
    if (!html) throw new Error('GenerateCursorTheme 必须提供 html 参数。');
    if (Buffer.byteLength(html, 'utf8') > MAX_SOURCE_BYTES) {
        throw new Error(`光标主题 HTML 超过 ${MAX_SOURCE_BYTES / 1024 / 1024}MB 限制。`);
    }

    const themeName = sanitizeThemeName(raw.themeName || raw.name || raw.fileName);
    const author = String(raw.author || raw.maid || 'VCPToolBox AI').trim().slice(0, 100);
    const timeoutMs = parseInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS, 'timeoutMs');
    const sizes = raw.sizes === undefined || raw.sizes === null || raw.sizes === ''
        ? [...DEFAULT_CURSOR_SIZES]
        : String(raw.sizes).split(/[\s,;]+/).filter(Boolean).map((value, index) =>
            parseInteger(value, undefined, 16, 256, `sizes[${index}]`)
        );
    const uniqueSizes = [...new Set(sizes)].sort((a, b) => a - b);
    if (uniqueSizes.length < 1 || uniqueSizes.length > 8) {
        throw new Error('sizes 必须包含 1-8 个不同尺寸。');
    }

    const renderRequest = normalizeRequest({
        html,
        width: Math.max(MIN_DIMENSION, ...uniqueSizes),
        height: Math.max(MIN_DIMENSION, ...uniqueSizes),
        format: 'png',
        transparent: true,
        allowJavaScript: true,
        libraries: raw.libraries || raw.library || raw.libs,
        assets: raw.assets,
        timeoutMs,
        readyMode: raw.readyMode || 'auto',
        waitMs: raw.waitMs || 0,
        fileName: sanitizePackageStem(themeName)
    });

    return {
        html,
        themeName,
        author,
        sizes: uniqueSizes,
        timeoutMs,
        renderRequest
    };
}

async function waitForCursorThemeReady(page, request) {
    const sourceRequestsSignal = /__CURSOR_THEME__(?:_READY__|\.setReady|\[['"]setReady['"]\])/i
        .test(request.source);
    if (request.readyMode === 'load' || (request.readyMode === 'auto' && !sourceRequestsSignal)) {
        return;
    }
    await page.waitForFunction(
        () => window.__CURSOR_THEME__?.ready === true ||
            window.__CURSOR_THEME_READY__ === true,
        { timeout: request.timeoutMs }
    );
}

async function inspectCursorThemeDocument(page) {
    const declarations = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('svg[data-cursor]')).map((element, index) => ({
            index,
            role: String(element.dataset.cursor || '').trim().toLowerCase(),
            hotspot: element.dataset.hotspot || '',
            duration: element.dataset.duration || '',
            fps: element.dataset.fps || '',
            viewBox: element.getAttribute('viewBox') || '',
            topLevel: element.parentElement === document.body
        }));
    });

    validateCursorRoles(declarations.map(item => item.role));
    const nestedRoles = declarations.filter(item => !item.topLevel).map(item => item.role);
    if (nestedRoles.length > 0) {
        throw new Error(
            `光标角色必须是 body 的顶层 SVG，以下角色被包装元素包裹: ${nestedRoles.join(', ')}`
        );
    }
    let totalFrames = 0;
    const roles = declarations.map(item => {
        const role = item.role;
        const hotspot = parseHotspot(item.hotspot, role, item.viewBox);
        const durationMs = item.duration === ''
            ? 0
            : parseInteger(item.duration, undefined, 0, 10000, `${role}.data-duration`);
        const fps = durationMs > 0
            ? parseInteger(item.fps, DEFAULT_CURSOR_FPS, 1, 60, `${role}.data-fps`)
            : null;
        const frameCount = durationMs > 0 ? Math.ceil(durationMs * fps / 1000) : 1;
        if (frameCount > MAX_CURSOR_ROLE_FRAMES) {
            throw new Error(`角色 ${role} 需要 ${frameCount} 帧，超过 ${MAX_CURSOR_ROLE_FRAMES} 帧上限。`);
        }
        totalFrames += frameCount;
        return {
            ...item,
            hotspot,
            durationMs,
            fps,
            frameCount,
            animated: durationMs > 0
        };
    });
    if (totalFrames > MAX_CURSOR_THEME_FRAMES) {
        throw new Error(`整套主题需要 ${totalFrames} 个逻辑帧，超过 ${MAX_CURSOR_THEME_FRAMES} 帧上限。`);
    }
    return roles;
}

async function prepareCursorThemePage(page, maxSize) {
    await page.setViewport({ width: maxSize, height: maxSize, deviceScaleFactor: 1 });
    await page.evaluate(size => {
        const declarations = Array.from(document.querySelectorAll('svg[data-cursor]'));
        for (const child of document.body.children) {
            child.style.setProperty('display', 'none', 'important');
        }
        for (const element of declarations) {
            element.style.setProperty('display', 'none', 'important');
            element.style.setProperty('position', 'fixed', 'important');
            element.style.setProperty('left', '0', 'important');
            element.style.setProperty('top', '0', 'important');
            element.style.setProperty('width', `${size}px`, 'important');
            element.style.setProperty('height', `${size}px`, 'important');
            element.style.setProperty('max-width', 'none', 'important');
            element.style.setProperty('max-height', 'none', 'important');
            element.style.setProperty('margin', '0', 'important');
            element.style.setProperty('padding', '0', 'important');
            element.style.setProperty('overflow', 'visible', 'important');
        }
        document.documentElement.style.cssText +=
            'background:transparent!important;width:100%!important;height:100%!important;overflow:hidden!important;';
        document.body.style.cssText +=
            'background:transparent!important;width:100%!important;height:100%!important;overflow:hidden!important;margin:0!important;';
    }, maxSize);
}

async function selectAndRenderCursorRole(page, role, timeMs, size) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.evaluate(async ({ role, timeMs, size }) => {
        const declarations = Array.from(document.querySelectorAll('svg[data-cursor]'));
        let selected = null;
        for (const element of declarations) {
            const matches = String(element.dataset.cursor || '').trim().toLowerCase() === role;
            element.style.setProperty('display', matches ? 'block' : 'none', 'important');
            if (matches) {
                selected = element;
                element.style.setProperty('width', `${size}px`, 'important');
                element.style.setProperty('height', `${size}px`, 'important');
            }
        }
        if (!selected) throw new Error(`找不到光标角色 ${role}。`);
        await window.__CURSOR_THEME__.render(role, timeMs, selected);
    }, { role, timeMs, size });
}

async function captureCursorPng(page, role, timeMs, size) {
    await selectAndRenderCursorRole(page, role, timeMs, size);
    const screenshot = await page.screenshot({
        type: 'png',
        omitBackground: true,
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: size, height: size }
    });
    // Puppeteer 25 返回 Uint8Array；在浏览器边界统一转换为 Node.js Buffer，
    // 保持 CUR/ANI/ZIP 纯二进制模块的严格 Buffer 契约。
    return Buffer.isBuffer(screenshot) ? screenshot : Buffer.from(screenshot);
}

function escapeSvgText(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

async function buildCursorThemePreview(themeName, roleResults, missingOptionalRoles) {
    const columns = 4;
    const rows = Math.ceil(roleResults.length / columns);
    const width = columns * CURSOR_PREVIEW_CELL_WIDTH;
    const headerHeight = 82;
    const height = headerHeight + rows * CURSOR_PREVIEW_CELL_HEIGHT;
    const checkerId = 'checker';
    const cells = [];
    const composites = [];

    roleResults.forEach((result, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = column * CURSOR_PREVIEW_CELL_WIDTH;
        const y = headerHeight + row * CURSOR_PREVIEW_CELL_HEIGHT;
        const imageSize = 64;
        const imageX = x + Math.floor((CURSOR_PREVIEW_CELL_WIDTH - imageSize) / 2);
        const imageY = y + 14;
        const hotspot = result.scaledHotspots['64'] ||
            scaleHotspot(result.hotspotInternal, imageSize, imageSize);
        const badge = result.animated
            ? `${result.frameCount}f / ${result.durationMs}ms`
            : 'CUR';
        cells.push(
            `<rect x="${x + 8}" y="${y + 5}" width="${CURSOR_PREVIEW_CELL_WIDTH - 16}" height="${CURSOR_PREVIEW_CELL_HEIGHT - 10}" rx="12" fill="#111827" stroke="#334155"/>`,
            `<rect x="${imageX}" y="${imageY}" width="${imageSize}" height="${imageSize}" fill="url(#${checkerId})"/>`,
            `<path d="M${imageX + hotspot.x - 5} ${imageY + hotspot.y}h10M${imageX + hotspot.x} ${imageY + hotspot.y - 5}v10" stroke="#f43f5e" stroke-width="1.5"/>`,
            `<text x="${x + CURSOR_PREVIEW_CELL_WIDTH / 2}" y="${y + 96}" text-anchor="middle" fill="#e2e8f0" font-size="14" font-family="Arial,sans-serif">${escapeSvgText(result.role)}</text>`,
            `<text x="${x + CURSOR_PREVIEW_CELL_WIDTH / 2}" y="${y + 116}" text-anchor="middle" fill="#67e8f9" font-size="11" font-family="Arial,sans-serif">${escapeSvgText(badge)}</text>`
        );
        composites.push({ input: result.previewPng, left: imageX, top: imageY });
    });

    const optionalText = missingOptionalRoles.length
        ? `Optional fallback: ${missingOptionalRoles.join(', ')} → arrow`
        : 'Optional roles included: pin, person';
    const backgroundSvg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
            <defs>
                <pattern id="${checkerId}" width="12" height="12" patternUnits="userSpaceOnUse">
                    <rect width="12" height="12" fill="#f8fafc"/>
                    <path d="M0 0h6v6H0zM6 6h6v6H6z" fill="#cbd5e1"/>
                </pattern>
            </defs>
            <rect width="100%" height="100%" fill="#070b14"/>
            <text x="24" y="34" fill="#f8fafc" font-size="22" font-weight="700" font-family="Arial,sans-serif">${escapeSvgText(themeName)}</text>
            <text x="24" y="60" fill="#94a3b8" font-size="12" font-family="Arial,sans-serif">${escapeSvgText(optionalText)}</text>
            ${cells.join('')}
        </svg>`
    );
    return sharp(backgroundSvg)
        .composite(composites)
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
}

async function renderCursorTheme(browser, params) {
    const request = normalizeCursorThemeRequest(params);
    const renderRequest = request.renderRequest;
    const assets = await resolveAssets(renderRequest);
    const directSource = await resolveDirectSourceAssets(
        renderRequest.source,
        assets,
        request.timeoutMs
    );
    const context = await browser.createBrowserContext();
    let page;

    try {
        page = await context.newPage();
        page.setDefaultTimeout(request.timeoutMs);
        await page.setJavaScriptEnabled(true);
        await installNetworkPolicy(page);
        const documentHtml = await buildHtmlDocument(
            renderRequest,
            null,
            assets,
            directSource.source
        );
        await page.setContent(documentHtml, {
            waitUntil: 'domcontentloaded',
            timeout: request.timeoutMs
        });
        await applyCanvasPolicy(page, renderRequest);
        await page.evaluate(async () => {
            if (document.fonts?.ready) await document.fonts.ready;
        });
        await waitForImages(page, request.timeoutMs);
        await waitForCursorThemeReady(page, renderRequest);
        if (renderRequest.waitMs > 0) {
            await new Promise(resolve => setTimeout(resolve, renderRequest.waitMs));
        }

        const roleDeclarations = await inspectCursorThemeDocument(page);
        const validation = validateCursorRoles(roleDeclarations.map(item => item.role));
        const maxSize = Math.max(...request.sizes);
        await prepareCursorThemePage(page, maxSize);

        const roleResults = [];
        for (const role of roleDeclarations) {
            const curFrames = [];
            let previewPng = null;
            let scaledHotspots = null;
            for (let frameIndex = 0; frameIndex < role.frameCount; frameIndex++) {
                const timeMs = role.animated
                    ? frameIndex * role.durationMs / role.frameCount
                    : 0;
                const images = [];
                const frameHotspots = {};
                for (const size of request.sizes) {
                    const png = await captureCursorPng(page, role.role, timeMs, size);
                    const hotspot = scaleHotspot(role.hotspot, size, size);
                    images.push({
                        png,
                        width: size,
                        height: size,
                        hotspotX: hotspot.x,
                        hotspotY: hotspot.y
                    });
                    frameHotspots[String(size)] = hotspot;
                    if (frameIndex === 0 && size === maxSize) {
                        previewPng = size === 64
                            ? png
                            : await sharp(png).resize(64, 64).png().toBuffer();
                    }
                }
                if (frameIndex === 0) scaledHotspots = frameHotspots;
                curFrames.push(encodeCur(images));
            }
            const jiffies = role.animated
                ? Math.max(1, Math.round(60 * role.durationMs / 1000 / role.frameCount))
                : null;
            const buffer = role.animated
                ? encodeAni(curFrames, {
                    jiffies,
                    name: `${request.themeName} - ${role.role}`,
                    author: request.author
                })
                : curFrames[0];
            roleResults.push({
                role: role.role,
                buffer,
                animated: role.animated,
                durationMs: role.durationMs,
                fps: role.fps,
                frameCount: role.frameCount,
                viewBox: role.viewBox,
                hotspot: { x: role.hotspot.x, y: role.hotspot.y },
                hotspotInternal: role.hotspot,
                scaledHotspots,
                previewPng
            });
            browserRuntimeManager.touchManagedBrowser();
        }

        const previewPng = await buildCursorThemePreview(
            request.themeName,
            roleResults,
            validation.missingOptionalRoles
        );
        const themeZip = buildThemeZip({
            name: request.themeName,
            author: request.author,
            sizes: request.sizes,
            roles: roleResults,
            previewPng,
            sourceHtml: request.html
        });
        const zipArtifact = await saveArtifact(themeZip.buffer, {
            format: 'zip',
            fileStem: sanitizePackageStem(request.themeName)
        });
        const previewArtifact = await saveArtifact(previewPng, {
            format: 'png',
            fileStem: `${sanitizePackageStem(request.themeName)}-preview`
        });

        const animatedCount = roleResults.filter(item => item.animated).length;
        const staticCount = roleResults.length - animatedCount;
        const text = [
            `Windows 鼠标主题“${request.themeName}”生成成功。`,
            `- 核心角色: ${CORE_CURSOR_ROLES.length}/${CORE_CURSOR_ROLES.length}`,
            `- 扩展角色: ${OPTIONAL_CURSOR_ROLES.length - validation.missingOptionalRoles.length}/${OPTIONAL_CURSOR_ROLES.length}`,
            `- 静态 CUR: ${staticCount}`,
            `- 动画 ANI: ${animatedCount}`,
            `- 输出尺寸: ${request.sizes.join(', ')} px`,
            validation.missingOptionalRoles.length
                ? `- 扩展角色回退: ${validation.missingOptionalRoles.join(', ')} → arrow`
                : null,
            `- ZIP 大小: ${(themeZip.buffer.length / 1024).toFixed(1)} KB`,
            `- 主题下载URL: ${zipArtifact.mediaUrl}`,
            `- 总览预览URL: ${previewArtifact.imageUrl}`,
            `<img src="${previewArtifact.imageUrl}" alt="${request.themeName} 鼠标主题总览">`,
            `请向用户提供 ZIP 下载链接：${zipArtifact.mediaUrl}`
        ].filter(Boolean).join('\n');

        return {
            content: [{ type: 'text', text }],
            details: {
                themeName: request.themeName,
                author: request.author,
                sizes: request.sizes,
                roleCount: roleResults.length,
                staticCount,
                animatedCount,
                missingOptionalRoles: validation.missingOptionalRoles,
                zipUrl: zipArtifact.mediaUrl,
                previewUrl: previewArtifact.imageUrl,
                zipByteLength: themeZip.buffer.length,
                manifest: themeZip.manifest,
                zipArtifact,
                previewArtifact
            }
        };
    } finally {
        if (page) await page.close().catch(() => {});
        await context.close().catch(() => {});
    }
}

async function generateCursorTheme(params) {
    await browserRuntimeManager.ensureManagedBrowser();
    let browser;
    try {
        browser = await connectToManagedBrowser();
        return await renderCursorTheme(browser, params);
    } finally {
        if (browser) await browser.disconnect().catch(() => {});
        browserRuntimeManager.touchManagedBrowser();
    }
}

async function generateAudio(params, context = {}) {
    validateAdminForAudio(params, context);
    const request = normalizeAudioRequest(params);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-audio-synthesis-'));
    const outputPath = path.join(tempDir, 'output.wav');

    try {
        const workerResult = await runAudioWorker(request, outputPath);
        const wavBuffer = await fs.readFile(outputPath);
        const metadata = inspectPcm16Wav(wavBuffer, request);
        const artifact = await saveArtifact(wavBuffer, request);
        const channelLabel = metadata.channels === 1 ? '单声道' : '立体声';
        const text = [
            '程序化音乐生成成功。',
            '- 格式: WAV / PCM16',
            `- 时长: ${(metadata.durationMs / 1000).toFixed(3)} 秒`,
            `- 采样率: ${metadata.sampleRate} Hz`,
            `- 声道: ${channelLabel}`,
            `- BPM: ${request.tempo}`,
            `- 随机种子: ${request.seed}`,
            `- 峰值（归一化前）: ${Number(workerResult.peakBeforeNormalization).toFixed(4)}`,
            `- 文件大小: ${(wavBuffer.length / 1024).toFixed(1)} KB`,
            `- 可访问URL: ${artifact.mediaUrl}`,
            `<audio src="${artifact.mediaUrl}" controls></audio>`
        ].join('\n');

        return {
            content: [{ type: 'text', text }],
            details: {
                format: 'wav',
                mimeType: 'audio/wav',
                durationMs: metadata.durationMs,
                sampleRate: metadata.sampleRate,
                channels: metadata.channels,
                frameCount: metadata.frameCount,
                tempo: request.tempo,
                seed: request.seed,
                byteLength: wavBuffer.length,
                ...artifact
            }
        };
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

function enqueueRender(task) {
    const scheduled = renderQueue.then(task, task);
    renderQueue = scheduled.catch(() => {});
    return scheduled;
}

async function processToolCall(params, context = {}) {
    try {
        const input = params || {};
        const command = String(input.command || 'RenderImage').trim().toLowerCase();
        let result;
        if (command === 'generateaudio') {
            result = await generateAudio(input, context);
        } else if (command === 'generatecursortheme') {
            result = await enqueueRender(() => generateCursorTheme(input));
        } else {
            result = await enqueueRender(() => executeRenderBatch(input));
        }
        return { status: 'success', result };
    } catch (error) {
        const message = `MediaRenderer 错误: ${error.message || error}`;
        return {
            status: 'error',
            error: message,
            result: {
                content: [{ type: 'text', text: message }]
            }
        };
    }
}

function shutdown() {
    for (const child of activeAudioChildren) killProcessTree(child);
    activeAudioChildren.clear();
    renderQueue = Promise.resolve();
    builtinLibrarySourceCache.clear();
    ffmpegAvailabilityPromise = null;
    hostPluginManager = null;
}

module.exports = {
    initialize,
    processToolCall,
    shutdown,
    normalizeRequest,
    collectSteps,
    connectToManagedBrowser,
    resolveSourceImage,
    applySourceImagePlaceholder,
    normalizeAudioRequest,
    inspectPcm16Wav,
    generateAudio,
    normalizeCursorThemeRequest,
    inspectCursorThemeDocument,
    buildCursorThemePreview,
    renderCursorTheme,
    generateCursorTheme
};