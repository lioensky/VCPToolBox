const axios = require('axios');
const WebSocket = require('ws');
const pluginManager = require('../../Plugin.js');

const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  PUBLIC_GUILD_MESSAGES: 1 << 30
};

const OPCODE = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11
};

const DEFAULT_SYSTEM_PROMPT = '你是黑哥VCP，一个接入QQ单聊的AI助手。你正在通过VCP主服务器与QQ用户聊天。你可以自然聊天，也可以使用VCP工具协议完成任务。若回复中包含图片URL、Markdown图片或HTML img标签，系统会自动转成QQ图片发送。回复应适合QQ聊天场景，避免一次性输出过长文本。';
const STATUS_PLACEHOLDER = '{{VCPQQBotStatus}}';
const RECENT_PLACEHOLDER = '{{VCPQQRecentMessages}}';

let config = {};
const KNOWN_GROUPS_FILE = __dirname + '/known_groups.json';
let knownGroups = new Set(); // 自动注册的群 openid

function loadKnownGroups() {
  try {
    const data = require('fs').readFileSync(KNOWN_GROUPS_FILE, 'utf8');
    JSON.parse(data).forEach(id => knownGroups.add(id));
  } catch (e) { /* 文件不存在时忽略 */ }
}

function saveKnownGroup(groupId) {
  if (!groupId || knownGroups.has(groupId)) return;
  knownGroups.add(groupId);
  try {
    require('fs').writeFileSync(KNOWN_GROUPS_FILE,
      JSON.stringify([...knownGroups], null, 2), 'utf8');
  } catch (e) { warn('保存群 ID 失败:', e.message); }
}

const groupEngageWindows = new Map(); // groupOpenid → 剩余主动参与消息条数
const groupLastAtMsgId = new Map();   // groupOpenid → {msgId, ts}  最近@mention的msg_id
const groupMsgSeqCounters = new Map();// `groupOpenid:msgId` → seq 计数器（QQ去重要求每条递增）

function getNextMsgSeq(groupOpenid, msgId) {
  if (!msgId) return undefined;
  const key = groupOpenid + ':' + msgId;
  const seq = (groupMsgSeqCounters.get(key) || 0) + 1;
  groupMsgSeqCounters.set(key, seq);
  return seq;
}

// C2C 被动消息也需 msg_seq 递增:同一 msg_id 多次被动回复(文字+图片多part)
// 必须每次用不同 msg_seq,否则 QQ 返回 50015014 系统繁忙 / 400
const c2cMsgSeqCounters = new Map();
function getC2CMsgSeq(openid, msgId) {
  if (!msgId) return undefined;
  const key = openid + ':' + msgId;
  const seq = (c2cMsgSeqCounters.get(key) || 0) + 1;
  c2cMsgSeqCounters.set(key, seq);
  return seq;
}
let debugMode = false;
let accessTokenCache = { token: null, expiresAt: 0 };
let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let stopped = false;
let connecting = false;
let retryCount = 0;
let latestSeq = null;
let sessionId = '';
let readyUser = null;
let heartbeatInterval = 45000;
let lastHeartbeatAckAt = null;
let lastConnectedAt = null;
let lastDisconnectedAt = null;
let lastError = null;
let processingLocks = new Set();
let histories = new Map();
let recentMessages = [];

function log(...args) {
  if (debugMode) console.log('[VCPQQBotServer]', ...args);
}

function warn(...args) {
  console.warn('[VCPQQBotServer]', ...args);
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).trim().toLowerCase() === 'true';
}

function normalizeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
  return String(value).split(/[,;\n]/).map(v => v.trim()).filter(Boolean);
}

function getBaseUrl() {
  return normalizeBoolean(config.QQBotSandbox, false)
    ? 'https://sandbox.api.sgroup.qq.com'
    : 'https://api.sgroup.qq.com';
}

function getGatewayUrlApi() {
  return `${getBaseUrl()}/gateway/bot`;
}

function getTokenValue() {
  return String(config.QQBotToken || config.QQAppSecret || '').trim();
}

async function getAppAccessToken() {
  if (accessTokenCache.token && Date.now() < accessTokenCache.expiresAt) {
    return accessTokenCache.token;
  }
  const appId = String(config.QQAppID || '').trim();
  const clientSecret = String(config.QQAppSecret || '').trim();
  if (!appId || !clientSecret) {
    warn('缺少 QQAppID 或 QQAppSecret，无法获取 AppAccessToken，回退到 getTokenValue。');
    return getTokenValue();
  }
  try {
    const response = await axios.post('https://bots.qq.com/app/getAppAccessToken', {
      appId,
      clientSecret
    }, {
      timeout: 15000
    });
    const data = response.data;
    if (data.access_token) {
      const expiresIn = (data.expires_in || 7200) - 60;
      accessTokenCache.token = data.access_token;
      accessTokenCache.expiresAt = Date.now() + expiresIn * 1000;
      log('已获取新的 AppAccessToken。');
      return data.access_token;
    }
    throw new Error(`获取 AppAccessToken 返回格式异常：${JSON.stringify(data)}`);
  } catch (error) {
    warn('获取 AppAccessToken 失败:', error.message);
    return getTokenValue();
  }
}

async function getBotAuthorization() {
  const appId = String(config.QQAppID || '').trim();
  const token = getTokenValue();
  const mode = String(config.QQBotAuthMode || 'bot_app_token').trim().toLowerCase();
  if (mode === 'access_token') {
    const accessToken = await getAppAccessToken();
    return `QQBot ${accessToken}`;
  }
  return `Bot ${appId}.${token}`;
}

async function getIdentifyToken() {
  return await getBotAuthorization();
}

async function getRequestHeaders(extra = {}) {
  return {
    Authorization: await getBotAuthorization(),
    'Content-Type': 'application/json',
    'User-Agent': 'VCPQQBotServer/0.1.0',
    ...extra
  };
}

function computeIntents() {
  const names = splitList(config.QQBotIntents || 'GROUP_AND_C2C_EVENT');
  let value = 0;
  for (const name of names) {
    const key = name.trim();
    if (Object.prototype.hasOwnProperty.call(INTENTS, key)) value |= INTENTS[key];
  }
  return value || INTENTS.GROUP_AND_C2C_EVENT;
}

function mask(value) {
  const text = String(value || '');
  if (!text) return 'NOT_CONFIGURED';
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function addRecent(item) {
  recentMessages.push({
    time: new Date().toISOString(),
    ...item
  });
  const keep = normalizeInteger(config.QQBotRecentKeep, 50);
  if (recentMessages.length > keep) recentMessages = recentMessages.slice(-keep);
  updatePlaceholders();
}

function buildStatusText() {
  const lines = [];
  lines.push('# VCPQQBotServer 状态');
  lines.push('');
  lines.push(`- Gateway：${ws && ws.readyState === WebSocket.OPEN ? 'connected' : connecting ? 'connecting' : 'disconnected'}`);
  lines.push(`- 已停止：${stopped ? '是' : '否'}`);
  lines.push(`- 重试次数：${retryCount}`);
  lines.push(`- 最近 seq：${latestSeq ?? '无'}`);
  lines.push(`- session_id：${sessionId || '无'}`);
  lines.push(`- Bot 用户：${readyUser ? `${readyUser.username || 'unknown'} (${readyUser.id || 'unknown'})` : '未知'}`);
  lines.push(`- 心跳间隔：${heartbeatInterval}ms`);
  lines.push(`- 最近心跳 ACK：${lastHeartbeatAckAt || '无'}`);
  lines.push(`- 最近连接：${lastConnectedAt || '无'}`);
  lines.push(`- 最近断开：${lastDisconnectedAt || '无'}`);
  lines.push(`- 最近错误：${lastError || '无'}`);
  lines.push(`- VCP 端口：${config.PORT || '未注入'}`);
  lines.push(`- VCP Key：${config.Key ? 'FOUND' : 'NOT FOUND'}`);
  lines.push(`- QQAppID：${mask(config.QQAppID)}`);
  lines.push(`- Intents：${config.QQBotIntents || 'GROUP_AND_C2C_EVENT'} (${computeIntents()})`);
  lines.push(`- 历史会话数：${histories.size}`);
  lines.push(`- 最近消息数：${recentMessages.length}`);
  return lines.join('\n');
}

function buildRecentText() {
  const lines = [];
  lines.push('# VCPQQBot 最近单聊消息');
  lines.push('');
  if (recentMessages.length === 0) {
    lines.push('暂无消息。');
    return lines.join('\n');
  }
  lines.push('| # | 时间 | 方向 | openid | 类型 | 内容 |');
  lines.push('|---:|---|---|---|---|---|');
  recentMessages.slice(-20).forEach((msg, index) => {
    lines.push(`| ${index + 1} | ${escapeMd(msg.time)} | ${escapeMd(msg.direction || '')} | ${escapeMd(msg.openid || '')} | ${escapeMd(msg.type || '')} | ${escapeMd(truncateInline(msg.content || msg.error || '', 120))} |`);
  });
  return lines.join('\n');
}

function escapeMd(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function truncateInline(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function updatePlaceholders() {
  pluginManager.staticPlaceholderValues.set(STATUS_PLACEHOLDER, {
    value: buildStatusText(),
    serverId: 'local'
  });
  pluginManager.staticPlaceholderValues.set(RECENT_PLACEHOLDER, {
    value: buildRecentText(),
    serverId: 'local'
  });
}

async function initialize(initialConfig = {}) {
  config = initialConfig || {};
  debugMode = normalizeBoolean(config.DebugMode, false);
  loadKnownGroups();
  stopped = false;
  updatePlaceholders();

  if (!config.QQAppID || !getTokenValue()) {
    lastError = '缺少 QQAppID 或 QQAppSecret/QQBotToken，VCPQQBotServer 不会连接 Gateway。';
    warn(lastError);
    updatePlaceholders();
    return;
  }
  if (!config.PORT || !config.Key) {
    lastError = '缺少 VCP 注入的 PORT 或 Key，无法调用主服务器聊天入口。';
    warn(lastError);
    updatePlaceholders();
    return;
  }

  log('初始化完成，准备连接 QQ Gateway。');
  connectGateway().catch(error => {
    lastError = error.message;
    warn('Gateway 首次连接失败:', error.message);
    scheduleReconnect(error.message);
  });
}

async function fetchGatewayInfo() {
  const response = await axios.get(getGatewayUrlApi(), {
    headers: await getRequestHeaders({ Accept: 'application/json' }),
    timeout: 15000
  });
  if (!response.data || !response.data.url) {
    throw new Error(`获取 Gateway 地址失败：${JSON.stringify(response.data)}`);
  }
  return response.data;
}

async function connectGateway() {
  if (stopped || connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  connecting = true;
  clearReconnectTimer();

  try {
    const gateway = await fetchGatewayInfo();
    const url = gateway.url;
    log('Gateway 信息:', gateway);
    await openGatewaySocket(url);
  } finally {
    connecting = false;
  }
}

function openGatewaySocket(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    ws = new WebSocket(url);

    ws.on('open', () => {
      lastConnectedAt = new Date().toISOString();
      lastError = null;
      log('Gateway WebSocket 已打开。');
      updatePlaceholders();
      if (!settled) {
        settled = true;
        resolve();
      }
    });

    ws.on('message', data => {
      handleGatewayMessage(data).catch(error => {
        lastError = error.message;
        warn('处理 Gateway 消息失败:', error.message);
        updatePlaceholders();
      });
    });

    ws.on('close', (code, reason) => {
      lastDisconnectedAt = new Date().toISOString();
      const reasonText = reason ? reason.toString() : '';
      log('Gateway WebSocket 关闭:', code, reasonText);
      clearHeartbeat();
      ws = null;
      updatePlaceholders();
      if (!stopped) scheduleReconnect(`close:${code}:${reasonText}`);
    });

    ws.on('error', error => {
      lastError = error.message;
      warn('Gateway WebSocket 错误:', error.message);
      updatePlaceholders();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

async function handleGatewayMessage(data) {
  const payload = parsePayload(data);
  if (!payload) return;

  if (typeof payload.s === 'number') latestSeq = payload.s;

  switch (payload.op) {
    case OPCODE.HELLO:
      heartbeatInterval = normalizeInteger(payload.d && payload.d.heartbeat_interval, heartbeatInterval);
      if (sessionId && latestSeq !== null) await sendResume();
      else await sendIdentify();
      break;
    case OPCODE.HEARTBEAT:
      sendHeartbeat();
      break;
    case OPCODE.HEARTBEAT_ACK:
      lastHeartbeatAckAt = new Date().toISOString();
      updatePlaceholders();
      break;
    case OPCODE.RECONNECT:
      warn('QQ Gateway 要求重连。');
      reconnectNow('server_reconnect');
      break;
    case OPCODE.INVALID_SESSION:
      warn('QQ Gateway Invalid Session，清理会话后重连。');
      sessionId = '';
      latestSeq = null;
      reconnectNow('invalid_session');
      break;
    case OPCODE.DISPATCH:
      handleDispatch(payload);
      break;
    default:
      log('忽略 Gateway op:', payload.op, payload.t || '');
      break;
  }
}

function parsePayload(data) {
  try {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    return JSON.parse(text);
  } catch (error) {
    warn('Gateway payload 解析失败:', error.message);
    return null;
  }
}

async function sendIdentify() {
  const payload = {
    op: OPCODE.IDENTIFY,
    d: {
      token: await getIdentifyToken(),
      intents: computeIntents(),
      shard: [0, 1],
      properties: {
        $os: process.platform,
        $browser: 'VCPQQBotServer',
        $device: 'VCPQQBotServer'
      }
    }
  };
  sendWs(payload);
  startHeartbeat();
  log('已发送 Identify。');
}

async function sendResume() {
  const payload = {
    op: OPCODE.RESUME,
    d: {
      token: await getIdentifyToken(),
      session_id: sessionId,
      seq: latestSeq || 0
    }
  };
  sendWs(payload);
  startHeartbeat();
  log('已发送 Resume。');
}

function sendHeartbeat() {
  sendWs({
    op: OPCODE.HEARTBEAT,
    d: latestSeq
  });
}

function startHeartbeat() {
  clearHeartbeat();
  const interval = Math.max(5000, heartbeatInterval || 45000);
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendHeartbeat();
  }, interval);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sendWs(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function handleDispatch(payload) {
  const eventType = payload.t;
  if (eventType === 'READY') {
    sessionId = payload.d && payload.d.session_id ? payload.d.session_id : sessionId;
    readyUser = payload.d && payload.d.user ? payload.d.user : readyUser;
    retryCount = 0;
    sendHeartbeat();
    updatePlaceholders();
    log('Gateway READY:', payload.d);
    return;
  }

  if (eventType === 'RESUMED') {
    retryCount = 0;
    updatePlaceholders();
    log('Gateway RESUMED。');
    return;
  }

  if (eventType === 'C2C_MESSAGE_CREATE') {
    const event = normalizeC2CEvent(payload);
    if (!event) return;
    handleC2CMessage(event).catch(error => {
      lastError = error.message;
      warn('处理 C2C 消息失败:', error.message);
      addRecent({
        direction: 'error',
        openid: event.openid,
        type: 'C2C_MESSAGE_CREATE',
        error: error.message
      });
    });
    return;
  }

  if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
    const event = normalizeGroupAtEvent(payload);
    if (!event) return;
    if (event.messageId) {
      groupLastAtMsgId.set(event.groupOpenid, { msgId: event.messageId, ts: Date.now() });
    }
    event.replyMsgId = event.messageId;
    // 立即预设窗口，避免 AI 处理期间的跟进消息漏掉
    const preWindowSizeAt = normalizeInteger(config.QQBotGroupEngageWindow, 0);
    if (preWindowSizeAt > 0) {
      groupEngageWindows.set(event.groupOpenid, preWindowSizeAt);
    }
    handleGroupAtMessage(event).catch(error => {
      lastError = error.message;
      warn('处理群@消息失败:', error.message);
    });
    return;
  }

  if (eventType === 'GROUP_MESSAGE_CREATE') {
    log('[GMC] 收到群消息，group:', (payload.d||{}).group_openid, 'content:', String((payload.d||{}).content||'').slice(0,40));
    const d = payload.d || {};
    saveKnownGroup(d.group_openid || d.group_id);
    const content = String(d.content || '');
    const mentions = Array.isArray(d.mentions) ? d.mentions : [];
    const botId = readyUser && readyUser.id ? String(readyUser.id) : '';
    // 只处理 @机器人 的消息（mentions 标记 bot:true，或内容含 <@!botId>，或文本含机器人显示名——兼容机器人间@不带结构化mention的情况）
    const botDisplayName = String(config.QQBotDisplayName || '').trim();
    const isBotMentioned = mentions.some(m => m.bot === true)
      || (botId && content.includes('<@!' + botId + '>'))
      || (botDisplayName && content.includes('@' + botDisplayName));
    if (debugMode) {
      log('[DBG] GROUP_MESSAGE_CREATE content:', content.slice(0, 80),
          'botId:', botId, 'mentioned:', isBotMentioned,
          'mentions:', JSON.stringify(mentions).slice(0, 120));
    }
    const engageWindow = normalizeInteger(config.QQBotGroupEngageWindow, 0);
    const remaining = groupEngageWindows.get(d.group_openid || d.group_id || '') || 0;
    const shouldRespond = isBotMentioned || remaining > 0;
    log('[DBG-WIN] group:', d.group_openid, 'remaining:', remaining, 'shouldRespond:', shouldRespond, 'engageWindow:', engageWindow);

    // 每来一条消息都消耗窗口（无论是否响应）
    if (remaining > 0) {
      groupEngageWindows.set(d.group_openid || d.group_id || '', remaining - 1);
    }

    if (!shouldRespond) return;

    const event = normalizeGroupAtEvent(payload);
    if (!event) return;

    if (isBotMentioned) {
      // @mention：保存 msg_id，供窗口期回复使用
      if (event.messageId) {
        groupLastAtMsgId.set(event.groupOpenid, { msgId: event.messageId, ts: Date.now() });
      }
      event.replyMsgId = event.messageId;
      // 立即预设窗口，避免 AI 处理期间的跟进消息漏掉
      const preWindowSize = normalizeInteger(config.QQBotGroupEngageWindow, 0);
      if (preWindowSize > 0) {
        groupEngageWindows.set(event.groupOpenid, preWindowSize);
        log('[DBG-WIN-SET] @mention 预设窗口 group:', event.groupOpenid, 'size:', preWindowSize);
      }
    } else {
      // 窗口期：走主动消息，无需 msg_id（需"机器人主动在群聊内发言"权限）
      event.replyMsgId = null;
    }

    handleGroupAtMessage(event).catch(error => {
      lastError = error.message;
      warn('处理群消息失败:', error.message);
    });
    return;
  }

  if (eventType === 'GROUP_MEMBER_ADD') {
    handleGroupMemberAdd(payload).catch(error => {
      lastError = error.message;
      warn('处理群成员加入失败:', error.message);
    });
    return;
  }

  log('忽略 Dispatch:', eventType);
}

function normalizeC2CEvent(payload) {
  const d = payload.d || {};
  const author = d.author || {};
  const openid = d.openid || d.author_openid || d.user_openid || author.user_openid || author.openid || author.id;
  const content = String(d.content || d.text || '').trim();
  const messageId = d.id || d.msg_id || payload.id || '';
  const attachments = Array.isArray(d.attachments) ? d.attachments : [];
  if (!openid) {
    warn('C2C 事件缺少 openid:', d);
    return null;
  }
  return {
    eventId: payload.id || '',
    eventType: payload.t,
    seq: payload.s,
    openid: String(openid),
    messageId: String(messageId || ''),
    content,
    attachments,
    author,
    raw: d
  };
}

function isAllowedOpenid(openid) {
  const allowList = splitList(config.QQBotAllowList);
  if (allowList.length === 0) return true;
  return allowList.includes(String(openid));
}

async function handleC2CMessage(event) {
  if (!isAllowedOpenid(event.openid)) {
    log('跳过未授权 openid:', event.openid);
    addRecent({
      direction: 'in_ignored',
      openid: event.openid,
      type: event.eventType,
      content: event.content || '[非文本消息]'
    });
    return;
  }

  const lockKey = `c2c:${event.openid}`;
  if (processingLocks.has(lockKey)) {
    await sendC2CText(event.openid, '我正在处理你上一条消息，请稍等一下。', event.messageId);
    return;
  }

  processingLocks.add(lockKey);
  addRecent({
    direction: 'in',
    openid: event.openid,
    type: event.eventType,
    content: event.content || summarizeAttachments(event.attachments)
  });

  try {
    const userText = buildUserMessageText(event);
    appendHistory(event.openid, { role: 'user', content: userText });

    const aiText = await callVcpChat(event.openid);
    appendHistory(event.openid, { role: 'assistant', content: aiText });

    addRecent({
      direction: 'out_ai',
      openid: event.openid,
      type: 'assistant',
      content: aiText
    });

    await sendAiReplyToQQ(event.openid, aiText, event.messageId);
  } catch (error) {
    lastError = error.message;
    warn('C2C 对话处理失败:', error.message);
    await sendC2CText(event.openid, `处理消息时出错：${error.message}`, event.messageId).catch(sendError => {
      warn('发送错误提示失败:', sendError.message);
    });
  } finally {
    processingLocks.delete(lockKey);
    updatePlaceholders();
  }
}

function normalizeGroupAtEvent(payload) {
  const d = payload.d || {};
  const author = d.author || {};
  const groupOpenid = d.group_openid || d.group_id;
  const memberOpenid = author.member_openid || author.user_openid || author.openid;
  // 去掉开头的 @bot mention token（<@!xxx> 格式）
  const content = String(d.content || '').replace(/^<@!\w+>\s*/, '').trim();
  const messageId = d.id || d.msg_id || '';
  const attachments = Array.isArray(d.attachments) ? d.attachments : [];
  if (!groupOpenid) {
    warn('GROUP_AT 事件缺少 group_openid:', d);
    return null;
  }
  return {
    eventId: payload.id || '',
    eventType: payload.t,
    seq: payload.s,
    groupOpenid: String(groupOpenid),
    memberOpenid: memberOpenid ? String(memberOpenid) : 'unknown',
    messageId: String(messageId),
    content,
    attachments,
    author,
    raw: d
  };
}

async function handleGroupAtMessage(event) {
  const lockKey = `group:${event.groupOpenid}`;
  if (processingLocks.has(lockKey)) {
    await sendGroupText(event.groupOpenid, '我正在处理上一条消息，请稍等...', null);
    return;
  }
  processingLocks.add(lockKey);

  addRecent({
    direction: 'in',
    openid: `${event.groupOpenid}/${event.memberOpenid}`,
    type: 'GROUP_AT_MESSAGE_CREATE',
    content: event.content || '[附件消息]'
  });

  try {
    const historyKey = `group_${event.groupOpenid}`;
    const lines = [
      `QQ群 openid：${event.groupOpenid}`,
      `发言成员 openid：${event.memberOpenid}`
    ];
    if (event.content) {
      lines.push('');
      lines.push('成员消息（群@消息）：');
      lines.push(event.content);
    }

    appendHistory(historyKey, { role: 'user', content: lines.join('\n') });
    const aiText = await callVcpChat(historyKey);
    appendHistory(historyKey, { role: 'assistant', content: aiText });

    addRecent({
      direction: 'out_ai',
      openid: event.groupOpenid,
      type: 'assistant',
      content: aiText
    });

    const delayMs = normalizeInteger(config.QQBotSendDelayMs, 800);
    if (delayMs > 0) await sleep(delayMs);

    const replyId = event.replyMsgId ?? event.messageId;
    const parts = splitAiReplyToParts(aiText);
    if (parts.length === 0) {
      await sendGroupText(event.groupOpenid, aiText || '（空回复）', replyId);
    } else {
      for (const [i, part] of parts.entries()) {
        if (i > 0 && delayMs > 0) await sleep(delayMs);
        if (part.type === 'image') {
          if (String(config.QQBotImageMode || 'upload').toLowerCase() === 'text') {
            await sendGroupText(event.groupOpenid, part.url, replyId);
          } else {
            await sendGroupImage(event.groupOpenid, part.url, replyId);
          }
        } else if (part.type === 'text' && part.text) {
          await sendGroupText(event.groupOpenid, part.text, replyId);
        }
      }
    }
  } catch (error) {
    lastError = error.message;
    const errBody = error.response?.data ? JSON.stringify(error.response.data).slice(0, 300) : '';
    warn('群@消息处理失败:', error.message, errBody);
    const replyId = event.replyMsgId ?? event.messageId;
    await sendGroupText(event.groupOpenid, `处理消息时出错：${error.message}`, replyId).catch(e => {
      warn('发送群错误提示失败:', e.message);
    });
  } finally {
    processingLocks.delete(lockKey);
    // 机器人回复后重置参与窗口
    const windowSize = normalizeInteger(config.QQBotGroupEngageWindow, 0);
    if (windowSize > 0) {
      groupEngageWindows.set(event.groupOpenid, windowSize);
      log('[DBG-WIN-RST] 回复后重置窗口 group:', event.groupOpenid, 'size:', windowSize);
    }
    updatePlaceholders();
  }
}

async function handleGroupMemberAdd(payload) {
  const d = payload.d || {};
  const groupOpenid = d.group_openid || d.group_id;
  const memberOpenid = d.op_member_openid || d.member_openid;
  const eventId = payload.id || '';
  if (!groupOpenid) return;

  const delayMs = normalizeInteger(config.QQBotSendDelayMs, 800);
  if (delayMs > 0) await sleep(delayMs);

  const welcomeMsg = [
    '欢迎新成员加入！👋',
    '🎮 群文件里有各种游戏资源，进群先去翻翻！',
    '📢 记得看群公告，里面有重要规则和活动信息！',
    '🌐 群主博客：https://your-domain.com/'
  ].join('\n');
  await sendGroupText(groupOpenid, welcomeMsg, null, eventId);

  addRecent({
    direction: 'out',
    openid: groupOpenid,
    type: 'group_welcome',
    content: `新成员 ${memberOpenid || 'unknown'} 进群`
  });
}

function summarizeAttachments(attachments) {
  if (!attachments || attachments.length === 0) return '[空消息]';
  return `[附件 ${attachments.length} 个]`;
}

function buildUserMessageText(event) {
  const lines = [];
  lines.push(`QQ 单聊用户 openid：${event.openid}`);
  if (event.author && Object.keys(event.author).length > 0) {
    lines.push(`QQ 用户信息：${JSON.stringify(event.author)}`);
  }
  if (event.content) {
    lines.push('');
    lines.push('用户消息：');
    lines.push(event.content);
  }
  if (event.attachments && event.attachments.length > 0) {
    lines.push('');
    lines.push('用户发送的附件：');
    event.attachments.forEach((att, index) => {
      lines.push(`${index + 1}. ${JSON.stringify(att)}`);
    });
  }
  return lines.join('\n');
}

function appendHistory(openid, message) {
  const key = String(openid);
  const history = histories.get(key) || [];
  history.push(message);
  const turns = normalizeInteger(config.QQBotHistoryTurns, 8);
  const maxMessages = Math.max(2, turns * 2);
  histories.set(key, history.slice(-maxMessages));
}

function getHistory(openid) {
  return histories.get(String(openid)) || [];
}

async function callVcpChat(openid) {
  const port = config.PORT;
  const key = config.Key;
  if (!port || !key) throw new Error('VCP PORT 或 Key 未注入。');

  const systemPrompt = String(config.QQBotSystemPrompt || DEFAULT_SYSTEM_PROMPT).trim();
  const messages = [
    { role: 'system', content: systemPrompt },
    ...getHistory(openid)
  ];

  const payload = {
    messages,
    stream: false,
    user: `qq_c2c_${openid}`,
    vcpchatExtensions: {
      frontend: 'VCPQQBotServer',
      conversationKey: `qq_c2c_${openid}`,
      qqOpenid: openid
    }
  };

  if (config.QQBotModel) payload.model = String(config.QQBotModel).trim();

  const response = await axios.post(`http://127.0.0.1:${port}/v1/chat/completions`, payload, {
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    timeout: normalizeInteger(config.QQBotRequestTimeoutMs, 300000)
  });

  const rawText = extractAssistantText(response.data);
  if (!rawText) throw new Error(`VCP 主服务器返回空回复：${JSON.stringify(response.data).slice(0, 500)}`);
  // 兜底:剥离任何残留工具协议块,群里只发可见自然语言
  return sanitizeForQQ(rawText);
}

// 兜底:剥离所有 VCP 工具协议块,保证群里绝不出现 <<<[...>>> / [本轮工具调用摘要:] 等标记。
// 即使主服务 clientResponseRenderer 漏处理,这层是最后防线。
function sanitizeForQQ(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  // 完整工具请求块(含 _ESCAPE 变体)
  out = out.replace(/<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}[\s\S]*?<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/g, '');
  // 工具调用摘要块
  out = out.replace(/\[本轮工具调用摘要[:：]\][\s\S]*?\[本轮工具调用摘要结束\]/g, '');
  // 角色分割标记
  out = out.replace(/<{2,4}\[(?:END_)?ROLE_DIVIDE_USER\]>{2,4}/g, '');
  // VCP 工具信息展示块
  out = out.replace(/<!--\s*VCP_TOOL_PAYLOAD\s*-->[\s\S]*?(?=<{2,4}\[END_|$)/g, '');
  // 多余空行压缩
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

function extractAssistantText(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  const content = message ? message.content : data.content || data.result || data.message;
  return contentToText(content).trim();
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (!part) return '';
      if (typeof part === 'string') return part;
      if (part.type === 'text') return part.text || '';
      if (part.text) return part.text;
      if (part.type === 'image_url' && part.image_url && part.image_url.url) return part.image_url.url;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    try {
      return JSON.stringify(content);
    } catch (_) {
      return String(content);
    }
  }
  return '';
}

async function sendAiReplyToQQ(openid, aiText, msgId) {
  const parts = splitAiReplyToParts(aiText);
  if (parts.length === 0) {
    await sendC2CText(openid, aiText || '（空回复）', msgId);
    return;
  }

  const delayMs = normalizeInteger(config.QQBotSendDelayMs, 800);
  for (const [index, part] of parts.entries()) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    if (part.type === 'image') {
      if (String(config.QQBotImageMode || 'upload').toLowerCase() === 'text') {
        await sendC2CText(openid, part.url, msgId);
      } else {
        await sendC2CImage(openid, part.url, msgId);
      }
    } else if (part.text && part.text.trim()) {
      await sendC2CText(openid, part.text.trim(), msgId);
    }
  }
}

function splitAiReplyToParts(text) {
  const raw = String(text || '');
  const tokens = [];
  const ranges = [];

  const patterns = [
    /!\[[^\]]*]\((https?:\/\/[^\s)]+)\)/gi,
    /<img\b[^>]*\bsrc=["'](https?:\/\/[^"']+)["'][^>]*>/gi,
    /(https?:\/\/[^\s"'<>，。！？）\]\}]+?\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s"'<>，。！？）\]\}]*)?)/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(raw))) {
      const url = match[1];
      if (!url) continue;
      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
        url
      });
    }
  }

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const selected = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    selected.push(range);
    cursor = range.end;
  }

  cursor = 0;
  for (const range of selected) {
    const before = raw.slice(cursor, range.start);
    pushTextParts(tokens, cleanupText(before));
    tokens.push({ type: 'image', url: range.url });
    cursor = range.end;
  }
  pushTextParts(tokens, cleanupText(raw.slice(cursor)));

  return mergeAdjacentText(tokens);
}

function cleanupText(text) {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pushTextParts(parts, text) {
  if (!text) return;
  const maxChars = normalizeInteger(config.QQBotMaxReplyChars, 1200);
  for (const chunk of splitLongText(text, maxChars)) {
    if (chunk.trim()) parts.push({ type: 'text', text: chunk.trim() });
  }
}

function splitLongText(text, maxChars) {
  const result = [];
  const normalized = String(text || '').trim();
  if (!normalized) return result;

  const paragraphs = normalized.split(/\n{2,}/);
  for (const paragraph of paragraphs) {
    pushChunk(result, paragraph.trim(), maxChars);
  }
  return result;
}

function pushChunk(result, text, maxChars) {
  if (!text) return;
  if (text.length <= maxChars) {
    result.push(text);
    return;
  }

  const lines = text.split(/\n/);
  if (lines.length > 1) {
    let buffer = '';
    for (const line of lines) {
      if ((buffer + '\n' + line).trim().length > maxChars) {
        if (buffer.trim()) result.push(buffer.trim());
        buffer = line;
      } else {
        buffer = buffer ? `${buffer}\n${line}` : line;
      }
    }
    if (buffer.trim()) result.push(buffer.trim());
    return;
  }

  const sentences = text.split(/(?<=[。！？.!?])/);
  if (sentences.length > 1) {
    let buffer = '';
    for (const sentence of sentences) {
      if ((buffer + sentence).length > maxChars) {
        if (buffer.trim()) result.push(buffer.trim());
        buffer = sentence;
      } else {
        buffer += sentence;
      }
    }
    if (buffer.trim()) result.push(buffer.trim());
    return;
  }

  for (let i = 0; i < text.length; i += maxChars) {
    result.push(text.slice(i, i + maxChars));
  }
}

function mergeAdjacentText(parts) {
  const result = [];
  for (const part of parts) {
    const last = result[result.length - 1];
    if (part.type === 'text' && last && last.type === 'text') {
      last.text = `${last.text}\n\n${part.text}`.trim();
    } else {
      result.push(part);
    }
  }
  return result;
}

async function sendC2CText(openid, content, msgId) {
  const payload = {
    msg_type: 0,
    content: String(content || '')
  };
  if (msgId) {
    payload.msg_id = String(msgId);
    payload.msg_seq = getC2CMsgSeq(openid, msgId);
  }

  const response = await axios.post(`${getBaseUrl()}/v2/users/${encodeURIComponent(openid)}/messages`, payload, {
    headers: await getRequestHeaders(),
    timeout: 30000
  });

  addRecent({
    direction: 'out',
    openid,
    type: 'text',
    content
  });
  return response.data;
}

/** 提取 axios 请求失败的真实原因：QQ API 通常在 response.data 里给 {code,message}，
 *  之前只拿 e.message 会丢掉这些信息，变成没法诊断的 "Request failed with status code 400"。 */
function formatSendError(e) {
  if (e && e.response) {
    const status = e.response.status;
    let detail = '';
    try {
      const data = e.response.data;
      detail = typeof data === 'string' ? data : JSON.stringify(data);
    } catch { /* ignore */ }
    return `HTTP ${status}${detail ? ' ' + detail : ''}`;
  }
  return e && e.message ? e.message : String(e);
}

async function sendGroupText(groupOpenid, content, msgId, eventId) {
  const payload = {
    msg_type: 0,
    content: String(content || '')
  };
  if (msgId) {
    payload.msg_id = String(msgId);
    payload.msg_seq = getNextMsgSeq(groupOpenid, msgId);
  } else if (eventId) {
    payload.event_id = String(eventId);
  }

  const response = await axios.post(
    `${getBaseUrl()}/v2/groups/${encodeURIComponent(groupOpenid)}/messages`,
    payload,
    { headers: await getRequestHeaders(), timeout: 30000 }
  );
  addRecent({
    direction: 'out',
    openid: groupOpenid,
    type: 'group_text',
    content
  });
  return response.data;
}

// 表情包文件名模糊匹配:flash模型常编造不存在的文件名(如比心.jpeg,实际只有比心.png),
// 导致QQ拉取404。上传前检查文件是否存在,不存在按相似度匹配真实文件。
const fs = require('fs');
const path = require('path');
let sharp;
try { sharp = require('../../node_modules/sharp'); } catch (_) { sharp = null; } // 图片压缩兜底,可选
const IMAGE_ROOT = path.join(__dirname, '..', '..', 'image');
const emojiDirCache = new Map(); // dir -> 文件名数组

function listEmojiDir(dirRel) {
  if (emojiDirCache.has(dirRel)) return emojiDirCache.get(dirRel);
  const absDir = path.join(IMAGE_ROOT, dirRel);
  let files = [];
  try { files = fs.readdirSync(absDir).filter(f => fs.statSync(path.join(absDir, f)).isFile()); }
  catch (_) { files = []; }
  emojiDirCache.set(dirRel, files);
  return files;
}

// Levenshtein编辑距离(小规模文件名用,性能可接受)
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
    }
  }
  return dp[m][n];
}

// 解析子路径(如 通用表情包/比心.jpeg),检查文件是否存在,不存在模糊匹配。
// 返回修正后的子路径(可能换文件名),匹配不到返回原值(让上游404回退)。
function resolveEmojiFile(subpath) {
  if (!subpath) return subpath;
  const absPath = path.join(IMAGE_ROOT, subpath);
  try {
    if (fs.existsSync(absPath)) return subpath; // 文件存在,无需修正
  } catch (_) {}
  // 拆出目录和文件名
  const sep = subpath.lastIndexOf('/');
  const dirRel = sep >= 0 ? subpath.slice(0, sep) : '';
  const fileName = sep >= 0 ? subpath.slice(sep + 1) : subpath;
  const files = listEmojiDir(dirRel);
  if (files.length === 0) return subpath;
  // 优先级1:同名不同扩展名(比心.jpeg -> 比心.png)
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const sameStem = files.filter(f => {
    const fd = f.lastIndexOf('.');
    return (fd > 0 ? f.slice(0, fd) : f) === stem;
  });
  if (sameStem.length > 0) {
    return (dirRel ? dirRel + '/' : '') + sameStem[0];
  }
  // 优先级2:编辑距离最近(阈值<=2,避免离谱匹配)
  let best = null, bestDist = 3;
  for (const f of files) {
    const d = editDistance(fileName, f);
    if (d < bestDist) { bestDist = d; best = f; }
  }
  if (best) {
    return (dirRel ? dirRel + '/' : '') + best;
  }
  return subpath; // 匹配不到,返回原值
}

// 从 imageUrl 解析本地文件路径(复用 resolveEmojiFile 模糊匹配),读为 Buffer。
// 返回 {buf, subpath} 或 null(非本地URL/文件不存在)。
function readLocalImage(imageUrl) {
  const m = String(imageUrl || '').match(/\/pw=[^/]+\/images\/(.+)$/);
  if (!m) return null; // 非鉴权图片URL,无法定位本地文件
  const subpath = resolveEmojiFile(m[1]);
  const absPath = path.join(IMAGE_ROOT, subpath);
  try {
    if (!fs.existsSync(absPath)) return null;
    const buf = fs.readFileSync(absPath);
    return { buf, subpath };
  } catch (_) { return null; }
}

// 用 sharp 压缩图片到目标大小(默认150KB)。GIF 跳过(动图压缩丢帧)。
// 返回压缩后的 Buffer,失败返回 null。
async function compressImage(buf, targetKB = 150) {
  if (!sharp || !buf) return null;
  const subpath = arguments[2] || '';
  if (/\.gif$/i.test(subpath)) return null; // GIF 不压缩
  try {
    const targetBytes = targetKB * 1024;
    // 先尝试 jpeg 质量80,再降;png 用调色板
    let out = await sharp(buf, { animated: false })
      .resize({ width: 400, withoutEnlargement: true }) // 限制宽度,表情包够用
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    if (out.length > targetBytes) {
      out = await sharp(buf, { animated: false })
        .resize({ width: 320, withoutEnlargement: true })
        .jpeg({ quality: 60, mozjpeg: true })
        .toBuffer();
    }
    return out;
  } catch (e) {
    warn('sharp压缩失败:', e.message);
    return null;
  }
}

// file_data base64 直传上传(群)。返回 file_info 或抛错。
async function uploadGroupImageByFileData(groupOpenid, buf) {
  const payload = {
    file_type: 1,
    file_data: buf.toString('base64'),
    srv_send_msg: false
  };
  const response = await axios.post(
    `${getBaseUrl()}/v2/groups/${encodeURIComponent(groupOpenid)}/files`,
    payload,
    { headers: await getRequestHeaders(), timeout: 60000 }
  );
  return response.data;
}

// file_data base64 直传上传(C2C)。返回 file_info 或抛错。
async function uploadC2CImageByFileData(openid, buf) {
  const payload = {
    file_type: 1,
    file_data: buf.toString('base64'),
    srv_send_msg: false
  };
  const response = await axios.post(
    `${getBaseUrl()}/v2/users/${encodeURIComponent(openid)}/files`,
    payload,
    { headers: await getRequestHeaders(), timeout: 60000 }
  );
  return response.data;
}

// 统一的 file_data 直传 + 压缩兜底(群)。返回 file_info 或 null。
async function uploadGroupImageSmart(groupOpenid, imageUrl) {
  const local = readLocalImage(imageUrl);
  if (local) {
    // 优先 file_data 直传原图
    try {
      const up = await uploadGroupImageByFileData(groupOpenid, local.buf);
      const fi = up.file_info || up.fileInfo || up.data?.file_info || up.data?.fileInfo;
      if (fi) { console.log("[VCPQQBotServer] 群图片file_data直传成功:", local.subpath, "("+local.buf.length+"字节)"); return fi; }
      throw new Error('群file_data上传未返回file_info');
    } catch (e1) {
      // 原图失败(可能过大) -> sharp压缩再直传
      const compressed = await compressImage(local.buf, 150, local.subpath);
      if (compressed) {
        try {
          const up2 = await uploadGroupImageByFileData(groupOpenid, compressed);
          const fi2 = up2.file_info || up2.fileInfo || up2.data?.file_info || up2.data?.fileInfo;
          if (fi2) return fi2;
        } catch (e2) {
          warn('群图片压缩后直传仍失败:', e2.message);
        }
      }
      // 压缩也失败或不可用,回退URL方式
      warn('群图片file_data直传失败,回退URL方式:', e1.message);
    }
  }
  // 非本地URL 或 file_data全失败 -> 回退URL上传
  const publicUrl = toPublicImageUrl(imageUrl) || imageUrl;
  const payload = { file_type: 1, url: publicUrl, srv_send_msg: false };
  const response = await axios.post(
    `${getBaseUrl()}/v2/groups/${encodeURIComponent(groupOpenid)}/files`,
    payload,
    { headers: await getRequestHeaders(), timeout: 60000 }
  );
  const fi = response.data.file_info || response.data.fileInfo || response.data?.file_info || response.data?.fileInfo;
  return fi || null;
}

// 统一的 file_data 直传 + 压缩兜底(C2C)。返回 file_info 或 null。
async function uploadC2CImageSmart(openid, imageUrl) {
  const local = readLocalImage(imageUrl);
  if (local) {
    try {
      const up = await uploadC2CImageByFileData(openid, local.buf);
      const fi = up.file_info || up.fileInfo || up.data?.file_info || up.data?.fileInfo;
      if (fi) { console.log("[VCPQQBotServer] C2C图片file_data直传成功:", local.subpath, "("+local.buf.length+"字节)"); return fi; }
      throw new Error('C2C file_data上传未返回file_info');
    } catch (e1) {
      const compressed = await compressImage(local.buf, 150, local.subpath);
      if (compressed) {
        try {
          const up2 = await uploadC2CImageByFileData(openid, compressed);
          const fi2 = up2.file_info || up2.fileInfo || up2.data?.file_info || up2.data?.fileInfo;
          if (fi2) return fi2;
        } catch (e2) {
          warn('C2C图片压缩后直传仍失败:', e2.message);
        }
      }
      warn('C2C图片file_data直传失败,回退URL方式:', e1.message);
    }
  }
  const publicUrl = toPublicImageUrl(imageUrl) || imageUrl;
  const payload = { file_type: 1, url: publicUrl, srv_send_msg: false };
  const response = await axios.post(
    `${getBaseUrl()}/v2/users/${encodeURIComponent(openid)}/files`,
    payload,
    { headers: await getRequestHeaders(), timeout: 60000 }
  );
  const fi = response.data.file_info || response.data.fileInfo || response.data?.file_info || response.data?.fileInfo;
  return fi || null;
}

function toPublicImageUrl(url) {
  // 把 VCP 鉴权图片 URL 转成 Nginx /stickers/ 公开路径
  // 输入: https://domain:6005/pw=KEY/images/subdir/file.ext
  // 输出: https://domain/stickers/<encoded subpath>
  // 修复:对中文子路径做 encodeURI,否则 QQ 服务器拉取时 express.static 中文路径返回 400
  const m = String(url || '').match(/\/pw=[^/]+\/images\/(.+)$/);
  if (!m) return url;
  const base = String(config.QQBotPublicBaseUrl || '').replace(/\/$/, '');
  if (!base) return url; // 未配置则不转换
  return `${base}/stickers/${encodeURI(resolveEmojiFile(m[1]))}`;
}

async function uploadGroupImageByUrl(groupOpenid, imageUrl) {
  const payload = {
    file_type: 1,
    url: imageUrl,
    srv_send_msg: false
  };
  const response = await axios.post(
    `${getBaseUrl()}/v2/groups/${encodeURIComponent(groupOpenid)}/files`,
    payload,
    { headers: await getRequestHeaders(), timeout: 60000 }
  );
  return response.data;
}

async function sendGroupImage(groupOpenid, imageUrl, msgId, eventId) {
  try {
    const fileInfo = await uploadGroupImageSmart(groupOpenid, imageUrl);
    if (!fileInfo) throw new Error('群图片上传未返回 file_info(直传+URL均失败)');

    const payload = { msg_type: 7, media: { file_info: fileInfo } };
    if (msgId) {
      payload.msg_id = String(msgId);
      payload.msg_seq = getNextMsgSeq(groupOpenid, msgId);
    } else if (eventId) {
      payload.event_id = String(eventId);
    }

    const response = await axios.post(
      `${getBaseUrl()}/v2/groups/${encodeURIComponent(groupOpenid)}/messages`,
      payload,
      { headers: await getRequestHeaders(), timeout: 30000 }
    );
    addRecent({ direction: 'out', openid: groupOpenid, type: 'group_image', content: imageUrl });
    return response.data;
  } catch (error) {
    // 修复:回退时禁止泄露鉴权URL(pw=KEY)。优先用已转换的公开URL;
    // 若未配置 QQBotPublicBaseUrl 导致 publicUrl 为原始鉴权URL,则发占位提示,绝不把密钥发到群里。
    // 硬约束:绝不回退成 [图片: URL] 文本链接(QQ显示不了,只显示一行字)。
    // 上传失败静默跳过(只记日志),群里只看到文字部分或啥都不发。
    warn('发送群图片失败(静默跳过,不发文本链接):', imageUrl, error.message);
    return null;
  }
}

async function sendC2CImage(openid, imageUrl, msgId) {
  try {
    const fileInfo = await uploadC2CImageSmart(openid, imageUrl);
    if (!fileInfo) throw new Error('图片上传未返回 file_info(直传+URL均失败)');

    const payload = {
      msg_type: 7,
      media: {
        file_info: fileInfo
      }
    };
    if (msgId) {
      payload.msg_id = String(msgId);
      payload.msg_seq = getC2CMsgSeq(openid, msgId);
    }

    const response = await axios.post(`${getBaseUrl()}/v2/users/${encodeURIComponent(openid)}/messages`, payload, {
      headers: await getRequestHeaders(),
      timeout: 30000
    });

    addRecent({
      direction: 'out',
      openid,
      type: 'image',
      content: imageUrl
    });
    return response.data;
  } catch (error) {
    // 修复:同 sendGroupImage,回退禁止泄露鉴权URL。
    // 硬约束:同 sendGroupImage,绝不回退成 [图片: URL] 文本链接。静默跳过。
    warn('发送 QQ 图片失败(静默跳过,不发文本链接):', imageUrl, error.message);
    return null;
  }
}

async function uploadC2CImageByUrl(openid, imageUrl) {
  const payload = {
    file_type: 1,
    url: imageUrl,
    srv_send_msg: false
  };

  const response = await axios.post(`${getBaseUrl()}/v2/users/${encodeURIComponent(openid)}/files`, payload, {
    headers: await getRequestHeaders(),
    timeout: 60000
  });
  return response.data;
}

function reconnectNow(reason) {
  clearHeartbeat();
  if (ws) {
    try {
      ws.close();
    } catch (_) {}
    ws = null;
  }
  scheduleReconnect(reason);
}

function scheduleReconnect(reason) {
  if (stopped) return;
  clearReconnectTimer();
  const delays = [1000, 2000, 5000, 10000, 30000, 60000];
  const delay = delays[Math.min(retryCount, delays.length - 1)];
  retryCount += 1;
  lastError = reason || lastError;
  updatePlaceholders();
  warn(`将在 ${delay}ms 后重连 QQ Gateway，原因：${reason || 'unknown'}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectGateway().catch(error => {
      lastError = error.message;
      warn('重连 QQ Gateway 失败:', error.message);
      scheduleReconnect(error.message);
    });
  }, delay);
  if (reconnectTimer.unref) reconnectTimer.unref();
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processToolCall(params = {}) {
  const command = String(params.command || params.cmd || 'status').trim();
  switch (command) {
    case 'status':
      return {
        content: [
          {
            type: 'text',
            text: `${buildStatusText()}\n\n${buildRecentText()}`
          }
        ],
        meta: {
          plugin: 'VCPQQBotServer',
          command: 'status'
        }
      };
    case 'broadcast_to_groups': {
      const content = String(params.content || '').trim();
      if (!content) throw new Error('broadcast_to_groups 缺少 content 参数');
      // 优先用 config 配置的群，没配置则用自动注册的群
      const configGroups = splitList(config.QQBotBroadcastGroups);
      const targetGroups = configGroups.length > 0 ? configGroups : [...knownGroups];
      if (targetGroups.length === 0) throw new Error('未找到目标群，请先让 bot 在群里收到消息，或在 QQBotBroadcastGroups 配置群 ID');
      const results = [];
      for (const gid of targetGroups) {
        const id = String(gid).trim();
        if (!id) continue;
        try {
          await sendGroupText(id, content, null, null);
          results.push(`✅ 群 ${id.slice(0, 8)}...: 发送成功`);
        } catch (e) {
          results.push(`❌ 群 ${id.slice(0, 8)}...: ${formatSendError(e)}`);
        }
      }
      return {
        content: [{ type: 'text', text: '群播结果（共' + targetGroups.length + '个群）：\n' + results.join('\n') }],
        meta: { plugin: 'VCPQQBotServer', command: 'broadcast_to_groups', groups: targetGroups.length }
      };
    }
    case 'broadcast_draft_file': {
      const draftPath = __dirname + '/draft_morning_brief.txt';
      let content;
      try {
        content = require('fs').readFileSync(draftPath, 'utf8').trim();
      } catch (e) {
        throw new Error('broadcast_draft_file 读取草稿文件失败: ' + e.message);
      }
      if (!content) throw new Error('broadcast_draft_file 草稿文件为空，请先执行撰写步骤');
      const configGroups = splitList(config.QQBotBroadcastGroups);
      const targetGroups = configGroups.length > 0 ? configGroups : [...knownGroups];
      if (targetGroups.length === 0) throw new Error('未找到目标群，请先让 bot 在群里收到消息，或在 QQBotBroadcastGroups 配置群 ID');
      const results = [];
      for (const gid of targetGroups) {
        const id = String(gid).trim();
        if (!id) continue;
        try {
          await sendGroupText(id, content, null, null);
          results.push('✅ 群 ' + id.slice(0, 8) + '...: 发送成功');
        } catch (e) {
          results.push('❌ 群 ' + id.slice(0, 8) + '...: ' + formatSendError(e));
        }
      }
      return {
        content: [{ type: 'text', text: '草稿群播结果（共' + targetGroups.length + '个群）：' + '\n' + results.join('\n') }],
        meta: { plugin: 'VCPQQBotServer', command: 'broadcast_draft_file', groups: targetGroups.length }
      };
    }
    default:
      throw new Error(`未知 command: ${command}。QQ 单聊回复不需要工具调用，AI 正常输出自然语言即可。`);
  }
}

async function shutdown() {
  stopped = true;
  clearHeartbeat();
  clearReconnectTimer();
  processingLocks.clear();
  if (ws) {
    try {
      ws.close();
    } catch (_) {}
    ws = null;
  }
  updatePlaceholders();
}

module.exports = {
  initialize,
  processToolCall,
  shutdown,
  _private: {
    splitAiReplyToParts,
    extractAssistantText,
    computeIntents,
    buildUserMessageText
  }
};