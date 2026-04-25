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

// 忽略的文件夹列表
const IGNORED_FOLDERS = ['MusicDiary'];


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
    } else {
        // No tag found in either place, throw an error.
        debugLog('No tag detected in content or as an argument. Throwing error.');
        throw new Error("Tag is missing. Please provide a 'Tag' argument or add a 'Tag:' line at the end of the 'Content'.");
    }
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
async function handleCreateCommand(args) {
    // 兼容 'Date'/'dateString', 'Content'/'contentText', 和 'maid'/'maidName' (case-insensitive for maid)
    const maid = args.maid || args.maidName || args.Maid || args.MAID;
    const dateString = args.dateString || args.Date;
    const contentText = args.contentText || args.Content;
    const tag = args.Tag || args.tag;
    const fileName = args.fileName || args.FileName;

    debugLog(`Processing 'create' for Maid: ${maid}, Date: ${dateString}, fileName: ${fileName}`);
    if (!maid || !dateString || !contentText) {
        return { status: "error", error: 'Invalid input for create: Missing maid/maidName, dateString/Date, or contentText/Content.' };
    }

    try {
        // 先将 file:// 本地路径转换为 ImageServer 内网 URL
        const fileConvertedContent = await processLocalFiles(contentText);
        const processedContent = await processTags(fileConvertedContent, tag);
        debugLog('Content after tag processing (length):', processedContent.length);

        const trimmedMaidName = maid.trim();
        let folderName = trimmedMaidName;
        let actualMaidName = trimmedMaidName;
        const tagMatch = trimmedMaidName.match(/^\[(.*?)\](.*)$/);

        if (tagMatch) {
            folderName = tagMatch[1].trim();
            actualMaidName = tagMatch[2].trim();
            debugLog(`Tagged note detected. Tag: ${folderName}, Actual Maid: ${actualMaidName}`);
        } else {
            debugLog(`No tag detected. Folder: ${folderName}, Actual Maid: ${actualMaidName}`);
        }

        const sanitizedFolderName = sanitizePathComponent(folderName);
        if (folderName !== sanitizedFolderName) {
            debugLog(`Sanitized folder name from "${folderName}" to "${sanitizedFolderName}"`);
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

        // 循环检查文件名冲突
        while (true) {
            try {
                await fs.access(filePath);
                // 如果文件已存在，增加计数器并重试
                counter++;
                finalFileName = `${baseFileNameWithoutExt}(${counter})${fileExtension}`;
                filePath = path.join(dirPath, finalFileName);
            } catch (err) {
                // 文件不存在，可以使用此路径
                break;
            }
        }

        debugLog(`Target file path: ${filePath}`);
        const fileContent = `[${datePart}] - ${actualMaidName}\n${processedContent}`;
        await fs.writeFile(filePath, fileContent);
        debugLog(`Successfully wrote file (length: ${fileContent.length})`);
        return { status: "success", message: `Diary saved to ${filePath}` };
    } catch (error) {
        console.error("[DailyNote] Error during 'create' command:", error.message);
        return { status: "error", error: error.message || "An unknown error occurred during diary creation." };
    }
}


// --- 'update' Command Logic ---
async function handleUpdateCommand(args) {
    debugLog("Processing 'update' command with args:", args);

    const { target, replace, maid } = args;

    if (typeof target !== 'string' || typeof replace !== 'string') {
        return { status: "error", error: "Invalid arguments for update: 'target' and 'replace' must be strings." };
    }

    if (target.length < 15) {
        return { status: "error", error: `Security check failed: 'target' must be at least 15 characters long. Provided length: ${target.length}` };
    }

    debugLog(`Validated input for update. Target length: ${target.length}. Maid: ${maid || 'Not specified'}`);

    try {
        let modificationDone = false;
        let modifiedFilePath = null;

        // 构建搜索顺序：优先文件夹 + 其他所有文件夹
        const priorityDirs = [];  // 优先搜索的文件夹
        const otherDirs = [];     // 其他文件夹

        // 获取所有子文件夹，过滤掉被忽略的文件夹
        const allDirEntries = await fs.readdir(dailyNoteRootPath, { withFileTypes: true });
        const allDirs = allDirEntries.filter(d => d.isDirectory() && !IGNORED_FOLDERS.includes(d.name));
        debugLog(`Filtered out ignored folders: ${IGNORED_FOLDERS.join(', ')}. Remaining directories: ${allDirs.map(d => d.name).join(', ')}`);

        if (maid) {
            const maidRegex = /^\[(.+?)\]/;
            const match = maid.match(maidRegex);

            if (match) {
                // 格式: [小克的知识]小克 -> 优先在 "小克的知识" 文件夹找
                const priorityFolder = sanitizePathComponent(match[1]);
                debugLog(`Maid specifies priority folder (sanitized): '${priorityFolder}'`);

                for (const dirEntry of allDirs) {
                    const dirPath = path.join(dailyNoteRootPath, dirEntry.name);

                    // 安全检查：确保路径在 dailyNoteRootPath 内
                    if (!isPathWithinBase(dirPath, dailyNoteRootPath)) {
                        debugLog(`Skipping unsafe directory during update: ${dirPath}`);
                        continue;
                    }

                    if (sanitizePathComponent(dirEntry.name) === priorityFolder) {
                        priorityDirs.push({ name: dirEntry.name, path: dirPath });
                    } else {
                        otherDirs.push({ name: dirEntry.name, path: dirPath });
                    }
                }

                if (priorityDirs.length === 0) {
                    debugLog(`Priority folder '${priorityFolder}' not found, will search all folders.`);
                }
            } else {
                // 格式: 小克 -> 优先在以 "小克" 开头的文件夹找
                const sanitizedMaid = sanitizePathComponent(maid);
                debugLog(`Maid specified: '${maid}' (sanitized: '${sanitizedMaid}'). Prioritizing directories starting with this name.`);

                for (const dirEntry of allDirs) {
                    const dirPath = path.join(dailyNoteRootPath, dirEntry.name);

                    // 安全检查：确保路径在 dailyNoteRootPath 内
                    if (!isPathWithinBase(dirPath, dailyNoteRootPath)) {
                        debugLog(`Skipping unsafe directory during update: ${dirPath}`);
                        continue;
                    }

                    if (sanitizePathComponent(dirEntry.name).startsWith(sanitizedMaid)) {
                        priorityDirs.push({ name: dirEntry.name, path: dirPath });
                    } else {
                        otherDirs.push({ name: dirEntry.name, path: dirPath });
                    }
                }
            }
        } else {
            // 没有指定 maid，搜索所有文件夹
            debugLog("No maid specified. Scanning all directories.");
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
        debugLog(`Search order: ${directoriesToScan.map(d => d.name).join(' -> ')}`);

        if (directoriesToScan.length === 0) {
            return { status: "error", error: `No diary folders found in ${dailyNoteRootPath}` };
        }

        for (const dir of directoriesToScan) {
            if (modificationDone) break;
            debugLog(`Scanning directory: ${dir.path}`);
            try {
                const files = await fs.readdir(dir.path);
                const txtFiles = files.filter(file => file.toLowerCase().endsWith('.txt') || file.toLowerCase().endsWith('.md')).sort();
                debugLog(`Found ${txtFiles.length} diary files for ${dir.name}`);

                for (const file of txtFiles) {
                    if (modificationDone) break;
                    const filePath = path.join(dir.path, file);
                    debugLog(`Reading file: ${filePath}`);
                    let content;
                    try {
                        content = await fs.readFile(filePath, 'utf-8');
                    } catch (readErr) {
                        console.error(`[DailyNote] Error reading diary file ${filePath}:`, readErr.message);
                        continue;
                    }

                    const index = content.indexOf(target);
                    if (index !== -1) {
                        debugLog(`Found target in file: ${filePath}`);
                        const newContent = content.substring(0, index) + replace + content.substring(index + target.length);
                        try {
                            await fs.writeFile(filePath, newContent, 'utf-8');
                            modificationDone = true;
                            modifiedFilePath = filePath;
                            debugLog(`Successfully modified file: ${filePath}`);
                            break;
                        } catch (writeErr) {
                            console.error(`[DailyNote] Error writing to diary file ${filePath}:`, writeErr.message);
                            break;
                        }
                    }
                }
            } catch (charDirError) {
                console.error(`[DailyNote] Error reading character directory ${dir.path}:`, charDirError.message);
                continue;
            }
        }

        if (modificationDone) {
            return { status: "success", result: `Successfully edited diary file: ${modifiedFilePath}` };
        } else {
            const errorMessage = maid ? `Target content not found in any diary files for maid '${maid}'.` : "Target content not found in any diary files.";
            return { status: "error", error: errorMessage };
        }

    } catch (error) {
        if (error.code === 'ENOENT') {
            return { status: "error", error: `Daily note root directory not found at ${dailyNoteRootPath}` };
        } else {
            console.error(`[DailyNote] Unexpected error during 'update' command:`, error);
            return { status: "error", error: `An unexpected error occurred: ${error.message}` };
        }
    }
}


// --- Main Execution ---
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
            const args = JSON.parse(inputData);
            const { command, ...parameters } = args;

            switch (command) {
                case 'create':
                    result = await handleCreateCommand(parameters);
                    break;
                case 'update':
                    result = await handleUpdateCommand(parameters);
                    break;
                default:
                    result = { status: "error", error: `Unknown command: '${command}'. Use 'create' or 'update'.` };
            }
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

main();