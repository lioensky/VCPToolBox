// vcp-task-assistant.js — VCP任务派发中心 (hybridservice)

const http = require('http');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const schedule = require('node-schedule');
const ForumEngine = require('./lib/forum-engine');

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
let forumEngine = null;

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
        taskDelegation: !!input.taskDelegation
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

        // 🛡️ 启动时清理：重置所有卡死的 running 标志
        // 服务器重启后不可能有任务正在运行，running=true 只可能是上次崩溃遗留的脏状态
        let staleCount = 0;
        for (const task of taskCenterData.tasks) {
            if (task.runtime.running) {
                task.runtime.running = false;
                task.runtime.lastResult = `error: 服务器重启时发现任务卡死，已自动重置`;
                task.runtime.lastError = '服务器重启自动重置 running 标志';
                staleCount++;
            }
        }
        if (staleCount > 0) {
            console.warn(`[TaskAssistant] 🛡️ 启动清理: 重置了 ${staleCount} 个卡死的任务状态`);
            await saveData();
        }
    } catch (e) {
        console.error('[TaskAssistant] 加载 task-center-data.json 失败:', e.message);
        taskCenterData = createDefaultData();
    }
}

async function saveData() {
    try {
        taskCenterData.history = (taskCenterData.history || []).slice(-(taskCenterData.settings.maxHistory || MAX_HISTORY));
        await fsPromises.writeFile(DATA_FILE, JSON.stringify(taskCenterData, null, 2), 'utf-8');
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
    return new Promise((resolve, reject) => {
        if (!VCP_KEY) return reject(new Error('VCP Key 未配置'));

        // inject_tools 功能已禁用：Agent 自身已拥有完整工具集，无需通过任务中心额外注入
        const maid = String(dispatchConfig.maid || 'VCP系统').trim() || 'VCP系统';
        const temporaryContact = dispatchConfig.temporaryContact !== false ? 'true' : 'false';
        const taskDelegation = dispatchConfig.taskDelegation ? 'true' : 'false';

        const requestBody = `<<<[TOOL_REQUEST]>>>
maid:「始」${maid}「末」,
tool_name:「始」AgentAssistant「末」,
agent_name:「始」${agentName}「末」,
prompt:「始」${prompt}「末」,
temporary_contact:「始」${temporaryContact}「末」,
task_delegation:「始」${taskDelegation}「末」,
<<<[END_TOOL_REQUEST]>>>`;

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
            reject(new Error(`唤醒Agent超时 (${WAKEUP_TIMEOUT_MS / 1000}s): ${agentName}`));
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

    const startedAt = new Date();
    task.runtime.running = true;
    task.runtime.lastRunTime = startedAt.toISOString();
    task.runtime.lastError = null;
    task.runtime.lastResult = `running via ${triggerSource}`;
    task.runtime.runCount += 1;
    task.meta.updatedAt = new Date().toISOString();
    await saveData();

    let agentsToExecute = [...task.targets.agents];
    let randomTag = null;
    try {
        const prompt = await buildTaskPrompt(task);
        if (!prompt.trim()) {
            throw new Error('任务提示词为空');
        }

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
                if (dispatchResult.status < 200 || dispatchResult.status >= 300) {
                    const errMsg = `Agent ${agentName} 收到异常响应: HTTP ${dispatchResult.status}`;
                    console.error(`[TaskAssistant] ${errMsg}`);
                    dispatchErrors.push({ agentName, error: errMsg });
                } else {
                    console.log(`[TaskAssistant] Agent ${agentName} 派发成功 (HTTP ${dispatchResult.status})`);
                    dispatchResults.push({
                        agentName,
                        status: dispatchResult.status
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

        // 判定整体状态：全部失败则标记为错误，部分成功则标记为部分成功
        if (dispatchResults.length === 0) {
            // 所有 Agent 都失败了
            const errorSummary = dispatchErrors.map(e => e.error).join('; ');
            task.runtime.lastResult = `error: 所有 Agent 均失败`;
            task.runtime.lastError = errorSummary;
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
                agents: agentsToExecute,
                originalAgents: task.targets.agents,
                randomTag,
                message: errorSummary
            });

            await saveData();
            throw new Error(errorSummary);
        }

        // 有至少一个 Agent 成功
        const hasPartialErrors = dispatchErrors.length > 0;
        const statusLabel = hasPartialErrors ? 'partial_success' : 'success';
        const resultMsg = hasPartialErrors
            ? `partial_success (${dispatchResults.length}/${agentsToExecute.length} agents ok${randomTag ? ', picked from ' + randomTag : ''}, failed: ${dispatchErrors.map(e => e.agentName).join(',')})`
            : `success (${dispatchResults.length} agents${randomTag ? ', picked from ' + randomTag : ''})`;

        task.runtime.lastResult = resultMsg;
        task.runtime.successCount += 1;
        task.runtime.lastError = hasPartialErrors ? dispatchErrors.map(e => e.error).join('; ') : null;
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
            status: statusLabel,
            agents: dispatchResults.map(r => r.agentName),
            failedAgents: dispatchErrors.map(e => e.agentName),
            originalAgents: task.targets.agents,
            randomTag,
            message: resultMsg
        });

        await saveData();
        return {
            success: true,
            message: resultMsg,
            executedAgents: dispatchResults.map(r => r.agentName),
            failedAgents: dispatchErrors
        };
    } catch (e) {
        // 仅处理 buildTaskPrompt / 随机过滤 等前置阶段的异常，以及全部 Agent 失败时的 rethrow
        if (!task.runtime.lastFinishTime || task.runtime.running) {
            // 前置阶段异常（prompt构建失败等），需要手动更新 runtime
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
                agents: agentsToExecute,
                originalAgents: task.targets.agents,
                randomTag,
                message: e.message
            });

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
            dispatch: { channel: 'AgentAssistant', temporaryContact: true, injectTools: ['VCPForum'], maid: 'VCP系统', taskDelegation: false },
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
        dispatch: { channel: 'AgentAssistant', temporaryContact: true, injectTools: ['VCPForum'], maid: 'VCP系统', taskDelegation: false },
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

    forumEngine = new ForumEngine(PROJECT_BASE_PATH);

    console.log(`[TaskAssistant] 初始化 | PORT=${VCP_PORT} | Key=${VCP_KEY ? 'FOUND' : 'NOT FOUND'}`);
    loadData()
        .then(() => rebuildScheduler())
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
