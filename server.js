// server.js
const express = require('express');
const dotenv = require('dotenv');
const schedule = require('node-schedule');
const lunarCalendar = require('chinese-lunar-calendar');
const fsSync = require('fs'); // Renamed to fsSync for clarity with fs.promises
const fs = require('fs').promises; // fs.promises for async operations
const path = require('path');
const { Writable } = require('stream');

const DEBUG_LOG_DIR = path.join(__dirname, 'DebugLog'); // Moved DEBUG_LOG_DIR definition higher
let currentServerLogPath = '';
let serverLogWriteStream = null;

// 确保 DebugLog 目录存在 (同步版本，因为在启动时需要)
function ensureDebugLogDirSync() {
    if (!fsSync.existsSync(DEBUG_LOG_DIR)) {
        try {
            fsSync.mkdirSync(DEBUG_LOG_DIR, { recursive: true });
            // Use originalConsoleLog if available, otherwise console.log (it might not be overridden yet)
            (typeof originalConsoleLog === 'function' ? originalConsoleLog : console.log)(`[ServerSetup] DebugLog 目录已创建: ${DEBUG_LOG_DIR}`);
        } catch (error) {
            (typeof originalConsoleError === 'function' ? originalConsoleError : console.error)(`[ServerSetup] 创建 DebugLog 目录失败: ${DEBUG_LOG_DIR}`, error);
        }
    }
}

// 服务器启动时调用
function initializeServerLogger() {
    ensureDebugLogDirSync(); // 确保目录存在
    const now = new Date();
    const timestamp = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}_${now.getMilliseconds().toString().padStart(3, '0')}`;
    currentServerLogPath = path.join(DEBUG_LOG_DIR, `ServerLog-${timestamp}.txt`);
    
    try {
        fsSync.writeFileSync(currentServerLogPath, `[${new Date().toLocaleString()}] Server log started.\n`, 'utf-8');
        serverLogWriteStream = fsSync.createWriteStream(currentServerLogPath, { flags: 'a' });
        (typeof originalConsoleLog === 'function' ? originalConsoleLog : console.log)(`[ServerSetup] 服务器日志将记录到: ${currentServerLogPath}`);
    } catch (error) {
        (typeof originalConsoleError === 'function' ? originalConsoleError : console.error)(`[ServerSetup] 初始化服务器日志文件失败: ${currentServerLogPath}`, error);
        serverLogWriteStream = null;
    }
}

// 保存原始 console 方法
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleInfo = console.info;

// 在服务器启动的最开始就初始化日志记录器
initializeServerLogger(); // Call this before console methods are overridden if they log during init


function formatLogMessage(level, args) {
    const timestamp = new Date().toLocaleString();
    // Handle potential circular structures in objects for JSON.stringify
    const safeStringify = (obj) => {
        const cache = new Set();
        return JSON.stringify(obj, (key, value) => {
            if (typeof value === 'object' && value !== null) {
                if (cache.has(value)) {
                    return '[Circular]';
                }
                cache.add(value);
            }
            return value;
        }, 2);
    };
    const message = args.map(arg => (typeof arg === 'object' ? safeStringify(arg) : String(arg))).join(' ');
    return `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
}

function writeToLogFile(formattedMessage) {
    if (serverLogWriteStream) {
        serverLogWriteStream.write(formattedMessage, (err) => {
            if (err) {
                originalConsoleError('[Logger] 写入日志文件失败:', err);
            }
        });
    }
}

console.log = (...args) => {
    originalConsoleLog.apply(console, args);
    const formattedMessage = formatLogMessage('log', args);
    writeToLogFile(formattedMessage);
};

console.error = (...args) => {
    originalConsoleError.apply(console, args);
    const formattedMessage = formatLogMessage('error', args);
    writeToLogFile(formattedMessage);
};

console.warn = (...args) => {
    originalConsoleWarn.apply(console, args);
    const formattedMessage = formatLogMessage('warn', args);
    writeToLogFile(formattedMessage);
};

console.info = (...args) => {
    originalConsoleInfo.apply(console, args);
    const formattedMessage = formatLogMessage('info', args);
    writeToLogFile(formattedMessage);
};


const AGENT_DIR = path.join(__dirname, 'Agent'); // 定义 Agent 目录
const TVS_DIR = path.join(__dirname, 'TVStxt'); // 新增：定义 TVStxt 目录
const crypto = require('crypto');
const pluginManager = require('./Plugin.js');
const taskScheduler = require('./routes/taskScheduler.js');
const webSocketServer = require('./WebSocketServer.js'); // 新增 WebSocketServer 引入
const FileFetcherServer = require('./FileFetcherServer.js'); // 引入新的 FileFetcherServer 模块
const vcpInfoHandler = require('./vcpInfoHandler.js'); // 引入新的 VCP 信息处理器
const basicAuth = require('basic-auth');
const cors = require('cors'); // 引入 cors 模块

const activeRequests = new Map(); // 新增：用于存储活动中的请求，以便中止

dotenv.config({ path: 'config.env' });

const ADMIN_USERNAME = process.env.AdminUsername;
const ADMIN_PASSWORD = process.env.AdminPassword;

const DEBUG_MODE = (process.env.DebugMode || "False").toLowerCase() === "true";
const SHOW_VCP_OUTPUT = (process.env.ShowVCP || "False").toLowerCase() === "true"; // 读取 ShowVCP 环境变量

// ensureDebugLogDir is now ensureDebugLogDirSync and called by initializeServerLogger
// writeDebugLog remains for specific debug purposes, it uses fs.promises.
async function ensureDebugLogDirAsync() { // Renamed to avoid conflict, used by writeDebugLog
    if (DEBUG_MODE) {
        try {
            await fs.mkdir(DEBUG_LOG_DIR, { recursive: true });
        } catch (error) {
            // console.error is now overridden, it will log to file too.
            console.error(`创建 DebugLog 目录失败 (async): ${DEBUG_LOG_DIR}`, error);
        }
    }
}

async function writeDebugLog(filenamePrefix, data) {
    if (DEBUG_MODE) {
        await ensureDebugLogDirAsync(); // Use the async version here
        const now = new Date();
        const timestamp = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}_${now.getMilliseconds().toString().padStart(3, '0')}`;
        const filename = `${filenamePrefix}-${timestamp}.txt`;
        const filePath = path.join(DEBUG_LOG_DIR, filename);
        try {
            await fs.writeFile(filePath, JSON.stringify(data, null, 2));
            console.log(`[DebugLog] 已记录日志: ${filename}`); // This console.log will also go to the main server log
        } catch (error) {
            console.error(`写入调试日志失败: ${filePath}`, error);
        }
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
    const isAdminPath = req.path.startsWith('/AdminPanel') || req.path.startsWith('/admin_api');

    if (isAdminPath) {
        // Check if admin credentials are configured
        if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
            console.error('[AdminAuth] AdminUsername or AdminPassword not set in config.env. Admin panel is disabled.');
            if (req.path.startsWith('/admin_api') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
                 res.status(503).json({
                    error: 'Service Unavailable: Admin credentials not configured.',
                    message: 'Please set AdminUsername and AdminPassword in the config.env file to enable the admin panel.'
                });
            } else {
                 res.status(503).send('<h1>503 Service Unavailable</h1><p>Admin credentials (AdminUsername, AdminPassword) are not configured in config.env. Please configure them to enable the admin panel.</p>');
            }
            return; // Stop further processing
        }

        // Credentials are configured, proceed with Basic Auth
        const credentials = basicAuth(req);
        if (!credentials || credentials.name !== ADMIN_USERNAME || credentials.pass !== ADMIN_PASSWORD) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Admin Panel"');
            if (req.path.startsWith('/admin_api') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
                return res.status(401).json({ error: 'Unauthorized' });
            } else {
                return res.status(401).send('<h1>401 Unauthorized</h1><p>Authentication required to access the Admin Panel.</p>');
            }
        }
        // Authentication successful
        return next();
    }
    // Not an admin path, proceed
    return next();
};
app.use(adminAuth); // Apply admin authentication globally (it will only act on /AdminPanel and /admin_api paths)

// Serve Admin Panel static files (will only be reached if adminAuth passes for /AdminPanel paths)
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

async function replaceCommonVariables(text, model, role) {
    if (text == null) return '';
    let processedText = String(text);

    // 仅在 system role 中执行大多数占位符替换
    if (role === 'system') {
        // START: Agent placeholder processing
        const agentConfigs = {};
        for (const envKey in process.env) {
            if (envKey.startsWith('Agent')) { // e.g., AgentNova
                const agentName = envKey.substring(5); // e.g., Nova
                if (agentName) { // Make sure it's not just "Agent"
                    agentConfigs[agentName] = process.env[envKey]; // agentConfigs["Nova"] = "Nova.txt"
                }
            }
        }

        for (const agentName in agentConfigs) {
            const placeholder = `{{${agentName}}}`; // e.g., {{Nova}}
            if (processedText.includes(placeholder)) {
                const agentFileName = agentConfigs[agentName]; // e.g., Nova.txt
                const agentFilePath = path.join(AGENT_DIR, agentFileName);
                try {
                    let agentFileContent = await fs.readFile(agentFilePath, 'utf-8');
                    // Recursively call replaceCommonVariables for the agent's content
                    // This ensures placeholders within the agent file are resolved.
                    let resolvedAgentContent = await replaceCommonVariables(agentFileContent, model, role);
                    processedText = processedText.replaceAll(placeholder, resolvedAgentContent);
                } catch (error) {
                    let errorMsg;
                    if (error.code === 'ENOENT') {
                        errorMsg = `[Agent ${agentName} (${agentFileName}) not found]`;
                        console.warn(`[Agent] Agent file not found: ${agentFilePath} for placeholder ${placeholder}`);
                    } else {
                        errorMsg = `[Error processing Agent ${agentName} (${agentFileName})]`;
                        console.error(`[Agent] Error reading or processing agent file ${agentFilePath} for placeholder ${placeholder}:`, error.message);
                    }
                    processedText = processedText.replaceAll(placeholder, errorMsg);
                }
            }
        }
        // END: Agent placeholder processing

        // 新增 Tar/Var 变量处理逻辑 (支持 .txt 文件)
        for (const envKey in process.env) {
            if (envKey.startsWith('Tar') || envKey.startsWith('Var')) {
                const placeholder = `{{${envKey}}}`;
                if (processedText.includes(placeholder)) {
                    const value = process.env[envKey];
                    if (value && typeof value === 'string' && value.toLowerCase().endsWith('.txt')) {
                        // 值是 .txt 文件，从 TVStxt 目录读取
                        const txtFilePath = path.join(TVS_DIR, value);
                        try {
                            const fileContent = await fs.readFile(txtFilePath, 'utf-8');
                            // 递归解析文件内容中的变量
                            const resolvedContent = await replaceCommonVariables(fileContent, model, role);
                            processedText = processedText.replaceAll(placeholder, resolvedContent);
                        } catch (error) {
                            let errorMsg;
                            if (error.code === 'ENOENT') {
                                errorMsg = `[变量 ${envKey} 的文件 (${value}) 未找到]`;
                                console.warn(`[变量加载] 文件未找到: ${txtFilePath} (占位符: ${placeholder})`);
                            } else {
                                errorMsg = `[处理变量 ${envKey} 的文件 (${value}) 时出错]`;
                                console.error(`[变量加载] 读取文件失败 ${txtFilePath} (占位符: ${placeholder}):`, error.message);
                            }
                            processedText = processedText.replaceAll(placeholder, errorMsg);
                        }
                    } else {
                        // 值是直接的字符串
                        processedText = processedText.replaceAll(placeholder, value || `[未配置 ${envKey}]`);
                    }
                }
            }
        }

        // START: New SarModelX/SarPromptX logic
        let sarPromptToInject = null;

        // Create a map from a model name to its specific prompt.
        const modelToPromptMap = new Map();
        for (const envKey in process.env) {
            if (/^SarModel\d+$/.test(envKey)) {
                const index = envKey.substring(8);
                const promptKey = `SarPrompt${index}`;
                let promptValue = process.env[promptKey];
                const models = process.env[envKey];

                if (promptValue && models) {
                    if (typeof promptValue === 'string' && promptValue.toLowerCase().endsWith('.txt')) {
                        const txtFilePath = path.join(TVS_DIR, promptValue);
                        try {
                            const fileContent = await fs.readFile(txtFilePath, 'utf-8');
                            // 递归解析文件内容中的变量, 依赖用户配置来避免无限递归
                            promptValue = await replaceCommonVariables(fileContent, model, role);
                        } catch (error) {
                            let errorMsg;
                            if (error.code === 'ENOENT') {
                                errorMsg = `[SarPrompt 文件 (${promptValue}) 未找到]`;
                                console.warn(`[Sar加载] 文件未找到: ${txtFilePath}`);
                            } else {
                                errorMsg = `[处理 SarPrompt 文件 (${promptValue}) 时出错]`;
                                console.error(`[Sar加载] 读取文件失败 ${txtFilePath}:`, error.message);
                            }
                            promptValue = errorMsg;
                        }
                    }
                    const modelList = models.split(',').map(m => m.trim()).filter(m => m);
                    for (const m of modelList) {
                        modelToPromptMap.set(m, promptValue);
                    }
                }
            }
        }

        // Check if the current request's model has a specific prompt.
        if (model && modelToPromptMap.has(model)) {
            sarPromptToInject = modelToPromptMap.get(model);
        }

        // Replace all {{Sar...}} placeholders.
        const sarPlaceholderRegex = /\{\{Sar[a-zA-Z0-9_]+\}\}/g;
        if (sarPromptToInject !== null) {
            // If a specific prompt is found, replace all Sar placeholders with it.
            processedText = processedText.replaceAll(sarPlaceholderRegex, sarPromptToInject);
        } else {
            // If no specific prompt is found for the model, remove all Sar placeholders.
            processedText = processedText.replaceAll(sarPlaceholderRegex, '');
        }
        // END: New SarModelX/SarPromptX logic

        const now = new Date();
        const date = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
        processedText = processedText.replace(/\{\{Date\}\}/g, date);
        const time = now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
        processedText = processedText.replace(/\{\{Time\}\}/g, time);
        const today = now.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: 'Asia/Shanghai' });
        processedText = processedText.replace(/\{\{Today\}\}/g, today);
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        const lunarDate = lunarCalendar.getLunar(year, month, day);
        let yearName = lunarDate.lunarYear.replace('年', '');
        let festivalInfo = `${yearName}${lunarDate.zodiac}年${lunarDate.dateStr}`;
        if (lunarDate.solarTerm) festivalInfo += ` ${lunarDate.solarTerm}`;
        processedText = processedText.replace(/\{\{Festival\}\}/g, festivalInfo);
        // START: 统一处理所有静态插件占位符 (VCP...)
        const staticPlaceholderValues = pluginManager.staticPlaceholderValues;
        if (staticPlaceholderValues && staticPlaceholderValues.size > 0) {
            for (const [placeholder, value] of staticPlaceholderValues.entries()) {
                // placeholder is already like "{{VCPPluginName}}"
                const placeholderRegex = new RegExp(placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
                processedText = processedText.replace(placeholderRegex, value || `[${placeholder} 信息不可用]`);
            }
        }
        // END: 统一处理所有静态插件占位符
        

        // Replace individual VCP plugin descriptions
        const individualPluginDescriptions = pluginManager.getIndividualPluginDescriptions();
        if (individualPluginDescriptions && individualPluginDescriptions.size > 0) {
            for (const [placeholderKey, description] of individualPluginDescriptions) {
                // placeholderKey is already like "VCPPluginName"
                processedText = processedText.replaceAll(`{{${placeholderKey}}}`, description || `[${placeholderKey} 信息不可用]`);
            }
        }

    // 新增：处理 {{VCPAllTools}} 占位符
        if (processedText.includes('{{VCPAllTools}}')) {
            const vcpDescriptionsList = [];

            // 从 individualPluginDescriptions 添加 (这些由 pluginManager.getIndividualPluginDescriptions() 提供)
            if (individualPluginDescriptions && individualPluginDescriptions.size > 0) {
                for (const description of individualPluginDescriptions.values()) {
                    vcpDescriptionsList.push(description);
                }
            }
            // 注意: 如果未来有其他直接通过 pluginManager.getPlaceholderValue("{{VCPCustomXXX}}") 处理的占位符,
            // 并且希望它们也列在 {{VCPAllTools}} 中，需要在此处手动添加逻辑来识别并包含它们。

            // 使用双换行符和分隔线来分隔各个插件的描述，使其更易读
            const allVcpToolsString = vcpDescriptionsList.length > 0 ? vcpDescriptionsList.join('\n\n---\n\n') : '没有可用的VCP工具描述信息';
            processedText = processedText.replaceAll('{{VCPAllTools}}', allVcpToolsString);
        }

        if (process.env.PORT) {
            processedText = processedText.replaceAll('{{Port}}', process.env.PORT);
        }
        const effectiveImageKey = pluginManager.getResolvedPluginConfigValue('ImageServer', 'Image_Key');
        if (processedText && typeof processedText === 'string' && effectiveImageKey) {
            processedText = processedText.replaceAll('{{Image_Key}}', effectiveImageKey);
        } else if (processedText && typeof processedText === 'string' && processedText.includes('{{Image_Key}}')) {
            if (DEBUG_MODE) console.warn('[replaceCommonVariables] {{Image_Key}} placeholder found in text, but ImageServer plugin or its Image_Key is not resolved. Placeholder will not be replaced.');
        }
        const emojiPlaceholderRegex = /\{\{(.+?表情包)\}\}/g;
        let emojiMatch;
        while ((emojiMatch = emojiPlaceholderRegex.exec(processedText)) !== null) {
            const placeholder = emojiMatch[0];
            const emojiName = emojiMatch[1];
            const emojiList = cachedEmojiLists.get(emojiName);
            processedText = processedText.replaceAll(placeholder, emojiList || `${emojiName}列表不可用`);
        }
        const diaryPlaceholderRegex = /\{\{(.+?)日记本\}\}/g;
        let tempProcessedText = processedText; // Work on a temporary copy

        // Attempt to get and parse the AllCharacterDiariesData placeholder from PluginManager
        let allDiariesData = {};
        const allDiariesDataString = pluginManager.getPlaceholderValue("{{AllCharacterDiariesData}}");

        if (allDiariesDataString && !allDiariesDataString.startsWith("[Placeholder")) {
            try {
                allDiariesData = JSON.parse(allDiariesDataString);
            } catch (e) {
                console.error(`[replaceCommonVariables] Failed to parse AllCharacterDiariesData JSON: ${e.message}. Data: ${allDiariesDataString.substring(0,100)}...`); // Keep as error
                // Keep allDiariesData as an empty object, so individual lookups will fail gracefully
            }
        } else if (allDiariesDataString && allDiariesDataString.startsWith("[Placeholder")) {
             if (DEBUG_MODE) console.warn(`[replaceCommonVariables] Placeholder {{AllCharacterDiariesData}} not found or not yet populated by DailyNoteGet plugin. Value: ${allDiariesDataString}`);
        }


        // Use a loop that allows for async operations if needed, though simple string replacement is sync here
        // We need to re-evaluate regex on each replacement as the string length changes
        let match;
        while ((match = diaryPlaceholderRegex.exec(tempProcessedText)) !== null) {
            const placeholder = match[0]; // e.g., "{{小明同学日记本}}"
            const characterName = match[1]; // e.g., "小明同学"
            
            let diaryContent = `[${characterName}日记本内容为空或未从插件获取]`; // Default message

            if (allDiariesData.hasOwnProperty(characterName)) {
                diaryContent = allDiariesData[characterName];
            } else {
                // console.warn(`[replaceCommonVariables] Diary for character "${characterName}" not found in AllCharacterDiariesData.`);
                // No need to log for every miss, default message is sufficient
            }
            
            // ReplaceAll is important if the same character's diary is mentioned multiple times
            tempProcessedText = tempProcessedText.replaceAll(placeholder, diaryContent);
            // Reset regex lastIndex because the string has changed, to re-scan from the beginning
            diaryPlaceholderRegex.lastIndex = 0;
        }
        processedText = tempProcessedText; // Assign the fully processed text back
        for (const rule of detectors) {
            if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
                processedText = processedText.replaceAll(rule.detector, rule.output);
            }
        }
    }
    // SuperDetectors 和 VCP_ASYNC_RESULT 应用于所有角色的消息
    for (const rule of superDetectors) {
        if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
            processedText = processedText.replaceAll(rule.detector, rule.output);
        }
    }

    // START: VCP_ASYNC_RESULT Placeholder Processing
    const asyncResultPlaceholderRegex = /\{\{VCP_ASYNC_RESULT::([a-zA-Z0-9_.-]+)::([a-zA-Z0-9_-]+)\}\}/g;
    let asyncMatch;
    // We need to handle multiple occurrences, and since replacement changes string length,
    // we collect all matches first, then replace. Or, more simply, loop until no more matches.
    // For simplicity in this step, let's assume a loop that re-evaluates.
    // A more robust way would be to collect all placeholders and their values first.

    // Create a new string for replacements to avoid issues with changing string length during regex exec
    let tempAsyncProcessedText = processedText;
    const promises = [];

    while ((asyncMatch = asyncResultPlaceholderRegex.exec(processedText)) !== null) {
        const placeholder = asyncMatch[0]; // Full placeholder e.g., {{VCP_ASYNC_RESULT::Wan2.1VideoGen::xyz123}}
        const pluginName = asyncMatch[1];
        const requestId = asyncMatch[2];
        
        promises.push(
            (async () => {
                const resultFilePath = path.join(VCP_ASYNC_RESULTS_DIR, `${pluginName}-${requestId}.json`);
                try {
                    const fileContent = await fs.readFile(resultFilePath, 'utf-8');
                    const callbackData = JSON.parse(fileContent);
                    // You suggested replacing with the 'message' from the callback data.
                    // Or, we could use the whole callbackData string, or a formatted summary.
                    // Let's use callbackData.message if available, otherwise a generic success.
                    let replacementText = `[任务 ${pluginName} (ID: ${requestId}) 已完成]`;
                    if (callbackData && callbackData.message) {
                        replacementText = callbackData.message;
                    } else if (callbackData && callbackData.status === 'Succeed') {
                         replacementText = `任务 ${pluginName} (ID: ${requestId}) 已成功完成。详情: ${JSON.stringify(callbackData.data || callbackData.result || callbackData)}`;
                    } else if (callbackData && callbackData.status === 'Failed') {
                        replacementText = `任务 ${pluginName} (ID: ${requestId}) 处理失败。原因: ${callbackData.reason || JSON.stringify(callbackData.data || callbackData.error || callbackData)}`;
                    }
                     // Replace only the first occurrence in each iteration to handle multiple identical placeholders correctly if needed,
                     // though typically each requestId would be unique.
                    tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, replacementText);
                } catch (error) {
                    if (error.code === 'ENOENT') {
                        // File not found, means task is pending or callback hasn't happened/saved
                        tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, `[任务 ${pluginName} (ID: ${requestId}) 结果待更新...]`);
                    } else {
                        // Other errors (e.g., JSON parse error from file)
                        console.error(`[replaceCommonVariables] Error processing async placeholder ${placeholder}:`, error);
                        tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, `[获取任务 ${pluginName} (ID: ${requestId}) 结果时出错]`);
                    }
                }
            })()
        );
    }
    
    await Promise.all(promises);
    processedText = tempAsyncProcessedText;
    // END: VCP_ASYNC_RESULT Placeholder Processing

    return processedText;
}


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

        // Forward the status code and headers from the upstream API
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
    const pad = (num) => num.toString().padStart(2, '0');

    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());

    const tzOffset = -date.getTimezoneOffset();
    const offsetHours = pad(Math.floor(Math.abs(tzOffset) / 60));
    const offsetMinutes = pad(Math.abs(tzOffset) % 60);
    const offsetSign = tzOffset >= 0 ? '+' : '-';

    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetSign}${offsetHours}:${offsetMinutes}`;
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
        context.abortController.abort(); // 触发中止
        // The actual response handling is done in the handleChatCompletion's error handler
        res.status(200).json({ status: 'success', message: `Interrupt signal sent for request ${id}.` });
    } else {
        console.log(`[Interrupt] Received stop signal for non-existent or completed ID: ${id}`);
        res.status(404).json({ status: 'error', message: `Request ${id} not found or already completed.` });
    }
});


async function handleChatCompletion(req, res, forceShowVCP = false) {
    const { default: fetch } = await import('node-fetch');
    const shouldShowVCP = SHOW_VCP_OUTPUT || forceShowVCP; // Combine env var and route-specific flag
    
    // 标准化客户端IP地址
    let clientIp = req.ip;
    if (clientIp && clientIp.substr(0, 7) === "::ffff:") {
        clientIp = clientIp.substr(7);
    }

    const id = req.body.requestId || req.body.messageId; // 兼容 requestId 和 messageId
    const abortController = new AbortController();

    if (id) {
        activeRequests.set(id, { req, res, abortController });
    }

    try {
        let originalBody = req.body;
        await writeDebugLog('LogInput', originalBody);

        let shouldProcessMedia = true;
        if (originalBody.messages && Array.isArray(originalBody.messages)) {
            for (const msg of originalBody.messages) {
                let foundPlaceholderInMsg = false;
                if (msg.role === 'user' || msg.role === 'system') {
                    if (typeof msg.content === 'string' && msg.content.includes('{{ShowBase64}}')) {
                        foundPlaceholderInMsg = true;
                        msg.content = msg.content.replace(/\{\{ShowBase64\}\}/g, '');
                    } else if (Array.isArray(msg.content)) {
                        for (const part of msg.content) {
                            if (part.type === 'text' && typeof part.text === 'string' && part.text.includes('{{ShowBase64}}')) {
                                foundPlaceholderInMsg = true;
                                part.text = part.text.replace(/\{\{ShowBase64\}\}/g, '');
                            }
                        }
                    }
                }
                if (foundPlaceholderInMsg) {
                    shouldProcessMedia = false;
                    if (DEBUG_MODE) console.log('[Server] Media processing disabled by {{ShowBase64}} placeholder.');
                    break;
                }
            }
        }

        // --- Start Message Preprocessing Chain ---
        let processedMessages = originalBody.messages;

        // 1. Handle MultiModalProcessor specifically due to the shouldProcessMedia flag
        if (shouldProcessMedia) {
            // Check for the new plugin name, but also handle the old one for backward compatibility during transition
            const processorName = pluginManager.messagePreprocessors.has("MultiModalProcessor") ? "MultiModalProcessor" : "ImageProcessor";
            if (pluginManager.messagePreprocessors.has(processorName)) {
                if (DEBUG_MODE) console.log(`[Server] Media processing enabled, calling ${processorName} plugin...`);
                try {
                    processedMessages = await pluginManager.executeMessagePreprocessor(processorName, processedMessages);
                } catch (pluginError) {
                    console.error(`[Server] Error executing ${processorName} plugin:`, pluginError);
                }
            }
        }

        // 2. Loop through all other message preprocessors (like VCPTavern)
        for (const name of pluginManager.messagePreprocessors.keys()) {
            if (name === "ImageProcessor" || name === "MultiModalProcessor") continue; // Skip, as it was handled above

            if (DEBUG_MODE) console.log(`[Server] Calling message preprocessor: ${name}`);
            try {
                processedMessages = await pluginManager.executeMessagePreprocessor(name, processedMessages);
            } catch (pluginError) {
                console.error(`[Server] Error executing message preprocessor plugin ${name}:`, pluginError);
                // Continue with the next preprocessor even if one fails
            }
        }
        originalBody.messages = processedMessages;
        // --- End Message Preprocessing Chain ---
        
        if (originalBody.messages && Array.isArray(originalBody.messages)) {
            originalBody.messages = await Promise.all(originalBody.messages.map(async (msg) => {
                const newMessage = JSON.parse(JSON.stringify(msg));
                if (newMessage.content && typeof newMessage.content === 'string') {
                    newMessage.content = await replaceCommonVariables(newMessage.content, originalBody.model, msg.role);
                } else if (Array.isArray(newMessage.content)) {
                    newMessage.content = await Promise.all(newMessage.content.map(async (part) => {
                        if (part.type === 'text' && typeof part.text === 'string') {
                            const newPart = JSON.parse(JSON.stringify(part));
                            newPart.text = await replaceCommonVariables(newPart.text, originalBody.model, msg.role);
                            return newPart;
                        }
                        return part;
                    }));
                }
                return newMessage;
            }));
        }
        await writeDebugLog('LogOutputAfterProcessing', originalBody);
        
        const isOriginalRequestStreaming = originalBody.stream === true;
        // If VCP info needs to be shown, the response MUST be streamed to the client.
        const willStreamResponse = isOriginalRequestStreaming; // Only stream if the original request was a stream.

        let firstAiAPIResponse = await fetch(`${apiUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
                'Accept': willStreamResponse ? 'text/event-stream' : (req.headers['accept'] || 'application/json'),
            },
            // Force stream to be true if we are showing VCP info.
            body: JSON.stringify({ ...originalBody, stream: willStreamResponse }),
            signal: abortController.signal, // 传递中止信号
        });

        const isUpstreamStreaming = willStreamResponse && firstAiAPIResponse.headers.get('content-type')?.includes('text/event-stream');
        
        if (!res.headersSent) {
            res.status(firstAiAPIResponse.status);
            firstAiAPIResponse.headers.forEach((value, name) => {
                if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length', 'keep-alive'].includes(name.toLowerCase())) {
                     res.setHeader(name, value);
                }
            });
            if (isOriginalRequestStreaming && !res.getHeader('Content-Type')?.includes('text/event-stream')) {
                res.setHeader('Content-Type', 'text/event-stream');
                if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
                if (!res.getHeader('Connection')) res.setHeader('Connection', 'keep-alive');
            }
        }

        let firstResponseRawDataForClientAndDiary = ""; // Used for non-streaming and initial diary

        if (isUpstreamStreaming) {
            let currentMessagesForLoop = originalBody.messages ? JSON.parse(JSON.stringify(originalBody.messages)) : [];
            let recursionDepth = 0;
            const maxRecursion = parseInt(process.env.MaxVCPLoopStream) || 5;
            let currentAIContentForLoop = '';
            let currentAIRawDataForDiary = '';

            // Helper function to process an AI response stream
            async function processAIResponseStreamHelper(aiResponse, isInitialCall) {
                return new Promise((resolve, reject) => {
                    let sseBuffer = ""; // Buffer for incomplete SSE lines
                    let collectedContentThisTurn = ""; // Collects textual content from delta
                    let rawResponseDataThisTurn = ""; // Collects all raw chunks for diary

                    const isGpt5Mini = originalBody.model === 'GPT-5-mini';
                    const thinkingRegex = /^Thinking\.\.\.( \(\d+s elapsed\))?$/;
                    let sseLineBuffer = ""; // Buffer for incomplete SSE lines

                    aiResponse.body.on('data', (chunk) => {
                        const chunkString = chunk.toString('utf-8');
                        rawResponseDataThisTurn += chunkString;
                        sseLineBuffer += chunkString;

                        let lines = sseLineBuffer.split('\n');
                        // Keep the last part in buffer if it's not a complete line
                        sseLineBuffer = lines.pop();

                        const filteredLines = [];
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const jsonData = line.substring(5).trim();
                                if (jsonData && jsonData !== '[DONE]') {
                                    try {
                                        const parsedData = JSON.parse(jsonData);
                                        const content = parsedData.choices?.[0]?.delta?.content;
                                        // Core filtering logic
                                        if (isGpt5Mini && content && thinkingRegex.test(content)) {
                                            if (DEBUG_MODE) {
                                                console.log(`[GPT-5-mini-Compat] Intercepted thinking SSE chunk: ${content}`);
                                            }
                                            continue; // Skip this line
                                        }
                                    } catch (e) {
                                        // Not a JSON we care about, pass through
                                    }
                                }
                            }
                            filteredLines.push(line);
                        }
                        
                        if (filteredLines.length > 0) {
                            const filteredChunkString = filteredLines.join('\n') + '\n'; // Re-add newline for valid SSE stream
                            const modifiedChunk = Buffer.from(filteredChunkString, 'utf-8');
                            processChunk(modifiedChunk);
                        }
                    });

                    // Process any remaining data in the buffer on stream end
                    aiResponse.body.on('end', () => {
                        if (sseLineBuffer.trim()) {
                             const modifiedChunk = Buffer.from(sseLineBuffer, 'utf-8');
                             processChunk(modifiedChunk);
                        }
                        // Signal end of processing for this stream helper
                        finalizeStream();
                    });


                    function processChunk(chunk) {
                        const chunkString = chunk.toString('utf-8');
                        let isChunkAnEndOfStreamSignal = false;
                        if (chunkString.includes("data: [DONE]")) {
                            isChunkAnEndOfStreamSignal = true;
                        } else {
                            const linesInChunk = chunkString.split('\n');
                            for (const line of linesInChunk) {
                                if (line.startsWith('data: ')) {
                                    const jsonData = line.substring(5).trim();
                                    if (jsonData === '[DONE]') { // Should be caught by the outer check, but good to be safe
                                        isChunkAnEndOfStreamSignal = true;
                                        break;
                                    }
                                    if (jsonData && !jsonData.startsWith("[")) { // Avoid trying to parse "[DONE]" as JSON
                                        try {
                                            const parsedData = JSON.parse(jsonData);
                                            if (parsedData.choices && parsedData.choices[0] && parsedData.choices[0].finish_reason) {
                                                isChunkAnEndOfStreamSignal = true;
                                                break;
                                            }
                                        } catch(e) { /* ignore parse errors, not a relevant JSON structure */ }
                                    }
                                }
                            }
                        }

                        if (!res.writableEnded) {
                            if (isChunkAnEndOfStreamSignal) {
                                // If the chunk is or contains an end-of-stream signal (DONE or finish_reason),
                                // do not forward it directly. The final [DONE] will be sent by the server's main loop.
                                // Its content will still be collected by the sseBuffer logic below.
                            } else {
                                // (原 filterGrokReasoningStream 调用已移除)
                                // 只有在过滤后仍有内容时才发送，避免发送空的数据块
                                if (chunkString) {
                                    res.write(chunkString);
                                }
                            }
                        }
                        
                        // SSE parsing for content collection
                        sseBuffer += chunkString;
                        let lines = sseBuffer.split('\n');
                        sseBuffer = lines.pop(); // Keep incomplete line for the next 'data' event or 'end'

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const jsonData = line.substring(5).trim();
                                if (jsonData !== '[DONE]' && jsonData) { // Ensure jsonData is not empty and not "[DONE]"
                                    try {
                                        const parsedData = JSON.parse(jsonData);
                                        collectedContentThisTurn += parsedData.choices?.[0]?.delta?.content || '';
                                    } catch (e) { /* ignore parse error for intermediate chunks */ }
                                }
                            }
                        }
                    }

                    function finalizeStream() {
                        // Process remaining sseBuffer for content
                        if (sseBuffer.trim().length > 0) {
                            const finalLines = sseBuffer.split('\n');
                            for (const line of finalLines) {
                                const trimmedLine = line.trim();
                                if (trimmedLine.startsWith('data: ')) {
                                    const jsonData = trimmedLine.substring(5).trim();
                                    if (jsonData !== '[DONE]' && jsonData) { // Ensure jsonData is not empty and not "[DONE]"
                                        try {
                                            const parsedData = JSON.parse(jsonData);
                                            collectedContentThisTurn += parsedData.choices?.[0]?.delta?.content || '';
                                        } catch (e) { /* ignore */ }
                                    }
                                }
                            }
                        }
                        resolve({ content: collectedContentThisTurn, raw: rawResponseDataThisTurn });
                    }
                    aiResponse.body.on('error', (streamError) => {
                        console.error("Error reading AI response stream in loop:", streamError);
                        if (!res.writableEnded) {
                            // Try to send an error message before closing if possible
                            try {
                                res.write(`data: ${JSON.stringify({error: "STREAM_READ_ERROR", message: streamError.message})}\n\n`);
                            } catch (e) { /* ignore if write fails */ }
                            res.end();
                        }
                        reject(streamError);
                    });
                });
            }

            // --- Initial AI Call ---
            if (DEBUG_MODE) console.log('[VCP Stream Loop] Processing initial AI call.');
            let initialAIResponseData = await processAIResponseStreamHelper(firstAiAPIResponse, true);
            currentAIContentForLoop = initialAIResponseData.content;
            currentAIRawDataForDiary = initialAIResponseData.raw;
            handleDiaryFromAIResponse(currentAIRawDataForDiary).catch(e => console.error('[VCP Stream Loop] Error in initial diary handling:', e));
            if (DEBUG_MODE) console.log('[VCP Stream Loop] Initial AI content (first 200):', currentAIContentForLoop.substring(0,200));

            // --- VCP Loop ---
            while (recursionDepth < maxRecursion) {
                currentMessagesForLoop.push({ role: 'assistant', content: currentAIContentForLoop });

                const toolRequestStartMarker = "<<<[TOOL_REQUEST]>>>";
                const toolRequestEndMarker = "<<<[END_TOOL_REQUEST]>>>";
                let toolCallsInThisAIResponse = [];
                let searchOffset = 0;

                while (searchOffset < currentAIContentForLoop.length) {
                    const startIndex = currentAIContentForLoop.indexOf(toolRequestStartMarker, searchOffset);
                    if (startIndex === -1) break;

                    const endIndex = currentAIContentForLoop.indexOf(toolRequestEndMarker, startIndex + toolRequestStartMarker.length);
                    if (endIndex === -1) {
                        if (DEBUG_MODE) console.warn("[VCP Stream Loop] Found TOOL_REQUEST_START but no END marker after offset", searchOffset);
                        searchOffset = startIndex + toolRequestStartMarker.length;
                        continue;
                    }

                    const requestBlockContent = currentAIContentForLoop.substring(startIndex + toolRequestStartMarker.length, endIndex).trim();
                    let parsedToolArgs = {};
                    let requestedToolName = null;
                    const paramRegex = /([\w_]+)\s*:\s*「始」([\s\S]*?)「末」\s*(?:,)?/g;
                    let regexMatch;
                    while ((regexMatch = paramRegex.exec(requestBlockContent)) !== null) {
                        const key = regexMatch[1];
                        const value = regexMatch[2].trim();
                        if (key === "tool_name") requestedToolName = value;
                        else parsedToolArgs[key] = value;
                    }

                    if (requestedToolName) {
                        toolCallsInThisAIResponse.push({ name: requestedToolName, args: parsedToolArgs });
                         if (DEBUG_MODE) console.log(`[VCP Stream Loop] Parsed tool request: ${requestedToolName}`, parsedToolArgs);
                    } else {
                        if (DEBUG_MODE) console.warn("[VCP Stream Loop] Parsed a tool request block but no tool_name found:", requestBlockContent.substring(0,100));
                    }
                    searchOffset = endIndex + toolRequestEndMarker.length;
                }

                if (toolCallsInThisAIResponse.length === 0) {
                    if (DEBUG_MODE) console.log('[VCP Stream Loop] No tool calls found in AI response. Sending final signals and exiting loop.');
                    if (!res.writableEnded) {
                        // Construct and send the final chunk with finish_reason 'stop'
                        const finalChunkPayload = {
                            id: `chatcmpl-VCP-final-stop-${Date.now()}`,
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: originalBody.model,
                            choices: [{
                                index: 0,
                                delta: {},
                                finish_reason: 'stop'
                            }]
                        };
                        res.write(`data: ${JSON.stringify(finalChunkPayload)}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                    break;
                }
                if (DEBUG_MODE) console.log(`[VCP Stream Loop] Found ${toolCallsInThisAIResponse.length} tool calls. Iteration ${recursionDepth + 1}.`);

                let allToolResultsContentForAI = [];
                const toolExecutionPromises = toolCallsInThisAIResponse.map(async (toolCall) => {
                    let toolResultText; // For logs and simple text display
                    let toolResultContentForAI; // For the next AI call (can be rich content)

                    if (pluginManager.getPlugin(toolCall.name)) {
                        try {
                            if (DEBUG_MODE) console.log(`[VCP Stream Loop] Executing tool: ${toolCall.name} with args:`, toolCall.args);
                            const pluginResult = await pluginManager.processToolCall(toolCall.name, toolCall.args, clientIp);
                            await writeDebugLog(`VCP-Stream-Result-${toolCall.name}`, { args: toolCall.args, result: pluginResult });
                            
                            // Always create a text version for logging/VCP output
                            toolResultText = (pluginResult !== undefined && pluginResult !== null) ? (typeof pluginResult === 'object' ? JSON.stringify(pluginResult, null, 2) : String(pluginResult)) : `插件 ${toolCall.name} 执行完毕，但没有返回明确内容。`;

                            // Check for rich content to pass to the AI
                            let richContentPayload = null;
                            if (typeof pluginResult === 'object' && pluginResult) {
                                // Standard local plugin structure
                                if (pluginResult.data && Array.isArray(pluginResult.data.content)) {
                                    richContentPayload = pluginResult.data.content;
                                }
                                // Structure from distributed FileOperator plugin or new image gen plugins
                                else if (Array.isArray(pluginResult.content)) {
                                    richContentPayload = pluginResult.content;
                                }
                            }

                            if (richContentPayload) {
                                // If it's rich content, use it for the AI
                                toolResultContentForAI = richContentPayload;
                                
                                // For logging, find the text part to make it human-readable
                                const textPart = richContentPayload.find(p => p.type === 'text');
                                toolResultText = textPart ? textPart.text : `[Rich Content with types: ${richContentPayload.map(p => p.type).join(', ')}]`;
                            } else {
                                // If not rich content, use the original text representation for both AI and logging
                                toolResultContentForAI = [{ type: 'text', text: `来自工具 "${toolCall.name}" 的结果:\n${toolResultText}` }];
                                // toolResultText is already set correctly in this case from the initial assignment
                            }

                            // Push to VCPLog via WebSocketServer (for VCP call logging)
                            webSocketServer.broadcast({
                                type: 'vcp_log',
                                data: { tool_name: toolCall.name, status: 'success', content: toolResultText, source: 'stream_loop' }
                            }, 'VCPLog');

                            // WebSocket push for the plugin's actual result
                            const pluginManifestForStream = pluginManager.getPlugin(toolCall.name);
                            if (pluginManifestForStream && pluginManifestForStream.webSocketPush && pluginManifestForStream.webSocketPush.enabled) {
                                const wsPushMessageStream = {
                                    type: pluginManifestForStream.webSocketPush.messageType || `vcp_tool_result_${toolCall.name}`,
                                    data: pluginResult
                                };
                                webSocketServer.broadcast(wsPushMessageStream, pluginManifestForStream.webSocketPush.targetClientType || null);
                                if (DEBUG_MODE) console.log(`[VCP Stream Loop] WebSocket push for ${toolCall.name} (success) processed.`);
                            }

                            if (shouldShowVCP && !res.writableEnded) {
                                vcpInfoHandler.streamVcpInfo(res, originalBody.model, toolCall.name, 'success', pluginResult);
                            }
                        } catch (pluginError) {
                             console.error(`[VCP Stream Loop EXECUTION ERROR] Error executing plugin ${toolCall.name}:`, pluginError.message);
                             toolResultText = `执行插件 ${toolCall.name} 时发生错误：${pluginError.message || '未知错误'}`;
                             toolResultContentForAI = [{ type: 'text', text: `来自工具 "${toolCall.name}" 的结果:\n${toolResultText}` }];
                             webSocketServer.broadcast({
                                type: 'vcp_log',
                                data: { tool_name: toolCall.name, status: 'error', content: toolResultText, source: 'stream_loop_error' }
                            }, 'VCPLog');
                             if (shouldShowVCP && !res.writableEnded) {
                                vcpInfoHandler.streamVcpInfo(res, originalBody.model, toolCall.name, 'error', toolResultText);
                             }
                        }
                    } else {
                        toolResultText = `错误：未找到名为 "${toolCall.name}" 的插件。`;
                        toolResultContentForAI = [{ type: 'text', text: toolResultText }];
                        if (DEBUG_MODE) console.warn(`[VCP Stream Loop] ${toolResultText}`);
                        webSocketServer.broadcast({
                            type: 'vcp_log',
                            data: { tool_name: toolCall.name, status: 'error', content: toolResultText, source: 'stream_loop_not_found' }
                        }, 'VCPLog');
                        if (shouldShowVCP && !res.writableEnded) {
                            vcpInfoHandler.streamVcpInfo(res, originalBody.model, toolCall.name, 'error', toolResultText);
                        }
                    }
                    return toolResultContentForAI;
                });

                const toolResults = await Promise.all(toolExecutionPromises);
                const combinedToolResultsForAI = toolResults.flat(); // Flatten the array of content arrays
                await writeDebugLog('LogToolResultForAI-Stream', { role: 'user', content: combinedToolResultsForAI });
                currentMessagesForLoop.push({ role: 'user', content: combinedToolResultsForAI });
                if (DEBUG_MODE) console.log('[VCP Stream Loop] Combined tool results for next AI call (first 200):', JSON.stringify(combinedToolResultsForAI).substring(0,200));

                // --- Make next AI call (stream: true) ---
                if (!res.writableEnded) {
                    res.write('\n'); // 在下一个AI响应开始前，向客户端发送一个换行符
                }
                if (DEBUG_MODE) console.log('[VCP Stream Loop] Fetching next AI response.');
                const nextAiAPIResponse = await fetch(`${apiUrl}/v1/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                        ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
                        'Accept': 'text/event-stream', // Ensure streaming for subsequent calls
                    },
                    body: JSON.stringify({ ...originalBody, messages: currentMessagesForLoop, stream: true }),
                    signal: abortController.signal, // 传递中止信号
                });

                if (!nextAiAPIResponse.ok) {
                    const errorBodyText = await nextAiAPIResponse.text();
                    console.error(`[VCP Stream Loop] AI call in loop failed (${nextAiAPIResponse.status}): ${errorBodyText}`);
                    if (!res.writableEnded) {
                        try {
                            res.write(`data: ${JSON.stringify({error: "AI_CALL_FAILED_IN_LOOP", status: nextAiAPIResponse.status, message: errorBodyText})}\n\n`);
                        } catch (e) { /* ignore */ }
                    }
                    break;
                }
                
                // Process the stream from the next AI call
                let nextAIResponseData = await processAIResponseStreamHelper(nextAiAPIResponse, false);
                currentAIContentForLoop = nextAIResponseData.content;
                currentAIRawDataForDiary = nextAIResponseData.raw;
                handleDiaryFromAIResponse(currentAIRawDataForDiary).catch(e => console.error(`[VCP Stream Loop] Error in diary handling for depth ${recursionDepth}:`, e));
                if (DEBUG_MODE) console.log('[VCP Stream Loop] Next AI content (first 200):', currentAIContentForLoop.substring(0,200));
                
                recursionDepth++;
            }

            // After loop, check if max recursion was hit and response is still open
            if (recursionDepth >= maxRecursion && !res.writableEnded) {
                if (DEBUG_MODE) console.log('[VCP Stream Loop] Max recursion reached. Sending final signals.');
                // Construct and send the final chunk with finish_reason 'length'
                const finalChunkPayload = {
                    id: `chatcmpl-VCP-final-length-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: originalBody.model,
                    choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: 'length'
                    }]
                };
                res.write(`data: ${JSON.stringify(finalChunkPayload)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            }

        } else { // Non-streaming (originalBody.stream === false)
            const firstArrayBuffer = await firstAiAPIResponse.arrayBuffer();
            const responseBuffer = Buffer.from(firstArrayBuffer);
            const aiResponseText = responseBuffer.toString('utf-8');
            // firstResponseRawDataForClientAndDiary is used by the non-streaming logic later
            firstResponseRawDataForClientAndDiary = aiResponseText;

            let fullContentFromAI = ''; // This will be populated by the non-streaming logic
            try {
                const parsedJson = JSON.parse(aiResponseText);
                fullContentFromAI = parsedJson.choices?.[0]?.message?.content || '';
            } catch (e) {
                if (DEBUG_MODE) console.warn('[PluginCall] First AI response (non-stream) not valid JSON. Raw:', aiResponseText.substring(0, 200));
                fullContentFromAI = aiResponseText; // Use raw text if not JSON
            }
            
            // --- Non-streaming VCP Loop ---
            let recursionDepth = 0;
            const maxRecursion = parseInt(process.env.MaxVCPLoopNonStream) || 5;
            let conversationHistoryForClient = []; // To build the final response for client
            let currentAIContentForLoop = fullContentFromAI; // Start with the first AI's response content
            let currentMessagesForNonStreamLoop = originalBody.messages ? JSON.parse(JSON.stringify(originalBody.messages)) : [];
            // `firstResponseRawDataForClientAndDiary` holds the raw first AI response for diary purposes.
            // Subsequent raw AI responses in the non-stream loop will also need diary handling.
            let accumulatedRawResponseDataForDiary = firstResponseRawDataForClientAndDiary;

            do {
                let anyToolProcessedInCurrentIteration = false; // Reset for each iteration of the outer AI-Tool-AI loop
                // Add the *current* AI content to the client history *before* processing it for tools
                // Add the *current* AI content to the client history *before* processing it for tools
                conversationHistoryForClient.push(currentAIContentForLoop);

                const toolRequestStartMarker = "<<<[TOOL_REQUEST]>>>";
                const toolRequestEndMarker = "<<<[END_TOOL_REQUEST]>>>";
                let toolCallsInThisAIResponse = []; // Stores {name, args} for each tool call found in currentAIContentForLoop
                
                let searchOffset = 0;
                while (searchOffset < currentAIContentForLoop.length) {
                    const startIndex = currentAIContentForLoop.indexOf(toolRequestStartMarker, searchOffset);
                    if (startIndex === -1) break; // No more start markers

                    const endIndex = currentAIContentForLoop.indexOf(toolRequestEndMarker, startIndex + toolRequestStartMarker.length);
                    if (endIndex === -1) {
                        if (DEBUG_MODE) console.warn("[Multi-Tool] Found TOOL_REQUEST_START but no END marker after offset", searchOffset);
                        searchOffset = startIndex + toolRequestStartMarker.length; // Skip malformed start
                        continue;
                    }

                    const requestBlockContent = currentAIContentForLoop.substring(startIndex + toolRequestStartMarker.length, endIndex).trim();
                    let parsedToolArgs = {};
                    let requestedToolName = null;
                    const paramRegex = /([\w_]+)\s*:\s*「始」([\s\S]*?)「末」\s*(?:,)?/g;
                    let regexMatch;
                    while ((regexMatch = paramRegex.exec(requestBlockContent)) !== null) {
                        const key = regexMatch[1];
                        const value = regexMatch[2].trim();
                        if (key === "tool_name") requestedToolName = value;
                        else parsedToolArgs[key] = value;
                    }

                    if (requestedToolName) {
                        toolCallsInThisAIResponse.push({ name: requestedToolName, args: parsedToolArgs });
                    } else {
                        if (DEBUG_MODE) console.warn("[Multi-Tool] Parsed a tool request block but no tool_name found:", requestBlockContent);
                    }
                    searchOffset = endIndex + toolRequestEndMarker.length; // Move past the processed block
                }

                if (toolCallsInThisAIResponse.length > 0) {
                    anyToolProcessedInCurrentIteration = true; // At least one tool request was found in the AI's response
                    let allToolResultsContentForAI = [];

                    // Add the AI's full response (that contained the tool requests) to the messages for the next AI call
                    currentMessagesForNonStreamLoop.push({ role: 'assistant', content: currentAIContentForLoop });

                    // Use Promise.all to execute tool calls potentially in parallel, though JS is single-threaded
                    // The main benefit here is cleaner async/await handling for multiple calls.
                    const toolExecutionPromises = toolCallsInThisAIResponse.map(async (toolCall) => {
                        let toolResultText; // For logs and simple text display
                        let toolResultContentForAI; // For the next AI call (can be rich content)

                        if (pluginManager.getPlugin(toolCall.name)) {
                            try {
                                if (DEBUG_MODE) console.log(`[Multi-Tool] Executing tool: ${toolCall.name} with args:`, toolCall.args);
                                // 将标准化的 clientIp 传递给 processToolCall
                                const pluginResult = await pluginManager.processToolCall(toolCall.name, toolCall.args, clientIp);
                                await writeDebugLog(`VCP-NonStream-Result-${toolCall.name}`, { args: toolCall.args, result: pluginResult });
                                
                                // Always create a text version for logging/VCP output
                                toolResultText = (pluginResult !== undefined && pluginResult !== null) ? (typeof pluginResult === 'object' ? JSON.stringify(pluginResult, null, 2) : String(pluginResult)) : `插件 ${toolCall.name} 执行完毕，但没有返回明确内容。`;

                                // Check for rich content to pass to the AI
                                let richContentPayload = null;
                                if (typeof pluginResult === 'object' && pluginResult) {
                                    // Standard local plugin structure
                                    if (pluginResult.data && Array.isArray(pluginResult.data.content)) {
                                        richContentPayload = pluginResult.data.content;
                                    }
                                    // Structure from distributed FileOperator plugin or new image gen plugins
                                    else if (Array.isArray(pluginResult.content)) {
                                        richContentPayload = pluginResult.content;
                                    }
                                }

                                if (richContentPayload) {
                                    // If it's rich content, use it for the AI
                                    toolResultContentForAI = richContentPayload;
                                    
                                    // For logging, find the text part to make it human-readable
                                    const textPart = richContentPayload.find(p => p.type === 'text');
                                    toolResultText = textPart ? textPart.text : `[Rich Content with types: ${richContentPayload.map(p => p.type).join(', ')}]`;
                                } else {
                                    // If not rich content, use the original text representation for both AI and logging
                                    toolResultContentForAI = [{ type: 'text', text: `来自工具 "${toolCall.name}" 的结果:\n${toolResultText}` }];
                                    // toolResultText is already set correctly in this case from the initial assignment
                                }

                                // Push to VCPLog via WebSocketServer (for VCP call logging)
                                webSocketServer.broadcast({
                                   type: 'vcp_log',
                                   data: { tool_name: toolCall.name, status: 'success', content: toolResultText, source: 'non_stream_loop' }
                                }, 'VCPLog');

                                // WebSocket push for the plugin's actual result
                                const pluginManifestNonStream = pluginManager.getPlugin(toolCall.name);
                                if (pluginManifestNonStream && pluginManifestNonStream.webSocketPush && pluginManifestNonStream.webSocketPush.enabled) {
                                    const wsPushMessageNonStream = {
                                        type: pluginManifestNonStream.webSocketPush.messageType || `vcp_tool_result_${toolCall.name}`,
                                        data: pluginResult
                                    };
                                    webSocketServer.broadcast(wsPushMessageNonStream, pluginManifestNonStream.webSocketPush.targetClientType || null);
                                    if (DEBUG_MODE) console.log(`[Multi-Tool] WebSocket push for ${toolCall.name} (success) processed.`);
                                }

                                if (shouldShowVCP) {
                                    const vcpText = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, 'success', pluginResult);
                                    if (vcpText) conversationHistoryForClient.push(vcpText);
                                }
                            } catch (pluginError) {
                                 console.error(`[Multi-Tool EXECUTION ERROR] Error executing plugin ${toolCall.name}:`, pluginError.message);
                                 toolResultText = `执行插件 ${toolCall.name} 时发生错误：${pluginError.message || '未知错误'}`;
                                 toolResultContentForAI = [{ type: 'text', text: `来自工具 "${toolCall.name}" 的结果:\n${toolResultText}` }];
                                 webSocketServer.broadcast({
                                    type: 'vcp_log',
                                    data: { tool_name: toolCall.name, status: 'error', content: toolResultText, source: 'non_stream_loop_error' }
                                }, 'VCPLog');
                                 if (shouldShowVCP) {
                                     const vcpText = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, 'error', toolResultText);
                                     if (vcpText) conversationHistoryForClient.push(vcpText);
                                 }
                            }
                        } else {
                            toolResultText = `错误：未找到名为 "${toolCall.name}" 的插件。`;
                            toolResultContentForAI = [{ type: 'text', text: toolResultText }];
                            if (DEBUG_MODE) console.warn(`[Multi-Tool] ${toolResultText}`);
                           webSocketServer.broadcast({
                               type: 'vcp_log',
                               data: { tool_name: toolCall.name, status: 'error', content: toolResultText, source: 'non_stream_loop_not_found' }
                           }, 'VCPLog');
                            if (shouldShowVCP) {
                                const vcpText = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, 'error', toolResultText);
                                if (vcpText) conversationHistoryForClient.push(vcpText);
                            }
                        }
                        return toolResultContentForAI;
                    });

                    // Wait for all tool executions to complete
                    const toolResults = await Promise.all(toolExecutionPromises);

                    const combinedToolResultsForAI = toolResults.flat(); // Flatten the array of content arrays
                    await writeDebugLog('LogToolResultForAI-NonStream', { role: 'user', content: combinedToolResultsForAI });
                    currentMessagesForNonStreamLoop.push({ role: 'user', content: combinedToolResultsForAI });

                    // Fetch the next AI response
                    if (DEBUG_MODE) console.log("[Multi-Tool] Fetching next AI response after processing tools.");
                    const recursionAiResponse = await fetch(`${apiUrl}/v1/chat/completions`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`,
                            ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
                            'Accept': 'application/json',
                        },
                        body: JSON.stringify({ ...originalBody, messages: currentMessagesForNonStreamLoop, stream: false }),
                        signal: abortController.signal, // 传递中止信号
                    });

                    if (!recursionAiResponse.ok) {
                        const errorBodyText = await recursionAiResponse.text();
                        console.error(`[Multi-Tool] AI call in loop failed (${recursionAiResponse.status}): ${errorBodyText}`);
                        if (SHOW_VCP_OUTPUT) {
                            conversationHistoryForClient.push({ type: 'vcp', content: `AI call failed with status ${recursionAiResponse.status}: ${errorBodyText}` });
                        }
                        // Break the loop on AI error
                        break;
                    }

                    const recursionArrayBuffer = await recursionAiResponse.arrayBuffer();
                    const recursionBuffer = Buffer.from(recursionArrayBuffer);
                    const recursionText = recursionBuffer.toString('utf-8');
                    // Consider appending recursionText to rawResponseDataForDiary if needed for multi-tool turn

                    try {
                        const recursionJson = JSON.parse(recursionText);
                        currentAIContentForLoop = "\n" + (recursionJson.choices?.[0]?.message?.content || '');
                    } catch (e) {
                        currentAIContentForLoop = "\n" + recursionText;
                    }
                } else {
                    // No tool calls found in the currentAIContentForLoop, so this is the final AI response.
                    anyToolProcessedInCurrentIteration = false;
                }
                
                // Exit the outer loop if no tools were processed in this iteration
                if (!anyToolProcessedInCurrentIteration) break;
                recursionDepth++;
            } while (recursionDepth < maxRecursion);

            // --- Finalize Non-Streaming Response ---
            const finalContentForClient = conversationHistoryForClient.join('');

            let finalJsonResponse;
            try {
                // Try to reuse the structure of the *first* AI response
                finalJsonResponse = JSON.parse(aiResponseText);
                 if (!finalJsonResponse.choices || !Array.isArray(finalJsonResponse.choices) || finalJsonResponse.choices.length === 0) {
                    finalJsonResponse.choices = [{ message: {} }];
                }
                if (!finalJsonResponse.choices[0].message) {
                    finalJsonResponse.choices[0].message = {};
                }
                // Overwrite the content with the full conversation history
                finalJsonResponse.choices[0].message.content = finalContentForClient;
                // Optionally update finish_reason if needed, e.g., if maxRecursion was hit
                if (recursionDepth >= maxRecursion) {
                     finalJsonResponse.choices[0].finish_reason = 'length'; // Or 'tool_calls' if appropriate
                } else {
                     finalJsonResponse.choices[0].finish_reason = 'stop'; // Assume normal stop if loop finished early
                }

            } catch (e) {
                // Fallback if the first response wasn't valid JSON
                finalJsonResponse = { choices: [{ index: 0, message: { role: 'assistant', content: finalContentForClient }, finish_reason: (recursionDepth >= maxRecursion ? 'length' : 'stop') }] };
            }

            if (!res.writableEnded) {
                 res.send(Buffer.from(JSON.stringify(finalJsonResponse)));
            }
            // Handle diary for the *first* AI response in non-streaming mode
            await handleDiaryFromAIResponse(firstResponseRawDataForClientAndDiary);
        }
    } catch (error) {
        console.error('处理请求或转发时出错:', error.message, error.stack);
        // 新增：处理 AbortError
        if (error.name === 'AbortError') {
            console.log(`[Abort] Request ${id} was aborted by the user.`);
            if (!res.headersSent) {
                // 非流式请求被中止
                res.status(200).json({
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: '请求已中止' },
                        finish_reason: 'stop'
                    }]
                });
            } else if (!res.writableEnded) {
                // 流式请求被中止，优雅地结束它
                res.write('data: [DONE]\n\n');
                res.end();
            }
            return; // 确保在中止后不再执行其他错误处理
        }

        if (!res.headersSent) {
             res.status(500).json({ error: 'Internal Server Error', details: error.message });
        } else if (!res.writableEnded) {
             console.error('[STREAM ERROR] Headers already sent. Cannot send JSON error. Ending stream if not already ended.');
             res.end();
        }
    } finally {
        // 确保在请求结束时从池中移除
        if (id) {
            activeRequests.delete(id);
        }
    }
}

// Route for standard chat completions. VCP info is shown based on the .env config.
app.post('/v1/chat/completions', (req, res) => {
    handleChatCompletion(req, res, false);
});

// Route to force VCP info to be shown, regardless of the .env config.
app.post('/v1/chatvcp/completions', (req, res) => {
    handleChatCompletion(req, res, true);
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

            // Extract Maid, Date, Content from noteBlockContent
            const lines = noteBlockContent.trim().split('\n');
            let maidName = null;
            let dateString = null;
            let contentLines = [];
            let isContentSection = false;

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine.startsWith('Maid:')) {
                    maidName = trimmedLine.substring(5).trim();
                    isContentSection = false;
                } else if (trimmedLine.startsWith('Date:')) {
                    dateString = trimmedLine.substring(5).trim();
                    isContentSection = false;
                } else if (trimmedLine.startsWith('Content:')) {
                    isContentSection = true;
                    const firstContentPart = trimmedLine.substring(8).trim();
                    if (firstContentPart) contentLines.push(firstContentPart);
                } else if (isContentSection) {
                    contentLines.push(line);
                }
            }
            const contentText = contentLines.join('\n').trim();

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
                console.error('[handleDiaryFromAIResponse] Could not extract Maid, Date, or Content from daily note block:', { maidName, dateString, contentText: contentText?.substring(0,50) });
            }
        }
    }
}

// --- Admin API Router (Moved to routes/adminPanelRoutes.js) ---

// Define dailyNoteRootPath here as it's needed by the adminPanelRoutes module
// and was previously defined within the moved block.
const dailyNoteRootPath = path.join(__dirname, 'dailynote');

// Import and use the admin panel routes, passing the getter for currentServerLogPath
const adminPanelRoutes = require('./routes/adminPanelRoutes')(
    DEBUG_MODE,
    dailyNoteRootPath,
    pluginManager,
    () => currentServerLogPath // Getter function for currentServerLogPath
);

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
    console.log('开始加载插件...');
    await pluginManager.loadPlugins();
    console.log('插件加载完成。');
    pluginManager.setProjectBasePath(__dirname);
    
    console.log('开始初始化服务类插件...');
    await pluginManager.initializeServices(app, adminPanelRoutes, __dirname);
    // 在所有服务插件都注册完路由后，再将 adminApiRouter 挂载到主 app 上
    app.use('/admin_api', adminPanelRoutes);
    console.log('服务类插件初始化完成，管理面板 API 路由已挂载。');

    console.log('开始初始化静态插件...');
    await pluginManager.initializeStaticPlugins();
    console.log('静态插件初始化完成。'); // Keep
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

server = app.listen(port, async () => { // Assign to server variable
    console.log(`中间层服务器正在监听端口 ${port}`);
    console.log(`API 服务器地址: ${apiUrl}`);
    // ensureDebugLogDir() is effectively handled by initializeServerLogger() synchronously earlier.
    // If ensureDebugLogDirAsync was meant for other purposes, it can be called where needed.
    await initialize(); // This loads plugins and initializes services

    // Initialize the new WebSocketServer
    if (DEBUG_MODE) console.log('[Server] Initializing WebSocketServer...');
    const vcpKeyValue = pluginManager.getResolvedPluginConfigValue('VCPLog', 'VCP_Key') || process.env.VCP_Key;
    webSocketServer.initialize(server, { debugMode: DEBUG_MODE, vcpKey: vcpKeyValue });
    
    // --- 注入依赖 ---
    pluginManager.setWebSocketServer(webSocketServer);
    webSocketServer.setPluginManager(pluginManager);
    
    // 初始化 FileFetcherServer
    FileFetcherServer.initialize(webSocketServer);

    if (DEBUG_MODE) console.log('[Server] WebSocketServer, PluginManager, and FileFetcherServer have been interconnected.');

    // The VCPLog plugin's attachWebSocketServer is no longer needed here as WebSocketServer handles it.
    // const vcpLogPluginModule = pluginManager.serviceModules.get("VCPLog")?.module;
    // if (vcpLogPluginModule && typeof vcpLogPluginModule.attachWebSocketServer === 'function') {
    //     if (DEBUG_MODE) console.log('[Server] Attaching WebSocket server for VCPLog plugin...');
    //     vcpLogPluginModule.attachWebSocketServer(server); // Pass the http.Server instance
    // } else {
    //     if (DEBUG_MODE) console.warn('[Server] VCPLog plugin module or attachWebSocketServer function not found.');
    // }
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

    if (serverLogWriteStream) {
        console.log('[Server] Closing server log file stream...');
        const logClosePromise = new Promise((resolve) => {
            serverLogWriteStream.end(`[${new Date().toLocaleString()}] Server gracefully shut down.\n`, () => {
                originalConsoleLog('[Server] Server log stream closed.'); // Use original console here as overridden one might rely on the stream
                resolve();
            });
        });
        await logClosePromise; // Wait for log stream to close
    }

    console.log('Graceful shutdown complete. Exiting.');
    process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Ensure log stream is flushed on uncaught exceptions or synchronous exit, though less reliable
process.on('exit', (code) => {
    originalConsoleLog(`[Server] Exiting with code ${code}.`);
    if (serverLogWriteStream && !serverLogWriteStream.destroyed) {
        try {
            // Attempt a final synchronous write if possible, though not guaranteed
            fsSync.appendFileSync(currentServerLogPath, `[${new Date().toLocaleString()}] Server exited with code ${code}.\n`);
            serverLogWriteStream.end(); // Attempt to close if not already
        } catch (e) {
            originalConsoleError('[Server] Error during final log write on exit:', e.message);
        }
    }
});