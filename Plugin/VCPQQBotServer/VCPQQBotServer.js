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

const DEFAULT_SYSTEM_PROMPT = '你是接入 QQ 单聊的 VCPQQBot。你正在通过 VCP 主服务器与 QQ 用户聊天。你可以自然聊天，也可以使用 VCP 工具协议完成任务。若回复中包含图片 URL、Markdown 图片或 HTML img 标签，系统会自动转成 QQ 图片发送。回复应适合 QQ 聊天场景，避免一次性输出过长文本。';
const STATUS_PLACEHOLDER = '{{VCPQQBotStatus}}';
const RECENT_PLACEHOLDER = '{{VCPQQRecentMessages}}';

let config = {};
let debugMode = false;
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

function getBotAuthorization() {
  const appId = String(config.QQAppID || '').trim();
  const token = getTokenValue();
  const mode = String(config.QQBotAuthMode || 'bot_app_token').trim().toLowerCase();
  if (mode === 'access_token') return `QQBot ${token}`;
  return `Bot ${appId}.${token}`;
}

function getIdentifyToken() {
  return getBotAuthorization();
}

function getRequestHeaders(extra = {}) {
  return {
    Authorization: getBotAuthorization(),
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
    headers: getRequestHeaders({ Accept: 'application/json' }),
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
      if (sessionId && latestSeq !== null) sendResume();
      else sendIdentify();
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

function sendIdentify() {
  const payload = {
    op: OPCODE.IDENTIFY,
    d: {
      token: getIdentifyToken(),
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

function sendResume() {
  const payload = {
    op: OPCODE.RESUME,
    d: {
      token: getIdentifyToken(),
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

  const text = extractAssistantText(response.data);
  if (!text) throw new Error(`VCP 主服务器返回空回复：${JSON.stringify(response.data).slice(0, 500)}`);
  return text;
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
  if (msgId) payload.msg_id = String(msgId);

  const response = await axios.post(`${getBaseUrl()}/v2/users/${encodeURIComponent(openid)}/messages`, payload, {
    headers: getRequestHeaders(),
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

async function sendC2CImage(openid, imageUrl, msgId) {
  try {
    const upload = await uploadC2CImageByUrl(openid, imageUrl);
    const fileInfo = upload.file_info || upload.fileInfo || upload.data?.file_info || upload.data?.fileInfo;
    if (!fileInfo) throw new Error(`图片上传未返回 file_info：${JSON.stringify(upload).slice(0, 300)}`);

    const payload = {
      msg_type: 7,
      media: {
        file_info: fileInfo
      }
    };
    if (msgId) payload.msg_id = String(msgId);

    const response = await axios.post(`${getBaseUrl()}/v2/users/${encodeURIComponent(openid)}/messages`, payload, {
      headers: getRequestHeaders(),
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
    warn('发送 QQ 图片失败，回退为文本 URL:', imageUrl, error.message);
    return await sendC2CText(openid, `图片：${imageUrl}`, msgId);
  }
}

async function uploadC2CImageByUrl(openid, imageUrl) {
  const payload = {
    file_type: 1,
    url: imageUrl,
    srv_send_msg: false
  };

  const response = await axios.post(`${getBaseUrl()}/v2/users/${encodeURIComponent(openid)}/files`, payload, {
    headers: getRequestHeaders(),
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