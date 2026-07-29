const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const browserRuntimeManager = require('../../modules/browserRuntimeManager.js');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_SUBDIR = 'media-renderer';
const MIN_DIMENSION = 64;
const MAX_DIMENSION = 4096;
const MAX_PIXELS = MAX_DIMENSION * MAX_DIMENSION;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_SIZE = 16;
const DEFAULT_TIMEOUT_MS = 45000;
const MAX_TIMEOUT_MS = 120000;
const SUPPORTED_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp']);

let pluginConfig = {};
let debugMode = false;
let renderQueue = Promise.resolve();

function initialize(config = {}) {
    pluginConfig = config;
    debugMode = parseBoolean(config.DebugMode ?? process.env.DebugMode, false);
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

function normalizeFormat(value, transparent) {
    let format = String(value || (transparent ? 'png' : 'jpg')).trim().toLowerCase();
    if (format === 'jpeg') format = 'jpg';
    if (!SUPPORTED_FORMATS.has(format)) {
        throw new Error(`不支持输出格式 ${format}，可选 png、jpg、webp。`);
    }
    if (transparent && format === 'jpg') {
        format = 'png';
    }
    return format;
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
    const quality = parseInteger(raw.quality, 90, 1, 100, 'quality');
    const timeoutMs = parseInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS, 'timeoutMs');
    const background = normalizeColor(raw.background || raw.backgroundColor, '#ffffff');
    const showBase64 = parseBoolean(raw.showBase64 ?? raw.showbase64, false);
    const allowJavaScript = parseBoolean(raw.allowJavaScript, false);
    const waitMs = parseInteger(raw.waitMs, 0, 0, 10000, 'waitMs');

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
        fileStem: sanitizeFileStem(raw.fileName || raw.filename || raw.name)
    };
}

function buildHtmlDocument(request) {
    if (request.sourceType === 'svg') {
        return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
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
<body>${request.source}</body>
</html>`;
    }

    return request.source;
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

async function installNetworkPolicy(page) {
    await page.setRequestInterception(true);
    page.on('request', request => {
        const url = request.url();
        if (url === 'about:blank' || url.startsWith('data:') || url.startsWith('blob:')) {
            request.continue().catch(() => {});
            return;
        }
        request.abort('blockedbyclient').catch(() => {});
    });
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

function getOutputEnvironment() {
    const projectBasePath = process.env.PROJECT_BASE_PATH || PROJECT_ROOT;
    const serverPort = process.env.SERVER_PORT || process.env.PORT;
    const imageKey = process.env.IMAGESERVER_IMAGE_KEY || process.env.Image_Key;
    const httpBase = process.env.VarHttpUrl || 'http://localhost';

    if (!serverPort) throw new Error('缺少 SERVER_PORT/PORT，无法构造图片 URL。');
    if (!imageKey) throw new Error('缺少 IMAGESERVER_IMAGE_KEY/Image_Key，无法构造图片 URL。');

    return { projectBasePath, serverPort, imageKey, httpBase: httpBase.replace(/\/+$/, '') };
}

async function saveArtifact(buffer, request) {
    const env = getOutputEnvironment();
    const extension = request.format;
    const fileName = `${request.fileStem}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${extension}`;
    const outputDir = path.join(env.projectBasePath, 'image', OUTPUT_SUBDIR);
    const outputPath = path.join(outputDir, fileName);

    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(outputPath, buffer);

    const relativeUrlPath = `${OUTPUT_SUBDIR}/${encodeURIComponent(fileName)}`;
    const imageUrl = `${env.httpBase}:${env.serverPort}/pw=${env.imageKey}/images/${relativeUrlPath}`;

    return {
        fileName,
        outputPath,
        serverPath: `image/${OUTPUT_SUBDIR}/${fileName}`,
        imageUrl
    };
}

async function renderOne(browser, rawRequest, stepIndex) {
    const request = normalizeRequest(rawRequest);
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
        await installNetworkPolicy(page);

        const documentHtml = buildHtmlDocument(request);
        await page.setContent(documentHtml, {
            waitUntil: 'domcontentloaded',
            timeout: request.timeoutMs
        });
        await applyCanvasPolicy(page, request);

        await page.evaluate(async () => {
            if (document.fonts?.ready) await document.fonts.ready;
        });

        if (request.waitMs > 0) {
            await new Promise(resolve => setTimeout(resolve, request.waitMs));
        }

        const pngBuffer = await page.screenshot({
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

        const imageBuffer = await encodeImage(pngBuffer, request);
        const metadata = await sharp(imageBuffer).metadata();
        const artifact = await saveArtifact(imageBuffer, request);
        const mimeType = request.format === 'jpg' ? 'image/jpeg' : `image/${request.format}`;

        const formatAdjusted = request.transparent &&
            ['jpg', 'jpeg'].includes(String(request.requestedFormat || '').toLowerCase());

        const text = [
            `第 ${stepIndex} 张图片渲染成功。`,
            `- 类型: ${request.sourceType.toUpperCase()}`,
            `- 分辨率: ${metadata.width}x${metadata.height}`,
            `- 格式: ${request.format.toUpperCase()}`,
            `- 透明背景: ${request.transparent ? '是' : '否'}`,
            formatAdjusted ? '- 格式调整: JPEG 不支持透明通道，已自动改为 PNG。' : null,
            `- 文件大小: ${(imageBuffer.length / 1024).toFixed(1)} KB`,
            `- 可访问URL: ${artifact.imageUrl}`,
            `请使用 <img src="${artifact.imageUrl}" alt="渲染图片"> 展示给用户。`
        ].filter(Boolean).join('\n');

        const content = [{ type: 'text', text }];
        if (request.showBase64) {
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
                step: stepIndex,
                sourceType: request.sourceType,
                width: metadata.width,
                height: metadata.height,
                format: request.format,
                mimeType,
                transparent: request.transparent,
                quality: request.quality,
                byteLength: imageBuffer.length,
                showBase64: request.showBase64,
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
    'timeoutMs', 'fileName', 'filename', 'name'
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
        if (!['renderimage', 'render', 'htmltoscreenshot', 'svgtoscreenshot'].includes(command)) {
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

function enqueueRender(task) {
    const scheduled = renderQueue.then(task, task);
    renderQueue = scheduled.catch(() => {});
    return scheduled;
}

async function processToolCall(params) {
    try {
        const result = await enqueueRender(() => executeRenderBatch(params || {}));
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
    renderQueue = Promise.resolve();
}

module.exports = {
    initialize,
    processToolCall,
    shutdown,
    normalizeRequest,
    collectSteps,
    connectToManagedBrowser
};