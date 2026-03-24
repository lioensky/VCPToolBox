/**
 * VCP 客户端 - 支持 B2 ChannelHub 协议和 B1 兼容模式
 */

function joinUrl(base, path) {
  if (/^https?:\/\//i.test(String(path || ''))) {
    return String(path);
  }
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

function decodeEntities(text = '') {
  return String(text)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function stripHtml(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
  ).trim();
}

function isDebugRawResponseEnabled() {
  return String(process.env.VCP_DEBUG_RAW_RESPONSE || '').toLowerCase() === 'true';
}

function summarizeValue(value, depth = 0) {
  if (depth > 2) return '[MaxDepth]';
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > 300 ? `${value.slice(0, 300)}...[${value.length}]` : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      sample: value.slice(0, 3).map((v) => summarizeValue(v, depth + 1)),
    };
  }
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 20)) {
    out[k] = summarizeValue(v, depth + 1);
  }
  return out;
}

function logRawResponse(data, logger = console) {
  try {
    logger.info('[vcpClient] raw response summary =>', summarizeValue(data));
    if (isDebugRawResponseEnabled()) {
      logger.info(`[vcpClient] RAW RESPONSE >>>\n${JSON.stringify(data, null, 2)}`);
    }
  } catch (error) {
    logger.warn?.('[vcpClient] raw response logging failed', error);
  }
}

async function parseResponse(resp) {
  const raw = await resp.text();
  const contentType = resp.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function collectTextFromOpenAIMessage(message) {
  if (!message) return '';

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .map((item) => {
        if (!item) return '';
        if (item.type === 'text') return item.text || '';
        if (item.type === 'image_url') return '[图片]';
        if (item.type === 'image_url' && item.image_url?.url) return `[图片: ${item.image_url.url}]`;
        return '';
      })
      .filter(Boolean)
      .join('');
  }

  return '';
}

/**
 * 从 VCP 响应中提取富回复
 */
function extractRichReply(vcpResponse) {
  if (!vcpResponse) return { text: '', options: [] };

  // B2 协议格式
  if (vcpResponse.reply) {
    const reply = vcpResponse.reply;
    let text = '';

    if (typeof reply.text === 'string') {
      text = reply.text;
    } else if (reply.messages) {
      text = reply.messages
        .map((msg) => {
          if (typeof msg.text === 'string') return msg.text;
          if (Array.isArray(msg.content)) {
            return msg.content
              .map((c) => (c.type === 'text' ? c.text : ''))
              .filter(Boolean)
              .join('');
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }

    // 提取选项（从 B2 选项字段）
    const options = (reply.options || []).map((opt) => ({
      label: opt.label || opt,
      value: opt.value || opt,
    }));

    return { text, options };
  }

  // B1 兼容格式
  if (vcpResponse.reply?.text) {
    return {
      text: vcpResponse.reply.text,
      options: [],
    };
  }

  // OpenAI 兼容格式
  if (vcpResponse.choices && Array.isArray(vcpResponse.choices)) {
    const text = vcpResponse.choices
      .map((choice) => collectTextFromOpenAIMessage(choice.message))
      .join('\n');

    return { text, options: [] };
  }

  // 原始文本
  if (typeof vcpResponse === 'string') {
    return { text: vcpResponse, options: [] };
  }

  return { text: '', options: [] };
}

/**
 * 构建 B2 协议消息
 */
function buildB2Message(params) {
  const {
    agentName,
    agentDisplayName,
    externalSessionKey,
    message,
    metadata = {},
    conversationId,
    userId,
    chatType = 'single',
  } = params;

  // 构建消息内容
  let content = [];
  if (typeof message === 'string') {
    content.push({ type: 'text', text: message });
  } else if (message.type) {
    content.push(message);
  }

  return {
    version: '2.0',
    eventId: `wecom_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    adapterId: params.adapterId || 'wecom-main',
    channel: 'wecom',
    eventType: 'message.created',
    occurredAt: Date.now(),
    requestId: `req_${Date.now()}`,
    target: {
      agentId: agentName,
      itemType: 'agent',
      itemId: agentName,
    },
    client: {
      clientType: 'wecom',
      conversationId: conversationId || metadata.conversationId || '',
      conversationType: chatType === 'group' ? 'group' : 'single',
      messageId: metadata.messageId || `msg_${Date.now()}`,
    },
    sender: {
      userId: userId || metadata.userId || '',
      nick: metadata.nick || '',
      corpId: metadata.corpId || '',
      isAdmin: metadata.isAdmin || false,
    },
    session: {
      bindingKey: externalSessionKey || `wecom:${chatType}:${conversationId || ''}:${userId || ''}`,
      currentTopicId: null,
      allowCreateTopic: true,
      allowSwitchTopic: true,
    },
    payload: {
      messages: [
        {
          role: 'user',
          content,
        },
      ],
    },
    runtime: {
      stream: false,
      model: params.model || agentName,
    },
    metadata: {
      platform: 'wecom',
      ...metadata,
    },
  };
}

/**
 * 构建 B1 兼容协议消息（回退用）
 */
function buildB1Message(params) {
  const {
    agentName,
    agentDisplayName,
    externalSessionKey,
    message,
    metadata = {},
    conversationId,
    userId,
    chatType = 'single',
  } = params;

  // 构建消息内容
  let content = [];
  if (typeof message === 'string') {
    content.push({ type: 'text', text: message });
  } else if (message.type) {
    content.push(message);
  }

  return {
    channel: 'wecom',
    agentId: agentName,
    agentName: agentDisplayName,
    itemType: 'agent',
    itemId: agentName,
    requestId: `wecom_${Date.now()}`,
    stream: false,
    client: {
      clientType: 'wecom',
      clientId: 'wecom',
      conversationId: conversationId || metadata.conversationId || '',
      conversationType: chatType === 'group' ? 'group' : 'single',
      conversationTitle: metadata.conversationTitle || '',
      messageId: metadata.messageId || `msg_${Date.now()}`,
      timestamp: Date.now(),
    },
    sender: {
      userId: userId || metadata.userId || '',
      nick: metadata.nick || '',
      isAdmin: metadata.isAdmin || false,
      corpId: metadata.corpId || '',
    },
    topicControl: {
      bindingKey: externalSessionKey || `wecom:${chatType}:${conversationId || ''}:${userId || ''}`,
      currentTopicId: null,
      allowCreateTopic: true,
      allowSwitchTopic: true,
    },
    messages: [
      {
        role: 'user',
        content,
      },
    ],
    modelConfig: {
      model: params.model || agentName,
      stream: false,
    },
    metadata: {
      platform: 'wecom',
      ...metadata,
    },
  };
}

/**
 * 发送消息到 VCP
 */
async function sendMessage(params) {
  const {
    channelHubUrl,
    adapterId,
    adapterKey,
    useChannelHub,
    bridgeUrl,
    bridgeKey,
    useBridge,
    baseUrl,
    chatPath,
    apiKey,
    model,
    defaultAgentName,
    defaultAgentDisplayName,
    timeoutMs,
    logger,
    onError,
  } = this;

  const agentName = params.agentName || defaultAgentName;
  const agentDisplayName = params.agentDisplayName || defaultAgentDisplayName;
  const externalSessionKey = params.externalSessionKey || null;
  const message = params.message;
  const metadata = params.metadata || {};
  const conversationId = metadata.conversationId;
  const userId = metadata.userId;
  const chatType = metadata.chatType || 'single';

  // 优先使用 B2 ChannelHub
  if (useChannelHub && channelHubUrl) {
    try {
      const b2Message = buildB2Message({
        agentName,
        agentDisplayName,
        externalSessionKey,
        message,
        metadata,
        conversationId,
        userId,
        chatType,
        adapterId,
        model,
      });

      logger.debug('[vcpClient] sending B2 message to ChannelHub:', JSON.stringify(b2Message).slice(0, 200));

      const resp = await fetch(channelHubUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-channel-adapter-id': adapterId,
          'x-channel-bridge-key': adapterKey,
          'x-channel-request-timestamp': String(Date.now()),
        },
        body: JSON.stringify(b2Message),
        signal: AbortSignal.timeout(timeoutMs || 120000),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        logger.warn(`[vcpClient] ChannelHub B2 failed: ${resp.status}, falling back to B1`);

        // B2 失败，尝试 B1
        if (useBridge && bridgeUrl) {
          return await this._sendB1Message(params);
        }

        throw new Error(`ChannelHub B2 failed: ${resp.status} - ${errText}`);
      }

      const data = await parseResponse(resp);
      logRawResponse(data, logger);
      return data;
    } catch (error) {
      logger.warn('[vcpClient] B2 failed, trying B1 fallback:', error.message);

      if (useBridge && bridgeUrl) {
        return await this._sendB1Message(params);
      }

      throw error;
    }
  }

  // 使用 B1 Bridge
  if (useBridge && bridgeUrl) {
    return await this._sendB1Message(params);
  }

  // 使用 OpenAI 兼容接口
  return await this._sendOpenAIMessage(params);
}

/**
 * 发送 B1 消息
 */
async function _sendB1Message(params) {
  const {
    bridgeUrl,
    bridgeKey,
    defaultAgentName,
    defaultAgentDisplayName,
    timeoutMs,
    logger,
  } = this;

  const b1Message = buildB1Message({
    ...params,
    agentName: params.agentName || defaultAgentName,
    agentDisplayName: params.agentDisplayName || defaultAgentDisplayName,
  });

  logger.debug('[vcpClient] sending B1 message to Bridge:', JSON.stringify(b1Message).slice(0, 200));

  const resp = await fetch(bridgeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-channel-bridge-key': bridgeKey,
      'Authorization': bridgeKey ? `Bearer ${bridgeKey}` : '',
    },
    body: JSON.stringify(b1Message),
    signal: AbortSignal.timeout(timeoutMs || 120000),
  });

  const data = await parseResponse(resp);
  logRawResponse(data, logger);
  return data;
}

/**
 * 发送 OpenAI 兼容消息
 */
async function _sendOpenAIMessage(params) {
  const {
    baseUrl,
    chatPath,
    apiKey,
    model,
    defaultAgentName,
    timeoutMs,
    logger,
  } = this;

  const url = joinUrl(baseUrl, chatPath);
  const messages = [
    { role: 'system', content: `{{${params.agentName || defaultAgentName}}}` },
    { role: 'user', content: params.message },
  ];

  logger.debug('[vcpClient] sending OpenAI message to:', url);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || params.agentName || defaultAgentName,
      messages,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs || 120000),
  });

  const data = await parseResponse(resp);
  logRawResponse(data, logger);
  return data;
}

/**
 * 创建 VCP 客户端
 */
export function createVcpClient(config) {
  const client = {
    // 配置
    channelHubUrl: config.channelHubUrl,
    adapterId: config.adapterId,
    adapterKey: config.adapterKey,
    useChannelHub: config.useChannelHub,
    bridgeUrl: config.bridgeUrl,
    bridgeKey: config.bridgeKey,
    useBridge: config.useBridge,
    baseUrl: config.baseUrl,
    chatPath: config.chatPath,
    apiKey: config.apiKey,
    model: config.model,
    defaultAgentName: config.defaultAgentName,
    defaultAgentDisplayName: config.defaultAgentDisplayName,
    timeoutMs: config.timeoutMs,
    logger: config.logger,

    // 方法
    sendMessage: sendMessage.bind(config),
    extractRichReply,
  };

  // 绑定 _sendB1Message 和 _sendOpenAIMessage
  client._sendB1Message = _sendB1Message.bind(config);
  client._sendOpenAIMessage = _sendOpenAIMessage.bind(config);

  return client;
}