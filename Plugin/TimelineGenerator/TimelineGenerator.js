const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const axios = require('axios');
const crypto = require('crypto');
const lockFile = require('proper-lockfile');

// --- 全局变量 ---
let pluginConfig = {};
let projectBasePath = '';
let dailyNoteDir = '';
let timelineDir = ''; // 存放最终的 timeline JSON 文件
let dbPath = '';      // 存放处理记录数据库
let watcher = null;
const summaryQueue = [];
let isProcessingQueue = false;

// --- 辅助函数 ---

/**
 * 将路径中的反斜杠(\)替换为正斜杠(/)
 * @param {string} filePath - 文件路径
 * @returns {string} 规范化后的路径
 */
function normalizePath(filePath) {
    return filePath.replace(/\\/g, '/');
}

/**
 * 为给定内容生成 SHA256 哈希值
 * @param {string} content - 要哈希的内容
 * @returns {string} 64个字符的十六进制哈希字符串
 */
function generateContentHash(content) {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 安全地读取和解析JSON文件
 * @param {string} filePath - JSON文件路径
 * @param {any} defaultValue - 如果文件不存在或解析失败，返回的默认值
 * @returns {Promise<any>} 解析后的JSON对象或默认值
 */
async function readJsonFile(filePath, defaultValue = {}) {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return defaultValue;
        }
        console.error(`[TimelineGenerator] Error reading or parsing JSON file ${path.basename(filePath)}:`, error);
        return defaultValue; // 返回默认值以保证程序健壮性
    }
}

// --- 插件生命周期 ---

async function initialize(config) {
    pluginConfig = config;
    if (!config.PROJECT_BASE_PATH) {
        throw new Error('[TimelineGenerator] PROJECT_BASE_PATH is not configured!');
    }

    projectBasePath = config.PROJECT_BASE_PATH;
    dailyNoteDir = path.join(projectBasePath, 'dailynote');
    timelineDir = path.join(projectBasePath, 'timeline');
    dbPath = path.join(timelineDir, 'processed_files_db.json');

    console.log('[TimelineGenerator] Initializing with new Hash-based architecture...');

    await fs.mkdir(timelineDir, { recursive: true });
    console.log(`[TimelineGenerator] Ensured timeline directory exists at: ${timelineDir}`);

    setupWatcher();
}

async function shutdown() {
    console.log('[TimelineGenerator] Shutting down...');
    if (watcher) {
        await watcher.close();
        console.log('[TimelineGenerator] Chokidar watcher stopped.');
    }
    summaryQueue.length = 0;
}

// --- 文件监控与队列 ---

function setupWatcher() {
    console.log(`[TimelineGenerator] Setting up watcher for: ${dailyNoteDir}`);
    const ignoredPaths = [/.*已整理.*/, /.*簇$/, /.*MusicDiary.*/];

    watcher = chokidar.watch(dailyNoteDir, {
        ignored: ignoredPaths,
        persistent: true,
        ignoreInitial: false, // 我们需要处理初始扫描
        awaitWriteFinish: {
            stabilityThreshold: 2000,
            pollInterval: 100
        },
        depth: 99
    });

    const initialScanFiles = new Set();
    let isReady = false;

    watcher
        .on('add', filePath => {
            const fileExtension = path.extname(filePath).toLowerCase();
            if (!['.txt', '.md'].includes(fileExtension)) return;

            if (isReady) {
                console.log(`[TimelineGenerator] New file detected: ${path.basename(filePath)}`);
                addToQueue(filePath);
            } else {
                initialScanFiles.add(filePath);
            }
        })
        .on('change', filePath => {
            const fileExtension = path.extname(filePath).toLowerCase();
            if (['.txt', '.md'].includes(fileExtension)) {
                console.log(`[TimelineGenerator] File change detected: ${path.basename(filePath)}`);
                addToQueue(filePath);
            }
        })
        .on('ready', async () => {
            isReady = true;
            console.log(`[TimelineGenerator] Initial scan complete. Found ${initialScanFiles.size} files.`);
            const db = await readJsonFile(dbPath, {});
            let filesToProcessCount = 0;

            for (const filePath of initialScanFiles) {
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    const contentHash = generateContentHash(content);
                    const normalizedPath = normalizePath(path.relative(projectBasePath, filePath));
                    
                    const record = db[normalizedPath];

                    // 检查：如果记录存在，哈希值相同，且状态为'summarized'，则跳过
                    if (record && record.hash === contentHash && record.status === 'summarized') {
                        if (pluginConfig.DebugMode) {
                            console.log(`[TimelineGenerator] Skipping unchanged and summarized file: ${path.basename(filePath)}`);
                        }
                        continue;
                    }
                    
                    // 其他情况（新文件、内容已更改、之前处理失败）都需要处理
                    filesToProcessCount++;
                    addToQueue(filePath);

                } catch (error) {
                    console.error(`[TimelineGenerator] Error during initial scan for file ${filePath}:`, error);
                }
            }
            console.log(`[TimelineGenerator] After filtering, ${filesToProcessCount} files need processing.`);
            console.log('[TimelineGenerator] Now monitoring for new changes...');
        })
        .on('error', error => console.error(`[TimelineGenerator] Watcher error: ${error}`));
}

function addToQueue(filePath) {
    if (!summaryQueue.find(item => item === filePath)) {
        summaryQueue.push(filePath);
        if (pluginConfig.DebugMode) {
            console.log(`[TimelineGenerator] Added to queue: ${path.basename(filePath)}. Queue size: ${summaryQueue.length}`);
        }
        processSummaryQueue();
    }
}

async function processSummaryQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (summaryQueue.length > 0) {
        const batchSize = pluginConfig.MAX_SUMMARY_QUEUE || 5; // 控制并发数
        const batch = summaryQueue.splice(0, batchSize);
        
        if (pluginConfig.DebugMode) {
            console.log(`[TimelineGenerator] Processing batch of ${batch.length} files.`);
        }

        await Promise.all(batch.map(filePath =>
            processFile(filePath).catch(e => {
                console.error(`[TimelineGenerator] Error processing ${path.basename(filePath)}:`, e);
            })
        ));
    }

    isProcessingQueue = false;
    if (pluginConfig.DebugMode) {
        console.log('[TimelineGenerator] Queue empty.');
    }
}

// --- 核心处理逻辑 ---

async function processFile(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    if (content.length < (pluginConfig.MIN_CONTENT_LENGTH || 100)) {
        if (pluginConfig.DebugMode) console.log(`[TimelineGenerator] Skipping short file: ${path.basename(filePath)}`);
        return;
    }

    const firstLine = content.split('\n')[0].trim();
    const match = firstLine.match(/^(?:\[(\d{4}[\.\-]\d{1,2}[\.\-]\d{1,2})\]\s*-\s*(.+)|(\d{4}[\.\-]\d{1,2}[\.\-]\d{1,2})-(.+))$/);
    if (!match) {
        if (pluginConfig.DebugMode) console.log(`[TimelineGenerator] Skipping file with invalid first line format: ${path.basename(filePath)}`);
        return;
    }

    const dateStr = (match[1] || match[3]).replace(/\./g, '-');
    const characterName = (match[2] || match[4]).trim();
    const originalContent = content.substring(content.indexOf('\n') + 1).trim();
    const contentHash = generateContentHash(content);
    const normalizedPath = normalizePath(path.relative(projectBasePath, filePath));

    // 再次使用数据库进行最终检查，防止队列中存在重复项
    const db = await readJsonFile(dbPath, {});
    const record = db[normalizedPath];
    if (record && record.hash === contentHash && record.status === 'summarized') {
        if (pluginConfig.DebugMode) console.log(`[TimelineGenerator] Final check: Skipping already processed file ${path.basename(filePath)}`);
        return;
    }

    console.log(`[TimelineGenerator] Processing for [${characterName}] on [${dateStr}] from file ${path.basename(filePath)}`);

    let summary = await getSummaryFromAPI(content);
    let summaryStatus = 'summarized';

    if (!summary) {
        summaryStatus = 'fallback';
        summary = originalContent; // 使用原文作为备用
        console.warn(`[TimelineGenerator] API summary failed for ${path.basename(filePath)}. Using fallback.`);
    }

    try {
        await updateTimelineJson(characterName, dateStr, summary, contentHash);
        await updateProcessDb(normalizedPath, contentHash, summaryStatus);
        console.log(`[TimelineGenerator] Successfully processed entry for [${characterName}] with status [${summaryStatus}].`);
    } catch (error) {
        console.error(`[TimelineGenerator] Failed to update data for ${path.basename(filePath)}:`, error);
        // 失败时不更新数据库，以便下次启动时能够根据哈希不匹配自动重试
    }
}

// --- API 调用 ---

async function getSummaryFromAPI(diaryContent) {
    const { API_URL, API_Key, MAX_RETRY_ATTEMPTS, SUMMARY_MODEL, SUMMARY_SYSTEM_PROMPT, SUMMARY_MAX_TOKENS } = pluginConfig;
    if (!API_URL || !API_Key) {
        console.error('[TimelineGenerator] API_URL or API_Key is not configured!');
        return null;
    }

    const retries = MAX_RETRY_ATTEMPTS || 3;
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_Key}` };
    const body = {
        model: SUMMARY_MODEL || 'gemini-1.5-flash-latest',
        messages: [{ role: 'system', content: SUMMARY_SYSTEM_PROMPT }, { role: 'user', content: diaryContent }],
        max_tokens: SUMMARY_MAX_TOKENS || 4096,
        stream: false
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.post(`${API_URL}/v1/chat/completions`, body, { headers, timeout: 60000 });
            const text = response.data.choices[0].message.content;
            const summaryMatch = text.match(/<<<summary>>>(.*?)<<<\s*\/?\s*summary\s*>>>/si);
            if (summaryMatch && summaryMatch[1]) {
                return summaryMatch[1].trim();
            }
            console.warn('[TimelineGenerator] API response did not contain a valid summary tag.', text);
            return null; // 如果格式不符，直接返回null
        } catch (error) {
            console.error(`[TimelineGenerator] API call failed (attempt ${attempt}/${retries}):`, error.response ? error.response.data : error.message);
            if (attempt === retries) return null;
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
    return null;
}

// --- 数据持久化 ---

/**
 * 更新处理记录数据库 (processed_files_db.json)
 * @param {string} normalizedPath - 规范化的相对文件路径
 * @param {string} hash - 文件内容的哈希值
 * @param {string} status - 处理状态 ('summarized', 'fallback', 'error')
 */
async function updateProcessDb(normalizedPath, hash, status) {
    const db = await readJsonFile(dbPath, {});
    const now = new Date().toISOString();
    const existingRecord = db[normalizedPath];

    db[normalizedPath] = {
        ...existingRecord,
        hash: hash,
        status: status,
        lastUpdated: now,
        firstProcessed: existingRecord ? existingRecord.firstProcessed : now
    };

    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), 'utf-8');
}

/**
 * 更新角色的时间线JSON文件
 * @param {string} characterName - 角色名
 * @param {string} dateStr - 日期字符串 (YYYY-MM-DD)
 * @param {string} summary - 总结内容
 * @param {string} sourceHash - 源文件内容的哈希
 */
async function updateTimelineJson(characterName, dateStr, summary, sourceHash) {
    const timelineFilePath = path.join(timelineDir, `${characterName}_timeline.json`);

    // 在加锁前，确保文件存在，防止因文件不存在而导致锁失败
    try {
        await fs.access(timelineFilePath);
    } catch {
        // 文件不存在，创建一个空的骨架
        await fs.writeFile(timelineFilePath, JSON.stringify({
            character: characterName,
            lastUpdated: '',
            version: '1.0.0',
            entries: {}
        }, null, 2), 'utf-8');
    }

    const release = await lockFile.lock(timelineFilePath, { retries: 5 }).catch(err => {
        console.error(`[TimelineGenerator] Failed to acquire lock for ${timelineFilePath}`);
        throw err;
    });

    try {
        const timelineData = await readJsonFile(timelineFilePath, {
            character: characterName,
            lastUpdated: '',
            version: '1.0.0',
            entries: {}
        });

        if (!timelineData.entries[dateStr]) {
            timelineData.entries[dateStr] = [];
        }

        // 检查此哈希是否已存在于当天的条目中
        const entryExists = timelineData.entries[dateStr].some(entry => entry.sourceHash === sourceHash);

        if (!entryExists) {
            timelineData.entries[dateStr].push({
                summary: summary,
                sourceHash: sourceHash,
                addedOn: new Date().toISOString()
            });
        } else if (pluginConfig.DebugMode) {
            console.log(`[TimelineGenerator] Entry with hash ${sourceHash} already exists for ${characterName} on ${dateStr}. Skipping add.`);
        }

        timelineData.lastUpdated = new Date().toISOString();

        await fs.writeFile(timelineFilePath, JSON.stringify(timelineData, null, 2), 'utf-8');
    } finally {
        await release();
    }
}

module.exports = {
    initialize,
    shutdown
};