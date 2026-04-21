#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');

// --- Load environment variables ---
require('dotenv').config({ path: path.join(__dirname, 'config.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', 'config.env') });

// --- Configuration ---
const DEBUG_MODE = (process.env.DebugMode || "false").toLowerCase() === "true";
const projectBasePath = process.env.PROJECT_BASE_PATH;
const dailyNoteRootPath = process.env.KNOWLEDGEBASE_ROOT_PATH || (projectBasePath ? path.join(projectBasePath, 'dailynote') : path.join(__dirname, '..', '..', 'dailynote'));
const CONFIGURED_EXTENSION = (process.env.DAILY_NOTE_EXTENSION || "txt").toLowerCase() === "md" ? "md" : "txt";

// 忽略的文件夹列表
const IGNORED_FOLDERS = ['MusicDiary'];
// 归档文件夹名
const ARCHIVE_FOLDER = '已整理';

// --- Debug Logging (to stderr) ---
function debugLog(message, ...args) {
    if (DEBUG_MODE) {
        console.error(`[DailyNoteManager][Debug] ${message}`, ...args);
    }
}

// --- Helper: Sanitize Path Component ---
function sanitizePathComponent(name) {
    if (!name || typeof name !== 'string') {
        return 'Untitled';
    }
    let sanitized = name
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .replace(/\s+/g, '_')
        .replace(/^[._]+|[._]+$/g, '')
        .replace(/_+/g, '_');

    const windowsReserved = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;
    if (windowsReserved.test(sanitized)) {
        sanitized = '_' + sanitized;
    }
    const MAX_FOLDER_NAME_LENGTH = 100;
    if (sanitized.length > MAX_FOLDER_NAME_LENGTH) {
        sanitized = sanitized.substring(0, MAX_FOLDER_NAME_LENGTH).replace(/[._]+$/g, '');
    }
    return sanitized || 'Untitled';
}

// --- Helper: Path Safety Check ---
function isPathWithinBase(targetPath, basePath) {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedBase = path.resolve(basePath);
    return resolvedTarget === resolvedBase ||
        resolvedTarget.startsWith(resolvedBase + path.sep);
}

// --- Helper: Extract date from diary filename ---
// 支持格式: 2026-04-18-14_52_57.txt, 2026-04-18-14_52_57-标题.txt
// 也兼容旧格式: 2025.05.13.txt, 2025.05.13.1.txt
function extractDateFromFilename(filename) {
    // 新格式: YYYY-MM-DD-HH_MM_SS...
    const newFormatMatch = filename.match(/^(\d{4})-(\d{2})-(\d{2})-/);
    if (newFormatMatch) {
        return `${newFormatMatch[1]}-${newFormatMatch[2]}-${newFormatMatch[3]}`;
    }

    // 旧格式: YYYY.MM.DD...
    const oldFormatMatch = filename.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
    if (oldFormatMatch) {
        return `${oldFormatMatch[1]}-${oldFormatMatch[2]}-${oldFormatMatch[3]}`;
    }

    return null;
}

// --- Helper: Parse date string to comparable value ---
function parseDateToNum(dateStr) {
    // dateStr: "YYYY-MM-DD"
    return parseInt(dateStr.replace(/-/g, ''), 10);
}

// --- Helper: Tag Processing (aligned with DailyNote plugin) ---
function detectTagLine(content) {
    const lines = content.split('\n');
    if (lines.length === 0) {
        return { hasTag: false, lastLine: '', contentWithoutLastLine: content };
    }
    const lastLine = lines[lines.length - 1].trim();
    const tagPattern = /^Tag:\s*.+/i;
    const hasTag = tagPattern.test(lastLine);
    const contentWithoutLastLine = hasTag ? lines.slice(0, -1).join('\n') : content;
    return { hasTag, lastLine, contentWithoutLastLine };
}

function fixTagFormat(tagLine) {
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
        .replace(/[。.]+$/g, '');
    normalizedContent = normalizedContent
        .replace(/,\s*/g, ', ')
        .replace(/,\s{2,}/g, ', ')
        .replace(/\s+,/g, ',');
    normalizedContent = normalizedContent.replace(/\s{2,}/g, ' ').trim();
    return 'Tag: ' + normalizedContent;
}

function processTags(contentText, externalTag) {
    if (externalTag && typeof externalTag === 'string' && externalTag.trim() !== '') {
        const fixedTag = fixTagFormat(externalTag);
        return contentText.trimEnd() + '\n' + fixedTag;
    }
    const detection = detectTagLine(contentText);
    if (detection.hasTag) {
        const fixedTag = fixTagFormat(detection.lastLine);
        return detection.contentWithoutLastLine.trimEnd() + '\n' + fixedTag;
    }
    throw new Error("Tag is missing. Please provide a 'Tag' argument or add a 'Tag:' line at the end of the 'Content'.");
}

// ============================================================
// Command: list
// 列出指定文件夹中某日期范围内的所有日记
// ============================================================
async function handleListCommand(args) {
    const folder = args.folder || args.Folder;
    const startDate = args.startDate || args.StartDate || args.start_date;
    const endDate = args.endDate || args.EndDate || args.end_date;

    debugLog(`Processing 'list' command - folder: ${folder}, startDate: ${startDate}, endDate: ${endDate}`);

    if (!folder || !startDate || !endDate) {
        return { status: "error", error: "参数不完整：需要 folder, startDate, endDate。" };
    }

    // 验证日期格式
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
        return { status: "error", error: "日期格式错误，请使用 YYYY-MM-DD 格式。" };
    }

    const startNum = parseDateToNum(startDate);
    const endNum = parseDateToNum(endDate);
    if (startNum > endNum) {
        return { status: "error", error: `起始日期 ${startDate} 不能晚于结束日期 ${endDate}。` };
    }

    // 安全检查文件夹
    const sanitizedFolder = sanitizePathComponent(folder);
    const dirPath = path.join(dailyNoteRootPath, sanitizedFolder);

    if (!isPathWithinBase(dirPath, dailyNoteRootPath)) {
        return { status: "error", error: "安全错误：检测到无效的文件夹路径。" };
    }

    if (IGNORED_FOLDERS.includes(sanitizedFolder)) {
        return { status: "error", error: `不允许访问被忽略的文件夹: ${sanitizedFolder}` };
    }

    try {
        await fs.access(dirPath);
    } catch {
        return { status: "error", error: `文件夹不存在: ${sanitizedFolder}` };
    }

    try {
        const files = await fs.readdir(dirPath);
        const diaryFiles = files
            .filter(f => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md'))
            .sort();

        const results = [];

        for (const file of diaryFiles) {
            const dateStr = extractDateFromFilename(file);
            if (!dateStr) {
                debugLog(`跳过无法解析日期的文件: ${file}`);
                continue;
            }

            const fileNum = parseDateToNum(dateStr);
            if (fileNum < startNum || fileNum > endNum) {
                continue;
            }

            const filePath = path.join(dirPath, file);
            let content = '';
            try {
                content = await fs.readFile(filePath, 'utf-8');
            } catch (readErr) {
                console.error(`[DailyNoteManager] 读取文件失败 ${filePath}: ${readErr.message}`);
                continue;
            }

            // 构建相对 URL（相对于 dailyNoteRootPath）
            const relativeUrl = path.join(sanitizedFolder, file).replace(/\\/g, '/');

            results.push({
                url: relativeUrl,
                date: dateStr,
                filename: file,
                content: content
            });
        }

        debugLog(`在 ${sanitizedFolder} 中找到 ${results.length} 条日记（日期范围 ${startDate} ~ ${endDate}）`);

        // 格式化输出
        if (results.length === 0) {
            return {
                status: "success",
                result: `在「${sanitizedFolder}」文件夹中，日期范围 ${startDate} ~ ${endDate} 内未找到任何日记文件。`
            };
        }

        let output = `在「${sanitizedFolder}」中找到 ${results.length} 条日记（${startDate} ~ ${endDate}）：\n\n`;
        for (const entry of results) {
            output += `--- [${entry.url}] ---\n`;
            output += entry.content;
            if (!entry.content.endsWith('\n')) {
                output += '\n';
            }
            output += '\n';
        }

        return { status: "success", result: output.trimEnd() };

    } catch (error) {
        console.error(`[DailyNoteManager] list 命令错误:`, error);
        return { status: "error", error: `读取文件夹失败: ${error.message}` };
    }
}

// ============================================================
// Command: organize
// 整理日记：创建新的合并日记 + 将原始文件归档到「已整理」
// ============================================================
async function handleOrganizeCommand(args) {
    const urls = args.urls || args.Urls || args.URL;
    const maid = args.maid || args.maidName || args.Maid;
    const dateString = args.dateString || args.Date || args.date;
    const contentText = args.contentText || args.Content || args.content;
    const tag = args.Tag || args.tag;
    const fileName = args.fileName || args.FileName;

    debugLog(`Processing 'organize' command`);

    // 参数验证
    if (!urls || !maid || !dateString || !contentText) {
        return {
            status: "error",
            error: "参数不完整：需要 urls（待整理的文件URL列表）、maid、Date、Content。"
        };
    }

    // 解析 urls（按换行符分割）
    const urlList = urls.split('\n').map(u => u.trim()).filter(u => u.length > 0);
    if (urlList.length === 0) {
        return { status: "error", error: "urls 列表为空，请至少提供一个要整理的文件URL。" };
    }

    debugLog(`待整理文件数: ${urlList.length}`);

    // ---- Step 1: 创建新的整理后日记 ----
    let newFilePath = '';
    try {
        const processedContent = processTags(contentText, tag);

        const trimmedMaidName = maid.trim();
        let folderName = trimmedMaidName;
        let actualMaidName = trimmedMaidName;
        const tagMatch = trimmedMaidName.match(/^\[(.*?)\](.*)$/);

        if (tagMatch) {
            folderName = tagMatch[1].trim();
            actualMaidName = tagMatch[2].trim();
            debugLog(`Tagged note detected. Tag: ${folderName}, Actual Maid: ${actualMaidName}`);
        }

        const sanitizedFolderName = sanitizePathComponent(folderName);
        if (IGNORED_FOLDERS.includes(sanitizedFolderName)) {
            return { status: "error", error: `不允许写入被忽略的文件夹: ${sanitizedFolderName}` };
        }

        const datePart = dateString.replace(/[.\\\/\s-]/g, '-').replace(/-+/g, '-');
        const now = new Date();
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const seconds = now.getSeconds().toString().padStart(2, '0');
        const timeStringForFile = `${hours}_${minutes}_${seconds}`;

        const dirPath = path.join(dailyNoteRootPath, sanitizedFolderName);
        if (!isPathWithinBase(dirPath, dailyNoteRootPath)) {
            return { status: "error", error: "安全错误：检测到无效的文件夹路径。" };
        }

        // 可选的 fileName 后缀
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
                counter++;
                finalFileName = `${baseFileNameWithoutExt}(${counter})${fileExtension}`;
                filePath = path.join(dirPath, finalFileName);
            } catch {
                break; // 文件不存在，可以使用
            }
        }

        // 写入新日记（格式与 DailyNote create 完全一致）
        const fileContent = `[${datePart}] - ${actualMaidName}\n${processedContent}`;
        await fs.writeFile(filePath, fileContent, 'utf-8');
        newFilePath = filePath;
        debugLog(`成功创建整理后日记: ${filePath}`);

    } catch (createError) {
        return {
            status: "error",
            error: `创建整理后日记失败: ${createError.message}`
        };
    }

    // ---- Step 2: 将原始文件移动到「已整理」文件夹 ----
    const archiveDir = path.join(dailyNoteRootPath, ARCHIVE_FOLDER);
    if (!isPathWithinBase(archiveDir, dailyNoteRootPath)) {
        return { status: "error", error: "安全错误：归档文件夹路径无效。" };
    }

    await fs.mkdir(archiveDir, { recursive: true });

    const moveResults = [];
    for (const url of urlList) {
        // url 格式: "文件夹名/文件名.txt" （相对于 dailyNoteRootPath）
        const sourcePath = path.join(dailyNoteRootPath, url.replace(/\//g, path.sep));

        if (!isPathWithinBase(sourcePath, dailyNoteRootPath)) {
            moveResults.push({ url, status: 'error', message: '路径安全检查失败' });
            continue;
        }

        try {
            await fs.access(sourcePath);
        } catch {
            moveResults.push({ url, status: 'error', message: '文件不存在' });
            continue;
        }

        const baseFileName = path.basename(sourcePath);
        let destPath = path.join(archiveDir, baseFileName);
        let archiveCounter = 1;

        // 处理归档目录的文件名冲突
        while (true) {
            try {
                await fs.access(destPath);
                archiveCounter++;
                const ext = path.extname(baseFileName);
                const nameWithoutExt = path.basename(baseFileName, ext);
                destPath = path.join(archiveDir, `${nameWithoutExt}(${archiveCounter})${ext}`);
            } catch {
                break;
            }
        }

        try {
            // 先尝试 rename（同设备快速移动）
            await fs.rename(sourcePath, destPath);
            moveResults.push({ url, status: 'success', message: `已归档到 ${ARCHIVE_FOLDER}/` });
            debugLog(`已移动: ${sourcePath} -> ${destPath}`);
        } catch (renameErr) {
            // rename 失败（可能跨设备），回退到 copy + delete
            try {
                await fs.copyFile(sourcePath, destPath);
                await fs.unlink(sourcePath);
                moveResults.push({ url, status: 'success', message: `已归档到 ${ARCHIVE_FOLDER}/` });
                debugLog(`已复制并删除: ${sourcePath} -> ${destPath}`);
            } catch (copyErr) {
                moveResults.push({ url, status: 'error', message: `归档失败: ${copyErr.message}` });
                console.error(`[DailyNoteManager] 归档文件失败 ${sourcePath}:`, copyErr.message);
            }
        }
    }

    // ---- 汇总结果 ----
    const successCount = moveResults.filter(r => r.status === 'success').length;
    const failCount = moveResults.filter(r => r.status === 'error').length;

    let summaryMessage = `日记整理完成！\n`;
    summaryMessage += `✅ 新日记已保存: ${newFilePath}\n`;
    summaryMessage += `📦 归档结果: ${successCount} 个文件成功归档到「${ARCHIVE_FOLDER}」`;
    if (failCount > 0) {
        summaryMessage += `，${failCount} 个文件处理失败`;
        const failDetails = moveResults
            .filter(r => r.status === 'error')
            .map(r => `  - ${r.url}: ${r.message}`)
            .join('\n');
        summaryMessage += `\n失败详情:\n${failDetails}`;
    }

    return {
        status: failCount > 0 ? "partial" : "success",
        result: summaryMessage
    };
}

// ============================================================
// Main Entry
// ============================================================
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
                case 'list':
                    result = await handleListCommand(parameters);
                    break;
                case 'organize':
                    result = await handleOrganizeCommand(parameters);
                    break;
                default:
                    result = {
                        status: "error",
                        error: `未知命令: '${command}'。可用命令: 'list'（列出日记）, 'organize'（整理日记）。`
                    };
            }
        } catch (error) {
            console.error("[DailyNoteManager] Error processing request:", error.message);
            result = { status: "error", error: error.message || "An unknown error occurred." };
        }

        process.stdout.write(JSON.stringify(result));
        process.exit(result.status === "error" ? 1 : 0);
    });

    process.stdin.on('error', (err) => {
        console.error("[DailyNoteManager] Stdin error:", err);
        process.stdout.write(JSON.stringify({ status: "error", error: "Error reading input." }));
        process.exit(1);
    });
}

main();