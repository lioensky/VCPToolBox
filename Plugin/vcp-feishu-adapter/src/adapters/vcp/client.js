/**
 * VCP 客户端 - 支持 B2 ChannelHub 协议和 B1 兼容模式
 * 飞书适配器版本
 */

function joinUrl(base, path) {
  if (/^https?:\/\//i.test(String(path || ''))) return String(path);
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

function isDebugRawResponseEnabled() {
  return String(process.env.VCP_DEBUG_RAW_RESPONSE || '').toLowerCase() === 'true';
}

function summarizeValue(value, depth = 0) {
  if (depth > 2) return '[MaxDepth]';
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}...[${value.length}]` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return { type: 'array', length: value.length, sample: value.slice(0, 3).map(v => summarizeValue(v, depth + 1)) };
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 20)) out[k] = summarizeValue(v, depth + 1);
  return out;
}

function logRawResponse(data, logger = console) {
  try {
    logger.info('[vcpClient] raw response summary =>', summarizeValue(data));
    if (isDebugRawResponseEnabled()) logger.info(`[vcpClient] RAW RESPONSE >>>\n${JSON.stringify(data, null, 2)}`);
  } catch (error) { logger.warn?.('[vcpClient] raw response logging failed', error); }
}

async function parseResponse(resp) {
  const raw = await resp.text();
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  try { return JSON.parse(raw); } catch { return raw; }
}

function collectTextFromOpenAIMessage(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map(item => {
      if (!item) return '';
      if (item.type === 'text') return item.text || '';
      if (item.type === 'image_url') return item.image_url?.url ? `[图片: ${item.image_url.url}]` : '[图片]';
      return '';
    }).filter(Boolean).join('');
  }
  return '';
}

function extractRichReply(vcpResponse) {
  if (!vcpResponse) return { text: '', options: [] };
  if (vcpResponse.reply) {
    const reply = vcpResponse.reply;
    let text = '';
    if (typeof reply.text === 'string') text = reply.text;
    else if (reply.messages) {
      text = reply.messages.map(msg => {
        if (typeof msg.text === 'string') return msg.text;
        if (Array.isArray(msg.content)) return msg.content.map(c => c.type === 'text' ? c.text : '').filter(Boolean).join('');
        return '';
      }).filter(Boolean).join('\n');
    }
    const options = (reply.options || []).map(opt => ({ label: opt.label || opt, value: opt.value || opt }));
    return { text, options };
  }
  if (vcpResponse.reply?.text) return { text: vcpResponse.reply.text, options: [] };
  if (vcpResponse.choices && Array.isArray(vcpResponse.choices)) {
    const text = vcpResponse.choices.map(choice => collectTextFromOpenAIMessage(choice.message)).join('\n');
    return { text, options: [] };
  }
  if (typeof vcpResponse === 'string') return { text: vcpResponse, options: [] };
  return { text: '', options: [] };
}

function buildB2Message(params) {
  const { agentName, agentDisplayName, externalSessionKey, message, metadata = {}, conversationId, userId, chatType = 'single', adapterId, model } = params;
  let content = [];
  if (typeof message === 'string') content.push({ type: 'text', text: message });
  else if (message.type) content.push(message);

  return {
    version: '2.0',
    eventId: `feishu_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    adapterId: adapterId || 'feishu-main',
    channel: 'feishu',
    eventType: 'message.created',
    occurredAt: Date.now(),
    requestId: `req_${Date.now()}`,
    target: { agentId: agentName, itemType: 'agent', itemId: agentName },
    client: { clientType: 'feishu', conversationId: conversationId || metadata.conversationId || '', conversationType: chatType === 'group' ? 'group' : 'single', messageId: metadata.messageId || `msg_${Date.now()}` },
    sender: { userId: userId || metadata.userId || '', nick: metadata.nick || '', isAdmin: metadata.isAdmin || false },
    session: { bindingKey: externalSessionKey || `feishu:${chatType}:${conversationId || ''}:${userId || ''}`, currentTopicId: null, allowCreateTopic: true, allowSwitchTopic: true },
    payload: { messages: [{ role: 'user', content }] },
    runtime: { stream: false, model: model || agentName },
    metadata: { platform: 'feishu', ...metadata },
  };
}

function buildB1Message(params) {
  const { agentName, agentDisplayName, externalSessionKey, message, metadata = {}, conversationId, userId, chatType = 'single', model } = params;
  let content = [];
  if (typeof message === 'string') content.push({ type: 'text', text: message });
  else if (message.type) content.push(message);

  return {
    channel: 'feishu', agentId: agentName, agentName: agentDisplayName, itemType: 'agent', itemId: agentName,
    requestId: `feishu_${Date.now()}`, stream: false,
    client: { clientType: 'feishu', clientId: 'feishu', conversationId: conversationId || metadata.conversationId || '', conversationType: chatType === 'group' ? 'group' : 'single', conversationTitle: metadata.conversationTitle || '', messageId: metadata.messageId || `msg_${Date.now()}`, timestamp: Date.now() },
    sender: { userId: userId || metadata.userId || '', nick: metadata.nick || '', isAdmin: metadata.isAdmin || false },
    topicControl: { bindingKey: externalSessionKey || `feishu:${chatType}:${conversationId || ''}:${userId || ''}`, currentTopicId: null, allowCreateTopic: true, allowSwitchTopic: true },
    messages: [{ role: 'user', content }],
    modelConfig: { model: model || agentName, stream: false },
    metadata: { platform: 'feishu', ...metadata },
  };
}

async function sendMessage(params) {
  const { channelHubUrl, adapterId, adapterKey, useChannelHub, bridgeUrl, bridgeKey, useBridge, baseUrl, chatPath, apiKey, model, defaultAgentName, defaultAgentDisplayName, timeoutMs, logger } = this;
  const agentName = params.agentName || defaultAgentName;
  const agentDisplayName = params.agentDisplayName || defaultAgentDisplayName;
  const externalSessionKey = params.externalSessionKey || null;
  const message = params.message;
  const metadata = params.metadata || {};
  const conversationId = metadata.conversationId;
  const userId = metadata.userId;
  const chatType = metadata.chatType || 'single';

  if (useChannelHub && channelHubUrl) {
    try {
      const b2Message = buildB2Message({ agentName, agentDisplayName, externalSessionKey, message, metadata, conversationId, userId, chatType, adapterId, model });
      logger.debug('[vcpClient] sending B2 message to ChannelHub');
      const resp = await fetch(channelHubUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-channel-adapter-id': adapterId, 'x-channel-bridge-key': adapterKey, 'x-channel-request-timestamp': String(Date.now()) }, body: JSON.stringify(b2Message), signal: AbortSignal.timeout(timeoutMs || 120000) });
      if (!resp.ok) {
        logger.warn(`[vcpClient] ChannelHub B2 failed: ${resp.status}, falling back to B1`);
        if (useBridge && bridgeUrl) return await this._sendB1Message(params);
        throw new Error(`ChannelHub B2 failed: ${resp.status}`);
      }
      const data = await parseResponse(resp);
      logRawResponse(data, logger);
      return data;
    } catch (error) {
      logger.warn('[vcpClient] B2 failed, trying B1 fallback:', error.message);
      if (useBridge && bridgeUrl) return await this._sendB1Message(params);
      throw error;
    }
  }
  if (useBridge && bridgeUrl) return await this._sendB1Message(params);
  return await this._sendOpenAIMessage(params);
}

async function _sendB1Message(params) {
  const { bridgeUrl, bridgeKey, defaultAgentName, defaultAgentDisplayName, timeoutMs, logger } = this;
  const b1Message = buildB1Message({ ...params, agentName: params.agentName || defaultAgentName, agentDisplayName: params.agentDisplayName || defaultAgentDisplayName });
  logger.debug('[vcpClient] sending B1 message to Bridge');
  const resp = await fetch(bridgeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-channel-bridge-key': bridgeKey, 'Authorization': bridgeKey ? `Bearer ${bridgeKey}` : '' }, body: JSON.stringify(b1Message), signal: AbortSignal.timeout(timeoutMs || 120000) });
  const data = await parseResponse(resp);
  logRawResponse(data, logger);
  return data;
}

async function _sendOpenAIMessage(params) {
  const { baseUrl, chatPath, apiKey, model, defaultAgentName, timeoutMs, logger } = this;
  const url = joinUrl(baseUrl, chatPath);
  const messages = [{ role: 'system', content: `{{${params.agentName || defaultAgentName}}}` }, { role: 'user', content: params.message }];
  logger.debug('[vcpClient] sending OpenAI message to:', url);
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify({ model: model || params.agentName || defaultAgentName, messages, stream: false }), signal: AbortSignal.timeout(timeoutMs || 120000) });
  const data = await parseResponse(resp);
  logRawResponse(data, logger);
  return data;
}

export function createVcpClient(config) {
  const client = {
    channelHubUrl: config.channelHubUrl, adapterId: config.adapterId, adapterKey: config.adapterKey, useChannelHub: config.useChannelHub,
    bridgeUrl: config.bridgeUrl, bridgeKey: config.bridgeKey, useBridge: config.useBridge,
    baseUrl: config.baseUrl, chatPath: config.chatPath, apiKey: config.apiKey, model: config.model,
    defaultAgentName: config.defaultAgentName, defaultAgentDisplayName: config.defaultAgentDisplayName, timeoutMs: config.timeoutMs, logger: config.logger,
    sendMessage: sendMessage.bind(config), extractRichReply,
  };
  client._sendB1Message = _sendB1Message.bind(config);
  client._sendOpenAIMessage = _sendOpenAIMessage.bind(config);
  return client;
}