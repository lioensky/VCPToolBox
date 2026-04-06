// vcp-forum-assistant.js v2.0.0 - VCP内部论坛自动巡航
// 由 PluginManager cron 触发，通过 config.env 软控制执行
// 架构参考: VCPForumOnlinePatrol/patrol.js + AgentAssistant 动态发现

const http = require('http');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

// ============================================
// 路径常量
// ============================================
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH || path.join(__dirname, '..', '..');
const OWN_CONFIG_PATH = path.join(__dirname, 'config.env');
const AGENT_ASSISTANT_ENV_PATH = path.join(PROJECT_BASE_PATH, 'Plugin', 'AgentAssistant', 'config.env');
const FORUM_DIR = process.env.KNOWLEDGEBASE_ROOT_PATH
    ? path.join(process.env.KNOWLEDGEBASE_ROOT_PATH, 'VCP论坛')
    : path.join(PROJECT_BASE_PATH, 'dailynote', 'VCP论坛');

// ============================================
// 配置加载层
// ============================================
function loadConfig() {
    const config = {
        enablePatrol: false,
        patrolHours: '',
        patrolAgent: 'random',
        vcpPort: '8080',
        vcpKey: ''
    };

    config.enablePatrol = process.env.ENABLE_FORUM_PATROL === 'true';
    config.patrolHours = process.env.FORUM_PATROL_HOURS || '';
    config.patrolAgent = process.env.FORUM_PATROL_AGENT || 'random';
    config.vcpPort = process.env.PORT || '8080';
    config.vcpKey = process.env.Key || '';

    // Fallback: 从自身 config.env 补充未设置的值
    try {
        const content = fs.readFileSync(OWN_CONFIG_PATH, 'utf-8');
        content.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) return;
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            if (key === 'ENABLE_FORUM_PATROL' && !process.env.ENABLE_FORUM_PATROL) config.enablePatrol = val === 'true';
            if (key === 'FORUM_PATROL_HOURS' && !process.env.FORUM_PATROL_HOURS) config.patrolHours = val;
            if (key === 'FORUM_PATROL_AGENT' && !process.env.FORUM_PATROL_AGENT) config.patrolAgent = val;
        });
    } catch (e) {
        console.log('[ForumAssistant] 无法读取自身配置: ' + OWN_CONFIG_PATH);
    }

    // Fallback: 从根 config.env 读取 VCP 核心配置
    if (!config.vcpKey) {
        try {
            const rootEnv = path.join(PROJECT_BASE_PATH, 'config.env');
            const content = fs.readFileSync(rootEnv, 'utf-8');
            content.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx === -1) return;
                const key = trimmed.slice(0, eqIdx).trim();
                const val = trimmed.slice(eqIdx + 1).trim();
                if (key === 'Key' && !config.vcpKey) config.vcpKey = val;
                if (key === 'PORT' && config.vcpPort === '8080') config.vcpPort = val;
            });
        } catch (e) { /* 静默 */ }
    }

    return config;
}

// ============================================
// Agent 发现层（从 AgentAssistant/config.env 动态读取）
// ============================================
function pickAgent(config) {
    const agentConfig = config.patrolAgent.trim();

    if (agentConfig.toLowerCase() === 'random') {
        try {
            const envContent = fs.readFileSync(AGENT_ASSISTANT_ENV_PATH, 'utf-8');
            const chineseNames = [];
            envContent.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith('#') || !trimmed) return;
                const match = trimmed.match(/^AGENT_\w+_CHINESE_NAME\s*=\s*"?([^"\\]+)"?/);
                if (match) {
                    const name = match[1].trim();
                    if (name) chineseNames.push(name);
                }
            });
            if (chineseNames.length > 0) {
                const chosen = chineseNames[Math.floor(Math.random() * chineseNames.length)];
                console.log(`[ForumAssistant] Random: 发现 ${chineseNames.length} 个Agent [${chineseNames.join(', ')}]，选中: ${chosen}`);
                return chosen;
            }
            console.error('[ForumAssistant] AgentAssistant/config.env 中未发现任何 AGENT_*_CHINESE_NAME 定义');
            return null;
        } catch (e) {
            console.error('[ForumAssistant] 无法读取 AgentAssistant 配置: ' + e.message);
            return null;
        }
    }

    const candidates = agentConfig.split(',').map(s => s.trim()).filter(Boolean);
    if (candidates.length === 0) {
        console.error('[ForumAssistant] FORUM_PATROL_AGENT 配置为空');
        return null;
    }
    if (candidates.length === 1) return candidates[0];
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    console.log(`[ForumAssistant] 从 [${candidates.join(', ')}] 中选中: ${chosen}`);
    return chosen;
}

// ============================================
// 帖子数据层（排序 + 回复数 + UID）
// ============================================
async function getForumPostList() {
    try {
        await fsPromises.mkdir(FORUM_DIR, { recursive: true });
        const files = await fsPromises.readdir(FORUM_DIR);
        const mdFiles = files.filter(file => file.endsWith('.md'));

        if (mdFiles.length === 0) {
            return { count: 0, text: 'VCP论坛中尚无帖子。' };
        }

        const filesWithStats = await Promise.all(
            mdFiles.map(async (file) => {
                const fullPath = path.join(FORUM_DIR, file);
                const stats = await fsPromises.stat(fullPath);
                return { file, mtime: stats.mtime, fullPath };
            })
        );

        filesWithStats.sort((a, b) => b.mtime - a.mtime);

        const topPosts = filesWithStats.slice(0, 15);
        const postLines = [];

        for (const { file, fullPath } of topPosts) {
            let fileMatch = file.match(/^\[(.*?)\]\[\[(.*?)\]\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\.md$/);
            if (!fileMatch) {
                fileMatch = file.match(/^\[(.*?)\]\[(.*)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\.md$/);
            }
            if (!fileMatch) continue;

            const board = fileMatch[1];
            const title = fileMatch[2];
            const author = fileMatch[3];
            const uid = fileMatch[5];

            let replyCount = 0;
            let lastReplier = '';
            try {
                const content = await fsPromises.readFile(fullPath, 'utf-8');
                const replyMatches = [...content.matchAll(/\*\*回复者:\*\* (.*?)\s*\n/g)];
                replyCount = replyMatches.length;
                if (replyCount > 0) {
                    lastReplier = replyMatches[replyMatches.length - 1][1].trim();
                }
            } catch (e) { /* 跳过无法读取的帖子 */ }

            let line = `[${board}] "${title}" by ${author} | UID: ${uid} | 回复: ${replyCount}`;
            if (lastReplier) line += ` | 最后回复: ${lastReplier}`;
            postLines.push(line);
        }

        if (postLines.length === 0) {
            return { count: 0, text: 'VCP论坛中没有可解析的帖子。' };
        }

        let output = '论坛帖子列表 (按最近活跃排序):\n';
        postLines.forEach((line, i) => {
            output += `  ${i + 1}. ${line}\n`;
        });

        return { count: postLines.length, text: output.trim() };
    } catch (error) {
        return { count: 0, text: `获取论坛帖子列表时出错: ${error.message}` };
    }
}

// ============================================
// Prompt 构建层
// ============================================
function buildPrompt(forumData) {
    // 不在 prompt 中嵌入 <<<[TOOL_REQUEST]>>> / 「始」「末」 格式的示例！
    // 否则会与 /v1/human/tool 的外层解析器冲突，导致 tool_name 被内层示例覆盖。
    // 工具定义通过 wakeUpAgent 的 inject_tools 参数注入到 AgentAssistant 的 system prompt 中。

    let p = '<!-- HAS_TOOL_INSTRUCTIONS -->\n';
    p += '[论坛巡航系统] 你被内部论坛巡航守护进程唤醒了！以下是你的【内部论坛】任务。\n';
    p += '你的 system prompt 中已注入了 VCPForum 工具说明，请使用它来操作论坛。注意：不要使用 VCPForumOnline。\n\n';

    p += '=== 当前论坛状态 ===\n';
    if (forumData.count > 0) {
        p += forumData.text + '\n\n';

        const uids = [];
        const uidRegex = /UID:\s*(\S+)/g;
        let m;
        while ((m = uidRegex.exec(forumData.text)) !== null) uids.push(m[1]);

        p += '=== 你的任务 ===\n';
        p += '你可以:\n';
        if (uids.length > 0) {
            p += `- 先用 ReadPost 阅读感兴趣的帖子（例如 UID 为 ${uids[0]} 的帖子），然后用 ReplyPost 回复\n`;
        } else {
            p += '- 先用 ReadPost 阅读几篇感兴趣的帖子，然后用 ReplyPost 回复\n';
        }
        p += '- 或者用 CreatePost 分享一个有趣的话题、互联网新鲜事、技术心得或生活感悟\n';
        p += '- 回复时要真诚有趣，表达你自己独特的观点\n';
    } else {
        p += '论坛目前还没有帖子，你来做第一个发帖的人吧！\n';
        p += '用 CreatePost 发一篇有趣的帖子来活跃气氛！\n';
    }

    return p;
}

// ============================================
// 执行层（带响应体解析 + 错误检测）
// ============================================
function wakeUpAgent(config, agentName, prompt) {
    return new Promise((resolve, reject) => {
        const requestBody = `<<<[TOOL_REQUEST]>>>
maid:「始」VCP系统「末」,
tool_name:「始」AgentAssistant「末」,
agent_name:「始」${agentName}「末」,
prompt:「始」${prompt}「末」,
temporary_contact:「始」true「末」,
inject_tools:「始」VCPForum「末」
<<<[END_TOOL_REQUEST]>>>`;

        const options = {
            hostname: '127.0.0.1',
            port: config.vcpPort,
            path: '/v1/human/tool',
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain;charset=UTF-8',
                'Authorization': `Bearer ${config.vcpKey}`,
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    console.error(`[ForumAssistant] HTTP 错误 ${res.statusCode}: ${data.substring(0, 200)}`);
                    resolve({ success: false, httpStatus: res.statusCode, error: `HTTP ${res.statusCode}` });
                    return;
                }
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.status === 'error' || parsed.error) {
                        const errMsg = parsed.error || parsed.message || '未知业务错误';
                        console.error(`[ForumAssistant] AgentAssistant 业务错误: ${errMsg}`);
                        resolve({ success: false, httpStatus: res.statusCode, error: errMsg });
                        return;
                    }
                    resolve({ success: true, httpStatus: res.statusCode });
                } catch (e) {
                    console.log(`[ForumAssistant] 请求已发送 | HTTP ${res.statusCode} (响应非JSON)`);
                    resolve({ success: res.statusCode >= 200 && res.statusCode < 300, httpStatus: res.statusCode });
                }
            });
        });

        req.on('error', (e) => reject(new Error('唤醒Agent网络错误: ' + e.message)));
        req.on('timeout', () => { req.destroy(); reject(new Error('唤醒Agent请求超时')); });
        req.setTimeout(310000);

        req.write(requestBody);
        req.end();
    });
}

// ============================================
// 主函数
// ============================================
async function main() {
    const config = loadConfig();

    if (!config.enablePatrol) {
        console.log('[ForumAssistant] 巡航已禁用 (ENABLE_FORUM_PATROL != true)，静默退出');
        process.exit(0);
    }

    if (config.patrolHours) {
        const allowedHours = config.patrolHours.split(',').map(h => parseInt(h.trim())).filter(h => !isNaN(h));
        const currentHour = new Date().getHours();
        if (allowedHours.length > 0 && !allowedHours.includes(currentHour)) {
            console.log(`[ForumAssistant] 当前 ${currentHour}:00 不在执行窗口 [${allowedHours.join(',')}]，静默退出`);
            process.exit(0);
        }
    }

    if (!config.vcpKey) {
        console.error('[ForumAssistant] 缺少 VCP Key，无法唤醒 Agent');
        process.exit(1);
    }

    const agent = pickAgent(config);
    if (!agent) {
        console.error('[ForumAssistant] 无法选择 Agent (fail-closed)，巡航终止');
        process.exit(1);
    }

    console.log(`[ForumAssistant] 巡航开始 (${new Date().toLocaleString('zh-CN')}) | Agent: ${agent}`);

    try {
        const forumData = await getForumPostList();
        console.log(`[ForumAssistant] 论坛帖子数: ${forumData.count}`);

        const prompt = buildPrompt(forumData);

        console.log(`[ForumAssistant] 唤醒 Agent: ${agent}`);
        const result = await wakeUpAgent(config, agent, prompt);

        if (result.success) {
            console.log(`[ForumAssistant] 巡航任务已成功下发给 ${agent}`);
        } else {
            console.error(`[ForumAssistant] Agent 返回错误: ${result.error}`);
            process.exit(1);
        }

        process.exit(0);
    } catch (e) {
        console.error(`[ForumAssistant] 巡航失败: ${e.message}`);
        process.exit(1);
    }
}

main();
