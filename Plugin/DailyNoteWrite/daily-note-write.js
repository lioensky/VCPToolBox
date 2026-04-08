const fs = require('fs').promises;
const path = require('path');

// --- Load environment variables ---
require('dotenv').config({ path: path.join(__dirname, 'config.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', 'config.env') }); // Load root config

// --- Configuration ---
const DEBUG_MODE = (process.env.DebugMode || "false").toLowerCase() === "true";
const CONFIGURED_EXTENSION = (process.env.DAILY_NOTE_EXTENSION || "txt").toLowerCase() === "md" ? "md" : "txt";
const projectBasePath = process.env.PROJECT_BASE_PATH;
const dailyNoteRootPath = process.env.KNOWLEDGEBASE_ROOT_PATH || (projectBasePath ? path.join(projectBasePath, 'dailynote') : path.join(__dirname, '..', '..', 'dailynote'));

// Tag processing configuration
const TAG_MODEL = process.env.TagModel || 'gemini-2.5-flash-preview-09-2025-thinking';
const TAG_MODEL_MAX_OUTPUT_TOKENS = parseInt(process.env.TagModelMaxOutPutTokens || '30000', 10);
const TAG_MODEL_MAX_TOKENS = parseInt(process.env.TagModelMaxTokens || '40000', 10);
const TAG_MODEL_PROMPT_FILE = process.env.TagModelPrompt || 'TagMaster.txt';

// API configuration from root config.env
const API_KEY = process.env.API_Key;
const API_URL = process.env.API_URL;

// --- Debug Logging (to stderr) ---
function debugLog(message, ...args) {
    if (DEBUG_MODE) {
        console.error(`[DailyNoteWrite][Debug] ${message}`, ...args); // Log debug to stderr
    }
}

// --- Output Function (to stdout) ---
function sendOutput(data) {
    try {
        const jsonString = JSON.stringify(data);
        process.stdout.write(jsonString);
        debugLog('Sent output to stdout:', jsonString);
    } catch (e) {
        // Fallback for stringification errors
        console.error("[DailyNoteWrite] Error stringifying output:", e);
        process.stdout.write(JSON.stringify({ status: "error", message: "Internal error: Failed to stringify output." }));
    }
}

// --- Helper Function for Sanitization ---
function sanitizePathComponent(name) {
    if (!name || typeof name !== 'string') {
        return 'Untitled'; // Return a default name for invalid input
    }
    // Replace invalid characters for Windows/Linux/macOS filenames
    const sanitized = name.replace(/[\\/:*?"<>|]/g, '')
                         // Remove control characters
                         .replace(/[\x00-\x1f\x7f]/g, '')
                         // Trim whitespace and dots from both ends, which are problematic on Windows
                         .trim()
                         .replace(/^[.]+|[.]+$/g, '')
                         .trim(); // Trim again in case dots were removed

    // If the name is empty after sanitization (e.g., it was just "."), use a fallback.
    return sanitized || 'Untitled';
}
// --- Tag Processing Functions ---

/**
 * 检查最后一行是否为Tag行
 * @param {string} content - 日记内容
 * @returns {Object} { hasTag: boolean, lastLine: string, contentWithoutLastLine: string }
 */
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
    
    return {
        hasTag,
        lastLine,
        contentWithoutLastLine
    };
}

/**
 * 修复Tag行格式
 * @param {string} tagLine - 原始Tag行
 * @returns {string} - 修复后的Tag行
 */
function fixTagFormat(tagLine) {
    debugLog('Fixing tag line format:', tagLine);
    
    // 移除首行缩进和两端空格
    let fixed = tagLine.trim();
    
    // 确保以"Tag:"开头（不区分大小写，但统一为"Tag:"）
    fixed = fixed.replace(/^tag:\s*/i, 'Tag: ');
    
    // 如果没有"Tag:"前缀，添加它
    if (!fixed.startsWith('Tag: ')) {
        fixed = 'Tag: ' + fixed;
    }
    
    // 提取Tag内容部分（去掉"Tag: "前缀）
    const tagContent = fixed.substring(5).trim();
    
    // 修复标点符号：
    // 1. 将中文冒号替换为空（因为前面已经有英文冒号）
    // 2. 将中文逗号、全角逗号、顿号都替换为英文逗号+空格
    let normalizedContent = tagContent
        .replace(/[\uff1a]/g, '') // 中文冒号 ：
        .replace(/[\uff0c]/g, ', ') // 中文逗号 ，
        .replace(/[\u3001]/g, ', '); // 顿号 、
    
    // 规范化逗号+空格格式：确保逗号后有且仅有一个空格
    normalizedContent = normalizedContent
        .replace(/,\s*/g, ', ') // 逗号后添加空格
        .replace(/,\s{2,}/g, ', ') // 多个空格替换为一个
        .replace(/\s+,/g, ','); // 逗号前的空格删除
    
    // 去除多余的空格
    normalizedContent = normalizedContent.replace(/\s{2,}/g, ' ').trim();
    
    const result = 'Tag: ' + normalizedContent;
    
    debugLog('Fixed tag line:', result);
    return result;
}

/**
 * 从AI响应中提取Tag行
 * @param {string} aiResponse - AI的完整响应
 * @returns {string|null} - 提取的Tag行或null
 */
function extractTagFromAIResponse(aiResponse) {
    debugLog('Extracting tag from AI response:', aiResponse);
    
    // 匹配 [[Tag: ...]] 格式
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

/**
 * 延迟函数（用于退避重试）
 * @param {number} ms - 延迟毫秒数
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 调用AI模型生成Tag（带退避重试机制）
 * @param {string} content - 日记内容
 * @param {number} maxRetries - 最大重试次数（默认3次）
 * @returns {Promise<string|null>} - 生成的Tag行或null
 */
async function generateTagsWithAI(content, maxRetries = 3) {
    debugLog('Generating tags with AI model...');
    
    // 检查API配置
    if (!API_KEY || !API_URL) {
        console.error('[DailyNoteWrite] API configuration missing. Cannot generate tags.');
        return null;
    }
    
    // 读取TagMaster提示词
    const promptFilePath = path.join(__dirname, TAG_MODEL_PROMPT_FILE);
    let systemPrompt;
    try {
        systemPrompt = await fs.readFile(promptFilePath, 'utf-8');
    } catch (err) {
        console.error('[DailyNoteWrite] Failed to read TagMaster prompt file:', err.message);
        return null;
    }
    
    // 构建请求数据
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
        temperature: 0.7
    };
    
    // 带退避重试的API调用
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
                timeout: 60000 // 60秒超时
            });
            
            // 检查是否为需要重试的错误码
            if (response.status === 500 || response.status === 503) {
                const errorText = await response.text();
                console.error(`[DailyNoteWrite] API returned ${response.status} (attempt ${attempt}/${maxRetries}):`, errorText);
                
                if (attempt < maxRetries) {
                    // 指数退避：第1次重试等1秒，第2次等2秒，第3次等4秒
                    const backoffTime = Math.pow(2, attempt - 1) * 1000;
                    debugLog(`Retrying after ${backoffTime}ms...`);
                    await delay(backoffTime);
                    continue; // 继续下一次重试
                } else {
                    console.error('[DailyNoteWrite] Max retries reached. Giving up tag generation.');
                    return null;
                }
            }
            
            // 其他错误码不重试
            if (!response.ok) {
                const errorText = await response.text();
                console.error('[DailyNoteWrite] AI API error:', response.status, errorText);
                return null;
            }
            
            // 成功响应，解析结果
            const result = await response.json();
            
            if (result.choices && result.choices.length > 0) {
                const aiResponse = result.choices[0].message.content;
                debugLog('AI response:', aiResponse);
                
                // 提取Tag行
                const tagLine = extractTagFromAIResponse(aiResponse);
                if (tagLine) {
                    debugLog(`Successfully generated tag on attempt ${attempt}`);
                }
                return tagLine;
            } else {
                console.error('[DailyNoteWrite] Unexpected AI response format:', result);
                return null;
            }
            
        } catch (error) {
            console.error(`[DailyNoteWrite] Error on attempt ${attempt}/${maxRetries}:`, error.message);
            
            if (attempt < maxRetries) {
                // 网络错误也进行重试
                const backoffTime = Math.pow(2, attempt - 1) * 1000;
                debugLog(`Retrying after ${backoffTime}ms due to error...`);
                await delay(backoffTime);
                continue;
            } else {
                console.error('[DailyNoteWrite] Max retries reached after errors. Giving up tag generation.');
                return null;
            }
        }
    }
    
    // 理论上不会到达这里，但为了安全返回null
    return null;
}

/**
 * 处理日记内容的Tag
 * @param {string} contentText - 原始日记内容
 * @returns {Promise<string>} - 处理后的日记内容（包含规范化的Tag）
 */
async function processTagsInContent(contentText) {
    debugLog('Processing tags in content...');
    
    // 检测是否有Tag行
    const detection = detectTagLine(contentText);
    
    if (detection.hasTag) {
        // 有Tag，修复格式
        debugLog('Tag detected, fixing format...');
        const fixedTag = fixTagFormat(detection.lastLine);
        const finalContent = detection.contentWithoutLastLine + '\n' + fixedTag;
        return finalContent;
    } else {
        // 没有Tag，调用AI生成
        debugLog('No tag detected, generating with AI...');
        const generatedTag = await generateTagsWithAI(contentText);
        
        if (generatedTag) {
            // AI生成了Tag，修复格式并附加
            const fixedTag = fixTagFormat(generatedTag);
            const finalContent = contentText + '\n' + fixedTag;
            debugLog('Generated and appended tag:', fixedTag);
            return finalContent;
        } else {
            // AI生成失败，返回原内容
            console.warn('[DailyNoteWrite] Failed to generate tags, saving without tags');
            return contentText;
        }
    }
}


// --- Core Diary Writing Logic ---
async function writeDiary(maidName, dateString, contentText, fileName) {
    debugLog(`Processing diary write for Maid: ${maidName}, Date: ${dateString}, fileName: ${fileName}`);
    if (!maidName || !dateString || !contentText) {
        throw new Error('Invalid input: Missing Maid, Date, or Content.');
    }

    // **步骤1: 处理Tag - 验证格式或生成Tag**
    const processedContent = await processTagsInContent(contentText);
    debugLog('Content after tag processing (length):', processedContent.length);

    // Trim maidName to prevent folder/file name issues with whitespace, especially on Windows.
    const trimmedMaidName = maidName.trim();

    let folderName = trimmedMaidName;
    let actualMaidName = trimmedMaidName;
    // Use regex to find [tag]name format
    const tagMatch = trimmedMaidName.match(/^\[(.*?)\](.*)$/);

    if (tagMatch) {
        folderName = tagMatch[1].trim(); // Use the captured tag as folder name
        actualMaidName = tagMatch[2].trim(); // Use the captured name as actual maid name
        debugLog(`Tagged note detected. Tag: ${folderName}, Actual Maid: ${actualMaidName}`);
    } else {
        // In the non-tag case, folderName and actualMaidName are already the trimmedMaidName
        debugLog(`No tag detected. Folder: ${folderName}, Actual Maid: ${actualMaidName}`);
    }

    // Sanitize the final folderName to remove invalid characters and trailing spaces/dots.
    const sanitizedFolderName = sanitizePathComponent(folderName);
    if (folderName !== sanitizedFolderName) {
        debugLog(`Sanitized folder name from "${folderName}" to "${sanitizedFolderName}"`);
    }

    const datePart = dateString.replace(/[.\\\/\s-]/g, '-').replace(/-+/g, '-');
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const timeStringForFile = `${hours}_${minutes}_${seconds}`;

    const dirPath = path.join(dailyNoteRootPath, sanitizedFolderName);

    // 可选字段：将 fileName 作为后缀拼接到时间戳文件名后
    let sanitizedOptionalFileName = '';
    if (typeof fileName === 'string' && fileName.trim()) {
        sanitizedOptionalFileName = sanitizePathComponent(fileName.trim());
    }

    const fileNameSuffix = sanitizedOptionalFileName ? `-${sanitizedOptionalFileName}` : '';
    const baseFileNameWithoutExt = `${datePart}-${timeStringForFile}${fileNameSuffix}`;
    const fileExtension = `.${CONFIGURED_EXTENSION}`;
    const finalFileName = `${baseFileNameWithoutExt}${fileExtension}`;
    const filePath = path.join(dirPath, finalFileName);

    debugLog(`Target file path: ${filePath}`);

    // **步骤2: 写入文件 - 使用处理后的内容（包含规范化的Tag）**
    await fs.mkdir(dirPath, { recursive: true });
    const fileContent = `[${datePart}] - ${actualMaidName}\n${processedContent}`;
    await fs.writeFile(filePath, fileContent);
    debugLog(`Successfully wrote file (length: ${fileContent.length})`);
    return filePath; // Return the path on success
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
        try {
            if (!inputData) {
                throw new Error("No input data received via stdin.");
            }
            const diaryData = JSON.parse(inputData);
            const { maidName, dateString, contentText } = diaryData;
            const fileName = diaryData.fileName || diaryData.FileName;

            const savedFilePath = await writeDiary(maidName, dateString, contentText, fileName);
            sendOutput({ status: "success", message: `Diary saved to ${savedFilePath}` });

        } catch (error) {
            console.error("[DailyNoteWrite] Error processing request:", error.message);
            sendOutput({ status: "error", message: error.message || "An unknown error occurred." });
            process.exitCode = 1; // Indicate failure
        }
    });

     process.stdin.on('error', (err) => {
         console.error("[DailyNoteWrite] Stdin error:", err);
         sendOutput({ status: "error", message: "Error reading input." });
         process.exitCode = 1; // Indicate failure
     });
}

main();