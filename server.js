// server.js
const express = require('express');
const dotenv = require('dotenv');
const schedule = require('node-schedule');
const lunarCalendar = require('chinese-lunar-calendar');
const fs = require('fs').promises;
const path = require('path');
const { Writable } = require('stream');
const crypto = require('crypto');
const pluginManager = require('./Plugin.js');
const basicAuth = require('basic-auth');

dotenv.config({ path: 'config.env' });

const ADMIN_USERNAME = process.env.AdminUsername;
const ADMIN_PASSWORD = process.env.AdminPassword;

const DEBUG_MODE = (process.env.DebugMode || "False").toLowerCase() === "true";
const DEBUG_LOG_DIR = path.join(__dirname, 'DebugLog');
const SHOW_VCP_OUTPUT = (process.env.ShowVCP || "False").toLowerCase() === "true"; // 读取 ShowVCP 环境变量

async function ensureDebugLogDir() {
    if (DEBUG_MODE) {
        try {
            await fs.mkdir(DEBUG_LOG_DIR, { recursive: true });
        } catch (error) {
            console.error(`创建 DebugLog 目录失败: ${DEBUG_LOG_DIR}`, error);
        }
    }
}

async function writeDebugLog(filenamePrefix, data) {
    if (DEBUG_MODE) {
        await ensureDebugLogDir();
        const now = new Date();
        const timestamp = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}_${now.getMilliseconds().toString().padStart(3, '0')}`;
        const filename = `${filenamePrefix}-${timestamp}.txt`;
        const filePath = path.join(DEBUG_LOG_DIR, filename);
        try {
            await fs.writeFile(filePath, JSON.stringify(data, null, 2));
            console.log(`[DebugLog] 已记录日志: ${filename}`);
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
const port = process.env.PORT;
const apiKey = process.env.API_Key;
const apiUrl = process.env.API_URL;
const serverKey = process.env.Key;

const cachedEmojiLists = new Map();

app.use(express.json({ limit: '300mb' }));
app.use(express.urlencoded({ limit: '300mb', extended: true }));

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

app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleString()}] Received ${req.method} request for ${req.url} from ${req.ip}`);
    next();
});

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

    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${serverKey}`) {
        return res.status(401).json({ error: 'Unauthorized (Bearer token required)' });
    }
    next();
});

// This function is no longer needed as the EmojiListGenerator plugin handles generation.
// async function updateAndLoadAgentEmojiList(agentName, dirPath, filePath) { ... }

async function replaceCommonVariables(text) {
    if (text == null) return '';
    let processedText = String(text);
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
    processedText = processedText.replace(/\{\{VCPWeatherInfo\}\}/g, pluginManager.getPlaceholderValue("{{VCPWeatherInfo}}") || '天气信息不可用');
    // processedText = processedText.replace(/\{\{VCPDescription\}\}/g, pluginManager.getVCPDescription() || '插件描述信息不可用'); // Deprecated

    // Replace individual VCP plugin descriptions
    const individualPluginDescriptions = pluginManager.getIndividualPluginDescriptions();
    if (individualPluginDescriptions && individualPluginDescriptions.size > 0) {
        for (const [placeholderKey, description] of individualPluginDescriptions) {
            // placeholderKey is already like "VCPPluginName"
            processedText = processedText.replaceAll(`{{${placeholderKey}}}`, description || `[${placeholderKey} 信息不可用]`);
        }
    }

    if (process.env.EmojiPrompt) {
        processedText = processedText.replaceAll('{{EmojiPrompt}}', process.env.EmojiPrompt);
    }
    for (const envKey in process.env) {
        if (envKey.startsWith('Var')) {
            const placeholder = `{{${envKey}}}`;
            const value = process.env[envKey];
            processedText = processedText.replaceAll(placeholder, value || `未配置${envKey}`);
        }
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
    if (processedText.includes('{{EmojiList}}') && process.env.EmojiList) {
        const emojiListFileName = process.env.EmojiList;
        const emojiCacheKey = emojiListFileName.replace(/\.txt$/i, '').trim();
        const specificEmojiListContent = cachedEmojiLists.get(emojiCacheKey);
        if (specificEmojiListContent !== undefined) {
            processedText = processedText.replaceAll('{{EmojiList}}', specificEmojiListContent);
        } else {
            processedText = processedText.replaceAll('{{EmojiList}}', `[名为 ${emojiCacheKey} 的表情列表不可用 (源: ${emojiListFileName})]`);
            if (DEBUG_MODE) console.warn(`[EmojiList Variable] 未能从缓存中找到 ${emojiCacheKey} 的列表.`);
        }
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
    for (const rule of superDetectors) {
        if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
            processedText = processedText.replaceAll(rule.detector, rule.output);
        }
    }
    return processedText;
}

app.post('/v1/chat/completions', async (req, res) => {
    const { default: fetch } = await import('node-fetch');
    try {
        let originalBody = req.body;
        await writeDebugLog('LogInput', originalBody);

        let shouldProcessImages = true;
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
                    shouldProcessImages = false;
                    if (DEBUG_MODE) console.log('[Server] Image processing disabled by {{ShowBase64}} placeholder.');
                    break;
                }
            }
        }

        if (shouldProcessImages) {
            if (DEBUG_MODE) console.log('[Server] Image processing enabled, calling ImageProcessor plugin...');
            if (DEBUG_MODE) console.log('[Server Pre-ImageProcessor] Messages:', JSON.stringify(originalBody.messages, null, 2).substring(0, 500) + "..."); // Log before call
            try {
                originalBody.messages = await pluginManager.executeMessagePreprocessor("ImageProcessor", originalBody.messages);
                if (DEBUG_MODE) console.log('[Server Post-ImageProcessor] Messages:', JSON.stringify(originalBody.messages, null, 2).substring(0, 500) + "..."); // Log after call
            } catch (pluginError) {
                console.error('[Server] Error executing ImageProcessor plugin:', pluginError);
            }
        }
        
        if (originalBody.messages && Array.isArray(originalBody.messages)) {
            originalBody.messages = await Promise.all(originalBody.messages.map(async (msg) => {
                const newMessage = JSON.parse(JSON.stringify(msg));
                if (newMessage.content && typeof newMessage.content === 'string') {
                    newMessage.content = await replaceCommonVariables(newMessage.content);
                } else if (Array.isArray(newMessage.content)) {
                    newMessage.content = await Promise.all(newMessage.content.map(async (part) => {
                        if (part.type === 'text' && typeof part.text === 'string') {
                            const newPart = JSON.parse(JSON.stringify(part));
                            newPart.text = await replaceCommonVariables(newPart.text);
                            return newPart;
                        }
                        return part;
                    }));
                }
                return newMessage;
            }));
        }
        await writeDebugLog('LogOutputAfterProcessing', originalBody);
        
        let firstAiAPIResponse = await fetch(`${apiUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${apiKey}`, 
                ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
                'Accept': originalBody.stream ? 'text/event-stream' : (req.headers['accept'] || 'application/json'),
            },
            body: JSON.stringify(originalBody),
        });

        const isOriginalResponseStreaming = originalBody.stream === true && firstAiAPIResponse.headers.get('content-type')?.includes('text/event-stream');
        
        if (!res.headersSent) {
            res.status(firstAiAPIResponse.status);
            firstAiAPIResponse.headers.forEach((value, name) => {
                if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length', 'keep-alive'].includes(name.toLowerCase())) {
                     res.setHeader(name, value);
                }
            });
            if (isOriginalResponseStreaming && !res.getHeader('Content-Type')?.includes('text/event-stream')) {
                res.setHeader('Content-Type', 'text/event-stream');
                if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
                if (!res.getHeader('Connection')) res.setHeader('Connection', 'keep-alive');
            }
        }

        let firstResponseRawDataForClientAndDiary = ""; // Used for non-streaming and initial diary

        if (isOriginalResponseStreaming) {
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

                    aiResponse.body.on('data', (chunk) => {
                        const chunkString = chunk.toString('utf-8');
                        rawResponseDataThisTurn += chunkString;
                        if (!res.writableEnded) {
                             // Forward chunk to client, except for the final [DONE] if it's not the true end
                            if (chunkString.includes("data: [DONE]")) {
                                // Don't forward AI's own [DONE] if we are in a loop
                            } else {
                                res.write(chunkString);
                            }
                        }
                        
                        sseBuffer += chunkString;
                        let lines = sseBuffer.split('\n');
                        sseBuffer = lines.pop(); // Keep incomplete line

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const jsonData = line.substring(5).trim();
                                if (jsonData !== '[DONE]') {
                                    try {
                                        const parsedData = JSON.parse(jsonData);
                                        collectedContentThisTurn += parsedData.choices?.[0]?.delta?.content || '';
                                    } catch (e) { /* ignore parse error for intermediate chunks */ }
                                }
                            }
                        }
                    });

                    aiResponse.body.on('end', () => {
                        // Process remaining buffer for content
                        if (sseBuffer.startsWith('data: ')) {
                            const jsonData = sseBuffer.substring(5).trim();
                            if (jsonData !== '[DONE]') {
                                try {
                                    const parsedData = JSON.parse(jsonData);
                                    collectedContentThisTurn += parsedData.choices?.[0]?.delta?.content || '';
                                } catch (e) { /* ignore */ }
                            }
                        }
                        resolve({ content: collectedContentThisTurn, raw: rawResponseDataThisTurn });
                    });
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
            await handleDiaryFromAIResponse(currentAIRawDataForDiary);
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
                    if (DEBUG_MODE) console.log('[VCP Stream Loop] No tool calls found in AI response. Exiting loop.');
                    break;
                }
                if (DEBUG_MODE) console.log(`[VCP Stream Loop] Found ${toolCallsInThisAIResponse.length} tool calls. Iteration ${recursionDepth + 1}.`);

                let allToolResultsContentForAI = [];
                const toolExecutionPromises = toolCallsInThisAIResponse.map(async (toolCall) => {
                    let toolResultText;
                    if (pluginManager.getPlugin(toolCall.name)) {
                        try {
                            if (DEBUG_MODE) console.log(`[VCP Stream Loop] Executing tool: ${toolCall.name} with args:`, toolCall.args);
                            const pluginResult = await pluginManager.processToolCall(toolCall.name, toolCall.args);
                            toolResultText = (pluginResult !== undefined && pluginResult !== null) ? String(pluginResult) : `插件 ${toolCall.name} 执行完毕，但没有返回明确内容。`;
                            if (SHOW_VCP_OUTPUT && !res.writableEnded) {
                                const vcpClientPayload = { type: 'vcp_stream_result', tool_name: toolCall.name, status: 'success', content: toolResultText };
                                res.write(`data: ${JSON.stringify(vcpClientPayload)}\n\n`);
                            }
                        } catch (pluginError) {
                             console.error(`[VCP Stream Loop EXECUTION ERROR] Error executing plugin ${toolCall.name}:`, pluginError.message);
                             toolResultText = `执行插件 ${toolCall.name} 时发生错误：${pluginError.message || '未知错误'}`;
                             if (SHOW_VCP_OUTPUT && !res.writableEnded) {
                                const vcpClientPayload = { type: 'vcp_stream_result', tool_name: toolCall.name, status: 'error', content: toolResultText };
                                res.write(`data: ${JSON.stringify(vcpClientPayload)}\n\n`);
                             }
                        }
                    } else {
                        toolResultText = `错误：未找到名为 "${toolCall.name}" 的插件。`;
                        if (DEBUG_MODE) console.warn(`[VCP Stream Loop] ${toolResultText}`);
                        if (SHOW_VCP_OUTPUT && !res.writableEnded) {
                            const vcpClientPayload = { type: 'vcp_stream_result', tool_name: toolCall.name, status: 'error', content: toolResultText };
                            res.write(`data: ${JSON.stringify(vcpClientPayload)}\n\n`);
                        }
                    }
                    return `来自工具 "${toolCall.name}" 的结果:\n${toolResultText}`;
                });

                allToolResultsContentForAI = await Promise.all(toolExecutionPromises);
                const combinedToolResultsForAI = allToolResultsContentForAI.join("\n\n---\n\n");
                currentMessagesForLoop.push({ role: 'user', content: combinedToolResultsForAI });
                if (DEBUG_MODE) console.log('[VCP Stream Loop] Combined tool results for next AI call (first 200):', combinedToolResultsForAI.substring(0,200));

                // --- Make next AI call (stream: true) ---
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
                await handleDiaryFromAIResponse(currentAIRawDataForDiary);
                if (DEBUG_MODE) console.log('[VCP Stream Loop] Next AI content (first 200):', currentAIContentForLoop.substring(0,200));
                
                recursionDepth++;
            }

            // After loop (or if no tools called initially / max recursion hit)
            if (!res.writableEnded) {
                if (DEBUG_MODE) console.log('[VCP Stream Loop] Loop finished. Sending final [DONE].');
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
                conversationHistoryForClient.push({ type: 'ai', content: currentAIContentForLoop });

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
                        let toolResultText;
                        if (pluginManager.getPlugin(toolCall.name)) {
                            try {
                                if (DEBUG_MODE) console.log(`[Multi-Tool] Executing tool: ${toolCall.name} with args:`, toolCall.args);
                                const pluginResult = await pluginManager.processToolCall(toolCall.name, toolCall.args);
                                toolResultText = (pluginResult !== undefined && pluginResult !== null) ? String(pluginResult) : `插件 ${toolCall.name} 执行完毕，但没有返回明确内容。`;
                                if (SHOW_VCP_OUTPUT) {
                                    conversationHistoryForClient.push({ type: 'vcp', content: `工具 ${toolCall.name} 调用结果:\n${toolResultText}` });
                                }
                            } catch (pluginError) {
                                 console.error(`[Multi-Tool EXECUTION ERROR] Error executing plugin ${toolCall.name}:`, pluginError.message);
                                 toolResultText = `执行插件 ${toolCall.name} 时发生错误：${pluginError.message || '未知错误'}`;
                                 if (SHOW_VCP_OUTPUT) {
                                    conversationHistoryForClient.push({ type: 'vcp', content: `工具 ${toolCall.name} 调用错误:\n${toolResultText}` });
                                 }
                            }
                        } else {
                            toolResultText = `错误：未找到名为 "${toolCall.name}" 的插件。`;
                            if (DEBUG_MODE) console.warn(`[Multi-Tool] ${toolResultText}`);
                            if (SHOW_VCP_OUTPUT) {
                                conversationHistoryForClient.push({ type: 'vcp', content: toolResultText });
                            }
                        }
                        return `来自工具 "${toolCall.name}" 的结果:\n${toolResultText}`;
                    });

                    // Wait for all tool executions to complete
                    allToolResultsContentForAI = await Promise.all(toolExecutionPromises);

                    const combinedToolResultsForAI = allToolResultsContentForAI.join("\n\n---\n\n");
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
                    });
                    const recursionArrayBuffer = await recursionAiResponse.arrayBuffer();
                    const recursionBuffer = Buffer.from(recursionArrayBuffer);
                    const recursionText = recursionBuffer.toString('utf-8');
                    // Consider appending recursionText to rawResponseDataForDiary if needed for multi-tool turn

                    try {
                        const recursionJson = JSON.parse(recursionText);
                        currentAIContentForLoop = recursionJson.choices?.[0]?.message?.content || '';
                    } catch (e) {
                        currentAIContentForLoop = recursionText;
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
            const finalContentForClient = conversationHistoryForClient
                .map(item => {
                    if (item.type === 'ai') return item.content;
                    // VCP results are only included if SHOW_VCP_OUTPUT was true when they were added
                    if (item.type === 'vcp') return `\n<<<[VCP_RESULT]>>>\n${item.content}\n<<<[END_VCP_RESULT]>>>\n`;
                    return '';
                }).join('');

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

            // Loop for subsequent tool calls and AI responses in non-streaming mode
            do {
                let anyToolProcessedInCurrentIteration = false;
                conversationHistoryForClient.push({ type: 'ai', content: currentAIContentForLoop });

                const toolRequestStartMarker = "<<<[TOOL_REQUEST]>>>";
                const toolRequestEndMarker = "<<<[END_TOOL_REQUEST]>>>";
                let toolCallsInThisAIResponse = [];
                let searchOffset = 0;

                while (searchOffset < currentAIContentForLoop.length) {
                    const startIndex = currentAIContentForLoop.indexOf(toolRequestStartMarker, searchOffset);
                    if (startIndex === -1) break;
                    const endIndex = currentAIContentForLoop.indexOf(toolRequestEndMarker, startIndex + toolRequestStartMarker.length);
                    if (endIndex === -1) {
                        if (DEBUG_MODE) console.warn("[VCP NonStream Loop] Found TOOL_REQUEST_START but no END marker after offset", searchOffset);
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
                        if (DEBUG_MODE) console.log(`[VCP NonStream Loop] Parsed tool request: ${requestedToolName}`, parsedToolArgs);
                    } else {
                         if (DEBUG_MODE) console.warn("[VCP NonStream Loop] Parsed a tool request block but no tool_name found:", requestBlockContent.substring(0,100));
                    }
                    searchOffset = endIndex + toolRequestEndMarker.length;
                }

                if (toolCallsInThisAIResponse.length > 0) {
                    anyToolProcessedInCurrentIteration = true;
                    if (DEBUG_MODE) console.log(`[VCP NonStream Loop] Found ${toolCallsInThisAIResponse.length} tool calls. Iteration ${recursionDepth + 1}.`);
                    currentMessagesForNonStreamLoop.push({ role: 'assistant', content: currentAIContentForLoop });
                    
                    let allToolResultsContentForAI = [];
                    const toolExecutionPromises = toolCallsInThisAIResponse.map(async (toolCall) => {
                        let toolResultText;
                        if (pluginManager.getPlugin(toolCall.name)) {
                            try {
                                if (DEBUG_MODE) console.log(`[VCP NonStream Loop] Executing tool: ${toolCall.name} with args:`, toolCall.args);
                                const pluginResult = await pluginManager.processToolCall(toolCall.name, toolCall.args);
                                toolResultText = (pluginResult !== undefined && pluginResult !== null) ? String(pluginResult) : `插件 ${toolCall.name} 执行完毕，但没有返回明确内容。`;
                                if (SHOW_VCP_OUTPUT) {
                                    conversationHistoryForClient.push({ type: 'vcp', content: `工具 ${toolCall.name} 调用结果:\n${toolResultText}` });
                                }
                            } catch (pluginError) {
                                 console.error(`[VCP NonStream Loop EXECUTION ERROR] Error executing plugin ${toolCall.name}:`, pluginError.message);
                                 toolResultText = `执行插件 ${toolCall.name} 时发生错误：${pluginError.message || '未知错误'}`;
                                 if (SHOW_VCP_OUTPUT) {
                                    conversationHistoryForClient.push({ type: 'vcp', content: `工具 ${toolCall.name} 调用错误:\n${toolResultText}` });
                                 }
                            }
                        } else {
                            toolResultText = `错误：未找到名为 "${toolCall.name}" 的插件。`;
                            if (DEBUG_MODE) console.warn(`[VCP NonStream Loop] ${toolResultText}`);
                            if (SHOW_VCP_OUTPUT) {
                                conversationHistoryForClient.push({ type: 'vcp', content: toolResultText });
                            }
                        }
                        return `来自工具 "${toolCall.name}" 的结果:\n${toolResultText}`;
                    });

                    allToolResultsContentForAI = await Promise.all(toolExecutionPromises);
                    const combinedToolResultsForAI = allToolResultsContentForAI.join("\n\n---\n\n");
                    currentMessagesForNonStreamLoop.push({ role: 'user', content: combinedToolResultsForAI });
                    if (DEBUG_MODE) console.log('[VCP NonStream Loop] Combined tool results for next AI call (first 200):', combinedToolResultsForAI.substring(0,200));

                    if (DEBUG_MODE) console.log("[VCP NonStream Loop] Fetching next AI response after processing tools.");
                    const recursionAiResponse = await fetch(`${apiUrl}/v1/chat/completions`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`,
                            ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
                            'Accept': 'application/json', // Non-streaming for subsequent calls in this loop
                        },
                        body: JSON.stringify({ ...originalBody, messages: currentMessagesForNonStreamLoop, stream: false }),
                    });

                    const recursionArrayBuffer = await recursionAiResponse.arrayBuffer();
                    const recursionBuffer = Buffer.from(recursionArrayBuffer);
                    const recursionText = recursionBuffer.toString('utf-8');
                    
                    // Handle diary for this AI response
                    await handleDiaryFromAIResponse(recursionText);
                    accumulatedRawResponseDataForDiary += "\n\n--- Next AI Turn (Non-Stream) ---\n\n" + recursionText;


                    try {
                        const recursionJson = JSON.parse(recursionText);
                        currentAIContentForLoop = recursionJson.choices?.[0]?.message?.content || '';
                    } catch (e) {
                        currentAIContentForLoop = recursionText;
                    }
                    if (DEBUG_MODE) console.log('[VCP NonStream Loop] Next AI content (first 200):', currentAIContentForLoop.substring(0,200));

                } else {
                    if (DEBUG_MODE) console.log('[VCP NonStream Loop] No tool calls found in AI response. Exiting loop.');
                    anyToolProcessedInCurrentIteration = false;
                }
                
                if (!anyToolProcessedInCurrentIteration) break;
                recursionDepth++;
            } while (recursionDepth < maxRecursion);

            // Rename variables to avoid redeclaration errors
            const finalContentForClient_nonStream = conversationHistoryForClient
                .map(item => {
                    if (item.type === 'ai') return item.content;
                    if (item.type === 'vcp' && SHOW_VCP_OUTPUT) return `\n<<<[VCP_RESULT]>>>\n${item.content}\n<<<[END_VCP_RESULT]>>>\n`;
                    return '';
                }).join('');

            let finalJsonResponse_nonStream;
            try {
                finalJsonResponse_nonStream = JSON.parse(firstResponseRawDataForClientAndDiary); // Try to use structure of first response
                 if (!finalJsonResponse_nonStream.choices || !Array.isArray(finalJsonResponse_nonStream.choices) || finalJsonResponse_nonStream.choices.length === 0) {
                    finalJsonResponse_nonStream.choices = [{ message: {} }];
                }
                if (!finalJsonResponse_nonStream.choices[0].message) {
                    finalJsonResponse_nonStream.choices[0].message = {};
                }
                finalJsonResponse_nonStream.choices[0].message.content = finalContentForClient_nonStream; // Use renamed variable
                finalJsonResponse_nonStream.choices[0].finish_reason = (recursionDepth >= maxRecursion && toolCallsInThisAIResponse.length > 0) ? 'length' : 'stop';
            } catch (e) {
                 // Use renamed variables
                finalJsonResponse_nonStream = { choices: [{ index: 0, message: { role: 'assistant', content: finalContentForClient_nonStream }, finish_reason: (recursionDepth >= maxRecursion && toolCallsInThisAIResponse.length > 0 ? 'length' : 'stop') }] };
            }

            if (!res.writableEnded) {
                 res.send(Buffer.from(JSON.stringify(finalJsonResponse_nonStream))); // Use renamed variable
            }
            // Diary for all turns in non-streaming already handled inside the loop for subsequent, and outside for first.
        }
    } catch (error) {
        console.error('处理请求或转发时出错:', error.message, error.stack);
        if (!res.headersSent) {
             res.status(500).json({ error: 'Internal Server Error', details: error.message });
        } else if (!res.writableEnded) {
             console.error('[STREAM ERROR] Headers already sent. Cannot send JSON error. Ending stream if not already ended.');
             res.end();
        }
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

                    if (pluginResult && pluginResult.status === "success") {
                        if (DEBUG_MODE) console.log(`[handleDiaryFromAIResponse] DailyNoteWrite plugin reported success: ${pluginResult.result?.message || pluginResult.message}`);
                    } else {
                        console.error(`[handleDiaryFromAIResponse] DailyNoteWrite plugin reported error or unexpected response:`, pluginResult?.error || pluginResult?.message || pluginResult); // Keep as error
                    }
                } catch (pluginError) {
                    console.error('[handleDiaryFromAIResponse] Error calling DailyNoteWrite plugin:', pluginError.message, pluginError.stack);
                }
            } else {
                console.error('[handleDiaryFromAIResponse] Could not extract Maid, Date, or Content from daily note block:', { maidName, dateString, contentText: contentText?.substring(0,50) });
            }
        }
    }
}

// --- Admin API Router ---
const adminApiRouter = express.Router();

// GET main config.env content (filtered)
adminApiRouter.get('/config/main', async (req, res) => {
    try {
        const configPath = path.join(__dirname, 'config.env');
        const content = await fs.readFile(configPath, 'utf-8');
        // Filter out sensitive keys before sending to client
        const filteredContent = content.split('\n').filter(line =>
            !/^\s*(AdminPassword|AdminUsername)\s*=/i.test(line)
        ).join('\n');
        res.json({ content: filteredContent });
    } catch (error) {
        console.error('Error reading main config for admin panel:', error);
        res.status(500).json({ error: 'Failed to read main config file', details: error.message });
    }
});

// GET raw main config.env content (for saving purposes)
adminApiRouter.get('/config/main/raw', async (req, res) => {
    try {
        const configPath = path.join(__dirname, 'config.env');
        const content = await fs.readFile(configPath, 'utf-8');
        res.json({ content: content });
    } catch (error) {
        console.error('Error reading raw main config for admin panel:', error);
        res.status(500).json({ error: 'Failed to read raw main config file', details: error.message });
    }
});

// POST to save main config.env content
adminApiRouter.post('/config/main', async (req, res) => {
    const { content } = req.body;
    if (typeof content !== 'string') {
        return res.status(400).json({ error: 'Invalid content format. String expected.' });
    }
    try {
        const configPath = path.join(__dirname, 'config.env');
        await fs.writeFile(configPath, content, 'utf-8');
        // Re-load dotenv to reflect changes in the current process (optional, might have side effects)
        // dotenv.config({ path: 'config.env', override: true });
        // console.log('[AdminPanel] Main config.env reloaded into process.env');
        res.json({ message: '主配置已成功保存。更改可能需要重启服务才能完全生效。' });
    } catch (error) {
        console.error('Error writing main config for admin panel:', error);
        res.status(500).json({ error: 'Failed to write main config file', details: error.message });
    }
});

// GET plugin list with manifest, status, and config.env content
adminApiRouter.get('/plugins', async (req, res) => {
    const PLUGIN_DIR = path.join(__dirname, 'Plugin');
    const manifestFileName = 'plugin-manifest.json';
    const blockedManifestExtension = '.block';

    try {
        const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
        const pluginDataList = [];

        for (const folder of pluginFolders) {
            if (folder.isDirectory()) {
                const pluginPath = path.join(PLUGIN_DIR, folder.name);
                const manifestPath = path.join(pluginPath, manifestFileName);
                const blockedManifestPath = manifestPath + blockedManifestExtension;
                let manifest = null;
                let isEnabled = false;
                let configEnvContent = null;

                try {
                    // Check for enabled manifest first
                    await fs.access(manifestPath);
                    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
                    manifest = JSON.parse(manifestContent);
                    isEnabled = true;
                } catch (error) {
                    if (error.code === 'ENOENT') {
                        // If enabled not found, check for disabled (blocked) manifest
                        try {
                            await fs.access(blockedManifestPath);
                            const manifestContent = await fs.readFile(blockedManifestPath, 'utf-8');
                            manifest = JSON.parse(manifestContent);
                            isEnabled = false; // It exists but is blocked
                        } catch (blockedError) {
                            if (blockedError.code !== 'ENOENT') {
                                console.warn(`[AdminPanel] Error reading blocked manifest for ${folder.name}:`, blockedError);
                            }
                            // If neither manifest exists, skip this folder or handle as error
                            continue;
                        }
                    } else if (error instanceof SyntaxError) {
                         console.warn(`[AdminPanel] Invalid JSON in manifest for ${folder.name}: ${manifestPath}`);
                         continue; // Skip invalid manifest
                    } else {
                        console.warn(`[AdminPanel] Error accessing manifest for ${folder.name}:`, error);
                        continue; // Skip on other errors
                    }
                }
                
                // Try reading plugin-specific config.env
                try {
                    const pluginConfigPath = path.join(pluginPath, 'config.env');
                    await fs.access(pluginConfigPath);
                    configEnvContent = await fs.readFile(pluginConfigPath, 'utf-8');
                } catch (envError) {
                     if (envError.code !== 'ENOENT') {
                         console.warn(`[AdminPanel] Error reading config.env for ${folder.name}:`, envError);
                     }
                     // If config.env doesn't exist, configEnvContent remains null
                }


                if (manifest && manifest.name) { // Ensure manifest was loaded and has a name
                    pluginDataList.push({
                        name: manifest.name,
                        manifest: manifest,
                        enabled: isEnabled,
                        configEnvContent: configEnvContent
                    });
                }
            }
        }
        res.json(pluginDataList);
    } catch (error) {
        console.error('[AdminPanel] Error listing plugins:', error);
        res.status(500).json({ error: 'Failed to list plugins', details: error.message });
    }
});

// POST to toggle plugin enabled/disabled status
adminApiRouter.post('/plugins/:pluginName/toggle', async (req, res) => {
    const pluginName = req.params.pluginName;
    const { enable } = req.body; // Expecting { enable: true } or { enable: false }
    const PLUGIN_DIR = path.join(__dirname, 'Plugin');
    const manifestFileName = 'plugin-manifest.json';
    const blockedManifestExtension = '.block';

    if (typeof enable !== 'boolean') {
        return res.status(400).json({ error: 'Invalid request body. Expected { enable: boolean }.' });
    }

    try {
        // Find the plugin folder by iterating and checking manifest 'name' field
        const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
        let targetPluginPath = null;
        let currentManifestPath = null;
        let currentBlockedPath = null;
        let foundManifest = null;

        for (const folder of pluginFolders) {
             if (folder.isDirectory()) {
                const potentialPluginPath = path.join(PLUGIN_DIR, folder.name);
                const potentialManifestPath = path.join(potentialPluginPath, manifestFileName);
                const potentialBlockedPath = potentialManifestPath + blockedManifestExtension;
                let manifestContent = null;
                let isCurrentlyEnabled = false;

                try {
                    manifestContent = await fs.readFile(potentialManifestPath, 'utf-8');
                    isCurrentlyEnabled = true;
                } catch (err) {
                    if (err.code === 'ENOENT') {
                        try {
                            manifestContent = await fs.readFile(potentialBlockedPath, 'utf-8');
                            isCurrentlyEnabled = false;
                        } catch (blockedErr) { continue; /* Not this folder */ }
                    } else { continue; /* Error reading manifest */ }
                }

                try {
                    const manifest = JSON.parse(manifestContent);
                    if (manifest.name === pluginName) {
                        targetPluginPath = potentialPluginPath;
                        currentManifestPath = potentialManifestPath;
                        currentBlockedPath = potentialBlockedPath;
                        foundManifest = manifest; // Store the found manifest
                        break; // Found the plugin
                    }
                } catch (parseErr) { continue; /* Invalid JSON */ }
            }
        }

        if (!targetPluginPath || !foundManifest) {
            return res.status(404).json({ error: `Plugin '${pluginName}' not found.` });
        }

        const manifestPath = currentManifestPath; //path.join(targetPluginPath, manifestFileName);
        const blockedManifestPath = currentBlockedPath; //manifestPath + blockedManifestExtension;

        if (enable) {
            // Enable: Rename .block to .json (if it exists)
            try {
                await fs.rename(blockedManifestPath, manifestPath);
                res.json({ message: `插件 ${pluginName} 已启用。请注意，更改可能需要重启服务才能完全生效。` });
            } catch (error) {
                if (error.code === 'ENOENT') {
                    // If .block doesn't exist, it might already be enabled
                     try {
                         await fs.access(manifestPath); // Check if .json exists
                         res.json({ message: `插件 ${pluginName} 已经是启用状态。` });
                     } catch (accessError) {
                         res.status(500).json({ error: `无法启用插件 ${pluginName}。找不到 manifest 文件。`, details: accessError.message });
                     }
                } else {
                    console.error(`[AdminPanel] Error enabling plugin ${pluginName}:`, error);
                    res.status(500).json({ error: `启用插件 ${pluginName} 时出错`, details: error.message });
                }
            }
        } else {
            // Disable: Rename .json to .block (if it exists)
            try {
                await fs.rename(manifestPath, blockedManifestPath);
                res.json({ message: `插件 ${pluginName} 已禁用。请注意，更改可能需要重启服务才能完全生效。` });
            } catch (error) {
                if (error.code === 'ENOENT') {
                    // If .json doesn't exist, it might already be disabled
                    try {
                         await fs.access(blockedManifestPath); // Check if .block exists
                         res.json({ message: `插件 ${pluginName} 已经是禁用状态。` });
                     } catch (accessError) {
                         res.status(500).json({ error: `无法禁用插件 ${pluginName}。找不到 manifest 文件。`, details: accessError.message });
                     }
                } else {
                    console.error(`[AdminPanel] Error disabling plugin ${pluginName}:`, error);
                    res.status(500).json({ error: `禁用插件 ${pluginName} 时出错`, details: error.message });
                }
            }
        }
    } catch (error) {
        console.error(`[AdminPanel] Error toggling plugin ${pluginName}:`, error);
        res.status(500).json({ error: `处理插件 ${pluginName} 状态切换时出错`, details: error.message });
    }
});

// POST to update plugin description in manifest
adminApiRouter.post('/plugins/:pluginName/description', async (req, res) => {
    const pluginName = req.params.pluginName;
    const { description } = req.body;
    const PLUGIN_DIR = path.join(__dirname, 'Plugin');
    const manifestFileName = 'plugin-manifest.json';
    const blockedManifestExtension = '.block';

    if (typeof description !== 'string') {
        return res.status(400).json({ error: 'Invalid request body. Expected { description: string }.' });
    }

    try {
        // Find the plugin folder and the active manifest file (.json or .json.block)
        const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
        let targetManifestPath = null;
        let manifest = null;

        for (const folder of pluginFolders) {
            if (folder.isDirectory()) {
                const potentialPluginPath = path.join(PLUGIN_DIR, folder.name);
                const potentialManifestPath = path.join(potentialPluginPath, manifestFileName);
                const potentialBlockedPath = potentialManifestPath + blockedManifestExtension;
                let currentPath = null;
                let manifestContent = null;

                try { // Try reading enabled first
                    manifestContent = await fs.readFile(potentialManifestPath, 'utf-8');
                    currentPath = potentialManifestPath;
                } catch (err) {
                    if (err.code === 'ENOENT') {
                        try { // Try reading disabled
                            manifestContent = await fs.readFile(potentialBlockedPath, 'utf-8');
                            currentPath = potentialBlockedPath;
                        } catch (blockedErr) { continue; }
                    } else { continue; }
                }

                try {
                    const parsedManifest = JSON.parse(manifestContent);
                    if (parsedManifest.name === pluginName) {
                        targetManifestPath = currentPath;
                        manifest = parsedManifest;
                        break;
                    }
                } catch (parseErr) { continue; }
            }
        }


        if (!targetManifestPath || !manifest) {
            return res.status(404).json({ error: `Plugin '${pluginName}' or its manifest file not found.` });
        }

        // Update the description in the manifest object
        manifest.description = description;

        // Write the updated manifest back to the file
        await fs.writeFile(targetManifestPath, JSON.stringify(manifest, null, 2), 'utf-8'); // Pretty print JSON

        res.json({ message: `插件 ${pluginName} 的描述已更新。` });

    } catch (error) {
        console.error(`[AdminPanel] Error updating description for plugin ${pluginName}:`, error);
        res.status(500).json({ error: `更新插件 ${pluginName} 描述时出错`, details: error.message });
    }
});

// POST to save plugin-specific config.env
adminApiRouter.post('/plugins/:pluginName/config', async (req, res) => {
    const pluginName = req.params.pluginName;
    const { content } = req.body;
    const PLUGIN_DIR = path.join(__dirname, 'Plugin');

     if (typeof content !== 'string') {
        return res.status(400).json({ error: 'Invalid content format. String expected.' });
    }

    try {
        // Find the plugin folder by name (similar logic to toggle/description)
        const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
        let targetPluginPath = null;

        for (const folder of pluginFolders) {
             if (folder.isDirectory()) {
                const potentialPluginPath = path.join(PLUGIN_DIR, folder.name);
                // We need to read the manifest to confirm the plugin name matches
                const manifestPath = path.join(potentialPluginPath, manifestFileName);
                const blockedManifestPath = manifestPath + blockedManifestExtension;
                let manifestContent = null;
                 try {
                    manifestContent = await fs.readFile(manifestPath, 'utf-8');
                 } catch (err) {
                     if (err.code === 'ENOENT') {
                         try { manifestContent = await fs.readFile(blockedManifestPath, 'utf-8'); }
                         catch (blockedErr) { continue; }
                     } else { continue; }
                 }
                 try {
                     const manifest = JSON.parse(manifestContent);
                     if (manifest.name === pluginName) {
                         targetPluginPath = potentialPluginPath;
                         break;
                     }
                 } catch (parseErr) { continue; }
             }
        }

        if (!targetPluginPath) {
             return res.status(404).json({ error: `Plugin folder for '${pluginName}' not found.` });
        }

        const configPath = path.join(targetPluginPath, 'config.env');
        await fs.writeFile(configPath, content, 'utf-8');
        
        // Optionally, try to update the plugin's config in pluginManager if loaded?
        // This might be complex depending on how pluginManager handles config updates.
        // For now, just saving the file. Restart might be needed for plugin to see changes.
        
        res.json({ message: `插件 ${pluginName} 的配置已保存。更改可能需要重启插件或服务才能生效。` });
    } catch (error) {
        console.error(`[AdminPanel] Error writing config.env for plugin ${pluginName}:`, error);
        res.status(500).json({ error: `保存插件 ${pluginName} 配置时出错`, details: error.message });
    }
});


app.use('/admin_api', adminApiRouter);
// --- End Admin API Router ---


async function initialize() {
    console.log('开始加载插件...');
    await pluginManager.loadPlugins();
    console.log('插件加载完成。');
    pluginManager.setProjectBasePath(__dirname); 
    
    console.log('开始初始化服务类插件...');
    await pluginManager.initializeServices(app, __dirname); 
    console.log('服务类插件初始化完成。');

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
}

app.listen(port, async () => {
    console.log(`中间层服务器正在监听端口 ${port}`);
    console.log(`API 服务器地址: ${apiUrl}`);
    await ensureDebugLogDir();
    await initialize();
});

async function gracefulShutdown() {
    console.log('Initiating graceful shutdown...');
    if (pluginManager) {
        await pluginManager.shutdownAllPlugins();
    }
    console.log('Graceful shutdown complete. Exiting.');
    process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);