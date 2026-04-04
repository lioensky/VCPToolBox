#!/usr/bin/env node
/**
 * DoubaoGen — 同步 stdio 插件，结构对齐「工具系统」思路（参考 build-code-agent / Tool 契约）：
 * - 工具元数据 TOOL_SPEC
 * - parseToolInput：入参归一化 + 校验（等价于 zod 层，无额外依赖）
 * - assertRuntimeEnv：运行前置条件
 * - executeTool：唯一副作用边界（HTTP + 写盘）
 * - 错误信息结构化，避免把整段 prompt 打进 JSON 报错体
 */
import axios from "axios";
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// 工具元数据（名称、能力边界、与宿主 timeout 协调的 HTTP 预算）
// ---------------------------------------------------------------------------
const TOOL_SPEC = {
    name: 'DoubaoGen',
    commandId: 'DoubaoGenerateImage',
    /** 会调用外网 API 并写入本地 image/doubaogen */
    isReadOnly: false,
    /** 与 plugin-manifest communication.timeout 协调 */
    httpTimeoutMs: { generation: 120000, download: 90000 },
};

const VOLCENGINE_API_KEY = process.env.VOLCENGINE_API_KEY;
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY;
const VAR_HTTP_URL = process.env.VarHttpUrl;

const VOLCENGINE_API_CONFIG = {
    BASE_URL: 'https://ark.cn-beijing.volces.com',
    IMAGE_GENERATION_ENDPOINT: '/api/v3/images/generations',
    MODEL_ID: "doubao-seedream-3-0-t2i-250415",
    DEFAULT_PARAMS: {
        n: 1,
        guidance_scale: 2.5,
        watermark: false,
    },
};

const ALLOWED_PAIRS = [
    [1024, 1024], [864, 1152], [1152, 864], [1280, 720], [720, 1280],
    [832, 1248], [1248, 832], [1512, 648],
];
const ALLOWED_RESOLUTIONS = new Set(ALLOWED_PAIRS.map(([w, h]) => `${w}x${h}`));

// ---------------------------------------------------------------------------
// 参数键名归一化（VCP 知识 07 + 协议里 image_size / ImageSize 等同义）
// ---------------------------------------------------------------------------
function normParamKey(k) {
    return String(k).toLowerCase().replace(/[-_\s]/g, '');
}

function flattenArgs(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const flat = {};
    for (const [k, v] of Object.entries(raw)) {
        flat[normParamKey(k)] = v;
    }
    return flat;
}

const WORD_SIZE_ALIASES = {
    portrait: '864x1152',
    vertical: '864x1152',
    tall: '864x1152',
    landscape: '1280x720',
    horizontal: '1280x720',
    wide: '1280x720',
    square: '1024x1024',
};

const RATIO_ALIASES = {
    '1:1': '1024x1024',
    '4:3': '1152x864',
    '3:4': '864x1152',
    '16:9': '1280x720',
    '9:16': '720x1280',
    '21:9': '1512x648',
};

function nearestAllowedSize(w, h) {
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    let bestW = ALLOWED_PAIRS[0][0], bestH = ALLOWED_PAIRS[0][1], bestD = Infinity;
    for (const [aw, ah] of ALLOWED_PAIRS) {
        const d = (w - aw) ** 2 + (h - ah) ** 2;
        if (d < bestD) {
            bestD = d;
            bestW = aw;
            bestH = ah;
        }
    }
    return `${bestW}x${bestH}`;
}

function resolveImageSize(flat) {
    let originalLabel = null;
    let candidate = null;

    const wRaw = flat.width ?? flat.w;
    const hRaw = flat.height ?? flat.h;
    if (wRaw != null && hRaw != null && String(wRaw).trim() !== '' && String(hRaw).trim() !== '') {
        const w = parseInt(String(wRaw).trim(), 10);
        const h = parseInt(String(hRaw).trim(), 10);
        if (Number.isFinite(w) && Number.isFinite(h)) {
            candidate = `${w}x${h}`;
            originalLabel = candidate;
        }
    }

    if (!candidate) {
        const rawVal = flat.resolution ?? flat.size ?? flat.imagesize;
        if (rawVal == null || (typeof rawVal === 'string' && !rawVal.trim())) return null;
        let t = String(rawVal).trim().toLowerCase();
        originalLabel = String(rawVal).trim();
        if (WORD_SIZE_ALIASES[t]) return { size: WORD_SIZE_ALIASES[t] };
        if (RATIO_ALIASES[t]) return { size: RATIO_ALIASES[t] };
        t = t.replace(/\*/g, 'x').replace(/×/g, 'x').replace(/\s+/g, '');
        const m = /^(\d+)x(\d+)$/i.exec(t);
        if (m) candidate = `${parseInt(m[1], 10)}x${parseInt(m[2], 10)}`;
        else return null;
    }

    if (ALLOWED_RESOLUTIONS.has(candidate)) return { size: candidate };

    const m2 = /^(\d+)x(\d+)$/.exec(candidate);
    if (!m2) return null;
    const w = parseInt(m2[1], 10);
    const h = parseInt(m2[2], 10);
    const nearest = nearestAllowedSize(w, h);
    if (!nearest) return null;
    return {
        size: nearest,
        sizeNote: `请求尺寸 ${originalLabel || candidate} 不在 API 支持列表中，已自动选用最接近的 ${nearest}。`,
    };
}

function parseSeedForApi(seed) {
    if (seed === undefined) return undefined;
    if (typeof seed === 'string' && /^\d+$/.test(seed.trim())) return parseInt(seed.trim(), 10);
    return seed;
}

function parseOptionalNumber(v) {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = parseFloat(v.trim());
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

function parseOptionalBool(v) {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'true' || s === '1' || s === 'yes') return true;
        if (s === 'false' || s === '0' || s === 'no') return false;
    }
    return undefined;
}

/**
 * 解析并校验 stdin JSON → 结构化工具入参。
 * @returns {{ ok: true, value: object } | { ok: false, issues: string[], hint?: string }}
 */
function parseToolInput(raw) {
    const issues = [];
    const flat = flattenArgs(raw);

    const prompt = flat.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) {
        issues.push('缺少有效 prompt（非空字符串）。');
    }

    const sizeRes = resolveImageSize(flat);
    if (!sizeRes) {
        const list = [...ALLOWED_RESOLUTIONS].sort().join('、');
        issues.push(
            `无法解析尺寸：请使用 resolution / size / imagesize（如 1024x1024，乘号可用 x、* 或 ×），或 width+height；可用 portrait、landscape、square 或 16:9 等比例。支持列表：${list}。`
        );
    }

    if (flat.seed !== undefined) {
        const s = parseSeedForApi(flat.seed);
        if (typeof s !== 'number' || !Number.isInteger(s) || s < 0) {
            issues.push('seed 须为非负整数（数字或纯数字字符串）。');
        }
    }

    const gs = parseOptionalNumber(flat.guidance_scale ?? flat.guidancescale ?? flat.cfg);
    if (flat.guidance_scale !== undefined || flat.guidancescale !== undefined || flat.cfg !== undefined) {
        if (gs === undefined || gs < 1 || gs > 10) {
            issues.push('guidance_scale（或 cfg）须为 1–10 之间的数字。');
        }
    }

    const wm = parseOptionalBool(flat.watermark);
    if (flat.watermark !== undefined && wm === undefined) {
        issues.push('watermark 须为布尔值或 true/false/1/0 字符串。');
    }

    if (issues.length > 0) {
        return { ok: false, issues, hint: '额外字段（如 maid）会被忽略。' };
    }

    return {
        ok: true,
        value: {
            prompt: prompt.trim(),
            size: sizeRes.size,
            sizeNote: sizeRes.sizeNote,
            seed: parseSeedForApi(flat.seed),
            guidance_scale: gs,
            watermark: wm,
        },
    };
}

function assertRuntimeEnv() {
    const missing = [];
    if (!VOLCENGINE_API_KEY) missing.push('VOLCENGINE_API_KEY');
    if (!PROJECT_BASE_PATH) missing.push('PROJECT_BASE_PATH');
    if (!SERVER_PORT) missing.push('SERVER_PORT');
    if (!IMAGESERVER_IMAGE_KEY) missing.push('IMAGESERVER_IMAGE_KEY');
    if (!VAR_HTTP_URL) missing.push('VarHttpUrl');
    if (missing.length) {
        throw new Error(`DoubaoGen Plugin Error: 缺少环境变量: ${missing.join(', ')}。`);
    }
}

function buildAuthHeaders() {
    if (!VOLCENGINE_API_KEY) {
        console.warn(`[${TOOL_SPEC.name}] WARN: VOLCENGINE_API_KEY 未设置，请求可能失败。`);
    }
    return {
        Authorization: `Bearer ${VOLCENGINE_API_KEY}`,
        'Content-Type': 'application/json',
    };
}

function extensionFromContentType(contentType) {
    if (!contentType || !contentType.startsWith('image/')) return null;
    let ext = contentType.split('/')[1].split(';')[0].trim();
    if (ext.includes('+')) ext = ext.split('+')[0];
    return ext || null;
}

/**
 * 工具核心执行：外网生成 + 可选拉取 + 本地持久化。
 */
async function executeTool(input) {
    const payload = {
        model: VOLCENGINE_API_CONFIG.MODEL_ID,
        prompt: input.prompt,
        n: VOLCENGINE_API_CONFIG.DEFAULT_PARAMS.n,
        size: input.size,
        guidance_scale: VOLCENGINE_API_CONFIG.DEFAULT_PARAMS.guidance_scale,
        watermark: VOLCENGINE_API_CONFIG.DEFAULT_PARAMS.watermark,
    };
    if (input.seed !== undefined) payload.seed = input.seed;
    if (input.guidance_scale !== undefined) payload.guidance_scale = input.guidance_scale;
    if (input.watermark !== undefined) payload.watermark = input.watermark;

    const client = axios.create({
        baseURL: VOLCENGINE_API_CONFIG.BASE_URL,
        headers: buildAuthHeaders(),
        timeout: TOOL_SPEC.httpTimeoutMs.generation,
    });

    const response = await client.post(VOLCENGINE_API_CONFIG.IMAGE_GENERATION_ENDPOINT, payload);
    const responseData = response.data?.data?.[0];
    let blob = responseData?.url ?? responseData?.b64_json;
    if (!blob) {
        throw new Error(
            'DoubaoGen Plugin Error: 无法从 API 响应中解析图片 URL 或 b64_json。Response: ' +
                JSON.stringify(response.data)
        );
    }

    let imageBuffer;
    let imageExtension = 'png';

    if (typeof blob === 'string' && blob.startsWith('http')) {
        const imageResponse = await axios({
            method: 'get',
            url: blob,
            responseType: 'arraybuffer',
            timeout: TOOL_SPEC.httpTimeoutMs.download,
        });
        imageBuffer = imageResponse.data;
        const ext = extensionFromContentType(imageResponse.headers['content-type']);
        if (ext) imageExtension = ext;
        else {
            const urlExtMatch = blob.match(/\.([^.?]+)(?:[?#]|$)/);
            if (urlExtMatch?.[1]) imageExtension = urlExtMatch[1];
        }
    } else {
        imageBuffer = Buffer.from(blob, 'base64');
    }

    const generatedFileName = `${uuidv4()}.${imageExtension}`;
    const doubaoGenImageDir = path.join(PROJECT_BASE_PATH, 'image', 'doubaogen');
    const localImageServerPath = path.join(doubaoGenImageDir, generatedFileName);

    await fs.mkdir(doubaoGenImageDir, { recursive: true });
    await fs.writeFile(localImageServerPath, imageBuffer);

    const relativeServerPathForUrl = path.join('doubaogen', generatedFileName).replace(/\\/g, '/');
    const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;

    const altText =
        input.prompt.length > 80 ? input.prompt.substring(0, 80) + '...' : input.prompt;

    let text =
        `图片已成功生成！\n\n` +
        `详细信息：\n` +
        `- 图片URL: ${accessibleImageUrl}\n` +
        `- 服务器路径: image/doubaogen/${generatedFileName}\n` +
        `- 文件名: ${generatedFileName}\n` +
        `- 实际选用尺寸: ${input.size}\n`;
    if (input.sizeNote) text += `- ${input.sizeNote}\n`;
    text +=
        `\n请务必使用以下HTML <img> 标签将图片直接展示给用户 (您可以调整width属性，建议200-500像素)：\n` +
        `<img src="${accessibleImageUrl}" alt="${altText}" width="300">\n`;

    return text;
}

function formatValidationError(parsed) {
    const body = {
        tool: TOOL_SPEC.name,
        command: TOOL_SPEC.commandId,
        issues: parsed.issues,
    };
    if (parsed.hint) body.hint = parsed.hint;
    return `DoubaoGen Plugin Error: 入参校验失败 — ${JSON.stringify(body)}`;
}

async function runFromStdinJson(raw) {
    assertRuntimeEnv();
    const parsed = parseToolInput(raw);
    if (!parsed.ok) {
        throw new Error(formatValidationError(parsed));
    }
    return executeTool(parsed.value);
}

async function main() {
    let inputChunks = [];
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) inputChunks.push(chunk);
    const inputData = inputChunks.join('');

    try {
        if (!inputData.trim()) {
            console.log(
                JSON.stringify({
                    status: 'error',
                    error: 'DoubaoGen Plugin Error: stdin 无输入。',
                })
            );
            process.exit(1);
            return;
        }
        let raw;
        try {
            raw = JSON.parse(inputData);
        } catch (je) {
            console.log(
                JSON.stringify({
                    status: 'error',
                    error: `DoubaoGen Plugin Error: JSON 解析失败 — ${je.message}`,
                })
            );
            process.exit(1);
            return;
        }

        const result = await runFromStdinJson(raw);
        console.log(JSON.stringify({ status: 'success', result }));
    } catch (e) {
        let detailedError = e.message || 'Unknown error in DoubaoGen plugin';
        if (e.response && e.response.data) {
            detailedError += ` - API Response: ${JSON.stringify(e.response.data)}`;
        }
        const finalErrorMessage = detailedError.startsWith('DoubaoGen Plugin Error:')
            ? detailedError
            : `DoubaoGen Plugin Error: ${detailedError}`;
        console.log(JSON.stringify({ status: 'error', error: finalErrorMessage }));
        process.exit(1);
    }
}

main();
