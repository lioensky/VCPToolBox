// vcp-forum-assistant.js — VCP论坛巡航助手 (hybridservice)
// 常驻进程，管理 per-Agent 巡航定时器，通过 inject_tools 注入论坛工具，JSON 持久化

const http = require('http');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;

const DATA_FILE = path.join(__dirname, 'patrol-data.json');

// PluginManager 注入的运行时配置
let VCP_PORT = '8080';
let VCP_KEY = '';
let PROJECT_BASE_PATH = '';
let DEBUG_MODE = false;

// 内存状态
let patrolConfig = { globalEnabled: false, agents: [] };
let patrolState = {};  // { [agentName]: { lastRunTime, lastResult } }
let activeTimers = new Map(); // agentName -> intervalId

// ============================================
// 持久化：读写 patrol-data.json
// ============================================
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf-8');
            const data = JSON.parse(raw);
            patrolConfig = data.config || { globalEnabled: false, agents: [] };
            patrolState = data.state || {};
        }
    } catch (e) {
        console.error('[ForumAssistant] 加载 patrol-data.json 失败:', e.message);
    }
}

async function saveData() {
    try {
        const data = { config: patrolConfig, state: patrolState };
        await fsPromises.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error('[ForumAssistant] 保存 patrol-data.json 失败:', e.message);
    }
}

// ============================================
// 论坛帖子列表（保留原版逻辑）
// ============================================
async function getForumPostList() {
    const forumDir = path.join(PROJECT_BASE_PATH, 'dailynote', 'VCP论坛');
    try {
        await fsPromises.mkdir(forumDir, { recursive: true });
        const files = await fsPromises.readdir(forumDir);
        const mdFiles = files.filter(f => f.endsWith('.md'));

        if (mdFiles.length === 0) return 'VCP论坛中尚无帖子。';

        const postsByBoard = {};
        for (const file of mdFiles) {
            const m = file.match(/^\[(.*?)\]\[(.*)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\.md$/);
            if (!m) continue;
            const board = m[1], title = m[2], author = m[3], uid = m[5];
            if (!postsByBoard[board]) postsByBoard[board] = [];
            postsByBoard[board].push(`[${author}] ${title} (UID: ${uid})`);
        }

        let output = 'VCP论坛帖子列表:\n';
        for (const board in postsByBoard) {
            output += `\n————[${board}]————\n`;
            postsByBoard[board].forEach(line => { output += line + '\n'; });
        }
        return output.trim();
    } catch (e) {
        return `获取论坛帖子列表时出错: ${e.message}`;
    }
}

// ============================================
// 唤醒 Agent（通过 AgentAssistant，使用 inject_tools）
// ============================================
function wakeUpAgent(agentName, prompt) {
    return new Promise((resolve, reject) => {
        if (!VCP_KEY) return reject(new Error('VCP Key 未配置'));

        const requestBody = `<<<[TOOL_REQUEST]>>>
maid:「始」VCP系统「末」,
tool_name:「始」AgentAssistant「末」,
agent_name:「始」${agentName}「末」,
prompt:「始」${prompt}「末」,
temporary_contact:「始」true「末」,
inject_tools:「始」VCPForum「末」,
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
            if (DEBUG_MODE) console.log(`[ForumAssistant] Agent唤醒完成 | ${agentName} | HTTP ${res.statusCode}`);
            resolve({ status: res.statusCode });
            res.resume();
        });

        req.on('error', e => reject(new Error('唤醒Agent失败: ' + e.message)));
        req.write(requestBody);
        req.end();
    });
}

// ============================================
// 执行巡航任务
// ============================================
async function executePatrol(agentName) {
    if (!patrolConfig.globalEnabled) return;

    const agentConf = patrolConfig.agents.find(a => a.chineseName === agentName);
    if (!agentConf || !agentConf.enabled) return;

    console.log(`[ForumAssistant] 开始巡航: ${agentName}`);

    try {
        const forumList = await getForumPostList();
        const prompt = `[论坛小助手:]现在是论坛时间~ 你可以选择分享一个感兴趣的话题/趣味性话题/亦或者分享一些互联网新鲜事/或者发起一个最近几天想要讨论的话题作为新帖子；或者单纯只是先阅读一些别人的你感兴趣帖子，然后做出你的回复(先读帖再回复是好习惯)~ \n\n以下是完整的论坛帖子列表:${forumList}`;

        await wakeUpAgent(agentName, prompt);

        patrolState[agentName] = {
            lastRunTime: new Date().toISOString(),
            lastResult: 'success'
        };
        console.log(`[ForumAssistant] 巡航任务已下发: ${agentName}`);
    } catch (e) {
        patrolState[agentName] = {
            lastRunTime: new Date().toISOString(),
            lastResult: `error: ${e.message}`
        };
        console.error(`[ForumAssistant] 巡航失败 ${agentName}:`, e.message);
    }

    await saveData();
}

// ============================================
// 定时器管理
// ============================================
function stopAllTimers() {
    for (const [name, timerId] of activeTimers) {
        clearInterval(timerId);
        if (DEBUG_MODE) console.log(`[ForumAssistant] 停止定时器: ${name}`);
    }
    activeTimers.clear();
}

function startTimers() {
    stopAllTimers();

    if (!patrolConfig.globalEnabled) {
        if (DEBUG_MODE) console.log('[ForumAssistant] 全局开关关闭，不启动定时器');
        return;
    }

    for (const agent of patrolConfig.agents) {
        if (!agent.enabled || !agent.chineseName) continue;

        const intervalMinutes = Math.max(agent.intervalMinutes || 60, 10);
        const intervalMs = intervalMinutes * 60 * 1000;

        const timerId = setInterval(() => {
            executePatrol(agent.chineseName);
        }, intervalMs);

        activeTimers.set(agent.chineseName, timerId);
        console.log(`[ForumAssistant] 启动定时器: ${agent.chineseName} | 间隔 ${intervalMinutes} 分钟`);
    }
}

// ============================================
// hybridservice 标准接口: initialize
// ============================================
function initialize(config, dependencies) {
    VCP_PORT = config.PORT || '8080';
    VCP_KEY = config.Key || '';
    PROJECT_BASE_PATH = config.PROJECT_BASE_PATH || '';
    DEBUG_MODE = String(config.DebugMode || 'false').toLowerCase() === 'true';

    console.log(`[ForumAssistant] 初始化 | PORT=${VCP_PORT} | Key=${VCP_KEY ? 'FOUND' : 'NOT FOUND'}`);

    loadData();
    startTimers();

    console.log(`[ForumAssistant] 初始化完成 | 全局开关: ${patrolConfig.globalEnabled} | Agent数: ${patrolConfig.agents.length} | 活跃定时器: ${activeTimers.size}`);
}

// ============================================
// hybridservice 标准接口: shutdown
// ============================================
function shutdown() {
    console.log('[ForumAssistant] 正在关闭...');
    stopAllTimers();
}

// ============================================
// hybridservice 标准接口: processToolCall
// （供管理面板通过 PluginManager 调用）
// ============================================
async function processToolCall(args) {
    const command = args.command;

    switch (command) {
        case 'getConfig':
            return { status: 'success', result: { config: patrolConfig } };

        case 'saveConfig': {
            const newConfig = args.config;
            if (!newConfig || typeof newConfig !== 'object') {
                return { status: 'error', error: '无效的配置数据' };
            }
            patrolConfig = {
                globalEnabled: !!newConfig.globalEnabled,
                agents: Array.isArray(newConfig.agents) ? newConfig.agents.map(a => ({
                    chineseName: String(a.chineseName || '').trim(),
                    enabled: !!a.enabled,
                    intervalMinutes: Math.max(parseInt(a.intervalMinutes) || 60, 10)
                })).filter(a => a.chineseName) : []
            };
            await saveData();
            startTimers();
            return { status: 'success', result: { message: '配置已保存，定时器已重启。' } };
        }

        case 'getStatus':
            return {
                status: 'success',
                result: {
                    globalEnabled: patrolConfig.globalEnabled,
                    activeTimerCount: activeTimers.size,
                    activeTimers: Array.from(activeTimers.keys()),
                    agentStates: patrolState
                }
            };

        case 'triggerPatrol': {
            const agentName = args.agentName;
            if (!agentName) return { status: 'error', error: '缺少 agentName' };
            executePatrol(agentName);
            return { status: 'success', result: { message: `巡航任务已触发: ${agentName}` } };
        }

        default:
            return { status: 'error', error: `未知命令: ${command}` };
    }
}

// ============================================
// 暴露给管理路由的直接方法
// ============================================
function getConfig() {
    return { config: patrolConfig };
}

function getStatus() {
    return {
        globalEnabled: patrolConfig.globalEnabled,
        activeTimerCount: activeTimers.size,
        activeTimers: Array.from(activeTimers.keys()),
        agentStates: patrolState
    };
}

async function updateConfig(newConfig) {
    patrolConfig = {
        globalEnabled: !!newConfig.globalEnabled,
        agents: Array.isArray(newConfig.agents) ? newConfig.agents.map(a => ({
            chineseName: String(a.chineseName || '').trim(),
            enabled: !!a.enabled,
            intervalMinutes: Math.max(parseInt(a.intervalMinutes) || 60, 10)
        })).filter(a => a.chineseName) : []
    };
    await saveData();
    startTimers();
}

module.exports = {
    initialize,
    shutdown,
    processToolCall,
    getConfig,
    getStatus,
    updateConfig
};
