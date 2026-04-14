// adminServer.js
// 独立后台管理面板进程，监听 PORT+1
// 目的：将 AdminPanel 与聊天主链解耦，避免主进程 SSE stall 时后台面板一起卡顿
const express = require('express');
const dotenv = require('dotenv');
dotenv.config({ path: 'config.env' });

const path = require('path');
const { promises: fs, existsSync } = require('fs');
const http = require('http');
const basicAuth = require('basic-auth');
const cors = require('cors');

const MAIN_PORT = parseInt(process.env.PORT) || 3000;
const ADMIN_PORT = MAIN_PORT + 1;
const DEBUG_MODE = (process.env.DebugMode || 'False').toLowerCase() === 'true';

const ADMIN_USERNAME = process.env.AdminUsername;
const ADMIN_PASSWORD = process.env.AdminPassword;
const VUE_ADMIN_PANEL_ROOT = path.join(__dirname, 'AdminPanel-Vue', 'dist');
const LEGACY_ADMIN_PANEL_BACKUP_ROOT = path.join(__dirname, 'AdminPanel-backup-20260408-201832');
const VUE_ADMIN_PANEL_INDEX = path.join(VUE_ADMIN_PANEL_ROOT, 'index.html');

if (!existsSync(VUE_ADMIN_PANEL_INDEX)) {
    console.warn(`[AdminServer] Vue AdminPanel build not found: ${VUE_ADMIN_PANEL_INDEX}`);
    console.warn('[AdminServer] Run "npm run build" inside AdminPanel-Vue before starting the admin server.');
}

// ============================================================
// 登录防暴力破解
// ============================================================
const loginAttempts = new Map();
const tempBlocks = new Map();
const noCredentialAccess = new Map(); // 无凭据访问计数（防DDoS探测）
const MAX_LOGIN_ATTEMPTS = 5; // 错误凭据上限
const MAX_NO_CREDENTIAL_REQUESTS = 100; // 无凭据访问上限（防DDoS探测）
const LOGIN_ATTEMPT_WINDOW = 15 * 60 * 1000;
const TEMP_BLOCK_DURATION = 30 * 60 * 1000; // 错误凭据触发封禁时长
const NO_CREDENTIAL_BLOCK_DURATION = 15 * 60 * 1000; // 无凭据DDoS触发封禁时长

// ============================================================
// Express App
// ============================================================
const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '300mb' }));
app.use(express.urlencoded({ limit: '300mb', extended: true }));
app.use(express.text({ limit: '300mb', type: 'text/plain' }));

// ============================================================
// Admin Authentication Middleware (从 server.js 复制并精简)
// ============================================================
const adminAuth = (req, res, next) => {
    // 登录页和静态资源白名单
    const publicPaths = [
        '/AdminPanel/login.html',
        '/AdminPanel/VCPLogo2.png',
        '/AdminPanel/favicon.ico',
        '/AdminPanel/style.css',
        '/AdminPanel/woff.css',
        '/AdminPanel/font.woff2'
    ];

    const isVerifyEndpoint = req.path === '/admin_api/verify-login';

    const readOnlyDashboardPaths = [
        '/admin_api/system-monitor',
        '/admin_api/newapi-monitor',
        '/admin_api/server-log',
        '/admin_api/user-auth-code',
        '/admin_api/weather'
    ];
    const isReadOnlyPath = readOnlyDashboardPaths.some(p => req.path.startsWith(p));

    if (publicPaths.includes(req.path)) {
        return next();
    }

    let clientIp = req.ip;
    if (clientIp && clientIp.substr(0, 7) === '::ffff:') {
        clientIp = clientIp.substr(7);
    }

    // 检查管理员凭据是否已配置
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
        console.error('[AdminServer] AdminUsername or AdminPassword not set in config.env.');
        if (req.path.startsWith('/admin_api') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(503).json({ error: 'Admin credentials not configured.' });
        }
        return res.status(503).send('<h1>503</h1><p>Admin credentials not configured.</p>');
    }

    // 检查 IP 是否被临时封禁
    const blockInfo = tempBlocks.get(clientIp);
    if (blockInfo && Date.now() < blockInfo.expires && !isReadOnlyPath) {
        const timeLeft = Math.ceil((blockInfo.expires - Date.now()) / 1000 / 60);
        res.setHeader('Retry-After', Math.ceil((blockInfo.expires - Date.now()) / 1000));
        return res.status(429).json({
            error: 'Too Many Requests',
            message: `您的IP已被暂时封禁。请在 ${timeLeft} 分钟后重试。`
        });
    }

    // 获取凭据（优先 Header，其次 Cookie）
    let credentials = basicAuth(req);
    if (!credentials && req.headers.cookie) {
        const cookies = req.headers.cookie.split(';').reduce((acc, cookie) => {
            const [key, value] = cookie.trim().split('=');
            acc[key] = value;
            return acc;
        }, {});

        if (cookies.admin_auth) {
            try {
                const authValue = decodeURIComponent(cookies.admin_auth);
                if (authValue.startsWith('Basic ')) {
                    const base64Credentials = authValue.substring(6);
                    const decodedCredentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
                    const [name, pass] = decodedCredentials.split(':');
                    if (name && pass) credentials = { name, pass };
                }
            } catch (e) {
                // ignore
            }
        }
    }

    // 验证凭据
    if (!credentials || credentials.name !== ADMIN_USERNAME || credentials.pass !== ADMIN_PASSWORD) {
        // 🌟 关键修复：只有当用户主动提供了凭据（但凭据错误）时才计入失败次数
        // 当 credentials 为 null 时（如 cookie 过期、用户登出后面板后台轮询），
        // 不计入失败次数，避免面板挂着时 cookie 过期导致立即封禁 IP
        const isActiveLoginAttempt = !!credentials;
        if (clientIp && !isReadOnlyPath && isActiveLoginAttempt) {
            const now = Date.now();
            let attemptInfo = loginAttempts.get(clientIp) || { count: 0, firstAttempt: now };
            if (now - attemptInfo.firstAttempt > LOGIN_ATTEMPT_WINDOW) {
                attemptInfo = { count: 0, firstAttempt: now };
            }
            attemptInfo.count++;
            if (attemptInfo.count >= MAX_LOGIN_ATTEMPTS) {
                tempBlocks.set(clientIp, { expires: now + TEMP_BLOCK_DURATION });
                loginAttempts.delete(clientIp);
            } else {
                loginAttempts.set(clientIp, attemptInfo);
            }
        }
        // 🌟 防DDoS：无凭据访问独立计数，阈值更宽松（不影响正常 cookie 过期场景）
        else if (clientIp && !isReadOnlyPath) {
            const now = Date.now();
            let accessInfo = noCredentialAccess.get(clientIp) || { count: 0, firstAccess: now };

            if (now - accessInfo.firstAccess > LOGIN_ATTEMPT_WINDOW) {
                accessInfo = { count: 0, firstAccess: now };
            }

            accessInfo.count++;

            if (accessInfo.count >= MAX_NO_CREDENTIAL_REQUESTS) {
                console.warn(`[AdminServer] IP ${clientIp} blocked for ${NO_CREDENTIAL_BLOCK_DURATION / 60000} min — excessive unauthenticated requests (${accessInfo.count}/${MAX_NO_CREDENTIAL_REQUESTS}).`);
                tempBlocks.set(clientIp, { expires: now + NO_CREDENTIAL_BLOCK_DURATION });
                noCredentialAccess.delete(clientIp);
            } else {
                noCredentialAccess.set(clientIp, accessInfo);
                if (accessInfo.count % 10 === 0) {
                    console.log(`[AdminServer] Unauthenticated access from IP: ${clientIp}. Count: ${accessInfo.count}/${MAX_NO_CREDENTIAL_REQUESTS}`);
                }
            }
        }

        if (isVerifyEndpoint || req.path.startsWith('/admin_api') ||
            (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(401).json({ error: 'Unauthorized' });
        } else if (req.path.startsWith('/AdminPanel') || req.path.startsWith('/AdminPanelLegacy')) {
            return res.redirect('/AdminPanel/login.html');
        } else {
            res.setHeader('WWW-Authenticate', 'Basic realm="Admin Panel"');
            return res.status(401).send('<h1>401 Unauthorized</h1>');
        }
    }

    // 认证成功
    if (clientIp) loginAttempts.delete(clientIp);
    return next();
};

app.use(adminAuth);

// 静态文件：默认托管 Vue 构建产物，并保留 legacy 路径兼容旧链接
app.use('/AdminPanel', express.static(VUE_ADMIN_PANEL_ROOT));
// Static serving targets the Vue build by default and keeps the legacy route alive.
app.use('/AdminPanel', express.static(VUE_ADMIN_PANEL_ROOT));
app.use('/AdminPanelLegacy', express.static(VUE_ADMIN_PANEL_ROOT));

function serveVueAdminPanelApp(req, res, next) {
    if (path.extname(req.path)) {
        return next();
    }
    return res.sendFile(VUE_ADMIN_PANEL_INDEX);
}

app.get(/^\/AdminPanel(?:\/.*)?$/, serveVueAdminPanelApp);
app.get(/^\/AdminPanelLegacy(?:\/.*)?$/, serveVueAdminPanelApp);

// 默认路由：访问根路径重定向到 AdminPanel
app.get('/', (req, res) => {
    res.redirect('/AdminPanel/index.html');
});

// ============================================================
// 路由分类：本地处理 vs 代理到主进程
// ============================================================

// --- 本地独立处理的模块 ---
// 这些模块仅依赖文件 I/O 和轻量单例，不需要主进程运行态

const dailyNoteRootPath = process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(__dirname, 'dailynote');

// Agent 目录
let AGENT_DIR;
const agentConfigPath = process.env.AGENT_DIR_PATH;
if (!agentConfigPath || typeof agentConfigPath !== 'string' || agentConfigPath.trim() === '') {
    AGENT_DIR = path.join(__dirname, 'Agent');
} else {
    const normalizedPath = path.normalize(agentConfigPath.trim());
    AGENT_DIR = path.isAbsolute(normalizedPath) ? normalizedPath : path.resolve(__dirname, normalizedPath);
}

// TVStxt 目录
let TVS_DIR;
const tvsConfigPath = process.env.TVSTXT_DIR_PATH;
if (!tvsConfigPath || typeof tvsConfigPath !== 'string' || tvsConfigPath.trim() === '') {
    TVS_DIR = path.join(__dirname, 'TVStxt');
} else {
    const normalizedPath = path.normalize(tvsConfigPath.trim());
    TVS_DIR = path.isAbsolute(normalizedPath) ? normalizedPath : path.resolve(__dirname, normalizedPath);
}

const localAdminRouter = express.Router();

// 本地可独立运行的模块列表
const localModules = [
    'system',          // PM2/系统资源/认证码/天气/热榜
    'logs',            // 服务器日志读取
    'server',          // 登录/登出/认证状态
    'config',          // config.env / toolApprovalConfig 读写
    'rag',             // RAG 标签/参数/语义组/思维链（文件读写）
    'toolbox',         // Toolbox 映射与文件管理
    'agents',          // Agent 映射与文件管理
    'tvs',             // TVS 变量文件管理
    'schedules',       // 日程管理
    'newapiMonitor',   // NewAPI 监控（外部 HTTP）
    'cache',           // 多媒体/图像缓存管理
    'dailyNotes',      // 日记知识库文件管理
    'agentAssistant',  // Agent 助手配置（纯文件 I/O）
];

// 日志路径获取函数（本地计算，不依赖主进程 logger 实例）
function getCurrentServerLogPath() {
    return path.join(__dirname, 'DebugLog', 'ServerLog.txt');
}

// 轻量 mock pluginManager — 仅为本地 admin 模块提供安全的 no-op 方法
// 例如 config.js 保存后会调用 pluginManager.loadPlugins()
// 在独立后台进程里，这个调用不应该真正执行插件加载，只记录一条日志
const mockPluginManager = {
    plugins: new Map(),
    loadPlugins: async () => {
        console.log('[AdminServer] pluginManager.loadPlugins() called in admin process — skipped (use reload-notify to trigger main process reload).');
    },
    hotReloadPluginsAndOrder: async () => {
        console.log('[AdminServer] pluginManager.hotReloadPluginsAndOrder() called in admin process — proxying to main process is recommended.');
        return [];
    },
    getPreprocessorOrder: () => [],
    getPlugin: () => null,
    getServiceModule: () => null,
    getAllPlaceholderValues: () => new Map(),
    getIndividualPluginDescriptions: () => new Map(),
    getPlaceholderValue: (key) => `[Placeholder ${key} not available in admin process]`,
    getResolvedPluginConfigValue: () => undefined,
};

const localOptions = {
    DEBUG_MODE,
    dailyNoteRootPath,
    pluginManager: mockPluginManager,
    getCurrentServerLogPath,
    vectorDBManager: null,      // vectordb-status 会返回 503，由代理路径覆盖
    agentDirPath: AGENT_DIR,
    cachedEmojiLists: new Map(),
    tvsDirPath: TVS_DIR,
    triggerRestart: (code = 1) => {
        console.log(`[AdminServer] Restarting admin process (exit code: ${code})...`);
        setTimeout(() => process.exit(code), 500);
    }
};

for (const moduleName of localModules) {
    try {
        const modulePath = path.join(__dirname, 'routes', 'admin', `${moduleName}.js`);
        const routeHandler = require(modulePath)(localOptions);
        localAdminRouter.use('/', routeHandler);
        if (DEBUG_MODE) console.log(`[AdminServer] Mounted local module: ${moduleName}`);
    } catch (error) {
        console.error(`[AdminServer] Failed to load local module "${moduleName}":`, error.message);
    }
}

// ============================================================
// 🔑 关键覆盖：重启主服务（必须在本地路由之前挂载）
// 本地 routes/admin/server.js 的 /server/restart 会 process.exit(1) 杀死当前进程
// 在独立后台进程里，这个行为需要被重定向为"通知主进程重启"
// ============================================================
app.post('/admin_api/server/restart', async (req, res) => {
    console.log('[AdminServer] Restart request received — forwarding to main process...');
    res.json({ message: '正在通知主服务重启。管理面板将保持运行。' });

    // 通过 HTTP 请求通知主进程自行重启
    setTimeout(() => {
        const restartReq = http.request(
            `http://127.0.0.1:${MAIN_PORT}/admin_api/server/restart`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': req.headers.authorization || '',
                    'Cookie': req.headers.cookie || ''
                },
                timeout: 5000
            },
            (restartRes) => {
                console.log(`[AdminServer] Main process restart response: ${restartRes.statusCode}`);
            }
        );
        restartReq.on('error', (err) => {
            // 预期会出错：主进程收到后会执行 process.exit(1)，连接会断
            console.log(`[AdminServer] Main process restart signal sent (connection closed as expected: ${err.code || err.message})`);
        });
        restartReq.write('{}');
        restartReq.end();
    }, 300);
});

app.use('/admin_api', localAdminRouter);

// ============================================================
// 代理到主进程的模块
// 这些模块强依赖 pluginManager / vectorDBManager 运行态
// 通过 HTTP 反向代理到主进程的 /admin_api/* 接口
// ============================================================

// 🌟 兜底代理：任何本地路由未处理的 /admin_api 请求都转发给主进程
// 这包括插件通过 registerRoutes 注册到 adminApiRouter 的动态路由
// 例如 /admin_api/vcptavern/*, /admin_api/forum/*, 等等
app.use('/admin_api', (req, res, next) => {
    // 如果响应已经被发送（由本地路由处理），则跳过
    if (res.headersSent) return;

    // 构建代理请求
    const fullPath = '/admin_api' + req.path;
    const queryString = require('url').parse(req.url).search || '';
    const targetUrl = `http://127.0.0.1:${MAIN_PORT}${fullPath}`;
    const proxyUrl = targetUrl + queryString;

    if (DEBUG_MODE) console.log(`[AdminServer Proxy] ${req.method} ${fullPath} -> ${proxyUrl}`);

    const proxyOptions = {
        method: req.method,
        headers: { ...req.headers },
        timeout: 30000,
    };

    // 移除可能干扰的 headers
    delete proxyOptions.headers['host'];
    delete proxyOptions.headers['content-length'];

    const proxyReq = http.request(proxyUrl, proxyOptions, (proxyRes) => {
        res.status(proxyRes.statusCode);
        // 复制响应头
        for (const [key, value] of Object.entries(proxyRes.headers)) {
            if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        }
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error(`[AdminServer Proxy] Error proxying to main process: ${err.message}`);
        if (!res.headersSent) {
            res.status(502).json({
                error: 'Bad Gateway',
                message: `无法连接到主服务 (PORT ${MAIN_PORT})。主服务可能未启动或正在重启中。`,
                details: err.message
            });
        }
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) {
            res.status(504).json({
                error: 'Gateway Timeout',
                message: '主服务响应超时。主服务可能正在处理重负载。'
            });
        }
    });

    // 转发请求体
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        const bodyData = JSON.stringify(req.body);
        proxyReq.setHeader('Content-Type', 'application/json');
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
        proxyReq.write(bodyData);
    }

    proxyReq.end();
});

// ============================================================
// 特殊处理：config/main 保存后通知主进程重载
// 前端可调用此端点，在本地写完文件后额外通知主进程
// ============================================================
app.post('/admin_api/config/main/reload-notify', async (req, res) => {
    try {
        // 通知主进程重新加载插件（fire-and-forget）
        const notifyReq = http.request(
            `http://127.0.0.1:${MAIN_PORT}/admin_api/config/main`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': req.headers.authorization || '',
                    'Cookie': req.headers.cookie || ''
                },
                timeout: 10000
            },
            (notifyRes) => {
                let body = '';
                notifyRes.on('data', chunk => body += chunk);
                notifyRes.on('end', () => {
                    res.json({ success: true, message: '配置已保存，主服务已通知重载。' });
                });
            }
        );
        notifyReq.on('error', (err) => {
            // 主进程可能不可达，但本地文件已保存
            res.json({ success: true, message: '配置已保存到文件，但主服务通知失败（可能需要手动重启）。', warning: err.message });
        });
        notifyReq.write(JSON.stringify(req.body));
        notifyReq.end();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 启动服务器
// ============================================================
app.listen(ADMIN_PORT, () => {
    console.log(`[AdminServer] 管理面板独立进程已启动，监听端口 ${ADMIN_PORT}`);
    console.log(`[AdminServer] 管理面板地址: http://localhost:${ADMIN_PORT}/AdminPanel/`);
    console.log(`[AdminServer] Vue 面板目录: ${VUE_ADMIN_PANEL_ROOT}`);
    console.log(`[AdminServer] Legacy 备份目录: ${LEGACY_ADMIN_PANEL_BACKUP_ROOT}`);
    console.log(`[AdminServer] 主服务地址: http://localhost:${MAIN_PORT}`);
    console.log(`[AdminServer] 本地处理模块: ${localModules.join(', ')}`);
    console.log(`[AdminServer] 未匹配的 /admin_api 请求将自动代理到主进程 PORT ${MAIN_PORT}`);
});
