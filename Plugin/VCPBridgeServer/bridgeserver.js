// VCPBridgeServer - local loopback prompt-injection API proxy.

const express = require('express');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 3100;
const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_UPSTREAM_URL = 'https://api.openai.com';
const DEFAULT_MODEL = 'gpt-4.1-mini';
const DEFAULT_TIMEOUT_MS = 120000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

let server = null;
let runtimeConfig = null;

function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function toInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function validatePort(value) {
    const port = toInteger(value, DEFAULT_PORT);
    if (port < 1 || port > 65535) {
        throw new Error(`BRIDGE_PORT must be between 1 and 65535, got ${value}`);
    }
    return port;
}

function validateBindHost(value) {
    const host = String(value || DEFAULT_BIND_HOST).trim();
    if (!LOOPBACK_HOSTS.has(host)) {
        throw new Error(`BRIDGE_BIND_HOST must be loopback-only (${Array.from(LOOPBACK_HOSTS).join(', ')}), got ${host}`);
    }
    return host;
}

function normalizeUpstreamUrl(value) {
    const raw = String(value || DEFAULT_UPSTREAM_URL).trim().replace(/\/+$/, '');
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`BRIDGE_UPSTREAM_URL must use http or https, got ${url.protocol}`);
    }
    return url.toString().replace(/\/+$/, '');
}

function sanitizeUrlForLog(value) {
    try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        return url.toString().replace(/\/+$/, '');
    } catch (_error) {
        return '<invalid-url>';
    }
}

function normalizeApiType(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'anthropic' || v === 'claude') return 'anthropic';
    if (v === 'gemini' || v === 'google') return 'gemini';
    return 'chat';
}

function resolveSystemPrompt(raw, pluginDir = __dirname) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return '';

    if (/^[^\\/:*?"<>|\r\n]+\.txt$/i.test(trimmed)) {
        const filePath = path.join(pluginDir, trimmed);
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf8').trim();
        }
    }
    return trimmed;
}

function parseModelMap(raw) {
    if (!raw) return {};
    return String(raw).split(',').reduce((acc, pair) => {
        const idx = pair.indexOf(':');
        if (idx > 0) {
            const alias = pair.slice(0, idx).trim();
            const target = pair.slice(idx + 1).trim();
            if (alias && target) acc[alias] = target;
        }
        return acc;
    }, {});
}

function createRuntimeConfig(config = {}, options = {}) {
    const pluginDir = options.pluginDir || __dirname;
    const portValue = (config.BRIDGE_PORT === undefined || config.BRIDGE_PORT === null || config.BRIDGE_PORT === '')
        ? DEFAULT_PORT
        : config.BRIDGE_PORT;
    return {
        enabled: toBoolean(config.BRIDGE_ENABLED, false),
        port: validatePort(portValue),
        bindHost: validateBindHost(config.BRIDGE_BIND_HOST || DEFAULT_BIND_HOST),
        upstreamUrl: normalizeUpstreamUrl(config.BRIDGE_UPSTREAM_URL || DEFAULT_UPSTREAM_URL),
        upstreamKey: String(config.BRIDGE_UPSTREAM_KEY || ''),
        upstreamType: normalizeApiType(config.BRIDGE_UPSTREAM_TYPE),
        defaultModel: String(config.BRIDGE_MODEL || DEFAULT_MODEL),
        systemPrompt: resolveSystemPrompt(config.BRIDGE_SYSTEM_PROMPT || '', pluginDir),
        hijackMode: String(config.BRIDGE_HIJACK_MODE || 'off').trim().toLowerCase(),
        modelMap: parseModelMap(config.BRIDGE_MODEL_MAP || ''),
        timeoutMs: Math.max(1000, toInteger(config.BRIDGE_UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)),
        debugMode: Boolean(config.DebugMode),
        fetchImpl: options.fetchImpl || globalThis.fetch
    };
}

function resolveModel(model, config = runtimeConfig) {
    const candidate = model || config.defaultModel;
    return config.modelMap[candidate] || candidate;
}

function extractBearerToken(authHeader) {
    if (!authHeader) return '';
    const match = String(authHeader).match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

function normalizeTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(item => {
            if (typeof item === 'string') return item;
            if (typeof item?.text === 'string') return item.text;
            if (item?.type === 'text' && typeof item.text === 'string') return item.text;
            if (item?.type === 'input_text' && typeof item.text === 'string') return item.text;
            return '';
        }).filter(Boolean).join('\n');
    }
    return '';
}

function applySystemPromptHijack(messages, config = runtimeConfig) {
    const safeMessages = Array.isArray(messages) ? messages.filter(message => message && typeof message === 'object') : [];
    if (!config?.systemPrompt || config.hijackMode === 'off') {
        return safeMessages;
    }

    const injected = { role: 'system', content: config.systemPrompt };
    switch (config.hijackMode) {
        case 'replace':
            return [injected, ...safeMessages.filter(message => message.role !== 'system')];
        case 'prepend':
            return [injected, ...safeMessages];
        case 'append': {
            const result = [...safeMessages];
            const lastSystemIdx = result.reduce((acc, message, index) => message.role === 'system' ? index : acc, -1);
            if (lastSystemIdx >= 0) {
                result.splice(lastSystemIdx + 1, 0, injected);
            } else {
                result.unshift(injected);
            }
            return result;
        }
        default:
            return safeMessages;
    }
}

function extractFromResponsesInput(input) {
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    if (!Array.isArray(input)) return [];
    const messages = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        let role = item.role || (item.type === 'message' ? 'user' : null);
        if (role === 'developer') role = 'system';
        const content = normalizeTextContent(item.content);
        if (role && content) messages.push({ role, content });
    }
    return messages;
}

function extractFromAnthropicBody(body = {}) {
    const messages = [];
    const system = normalizeTextContent(body.system);
    if (system) messages.push({ role: 'system', content: system });
    if (Array.isArray(body.messages)) {
        for (const message of body.messages) {
            const content = normalizeTextContent(message?.content);
            if (message?.role && content) messages.push({ role: message.role, content });
        }
    }
    return messages;
}

function extractFromGeminiBody(body = {}) {
    const messages = [];
    if (body.systemInstruction?.parts) {
        const system = normalizeTextContent(body.systemInstruction.parts);
        if (system) messages.push({ role: 'system', content: system });
    }
    if (Array.isArray(body.contents)) {
        for (const content of body.contents) {
            const role = content?.role === 'model' ? 'assistant' : 'user';
            const text = normalizeTextContent(content?.parts);
            if (text) messages.push({ role, content: text });
        }
    }
    return messages;
}

function buildUpstreamChatBody(messages, model, body = {}, config = runtimeConfig) {
    return {
        model: resolveModel(model, config),
        messages,
        stream: body.stream === true,
        ...(body.temperature !== undefined && { temperature: body.temperature }),
        ...(body.top_p !== undefined && { top_p: body.top_p }),
        ...(body.max_tokens !== undefined && { max_tokens: body.max_tokens }),
        ...(body.max_completion_tokens !== undefined && { max_completion_tokens: body.max_completion_tokens })
    };
}

function buildUpstreamAnthropicBody(messages, model, body = {}, config = runtimeConfig) {
    const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    const nonSystem = messages.filter(message => message.role !== 'system').map(message => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content
    }));
    const result = {
        model: resolveModel(model, config),
        messages: nonSystem,
        max_tokens: body.max_tokens || body.max_output_tokens || 4096,
        stream: body.stream === true
    };
    if (system) result.system = system;
    if (body.temperature !== undefined) result.temperature = body.temperature;
    return result;
}

function buildUpstreamGeminiBody(messages, _model, body = {}) {
    const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    const contents = messages.filter(message => message.role !== 'system').map(message => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }]
    }));
    const result = { contents };
    if (system) result.systemInstruction = { parts: [{ text: system }] };
    const generationConfig = {};
    if (body.temperature !== undefined) generationConfig.temperature = body.temperature;
    if (body.top_p !== undefined) generationConfig.topP = body.top_p;
    if (body.max_tokens !== undefined || body.max_output_tokens !== undefined) {
        generationConfig.maxOutputTokens = body.max_output_tokens || body.max_tokens;
    }
    if (Object.keys(generationConfig).length > 0) result.generationConfig = generationConfig;
    return result;
}

function resolveUpstreamEndpoint(model, stream, config = runtimeConfig) {
    if (config.upstreamType === 'anthropic') {
        return { url: `${config.upstreamUrl}/v1/messages`, type: 'anthropic' };
    }
    if (config.upstreamType === 'gemini') {
        const resolvedModel = encodeURIComponent(resolveModel(model, config));
        const action = stream ? 'streamGenerateContent' : 'generateContent';
        return { url: `${config.upstreamUrl}/v1beta/models/${resolvedModel}:${action}`, type: 'gemini' };
    }
    return { url: `${config.upstreamUrl}/v1/chat/completions`, type: 'chat' };
}

function buildUpstreamRequest({ messages, model, body = {}, requestHeaders = {}, downstreamFormat = 'chat' }, config = runtimeConfig) {
    const hijackedMessages = applySystemPromptHijack(messages, config);
    const stream = body.stream === true;
    const endpoint = resolveUpstreamEndpoint(model, stream, config);
    let upstreamBody;

    if (endpoint.type === 'anthropic') {
        upstreamBody = buildUpstreamAnthropicBody(hijackedMessages, model, body, config);
    } else if (endpoint.type === 'gemini') {
        upstreamBody = buildUpstreamGeminiBody(hijackedMessages, model, body, config);
    } else {
        upstreamBody = buildUpstreamChatBody(hijackedMessages, model, body, config);
    }

    const headers = { 'Content-Type': 'application/json' };
    if (endpoint.type === 'anthropic') {
        headers['anthropic-version'] = requestHeaders['anthropic-version'] || '2023-06-01';
        const anthropicKey = config.upstreamKey || requestHeaders['x-api-key'];
        if (anthropicKey) headers['x-api-key'] = anthropicKey;
    } else if (endpoint.type === 'gemini') {
        const geminiKey = config.upstreamKey || requestHeaders['x-goog-api-key'];
        if (geminiKey) headers['x-goog-api-key'] = geminiKey;
    } else {
        const chatKey = config.upstreamKey || extractBearerToken(requestHeaders.authorization);
        if (chatKey) headers.Authorization = `Bearer ${chatKey}`;
    }

    return { endpoint, headers, upstreamBody, downstreamFormat };
}

function extractTextFromUpstreamPayload(payload, upstreamType) {
    if (!payload || typeof payload !== 'object') return '';
    if (upstreamType === 'anthropic') {
        const content = Array.isArray(payload.content) ? payload.content : [];
        return content.map(item => item?.text || '').filter(Boolean).join('\n');
    }
    if (upstreamType === 'gemini') {
        const parts = payload.candidates?.[0]?.content?.parts;
        return normalizeTextContent(parts);
    }
    return payload.choices?.map(choice => choice?.message?.content || '').filter(Boolean).join('\n') || '';
}

function extractUsageFromUpstreamPayload(payload, upstreamType) {
    if (!payload || typeof payload !== 'object') return {};
    if (upstreamType === 'anthropic') {
        return {
            input_tokens: payload.usage?.input_tokens || 0,
            output_tokens: payload.usage?.output_tokens || 0,
            total_tokens: (payload.usage?.input_tokens || 0) + (payload.usage?.output_tokens || 0)
        };
    }
    if (upstreamType === 'gemini') {
        return {
            input_tokens: payload.usageMetadata?.promptTokenCount || 0,
            output_tokens: payload.usageMetadata?.candidatesTokenCount || 0,
            total_tokens: payload.usageMetadata?.totalTokenCount || 0
        };
    }
    return {
        input_tokens: payload.usage?.prompt_tokens || 0,
        output_tokens: payload.usage?.completion_tokens || 0,
        total_tokens: payload.usage?.total_tokens || 0
    };
}

function buildResponsesPayloadFromUpstream(payload, upstreamType) {
    const text = extractTextFromUpstreamPayload(payload, upstreamType);
    const usage = extractUsageFromUpstreamPayload(payload, upstreamType);
    const created = payload?.created || Math.floor(Date.now() / 1000);
    const responseId = payload?.id && String(payload.id).startsWith('resp_')
        ? payload.id
        : `resp_${payload?.id || created}`;
    const itemId = `msg_${responseId.replace(/^resp_/, '')}`;
    return {
        id: responseId,
        object: 'response',
        created_at: created,
        status: 'completed',
        error: null,
        incomplete_details: null,
        model: payload?.model || runtimeConfig?.defaultModel || DEFAULT_MODEL,
        output: [
            {
                id: itemId,
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [
                    {
                        type: 'output_text',
                        text,
                        annotations: []
                    }
                ]
            }
        ],
        output_text: text,
        usage
    };
}

function buildAnthropicPayloadFromUpstream(payload, upstreamType) {
    const text = extractTextFromUpstreamPayload(payload, upstreamType);
    const usage = extractUsageFromUpstreamPayload(payload, upstreamType);
    return {
        id: payload?.id || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: payload?.model || runtimeConfig?.defaultModel || DEFAULT_MODEL,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0
        }
    };
}

function buildGeminiPayloadFromUpstream(payload, upstreamType) {
    const text = extractTextFromUpstreamPayload(payload, upstreamType);
    const usage = extractUsageFromUpstreamPayload(payload, upstreamType);
    return {
        candidates: [
            {
                content: {
                    role: 'model',
                    parts: [{ text }]
                },
                finishReason: 'STOP',
                index: 0
            }
        ],
        usageMetadata: {
            promptTokenCount: usage.input_tokens || 0,
            candidatesTokenCount: usage.output_tokens || 0,
            totalTokenCount: usage.total_tokens || 0
        }
    };
}

function transformUpstreamJsonPayload(payload, upstreamType, downstreamFormat) {
    if (downstreamFormat === upstreamType || downstreamFormat === 'chat') {
        return payload;
    }
    if (downstreamFormat === 'responses') {
        return buildResponsesPayloadFromUpstream(payload, upstreamType);
    }
    if (downstreamFormat === 'anthropic') {
        return buildAnthropicPayloadFromUpstream(payload, upstreamType);
    }
    if (downstreamFormat === 'gemini') {
        return buildGeminiPayloadFromUpstream(payload, upstreamType);
    }
    return payload;
}

function createResponsesStreamEvent(type, data) {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function transformChatSseToResponsesSse(sseText) {
    const created = Math.floor(Date.now() / 1000);
    const responseId = `resp_${created}`;
    const itemId = `msg_${created}`;
    const deltas = [];
    let model = runtimeConfig?.defaultModel || DEFAULT_MODEL;
    const events = [
        createResponsesStreamEvent('response.created', {
            response: {
                id: responseId,
                object: 'response',
                created_at: created,
                status: 'in_progress',
                model,
                output: []
            }
        }),
        createResponsesStreamEvent('response.output_item.added', {
            output_index: 0,
            item: {
                id: itemId,
                type: 'message',
                status: 'in_progress',
                role: 'assistant',
                content: []
            }
        }),
        createResponsesStreamEvent('response.content_part.added', {
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] }
        })
    ];

    for (const rawLine of String(sseText || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
            const chunk = JSON.parse(data);
            if (chunk.model) model = chunk.model;
            const delta = chunk.choices?.map(choice => choice?.delta?.content || '').join('') || '';
            if (!delta) continue;
            deltas.push(delta);
            events.push(createResponsesStreamEvent('response.output_text.delta', {
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                delta
            }));
        } catch (_error) {}
    }

    const text = deltas.join('');
    events.push(
        createResponsesStreamEvent('response.output_text.done', {
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            text
        }),
        createResponsesStreamEvent('response.content_part.done', {
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text, annotations: [] }
        }),
        createResponsesStreamEvent('response.output_item.done', {
            output_index: 0,
            item: {
                id: itemId,
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text, annotations: [] }]
            }
        }),
        createResponsesStreamEvent('response.completed', {
            response: {
                id: responseId,
                object: 'response',
                created_at: created,
                status: 'completed',
                model,
                output: [
                    {
                        id: itemId,
                        type: 'message',
                        status: 'completed',
                        role: 'assistant',
                        content: [{ type: 'output_text', text, annotations: [] }]
                    }
                ],
                output_text: text
            }
        }),
        'data: [DONE]\n\n'
    );
    return events.join('');
}

function shouldTransformResponse(upstreamType, downstreamFormat) {
    return downstreamFormat !== upstreamType && downstreamFormat !== 'chat';
}

async function proxyRequest(req, res, payload) {
    const config = runtimeConfig;
    const { endpoint, headers, upstreamBody, downstreamFormat } = buildUpstreamRequest({
        ...payload,
        requestHeaders: req.headers
    }, config);

    if (config.debugMode) {
        console.log(`[VCPBridgeServer] ${downstreamFormat} -> ${endpoint.type} | ${sanitizeUrlForLog(endpoint.url)} | hijack=${config.hijackMode}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    let upstreamResponse;
    try {
        upstreamResponse = await config.fetchImpl(endpoint.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(upstreamBody),
            signal: controller.signal
        });
    } catch (error) {
        const message = error?.name === 'AbortError' ? 'Upstream fetch timed out' : `Upstream fetch failed: ${error.message}`;
        return res.status(502).json({ error: { message, type: 'upstream_error' } });
    } finally {
        clearTimeout(timeout);
    }

    const contentType = upstreamResponse.headers.get('content-type') || '';
    const shouldTransform = upstreamResponse.ok && shouldTransformResponse(endpoint.type, downstreamFormat);
    res.status(upstreamResponse.status);
    upstreamResponse.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(lower)) {
            res.setHeader(key, value);
        }
    });

    if (shouldTransform) {
        const text = await upstreamResponse.text();
        if (contentType.includes('text/event-stream') && endpoint.type === 'chat' && downstreamFormat === 'responses') {
            res.setHeader('content-type', 'text/event-stream; charset=utf-8');
            return res.send(transformChatSseToResponsesSse(text));
        }
        try {
            const payloadJson = JSON.parse(text);
            const transformed = transformUpstreamJsonPayload(payloadJson, endpoint.type, downstreamFormat);
            res.setHeader('content-type', 'application/json; charset=utf-8');
            return res.send(JSON.stringify(transformed));
        } catch (_error) {
            return res.send(text);
        }
    }

    if (!upstreamResponse.body) {
        return res.send(await upstreamResponse.text());
    }

    for await (const chunk of upstreamResponse.body) {
        res.write(chunk);
    }
    res.end();
}

function createApp() {
    const app = express();
    app.use(express.json({ limit: '10mb' }));

    app.get('/health', (_req, res) => {
        res.json({
            ok: true,
            hijackMode: runtimeConfig.hijackMode,
            hasSystemPrompt: Boolean(runtimeConfig.systemPrompt),
            upstreamType: runtimeConfig.upstreamType,
            upstreamUrl: sanitizeUrlForLog(runtimeConfig.upstreamUrl),
            modelMap: runtimeConfig.modelMap
        });
    });

    app.post('/v1/chat/completions', async (req, res) => {
        const body = req.body || {};
        const messages = Array.isArray(body.messages) ? body.messages : [];
        await proxyRequest(req, res, { messages, model: body.model, body, downstreamFormat: 'chat' });
    });

    app.post('/v1/responses', async (req, res) => {
        const body = req.body || {};
        const messages = extractFromResponsesInput(body.input);
        const stream = body.stream === true || String(req.headers.accept || '').includes('text/event-stream');
        await proxyRequest(req, res, { messages, model: body.model, body: { ...body, stream }, downstreamFormat: 'responses' });
    });

    app.post('/v1/messages', async (req, res) => {
        const body = req.body || {};
        const messages = extractFromAnthropicBody(body);
        await proxyRequest(req, res, { messages, model: body.model, body, downstreamFormat: 'anthropic' });
    });

    app.post(/^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/, async (req, res) => {
        const body = req.body || {};
        const messages = extractFromGeminiBody(body);
        const model = req.params[0] || runtimeConfig.defaultModel;
        const stream = req.params[1] === 'streamGenerateContent';
        await proxyRequest(req, res, { messages, model, body: { ...body, stream }, downstreamFormat: 'gemini' });
    });

    return app;
}

function startServer() {
    if (server) return Promise.resolve();
    const app = createApp();
    return new Promise((resolve, reject) => {
        const nextServer = app.listen(runtimeConfig.port, runtimeConfig.bindHost, () => {
            server = nextServer;
            console.log(`[VCPBridgeServer] Listening on http://${runtimeConfig.bindHost}:${runtimeConfig.port}`);
            console.log(`[VCPBridgeServer] Upstream: ${sanitizeUrlForLog(runtimeConfig.upstreamUrl)} (${runtimeConfig.upstreamType})`);
            if (runtimeConfig.systemPrompt) {
                console.log(`[VCPBridgeServer] System prompt loaded (${runtimeConfig.systemPrompt.length} chars), mode: ${runtimeConfig.hijackMode}`);
            }
            resolve();
        });
        nextServer.once('error', reject);
    });
}

async function initialize(config = {}, dependencies = {}) {
    await shutdown();
    runtimeConfig = createRuntimeConfig(config, {
        fetchImpl: dependencies.fetchImpl
    });
    if (!runtimeConfig.enabled) {
        console.log('[VCPBridgeServer] Disabled. Set BRIDGE_ENABLED=true to start the loopback proxy.');
        return;
    }
    await startServer();
}

function shutdown() {
    return new Promise(resolve => {
        if (!server) {
            resolve();
            return;
        }
        const closingServer = server;
        server = null;
        closingServer.close(() => {
            console.log('[VCPBridgeServer] Server stopped.');
            resolve();
        });
    });
}

module.exports = {
    initialize,
    shutdown,
    _private: {
        applySystemPromptHijack,
        buildUpstreamAnthropicBody,
        buildUpstreamChatBody,
        buildUpstreamGeminiBody,
        buildUpstreamRequest,
        buildResponsesPayloadFromUpstream,
        createRuntimeConfig,
        extractFromAnthropicBody,
        extractFromGeminiBody,
        extractFromResponsesInput,
        transformChatSseToResponsesSse,
        transformUpstreamJsonPayload,
        normalizeApiType,
        normalizeTextContent,
        parseModelMap,
        resolveModel,
        resolveSystemPrompt,
        resolveUpstreamEndpoint,
        sanitizeUrlForLog,
        isRunning: () => Boolean(server)
    }
};
