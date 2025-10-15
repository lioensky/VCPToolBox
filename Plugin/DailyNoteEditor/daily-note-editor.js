#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');

// 获取 PluginManager 注入的项目基础路径环境变量
const projectBasePath = process.env.PROJECT_BASE_PATH;
// 如果环境变量未设置，使用一个合理的默认路径（例如，假定 dailynote 在项目根目录）
const dailyNoteRootPath = projectBasePath ? path.join(projectBasePath, 'dailynote') : path.join(__dirname, '..', '..', 'dailynote');

const DEBUG_MODE = (process.env.DebugMode || "false").toLowerCase() === "true";

function debugLog(message, ...args) {
    if (DEBUG_MODE) {
        // 使用 console.error 将调试日志输出到 stderr，避免干扰 stdout 的 JSON 输出
        console.error(`[DailyNoteEditor][Debug] ${message}`, ...args);
    }
}

async function processEditRequest(inputData) {
    debugLog("Received input data:", inputData);

    // 1. 解析输入数据
    let args;
    try {
        args = JSON.parse(inputData);
    } catch (e) {
        return { status: "error", error: `Invalid JSON input: ${e.message}` };
    }

    // 2. 验证输入参数
    const { target, replace, maid } = args;

    if (typeof target !== 'string' || typeof replace !== 'string') {
        return { status: "error", error: "Invalid arguments: 'target' and 'replace' must be strings." };
    }

    // 安全性检查 1: 目标字段长度不能少于15字符
    if (target.length < 15) {
        return { status: "error", error: `Security check failed: 'target' must be at least 15 characters long. Provided length: ${target.length}` };
    }

    debugLog(`Validated input. Target length: ${target.length}. Maid: ${maid || 'Not specified'}`);

    // 3. 扫描日记文件夹并查找/替换内容
    try {
        let modificationDone = false;
        let modifiedFilePath = null;
        const directoriesToScan = [];

        if (maid) {
            // 优化 maid 字段处理，支持 [文件夹]角色名 格式
            let scanPath = dailyNoteRootPath;
            let nameToMatch = maid;
            const maidRegex = /^\[(.+?)\](.+)$/;
            const match = maid.match(maidRegex);

            if (match) {
                const subfolder = match[1];
                nameToMatch = match[2];
                scanPath = path.join(dailyNoteRootPath, subfolder);
                debugLog(`Parsed maid format: scanning in subfolder '${subfolder}' for directories starting with '${nameToMatch}'.`);
            } else {
                debugLog(`Maid specified: '${maid}'. Targeting directories starting with this name in root.`);
            }

            let allDirs;
            try {
                allDirs = await fs.readdir(scanPath, { withFileTypes: true });
            } catch (e) {
                if (e.code === 'ENOENT') {
                    return { status: "error", error: `Diary subfolder not found: ${scanPath}` };
                }
                // 对于其他错误，让外层 catch 处理
                throw e;
            }

            for (const dirEntry of allDirs) {
                if (dirEntry.isDirectory() && dirEntry.name.startsWith(nameToMatch)) {
                    directoriesToScan.push({ name: dirEntry.name, path: path.join(scanPath, dirEntry.name) });
                }
            }
            if (directoriesToScan.length === 0) {
                return { status: "error", error: `No diary folders found for maid '${maid}'.` };
            }
        } else {
            // 如果未指定 maid，扫描所有目录 (原始行为)
            debugLog("No maid specified. Scanning all directories.");
            const characterDirs = await fs.readdir(dailyNoteRootPath, { withFileTypes: true });
            for (const dirEntry of characterDirs) {
                if (dirEntry.isDirectory()) {
                    directoriesToScan.push({ name: dirEntry.name, path: path.join(dailyNoteRootPath, dirEntry.name) });
                }
            }
        }

        for (const dir of directoriesToScan) {
            debugLog(`Scanning directory: ${dir.path}`);
            try {
                const files = await fs.readdir(dir.path);
                const txtFiles = files.filter(file => file.toLowerCase().endsWith('.txt')).sort();
                debugLog(`Found ${txtFiles.length} .txt files for ${dir.name}`);

                for (const file of txtFiles) {
                    if (modificationDone) break;

                    const filePath = path.join(dir.path, file);
                    debugLog(`Reading file: ${filePath}`);
                    let content;
                    try {
                        content = await fs.readFile(filePath, 'utf-8');
                    } catch (readErr) {
                        console.error(`[DailyNoteEditor] Error reading diary file ${filePath}:`, readErr.message);
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
                            console.error(`[DailyNoteEditor] Error writing to diary file ${filePath}:`, writeErr.message);
                            break;
                        }
                    } else {
                        debugLog(`Target not found in file: ${filePath}`);
                    }
                }
            } catch (charDirError) {
                console.error(`[DailyNoteEditor] Error reading character directory ${dir.path}:`, charDirError.message);
                continue;
            }
            if (modificationDone) break;
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
            console.error(`[DailyNoteEditor] Unexpected error during processing:`, error);
            return { status: "error", error: `An unexpected error occurred: ${error.message}` };
        }
    }
}

// 读取 stdin 并处理请求
let inputChunks = [];
process.stdin.resume();
process.stdin.setEncoding('utf8');

process.stdin.on('data', function(chunk) {
    inputChunks.push(chunk);
});

process.stdin.on('end', async function() {
    const inputData = inputChunks.join('');
    const result = await processEditRequest(inputData);
    // 将结果以 JSON 字符串形式输出到 stdout
    process.stdout.write(JSON.stringify(result));
    // 确保进程退出
    process.exit(result.status === "success" ? 0 : 1);
});

process.stdin.on('error', (err) => {
    console.error('[DailyNoteEditor] Stdin error:', err);
    process.stdout.write(JSON.stringify({ status: "error", error: `Stdin read error: ${err.message}` }));
    process.exit(1);
});