'use strict';

/**
 * VCPWeCom — VCP 企业微信桥接插件
 *
 * 架构：hybridservice + direct，随 VCP 主进程常驻内存
 * 闭环：企微消息到达 → lazy require AgentAssistant.processToolCall 唤醒 config.env 指定 agent → replyStream 两段式流式回复推回企微
 *
 * 支持消息类型：
 *   - text:  文本消息（含群聊 @机器人）
 *   - image: 图片消息 → SDK 下载解密 → base64 → 多模态 prompt 传给 agent
 *   - file:  文件消息 → SDK 下载解密 → 按类型解析(pdf/word/excel/txt) → 文本 prompt 传给 agent
 *   - voice: 语音消息 → SDK 已转文本 → 当文本处理
 *   - mixed: 图文混排 → 遍历子项，文本+图片组合成多模态 prompt
 *   - video: 视频消息 → 暂不支持（回提示语）
 *
 * 参考：VCPClawMail（manifest 结构、getConfigValue 双源读取、require AgentAssistant 复用先例、try-require 文件解析库）
 */

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

// ============ 文件解析库（lazy try-require，从 VCP 根 node_modules 加载）============
// pdf-parse v2 导出 { PDFParse } 类，v1 导出 function；兼容两种
let pdfParseLib = null;
let mammoth = null;
let ExcelJS = null;
let mimeTypes = null;
try {
    const pp = require('pdf-parse');
    if (typeof pp === 'function') pdfParseLib = pp;             // v1: 直接调用
    else if (pp && typeof pp.PDFParse === 'function') pdfParseLib = pp;  // v2: { PDFParse } 类
} catch (_) {}
try { mammoth = require('mammoth'); } catch (_) {}
try { ExcelJS = require('exceljs'); } catch (_) {}
try { mimeTypes = require('mime-types'); } catch (_) {}

// ============ 模块级状态 ============
let AiBot = null;
let wsClient = null;

let config = {};
let dependencies = {};
let debugMode = false;

// 运行时统计
let stats = {
    connected: false,
    authenticated: false,
    lastReconnectAttempt: 0,
    messagesReceived: 0,
    messagesProcessed: 0,
    messagesFailed: 0,
    lastMessageAt: null,
    lastError: null,
    startedAt: null
};

// ============ 配置工具函数 ============

function getConfigValue(...keys) {
    for (const key of keys) {
        if (config[key] !== undefined && config[key] !== null && config[key] !== '') return config[key];
        if (process.env[key] !== undefined && process.env[key] !== null && process.env[key] !== '') return process.env[key];
    }
    return '';
}

function normalizeBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true';
}

function normalizeInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeIntegerPositive(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
    const trimmed = String(value).trim();
    if (!trimmed) return [];
    return trimmed.split(',').map(v => v.trim()).filter(Boolean);
}

function log(...args) {
    console.log('[VCPWeCom]', ...args);
}

function warn(...args) {
    console.warn('[VCPWeCom]', ...args);
}

function debug(...args) {
    if (debugMode) console.log('[VCPWeCom][debug]', ...args);
}

function setStatsError(err) {
    stats.lastError = {
        message: String(err?.message || err || ''),
        at: new Date().toISOString()
    };
}

// ============ 解析后的运行时配置 ============

function loadRuntimeConfig() {
    return {
        botId: String(getConfigValue('WeComBotId', 'BOT_ID') || '').trim(),
        botSecret: String(getConfigValue('WeComBotSecret', 'BOT_SECRET') || '').trim(),
        bindAgent: String(getConfigValue('WeComBindAgent', 'BIND_AGENT') || '').trim(),
        maxReconnect: normalizeInteger(getConfigValue('WeComMaxReconnect', 'MAX_RECONNECT'), -1),
        heartbeatInterval: normalizeIntegerPositive(getConfigValue('WeComHeartbeatInterval', 'HEARTBEAT_INTERVAL'), 30000),
        streamReply: normalizeBoolean(getConfigValue('WeComStreamReply', 'STREAM_REPLY'), true),
        streamHint: String(getConfigValue('WeComStreamHint', 'STREAM_HINT') || '正在思考中…'),
        sessionPrefix: String(getConfigValue('WeComSessionPrefix', 'SESSION_PREFIX') || 'wecom'),
        injectTools: String(getConfigValue('WeComInjectTools', 'INJECT_TOOLS') || '').trim(),
        allowedUsers: splitList(getConfigValue('WeComAllowedUsers', 'ALLOWED_USERS')),
        agentTimeoutMs: normalizeIntegerPositive(getConfigValue('WeComAgentTimeoutMs', 'AGENT_TIMEOUT_MS'), 120000),
        welcomeText: String(getConfigValue('WeComWelcomeText', 'WELCOME_TEXT') || '').trim(),
        // 图片/文件处理配置
        maxImageBytes: normalizeIntegerPositive(getConfigValue('WeComMaxImageBytes', 'MAX_IMAGE_BYTES'), 10 * 1024 * 1024),
        maxFileBytes: normalizeIntegerPositive(getConfigValue('WeComMaxFileBytes', 'MAX_FILE_BYTES'), 25 * 1024 * 1024),
        fileParseTimeoutMs: normalizeIntegerPositive(getConfigValue('WeComFileParseTimeoutMs', 'FILE_PARSE_TIMEOUT_MS'), 30000)
    };
}

// ============ AgentAssistant 复用（lazy require）============

let _agentAssistantModule = null;
let _agentAssistantRequiredAt = 0;

function getAgentAssistant() {
    if (_agentAssistantModule) return _agentAssistantModule;
    try {
        _agentAssistantModule = require('../AgentAssistant/AgentAssistant.js');
        _agentAssistantRequiredAt = Date.now();
        log('AgentAssistant 模块已加载（lazy require）');
        return _agentAssistantModule;
    } catch (err) {
        warn('加载 AgentAssistant 模块失败:', err.message);
        setStatsError(err);
        return null;
    }
}

function extractReplyText(result) {
    if (!result) return '';
    if (typeof result === 'string') return result;
    if (Array.isArray(result?.content)) {
        const textPart = result.content.find(p => p?.type === 'text');
        if (textPart?.text) return String(textPart.text);
    }
    if (typeof result?.content === 'string') return result.content;
    return '';
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 清理群聊 @机器人 前缀。
 * 只在 @名+空格+内容 的标准格式时才清理，避免贪婪正则吃掉中文标点后的内容。
 */
function stripMentionPrefix(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';
    const m = trimmed.match(/^@\S+\s+([\s\S]+)$/);
    if (m && m[1].trim()) return m[1].trim();
    return trimmed;
}

// ============ 调 Agent 生成回复 ============

/**
 * 唤醒 agent 生成回复。
 * @param {Object} params
 * @param {string|Array} params.prompt - 字符串或多模态数组 [{type:'text',text}, {type:'image_url',image_url:{url}}]
 * @param {string} params.userid
 * @param {string} params.chatid
 * @param {string} params.chattype
 * @param {Object} params.runtimeConfig
 */
async function callAgentForMessage({ prompt, userid, chatid, chattype, runtimeConfig }) {
    const agentAssistant = getAgentAssistant();
    if (!agentAssistant || typeof agentAssistant.processToolCall !== 'function') {
        throw new Error('AgentAssistant 服务未就绪，无法唤醒 agent。');
    }

    // 会话隔离：单聊按 userid，群聊按 chatid
    const sessionKey = (chattype === 'group' && chatid)
        ? `${runtimeConfig.sessionPrefix}_group_${chatid}`
        : `${runtimeConfig.sessionPrefix}_${userid}`;

    // 对字符串 prompt 清理 @ 前缀；对数组 prompt 清理其中 text 部分
    let finalPrompt = prompt;
    if (typeof prompt === 'string') {
        finalPrompt = stripMentionPrefix(prompt);
        if (!finalPrompt) {
            throw new Error('消息内容为空（可能只是 @ 机器人）。');
        }
    } else if (Array.isArray(prompt)) {
        // 处理数组中的 text 部分
        const textPart = prompt.find(p => p.type === 'text');
        if (textPart && textPart.text) {
            textPart.text = stripMentionPrefix(textPart.text);
        }
        // 移除空的 text 部分，保留有内容的部分和 image_url 部分
        finalPrompt = prompt.filter(p => {
            if (p.type === 'text') return p.text && p.text.trim();
            return true; // image_url 等保留
        });
        if (finalPrompt.length === 0) {
            throw new Error('消息内容为空（可能只是 @ 机器人）。');
        }
        // 如果只剩一个 text 部分，降级为字符串
        if (finalPrompt.length === 1 && finalPrompt[0].type === 'text') {
            finalPrompt = finalPrompt[0].text;
        }
    }

    const callArgs = {
        agent_name: runtimeConfig.bindAgent,
        prompt: finalPrompt,
        maid: `VCPWeCom/${userid}`,
        session_id: sessionKey
    };
    if (runtimeConfig.injectTools) {
        callArgs.inject_tools = runtimeConfig.injectTools;
    }

    debug('唤醒 Agent:', JSON.stringify({
        agent: callArgs.agent_name,
        session: callArgs.session_id,
        promptType: typeof finalPrompt === 'string' ? 'text' : 'multimodal',
        promptPreview: typeof finalPrompt === 'string'
            ? finalPrompt.slice(0, 80)
            : `[${finalPrompt.map(p => p.type).join(', ')}]`
    }));

    const result = await withTimeout(
        agentAssistant.processToolCall(callArgs),
        runtimeConfig.agentTimeoutMs,
        `AgentAssistant.processToolCall(${runtimeConfig.bindAgent})`
    );

    return extractReplyText(result);
}

// ============ 企微消息处理工具 ============

function isUserAllowed(userid, runtimeConfig) {
    if (!runtimeConfig.allowedUsers || runtimeConfig.allowedUsers.length === 0) return true;
    return runtimeConfig.allowedUsers.includes(userid);
}

function buildTarget(frame) {
    const body = frame?.body || {};
    if (body.chattype === 'group' && body.chatid) return { target: body.chatid, isGroup: true };
    const userid = body?.from?.userid;
    return { target: userid, isGroup: false };
}

function safeTruncate(text, maxBytes, suffix = '…[回复过长已截断]') {
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxBytes) return text;
    const suffixBuf = Buffer.from(suffix, 'utf8');
    const cutBytes = Math.max(0, maxBytes - suffixBuf.length);
    let cut = buf.subarray(0, cutBytes).toString('utf8');
    for (let i = cut.length - 1; i >= 0; i--) {
        try {
            Buffer.from(cut.slice(0, i + 1), 'utf8');
            cut = cut.slice(0, i + 1);
            break;
        } catch (_) { /* continue */ }
    }
    return cut + suffix;
}

/**
 * 清理 VCP TOOL_REQUEST 块，替换成「【调用 xxx 工具】」。
 *
 * agent 回复中可能残留 <<<[TOOL_REQUEST]>>>...<<<[END_TOOL_REQUEST]>>> 块
 * （tool loop 异常、archery:no_reply、或 agent 在正文里嵌了格式），
 * 直接推到企微会暴露内部协议语法，影响阅读。
 *
 * 如果块内有 tool_name:「始」xxx「末」，提取工具名；否则显示「工具调用」。
 * 块前后的正常文字保留不动。
 */
function cleanToolRequests(text) {
    if (!text || typeof text !== 'string') return text || '';
    let result = text.replace(
        /<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g,
        (block) => {
            const m = block.match(/tool_name[：:]「始」([^「」]*)「末」/);
            const toolName = m?.[1]?.trim();
            return toolName ? `【调用 ${toolName} 工具】` : '【工具调用】';
        }
    );
    // 清理 [本轮工具调用摘要:xxx]...[本轮工具调用摘要结束] 块
    // 成功 → ✅️调用成功，失败 → ❎️调用失败
    result = result.replace(
        /\[本轮工具调用摘要[：:]\s*\]([\s\S]*?)\[本轮工具调用摘要结束\]/g,
        (block, inner) => {
            if (inner.includes('失败') || inner.includes('错误') || inner.includes('异常') || inner.includes('Error')) {
                return '❎️调用失败';
            }
            return '✅️调用成功';
        }
    );
    return result;
}

/**
 * 发送流式提示帧（第一段）。
 */
async function sendStreamHint(frame, streamId, runtimeConfig) {
    if (!runtimeConfig.streamReply) return;
    try {
        await wsClient.replyStream(frame, streamId, runtimeConfig.streamHint, false);
    } catch (err) {
        warn('发送流式提示帧失败:', err.message);
    }
}

/**
 * HTTP GET 下载图片，返回 Buffer。支持 http/https，带 10s 超时。
 */
function downloadImageBuffer(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, { timeout: timeoutMs }, (res) => {
            // 跟随重定向
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadImageBuffer(res.headers.location, timeoutMs).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('下载超时'));
        });
    });
}

/**
 * 从 agent 回复文本中提取 <img> 标签，下载图片，生成企微 msgItem。
 *
 * 流程：
 *   1. 正则匹配所有 <img src="..." width="..."> 标签
 *   2. 并行下载每张图片 → base64 + md5
 *   3. 从文本中剥离 <img> 标签，返回纯文本 + 图片数组
 *
 * 降级：某张图下载失败 → 替换为 [表情包加载失败]
 * 限制：最多取前 10 张（企微 msgItem 上限），GIF/WebP 跳过（企微仅支持 JPG/PNG）
 */
async function extractAndDownloadImages(text) {
    if (!text || typeof text !== 'string') return { text, msgItems: [] };

    const imgRegex = /<img\s+src="([^"]+)"(?:\s+width="(\d+)")?[^>]*>/gi;
    const matches = [];
    let match;
    while ((match = imgRegex.exec(text)) !== null) {
        matches.push({ src: match[1], width: match[2], fullTag: match[0] });
    }

    if (matches.length === 0) return { text, msgItems: [] };

    // 最多取前 10 张
    const selected = matches.slice(0, 10);
    debug(`发现 ${matches.length} 个 <img> 标签，处理前 ${selected.length} 张`);

    // 并行下载
    const downloadResults = await Promise.allSettled(
        selected.map(async (m) => {
            // 检查扩展名，GIF/WebP 不支持
            const urlLower = m.src.toLowerCase();
            if (urlLower.match(/\.(gif|webp|bmp)/)) {
                throw new Error(`企微不支持该格式: ${m.src.split('/').pop()}`);
            }
            const buffer = await downloadImageBuffer(m.src);
            if (buffer.length > 10 * 1024 * 1024) {
                throw new Error(`图片过大: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
            }
            return {
                fullTag: m.fullTag,
                buffer,
                msgItem: {
                    msgtype: 'image',
                    image: {
                        base64: buffer.toString('base64'),
                        md5: crypto.createHash('md5').update(buffer).digest('hex')
                    }
                }
            };
        })
    );

    // 组装 msgItems，失败的标记为降级文本
    const msgItems = [];
    const replacements = []; // { fullTag, replacement }
    for (let i = 0; i < downloadResults.length; i++) {
        const r = downloadResults[i];
        const m = selected[i];
        if (r.status === 'fulfilled') {
            msgItems.push(r.value.msgItem);
            replacements.push({ fullTag: m.fullTag, replacement: '' }); // 剥离标签
        } else {
            debug(`图片下载失败 [${m.src}]: ${r.reason?.message || r.reason}`);
            replacements.push({ fullTag: m.fullTag, replacement: '[表情包加载失败]' });
        }
    }

    // 超出 10 张的，也替换为占位
    for (let i = selected.length; i < matches.length; i++) {
        replacements.push({ fullTag: matches[i].fullTag, replacement: '' });
    }

    // 从文本中剥离/替换 img 标签
    let cleanText = text;
    for (const r of replacements) {
        cleanText = cleanText.replace(r.fullTag, r.replacement);
    }
    // 清理多余空行（图片被剥离后可能留下连续空行）
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

    return { text: cleanText, msgItems };
}

/**
 * 推回复回企微（第二段）。
 *
 * 处理流程：
 *   1. 清理 TOOL_REQUEST 块
 *   2. 提取 <img> 标签 → 下载图片 → 组装 msgItem
 *   3. 文本部分作为 content，图片作为 msgItem（finish=true）
 *   4. 非流式模式无 msgItem 能力，图片降级为 [表情包] 文本
 */
async function sendReply(frame, streamId, replyText, runtimeConfig) {
    // 推回企微前清理 TOOL_REQUEST 块，避免内部协议语法暴露给用户
    const cleaned = cleanToolRequests(replyText);

    // 提取并下载 <img> 标签指向的图片
    const { text: textWithoutImg, msgItems } = await extractAndDownloadImages(cleaned);

    if (runtimeConfig.streamReply) {
        // 企微 replyStream 的 content 不能为空，空内容会导致发送失败
        let safeText = safeTruncate(textWithoutImg, 20000);
        if (!safeText || safeText.trim() === '') {
            safeText = msgItems.length > 0 ? '[表情包]' : '[空回复]';
        }

        // 先发文本（finish=true 结束流式消息）
        await wsClient.replyStream(frame, streamId, safeText, true);
        debug(`replyStream 文本已发送: content长度=${safeText.length}`);

        // 再主动推送图片（uploadMedia → sendMediaMessage）
        if (msgItems.length > 0) {
            const { target } = buildTarget(frame);
            if (target) {
                for (let i = 0; i < msgItems.length; i++) {
                    const item = msgItems[i];
                    try {
                        const b64 = item.image.base64;
                        const md5 = item.image.md5;
                        debug(`上传图片[${i}]: base64长度=${b64.length} md5=${md5}`);
                        const buffer = Buffer.from(b64, 'base64');
                        const uploadResult = await wsClient.uploadMedia(buffer, {
                            type: 'image',
                            filename: `emoji_${i}.png`
                        });
                        debug(`uploadMedia 成功[${i}]: media_id=${uploadResult.media_id}`);
                        await wsClient.sendMediaMessage(target, 'image', uploadResult.media_id);
                        debug(`sendMediaMessage 成功[${i}]: target=${target}`);
                    } catch (err) {
                        warn(`图片推送失败[${i}]: ${err.message}`);
                    }
                }
            }
        }
    } else {
        // 非流式模式（sendMessage）不支持 msgItem，图片信息已在文本中被替换
        const { target } = buildTarget(frame);
        if (!target) throw new Error('无法确定回复目标（缺少 userid/chatid）');
        await wsClient.sendMessage(target, {
            msgtype: 'markdown',
            markdown: { content: textWithoutImg }
        });
    }
}

// ============ 表情包图片处理 ============

/**
 * HTTP GET 下载图片，返回 Buffer。
 * 支持 http 和 https，带 10 秒超时。
 */
function fetchImageBuffer(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        // 对 URL 中的非 ASCII 字符（如中文路径）进行编码
        // Node.js http.get 不会自动编码中文，导致带中文的路径返回 404
        // 用 encodeURI 而非 encodeURIComponent：保留 = & ? / : 等 URL 结构字符
        // 这样 pw=YOUR_IMAGE_KEY 段里的 = 不会被编码成 %3D（导致 401）
        const encodedUrl = encodeURI(url);
        const client = encodedUrl.startsWith('https') ? https : http;
        const req = client.get(encodedUrl, { timeout: timeoutMs }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('下载超时'));
        });
    });
}

/**
 * 从 agent 回复文本中提取图片引用，下载图片，组成企微 msgItem 数组。
 *
 * 支持三种 agent 可能输出的格式：
 *   1. <img src="http://..." width="150">
 *   2. [图片]http://...
 *   3. ![alt](http://...)   （Markdown 图片语法）
 *
 * 流程：
 * 1. 正则匹配所有图片引用
 * 2. 并行下载图片（支持 http/https）
 * 3. 转 base64 + md5
 * 4. 从原文中剥离图片标签，剩余文本作为 content
 *
 * 容错：
 * - 下载失败 → 该标签替换为「[表情包加载失败]」
 * - 格式不支持(gif/webp) → 替换为「[不支持的表情包格式]」
 * - 超过 10 张 → 多余的忽略（企微限制）
 * - 超过 10MB → 替换为「[表情包过大]」
 *
 * @param {string} text agent 回复原文
 * @returns {Promise<{text: string, msgItems: Array}>} 剥离后的文本 + msgItem 数组
 */
async function extractAndDownloadImages(text) {
    const matches = [];
    let m;

    // 格式1: <img src="..." width="...">
    const IMG_TAG_RE = /<img\s+src="([^"]+)"(?:\s+width="\d+")?[^>]*>/gi;
    while ((m = IMG_TAG_RE.exec(text)) !== null) {
        matches.push({ full: m[0], src: m[1] });
    }

    // 格式2: [图片]url（url 前后可能有空格）
    const BRACKET_RE = /\[图片\]\s*(https?:\/\/[^\s\]<]+)/gi;
    while ((m = BRACKET_RE.exec(text)) !== null) {
        matches.push({ full: m[0], src: m[1] });
    }

    // 格式3: ![alt](url)  Markdown 图片
    const MD_IMG_RE = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;
    while ((m = MD_IMG_RE.exec(text)) !== null) {
        matches.push({ full: m[0], src: m[1] });
    }

    if (matches.length === 0) {
        return { text, msgItems: [] };
    }

    debug(`发现 ${matches.length} 个图片引用，开始下载表情包`);

    // 企微限制：最多 10 张图
    const usable = matches.slice(0, 10);
    const overflow = matches.length - usable.length;

    // 并行下载
    const results = await Promise.allSettled(
        usable.map(async (match) => {
            const url = match.src;

            // 检查格式
            const lowerUrl = url.toLowerCase().split('?')[0];
            if (lowerUrl.endsWith('.gif') || lowerUrl.endsWith('.webp') || lowerUrl.endsWith('.bmp')) {
                throw new Error('不支持的表情包格式');
            }

            const buffer = await fetchImageBuffer(url);

            // 检查大小（10MB = 10485760 字节）
            if (buffer.length > 10485760) {
                throw new Error('表情包过大');
            }

            const base64 = buffer.toString('base64');
            const md5 = crypto.createHash('md5').update(buffer).digest('hex');
            return { full: match.full, base64, md5, success: true };
        })
    );

    // 组装 msgItems + 替换原文中的标签
    let cleanedText = text;
    const msgItems = [];

    for (const result of results) {
        if (result.status === 'fulfilled' && result.value.success) {
            // 剥离成功的 <img> 标签
            cleanedText = cleanedText.replace(result.value.full, '');
            msgItems.push({
                msgtype: 'image',
                image: { base64: result.value.base64, md5: result.value.md5 }
            });
        } else {
            // 下载失败 → 替换为提示文本
            const reason = result.reason?.message || '下载失败';
            const failedMatch = results.indexOf(result) >= 0 ? usable[results.indexOf(result)] : null;
            if (failedMatch) {
                cleanedText = cleanedText.replace(failedMatch.full, `[表情包加载失败:${reason}]`);
            }
        }
    }

    if (overflow > 0) {
        debug(`有 ${overflow} 个表情包因超过企微上限(10张)被忽略`);
    }

    // 清理剥离后可能残留的多余空行
    cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();

    debug(`表情包处理完成: ${msgItems.length} 张成功, 文本长度 ${cleanedText.length}`);
    return { text: cleanedText, msgItems };
}

// ============ 媒体下载与解析 ============

/**
 * 用 SDK downloadFile 下载并 AES 解密企微媒体文件。
 * @returns {Promise<{buffer: Buffer, filename?: string}>}
 */
async function downloadMedia(url, aesKey) {
    if (!wsClient || typeof wsClient.downloadFile !== 'function') {
        throw new Error('SDK downloadFile 不可用');
    }
    if (!url) throw new Error('媒体 URL 为空');
    if (!aesKey) throw new Error('媒体 aesKey 为空，无法解密');
    return await wsClient.downloadFile(url, aesKey);
}

/**
 * 将图片 Buffer 转为 data URL（base64）。
 */
function bufferToDataUrl(buffer, filename) {
    const ext = path.extname(filename || '').toLowerCase().replace('.', '');
    let mimeType = 'image/jpeg';
    if (ext === 'png') mimeType = 'image/png';
    else if (ext === 'gif') mimeType = 'image/gif';
    else if (ext === 'webp') mimeType = 'image/webp';
    else if (ext === 'bmp') mimeType = 'image/bmp';
    else if (mimeTypes) {
        const looked = mimeTypes.lookup(ext);
        if (looked && looked.startsWith('image/')) mimeType = looked;
    }
    const base64 = buffer.toString('base64');
    return `data:${mimeType};base64,${base64}`;
}

/**
 * 按文件扩展名解析文件内容为文本。
 * 支持：pdf, docx, xlsx, txt/md/csv/json 等纯文本格式。
 * @returns {Promise<string>} 解析后的文本（含文件名标注）
 */
async function parseFileToText(buffer, filename) {
    const ext = path.extname(filename || '').toLowerCase().replace('.', '');

    if (ext === 'pdf') {
        if (!pdfParseLib) throw new Error('pdf-parse 未安装，无法解析 PDF');
        // pdf-parse v1 API: pdfParseLib(buffer) → { text }（已废弃，但兼容）
        if (typeof pdfParseLib === 'function') {
            // v1 fallback
            const data = await withTimeout(
                Promise.resolve(pdfParseLib(buffer)),
                30000,
                'pdf-parse'
            );
            return `[PDF文件: ${filename}]\n${data.text || '(PDF无文本层，可能是扫描件)'}`;
        } else if (pdfParseLib.PDFParse) {
            // v2 API
            const parser = new pdfParseLib.PDFParse({ data: buffer });
            await withTimeout(parser.load(), 30000, 'pdf-parse load');
            const textResult = await withTimeout(parser.getText(), 30000, 'pdf-parse getText');
            try { await parser.destroy(); } catch (_) {}
            return `[PDF文件: ${filename}]\n${textResult.text || '(PDF无文本层，可能是扫描件)'}`;
        }
        throw new Error('pdf-parse 版本不兼容');
    }

    if (ext === 'docx' || ext === 'doc') {
        if (!mammoth) throw new Error('mammoth 未安装，无法解析 Word');
        const result = await withTimeout(
            mammoth.extractRawText({ arrayBuffer: buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer }),
            30000,
            'mammoth'
        );
        return `[Word文件: ${filename}]\n${result.value || '(文档无文本内容)'}`;
    }

    if (ext === 'xlsx' || ext === 'xls') {
        if (!ExcelJS) throw new Error('exceljs 未安装，无法解析 Excel');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const lines = [];
        workbook.eachSheet((worksheet) => {
            lines.push(`[Sheet: ${worksheet.name}]`);
            worksheet.eachRow((row) => {
                lines.push(row.values.slice(1).map(v => v ?? '').join('\t'));
            });
        });
        return `[Excel文件: ${filename}]\n${lines.join('\n') || '(空表格)'}`;
    }

    // 纯文本类文件直接读 utf8
    const textExts = ['txt', 'md', 'csv', 'json', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'go', 'rs', 'html', 'css', 'xml', 'yml', 'yaml', 'log', 'sql', 'sh', 'bat', 'ini', 'conf'];
    if (textExts.includes(ext)) {
        const text = buffer.toString('utf8');
        // 截断超长文本（避免 prompt 过长）
        const maxChars = 50000;
        const truncated = text.length > maxChars ? text.slice(0, maxChars) + '\n…[文件内容过长已截断]' : text;
        return `[文本文件: ${filename}]\n${truncated}`;
    }

    throw new Error(`暂不支持解析 .${ext || '未知'} 格式的文件`);
}

// ============ 引用消息解析 ============

/**
 * 解析 body.quote 引用内容，返回可直接拼入 prompt 的结构。
 *
 * @param {object} quote - body.quote 引用对象
 * @param {object} runtimeConfig - 运行时配置
 * @returns {Promise<{type:'text'|'image'|'multipart', text?:string, dataUrl?:string, parts?:Array}>}
 *   - type=text:  纯文本引用，用 text 字段
 *   - type=image: 图片引用，用 dataUrl 字段（可能附带 text 说明）
 *   - type=multipart: 图文混排引用，用 parts 数组
 */
async function resolveQuote(quote, runtimeConfig) {
    if (!quote || !quote.msgtype) return null;

    const qt = quote.msgtype;

    // --- 文本引用 ---
    if (qt === 'text') {
        const t = quote.text?.content || '(引用文本为空)';
        return { type: 'text', text: `[用户引用了以下消息]\n${t}` };
    }

    // --- 语音引用（SDK 已转文本） ---
    if (qt === 'voice') {
        const t = quote.voice?.content || '(引用语音为空)';
        return { type: 'text', text: `[用户引用了一条语音消息，内容如下]\n${t}` };
    }

    // --- 图片引用 ---
    if (qt === 'image') {
        const url = quote.image?.url;
        const aesKey = quote.image?.aeskey;
        if (!url || !aesKey) return { type: 'text', text: '[用户引用了一张图片，但图片信息不完整]' };
        try {
            const { buffer, filename } = await downloadMedia(url, aesKey);
            debug(`引用图片下载完成 size=${buffer.length} bytes`);
            if (buffer.length > runtimeConfig.maxImageBytes) {
                return { type: 'text', text: `[用户引用了一张图片，但图片过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），无法处理]` };
            }
            const dataUrl = bufferToDataUrl(buffer, filename);
            return { type: 'image', dataUrl };
        } catch (err) {
            warn('引用图片下载失败:', err.message);
            return { type: 'text', text: `[用户引用了一张图片，但下载失败：${err.message}（可能链接已过期）]` };
        }
    }

    // --- 文件引用 ---
    if (qt === 'file') {
        const url = quote.file?.url;
        const aesKey = quote.file?.aeskey;
        if (!url || !aesKey) return { type: 'text', text: '[用户引用了一个文件，但文件信息不完整]' };
        try {
            const { buffer, filename } = await downloadMedia(url, aesKey);
            debug(`引用文件下载完成 filename=${filename || '(无)'} size=${buffer.length} bytes`);
            if (buffer.length > runtimeConfig.maxFileBytes) {
                return { type: 'text', text: `[用户引用了一个文件 ${filename || ''}，但文件过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），无法处理]` };
            }
            // 尝试解析为文本
            let fileText;
            try {
                fileText = await withTimeout(
                    parseFileToText(buffer, filename),
                    runtimeConfig.fileParseTimeoutMs,
                    'quote.parseFileToText'
                );
                return { type: 'text', text: `[用户引用了以下文件]\n${fileText}` };
            } catch (parseErr) {
                // 解析失败，检查是否是图片扩展名
                const ext = path.extname(filename || '').toLowerCase().replace('.', '');
                if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
                    debug('引用文件是图片扩展名，走图片路径');
                    const dataUrl = bufferToDataUrl(buffer, filename);
                    return { type: 'image', dataUrl, text: `[用户引用了一个图片文件: ${filename}]` };
                }
                throw parseErr;
            }
        } catch (err) {
            warn('引用文件处理失败:', err.message);
            return { type: 'text', text: `[用户引用了一个文件，但处理失败：${err.message}（可能链接已过期）]` };
        }
    }

    // --- 图文混排引用 ---
    if (qt === 'mixed') {
        const msgItems = quote.mixed?.msg_item || [];
        const parts = [];
        for (const item of msgItems) {
            if (item.msgtype === 'text' && item.text?.content) {
                parts.push({ type: 'text', text: item.text.content });
            } else if (item.msgtype === 'image' && item.image?.url && item.image?.aeskey) {
                try {
                    const { buffer, filename } = await downloadMedia(item.image.url, item.image.aeskey);
                    if (buffer.length <= runtimeConfig.maxImageBytes) {
                        const dataUrl = bufferToDataUrl(buffer, filename);
                        parts.push({ type: 'image_url', image_url: { url: dataUrl } });
                    } else {
                        parts.push({ type: 'text', text: `[引用的图片过大，已跳过]` });
                    }
                } catch (err) {
                    parts.push({ type: 'text', text: `[引用的图片下载失败: ${err.message}]` });
                }
            }
        }
        if (parts.length === 0) return { type: 'text', text: '[用户引用了一条图文混排消息，但内容为空]' };
        return { type: 'multipart', parts };
    }

    return { type: 'text', text: `[用户引用了一条不支持类型的消息: ${qt}]` };
}

// ============ 消息处理函数 ============

async function handleTextMessage(frame) {
    stats.messagesReceived += 1;
    stats.lastMessageAt = new Date().toISOString();

    const body = frame?.body || {};
    const userid = body?.from?.userid || '';
    const text = body?.text?.content || '';
    const chatid = body?.chatid || '';
    const chattype = body?.chattype || 'single';
    const msgid = body?.msgid || '';
    const quote = body?.quote || null;

    debug(`收到文本消息 userid=${userid} chattype=${chattype} chatid=${chatid || '(无)'} msgid=${msgid} content=${JSON.stringify(text)} quote=${quote ? quote.msgtype : '无'}`);

    const runtimeConfig = loadRuntimeConfig();
    if (!isUserAllowed(userid, runtimeConfig)) {
        debug(`用户 ${userid} 不在白名单，已忽略`);
        return;
    }

    const { generateReqId } = AiBot;
    const streamId = generateReqId('stream');

    await sendStreamHint(frame, streamId, runtimeConfig);

    let replyText;
    try {
        // 解析引用消息（群聊引用图片/文件再 @bot 的场景）
        let prompt = text;
        if (quote) {
            const quoteResult = await resolveQuote(quote, runtimeConfig);
            if (quoteResult) {
                if (quoteResult.type === 'text') {
                    // 纯文本引用：拼成字符串
                    prompt = `${quoteResult.text}\n\n用户说：${text}`;
                } else if (quoteResult.type === 'image') {
                    // 图片引用：多模态 prompt
                    const desc = quoteResult.text || '[用户引用了一张图片]';
                    prompt = [
                        { type: 'text', text: `${desc}\n\n用户说：${text}` },
                        { type: 'image_url', image_url: { url: quoteResult.dataUrl } }
                    ];
                } else if (quoteResult.type === 'multipart') {
                    // 图文混排引用：多模态 prompt
                    prompt = [
                        { type: 'text', text: `[用户引用了以下图文混排消息]\n\n用户说：${text}` },
                        ...quoteResult.parts
                    ];
                }
            }
        }

        replyText = await callAgentForMessage({
            prompt, userid, chatid, chattype, runtimeConfig
        });
        if (!replyText) replyText = '[agent 返回了空回复]';
    } catch (err) {
        warn('唤醒 agent 失败:', err.message);
        setStatsError(err);
        stats.messagesFailed += 1;
        replyText = `[处理失败] ${err.message}`;
    }

    try {
        await sendReply(frame, streamId, replyText, runtimeConfig);
        stats.messagesProcessed += 1;
        debug(`回复已推送 userid=${userid} 长度=${replyText.length}`);
    } catch (err) {
        warn('推回企微失败:', err.message);
        setStatsError(err);
        stats.messagesFailed += 1;
    }
}

async function handleImageMessage(frame) {
    stats.messagesReceived += 1;
    stats.lastMessageAt = new Date().toISOString();

    const body = frame?.body || {};
    const userid = body?.from?.userid || '';
    const chatid = body?.chatid || '';
    const chattype = body?.chattype || 'single';
    const msgid = body?.msgid || '';
    const imageUrl = body?.image?.url;
    const imageAesKey = body?.image?.aeskey;

    debug(`收到图片消息 userid=${userid} chattype=${chattype} msgid=${msgid} url=${imageUrl ? '有' : '无'} aeskey=${imageAesKey ? '有' : '无'}`);

    const runtimeConfig = loadRuntimeConfig();
    if (!isUserAllowed(userid, runtimeConfig)) {
        debug(`用户 ${userid} 不在白名单，已忽略`);
        return;
    }

    const { generateReqId } = AiBot;
    const streamId = generateReqId('stream');

    await sendStreamHint(frame, streamId, runtimeConfig);

    let replyText;
    try {
        // 1. 下载并解密图片
        const { buffer, filename } = await downloadMedia(imageUrl, imageAesKey);
        debug(`图片下载完成 filename=${filename || '(无)'} size=${buffer.length} bytes`);

        // 2. 检查大小限制
        if (buffer.length > runtimeConfig.maxImageBytes) {
            throw new Error(`图片过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），上限 ${(runtimeConfig.maxImageBytes / 1024 / 1024).toFixed(0)}MB`);
        }

        // 3. 转 base64 data URL
        const dataUrl = bufferToDataUrl(buffer, filename);
        debug(`图片转 base64 完成 mimeType=${dataUrl.split(';')[0].split(':')[1]} dataLen=${dataUrl.length}`);

        // 4. 构建多模态 prompt 数组
        const prompt = [
            { type: 'text', text: `[用户发送了一张图片]` },
            { type: 'image_url', image_url: { url: dataUrl } }
        ];

        replyText = await callAgentForMessage({
            prompt, userid, chatid, chattype, runtimeConfig
        });
        if (!replyText) replyText = '[agent 返回了空回复]';
    } catch (err) {
        warn('处理图片消息失败:', err.message);
        setStatsError(err);
        stats.messagesFailed += 1;
        replyText = `[图片处理失败] ${err.message}`;
    }

    try {
        await sendReply(frame, streamId, replyText, runtimeConfig);
        stats.messagesProcessed += 1;
    } catch (err) {
        warn('推回企微失败:', err.message);
        setStatsError(err);
        stats.messagesFailed += 1;
    }
}

async function handleFileMessage(frame) {
    stats.messagesReceived += 1;
    stats.lastMessageAt = new Date().toISOString();

    const body = frame?.body || {};
    const userid = body?.from?.userid || '';
    const chatid = body?.chatid || '';
    const chattype = body?.chattype || 'single';
    const msgid = body?.msgid || '';
    const fileUrl = body?.file?.url;
    const fileAesKey = body?.file?.aeskey;

    debug(`收到文件消息 userid=${userid} chattype=${chattype} msgid=${msgid} url=${fileUrl ? '有' : '无'} aeskey=${fileAesKey ? '有' : '无'}`);

    const runtimeConfig = loadRuntimeConfig();
    if (!isUserAllowed(userid, runtimeConfig)) {
        debug(`用户 ${userid} 不在白名单，已忽略`);
        return;
    }

    const { generateReqId } = AiBot;
    const streamId = generateReqId('stream');

    await sendStreamHint(frame, streamId, runtimeConfig);

    let replyText;
    try {
        // 1. 下载并解密文件
        const { buffer, filename } = await downloadMedia(fileUrl, fileAesKey);
        debug(`文件下载完成 filename=${filename || '(无)'} size=${buffer.length} bytes`);

        // 2. 检查大小限制
        if (buffer.length > runtimeConfig.maxFileBytes) {
            throw new Error(`文件过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），上限 ${(runtimeConfig.maxFileBytes / 1024 / 1024).toFixed(0)}MB`);
        }

        // 3. 解析文件内容为文本
        let fileText;
        try {
            fileText = await withTimeout(
                parseFileToText(buffer, filename),
                runtimeConfig.fileParseTimeoutMs,
                'parseFileToText'
            );
        } catch (parseErr) {
            // 解析失败时，如果是图片扩展名，走图片路径
            const ext = path.extname(filename || '').toLowerCase().replace('.', '');
            if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
                debug('文件扩展名是图片，走图片处理路径');
                const dataUrl = bufferToDataUrl(buffer, filename);
                const prompt = [
                    { type: 'text', text: `[用户发送了一张图片文件: ${filename}]` },
                    { type: 'image_url', image_url: { url: dataUrl } }
                ];
                replyText = await callAgentForMessage({
                    prompt, userid, chatid, chattype, runtimeConfig
                });
                if (!replyText) replyText = '[agent 返回了空回复]';
                // 跳过后面的文本路径
                try {
                    await sendReply(frame, streamId, replyText, runtimeConfig);
                    stats.messagesProcessed += 1;
                } catch (err) {
                    warn('推回企微失败:', err.message);
                    setStatsError(err);
                    stats.messagesFailed += 1;
                }
                return;
            }
            throw parseErr;
        }

        debug(`文件解析完成 filename=${filename} textLen=${fileText.length}`);

        // 4. 构建文本 prompt
        replyText = await callAgentForMessage({
            prompt: fileText, userid, chatid, chattype, runtimeConfig
        });
        if (!replyText) replyText = '[agent 返回了空回复]';
    } catch (err) {
        warn('处理文件消息失败:', err.message);
        setStatsError(err);
        stats.messagesFailed += 1;
        replyText = `[文件处理失败] ${err.message}`;
    }

    try {
        await sendReply(frame, streamId, replyText, runtimeConfig);
        stats.messagesProcessed += 1;
    } catch (err) {
        warn('推回企微失败:', err.message);
        setStatsError(err);
        stats.messagesFailed += 1;
    }
}

async function handleVoiceMessage(frame) {
    stats.messagesReceived += 1;
    stats.lastMessageAt = new Date().toISOString();

    const body = frame?.body || {};
    const userid = body?.from?.userid || '';
    const chatid = body?.chatid || '';
    const chattype = body?.chattype || 'single';
    const msgid = body?.msgid || '';
    // SDK 已将语音转为文本
    const voiceText = body?.voice?.content || '';

    debug(`收到语音消息 userid=${userid} chattype=${chattype} msgid=${msgid} text=${JSON.stringify(voiceText).slice(0, 60)}`);

    const runtimeConfig = loadRuntimeConfig();
    if (!isUserAllowed(userid, runtimeConfig)) {
        debug(`用户 ${userid} 不在白名单，已忽略`);
        return;
    }

    const { generateReqId } = AiBot;
    const streamId = generateReqId('stream');

    await sendStreamHint(frame, streamId, runtimeConfig);

    let replyText;
    try {
        if (!voiceText.trim()) {
            throw new Error('语音消息未识别出文本内容');
        }
        replyText = await callAgentForMessage({
            prompt: `[用户发了一段语音，识别为:] ${voiceText}`,
            userid, chatid, chattype, runtimeConfig
        });
        if (!replyText) replyText = '[agent 返回了空回复]';
    } catch (err) {
        warn('处理语音消息失败:', err.message);
        setStatsError(err);
        stats.messagesFailed += 1;
        replyText = `[语音处理失败] ${err.message}`;
    }

    try {
        await sendReply(frame, streamId, replyText, runtimeConfig);
        stats.messagesProcessed += 1;
    } catch (err) {
        warn('推回企微失败:', err.message);
        setStatsError(err);
        stats.messagesFailed += 1;
    }
}

async function handleMixedMessage(frame) {
    stats.messagesReceived += 1;
    stats.lastMessageAt = new Date().toISOString();

    const body = frame?.body || {};
    const userid = body?.from?.userid || '';
    const chatid = body?.chatid || '';
    const chattype = body?.chattype || 'single';
    const msgid = body?.msgid || '';
    const msgItems = body?.mixed?.msg_item || [];

    debug(`收到图文混排消息 userid=${userid} chattype=${chattype} msgid=${msgid} items=${msgItems.length}`);

    const runtimeConfig = loadRuntimeConfig();
    if (!isUserAllowed(userid, runtimeConfig)) {
        debug(`用户 ${userid} 不在白名单，已忽略`);
        return;
    }

    const { generateReqId } = AiBot;
    const streamId = generateReqId('stream');

    await sendStreamHint(frame, streamId, runtimeConfig);

    let replyText;
    try {
        const promptParts = [];
        const textParts = [];

        for (const item of msgItems) {
            if (item.msgtype === 'text' && item.text?.content) {
                textParts.push(item.text.content);
            } else if (item.msgtype === 'image' && item.image?.url) {
                // 下载图片
                try {
                    const { buffer, filename } = await downloadMedia(item.image.url, item.image.aeskey);
                    if (buffer.length > runtimeConfig.maxImageBytes) {
                        textParts.push(`[图片过大已跳过: ${(buffer.length / 1024 / 1024).toFixed(1)}MB]`);
                        continue;
                    }
                    const dataUrl = bufferToDataUrl(buffer, filename);
                    // 先把已收集的文本作为一个 text part
                    if (textParts.length > 0) {
                        promptParts.push({ type: 'text', text: textParts.join('\n') });
                        textParts.length = 0;
                    }
                    promptParts.push({ type: 'image_url', image_url: { url: dataUrl } });
                } catch (imgErr) {
                    textParts.push(`[图片下载失败: ${imgErr.message}]`);
                }
            }
        }
        // 收尾的文本
        if (textParts.length > 0) {
            promptParts.push({ type: 'text', text: textParts.join('\n') });
        }

        if (promptParts.length === 0) {
            throw new Error('图文混排消息中没有有效内容');
        }

        // 如果只有文本没有图片，降级为字符串
        const prompt = promptParts.length === 1 && promptParts[0].type === 'text'
            ? promptParts[0].text
            : promptParts;

        replyText = await callAgentForMessage({
            prompt, userid, chatid, chattype, runtimeConfig
        });
        if (!replyText) replyText = '[agent 返回了空回复]';
    } catch (err) {
        warn('处理图文混排消息失败:', err.message);
        setStatsError(err);
        stats.messagesFailed += 1;
        replyText = `[图文混排处理失败] ${err.message}`;
    }

    try {
        await sendReply(frame, streamId, replyText, runtimeConfig);
        stats.messagesProcessed += 1;
    } catch (err) {
        warn('推回企微失败:', err.message);
        setStatsError(err);
        stats.messagesFailed += 1;
    }
}

async function handleUnsupportedMessage(frame, kind) {
    stats.messagesReceived += 1;
    stats.lastMessageAt = new Date().toISOString();
    const body = frame?.body || {};
    const userid = body?.from?.userid || '';
    debug(`收到${kind}消息 userid=${userid}（暂不支持）`);

    const runtimeConfig = loadRuntimeConfig();
    if (!isUserAllowed(userid, runtimeConfig)) return;

    try {
        await wsClient.reply(frame, {
            msgtype: 'text',
            text: { content: `暂不支持${kind}消息，请发送文本、图片或文件。` }
        });
    } catch (err) {
        warn(`回复${kind}不支持提示失败:`, err.message);
    }
}

async function handleEnterChat(frame) {
    const runtimeConfig = loadRuntimeConfig();
    if (!runtimeConfig.welcomeText) {
        debug('收到进入会话事件，未配置欢迎语，跳过');
        return;
    }
    const body = frame?.body || {};
    const userid = body?.from?.userid || '';
    if (!isUserAllowed(userid, runtimeConfig)) return;
    try {
        await wsClient.replyWelcome(frame, {
            msgtype: 'text',
            text: { content: runtimeConfig.welcomeText }
        });
        debug(`已发送欢迎语 userid=${userid}`);
    } catch (err) {
        warn('发送欢迎语失败:', err.message);
    }
}

// ============ WSClient 事件注册 ============

function registerWsEventHandlers() {
    if (!wsClient) return;

    wsClient.on('connected', () => {
        stats.connected = true;
        log('企微 WebSocket 连接已建立');
    });

    wsClient.on('authenticated', () => {
        stats.authenticated = true;
        log('企微 WebSocket 认证成功');
    });

    wsClient.on('disconnected', (reason) => {
        stats.connected = false;
        stats.authenticated = false;
        warn('企微 WebSocket 断开:', reason);
    });

    wsClient.on('reconnecting', (attempt) => {
        stats.lastReconnectAttempt = attempt;
        log(`企微 WebSocket 第 ${attempt} 次重连...`);
    });

    wsClient.on('error', (err) => {
        warn('企微 WebSocket 错误:', err?.message || err);
        setStatsError(err);
    });

    wsClient.on('message.text', (frame) => {
        handleTextMessage(frame).catch(e => warn('handleTextMessage 异常:', e.message));
    });

    wsClient.on('message.image', (frame) => {
        handleImageMessage(frame).catch(e => warn('handleImageMessage 异常:', e.message));
    });

    wsClient.on('message.file', (frame) => {
        handleFileMessage(frame).catch(e => warn('handleFileMessage 异常:', e.message));
    });

    wsClient.on('message.voice', (frame) => {
        handleVoiceMessage(frame).catch(e => warn('handleVoiceMessage 异常:', e.message));
    });

    wsClient.on('message.mixed', (frame) => {
        handleMixedMessage(frame).catch(e => warn('handleMixedMessage 异常:', e.message));
    });

    wsClient.on('message.video', (frame) => {
        handleUnsupportedMessage(frame, '视频').catch(() => {});
    });

    wsClient.on('event.enter_chat', (frame) => {
        handleEnterChat(frame).catch(() => {});
    });

    wsClient.on('event.template_card_event', (frame) => {
        debug('收到模板卡片事件（本期不处理）');
    });

    wsClient.on('event.feedback_event', (frame) => {
        debug('收到用户反馈事件（本期不处理）');
    });
}

// ============ VCP 插件接口 ============

async function initialize(initialConfig = {}, injectedDependencies = {}) {
    config = initialConfig || {};
    dependencies = injectedDependencies || {};
    debugMode = normalizeBoolean(config.DebugMode, false);

    stats.startedAt = new Date().toISOString();
    log('初始化中...');

    // 检查文件解析库可用性
    const parserStatus = [];
    if (pdfParseLib) parserStatus.push('pdf-parse');
    if (mammoth) parserStatus.push('mammoth');
    if (ExcelJS) parserStatus.push('exceljs');
    if (mimeTypes) parserStatus.push('mime-types');
    if (parserStatus.length > 0) {
        log(`文件解析库已加载: ${parserStatus.join(', ')}`);
    } else {
        warn('文件解析库均未加载，文件解析功能不可用（需 VCP 根 node_modules 提供）');
    }

    // 加载 SDK
    try {
        AiBot = require('@wecom/aibot-node-sdk');
    } catch (err) {
        warn('加载 @wecom/aibot-node-sdk 失败:', err.message);
        warn('请在插件目录运行 npm install');
        setStatsError(err);
        return;
    }

    const { generateReqId } = AiBot;
    if (typeof generateReqId !== 'function') {
        warn('SDK 未导出 generateReqId，可能版本不兼容');
    }

    const runtimeConfig = loadRuntimeConfig();

    // 校验必填项
    const missing = [];
    if (!runtimeConfig.botId) missing.push('WeComBotId');
    if (!runtimeConfig.botSecret) missing.push('WeComBotSecret');
    if (!runtimeConfig.bindAgent) missing.push('WeComBindAgent');
    if (missing.length > 0) {
        warn(`配置缺失: ${missing.join(', ')}，插件将以空跑模式启动（不建立 WS 连接）`);
        setStatsError(new Error(`配置缺失: ${missing.join(', ')}`));
        return;
    }

    log(`配置: bindAgent=${runtimeConfig.bindAgent} streamReply=${runtimeConfig.streamReply} ` +
        `allowedUsers=${runtimeConfig.allowedUsers.length || '无限制'} ` +
        `injectTools=${runtimeConfig.injectTools || '无'} ` +
        `agentTimeout=${runtimeConfig.agentTimeoutMs}ms ` +
        `maxImage=${(runtimeConfig.maxImageBytes / 1024 / 1024).toFixed(0)}MB ` +
        `maxFile=${(runtimeConfig.maxFileBytes / 1024 / 1024).toFixed(0)}MB`);

    // 创建 WSClient
    try {
        wsClient = new AiBot.WSClient({
            botId: runtimeConfig.botId,
            secret: runtimeConfig.botSecret,
            maxReconnectAttempts: runtimeConfig.maxReconnect,
            heartbeatInterval: runtimeConfig.heartbeatInterval,
            logger: {
                debug: (msg, ...args) => { if (debugMode) console.log('[VCPWeCom][sdk]', msg, ...args); },
                info: (msg, ...args) => console.log('[VCPWeCom][sdk]', msg, ...args),
                warn: (msg, ...args) => console.warn('[VCPWeCom][sdk]', msg, ...args),
                error: (msg, ...args) => console.error('[VCPWeCom][sdk]', msg, ...args)
            }
        });
    } catch (err) {
        warn('创建 WSClient 失败:', err.message);
        setStatsError(err);
        return;
    }

    registerWsEventHandlers();

    // 建立连接（SDK 自带认证/心跳/重连）
    try {
        wsClient.connect();
        log('WebSocket 连接已发起，等待认证...');
    } catch (err) {
        warn('WebSocket 连接发起失败:', err.message);
        setStatsError(err);
    }
}

function shutdown() {
    log('关闭中...');
    try {
        if (wsClient && typeof wsClient.disconnect === 'function') {
            wsClient.disconnect();
        }
    } catch (err) {
        warn('disconnect 异常:', err.message);
    }
    wsClient = null;
    stats.connected = false;
    stats.authenticated = false;
}

async function processToolCall(args = {}) {
    const command = String(args.command || args.cmd || '').trim();

    if (command === 'WeComSend' || args.target !== undefined) {
        const target = String(args.target || '').trim();
        const content = String(args.content || args.message || '').trim();
        if (!target) throw new Error('WeComSend 缺少 target 参数（userid 或 chatid）');
        if (!content) throw new Error('WeComSend 缺少 content 参数');
        if (!wsClient || !stats.connected) {
            throw new Error('企微 WebSocket 未连接，无法发送消息');
        }
        await wsClient.sendMessage(target, {
            msgtype: 'markdown',
            markdown: { content }
        });
        return {
            content: [{
                type: 'text',
                text: `已向 ${target} 推送企微消息（${content.length} 字）。`
            }]
        };
    }

    if (command === 'status' || command === 'Status') {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(getStatus(), null, 2)
            }]
        };
    }

    throw new Error(`VCPWeCom 未知 command: ${command || '(空)'}`);
}

function getStatus() {
    return {
        ...stats,
        connected: stats.connected,
        authenticated: stats.authenticated,
        agentAssistantLoaded: !!_agentAssistantModule,
        agentAssistantLoadedAt: _agentAssistantRequiredAt ? new Date(_agentAssistantRequiredAt).toISOString() : null,
        fileParsers: {
            pdfParse: !!pdfParseLib,
            mammoth: !!mammoth,
            exceljs: !!ExcelJS,
            mimeTypes: !!mimeTypes
        },
        runtimeConfigSummary: (() => {
            const rc = loadRuntimeConfig();
            return {
                bindAgent: rc.bindAgent,
                streamReply: rc.streamReply,
                allowedUsersCount: rc.allowedUsers.length,
                injectTools: rc.injectTools || '(none)',
                agentTimeoutMs: rc.agentTimeoutMs,
                maxImageMB: (rc.maxImageBytes / 1024 / 1024).toFixed(0),
                maxFileMB: (rc.maxFileBytes / 1024 / 1024).toFixed(0)
            };
        })()
    };
}

// ============ 模块导出 ============

module.exports = {
    initialize,
    shutdown,
    processToolCall,
    getStatus
};
