#!/usr/bin/env node

/**
 * VCP日记批量Tag处理工具
 * 
 * 功能：
 * 1. 扫描指定文件夹中的所有日记文件
 * 2. 检查每个文件的Tag格式是否合规
 * 3. 修复格式错误的Tag
 * 4. 为缺失Tag的日记自动生成Tag
 * 
 * 使用方法：
 *   node diary-tag-batch-processor.js [目标文件夹路径]
 * 
 * 配置：
 *   通过根目录的 config.env 文件配置API密钥和模型参数
 */

const fs = require('fs').promises;
const path = require('path');
const { existsSync } = require('fs');

// 加载环境变量（独立应用配置）
require('dotenv').config({ path: path.join(__dirname, 'config.env') });

// --- 配置 ---
const TAG_MODEL = process.env.TagModel || 'gemini-2.5-flash-preview-09-2025-thinking';
const TAG_MODEL_MAX_TOKENS = parseInt(process.env.TagModelMaxTokens || '40000', 10);
const TAG_MODEL_PROMPT_FILE = process.env.TagModelPrompt || 'TagMaster.txt';
const API_KEY = process.env.API_Key;
const API_URL = process.env.API_URL;

// 统计数据
const stats = {
    total: 0,
    processed: 0,
    fixed: 0,
    generated: 0,
    skipped: 0,
    errors: 0
};

// --- 辅助函数 ---

function log(message, ...args) {
    console.log(`[TagProcessor] ${message}`, ...args);
}

function error(message, ...args) {
    console.error(`[TagProcessor][ERROR] ${message}`, ...args);
}

/**
 * 检查最后一行是否为Tag行
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
    
    return {
        hasTag,
        lastLine,
        contentWithoutLastLine
    };
}

/**
 * 修复Tag行格式
 */
function fixTagFormat(tagLine) {
    // 移除首行缩进和两端空格
    let fixed = tagLine.trim();
    
    // 确保以"Tag:"开头
    fixed = fixed.replace(/^tag:\s*/i, 'Tag: ');
    
    if (!fixed.startsWith('Tag: ')) {
        fixed = 'Tag: ' + fixed;
    }
    
    // 提取Tag内容部分
    const tagContent = fixed.substring(5).trim();
    
    // 修复标点符号
    let normalizedContent = tagContent
        .replace(/[\uff1a]/g, '') // 中文冒号
        .replace(/[\uff0c]/g, ', ') // 中文逗号
        .replace(/[\u3001]/g, ', '); // 顿号
    
    // 规范化逗号+空格格式
    normalizedContent = normalizedContent
        .replace(/,\s*/g, ', ')
        .replace(/,\s{2,}/g, ', ')
        .replace(/\s+,/g, ',');
    
    // 去除多余的空格
    normalizedContent = normalizedContent.replace(/\s{2,}/g, ' ').trim();
    
    const result = 'Tag: ' + normalizedContent;
    
    return result;
}

/**
 * 检查Tag格式是否合规
 */
function isTagFormatValid(tagLine) {
    const trimmed = tagLine.trim();
    
    // 检查是否以"Tag: "开头（严格匹配）
    if (!trimmed.startsWith('Tag: ')) {
        return false;
    }
    
    // 检查是否有中文标点
    if (/[\uff0c\uff1a\u3001]/.test(trimmed)) {
        return false;
    }
    
    // 检查逗号格式：应该是", "
    const content = trimmed.substring(5);
    const commas = content.match(/,/g);
    if (commas) {
        // 检查每个逗号后是否有且仅有一个空格
        if (/, /.test(content) === false || /,  /.test(content) || /,\S/.test(content)) {
            return false;
        }
    }
    
    return true;
}

/**
 * 从AI响应中提取Tag行
 */
function extractTagFromAIResponse(aiResponse) {
    const match = aiResponse.match(/\[\[Tag:\s*(.+?)\]\]/i);
    
    if (match && match[1]) {
        const tagContent = match[1].trim();
        return 'Tag: ' + tagContent;
    }
    
    return null;
}

/**
 * 延迟函数
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 调用AI模型生成Tag（带退避重试）
 */
async function generateTagsWithAI(content, maxRetries = 3) {
    if (!API_KEY || !API_URL) {
        error('API configuration missing. Cannot generate tags.');
        return null;
    }
    
    // 读取TagMaster提示词（独立应用根目录）
    const promptFilePath = path.join(__dirname, TAG_MODEL_PROMPT_FILE);
    let systemPrompt;
    try {
        systemPrompt = await fs.readFile(promptFilePath, 'utf-8');
    } catch (err) {
        error('Failed to read TagMaster prompt file:', err.message);
        return null;
    }
    
    const requestData = {
        model: TAG_MODEL,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: content }
        ],
        max_tokens: TAG_MODEL_MAX_TOKENS,
        temperature: 0.7
    };
    
    // 构造完整的API URL（如果API_URL已包含完整路径则直接使用）
    const apiEndpoint = API_URL.includes('/chat/completions')
        ? API_URL
        : `${API_URL}/v1/chat/completions`;
    
    // 带退避重试的API调用
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const fetch = (await import('node-fetch')).default;
            
            log(`API Request (attempt ${attempt}): ${apiEndpoint}`);
            log(`Using model: ${TAG_MODEL}`);
            
            const response = await fetch(apiEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEY}`
                },
                body: JSON.stringify(requestData),
                timeout: 60000
            });
            
            // 429 限流错误 - 需要更长的等待时间
            if (response.status === 429) {
                const retryAfter = response.headers.get('retry-after');
                const waitTime = retryAfter
                    ? parseInt(retryAfter) * 1000
                    : Math.pow(2, attempt) * 5000; // 5秒、10秒、20秒...
                
                error(`API rate limit (429) reached (attempt ${attempt}/${maxRetries})`);
                
                if (attempt < maxRetries) {
                    log(`⏳ Waiting ${Math.round(waitTime/1000)}s before retry...`);
                    await delay(waitTime);
                    continue;
                } else {
                    error('Max retries reached for rate limit. Stopping.');
                    return null;
                }
            }
            
            // 服务器错误 - 需要重试
            if (response.status === 500 || response.status === 503) {
                error(`API server error ${response.status} (attempt ${attempt}/${maxRetries})`);
                
                if (attempt < maxRetries) {
                    const backoffTime = Math.pow(2, attempt - 1) * 1000;
                    log(`Retrying after ${backoffTime}ms...`);
                    await delay(backoffTime);
                    continue;
                }
                return null;
            }
            
            if (!response.ok) {
                let errorText = '';
                try {
                    errorText = await response.text();
                } catch (e) {
                    errorText = 'Unable to read error response';
                }
                
                error(`API error (${response.status}): ${errorText}`);
                
                // 认证错误 - 不重试，直接失败
                if (response.status === 401 || response.status === 403) {
                    error('❌ Authentication failed. Please check your API_Key and API_URL in config.env');
                    return null;
                }
                
                return null;
            }
            
            const result = await response.json();
            
            if (result.choices && result.choices.length > 0) {
                const aiResponse = result.choices[0].message.content;
                const tagLine = extractTagFromAIResponse(aiResponse);
                return tagLine;
            }
            
            return null;
            
        } catch (err) {
            error(`Error on attempt ${attempt}/${maxRetries}:`, err.message);
            
            if (attempt < maxRetries) {
                const backoffTime = Math.pow(2, attempt - 1) * 1000;
                await delay(backoffTime);
                continue;
            }
            return null;
        }
    }
    
    return null;
}

/**
 * 处理单个文件的Tag
 */
async function processFile(filePath) {
    let apiCalled = false;
    try {
        log(`Processing: ${filePath}`);
        
        const content = await fs.readFile(filePath, 'utf-8');
        const detection = detectTagLine(content);
        
        let modified = false;
        let finalContent = content;
        
        if (detection.hasTag) {
            if (isTagFormatValid(detection.lastLine)) {
                log(`  ✓ Tag format is valid`);
                stats.skipped++;
            } else {
                log(`  ⚠ Tag format needs fixing`);
                const fixedTag = fixTagFormat(detection.lastLine);
                finalContent = detection.contentWithoutLastLine + '\n' + fixedTag;
                modified = true;
                stats.fixed++;
                log(`  ✓ Fixed tag: ${fixedTag}`);
            }
        } else {
            log(`  ⚠ No tag found, generating...`);
            apiCalled = true;
            const generatedTag = await generateTagsWithAI(content);
            
            if (generatedTag) {
                const fixedTag = fixTagFormat(generatedTag);
                finalContent = content + '\n' + fixedTag;
                modified = true;
                stats.generated++;
                log(`  ✓ Generated tag: ${fixedTag}`);
            } else {
                error(`  ✗ Failed to generate tag`);
                stats.errors++;
                return { success: false, apiCalled };
            }
        }
        
        if (modified) {
            await fs.writeFile(filePath, finalContent, 'utf-8');
            log(`  ✓ File updated`);
            stats.processed++;
        }
        
        return { success: true, apiCalled };
        
    } catch (err) {
        error(`Error processing ${filePath}:`, err.message);
        stats.errors++;
        return { success: false, apiCalled: false };
    }
}

/**
 * 递归扫描目录
 */
async function scanDirectory(dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files = [];
    
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
            // 递归扫描子目录
            const subFiles = await scanDirectory(fullPath);
            files.push(...subFiles);
        } else if (entry.isFile()) {
            // 只处理 .txt 和 .md 文件
            const ext = path.extname(entry.name).toLowerCase();
            if (ext === '.txt' || ext === '.md') {
                files.push(fullPath);
            }
        }
    }
    
    return files;
}

/**
 * 主函数
 */
async function main() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║        VCP日记批量Tag处理工具 v1.0                         ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    // 获取目标文件夹路径
    const targetPath = process.argv[2];
    
    if (!targetPath) {
        console.log('使用方法：');
        console.log('  node diary-tag-batch-processor.js [目标文件夹路径]\n');
        console.log('示例：');
        console.log('  node diary-tag-batch-processor.js ./dailynote');
        console.log('  node diary-tag-batch-processor.js "C:\\Users\\Admin\\Documents\\旧日记"\n');
        process.exit(1);
    }
    
    // 检查路径是否存在
    if (!existsSync(targetPath)) {
        error(`路径不存在: ${targetPath}`);
        process.exit(1);
    }
    
    // 检查API配置
    if (!API_KEY || !API_URL) {
        error('API configuration missing in config.env!');
        error('请在根目录的 config.env 中配置 API_Key 和 API_URL');
        process.exit(1);
    }
    
    log(`Target directory: ${targetPath}`);
    log(`API URL: ${API_URL}`);
    log(`Model: ${TAG_MODEL}\n`);
    
    // 扫描所有文件
    log('Scanning files...');
    const files = await scanDirectory(targetPath);
    stats.total = files.length;
    
    if (files.length === 0) {
        log('No diary files (.txt or .md) found in the directory.');
        process.exit(0);
    }
    
    log(`Found ${files.length} files to process\n`);
    log('Starting processing...\n');
    
    // 处理每个文件
    for (let i = 0; i < files.length; i++) {
        log(`[${i + 1}/${files.length}]`);
        
        const result = await processFile(files[i]);
        console.log(); // 空行分隔
        
        // 仅在调用了AI时才应用延迟
        if (result.apiCalled) {
            // 如果处理失败，可能是限流，增加退避延迟
            if (!result.success) {
                const waitTime = Math.min(stats.errors * 2000, 10000); // 最多等10秒
                log(`⏳ Detected potential rate limiting, waiting ${waitTime/1000}s before next file...`);
                await delay(waitTime);
            } else if (i < files.length - 1) {
                // 正常情况下的基础延迟，避免API限流
                await delay(1000);
            }
        }
    }
    
    // 输出统计信息
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                      处理完成统计                           ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  总文件数:     ${stats.total.toString().padStart(4)} 个                                 ║`);
    console.log(`║  处理成功:     ${stats.processed.toString().padStart(4)} 个 (修改了文件)                  ║`);
    console.log(`║  格式修复:     ${stats.fixed.toString().padStart(4)} 个                                 ║`);
    console.log(`║  AI生成Tag:    ${stats.generated.toString().padStart(4)} 个                                 ║`);
    console.log(`║  跳过(已合规): ${stats.skipped.toString().padStart(4)} 个                                 ║`);
    console.log(`║  错误:         ${stats.errors.toString().padStart(4)} 个                                 ║`);
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    if (stats.errors > 0) {
        log('部分文件处理失败，请检查上方错误信息');
        process.exit(1);
    } else {
        log('所有文件处理完成！');
        process.exit(0);
    }
}

// 运行主函数
main().catch(err => {
    error('Fatal error:', err);
    process.exit(1);
});