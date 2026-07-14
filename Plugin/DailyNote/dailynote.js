#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// --- Load environment variables ---
require('dotenv').config({ path: path.join(__dirname, 'config.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', 'config.env') }); // Load root config

// --- Configuration ---
const DEBUG_MODE = (process.env.DebugMode || "false").toLowerCase() === "true";
const projectBasePath = process.env.PROJECT_BASE_PATH;
const dailyNoteRootPath = process.env.KNOWLEDGEBASE_ROOT_PATH || (projectBasePath ? path.join(projectBasePath, 'dailynote') : path.join(__dirname, '..', '..', 'dailynote'));

// ImageServer 相关配置（由 Plugin.js 自动注入）
const SERVER_PORT = process.env.SERVER_PORT;
const IMAGESERVER_IMAGE_KEY = process.env.IMAGESERVER_IMAGE_KEY;
const IMAGESERVER_FILE_KEY = process.env.IMAGESERVER_FILE_KEY;
const VAR_HTTP_URL = process.env.VarHttpUrl;

// Config for 'create' command
const CONFIGURED_EXTENSION = (process.env.DAILY_NOTE_EXTENSION || "txt").toLowerCase() === "md" ? "md" : "txt";

// Tag AI helper configuration (disabled by default)
const TAG_MASTER_ENABLED = (process.env.TagMaster || "false").toLowerCase() === "true";
const TAG_MODEL = process.env.TagModel || 'gemini-2.5-flash-preview-09-2025-thinking';
const TAG_MODEL_MAX_OUTPUT_TOKENS = parseInt(process.env.TagModelMaxOutPutTokens || '30000', 10);
const TAG_MODEL_MAX_TOKENS = parseInt(process.env.TagModelMaxTokens || '40000', 10);
const TAG_MODEL_PROMPT_FILE = process.env.TagModelPrompt || 'TagMaster.txt';
const API_KEY = process.env.API_Key;
const API_URL = process.env.API_URL;

// Fuzzy Diff for Update Failures
const FUZZY_DIFF_ENABLED = (process.env.DAILY_NOTE_FUZZY_DIFF || "false").toLowerCase() === "true";
const UPDATE_FAILURE_HINT = "请检查字段或标点符号是否与原文一致；若多次失败，可尝试使用 DailyNoteManager 插件 list 对应文件夹/日期，以检索日记原文状态后再重试。";

// 忽略的文件夹列表
const IGNORED_FOLDERS = ['MusicDiary'];

// --- Resident Service State ---
// DailyNote 升级为 direct 常驻服务后，所有 create/update 都通过同一条进程内队列执行。
// 文件落盘后即可向 AI 返回；SQLite/Rust 向量入库仍由
// KnowledgeBaseManager.runExternalFileMutation() 的内部 FIFO 队列托管并在后台完成。
let knowledgeBaseManager = null;
let residentQueue = Promise.resolve();
let residentAcceptingRequests = true;
let residentPendingCount = 0;
let residentInitialized = false;


// --- Debug Logging (to stderr) ---
function debugLog(message, ...args) {
    if (DEBUG_MODE) {
        console.error(`[DailyNote][Debug] ${message}`, ...args); // Log debug to stderr
    }
}

// --- Helper Function for Sanitization (增强版) ---
function sanitizePathComponent(name) {
    if (!name || typeof name !== 'string') {
        return 'Untitled';
    }

    let sanitized = name
        // 1. 移除路径分隔符和 Windows 非法字符
        .replace(/[\\/:*?"<>|]/g, '')
        // 2. 移除控制字符 (0x00-0x1F, 0x7F)
        .replace(/[\x00-\x1f\x7f]/g, '')
        // 3. 移除 Unicode 方向控制字符 (可用于视觉欺骗)
        .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        // 4. 移除零宽字符
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        // 5. 将所有空白字符替换为下划线，防止 NTFS 索引问题
        .replace(/\s+/g, '_')
        // 6. 移除开头和结尾的点和下划线
        .replace(/^[._]+|[._]+$/g, '')
        // 7. 合并多个连续的下划线（美观 + 防止变体攻击）
        .replace(/_+/g, '_');

    // 8. Windows 保留名检查 (不区分大小写)
    const windowsReserved = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;
    if (windowsReserved.test(sanitized)) {
        sanitized = '_' + sanitized;
        debugLog(`Renamed Windows reserved name to: ${sanitized}`);
    }

    // 9. 长度限制 (预留空间给文件名)
    const MAX_FOLDER_NAME_LENGTH = 100;
    if (sanitized.length > MAX_FOLDER_NAME_LENGTH) {
        sanitized = sanitized.substring(0, MAX_FOLDER_NAME_LENGTH).replace(/[._]+$/g, '');
        debugLog(`Truncated folder name to ${MAX_FOLDER_NAME_LENGTH} chars`);
    }

    return sanitized || 'Untitled';
}

// --- 新增：路径安全验证函数 ---
function isPathWithinBase(targetPath, basePath) {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedBase = path.resolve(basePath);
    // 确保目标路径以基础路径开头（加 sep 防止 /base123 匹配 /base）
    return resolvedTarget === resolvedBase ||
        resolvedTarget.startsWith(resolvedBase + path.sep);
}

// --- Folder Resolution Helpers ---
const FOLDER_NOISE_WORDS = [
    '日记本'
];

function normalizeDiaryFolderAlias(name) {
    if (!name || typeof name !== 'string') {
        return '';
    }

    let normalized = name.trim();
    for (const word of FOLDER_NOISE_WORDS) {
        normalized = normalized.split(word).join('');
    }

    normalized = normalized
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .replace(/\s+/g, '')
        .replace(/[._]+$/g, '')
        .trim();

    return normalized;
}

function calculateFolderMatchScore(requestedAlias, existingAlias) {
    if (!requestedAlias || !existingAlias) {
        return 0;
    }

    if (requestedAlias === existingAlias) {
        return 100000 + existingAlias.length;
    }

    if (requestedAlias.includes(existingAlias)) {
        return 50000 + existingAlias.length;
    }

    if (existingAlias.includes(requestedAlias)) {
        return 40000 + requestedAlias.length;
    }

    return 0;
}

function isPublicFolderAlias(alias) {
    return alias === '公共' || alias.startsWith('公共的') || alias.startsWith('公共_');
}

function isFolderMatchAllowedByOwner(requestedAlias, existingAlias, ownerAlias) {
    if (!ownerAlias) {
        return true;
    }

    const requestedIsPublic = isPublicFolderAlias(requestedAlias);
    const existingIsPublic = isPublicFolderAlias(existingAlias);

    if (requestedIsPublic || existingIsPublic) {
        return requestedIsPublic && existingIsPublic;
    }

    return existingAlias === ownerAlias || existingAlias.startsWith(ownerAlias + '的');
}

async function resolveDiaryFolderName(folderName, options = {}) {
    const {
        allowFuzzyExisting = true,
        fallbackName = 'Untitled',
        logContext = 'folder',
        ownerName = ''
    } = options;

    const rawName = typeof folderName === 'string' ? folderName.trim() : '';
    const aliasName = normalizeDiaryFolderAlias(rawName);
    const ownerAlias = normalizeDiaryFolderAlias(ownerName);
    const candidateName = aliasName || rawName || fallbackName;
    const sanitizedCandidate = sanitizePathComponent(candidateName);

    if (!allowFuzzyExisting) {
        return {
            folderName: sanitizedCandidate,
            matchedExisting: false,
            requestedName: rawName,
            normalizedAlias: aliasName
        };
    }

    let allDirEntries = [];
    try {
        allDirEntries = await fs.readdir(dailyNoteRootPath, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') {
            debugLog(`resolveDiaryFolderName: root does not exist yet, using sanitized ${logContext}: ${sanitizedCandidate}`);
            return {
                folderName: sanitizedCandidate,
                matchedExisting: false,
                requestedName: rawName,
                normalizedAlias: aliasName
            };
        }
        throw error;
    }

    let bestMatch = null;
    for (const dirEntry of allDirEntries) {
        if (!dirEntry.isDirectory() || IGNORED_FOLDERS.includes(dirEntry.name)) {
            continue;
        }

        const dirPath = path.join(dailyNoteRootPath, dirEntry.name);
        if (!isPathWithinBase(dirPath, dailyNoteRootPath)) {
            debugLog(`resolveDiaryFolderName: skipping unsafe directory: ${dirPath}`);
            continue;
        }

        const existingAlias = normalizeDiaryFolderAlias(dirEntry.name);
        if (!isFolderMatchAllowedByOwner(aliasName, existingAlias, ownerAlias)) {
            debugLog(`resolveDiaryFolderName: owner guard skipped folder "${dirEntry.name}" for requested "${rawName}" and owner "${ownerName}"`);
            continue;
        }

        const score = calculateFolderMatchScore(aliasName, existingAlias);
        if (
            score > 0 &&
            (!bestMatch ||
                score > bestMatch.score ||
                (score === bestMatch.score && dirEntry.name.length < bestMatch.name.length))
        ) {
            bestMatch = {
                name: dirEntry.name,
                score,
                alias: existingAlias
            };
        }
    }

    if (bestMatch) {
        debugLog(
            `Resolved ${logContext} "${rawName}" (alias: "${aliasName}") to existing folder "${bestMatch.name}" (alias: "${bestMatch.alias}", score: ${bestMatch.score})`
        );
        return {
            folderName: bestMatch.name,
            matchedExisting: true,
            requestedName: rawName,
            normalizedAlias: aliasName,
            matchedAlias: bestMatch.alias
        };
    }

    debugLog(`No existing folder matched ${logContext} "${rawName}" (alias: "${aliasName}"), using new folder "${sanitizedCandidate}"`);
    return {
        folderName: sanitizedCandidate,
        matchedExisting: false,
        requestedName: rawName,
        normalizedAlias: aliasName
    };
}

// --- Tag Processing Functions (for 'create' command) ---

function detectTagLine(content) {
    const lines = content.split('\n');
    if (lines.length === 0) {
        return { hasTag: false, lastLine: '', contentWithoutLastLine: content };
    }
    const lastLine = lines[lines.length - 1].trim();
    const tagPattern = /^Tag:\s*.+/i;
    const hasTag = tagPattern.test(lastLine);
    const contentWithoutLastLine = hasTag ? lines.slice(0, -1).join('\n') : content;
    debugLog(`Tag detection - hasTag: ${hasTag}, lastLine: "${lastLine}"`);
    return { hasTag, lastLine, contentWithoutLastLine };
}

function fixTagFormat(tagLine) {
    debugLog('Fixing tag line format:', tagLine);
    let fixed = tagLine.trim();
    fixed = fixed.replace(/^tag:\s*/i, 'Tag: ');
    if (!fixed.startsWith('Tag: ')) {
        fixed = 'Tag: ' + fixed;
    }
    const tagContent = fixed.substring(5).trim();
    let normalizedContent = tagContent
        .replace(/[\uff1a]/g, '')
        .replace(/[\uff0c]/g, ', ')
        .replace(/[\u3001]/g, ', ')
        .replace(/[。.]+$/g, ''); // 🔧 修复：移除末尾的中文句号和英文句号
    normalizedContent = normalizedContent
        .replace(/,\s*/g, ', ')
        .replace(/,\s{2,}/g, ', ')
        .replace(/\s+,/g, ',');
    normalizedContent = normalizedContent.replace(/\s{2,}/g, ' ').trim();
    const result = 'Tag: ' + normalizedContent;
    debugLog('Fixed tag line:', result);
    return result;
}


function extractTagFromAIResponse(aiResponse) {
    debugLog('Extracting tag from AI response:', aiResponse);

    const match = aiResponse.match(/\[\[Tag:\s*(.+?)\]\]/i);
    if (match && match[1]) {
        const tagContent = match[1].trim();
        const result = 'Tag: ' + tagContent;
        debugLog('Extracted tag:', result);
        return result;
    }

    debugLog('No tag found in AI response');
    return null;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateTagsWithAI(content, maxRetries = 3) {
    debugLog('Generating tags with AI model...');

    if (!TAG_MASTER_ENABLED) {
        debugLog('TagMaster disabled, skipping AI tag generation.');
        return null;
    }

    if (!API_KEY || !API_URL) {
        console.error('[DailyNote] API configuration missing. Cannot generate tags.');
        return null;
    }

    const promptFilePath = path.join(__dirname, TAG_MODEL_PROMPT_FILE);
    let systemPrompt;
    try {
        systemPrompt = await fs.readFile(promptFilePath, 'utf-8');
    } catch (err) {
        console.error('[DailyNote] Failed to read TagMaster prompt file:', err.message);
        return null;
    }

    const requestData = {
        model: TAG_MODEL,
        messages: [
            {
                role: 'system',
                content: systemPrompt
            },
            {
                role: 'user',
                content: content
            }
        ],
        max_tokens: TAG_MODEL_MAX_TOKENS,
        max_output_tokens: TAG_MODEL_MAX_OUTPUT_TOKENS,
        temperature: 0.7
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            debugLog(`Calling AI API (attempt ${attempt}/${maxRetries}) with model: ${TAG_MODEL}`);

            const fetch = (await import('node-fetch')).default;
            const response = await fetch(`${API_URL}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEY}`
                },
                body: JSON.stringify(requestData),
                timeout: 60000
            });

            if (response.status === 500 || response.status === 503) {
                const errorText = await response.text();
                console.error(`[DailyNote] Tag AI API returned ${response.status} (attempt ${attempt}/${maxRetries}):`, errorText);

                if (attempt < maxRetries) {
                    const backoffTime = Math.pow(2, attempt - 1) * 1000;
                    debugLog(`Retrying tag generation after ${backoffTime}ms...`);
                    await delay(backoffTime);
                    continue;
                }

                console.error('[DailyNote] Max retries reached. Giving up tag generation.');
                return null;
            }

            if (!response.ok) {
                const errorText = await response.text();
                console.error('[DailyNote] Tag AI API error:', response.status, errorText);
                return null;
            }

            const result = await response.json();
            if (result.choices && result.choices.length > 0 && result.choices[0].message) {
                const aiResponse = result.choices[0].message.content;
                debugLog('Tag AI response:', aiResponse);

                const tagLine = extractTagFromAIResponse(aiResponse);
                if (tagLine) {
                    debugLog(`Successfully generated tag on attempt ${attempt}`);
                }
                return tagLine;
            }

            console.error('[DailyNote] Unexpected Tag AI response format:', result);
            return null;
        } catch (error) {
            console.error(`[DailyNote] Tag AI error on attempt ${attempt}/${maxRetries}:`, error.message);

            if (attempt < maxRetries) {
                const backoffTime = Math.pow(2, attempt - 1) * 1000;
                debugLog(`Retrying tag generation after ${backoffTime}ms due to error...`);
                await delay(backoffTime);
                continue;
            }

            console.error('[DailyNote] Max retries reached after errors. Giving up tag generation.');
            return null;
        }
    }

    return null;
}

async function processTags(contentText, externalTag) {
    debugLog('Processing tags...');
    const detection = detectTagLine(contentText);

    // Prioritize externalTag if provided, but deduplicate any existing trailing tag line in content
    if (externalTag && typeof externalTag === 'string' && externalTag.trim() !== '') {
        debugLog('External tag provided, using it:', externalTag);
        if (detection.hasTag) {
            debugLog('Trailing tag detected in content while external tag is provided, removing duplicate trailing tag line.');
        }
        const fixedTag = fixTagFormat(externalTag);
        const contentBody = detection.hasTag ? detection.contentWithoutLastLine : contentText;
        return contentBody.trimEnd() + '\n' + fixedTag;
    }

    // Fallback to detecting tag in content
    debugLog('No external tag, detecting tag in content...');
    if (detection.hasTag) {
        debugLog('Tag detected in content, fixing format...');
        const fixedTag = fixTagFormat(detection.lastLine);
        // Ensure there's exactly one newline before the tag.
        return detection.contentWithoutLastLine.trimEnd() + '\n' + fixedTag;
    }

    if (TAG_MASTER_ENABLED) {
        debugLog('No tag detected, TagMaster enabled; generating with AI...');
        const generatedTag = await generateTagsWithAI(contentText);
        if (generatedTag) {
            const fixedTag = fixTagFormat(generatedTag);
            debugLog('Generated and appended tag:', fixedTag);
            return contentText.trimEnd() + '\n' + fixedTag;
        }

        console.warn('[DailyNote] TagMaster enabled but failed to generate tags. Falling back to missing-tag error.');
    }

    // No tag found in either place, throw an error.
    debugLog('No tag detected in content or as an argument. Throwing error.');
    throw new Error("Tag is missing. Please provide a 'Tag' argument or add a 'Tag:' line at the end of the 'Content'.");
}

// --- Local File URL Processing ---
/**
 * 将内容中的 file:// 本地路径转换为 ImageServer 内网 URL。
 * 同时处理 Markdown 图片 ![alt](file://...) 和普通链接 [text](file://...)。
 * 需要 PROJECT_BASE_PATH、SERVER_PORT、IMAGESERVER_IMAGE_KEY/FILE_KEY、VarHttpUrl 环境变量。
 * 如果缺少这些变量，则原样返回内容。
 * @param {string} content - 日记内容
 * @returns {Promise<string>} 替换后的内容
 */
/**
 * 清理文件名，使其适合用于 URL（去除特殊字符，保留语义）。
 * @param {string} name - 原始文件名（不含扩展名）
 * @returns {string} 清理后的文件名
 */
function sanitizeServerFilename(name) {
    return name
        .replace(/[\\/:*?"<>|]/g, '_') // Windows 非法字符
        .replace(/\s+/g, '_')           // 空格转下划线
        .replace(/_+/g, '_')            // 合并连续下划线
        .replace(/^_+|_+$/g, '')        // 去除首尾下划线
        .substring(0, 80)               // 限制长度，避免路径过长
        || 'file';
}

async function processLocalFiles(content) {
    if (!projectBasePath || !SERVER_PORT || !VAR_HTTP_URL) {
        debugLog('processLocalFiles: 缺少必要的环境变量（PROJECT_BASE_PATH/SERVER_PORT/VarHttpUrl），跳过转换。');
        return content;
    }

    let result = content;

    // 1. 处理 Markdown 图片: ![alt](file://...)
    if (IMAGESERVER_IMAGE_KEY) {
        const imageRegex = /!\[([^\]]*)\]\((file:\/\/[^)]+)\)/g;
        const imageMatches = [...result.matchAll(imageRegex)];

        for (const match of imageMatches) {
            const fullMatch = match[0];
            const altText = match[1];
            const fileUrl = match[2];

            try {
                // 将 file:// URL 转为本地路径（兼容 Windows）
                let filePath = fileUrl.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
                filePath = filePath.replace(/\//g, path.sep);

                const buffer = await fs.readFile(filePath);
                const ext = path.extname(filePath).toLowerCase() || '.png';
                const baseName = sanitizeServerFilename(path.basename(filePath, path.extname(filePath)));
                const generatedFileName = `${crypto.randomBytes(4).toString('hex')}_${baseName}${ext}`;
                const destDir = path.join(projectBasePath, 'image', 'dailynote');
                await fs.mkdir(destDir, { recursive: true });
                await fs.writeFile(path.join(destDir, generatedFileName), buffer);

                const serverUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/dailynote/${generatedFileName}`;
                result = result.replace(fullMatch, `![${altText}](${serverUrl})`);
                debugLog(`processLocalFiles: 图片已转换 ${fileUrl} -> ${serverUrl}`);
            } catch (e) {
                if (e.code === 'ENOENT') {
                    debugLog(`processLocalFiles: 图片文件不存在，跳过: ${fileUrl}`);
                } else {
                    console.error(`[DailyNote] processLocalFiles: 读取图片文件失败 ${fileUrl}: ${e.message}`);
                }
            }
        }
    } else {
        debugLog('processLocalFiles: 未配置 IMAGESERVER_IMAGE_KEY，跳过图片转换。');
    }

    // 2. 处理普通文件链接: [text](file://...)
    //    注意：使用负向前瞻 (?<!!) 排除已处理的图片语法
    if (IMAGESERVER_FILE_KEY) {
        const fileRegex = /(?<!!)\[([^\]]*)\]\((file:\/\/[^)]+)\)/g;
        const fileMatches = [...result.matchAll(fileRegex)];

        for (const match of fileMatches) {
            const fullMatch = match[0];
            const linkText = match[1];
            const fileUrl = match[2];

            try {
                let filePath = fileUrl.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
                filePath = filePath.replace(/\//g, path.sep);

                const buffer = await fs.readFile(filePath);
                const ext = path.extname(filePath).toLowerCase() || '.bin';
                const baseName = sanitizeServerFilename(path.basename(filePath, path.extname(filePath)));
                const generatedFileName = `${crypto.randomBytes(4).toString('hex')}_${baseName}${ext}`;
                const destDir = path.join(projectBasePath, 'file', 'dailynote');
                await fs.mkdir(destDir, { recursive: true });
                await fs.writeFile(path.join(destDir, generatedFileName), buffer);

                const serverUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_FILE_KEY}/files/dailynote/${generatedFileName}`;
                result = result.replace(fullMatch, `[${linkText}](${serverUrl})`);
                debugLog(`processLocalFiles: 文件已转换 ${fileUrl} -> ${serverUrl}`);
            } catch (e) {
                if (e.code === 'ENOENT') {
                    debugLog(`processLocalFiles: 文件不存在，跳过: ${fileUrl}`);
                } else {
                    console.error(`[DailyNote] processLocalFiles: 读取文件失败 ${fileUrl}: ${e.message}`);
                }
            }
        }
    } else {
        debugLog('processLocalFiles: 未配置 IMAGESERVER_FILE_KEY，跳过普通文件转换。');
    }

    return result;
}

// --- 'create' Command Logic ---
function contentStartsWithAiTimePrefix(content) {
    return /^\s*\[\d{1,2}:\d{2}(?::\d{2})?\](?=\s|$)/.test(content);
}

async function handleCreateCommand(args) {
    // 兼容 'Date'/'dateString', 'Content'/'contentText'/'content', 'maid'/'maidName' (case-insensitive for maid)
    // 新增 folder 字段：用于直接指定存储目录，避免必须把目录塞进 maid 的 [文件夹]署名格式。
    // 额外兼容 fold，降低模型误拼写导致目录未生效的概率。
    const maid = args.maid || args.maidName || args.Maid || args.MAID;
    const folder = args.folder || args.Folder || args.folderName || args.FolderName || args.fold || args.Fold;
    let dateString = args.dateString || args.Date;
    const contentText = args.contentText || args.Content || args.content;
    // 如果没有传入 Date，则使用系统当前日期
    if (!dateString) {
        const d = new Date();
        dateString = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
    }
    const tag = args.Tag || args.tag;
    const fileName = args.fileName || args.FileName;

    debugLog(`Processing 'create' for Maid: ${maid}, Folder: ${folder || 'Not specified'}, Date: ${dateString}, fileName: ${fileName}`);
    if (!maid || !contentText) {
        return { status: "error", error: 'Invalid input for create: Missing maid/maidName or contentText/Content/content.' };
    }

    try {
        // 先将 file:// 本地路径转换为 ImageServer 内网 URL
        const fileConvertedContent = await processLocalFiles(contentText);
        const processedContent = await processTags(fileConvertedContent, tag);
        debugLog('Content after tag processing (length):', processedContent.length);

        const trimmedMaidName = maid.trim();
        const trimmedFolderName = typeof folder === 'string' ? folder.trim() : '';
        let folderName = trimmedFolderName || trimmedMaidName;
        let actualMaidName = trimmedMaidName;
        const tagMatch = trimmedMaidName.match(/^\[(.*?)\](.*)$/);

        if (trimmedFolderName) {
            debugLog(`Explicit folder provided. Folder: ${folderName}, Actual Maid: ${actualMaidName}`);
        } else if (tagMatch) {
            folderName = tagMatch[1].trim();
            actualMaidName = tagMatch[2].trim();
            debugLog(`Tagged note detected. Tag: ${folderName}, Actual Maid: ${actualMaidName}`);
        } else {
            debugLog(`No tag detected. Folder: ${folderName}, Actual Maid: ${actualMaidName}`);
        }

        const folderResolution = await resolveDiaryFolderName(folderName, {
            allowFuzzyExisting: true,
            fallbackName: actualMaidName || 'Untitled',
            logContext: 'create folder',
            ownerName: actualMaidName
        });
        const sanitizedFolderName = folderResolution.folderName;
        if (folderName !== sanitizedFolderName) {
            debugLog(`Resolved folder name from "${folderName}" to "${sanitizedFolderName}"`);
        }

        // 检查是否尝试写入被忽略的文件夹
        if (IGNORED_FOLDERS.includes(sanitizedFolderName)) {
            return { status: "error", error: `Cannot create diary in ignored folder: ${sanitizedFolderName}` };
        }

        const datePart = dateString.replace(/[.\\\/\s-]/g, '-').replace(/-+/g, '-');
        const now = new Date();
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const seconds = now.getSeconds().toString().padStart(2, '0');
        const timeStringForFile = `${hours}_${minutes}_${seconds}`;

        const dirPath = path.join(dailyNoteRootPath, sanitizedFolderName);

        // 🆕 安全检查：确保路径在 dailyNoteRootPath 内
        if (!isPathWithinBase(dirPath, dailyNoteRootPath)) {
            console.error(`[DailyNote] Path traversal attempt detected: ${dirPath}`);
            return {
                status: "error",
                error: "Security error: Invalid folder path detected."
            };
        }

        // 可选字段：将 fileName 作为后缀拼接到时间戳文件名后
        let sanitizedOptionalFileName = '';
        if (typeof fileName === 'string' && fileName.trim()) {
            sanitizedOptionalFileName = sanitizePathComponent(fileName.trim());
        }

        const fileNameSuffix = sanitizedOptionalFileName ? `-${sanitizedOptionalFileName}` : '';
        const baseFileNameWithoutExt = `${datePart}-${timeStringForFile}${fileNameSuffix}`;
        const fileExtension = `.${CONFIGURED_EXTENSION}`;

        let finalFileName = `${baseFileNameWithoutExt}${fileExtension}`;
        let filePath = path.join(dirPath, finalFileName);
        let counter = 1;

        await fs.mkdir(dirPath, { recursive: true });

        const timeStringForContent = `${hours}:${minutes}`;
        const fileContent = contentStartsWithAiTimePrefix(processedContent)
            ? `[${datePart}] - ${actualMaidName}\n${processedContent}`
            : `[${datePart}] - ${actualMaidName}\n[${timeStringForContent}]\n${processedContent}`;

        // 使用 wx 原子排他创建，避免多个调用方在 access 与 writeFile 之间同时抢到同一路径。
        const maxFileNameAttempts = 1000;
        while (counter <= maxFileNameAttempts) {
            try {
                debugLog(`Attempting atomic create: ${filePath}`);
                await fs.writeFile(filePath, fileContent, { encoding: 'utf-8', flag: 'wx' });
                break;
            } catch (err) {
                if (err.code !== 'EEXIST') {
                    throw err;
                }
                counter++;
                finalFileName = `${baseFileNameWithoutExt}(${counter})${fileExtension}`;
                filePath = path.join(dirPath, finalFileName);
            }
        }

        if (counter > maxFileNameAttempts) {
            throw new Error(`Unable to allocate a unique diary filename after ${maxFileNameAttempts} attempts.`);
        }

        debugLog(`Successfully wrote file (length: ${fileContent.length})`);
        return {
            status: "success",
            result: {
                message: `${actualMaidName} 的日记已保存到 ${sanitizedFolderName} 文件夹 (${finalFileName})，知识库索引将在后台更新`,
                folder: sanitizedFolderName,
                fileName: finalFileName,
                indexStatus: "queued"
            }
        };
    } catch (error) {
        console.error("[DailyNote] Error during 'create' command:", error.message);
        return { status: "error", error: error.message || "An unknown error occurred during diary creation." };
    }
}


// --- Fuzzy Diff Utilities (for 'update' command failure diagnostics) ---

function normalizeLooseMatchChar(char) {
    switch (char) {
        case '\u201c': // “
        case '\u201d': // ”
        case '\u201e': // „
        case '\u201f': // ‟
        case '\uff02': // ＂
            return '"';
        case '\u2018': // ‘
        case '\u2019': // ’
        case '\u201a': // ‚
        case '\u201b': // ‛
        case '\uff07': // ＇
            return "'";
        case '\uff08': // （
            return '(';
        case '\uff09': // ）
            return ')';
        case '\uff0c': // ，
            return ',';
        case '\u3001': // 、
            return ',';
        case '\uff1a': // ：
            return ':';
        case '\uff1b': // ；
            return ';';
        case '\uff01': // ！
            return '!';
        case '\uff1f': // ？
            return '?';
        case '\u3002': // 。
            return '.';
        case '\uff0e': // ．
            return '.';
        case '\u2026': // …
            return '...';
        case '\u2014': // —
        case '\u2013': // –
            return '-';
        default:
            return char.toLowerCase();
    }
}

function shouldRemoveForLooseMatch(char) {
    return /\s/.test(char) || char === '\\';
}

function dehydrate(text) {
    let normalized = '';
    for (const char of text) {
        if (shouldRemoveForLooseMatch(char)) {
            continue;
        }
        normalized += normalizeLooseMatchChar(char);
    }
    return normalized;
}

function mapDehydratedIndexToOriginal(content, dehydratedIndex) {
    let originalIndex = 0;
    let count = 0;
    while (originalIndex < content.length) {
        const char = content[originalIndex];
        if (shouldRemoveForLooseMatch(char)) {
            originalIndex++;
            continue;
        }
        if (count === dehydratedIndex) {
            return originalIndex;
        }
        count += normalizeLooseMatchChar(char).length;
        originalIndex++;
    }
    return originalIndex;
}

function extractSmartProbes(target, maxProbes = 8) {
    const probes = [];
    probes.push(target.substring(0, 12));
    probes.push(target.substring(target.length - 12));
    const structuralMatches = target.match(/[^\u4e00-\u9fa5\n]{3,}/g) || [];
    for (const match of structuralMatches.slice(0, 4)) {
        const idx = target.indexOf(match);
        probes.push(target.substring(idx, idx + 12));
    }
    const step = Math.max(1, Math.floor(target.length / maxProbes));
    for (let i = step; i < target.length - 12; i += step) {
        probes.push(target.substring(i, i + 12));
    }
    return [...new Set(probes)].filter((p) => p.length >= 8).slice(0, maxProbes);
}

function emergencyFallback(content, target) {
    const head = target.substring(0, 15);
    const tail = target.substring(target.length - 15);
    const headIdx = content.indexOf(head);
    const tailIdx = content.indexOf(tail);
    if (headIdx !== -1 || tailIdx !== -1) {
        const anchor = headIdx !== -1 ? headIdx : tailIdx;
        const start = Math.max(0, anchor - 50);
        const end = Math.min(
            content.length,
            anchor + Math.min(target.length, 300) + 50
        );
        return { mode: 'anchor_fallback', segment: content.substring(start, end) };
    }
    const keywords =
        target.match(/[a-zA-Z0-9#\[\]]{2,}|[\u4e00-\u9fa5]{2,}/g) || [];
    const keywordHits = keywords.filter((kw) => content.includes(kw));
    if (keywordHits.length > 0) {
        const firstHitIdx = content.indexOf(keywordHits[0]);
        const start = Math.max(0, firstHitIdx - 100);
        const end = Math.min(content.length, firstHitIdx + 400);
        return {
            mode: 'keyword_fallback',
            matchedKeywords: keywordHits,
            segment: content.substring(start, end),
        };
    }
    return null;
}

/**
* 在日记内容中搜索探针命中位置。
* @param {string} content - 日记文件全文
* @param {string[]} probes - 探针数组
* @returns {{ positions: number[], hitCount: number }} 命中位置数组和命中数
*/
function probeMatch(content, probes) {
    const positions = [];
    let hitCount = 0;
    for (const probe of probes) {
        const idx = content.indexOf(probe);
        if (idx !== -1) {
            positions.push(idx);
            hitCount++;
        }
    }
    return { positions, hitCount };
}

/**
* 根据探针命中位置，从日记内容中智能截取与 target 等长的最佳匹配片段。
* 核心思路：找到命中位置的密集聚类中心，以此为锚点截取。
* @param {string} content - 日记文件全文
* @param {number[]} positions - 探针命中位置数组
* @param {number} targetLength - AI target 的长度
* @returns {{ segment: string, startIdx: number } | null} 截取的片段及起始位置
*/
function extractBestSegment(content, positions, targetLength) {
    if (positions.length === 0) return null;

    // 对命中位置排序
    const sorted = [...positions].sort((a, b) => a - b);

    // 找密集聚类中心：用滑动窗口找包含最多命中点的区域
    let bestStart = sorted[0];
    let bestCount = 0;
    const windowSize = targetLength;

    for (let i = 0; i < sorted.length; i++) {
        let count = 0;
        for (let j = i; j < sorted.length; j++) {
            if (sorted[j] - sorted[i] <= windowSize) {
                count++;
            } else {
                break;
            }
        }
        if (count > bestCount) {
            bestCount = count;
            bestStart = sorted[i];
        }
    }

    // 以聚类起点为锚，向前扩展一点余量，截取 targetLength 长度的片段
    const margin = Math.floor(targetLength * 0.1); // 10% 余量
    let segStart = Math.max(0, bestStart - margin);
    let segEnd = Math.min(content.length, segStart + targetLength + margin * 2);
    // 如果截取长度超出 target 的 1.5 倍，收缩到合理范围
    if (segEnd - segStart > targetLength * 1.5) {
        segEnd = segStart + Math.ceil(targetLength * 1.5);
    }
    segEnd = Math.min(segEnd, content.length);

    return {
        segment: content.substring(segStart, segEnd),
        startIdx: segStart,
    };
}

/**
* 计算两个数组的最长公共子序列（LCS）索引。
* @returns {{ lcsA: number[], lcsB: number[] }}
*/
function computeLCSIndices(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    const lcsA = [];
    const lcsB = [];
    let i = m,
        j = n;
    while (i > 0 && j > 0) {
        if (a[i - 1] === b[j - 1]) {
            lcsA.unshift(i - 1);
            lcsB.unshift(j - 1);
            i--;
            j--;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }

    return { lcsA, lcsB };
}

/**
* 对比 oldText（日记内容）和 newText（AI target），生成 unified diff（git diff -u 风格）。
* @param {string} oldText - 旧文本（日记中匹配到的最佳片段）
* @param {string} newText - 新文本（AI 提供的目标文本）
* @param {string} oldLabel - 旧文件标签（用于 diff 头部）
* @param {string} newLabel - 新文件标签（用于 diff 头部）
* @returns {string} unified diff 格式差异描述
*/
function generateDiff(oldText, newText, oldLabel, newLabel) {
    const a = oldText.split('\n');
    const b = newText.split('\n');

    const { lcsA, lcsB } = computeLCSIndices(a, b);

    // Build diff operations
    const ops = [];
    let i = 0,
        j = 0,
        k = 0;
    while (i < a.length || j < b.length) {
        if (k < lcsA.length && i === lcsA[k] && j === lcsB[k]) {
            ops.push({ type: ' ', line: a[i] });
            i++;
            j++;
            k++;
        } else if (k < lcsA.length && i < lcsA[k]) {
            ops.push({ type: '-', line: a[i] });
            i++;
        } else if (k < lcsB.length && j < lcsB[k]) {
            ops.push({ type: '+', line: b[j] });
            j++;
        } else {
            while (i < a.length) {
                ops.push({ type: '-', line: a[i] });
                i++;
            }
            while (j < b.length) {
                ops.push({ type: '+', line: b[j] });
                j++;
            }
        }
    }

    // Split into hunks with 3-line context
    const hunks = [];
    const context = 3;
    let idx = 0;

    while (idx < ops.length) {
        // Skip unchanged lines
        while (idx < ops.length && ops[idx].type === ' ') idx++;
        if (idx >= ops.length) break;

        const hunkStart = Math.max(0, idx - context);
        let hunkEnd = idx + context + 1;

        // Extend hunk to include nearby changes
        while (true) {
            let nextChange = hunkEnd;
            while (nextChange < ops.length && ops[nextChange].type === ' ')
                nextChange++;
            if (nextChange >= ops.length) break;
            if (nextChange - hunkEnd <= context * 2) {
                hunkEnd = nextChange + context + 1;
            } else {
                break;
            }
        }

        hunkEnd = Math.min(ops.length, hunkEnd);

        // Compute line numbers
        let aLine = 1,
            bLine = 1;
        for (let p = 0; p < hunkStart; p++) {
            if (ops[p].type === ' ' || ops[p].type === '-') aLine++;
            if (ops[p].type === ' ' || ops[p].type === '+') bLine++;
        }

        const hunkOps = ops.slice(hunkStart, hunkEnd);
        const aCount = hunkOps.filter(
            (o) => o.type === ' ' || o.type === '-'
        ).length;
        const bCount = hunkOps.filter(
            (o) => o.type === ' ' || o.type === '+'
        ).length;

        const aRange =
            aCount === 0
                ? `${aLine},0`
                : `${aLine}${aCount !== 1 ? ',' + aCount : ''}`;
        const bRange =
            bCount === 0
                ? `${bLine},0`
                : `${bLine}${bCount !== 1 ? ',' + bCount : ''}`;

        hunks.push(
            `@@ -${aRange} +${bRange} @@\n` +
                hunkOps.map((o) => o.type + o.line).join('\n')
        );

        idx = hunkEnd;
    }

    return `--- ${oldLabel}\n+++ ${newLabel}\n` + hunks.join('\n');
}

// --- 'update' Command Logic ---
async function atomicReplaceIfUnchanged(filePath, content, expectedStats) {
    const currentStats = await fs.stat(filePath);
    if (
        !expectedStats ||
        currentStats.size !== expectedStats.size ||
        currentStats.mtimeMs !== expectedStats.mtimeMs
    ) {
        const conflict = new Error(
            `Diary file changed concurrently before update commit: ${filePath}. ` +
            'Please read the latest content and retry.'
        );
        conflict.code = 'DAILY_NOTE_WRITE_CONFLICT';
        throw conflict;
    }

    const tempPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
    );

    try {
        await fs.writeFile(tempPath, content, { encoding: 'utf-8', flag: 'wx' });

        // 临时文件写完后再做一次版本校验，缩小外部写入者抢占提交窗口的概率。
        const beforeCommitStats = await fs.stat(filePath);
        if (
            beforeCommitStats.size !== expectedStats.size ||
            beforeCommitStats.mtimeMs !== expectedStats.mtimeMs
        ) {
            const conflict = new Error(
                `Diary file changed concurrently during update commit: ${filePath}. ` +
                'Please read the latest content and retry.'
            );
            conflict.code = 'DAILY_NOTE_WRITE_CONFLICT';
            throw conflict;
        }

        await fs.rename(tempPath, filePath);
    } catch (error) {
        try {
            await fs.unlink(tempPath);
        } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') {
                console.warn(`[DailyNote] Failed to remove update temp file "${tempPath}": ${cleanupError.message}`);
            }
        }
        throw error;
    }
}

async function handleUpdateCommand(args) {
    debugLog("Processing 'update' command with args:", args);

    const { target, replace, maid } = args;
    const folder = args.folder || args.Folder || args.folderName || args.FolderName || args.fold || args.Fold;

    if (typeof target !== 'string' || typeof replace !== 'string') {
        return {
            status: 'error',
            error:
                "Invalid arguments for update: 'target' and 'replace' must be strings.",
        };
    }

    if (target.length < 15) {
        return {
            status: 'error',
            error: `Security check failed: 'target' must be at least 15 characters long. Provided length: ${target.length}`,
        };
    }

    debugLog(
        `Validated input for update. Target length: ${target.length}. Maid: ${
            maid || 'Not specified'
        }. Folder: ${folder || 'Not specified'}`
    );

    try {
        let modificationDone = false;
        let modifiedFilePath = null;

        // Fuzzy diff: 在遍历过程中收集最佳候选（零额外IO）
        const probes = FUZZY_DIFF_ENABLED ? extractSmartProbes(target, 5) : [];
        let bestCandidate = null; // { filePath, segment, hitCount }
        const scannedFiles = []; // For emergency fallback

        // 构建搜索顺序：优先文件夹 + 其他所有文件夹
        const priorityDirs = []; // 优先搜索的文件夹
        const otherDirs = []; // 其他文件夹

        // 获取所有子文件夹，过滤掉被忽略的文件夹
        const allDirEntries = await fs.readdir(dailyNoteRootPath, {
            withFileTypes: true,
        });
        const allDirs = allDirEntries.filter(
            (d) => d.isDirectory() && !IGNORED_FOLDERS.includes(d.name)
        );
        debugLog(
            `Filtered out ignored folders: ${IGNORED_FOLDERS.join(
                ', '
            )}. Remaining directories: ${allDirs.map((d) => d.name).join(', ')}`
        );

        if (folder && typeof folder === 'string' && folder.trim()) {
            // 显式 folder 优先级最高：格式如 folder: 小克的知识, maid: 小克
            const requestedFolderAlias = normalizeDiaryFolderAlias(folder.trim());
            const maidOwnerAlias = normalizeDiaryFolderAlias(maid);
            debugLog(
                `Explicit folder specified for update. Requested: '${folder.trim()}', alias: '${requestedFolderAlias}', maid owner alias: '${maidOwnerAlias}'`
            );

            let bestFolderMatch = null;
            for (const dirEntry of allDirs) {
                const dirPath = path.join(dailyNoteRootPath, dirEntry.name);

                // 安全检查：确保路径在 dailyNoteRootPath 内
                if (!isPathWithinBase(dirPath, dailyNoteRootPath)) {
                    debugLog(`Skipping unsafe directory during update: ${dirPath}`);
                    continue;
                }

                const existingAlias = normalizeDiaryFolderAlias(dirEntry.name);
                if (!isFolderMatchAllowedByOwner(requestedFolderAlias, existingAlias, maidOwnerAlias)) {
                    debugLog(`Owner guard skipped update folder "${dirEntry.name}" for requested "${folder}" and maid "${maid || ''}"`);
                    otherDirs.push({ name: dirEntry.name, path: dirPath });
                    continue;
                }

                const score = calculateFolderMatchScore(requestedFolderAlias, existingAlias);
                if (
                    score > 0 &&
                    (!bestFolderMatch ||
                        score > bestFolderMatch.score ||
                        (score === bestFolderMatch.score && dirEntry.name.length < bestFolderMatch.name.length))
                ) {
                    bestFolderMatch = {
                        name: dirEntry.name,
                        path: dirPath,
                        score,
                        alias: existingAlias
                    };
                }

                otherDirs.push({ name: dirEntry.name, path: dirPath });
            }

            if (bestFolderMatch) {
                priorityDirs.push({ name: bestFolderMatch.name, path: bestFolderMatch.path });
                const duplicateIndex = otherDirs.findIndex((dir) => dir.name === bestFolderMatch.name);
                if (duplicateIndex !== -1) {
                    otherDirs.splice(duplicateIndex, 1);
                }
                debugLog(
                    `Explicit folder '${folder}' resolved to existing folder '${bestFolderMatch.name}' (alias: '${bestFolderMatch.alias}', score: ${bestFolderMatch.score}).`
                );
            } else {
                debugLog(
                    `Explicit folder '${folder}' did not match existing folders, will search all folders.`
                );
            }
        } else if (maid) {
            const maidRegex = /^\[(.+?)\]/;
            const match = maid.match(maidRegex);

            if (match) {
                // 格式: [小克的知识]小克 -> 优先在 '小克的知识' 文件夹找
                const requestedFolderAlias = normalizeDiaryFolderAlias(match[1]);
                const maidOwnerName = maid.replace(/^\[(.+?)\]/, '').trim();
                const maidOwnerAlias = normalizeDiaryFolderAlias(maidOwnerName);
                debugLog(
                    `Maid specifies priority folder. Requested: '${match[1]}', alias: '${requestedFolderAlias}', maid owner alias: '${maidOwnerAlias}'`
                );

                let bestFolderMatch = null;
                for (const dirEntry of allDirs) {
                    const dirPath = path.join(dailyNoteRootPath, dirEntry.name);

                    // 安全检查：确保路径在 dailyNoteRootPath 内
                    if (!isPathWithinBase(dirPath, dailyNoteRootPath)) {
                        debugLog(`Skipping unsafe directory during update: ${dirPath}`);
                        continue;
                    }

                    const existingAlias = normalizeDiaryFolderAlias(dirEntry.name);
                    if (!isFolderMatchAllowedByOwner(requestedFolderAlias, existingAlias, maidOwnerAlias)) {
                        debugLog(`Owner guard skipped maid priority folder "${dirEntry.name}" for requested "${match[1]}" and maid "${maidOwnerName}"`);
                        otherDirs.push({ name: dirEntry.name, path: dirPath });
                        continue;
                    }

                    const score = calculateFolderMatchScore(requestedFolderAlias, existingAlias);
                    if (
                        score > 0 &&
                        (!bestFolderMatch ||
                            score > bestFolderMatch.score ||
                            (score === bestFolderMatch.score && dirEntry.name.length < bestFolderMatch.name.length))
                    ) {
                        bestFolderMatch = {
                            name: dirEntry.name,
                            path: dirPath,
                            score,
                            alias: existingAlias
                        };
                    }

                    otherDirs.push({ name: dirEntry.name, path: dirPath });
                }

                if (bestFolderMatch) {
                    priorityDirs.push({ name: bestFolderMatch.name, path: bestFolderMatch.path });
                    const duplicateIndex = otherDirs.findIndex((dir) => dir.name === bestFolderMatch.name);
                    if (duplicateIndex !== -1) {
                        otherDirs.splice(duplicateIndex, 1);
                    }
                    debugLog(
                        `Maid priority folder '${match[1]}' resolved to existing folder '${bestFolderMatch.name}' (alias: '${bestFolderMatch.alias}', score: ${bestFolderMatch.score}).`
                    );
                } else {
                    debugLog(
                        `Maid priority folder '${match[1]}' did not match existing folders, will search all folders.`
                    );
                }
            } else {
                // 格式: 小克 -> 优先在以 '小克' 开头的文件夹找
                const maidAlias = normalizeDiaryFolderAlias(maid);
                debugLog(
                    `Maid specified: '${maid}' (alias: '${maidAlias}'). Prioritizing directories starting with this alias.`
                );

                for (const dirEntry of allDirs) {
                    const dirPath = path.join(dailyNoteRootPath, dirEntry.name);

                    // 安全检查：确保路径在 dailyNoteRootPath 内
                    if (!isPathWithinBase(dirPath, dailyNoteRootPath)) {
                        debugLog(`Skipping unsafe directory during update: ${dirPath}`);
                        continue;
                    }

                    if (normalizeDiaryFolderAlias(dirEntry.name).startsWith(maidAlias)) {
                        priorityDirs.push({ name: dirEntry.name, path: dirPath });
                    } else {
                        otherDirs.push({ name: dirEntry.name, path: dirPath });
                    }
                }
            }
        } else {
            // 没有指定 maid，搜索所有文件夹
            debugLog('No maid specified. Scanning all directories.');
            for (const dirEntry of allDirs) {
                const dirPath = path.join(dailyNoteRootPath, dirEntry.name);

                // 安全检查：确保路径在 dailyNoteRootPath 内
                if (!isPathWithinBase(dirPath, dailyNoteRootPath)) {
                    debugLog(`Skipping unsafe directory during update: ${dirPath}`);
                    continue;
                }

                otherDirs.push({ name: dirEntry.name, path: dirPath });
            }
        }

        // 合并搜索顺序：优先文件夹在前
        const directoriesToScan = [...priorityDirs, ...otherDirs];
        debugLog(
            `Search order: ${directoriesToScan.map((d) => d.name).join(' -> ')}`
        );

        if (directoriesToScan.length === 0) {
            return {
                status: 'error',
                error: `No diary folders found in ${dailyNoteRootPath}`,
            };
        }

        for (const dir of directoriesToScan) {
            if (modificationDone) break;
            debugLog(`Scanning directory: ${dir.path}`);
            try {
                const files = await fs.readdir(dir.path);
                const txtFiles = files
                    .filter(
                        (file) =>
                            file.toLowerCase().endsWith('.txt') ||
                            file.toLowerCase().endsWith('.md')
                    )
                    .sort();
                debugLog(`Found ${txtFiles.length} diary files for ${dir.name}`);

                for (const file of txtFiles) {
                    if (modificationDone) break;
                    const filePath = path.join(dir.path, file);
                    debugLog(`Reading file: ${filePath}`);
                    let content;
                    let readVersion;
                    try {
                        const statsBeforeRead = await fs.stat(filePath);
                        content = await fs.readFile(filePath, 'utf-8');
                        const statsAfterRead = await fs.stat(filePath);
                        if (
                            statsBeforeRead.size !== statsAfterRead.size ||
                            statsBeforeRead.mtimeMs !== statsAfterRead.mtimeMs
                        ) {
                            debugLog(`Skipping concurrently changing diary file: ${filePath}`);
                            continue;
                        }
                        readVersion = statsAfterRead;
                    } catch (readErr) {
                        console.error(
                            `[DailyNote] Error reading diary file ${filePath}:`,
                            readErr.message
                        );
                        continue;
                    }

                    let index = content.indexOf(target);

                    // Layer 1: Dehydration Match
                    if (index === -1) {
                        const dehydratedContent = dehydrate(content);
                        const dehydratedTarget = dehydrate(target);
                        const dIndex = dehydratedContent.indexOf(dehydratedTarget);
                        if (dIndex !== -1) {
                            index = mapDehydratedIndexToOriginal(content, dIndex);
                            debugLog(`Dehydrated match found in file: ${filePath}`);
                        }
                    }

                    if (index !== -1) {
                        debugLog(`Found target in file: ${filePath}`);
                        const newContent =
                            content.substring(0, index) +
                            replace +
                            content.substring(index + target.length);
                        try {
                            await atomicReplaceIfUnchanged(filePath, newContent, readVersion);
                            modificationDone = true;
                            modifiedFilePath = filePath;
                            debugLog(`Successfully modified file: ${filePath}`);
                            break;
                        } catch (writeErr) {
                            console.error(
                                `[DailyNote] Error writing to diary file ${filePath}:`,
                                writeErr.message
                            );
                            if (writeErr.code === 'DAILY_NOTE_WRITE_CONFLICT') {
                                return {
                                    status: 'error',
                                    error: writeErr.message,
                                    code: writeErr.code
                                };
                            }
                            break;
                        }
                    } else if (FUZZY_DIFF_ENABLED && probes.length > 0) {
                        // 精确匹配失败，顺手做探针匹配收集候选
                        const { positions, hitCount } = probeMatch(content, probes);
                        if (
                            hitCount > 0 &&
                            (!bestCandidate || hitCount > bestCandidate.hitCount)
                        ) {
                            const segResult = extractBestSegment(
                                content,
                                positions,
                                target.length
                            );
                            if (segResult) {
                                bestCandidate = {
                                    filePath,
                                    segment: segResult.segment,
                                    hitCount,
                                };
                                debugLog(
                                    `Fuzzy candidate found in ${filePath}, hitCount: ${hitCount}`
                                );
                            }
                        }
                    }

                    if (FUZZY_DIFF_ENABLED) {
                        scannedFiles.push({ filePath, content });
                    }
                }
            } catch (charDirError) {
                console.error(
                    `[DailyNote] Error reading character directory ${dir.path}:`,
                    charDirError.message
                );
                continue;
            }
        }

        if (modificationDone) {
            const finalFileName = path.basename(modifiedFilePath);
            const folderName = path.basename(path.dirname(modifiedFilePath));
            return {
                status: 'success',
                result: {
                    result: `Successfully edited diary file: ${modifiedFilePath}`,
                    message: `${maid || 'AI'} 已成功更新 ${folderName} 文件夹中的日记文件 (${finalFileName})，知识库索引将在后台更新`,
                    targetFile: modifiedFilePath,
                    folder: folderName,
                    fileName: finalFileName,
                    indexStatus: 'queued'
                }
            };
        } else {
            const scopeDescription = folder
                ? `folder '${folder}'`
                : maid
                    ? `maid '${maid}'`
                    : '';
            const baseErrorMessage = scopeDescription
                ? `Target content not found in any diary files for ${scopeDescription}.`
                : 'Target content not found in any diary files.';
            const errorMessage = `${baseErrorMessage} ${UPDATE_FAILURE_HINT}`;

            // Layer 3: Emergency Fallback
            if (FUZZY_DIFF_ENABLED && !bestCandidate) {
                for (const { filePath, content } of scannedFiles) {
                    const fallbackResult = emergencyFallback(content, target);
                    if (fallbackResult) {
                        bestCandidate = {
                            filePath,
                            segment: fallbackResult.segment,
                            hitCount: 0,
                            fallbackMode: fallbackResult.mode,
                            matchedKeywords: fallbackResult.matchedKeywords,
                        };
                        debugLog(
                            `Emergency fallback found in ${filePath}, mode: ${fallbackResult.mode}`
                        );
                        break;
                    }
                }
            }

            // Fuzzy diff: 如果有候选，返回 schema-friendly 诊断信息
            if (FUZZY_DIFF_ENABLED && bestCandidate) {
                const diff = generateDiff(
                    bestCandidate.segment,
                    target,
                    bestCandidate.filePath,
                    'target'
                );
                debugLog(
                    `Fuzzy diff generated for candidate in: ${bestCandidate.filePath}`
                );
                return {
                    status: 'error',
                    error: errorMessage,
                    result: {
                        fuzzyDiff: {
                            candidateFile: bestCandidate.filePath,
                            diff: diff,
                        },
                    },
                };
            }

            return { status: 'error', error: errorMessage };
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {
                status: 'error',
                error: `Daily note root directory not found at ${dailyNoteRootPath}`,
            };
        } else {
            console.error(
                `[DailyNote] Unexpected error during 'update' command:`,
                error
            );
            return {
                status: 'error',
                error: `An unexpected error occurred: ${error.message}`,
            };
        }
    }
}

// --- Shared Command Dispatcher ---
async function dispatchCommand(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return { status: 'error', error: 'DailyNote request must be a JSON object.' };
    }

    const { command, ...parameters } = args;

    // 鲁棒性兼容：AI 有时会遗漏 command，或把 command 拼错。
    const rawCommand = typeof command === 'string' ? command.trim().toLowerCase() : command;
    const hasCreateContent =
        typeof parameters.contentText === 'string' ||
        typeof parameters.Content === 'string' ||
        typeof parameters.content === 'string';
    const hasUpdateTargetReplace =
        typeof parameters.target === 'string' &&
        typeof parameters.replace === 'string';

    let normalizedCommand = rawCommand;
    if (rawCommand !== 'create' && rawCommand !== 'update') {
        if (hasUpdateTargetReplace) {
            normalizedCommand = 'update';
            debugLog(`Command '${command || ''}' is missing or invalid; inferred 'update' from target/replace arguments.`);
        } else if (hasCreateContent) {
            normalizedCommand = 'create';
            debugLog(`Command '${command || ''}' is missing or invalid; inferred 'create' from content arguments.`);
        }
    }

    switch (normalizedCommand) {
        case 'create':
            return handleCreateCommand(parameters);
        case 'update':
            return handleUpdateCommand(parameters);
        default:
            return { status: 'error', error: `Unknown command: '${normalizedCommand}'. Use 'create' or 'update'.` };
    }
}

function enqueueResidentRequest(args, context = {}) {
    if (!residentAcceptingRequests) {
        return Promise.resolve({
            status: 'error',
            error: 'DailyNote service is shutting down and no longer accepts new requests.'
        });
    }

    residentPendingCount++;
    const owner = `DailyNote:${args?.command || 'inferred'}:${Date.now()}:${residentPendingCount}`;

    const execute = async () => {
        if (context.signal?.aborted) {
            return { status: 'error', error: 'DailyNote request was aborted before execution.' };
        }

        const operation = () => dispatchCommand(args);
        if (
            knowledgeBaseManager &&
            typeof knowledgeBaseManager.runExternalFileMutation === 'function'
        ) {
            return knowledgeBaseManager.runExternalFileMutation(owner, operation, {
                signal: context.signal,
                // AI 只等待文件系统提交；Embedding、SQLite 与 Vexus 更新由 KBD 后台队列继续完成。
                waitForIndex: false
            });
        }
        return operation();
    };

    const requestPromise = residentQueue.then(execute);
    // 队列尾必须吞掉前一任务的异常，否则一次失败会永久毒化后续请求。
    residentQueue = requestPromise.catch(error => {
        console.error('[DailyNote] Resident queue task failed:', error);
    }).finally(() => {
        residentPendingCount = Math.max(0, residentPendingCount - 1);
    });

    return requestPromise;
}

function initialize(config = {}, dependencies = {}) {
    knowledgeBaseManager =
        dependencies.knowledgeBaseManager ||
        dependencies.vectorDBManager ||
        knowledgeBaseManager;
    residentAcceptingRequests = true;
    residentInitialized = true;
    console.log(
        `[DailyNote] ✅ Resident service initialized. Root: ${dailyNoteRootPath}, ` +
        `KBD coordinator: ${knowledgeBaseManager ? 'connected' : 'unavailable'}`
    );
}

function setDependencies(dependencies = {}) {
    knowledgeBaseManager =
        dependencies.knowledgeBaseManager ||
        dependencies.vectorDBManager ||
        knowledgeBaseManager;
    if (knowledgeBaseManager) {
        console.log('[DailyNote] 🔗 KnowledgeBaseManager coordinator connected.');
    }
}

async function processToolCall(args, context = {}) {
    if (!residentInitialized) {
        return {
            status: 'error',
            error: 'DailyNote resident service has not been initialized.'
        };
    }
    return enqueueResidentRequest(args, context);
}

async function shutdown() {
    residentAcceptingRequests = false;
    await residentQueue;
    knowledgeBaseManager = null;
    residentInitialized = false;
    console.log('[DailyNote] Resident service shutdown complete.');
}

// --- Legacy CLI/stdin Execution ---
async function main() {
    let inputData = '';
    process.stdin.setEncoding('utf8');

    process.stdin.on('readable', () => {
        let chunk;
        while ((chunk = process.stdin.read()) !== null) {
            inputData += chunk;
        }
    });

    process.stdin.on('end', async () => {
        debugLog('Received stdin data:', inputData);
        let result;
        try {
            if (!inputData) {
                throw new Error("No input data received via stdin.");
            }
            result = await dispatchCommand(JSON.parse(inputData));
        } catch (error) {
            console.error("[DailyNote] Error processing request:", error.message);
            result = { status: "error", error: error.message || "An unknown error occurred." };
        }

        process.stdout.write(JSON.stringify(result));
        process.exit(result.status === "success" ? 0 : 1);
    });

    process.stdin.on('error', (err) => {
        console.error("[DailyNote] Stdin error:", err);
        process.stdout.write(JSON.stringify({ status: "error", error: "Error reading input." }));
        process.exit(1);
    });
}

if (require.main === module) {
    main();
}

module.exports = {
    initialize,
    setDependencies,
    processToolCall,
    shutdown,
    dispatchCommand,
    handleCreateCommand,
    handleUpdateCommand
};