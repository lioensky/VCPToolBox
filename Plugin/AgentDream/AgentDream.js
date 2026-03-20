// AgentDream.js (Service Module)
// 梦系统插件 - 让AI Agent回顾记忆、联想式沉浸梦境、整理记忆
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { parseEnvCascade } = require('../../envLoader');

// --- State and Config Variables ---
let VCP_SERVER_PORT;
let VCP_SERVER_ACCESS_KEY;
let VCP_API_TARGET_URL;
let DEBUG_MODE = false;

// 梦系统配置
let DREAM_CONFIG = {
    frequencyHours: 8,
    timeWindowStart: 1,
    timeWindowEnd: 6,
    probability: 0.6,
    associationMaxRangeDays: 180,
    seedCountMin: 1,
    seedCountMax: 5,
    recallK: 12,
    personalPublicRatio: 3,
    tagBoost: 0.15,
    contextTTLHours: 4,
    agentList: []
};

const DREAM_AGENTS = {};
let knowledgeBaseManager = null;
let pushVcpInfo = () => { };
let dailyNoteRootPath = '';
const dreamContexts = new Map(); // agentName -> { timestamp, history }

// --- 自动做梦调度状态 ---
let dreamSchedulerTimer = null;
const SCHEDULER_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 每15分钟检查一次
const lastDreamTimestamps = new Map(); // agentName -> timestamp(ms)
const DREAM_STATE_FILE = 'dream_schedule_state.json';
let isDreamingInProgress = false; // 防止并发做梦

// --- Core Module Functions ---

/**
 * 初始化梦系统服务
 * @param {object} config - PluginManager 传递的全局配置
 * @param {object} dependencies - 依赖注入 (vcpLogFunctions 等)
 */
function initialize(config, dependencies) {
    VCP_SERVER_PORT = config.PORT;
    VCP_SERVER_ACCESS_KEY = config.Key;
    DEBUG_MODE = String(config.DebugMode || 'false').toLowerCase() === 'true';
    VCP_API_TARGET_URL = `http://127.0.0.1:${VCP_SERVER_PORT}/v1`;

    // 加载 KnowledgeBaseManager
    try {
        knowledgeBaseManager = require('../../KnowledgeBaseManager');
        if (DEBUG_MODE) console.error('[AgentDream] KnowledgeBaseManager loaded.');
    } catch (e) {
        console.error('[AgentDream] ❌ Failed to load KnowledgeBaseManager:', e.message);
    }

    // 计算 dailynote 路径
    dailyNoteRootPath = process.env.KNOWLEDGEBASE_ROOT_PATH ||
        (process.env.PROJECT_BASE_PATH ? path.join(process.env.PROJECT_BASE_PATH, 'dailynote') : path.join(__dirname, '..', '..', 'dailynote'));

    // 注入 VCPInfo 广播
    if (dependencies && dependencies.vcpLogFunctions && typeof dependencies.vcpLogFunctions.pushVcpInfo === 'function') {
        pushVcpInfo = dependencies.vcpLogFunctions.pushVcpInfo;
        if (DEBUG_MODE) console.error('[AgentDream] pushVcpInfo dependency injected.');
    } else {
        console.error('[AgentDream] Warning: pushVcpInfo dependency injection failed.');
    }

    // 加载梦配置
    loadDreamConfig();

    // 确保 dream_logs 目录存在
    const dreamLogsDir = path.join(__dirname, 'dream_logs');
    if (!fs.existsSync(dreamLogsDir)) {
        fs.mkdirSync(dreamLogsDir, { recursive: true });
    }

    // 加载上次做梦时间戳（持久化状态）
    _loadDreamState();

    // 启动自动做梦调度器
    _startDreamScheduler();

    console.log('[AgentDream] ✅ Initialized successfully.');
    if (DEBUG_MODE) {
        console.error(`[AgentDream] VCP PORT: ${VCP_SERVER_PORT}, VCP Key: ${VCP_SERVER_ACCESS_KEY ? 'FOUND' : 'NOT FOUND'}`);
        console.error(`[AgentDream] Dream agents: ${Object.keys(DREAM_AGENTS).join(', ') || 'None'}`);
        console.error(`[AgentDream] Recall K: ${DREAM_CONFIG.recallK}, Tag Boost: ${DREAM_CONFIG.tagBoost}`);
    }
}

/**
 * 关闭梦系统
 */
function shutdown() {
    _stopDreamScheduler();
    _saveDreamState();
    dreamContexts.clear();
    console.log('[AgentDream] Shutdown complete.');
}

/**
 * 从 config.env 加载梦系统配置和 Agent 定义
 */
function loadDreamConfig() {
    const configEnvPath = path.join(__dirname, 'config.env');
    let envConfig = {};

    try {
        envConfig = parseEnvCascade(configEnvPath).env;
    } catch (e) {
        console.error(`[AgentDream] Error parsing config.env: ${e.message}`);
        return;
    }

    if (Object.keys(envConfig).length === 0) {
        if (DEBUG_MODE) console.error('[AgentDream] config.env not found, using defaults.');
        console.warn('[AgentDream] ⚠️ config.env 未找到，梦系统处于休眠状态。请复制 config.env.example 为 config.env 以启用。');
        return;
    }

    // 解析梦调度配置
    DREAM_CONFIG.frequencyHours = parseInt(envConfig.DREAM_FREQUENCY_HOURS || '8', 10);
    DREAM_CONFIG.timeWindowStart = parseInt(envConfig.DREAM_TIME_WINDOW_START || '1', 10);
    DREAM_CONFIG.timeWindowEnd = parseInt(envConfig.DREAM_TIME_WINDOW_END || '6', 10);
    DREAM_CONFIG.probability = parseFloat(envConfig.DREAM_PROBABILITY || '0.6');
    DREAM_CONFIG.associationMaxRangeDays = parseInt(envConfig.DREAM_ASSOCIATION_MAX_RANGE_DAYS || '180', 10);
    DREAM_CONFIG.seedCountMin = parseInt(envConfig.DREAM_SEED_COUNT_MIN || '1', 10);
    DREAM_CONFIG.seedCountMax = parseInt(envConfig.DREAM_SEED_COUNT_MAX || '5', 10);
    DREAM_CONFIG.recallK = parseInt(envConfig.DREAM_RECALL_K || '12', 10);
    DREAM_CONFIG.personalPublicRatio = parseInt(envConfig.DREAM_PERSONAL_PUBLIC_RATIO || '3', 10);
    DREAM_CONFIG.tagBoost = parseFloat(envConfig.DREAM_TAG_BOOST || '0.15');
    DREAM_CONFIG.contextTTLHours = parseInt(envConfig.DREAM_CONTEXT_TTL_HOURS || '4', 10);

    // 解析 agent 列表
    DREAM_CONFIG.agentList = (envConfig.DREAM_AGENT_LIST || '')
        .split(',').map(s => s.trim()).filter(Boolean);

    // 解析各 Agent 定义
    Object.keys(DREAM_AGENTS).forEach(key => delete DREAM_AGENTS[key]);
    const agentBaseNames = new Set();

    for (const key in envConfig) {
        if (key.startsWith('DREAM_AGENT_') && key.endsWith('_MODEL_ID')) {
            const nameMatch = key.match(/^DREAM_AGENT_([A-Z0-9_]+)_MODEL_ID$/i);
            if (nameMatch && nameMatch[1]) agentBaseNames.add(nameMatch[1].toUpperCase());
        }
    }

    for (const baseName of agentBaseNames) {
        const modelId = envConfig[`DREAM_AGENT_${baseName}_MODEL_ID`];
        const chineseName = envConfig[`DREAM_AGENT_${baseName}_CHINESE_NAME`];

        if (!modelId || !chineseName) {
            if (DEBUG_MODE) console.error(`[AgentDream] Skipping agent ${baseName}: Missing MODEL_ID or CHINESE_NAME.`);
            continue;
        }

        const systemPromptTemplate = envConfig[`DREAM_AGENT_${baseName}_SYSTEM_PROMPT`] || '';
        let finalSystemPrompt = systemPromptTemplate.replace(/\{\{MaidName\}\}/g, chineseName);

        DREAM_AGENTS[chineseName] = {
            id: modelId,
            name: chineseName,
            baseName: baseName,
            systemPrompt: finalSystemPrompt,
            maxOutputTokens: parseInt(envConfig[`DREAM_AGENT_${baseName}_MAX_OUTPUT_TOKENS`] || '40000', 10),
            temperature: parseFloat(envConfig[`DREAM_AGENT_${baseName}_TEMPERATURE`] || '0.85'),
        };
        if (DEBUG_MODE) console.error(`[AgentDream] Loaded dream agent: '${chineseName}' (Base: ${baseName}, Model: ${modelId})`);
    }
}

// =========================================================================
// 入梦流程核心
// =========================================================================

/**
 * 触发一个 Agent 进入梦境
 * @param {string} agentName - Agent 的中文名
 * @returns {Promise<object>} 梦境结果
 */
async function triggerDream(agentName) {
    const agentConfig = DREAM_AGENTS[agentName];
    if (!agentConfig) {
        return { status: 'error', error: `梦Agent '${agentName}' 未找到。可用: ${Object.keys(DREAM_AGENTS).join(', ')}` };
    }

    if (!knowledgeBaseManager || !knowledgeBaseManager.initialized) {
        return { status: 'error', error: 'KnowledgeBaseManager 未初始化，无法进入梦境。' };
    }

    const dreamId = `dream-${_getDateStr()}-${agentName}-${uuidv4().substring(0, 8)}`;
    console.log(`[AgentDream] 🌙 Dream starting: ${agentName} (${dreamId})`);

    // 广播: 入梦开始
    _broadcastDream('AGENT_DREAM_START', agentName, dreamId, {
        message: `${agentName} 正在进入梦境...`
    });

    try {
        // Step 1: 稀疏采样种子日记
        const seedDiaries = await _sampleSeedDiaries(agentName);
        if (seedDiaries.length === 0) {
            console.log(`[AgentDream] ⚠️ No diaries found for ${agentName}, aborting dream.`);
            return { status: 'error', error: `${agentName} 没有可用的日记，无法入梦。` };
        }
        if (DEBUG_MODE) console.error(`[AgentDream] Sampled ${seedDiaries.length} seed diaries for ${agentName}`);

        // Step 2: TagMemo 联想召回
        const associations = await _recallAssociations(agentName, seedDiaries);

        // 广播: 联想完成
        _broadcastDream('AGENT_DREAM_ASSOCIATIONS', agentName, dreamId, {
            seedCount: seedDiaries.length,
            associationCount: associations.length,
            seeds: seedDiaries.map(s => ({ file: path.basename(s.filePath), snippet: s.content.substring(0, 80) + '...' })),
            associations: associations.map(a => ({ file: path.basename(a.fullPath || ''), score: a.score?.toFixed(3) }))
        });

        // Step 3: 组装梦提示词
        const dreamPrompt = await _assembleDreamPrompt(agentName, seedDiaries, associations);

        // Step 4: 调用 VCP API 进行梦对话
        const dreamSessionId = `dream_${agentName}_${dreamId}`;
        const history = _getDreamContext(agentName, dreamSessionId);

        const messagesForVCP = [
            { role: 'system', content: agentConfig.systemPrompt },
            ...history,
            { role: 'user', content: dreamPrompt }
        ];

        const payload = {
            model: agentConfig.id,
            messages: messagesForVCP,
            max_tokens: agentConfig.maxOutputTokens,
            temperature: agentConfig.temperature,
            stream: false
        };

        if (DEBUG_MODE) console.error(`[AgentDream] Sending dream request to VCP Server for ${agentName}`);

        const response = await axios.post(`${VCP_API_TARGET_URL}/chat/completions`, payload, {
            headers: {
                'Authorization': `Bearer ${VCP_SERVER_ACCESS_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: parseInt(process.env.PLUGIN_COMMUNICATION_TIMEOUT) || 118000
        });

        // 提取回复内容 - 只取 content，忽略 reasoning_content（Gemini思维链）
        const message = response.data?.choices?.[0]?.message;
        const dreamNarrative = message?.content;
        if (typeof dreamNarrative !== 'string') {
            return { status: 'error', error: `${agentName} 的梦境回复无效。` };
        }

        if (message.reasoning_content) {
            console.log(`[AgentDream] 🧠 Filtered out ${message.reasoning_content.length} chars of thinking chain for ${agentName}`);
        }

        // 移除 VCP 思维链标记（兜底，以防某些模型用标记格式）
        const cleanedNarrative = _removeVCPThinkingChain(dreamNarrative);

        // 更新梦上下文
        _updateDreamContext(agentName, dreamSessionId,
            { role: 'user', content: dreamPrompt },
            { role: 'assistant', content: cleanedNarrative }
        );

        // 广播: 梦叙述产出
        _broadcastDream('AGENT_DREAM_NARRATIVE', agentName, dreamId, {
            narrative: cleanedNarrative
        });

        console.log(`[AgentDream] 🌙 Dream narrative received for ${agentName} (${cleanedNarrative.length} chars)`);

        // 持久化梦记录 JSON（包含完整梦叙事、种子、联想）
        const dreamSessionLog = {
            dreamId: dreamId,
            agentName: agentName,
            timestamp: new Date().toISOString(),
            dreamNarrative: cleanedNarrative,
            seedDiaries: seedDiaries.map(s => ({
                filePath: s.filePath,
                contentSnippet: s.content.substring(0, 300) + (s.content.length > 300 ? '...' : '')
            })),
            associations: associations.map(a => ({
                fullPath: a.fullPath,
                score: a.score,
                source: a.source,
                diaryName: a.diaryName,
                textSnippet: (a.text || '').substring(0, 200) + ((a.text || '').length > 200 ? '...' : '')
            })),
            operations: [] // 后续 processToolCall 会追加
        };
        const sessionLogFileName = `${agentName}_${_getDateStr()}_${dreamId.split('-').pop()}.json`;
        const sessionLogPath = path.join(__dirname, 'dream_logs', sessionLogFileName);
        try {
            await fsPromises.writeFile(sessionLogPath, JSON.stringify(dreamSessionLog, null, 2), 'utf-8');
            console.log(`[AgentDream] 📝 Dream session saved: ${sessionLogFileName}`);
        } catch (e) {
            console.error(`[AgentDream] Failed to save dream session log: ${e.message}`);
        }

        return {
            status: 'success',
            dreamId: dreamId,
            agentName: agentName,
            narrative: cleanedNarrative,
            seedDiaries: seedDiaries.map(s => s.filePath),
            associations: associations.map(a => ({ fullPath: a.fullPath, score: a.score })),
            dreamLogFile: sessionLogFileName,
            result: { content: [{ type: 'text', text: cleanedNarrative }] }
        };

    } catch (error) {
        let errorMessage = `${agentName} 入梦失败。`;
        if (axios.isAxiosError(error)) {
            if (error.response) errorMessage += ` API Status: ${error.response.status}.`;
            else if (error.code) errorMessage += ` Code: ${error.code}.`;
            if (error.message?.includes('timeout')) errorMessage += ' Request timed out.';
        } else {
            errorMessage += ` ${error.message}`;
        }
        console.error(`[AgentDream] ❌ ${errorMessage}`);

        _broadcastDream('AGENT_DREAM_END', agentName, dreamId, {
            status: 'error', error: errorMessage
        });

        return { status: 'error', error: errorMessage };
    }
}

// =========================================================================
// 种子日记稀疏采样
// =========================================================================

/**
 * 自适应稀疏采样 - 从 agent 的日记目录中采样种子日记
 * 对于活跃 agent，窗口期短但日记多；对于不活跃 agent，自动扩大窗口
 */
async function _sampleSeedDiaries(agentName) {
    const diaryDir = path.join(dailyNoteRootPath, agentName);
    let allFiles = [];

    try {
        const entries = await fsPromises.readdir(diaryDir, { withFileTypes: true });
        // 支持子目录下的日记 (浅层)
        for (const entry of entries) {
            if (entry.isFile() && /\.(txt|md)$/i.test(entry.name)) {
                const fullPath = path.join(diaryDir, entry.name);
                allFiles.push(fullPath);
            } else if (entry.isDirectory()) {
                try {
                    const subEntries = await fsPromises.readdir(path.join(diaryDir, entry.name));
                    for (const subFile of subEntries) {
                        if (/\.(txt|md)$/i.test(subFile)) {
                            allFiles.push(path.join(diaryDir, entry.name, subFile));
                        }
                    }
                } catch (e) { /* 忽略无法读取的子目录 */ }
            }
        }
    } catch (e) {
        if (e.code === 'ENOENT') {
            if (DEBUG_MODE) console.error(`[AgentDream] Diary directory not found: ${diaryDir}`);
            return [];
        }
        throw e;
    }

    if (allFiles.length === 0) return [];

    // 获取所有文件的修改时间
    const filesWithStats = await Promise.all(allFiles.map(async (f) => {
        try {
            const stat = await fsPromises.stat(f);
            return { filePath: f, mtime: stat.mtimeMs };
        } catch (e) {
            return null;
        }
    }));
    const validFiles = filesWithStats.filter(Boolean).sort((a, b) => b.mtime - a.mtime);

    if (validFiles.length === 0) return [];

    // 自适应窗口：从最近开始，逐步扩大日期窗口直到有足够日记
    const now = Date.now();
    const maxRangeMs = DREAM_CONFIG.associationMaxRangeDays * 24 * 60 * 60 * 1000;
    const targetSeedCount = Math.floor(Math.random() * (DREAM_CONFIG.seedCountMax - DREAM_CONFIG.seedCountMin + 1)) + DREAM_CONFIG.seedCountMin;

    // 逐步扩大窗口: 7天 → 30天 → 90天 → maxRange
    const windowSteps = [7, 30, 90, DREAM_CONFIG.associationMaxRangeDays];
    let candidatePool = [];

    for (const windowDays of windowSteps) {
        const windowMs = windowDays * 24 * 60 * 60 * 1000;
        candidatePool = validFiles.filter(f => (now - f.mtime) <= windowMs);
        if (candidatePool.length >= targetSeedCount) break;
    }

    // 如果窗口扩大到最大仍然不够，就用全部
    if (candidatePool.length === 0) candidatePool = validFiles;

    // 随机采样
    const shuffled = candidatePool.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(targetSeedCount, shuffled.length));

    // 读取内容
    const seeds = await Promise.all(selected.map(async (f) => {
        try {
            const content = await fsPromises.readFile(f.filePath, 'utf-8');
            return { filePath: f.filePath, content, mtime: f.mtime };
        } catch (e) {
            return null;
        }
    }));

    return seeds.filter(Boolean);
}

// =========================================================================
// TagMemo 联想召回
// =========================================================================

/**
 * 使用 TagMemo 系统从个人和公共日记索引中召回联想日记
 * 个人:公共 ≈ 3:1
 */
async function _recallAssociations(agentName, seedDiaries) {
    if (!knowledgeBaseManager) return [];

    const totalK = DREAM_CONFIG.recallK;
    const ratio = DREAM_CONFIG.personalPublicRatio;
    const personalK = Math.ceil(totalK * ratio / (ratio + 1));
    const publicK = totalK - personalK;

    const allResults = [];
    const seenPaths = new Set(seedDiaries.map(s => s.filePath)); // 用于去重

    // 构建所有需要搜索的个人日记索引名称
    // 例如: "小克", "小克的知识" 等
    const personalDiaryNames = _getPersonalDiaryNames(agentName);
    // 公共索引名称
    const publicDiaryNames = _getPublicDiaryNames();

    for (const seed of seedDiaries) {
        try {
            // 将种子日记内容向量化
            const embeddingConfig = {
                apiKey: process.env.API_Key,
                apiUrl: process.env.API_URL,
                model: process.env.WhitelistEmbeddingModel || 'google/gemini-embedding-001'
            };

            // 使用 getEmbeddingsBatch 接口
            const { getEmbeddingsBatch } = require('../../EmbeddingUtils');
            const seedText = seed.content.substring(0, 2000); // 截断过长内容
            const [seedVector] = await getEmbeddingsBatch([seedText], embeddingConfig);

            if (!seedVector) continue;

            // 搜索个人索引
            const perKPerIndex = Math.max(3, Math.ceil(personalK / personalDiaryNames.length));
            for (const diaryName of personalDiaryNames) {
                try {
                    const results = await knowledgeBaseManager.search(
                        diaryName, seedVector, perKPerIndex, DREAM_CONFIG.tagBoost
                    );
                    for (const r of results) {
                        if (r.fullPath && !seenPaths.has(r.fullPath)) {
                            seenPaths.add(r.fullPath);
                            allResults.push({ ...r, source: 'personal', diaryName });
                        }
                    }
                } catch (e) {
                    if (DEBUG_MODE) console.error(`[AgentDream] Search error for "${diaryName}":`, e.message);
                }
            }

            // 搜索公共索引
            const pubKPerIndex = Math.max(2, Math.ceil(publicK / publicDiaryNames.length));
            for (const diaryName of publicDiaryNames) {
                try {
                    const results = await knowledgeBaseManager.search(
                        diaryName, seedVector, pubKPerIndex, DREAM_CONFIG.tagBoost
                    );
                    for (const r of results) {
                        if (r.fullPath && !seenPaths.has(r.fullPath)) {
                            seenPaths.add(r.fullPath);
                            allResults.push({ ...r, source: 'public', diaryName });
                        }
                    }
                } catch (e) {
                    if (DEBUG_MODE) console.error(`[AgentDream] Search error for "${diaryName}":`, e.message);
                }
            }
        } catch (e) {
            console.error(`[AgentDream] Embedding error for seed diary:`, e.message);
        }
    }

    // 按分数排序后截取 totalK
    allResults.sort((a, b) => (b.score || 0) - (a.score || 0));

    // K补偿: 如果去重后数量不足 totalK，放宽约束
    let finalResults = allResults.slice(0, totalK);

    if (DEBUG_MODE) {
        const personalCount = finalResults.filter(r => r.source === 'personal').length;
        const publicCount = finalResults.filter(r => r.source === 'public').length;
        console.error(`[AgentDream] Associations: ${personalCount} personal + ${publicCount} public = ${finalResults.length} total`);
    }

    return finalResults;
}

/**
 * 获取一个 agent 相关的所有个人日记索引名称
 * 例如: ["小克", "小克的知识", ...]
 */
function _getPersonalDiaryNames(agentName) {
    const names = [agentName];
    // 扫描 dailynote 目录，查找包含 agentName 的子目录
    try {
        const dirs = fs.readdirSync(dailyNoteRootPath, { withFileTypes: true });
        for (const dir of dirs) {
            if (dir.isDirectory() && dir.name.includes(agentName) && dir.name !== agentName) {
                names.push(dir.name);
            }
        }
    } catch (e) { /* ignore */ }
    return names;
}

/**
 * 获取公共日记索引名称
 * 例如: ["公共", "公共的知识", ...]
 */
function _getPublicDiaryNames() {
    const names = [];
    try {
        const dirs = fs.readdirSync(dailyNoteRootPath, { withFileTypes: true });
        for (const dir of dirs) {
            if (dir.isDirectory() && dir.name.startsWith('公共')) {
                names.push(dir.name);
            }
        }
    } catch (e) { /* ignore */ }
    // 兜底：至少搜索 "公共"
    if (names.length === 0) names.push('公共');
    return names;
}

// =========================================================================
// 梦提示词组装
// =========================================================================

/**
 * 读取 dreampost.txt 模板并填充占位符
 */
async function _assembleDreamPrompt(agentName, seedDiaries, associations) {
    // 读取模板
    const templatePath = path.join(__dirname, 'dreampost.txt');
    let template = '';
    try {
        template = await fsPromises.readFile(templatePath, 'utf-8');
    } catch (e) {
        console.error(`[AgentDream] Failed to read dreampost.txt: ${e.message}`);
        template = '你正在做梦。你想起了以下记忆：\n{{日记联想组合占位符}}';
    }

    // 组装日记内容
    const diarySegments = [];

    // 种子日记
    diarySegments.push('=== 你今天想起的记忆 ===');
    for (const seed of seedDiaries) {
        const fileUrl = `file:///${seed.filePath.replace(/\\/g, '/')}`;
        diarySegments.push(`[LocalURL: ${fileUrl}]\n${seed.content}\n`);
    }

    // 联想日记
    if (associations.length > 0) {
        diarySegments.push('=== 由此联想到的记忆碎片 ===');
        for (const assoc of associations) {
            const fileUrl = assoc.fullPath ? `file:///${assoc.fullPath.replace(/\\/g, '/')}` : '[路径未知]';
            const sourceLabel = assoc.source === 'personal' ? '个人记忆' : '公共记忆';
            diarySegments.push(`[${sourceLabel}] [LocalURL: ${fileUrl}] [相似度: ${(assoc.score || 0).toFixed(3)}]\n${assoc.text}\n`);
        }
    }

    const diaryBlock = diarySegments.join('\n');

    // 替换模板占位符
    const now = new Date();
    const monthNames = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
    const hour = now.getHours();
    let timeOfDay = '晨';
    if (hour >= 6 && hour < 12) timeOfDay = '晨';
    else if (hour >= 12 && hour < 14) timeOfDay = '午';
    else if (hour >= 14 && hour < 18) timeOfDay = '日';
    else timeOfDay = '夜';

    let result = template
        .replace(/\{\{Month\}\}/g, monthNames[now.getMonth()])
        .replace(/\{\{Day\}\}/g, String(now.getDate()))
        .replace(/\{\{TimeOfDay\}\}/g, timeOfDay)
        .replace(/\{\{DiaryAssociations\}\}/g, diaryBlock)
        .replace(/\{\{MaidName\}\}/g, agentName)
        .replace(/\{\{Date\}\}/g, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`)
        .replace(/\{\{Time\}\}/g, `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);

    return result;
}

// =========================================================================
// 梦操作指令处理 (processToolCall)
// =========================================================================

/**
 * 处理梦操作工具调用 - 支持串语法
 * @param {object} args - 工具调用参数
 * @returns {Promise<object>} 操作结果
 */
async function processToolCall(args) {
    // 检查是否是 triggerDream 入口
    if (args.action === 'triggerDream' && args.agent_name) {
        return await triggerDream(args.agent_name);
    }

    // 兼容单指令不带数字后缀的情况: command → command1
    if (args.command && !args.command1) {
        args.command1 = args.command;
        // 同步迁移所有无后缀的参数到后缀1
        const paramKeys = ['sourceDiaries', 'newContent', 'targetDiary', 'reason', 'referenceDiaries', 'insightContent'];
        for (const key of paramKeys) {
            if (args[key] && !args[`${key}1`]) {
                args[`${key}1`] = args[key];
            }
        }
    }

    // 串语法解析: command1, command2, ...
    const operations = [];
    let i = 1;
    let hasCommand = false;

    while (args[`command${i}`]) {
        hasCommand = true;
        const command = args[`command${i}`];
        const operation = await _parseOperation(command, i, args);
        operations.push(operation);
        i++;
    }

    if (!hasCommand) {
        return { status: 'error', error: '缺少操作指令。请使用 command1, command2... 格式指定梦操作。' };
    }

    // 确定 dream context
    const agentName = args.maid || args.agent_name || '未知Agent';
    const dreamId = args.dreamId || `dream-${_getDateStr()}-${agentName}-${uuidv4().substring(0, 8)}`;

    // 构建梦操作 JSON
    const dreamLog = {
        dreamId: dreamId,
        agentName: agentName,
        timestamp: new Date().toISOString(),
        operations: operations,
    };

    // 保存到 dream_logs
    const logFileName = `${agentName}_${_getDateStr()}_${uuidv4().substring(0, 8)}.json`;
    const logFilePath = path.join(__dirname, 'dream_logs', logFileName);

    try {
        await fsPromises.writeFile(logFilePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
        console.log(`[AgentDream] 📝 Dream operations saved: ${logFileName}`);
    } catch (e) {
        console.error(`[AgentDream] ❌ Failed to save dream log: ${e.message}`);
        return { status: 'error', error: `保存梦操作记录失败: ${e.message}` };
    }

    // 广播: 梦操作记录
    _broadcastDream('AGENT_DREAM_OPERATIONS', agentName, dreamId, {
        operationCount: operations.length,
        operations: operations.map(op => ({
            type: op.type,
            operationId: op.operationId,
            status: op.status
        })),
        logFile: logFileName
    });

    // 构建友好的回复文本
    const summaryLines = operations.map((op, idx) => {
        switch (op.type) {
            case 'merge':
                return `${idx + 1}. [合并] 将 ${(op.sourceDiaries || []).length} 篇日记合并 → 待审批`;
            case 'delete':
                return `${idx + 1}. [删除] 标记 ${op.targetDiary || '未知'} 待删除 → 待审批`;
            case 'insight':
                return `${idx + 1}. [感悟] 基于 ${(op.referenceDiaries || []).length} 篇日记产生梦感悟 → 待审批`;
            default:
                return `${idx + 1}. [${op.type}] → ${op.status}`;
        }
    });

    const resultText = `梦操作已记录 (${dreamId}):\n${summaryLines.join('\n')}\n\n所有操作已保存待管理员审批，日志文件: ${logFileName}`;

    return {
        status: 'success',
        result: { content: [{ type: 'text', text: resultText }] },
        dreamLog: dreamLog
    };
}

/**
 * 解析单个操作指令 (异步 - 自动读取日记内容供管理员审阅)
 */
async function _parseOperation(command, index, args) {
    const operationId = `op-${index}`;
    const suffix = String(index);

    switch (command) {
        case 'DiaryMerge': {
            const sourceDiariesStr = args[`sourceDiaries${suffix}`] || '';
            const sourceDiaries = sourceDiariesStr.split(',').map(s => s.trim()).filter(Boolean);
            // 自动读取每篇源日记的原始内容，供管理员对比审阅
            const sourceContents = {};
            for (const diaryUrl of sourceDiaries) {
                const filePath = _urlToFilePath(diaryUrl);
                try {
                    sourceContents[diaryUrl] = await fsPromises.readFile(filePath, 'utf-8');
                } catch (e) {
                    sourceContents[diaryUrl] = `[读取失败: ${e.message}]`;
                }
            }
            return {
                type: 'merge',
                operationId,
                sourceDiaries,
                sourceContents,
                newContent: args[`newContent${suffix}`] || '',
                status: 'pending_review'
            };
        }

        case 'DiaryDelete': {
            const targetDiary = args[`targetDiary${suffix}`] || '';
            // 自动读取待删除日记的完整内容，供管理员审阅
            let targetContent = '';
            const filePath = _urlToFilePath(targetDiary);
            try {
                targetContent = await fsPromises.readFile(filePath, 'utf-8');
            } catch (e) {
                targetContent = `[读取失败: ${e.message}]`;
            }
            return {
                type: 'delete',
                operationId,
                targetDiary,
                targetContent,
                reason: args[`reason${suffix}`] || '',
                status: 'pending_review'
            };
        }

        case 'DreamInsight': {
            const refDiariesStr = args[`referenceDiaries${suffix}`] || '';
            const referenceDiaries = refDiariesStr.split(',').map(s => s.trim()).filter(Boolean);
            return {
                type: 'insight',
                operationId,
                referenceDiaries,
                insightContent: args[`insightContent${suffix}`] || '',
                suggestedMaid: args[`maid`] || args[`agent_name`] || '未知',
                suggestedDate: _getDateStr(),
                status: 'pending_review'
            };
        }

        default:
            return {
                type: 'unknown',
                operationId,
                command: command,
                status: 'error',
                error: `未知的梦操作类型: ${command}`
            };
    }
}

/**
 * 将 file:/// URL 转换为本地文件路径
 */
function _urlToFilePath(fileUrl) {
    if (fileUrl.startsWith('file:///')) {
        return fileUrl.replace('file:///', '').replace(/\//g, path.sep);
    }
    return fileUrl; // 如果不是 file:// URL，直接当路径用
}

// =========================================================================
// 梦上下文管理
// =========================================================================

function _getDreamContext(agentName, sessionId) {
    if (!dreamContexts.has(agentName)) {
        dreamContexts.set(agentName, new Map());
    }
    const sessions = dreamContexts.get(agentName);
    if (!sessions.has(sessionId) || _isContextExpired(sessions.get(sessionId).timestamp)) {
        sessions.set(sessionId, { timestamp: Date.now(), history: [] });
    }
    return sessions.get(sessionId).history;
}

function _updateDreamContext(agentName, sessionId, userMessage, assistantMessage) {
    const sessions = dreamContexts.get(agentName);
    if (!sessions) return;
    let data = sessions.get(sessionId);
    if (!data || _isContextExpired(data.timestamp)) {
        data = { timestamp: Date.now(), history: [] };
        sessions.set(sessionId, data);
    }
    data.history.push(userMessage, assistantMessage);
    data.timestamp = Date.now();
    // 梦上下文保持精简，最多 6 轮 (12 条消息)
    if (data.history.length > 12) {
        data.history = data.history.slice(-12);
    }
}

function _isContextExpired(timestamp) {
    return (Date.now() - timestamp) > (DREAM_CONFIG.contextTTLHours * 60 * 60 * 1000);
}

// =========================================================================
// 辅助函数
// =========================================================================

/**
 * 移除 VCP 思维链内容
 */
function _removeVCPThinkingChain(text) {
    if (typeof text !== 'string') return text;
    let result = text;
    const startMarker = '[--- VCP元思考链:';
    const endMarker = '[--- 元思考链结束 ---]';

    while (true) {
        const startIndex = result.indexOf(startMarker);
        if (startIndex === -1) break;
        const endIndex = result.indexOf(endMarker, startIndex);
        if (endIndex === -1) {
            result = result.substring(0, startIndex).trimEnd();
            break;
        }
        result = result.substring(0, startIndex) + result.substring(endIndex + endMarker.length);
    }
    return result.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * VCPInfo 广播封装
 */
function _broadcastDream(type, agentName, dreamId, data) {
    const broadcastData = {
        type,
        agentName,
        dreamId,
        ...data,
        timestamp: new Date().toISOString()
    };

    try {
        // 动态获取最新的 pushVcpInfo (类似 AA 插件的做法)
        const pluginManager = require('../../Plugin.js');
        const freshVcpLogFunctions = pluginManager.getVCPLogFunctions();
        if (freshVcpLogFunctions && typeof freshVcpLogFunctions.pushVcpInfo === 'function') {
            freshVcpLogFunctions.pushVcpInfo(broadcastData);
            if (DEBUG_MODE) console.error(`[AgentDream] Broadcast: ${type} for ${agentName}`);
        }
    } catch (e) {
        // 初始注入的 fallback
        try {
            pushVcpInfo(broadcastData);
        } catch (e2) {
            if (DEBUG_MODE) console.error('[AgentDream] Broadcast failed:', e2.message);
        }
    }
}

/**
 * 获取日期字符串 YYYYMMDD
 */
function _getDateStr() {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

// =========================================================================
// 自动做梦调度器
// =========================================================================

/**
 * 启动自动做梦调度定时器
 */
function _startDreamScheduler() {
    if (dreamSchedulerTimer) {
        clearInterval(dreamSchedulerTimer);
    }

    // 检查是否有可做梦的 Agent
    if (DREAM_CONFIG.agentList.length === 0 && Object.keys(DREAM_AGENTS).length === 0) {
        console.log('[AgentDream] ⏸️ No dream agents configured, scheduler not started.');
        return;
    }

    dreamSchedulerTimer = setInterval(() => {
        _checkAndTriggerDreams().catch(err => {
            console.error('[AgentDream] ❌ Scheduler error:', err.message);
        });
    }, SCHEDULER_CHECK_INTERVAL_MS);

    // 让定时器不阻止进程退出
    if (dreamSchedulerTimer.unref) {
        dreamSchedulerTimer.unref();
    }

    let scheduledAgents = Object.keys(DREAM_AGENTS);
    if (DREAM_CONFIG.agentList && DREAM_CONFIG.agentList.length > 0) {
        scheduledAgents = scheduledAgents.filter(a => DREAM_CONFIG.agentList.includes(a));
    }
    console.log(`[AgentDream] ⏰ Dream scheduler started. Check every ${SCHEDULER_CHECK_INTERVAL_MS / 60000}min, ` +
        `window ${DREAM_CONFIG.timeWindowStart}:00-${DREAM_CONFIG.timeWindowEnd}:00, ` +
        `frequency ${DREAM_CONFIG.frequencyHours}h, probability ${DREAM_CONFIG.probability}, ` +
        `agents: [${scheduledAgents.join(', ')}]`);
}

/**
 * 停止自动做梦调度定时器
 */
function _stopDreamScheduler() {
    if (dreamSchedulerTimer) {
        clearInterval(dreamSchedulerTimer);
        dreamSchedulerTimer = null;
        console.log('[AgentDream] ⏰ Dream scheduler stopped.');
    }
}

/**
 * 核心调度检查 - 每次定时器触发时执行
 * 1. 检查当前时间是否在做梦时间窗口内
 * 2. 对每个 Agent 检查频率冷却
 * 3. 掷骰子决定是否触发
 * 4. 逐个触发做梦（避免并发压力）
 */
async function _checkAndTriggerDreams() {
    // 防止并发执行（上一轮做梦还未完成）
    if (isDreamingInProgress) {
        if (DEBUG_MODE) console.error('[AgentDream] Scheduler: skipping, previous dream still in progress.');
        return;
    }

    const now = new Date();
    const currentHour = now.getHours();

    // 检查时间窗口（支持跨午夜，例如 22:00 - 06:00）
    const windowStart = DREAM_CONFIG.timeWindowStart;
    const windowEnd = DREAM_CONFIG.timeWindowEnd;
    let inWindow = false;

    if (windowStart <= windowEnd) {
        // 正常窗口: 例如 1:00 - 6:00
        inWindow = currentHour >= windowStart && currentHour < windowEnd;
    } else {
        // 跨午夜窗口: 例如 22:00 - 6:00
        inWindow = currentHour >= windowStart || currentHour < windowEnd;
    }

    if (!inWindow) {
        if (DEBUG_MODE) console.error(`[AgentDream] Scheduler: outside dream window (current: ${currentHour}:00, window: ${windowStart}:00-${windowEnd}:00)`);
        return;
    }

    // 获取所有可做梦的 Agent
    let eligibleAgents = Object.keys(DREAM_AGENTS);
    if (DREAM_CONFIG.agentList && DREAM_CONFIG.agentList.length > 0) {
        eligibleAgents = eligibleAgents.filter(agent => DREAM_CONFIG.agentList.includes(agent));
    }

    if (eligibleAgents.length === 0) {
        return;
    }

    const nowMs = Date.now();
    const frequencyMs = DREAM_CONFIG.frequencyHours * 60 * 60 * 1000;
    const agentsToTrigger = [];

    for (const agentName of eligibleAgents) {
        const lastDreamTime = lastDreamTimestamps.get(agentName) || 0;
        const elapsed = nowMs - lastDreamTime;

        // 频率冷却检查
        if (elapsed < frequencyMs) {
            if (DEBUG_MODE) {
                const remainingMin = Math.ceil((frequencyMs - elapsed) / 60000);
                console.error(`[AgentDream] Scheduler: ${agentName} cooldown, ${remainingMin}min remaining.`);
            }
            continue;
        }

        // 概率掷骰子
        const roll = Math.random();
        if (roll >= DREAM_CONFIG.probability) {
            if (DEBUG_MODE) console.error(`[AgentDream] Scheduler: ${agentName} dice roll failed (${roll.toFixed(3)} >= ${DREAM_CONFIG.probability})`);
            continue;
        }

        if (DEBUG_MODE) console.error(`[AgentDream] Scheduler: ${agentName} dice roll passed (${roll.toFixed(3)} < ${DREAM_CONFIG.probability})`);
        agentsToTrigger.push(agentName);
    }

    if (agentsToTrigger.length === 0) {
        if (DEBUG_MODE) console.error('[AgentDream] Scheduler: no agents eligible for dreaming this cycle.');
        return;
    }

    // 逐个触发做梦（串行避免过大并发压力）
    isDreamingInProgress = true;
    console.log(`[AgentDream] 🌙 Scheduler triggering auto-dream for: [${agentsToTrigger.join(', ')}]`);

    // 广播: 自动做梦开始
    _broadcastDream('AGENT_DREAM_SCHEDULE', 'system', 'scheduler', {
        message: `自动做梦调度触发，即将为 ${agentsToTrigger.join(', ')} 入梦`,
        agents: agentsToTrigger,
        currentHour: currentHour
    });

    try {
        for (const agentName of agentsToTrigger) {
            try {
                console.log(`[AgentDream] ⏰ Auto-dreaming: ${agentName}...`);
                const result = await triggerDream(agentName);

                if (result.status === 'success') {
                    // 更新上次做梦时间
                    lastDreamTimestamps.set(agentName, Date.now());
                    _saveDreamState();
                    console.log(`[AgentDream] ✅ Auto-dream completed for ${agentName}: ${result.dreamId}`);
                } else {
                    console.error(`[AgentDream] ⚠️ Auto-dream failed for ${agentName}: ${result.error}`);
                }

                // Agent 之间间隔 30 秒，避免 API 压力
                if (agentsToTrigger.indexOf(agentName) < agentsToTrigger.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 30000));
                }
            } catch (err) {
                console.error(`[AgentDream] ❌ Auto-dream error for ${agentName}:`, err.message);
            }
        }
    } finally {
        isDreamingInProgress = false;
    }
}

// =========================================================================
// 调度状态持久化
// =========================================================================

/**
 * 从磁盘加载上次做梦时间戳（防止重启后立即重新触发）
 */
function _loadDreamState() {
    const stateFilePath = path.join(__dirname, DREAM_STATE_FILE);
    try {
        if (fs.existsSync(stateFilePath)) {
            const data = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
            if (data.lastDreamTimestamps && typeof data.lastDreamTimestamps === 'object') {
                for (const [agent, ts] of Object.entries(data.lastDreamTimestamps)) {
                    lastDreamTimestamps.set(agent, ts);
                }
            }
            if (DEBUG_MODE) {
                const entries = [...lastDreamTimestamps.entries()].map(([a, t]) => `${a}: ${new Date(t).toLocaleString()}`);
                console.error(`[AgentDream] Loaded dream state: ${entries.join(', ') || 'empty'}`);
            }
        }
    } catch (e) {
        console.error(`[AgentDream] Failed to load dream state: ${e.message}`);
    }
}

/**
 * 将上次做梦时间戳保存到磁盘
 */
function _saveDreamState() {
    const stateFilePath = path.join(__dirname, DREAM_STATE_FILE);
    try {
        const data = {
            lastDreamTimestamps: Object.fromEntries(lastDreamTimestamps),
            savedAt: new Date().toISOString()
        };
        fs.writeFileSync(stateFilePath, JSON.stringify(data, null, 2), 'utf-8');
        if (DEBUG_MODE) console.error('[AgentDream] Dream state saved.');
    } catch (e) {
        console.error(`[AgentDream] Failed to save dream state: ${e.message}`);
    }
}

// =========================================================================
// 模块导出
// =========================================================================

module.exports = {
    initialize,
    shutdown,
    processToolCall,
    // 暴露给外部调度系统使用
    triggerDream,
    // 二期面板接口预留
    getDreamConfig: () => ({ ...DREAM_CONFIG }),
    getDreamAgents: () => ({ ...DREAM_AGENTS }),
    getDreamLogs: async (agentName = null) => {
        const logsDir = path.join(__dirname, 'dream_logs');
        try {
            const files = await fsPromises.readdir(logsDir);
            let logFiles = files.filter(f => f.endsWith('.json'));
            if (agentName) {
                logFiles = logFiles.filter(f => f.startsWith(agentName + '_'));
            }
            logFiles.sort().reverse(); // 最新在前
            const logs = await Promise.all(logFiles.map(async (f) => {
                try {
                    const content = await fsPromises.readFile(path.join(logsDir, f), 'utf-8');
                    return JSON.parse(content);
                } catch (e) {
                    return { error: `Failed to parse ${f}` };
                }
            }));
            return logs;
        } catch (e) {
            return [];
        }
    },
    // 二期: 审批操作
    approveDreamOperation: async (logFileName, operationId) => {
        // 预留接口 - 二期实现
        return { status: 'not_implemented', message: '梦操作审批功能将在二期面板中实现。' };
    },
    rejectDreamOperation: async (logFileName, operationId) => {
        // 预留接口 - 二期实现
        return { status: 'not_implemented', message: '梦操作拒绝功能将在二期面板中实现。' };
    }
};
