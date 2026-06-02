'use strict';

const express = require('express');
const path = require('path');
const { parseEnvCascade } = require('../envLoader');
const { createCodexOAuthProvider } = require('../modules/providers/codexOAuthProvider');
const {
  createCodexOAuthTraceStore,
} = require('../modules/codexOAuthTraceStore');

const DEFAULT_CODEX_OAUTH_MODEL_IDS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
  'codex-auto-review',
];

const DEFAULT_CHAT_COMPLETIONS_INSTRUCTIONS = 'You are ChatGPT, a helpful assistant.';

function isCodexOAuthResponsesEnabled(options = {}) {
  const provider = options.responsesProvider || process.env.VCP_RESPONSES_PROVIDER || '';
  return String(provider).trim().toLowerCase() === 'codex_oauth';
}

function resolveConfigPath(options = {}) {
  if (options.configPath) {
    return path.resolve(options.configPath);
  }

  return path.join(options.projectBasePath || path.join(__dirname, '..'), 'config.env');
}

function readRuntimeConfig(options = {}) {
  if (options.runtimeConfig && typeof options.runtimeConfig === 'object') {
    return options.runtimeConfig;
  }

  if (options.responsesProvider) {
    return {
      VCP_RESPONSES_PROVIDER: options.responsesProvider,
      VCP_CODEX_OAUTH_ACCOUNT_ID: options.accountId || '',
      VCP_CODEX_OAUTH_UPSTREAM_BASE_URL: options.baseUrl || '',
      VCP_CODEX_OAUTH_CLIENT_VERSION: options.clientVersion || '',
    };
  }

  if (options.disableConfigFileLookup) {
    return process.env;
  }

  try {
    const { env } = parseEnvCascade(resolveConfigPath(options));
    return {
      ...process.env,
      ...env,
    };
  } catch (_error) {
    return process.env;
  }
}

function getRuntimeProviderName(options = {}) {
  const runtimeConfig = readRuntimeConfig(options);
  return runtimeConfig.VCP_RESPONSES_PROVIDER || '';
}

function isCodexOAuthResponsesRuntimeEnabled(options = {}) {
  return String(getRuntimeProviderName(options)).trim().toLowerCase() === 'codex_oauth';
}

function createRuntimeProvider(options = {}) {
  if (options.codexOAuthProvider) {
    return options.codexOAuthProvider;
  }

  const runtimeConfig = readRuntimeConfig(options);
  const traceStore = options.traceStore || createCodexOAuthTraceStore({
    projectBasePath: options.projectBasePath,
  });
  return createCodexOAuthProvider({
    oauthAuthManager: options.oauthAuthManager,
    fetchImpl: options.fetchImpl,
    projectBasePath: options.projectBasePath,
    accountId: runtimeConfig.VCP_CODEX_OAUTH_ACCOUNT_ID || undefined,
    baseUrl: runtimeConfig.VCP_CODEX_OAUTH_UPSTREAM_BASE_URL || undefined,
    clientVersion: runtimeConfig.VCP_CODEX_OAUTH_CLIENT_VERSION || undefined,
    timeoutMs: runtimeConfig.VCP_CODEX_OAUTH_UPSTREAM_TIMEOUT_MS || undefined,
    traceObserver: (traceId, stage, metadata) => traceStore.addEvent(traceId, stage, metadata),
  });
}

function getConfiguredCodexOAuthModelIds(runtimeConfig = {}) {
  const raw = runtimeConfig.VCP_CODEX_OAUTH_MODELS || runtimeConfig.VCP_CODEX_OAUTH_MODEL_LIST || '';
  const configuredModels = String(raw)
    .split(',')
    .map(model => model.trim())
    .filter(Boolean);

  return configuredModels.length > 0 ? configuredModels : DEFAULT_CODEX_OAUTH_MODEL_IDS;
}

function normalizeCodexOAuthModelEntry(entry) {
  const id = typeof entry === 'string'
    ? entry
    : entry && (entry.id || entry.name || entry.model || entry.slug);

  if (!id) return null;

  return {
    object: 'model',
    created: 0,
    ...(typeof entry === 'object' && entry ? entry : {}),
    id: String(id),
    owned_by: 'codex_oauth',
  };
}

function normalizeCodexOAuthModelsPayload(payload) {
  const sourceModels = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];

  const seen = new Set();
  return sourceModels
    .map(normalizeCodexOAuthModelEntry)
    .filter(Boolean)
    .filter(model => {
      if (seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
}

function normalizeTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content === null || content === undefined) return '';
  return String(content);
}

function normalizeChatContentForResponses(content, role) {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  if (!Array.isArray(content)) {
    return [{ type: textType, text: normalizeTextContent(content) }];
  }

  return content.map(part => {
    if (!part || typeof part !== 'object') {
      return { type: textType, text: normalizeTextContent(part) };
    }
    if (part.type === 'text') {
      return { type: textType, text: normalizeTextContent(part.text) };
    }
    if (part.type === 'image_url' && part.image_url) {
      return {
        type: 'input_image',
        image_url: typeof part.image_url === 'string' ? part.image_url : part.image_url.url,
      };
    }
    if (typeof part.type === 'string') {
      return part;
    }
    return { type: textType, text: normalizeTextContent(part) };
  });
}

function buildResponsesBodyFromChatCompletion(chatBody = {}) {
  const messages = Array.isArray(chatBody.messages) ? chatBody.messages : [];
  const systemPrompt = messages
    .filter(message => message && message.role === 'system')
    .map(message => normalizeTextContent(message.content))
    .filter(Boolean)
    .join('\n\n');
  const input = messages
    .filter(message => message && message.role !== 'system')
    .map(message => ({
      type: 'message',
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: normalizeChatContentForResponses(message.content, message.role),
    }));

  const responsesBody = {
    model: chatBody.model,
    input,
    stream: true,
    store: false,
  };

  responsesBody.instructions = systemPrompt || DEFAULT_CHAT_COMPLETIONS_INSTRUCTIONS;
  if (chatBody.reasoning !== undefined) responsesBody.reasoning = chatBody.reasoning;

  return responsesBody;
}

function normalizeResponsesInputForCodexOAuth(input) {
  if (typeof input === 'string') {
    return [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: input }],
    }];
  }

  if (!Array.isArray(input)) {
    return input;
  }

  return input.map(item => {
    if (typeof item === 'string') {
      return {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: item }],
      };
    }
    return item;
  });
}

function normalizeResponsesBodyForCodexOAuth(body = {}) {
  const nextBody = body && typeof body === 'object' ? { ...body } : {};
  nextBody.input = normalizeResponsesInputForCodexOAuth(nextBody.input);
  nextBody.stream = true;
  if (typeof nextBody.instructions !== 'string' || !nextBody.instructions.trim()) {
    nextBody.instructions = DEFAULT_CHAT_COMPLETIONS_INSTRUCTIONS;
  }
  return nextBody;
}

function extractResponsesSseDeltas(sseText = '') {
  const deltas = [];
  let completedResponse = null;
  let model = null;

  for (const rawLine of String(sseText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;

    try {
      const payload = JSON.parse(data);
      if (payload.model) model = payload.model;
      if (payload.response?.model) model = payload.response.model;
      if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
        deltas.push(payload.delta);
      } else if (typeof payload.delta === 'string') {
        deltas.push(payload.delta);
      }
      if (payload.type === 'response.completed' && payload.response) {
        completedResponse = payload.response;
      }
    } catch (_error) {}
  }

  if (deltas.length === 0 && completedResponse) {
    const completedText = extractResponsesOutputText(completedResponse);
    if (completedText) deltas.push(completedText);
  }

  return {
    deltas,
    text: deltas.join(''),
    model,
    completedResponse,
  };
}

function extractResponsesOutputText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.output_text === 'string') return payload.output_text;

  const chunks = [];
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.text === 'string') chunks.push(item.text);
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') chunks.push(part.text);
      if (typeof part.output_text === 'string') chunks.push(part.output_text);
    }
  }

  return chunks.join('');
}

function transformResponsesJsonToChatCompletion(payload = {}, chatBody = {}) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: payload.id || `chatcmpl-codex-oauth-${Date.now()}`,
    object: 'chat.completion',
    created,
    model: payload.model || chatBody.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: extractResponsesOutputText(payload),
        },
        finish_reason: payload.status === 'incomplete' ? 'length' : 'stop',
      },
    ],
    usage: payload.usage,
  };
}

function transformResponsesSseToChatCompletion(sseText = '', chatBody = {}) {
  const parsed = extractResponsesSseDeltas(sseText);
  return transformResponsesJsonToChatCompletion({
    id: parsed.completedResponse?.id,
    model: parsed.model || parsed.completedResponse?.model || chatBody.model,
    output_text: parsed.text,
  }, chatBody);
}

function transformResponsesSseToResponsesJson(sseText = '', body = {}) {
  const parsed = extractResponsesSseDeltas(sseText);
  if (parsed.completedResponse && typeof parsed.completedResponse === 'object') {
    return {
      ...parsed.completedResponse,
      output_text: parsed.text || extractResponsesOutputText(parsed.completedResponse),
    };
  }

  return {
    id: `resp-codex-oauth-${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: parsed.model || body.model || 'codex_oauth',
    output_text: parsed.text,
  };
}

function looksLikeSsePayload(text = '') {
  return /^\s*(event|data):/m.test(String(text || ''));
}

function normalizeProviderFailureStatus(status) {
  const parsed = Number(status);
  if (Number.isInteger(parsed) && parsed >= 400 && parsed <= 599) {
    return parsed;
  }
  return 502;
}

function classifyCodexOAuthProviderFailure(input = 502) {
  const status = normalizeProviderFailureStatus(
    typeof input === 'number' ? input : input?.statusCode || input?.status
  );
  const errorName = typeof input === 'object' && input ? String(input.name || '') : '';
  const errorCode = typeof input === 'object' && input ? String(input.code || '') : '';

  if (errorName === 'AbortError' || errorCode === 'ABORT_ERR' || status === 408 || status === 504) {
    return {
      status: (errorName === 'AbortError' || errorCode === 'ABORT_ERR') && status === 502 ? 504 : status,
      code: 'codex_oauth_upstream_timeout',
      message: 'Codex OAuth upstream request timed out. Check upstream network and timeout settings.',
    };
  }

  if (status === 404) {
    return {
      status,
      code: 'codex_oauth_account_missing',
      message: 'Codex OAuth account is missing or not selected. Sign in and select an account in AdminPanel.',
    };
  }

  if (status === 401 || status === 403) {
    return {
      status,
      code: 'codex_oauth_unauthorized',
      message: 'Codex OAuth authorization was rejected by the upstream service. Re-authenticate the account in AdminPanel.',
    };
  }

  if (status === 409) {
    return {
      status,
      code: 'codex_oauth_refresh_unavailable',
      message: 'Codex OAuth token refresh is unavailable. Remove and re-authorize the account in AdminPanel.',
    };
  }

  if (status === 429) {
    return {
      status,
      code: 'codex_oauth_rate_limited',
      message: 'Codex OAuth upstream rate limit was reached. Retry later or switch to another account/model.',
    };
  }

  if (status === 400) {
    return {
      status,
      code: 'codex_oauth_request_rejected',
      message: 'Codex OAuth upstream rejected the request. Check the selected model and request format.',
    };
  }

  return {
    status,
    code: 'codex_oauth_upstream_failed',
    message: 'Codex OAuth provider request failed. Check OAuth account, model configuration, and upstream network.',
  };
}

function buildCodexOAuthProviderFailurePayload(input = 502, traceId = null) {
  const failure = classifyCodexOAuthProviderFailure(input);
  const payload = {
    error: {
      message: failure.message,
      type: 'codex_oauth_provider_failed',
      code: failure.code,
    },
  };
  if (traceId) {
    payload.error.trace_id = traceId;
  }
  return payload;
}

function sendCodexOAuthProviderFailure(res, input = 502, traceId = null) {
  const failure = classifyCodexOAuthProviderFailure(input);
  if (traceId) {
    res.setHeader('x-vcp-codex-oauth-trace-id', traceId);
  }
  return res.status(failure.status).json(buildCodexOAuthProviderFailurePayload(input, traceId));
}

function endCodexOAuthStreamFailure(res, input = 502, traceId = null) {
  const payload = buildCodexOAuthProviderFailurePayload(input, traceId);
  try {
    res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    res.write('data: [DONE]\n\n');
  } catch (_error) {}
  return res.end();
}

function redactTraceText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1<redacted>')
    .replace(/((?:access|refresh)[_-]?token["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1<redacted>')
    .replace(/secret-[A-Za-z0-9._-]+/gi, '<redacted>');
}

function truncateTraceText(value, limit = 180) {
  if (typeof value !== 'string') return '';
  const normalized = redactTraceText(value).replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

function summarizeUpstreamRejection(upstreamText = '', contentType = '') {
  const summary = {
    upstreamContentType: truncateTraceText(contentType, 120),
    upstreamPayloadKind: '',
    upstreamErrorType: '',
    upstreamErrorCode: '',
    upstreamErrorMessage: '',
    upstreamPayloadKeys: '',
  };

  if (!upstreamText) return summary;

  try {
    const parsed = JSON.parse(upstreamText);
    if (!parsed || typeof parsed !== 'object') {
      summary.upstreamPayloadKind = typeof parsed;
      return summary;
    }

    summary.upstreamPayloadKind = Array.isArray(parsed) ? 'array' : 'object';
    summary.upstreamPayloadKeys = Object.keys(parsed).slice(0, 8).join(',');

    const error = parsed.error && typeof parsed.error === 'object'
      ? parsed.error
      : parsed;
    summary.upstreamErrorType = truncateTraceText(error.type || error.error_type || '', 80);
    summary.upstreamErrorCode = truncateTraceText(error.code || error.error_code || '', 80);
    summary.upstreamErrorMessage = truncateTraceText(error.message || error.detail || error.error || '', 220);
  } catch (_error) {
    summary.upstreamPayloadKind = looksLikeSsePayload(upstreamText) ? 'sse' : 'text';
    summary.upstreamErrorMessage = truncateTraceText(upstreamText, 220);
  }

  return summary;
}

function startCodexOAuthTrace(req, route, traceStore) {
  const traceId = traceStore.startTrace({
    route,
    method: req.method,
    model: typeof req.body?.model === 'string' ? req.body.model : '',
    stream: req.body?.stream === true,
  });
  traceStore.addEvent(traceId, 'agent_request_received', {
    route,
    stream: req.body?.stream === true,
  });
  return { traceId };
}

function finishCodexOAuthTrace(traceStore, traceContext, result = {}) {
  if (!traceContext?.traceId) return;
  const failure = result.ok ? null : classifyCodexOAuthProviderFailure(result.error || result.status || 502);
  traceStore.finishTrace(traceContext.traceId, {
    ok: Boolean(result.ok),
    status: result.status || failure?.status || 200,
    errorCode: failure ? failure.code : null,
    message: failure ? failure.message : 'Codex OAuth provider request completed.',
  });
}

function writeChatCompletionSse(res, chatPayload) {
  const content = chatPayload.choices?.[0]?.message?.content || '';
  const chunk = {
    id: chatPayload.id,
    object: 'chat.completion.chunk',
    created: chatPayload.created,
    model: chatPayload.model,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
  };

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeResponsesSseAsChatSse(res, sseText = '', chatBody = {}) {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${created}`;
  const parsed = extractResponsesSseDeltas(sseText);
  const model = parsed.model || parsed.completedResponse?.model || chatBody.model || 'codex_oauth';

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  for (const delta of parsed.deltas) {
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: delta },
          finish_reason: null,
        },
      ],
    })}\n\n`);
  }

  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop',
      },
    ],
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeChatSseDelta(res, { id, created, model, delta = '', finishReason = null }) {
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: delta ? { content: delta } : {},
        finish_reason: finishReason,
      },
    ],
  })}\n\n`);
}

async function streamResponsesSseAsChatSse(res, body, chatBody = {}) {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${created}`;
  let model = chatBody.model || 'codex_oauth';
  let buffer = '';
  const decoder = new TextDecoder();

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const processLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;

    try {
      const payload = JSON.parse(data);
      if (payload.model) model = payload.model;
      if (payload.response?.model) model = payload.response.model;
      const delta = typeof payload.delta === 'string' ? payload.delta : '';
      if (delta) {
        writeChatSseDelta(res, { id, created, model, delta });
      }
    } catch (_error) {}
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      processLine(line);
    }
  }

  buffer += decoder.decode();
  if (buffer) {
    for (const line of buffer.split(/\r?\n/)) {
      processLine(line);
    }
  }

  writeChatSseDelta(res, { id, created, model, finishReason: 'stop' });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function fetchCodexOAuthModels(options = {}) {
  if (!isCodexOAuthResponsesRuntimeEnabled(options)) {
    return [];
  }

  const runtimeConfig = readRuntimeConfig(options);
  const configuredModels = getConfiguredCodexOAuthModelIds(runtimeConfig)
    .map(normalizeCodexOAuthModelEntry)
    .filter(Boolean);

  try {
    const provider = createRuntimeProvider(options);
    const response = await provider.fetchModels();
    if (!response.ok) {
      return configuredModels;
    }

    const payload = await response.json();
    const upstreamModels = normalizeCodexOAuthModelsPayload(payload);
    if (upstreamModels.length > 0) {
      return upstreamModels;
    }
    return configuredModels;
  } catch (_error) {
    return configuredModels;
  }
}

async function isCodexOAuthModel(model, options = {}) {
  if (!model || !isCodexOAuthResponsesRuntimeEnabled(options)) {
    return false;
  }

  const models = await fetchCodexOAuthModels(options);
  return models.some(item => item.id === model);
}

module.exports = function createCodexOAuthResponsesRouter(options = {}) {
  const router = express.Router();
  const traceStore = options.traceStore || createCodexOAuthTraceStore({
    projectBasePath: options.projectBasePath,
  });

  router.post(['/v1/chat/completions', '/v1/chatvcp/completions'], async (req, res, next) => {
    let traceContext = null;
    try {
      if (!(await isCodexOAuthModel(req.body && req.body.model, options))) {
        return next();
      }

      traceContext = startCodexOAuthTrace(req, 'chat_completions_adapter', traceStore);
      res.setHeader('x-vcp-codex-oauth-trace-id', traceContext.traceId);
      const provider = createRuntimeProvider(options);
      const responsesBody = buildResponsesBodyFromChatCompletion(req.body || {});
      if (options.codexOAuthProvider) {
        traceStore.addEvent(traceContext.traceId, 'provider_forward_start', {
          model: typeof responsesBody.model === 'string' ? responsesBody.model : '',
          stream: responsesBody.stream === true,
        });
      }
      const upstreamResponse = await provider.forwardResponses(responsesBody, {
        ...req.headers,
        accept: 'text/event-stream',
      }, {
        traceContext,
      });
      if (options.codexOAuthProvider) {
        traceStore.addEvent(traceContext.traceId, 'upstream_headers', {
          status: upstreamResponse.status,
          ok: upstreamResponse.ok,
          contentType: typeof upstreamResponse.headers?.get === 'function' ? upstreamResponse.headers.get('content-type') || '' : '',
        });
      }

      if (!upstreamResponse.ok) {
        const upstreamText = await upstreamResponse.text().catch(() => '');
        const upstreamContentType = typeof upstreamResponse.headers?.get === 'function'
          ? upstreamResponse.headers.get('content-type') || ''
          : '';
        traceStore.addEvent(traceContext.traceId, 'upstream_rejected', {
          status: upstreamResponse.status,
          ...summarizeUpstreamRejection(upstreamText, upstreamContentType),
        });
        finishCodexOAuthTrace(traceStore, traceContext, { ok: false, status: upstreamResponse.status });
        return sendCodexOAuthProviderFailure(res, upstreamResponse.status, traceContext.traceId);
      }

      if (req.body && req.body.stream === true && upstreamResponse.body) {
        traceStore.addEvent(traceContext.traceId, 'stream_start', {
          transform: 'responses_sse_to_chat_sse',
        });
        await streamResponsesSseAsChatSse(res, upstreamResponse.body, req.body || {});
        traceStore.addEvent(traceContext.traceId, 'stream_end', {
          transform: 'responses_sse_to_chat_sse',
        });
        finishCodexOAuthTrace(traceStore, traceContext, { ok: true, status: upstreamResponse.status });
        return;
      }

      const upstreamText = await upstreamResponse.text();
      const upstreamContentType = upstreamResponse.headers.get('content-type') || '';
      const isUpstreamSse = upstreamContentType.includes('text/event-stream') || looksLikeSsePayload(upstreamText);
      const chatPayload = isUpstreamSse
        ? transformResponsesSseToChatCompletion(upstreamText, req.body || {})
        : transformResponsesJsonToChatCompletion(JSON.parse(upstreamText || '{}'), req.body || {});
      if (req.body && req.body.stream === true) {
        if (isUpstreamSse) {
          traceStore.addEvent(traceContext.traceId, 'stream_buffer_transform', {
            transform: 'responses_sse_to_chat_sse',
          });
          finishCodexOAuthTrace(traceStore, traceContext, { ok: true, status: upstreamResponse.status });
          return writeResponsesSseAsChatSse(res, upstreamText, req.body || {});
        }
        traceStore.addEvent(traceContext.traceId, 'stream_buffer_transform', {
          transform: 'responses_json_to_chat_sse',
        });
        finishCodexOAuthTrace(traceStore, traceContext, { ok: true, status: upstreamResponse.status });
        return writeChatCompletionSse(res, chatPayload);
      }
      finishCodexOAuthTrace(traceStore, traceContext, { ok: true, status: upstreamResponse.status });
      return res.status(upstreamResponse.status).json(chatPayload);
    } catch (error) {
      if (traceContext?.traceId) {
        traceStore.addEvent(traceContext.traceId, 'request_error', {
          errorName: error?.name || '',
          errorCode: error?.code || '',
          status: error?.statusCode || error?.status || 0,
        });
        finishCodexOAuthTrace(traceStore, traceContext, { ok: false, error });
      }
      if (res.headersSent) {
        return endCodexOAuthStreamFailure(res, error, traceContext?.traceId || null);
      }
      return sendCodexOAuthProviderFailure(res, error, traceContext?.traceId || null);
    }
  });

  router.post('/v1/responses', async (req, res, next) => {
    if (!isCodexOAuthResponsesRuntimeEnabled(options)) {
      return next();
    }

    const traceContext = startCodexOAuthTrace(req, 'responses_proxy', traceStore);
    res.setHeader('x-vcp-codex-oauth-trace-id', traceContext.traceId);
    try {
      const provider = createRuntimeProvider(options);
      const responsesBody = normalizeResponsesBodyForCodexOAuth(req.body || {});
      const clientWantsStream = req.body?.stream === true || String(req.headers?.accept || '').includes('text/event-stream');
      if (options.codexOAuthProvider) {
        traceStore.addEvent(traceContext.traceId, 'provider_forward_start', {
          model: typeof responsesBody.model === 'string' ? responsesBody.model : '',
          stream: responsesBody.stream === true,
        });
      }
      const upstreamResponse = await provider.forwardResponses(responsesBody, req.headers || {}, {
        traceContext,
      });
      if (options.codexOAuthProvider) {
        traceStore.addEvent(traceContext.traceId, 'upstream_headers', {
          status: upstreamResponse.status,
          ok: upstreamResponse.ok,
          contentType: typeof upstreamResponse.headers?.get === 'function' ? upstreamResponse.headers.get('content-type') || '' : '',
        });
      }
      if (!upstreamResponse.ok) {
        const upstreamText = await upstreamResponse.text().catch(() => '');
        const upstreamContentType = typeof upstreamResponse.headers?.get === 'function'
          ? upstreamResponse.headers.get('content-type') || ''
          : '';
        traceStore.addEvent(traceContext.traceId, 'upstream_rejected', {
          status: upstreamResponse.status,
          ...summarizeUpstreamRejection(upstreamText, upstreamContentType),
        });
        finishCodexOAuthTrace(traceStore, traceContext, { ok: false, status: upstreamResponse.status });
        return sendCodexOAuthProviderFailure(res, upstreamResponse.status, traceContext.traceId);
      }

      res.status(upstreamResponse.status);
      upstreamResponse.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(lower)) {
          res.setHeader(key, value);
        }
      });

      if (!upstreamResponse.body) {
        const upstreamText = await upstreamResponse.text();
        finishCodexOAuthTrace(traceStore, traceContext, { ok: true, status: upstreamResponse.status });
        return res.send(upstreamText);
      }

      if (!clientWantsStream) {
        const upstreamText = await new Response(upstreamResponse.body).text();
        const upstreamContentType = typeof upstreamResponse.headers?.get === 'function'
          ? upstreamResponse.headers.get('content-type') || ''
          : '';
        const isUpstreamSse = upstreamContentType.includes('text/event-stream') || looksLikeSsePayload(upstreamText);
        finishCodexOAuthTrace(traceStore, traceContext, { ok: true, status: upstreamResponse.status });
        if (!isUpstreamSse) {
          return res.send(upstreamText);
        }
        traceStore.addEvent(traceContext.traceId, 'stream_buffer_transform', {
          transform: 'responses_sse_to_responses_json',
        });
        return res
          .type('application/json')
          .json(transformResponsesSseToResponsesJson(upstreamText, req.body || {}));
      }

      let chunks = 0;
      traceStore.addEvent(traceContext.traceId, 'stream_start', {
        route: 'responses_proxy',
      });
      for await (const chunk of upstreamResponse.body) {
        chunks += 1;
        res.write(chunk);
      }
      traceStore.addEvent(traceContext.traceId, 'stream_end', {
        chunks,
      });
      finishCodexOAuthTrace(traceStore, traceContext, { ok: true, status: upstreamResponse.status });
      return res.end();
    } catch (error) {
      traceStore.addEvent(traceContext.traceId, 'request_error', {
        errorName: error?.name || '',
        errorCode: error?.code || '',
        status: error?.statusCode || error?.status || 0,
      });
      finishCodexOAuthTrace(traceStore, traceContext, { ok: false, error });
      if (res.headersSent) {
        return endCodexOAuthStreamFailure(res, error, traceContext.traceId);
      }
      return sendCodexOAuthProviderFailure(res, error, traceContext.traceId);
    }
  });

  return router;
};

module.exports.isCodexOAuthResponsesEnabled = isCodexOAuthResponsesEnabled;
module.exports.isCodexOAuthResponsesRuntimeEnabled = isCodexOAuthResponsesRuntimeEnabled;
module.exports.readRuntimeConfig = readRuntimeConfig;
module.exports.fetchCodexOAuthModels = fetchCodexOAuthModels;
module.exports.normalizeCodexOAuthModelsPayload = normalizeCodexOAuthModelsPayload;
module.exports.DEFAULT_CODEX_OAUTH_MODEL_IDS = DEFAULT_CODEX_OAUTH_MODEL_IDS;
module.exports.buildResponsesBodyFromChatCompletion = buildResponsesBodyFromChatCompletion;
module.exports.transformResponsesJsonToChatCompletion = transformResponsesJsonToChatCompletion;
module.exports.transformResponsesSseToChatCompletion = transformResponsesSseToChatCompletion;
module.exports.looksLikeSsePayload = looksLikeSsePayload;
module.exports.isCodexOAuthModel = isCodexOAuthModel;
module.exports.classifyCodexOAuthProviderFailure = classifyCodexOAuthProviderFailure;
