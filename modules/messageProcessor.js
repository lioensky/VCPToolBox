// modules/messageProcessor.js
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const lunarCalendar = require('chinese-lunar-calendar');
const agentManager = require('./agentManager.js'); // 引入新的Agent管理器
const tvsManager = require('./tvsManager.js'); // 引入新的TVS管理器
const crypto = require('crypto');
const ignore = require('ignore');

const AGENT_DIR = path.join(__dirname, '..', 'Agent');
const TVS_DIR = path.join(__dirname, '..', 'TVStxt');
const VCP_ASYNC_RESULTS_DIR = path.join(__dirname, '..', 'VCPAsyncResults');

// 路径别名缓存
let pathAliasesCache = null;
let pathAliasesLoadTime = 0;
const ALIAS_CACHE_TTL = 60000; // 1分钟缓存

// 加载路径别名
async function loadPathAliases() {
    const now = Date.now();
    if (pathAliasesCache && (now - pathAliasesLoadTime) < ALIAS_CACHE_TTL) {
        return pathAliasesCache;
    }
    
    const aliasPath = path.join(__dirname, '..', 'Plugin', 'MultimediaProcessor', 'path-aliases.json');
    try {
        const data = await fs.readFile(aliasPath, 'utf-8');
        pathAliasesCache = JSON.parse(data);
        pathAliasesLoadTime = now;
        return pathAliasesCache;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error(`[messageProcessor] 加载路径别名失败:`, error);
        }
        pathAliasesCache = {};
        pathAliasesLoadTime = now;
        return {};
    }
}

// 解析路径（支持别名和相对路径）
async function resolvePath(pathStr) {
    const pathAliases = await loadPathAliases();
    
    // 检查是否是别名路径
    for (const [alias, realPath] of Object.entries(pathAliases)) {
        if (pathStr.startsWith(alias + '/') || pathStr === alias) {
            return pathStr.replace(alias, realPath);
        }
    }
    
    // 如果是绝对路径，直接返回
    if (path.isAbsolute(pathStr)) {
        return pathStr;
    }
    
    // 否则视为相对于项目根目录的路径
    return path.resolve(__dirname, '..', pathStr);
}

// 读取文件为 Base64
async function readFileAsBase64(filePath) {
    try {
        const buffer = await fs.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        
        let mimeType = 'application/octet-stream';
        if (['.jpg', '.jpeg'].includes(ext)) mimeType = 'image/jpeg';
        else if (ext === '.png') mimeType = 'image/png';
        else if (ext === '.gif') mimeType = 'image/gif';
        else if (ext === '.webp') mimeType = 'image/webp';
        else if (ext === '.mp4') mimeType = 'video/mp4';
        else if (ext === '.mp3') mimeType = 'audio/mp3';
        else if (ext === '.wav') mimeType = 'audio/wav';
        else if (ext === '.ogg') mimeType = 'audio/ogg';
        else if (ext === '.flac') mimeType = 'audio/flac';
        else if (ext === '.m4a') mimeType = 'audio/m4a';
        else if (ext === '.mov') mimeType = 'video/quicktime';
        else if (ext === '.avi') mimeType = 'video/x-msvideo';
        
        const base64 = buffer.toString('base64');
        return `data:${mimeType};base64,${base64}`;
    } catch (error) {
        throw new Error(`读取文件失败 ${filePath}: ${error.message}`);
    }
}

// 获取目录下的所有媒体文件（支持 .showbase64ignore）
async function getMediaFiles(dirPath, supportedFormatsStr = '.jpg,.jpeg,.png,.gif,.webp,.bmp,.tiff,.mp4,.mov,.avi,.mp3,.wav,.ogg,.flac,.m4a') {
    const mediaExtensions = supportedFormatsStr.split(',').map(ext => ext.trim().toLowerCase());
    const files = [];
    
    // 读取 .showbase64ignore 文件（专用于 {{ShowBase64::path}}）
    const ig = ignore();
    const ignoreFilePath = path.join(dirPath, '.showbase64ignore');
    
    try {
        const ignoreFileContent = await fs.readFile(ignoreFilePath, 'utf-8');
        ig.add(ignoreFileContent);
    } catch (error) {
        // .showbase64ignore 不存在时静默忽略
    }
    
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                
                // 检查文件扩展名是否在白名单中
                if (!mediaExtensions.includes(ext)) {
                    continue;
                }
                
                // 检查文件是否被 ignore 规则排除
                const relativePath = entry.name;
                if (ig.ignores(relativePath)) {
                    continue;
                }
                
                const fullPath = path.join(dirPath, entry.name);
                files.push(fullPath);
            }
        }
    } catch (error) {
        throw new Error(`读取目录失败 ${dirPath}: ${error.message}`);
    }
    
    return files;
}

// 解析 ShowBase64::path 语法并替换为实际的 Base64 数据
// 注意：ShowBase64+::~ 由 MultimediaProcessor 插件直接处理，不在这里处理
async function processShowBase64Paths(text, context) {
    if (!text || typeof text !== 'string') return text;
    
    // 只匹配 ShowBase64::path（不带加号的版本）
    // 使用负向前瞻 (?!\+) 确保 ShowBase64 后面不跟 +
    const pattern = /\{\{ShowBase64(?!\+)::([^}]+)\}\}/g;
    const matches = [];
    let match;
    
    while ((match = pattern.exec(text)) !== null) {
        matches.push({
            fullMatch: match[0],
            path: match[1],
            index: match.index
        });
    }
    
    if (matches.length === 0) return text;
    
    let processedText = text;
    const { DEBUG_MODE } = context;
    
    // 从后往前替换，避免索引混乱
    for (let i = matches.length - 1; i >= 0; i--) {
        const matchItem = matches[i];
        
        try {
            const resolvedPath = await resolvePath(matchItem.path);
            
            // 检查路径是否存在
            let stat;
            try {
                stat = await fs.stat(resolvedPath);
            } catch (error) {
                if (DEBUG_MODE) {
                    console.warn(`[ShowBase64] 路径不存在: ${resolvedPath}`);
                }
                // 保留占位符，让后续处理流程继续
                continue;
            }
            
            const isFolder = stat.isDirectory();
            let filesToProcess = [];
            
            if (isFolder) {
                // 文件夹：获取所有媒体文件
                filesToProcess = await getMediaFiles(resolvedPath);
                if (DEBUG_MODE) {
                    console.log(`[ShowBase64] 文件夹 ${resolvedPath} 包含 ${filesToProcess.length} 个媒体文件`);
                }
            } else if (stat.isFile()) {
                // 单个文件
                filesToProcess = [resolvedPath];
            }
            
            if (filesToProcess.length === 0) {
                if (DEBUG_MODE) {
                    console.warn(`[ShowBase64] 未找到可处理的媒体文件: ${resolvedPath}`);
                }
                // 移除占位符，避免发送给 AI
                processedText = processedText.substring(0, matchItem.index) +
                              '' +
                              processedText.substring(matchItem.index + matchItem.fullMatch.length);
                continue;
            }
            
            // 读取所有文件的 Base64 数据
            const base64DataList = [];
            for (const filePath of filesToProcess) {
                try {
                    const base64Data = await readFileAsBase64(filePath);
                    base64DataList.push({
                        path: filePath,
                        filename: path.basename(filePath),
                        base64: base64Data
                    });
                } catch (error) {
                    console.error(`[ShowBase64] 读取文件失败 ${filePath}:`, error.message);
                }
            }
            
            if (base64DataList.length === 0) {
                // 移除占位符
                processedText = processedText.substring(0, matchItem.index) +
                              '' +
                              processedText.substring(matchItem.index + matchItem.fullMatch.length);
                continue;
            }
            
            if (DEBUG_MODE) {
                console.log(`[ShowBase64] 成功处理 ${base64DataList.length} 个文件，来自路径: ${matchItem.path}`);
            }
            
            // 移除占位符（Base64 数据将在后续注入到最后一条用户消息中）
            processedText = processedText.substring(0, matchItem.index) +
                          '' +
                          processedText.substring(matchItem.index + matchItem.fullMatch.length);
            
            // 将 Base64 数据存储到上下文中，供后续处理使用
            if (!context.showBase64Files) {
                context.showBase64Files = [];
            }
            context.showBase64Files.push(...base64DataList);
            
        } catch (error) {
            console.error(`[ShowBase64] 处理路径失败 ${matchItem.path}:`, error);
            // 移除占位符
            processedText = processedText.substring(0, matchItem.index) +
                          `[ShowBase64错误:${error.message}]` +
                          processedText.substring(matchItem.index + matchItem.fullMatch.length);
        }
    }
    
    return processedText;
}

async function resolveAllVariables(text, model, role, context, processingStack = new Set()) {
    if (text == null) return '';
    let processedText = String(text);
    
    // 最优先处理 ShowBase64::path 占位符（在所有其他变量替换之前）
    processedText = await processShowBase64Paths(processedText, context);

    // 通用正则表达式，匹配所有 {{...}} 格式的占位符
    const placeholderRegex = /\{\{([a-zA-Z0-9_:]+)\}\}/g;
    const matches = [...processedText.matchAll(placeholderRegex)];
    
    // 提取所有潜在的别名（去除 "agent:" 前缀）
    const allAliases = new Set(matches.map(match => match[1].replace(/^agent:/, '')));

    for (const alias of allAliases) {
        // 关键：使用 agentManager 来判断这是否是一个真正的Agent
        if (agentManager.isAgent(alias)) {
            if (processingStack.has(alias)) {
                console.error(`[AgentManager] Circular dependency detected! Stack: [${[...processingStack].join(' -> ')} -> ${alias}]`);
                const errorMessage = `[Error: Circular agent reference detected for '${alias}']`;
                processedText = processedText.replaceAll(`{{${alias}}}`, errorMessage).replaceAll(`{{agent:${alias}}}`, errorMessage);
                continue;
            }

            const agentContent = await agentManager.getAgentPrompt(alias);
            
            processingStack.add(alias);
            const resolvedAgentContent = await resolveAllVariables(agentContent, model, role, context, processingStack);
            processingStack.delete(alias);

            // 替换两种可能的Agent占位符格式
            processedText = processedText.replaceAll(`{{${alias}}}`, resolvedAgentContent);
            processedText = processedText.replaceAll(`{{agent:${alias}}}`, resolvedAgentContent);
        }
    }

    // 在所有Agent都被递归展开后，处理剩余的非Agent占位符
    processedText = await replacePriorityVariables(processedText, context, role);
    processedText = await replaceOtherVariables(processedText, model, role, context);

    return processedText;
}

async function replaceOtherVariables(text, model, role, context) {
    const { pluginManager, cachedEmojiLists, detectors, superDetectors, DEBUG_MODE } = context;
    if (text == null) return '';
    let processedText = String(text);

    if (role === 'system') {
        for (const envKey in process.env) {
            if (envKey.startsWith('Tar') || envKey.startsWith('Var')) {
                const placeholder = `{{${envKey}}}`;
                if (processedText.includes(placeholder)) {
                    const value = process.env[envKey];
                    if (value && typeof value === 'string' && value.toLowerCase().endsWith('.txt')) {
                        const fileContent = await tvsManager.getContent(value);
                        // 检查内容是否表示错误
                        if (fileContent.startsWith('[变量文件') || fileContent.startsWith('[处理变量文件')) {
                            processedText = processedText.replaceAll(placeholder, fileContent);
                        } else {
                            const resolvedContent = await replaceOtherVariables(fileContent, model, role, context);
                            processedText = processedText.replaceAll(placeholder, resolvedContent);
                        }
                    } else {
                        processedText = processedText.replaceAll(placeholder, value || `[未配置 ${envKey}]`);
                    }
                }
            }
        }

        let sarPromptToInject = null;
        const modelToPromptMap = new Map();
        for (const envKey in process.env) {
            if (/^SarModel\d+$/.test(envKey)) {
                const index = envKey.substring(8);
                const promptKey = `SarPrompt${index}`;
                let promptValue = process.env[promptKey];
                const models = process.env[envKey];

                if (promptValue && models) {
                    if (typeof promptValue === 'string' && promptValue.toLowerCase().endsWith('.txt')) {
                        const fileContent = await tvsManager.getContent(promptValue);
                        // 检查内容是否表示错误
                        if (fileContent.startsWith('[变量文件') || fileContent.startsWith('[处理变量文件')) {
                            promptValue = fileContent;
                        } else {
                            promptValue = await replaceOtherVariables(fileContent, model, role, context);
                        }
                    }
                    const modelList = models.split(',').map(m => m.trim()).filter(m => m);
                    for (const m of modelList) {
                        modelToPromptMap.set(m, promptValue);
                    }
                }
            }
        }

        if (model && modelToPromptMap.has(model)) {
            sarPromptToInject = modelToPromptMap.get(model);
        }

        const sarPlaceholderRegex = /\{\{Sar[a-zA-Z0-9_]+\}\}/g;
        if (sarPromptToInject !== null) {
            processedText = processedText.replaceAll(sarPlaceholderRegex, sarPromptToInject);
        } else {
            processedText = processedText.replaceAll(sarPlaceholderRegex, '');
        }

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
        
        const staticPlaceholderValues = pluginManager.getAllPlaceholderValues(); // Use the getter
        if (staticPlaceholderValues && staticPlaceholderValues.size > 0) {
            for (const [placeholder, value] of staticPlaceholderValues.entries()) {
                const placeholderRegex = new RegExp(placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
                // The getter now returns the correct string value
                processedText = processedText.replace(placeholderRegex, value || `[${placeholder} 信息不可用]`);
            }
        }

        const individualPluginDescriptions = pluginManager.getIndividualPluginDescriptions();
        if (individualPluginDescriptions && individualPluginDescriptions.size > 0) {
            for (const [placeholderKey, description] of individualPluginDescriptions) {
                processedText = processedText.replaceAll(`{{${placeholderKey}}}`, description || `[${placeholderKey} 信息不可用]`);
            }
        }

        if (processedText.includes('{{VCPAllTools}}')) {
            const vcpDescriptionsList = [];
            if (individualPluginDescriptions && individualPluginDescriptions.size > 0) {
                for (const description of individualPluginDescriptions.values()) {
                    vcpDescriptionsList.push(description);
                }
            }
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
            if (DEBUG_MODE) console.warn('[replaceOtherVariables] {{Image_Key}} placeholder found in text, but ImageServer plugin or its Image_Key is not resolved. Placeholder will not be replaced.');
        }
        for (const rule of detectors) {
            if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
                processedText = processedText.replaceAll(rule.detector, rule.output);
            }
        }
    }
    
    for (const rule of superDetectors) {
        if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
            processedText = processedText.replaceAll(rule.detector, rule.output);
        }
    }

    const asyncResultPlaceholderRegex = /\{\{VCP_ASYNC_RESULT::([a-zA-Z0-9_.-]+)::([a-zA-Z0-9_-]+)\}\}/g;
    let asyncMatch;
    let tempAsyncProcessedText = processedText;
    const promises = [];

    while ((asyncMatch = asyncResultPlaceholderRegex.exec(processedText)) !== null) {
        const placeholder = asyncMatch[0];
        const pluginName = asyncMatch[1];
        const requestId = asyncMatch[2];
        
        promises.push(
            (async () => {
                const resultFilePath = path.join(VCP_ASYNC_RESULTS_DIR, `${pluginName}-${requestId}.json`);
                try {
                    const fileContent = await fs.readFile(resultFilePath, 'utf-8');
                    const callbackData = JSON.parse(fileContent);
                    let replacementText = `[任务 ${pluginName} (ID: ${requestId}) 已完成]`;
                    if (callbackData && callbackData.message) {
                        replacementText = callbackData.message;
                    } else if (callbackData && callbackData.status === 'Succeed') {
                         replacementText = `任务 ${pluginName} (ID: ${requestId}) 已成功完成。详情: ${JSON.stringify(callbackData.data || callbackData.result || callbackData)}`;
                    } else if (callbackData && callbackData.status === 'Failed') {
                        replacementText = `任务 ${pluginName} (ID: ${requestId}) 处理失败。原因: ${callbackData.reason || JSON.stringify(callbackData.data || callbackData.error || callbackData)}`;
                    }
                    tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, replacementText);
                } catch (error) {
                    if (error.code === 'ENOENT') {
                        tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, `[任务 ${pluginName} (ID: ${requestId}) 结果待更新...]`);
                    } else {
                        console.error(`[replaceOtherVariables] Error processing async placeholder ${placeholder}:`, error);
                        tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, `[获取任务 ${pluginName} (ID: ${requestId}) 结果时出错]`);
                    }
                }
            })()
        );
    }
    
    await Promise.all(promises);
    processedText = tempAsyncProcessedText;

    return processedText;
}

async function replacePriorityVariables(text, context, role) {
    const { pluginManager, cachedEmojiLists, DEBUG_MODE } = context;
    if (text == null) return '';
    let processedText = String(text);

    // 只在 system role 中处理
    if (role !== 'system') {
        return processedText;
    }

    // --- 表情包处理 ---
    const emojiPlaceholderRegex = /\{\{(.+?表情包)\}\}/g;
    let emojiMatch;
    while ((emojiMatch = emojiPlaceholderRegex.exec(processedText)) !== null) {
        const placeholder = emojiMatch[0];
        const emojiName = emojiMatch[1];
        const emojiList = cachedEmojiLists.get(emojiName);
        processedText = processedText.replaceAll(placeholder, emojiList || `[${emojiName}列表不可用]`);
    }

    // --- 日记本处理 (已修复循环风险) ---
    const diaryPlaceholderRegex = /\{\{(.+?)日记本\}\}/g;
    let allDiariesData = {};
    const allDiariesDataString = pluginManager.getPlaceholderValue("{{AllCharacterDiariesData}}");

    if (allDiariesDataString && !allDiariesDataString.startsWith("[Placeholder")) {
        try {
            allDiariesData = JSON.parse(allDiariesDataString);
        } catch (e) {
            console.error(`[replacePriorityVariables] Failed to parse AllCharacterDiariesData JSON: ${e.message}. Data: ${allDiariesDataString.substring(0, 100)}...`);
        }
    } else if (allDiariesDataString && allDiariesDataString.startsWith("[Placeholder")) {
        if (DEBUG_MODE) console.warn(`[replacePriorityVariables] Placeholder {{AllCharacterDiariesData}} not found or not yet populated. Value: ${allDiariesDataString}`);
    }

    // Step 1: Find all unique diary placeholders in the original text to avoid loops.
    const matches = [...processedText.matchAll(diaryPlaceholderRegex)];
    const uniquePlaceholders = [...new Set(matches.map(match => match[0]))];

    // Step 2: Iterate through the unique placeholders and replace them.
    for (const placeholder of uniquePlaceholders) {
        // Extract character name from placeholder like "{{小雨日记本}}" -> "小雨"
        const characterNameMatch = placeholder.match(/\{\{(.+?)日记本\}\}/);
        if (characterNameMatch && characterNameMatch[1]) {
            const characterName = characterNameMatch[1];
            let diaryContent = `[${characterName}日记本内容为空或未从插件获取]`;
            if (allDiariesData.hasOwnProperty(characterName)) {
                diaryContent = allDiariesData[characterName];
            }
            // Replace all instances of this specific placeholder.
            // This is safe because we are iterating over a pre-determined list, not re-scanning the string.
            processedText = processedText.replaceAll(placeholder, diaryContent);
        }
    }

    return processedText;
}

module.exports = {
    // 导出主函数，并重命名旧函数以供内部调用
    replaceAgentVariables: resolveAllVariables,
    replaceOtherVariables,
    replacePriorityVariables
};