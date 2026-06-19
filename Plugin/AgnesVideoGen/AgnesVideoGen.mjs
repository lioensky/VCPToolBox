#!/usr/bin/env node
/**
 * AgnesVideoGen - Agnes Video V2.0 视频生成插件
 *
 * 【设计思路参考：Wan2.1VideoGen 的两步命令模式】
 * 视频生成要等几分钟，不能一次调用里死等——那样必然超时、卡住对话。
 * 正确做法：拆成两步，每步都是快速完成的：
 *
 *   第一步 submit  → 提交任务给 agnes，秒级返回 task_id，不等生成结果
 *   第二步 query   → 拿 task_id 查状态；没好就告诉 AI 再等等；好了就下载视频返回链接
 *
 * AI 的工作流：
 *   1. 调 submit → 拿到 task_id → 告诉用户"已提交，等几分钟"
 *   2. 过一两分钟，调 query + task_id → 如果还没好继续等，好了展示视频
 *
 * 零外部依赖，仅使用 Node.js 原生模块。
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { URL } from 'url';

// ============================================================
// 配置读取
// ============================================================

const API_KEY = process.env.AGNES_VIDEO_API_KEY || '';
const MODEL   = process.env.AGNES_VIDEO_MODEL   || 'agnes-video-v2.0';
const API_BASE = 'https://apihub.agnes-ai.com';

// 出视频的默认尺寸和帧数。
// num_frames 必须满足 8n+1（如 81/121/161/241/441），默认 121 ≈ 5 秒（24fps）。
const DEFAULT_WIDTH      = process.env.AGNES_VIDEO_DEFAULT_WIDTH      || '1152';
const DEFAULT_HEIGHT     = process.env.AGNES_VIDEO_DEFAULT_HEIGHT     || '768';
const DEFAULT_NUM_FRAMES = process.env.AGNES_VIDEO_DEFAULT_NUM_FRAMES || '121';
const DEFAULT_FRAME_RATE = process.env.AGNES_VIDEO_DEFAULT_FRAME_RATE || '24';

const DEBUG = process.env.DebugMode === 'true';

// VCP 全局注入的服务器信息（Plugin.js 自动传进来，不用手动配）。
const PROJECT_BASE_PATH    = process.env.PROJECT_BASE_PATH    || process.cwd();
const SERVER_PORT          = process.env.SERVER_PORT          || '5000';
// 视频走文件服务（/files/ 路径），不能走图片服务（/images/ 只认图片格式，mp4 会被拒绝 403）。
const IMAGESERVER_FILE_KEY = process.env.IMAGESERVER_FILE_KEY || '';
const VAR_HTTP_URL         = process.env.VarHttpUrl           || 'http://localhost';
const VAR_HTTPS_URL        = process.env.VarHttpsUrl          || '';
// 决定返回的链接用"对外地址"还是"内网地址"，统一在主 config.env 里设置。
const USE_PUBLIC_URL = process.env.USE_PUBLIC_URL === 'true';

// ============================================================
// 工具函数
// ============================================================

function debugLog(...args) {
    if (DEBUG) console.error('[AgnesVideoGen DEBUG]', ...args);
}

function outputAndExit(result) {
    process.stdout.write(JSON.stringify(result));
    process.stdout.end(() => process.exit(result.status === 'success' ? 0 : 1));
}

/**
 * 把存到 file/agnesvideogen/ 下的相对路径，拼成浏览器能访问的视频链接。
 * 视频走 /files/ 路径（/images/ 不收 mp4 会 403）。query 和 concat 共用，避免两处写死。
 * @param {string} relPath 形如 "agnesvideogen/xxx.mp4"
 */
function buildFilesUrl(relPath) {
    return (USE_PUBLIC_URL && VAR_HTTPS_URL)
        ? `${VAR_HTTPS_URL}/pw=${IMAGESERVER_FILE_KEY}/files/${relPath}`
        : `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_FILE_KEY}/files/${relPath}`;
}

/**
 * num_frames 必须满足 8n+1，不合法时自动修正到最近的合法值。
 */
function normalizeNumFrames(n) {
    const MAX = 441;
    n = Math.min(Math.max(parseInt(n, 10) || 121, 9), MAX);
    const remainder = (n - 1) % 8;
    if (remainder !== 0) {
        n = n + (8 - remainder);
        if (n > MAX) n = MAX - ((MAX - 1) % 8);
    }
    return n;
}

// ============================================================
// HTTP 封装（零依赖）
// ============================================================

function httpRequest(url, options = {}, body = null) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const transport = parsed.protocol === 'https:' ? https : http;
        const reqOptions = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: options.method || 'GET',
            headers: options.headers || {},
            timeout: options.timeout || 30000,
        };
        const req = transport.request(reqOptions, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf-8'),
            }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('HTTP request timed out')); });
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

/**
 * 下载二进制文件（支持 Google Cloud Storage 的多跳重定向）。
 */
function downloadBinary(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        const transport = url.startsWith('https:') ? https : http;
        const req = transport.get(url, { timeout: 120000 }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
                return downloadBinary(res.headers.location, maxRedirects - 1).then(resolve).catch(reject);
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('视频下载超时')); });
    });
}

// ============================================================
// 核心：两个命令的实现
// ============================================================

/**
 * 命令一：submit
 * 把视频生成请求提交给 agnes，立刻拿回 task_id 就返回，不等生成结果。
 * 整个过程秒级完成。
 */
async function handleSubmit(args) {
    const prompt = args.prompt || args.Prompt || '';
    if (!prompt.trim()) throw new Error('prompt 是必填参数，请告诉我想生成什么视频。');

    // 组装请求体，自动判断模式（文生视频 / 图生视频 / 多图 / 关键帧动画）
    const body = buildRequestBody(args);
    debugLog('submit 请求体：', JSON.stringify(body));

    const res = await httpRequest(
        `${API_BASE}/v1/videos`,
        {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 90000, // agnes 服务繁忙时响应可能慢，给 90s
        },
        body
    );

    const data = JSON.parse(res.body);
    debugLog('submit 响应：', JSON.stringify(data));

    if (res.statusCode !== 200 && res.statusCode !== 201) {
        throw new Error(`提交失败（HTTP ${res.statusCode}）：${data.error?.message || res.body}`);
    }

    const taskId = data.id || data.task_id;
    if (!taskId) throw new Error(`提交成功但没有返回 task_id，响应：${res.body}`);

    const estSeconds = Math.round(normalizeNumFrames(parseInt(args.num_frames || DEFAULT_NUM_FRAMES)) / parseInt(args.frame_rate || DEFAULT_FRAME_RATE, 10));

    return {
        status: 'success',
        result: [
            `✅ 视频任务已提交！`,
            `task_id：${taskId}`,
            `预计时长：约 ${estSeconds} 秒的视频，生成通常需要 1-5 分钟。`,
            ``,
            `请告知用户"视频生成中，需要等待几分钟"。`,
            `过 1-2 分钟后，用 command:query + task_id:${taskId} 查询结果。`,
        ].join('\n'),
    };
}

/**
 * 命令二：query
 * 拿 task_id 去 agnes 查状态。
 * - 还没好：告诉 AI 进度，让它稍后再来查
 * - 好了：下载视频存本地，返回可访问链接
 * - 失败：报错
 */
async function handleQuery(args) {
    const taskId = args.task_id || args.taskId || args.request_id || args.requestId || '';
    if (!taskId.trim()) throw new Error('query 命令需要提供 task_id，格式：task_id:「始」你的任务ID「末」');

    const res = await httpRequest(
        `${API_BASE}/v1/videos/${taskId}`,
        {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${API_KEY}` },
            timeout: 15000,
        }
    );

    const data = JSON.parse(res.body);
    debugLog('query 响应：', JSON.stringify(data));

    if (res.statusCode !== 200) {
        throw new Error(`查询失败（HTTP ${res.statusCode}）：${data.error?.message || res.body}`);
    }

    const status   = data.status   || 'unknown';
    const progress = data.progress ?? 0;

    if (status === 'queued' || status === 'in_progress') {
        return {
            status: 'success',
            result: `⏳ 视频还在生成中（进度 ${progress}%，状态：${status}）。请再等 1-2 分钟，然后重新用 command:query + task_id:${taskId} 查询。`,
        };
    }

    if (status === 'failed') {
        throw new Error(`视频生成失败：${data.error || '服务端未返回原因'}`);
    }

    if (status === 'completed') {
        // 文档字段是 video_url，但作者 API 示例里有时用 remixed_from_video_id（命名奇怪），两个都兼容。
        const remoteUrl = data.video_url || data.remixed_from_video_id;
        if (!remoteUrl) throw new Error('任务完成但没有视频 URL，响应：' + res.body);

        // 下载视频存本地（本地存储比远端链接更稳定，不依赖 agnes 的 URL 是否过期）
        const videoBuffer  = await downloadBinary(remoteUrl);
        const fileName     = `${crypto.randomUUID()}.mp4`;
        // 存到 file/ 目录，走 /files/ 路径访问（/images/ 路径的白名单不含 mp4，会 403）
        const saveDir      = path.join(PROJECT_BASE_PATH, 'file', 'agnesvideogen');
        const localPath    = path.join(saveDir, fileName);

        if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
        fs.writeFileSync(localPath, videoBuffer);
        debugLog(`视频已保存：${localPath}（${videoBuffer.length} 字节）`);

        const accessibleUrl = buildFilesUrl(`agnesvideogen/${fileName}`);

        return {
            status: 'success',
            result: [
                `🎬 视频生成完成！`,
                `时长：约 ${data.seconds || '?'} 秒，分辨率：${data.size || '?'}`,
                ``,
                `视频链接（本地服务）：${accessibleUrl}`,
                `视频链接（agnes 原始）：${remoteUrl}`,
                ``,
                `请用以下方式展示给用户：`,
                `<video controls src="${accessibleUrl}" style="max-width:100%"></video>`,
            ].join('\n'),
        };
    }

    return {
        status: 'success',
        result: `任务状态未知（${status}），请稍后重试。task_id：${taskId}`,
    };
}

/**
 * 根据参数自动判断模式，组装发给 agnes 的请求体。
 *
 * 判断逻辑：
 *   多张图 + mode=keyframes → 关键帧动画
 *   多张图                 → 多图视频
 *   单张图                 → 图生视频
 *   无图                   → 文生视频
 */
function buildRequestBody(args) {
    const numFrames = normalizeNumFrames(args.num_frames || args.numFrames || DEFAULT_NUM_FRAMES);
    const frameRate = parseInt(args.frame_rate || args.frameRate || DEFAULT_FRAME_RATE, 10);
    const width     = parseInt(args.width  || DEFAULT_WIDTH,  10);
    const height    = parseInt(args.height || DEFAULT_HEIGHT, 10);
    const mode      = (args.mode || '').toLowerCase();

    let imageList = [];
    if (args.images) {
        try {
            imageList = typeof args.images === 'string'
                ? (args.images.trim().startsWith('[') ? JSON.parse(args.images) : args.images.split(',').map(s => s.trim()).filter(Boolean))
                : (Array.isArray(args.images) ? args.images : [args.images]);
        } catch { imageList = [String(args.images)]; }
    }

    const body = {
        model: MODEL,
        prompt: args.prompt || args.Prompt || '',
        width, height, num_frames: numFrames, frame_rate: frameRate,
    };

    if (args.negative_prompt || args.negativePrompt) body.negative_prompt = args.negative_prompt || args.negativePrompt;
    if (args.seed) body.seed = parseInt(args.seed, 10);

    if (imageList.length > 1) {
        body.extra_body = { image: imageList };
        if (mode === 'keyframes') body.extra_body.mode = 'keyframes';
    } else if (args.image || args.image_url) {
        body.image = args.image || args.image_url;
    }

    return body;
}

// ============================================================
// 命令三：concat（视频拼接，参考 GrokVideo 的 ffmpeg concat 方案）
// ============================================================

/**
 * 从参数里收集要拼接的视频 URL，支持两种写法：
 *   1) videos 数组：videos:「始」["url1","url2"]「末」（也兼容逗号分隔）
 *   2) 编号字段：video_url1、video_url2、video_url3 …（与 GrokVideo 一致）
 * 按编号顺序排列，去掉空值。
 */
function collectVideoUrls(args) {
    const urls = [];

    // 写法一：videos 数组
    if (args.videos) {
        try {
            const arr = typeof args.videos === 'string'
                ? (args.videos.trim().startsWith('[') ? JSON.parse(args.videos) : args.videos.split(',').map(s => s.trim()).filter(Boolean))
                : (Array.isArray(args.videos) ? args.videos : [args.videos]);
            urls.push(...arr);
        } catch { urls.push(String(args.videos)); }
    }

    // 写法二：video_url1 / video_url2 / …（按编号升序）
    const numbered = Object.keys(args)
        .map(k => {
            const m = /^video_url(\d+)$/i.exec(k);
            return m ? { idx: parseInt(m[1], 10), val: args[k] } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.idx - b.idx);
    urls.push(...numbered.map(n => n.val));

    return urls.map(u => String(u).trim()).filter(Boolean);
}

/**
 * 把一个视频 URL 准备成本地文件路径，供 ffmpeg 读取。
 *   - http/https：下载到临时目录
 *   - file:// 或本地绝对路径：直接用（不复制，省 IO）
 * 返回 { path, isTemp }，isTemp=true 的拼接完要删。
 */
async function prepareLocalVideo(url, tempDir, index) {
    if (url.startsWith('http://') || url.startsWith('https://')) {
        const buf = await downloadBinary(url);
        const dest = path.join(tempDir, `input_${index}.mp4`);
        fs.writeFileSync(dest, buf);
        return { path: dest, isTemp: true };
    }
    // 本地文件：file:// 或直接路径
    let localPath = url;
    if (url.startsWith('file://')) localPath = new URL(url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');
    if (!fs.existsSync(localPath)) throw new Error(`本地视频文件不存在：${localPath}`);
    return { path: localPath, isTemp: false };
}

/**
 * 跑 ffmpeg，返回 Promise。失败时把 stderr 末尾带回来方便排错。
 */
function runFfmpeg(ffmpegArgs, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', ffmpegArgs);
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg 拼接超时')); }, timeoutMs);
        proc.on('error', err => {
            clearTimeout(timer);
            if (err.code === 'ENOENT') reject(new Error('服务器没装 ffmpeg，视频拼接需要它（GrokVideoGen 的拼接也依赖 ffmpeg）。请先安装 ffmpeg。'));
            else reject(err);
        });
        proc.on('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg 拼接失败（退出码 ${code}）：${stderr.trim().slice(-300)}`));
        });
    });
}

/**
 * 命令三：concat
 * 把多个视频按顺序拼成一个。不需要 prompt，只要视频 URL 列表（至少 2 个）。
 * 用 ffmpeg 的 concat demuxer + 重编码（libx264/aac），保证不同来源的视频也能兼容合并。
 */
async function handleConcat(args) {
    const urls = collectVideoUrls(args);
    if (urls.length < 2) throw new Error('视频拼接至少需要 2 个视频 URL。用 video_url1、video_url2 … 或 videos 数组传入。');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agnes_concat_'));
    const tempFiles = [];
    try {
        // 1. 把每个视频准备成本地文件
        const localPaths = [];
        for (let i = 0; i < urls.length; i++) {
            debugLog(`准备第 ${i + 1}/${urls.length} 个视频：${urls[i]}`);
            const { path: p, isTemp } = await prepareLocalVideo(urls[i], tempDir, i);
            localPaths.push(p);
            if (isTemp) tempFiles.push(p);
        }

        // 2. 写 ffmpeg concat 列表文件（路径里的单引号要转义）
        const listPath = path.join(tempDir, 'concat_list.txt');
        fs.writeFileSync(listPath, localPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf-8');

        // 3. 输出到 file/agnesvideogen/（和生成的视频放一起，走 /files/ 访问）
        const fileName = `concat_${crypto.randomUUID()}.mp4`;
        const saveDir  = path.join(PROJECT_BASE_PATH, 'file', 'agnesvideogen');
        if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
        const outPath = path.join(saveDir, fileName);

        // 4. 跑 ffmpeg：concat demuxer + 重编码确保兼容
        await runFfmpeg([
            '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-movflags', '+faststart',
            outPath,
        ]);
        debugLog(`拼接完成：${outPath}`);

        const accessibleUrl = buildFilesUrl(`agnesvideogen/${fileName}`);
        return {
            status: 'success',
            result: [
                `🎬 视频拼接完成！共合并 ${urls.length} 个视频。`,
                ``,
                `视频链接（本地服务）：${accessibleUrl}`,
                ``,
                `请用以下方式展示给用户：`,
                `<video controls src="${accessibleUrl}" style="max-width:100%"></video>`,
            ].join('\n'),
        };
    } finally {
        // 清理临时目录（只删下载的临时文件和列表，本地原视频不动）
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
    }
}

// ============================================================
// 入口
// ============================================================

async function main() {
    if (!API_KEY) {
        outputAndExit({ status: 'error', error: 'AgnesVideoGen: 缺少 AGNES_VIDEO_API_KEY，请在 config.env 里填写 agnes API 密钥。' });
        return;
    }

    let rawInput = '';
    process.stdin.setEncoding('utf-8');
    for await (const chunk of process.stdin) rawInput += chunk;

    let args;
    try { args = JSON.parse(rawInput.trim()); }
    catch { outputAndExit({ status: 'error', error: `AgnesVideoGen: 参数格式错误，期望 JSON，收到：${rawInput.slice(0, 200)}` }); return; }

    const command = (args.command || args.Command || '').toLowerCase().trim();

    try {
        if (command === 'submit') {
            outputAndExit(await handleSubmit(args));
        } else if (command === 'query') {
            outputAndExit(await handleQuery(args));
        } else if (command === 'concat') {
            outputAndExit(await handleConcat(args));
        } else {
            outputAndExit({
                status: 'error',
                error: `AgnesVideoGen: 不认识的命令"${command}"。支持的命令：submit（提交任务）、query（查询结果）、concat（视频拼接）。`,
            });
        }
    } catch (err) {
        outputAndExit({ status: 'error', error: `AgnesVideoGen Plugin Error: ${err.message}` });
    }
}

main().catch(err => outputAndExit({ status: 'error', error: `AgnesVideoGen Plugin Error: ${err.message}` }));
