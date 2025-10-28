// Plugin/MultimediaProcessor/multimedia-processor.js
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const ignore = require('ignore');

let mediaCache = {}; // 优化后的格式: { hash: { base64Data, mimeType, paths: [], descriptions: { preset1: {...}, preset2: {...} } } }
const cachePath = path.join(__dirname, 'multimedia_cache.json');
let presets = {};
let pathAliases = {};
let pluginConfig = {};

// 调试日志
function debugLog(message, data) {
    if (pluginConfig.DebugMode) {
        console.log(`[MultimediaProcessor][Debug] ${message}`, data !== undefined ? JSON.stringify(data, null, 2) : '');
    }
}

// 加载缓存
async function loadCache() {
    try {
        const data = await fs.readFile(cachePath, 'utf-8');
        mediaCache = JSON.parse(data);
        console.log(`[MultimediaProcessor] 已加载 ${Object.keys(mediaCache).length} 条缓存记录`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`[MultimediaProcessor] 缓存文件不存在，将在首次使用时创建`);
            mediaCache = {};
            // 不自动创建空文件，等到真正有数据时再保存
        } else {
            console.error(`[MultimediaProcessor] 加载缓存失败:`, error);
            mediaCache = {};
        }
    }
}

// 保存缓存
async function saveCache() {
    try {
        await fs.writeFile(cachePath, JSON.stringify(mediaCache, null, 2));
        debugLog(`缓存已保存到 ${cachePath}`);
    } catch (error) {
        console.error(`[MultimediaProcessor] 保存缓存失败:`, error);
    }
}

// 加载预设配置
async function loadPresets() {
    const presetsPath = path.join(__dirname, 'presets.json');
    const examplePath = path.join(__dirname, 'presets.json.example');
    
    try {
        const data = await fs.readFile(presetsPath, 'utf-8');
        presets = JSON.parse(data);
        console.log(`[MultimediaProcessor] 已加载 ${Object.keys(presets).length} 个预设`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`[MultimediaProcessor] presets.json 不存在，尝试从 example 复制`);
            try {
                await fs.copyFile(examplePath, presetsPath);
                const data = await fs.readFile(presetsPath, 'utf-8');
                presets = JSON.parse(data);
                console.log(`[MultimediaProcessor] 已从 example 创建并加载预设`);
            } catch (copyError) {
                console.error(`[MultimediaProcessor] 无法创建预设文件:`, copyError);
                presets = { default: { displayName: '默认', prompt: '请描述这个内容', maxTokens: 1000 } };
            }
        } else {
            console.error(`[MultimediaProcessor] 加载预设失败:`, error);
            presets = { default: { displayName: '默认', prompt: '请描述这个内容', maxTokens: 1000 } };
        }
    }
}

// 加载路径别名
async function loadPathAliases() {
    const aliasPath = path.join(__dirname, 'path-aliases.json');
    try {
        const data = await fs.readFile(aliasPath, 'utf-8');
        pathAliases = JSON.parse(data);
        console.log(`[MultimediaProcessor] 已加载 ${Object.keys(pathAliases).length} 个路径别名`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            debugLog('path-aliases.json 不存在，使用空别名映射');
            pathAliases = {};
        } else {
            console.error(`[MultimediaProcessor] 加载路径别名失败:`, error);
            pathAliases = {};
        }
    }
}

// 解析路径（支持别名和相对路径）
function resolvePath(pathStr) {
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
    
    // 否则视为相对于插件目录的路径
    return path.resolve(__dirname, pathStr);
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
        
        const base64 = buffer.toString('base64');
        return `data:${mimeType};base64,${base64}`;
    } catch (error) {
        throw new Error(`读取文件失败 ${filePath}: ${error.message}`);
    }
}

// 获取目录下的所有媒体文件（支持 ignore 文件和配置的格式白名单）
// ignoreFileName: 要使用的 ignore 文件名，如 '.overbase64ignore' 或 '.showbase64plusignore'
async function getMediaFiles(dirPath, config, ignoreFileName = '.overbase64ignore') {
    // 从配置获取支持的格式，如果未配置则使用默认值
    const supportedFormatsStr = config.SupportedMediaFormats || '.jpg,.jpeg,.png,.gif,.webp,.bmp,.tiff,.mp4,.mov,.avi,.mp3,.wav,.ogg,.flac,.m4a';
    const mediaExtensions = supportedFormatsStr.split(',').map(ext => ext.trim().toLowerCase());
    
    if (pluginConfig.DebugMode) {
        debugLog(`支持的媒体格式: ${mediaExtensions.join(', ')}`);
    }
    
    const files = [];
    
    // 读取指定的 ignore 文件（如果存在）
    const ig = ignore();
    const ignoreFilePath = path.join(dirPath, ignoreFileName);
    try {
        const ignoreFileContent = await fs.readFile(ignoreFilePath, 'utf-8');
        ig.add(ignoreFileContent);
        if (pluginConfig.DebugMode) {
            debugLog(`已加载 ${ignoreFileName} 文件: ${ignoreFilePath}`);
        }
    } catch (error) {
        // 忽略文件不存在的错误
        if (error.code !== 'ENOENT' && pluginConfig.DebugMode) {
            debugLog(`读取 ${ignoreFileName} 失败: ${error.message}`);
        }
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
                
                // 检查文件是否被 ignore 规则排除（黑名单）
                const relativePath = entry.name;
                if (ig.ignores(relativePath)) {
                    if (pluginConfig.DebugMode) {
                        debugLog(`文件被忽略: ${relativePath}`);
                    }
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

// 调用多模态 API 获取描述
async function getMediaDescription(base64Data, preset, config) {
    const { default: fetch } = await import('node-fetch');
    
    const base64PrefixPattern = /^data:(image|audio|video)\/[^;]+;base64,/;
    const pureBase64 = base64Data.replace(base64PrefixPattern, '');
    const mimeType = (base64Data.match(base64PrefixPattern) || ['data:application/octet-stream;base64,'])[0].replace('base64,', '');
    
    const maxRetries = 3;
    let attempt = 0;
    let lastError = null;
    
    while (attempt < maxRetries) {
        attempt++;
        try {
            // 使用预设中的模型，如果未设置则使用全局配置
            const modelToUse = preset.model || config.MultiModalModel;
            
            const payload = {
                model: modelToUse,
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: preset.prompt },
                        { type: "image_url", image_url: { url: `${mimeType}base64,${pureBase64}` } }
                    ]
                }],
                max_tokens: preset.maxTokens || config.MultiModalModelOutputMaxTokens || 2000
            };
            
            // 添加温度参数（如果设置）
            if (preset.temperature !== undefined && preset.temperature !== null) {
                payload.temperature = preset.temperature;
            }
            
            // 添加 top_p 参数（如果设置）
            if (preset.topP !== undefined && preset.topP !== null) {
                payload.top_p = preset.topP;
            }
            
            // 添加思考预算（如果设置）
            if (preset.thinkingBudget || config.MultiModalModelThinkingBudget) {
                payload.extra_body = {
                    thinking_config: {
                        thinking_budget: preset.thinkingBudget || config.MultiModalModelThinkingBudget
                    }
                };
            }
            
            const response = await fetch(`${config.API_URL}/v1/chat/completions`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json', 
                    'Authorization': `Bearer ${config.API_Key}` 
                },
                body: JSON.stringify(payload)
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API 调用失败 (尝试 ${attempt}): ${response.status} - ${errorText}`);
            }
            
            const result = await response.json();
            const description = result.choices?.[0]?.message?.content?.trim();
            
            if (description && description.length >= 10) {
                return description.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
            } else {
                lastError = new Error(`描述过短 (长度: ${description?.length || 0}, 尝试 ${attempt})`);
            }
        } catch (error) {
            lastError = error;
            console.error(`[MultimediaProcessor] 获取描述失败 (尝试 ${attempt}):`, error.message);
        }
        
        if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        }
    }
    
    throw new Error(`${maxRetries} 次尝试后仍然失败: ${lastError?.message || '未知错误'}`);
}

// 处理单个媒体项
async function processMediaItem(base64Data, presetNames, useCache, config, metadata = {}) {
    const base64PrefixPattern = /^data:(image|audio|video)\/[^;]+;base64,/;
    const pureBase64 = base64Data.replace(base64PrefixPattern, '');
    const mimeTypeMatch = base64Data.match(base64PrefixPattern);
    const mimeType = mimeTypeMatch ? mimeTypeMatch[0] : 'data:application/octet-stream;base64,';
    const hash = crypto.createHash('md5').update(pureBase64).digest('hex');
    
    // 确保该文件的缓存记录存在
    if (!mediaCache[hash]) {
        mediaCache[hash] = {
            // === 基本标识信息 ===
            id: crypto.randomUUID(),
            hash: hash,
            cacheVersion: '3.0',
            
            // === 媒体数据（只存储一次）===
            mimeType: mimeType.replace('data:', '').replace(';base64,', ''),
            base64Data: pureBase64, // 完整 Base64 数据，所有预设共享
            fileSize: Math.ceil(pureBase64.length * 0.75),
            
            // === 路径信息 ===
            paths: [], // 存储该文件被引用的所有路径
            
            // === 时间信息 ===
            createdTime: new Date().toISOString(),
            lastAccessTime: new Date().toISOString(),
            
            // === 不同预设的描述结果 ===
            descriptions: {}
        };
    }
    
    // 更新路径信息（如果是新路径则添加）
    const pathInfo = {
        originalPath: metadata.originalPath,
        resolvedPath: metadata.resolvedPath,
        usedAlias: metadata.usedAlias,
        aliasName: metadata.aliasName,
        isFolder: metadata.isFolder,
        folderPath: metadata.folderPath,
        batchId: metadata.batchId,
        groupId: metadata.groupId,
        fileIndex: metadata.fileIndex,
        totalFiles: metadata.totalFiles,
        lastUsed: new Date().toISOString()
    };
    
    // 检查是否已存在相同的路径记录
    const existingPathIndex = mediaCache[hash].paths.findIndex(p =>
        p.resolvedPath === pathInfo.resolvedPath
    );
    
    if (existingPathIndex >= 0) {
        // 更新现有路径的最后使用时间
        mediaCache[hash].paths[existingPathIndex].lastUsed = pathInfo.lastUsed;
    } else {
        // 添加新路径
        mediaCache[hash].paths.push(pathInfo);
    }
    
    const results = [];
    
    for (const presetName of presetNames) {
        const preset = presets[presetName] || presets['default'];
        
        // 检查该预设的描述是否已存在
        if (useCache && mediaCache[hash].descriptions[presetName]) {
            debugLog(`缓存命中: ${presetName}`, { hash: hash.substring(0, 8) });
            
            // 更新访问信息
            mediaCache[hash].lastAccessTime = new Date().toISOString();
            mediaCache[hash].descriptions[presetName].lastAccessTime = new Date().toISOString();
            mediaCache[hash].descriptions[presetName].accessCount =
                (mediaCache[hash].descriptions[presetName].accessCount || 0) + 1;
            await saveCache();
            
            results.push({
                preset: presetName,
                description: mediaCache[hash].descriptions[presetName].description,
                cached: true,
                timestamp: mediaCache[hash].descriptions[presetName].createdTime
            });
            continue;
        }
        
        // 调用 API 获取描述
        try {
            debugLog(`调用 API: ${presetName}`, { hash: hash.substring(0, 8) });
            const description = await getMediaDescription(base64Data, preset, config);
            
            // 保存该预设的描述结果
            mediaCache[hash].descriptions[presetName] = {
                description: description,
                descriptionLength: description.length,
                
                // 预设配置
                presetConfig: {
                    model: preset.model || config.MultiModalModel || 'default',
                    temperature: preset.temperature,
                    maxTokens: preset.maxTokens,
                    topP: preset.topP,
                    thinkingBudget: preset.thinkingBudget
                },
                
                // 时间信息
                createdTime: new Date().toISOString(),
                lastAccessTime: new Date().toISOString(),
                
                // 使用统计
                accessCount: 1
            };
            
            // 更新文件的最后访问时间
            mediaCache[hash].lastAccessTime = new Date().toISOString();
            await saveCache();
            
            results.push({
                preset: presetName,
                description,
                cached: false,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error(`[MultimediaProcessor] 处理预设 ${presetName} 失败:`, error.message);
            results.push({
                preset: presetName,
                error: error.message,
                cached: false
            });
        }
    }
    
    return results;
}

// 解析 OverBase64 语法
function parseOverBase64Syntax(text) {
    const pattern = /\{\{OverBase64::([^:]+)::([^:}]+)(?:::(cache|no_cache))?\}\}/g;
    const matches = [];
    let match;
    
    while ((match = pattern.exec(text)) !== null) {
        const presetsStr = match[1];
        const pathStr = match[2];
        const cacheFlag = match[3]; // 'cache', 'no_cache', 或 undefined
        
        // 默认使用缓存，只有明确指定 ::no_cache 才禁用
        const useCache = cacheFlag !== 'no_cache';
        
        const presetNames = presetsStr.split(';').map(p => p.trim()).slice(0, 5); // 最多5个预设
        
        matches.push({
            fullMatch: match[0],
            presetNames,
            path: pathStr,
            useCache,
            index: match.index
        });
    }
    
    return matches;
}

// 解析 ShowBase64+ 语法
function parseShowBase64PlusSyntax(text) {
    const pattern = /\{\{ShowBase64\+::([^:]+)::([^:}]+)(?:::(cache|no_cache))?\}\}/g;
    const matches = [];
    let match;
    
    while ((match = pattern.exec(text)) !== null) {
        const presetsStr = match[1];
        const pathStr = match[2];
        const cacheFlag = match[3]; // 'cache', 'no_cache', 或 undefined
        
        // 默认使用缓存，只有明确指定 ::no_cache 才禁用
        const useCache = cacheFlag !== 'no_cache';
        
        const presetNames = presetsStr.split(';').map(p => p.trim()).slice(0, 5); // 最多5个预设
        
        matches.push({
            fullMatch: match[0],
            presetNames,
            path: pathStr,
            useCache,
            index: match.index
        });
    }
    
    return matches;
}

module.exports = {
    async initialize(initialConfig = {}) {
        pluginConfig = initialConfig;
        await loadCache();
        await loadPresets();
        await loadPathAliases();
        console.log('[MultimediaProcessor] 初始化完成');
    },
    
    async processMessages(messages, requestConfig = {}) {
        const config = { ...pluginConfig, ...requestConfig };
        const processedMessages = JSON.parse(JSON.stringify(messages));
        
        // 用于存储 ShowBase64+ 需要注入的原始 Base64 数据
        const showBase64PlusDataToInject = [];
        
        for (let i = 0; i < processedMessages.length; i++) {
            const msg = processedMessages[i];
            
            // 只处理 user 和 system 角色的消息
            if (msg.role !== 'user' && msg.role !== 'system') continue;
            
            // 处理字符串类型的 content
            if (typeof msg.content === 'string') {
                // 先处理 ShowBase64+（优先级更高，因为它既需要描述又需要原始数据）
                const showBase64PlusMatches = parseShowBase64PlusSyntax(msg.content);
                
                // 再处理 OverBase64
                const overBase64Matches = parseOverBase64Syntax(msg.content);
                
                // 合并所有匹配，按索引从后往前排序
                const allMatches = [
                    ...showBase64PlusMatches.map(m => ({ ...m, type: 'plus' })),
                    ...overBase64Matches.map(m => ({ ...m, type: 'over' }))
                ].sort((a, b) => b.index - a.index);
                
                if (allMatches.length === 0) continue;
                
                let newContent = msg.content;
                
                // 从后往前替换，避免索引混乱
                for (const match of allMatches) {
                    
                    try {
                        const resolvedPath = resolvePath(match.path);
                        const stat = await fs.stat(resolvedPath);
                        
                        // 检查是否使用了别名
                        let usedAlias = false;
                        let aliasName = null;
                        for (const [alias, realPath] of Object.entries(pathAliases)) {
                            if (match.path.startsWith(alias + '/') || match.path === alias) {
                                usedAlias = true;
                                aliasName = alias;
                                break;
                            }
                        }
                        
                        let filesToProcess = [];
                        const isFolder = stat.isDirectory();
                        
                        if (isFolder) {
                            // 根据占位符类型选择对应的 ignore 文件
                            const ignoreFileName = match.type === 'plus' ? '.showbase64plusignore' : '.overbase64ignore';
                            filesToProcess = await getMediaFiles(resolvedPath, config, ignoreFileName);
                        } else if (stat.isFile()) {
                            // 对于单个文件，也检查格式白名单
                            const ext = path.extname(resolvedPath).toLowerCase();
                            const supportedFormatsStr = config.SupportedMediaFormats || '.jpg,.jpeg,.png,.gif,.webp,.bmp,.tiff,.mp4,.mov,.avi,.mp3,.wav,.ogg,.flac,.m4a';
                            const mediaExtensions = supportedFormatsStr.split(',').map(e => e.trim().toLowerCase());
                            
                            if (mediaExtensions.includes(ext)) {
                                filesToProcess = [resolvedPath];
                            } else {
                                newContent = newContent.substring(0, match.index) +
                                           `[错误: 文件格式 ${ext} 不在支持的格式列表中]` +
                                           newContent.substring(match.index + match.fullMatch.length);
                                continue;
                            }
                        }
                        
                        if (filesToProcess.length === 0) {
                            newContent = newContent.substring(0, match.index) +
                                       `[错误: 未找到媒体文件]` +
                                       newContent.substring(match.index + match.fullMatch.length);
                            continue;
                        }
                        
                        // 生成批次和组合标识
                        const batchId = crypto.randomUUID();
                        const groupId = crypto.createHash('md5')
                            .update(resolvedPath + match.presetNames.join(';') + Date.now())
                            .digest('hex');
                        
                        // 处理所有文件
                        const allResults = [];
                        const allBase64DataList = []; // 用于 ShowBase64+ 存储原始 Base64
                        const asyncLimit = config.MultiModalModelAsynchronousLimit || 1;
                        
                        for (let k = 0; k < filesToProcess.length; k += asyncLimit) {
                            const batch = filesToProcess.slice(k, k + asyncLimit);
                            const batchPromises = batch.map(async (file, batchIndex) => {
                                const base64Data = await readFileAsBase64(file);
                                
                                // 如果是 ShowBase64+ 类型，保存原始 Base64 数据供后续注入
                                if (match.type === 'plus') {
                                    allBase64DataList.push({
                                        filename: path.basename(file),
                                        base64: base64Data,
                                        path: file
                                    });
                                }
                                
                                // 构建元数据
                                const metadata = {
                                    originalPath: match.path,
                                    resolvedPath: file,
                                    usedAlias: usedAlias,
                                    aliasName: aliasName,
                                    isFolder: isFolder,
                                    folderPath: isFolder ? resolvedPath : null,
                                    batchId: batchId,
                                    groupId: groupId,
                                    fileIndex: k + batchIndex,
                                    totalFiles: filesToProcess.length
                                };
                                
                                const results = await processMediaItem(
                                    base64Data,
                                    match.presetNames,
                                    match.useCache,
                                    config,
                                    metadata
                                );
                                return { file: path.basename(file), results };
                            });
                            const batchResults = await Promise.all(batchPromises);
                            allResults.push(...batchResults);
                        }
                        
                        // 如果是 ShowBase64+ 类型，将原始 Base64 数据添加到待注入列表
                        if (match.type === 'plus' && allBase64DataList.length > 0) {
                            showBase64PlusDataToInject.push(...allBase64DataList);
                        }
                        
                        // 格式化结果（描述文本）
                        const typeLabel = match.type === 'plus' ? 'ShowBase64+' : 'OverBase64';
                        let replacement = `\n[多媒体内容分析结果 - ${typeLabel}]\n`;
                        allResults.forEach(({ file, results }) => {
                            replacement += `\n文件: ${file}\n`;
                            results.forEach(r => {
                                if (r.error) {
                                    replacement += `  [${r.preset}] 错误: ${r.error}\n`;
                                } else {
                                    replacement += `  [${r.preset}${r.cached ? ' (缓存)' : ''}]: ${r.description}\n`;
                                }
                            });
                        });
                        replacement += '\n';
                        
                        newContent = newContent.substring(0, match.index) + 
                                   replacement + 
                                   newContent.substring(match.index + match.fullMatch.length);
                        
                    } catch (error) {
                        console.error(`[MultimediaProcessor] 处理路径失败 ${match.path}:`, error);
                        newContent = newContent.substring(0, match.index) + 
                                   `[错误: ${error.message}]` + 
                                   newContent.substring(match.index + match.fullMatch.length);
                    }
                }
                
                msg.content = newContent;
            }
        }
        
        // 如果有 ShowBase64+ 的原始数据需要注入，将它们添加到最后一条用户消息
        if (showBase64PlusDataToInject.length > 0) {
            // 查找最后一条用户消息
            for (let i = processedMessages.length - 1; i >= 0; i--) {
                if (processedMessages[i].role === 'user') {
                    const lastUserMsg = processedMessages[i];
                    
                    // 确保消息是多模态格式
                    if (typeof lastUserMsg.content === 'string') {
                        lastUserMsg.content = [
                            { type: 'text', text: lastUserMsg.content }
                        ];
                    }
                    
                    // 注入所有 ShowBase64+ 的原始 Base64 数据
                    for (const { base64 } of showBase64PlusDataToInject) {
                        lastUserMsg.content.push({
                            type: 'image_url',
                            image_url: { url: base64 }
                        });
                    }
                    
                    debugLog(`ShowBase64+ 已注入 ${showBase64PlusDataToInject.length} 个原始文件到最后一条用户消息`);
                    break;
                }
            }
        }
        
        return processedMessages;
    },
    
    async shutdown() {
        await saveCache();
        console.log('[MultimediaProcessor] 关闭完成，缓存已保存');
    }
};