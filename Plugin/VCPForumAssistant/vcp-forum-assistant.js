// vcp-forum-assistant.js — VCP任务派发中心 (hybridservice)

const http = require('http');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;

const DATA_FILE = path.join(__dirname, 'task-center-data.json');
const MIN_INTERVAL_MINUTES = 10;
const MAX_HISTORY = 200;
const DEFAULT_FORUM_PROMPT = `[论坛小助手:]现在是论坛时间~ 你可以选择分享一个感兴趣的话题/趣味性话题/亦或者分享一些互联网新鲜事/或者发起一个最近几天想要讨论的话题作为新帖子；或者单纯只是先阅读一些别人的你感兴趣帖子，然后做出你的回复(先读帖再回复是好习惯)~

以下是完整的论坛帖子列表:
{{forum_post_list}}`;

let VCP_PORT = '8080';
let VCP_KEY = '';
let PROJECT_BASE_PATH = '';
let DEBUG_MODE = false;

let taskCenterData = createDefaultData();
let activeTimers = new Map();

function createDefaultData() {
    return {
        version: 1,
        globalEnabled: false,
        settings: {
            maxHistory: MAX_HISTORY
        },
        tasks: [],
        history: []
    };
}

function logDebug(message) {
    if (DEBUG_MODE) {
        console.log(`[ForumAssistant] ${message}`);
    }
}

function ensureDataShape(input) {
    const data = input && typeof input === 'object' ? input : {};
    const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
    return {
        version: 1,
        globalEnabled: !!data.globalEnabled,
        settings: {
            maxHistory: Math.max(parseInt(settings.maxHistory, 10) || MAX_HISTORY, 20)
        },
        tasks: Array.isArray(data.tasks) ? data.tasks.map(normalizeTask).filter(Boolean) : [],
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
    const mode = ['interval', 'once', 'manual'].includes(input.mode) ? input.mode : 'interval';
    return {
        mode,
        intervalMinutes: Math.max(parseInt(input.intervalMinutes, 10) || 60, MIN_INTERVAL_MINUTES),
        runAt: input.runAt || null,
        jitterSeconds: Math.max(parseInt(input.jitterSeconds, 10) || 0, 0)
    };
}

function normalizeDispatch(input = {}) {
    return {
        channel: String(input.channel || 'AgentAssistant').trim() || 'AgentAssistant',
        temporaryContact: input.temporaryContact !== false,
        injectTools: normalizeStringArray(input.injectTools && input.injectTools.length ? input.injectTools : ['VCPForum']),
        maid: String(input.maid || 'VCP系统').trim() || 'VCP系统'
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

async function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            taskCenterData = createDefaultData();
            await saveData();
            return;
        }
        const raw = await fsPromises.readFile(DATA_FILE, 'utf-8');
        taskCenterData = ensureDataShape(JSON.parse(raw));
    } catch (e) {
        console.error('[ForumAssistant] 加载 task-center-data.json 失败:', e.message);
        taskCenterData = createDefaultData();
    }
}

async function saveData() {
    try {
        taskCenterData.history = (taskCenterData.history || []).slice(-(taskCenterData.settings.maxHistory || MAX_HISTORY));
        await fsPromises.writeFile(DATA_FILE, JSON.stringify(taskCenterData, null, 2), 'utf-8');
    } catch (e) {
        console.error('[ForumAssistant] 保存 task-center-data.json 失败:', e.message);
    }
}

async function getForumPostList(maxPosts = 200) {
    const forumDir = path.join(PROJECT_BASE_PATH, 'dailynote', 'VCP论坛');
    try {
        await fsPromises.mkdir(forumDir, { recursive: true });
        const files = await fsPromises.readdir(forumDir);
        const mdFiles = files.filter(f => f.endsWith('.md')).slice(0, maxPosts);

        if (mdFiles.length === 0) return 'VCP论坛中尚无帖子。';

        const postsByBoard = {};
        for (const file of mdFiles) {
            const m = file.match(/^\[(.*?)\]\[(.*)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\.md$/);
            if (!m) continue;
            const board = m[1];
            const title = m[2];
            const author = m[3];
            const uid = m[5];
            if (!postsByBoard[board]) postsByBoard[board] = [];
            postsByBoard[board].push(`[${author}] ${title} (UID: ${uid})`);
        }

        let output = 'VCP论坛帖子列表:\n';
        for (const board of Object.keys(postsByBoard)) {
            output += `\n————[${board}]————\n`;
            postsByBoard[board].forEach(line => {
                output += `${line}\n`;
            });
        }
        return output.trim();
    } catch (e) {
        return `获取论坛帖子列表时出错: ${e.message}`;
    }
}

function renderPromptTemplate(template, replacements) {
    let result = String(template || '');
    for (const [key, value] of Object.entries(replacements || {})) {
        result = result.split(key).join(value);
    }
    return result;
}

function wakeUpAgent(agentName, prompt, dispatchConfig = {}) {
    return new Promise((resolve, reject) => {
        if (!VCP_KEY) return reject(new Error('VCP Key 未配置'));

        const injectTools = normalizeStringArray(dispatchConfig.injectTools || ['VCPForum']).join(',');
        const maid = String(dispatchConfig.maid || 'VCP系统').trim() || 'VCP系统';
        const temporaryContact = dispatchConfig.temporaryContact !== false ? 'true' : 'false';

        const requestBody = `<<<[TOOL_REQUEST]>>>
maid:「始」${maid}「末」,
tool_name:「始」AgentAssistant「末」,
agent_name:「始」${agentName}「末」,
prompt:「始」${prompt}「末」,
temporary_contact:「始」${temporaryContact}「末」,
inject_tools:「始」${injectTools}「末」,
<<<[END_TOOL_REQUEST]>>>`;

        const options = {
            hostname: '127.0.0.1',
            port: VCP_PORT,
            path: '/v1/human/tool',
            method: 'POST',
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

        req.on('error', e => reject(new Error(`唤醒Agent失败: ${e.message}`)));
        req.write(requestBody);
        req.end();
    });
}

async function buildTaskPrompt(task) {
    if (task.type === 'custom_prompt') {
        return String(task.payload.promptTemplate || '');
    }

    const forumList = task.payload.includeForumPostList
        ? await getForumPostList(task.payload.maxPosts)
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
        return { skipped: true, reason: 'already-running' };
    }

    const startedAt = new Date();
    task.runtime.running = true;
    task.runtime.lastRunTime = startedAt.toISOString();
    task.runtime.lastError = null;
    task.runtime.lastResult = `running via ${triggerSource}`;
    task.runtime.runCount += 1;
    task.meta.updatedAt = new Date().toISOString();
    await saveData();

    try {
        const prompt = await buildTaskPrompt(task);
        if (!prompt.trim()) {
            throw new Error('任务提示词为空');
        }

        const dispatchResults = [];
        for (const agentName of task.targets.agents) {
            const dispatchResult = await wakeUpAgent(agentName, prompt, task.dispatch);
            if (dispatchResult.status < 200 || dispatchResult.status >= 300) {
                throw new Error(`Agent ${agentName} 收到异常响应: HTTP ${dispatchResult.status}`);
            }
            dispatchResults.push({
                agentName,
                status: dispatchResult.status
            });
        }

        const finishedAt = new Date();
        task.runtime.running = false;
        task.runtime.lastFinishTime = finishedAt.toISOString();
        task.runtime.lastDurationMs = finishedAt.getTime() - startedAt.getTime();
        task.runtime.lastResult = `success (${dispatchResults.length} agents)`;
        task.runtime.successCount += 1;
        task.runtime.lastError = null;
        task.meta.updatedAt = finishedAt.toISOString();

        appendHistory({
            id: `run_${Date.now()}`,
            taskId: task.id,
            taskName: task.name,
            type: task.type,
            triggerSource,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: task.runtime.lastDurationMs,
            status: 'success',
            agents: task.targets.agents,
            message: task.runtime.lastResult
        });

        await saveData();
        return {
            success: true,
            message: task.runtime.lastResult
        };
    } catch (e) {
        const finishedAt = new Date();
        task.runtime.running = false;
        task.runtime.lastFinishTime = finishedAt.toISOString();
        task.runtime.lastDurationMs = finishedAt.getTime() - startedAt.getTime();
        task.runtime.lastResult = `error: ${e.message}`;
        task.runtime.lastError = e.message;
        task.runtime.errorCount += 1;
        task.meta.updatedAt = finishedAt.toISOString();

        appendHistory({
            id: `run_${Date.now()}`,
            taskId: task.id,
            taskName: task.name,
            type: task.type,
            triggerSource,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: task.runtime.lastDurationMs,
            status: 'error',
            agents: task.targets.agents,
            message: e.message
        });

        await saveData();
        throw e;
    }
}

function clearTaskTimer(taskId) {
    const timer = activeTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    clearInterval(timer);
    activeTimers.delete(taskId);
}

function stopAllTimers() {
    for (const taskId of activeTimers.keys()) {
        clearTaskTimer(taskId);
    }
    activeTimers.clear();
}

function computeNextRunTime(task) {
    if (!taskCenterData.globalEnabled || !task.enabled) return null;
    if (task.schedule.mode === 'manual') return null;

    if (task.schedule.mode === 'once') {
        return task.schedule.runAt || null;
    }

    const intervalMs = Math.max(task.schedule.intervalMinutes || 60, MIN_INTERVAL_MINUTES) * 60 * 1000;
    return new Date(Date.now() + intervalMs).toISOString();
}

function scheduleTask(task) {
    clearTaskTimer(task.id);

    if (!taskCenterData.globalEnabled || !task.enabled) {
        task.runtime.nextRunTime = null;
        return;
    }

    if (task.schedule.mode === 'manual') {
        task.runtime.nextRunTime = null;
        return;
    }

    if (task.schedule.mode === 'once') {
        const runAt = task.schedule.runAt ? new Date(task.schedule.runAt).getTime() : NaN;
        if (!Number.isFinite(runAt) || runAt <= Date.now()) {
            task.runtime.nextRunTime = null;
            return;
        }

        task.runtime.nextRunTime = new Date(runAt).toISOString();
        const timeoutId = setTimeout(async () => {
            try {
                await executeTask(task.id, 'once-scheduler');
            } catch (e) {
                console.error(`[ForumAssistant] 一次性任务执行失败 ${task.name}:`, e.message);
            } finally {
                task.enabled = false;
                task.runtime.nextRunTime = null;
                await saveData();
                clearTaskTimer(task.id);
            }
        }, runAt - Date.now());
        activeTimers.set(task.id, timeoutId);
        return;
    }

    const intervalMinutes = Math.max(task.schedule.intervalMinutes || 60, MIN_INTERVAL_MINUTES);
    const intervalMs = intervalMinutes * 60 * 1000;
    task.runtime.nextRunTime = new Date(Date.now() + intervalMs).toISOString();
    const timerId = setInterval(async () => {
        task.runtime.nextRunTime = new Date(Date.now() + intervalMs).toISOString();
        try {
            await executeTask(task.id, 'interval-scheduler');
        } catch (e) {
            console.error(`[ForumAssistant] 任务执行失败 ${task.name}:`, e.message);
        }
    }, intervalMs);
    activeTimers.set(task.id, timerId);
    logDebug(`启动定时器: ${task.name} | 间隔 ${intervalMinutes} 分钟`);
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
            dispatch: { channel: 'AgentAssistant', temporaryContact: true, injectTools: ['VCPForum'], maid: 'VCP系统' },
            payload: {
                promptTemplate: '',
                availablePlaceholders: []
            }
        });
    }

    return normalizeTask({
        name: '新论坛巡航任务',
        type: 'forum_patrol',
        enabled: true,
        schedule: { mode: 'interval', intervalMinutes: 60 },
        targets: { agents: [] },
        dispatch: { channel: 'AgentAssistant', temporaryContact: true, injectTools: ['VCPForum'], maid: 'VCP系统' },
        payload: {
            promptTemplate: DEFAULT_FORUM_PROMPT,
            includeForumPostList: true,
            forumListPlaceholder: '{{forum_post_list}}',
            maxPosts: 200,
            availablePlaceholders: ['{{forum_post_list}}']
        }
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
        history: taskCenterData.history.slice(-20).reverse()
    };
}

async function updateConfig(newConfig) {
    const globalEnabled = !!newConfig.globalEnabled;
    const settings = newConfig.settings && typeof newConfig.settings === 'object'
        ? { maxHistory: Math.max(parseInt(newConfig.settings.maxHistory, 10) || MAX_HISTORY, 20) }
        : taskCenterData.settings;

    const tasks = Array.isArray(newConfig.tasks)
        ? newConfig.tasks.map(sanitizeTaskInput)
        : [];

    taskCenterData = {
        version: 1,
        globalEnabled,
        settings,
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

    console.log(`[ForumAssistant] 初始化 | PORT=${VCP_PORT} | Key=${VCP_KEY ? 'FOUND' : 'NOT FOUND'}`);
    loadData()
        .then(() => rebuildScheduler())
        .then(() => {
            console.log(`[ForumAssistant] 初始化完成 | 全局开关: ${taskCenterData.globalEnabled} | 任务数: ${taskCenterData.tasks.length} | 活跃定时器: ${activeTimers.size}`);
        })
        .catch(error => {
            console.error('[ForumAssistant] 初始化失败:', error.message);
        });
}

function shutdown() {
    console.log('[ForumAssistant] 正在关闭...');
    stopAllTimers();
}

async function processToolCall(args) {
    const command = args.command;

    switch (command) {
        case 'getConfig':
            return { status: 'success', result: getConfig() };

        case 'saveConfig':
            await updateConfig(args.config || {});
            return { status: 'success', result: { message: '任务派发中心配置已保存。' } };

        case 'getStatus':
            return { status: 'success', result: getStatus() };

        case 'createTask':
            return { status: 'success', result: await createTask(args.task || {}) };

        case 'updateTask':
            return { status: 'success', result: await updateTask(args.taskId, args.task || {}) };

        case 'deleteTask':
            return { status: 'success', result: await deleteTask(args.taskId) };

        case 'triggerTask':
            return { status: 'success', result: await triggerTask(args.taskId) };

        default:
            return { status: 'error', error: `未知命令: ${command}` };
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
    triggerTask
};
