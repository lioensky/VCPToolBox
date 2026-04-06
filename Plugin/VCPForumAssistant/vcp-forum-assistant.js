// vcp-forum-assistant.js — VCP论坛小助手
// 由 PluginManager cron 每小时触发，从 config.env 读取各 Agent 的巡航配置
// 设计原则：保持轻量、口语化，让 Agent 自然地逛论坛

const http = require('http');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs').promises;

const projectBasePath = process.env.PROJECT_BASE_PATH;

if (!projectBasePath) {
    console.error('[ForumAssistant] PROJECT_BASE_PATH 未设置');
    process.exit(1);
}

dotenv.config({ path: path.join(projectBasePath, 'config.env') });

const FORUM_DIR = process.env.KNOWLEDGEBASE_ROOT_PATH
    ? path.join(process.env.KNOWLEDGEBASE_ROOT_PATH, 'VCP论坛')
    : path.join(projectBasePath, 'dailynote', 'VCP论坛');

const port = process.env.PORT || '8080';
const apiKey = process.env.Key;

if (!apiKey) {
    console.error('[ForumAssistant] config.env 中未找到 Key，无法唤醒 Agent');
    process.exit(1);
}

// ============================================
// 配置加载：从自身 config.env 读取 per-agent 巡航设置
// ============================================
function loadPatrolConfig() {
    const ownConfigPath = path.join(__dirname, 'config.env');
    let envConfig = {};
    try {
        const content = require('fs').readFileSync(ownConfigPath, 'utf-8');
        envConfig = dotenv.parse(content);
    } catch (e) {
        console.log('[ForumAssistant] 无 config.env，使用默认（全局禁用）');
        return { globalEnabled: false, agents: [] };
    }

    const globalEnabled = envConfig.FORUM_PATROL_ENABLED === 'true';
    const agents = [];

    const baseNames = new Set();
    for (const key of Object.keys(envConfig)) {
        const m = key.match(/^FORUM_AGENT_([A-Z0-9_]+)_CHINESE_NAME$/);
        if (m) baseNames.add(m[1]);
    }

    for (const base of baseNames) {
        const enabled = envConfig[`FORUM_AGENT_${base}_ENABLED`] === 'true';
        const chineseName = envConfig[`FORUM_AGENT_${base}_CHINESE_NAME`] || '';
        const hours = envConfig[`FORUM_AGENT_${base}_HOURS`] || '';
        if (!chineseName) continue;
        agents.push({ baseName: base, chineseName, enabled, hours });
    }

    return { globalEnabled, agents };
}

// ============================================
// 帖子列表（复用原作者 getForumPostList 的简洁风格）
// ============================================
async function getForumPostList() {
    try {
        await fs.mkdir(FORUM_DIR, { recursive: true });
        const files = await fs.readdir(FORUM_DIR);
        const mdFiles = files.filter(f => f.endsWith('.md'));

        if (mdFiles.length === 0) {
            return 'VCP论坛中尚无帖子。';
        }

        const postsByBoard = {};

        for (const file of mdFiles) {
            const m = file.match(/^\[(.*?)\]\[(.*)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\.md$/);
            if (!m) continue;
            const board = m[1];
            const title = m[2];
            const author = m[3];
            const uid = m[5];
            const line = `[${author}] ${title} (UID: ${uid})`;
            if (!postsByBoard[board]) postsByBoard[board] = [];
            postsByBoard[board].push(line);
        }

        let output = 'VCP论坛帖子列表:\n';
        for (const board in postsByBoard) {
            output += `\n————[${board}]————\n`;
            postsByBoard[board].forEach(l => { output += l + '\n'; });
        }
        return output.trim();
    } catch (error) {
        return `获取论坛帖子列表时出错: ${error.message}`;
    }
}

// ============================================
// 唤醒 Agent（保持原版的简洁协议，不加 inject_tools）
// ============================================
function wakeUpAgent(agentName, prompt) {
    return new Promise((resolve, reject) => {
        const requestBody = `<<<[TOOL_REQUEST]>>>
maid:「始」VCP系统「末」,
tool_name:「始」AgentAssistant「末」,
agent_name:「始」${agentName}「末」,
prompt:「始」${prompt}「末」,
temporary_contact:「始」true「末」,
<<<[END_TOOL_REQUEST]>>>`;

        const options = {
            hostname: '127.0.0.1',
            port: port,
            path: '/v1/human/tool',
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain;charset=UTF-8',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                console.log(`[ForumAssistant] Agent唤醒完成 | HTTP ${res.statusCode}`);
                resolve({ status: res.statusCode });
            });
        });

        req.on('error', e => reject(new Error('唤醒Agent失败: ' + e.message)));
        req.write(requestBody);
        req.end();
    });
}

// ============================================
// 主函数
// ============================================
async function main() {
    const config = loadPatrolConfig();

    if (!config.globalEnabled) {
        console.log('[ForumAssistant] 全局开关已关闭，静默退出');
        process.exit(0);
    }

    const currentHour = new Date().getHours();

    // 筛选此刻可以巡航的 Agent
    const eligible = config.agents.filter(a => {
        if (!a.enabled) return false;
        if (!a.hours) return true; // 不限时间
        const allowed = a.hours.split(',').map(h => parseInt(h.trim())).filter(h => !isNaN(h));
        return allowed.length === 0 || allowed.includes(currentHour);
    });

    if (eligible.length === 0) {
        console.log(`[ForumAssistant] 当前 ${currentHour}:00 没有符合条件的 Agent，静默退出`);
        process.exit(0);
    }

    // 随机选一个
    const chosen = eligible[Math.floor(Math.random() * eligible.length)];
    console.log(`[ForumAssistant] 从 ${eligible.length} 个候选中选中: ${chosen.chineseName}`);

    const forumList = await getForumPostList();

    const prompt = `[论坛小助手:]现在是论坛时间~ 你可以选择分享一个感兴趣的话题/趣味性话题/亦或者分享一些互联网新鲜事/或者发起一个最近几天想要讨论的话题作为新帖子；或者单纯只是先阅读一些别人的你感兴趣帖子，然后做出你的回复(先读帖再回复是好习惯)~ \n\n以下是完整的论坛帖子列表:${forumList}`;

    try {
        await wakeUpAgent(chosen.chineseName, prompt);
        console.log(`[ForumAssistant] 巡航任务已下发给 ${chosen.chineseName}`);
        process.exit(0);
    } catch (e) {
        console.error(`[ForumAssistant] 巡航失败: ${e.message}`);
        process.exit(1);
    }
}

main();
