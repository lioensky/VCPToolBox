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

dotenv.config({ path: 'config.env' });

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

// Image server logic is now handled by the ImageServer plugin.

app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleString()}] Received ${req.method} request for ${req.url} from ${req.ip}`);
    next();
});
app.use((req, res, next) => {
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

async function updateAndLoadAgentEmojiList(agentName, dirPath, filePath) {
    console.log(`尝试更新 ${agentName} 表情包列表...`);
    let newList = '';
    let errorMessage = '';
    try {
        const files = await fs.readdir(dirPath);
        const imageFiles = files.filter(file => /\.(jpg|jpeg|png|gif)$/i.test(file));
        newList = imageFiles.join('|');
        await fs.writeFile(filePath, newList);
        console.log(`${agentName} 表情包列表已更新并写入 ${filePath}`);
        errorMessage = newList;
    } catch (error) {
        if (error.code === 'ENOENT') {
            errorMessage = `${agentName} 表情包目录 ${dirPath} 不存在，无法生成列表。`;
        } else {
            errorMessage = `更新或写入 ${agentName} 表情包列表 ${filePath} 时出错: ${error.message}`;
        }
        console.error(errorMessage, error.code !== 'ENOENT' ? error : '');
        try {
            await fs.writeFile(filePath, errorMessage);
        } catch (writeError) {
            console.error(`创建空的 ${filePath} 文件失败:`, writeError);
        }
        try {
            const oldList = await fs.readFile(filePath, 'utf-8');
            if (oldList !== errorMessage) {
                errorMessage = oldList;
            }
        } catch (readError) {
            if (readError.code !== 'ENOENT') console.error(`读取旧的 ${agentName} 表情包列表 ${filePath} 失败:`, readError);
        }
    }
    return errorMessage;
}

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
        console.warn('[replaceCommonVariables] {{Image_Key}} placeholder found in text, but ImageServer plugin or its Image_Key is not resolved. Placeholder will not be replaced.');
    }
    if (processedText.includes('{{EmojiList}}') && process.env.EmojiList) {
        const emojiListFileName = process.env.EmojiList;
        const emojiCacheKey = emojiListFileName.replace(/\.txt$/i, '').trim();
        const specificEmojiListContent = cachedEmojiLists.get(emojiCacheKey);
        if (specificEmojiListContent !== undefined) {
            processedText = processedText.replaceAll('{{EmojiList}}', specificEmojiListContent);
        } else {
            processedText = processedText.replaceAll('{{EmojiList}}', `[名为 ${emojiCacheKey} 的表情列表不可用 (源: ${emojiListFileName})]`);
            console.warn(`[EmojiList Variable] 未能从缓存中找到 ${emojiCacheKey} 的列表.`);
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
    let tempProcessedText = processedText;
    const diaryMatches = tempProcessedText.matchAll(diaryPlaceholderRegex);
    const processedCharacters = new Set();
    for (const match of diaryMatches) {
        const placeholder = match[0];
        const characterName = match[1];
        if (processedCharacters.has(characterName)) continue;
        const diaryDirPath = path.join(__dirname, 'dailynote', characterName);
        let diaryContent = `[${characterName}日记本内容为空或不存在]`;
        try {
            const files = await fs.readdir(diaryDirPath);
            const txtFiles = files.filter(file => file.toLowerCase().endsWith('.txt')).sort();
            if (txtFiles.length > 0) {
                const fileContents = await Promise.all(
                    txtFiles.map(async (file) => {
                        const filePath = path.join(diaryDirPath, file);
                        try {
                            return await fs.readFile(filePath, 'utf-8');
                        } catch (readErr) {
                            console.error(`读取日记文件 ${filePath} 失败:`, readErr);
                            return `[读取文件 ${file} 失败]`;
                        }
                    })
                );
                diaryContent = fileContents.join('\n\n---\n\n');
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`读取 ${characterName} 日记目录 ${diaryDirPath} 出错:`, error);
                diaryContent = `[读取${characterName}日记时出错]`;
            }
        }
        tempProcessedText = tempProcessedText.replaceAll(placeholder, diaryContent);
        processedCharacters.add(characterName);
    }
    processedText = tempProcessedText;
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

async function handleDailyNote(noteBlockContent) {
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
    if (!maidName || !dateString || !contentText) {
        console.error('[handleDailyNote] 无法从日记块中完整提取 Maid, Date, 或 Content:', { maidName, dateString, contentText: contentText.substring(0,100)+ '...' });
        return;
    }
    const datePart = dateString.replace(/[.-]/g, '.');
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const timeStringForFile = `${hours}_${minutes}_${seconds}`;
    const dirPath = path.join(__dirname, 'dailynote', maidName);
    const baseFileNameWithoutExt = `${datePart}-${timeStringForFile}`;
    const fileExtension = '.txt';
    let finalFileName = `${baseFileNameWithoutExt}${fileExtension}`;
    let filePath = path.join(dirPath, finalFileName);
    try {
        await fs.mkdir(dirPath, { recursive: true });
        await fs.writeFile(filePath, `[${datePart}] - ${maidName}\n${contentText}`);
        console.log(`[handleDailyNote] 日记文件写入成功: ${filePath}`);
    } catch (error) {
        console.error(`[handleDailyNote] 处理日记文件 ${filePath} 时捕获到错误:`, error);
    }
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
                    console.log('[Server] Image processing disabled by {{ShowBase64}} placeholder.');
                    break;
                }
            }
        }

        if (shouldProcessImages) {
            console.log('[Server] Image processing enabled, calling ImageProcessor plugin...');
            try {
                originalBody.messages = await pluginManager.executeMessagePreprocessor("ImageProcessor", originalBody.messages);
                console.log('[Server] ImageProcessor plugin finished.');
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

        let fullContentFromAI = ''; 
        let firstResponseRawDataForClientAndDiary = ""; 

        if (isOriginalResponseStreaming) {
            let lineBuffer = "";
            await new Promise((resolve, reject) => {
                firstAiAPIResponse.body.on('data', (chunk) => {
                    const chunkString = chunk.toString('utf-8');
                    firstResponseRawDataForClientAndDiary += chunkString;
                    lineBuffer += chunkString;
                    
                    let lines = lineBuffer.split('\n');
                    lineBuffer = lines.pop(); 

                    for (const line of lines) {
                        if (line.trim() === 'data: [DONE]') {
                        } else if (line.trim() !== "" && !res.writableEnded) {
                            res.write(`${line}\n`);
                        } else if (line.trim() === "" && !res.writableEnded) { 
                            res.write('\n');
                        }
                    }
                });
                firstAiAPIResponse.body.on('end', () => {
                    if (lineBuffer.trim() !== "" && lineBuffer.trim() !== 'data: [DONE]' && !res.writableEnded) {
                        res.write(`${lineBuffer}\n`); 
                    }
                    const sseLines = firstResponseRawDataForClientAndDiary.trim().split('\n');
                    let sseContent = '';
                    for (const line of sseLines) {
                        if (line.startsWith('data: ')) {
                            const jsonData = line.substring(5).trim();
                            if (jsonData === '[DONE]') continue;
                            try {
                                const parsedData = JSON.parse(jsonData);
                                const contentChunk = parsedData.choices?.[0]?.delta?.content || '';
                                if (contentChunk) sseContent += contentChunk;
                            } catch (e) { /* ignore */ }
                        }
                    }
                    fullContentFromAI = sseContent;
                    resolve(); 
                });
                firstAiAPIResponse.body.on('error', (streamError) => {
                    console.error("Error reading first AI response stream:", streamError);
                    if (!res.writableEnded) { res.status(500).end("Stream reading error"); }
                    reject(streamError); 
                });
            });
        } else { 
            const firstArrayBuffer = await firstAiAPIResponse.arrayBuffer();
            const responseBuffer = Buffer.from(firstArrayBuffer);
            const aiResponseText = responseBuffer.toString('utf-8');
            firstResponseRawDataForClientAndDiary = aiResponseText; 

            try {
                const parsedJson = JSON.parse(aiResponseText);
                fullContentFromAI = parsedJson.choices?.[0]?.message?.content || '';
            } catch (e) {
                console.warn('[PluginCall] First AI response (non-stream) not valid JSON. Raw:', aiResponseText.substring(0, 200));
                fullContentFromAI = aiResponseText;
            }
            // 非流式分支递归工具链闭环处理
            let recursionDepth = 0;
            const maxRecursion = 5; // Max VCP calls for non-streaming
            let conversationHistoryForClient = [];
            let currentAIContentForLoop = fullContentFromAI;
            // Start with original messages + first AI response for the loop state
            let currentMessagesForNonStreamLoop = originalBody.messages ? JSON.parse(JSON.stringify(originalBody.messages)) : [];
            // Note: The first AI response is already captured in currentAIContentForLoop
            let toolRequestBlockFound = false;

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
                        console.warn("[Multi-Tool] Found TOOL_REQUEST_START but no END marker after offset", searchOffset);
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
                        console.warn("[Multi-Tool] Parsed a tool request block but no tool_name found:", requestBlockContent);
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
                                console.log(`[Multi-Tool] Executing tool: ${toolCall.name} with args:`, toolCall.args);
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
                            console.warn(`[Multi-Tool] ${toolResultText}`);
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
                    console.log("[Multi-Tool] Fetching next AI response after processing tools.");
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
            // Handle diary after the entire non-stream process is complete
            await handleDiaryFromAIResponse(firstResponseRawDataForClientAndDiary); // Use the initially collected raw data
        }
        
        console.log('[PluginCall] AI First Full Response Text (from fullContentFromAI):', fullContentFromAI.substring(0, 200) + "...");

        let needsSecondAICall = false;
        let messagesForNextAICall = originalBody.messages ? JSON.parse(JSON.stringify(originalBody.messages)) : [];
        const firstAIResponseContent = fullContentFromAI || null; 

        const toolRequestStartMarker = "<<<[TOOL_REQUEST]>>>";
        const toolRequestEndMarker = "<<<[END_TOOL_REQUEST]>>>";
        let parsedToolArgs = {}; 
        let requestedToolName = null;
        let toolRequestBlockFound = false; 

        const startIndex = fullContentFromAI.indexOf(toolRequestStartMarker);
        if (startIndex !== -1) {
            const endIndex = fullContentFromAI.indexOf(toolRequestEndMarker, startIndex + toolRequestStartMarker.length);
            if (endIndex !== -1) {
                toolRequestBlockFound = true; 
                const requestBlock = fullContentFromAI.substring(startIndex + toolRequestStartMarker.length, endIndex).trim();
                console.log("[PluginCall Debug] Extracted Tool Request Block:\n", requestBlock);
                
                const paramRegex = /([\w_]+)\s*:\s*「始」([\s\S]*?)「末」\s*(?:,)?/g;
                let regexMatch;

                while ((regexMatch = paramRegex.exec(requestBlock)) !== null) {
                    const key = regexMatch[1];
                    const value = regexMatch[2].trim(); 
                    if (key === "tool_name") {
                        requestedToolName = value;
                    } else {
                        parsedToolArgs[key] = value;
                    }
                }
                const lastIndex = paramRegex.lastIndex;
                if (requestBlock.length > 0 && lastIndex < requestBlock.length && requestBlock.substring(lastIndex).trim() !== "") {
                    console.warn("[PluginCall Debug] Remaining unparsed text in tool request block:", requestBlock.substring(lastIndex).trim());
                }

                console.log("[PluginCall Debug] Parsed Tool Name:", requestedToolName);
                console.log("[PluginCall Debug] Parsed Tool Arguments:", parsedToolArgs);

                if (requestedToolName && pluginManager.getPlugin(requestedToolName)) {
                    const pluginManifest = pluginManager.getPlugin(requestedToolName);
                    messagesForNextAICall.push({ role: 'assistant', content: firstAIResponseContent }); 

                    try {
                        // 使用新的 processToolCall 方法，它会处理 executionParam 的准备
                        console.log(`[PluginCall Debug] Attempting to call pluginManager.processToolCall for: ${requestedToolName} with args:`, parsedToolArgs);
                        const pluginResult = await pluginManager.processToolCall(requestedToolName, parsedToolArgs);
                        // pluginResult is now expected to be the final, pre-formatted string for AI,
                        // as formatting logic has been moved into individual plugins and processToolCall.
                        // Log the result, handling objects correctly using JSON.stringify
                        const resultLogPreview = pluginResult
                            ? JSON.stringify(pluginResult).substring(0, 200) + (JSON.stringify(pluginResult).length > 200 ? "..." : "")
                            : pluginResult;
                        console.log(`[PluginCall Debug] Plugin ${requestedToolName} executed. Result from processToolCall:`, resultLogPreview);

                        // Directly use the result from processToolCall as it's already formatted.
                        // If processToolCall encountered an error (either from plugin's JSON or execution failure),
                        // it would have thrown an error, which is caught by the outer catch block.
                        // If pluginResult is null or undefined (e.g. plugin had no output but didn't error),
                        // provide a generic message.
                        let messageContentForAI;
                        if (pluginResult !== undefined && pluginResult !== null) {
                            // Directly stringify the object returned by the plugin
                            messageContentForAI = `来自工具 "${requestedToolName}" 的结果:\n${JSON.stringify(pluginResult, null, 2)}`;
                        } else {
                            messageContentForAI = `来自工具 "${requestedToolName}" 的结果:\n插件 ${requestedToolName} 执行完毕，但没有返回明确内容。`;
                        }
                        
                        messagesForNextAICall.push({ role: 'user', content: messageContentForAI });
                        needsSecondAICall = true;

                    } catch (pluginError) {
                        console.error(`[PluginCall EXECUTION ERROR] Error executing plugin ${requestedToolName} with args:`, parsedToolArgs, "Error:", pluginError.message);
                        if (pluginError.stack) {
                            console.error(`[PluginCall EXECUTION ERROR] Stack trace for ${requestedToolName}:`, pluginError.stack);
                        }
                        messagesForNextAICall.push({ role: 'user', content: `\n执行插件 ${requestedToolName} 时发生错误：${pluginError.message || '未知错误'}` }); // Added \n here
                        needsSecondAICall = true;
                    }
                } else if (requestedToolName) { 
                    console.warn(`[PluginCall Debug] Requested tool "${requestedToolName}" not found or not loaded.`);
                    messagesForNextAICall.push({ role: 'user', content: firstAIResponseContent });
                } else if (requestBlock.length > 0) { 
                    console.warn(`[PluginCall Debug] Tool request block found but no valid 'tool_name' was parsed from: ${requestBlock}`);
                    messagesForNextAICall.push({ role: 'user', content: firstAIResponseContent });
                } else { 
                     console.warn(`[PluginCall Debug] Tool request markers found, but the block between them was empty or whitespace.`);
                     messagesForNextAICall.push({ role: 'user', content: firstAIResponseContent });
                }
            } else if (startIndex !== -1 && endIndex === -1) { 
                 console.warn("[PluginCall Debug] Found TOOL_REQUEST_START but no END marker in AI response.");
                 toolRequestBlockFound = true; 
                 messagesForNextAICall.push({ role: 'user', content: firstAIResponseContent });
            }
        }
        
        if (!toolRequestBlockFound) { 
            messagesForNextAICall.push({ role: 'user', content: firstAIResponseContent });
        }
        
        if (needsSecondAICall) {
            console.log('[PluginCall] Proceeding with second AI call with tool results.');
            console.log('[PluginCall Debug] messagesForNextAICall for second call:', JSON.stringify(messagesForNextAICall, null, 2));
            await writeDebugLog('LogOutputWithPluginCall_BeforeSecondCall', { messages: messagesForNextAICall, originalRequestBody: originalBody });

            try { 
                const secondAiAPIResponse = await fetch(`${apiUrl}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 
                        ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
                        'Accept': originalBody.stream ? 'text/event-stream' : (req.headers['accept'] || 'application/json'),
                    },
                    body: JSON.stringify({ ...originalBody, messages: messagesForNextAICall }),
                });
                console.log(`[PluginCall Debug] Second AI call response status: ${secondAiAPIResponse.status}`);
                await writeDebugLog('LogOutputWithPluginCall_AfterSecondCall_Status', { status: secondAiAPIResponse.status, headers: Object.fromEntries(secondAiAPIResponse.headers.entries()) });

                if (!secondAiAPIResponse.ok && !originalBody.stream) {
                    const errorBody = await secondAiAPIResponse.text();
                    console.error(`[PluginCall Debug] Second AI call non-OK response body: ${errorBody}`);
                    throw new Error(`Second AI call failed with status ${secondAiAPIResponse.status}: ${errorBody}`);
                }

                if (!isOriginalResponseStreaming) {
                    if (res.statusCode !== secondAiAPIResponse.status && secondAiAPIResponse.ok) {
                         res.status(secondAiAPIResponse.status);
                    }
                    secondAiAPIResponse.headers.forEach((value, name) => {
                        if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length', 'keep-alive'].includes(name.toLowerCase())) {
                            if (!res.headersSent && name.toLowerCase() === 'content-type') res.setHeader(name, value);
                        }
                    });
                }
                
                const secondResponseIsStreaming = originalBody.stream === true && secondAiAPIResponse.headers.get('content-type')?.includes('text/event-stream');
                let secondResponseFullText = "";

                if (secondResponseIsStreaming) {
                    console.log('[PluginCall Debug] Second AI response is streaming.');
                    let finalResponseAggregated = ""; 
                    await new Promise((resolve, reject) => {
                        secondAiAPIResponse.body.on('data', (chunk) => {
                            const chunkString = chunk.toString('utf-8');
                            finalResponseAggregated += chunkString;
                            if (!res.writableEnded) res.write(chunkString);
                        });
                        secondAiAPIResponse.body.on('end', async () => {
                            if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
                            secondResponseFullText = finalResponseAggregated;
                            await handleDiaryFromAIResponse(secondResponseFullText); 
                            resolve();
                        });
                        secondAiAPIResponse.body.on('error', async (streamError) => {
                            console.error('[PluginCall Debug] Second AI response stream reading error:', streamError);
                            if (!res.writableEnded) res.end('\nError during second AI response stream.');
                            secondResponseFullText = finalResponseAggregated; 
                            await handleDiaryFromAIResponse(secondResponseFullText);
                            reject(streamError); 
                        });
                    });
                } else { 
                    console.log('[PluginCall Debug] Second AI response is NOT streaming.');
                    const secondArrayBuffer = await secondAiAPIResponse.arrayBuffer();
                    const secondResponseBuffer = Buffer.from(secondArrayBuffer);
                    secondResponseFullText = secondResponseBuffer.toString('utf-8');
                    console.log('[PluginCall Debug] Second AI response (non-stream) full text (first 500 chars):', secondResponseFullText.substring(0,500));
                    
                    if (!isOriginalResponseStreaming && !res.getHeader('Content-Type')) { 
                        try { JSON.parse(secondResponseFullText); if (!res.headersSent) res.setHeader('Content-Type', 'application/json');}
                        catch (e) { if (!res.headersSent) res.setHeader('Content-Type', 'text/plain');}
                    }
                    if (!res.writableEnded) res.send(secondResponseBuffer); 
                    await handleDiaryFromAIResponse(secondResponseFullText);
                }
            } catch (secondCallError) {
                console.error('[PluginCall SECOND CALL ERROR] Error during second AI call or its response processing:', secondCallError.message);
                if (secondCallError.stack) {
                    console.error('[PluginCall SECOND CALL ERROR] Stack trace:', secondCallError.stack);
                }
                throw secondCallError; 
            }
        } else { 
            if (isOriginalResponseStreaming && !res.writableEnded) {
                res.write('data: [DONE]\n\n');
                res.end();
            } else if (!isOriginalResponseStreaming && !res.writableEnded) {
                 if(!res.writableEnded) res.end();
            }
            await handleDiaryFromAIResponse(firstResponseRawDataForClientAndDiary); 
        }
    } catch (error) {
        console.error('处理请求或转发时出错:', error.message, error.stack);
        if (!res.headersSent) {
             res.status(500).json({ error: 'Internal Server Error', details: error.message });
        } else {
             console.error('[STREAM ERROR] Headers already sent. Cannot send JSON error. Ending stream if not already ended.');
             if (!res.writableEnded) {
                res.end();
             }
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
            console.log('[DailyNote Check from handleDiary] Found structured daily note.');
            handleDailyNote(noteBlockContent).catch(err => {
                console.error("[DailyNote Check from handleDiary] Error processing daily note:", err);
            });
        }
    }
}

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
    console.log('静态插件初始化完成。');

    console.log('开始初始化表情包列表...');
    const imageDir = path.join(__dirname, 'image');
    try {
        const entries = await fs.readdir(imageDir, { withFileTypes: true });
        const emojiDirs = entries.filter(entry => entry.isDirectory() && entry.name.endsWith('表情包'));
        if (emojiDirs.length === 0) {
            console.warn(`警告: 在 ${imageDir} 目录下未找到任何以 '表情包' 结尾的文件夹。`);
        } else {
            console.log(`找到 ${emojiDirs.length} 个表情包目录，开始加载...`);
            await Promise.all(emojiDirs.map(async (dirEntry) => {
                const emojiName = dirEntry.name;
                const dirPath = path.join(imageDir, emojiName);
                const filePath = path.join(__dirname, `${emojiName}.txt`);
                try {
                    const listContent = await updateAndLoadAgentEmojiList(emojiName, dirPath, filePath);
                    cachedEmojiLists.set(emojiName, listContent);
                } catch (loadError) {
                    console.error(`加载 ${emojiName} 列表时出错:`, loadError);
                    cachedEmojiLists.set(emojiName, `${emojiName}列表加载失败`);
                }
            }));
            console.log('所有表情包列表加载完成。');
        }
    } catch (error) {
        console.error(`读取 image 目录 ${imageDir} 时出错:`, error);
    }
    console.log('表情包列表初始化结束。');
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