// server.js
const express = require('express');
const dotenv = require('dotenv');
dotenv.config({ path: 'config.env' });
const schedule = require('node-schedule');
const lunarCalendar = require('chinese-lunar-calendar');
const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);
dayjs.extend(timezone);

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';
const fs = require('fs').promises; // fs.promises for async operations
const path = require('path');
const { Writable } = require('stream');
const fsSync = require('fs'); // Renamed to fsSync for clarity with fs.promises

// 🌟 核心修复：彻底解放 Node.js 默认的全局连接池限制，防止底层网络排队导致 AdminPanel 死锁
const http = require('http');
const https = require('https');
http.globalAgent.maxSockets = 10000;
https.globalAgent.maxSockets = 10000;

// 初始化日志记录器
const logger = require('./modules/logger.js');
logger.initializeServerLogger();
logger.overrideConsole();

// Agent 目录路径初始化（同步，在模块加载时解析）
let AGENT_DIR;

function resolveAgentDir() {
    const configPath = process.env.AGENT_DIR_PATH;

    if (!configPath || typeof configPath !== 'string' || configPath.trim() === '') {
        return path.join(__dirname, 'Agent');
    }

    const normalizedPath = path.normalize(configPath.trim());
    const absolutePath = path.isAbsolute(normalizedPath)
        ? normalizedPath
        : path.resolve(__dirname, normalizedPath);

    return absolutePath;
}

AGENT_DIR = resolveAgentDir();

// 确保目录存在（异步，在服务器启动时调用）
async function ensureAgentDirectory() {
    try {
        await fs.mkdir(AGENT_DIR, { recursive: true });
        console.log(`[Server] Agent directory: ${AGENT_DIR}`);
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.error(`[Server] Failed to create Agent directory: ${AGENT_DIR}`);

            if (error.code === 'EACCES' || error.code === 'EPERM') {
                console.error('[Server] Error: Permission denied');
            } else if (error.code === 'ENOENT') {
                console.error('[Server] Error: Parent directory does not exist');
            } else if (error.code === 'ENOSPC') {
                console.error('[Server] Error: No space left on device');
            } else if (error.code === 'ENAMETOOLONG') {
                console.error('[Server] Error: Path is too long');
            }

            process.exit(1);
        }
    }
}
let TVS_DIR;

function resolveTvsDir() {
    const configPath = process.env.TVS_DIR_PATH;
    if (!configPath || typeof configPath !== 'string' || configPath.trim() === '') {
        return path.join(__dirname, 'TVStxt');
    }

    const normalizedPath = path.normalize(configPath.trim());
    return path.isAbsolute(normalizedPath)
        ? normalizedPath
        : path.resolve(__dirname, normalizedPath);
}

TVS_DIR = resolveTvsDir();

async function ensureTvsDirectory() {
    try {
        await fs.mkdir(TVS_DIR, { recursive: true });
        console.log(`[Server] TVS directory: ${TVS_DIR}`);
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.error(`[Server] Failed to create TVS directory: ${TVS_DIR}`);
            console.error(error);
            process.exit(1);
        }
    }
}

const crypto = require('crypto');
const agentManager = require('./modules/agentManager.js'); // 新增：Agent管理器
const tvsManager = require('./modules/tvsManager.js'); // 新增：TVS管理器
const messageProcessor = require('./modules/messageProcessor.js');
const mediaSidecarManager = require('./modules/mediaSidecarManager.js');
const knowledgeBaseManager = require('./KnowledgeBaseManager.js'); // 新增：引入统一知识库管理器
const pluginManager = require('./Plugin.js');
const taskScheduler = require('./routes/taskScheduler.js');
const webSocketServer = require('./WebSocketServer.js'); // 新增 WebSocketServer 引入
const FileFetcherServer = require('./FileFetcherServer.js'); // 引入新的 FileFetcherServer 模块
const vcpInfoHandler = require('./vcpInfoHandler.js'); // 引入新的 VCP 信息处理器
const basicAuth = require('basic-auth');
const cors = require('cors'); // 引入 cors 模块

const BLACKLIST_FILE = path.join(__dirname, 'ip_blacklist.json');
const MAX_API_ERRORS = 5;
let ipBlacklist = [];
const apiErrorCounts = new Map();

const loginAttempts = new Map();
const tempBlocks = new Map();
const MAX_LOGIN_ATTEMPTS = 5; // 15分钟内最多尝试5次
const LOGIN_ATTEMPT_WINDOW = 15 * 60 * 1000; // 15分钟的窗口
const TEMP_BLOCK_DURATION = 30 * 60 * 1000; // 封禁30分钟

const ChatCompletionHandler = require('./modules/chatCompletionHandler.js');

const activeRequests = new Map(); // 新增：用于存储活动中的请求，以便中止

// 新增：定时清理 activeRequests 防止内存泄漏
setInterval(() => {
    const now = Date.now();
    for (const [id, context] of activeRequests.entries()) {
        // 30分钟超时
        if (now - (context.timestamp || 0) > 30 * 60 * 1000) {
            console.log(`[Request Cleanup] Aborting and removing timed-out request: ${id}`);
            if (context.abortController) {
                context.abortController.abort();
            }
            activeRequests.delete(id);
        }
    }
}, 60 * 1000); // 每分钟检查一次

const ADMIN_USERNAME = process.env.AdminUsername;
const ADMIN_PASSWORD = process.env.AdminPassword;

const DEBUG_MODE = (process.env.DebugMode || "False").toLowerCase() === "true";
const VCPToolCode = (process.env.VCPToolCode || "false").toLowerCase() === "true"; // 新增：读取VCP工具调用验证码开关
const SHOW_VCP_OUTPUT = (process.env.ShowVCP || "False").toLowerCase() === "true"; // 读取 ShowVCP 环境变量
const RAG_MEMO_REFRESH = (process.env.RAGMemoRefresh || "false").toLowerCase() === "true"; // 新增：RAG日记刷新开关
const ENABLE_ROLE_DIVIDER = (process.env.EnableRoleDivider || "false").toLowerCase() === "true"; // 新增：角色分割开关
const ENABLE_ROLE_DIVIDER_IN_LOOP = (process.env.EnableRoleDividerInLoop || "false").toLowerCase() === "true"; // 新增：循环栈角色分割开关
const ROLE_DIVIDER_SYSTEM = (process.env.RoleDividerSystem || "true").toLowerCase() === "true"; // 新增：System角色分割开关
const ROLE_DIVIDER_ASSISTANT = (process.env.RoleDividerAssistant || "true").toLowerCase() === "true"; // 新增：Assistant角色分割开关
const ROLE_DIVIDER_USER = (process.env.RoleDividerUser || "true").toLowerCase() === "true"; // 新增：User角色分割开关
const ROLE_DIVIDER_SCAN_SYSTEM = (process.env.RoleDividerScanSystem || "true").toLowerCase() === "true"; // 新增：System角色扫描开关
const ROLE_DIVIDER_SCAN_ASSISTANT = (process.env.RoleDividerScanAssistant || "true").toLowerCase() === "true"; // 新增：Assistant角色扫描开关
const ROLE_DIVIDER_SCAN_USER = (process.env.RoleDividerScanUser || "true").toLowerCase() === "true"; // 新增：User角色扫描开关
const ROLE_DIVIDER_REMOVE_DISABLED_TAGS = (process.env.RoleDividerRemoveDisabledTags || "true").toLowerCase() === "true"; // 新增：禁用标签清除开关

let ROLE_DIVIDER_IGNORE_LIST = [];
try {
    ROLE_DIVIDER_IGNORE_LIST = JSON.parse(process.env.RoleDividerIgnoreList || "[]");
} catch (e) {
    console.error("Failed to parse RoleDividerIgnoreList:", e);
}

// 新增：国产A类模型推理功能配置
let CHINA_MODEL_1 = [];
try {
    CHINA_MODEL_1 = (process.env.ChinaModel1 || "").split(',').map(m => m.trim()).filter(m => m !== "");
} catch (e) {
    console.error("Failed to parse ChinaModel1:", e);
}
const CHINA_MODEL_1_COT = (process.env.ChinaModel1Cot || "false").toLowerCase() === "true";

// 新增：模型重定向功能
const ModelRedirectHandler = require('./modelRedirectHandler.js');
const modelRedirectHandler = new ModelRedirectHandler();

// ensureDebugLogDir is now ensureDebugLogDirSync and called by initializeServerLogger
// writeDebugLog remains for specific debug purposes, it uses fs.promises.
// 优化：Debug 日志按天归档到 archive/YYYY-MM-DD/Debug/ 目录
async function writeDebugLog(filenamePrefix, data) {
    if (DEBUG_MODE) {
        const DEBUG_LOG_DIR = path.join(__dirname, 'DebugLog');
        const now = dayjs().tz(DEFAULT_TIMEZONE);
        const dateStr = now.format('YYYY-MM-DD');
        const timestamp = now.format('HHmmss_SSS');

        // 归档目录：DebugLog/archive/YYYY-MM-DD/Debug/
        const archiveDir = path.join(DEBUG_LOG_DIR, 'archive', dateStr, 'Debug');

        try {
            await fs.mkdir(archiveDir, { recursive: true });
        } catch (error) {
            console.error(`创建 Debug 归档目录失败: ${archiveDir}`, error);
        }

        const filename = `${filenamePrefix}-${timestamp}.txt`;
        const filePath = path.join(archiveDir, filename);
        try {
            await fs.writeFile(filePath, JSON.stringify(data, null, 2));
            console.log(`[DebugLog] 已记录日志: archive/${dateStr}/Debug/${filename}`);
        } catch (error) {
            console.error(`写入调试日志失败: ${filePath}`, error);
        }
    }
}

// 新增：加载IP黑名单
async function loadBlacklist() {
    try {
        await fs.access(BLACKLIST_FILE);
        const data = await fs.readFile(BLACKLIST_FILE, 'utf8');
        ipBlacklist = JSON.parse(data);
        console.log(`[Security] IP黑名单加载成功，共 ${ipBlacklist.length} 个条目。`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('[Security] 未找到IP黑名单文件，将创建一个新的。');
            await saveBlacklist(); // 创建一个空的黑名单文件
        } else {
            console.error('[Security] 加载IP黑名单失败:', error);
        }
    }
}

// 新增：保存IP黑名单
async function saveBlacklist() {
    try {
        await fs.writeFile(BLACKLIST_FILE, JSON.stringify(ipBlacklist, null, 2));
    } catch (error) {
        console.error('[Security] 保存IP黑名单失败:', error);
    }
}

const detectors = [];
for (const key in process.env) {
    if (/^Detector\d+$/.test(key)) {
        const index = key.substring(8);
        const outputKey = `Detector_Output${index}`;
        if (process.env[outputKey]) {
            detectors.push({ detector: process.env[key], output: process.env[outputKey] });
        }
    }
}
if (detectors.length > 0) console.log(`共加载了 ${detectors.length} 条系统提示词转换规则。`);
else console.log('未加载任何系统提示词转换规则。');

const superDetectors = [];
for (const key in process.env) {
    if (/^SuperDetector\d+$/.test(key)) {
        const index = key.substring(13);
        const outputKey = `SuperDetector_Output${index}`;
        if (process.env[outputKey]) {
            superDetectors.push({ detector: process.env[key], output: process.env[outputKey] });
        }
    }
}
if (superDetectors.length > 0) console.log(`共加载了 ${superDetectors.length} 条全局上下文转换规则。`);
else console.log('未加载任何全局上下文转换规则。');


const app = express();
app.set('trust proxy', true); // 新增：信任代理，以便正确解析 X-Forwarded-For 头，解决本地IP识别为127.0.0.1的问题
app.use(cors({ origin: '*' })); // 启用 CORS，允许所有来源的跨域请求，方便本地文件调试

// 在路由决策之前解析请求体，以便 req.body 可用
app.use(express.json({ limit: '300mb' }));
app.use(express.urlencoded({ limit: '300mb', extended: true }));
app.use(express.text({ limit: '300mb', type: 'text/plain' })); // 新增：用于处理纯文本请求体

// 新增：IP追踪中间件
app.use((req, res, next) => {
    if (req.method === 'POST') {
        let clientIp = req.ip;
        // 标准化IPv6映射的IPv4地址 (e.g., from '::ffff:127.0.0.1' to '127.0.0.1')
        if (clientIp && clientIp.substr(0, 7) === "::ffff:") {
            clientIp = clientIp.substr(7);
        }

        // 始终记录收到的POST请求IP
        console.log(`[IP Tracker] Received POST request from IP: ${clientIp}`);

        const serverName = webSocketServer.findServerByIp(clientIp);
        if (serverName) {
            console.log(`[IP Tracker] SUCCESS: Post request is from known Distributed Server: '${serverName}' (IP: ${clientIp})`);
        }
    }
    next();
});

// 新增：处理API错误并更新IP计数
function handleApiError(req) {
    let clientIp = req.ip;
    if (clientIp && clientIp.substr(0, 7) === "::ffff:") {
        clientIp = clientIp.substr(7);
    }

    // Don't blacklist the server itself.
    if (clientIp === '127.0.0.1' || clientIp === '::1') {
        console.log(`[Security] Ignored an API error from the local server itself (IP: ${clientIp}). This is to prevent self-blocking.`);
        return;
    }

    if (!clientIp || ipBlacklist.includes(clientIp)) {
        return; // 如果IP无效或已在黑名单中，则不处理
    }

    const currentErrors = (apiErrorCounts.get(clientIp) || 0) + 1;
    apiErrorCounts.set(clientIp, currentErrors);
    console.log(`[Security] IP ${clientIp} 出现API错误，当前计次: ${currentErrors}/${MAX_API_ERRORS}`);

    if (currentErrors >= MAX_API_ERRORS) {
        if (!ipBlacklist.includes(clientIp)) {
            ipBlacklist.push(clientIp);
            console.log(`[Security] IP ${clientIp} 已达到错误上限，已加入黑名单。`);
            saveBlacklist(); // 异步保存，不阻塞当前请求
            apiErrorCounts.delete(clientIp); // 从计数器中移除
        }
    }
}

// 新增：IP黑名单中间件
app.use((req, res, next) => {
    let clientIp = req.ip;
    if (clientIp && clientIp.substr(0, 7) === "::ffff:") {
        clientIp = clientIp.substr(7);
    }

    if (clientIp && ipBlacklist.includes(clientIp)) {
        console.warn(`[Security] 已阻止来自黑名单IP ${clientIp} 的请求。`);
        return res.status(403).json({ error: 'Forbidden: Your IP address has been blocked due to suspicious activity.' });
    }
    next();
});

// 引入并使用特殊模型路由
const specialModelRouter = require('./routes/specialModelRouter');
app.use(specialModelRouter); // 这个将处理所有白名单模型的请求

const port = process.env.PORT;
const apiKey = process.env.API_Key;
const apiUrl = process.env.API_URL;
const serverKey = process.env.Key;

const cachedEmojiLists = new Map();

// Authentication middleware for Admin Panel and Admin API
const adminAuth = (req, res, next) => {
    // This middleware protects both the Admin Panel static files and its API endpoints.
    const isAdminPath = req.path.startsWith('/admin_api') || req.path.startsWith('/AdminPanel');

    if (isAdminPath) {
        // ========== 新增：允许登录页面和相关资源无需认证 ==========
        const publicPaths = [
            '/AdminPanel/login.html',
            '/AdminPanel/VCPLogo2.png',
            '/AdminPanel/favicon.ico',
            '/AdminPanel/style.css',
            '/AdminPanel/woff.css',
            '/AdminPanel/font.woff2'
        ];

        // 验证登录的端点也需要特殊处理（允许无凭据时返回401而不是重定向）
        const isVerifyEndpoint = req.path === '/admin_api/verify-login';

        if (publicPaths.includes(req.path)) {
            return next(); // 直接放行登录页面相关资源
        }
        // ========== 新增结束 ==========

        let clientIp = req.ip;
        if (clientIp && clientIp.substr(0, 7) === "::ffff:") {
            clientIp = clientIp.substr(7);
        }

        // 1. 检查管理员凭据是否已配置 (这是最高优先级的安全检查)
        if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
            console.error('[AdminAuth] AdminUsername or AdminPassword not set in config.env. Admin panel is disabled.');
            // 对API和页面请求返回不同的错误格式
            if (req.path.startsWith('/admin_api') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
                res.status(503).json({
                    error: 'Service Unavailable: Admin credentials not configured.',
                    message: 'Please set AdminUsername and AdminPassword in the config.env file to enable the admin panel.'
                });
            } else {
                res.status(503).send('<h1>503 Service Unavailable</h1><p>Admin credentials (AdminUsername, AdminPassword) are not configured in config.env. Please configure them to enable the admin panel.</p>');
            }
            return; // 停止进一步处理
        }

        // 2. 检查IP是否被临时封禁
        const blockInfo = tempBlocks.get(clientIp);
        if (blockInfo && Date.now() < blockInfo.expires) {
            console.warn(`[AdminAuth] Blocked login attempt from IP: ${clientIp}. Block expires at ${new Date(blockInfo.expires).toLocaleString()}.`);
            const timeLeft = Math.ceil((blockInfo.expires - Date.now()) / 1000 / 60);
            res.setHeader('Retry-After', Math.ceil((blockInfo.expires - Date.now()) / 1000)); // In seconds
            return res.status(429).json({
                error: 'Too Many Requests',
                message: `由于登录失败次数过多，您的IP已被暂时封禁。请在 ${timeLeft} 分钟后重试。`
            });
        }

        // 3. 尝试获取凭据（优先 Header，其次 Cookie）
        let credentials = basicAuth(req);

        // 如果 Header 中没有凭据，尝试从 Cookie 中读取
        if (!credentials && req.headers.cookie) {
            const cookies = req.headers.cookie.split(';').reduce((acc, cookie) => {
                const [key, value] = cookie.trim().split('=');
                acc[key] = value;
                return acc;
            }, {});

            if (cookies.admin_auth) {
                try {
                    // Cookie 存储的是 "Basic xxxx" 格式
                    const authValue = decodeURIComponent(cookies.admin_auth);
                    if (authValue.startsWith('Basic ')) {
                        const base64Credentials = authValue.substring(6);
                        const decodedCredentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
                        const [name, pass] = decodedCredentials.split(':');
                        if (name && pass) {
                            credentials = { name, pass };
                        }
                    }
                } catch (e) {
                    console.warn('[AdminAuth] Failed to parse auth cookie:', e.message);
                }
            }
        }

        // 4. 验证凭据
        if (!credentials || credentials.name !== ADMIN_USERNAME || credentials.pass !== ADMIN_PASSWORD) {
            // 认证失败，处理登录尝试计数
            if (clientIp) {
                const now = Date.now();
                let attemptInfo = loginAttempts.get(clientIp) || { count: 0, firstAttempt: now };

                // 如果时间窗口已过，则重置计数
                if (now - attemptInfo.firstAttempt > LOGIN_ATTEMPT_WINDOW) {
                    attemptInfo = { count: 0, firstAttempt: now };
                }

                attemptInfo.count++;
                console.log(`[AdminAuth] Failed login attempt from IP: ${clientIp}. Count: ${attemptInfo.count}/${MAX_LOGIN_ATTEMPTS}`);

                if (attemptInfo.count >= MAX_LOGIN_ATTEMPTS) {
                    console.warn(`[AdminAuth] IP ${clientIp} has been temporarily blocked for ${TEMP_BLOCK_DURATION / 60000} minutes due to excessive failed login attempts.`);
                    tempBlocks.set(clientIp, { expires: now + TEMP_BLOCK_DURATION });
                    loginAttempts.delete(clientIp); // 封禁后清除尝试记录
                } else {
                    loginAttempts.set(clientIp, attemptInfo);
                }
            }

            // ========== 修改：根据请求类型决定响应方式 ==========
            // API 请求或验证端点：返回 401 JSON
            if (isVerifyEndpoint || req.path.startsWith('/admin_api') ||
                (req.headers.accept && req.headers.accept.includes('application/json'))) {
                // 不设置 WWW-Authenticate 头，避免触发浏览器弹窗
                return res.status(401).json({ error: 'Unauthorized' });
            }
            // AdminPanel 页面请求：重定向到登录页面
            else if (req.path.startsWith('/AdminPanel')) {
                return res.redirect('/AdminPanel/login.html');
            }
            // 其他情况
            else {
                res.setHeader('WWW-Authenticate', 'Basic realm="Admin Panel"');
                return res.status(401).send('<h1>401 Unauthorized</h1><p>Authentication required to access the Admin Panel.</p>');
            }
            // ========== 修改结束 ==========
        }

        // 4. 认证成功
        if (clientIp) {
            loginAttempts.delete(clientIp); // 成功后清除尝试记录
        }
        return next();
    }

    // 非管理面板路径，继续
    return next();
};
// Apply admin authentication to all /AdminPanel and /admin_api routes.
// This MUST come before serving static files to protect the panel itself.
app.use(adminAuth);

// Serve Admin Panel static files only after successful authentication.
app.use('/AdminPanel', express.static(path.join(__dirname, 'AdminPanel')));


// Image server logic is now handled by the ImageServer plugin.


// General API authentication (Bearer token) - This was the original one, now adminAuth handles its paths
app.use((req, res, next) => {
    // Skip bearer token check for admin panel API and static files, as they use basic auth or no auth
    if (req.path.startsWith('/admin_api') || req.path.startsWith('/AdminPanel')) {
        return next();
    }

    const imageServicePathRegex = /^\/pw=[^/]+\/images\//;
    if (imageServicePathRegex.test(req.path)) {
        return next();
    }

    // Add a similar check for the FileServer plugin path
    const fileServicePathRegex = /^\/pw=[^/]+\/files\//;
    if (fileServicePathRegex.test(req.path)) {
        return next();
    }

    // Skip bearer token check for plugin callbacks
    if (req.path.startsWith('/plugin-callback')) {
        return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${serverKey}`) {
        return res.status(401).json({ error: 'Unauthorized (Bearer token required)' });
    }
    next();
});

// This function is no longer needed as the EmojiListGenerator plugin handles generation.
// async function updateAndLoadAgentEmojiList(agentName, dirPath, filePath) { ... }



app.get('/v1/models', async (req, res) => {
    const { default: fetch } = await import('node-fetch');
    try {
        const modelsApiUrl = `${apiUrl}/v1/models`;
        const apiResponse = await fetch(modelsApiUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
                'Accept': req.headers['accept'] || 'application/json',
            },
        });

        // 新增：如果启用了模型重定向，需要处理模型列表响应
        if (modelRedirectHandler.isEnabled() && apiResponse.ok) {
            const responseText = await apiResponse.text();
            try {
                const modelsData = JSON.parse(responseText);

                // 替换模型列表中的内部模型名为公开模型名
                if (modelsData.data && Array.isArray(modelsData.data)) {
                    modelsData.data = modelsData.data.map(model => {
                        if (model.id) {
                            const publicModelName = modelRedirectHandler.redirectModelForClient(model.id);
                            if (publicModelName !== model.id) {
                                if (DEBUG_MODE) {
                                    console.log(`[ModelRedirect] 模型列表重定向: ${model.id} -> ${publicModelName}`);
                                }
                                return { ...model, id: publicModelName };
                            }
                        }
                        return model;
                    });
                }

                // 设置响应头
                res.status(apiResponse.status);
                apiResponse.headers.forEach((value, name) => {
                    if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length', 'keep-alive'].includes(name.toLowerCase())) {
                        res.setHeader(name, value);
                    }
                });

                // 发送修改后的响应
                res.json(modelsData);
                return;
            } catch (parseError) {
                console.warn('[ModelRedirect] 解析模型列表响应失败，使用原始响应:', parseError.message);
                // 如果解析失败，回退到原始流式转发
            }
        }

        // 原始的流式转发逻辑（当模型重定向未启用或解析失败时使用）
        res.status(apiResponse.status);
        apiResponse.headers.forEach((value, name) => {
            // Avoid forwarding hop-by-hop headers
            if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length', 'keep-alive'].includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

        // Stream the response body back to the client
        apiResponse.body.pipe(res);

    } catch (error) {
        console.error('转发 /v1/models 请求时出错:', error.message, error.stack);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error', details: error.message });
        } else if (!res.writableEnded) {
            console.error('[STREAM ERROR] Headers already sent. Cannot send JSON error. Ending stream if not already ended.');
            res.end();
        }
    }
});
// 新增：标准化任务创建API端点
const VCP_TIMED_CONTACTS_DIR = path.join(__dirname, 'VCPTimedContacts');

// 辅助函数：将 Date 对象格式化为包含时区偏移的本地时间字符串 (e.g., 2025-06-29T15:00:00+08:00)
function formatToLocalDateTimeWithOffset(date) {
    // 使用 dayjs 在配置的时区中解析 Date 对象，并格式化为 ISO 8601 扩展格式
    // 'YYYY-MM-DDTHH:mm:ssZ' 格式会包含时区偏移
    return dayjs(date).tz(DEFAULT_TIMEZONE).format('YYYY-MM-DDTHH:mm:ssZ');
}

app.post('/v1/schedule_task', async (req, res) => {
    // 这是一个内部端点，由插件调用以创建定时任务。
    // 它依赖于全局的 Bearer token 认证。
    const { schedule_time, task_id, tool_call } = req.body;

    if (!schedule_time || !task_id || !tool_call || !tool_call.tool_name || !tool_call.arguments) {
        return res.status(400).json({ status: "error", error: "请求无效，缺少 'schedule_time', 'task_id', 或有效的 'tool_call' 对象。" });
    }

    const targetDate = new Date(schedule_time);
    if (isNaN(targetDate.getTime())) {
        return res.status(400).json({ status: "error", error: "无效的 'schedule_time' 时间格式。" });
    }
    if (targetDate.getTime() <= Date.now()) {
        return res.status(400).json({ status: "error", error: "schedule_time 不能是过去的时间。" });
    }

    try {
        // 确保目录存在
        await fs.mkdir(VCP_TIMED_CONTACTS_DIR, { recursive: true });

        const taskFilePath = path.join(VCP_TIMED_CONTACTS_DIR, `${task_id}.json`);

        const scheduledTimeWithOffset = formatToLocalDateTimeWithOffset(targetDate);

        const taskData = {
            taskId: task_id,
            scheduledLocalTime: scheduledTimeWithOffset, // 使用带时区偏移的本地时间格式
            tool_call: tool_call, // 存储完整的 VCP Tool Call
            requestor: `Plugin: ${tool_call.tool_name}`,
        };

        await fs.writeFile(taskFilePath, JSON.stringify(taskData, null, 2));
        if (DEBUG_MODE) console.log(`[Server] 已通过API创建新的定时任务文件: ${taskFilePath}`);

        // 返回成功的响应，插件可以基于此生成最终的用户回执
        res.status(200).json({
            status: "success",
            message: "任务已成功调度。",
            details: {
                taskId: task_id,
                scheduledTime: scheduledTimeWithOffset
            }
        });

    } catch (error) {
        console.error(`[Server] 通过API创建定时任务文件时出错:`, error);
        res.status(500).json({ status: "error", error: "在服务器上保存定时任务时发生内部错误。" });
    }
});

// 新增：紧急停止路由
app.post('/v1/interrupt', (req, res) => {
    const id = req.body.requestId || req.body.messageId; // 兼容 requestId 和 messageId
    if (!id) {
        return res.status(400).json({ error: 'requestId or messageId is required.' });
    }

    const context = activeRequests.get(id);
    if (context) {
        console.log(`[Interrupt] Received stop signal for ID: ${id}`);

        // 修复 Bug #1, #2, #3: 先设置中止标志，再触发 abort，最后才尝试写入
        // 1. 设置中止标志，防止 chatCompletionHandler 继续写入
        if (!context.aborted) {
            context.aborted = true; // 标记为已中止

            // 2. 立即触发 abort 信号（中断正在进行的 fetch 请求）
            if (context.abortController && !context.abortController.signal.aborted) {
                context.abortController.abort();
                console.log(`[Interrupt] AbortController.abort() called for ID: ${id}`);
            }

            // 3. 等待一小段时间让 abort 传播（避免竞态条件）
            setImmediate(() => {
                // 4. 现在安全地尝试关闭响应流（如果还未关闭）
                if (context.res && !context.res.writableEnded && !context.res.destroyed) {
                    try {
                        // 检查响应头是否已发送，决定如何关闭
                        if (!context.res.headersSent) {
                            // 修复竞态条件Bug: 根据原始请求的stream属性判断响应类型
                            const isStreamRequest = context.req?.body?.stream === true;

                            if (isStreamRequest) {
                                // 流式请求：发送SSE格式的中止信号
                                console.log(`[Interrupt] Sending SSE abort signal for stream request ${id}`);
                                context.res.status(200);
                                context.res.setHeader('Content-Type', 'text/event-stream');
                                context.res.setHeader('Cache-Control', 'no-cache');
                                context.res.setHeader('Connection', 'keep-alive');

                                const abortChunk = {
                                    id: `chatcmpl-interrupt-${Date.now()}`,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model: context.req?.body?.model || 'unknown',
                                    choices: [{
                                        index: 0,
                                        delta: { content: '请求已被用户中止' },
                                        finish_reason: 'stop'
                                    }]
                                };
                                context.res.write(`data: ${JSON.stringify(abortChunk)}\n\n`);
                                context.res.write('data: [DONE]\n\n');
                                context.res.end();
                            } else {
                                // 非流式请求：发送标准JSON响应
                                console.log(`[Interrupt] Sending JSON abort response for non-stream request ${id}`);
                                context.res.status(200).json({
                                    choices: [{
                                        index: 0,
                                        message: { role: 'assistant', content: '请求已被用户中止' },
                                        finish_reason: 'stop'
                                    }]
                                });
                            }
                        } else if (context.res.getHeader('Content-Type')?.includes('text/event-stream')) {
                            // 是流式响应，发送 [DONE] 信号并关闭
                            context.res.write('data: [DONE]\n\n');
                            context.res.end();
                            console.log(`[Interrupt] Sent [DONE] signal and closed stream for ID: ${id}`);
                        } else {
                            // 其他情况，直接结束响应
                            context.res.end();
                            console.log(`[Interrupt] Ended response for ID: ${id}`);
                        }
                    } catch (e) {
                        console.error(`[Interrupt] Error closing response for ${id}:`, e.message);
                        // 即使写入失败也不要崩溃，只记录错误
                        // 尝试强制关闭连接以防止挂起
                        try {
                            if (context.res && !context.res.destroyed) {
                                context.res.destroy();
                                console.log(`[Interrupt] Forcefully destroyed response for ${id}`);
                            }
                        } catch (destroyError) {
                            console.error(`[Interrupt] Error destroying response for ${id}:`, destroyError.message);
                        }
                    }
                } else {
                    console.log(`[Interrupt] Response for ${id} already closed or destroyed.`);
                }
            });
        } else {
            console.log(`[Interrupt] Request ${id} already aborted, skipping duplicate abort.`);
        }

        // 最后从 activeRequests 中移除，防止内存泄漏
        setTimeout(() => {
            if (activeRequests.has(id)) {
                activeRequests.delete(id);
                console.log(`[Interrupt] Cleaned up request ${id} from activeRequests`);
            }
        }, 1000); // 延迟1秒删除，确保所有异步操作完成

        // 向中断请求的发起者返回成功响应
        res.status(200).json({ status: 'success', message: `Interrupt signal sent for request ${id}.` });
    } else {
        console.log(`[Interrupt] Received stop signal for non-existent or completed ID: ${id}`);
        res.status(404).json({ status: 'error', message: `Request ${id} not found or already completed.` });
    }
});



const chatCompletionHandler = new ChatCompletionHandler({
    apiUrl,
    apiKey,
    modelRedirectHandler,
    pluginManager,
    activeRequests,
    writeDebugLog,
    handleDiaryFromAIResponse,
    webSocketServer,
    DEBUG_MODE,
    SHOW_VCP_OUTPUT,
    VCPToolCode, // 新增：传递VCP工具调用验证码开关
    RAGMemoRefresh: RAG_MEMO_REFRESH, // 新增：传递RAG日记刷新开关
    enableRoleDivider: ENABLE_ROLE_DIVIDER, // 新增：传递角色分割开关
    enableRoleDividerInLoop: ENABLE_ROLE_DIVIDER_IN_LOOP, // 新增：传递循环栈角色分割开关
    roleDividerIgnoreList: ROLE_DIVIDER_IGNORE_LIST, // 新增：传递角色分割忽略列表
    roleDividerSwitches: {
        system: ROLE_DIVIDER_SYSTEM,
        assistant: ROLE_DIVIDER_ASSISTANT,
        user: ROLE_DIVIDER_USER
    },
    roleDividerScanSwitches: {
        system: ROLE_DIVIDER_SCAN_SYSTEM,
        assistant: ROLE_DIVIDER_SCAN_ASSISTANT,
        user: ROLE_DIVIDER_SCAN_USER
    },
    roleDividerRemoveDisabledTags: ROLE_DIVIDER_REMOVE_DISABLED_TAGS,
    maxVCPLoopStream: parseInt(process.env.MaxVCPLoopStream),
    maxVCPLoopNonStream: parseInt(process.env.MaxVCPLoopNonStream),
    apiRetries: parseInt(process.env.ApiRetries) || 3, // 新增：API重试次数
    apiRetryDelay: parseInt(process.env.ApiRetryDelay) || 1000, // 新增：API重试延迟
    cachedEmojiLists,
    detectors,
    superDetectors,
    chinaModel1: CHINA_MODEL_1,
    chinaModel1Cot: CHINA_MODEL_1_COT
});

// Route for standard chat completions. VCP info is shown based on the .env config.
app.post('/v1/chat/completions', async (req, res) => {
    try {
        await chatCompletionHandler.handle(req, res, false);
    } catch (e) {
        console.error(`[FATAL] Uncaught exception from chatCompletionHandler for ${req.path}:`, e);
        if (!res.headersSent) {
            res.status(500).json({ error: "A fatal internal error occurred." });
        } else if (!res.writableEnded) {
            res.end();
        }
    }
});

// Route to force VCP info to be shown, regardless of the .env config.
app.post('/v1/chatvcp/completions', async (req, res) => {
    try {
        await chatCompletionHandler.handle(req, res, true);
    } catch (e) {
        console.error(`[FATAL] Uncaught exception from chatCompletionHandler for ${req.path}:`, e);
        if (!res.headersSent) {
            res.status(500).json({ error: "A fatal internal error occurred." });
        } else if (!res.writableEnded) {
            res.end();
        }
    }
});

// 新增：人类直接调用工具的端点
app.post('/v1/human/tool', async (req, res) => {
    try {
        const requestBody = req.body;
        if (typeof requestBody !== 'string' || !requestBody.trim()) {
            return res.status(400).json({ error: 'Request body must be a non-empty plain text.' });
        }

        const toolRequestStartMarker = "<<<[TOOL_REQUEST]>>>";
        const toolRequestEndMarker = "<<<[END_TOOL_REQUEST]>>>";

        const startIndex = requestBody.indexOf(toolRequestStartMarker);
        const endIndex = requestBody.indexOf(toolRequestEndMarker, startIndex);

        if (startIndex === -1 || endIndex === -1) {
            return res.status(400).json({ error: 'Malformed request: Missing TOOL_REQUEST markers.' });
        }

        const requestBlockContent = requestBody.substring(startIndex + toolRequestStartMarker.length, endIndex).trim();

        let parsedToolArgs = {};
        let requestedToolName = null;
        const paramRegex = /([\w_]+)\s*:\s*「始」([\s\S]*?)「末」\s*(?:,)?/g;
        let regexMatch;

        while ((regexMatch = paramRegex.exec(requestBlockContent)) !== null) {
            const key = regexMatch[1];
            const value = regexMatch[2].trim();
            if (key === "tool_name") {
                requestedToolName = value;
            } else {
                parsedToolArgs[key] = value;
            }
        }

        if (!requestedToolName) {
            return res.status(400).json({ error: 'Malformed request: tool_name not found within the request block.' });
        }

        if (DEBUG_MODE) {
            console.log(`[Human Tool Exec] Received tool call for: ${requestedToolName}`, parsedToolArgs);
        }

        // 直接调用插件管理器
        const result = await pluginManager.processToolCall(requestedToolName, parsedToolArgs);

        // processToolCall 的结果已经是正确的对象格式
        res.status(200).json(result);

    } catch (error) {
        console.error('[Human Tool Exec] Error processing direct tool call:', error.message);
        handleApiError(req); // 新增：处理API错误计数

        let errorObject;
        try {
            // processToolCall 抛出的错误是一个字符串化的JSON
            errorObject = JSON.parse(error.message);
        } catch (parseError) {
            errorObject = { error: 'Internal Server Error', details: error.message };
        }

        res.status(500).json(errorObject);
    }
});


async function handleDiaryFromAIResponse(responseText) {
    let fullAiResponseTextForDiary = '';
    let successfullyParsedForDiary = false;
    if (!responseText || typeof responseText !== 'string' || responseText.trim() === "") {
        return;
    }
    const lines = responseText.trim().split('\n');
    const looksLikeSSEForDiary = lines.some(line => line.startsWith('data: '));
    if (looksLikeSSEForDiary) {
        let sseContent = '';
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const jsonData = line.substring(5).trim();
                if (jsonData === '[DONE]') continue;
                try {
                    const parsedData = JSON.parse(jsonData);
                    const contentChunk = parsedData.choices?.[0]?.delta?.content || parsedData.choices?.[0]?.message?.content || '';
                    if (contentChunk) sseContent += contentChunk;
                } catch (e) { /* ignore */ }
            }
        }
        if (sseContent) {
            fullAiResponseTextForDiary = sseContent;
            successfullyParsedForDiary = true;
        }
    }
    if (!successfullyParsedForDiary) {
        try {
            const parsedJson = JSON.parse(responseText);
            const jsonContent = parsedJson.choices?.[0]?.message?.content;
            if (jsonContent && typeof jsonContent === 'string') {
                fullAiResponseTextForDiary = jsonContent;
                successfullyParsedForDiary = true;
            }
        } catch (e) { /* ignore */ }
    }
    if (!successfullyParsedForDiary && !looksLikeSSEForDiary) {
        fullAiResponseTextForDiary = responseText;
    }

    if (fullAiResponseTextForDiary.trim()) {
        const dailyNoteRegex = /<<<DailyNoteStart>>>(.*?)<<<DailyNoteEnd>>>/s;
        const match = fullAiResponseTextForDiary.match(dailyNoteRegex);
        if (match && match[1]) {
            const noteBlockContent = match[1].trim();
            if (DEBUG_MODE) console.log('[handleDiaryFromAIResponse] Found structured daily note block.');

            const maidMatch = noteBlockContent.match(/^\s*Maid:\s*(.+?)$/m);
            const dateMatch = noteBlockContent.match(/^\s*Date:\s*(.+?)$/m);

            const maidName = maidMatch ? maidMatch[1].trim() : null;
            const dateString = dateMatch ? dateMatch[1].trim() : null;

            let contentText = null;
            const contentMatch = noteBlockContent.match(/^\s*Content:\s*([\s\S]*)$/m);
            if (contentMatch) {
                contentText = contentMatch[1].trim();
            }

            if (maidName && dateString && contentText) {
                const diaryPayload = { maidName, dateString, contentText };
                try {
                    if (DEBUG_MODE) console.log('[handleDiaryFromAIResponse] Calling DailyNoteWrite plugin with payload:', diaryPayload);
                    // pluginManager.executePlugin is expected to handle JSON stringification if the plugin expects a string
                    // and to parse the JSON response from the plugin.
                    // The third argument to executePlugin in Plugin.js is inputData, which can be a string or object.
                    // For stdio, it's better to stringify here.
                    const pluginResult = await pluginManager.executePlugin("DailyNoteWrite", JSON.stringify(diaryPayload));
                    // pluginResult is the direct parsed JSON object from the DailyNoteWrite plugin's stdout.
                    // Example success: { status: "success", message: "Diary saved to /path/to/your/file.txt" }
                    // Example error:   { status: "error", message: "Error details" }

                    if (pluginResult && pluginResult.status === "success" && pluginResult.message) {
                        const dailyNoteWriteResponse = pluginResult; // Use pluginResult directly

                        if (DEBUG_MODE) console.log(`[handleDiaryFromAIResponse] DailyNoteWrite plugin reported success: ${dailyNoteWriteResponse.message}`);

                        let filePath = '';
                        const successMessage = dailyNoteWriteResponse.message; // e.g., "Diary saved to /path/to/file.txt"
                        const pathMatchMsg = /Diary saved to (.*)/;
                        const matchedPath = successMessage.match(pathMatchMsg);
                        if (matchedPath && matchedPath[1]) {
                            filePath = matchedPath[1];
                        }

                        const notification = {
                            type: 'daily_note_created',
                            data: {
                                maidName: diaryPayload.maidName,
                                dateString: diaryPayload.dateString,
                                filePath: filePath,
                                status: 'success',
                                message: `日记 '${filePath || '未知路径'}' 已为 '${diaryPayload.maidName}' (${diaryPayload.dateString}) 创建成功。`
                            }
                        };
                        webSocketServer.broadcast(notification, 'VCPLog');
                        if (DEBUG_MODE) console.log('[handleDiaryFromAIResponse] Broadcasted daily_note_created notification:', notification);

                    } else if (pluginResult && pluginResult.status === "error") {
                        // Handle errors reported by the plugin's JSON response
                        console.error(`[handleDiaryFromAIResponse] DailyNoteWrite plugin reported an error:`, pluginResult.message || pluginResult);
                    } else {
                        // Handle cases where pluginResult is null, or status is not "success"/"error", or message is missing on success.
                        console.error(`[handleDiaryFromAIResponse] DailyNoteWrite plugin returned an unexpected response structure or failed:`, pluginResult);
                    }
                } catch (pluginError) {
                    // This catches errors from pluginManager.executePlugin itself (e.g., process spawn error, timeout)
                    console.error('[handleDiaryFromAIResponse] Error executing DailyNoteWrite plugin:', pluginError.message, pluginError.stack);
                }
            } else {
                console.error('[handleDiaryFromAIResponse] Could not extract Maid, Date, or Content from daily note block:', { maidName, dateString, contentText: contentText?.substring(0, 50) });
            }
        }
    }
}

// --- Admin API Router (Moved to routes/adminPanelRoutes.js) ---

// Define dailyNoteRootPath here as it's needed by the adminPanelRoutes module
// and was previously defined within the moved block.
const dailyNoteRootPath = process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(__dirname, 'dailynote');

// Import and use the admin panel routes, passing the getter for currentServerLogPath
const adminPanelRoutes = require('./routes/adminPanelRoutes')(
    DEBUG_MODE,
    dailyNoteRootPath,
    pluginManager,
    logger.getServerLogPath, // Pass the getter function
    knowledgeBaseManager, // Pass the knowledgeBaseManager instance
    AGENT_DIR, // Pass the Agent directory path
    cachedEmojiLists
);

// 新增：引入 VCP 论坛 API 路由
const forumApiRoutes = require('./routes/forumApi');

// --- End Admin API Router ---

// 新增：异步插件回调路由
const VCP_ASYNC_RESULTS_DIR = path.join(__dirname, 'VCPAsyncResults');

async function ensureAsyncResultsDir() {
    try {
        await fs.mkdir(VCP_ASYNC_RESULTS_DIR, { recursive: true });
    } catch (error) {
        console.error(`[ServerSetup] 创建 VCPAsyncResults 目录失败: ${VCP_ASYNC_RESULTS_DIR}`, error);
    }
}

app.post('/plugin-callback/:pluginName/:taskId', async (req, res) => {
    const { pluginName, taskId } = req.params;
    const callbackData = req.body; // 这是插件回调时发送的 JSON 数据

    if (DEBUG_MODE) {
        console.log(`[Server] Received callback for plugin: ${pluginName}, taskId: ${taskId}`);
        console.log(`[Server] Callback data:`, JSON.stringify(callbackData, null, 2));
    }

    // 1. Save callback data to a file
    await ensureAsyncResultsDir();
    const resultFilePath = path.join(VCP_ASYNC_RESULTS_DIR, `${pluginName}-${taskId}.json`);
    try {
        await fs.writeFile(resultFilePath, JSON.stringify(callbackData, null, 2), 'utf-8');
        if (DEBUG_MODE) console.log(`[Server Callback] Saved async result for ${pluginName}-${taskId} to ${resultFilePath}`);
    } catch (fileError) {
        console.error(`[Server Callback] Error saving async result file for ${pluginName}-${taskId}:`, fileError);
        // Continue with WebSocket push even if file saving fails for now
    }

    const pluginManifest = pluginManager.getPlugin(pluginName);

    if (!pluginManifest) {
        console.error(`[Server Callback] Plugin manifest not found for: ${pluginName}`);
        // Still attempt to acknowledge the callback if possible, but log error
        return res.status(404).json({ status: "error", message: "Plugin not found, but callback noted." });
    }

    // 2. WebSocket push (existing logic)
    if (pluginManifest.webSocketPush && pluginManifest.webSocketPush.enabled) {
        const targetClientType = pluginManifest.webSocketPush.targetClientType || null;
        const wsMessage = {
            type: pluginManifest.webSocketPush.messageType || 'plugin_callback_notification',
            data: callbackData
        };
        webSocketServer.broadcast(wsMessage, targetClientType);
        if (DEBUG_MODE) {
            console.log(`[Server Callback] WebSocket push for ${pluginName} (taskId: ${taskId}) processed. Message:`, JSON.stringify(wsMessage, null, 2));
        }
    } else if (DEBUG_MODE) {
        console.log(`[Server Callback] WebSocket push not configured or disabled for plugin: ${pluginName}`);
    }

    res.status(200).json({ status: "success", message: "Callback received and processed" });
});


async function initialize() {
    console.log('开始初始化向量数据库...');
    await knowledgeBaseManager.initialize(); // 在加载插件之前启动，确保服务就绪
    console.log('向量数据库初始化完成。');

    pluginManager.setProjectBasePath(__dirname);
    pluginManager.setVectorDBManager(knowledgeBaseManager); // 注入 knowledgeBaseManager

    console.log('开始加载插件...');
    await pluginManager.loadPlugins();
    console.log('插件加载完成。');

    console.log('开始初始化服务类插件...');
    // --- 关键顺序调整 ---
    // 必须先将 WebSocketServer 实例注入到 PluginManager，
    // 这样在 initializeServices 内部才能正确地为 VCPLog 等插件注入广播函数。
    pluginManager.setWebSocketServer(webSocketServer);

    await pluginManager.initializeServices(app, adminPanelRoutes, __dirname);
    // 在所有服务插件都注册完路由后，再将 adminApiRouter 挂载到主 app 上
    app.use('/admin_api', adminPanelRoutes);
    // 挂载 VCP 论坛 API 路由
    app.use('/admin_api/forum', forumApiRoutes);
    console.log('服务类插件初始化完成，管理面板 API 路由和 VCP 论坛 API 路由已挂载。');

    // --- 新增：通用依赖注入 ---
    // 在所有服务都初始化完毕后，再执行依赖注入，确保 VCPLog 等服务已准备就绪。
    try {
        const dependencies = {
            knowledgeBaseManager,
            vcpLogFunctions: pluginManager.getVCPLogFunctions()
        };
        if (DEBUG_MODE) console.log('[Server] Injecting dependencies into plugins...');

        // 注入到消息预处理器
        for (const [name, module] of pluginManager.messagePreprocessors) {
            if (typeof module.setDependencies === 'function') {
                module.setDependencies(dependencies);
                if (DEBUG_MODE) console.log(`  - Injected dependencies into message preprocessor: ${name}.`);
            }
        }
        // 注入到服务模块 (排除VCPLog自身)
        for (const [name, serviceData] of pluginManager.serviceModules) {
            if (name !== 'VCPLog' && typeof serviceData.module.setDependencies === 'function') {
                serviceData.module.setDependencies(dependencies);
                if (DEBUG_MODE) console.log(`  - Injected dependencies into service: ${name}.`);
            }
        }
    } catch (e) {
        console.error('[Server] An error occurred during dependency injection:', e);
    }
    // --- 依赖注入结束 ---

    console.log('开始初始化静态插件...');
    await pluginManager.initializeStaticPlugins();
    console.log('静态插件初始化完成。'); // Keep
    await pluginManager.prewarmPythonPlugins(); // 新增：预热Python插件以解决冷启动问题
    // EmojiListGenerator (static plugin) is automatically executed as part of the initializeStaticPlugins call above.
    // Its script (`emoji-list-generator.js`) will run and generate/update the .txt files
    // in its `generated_lists` directory. No need to call it separately here.

    if (DEBUG_MODE) console.log('开始从插件目录加载表情包列表到缓存 (由EmojiListGenerator插件生成)...');
    const emojiListSourceDir = path.join(__dirname, 'Plugin', 'EmojiListGenerator', 'generated_lists');
    cachedEmojiLists.clear();

    try {
        const listFiles = await fs.readdir(emojiListSourceDir);
        const txtFiles = listFiles.filter(file => file.toLowerCase().endsWith('.txt'));

        if (txtFiles.length === 0) {
            if (DEBUG_MODE) console.warn(`[initialize] Warning: No .txt files found in emoji list source directory: ${emojiListSourceDir}`);
        } else {
            if (DEBUG_MODE) console.log(`[initialize] Found ${txtFiles.length} emoji list files in ${emojiListSourceDir}. Loading...`);
            await Promise.all(txtFiles.map(async (fileName) => {
                const emojiName = fileName.replace(/\.txt$/i, '');
                const filePath = path.join(emojiListSourceDir, fileName);
                try {
                    const listContent = await fs.readFile(filePath, 'utf-8');
                    cachedEmojiLists.set(emojiName, listContent);
                } catch (readError) {
                    console.error(`[initialize] Error reading emoji list file ${filePath}:`, readError.message); // Keep as error
                    cachedEmojiLists.set(emojiName, `[加载 ${emojiName} 列表失败: ${readError.code}]`);
                }
            }));
            if (DEBUG_MODE) console.log('[initialize] All available emoji lists loaded into cache.');
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.error(`[initialize] Error: Emoji list source directory not found: ${emojiListSourceDir}. Make sure the EmojiListGenerator plugin ran successfully.`); // Keep as error
        } else {
            console.error(`[initialize] Error reading emoji list source directory ${emojiListSourceDir}:`, error.message); // Keep as error
        }
    }
    if (DEBUG_MODE) console.log('表情包列表缓存加载完成。');

    // 初始化通用任务调度器
    taskScheduler.initialize(pluginManager, webSocketServer, DEBUG_MODE);
}

// Store the server instance globally so it can be accessed by gracefulShutdown
let server;

async function startServer() {
    await loadBlacklist(); // 新增：在服务器启动时加载IP黑名单

    // 确保 Agent 目录存在
    await ensureAgentDirectory();

    // 确保 TVS 目录存在
    await ensureTvsDirectory();

    // 新增：加载模型重定向配置
    console.log('正在加载模型重定向配置...');
    modelRedirectHandler.setDebugMode(DEBUG_MODE);
    await modelRedirectHandler.loadModelRedirectConfig(path.join(__dirname, 'ModelRedirect.json'));
    console.log('模型重定向配置加载完成。');

    // 新增：初始化Agent管理器
    console.log('正在初始化Agent管理器...');
    agentManager.setAgentDir(AGENT_DIR);
    await agentManager.initialize(DEBUG_MODE);
    console.log('Agent管理器初始化完成。');

    console.log('正在初始化TVS管理器...');
    tvsManager.initialize(DEBUG_MODE);
    console.log('TVS管理器初始化完成。');

    // 🌟 关键修复：在监听端口前完成所有初始化
    await initialize(); // This loads plugins and initializes services

    console.log('正在初始化多模态侧车管理器...');
    await mediaSidecarManager.initialize({
        rootPath: dailyNoteRootPath,
        storePath: process.env.KNOWLEDGEBASE_STORE_PATH || path.join(__dirname, 'VectorStore'),
        debugMode: DEBUG_MODE
    });
    console.log('多模态侧车管理器初始化完成。');

    if (knowledgeBaseManager && typeof knowledgeBaseManager.notifyFileChanged === 'function' && typeof knowledgeBaseManager.notifyFileDeleted === 'function') {
        mediaSidecarManager.on('sidecar-upsert', async ({ sidecarPath }) => {
            try {
                if (sidecarPath) {
                    knowledgeBaseManager.notifyFileChanged(sidecarPath);
                }
            } catch (error) {
                console.error('[Server] sidecar-upsert -> KnowledgeBase notify failed:', error.message);
            }
        });

        mediaSidecarManager.on('sidecar-delete', async ({ sidecarPath }) => {
            try {
                if (sidecarPath) {
                    await knowledgeBaseManager.notifyFileDeleted(sidecarPath);
                }
            } catch (error) {
                console.error('[Server] sidecar-delete -> KnowledgeBase notify failed:', error.message);
            }
        });

        if (DEBUG_MODE) {
            console.log('[Server] Media sidecar lifecycle bridge to KnowledgeBaseManager is active.');
        }
    }

    server = app.listen(port, () => {
        console.log(`中间层服务器正在监听端口 ${port}`);
        console.log(`API 服务器地址: ${apiUrl}`);

        // Initialize the new WebSocketServer
        if (DEBUG_MODE) console.log('[Server] Initializing WebSocketServer...');
        const vcpKeyValue = pluginManager.getResolvedPluginConfigValue('VCPLog', 'VCP_Key') || process.env.VCP_Key;
        webSocketServer.initialize(server, { debugMode: DEBUG_MODE, vcpKey: vcpKeyValue });

        // --- 注入依赖 ---
        webSocketServer.setPluginManager(pluginManager);

        // 初始化 FileFetcherServer
        FileFetcherServer.initialize(webSocketServer);

        if (DEBUG_MODE) console.log('[Server] WebSocketServer, PluginManager, and FileFetcherServer have been interconnected.');
    });
}

startServer().catch(err => {
    console.error('[Server] Failed to start server:', err);
    process.exit(1);
});


async function gracefulShutdown() {
    console.log('Initiating graceful shutdown...');

    if (taskScheduler) {
        taskScheduler.shutdown();
    }

    if (webSocketServer) {
        console.log('[Server] Shutting down WebSocketServer...');
        webSocketServer.shutdown();
    }
    if (pluginManager) {
        await pluginManager.shutdownAllPlugins();
    }

    if (mediaSidecarManager) {
        await mediaSidecarManager.shutdown();
    }

    const serverLogWriteStream = logger.getLogWriteStream();
    if (serverLogWriteStream) {
        logger.originalConsoleLog('[Server] Closing server log file stream...');
        const logClosePromise = new Promise((resolve) => {
            serverLogWriteStream.end(`[${dayjs().tz(DEFAULT_TIMEZONE).format('YYYY-MM-DD HH:mm:ss Z')}] Server gracefully shut down.\n`, () => {
                logger.originalConsoleLog('[Server] Server log stream closed.');
                resolve();
            });
        });
        await logClosePromise;
    }

    console.log('Graceful shutdown complete. Exiting.');
    process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// 新增：捕获未处理的异常，防止服务器崩溃
process.on('uncaughtException', (error) => {
    console.error('[CRITICAL] Uncaught Exception detected:', error.message);
    console.error('[CRITICAL] Stack trace:', error.stack);

    // 记录到日志文件
    const serverLogWriteStream = logger.getLogWriteStream();
    if (serverLogWriteStream && !serverLogWriteStream.destroyed) {
        try {
            serverLogWriteStream.write(
                `[${dayjs().tz(DEFAULT_TIMEZONE).format('YYYY-MM-DD HH:mm:ss Z')}] [CRITICAL] Uncaught Exception: ${error.message}\n${error.stack}\n`
            );
        } catch (e) {
            console.error('[CRITICAL] Failed to write exception to log:', e.message);
        }
    }

    // 不要立即退出，让服务器继续运行
    console.log('[CRITICAL] Server will continue running despite the exception.');
});

// 新增：捕获未处理的 Promise 拒绝
process.on('unhandledRejection', (reason, promise) => {
    console.error('[WARNING] Unhandled Promise Rejection at:', promise);
    console.error('[WARNING] Reason:', reason);

    // 记录到日志文件
    const serverLogWriteStream = logger.getLogWriteStream();
    if (serverLogWriteStream && !serverLogWriteStream.destroyed) {
        try {
            serverLogWriteStream.write(
                `[${dayjs().tz(DEFAULT_TIMEZONE).format('YYYY-MM-DD HH:mm:ss Z')}] [WARNING] Unhandled Promise Rejection: ${reason}\n`
            );
        } catch (e) {
            console.error('[WARNING] Failed to write rejection to log:', e.message);
        }
    }
});

// Ensure log stream is flushed on uncaught exceptions or synchronous exit, though less reliable
process.on('exit', (code) => {
    logger.originalConsoleLog(`[Server] Exiting with code ${code}.`);
    const serverLogWriteStream = logger.getLogWriteStream();
    const currentServerLogPath = logger.getServerLogPath();
    if (serverLogWriteStream && !serverLogWriteStream.destroyed) {
        try {
            fsSync.appendFileSync(currentServerLogPath, `[${dayjs().tz(DEFAULT_TIMEZONE).format('YYYY-MM-DD HH:mm:ss Z')}] Server exited with code ${code}.\n`);
            serverLogWriteStream.end();
        } catch (e) {
            logger.originalConsoleError('[Server] Error during final log write on exit:', e.message);
        }
    }
});