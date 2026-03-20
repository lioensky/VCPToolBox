
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { parseEnvCascade } = require('../../envLoader');

// 加载配置
const configPath = path.join(__dirname, 'config.env');
let config = {};
try {
    config = parseEnvCascade(configPath).env;
    log('成功加载 config.env 文件。');
} catch (error) {
    if (error.code === 'ENOENT') {
        log('警告: 未找到 config.env 文件。将尝试使用全局环境变量。');
    } else {
        console.error('加载 config.env 时出错:', error.message);
        process.exit(1); // 对于其他错误，如权限问题，则退出
    }
}

// 从命令行参数获取路径和ID
const [,, directoryPath, analysisId, analysisMode = 'quick'] = process.argv; // 'quick' or 'full'
const DB_DIR = path.join(__dirname, 'database');
const FILE_CACHE_DIR = path.join(__dirname, 'file_cache');
const REPORT_FILE = path.join(DB_DIR, `${analysisId}.md`);

// 需要跳过的目录
const SKIP_DIRS = ['node_modules', '.git', '.env', 'env', '__pycache__', 'dist', 'build', '.next', '.nuxt'];
// 只列出不分析的目录
const LIST_ONLY_DIRS = ['vendor'];
// 只列出不分析的文件扩展名
const LIST_ONLY_EXTENSIONS = ['.json'];
// 需要分析的文件扩展名
const ANALYZE_EXTENSIONS = ['.rs', '.js', '.ts', '.py'];
// 特殊依赖文件（直接返回内容）
const SPECIAL_FILES = ['package.json', 'Cargo.toml', 'requirements.txt'];

// --- 日志函数 ---
function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

// --- 递归获取文件树 ---
async function getFileTree(dir, prefix = '', isRoot = true) {
    let tree = '';
    let filesToAnalyze = [];
    
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const isLast = i === entries.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const childPrefix = prefix + (isLast ? '    ' : '│   ');
            
            if (entry.isDirectory()) {
                // 检查是否需要完全跳过
                if (SKIP_DIRS.includes(entry.name)) {
                    tree += `${prefix}${connector}${entry.name}/ [跳过]\n`;
                    continue;
                }
                
                // 检查是否只列出不分析
                if (LIST_ONLY_DIRS.includes(entry.name)) {
                    tree += `${prefix}${connector}${entry.name}/ [仅列出]\n`;
                    continue;
                }
                
                tree += `${prefix}${connector}${entry.name}/\n`;
                const subPath = path.join(dir, entry.name);
                const subResult = await getFileTree(subPath, childPrefix, false);
                tree += subResult.tree;
                filesToAnalyze.push(...subResult.files);
                
            } else {
                const ext = path.extname(entry.name);
                const fullPath = path.join(dir, entry.name);
                
                // .example 文件只列出
                if (entry.name.endsWith('.example')) {
                    tree += `${prefix}${connector}${entry.name} [示例文件]\n`;
                    continue;
                }
                
                // 特殊依赖文件
                if (SPECIAL_FILES.includes(entry.name)) {
                    tree += `${prefix}${connector}${entry.name} [依赖配置]\n`;
                    filesToAnalyze.push({ path: fullPath, type: 'special' });
                    continue;
                }
                
                // .json 文件只列出
                if (LIST_ONLY_EXTENSIONS.includes(ext)) {
                    tree += `${prefix}${connector}${entry.name} [配置文件]\n`;
                    continue;
                }
                
                // 需要分析的文件
                if (ANALYZE_EXTENSIONS.includes(ext)) {
                    tree += `${prefix}${connector}${entry.name}\n`;
                    filesToAnalyze.push({ path: fullPath, type: 'code' });
                    continue;
                }
                
                // 其他文件
                tree += `${prefix}${connector}${entry.name}\n`;
            }
        }
    } catch (error) {
        tree += `${prefix}[错误: ${error.message}]\n`;
    }
    
    return { tree, files: filesToAnalyze };
}

// --- 调用AI模型 ---
async function callAI(systemPrompt, userPrompt, retries = 3) {
    const modelUrl = config.ProjectAnalystModelUrl || process.env.ProjectAnalystModelUrl;
    const modelKey = config.ProjectAnalystModelKey || process.env.ProjectAnalystModelKey;
    const modelName = config.ProjectAnalystModel || 'gemini-2.5-flash-lite-preview-09-2025-thinking';
    const maxTokens = parseInt(config.ProjectAnalystMaxToken || '80000');
    const maxOutputTokens = parseInt(config.ProjectAnalystMaxOutputToken || '50000');
    
    if (!modelUrl || !modelKey) {
        throw new Error('AI模型配置不完整，请检查 config.env 中的 ProjectAnalystModelUrl 和 ProjectAnalystModelKey');
    }
    
    const requestBody = {
        model: modelName,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        max_tokens: maxOutputTokens
    };
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(modelUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${modelKey}`
                },
                body: JSON.stringify(requestBody)
            });
            
            // 429 错误需要特殊处理：暂停更长时间
            if (response.status === 429) {
                const waitTime = 120000; // 2分钟
                log(`遇到 429 错误（请求过多），暂停 ${waitTime/1000} 秒后重试...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue; // 不计入重试次数，直接重试
            }
            
            if (response.status === 500 || response.status === 503) {
                log(`AI调用失败 (${response.status})，第 ${attempt}/${retries} 次重试...`);
                if (attempt < retries) {
                    await new Promise(resolve => setTimeout(resolve, 3000 * attempt)); // 递增等待时间
                    continue;
                }
            }
            
            if (!response.ok) {
                throw new Error(`AI API返回错误: ${response.status} ${response.statusText}`);
            }
            
            const data = await response.json();
            return data.choices[0].message.content;
            
        } catch (error) {
            log(`AI调用异常 (第 ${attempt}/${retries} 次): ${error.message}`);
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
            } else {
                throw error;
            }
        }
    }
}

// --- 获取项目总结 ---
async function getProjectSummary(fileTree, readmeContent) {
    const systemPrompt = `你是一位高级软件架构师。你的任务是深入分析项目结构和文档，精准地识别出项目的核心功能和关键实现。你的回答应该简洁、专业，并直指要点。`;
    
    const userPrompt = `请根据以下提供的项目文件结构树和README内容，完成以下任务：

1.  **核心功能总结**: 用一句话总结该项目的主要目标或核心功能。
2.  **关键实现定位**: 识别并列出 2-3 个实现上述核心功能的最关键的文件或类。
3.  **简要原因**: 对每个列出的文件/类，用一句话解释它为什么是核心。

**项目文件结构树:**
\`\`\`
${fileTree}
\`\`\`

**README内容:**
\`\`\`
${readmeContent}
\`\`\`

请按照以下格式输出，不要添加任何额外的解释或客套话：

**核心功能:** [此处填写项目核心功能总结]

**关键实现:**
*   \`[文件/类名1]\`: [选择该文件/类的原因]
*   \`[文件/类名2]\`: [选择该文件/类的原因]
*   \`[文件/类名3]\`: [选择该文件/类的原因]
`;
    
    try {
        return await callAI(systemPrompt, userPrompt);
    } catch (error) {
        log(`获取项目总结失败: ${error.message}`);
        return `[无法生成项目总结: ${error.message}]`;
    }
}

// --- 查找README文件（兼容大小写）---
async function findReadmeFile(dir) {
    try {
        const entries = await fs.readdir(dir);
        const readmeVariants = ['README.md', 'readme.md', 'Readme.md', 'README.MD', 'readme.MD'];
        for (const variant of readmeVariants) {
            if (entries.includes(variant)) {
                return path.join(dir, variant);
            }
        }
        return null;
    } catch (error) {
        log(`查找 README 文件时出错: ${error.message}`);
        return null;
    }
}

// --- 缓存管理 ---
function getFileHash(filePath) {
    return crypto.createHash('md5').update(filePath).digest('hex');
}

async function getFileMetadata(filePath) {
    try {
        const stats = await fs.stat(filePath);
        return { size: stats.size, mtime: stats.mtimeMs };
    } catch (error) {
        return null;
    }
}

async function checkFileCache(filePath) {
    const fileHash = getFileHash(filePath);
    const cachePath = path.join(FILE_CACHE_DIR, `${fileHash}.json`);
    
    try {
        const cacheData = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
        const currentMeta = await getFileMetadata(filePath);
        
        if (!currentMeta) return null;
        
        if (cacheData.metadata.size === currentMeta.size && cacheData.metadata.mtime === currentMeta.mtime) {
            log(`缓存命中: ${filePath}`);
            return cacheData.analysis;
        }
        
        return null;
    } catch (error) {
        return null; // 缓存不存在或读取失败
    }
}

async function saveFileCache(filePath, analysis) {
    const fileHash = getFileHash(filePath);
    const cachePath = path.join(FILE_CACHE_DIR, `${fileHash}.json`);
    const metadata = await getFileMetadata(filePath);
    
    if (!metadata) return;
    
    const cacheData = {
        filePath,
        metadata,
        analysis,
        cachedAt: new Date().toISOString()
    };
    
    try {
        await fs.writeFile(cachePath, JSON.stringify(cacheData, null, 2));
    } catch (error) {
        log(`保存缓存失败 ${filePath}: ${error.message}`);
    }
}


// --- 分析单个文件 ---
async function analyzeFile(fileInfo, fullTree) {
    const { path: filePath, type } = fileInfo;

    // 1. 检查缓存
    const cachedAnalysis = await checkFileCache(filePath);
    if (cachedAnalysis) {
        return `**[来自缓存]**\n\n${cachedAnalysis}`;
    }
    
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        
        // 2. 处理特殊文件
        if (type === 'special') {
            const analysis = `**依赖配置文件内容：**\n\`\`\`\n${content}\n\`\`\``;
            await saveFileCache(filePath, analysis);
            return analysis;
        }
        
        // 3. 调用 AI 分析
        const promptPath = path.join(__dirname, config.ProjectAnalystModelPrompt || 'ProjectAnalystModelPrompt.txt');
        let systemPrompt;
        try {
            systemPrompt = await fs.readFile(promptPath, 'utf-8');
        } catch (error) {
            systemPrompt = '你是一个专业的代码分析助手。请分析给定的代码文件，总结其主要功能、关键逻辑和重要依赖。';
        }
        
        const userPrompt = `项目整体文件结构：
\`\`\`
${fullTree}
\`\`\`

当前需要分析的文件路径：${filePath}

文件内容：
\`\`\`
${content}
\`\`\`

请分析这个文件的功能和作用。`;
        
        const analysis = await callAI(systemPrompt, userPrompt);
        
        // 4. 保存到缓存
        await saveFileCache(filePath, analysis);
        
        return analysis;
        
    } catch (error) {
        log(`分析文件 ${filePath} 失败: ${error.message}`);
        return `[分析失败: ${error.message}]`;
    }
}

// --- 主分析流程 ---
async function analyzeProject() {
    // 1. 设置90分钟自毁计时器
    const selfDestructTimeout = setTimeout(async () => {
        log('分析任务超时（超过90分钟），进程即将自动终止');
        try {
            await fs.appendFile(REPORT_FILE, '\n\n---\n**[错误]** 分析任务超时（超过90分钟），进程已自动终止。\n');
        } catch (e) {
            console.error('Failed to write timeout message:', e);
        }
        process.exit(1);
    }, 5400 * 1000); // 90分钟 = 5400秒

    try {
        log(`开始分析项目: ${directoryPath} (模式: ${analysisMode})`);
        log(`分析ID: ${analysisId}`);
        
        // 2. 确保缓存目录存在
        await fs.mkdir(FILE_CACHE_DIR, { recursive: true });

        // 3. 获取文件树
        log('正在构建文件树...');
        const { tree: fileTree, files: filesToAnalyze } = await getFileTree(directoryPath);
        log(`文件树构建完成，发现 ${filesToAnalyze.length} 个需要分析的文件`);

        // 3. 查找并读取 README.md (兼容大小写)
        const readmePath = await findReadmeFile(directoryPath);
        let readmeContent = '';
        if (readmePath) {
            try {
                readmeContent = await fs.readFile(readmePath, 'utf-8');
                log(`已读取 ${path.basename(readmePath)}`);
            } catch (error) {
                readmeContent = '读取 README 文件失败。';
                log(`读取 README 文件失败: ${error.message}`);
            }
        } else {
            readmeContent = '未找到 README.md 文件。';
            log('未找到 README.md 文件');
        }

        // 4. 获取项目初步总结
        log('正在生成项目总结...');
        const summary = await getProjectSummary(fileTree, readmeContent);
        log('项目总结生成完成');

        // 5. 写入报告抬头
        const header = `# 项目分析报告: ${path.basename(directoryPath)}

**分析ID:** ${analysisId}  
**分析时间:** ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}  
**项目路径:** ${directoryPath}

---

## 📋 项目简介

${summary}

---

## 📁 文件结构树

\`\`\`
${fileTree}
\`\`\`

---

## 📝 文件详细分析

`;
        await fs.writeFile(REPORT_FILE, header);
        log('报告抬头已写入');

        // 6. 如果是快速分析，到此为止
        if (analysisMode === 'quick') {
            const quickFooter = `\n\n---\n\n## ✅ 快速分析完成\n\n快速分析仅提供项目简介和文件结构。如需逐文件深入分析，请使用 \`fullAnalyze\` 参数。`;
            await fs.appendFile(REPORT_FILE, quickFooter);
            log('快速分析完成，即将退出。');
            return; // 提前退出
        }

        // 7. 批量处理文件分析 (仅在 full 模式下)
        const batchSize = parseInt(config.ProjectAnalystBatch || '5');
        log(`开始完整文件分析，批次大小: ${batchSize}`);
        
        for (let i = 0; i < filesToAnalyze.length; i += batchSize) {
            const batch = filesToAnalyze.slice(i, i + batchSize);
            log(`处理批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(filesToAnalyze.length / batchSize)} (${batch.length} 个文件)`);
            
            const analysisPromises = batch.map(file => analyzeFile(file, fileTree));
            const results = await Promise.allSettled(analysisPromises);
            
            for (let j = 0; j < batch.length; j++) {
                const file = batch[j];
                const result = results[j];
                
                let fileAnalysis;
                if (result.status === 'fulfilled') {
                    fileAnalysis = result.value;
                } else {
                    fileAnalysis = `[分析失败: ${result.reason}]`;
                    log(`文件 ${file.path} 分析失败: ${result.reason}`);
                }
                
                const relativePath = path.relative(directoryPath, file.path);
                const analysisSection = `
### 📄 \`${relativePath}\`

${fileAnalysis}

---

`;
                await fs.appendFile(REPORT_FILE, analysisSection);
            }
            
            log(`批次 ${Math.floor(i / batchSize) + 1} 完成`);
        }

        // 8. 写入完成标记
        const footer = `
---

## ✅ 分析完成

**总计分析文件数:** ${filesToAnalyze.length}
**完成时间:** ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}

---
*本报告由 ProjectAnalyst 插件自动生成*
`;
        await fs.appendFile(REPORT_FILE, footer);
        log('所有文件分析完成！');

    } catch (error) {
        log(`致命错误: ${error.message}`);
        const errorMessage = `

---

## ❌ 致命错误

分析过程中发生意外错误：

\`\`\`
${error.message}
${error.stack}
\`\`\`

---
`;
        try {
            await fs.appendFile(REPORT_FILE, errorMessage);
        } catch (writeError) {
            console.error("Failed to write fatal error to report file:", writeError);
        }
    } finally {
        // 清除自毁计时器，正常退出
        clearTimeout(selfDestructTimeout);
        log('委托进程退出');
        process.exit(0);
    }
}

// --- 启动 ---
(async () => {
    if (!directoryPath || !analysisId) {
        console.error('Usage: node AnalysisDelegate.js <directoryPath> <analysisId>');
        process.exit(1);
    }

    await analyzeProject();
})();
