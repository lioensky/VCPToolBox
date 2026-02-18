const fs = require('fs').promises;
const path = require('path');

// 获取 PluginManager 注入的项目基础路径环境变量
const projectBasePath = process.env.PROJECT_BASE_PATH;
const dailyNoteRootPath = process.env.KNOWLEDGEBASE_ROOT_PATH || (projectBasePath ? path.join(projectBasePath, 'dailynote') : path.join(__dirname, '..', '..', 'dailynote')); // Fallback if env var not set

const DEBUG_MODE = (process.env.DebugMode || "false").toLowerCase() === "true";

function debugLog(message, ...args) {
    if (DEBUG_MODE) {
        console.error(`[DailyNoteGet][Debug] ${message}`, ...args); // Log debug to stderr
    }
}

async function getAllCharacterDiaries() {
    const allDiaries = {};
    debugLog(`Starting diary scan in: ${dailyNoteRootPath}`);

    try {
        const characterDirs = await fs.readdir(dailyNoteRootPath, { withFileTypes: true });

        for (const dirEntry of characterDirs) {
            if (dirEntry.isDirectory()) {
                const characterName = dirEntry.name;
                const characterDirPath = path.join(dailyNoteRootPath, characterName);
                let characterDiaryContent = '';
                debugLog(`Scanning directory for character: ${characterName}`);

                try {
                    const files = await fs.readdir(characterDirPath);
                    const relevantFiles = files.filter(file => {
                        const lowerCaseFile = file.toLowerCase();
                        return lowerCaseFile.endsWith('.txt') || lowerCaseFile.endsWith('.md');
                    }).sort();
                    debugLog(`Found ${relevantFiles.length} relevant files (.txt, .md) for ${characterName}`);

                    if (relevantFiles.length > 0) {
                        const fileContents = await Promise.all(
                            relevantFiles.map(async (file) => {
                                const filePath = path.join(characterDirPath, file);
                                try {
                                    const content = await fs.readFile(filePath, 'utf-8');
                                    debugLog(`Read content from ${file} (length: ${content.length})`);
                                    // 在内容前添加本地文件路径信息
                                    return `[File: ${filePath}]\n${content}`;
                                } catch (readErr) {
                                    console.error(`[DailyNoteGet] Error reading diary file ${filePath}:`, readErr.message);
                                    return `[Error reading file: ${file}]`; // Include error marker in content
                                }
                            })
                        );
                        // Combine content with separators, similar to server.js logic
                        characterDiaryContent = fileContents.join('\n\n---\n\n');
                    } else {
                         characterDiaryContent = `[${characterName}日记本内容为空]`; // Explicitly state if empty
                         debugLog(`No .txt or .md files found for ${characterName}, setting content to empty marker.`);
                    }
                } catch (charDirError) {
                     console.error(`[DailyNoteGet] Error reading character directory ${characterDirPath}:`, charDirError.message);
                     characterDiaryContent = `[Error reading ${characterName}'s diary directory]`;
                }
                allDiaries[characterName] = characterDiaryContent;
            }
        }
        debugLog(`Finished diary scan. Found diaries for ${Object.keys(allDiaries).length} characters.`);

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.error(`[DailyNoteGet] Error: Daily note root directory not found at ${dailyNoteRootPath}`);
        } else {
            console.error(`[DailyNoteGet] Error reading daily note root directory ${dailyNoteRootPath}:`, error.message);
        }
        // Output empty JSON if root directory fails
        return '{}';
    }

    // Output the result as a JSON string to stdout
    return JSON.stringify(allDiaries);
}

(async () => {
    try {
        const resultJsonString = await getAllCharacterDiaries();
        process.stdout.write(resultJsonString); // Write JSON string to stdout
        debugLog('Successfully wrote diary JSON to stdout.');
    } catch (e) {
        console.error("[DailyNoteGet] Fatal error during execution:", e);
        // Output empty JSON on fatal error to prevent breaking PluginManager
        process.stdout.write('{}');
        process.exit(1); // Exit with error code
    }
})();