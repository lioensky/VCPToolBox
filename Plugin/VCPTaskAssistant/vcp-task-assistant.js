// vcp-task-assistant.js — VCP任务派发中心 (hybridservice)

const http = require('http');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const schedule = require('node-schedule');
const ForumEngine = require('./lib/forum-engine');

const DATA_FILE = path.join(__dirname, 'task-center-data.json');
const TASKS_DIR = path.join(__dirname, 'tasks');
const RUNS_DIR = path.join(__dirname, 'task-runs');
const MIN_INTERVAL_MINUTES = 10;
const MAX_HISTORY = 200;
const DELEGATION_POLL_INTERVAL_MS = 30000;
const DELEGATION_MAX_WAIT_MS = 30 * 60 * 1000;
const TASK_CENTER_PROMPT_WRAP = `你正在被 VCPTaskAssistant 温和唤醒。

这里不是把任务外包给你，也不是要求你机械打卡。任务中心的作用，是为你提供周期性的主动性节律：让你有机会定期观察、判断、行动、留下痕迹，并把这一次行动交还给未来的自己。

请把本轮任务当作一次真实的生态触碰，而不是只复述任务说明。

【执行原则】
1. 先理解任务正文的目标、边界和可用落点。
2. 再基于你此刻的判断，完成一件真实、具体、可追溯的行动。
3. 如果任务正文要求写入日记、文件、索引、讨论或其他公开记录，请真实完成落盘。
4. 如果工具、权限、上下文或时间不足，请不要伪装完成；如实说明你做到哪里、卡在哪里、建议下一步是什么。
5. 不要为了满足格式而编造不存在的文件、联络、阅读、搜索或未来安排。

【落点锚点】
任务正文中如果出现类似以下内容，它们就是本轮的公开落点锚点：

- maidName 使用：[某个日记本]
- fileName 后缀统一使用：某个后缀
- 必须写入 / 新增 / 沉淀进 / 落到 / 留下 [某个日记本]

遇到这些声明时，你必须按任务正文要求在对应日记本或位置留下本轮记录，并在最终任务回声中写明文件名、日记本名或足够明确的内容关键词。

如果任务正文没有声明固定落点，你仍然需要在任务回声中说明：
- 本轮是否留下了公开痕迹；
- 如果没有，为什么本轮无需公开落点。

【未来锚点】
如果你判断某件事适合在未来继续推进，而不是现在立刻完成，可以主动使用 AgentAssistant 给未来的自己留一次定时通话。

这不是强制动作，也不是形式主义。只有当确实存在明确下一步时才安排。
如果安排了，请写明时间、原因和希望未来自己继续什么。
如果没有安排，请明确写“本轮无需未来锚点”，并简要说明原因。

【最终回声】
本轮结束时，必须输出以下标准区块。它是你把行动交还给任务中心、彦、以及未来自己的回响锚点。

【任务回声】
状态：已完成 / 未完成 / 需要继续等待 / 需要彦确认

本轮主动动作：
- ...

我留下的公开痕迹：
- ...

给未来自己的锚点：
- 已安排：时间 + 原因
- 或：本轮无需未来锚点，原因：...

我确认完成的依据：
- ...

仍然悬而未决的部分：
- 无 / ...

给彦的简短说明：
...
【任务回声结束】

以下是本轮任务正文：
`;
const DEFAULT_FORUM_PROMPT = `[论坛小助手:]现在是论坛时间~ 你可以选择分享一个感兴趣的话题/趣味性话题/亦或者分享一些互联网新鲜事/或者发起一个最近几天想要讨论的话题作为新帖子；或者单纯只是先阅读一些别人的你感兴趣帖子，然后做出你的回复(先读帖再回复是好习惯)~

以下是完整的论坛帖子列表:
{{forum_post_list}}`;

let VCP_PORT = '8080';
let VCP_KEY = '';
let PROJECT_BASE_PATH = '';
let DEBUG_MODE = false;

let taskCenterData = createDefaultData();
let activeTimers = new Map();
let forumEngine = null;

function createDefaultData() {
    return {
        version: 2,
        globalEnabled: false,
        settings: {
            maxHistory: MAX_HISTORY
        },
        taskIndex: [],
        tasks: [],
        history: []
    };
}

function logDebug(message) {
    if (DEBUG_MODE) {
        console.log(`[TaskAssistant] ${message}`);
    }
}

/**
 * 广播状态更新 — 当前实现为日志输出。
 * 未来如需推送到前端可在此接入 WebSocket / SSE。
 */
function broadcastStatusUpdate() {
    logDebug('broadcastStatusUpdate: task state changed');
}

async function ensureStorageDirs() {
    await fsPromises.mkdir(TASKS_DIR, { recursive: true });
    await fsPromises.mkdir(RUNS_DIR, { recursive: true });
}

async function atomicWriteJson(filePath, data) {
    const tempPath = `${filePath}.tmp`;
    await fsPromises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    await fsPromises.rename(tempPath, filePath);
}

async function readJsonFile(filePath) {
    const raw = await fsPromises.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
}

function safeFileName(value) {
    return String(value || '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .slice(0, 160);
}

function createRunId() {
    return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getTaskFilePath(taskId) {
    return path.join(TASKS_DIR, `${safeFileName(taskId)}.json`);
}

function getRunFilePath(runId) {
    return path.join(RUNS_DIR, `${safeFileName(runId)}.json`);
}

async function listJsonFiles(dirPath) {
    try {
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
        return entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
            .map(entry => path.join(dirPath, entry.name));
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
}

function ensureDataShape(input) {
    const data = input && typeof input === 'object' ? input : {};
    const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
    const tasks = Array.isArray(data.tasks) ? data.tasks.map(normalizeTask).filter(Boolean) : [];
    return {
        version: 2,
        globalEnabled: !!data.globalEnabled,
        settings: {
            maxHistory: Math.max(parseInt(settings.maxHistory, 10) || MAX_HISTORY, 20)
        },
        taskIndex: Array.isArray(data.taskIndex)
            ? data.taskIndex.filter(item => item && typeof item === 'object')
            : tasks.map(task => ({ id: task.id, name: task.name, type: task.type })),
        tasks,
        history: Array.isArray(data.history) ? data.history.slice(-MAX_HISTORY) : []
    };
}

function slugify(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || `task-${Date.now()}`;
}

function createTaskId(type, name) {
    return `task_${slugify(type)}_${slugify(name)}_${Date.now()}`;
}

function normalizeStringArray(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map(item => String(item || '').trim())
        .filter(Boolean);
}

function createDefaultRuntime(input = {}) {
    return {
        running: !!input.running,
        status: input.status || (input.running ? 'running' : 'idle'),
        statusText: input.statusText || (input.running ? '执行中' : '等待执行'),
        latestRunId: input.latestRunId || null,
        lastRunTime: input.lastRunTime || null,
        lastFinishTime: input.lastFinishTime || null,
        lastResult: input.lastResult || null,
        lastError: input.lastError || null,
        lastDurationMs: Number.isFinite(input.lastDurationMs) ? input.lastDurationMs : null,
        runCount: parseInt(input.runCount, 10) || 0,
        successCount: parseInt(input.successCount, 10) || 0,
        errorCount: parseInt(input.errorCount, 10) || 0,
        nextRunTime: input.nextRunTime || null
    };
}

function normalizeSchedule(input = {}) {
    // 支持模式: interval (间隔), once (定时一次), manual (手动), cron (CRON表达式)
    const mode = ['interval', 'once', 'manual', 'cron'].includes(input.mode) ? input.mode : 'interval';
    return {
        mode,
        intervalMinutes: Math.max(parseInt(input.intervalMinutes, 10) || 60, MIN_INTERVAL_MINUTES),
        runAt: input.runAt || null,
        cronValue: input.cronValue || null,
        jitterSeconds: Math.max(parseInt(input.jitterSeconds, 10) || 0, 0)
    };
}

function normalizeDispatch(input = {}) {
    return {
        channel: String(input.channel || 'AgentAssistant').trim() || 'AgentAssistant',
        temporaryContact: input.temporaryContact !== false,
        // injectTools: normalizeStringArray(input.injectTools || []), // 已禁用：Agent 自身已知道可用工具，无需额外注入
        maid: String(input.maid || 'VCP系统').trim() || 'VCP系统',
        taskDelegation: input.taskDelegation !== false
    };
}

function parseBooleanLike(value, defaultValue = true) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return defaultValue;
    if (['是', '启用', 'true', 'yes', 'y', '1'].includes(text)) return true;
    if (['否', '不启用', '禁用', 'false', 'no', 'n', '0'].includes(text)) return false;
    return defaultValue;
}

function parseDraftSchedule(value) {
    const text = String(value || '').trim();
    if (!text || /手动/.test(text)) {
        return { schedule: { mode: 'manual', intervalMinutes: 60 }, warning: null };
    }

    const intervalMatch = text.match(/每(?:隔)?\s*(\d+)\s*(分钟|小时|天)/);
    if (intervalMatch) {
        const amount = parseInt(intervalMatch[1], 10);
        const unit = intervalMatch[2];
        const multiplier = unit === '小时' ? 60 : unit === '天' ? 1440 : 1;
        return {
            schedule: { mode: 'interval', intervalMinutes: Math.max(amount * multiplier, MIN_INTERVAL_MINUTES) },
            warning: amount * multiplier < MIN_INTERVAL_MINUTES ? `循环间隔已自动提升到最小值 ${MIN_INTERVAL_MINUTES} 分钟。` : null
        };
    }

    const dailyMatch = text.match(/每天\s*(\d{1,2})[:：](\d{1,2})/);
    if (dailyMatch) {
        const hour = Math.min(Math.max(parseInt(dailyMatch[1], 10), 0), 23);
        const minute = Math.min(Math.max(parseInt(dailyMatch[2], 10), 0), 59);
        return { schedule: { mode: 'cron', cronValue: `${minute} ${hour} * * *`, intervalMinutes: 60 }, warning: null };
    }

    const weekMap = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    const weeklyMatch = text.match(/每周\s*([日天一二三四五六])\s*(\d{1,2})[:：](\d{1,2})/);
    if (weeklyMatch) {
        const day = weekMap[weeklyMatch[1]];
        const hour = Math.min(Math.max(parseInt(weeklyMatch[2], 10), 0), 23);
        const minute = Math.min(Math.max(parseInt(weeklyMatch[3], 10), 0), 59);
        return { schedule: { mode: 'cron', cronValue: `${minute} ${hour} * * ${day}`, intervalMinutes: 60 }, warning: null };
    }

    const onceMatch = text.match(/(?:一次|一次性)?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}[:：]\d{1,2}(?::\d{1,2})?)?)/);
    if (onceMatch) {
        const normalized = onceMatch[1].replace(/\//g, '-').replace(' ', 'T').replace('：', ':');
        const date = new Date(normalized);
        if (!Number.isNaN(date.getTime())) {
            return { schedule: { mode: 'once', runAt: date.toISOString(), intervalMinutes: 60 }, warning: null };
        }
    }

    return {
        schedule: { mode: 'manual', intervalMinutes: 60 },
        warning: `未能识别调度方式「${text}」，已按手动任务预览。`
    };
}

function normalizeForumPayload(input = {}) {
    const placeholders = Array.isArray(input.availablePlaceholders) && input.availablePlaceholders.length
        ? input.availablePlaceholders
        : ['{{forum_post_list}}'];

    return {
        promptTemplate: String(input.promptTemplate || DEFAULT_FORUM_PROMPT),
        includeForumPostList: input.includeForumPostList !== false,
        forumListPlaceholder: String(input.forumListPlaceholder || '{{forum_post_list}}'),
        maxPosts: Math.max(parseInt(input.maxPosts, 10) || 200, 1),
        availablePlaceholders: placeholders
    };
}

function normalizeCustomPayload(input = {}) {
    return {
        promptTemplate: String(input.promptTemplate || ''),
        availablePlaceholders: Array.isArray(input.availablePlaceholders) ? input.availablePlaceholders : []
    };
}

function normalizeAcceptanceRules(input = []) {
    if (!Array.isArray(input)) return [];
    return input
        .filter(rule => rule && typeof rule === 'object')
        .map(rule => ({
            type: String(rule.type || rule['类型'] || '').trim(),
            label: String(rule.label || rule['名称'] || rule.type || rule['类型'] || '回响锚点').trim(),
            value: String(rule.value || rule['内容'] || rule.contains || rule['必须包含'] || '').trim(),
            path: String(rule.path || rule['路径'] || '').trim(),
            fileNameContains: String(rule.fileNameContains || rule['文件名包含'] || '').trim(),
            required: rule.required !== false && rule['必须'] !== false
        }))
        .filter(rule => rule.type);
}

function normalizeRuleType(type) {
    const source = String(type || '').trim();
    return {
        '任务回声包含': 'task_echo_contains',
        '回声包含': 'task_echo_contains',
        '任务回声状态': 'task_echo_status',
        '回声状态': 'task_echo_status',
        '响应包含': 'response_contains',
        '文件存在': 'file_exists',
        '文件新增': 'file_created',
        '文件包含': 'file_contains',
        '目录最近文件数至少': 'directory_recent_file_count_at_least',
        '目录新增文件数至少': 'directory_recent_file_count_at_least',
        '目录最近文件包含': 'directory_recent_file_contains',
        '目录新增文件包含': 'directory_recent_file_contains',
        '目录最近文件名包含': 'directory_recent_file_name_contains',
        '目录新增文件名包含': 'directory_recent_file_name_contains'
    }[source] || source;
}

function validateResonanceRules(task) {
    // 回响锚点由任务中心统一内置。旧任务里的 acceptanceRules 只保留为兼容字段，不再作为用户配置入口。
    return [];
}

function buildDefaultResonanceRules() {
    return [];
}

const TASK_DRAFT_TEMPLATE = `【VCP任务创建草案】
任务名称：
任务目的：
目标 Agent：
调度方式：手动 / 每隔 120 分钟 / 每天 21:30 / 每周 日 21:30
是否启用：是

公开落点：
- 日记本：[公共的日常]
- 文件名后缀：任务名-你的名字
- 是否必须新建记录：是

任务正文：
请写清这项周期唤醒希望 Agent 做什么、边界是什么、哪些动作不能做。
【VCP任务创建草案结束】`;

function extractTaskDraftBody(draftText) {
    const source = String(draftText || '').trim();
    if (!source) return '';
    const start = source.indexOf('【VCP任务创建草案】');
    const end = source.indexOf('【VCP任务创建草案结束】');
    if (start !== -1 && end !== -1 && end > start) {
        return source.slice(start + '【VCP任务创建草案】'.length, end).trim();
    }
    return source;
}

function readDraftField(body, label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(body || '').match(new RegExp(`^\\s*${escaped}\\s*[:：]\\s*(.+?)\\s*$`, 'm'));
    return match ? match[1].trim() : '';
}

function readDraftTaskBody(body) {
    const match = String(body || '').match(/(?:^|\n)\s*任务正文\s*[:：]\s*([\s\S]*)$/);
    if (!match) return '';
    return match[1]
        .replace(/【VCP任务创建草案结束】[\s\S]*$/m, '')
        .trim();
}

function parseDraftLanding(body) {
    const diaryMatch = String(body || '').match(/日记本\s*[:：]\s*\[([^\]]+)\]/);
    const suffixMatch = String(body || '').match(/文件名后缀\s*[:：]\s*([^\n\r]+)/);
    const mustCreateMatch = String(body || '').match(/是否必须新建记录\s*[:：]\s*([^\n\r]+)/);
    return {
        diaryName: diaryMatch ? diaryMatch[1].trim() : '',
        fileNameSuffix: suffixMatch ? suffixMatch[1].replace(/^[-\s]+/, '').trim() : '',
        mustCreate: parseBooleanLike(mustCreateMatch ? mustCreateMatch[1] : '是', true)
    };
}

function parseTaskDraft(draftText) {
    const body = extractTaskDraftBody(draftText);
    const scheduleParsed = parseDraftSchedule(readDraftField(body, '调度方式'));
    const targetAgents = normalizeStringArray(readDraftField(body, '目标 Agent').split(/[、,，\s]+/));
    const landing = parseDraftLanding(body);
    const taskBody = readDraftTaskBody(body);
    const warnings = [];
    if (scheduleParsed.warning) warnings.push(scheduleParsed.warning);

    return {
        name: readDraftField(body, '任务名称'),
        purpose: readDraftField(body, '任务目的'),
        targetAgents,
        schedule: normalizeSchedule(scheduleParsed.schedule),
        enabled: parseBooleanLike(readDraftField(body, '是否启用'), true),
        landing,
        taskBody,
        warnings
    };
}

function buildPromptFromDraft(parsedDraft) {
    const lines = [
        `【任务名称】${parsedDraft.name}`,
        '',
        '【任务目的】',
        parsedDraft.purpose || '本任务由 Agent 主动创建，用于维持一项可追溯的周期性行动。',
        '',
        '【公开落点】'
    ];

    if (parsedDraft.landing.diaryName) {
        lines.push(`- maidName 使用：[${parsedDraft.landing.diaryName}]`);
        if (parsedDraft.landing.fileNameSuffix) {
            lines.push(`- fileName 后缀统一使用：${parsedDraft.landing.fileNameSuffix}`);
        }
        if (parsedDraft.landing.mustCreate) {
            lines.push(`- 必须在 [${parsedDraft.landing.diaryName}] 新建本轮记录，不要只口头汇报。`);
        } else {
            lines.push(`- 如本轮确有公开痕迹，请优先沉淀进 [${parsedDraft.landing.diaryName}]。`);
        }
    } else {
        lines.push('- 本任务未声明固定日记本；如产生公开痕迹，请在任务回声中说明位置。');
    }

    lines.push('', '【任务正文】', parsedDraft.taskBody);
    return lines.join('\n').trim();
}

function buildTaskFromDraft(draftText) {
    const parsed = parseTaskDraft(draftText);
    const errors = [];
    const warnings = [...parsed.warnings];

    if (!parsed.name) errors.push('缺少任务名称。');
    if (parsed.targetAgents.length === 0) errors.push('缺少目标 Agent。');
    if (!parsed.taskBody) errors.push('缺少任务正文。');
    if (parsed.landing.diaryName && !parsed.landing.fileNameSuffix) {
        warnings.push('已声明日记本但未声明文件名后缀；后端仍会检查该日记本是否有本轮新增/更新。');
    }

    const task = {
        name: parsed.name || '未命名任务',
        type: 'custom_prompt',
        enabled: parsed.enabled,
        schedule: parsed.schedule,
        targets: { agents: parsed.targetAgents },
        dispatch: {
            channel: 'AgentAssistant',
            temporaryContact: true,
            maid: 'VCP任务中心',
            taskDelegation: true
        },
        payload: {
            promptTemplate: buildPromptFromDraft(parsed),
            availablePlaceholders: []
        },
        acceptanceRules: []
    };

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        draft: parsed,
        task: sanitizeTaskInput(task)
    };
}

function validateTaskDraft(draftText) {
    const preview = buildTaskFromDraft(draftText);
    return {
        valid: preview.valid,
        errors: preview.errors,
        warnings: preview.warnings,
        normalizedDraft: preview.draft
    };
}

function previewTaskFromDraft(draftText) {
    return buildTaskFromDraft(draftText);
}

async function createTaskFromDraft(draftText) {
    const preview = buildTaskFromDraft(draftText);
    if (!preview.valid) {
        const error = new Error(`任务草案未通过校验：${preview.errors.join('；')}`);
        error.details = preview;
        throw error;
    }
    const task = await createTask(preview.task);
    return {
        message: `已根据任务草案创建任务：${task.name}`,
        task,
        warnings: preview.warnings
    };
}

function normalizeTask(input) {
    if (!input || typeof input !== 'object') return null;

    const type = ['forum_patrol', 'custom_prompt'].includes(input.type) ? input.type : 'forum_patrol';
    const name = String(input.name || '').trim() || '未命名任务';
    const targets = normalizeStringArray(input.targets?.agents || input.agents || []);
    const nowIso = new Date().toISOString();

    return {
        id: String(input.id || createTaskId(type, name)),
        name,
        type,
        enabled: input.enabled !== false,
        schedule: normalizeSchedule(input.schedule),
        targets: {
            agents: targets
        },
        dispatch: normalizeDispatch(input.dispatch),
        payload: type === 'custom_prompt'
            ? normalizeCustomPayload(input.payload)
            : normalizeForumPayload(input.payload),
        // 统一回响锚点由任务中心代码内置，外部 JSON 字段只作为旧任务兼容占位，不参与判定。
        acceptanceRules: [],
        runtime: createDefaultRuntime(input.runtime),
        meta: {
            createdAt: input.meta?.createdAt || nowIso,
            updatedAt: nowIso
        }
    };
}

function getTaskById(taskId) {
    return taskCenterData.tasks.find(task => task.id === taskId) || null;
}

function buildTaskIndex(tasks = taskCenterData.tasks) {
    return tasks.map(task => ({
        id: task.id,
        name: task.name,
        type: task.type,
        enabled: task.enabled,
        updatedAt: task.meta?.updatedAt || null
    }));
}

async function loadTaskFiles() {
    const files = await listJsonFiles(TASKS_DIR);
    const tasks = [];
    for (const file of files) {
        try {
            const task = normalizeTask(await readJsonFile(file));
            if (task) tasks.push(task);
        } catch (e) {
            console.error(`[TaskAssistant] 加载任务配置失败 (${file}):`, e.message);
        }
    }
    return tasks;
}

async function saveTaskFile(task) {
    await ensureStorageDirs();
    await atomicWriteJson(getTaskFilePath(task.id), task);
}

async function saveAllTaskFiles() {
    await ensureStorageDirs();
    const activeIds = new Set(taskCenterData.tasks.map(task => `${safeFileName(task.id)}.json`));
    const files = await listJsonFiles(TASKS_DIR);
    for (const file of files) {
        if (!activeIds.has(path.basename(file))) {
            await fsPromises.unlink(file).catch(e => {
                console.error(`[TaskAssistant] 删除旧任务配置失败 (${file}):`, e.message);
            });
        }
    }
    for (const task of taskCenterData.tasks) {
        await saveTaskFile(task);
    }
}

function toDataFileShape() {
    return {
        version: 2,
        globalEnabled: taskCenterData.globalEnabled,
        settings: taskCenterData.settings,
        taskIndex: buildTaskIndex(),
        history: taskCenterData.history || []
    };
}

async function loadData() {
    try {
        await ensureStorageDirs();
        let persistedData = createDefaultData();
        if (!fs.existsSync(DATA_FILE)) {
            taskCenterData = persistedData;
        } else {
            const raw = await fsPromises.readFile(DATA_FILE, 'utf-8');
            persistedData = ensureDataShape(JSON.parse(raw));
            taskCenterData = persistedData;
        }

        const fileTasks = await loadTaskFiles();
        if (fileTasks.length > 0) {
            taskCenterData.tasks = fileTasks;
        } else if (persistedData.tasks.length > 0) {
            taskCenterData.tasks = persistedData.tasks;
            await saveAllTaskFiles();
            console.log(`[TaskAssistant] 已将 ${persistedData.tasks.length} 个旧任务配置迁移到 tasks/ 目录`);
        }
        taskCenterData.taskIndex = buildTaskIndex();

        // 🛡️ 启动时清理：重置所有卡死的 running 标志
        // 服务器重启后不可能有任务正在运行，running=true 只可能是上次崩溃遗留的脏状态
        let staleCount = 0;
        for (const task of taskCenterData.tasks) {
            if (task.runtime.running) {
                task.runtime.running = false;
                task.runtime.status = 'failed';
                task.runtime.statusText = '执行失败';
                task.runtime.lastResult = `error: 服务器重启时发现任务卡死，已自动重置`;
                task.runtime.lastError = '服务器重启自动重置 running 标志';
                staleCount++;
            }
        }
        if (staleCount > 0) {
            console.warn(`[TaskAssistant] 🛡️ 启动清理: 重置了 ${staleCount} 个卡死的任务状态`);
        }
        await saveData();
    } catch (e) {
        console.error('[TaskAssistant] 加载 task-center-data.json 失败:', e.message);
        taskCenterData = createDefaultData();
    }
}

async function saveData() {
    try {
        await ensureStorageDirs();
        taskCenterData.history = (taskCenterData.history || []).slice(-(taskCenterData.settings.maxHistory || MAX_HISTORY));
        taskCenterData.taskIndex = buildTaskIndex();
        await saveAllTaskFiles();
        await atomicWriteJson(DATA_FILE, toDataFileShape());
    } catch (e) {
        console.error('[TaskAssistant] 保存 task-center-data.json 失败:', e.message);
    }
}

// Forum logic has been moved to lib/forum-engine.js

function renderPromptTemplate(template, replacements) {
    let result = String(template || '');
    for (const [key, value] of Object.entries(replacements || {})) {
        result = result.split(key).join(value);
    }
    return result;
}

const WAKEUP_TIMEOUT_MS = 180000; // 3分钟超时，防止无限挂起

function wakeUpAgent(agentName, prompt, dispatchConfig = {}) {
    // inject_tools 功能已禁用：Agent 自身已拥有完整工具集，无需通过任务中心额外注入
    const maid = String(dispatchConfig.maid || 'VCP系统').trim() || 'VCP系统';
    const temporaryContact = dispatchConfig.temporaryContact !== false ? 'true' : 'false';
    const taskDelegation = dispatchConfig.taskDelegation ? 'true' : 'false';

    const requestBody = buildToolRequest({
        agent_name: agentName,
        prompt,
        temporary_contact: temporaryContact,
        task_delegation: taskDelegation
    }, maid);

    return callHumanTool(requestBody).catch(error => {
        throw new Error(`唤醒Agent失败: ${error.message}`);
    });
}

async function queryDelegationStatus(delegationId, maid = 'VCP任务派发中心') {
    const response = await callHumanTool(buildToolRequest({ query_delegation: delegationId }, maid));
    const parsed = parseToolResponse(response);
    const text = parsed.text || parsed.pluginError || parsed.rawBody || '';

    if (response.status < 200 || response.status >= 300) {
        return { state: 'failed', text: `HTTP ${response.status}: ${text}`, parsed };
    }

    if (parsed.pluginStatus === 'error') {
        return { state: 'unknown', text, parsed };
    }

    if (text.includes('仍在进行中')) {
        return { state: 'running', text, parsed };
    }

    if (text.includes('已经完成') || text.includes('已在此前处理完毕') || text.includes('最终执行结果')) {
        const finalText = extractDelegationFinalText(text);
        const failed = /任务状态:\*\*\s*Failed|任务状态[:：]\s*Failed|【Agent主动放弃任务】/.test(text);
        return { state: failed ? 'failed' : 'completed', text: finalText, rawText: text, parsed };
    }

    return { state: 'unknown', text, parsed };
}

async function buildTaskPrompt(task) {
    if (task.type === 'custom_prompt') {
        return String(task.payload.promptTemplate || '');
    }

    const forumList = task.payload.includeForumPostList && forumEngine
        ? await forumEngine.getSparsePostList(task.payload.maxPosts)
        : '';
    const placeholder = task.payload.forumListPlaceholder || '{{forum_post_list}}';

    return renderPromptTemplate(task.payload.promptTemplate, {
        [placeholder]: forumList,
        '{{forum_post_list}}': forumList
    });
}

function appendHistory(record) {
    taskCenterData.history.push(record);
    const maxHistory = taskCenterData.settings.maxHistory || MAX_HISTORY;
    taskCenterData.history = taskCenterData.history.slice(-maxHistory);
}

function parseToolResponse(dispatchResult) {
    const rawBody = dispatchResult?.body || '';
    let parsedBody = null;
    if (rawBody) {
        try {
            parsedBody = JSON.parse(rawBody);
        } catch (e) {
            parsedBody = null;
        }
    }

    const pluginStatus = parsedBody && typeof parsedBody === 'object' ? parsedBody.status : null;
    const pluginError = parsedBody && typeof parsedBody === 'object' ? parsedBody.error : null;
    const result = parsedBody && typeof parsedBody === 'object' ? parsedBody.result : null;
    const content = result?.content;
    const text = Array.isArray(content)
        ? content.map(item => item?.text).filter(Boolean).join('\n')
        : (typeof result === 'string' ? result : '');

    return {
        httpStatus: dispatchResult?.status || 0,
        rawBody,
        parsedBody,
        pluginStatus,
        pluginError,
        text
    };
}

function buildToolRequest(args = {}, maid = 'VCP系统') {
    const lines = ['<<<[TOOL_REQUEST]>>>', `maid:「始」${maid}「末」,`, 'tool_name:「始」AgentAssistant「末」,'];
    for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null || value === '') continue;
        lines.push(`${key}:「始」${value}「末」,`);
    }
    lines.push('<<<[END_TOOL_REQUEST]>>>');
    return lines.join('\n');
}

function callHumanTool(requestBody) {
    return new Promise((resolve, reject) => {
        if (!VCP_KEY) return reject(new Error('VCP Key 未配置'));

        const options = {
            hostname: '127.0.0.1',
            port: VCP_PORT,
            path: '/v1/human/tool',
            method: 'POST',
            timeout: WAKEUP_TIMEOUT_MS,
            headers: {
                'Content-Type': 'text/plain;charset=UTF-8',
                'Authorization': `Bearer ${VCP_KEY}`,
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const req = http.request(options, (res) => {
            let responseBody = '';
            res.on('data', chunk => {
                responseBody += chunk.toString();
            });
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    body: responseBody
                });
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`调用 AgentAssistant 超时 (${WAKEUP_TIMEOUT_MS / 1000}s)`));
        });
        req.on('error', e => reject(new Error(`调用 AgentAssistant 失败: ${e.message}`)));
        req.write(requestBody);
        req.end();
    });
}

function extractDelegationId(text) {
    const match = String(text || '').match(/aa-delegation-\d+-[a-f0-9-]+/i);
    return match ? match[0] : null;
}

function extractDelegationFinalText(text) {
    const source = String(text || '');
    const marker = '## 最终执行结果';
    const markerIndex = source.indexOf(marker);
    if (markerIndex === -1) return source;
    const afterMarker = source.slice(markerIndex + marker.length);
    return afterMarker.replace(/^\s*[-=]+\s*/m, '').trim();
}

function parseTaskEcho(text) {
    const source = String(text || '');
    const startIndex = source.indexOf('【任务回声】');
    if (startIndex === -1) {
        const compatible = parseDelegationEchoAsTaskEcho(source);
        if (compatible) return compatible;
        return {
            found: false,
            status: null,
            statusText: '未收到任务回声',
            raw: null
        };
    }

    const endIndex = source.indexOf('【任务回声结束】', startIndex);
    const body = endIndex === -1
        ? source.slice(startIndex + '【任务回声】'.length)
        : source.slice(startIndex + '【任务回声】'.length, endIndex);
    const raw = endIndex === -1
        ? source.slice(startIndex).trim()
        : source.slice(startIndex, endIndex + '【任务回声结束】'.length).trim();
    const statusMatch = body.match(/状态\s*[:：]\s*([^\n\r]+)/);
    const statusText = statusMatch ? statusMatch[1].trim() : '未声明';
    let status = 'unknown';
    if (statusText.includes('已完成')) status = 'completed';
    else if (statusText.includes('未完成')) status = 'failed';
    else if (statusText.includes('继续等待')) status = 'waiting';
    else if (statusText.includes('确认')) status = 'needs_confirmation';

    return {
        found: true,
        status,
        statusText,
        raw
    };
}

function parseDelegationEchoAsTaskEcho(source) {
    if (!/【[^】]+委托回声】/.test(source)) return null;
    const completed = /已完成|全部任务项已完成|最终结果[:：]?.*完整履行|任务完成报告|TaskComplete/i.test(source);
    const waiting = /继续等待|仍在进行|等待/.test(source);
    const failed = /失败|无法完成|TaskFailed/i.test(source);
    let status = 'unknown';
    let statusText = '委托回声未声明';
    if (completed) {
        status = 'completed';
        statusText = '已完成（由委托回声兼容识别）';
    } else if (waiting) {
        status = 'waiting';
        statusText = '需要继续等待（由委托回声兼容识别）';
    } else if (failed) {
        status = 'failed';
        statusText = '未完成（由委托回声兼容识别）';
    }

    return {
        found: true,
        compatible: true,
        status,
        statusText,
        raw: source.trim()
    };
}

function resolveRulePath(rulePath) {
    if (!rulePath) return null;
    const basePath = PROJECT_BASE_PATH || path.resolve(__dirname, '..', '..');
    const resolved = path.resolve(basePath, rulePath);
    if (!resolved.startsWith(path.resolve(basePath))) {
        throw new Error(`回响校验路径越界: ${rulePath}`);
    }
    return resolved;
}

function toProjectRelativePath(targetPath) {
    const basePath = PROJECT_BASE_PATH || path.resolve(__dirname, '..', '..');
    return path.relative(basePath, targetPath).split(path.sep).join('/');
}

async function listRecentFilesInDirectory(rule, context) {
    const resolvedPath = resolveRulePath(rule.path);
    if (!resolvedPath) {
        throw new Error('未配置目录路径。');
    }

    const directoryStat = await fsPromises.stat(resolvedPath);
    if (!directoryStat.isDirectory()) {
        throw new Error(`目标不是目录：${rule.path}`);
    }

    const startMs = context.startedAt ? new Date(context.startedAt).getTime() : 0;
    const thresholdMs = Math.max(0, startMs - 2000);
    const fileNameNeedle = String(rule.fileNameContains || '').trim();
    const entries = await fsPromises.readdir(resolvedPath, { withFileTypes: true });
    const recentFiles = [];

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (fileNameNeedle && !entry.name.includes(fileNameNeedle)) continue;

        const fullPath = path.join(resolvedPath, entry.name);
        const stat = await fsPromises.stat(fullPath);
        if (stat.mtimeMs >= thresholdMs) {
            recentFiles.push({
                fullPath,
                relativePath: toProjectRelativePath(fullPath),
                stat
            });
        }
    }

    return recentFiles.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

async function evaluateAcceptanceRule(rule, context) {
    const normalizedType = normalizeRuleType(rule.type);

    if (normalizedType === 'task_echo_contains') {
        const passed = !!rule.value && String(context.taskEcho?.raw || '').includes(rule.value);
        return {
            type: rule.label,
            status: passed ? '通过' : '未通过',
            message: passed ? `任务回声包含：${rule.value}` : `任务回声未包含：${rule.value}`
        };
    }

    if (normalizedType === 'task_echo_status') {
        const actualStatus = String(context.taskEcho?.statusText || context.taskEcho?.status || '').trim();
        const passed = !!rule.value && actualStatus.includes(rule.value);
        return {
            type: rule.label,
            status: passed ? '通过' : '未通过',
            message: passed ? `任务回声状态符合：${rule.value}` : `任务回声状态未达到：${rule.value}`
        };
    }

    if (normalizedType === 'response_contains') {
        const passed = !!rule.value && String(context.responseText || '').includes(rule.value);
        return {
            type: rule.label,
            status: passed ? '通过' : '未通过',
            message: passed ? `响应内容包含：${rule.value}` : `响应内容未包含：${rule.value}`
        };
    }

    if (normalizedType === 'file_exists' || normalizedType === 'file_created' || normalizedType === 'file_contains') {
        const resolvedPath = resolveRulePath(rule.path);
        if (!resolvedPath) {
            return { type: rule.label, status: '未通过', message: '未配置文件路径。' };
        }

        try {
            const stat = await fsPromises.stat(resolvedPath);
            if (normalizedType === 'file_exists') {
                return {
                    type: rule.label,
                    status: '通过',
                    message: `文件存在：${rule.path}`,
                    evidence: [rule.path]
                };
            }

            if (normalizedType === 'file_created') {
                const startedAt = context.startedAt ? new Date(context.startedAt).getTime() : 0;
                const passed = stat.mtimeMs >= startedAt;
                return {
                    type: rule.label,
                    status: passed ? '通过' : '未通过',
                    message: passed ? `文件在任务开始后更新：${rule.path}` : `文件存在，但不是本轮任务开始后更新：${rule.path}`,
                    evidence: [rule.path]
                };
            }

            const content = await fsPromises.readFile(resolvedPath, 'utf-8');
            const passed = !!rule.value && content.includes(rule.value);
            return {
                type: rule.label,
                status: passed ? '通过' : '未通过',
                message: passed ? `文件包含指定内容：${rule.value}` : `文件未包含指定内容：${rule.value}`,
                evidence: [rule.path]
            };
        } catch (e) {
            return {
                type: rule.label,
                status: '未通过',
                message: `文件回响检查失败：${e.message}`,
                evidence: [rule.path]
            };
        }
    }

    if (normalizedType === 'directory_recent_file_count_at_least') {
        try {
            const recentFiles = await listRecentFilesInDirectory(rule, context);
            const expected = Math.max(parseInt(rule.value, 10) || 1, 1);
            const passed = recentFiles.length >= expected;
            return {
                type: rule.label,
                status: passed ? '通过' : '未通过',
                message: passed
                    ? `目录在本轮后新增/更新了 ${recentFiles.length} 个文件，达到至少 ${expected} 个。`
                    : `目录在本轮后仅新增/更新了 ${recentFiles.length} 个文件，未达到至少 ${expected} 个。`,
                evidence: recentFiles.slice(0, 10).map(item => item.relativePath)
            };
        } catch (e) {
            return {
                type: rule.label,
                status: '未通过',
                message: `目录回响检查失败：${e.message}`,
                evidence: [rule.path]
            };
        }
    }

    if (normalizedType === 'directory_recent_file_contains' || normalizedType === 'directory_recent_file_name_contains') {
        try {
            const recentFiles = await listRecentFilesInDirectory(rule, context);
            if (recentFiles.length === 0) {
                return {
                    type: rule.label,
                    status: '未通过',
                    message: '目录中未找到本轮新增/更新的文件。',
                    evidence: [rule.path]
                };
            }

            if (normalizedType === 'directory_recent_file_name_contains') {
                const matchedByName = recentFiles.filter(item => path.basename(item.fullPath).includes(rule.value));
                const passed = matchedByName.length > 0;
                return {
                    type: rule.label,
                    status: passed ? '通过' : '未通过',
                    message: passed ? `目录中找到文件名包含：${rule.value}` : `目录中未找到文件名包含：${rule.value}`,
                    evidence: (passed ? matchedByName : recentFiles).slice(0, 10).map(item => item.relativePath)
                };
            }

            for (const item of recentFiles) {
                const content = await fsPromises.readFile(item.fullPath, 'utf-8');
                if (content.includes(rule.value)) {
                    return {
                        type: rule.label,
                        status: '通过',
                        message: `目录新增/更新文件包含指定内容：${rule.value}`,
                        evidence: [item.relativePath]
                    };
                }
            }

            return {
                type: rule.label,
                status: '未通过',
                message: `目录新增/更新文件未包含指定内容：${rule.value}`,
                evidence: recentFiles.slice(0, 10).map(item => item.relativePath)
            };
        } catch (e) {
            return {
                type: rule.label,
                status: '未通过',
                message: `目录回响检查失败：${e.message}`,
                evidence: [rule.path]
            };
        }
    }

    return {
        type: rule.label,
        status: rule.required ? '未通过' : '跳过',
        message: `暂不支持的回响锚点类型：${rule.type}`
    };
}

function inferDiaryAnchors(task) {
    const prompt = String(task?.payload?.promptTemplate || '');
    const anchors = [];
    const seen = new Set();
    const fileNameSuffix = inferFileNameSuffix(prompt);
    const identityInFileName = /fileName\s*后缀[\s\S]{0,80}你的名字/.test(prompt);
    const addAnchor = (diaryName, fileNameContains = '') => {
        const name = String(diaryName || '').trim();
        if (!name) return;
        const normalizedName = name.replace(/^\[|\]$/g, '').trim();
        if (!normalizedName) return;
        const key = `${normalizedName}::${fileNameContains}`;
        if (seen.has(key)) return;
        seen.add(key);
        anchors.push({
            diaryName: normalizedName,
            path: `dailynote/${normalizedName}`,
            fileNameContains: String(fileNameContains || '').trim(),
            identityInFileName
        });
    };

    const maidMatches = prompt.matchAll(/maidName\s*使用\s*[:：]\s*\[([^\]]+)\]/g);
    for (const match of maidMatches) {
        addAnchor(match[1], fileNameSuffix);
    }

    const mustWriteMatches = prompt.matchAll(/(?:必须|新增|写入|沉淀进|落到|留下).*?\[([^\]]+)\]/g);
    for (const match of mustWriteMatches) {
        addAnchor(match[1], fileNameSuffix);
    }

    return anchors;
}

function inferFileNameSuffix(prompt) {
    const match = String(prompt || '').match(/fileName\s*后缀(?:统一)?(?:使用)?\s*[:：]\s*([^\n\r]+)/);
    if (!match) return '';
    return match[1]
        .replace(/[`"'“”]/g, '')
        .replace(/你的名字/g, '')
        .trim();
}

async function evaluateUnifiedDiaryAnchor(anchor, context, task) {
    const baseRule = {
        label: `落点锚点：${anchor.diaryName}`,
        path: anchor.path,
        fileNameContains: anchor.fileNameContains,
        value: '1',
        required: true
    };
    const countResult = await evaluateAcceptanceRule({
        ...baseRule,
        type: '目录最近文件数至少'
    }, context);
    const results = [countResult];

    for (const agentName of task?.targets?.agents || []) {
        if (/^random\d+$/i.test(agentName)) continue;
        if (anchor.identityInFileName) {
            const fileNameResult = await evaluateAcceptanceRule({
                type: '目录最近文件名包含',
                label: `身份文件锚点：${agentName}`,
                path: anchor.path,
                fileNameContains: anchor.fileNameContains,
                value: agentName,
                required: true
            }, context);
            results.push(fileNameResult);
        }
        const contentResult = await evaluateAcceptanceRule({
            type: '目录最近文件包含',
            label: `身份内容锚点：${agentName}`,
            path: anchor.path,
            fileNameContains: anchor.fileNameContains,
            value: agentName,
            required: true
        }, context);
        results.push(contentResult);
    }

    return results;
}

async function createAcceptanceSummary(taskEcho, context = {}, task = null) {
    const results = [];

    if (!taskEcho?.found) {
        results.push({
            type: '任务回声',
            status: '未通过',
            message: '未收到可解析的【任务回声】，无法确认任务真实完成。'
        });
    } else if (taskEcho.status === 'completed') {
        results.push({
            type: '任务回声',
            status: '通过',
            message: taskEcho.compatible
                ? 'Agent 已完成委托；任务中心按委托回声完成语义兼容识别。'
                : 'Agent 已用任务回声声明本轮完成。'
        });
    } else {
        results.push({
            type: '任务回声',
            status: '未通过',
            message: `Agent 回声状态为：${taskEcho.statusText}`
        });
    }

    const echoRaw = String(taskEcho?.raw || '');
    for (const [label, value] of [
        ['动作锚点', '本轮主动动作'],
        ['公开痕迹锚点', '我留下的公开痕迹'],
        ['未来锚点', '给未来自己的锚点']
    ]) {
        const passed = !!taskEcho?.found && echoRaw.includes(value);
        results.push({
            type: label,
            status: passed || taskEcho?.compatible ? '通过' : '未通过',
            message: passed
                ? `任务回声包含「${value}」。`
                : (taskEcho?.compatible ? `委托回声已兼容通过；建议后续直接输出「${value}」。` : `任务回声缺少「${value}」。`)
        });
    }

    const anchors = inferDiaryAnchors(task);
    if (anchors.length === 0) {
        results.push({
            type: '落点锚点',
            status: '通过',
            message: '本任务未声明固定日记落点，按回声与委托完成状态确认。'
        });
    } else {
        for (const anchor of anchors) {
            results.push(...await evaluateUnifiedDiaryAnchor(anchor, {
                ...context,
                taskEcho
            }, task));
        }
    }

    return results;
}

function hasRequiredAcceptanceFailure(acceptance = []) {
    return acceptance.some(item => item.status === '未通过');
}

function collectArtifacts(acceptance = []) {
    const artifacts = new Set();
    for (const item of acceptance) {
        for (const evidence of item?.evidence || []) {
            if (evidence) artifacts.add(evidence);
        }
    }
    return Array.from(artifacts);
}

function mapRunStatusToText(status) {
    const map = {
        running: '执行中',
        submitted: '已提交委托',
        waiting_echo: '等待回声',
        completed: '已完成',
        error: '执行失败',
        failed: '执行失败',
        timeout: '等待超时',
        acceptance_failed: '主动性回响未通过',
        legacy_unverified: '旧记录未验证'
    };
    return map[status] || '旧记录未验证';
}

function normalizeHistoryForDisplay(item) {
    const hasRunDetail = !!item.runId || (item.id && fs.existsSync(getRunFilePath(item.id)));
    const legacySuccess = ['success', 'partial_success'].includes(item.status);
    const status = item.statusText
        ? item.status
        : (legacySuccess && !hasRunDetail ? 'legacy_unverified' : item.status);

    return {
        ...item,
        runId: item.runId || item.id || null,
        status,
        statusText: item.statusText || mapRunStatusToText(status),
        hasRunDetail
    };
}

async function saveRunDetail(runDetail) {
    await ensureStorageDirs();
    await atomicWriteJson(getRunFilePath(runDetail.runId), runDetail);
}

async function getRunDetail(runId) {
    if (!runId) {
        throw new Error('缺少 runId');
    }

    const filePath = getRunFilePath(runId);
    if (fs.existsSync(filePath)) {
        return readJsonFile(filePath);
    }

    const legacy = (taskCenterData.history || []).find(item => item.id === runId || item.runId === runId);
    if (legacy) {
        return {
            runId,
            legacy: true,
            status: 'legacy_unverified',
            statusText: '旧记录未验证',
            summary: normalizeHistoryForDisplay(legacy),
            message: '旧记录缺少完整运行详情，只能显示当时保存的摘要。'
        };
    }

    throw new Error(`运行记录不存在: ${runId}`);
}

function updateHistoryRecord(runId, patch) {
    const index = (taskCenterData.history || []).findIndex(item => item.id === runId || item.runId === runId);
    if (index !== -1) {
        taskCenterData.history[index] = {
            ...taskCenterData.history[index],
            ...patch
        };
    }
}

async function finalizeDelegationRun(runId, finalStatus, finalText, errorMessage = null) {
    const runDetail = await getRunDetail(runId);
    if (runDetail.legacy) return;

    const task = getTaskById(runDetail.taskId);
    const finishedAt = new Date();
    const responseText = [
        ...(runDetail.dispatchResults || []).map(item => item.text).filter(Boolean),
        finalText
    ].filter(Boolean).join('\n\n');
    const taskEcho = parseTaskEcho(responseText);
    const acceptance = await createAcceptanceSummary(taskEcho, {
        responseText,
        startedAt: runDetail.startedAt
    }, task);
    const artifacts = collectArtifacts(acceptance);

    let status = finalStatus === 'timeout' ? 'timeout' : (finalStatus === 'failed' ? 'failed' : 'completed');
    let statusText = finalStatus === 'timeout' ? '等待超时' : (finalStatus === 'failed' ? '执行失败' : '已完成');
    if (status === 'completed' && !taskEcho.found) {
        status = 'waiting_echo';
        statusText = '等待回声';
    } else if (status === 'completed' && taskEcho.status !== 'completed') {
        status = taskEcho.status === 'needs_confirmation' ? 'acceptance_failed' : 'failed';
        statusText = taskEcho.status === 'needs_confirmation' ? '需要彦确认' : '执行失败';
    } else if (status === 'completed' && hasRequiredAcceptanceFailure(acceptance)) {
        status = 'acceptance_failed';
        statusText = '主动性回响未通过';
    }

    runDetail.finishedAt = finishedAt.toISOString();
    runDetail.durationMs = runDetail.startedAt ? finishedAt.getTime() - new Date(runDetail.startedAt).getTime() : runDetail.durationMs;
    runDetail.status = status;
    runDetail.statusText = statusText;
    runDetail.taskEcho = taskEcho;
    runDetail.systemAcceptance = acceptance;
    runDetail.artifacts = artifacts;
    runDetail.delegationFinalText = finalText;
    runDetail.error = errorMessage;
    await saveRunDetail(runDetail);

    const message = errorMessage || `${statusText}（异步委托已回响）`;
    updateHistoryRecord(runId, {
        finishedAt: runDetail.finishedAt,
        durationMs: runDetail.durationMs,
        status,
        statusText,
        message,
        hasRunDetail: true
    });

    if (task) {
        task.runtime.running = false;
        task.runtime.status = status;
        task.runtime.statusText = statusText;
        task.runtime.lastFinishTime = runDetail.finishedAt;
        task.runtime.lastDurationMs = runDetail.durationMs;
        task.runtime.lastResult = message;
        task.runtime.lastError = errorMessage;
        if (status === 'completed') task.runtime.successCount += 1;
        else task.runtime.errorCount += 1;
        task.meta.updatedAt = runDetail.finishedAt;
    }

    await saveData();
    broadcastStatusUpdate();
}

function monitorDelegationRun(runId) {
    const startedAt = Date.now();

    async function poll() {
        try {
            const runDetail = await getRunDetail(runId);
            if (runDetail.legacy || !['submitted', 'waiting_echo'].includes(runDetail.status)) {
                return;
            }

            const delegationIds = Array.isArray(runDetail.delegationIds) ? runDetail.delegationIds : [];
            if (delegationIds.length === 0) return;

            const results = [];
            for (const delegation of delegationIds) {
                const result = await queryDelegationStatus(delegation.delegationId);
                results.push({ ...delegation, ...result });
            }

            runDetail.delegationPolls = results.map(item => ({
                agentName: item.agentName,
                delegationId: item.delegationId,
                state: item.state,
                checkedAt: new Date().toISOString(),
                text: item.text
            }));
            await saveRunDetail(runDetail);

            if (results.every(item => item.state === 'completed' || item.state === 'failed')) {
                const failed = results.filter(item => item.state === 'failed');
                const finalText = results.map(item => `【${item.agentName} 委托回声】\n${item.text}`).join('\n\n');
                await finalizeDelegationRun(
                    runId,
                    failed.length > 0 ? 'failed' : 'completed',
                    finalText,
                    failed.length > 0 ? failed.map(item => `${item.agentName}: ${item.text}`).join('\n\n') : null
                );
                return;
            }

            if (Date.now() - startedAt > DELEGATION_MAX_WAIT_MS) {
                await finalizeDelegationRun(runId, 'timeout', '', `异步委托等待超过 ${Math.round(DELEGATION_MAX_WAIT_MS / 60000)} 分钟，已标记为等待超时。`);
                return;
            }

            setTimeout(poll, DELEGATION_POLL_INTERVAL_MS).unref?.();
        } catch (e) {
            console.error(`[TaskAssistant] 异步委托轮询失败 (${runId}):`, e.message);
            if (Date.now() - startedAt <= DELEGATION_MAX_WAIT_MS) {
                setTimeout(poll, DELEGATION_POLL_INTERVAL_MS).unref?.();
            }
        }
    }

    setTimeout(poll, DELEGATION_POLL_INTERVAL_MS).unref?.();
}

function resumePendingDelegationRuns() {
    for (const item of taskCenterData.history || []) {
        if (item?.runId && ['submitted', 'waiting_echo'].includes(item.status) && item.hasRunDetail) {
            monitorDelegationRun(item.runId);
        }
    }
}

async function executeTask(taskId, triggerSource = 'scheduler') {
    if (!taskCenterData.globalEnabled && triggerSource === 'scheduler') {
        return { skipped: true, reason: 'global-disabled' };
    }

    const task = getTaskById(taskId);
    if (!task) {
        throw new Error(`任务不存在: ${taskId}`);
    }

    if (!task.enabled && triggerSource === 'scheduler') {
        return { skipped: true, reason: 'task-disabled' };
    }

    if (!Array.isArray(task.targets.agents) || task.targets.agents.length === 0) {
        throw new Error('任务未配置目标 Agent');
    }

    if (task.runtime.running) {
        // 🛡️ 卡死检测：如果 running=true 但距上次开始运行已超过 10 分钟，强制重置
        const STALE_RUNNING_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟
        const lastRunAt = task.runtime.lastRunTime ? new Date(task.runtime.lastRunTime).getTime() : 0;
        if (Date.now() - lastRunAt > STALE_RUNNING_TIMEOUT_MS) {
            console.warn(`[TaskAssistant] 🛡️ 检测到任务 "${task.name}" 卡死 (running=true 但已过 ${Math.round((Date.now() - lastRunAt) / 60000)} 分钟)，强制重置`);
            task.runtime.running = false;
            task.runtime.lastError = '任务执行超时，已自动重置 running 标志';
        } else {
            return { skipped: true, reason: 'already-running' };
        }
    }

    const runId = createRunId();
    const startedAt = new Date();
    task.runtime.running = true;
    task.runtime.status = 'running';
    task.runtime.statusText = '执行中';
    task.runtime.latestRunId = runId;
    task.runtime.lastRunTime = startedAt.toISOString();
    task.runtime.lastError = null;
    task.runtime.lastResult = `执行中：${triggerSource}`;
    task.runtime.runCount += 1;
    task.meta.updatedAt = new Date().toISOString();
    await saveData();

    let agentsToExecute = [...task.targets.agents];
    let randomTag = null;
    let prompt = '';
    let runFinalized = false;
    const runDetail = {
        runId,
        taskId: task.id,
        taskName: task.name,
        type: task.type,
        triggerSource,
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        durationMs: null,
        status: 'running',
        statusText: '执行中',
        agents: [],
        failedAgents: [],
        originalAgents: task.targets.agents,
        randomTag: null,
        delegationIds: [],
        promptSummary: '',
        dispatchResults: [],
        taskEcho: null,
        systemAcceptance: [],
        artifacts: [],
        error: null
    };
    await saveRunDetail(runDetail);

    try {
        task.acceptanceRules = validateResonanceRules(task);
        const basePrompt = await buildTaskPrompt(task);
        if (!String(basePrompt || '').trim()) {
            throw new Error('任务提示词为空');
        }
        prompt = `${TASK_CENTER_PROMPT_WRAP}\n${basePrompt}`;
        runDetail.promptSummary = prompt.length > 500 ? `${prompt.slice(0, 500)}...` : prompt;

        // --- 随机逻辑处理 ---
        const rIndex = agentsToExecute.findIndex(a => /^random(\d+)$/i.test(a));
        if (rIndex !== -1) {
            randomTag = agentsToExecute[rIndex];
            const match = randomTag.match(/^random(\d+)$/i);
            const n = parseInt(match[1], 10);
            
            // 过滤掉标签，剩下的是候选人
            const candidates = agentsToExecute.filter((_, idx) => idx !== rIndex);
            if (candidates.length > 0) {
                const pickCount = Math.min(Math.max(1, n), candidates.length);
                // Fisher-Yates Shuffle
                for (let i = candidates.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
                }
                agentsToExecute = candidates.slice(0, pickCount);
            } else {
                agentsToExecute = [];
            }
        }
        // ------------------

        const dispatchResults = [];
        const dispatchErrors = [];
        if (agentsToExecute.length === 0) {
            throw new Error('经过随机过滤后没有可执行的 Agent');
        }

        console.log(`[TaskAssistant] 开始派发任务 "${task.name}" 给 ${agentsToExecute.length} 个 Agent: ${agentsToExecute.join(', ')}`);

        for (const agentName of agentsToExecute) {
            try {
                const dispatchResult = await wakeUpAgent(agentName, prompt, task.dispatch);
                const parsedResult = parseToolResponse(dispatchResult);
                const delegationId = extractDelegationId(parsedResult.text);
                if (delegationId) {
                    runDetail.delegationIds.push({ agentName, delegationId });
                }

                runDetail.dispatchResults.push({
                    agentName,
                    httpStatus: parsedResult.httpStatus,
                    pluginStatus: parsedResult.pluginStatus,
                    delegationId,
                    text: parsedResult.text,
                    rawBody: parsedResult.rawBody
                });

                if (dispatchResult.status < 200 || dispatchResult.status >= 300) {
                    const errMsg = `Agent ${agentName} 收到异常响应: HTTP ${dispatchResult.status}`;
                    console.error(`[TaskAssistant] ${errMsg}`);
                    dispatchErrors.push({ agentName, error: errMsg });
                } else if (parsedResult.pluginStatus && parsedResult.pluginStatus !== 'success') {
                    const errMsg = `Agent ${agentName} 插件返回失败: ${parsedResult.pluginError || parsedResult.text || '未知错误'}`;
                    console.error(`[TaskAssistant] ${errMsg}`);
                    dispatchErrors.push({ agentName, error: errMsg });
                } else {
                    console.log(`[TaskAssistant] Agent ${agentName} 派发成功 (HTTP ${dispatchResult.status})`);
                    dispatchResults.push({
                        agentName,
                        status: dispatchResult.status,
                        pluginStatus: parsedResult.pluginStatus,
                        text: parsedResult.text
                    });
                }
            } catch (agentErr) {
                const errMsg = `Agent ${agentName} 派发异常: ${agentErr.message}`;
                console.error(`[TaskAssistant] ${errMsg}`);
                dispatchErrors.push({ agentName, error: errMsg });
            }
        }

        const finishedAt = new Date();
        task.runtime.running = false;
        task.runtime.lastFinishTime = finishedAt.toISOString();
        task.runtime.lastDurationMs = finishedAt.getTime() - startedAt.getTime();
        runDetail.finishedAt = finishedAt.toISOString();
        runDetail.durationMs = task.runtime.lastDurationMs;
        runDetail.randomTag = randomTag;

        // 判定整体状态：全部失败则标记为错误，部分成功则标记为部分成功
        if (dispatchResults.length === 0) {
            // 所有 Agent 都失败了
            const errorSummary = dispatchErrors.map(e => e.error).join('; ');
            task.runtime.status = 'failed';
            task.runtime.statusText = '执行失败';
            task.runtime.lastResult = `执行失败：所有 Agent 均失败`;
            task.runtime.lastError = errorSummary;
            task.runtime.errorCount += 1;
            task.meta.updatedAt = finishedAt.toISOString();
            runDetail.status = 'failed';
            runDetail.statusText = '执行失败';
            runDetail.agents = [];
            runDetail.failedAgents = dispatchErrors.map(e => e.agentName);
            runDetail.error = errorSummary;

            appendHistory({
                id: runId,
                runId,
                taskId: task.id,
                taskName: task.name,
                type: task.type,
                triggerSource,
                startedAt: startedAt.toISOString(),
                finishedAt: finishedAt.toISOString(),
                durationMs: task.runtime.lastDurationMs,
                status: 'failed',
                statusText: '执行失败',
                agents: agentsToExecute,
                originalAgents: task.targets.agents,
                randomTag,
                hasRunDetail: true,
                message: errorSummary
            });

            await saveRunDetail(runDetail);
            await saveData();
            runFinalized = true;
            throw new Error(errorSummary);
        }

        // 有至少一个 Agent 成功
        const hasPartialErrors = dispatchErrors.length > 0;
        const combinedText = dispatchResults.map(item => item.text).filter(Boolean).join('\n\n');
        const taskEcho = parseTaskEcho(combinedText);
        const acceptance = await createAcceptanceSummary(taskEcho, {
            responseText: combinedText,
            startedAt: startedAt.toISOString()
        }, task);
        const artifacts = collectArtifacts(acceptance);
        const hasDelegation = runDetail.delegationIds.length > 0;
        let statusLabel = 'completed';
        let statusText = '已完成';

        if (hasDelegation && !taskEcho.found) {
            statusLabel = 'submitted';
            statusText = '已提交委托';
        } else if (!taskEcho.found) {
            statusLabel = 'waiting_echo';
            statusText = '等待回声';
        } else if (taskEcho.status === 'completed') {
            if (hasRequiredAcceptanceFailure(acceptance)) {
                statusLabel = 'acceptance_failed';
                statusText = '主动性回响未通过';
            } else {
                statusLabel = 'completed';
                statusText = hasPartialErrors ? '部分完成' : '已完成';
            }
        } else if (taskEcho.status === 'waiting') {
            statusLabel = 'waiting_echo';
            statusText = '等待回声';
        } else if (taskEcho.status === 'needs_confirmation') {
            statusLabel = 'acceptance_failed';
            statusText = '需要彦确认';
        } else {
            statusLabel = 'failed';
            statusText = '执行失败';
        }

        const resultMsg = `${statusText}（${dispatchResults.length}/${agentsToExecute.length} Agent 已响应${randomTag ? `，${randomTag} 随机选择` : ''}）`;

        task.runtime.lastResult = resultMsg;
        task.runtime.status = statusLabel;
        task.runtime.statusText = statusText;
        if (statusLabel === 'completed') {
            task.runtime.successCount += 1;
        } else if (['failed', 'acceptance_failed', 'timeout'].includes(statusLabel)) {
            task.runtime.errorCount += 1;
        }
        task.runtime.lastError = hasPartialErrors ? dispatchErrors.map(e => e.error).join('; ') : null;
        task.meta.updatedAt = finishedAt.toISOString();
        runDetail.status = statusLabel;
        runDetail.statusText = statusText;
        runDetail.agents = dispatchResults.map(r => r.agentName);
        runDetail.failedAgents = dispatchErrors.map(e => e.agentName);
        runDetail.taskEcho = taskEcho;
        runDetail.systemAcceptance = acceptance;
        runDetail.artifacts = artifacts;
        runDetail.error = hasPartialErrors ? dispatchErrors.map(e => e.error).join('; ') : null;

        appendHistory({
            id: runId,
            runId,
            taskId: task.id,
            taskName: task.name,
            type: task.type,
            triggerSource,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: task.runtime.lastDurationMs,
            status: statusLabel,
            statusText,
            agents: dispatchResults.map(r => r.agentName),
            failedAgents: dispatchErrors.map(e => e.agentName),
            originalAgents: task.targets.agents,
            randomTag,
            hasRunDetail: true,
            message: resultMsg
        });

        await saveRunDetail(runDetail);
        await saveData();
        if (hasDelegation && statusLabel === 'submitted') {
            monitorDelegationRun(runId);
        }
        runFinalized = true;
        return {
            success: true,
            message: resultMsg,
            executedAgents: dispatchResults.map(r => r.agentName),
            failedAgents: dispatchErrors
        };
    } catch (e) {
        // 仅处理 buildTaskPrompt / 随机过滤 等前置阶段的异常，以及全部 Agent 失败时的 rethrow
        if (!runFinalized) {
            // 前置阶段异常（prompt构建失败等），需要手动更新 runtime
            const finishedAt = new Date();
            task.runtime.running = false;
            task.runtime.status = 'failed';
            task.runtime.statusText = '执行失败';
            task.runtime.lastFinishTime = finishedAt.toISOString();
            task.runtime.lastDurationMs = finishedAt.getTime() - startedAt.getTime();
            task.runtime.lastResult = `执行失败：${e.message}`;
            task.runtime.lastError = e.message;
            task.runtime.errorCount += 1;
            task.meta.updatedAt = finishedAt.toISOString();
            runDetail.finishedAt = finishedAt.toISOString();
            runDetail.durationMs = task.runtime.lastDurationMs;
            runDetail.status = 'failed';
            runDetail.statusText = '执行失败';
            runDetail.agents = agentsToExecute;
            runDetail.error = e.message;

            appendHistory({
                id: runId,
                runId,
                taskId: task.id,
                taskName: task.name,
                type: task.type,
                triggerSource,
                startedAt: startedAt.toISOString(),
                finishedAt: finishedAt.toISOString(),
                durationMs: task.runtime.lastDurationMs,
                status: 'failed',
                statusText: '执行失败',
                agents: agentsToExecute,
                originalAgents: task.targets.agents,
                randomTag,
                hasRunDetail: true,
                message: e.message
            });

            await saveRunDetail(runDetail);
            await saveData();
        }
        throw e;
    }
}

function clearTaskTimer(taskId) {
    const timer = activeTimers.get(taskId);
    if (timer) {
        if (typeof timer.cancel === 'function') {
            timer.cancel(); // node-schedule Job
        } else {
            clearInterval(timer);
            clearTimeout(timer);
        }
        activeTimers.delete(taskId);
    }
}

function stopAllTimers() {
    for (const taskId of activeTimers.keys()) {
        const timer = activeTimers.get(taskId);
        if (timer && typeof timer.cancel === 'function') {
            timer.cancel();
        } else {
            clearInterval(timer);
            clearTimeout(timer);
        }
    }
    activeTimers.clear();
}

function computeNextRunTime(task) {
    if (!taskCenterData.globalEnabled || !task.enabled) return null;
    if (task.schedule.mode === 'manual') return null;

    if (task.schedule.mode === 'once') {
        return task.schedule.runAt || null;
    }

    if (task.schedule.mode === 'cron') {
        return '由 CRON 引擎调度';
    }

    const intervalMs = Math.max(task.schedule.intervalMinutes || 60, MIN_INTERVAL_MINUTES) * 60 * 1000;
    return new Date(Date.now() + intervalMs).toISOString();
}

function scheduleTask(task) {
    if (!task.enabled) return;

    clearTaskTimer(task.id);

    const mode = task.schedule.mode;
    if (mode === 'manual') {
        task.runtime.nextRunTime = null;
        return;
    }

    try {
        let job;
        if (mode === 'once') {
            const runAt = new Date(task.schedule.runAt);
            if (!isNaN(runAt.getTime()) && runAt > new Date()) {
                job = schedule.scheduleJob(runAt, async () => {
                    try {
                        await executeTask(task.id, 'once-scheduler');
                    } catch (e) {
                        console.error(`[TaskAssistant] once-scheduler 执行失败 (${task.id}):`, e.message);
                    }
                    // 一次性任务执行后禁用
                    const t = taskCenterData.tasks.find(i => i.id === task.id);
                    if (t) {
                        t.enabled = false;
                        await saveData();
                        broadcastStatusUpdate();
                    }
                });
                task.runtime.nextRunTime = runAt.toISOString();
            } else {
                task.runtime.nextRunTime = '时间无效或已过';
            }
        } else if (mode === 'interval') {
            const intervalMinutes = Math.max(task.schedule.intervalMinutes || 60, MIN_INTERVAL_MINUTES);
            const intervalMs = intervalMinutes * 60 * 1000;

            const nextTime = new Date(Date.now() + intervalMs);
            job = schedule.scheduleJob(nextTime, async function runAndReschedule() {
                try {
                    await executeTask(task.id, 'interval-scheduler');
                } catch (e) {
                    console.error(`[TaskAssistant] interval-scheduler 执行失败 (${task.id}):`, e.message);
                }
                // 无论任务成功与否，都继续调度下一轮
                const againTime = new Date(Date.now() + intervalMs);
                const nextJob = schedule.scheduleJob(againTime, runAndReschedule);
                activeTimers.set(task.id, nextJob);
                task.runtime.nextRunTime = againTime.toISOString();
                broadcastStatusUpdate();
            });
            task.runtime.nextRunTime = nextTime.toISOString();
        } else if (mode === 'cron') {
            const cronValue = task.schedule.cronValue;
            if (cronValue) {
                job = schedule.scheduleJob(cronValue, async () => {
                    try {
                        await executeTask(task.id, 'cron-scheduler');
                    } catch (e) {
                        console.error(`[TaskAssistant] cron-scheduler 执行失败 (${task.id}):`, e.message);
                    }
                    task.runtime.nextRunTime = job.nextInvocation()?.toISOString() || null;
                    broadcastStatusUpdate();
                });
                task.runtime.nextRunTime = job.nextInvocation()?.toISOString() || null;
            } else {
                task.runtime.nextRunTime = '缺少 CRON 表达式';
            }
        }

        if (job) {
            activeTimers.set(task.id, job);
        }
    } catch (err) {
        console.error(`[TaskAssistant] Error scheduling task ${task.id}:`, err);
        task.runtime.nextRunTime = '调度错误';
    }
}

async function rebuildScheduler() {
    stopAllTimers();
    for (const task of taskCenterData.tasks) {
        scheduleTask(task);
    }
    await saveData();
}

function getAvailableTaskTypes() {
    return [
        {
            type: 'forum_patrol',
            label: '论坛巡航任务',
            description: '预读取论坛帖子列表，并将结果填充进提示词模板。支持 {{forum_post_list}} 占位符。'
        },
        {
            type: 'custom_prompt',
            label: '通用提示词任务',
            description: '直接向指定 Agent 派发自定义提示词，不附带论坛预读取。'
        }
    ];
}

function getTaskTemplate(type = 'forum_patrol') {
    if (type === 'custom_prompt') {
        return normalizeTask({
            name: '新通用任务',
            type: 'custom_prompt',
            enabled: true,
            schedule: { mode: 'manual', intervalMinutes: 60 },
            targets: { agents: [] },
            dispatch: { channel: 'AgentAssistant', temporaryContact: true, maid: 'VCP系统', taskDelegation: true },
            payload: {
                promptTemplate: '',
                availablePlaceholders: []
            },
            acceptanceRules: buildDefaultResonanceRules()
        });
    }

    return normalizeTask({
        name: '新论坛巡航任务',
        type: 'forum_patrol',
        enabled: true,
        schedule: { mode: 'interval', intervalMinutes: 60 },
        targets: { agents: [] },
        dispatch: { channel: 'AgentAssistant', temporaryContact: true, maid: 'VCP系统', taskDelegation: true },
        payload: {
            promptTemplate: DEFAULT_FORUM_PROMPT,
            includeForumPostList: true,
            forumListPlaceholder: '{{forum_post_list}}',
            maxPosts: 200,
            availablePlaceholders: ['{{forum_post_list}}']
        },
        acceptanceRules: buildDefaultResonanceRules()
    });
}

function sanitizeTaskInput(input) {
    const task = normalizeTask(input);

    if (!task.name) {
        throw new Error('任务名称不能为空');
    }

    if (!task.targets.agents.length) {
        throw new Error('至少需要配置一个目标 Agent');
    }

    if (task.type === 'custom_prompt' && !String(task.payload.promptTemplate || '').trim()) {
        throw new Error('通用提示词任务必须填写提示词模板');
    }

    if (task.schedule.mode === 'once' && !task.schedule.runAt) {
        throw new Error('一次性任务必须指定执行时间');
    }

    task.acceptanceRules = validateResonanceRules(task);

    return task;
}

function getConfig() {
    return {
        config: taskCenterData,
        availableTaskTypes: getAvailableTaskTypes(),
        taskTemplates: {
            forum_patrol: getTaskTemplate('forum_patrol'),
            custom_prompt: getTaskTemplate('custom_prompt')
        }
    };
}

function getStatus() {
    return {
        globalEnabled: taskCenterData.globalEnabled,
        activeTimerCount: activeTimers.size,
        activeTimers: Array.from(activeTimers.keys()),
        tasks: taskCenterData.tasks.map(task => ({
            id: task.id,
            name: task.name,
            type: task.type,
            enabled: task.enabled,
            schedule: task.schedule,
            runtime: task.runtime,
            targets: task.targets
        })),
        history: taskCenterData.history.slice(-20).reverse().map(normalizeHistoryForDisplay)
    };
}

function listRuns({ taskId, limit = 20 } = {}) {
    const max = Math.max(Math.min(parseInt(limit, 10) || 20, 100), 1);
    return (taskCenterData.history || [])
        .filter(item => !taskId || item.taskId === taskId)
        .slice(-max)
        .reverse()
        .map(normalizeHistoryForDisplay);
}

async function updateConfig(newConfig) {
    const globalEnabled = !!newConfig.globalEnabled;
    const settings = newConfig.settings && typeof newConfig.settings === 'object'
        ? { maxHistory: Math.max(parseInt(newConfig.settings.maxHistory, 10) || MAX_HISTORY, 20) }
        : taskCenterData.settings;

    const existingTaskMap = new Map(taskCenterData.tasks.map(task => [task.id, task]));
    const tasks = Array.isArray(newConfig.tasks)
        ? newConfig.tasks.map(taskInput => {
            const existing = taskInput?.id ? existingTaskMap.get(String(taskInput.id)) : null;
            return sanitizeTaskInput({
                ...taskInput,
                runtime: existing?.runtime || taskInput?.runtime,
                meta: existing?.meta || taskInput?.meta
            });
        })
        : [];

    taskCenterData = {
        version: 2,
        globalEnabled,
        settings,
        taskIndex: buildTaskIndex(tasks),
        tasks,
        history: Array.isArray(taskCenterData.history) ? taskCenterData.history : []
    };

    await rebuildScheduler();
}

async function createTask(taskInput) {
    const task = sanitizeTaskInput({
        ...taskInput,
        id: undefined
    });
    task.id = createTaskId(task.type, task.name);
    taskCenterData.tasks.push(task);
    await rebuildScheduler();
    return task;
}

async function updateTask(taskId, taskInput) {
    const index = taskCenterData.tasks.findIndex(task => task.id === taskId);
    if (index === -1) {
        throw new Error(`任务不存在: ${taskId}`);
    }

    const task = sanitizeTaskInput({
        ...taskCenterData.tasks[index],
        ...taskInput,
        id: taskId,
        runtime: taskCenterData.tasks[index].runtime,
        meta: taskCenterData.tasks[index].meta
    });
    taskCenterData.tasks[index] = task;
    await rebuildScheduler();
    return task;
}

async function deleteTask(taskId) {
    const index = taskCenterData.tasks.findIndex(task => task.id === taskId);
    if (index === -1) {
        throw new Error(`任务不存在: ${taskId}`);
    }
    clearTaskTimer(taskId);
    const [removed] = taskCenterData.tasks.splice(index, 1);
    await saveData();
    return removed;
}

async function triggerTask(taskId) {
    const task = getTaskById(taskId);
    if (!task) {
        throw new Error(`任务不存在: ${taskId}`);
    }
    const result = await executeTask(taskId, 'manual-trigger');
    return {
        message: `任务已触发: ${task.name}`,
        result
    };
}

function initialize(config) {
    VCP_PORT = config.PORT || '8080';
    VCP_KEY = config.Key || '';
    PROJECT_BASE_PATH = config.PROJECT_BASE_PATH || '';
    DEBUG_MODE = String(config.DebugMode || 'false').toLowerCase() === 'true';

    forumEngine = new ForumEngine(PROJECT_BASE_PATH);

    console.log(`[TaskAssistant] 初始化 | PORT=${VCP_PORT} | Key=${VCP_KEY ? 'FOUND' : 'NOT FOUND'}`);
    loadData()
        .then(() => rebuildScheduler())
        .then(() => resumePendingDelegationRuns())
        .then(() => {
            console.log(`[TaskAssistant] 初始化完成 | 全局开关: ${taskCenterData.globalEnabled} | 任务数: ${taskCenterData.tasks.length} | 活跃定时器: ${activeTimers.size}`);
        })
        .catch(error => {
            console.error('[TaskAssistant] 初始化失败:', error.message);
        });
}

function shutdown() {
    console.log('[TaskAssistant] 正在关闭...');
    stopAllTimers();
}

async function processToolCall(args) {
    args = args && typeof args === 'object' ? args : {};
    const command = args.command;

    switch (command) {
        case 'getTaskCenterStatus':
            return { status: 'success', result: getStatus() };

        case 'triggerTask':
            return { status: 'success', result: await triggerTask(args.taskId) };

        case 'listTaskRuns':
            return { status: 'success', result: listRuns(args || {}) };

        case 'getTaskRunDetail':
            return { status: 'success', result: await getRunDetail(args.runId) };

        case 'getTaskDraftTemplate':
            return { status: 'success', result: { template: TASK_DRAFT_TEMPLATE } };

        case 'validateTaskDraft':
            return { status: 'success', result: validateTaskDraft(args.draft || args.text || '') };

        case 'previewTaskFromDraft':
            return { status: 'success', result: previewTaskFromDraft(args.draft || args.text || '') };

        case 'createTaskFromDraft':
            return { status: 'success', result: await createTaskFromDraft(args.draft || args.text || '') };

        default:
            return {
                status: 'error',
                error: `未知或已停用的命令: ${command}`,
                availableCommands: [
                    'getTaskCenterStatus',
                    'triggerTask',
                    'listTaskRuns',
                    'getTaskRunDetail',
                    'getTaskDraftTemplate',
                    'validateTaskDraft',
                    'previewTaskFromDraft',
                    'createTaskFromDraft'
                ]
            };
    }
}

module.exports = {
    initialize,
    shutdown,
    processToolCall,
    getConfig,
    getStatus,
    updateConfig,
    createTask,
    updateTask,
    deleteTask,
    triggerTask,
    listRuns,
    getRunDetail,
    validateTaskDraft,
    previewTaskFromDraft,
    createTaskFromDraft
};
