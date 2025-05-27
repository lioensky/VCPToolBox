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
    const target = args.target;
    const replace = args.replace;

    if (typeof target !== 'string' || typeof replace !== 'string') {
        return { status: "error", error: "Invalid arguments: 'target' and 'replace' must be strings." };
    }

    // 安全性检查 1: 目标字段长度不能少于15字符
    if (target.length < 15) {
        return { status: "error", error: `Security check failed: 'target' must be at least 15 characters long. Provided length: ${target.length}` };
    }

    debugLog(`Validated input. Target length: ${target.length}`);

    // 3. 扫描日记文件夹并查找/替换内容
    try {
        const characterDirs = await fs.readdir(dailyNoteRootPath, { withFileTypes: true });
        let modificationDone = false;
        let modifiedFilePath = null;

        for (const dirEntry of characterDirs) {
            if (dirEntry.isDirectory()) {
                const characterName = dirEntry.name;
                const characterDirPath = path.join(dailyNoteRootPath, characterName);
                debugLog(`Scanning directory for character: ${characterName}`);

                try {
                    const files = await fs.readdir(characterDirPath);
                    // 过滤出 .txt 文件并按名称排序，以便按某种可预测的顺序处理
                    const txtFiles = files.filter(file => file.toLowerCase().endsWith('.txt')).sort();
                    debugLog(`Found ${txtFiles.length} .txt files for ${characterName}`);

                    for (const file of txtFiles) {
                        if (modificationDone) break; // 安全性检查 2: 一次只能修改一个日记内容

                        const filePath = path.join(characterDirPath, file);
                        debugLog(`Reading file: ${filePath}`);

                        let content;
                        try {
                            content = await fs.readFile(filePath, 'utf-8');
                        } catch (readErr) {
                            console.error(`[DailyNoteEditor] Error reading diary file ${filePath}:`, readErr.message);
                            // 继续处理下一个文件
                            continue;
                        }

                        // 使用 indexOf 查找 target 字符串
                        const index = content.indexOf(target);

                        if (index !== -1) {
                            debugLog(`Found target in file: ${filePath}`);

                            // 执行替换
                            const newContent = content.substring(0, index) + replace + content.substring(index + target.length);

                            // 写入修改后的内容
                            try {
                                await fs.writeFile(filePath, newContent, 'utf-8');
                                modificationDone = true;
                                modifiedFilePath = filePath;
                                debugLog(`Successfully modified file: ${filePath}`);
                                // 安全性检查 2: 找到并修改第一个匹配项后立即停止
                                break;
                            } catch (writeErr) {
                                console.error(`[DailyNoteEditor] Error writing to diary file ${filePath}:`, writeErr.message);
                                // 如果写入失败，记录错误，但继续查找下一个可能的匹配项（虽然要求只修改一个，但为了健壮性，这里不立即退出）
                                // 实际应用中，如果要求严格“一次只能修改一个”，这里应该直接返回错误并退出。
                                // 考虑到AI可能发出多个匹配，我们只修改第一个找到的，所以这里break是正确的。
                                break; // 写入失败也算处理了这个文件，退出内层循环
                            }
                        } else {
                             debugLog(`Target not found in file: ${filePath}`);
                        }
                    }
                } catch (charDirError) {
                    console.error(`[DailyNoteEditor] Error reading character directory ${characterDirPath}:`, charDirError.message);
                    // 继续处理下一个角色目录
                    continue;
                }
            }
            if (modificationDone) break; // 安全性检查 2: 找到并修改第一个匹配项后立即停止
        }

        if (modificationDone) {
            return { status: "success", result: `Successfully edited diary file: ${modifiedFilePath}` };
        } else {
            return { status: "error", error: "Target content not found in any diary files." };
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