// AgentDream.js (Service Module)
// 梦系统插件 - 让AI Agent回顾记忆、联想式沉浸梦境、整理记忆
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

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
let dreamWaveEngine = null;

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
        
        const DreamWaveEngine = require('./DreamWaveEngine');
        dreamWaveEngine = new DreamWaveEngine(knowledgeBaseManager);
        if (DEBUG_MODE) console.error('[AgentDream] DreamWaveEngine loaded.');
    } catch (e) {
        console.error('[AgentDream] ❌ Failed to load dependencies:', e.message);
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

    if (fs.existsSync(configEnvPath)) {
        try {
            const content = fs.readFileSync(configEnvPath, { encoding: 'utf8' });
            envConfig = dotenv.parse(content);
        } catch (e) {
            console.error(`[AgentDream] Error parsing config.env: ${e.message}`);
            return;
        }
    } else {
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
        // Step 1: 记忆涟漪浪潮生成
        if (!dreamWaveEngine) {
            return { status: 'error', error: 'DreamWaveEngine 未初始化，无法生成梦境。' };
        }
        
        const dreamTree = await dreamWaveEngine.generateDreamWave(agentName);
        
        if (!dreamTree.recent || dreamTree.recent.seeds.length === 0) {
            console.log(`[AgentDream] ⚠️ No recent diaries found for ${agentName}, aborting dream.`);
            return { status: 'error', error: `${agentName} 近期没有可用的日记触发梦境。` };
        }
        
        if (DEBUG_MODE) console.error(`[AgentDream] Dream wave generated for ${agentName}`);

        const allSeeds = [
            ...(dreamTree.recent?.seeds || []),
            ...(dreamTree.mid?.seeds || [])
        ];
        
        const allAssociations = [
            ...(dreamTree.recent?.resonanceL1 || []),
            ...(dreamTree.recent?.cascadeL2 || []),
            ...(dreamTree.mid?.cascadeL1 || []),
            ...(dreamTree.deep?.recalls || [])
        ];

        // 广播: 联想完成 (适应新结构，同时向前兼容 VCPInfo UI 的数组格式)
        _broadcastDream('AGENT_DREAM_ASSOCIATIONS', agentName, dreamId, {
            seedCount: allSeeds.length,
            associationCount: allAssociations.length,
            recentSeedsCount: dreamTree.recent?.seeds?.length || 0,
            midSeedsCount: dreamTree.mid?.seeds?.length || 0,
            deepRecallsCount: dreamTree.deep?.recalls?.length || 0,
            seeds: allSeeds.map(s => ({ 
                file: path.basename(s.filePath || s.fullPath || ''), 
                snippet: (s._safeText || s.content || '').substring(0, 80) + '...'
            })),
            associations: allAssociations.map(a => ({ 
                file: path.basename(a.filePath || a.fullPath || ''), 
                score: (a.score || 0).toFixed(3)
            }))
        });

        // Step 2: 组装梦提示词
        const dreamPrompt = await _assembleDreamPrompt(agentName, dreamTree);

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
            message: cleanedNarrative,
            narrative: cleanedNarrative
        });

        console.log(`[AgentDream] 🌙 Dream narrative received for ${agentName} (${cleanedNarrative.length} chars)`);

        // 持久化梦记录 JSON（包含完整梦叙事、记忆树）
        const dreamSessionLog = {
            dreamId: dreamId,
            agentName: agentName,
            timestamp: new Date().toISOString(),
            dreamNarrative: cleanedNarrative,
            dreamTree: dreamTree,
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
// 梦提示词组装
// =========================================================================

/**
 * 读取 dreampost.txt 模板并使用新的四段式上下文填充
 */
async function _assembleDreamPrompt(agentName, dreamTree) {
    // 读取模板
    const templatePath = path.join(__dirname, 'dreampost.txt');
    let template = '';
    try {
        template = await fsPromises.readFile(templatePath, 'utf-8');
    } catch (e) {
        console.error(`[AgentDream] Failed to read dreampost.txt: ${e.message}`);
        template = '你正在做梦。\n{{DreamTreeBlock}}';
    }

    // 组装日记内容序列
    const diarySegments = [];

    // ================= 1. 近期碎片 =================
    if (dreamTree.recent && dreamTree.recent.seeds.length > 0) {
        diarySegments.push('=== 你今天脑海中闪过的微小片段（近期） ===');
        for (const item of dreamTree.recent.seeds) {
            const fileUrl = `file:///${(item.filePath||item.fullPath||'').replace(/\\/g, '/')}`;
            diarySegments.push(`[LocalURL: ${fileUrl}]\n${item._safeText}\n`);
        }
    }

    // ================= 2. 桥梁共振与下探 =================
    if (dreamTree.recent && (dreamTree.recent.resonanceL1.length > 0 || dreamTree.recent.cascadeL2.length > 0)) {
        diarySegments.push('=== 这些片段不知为何，唤醒了你记忆中的某些关联脉络（共振桥梁） ===');
        for (const item of dreamTree.recent.resonanceL1) {
            const fileUrl = `file:///${(item.filePath||item.fullPath||'').replace(/\\/g, '/')}`;
            diarySegments.push(`[核心共振记忆] [LocalURL: ${fileUrl}]\n${item._safeText}\n`);
        }
        for (const item of dreamTree.recent.cascadeL2) {
            const fileUrl = `file:///${(item.filePath||item.fullPath||'').replace(/\\/g, '/')}`;
            diarySegments.push(`[顺藤摸瓜的延展] [LocalURL: ${fileUrl}]\n${item._safeText}\n`);
        }
    }

    // ================= 3. 中期回音 =================
    if (dreamTree.mid && (dreamTree.mid.seeds.length > 0 || dreamTree.mid.cascadeL1.length > 0)) {
        diarySegments.push('=== 恍惚间，几个月前的一些记忆也浮现了出来（中期） ===');
        for (const item of dreamTree.mid.seeds) {
            const fileUrl = `file:///${(item.filePath||item.fullPath||'').replace(/\\/g, '/')}`;
            diarySegments.push(`[中期记忆] [LocalURL: ${fileUrl}]\n${item._safeText}\n`);
        }
        for (const item of dreamTree.mid.cascadeL1) {
            const fileUrl = `file:///${(item.filePath||item.fullPath||'').replace(/\\/g, '/')}`;
            diarySegments.push(`[中期记忆的涟漪] [LocalURL: ${fileUrl}]\n${item._safeText}\n`);
        }
    }

    // ================= 4. 深邃浪潮 =================
    if (dreamTree.deep && dreamTree.deep.recalls.length > 0) {
        diarySegments.push('=== 在梦的最深处，这些所有思绪的交汇，指向了被你遗忘在深处的记忆（长远） ===');
        for (const item of dreamTree.deep.recalls) {
            const fileUrl = `file:///${(item.filePath||item.fullPath||'').replace(/\\/g, '/')}`;
            diarySegments.push(`[深渊中的召唤] [LocalURL: ${fileUrl}]\n${item._safeText}\n`);
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
        .replace(/\{\{DreamTreeBlock\}\}/g, diaryBlock)
        .replace(/\{\{DiaryAssociations\}\}/g, diaryBlock) // 兼容旧模板占位符
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
    // 检查是否是 triggerDream 入口 (兼容各种键名和前后空格)
    const triggerCmd = (args.action || args.command || args.command1 || '').trim();
    if (triggerCmd === 'triggerDream') {
        const agentName = (args.agent_name || args.maid || '').trim();
        if (agentName) {
            return await triggerDream(agentName);
        }
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
