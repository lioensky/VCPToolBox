'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PLUGIN_NAME = 'VCPFeishu';
const MESSAGE_DEDUPE_TTL_MS = 10 * 60 * 1000;
const FEISHU_HTTP_TIMEOUT_MS = 15000;
const FEISHU_WS_READY_TIMEOUT_MS = 30000;
const DEFAULT_STREAM_HINT = '正在思考中…';

let lark = null;
let wsClient = null;
let config = {};
let debugMode = false;
let tenantTokenCache = { appId: '', appSecret: '', token: '', expiresAt: 0 };
const processedMessageIds = new Map();

const stats = {
    connected: false,
    messagesReceived: 0,
    messagesProcessed: 0,
    messagesFailed: 0,
    topicsCreated: 0,
    lastMessageAt: null,
    lastError: null,
    startedAt: null,
    lastTopicId: null,
    lastSessionKey: null,
};

function log(...args) { console.log(`[${PLUGIN_NAME}][Bot]`, ...args); }
function warn(...args) { console.warn(`[${PLUGIN_NAME}][Bot]`, ...args); }
function debug(...args) { if (debugMode) console.log(`[${PLUGIN_NAME}][Bot][debug]`, ...args); }

function configure(pluginConfig = {}) {
    config = { ...config, ...pluginConfig };
    debugMode = toBoolean(getConfigValue('DebugMode'), false);
}

function getConfigValue(...keys) {
    for (const key of keys) {
        if (config[key] !== undefined && config[key] !== null && config[key] !== '') return config[key];
        if (process.env[key] !== undefined && process.env[key] !== null && process.env[key] !== '') return process.env[key];
    }
    return '';
}

function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function splitList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
    return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

function setLastError(err) {
    stats.lastError = {
        message: String(err?.message || err || ''),
        at: new Date().toISOString(),
    };
}

function projectRoot() {
    const basePath = config.PROJECT_BASE_PATH || process.env.PROJECT_BASE_PATH || path.resolve(__dirname, '..', '..', '..');
    return path.basename(basePath).toLowerCase() === 'vcpdistributedserver'
        ? path.dirname(basePath)
        : basePath;
}

function appDataRoot() {
    return path.join(projectRoot(), 'AppData');
}

function settingsPath() {
    return path.join(appDataRoot(), 'settings.json');
}

function agentsDir() {
    return path.join(appDataRoot(), 'Agents');
}

function userDataDir() {
    return path.join(appDataRoot(), 'UserData');
}

function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        warn(`读取 JSON 失败: ${filePath} - ${err.message}`);
        return fallback;
    }
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function loadSettings() {
    return readJson(settingsPath(), {}) || {};
}

function loadBridgeConfig() {
    return {
        appId: String(getConfigValue('FeishuAppId') || '').trim(),
        appSecret: String(getConfigValue('FeishuAppSecret') || '').trim(),
        bindAgent: String(getConfigValue('FeishuBindAgent') || '').trim(),
        allowedUsers: splitList(getConfigValue('FeishuAllowedUsers')),
        streamReply: toBoolean(getConfigValue('FeishuStreamReply'), true),
        streamHint: String(getConfigValue('FeishuStreamHint') || DEFAULT_STREAM_HINT),
    };
}

function randomSuffix(length = 7) {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function safeIdPart(value) {
    return String(value || 'unknown')
        .trim()
        .replace(/[^\w.-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'unknown';
}

function sessionKeyFor(chatId, senderId) {
    return `feishu_${safeIdPart(chatId || senderId || 'chat')}`;
}

function normalizeHistory(value) {
    return Array.isArray(value) ? value : [];
}

function getAgentDisplayName(agentId, agentConfig) {
    return agentConfig?.name || agentConfig?.chineseName || agentConfig?.baseName || agentId;
}

function findAgent(bindAgent) {
    const wanted = String(bindAgent || '').trim();
    const wantedLower = wanted.toLowerCase();
    if (!wanted || !fs.existsSync(agentsDir())) return null;

    for (const folder of fs.readdirSync(agentsDir())) {
        const folderPath = path.join(agentsDir(), folder);
        if (!fs.statSync(folderPath).isDirectory()) continue;
        const configPath = path.join(folderPath, 'config.json');
        const agentConfig = readJson(configPath, null);
        if (!agentConfig) continue;

        const aliases = [
            folder,
            agentConfig.id,
            agentConfig.name,
            agentConfig.chineseName,
            agentConfig.baseName,
        ].map(v => String(v || '').trim()).filter(Boolean);

        if (aliases.includes(wanted) || aliases.some(alias => alias.toLowerCase() === wantedLower)) {
            return { id: folder, dir: folderPath, configPath, config: agentConfig };
        }
    }
    return null;
}

function listFeishuTopics(bindAgent = '') {
    const bridgeConfig = loadBridgeConfig();
    const agent = findAgent(bindAgent || bridgeConfig.bindAgent);
    if (!agent) throw new Error(`未找到绑定 Agent: ${bindAgent || bridgeConfig.bindAgent}`);

    const latestConfig = readJson(agent.configPath, agent.config) || {};
    const topics = Array.isArray(latestConfig.topics) ? latestConfig.topics : [];

    return topics
        .filter(topic => String(topic?._metadata?.source || '') === PLUGIN_NAME)
        .map(topic => {
            const meta = topic._metadata || {};
            return {
                topicId: topic.id || null,
                name: topic.name || null,
                createdAt: topic.createdAt || null,
                session: meta.sessionKey || null,
                target: meta.targetId || meta.chatId || meta.userId || null,
                receiveIdType: meta.receiveIdType || null,
                chatType: meta.chatType || null,
                chatId: meta.chatId || null,
                userId: meta.userId || null,
            };
        });
}

function listFeishuGroups(bindAgent = '') {
    return listFeishuTopics(bindAgent).filter(item => item.chatType === 'group');
}

async function fetchFeishuChatInfo(chatId, bridgeConfig = loadBridgeConfig()) {
    if (!chatId) return null;
    const token = await tenantAccessToken(bridgeConfig);
    const response = await fetchWithTimeout(
        `https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
        {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        },
        FEISHU_HTTP_TIMEOUT_MS,
        '获取飞书群聊信息'
    );
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data.msg || data.message || `HTTP ${response.status}`);
    assertFeishuOk(data, '获取飞书群聊信息');
    return data.data?.chat || null;
}

async function fetchFeishuUserInfo(userId, bridgeConfig = loadBridgeConfig()) {
    if (!userId) return null;
    const token = await tenantAccessToken(bridgeConfig);
    const response = await fetchWithTimeout(
        `https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(userId)}?user_id_type=open_id`,
        {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        },
        FEISHU_HTTP_TIMEOUT_MS,
        '获取飞书用户信息'
    );
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data.msg || data.message || `HTTP ${response.status}`);
    assertFeishuOk(data, '获取飞书用户信息');
    return data.data?.user || null;
}

async function enrichFeishuTopic(item, bridgeConfig = loadBridgeConfig()) {
    const enriched = { ...item, displayName: item.name || item.target || item.topicId };
    try {
        if (item.chatType === 'group' && item.chatId) {
            const chat = await fetchFeishuChatInfo(item.chatId, bridgeConfig);
            if (chat) {
                enriched.displayName = chat.name || enriched.displayName;
                enriched.chatName = chat.name || null;
                enriched.memberCount = chat.member_count ?? null;
                enriched.description = chat.description || null;
            }
            return enriched;
        }

        if (item.userId) {
            const user = await fetchFeishuUserInfo(item.userId, bridgeConfig);
            if (user) {
                enriched.displayName = user.name || user.en_name || enriched.displayName;
                enriched.userName = user.name || null;
                enriched.userEnName = user.en_name || null;
            }
        }
    } catch (err) {
        enriched.lookupError = err.message;
    }
    return enriched;
}

async function listFeishuTopicsDetailed(bindAgent = '') {
    const bridgeConfig = loadBridgeConfig();
    const topics = listFeishuTopics(bindAgent);
    return Promise.all(topics.map(item => enrichFeishuTopic(item, bridgeConfig)));
}

async function listFeishuGroupsDetailed(bindAgent = '') {
    const groups = listFeishuGroups(bindAgent);
    const bridgeConfig = loadBridgeConfig();
    return Promise.all(groups.map(item => enrichFeishuTopic(item, bridgeConfig)));
}

function inferReceiveIdType(target, explicitType) {
    const explicit = String(explicitType || '').trim();
    if (explicit) return explicit;
    const id = String(target || '').trim();
    if (id.startsWith('ou_')) return 'open_id';
    if (id.startsWith('oc_')) return 'chat_id';
    return 'chat_id';
}

function topicTitleFor(chatType, targetId) {
    const suffix = safeIdPart(targetId).slice(0, 32);
    return `飞书${chatType === 'group' ? '群聊' : '私聊'} ${suffix}`;
}

function topicHistoryPath(agentId, topicId) {
    return path.join(userDataDir(), agentId, 'topics', topicId, 'history.json');
}

function findFeishuTopic(agentConfig, matchValue) {
    const topics = Array.isArray(agentConfig?.topics) ? agentConfig.topics : [];
    if (!matchValue) return null;
    return topics.find(topic => {
        const meta = topic?._metadata || {};
        return topic.id === matchValue
            || meta.sessionKey === matchValue
            || meta.chatId === matchValue
            || meta.userId === matchValue;
    }) || null;
}

function ensureFeishuTopic(agent, session) {
    const latestConfig = readJson(agent.configPath, agent.config) || {};
    latestConfig.topics = Array.isArray(latestConfig.topics) ? latestConfig.topics : [];

    let topic = findFeishuTopic(latestConfig, session.sessionKey);
    let created = false;
    if (!topic) {
        const now = Date.now();
        topic = {
            id: `topic_${now}`,
            name: topicTitleFor(session.chatType, session.targetId),
            createdAt: now,
            locked: false,
            unread: true,
            creatorSource: `plugin:${PLUGIN_NAME}`,
            _metadata: {
                source: PLUGIN_NAME,
                sessionKey: session.sessionKey,
                chatId: session.chatId || null,
                userId: session.senderId || null,
                targetId: session.targetId || null,
                receiveIdType: session.receiveIdType,
                chatType: session.chatType,
            },
        };
        latestConfig.topics.unshift(topic);
        created = true;
        stats.topicsCreated++;
        log(`首次连接已创建话题会话: agent=${agent.id} topic=${topic.id} session=${session.sessionKey}`);
    } else {
        topic.unread = true;
        topic.locked = false;
        topic._metadata = {
            ...(topic._metadata || {}),
            source: PLUGIN_NAME,
            sessionKey: session.sessionKey,
            chatId: session.chatId || topic._metadata?.chatId || null,
            userId: session.senderId || topic._metadata?.userId || null,
            targetId: session.targetId || topic._metadata?.targetId || null,
            receiveIdType: session.receiveIdType || topic._metadata?.receiveIdType || null,
            chatType: session.chatType || topic._metadata?.chatType || null,
        };
    }

    writeJson(agent.configPath, latestConfig);

    const historyPath = topicHistoryPath(agent.id, topic.id);
    if (!fs.existsSync(historyPath)) writeJson(historyPath, []);

    stats.lastTopicId = topic.id;
    stats.lastSessionKey = session.sessionKey;
    return { agentId: agent.id, agentConfig: latestConfig, topic, historyPath, created, session };
}

function buildUserMessage(text, session, timestamp = Date.now()) {
    return {
        role: 'user',
        name: session.senderName || '飞书用户',
        content: text,
        timestamp,
        id: `msg_${timestamp}_user_${randomSuffix()}`,
        attachments: [],
        _metadata: {
            source: PLUGIN_NAME,
            feishuMessageId: session.messageId || null,
            feishuSenderId: session.senderId || null,
            feishuChatId: session.chatId || null,
            feishuChatType: session.chatType || null,
        },
    };
}

function buildAssistantMessage(text, agentId, agentConfig, session, timestamp = Date.now()) {
    return {
        role: 'assistant',
        name: getAgentDisplayName(agentId, agentConfig),
        content: text,
        timestamp,
        id: `msg_${timestamp}_assistant_${randomSuffix()}`,
        isThinking: false,
        avatarUrl: agentConfig.avatarUrl || 'assets/default_avatar.png',
        avatarColor: agentConfig.avatarCalculatedColor || agentConfig.avatarColor || 'rgb(96,106,116)',
        isGroupMessage: false,
        agentId,
        finishReason: 'completed',
        _metadata: {
            source: PLUGIN_NAME,
            feishuSourceMessageId: session.messageId || null,
            feishuChatId: session.chatId || null,
            feishuChatType: session.chatType || null,
        },
    };
}

function appendHistory(historyPath, ...messages) {
    const history = normalizeHistory(readJson(historyPath, []));
    history.push(...messages.filter(Boolean));
    writeJson(historyPath, history);
    return history;
}

function stripMentionPrefix(text) {
    const trimmed = String(text || '').trim();
    const match = trimmed.match(/^@\S+\s+([\s\S]+)$/);
    return match && match[1].trim() ? match[1].trim() : trimmed;
}

function historyToVcpMessage(message) {
    if (!message || !['user', 'assistant'].includes(message.role)) return null;
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '');
    if (!content) return null;
    const vcpMessage = { role: message.role, content };
    if (message.name) {
        vcpMessage.name = String(message.name).replace(/[^\w-]/g, '_').slice(0, 64) || undefined;
    }
    if (message.id && typeof message.timestamp === 'number') {
        vcpMessage.__vcpchatTimestampMeta = {
            messageId: message.id,
            role: message.role,
            timestamp: message.timestamp,
        };
    }
    return vcpMessage;
}

function sha256(value) {
    return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function messageTextForHash(message) {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        return message.content.filter(part => part?.type === 'text').map(part => part.text).join('\n');
    }
    return JSON.stringify(message.content || '');
}

function buildVcpChatExtensions(messages) {
    const messageTimestampBindings = [];
    messages.forEach((message, index) => {
        const meta = message.__vcpchatTimestampMeta;
        if (!meta || !meta.messageId || typeof meta.timestamp !== 'number') return;
        messageTimestampBindings.push({
            messageId: meta.messageId,
            role: message.role || meta.role,
            timestamp: meta.timestamp,
            timestampIso: new Date(meta.timestamp).toISOString(),
            source: 'client_history',
            sentMessageHash: sha256(messageTextForHash(message)),
            sentMessageIndex: index,
        });
    });
    if (messageTimestampBindings.length === 0) return null;
    return { schemaVersion: 1, messageMetadataMode: 'hash_only', messageTimestampBindings };
}

function stripInternalMessageFields(messages) {
    return messages.map(message => {
        const { __vcpchatTimestampMeta, ...clean } = message;
        return clean;
    });
}

function formatTopicTime(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function buildSystemPrompt(agentId, agentConfig, topicSession) {
    let prompt = agentConfig.systemPrompt || `你是 ${getAgentDisplayName(agentId, agentConfig)}。`;
    const agentName = getAgentDisplayName(agentId, agentConfig);
    prompt = prompt.replace(/\{\{AgentName\}\}/g, agentName).replace(/\{\{MaidName\}\}/g, agentName);

    const lines = [];
    lines.push(`当前聊天记录文件路径: ${topicSession.historyPath}`);
    if (topicSession.topic?.createdAt) lines.push(`当前话题创建于 ${formatTopicTime(topicSession.topic.createdAt)}`);
    lines.push(`当前飞书会话 session: ${topicSession.session.sessionKey}`);
    lines.push(`当前飞书话题 topic_id: ${topicSession.topic.id}`);
    lines.push(`当前飞书目标 target: ${topicSession.session.targetId}`);
    lines.push(`当前飞书目标类型 receive_id_type: ${topicSession.session.receiveIdType}`);
    lines.push('如需主动给当前飞书会话或其他飞书用户/群发消息，调用 VCPFeishu 的 FeishuSend。');

    const withContext = `${lines.join('\n')}\n\n${prompt}`.trim();
    return withContext.includes('{{VCPFeishu}}') ? withContext : `${withContext}\n\n{{VCPFeishu}}`;
}

function modelConfigFromAgent(agentConfig) {
    const modelConfig = {};
    if (agentConfig.model || agentConfig.modelId) modelConfig.model = agentConfig.model || agentConfig.modelId;
    if (agentConfig.temperature !== undefined && agentConfig.temperature !== null) modelConfig.temperature = Number(agentConfig.temperature);
    if (agentConfig.maxOutputTokens !== undefined && agentConfig.maxOutputTokens !== null) modelConfig.max_tokens = Number.parseInt(agentConfig.maxOutputTokens, 10);
    if (agentConfig.contextTokenLimit !== undefined && agentConfig.contextTokenLimit !== null) modelConfig.contextTokenLimit = Number.parseInt(agentConfig.contextTokenLimit, 10);
    if (agentConfig.top_p !== undefined && agentConfig.top_p !== null) modelConfig.top_p = Number(agentConfig.top_p);
    if (agentConfig.top_k !== undefined && agentConfig.top_k !== null) modelConfig.top_k = Number.parseInt(agentConfig.top_k, 10);
    modelConfig.stream = toBoolean(agentConfig.streamOutput, false);
    return modelConfig;
}

function buildMessagesForVcp(topicSession) {
    const history = normalizeHistory(readJson(topicSession.historyPath, []));
    const messages = history.map(historyToVcpMessage).filter(Boolean);
    messages.unshift({
        role: 'system',
        content: buildSystemPrompt(topicSession.agentId, topicSession.agentConfig, topicSession),
    });
    return messages;
}

function vcpUrlFromSettings(settings) {
    const baseUrl = settings.vcpServerUrl;
    if (!baseUrl) throw new Error('settings.json 缺少 vcpServerUrl');
    if (settings.enableVcpToolInjection !== true) return baseUrl;
    try {
        const url = new URL(baseUrl);
        url.pathname = '/v1/chatvcp/completions';
        return url.toString();
    } catch (_) {
        return baseUrl;
    }
}

async function fetchWithTimeout(url, options, timeoutMs = FEISHU_HTTP_TIMEOUT_MS, operationName = 'HTTP 请求') {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error(`${operationName} 超时（${timeoutMs}ms）`);
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function postJson(url, body, { headers = {}, timeoutMs = FEISHU_HTTP_TIMEOUT_MS, operationName = 'HTTP 请求' } = {}) {
    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    }, timeoutMs, operationName);
    const text = await response.text();
    let data = {};
    if (text) {
        try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    }
    if (!response.ok) {
        throw new Error(`${operationName}失败: ${data.msg || data.message || data.raw || `HTTP ${response.status}`}`);
    }
    return data;
}

function assertFeishuOk(data, operationName) {
    if (data && data.code !== undefined && data.code !== 0) {
        throw new Error(`${operationName}失败: ${data.msg || data.message || `code=${data.code}`}`);
    }
}

async function tenantAccessToken(bridgeConfig = loadBridgeConfig()) {
    const now = Date.now();
    if (
        tenantTokenCache.token &&
        tenantTokenCache.appId === bridgeConfig.appId &&
        tenantTokenCache.appSecret === bridgeConfig.appSecret &&
        tenantTokenCache.expiresAt - now > 60000
    ) {
        return tenantTokenCache.token;
    }

    const data = await postJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: bridgeConfig.appId,
        app_secret: bridgeConfig.appSecret,
    }, { operationName: '获取飞书 tenant_access_token' });
    assertFeishuOk(data, '获取飞书 tenant_access_token');
    if (!data.tenant_access_token) throw new Error('获取飞书 tenant_access_token 失败: 响应缺少 token');

    const expire = Number.parseInt(data.expire, 10);
    tenantTokenCache = {
        appId: bridgeConfig.appId,
        appSecret: bridgeConfig.appSecret,
        token: data.tenant_access_token,
        expiresAt: now + Math.max(60, Number.isFinite(expire) ? expire - 180 : 6900) * 1000,
    };
    return tenantTokenCache.token;
}

async function sendFeishuText(target, text, { replyToMessageId = '', receiveIdType = '' } = {}) {
    const bridgeConfig = loadBridgeConfig();
    if (!bridgeConfig.appId || !bridgeConfig.appSecret) throw new Error('缺少飞书凭证，无法发送消息');
    const token = await tenantAccessToken(bridgeConfig);
    const content = JSON.stringify({ text });

    if (replyToMessageId) {
        const data = await postJson(
            `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`,
            { msg_type: 'text', content },
            { headers: { Authorization: `Bearer ${token}` }, operationName: '回复飞书消息' }
        );
        assertFeishuOk(data, '回复飞书消息');
        return data;
    }

    const idType = inferReceiveIdType(target, receiveIdType);
    const data = await postJson(
        `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(idType)}`,
        { receive_id: target, msg_type: 'text', content },
        { headers: { Authorization: `Bearer ${token}` }, operationName: '发送飞书消息' }
    );
    assertFeishuOk(data, '发送飞书消息');
    return data;
}

async function readStreamResponse(response) {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder('utf8');
    let buffer = '';
    let content = '';

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                const json = JSON.parse(payload);
                content += json.choices?.[0]?.delta?.content
                    || json.choices?.[0]?.message?.content
                    || json.choices?.[0]?.text
                    || '';
            } catch (_) {
                content += payload;
            }
        }
    }
    return content;
}

async function callVcpAgent(topicSession) {
    const settings = loadSettings();
    if (!settings.vcpApiKey) throw new Error('settings.json 缺少 vcpApiKey');
    const messages = buildMessagesForVcp(topicSession);
    const modelConfig = modelConfigFromAgent(topicSession.agentConfig);
    const messageId = `msg_feishu_${Date.now()}_${randomSuffix()}`;
    const vcpchatExtensions = buildVcpChatExtensions(messages);
    const body = {
        messages: stripInternalMessageFields(messages),
        ...modelConfig,
        requestId: messageId,
    };
    if (vcpchatExtensions) body.vcpchatExtensions = vcpchatExtensions;

    const response = await fetch(vcpUrlFromSettings(settings), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.vcpApiKey}`,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status} - ${text || 'VCP 请求失败'}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (modelConfig.stream === true && !contentType.includes('application/json')) {
        const streamed = await readStreamResponse(response);
        if (streamed) return streamed;
        return '';
    }

    const text = await response.text();
    let data = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch (_) {
        return text;
    }
    return data?.choices?.[0]?.message?.content
        || data?.choices?.[0]?.text
        || data?.content
        || '';
}

function pruneProcessedMessages(now = Date.now()) {
    for (const [messageId, seenAt] of processedMessageIds) {
        if (now - seenAt > MESSAGE_DEDUPE_TTL_MS) processedMessageIds.delete(messageId);
    }
}

function isDuplicateMessage(messageId) {
    if (!messageId) return false;
    const now = Date.now();
    pruneProcessedMessages(now);
    if (processedMessageIds.has(messageId)) return true;
    processedMessageIds.set(messageId, now);
    return false;
}

function isUserAllowed(senderId, bridgeConfig) {
    return bridgeConfig.allowedUsers.length === 0 || bridgeConfig.allowedUsers.includes(senderId);
}

function isGroupMentioned(message) {
    const mentions = message.mentions || [];
    if (!Array.isArray(mentions) || mentions.length === 0) return false;
    return mentions.some(item => item.tenant_key || item.name === config.botName);
}

function parseFeishuEvent(rawEvent) {
    const event = rawEvent.event || rawEvent;
    const message = event.message || event;
    const sender = event.sender || message.sender || {};
    const senderId = sender.sender_id?.open_id || sender.sender_id?.user_id || sender.sender_id?.union_id || '';
    const chatType = message.chat_type || event.chat_type || 'p2p';
    const chatId = chatType === 'group' ? message.chat_id : senderId;
    const targetId = chatId || senderId;
    const receiveIdType = chatType === 'group' ? 'chat_id' : inferReceiveIdType(targetId);
    let text = '';

    try {
        const content = typeof message.content === 'string' ? JSON.parse(message.content) : message.content;
        text = content?.text || '';
    } catch (_) {
        text = String(message.content || '');
    }

    return {
        message,
        type: message.msg_type || message.message_type,
        messageId: message.message_id || event.message_id || '',
        senderId,
        senderName: sender.sender_id?.union_id || senderId || '飞书用户',
        chatType,
        chatId,
        targetId,
        receiveIdType,
        sessionKey: sessionKeyFor(chatId, senderId),
        text: stripMentionPrefix(text),
    };
}

async function handleFeishuEvent(rawEvent) {
    const bridgeConfig = loadBridgeConfig();
    const session = parseFeishuEvent(rawEvent);

    if (session.type !== 'text') {
        debug('跳过非文本消息:', session.type);
        return;
    }
    if (isDuplicateMessage(session.messageId)) {
        debug('跳过重复消息:', session.messageId);
        return;
    }
    if (session.chatType === 'group' && !isGroupMentioned(session.message)) {
        debug('群聊消息未 @ 机器人，跳过');
        return;
    }
    if (!session.senderId) {
        warn('消息缺少 sender_id');
        return;
    }
    if (!isUserAllowed(session.senderId, bridgeConfig)) {
        log('用户不在白名单中:', session.senderId);
        return;
    }
    if (!session.text) {
        debug('消息内容为空');
        return;
    }

    stats.messagesReceived++;
    stats.lastMessageAt = new Date().toISOString();
    log(`收到消息: from=${session.senderId} chat_type=${session.chatType} text=${session.text.slice(0, 80)}`);

    const agent = findAgent(bridgeConfig.bindAgent);
    if (!agent) throw new Error(`未找到绑定 Agent: ${bridgeConfig.bindAgent}`);

    const topicSession = ensureFeishuTopic(agent, session);
    appendHistory(topicSession.historyPath, buildUserMessage(session.text, session));

    if (bridgeConfig.streamReply) {
        try {
            await sendFeishuText(session.targetId, bridgeConfig.streamHint, { replyToMessageId: session.messageId });
        } catch (err) {
            warn('发送提示语失败:', err.message);
        }
    }

    try {
        const reply = await callVcpAgent(topicSession);
        if (!reply) throw new Error('VCP 后端未返回有效回复');
        await sendFeishuText(session.targetId, reply, { replyToMessageId: session.messageId });
        appendHistory(topicSession.historyPath, buildAssistantMessage(reply, agent.id, topicSession.agentConfig, session));
        stats.messagesProcessed++;
        log(`回复已发送: target=${session.targetId} topic=${topicSession.topic.id} length=${reply.length}`);
    } catch (err) {
        stats.messagesFailed++;
        setLastError(err);
        warn('处理消息失败:', err.message);
        try {
            await sendFeishuText(session.targetId, `抱歉，处理出错：${err.message}`, { replyToMessageId: session.messageId });
        } catch (_) {}
    }
}

function resolveSendTarget({ target = '', receiveIdType = '', session = '', topicId = '' } = {}) {
    if (target) {
        return { target, receiveIdType: inferReceiveIdType(target, receiveIdType) };
    }

    const bridgeConfig = loadBridgeConfig();
    const agent = findAgent(bridgeConfig.bindAgent);
    if (!agent) throw new Error(`未找到绑定 Agent: ${bridgeConfig.bindAgent}`);

    const topic = findFeishuTopic(agent.config, topicId || session);
    if (!topic) throw new Error('缺少 target，且无法通过 session/topic_id 找到飞书会话');
    const meta = topic._metadata || {};
    const resolvedTarget = meta.targetId || meta.chatId || meta.userId;
    if (!resolvedTarget) throw new Error(`话题 ${topic.id} 缺少飞书目标元数据`);

    return {
        target: resolvedTarget,
        receiveIdType: inferReceiveIdType(resolvedTarget, receiveIdType || meta.receiveIdType),
        sessionKey: meta.sessionKey || null,
        topicId: topic.id,
    };
}

async function sendMessage(target, content, receiveIdType, options = {}) {
    const resolved = resolveSendTarget({
        target: String(target || '').trim(),
        receiveIdType: String(receiveIdType || '').trim(),
        session: String(options.session || options.sessionKey || '').trim(),
        topicId: String(options.topicId || options.topic_id || '').trim(),
    });
    const result = await sendFeishuText(resolved.target, content, { receiveIdType: resolved.receiveIdType });
    return {
        ...result,
        resolvedTarget: resolved.target,
        receiveIdType: resolved.receiveIdType,
        sessionKey: resolved.sessionKey,
        topicId: resolved.topicId,
    };
}

async function initialize(pluginConfig = {}) {
    configure(pluginConfig);
    stats.connected = false;
    stats.startedAt = new Date().toISOString();
    stats.lastError = null;

    const bridgeConfig = loadBridgeConfig();
    const missing = [];
    if (!bridgeConfig.appId) missing.push('FeishuAppId');
    if (!bridgeConfig.appSecret) missing.push('FeishuAppSecret');
    if (!bridgeConfig.bindAgent) missing.push('FeishuBindAgent');
    if (missing.length > 0) {
        const err = new Error(`配置缺失: ${missing.join(', ')}`);
        setLastError(err);
        throw err;
    }
    if (!findAgent(bridgeConfig.bindAgent)) {
        const err = new Error(`未找到绑定 Agent: ${bridgeConfig.bindAgent}`);
        setLastError(err);
        throw err;
    }

    try {
        lark = require('@larksuiteoapi/node-sdk');
    } catch (err) {
        setLastError(err);
        throw new Error(`加载 @larksuiteoapi/node-sdk 失败: ${err.message}`);
    }

    const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async data => {
            try {
                await handleFeishuEvent(data);
            } catch (err) {
                setLastError(err);
                warn('消息处理异常:', err.message);
            }
        },
    });

    try {
        let readySettled = false;
        let resolveReady;
        let rejectReady;
        const readyPromise = new Promise((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        const settleReady = (err) => {
            if (readySettled) return;
            readySettled = true;
            if (err) rejectReady(err);
            else resolveReady();
        };
        const readyTimeout = setTimeout(() => {
            settleReady(new Error(`飞书 WebSocket 连接超时（${FEISHU_WS_READY_TIMEOUT_MS}ms）`));
        }, FEISHU_WS_READY_TIMEOUT_MS);

        wsClient = new lark.WSClient({
            appId: bridgeConfig.appId,
            appSecret: bridgeConfig.appSecret,
            loggerLevel: debugMode ? lark.LoggerLevel.debug : lark.LoggerLevel.warn,
            autoReconnect: true,
            onReady: () => {
                stats.connected = true;
                settleReady();
            },
            onError: err => {
                stats.connected = false;
                setLastError(err);
                settleReady(err);
                warn('WebSocket 错误:', err.message);
            },
            onReconnecting: () => { stats.connected = false; },
            onReconnected: () => { stats.connected = true; },
            handshakeTimeoutMs: 30000,
            wsConfig: { pingTimeout: 90 },
        });
        await wsClient.start({ eventDispatcher });
        await readyPromise.finally(() => clearTimeout(readyTimeout));
        log(`WebSocket 已连接，绑定 Agent=${bridgeConfig.bindAgent}`);
    } catch (err) {
        stats.connected = false;
        setLastError(err);
        shutdown();
        throw err;
    }
}

function shutdown() {
    try {
        if (wsClient && typeof wsClient.close === 'function') wsClient.close();
    } catch (err) {
        warn('关闭 WebSocket 异常:', err.message);
    }
    wsClient = null;
    stats.connected = false;
    tenantTokenCache = { appId: '', appSecret: '', token: '', expiresAt: 0 };
}

function getStatus() {
    const bridgeConfig = loadBridgeConfig();
    const settings = loadSettings();
    return {
        ...stats,
        connected: stats.connected,
        appId: bridgeConfig.appId ? `${bridgeConfig.appId.slice(0, 8)}***` : null,
        bindAgent: bridgeConfig.bindAgent || null,
        systemSettings: {
            vcpServerUrl: settings.vcpServerUrl || null,
            enableVcpToolInjection: settings.enableVcpToolInjection === true,
        },
    };
}

module.exports = {
    configure,
    initialize,
    shutdown,
    sendMessage,
    getStatus,
    listFeishuTopics,
    listFeishuGroups,
    listFeishuTopicsDetailed,
    listFeishuGroupsDetailed,
};
