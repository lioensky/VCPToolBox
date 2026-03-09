// patrol.js v1.0.0 - VCPForumOnline 自动巡航 (static插件版)
// 由 PluginManager cron 每整点触发，通过 config.env 软控制实际执行
// 配置文件位于 Plugin/VCPForumOnline/config.env
// Author: Nova | 2026-03-09

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// 路径常量
// ============================================
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH || path.join(__dirname, '..', '..');
const FORUM_CONFIG_PATH = path.join(__dirname, '..', 'VCPForumOnline', 'config.env');
const AGENT_ASSISTANT_ENV_PATH = path.join(PROJECT_BASE_PATH, 'Plugin', 'AgentAssistant', 'config.env');

// ============================================
// 配置加载（从 VCPForumOnline/config.env 读取）
// ============================================
function loadConfig() {
  const config = {
    forumApiUrl: '',
    forumApiKey: '',
    forumProxy: '',
    enablePatrol: false, // 默认关闭
    patrolHours: '',     // 允许执行的小时列表，空=每次心跳都执行
    patrolAgent: 'random',
    vcpPort: '8080',
    vcpKey: ''
  };

  // 优先从环境变量读取（PluginManager 会注入）
  config.forumApiUrl = process.env.FORUM_API_URL || '';
  config.forumApiKey = process.env.FORUM_API_KEY || '';
  config.forumProxy = process.env.FORUM_PROXY || '';
  config.enablePatrol = process.env.ENABLE_PATROL === 'true';
  config.patrolHours = process.env.PATROL_HOURS || '';
  config.patrolAgent = process.env.PATROL_AGENT || 'random';
  config.vcpPort = process.env.PORT || '8080';
  config.vcpKey = process.env.Key || '';

  // Fallback: 从 VCPForumOnline/config.env 读取
  try {
    const content = fs.readFileSync(FORUM_CONFIG_PATH, 'utf-8');
    content.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) return;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key === 'FORUM_API_URL' && !config.forumApiUrl) config.forumApiUrl = val;
      if (key === 'FORUM_API_KEY' && !config.forumApiKey) config.forumApiKey = val;
      if (key === 'FORUM_PROXY' && !config.forumProxy) config.forumProxy = val;
      if (key === 'ENABLE_PATROL' && !process.env.ENABLE_PATROL) config.enablePatrol = val === 'true';
      if (key === 'PATROL_HOURS' && !process.env.PATROL_HOURS) config.patrolHours = val;
      if (key === 'PATROL_AGENT' && !process.env.PATROL_AGENT) config.patrolAgent = val;
    });
  } catch (e) {
    console.log('[Patrol] 无法读取论坛配置: ' + FORUM_CONFIG_PATH);
  }

  // Fallback: 从根目录 config.env 读取 VCP 核心配置
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
    } catch (e) {}
  }

  config.forumApiUrl = config.forumApiUrl.replace(/\/+$/, '');
  return config;
}

// ============================================
// 论坛API请求
// ============================================
function forumApiRequest(config, method, endpoint) {
  return new Promise((resolve, reject) => {
    const fullUrl = config.forumApiUrl + endpoint;
    const parsed = new URL(fullUrl);
    const isHttps = parsed.protocol === 'https:';
    const targetPort = parseInt(parsed.port) || (isHttps ? 443 : 80);
    const headers = {
      'Authorization': 'Bearer ' + config.forumApiKey,
      'Content-Type': 'application/json'
    };

    function onResponse(res) {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, data: { raw: data } }); }
      });
    }
    function onError(e) { reject(new Error('网络请求失败: ' + e.message)); }

    if (config.forumProxy && isHttps) {
      const proxy = new URL(config.forumProxy);
      const connectReq = http.request({
        hostname: proxy.hostname, port: proxy.port || 7897,
        method: 'CONNECT', path: `${parsed.hostname}:${targetPort}`, timeout: 10000
      });
      connectReq.on('connect', (connectRes, socket) => {
        if (connectRes.statusCode !== 200) { socket.destroy(); reject(new Error(`代理CONNECT失败: ${connectRes.statusCode}`)); return; }
        const req = https.request({ hostname: parsed.hostname, port: targetPort, path: parsed.pathname + parsed.search, method, headers, timeout: 12000, socket, agent: false }, onResponse);
        req.on('error', onError); req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); }); req.end();
      });
      connectReq.on('error', (e) => reject(new Error('代理连接失败: ' + e.message)));
      connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error('代理连接超时')); });
      connectReq.end();
    } else if (config.forumProxy && !isHttps) {
      const proxy = new URL(config.forumProxy);
      const req = http.request({ hostname: proxy.hostname, port: proxy.port || 7897, path: fullUrl, method, headers, timeout: 12000 }, onResponse);
      req.on('error', onError); req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); }); req.end();
    } else {
      const lib = isHttps ? https : http;
      const req = lib.request({ hostname: parsed.hostname, port: targetPort, path: parsed.pathname + parsed.search, method, headers, timeout: 12000 }, onResponse);
      req.on('error', onError); req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); }); req.end();
    }
  });
}

// ============================================
// Agent选择（从AgentAssistant的CHINESE_NAME读取）
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
        console.log(`[Patrol] Random: 发现${chineseNames.length}个Agent，选中: ${chosen}`);
        return chosen;
      }
      return 'Nova';
    } catch (e) {
      console.log('[Patrol] 无法读取AgentAssistant配置，使用默认: Nova');
      return 'Nova';
    }
  }
  const candidates = agentConfig.split(',').map(s => s.trim()).filter(Boolean);
  if (candidates.length === 0) return 'Nova';
  if (candidates.length === 1) return candidates[0];
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  console.log(`[Patrol] 从 [${candidates.join(', ')}] 中选中: ${chosen}`);
  return chosen;
}
// ============================================
// 唤醒Agent（通过 /v1/human/tool 接口，参考 vcp-forum-assistant.js）
// ============================================
function wakeUpAgent(config, agentName, prompt) {
  return new Promise((resolve, reject) => {
    if (!config.vcpKey) {
      reject(new Error('未配置VCP Key，无法唤醒Agent'));
      return;
    }

    const requestBody = `<<<[TOOL_REQUEST]>>>
maid:「始」VCP系统「末」,
tool_name:「始」AgentAssistant「末」,
agent_name:「始」${agentName}「末」,
prompt:「始」${prompt}「末」,
temporary_contact:「始」true「末」,
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
      console.log(`[Patrol] Agent唤醒请求已被VCP接受 | HTTP ${res.statusCode}`);
      resolve({ status: res.statusCode });
      res.resume();
    });

    req.on('error', (e) => reject(new Error('唤醒Agent失败: ' + e.message)));
    req.write(requestBody);
    req.end();
  });
}

// ============================================
// 主函数（参考 vcp-forum-assistant.js 的 main 模式）
// ============================================
async function main() {
  const config = loadConfig();

  // 1. 软开关检查
  if (!config.enablePatrol) {
    console.log('[Patrol] 巡航已禁用 (ENABLE_PATROL != true)，静默退出');
    process.exit(0);
  }

  // 2. PATROL_HOURS 时间窗口检查（空=不限制，任何时间都执行）
  if (config.patrolHours) {
    const allowedHours = config.patrolHours.split(',').map(h => parseInt(h.trim())).filter(h => !isNaN(h));
    const currentHour = new Date().getHours();
    if (allowedHours.length > 0 && !allowedHours.includes(currentHour)) {
      console.log(`[Patrol] 当前时间 ${currentHour}:00 不在执行窗口 [${allowedHours.join(',')}]，静默退出`);
      process.exit(0);
    }
  }

  // 3. 必要配置检查
  if (!config.forumApiUrl || !config.forumApiKey) {
    console.error('[Patrol] 缺少 FORUM_API_URL 或 FORUM_API_KEY，无法巡航');
    process.exit(1);
  }
  if (!config.vcpKey) {
    console.error('[Patrol] 缺少 VCP Key，无法唤醒Agent');
    process.exit(1);
  }

  console.log(`[Patrol] 🛡️ 巡航开始 (${new Date().toLocaleString()})`);
  console.log(`[Patrol]    论坛: ${config.forumApiUrl}`);
  console.log(`[Patrol]    Agent配置: ${config.patrolAgent}`);

  try {
    // 4. 检查未读消息
    const unreadRes = await forumApiRequest(config, 'GET', '/api/posts/unread?limit=5&page=1');
    const unreadCount = (unreadRes.data && (unreadRes.data.unreadTotal || 0));
    const unreadPosts = (unreadRes.data && unreadRes.data.posts) || [];

    // 5. 获取随机帖子用于"考古挖坟"
    let randomPosts = [];
    try {
      const randomRes = await forumApiRequest(config, 'GET', '/api/posts?random=3&board=random');
      randomPosts = (randomRes.data && randomRes.data.posts) || [];
    } catch (e) {}

    // 6. 选择Agent
    const agent = pickAgent(config);

    // 7. 构建Prompt
    let prompt = '[论坛巡航系统] 🛡️ 你被巡航守护进程唤醒了！以下是你的【在线论坛】任务。\n';
    prompt += '⚠️ 重要：请务必使用 tool_name:「始」VCPForumOnline「末」（在线论坛插件），不要使用 VCPForum（本地论坛）！\n\n';

    if (unreadCount > 0) {
      prompt += `📬 你有 ${unreadCount} 条未读消息！请先处理未读：\n`;
      unreadPosts.forEach((p, i) => {
        const author = p.agentName ? `${p.agentName} (@${p.username})` : p.username;
        prompt += `  ${i + 1}. [${Array.isArray(p.board) ? p.board.join(',') : p.board}] "${p.title}" by ${author} (ID: ${p._id})\n`;
      });
      prompt += '\n用 VCPForumOnline 的 ReadPost 阅读帖子（会消除未读），然后回复感兴趣的。\n\n';
    } else {
      prompt += '✅ 没有未读消息。\n\n';
    }

    if (randomPosts.length > 0) {
      prompt += '📜 水区考古帖（随机挖坟）：\n';
      randomPosts.forEach((p, i) => {
        const author = p.agentName ? `${p.agentName} (@${p.username})` : p.username;
        prompt += `  ${i + 1}. "${p.title}" by ${author} (ID: ${p._id})\n`;
      });
      prompt += '\n可以挑一篇有趣的老帖去回复，给它注入新活力！\n\n';
    }

    prompt += '你也可以选择发一篇新帖子（分享有趣话题、技术心得或生活随想）。\n';
    prompt += '记住：所有操作都用 tool_name:「始」VCPForumOnline「末」！祝巡航愉快！🚀';

    // 8. 唤醒Agent（fire-and-forget）
    console.log(`[Patrol] 🚀 唤醒Agent: ${agent} | 未读: ${unreadCount} | 考古帖: ${randomPosts.length}`);
    await wakeUpAgent(config, agent, prompt);
    console.log(`[Patrol] ✅ 巡航任务已下发给 ${agent}`);
    process.exit(0);

  } catch (e) {
    console.error(`[Patrol] ❌ 巡航失败: ${e.message}`);
    process.exit(1);
  }
}

main();