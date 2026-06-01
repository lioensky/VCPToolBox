// VCPBridgeServer - local loopback prompt-injection API proxy.

const express = require('express');
const { once } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const DEFAULT_PORT = 3100;
const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_MODEL = 'gpt-4.1-mini';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_TOTAL_TIMEOUT_MS = 0;
const DEFAULT_IDLE_TIMEOUT_MS = 180000;
const DEFAULT_RATE_LIMIT_RPM = 60;
const DEFAULT_MAX_BODY_MB = 20;
const CODEX_VCP_MEMORY_PROFILE = 'codex-vcp-memory';
const CODEX_VCP_MEMORY_PROMPT = 'prompts/codex_vcp_memory.strict.txt';
const RESPONSE_FIELDS_NOT_SUPPORTED = [
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'previous_response_id',
    'truncation',
    'reasoning'
];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const HIJACK_MODES = new Set(['off', 'replace', 'prepend', 'append']);

let server = null;
let runtimeConfig = null;
const rateLimitBuckets = new Map();

function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function toInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function toBoundedInteger(value, fallback, min, max = Number.MAX_SAFE_INTEGER) {
    const parsed = toInteger(value, fallback);
    return Math.max(min, Math.min(max, parsed));
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
    const raw = String(value || '').trim().replace(/\/+$/, '');
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

function normalizeHostForCompare(value) {
    return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function isLoopbackHost(value) {
    return LOOPBACK_HOSTS.has(normalizeHostForCompare(value));
}

function formatOriginHost(host) {
    const normalized = normalizeHostForCompare(host);
    return normalized.includes(':') ? `[${normalized}]` : normalized;
}

function normalizeBearerOrApiKey(headers = {}) {
    const bearer = extractBearerToken(headers.authorization);
    return bearer || String(headers['x-api-key'] || '').trim();
}

function buildAllowedOrigins(config) {
    const hosts = new Set([config.bindHost]);
    if (isLoopbackHost(config.bindHost)) {
        for (const host of LOOPBACK_HOSTS) hosts.add(host);
    }
    return Array.from(hosts).map(formatOriginHost).flatMap(host => [
        `http://${host}:${config.port}`,
        `https://${host}:${config.port}`
    ]);
}

function normalizeOriginForCompare(origin) {
    const parsed = new URL(origin);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return `${parsed.protocol}//${normalizeHostForCompare(parsed.hostname)}:${port}`;
}

function isOriginAllowed(origin, config = runtimeConfig) {
    if (!origin) return true;
    try {
        const normalizedOrigin = normalizeOriginForCompare(origin);
        return buildAllowedOrigins(config)
            .map(candidate => normalizeOriginForCompare(candidate))
            .includes(normalizedOrigin);
    } catch (_error) {
        return false;
    }
}

function normalizeApiType(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'anthropic' || v === 'claude') return 'anthropic';
    if (v === 'gemini' || v === 'google') return 'gemini';
    return 'chat';
}

function normalizeProfile(value) {
    return String(value || '').trim().toLowerCase();
}

function resolveProfileDefaults(profile) {
    if (profile === CODEX_VCP_MEMORY_PROFILE) {
        return {
            upstreamType: 'chat',
            hijackMode: 'append',
            systemPrompt: CODEX_VCP_MEMORY_PROMPT,
            requireVcpUpstream: true
        };
    }
    return {};
}

function validateNoSelfLoop(config) {
    const upstream = new URL(config.upstreamUrl);
    const upstreamHost = normalizeHostForCompare(upstream.hostname);
    const bindHost = normalizeHostForCompare(config.bindHost);
    const upstreamPort = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80));
    const bindPort = Number(config.port);
    const sameHost = upstreamHost === bindHost || (isLoopbackHost(upstreamHost) && isLoopbackHost(bindHost));

    if (sameHost && upstreamPort === bindPort) {
        throw new Error('BRIDGE_UPSTREAM_URL points to this bridge itself. Refusing self-loop.');
    }
}

function resolveSystemPrompt(raw, pluginDir = __dirname) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return '';

    if (/^[^:*?"<>|\r\n]+\.txt$/i.test(trimmed) && !path.isAbsolute(trimmed)) {
        const basePath = path.resolve(pluginDir);
        const filePath = path.resolve(basePath, trimmed);
        const relativePath = path.relative(basePath, filePath);
        const staysInPluginDir = relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
        if (staysInPluginDir && fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf8').trim();
        }
        if (staysInPluginDir) return '';
    }

    if (/^[^\\/:*?"<>|\r\n]+\.txt$/i.test(trimmed)) {
        const filePath = path.resolve(pluginDir, trimmed);
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf8').trim();
        }
    }
    return trimmed;
}

function normalizeHijackMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    return HIJACK_MODES.has(mode) ? mode : 'off';
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
    const profile = normalizeProfile(config.BRIDGE_PROFILE);
    const profileDefaults = resolveProfileDefaults(profile);
    const portValue = (config.BRIDGE_PORT === undefined || config.BRIDGE_PORT === null || config.BRIDGE_PORT === '')
        ? DEFAULT_PORT
        : config.BRIDGE_PORT;
    const mainServerPort = config.PORT || process.env.PORT || 6005;
    const defaultUpstreamUrl = `http://127.0.0.1:${mainServerPort}`;
    const useLocalDefaultUpstream = config.BRIDGE_UPSTREAM_URL === undefined || config.BRIDGE_UPSTREAM_URL === null || config.BRIDGE_UPSTREAM_URL === '';
    const upstreamUrl = useLocalDefaultUpstream
        ? defaultUpstreamUrl
        : config.BRIDGE_UPSTREAM_URL;
    const upstreamKey = config.BRIDGE_UPSTREAM_KEY || (useLocalDefaultUpstream ? (config.Key || process.env.Key || '') : '');
    const upstreamTypeValue = config.BRIDGE_UPSTREAM_TYPE || profileDefaults.upstreamType;
    const systemPromptValue = config.BRIDGE_SYSTEM_PROMPT || profileDefaults.systemPrompt || '';
    const hijackModeValue = config.BRIDGE_HIJACK_MODE || profileDefaults.hijackMode || 'off';
    const requireVcpUpstream = config.BRIDGE_REQUIRE_VCP_UPSTREAM === undefined || config.BRIDGE_REQUIRE_VCP_UPSTREAM === null || config.BRIDGE_REQUIRE_VCP_UPSTREAM === ''
        ? Boolean(profileDefaults.requireVcpUpstream)
        : toBoolean(config.BRIDGE_REQUIRE_VCP_UPSTREAM, false);
    const legacyTimeoutMs = toBoundedInteger(config.BRIDGE_UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000);
    const bodyLimit = parseBodyLimit(config.BRIDGE_MAX_BODY_MB);
    const resolvedConfig = {
        profile,
        enabled: toBoolean(config.BRIDGE_ENABLED, false),
        port: validatePort(portValue),
        bindHost: validateBindHost(config.BRIDGE_BIND_HOST || DEFAULT_BIND_HOST),
        upstreamUrl: normalizeUpstreamUrl(upstreamUrl),
        clientKey: String(config.BRIDGE_CLIENT_KEY || ''),
        upstreamKey: String(upstreamKey),
        upstreamType: normalizeApiType(upstreamTypeValue),
        requireVcpUpstream,
        defaultModel: String(config.BRIDGE_MODEL || DEFAULT_MODEL),
        systemPrompt: resolveSystemPrompt(systemPromptValue, pluginDir),
        systemPromptSource: systemPromptValue ? String(systemPromptValue) : null,
        hijackMode: normalizeHijackMode(hijackModeValue),
        modelMap: parseModelMap(config.BRIDGE_MODEL_MAP || ''),
        timeoutMs: legacyTimeoutMs,
        connectTimeoutMs: toBoundedInteger(config.BRIDGE_UPSTREAM_CONNECT_TIMEOUT_MS, Math.min(legacyTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS), 0),
        totalTimeoutMs: toBoundedInteger(config.BRIDGE_UPSTREAM_TOTAL_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS, 0),
        idleTimeoutMs: toBoundedInteger(config.BRIDGE_UPSTREAM_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, 0),
        denyBrowserOrigin: toBoolean(config.BRIDGE_DENY_BROWSER_ORIGIN, true),
        rateLimitRpm: toBoundedInteger(config.BRIDGE_RATE_LIMIT_RPM, DEFAULT_RATE_LIMIT_RPM, 0, 100000),
        maxBodyMb: bodyLimit.maxBodyMb,
        expressJsonLimit: bodyLimit.expressLimit,
        debugMode: Boolean(config.DebugMode),
        fetchImpl: options.fetchImpl || globalThis.fetch
    };
    validateNoSelfLoop(resolvedConfig);
    return resolvedConfig;
}

function parseBodyLimit(raw) {
    const maxBodyMb = toBoundedInteger(raw, DEFAULT_MAX_BODY_MB, 1, 512);
    return { maxBodyMb, expressLimit: `${maxBodyMb}mb` };
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

function createTimeoutError(type, ms) {
    const error = new Error(`Upstream ${type} timeout after ${ms}ms`);
    error.name = 'BridgeTimeoutError';
    error.timeoutType = type;
    return error;
}

function startTimer(ms, onTimeout) {
    if (!ms || ms <= 0) return null;
    return setTimeout(onTimeout, ms);
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

function extractFromResponsesBody(body = {}) {
    const messages = [];
    const instructions = normalizeTextContent(body.instructions);
    if (instructions) {
        messages.push({ role: 'system', content: instructions });
    }
    messages.push(...extractFromResponsesInput(body.input));
    return messages;
}

function collectDroppedResponseFields(body = {}) {
    if (!body || typeof body !== 'object') return [];
    return RESPONSE_FIELDS_NOT_SUPPORTED.filter(key => body[key] !== undefined);
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
    const maxTokens = body.max_tokens !== undefined ? body.max_tokens : body.max_output_tokens;
    return {
        model: resolveModel(model, config),
        messages,
        stream: body.stream === true,
        ...(body.temperature !== undefined && { temperature: body.temperature }),
        ...(body.top_p !== undefined && { top_p: body.top_p }),
        ...(maxTokens !== undefined && { max_tokens: maxTokens }),
        ...(body.max_completion_tokens !== undefined && { max_completion_tokens: body.max_completion_tokens }),
        ...(body.stream_options !== undefined && { stream_options: body.stream_options })
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

function buildCodexConfig(config = runtimeConfig) {
    return [
        'model_provider = "vcp_bridge"',
        `model = "${config.defaultModel}"`,
        '',
        '[model_providers.vcp_bridge]',
        'name = "VCP Bridge"',
        `base_url = "http://${config.bindHost}:${config.port}/v1"`,
        'env_key = "VCP_BRIDGE_KEY"',
        'wire_api = "responses"',
        ''
    ].join('\n');
}

function buildPromptDoctor(config = runtimeConfig) {
    const prompt = config.systemPrompt || '';
    return {
        configured: Boolean(prompt),
        source: config.systemPromptSource || null,
        chars: prompt.length,
        sha256: prompt
            ? crypto.createHash('sha256').update(prompt, 'utf8').digest('hex')
            : null
    };
}

async function probeUpstreamForDoctor(config = runtimeConfig) {
    const warnings = [];
    const upstream = new URL(config.upstreamUrl);
    const loopback = isLoopbackHost(upstream.hostname);
    const result = {
        url: sanitizeUrlForLog(config.upstreamUrl),
        type: config.upstreamType,
        loopback,
        reachable: null,
        looksLikeVCPToolBox: null,
        probe: null
    };

    if (config.upstreamType !== 'chat') {
        warnings.push('Upstream probe is only available for chat-compatible VCPToolBox mode.');
        return { upstream: result, warnings };
    }

    if (!config.upstreamKey) {
        warnings.push('Upstream probe skipped because no upstream key is configured.');
        result.looksLikeVCPToolBox = loopback ? null : false;
        return { upstream: result, warnings };
    }

    result.probe = '/v1/models';
    try {
        const response = await config.fetchImpl(`${config.upstreamUrl}/v1/models`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${config.upstreamKey}` }
        });
        result.reachable = true;
        result.status = response.status;
        result.looksLikeVCPToolBox = loopback && response.status < 500;
        if (!response.ok) {
            warnings.push(`Upstream /v1/models probe returned HTTP ${response.status}.`);
        }
    } catch (error) {
        result.reachable = false;
        result.looksLikeVCPToolBox = false;
        warnings.push(`Upstream probe failed: ${error.message}`);
    }

    return { upstream: result, warnings };
}

async function buildDoctorReport(config = runtimeConfig) {
    const upstreamProbe = await probeUpstreamForDoctor(config);
    const warnings = [...upstreamProbe.warnings];
    if (config.profile === CODEX_VCP_MEMORY_PROFILE && config.hijackMode !== 'append') {
        warnings.push('codex-vcp-memory profile is expected to use BRIDGE_HIJACK_MODE=append.');
    }
    if (config.requireVcpUpstream && upstreamProbe.upstream.looksLikeVCPToolBox === false) {
        warnings.push('BRIDGE_REQUIRE_VCP_UPSTREAM=true but the upstream was not confirmed as VCPToolBox.');
    }

    return {
        ok: warnings.length === 0,
        profile: config.profile || 'default',
        bridge: {
            bind: `${config.bindHost}:${config.port}`,
            loopbackOnly: isLoopbackHost(config.bindHost),
            clientAuth: config.clientKey ? 'enabled' : 'not_configured',
            denyBrowserOrigin: config.denyBrowserOrigin,
            rateLimitRpm: config.rateLimitRpm,
            maxBodyMb: config.maxBodyMb,
            upstreamTimeouts: {
                connectMs: config.connectTimeoutMs,
                totalMs: config.totalTimeoutMs,
                idleMs: config.idleTimeoutMs
            }
        },
        upstream: upstreamProbe.upstream,
        prompt: buildPromptDoctor(config),
        codex: {
            recommendedBaseUrl: `http://${config.bindHost}:${config.port}/v1`,
            wireApi: 'responses'
        },
        warnings
    };
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

function buildChatPayloadFromUpstream(payload, upstreamType) {
    const text = extractTextFromUpstreamPayload(payload, upstreamType);
    const usage = extractUsageFromUpstreamPayload(payload, upstreamType);
    const created = payload?.created || Math.floor(Date.now() / 1000);
    const responseId = payload?.id && String(payload.id).startsWith('chatcmpl-')
        ? payload.id
        : `chatcmpl-${payload?.id || created}`;
    return {
        id: responseId,
        object: 'chat.completion',
        created,
        model: payload?.model || runtimeConfig?.defaultModel || DEFAULT_MODEL,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: text
                },
                finish_reason: 'stop'
            }
        ],
        usage: {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: usage.total_tokens || 0
        }
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
    if (downstreamFormat === upstreamType) {
        return payload;
    }
    if (downstreamFormat === 'chat') {
        return buildChatPayloadFromUpstream(payload, upstreamType);
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

function createChatStreamChunk(id, created, model, content, finishReason = null) {
    return {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
            {
                index: 0,
                delta: content ? { content } : {},
                finish_reason: finishReason
            }
        ]
    };
}

function extractStreamingTextDelta(payload, upstreamType) {
    if (!payload || typeof payload !== 'object') return '';
    if (upstreamType === 'anthropic') {
        if (payload.type === 'content_block_delta') {
            return payload.delta?.text || '';
        }
        return normalizeTextContent(payload.content);
    }
    if (upstreamType === 'gemini') {
        return normalizeTextContent(payload.candidates?.[0]?.content?.parts);
    }
    return payload.choices?.map(choice => choice?.delta?.content || '').join('') || '';
}

function transformUpstreamSseToChatSse(sseText, upstreamType) {
    const created = Math.floor(Date.now() / 1000);
    const responseId = `chatcmpl-${created}`;
    let model = runtimeConfig?.defaultModel || DEFAULT_MODEL;
    const lines = [];

    for (const rawLine of String(sseText || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
            const chunk = JSON.parse(data);
            if (chunk.model) model = chunk.model;
            if (chunk.message?.model) model = chunk.message.model;
            const delta = extractStreamingTextDelta(chunk, upstreamType);
            if (!delta) continue;
            lines.push(`data: ${JSON.stringify(createChatStreamChunk(responseId, created, model, delta))}\n\n`);
        } catch (_error) {}
    }

    lines.push(`data: ${JSON.stringify(createChatStreamChunk(responseId, created, model, '', 'stop'))}\n\n`);
    lines.push('data: [DONE]\n\n');
    return lines.join('');
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

async function writeSseChunk(res, text) {
    if (!text) return;
    if (!res.write(text)) {
        await once(res, 'drain');
    }
}

function destroyReadable(readable) {
    try {
        if (typeof readable?.destroy === 'function') readable.destroy();
        else if (typeof readable?.cancel === 'function') readable.cancel();
    } catch (_error) {
        // ignore cleanup errors
    }
}

async function readSseLines(readable, onLine, options = {}) {
    const decoder = new TextDecoder();
    let buffer = '';
    let idleTimer = null;
    let timedOut = false;
    const resetIdleTimer = () => {
        if (!options.idleTimeoutMs) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            timedOut = true;
            if (options.abortController && !options.abortController.signal.aborted) {
                options.abortController.abort();
            }
            destroyReadable(readable);
        }, options.idleTimeoutMs);
    };

    try {
        resetIdleTimer();
        for await (const chunk of readable) {
            resetIdleTimer();
            buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
                await onLine(line);
            }
        }

        buffer += decoder.decode();
        if (buffer) {
            await onLine(buffer);
        }
    } catch (error) {
        if (!timedOut) throw error;
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
    }

    if (timedOut) {
        throw createTimeoutError('idle', options.idleTimeoutMs);
    }
}

async function streamUpstreamSseToChatSse(readable, upstreamType, res, options = {}) {
    const created = Math.floor(Date.now() / 1000);
    const responseId = `chatcmpl-${created}`;
    let model = runtimeConfig?.defaultModel || DEFAULT_MODEL;

    await readSseLines(readable, async rawLine => {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        try {
            const chunk = JSON.parse(data);
            if (chunk.model) model = chunk.model;
            if (chunk.message?.model) model = chunk.message.model;
            const delta = extractStreamingTextDelta(chunk, upstreamType);
            if (!delta) return;
            await writeSseChunk(res, `data: ${JSON.stringify(createChatStreamChunk(responseId, created, model, delta))}\n\n`);
        } catch (_error) {}
    }, options);

    await writeSseChunk(res, `data: ${JSON.stringify(createChatStreamChunk(responseId, created, model, '', 'stop'))}\n\n`);
    await writeSseChunk(res, 'data: [DONE]\n\n');
    res.end();
}

async function streamChatSseToResponsesSse(readable, res, options = {}) {
    const created = Math.floor(Date.now() / 1000);
    const responseId = `resp_${created}`;
    const itemId = `msg_${created}`;
    const deltas = [];
    let model = runtimeConfig?.defaultModel || DEFAULT_MODEL;

    await writeSseChunk(res, [
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
    ].join(''));

    await readSseLines(readable, async rawLine => {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        try {
            const chunk = JSON.parse(data);
            if (chunk.model) model = chunk.model;
            const delta = chunk.choices?.map(choice => choice?.delta?.content || '').join('') || '';
            if (!delta) return;
            deltas.push(delta);
            await writeSseChunk(res, createResponsesStreamEvent('response.output_text.delta', {
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                delta
            }));
        } catch (_error) {}
    }, options);

    const text = deltas.join('');
    await writeSseChunk(res, [
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
    ].join(''));
    res.end();
}

function shouldTransformResponse(upstreamType, downstreamFormat) {
    return downstreamFormat !== upstreamType;
}

function getRateLimitKey(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(req, config = runtimeConfig, now = Date.now()) {
    if (!config.rateLimitRpm) return { allowed: true };
    const key = getRateLimitKey(req);
    const windowMs = 60 * 1000;
    const current = rateLimitBuckets.get(key);
    const bucket = current && now - current.startedAt < windowMs
        ? current
        : { startedAt: now, count: 0 };
    bucket.count += 1;
    rateLimitBuckets.set(key, bucket);
    if (bucket.count > config.rateLimitRpm) {
        return {
            allowed: false,
            retryAfterSeconds: Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1000))
        };
    }
    return { allowed: true };
}

function createSecurityMiddleware(config = runtimeConfig) {
    return (req, res, next) => {
        if (config.denyBrowserOrigin && !isOriginAllowed(req.headers.origin, config)) {
            return res.status(403).json({ error: { message: 'Browser origin is not allowed.', type: 'forbidden_origin' } });
        }

        if (config.clientKey) {
            const token = normalizeBearerOrApiKey(req.headers);
            if (token !== config.clientKey) {
                return res.status(401).json({ error: { message: 'Bridge client key required.', type: 'unauthorized' } });
            }
        }

        const limit = checkRateLimit(req, config);
        if (!limit.allowed) {
            res.setHeader('Retry-After', String(limit.retryAfterSeconds));
            return res.status(429).json({ error: { message: 'Bridge rate limit exceeded.', type: 'rate_limit_exceeded' } });
        }

        return next();
    };
}

async function streamRawReadable(readable, res, options = {}) {
    let idleTimer = null;
    let timedOut = false;
    const resetIdleTimer = () => {
        if (!options.idleTimeoutMs) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            timedOut = true;
            if (options.abortController && !options.abortController.signal.aborted) {
                options.abortController.abort();
            }
            destroyReadable(readable);
        }, options.idleTimeoutMs);
    };

    try {
        resetIdleTimer();
        for await (const chunk of readable) {
            resetIdleTimer();
            res.write(chunk);
        }
    } catch (error) {
        if (!timedOut) throw error;
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
    }

    if (timedOut) {
        throw createTimeoutError('idle', options.idleTimeoutMs);
    }
    res.end();
}

async function proxyRequest(req, res, payload) {
    const config = runtimeConfig;
    const droppedFields = Array.isArray(payload.droppedFields) ? payload.droppedFields : [];
    const { endpoint, headers, upstreamBody, downstreamFormat } = buildUpstreamRequest({
        ...payload,
        requestHeaders: req.headers
    }, config);

    if (config.debugMode) {
        console.log(`[VCPBridgeServer] ${downstreamFormat} -> ${endpoint.type} | ${sanitizeUrlForLog(endpoint.url)} | hijack=${config.hijackMode}`);
        if (droppedFields.length > 0) {
            console.warn(`[VCPBridgeServer] responses fields not forwarded: ${droppedFields.join(', ')}`);
        }
    }

    const controller = new AbortController();
    let timeoutType = null;
    const connectTimer = startTimer(config.connectTimeoutMs, () => {
        timeoutType = 'connect';
        controller.abort();
    });
    const totalTimer = startTimer(config.totalTimeoutMs, () => {
        timeoutType = 'total';
        controller.abort();
    });
    let upstreamResponse;
    try {
        upstreamResponse = await config.fetchImpl(endpoint.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(upstreamBody),
            signal: controller.signal
        });
    } catch (error) {
        const type = timeoutType || error?.timeoutType || 'upstream';
        const message = error?.name === 'AbortError' || error?.name === 'BridgeTimeoutError'
            ? `Upstream ${type} timeout`
            : `Upstream fetch failed: ${error.message}`;
        if (connectTimer) clearTimeout(connectTimer);
        if (totalTimer) clearTimeout(totalTimer);
        return res.status(502).json({ error: { message, type: `${type}_timeout` } });
    } finally {
        if (connectTimer) clearTimeout(connectTimer);
    }

    try {
        const streamOptions = { idleTimeoutMs: config.idleTimeoutMs, abortController: controller };
        const contentType = upstreamResponse.headers.get('content-type') || '';
        const shouldTransform = upstreamResponse.ok && shouldTransformResponse(endpoint.type, downstreamFormat);
        res.status(upstreamResponse.status);
        if (droppedFields.length > 0) {
            res.setHeader('X-VCP-Bridge-Dropped-Fields', droppedFields.join(','));
        }
        upstreamResponse.headers.forEach((value, key) => {
            const lower = key.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(lower)) {
                res.setHeader(key, value);
            }
        });

        if (shouldTransform) {
            if (contentType.includes('text/event-stream') && upstreamResponse.body && endpoint.type === 'chat' && downstreamFormat === 'responses') {
                res.setHeader('content-type', 'text/event-stream; charset=utf-8');
                if (typeof res.flushHeaders === 'function') res.flushHeaders();
                return await streamChatSseToResponsesSse(upstreamResponse.body, res, streamOptions);
            }
            if (contentType.includes('text/event-stream') && upstreamResponse.body && downstreamFormat === 'chat') {
                res.setHeader('content-type', 'text/event-stream; charset=utf-8');
                if (typeof res.flushHeaders === 'function') res.flushHeaders();
                return await streamUpstreamSseToChatSse(upstreamResponse.body, endpoint.type, res, streamOptions);
            }
            const text = await upstreamResponse.text();
            if (contentType.includes('text/event-stream') && endpoint.type === 'chat' && downstreamFormat === 'responses') {
                res.setHeader('content-type', 'text/event-stream; charset=utf-8');
                return res.send(transformChatSseToResponsesSse(text));
            }
            if (contentType.includes('text/event-stream') && downstreamFormat === 'chat') {
                res.setHeader('content-type', 'text/event-stream; charset=utf-8');
                return res.send(transformUpstreamSseToChatSse(text, endpoint.type));
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

        return await streamRawReadable(upstreamResponse.body, res, streamOptions);
    } catch (error) {
        const type = timeoutType || error?.timeoutType || 'upstream';
        const message = error?.name === 'AbortError' || error?.name === 'BridgeTimeoutError'
            ? `Upstream ${type} timeout`
            : `Upstream response failed: ${error.message}`;
        if (!res.headersSent) {
            return res.status(502).json({ error: { message, type: `${type}_timeout` } });
        }
        if (!res.writableEnded) {
            res.end();
        }
        return undefined;
    } finally {
        if (totalTimer) clearTimeout(totalTimer);
    }
}

function createApp() {
    const app = express();
    app.use(express.json({ limit: runtimeConfig.expressJsonLimit }));
    app.use(createSecurityMiddleware(runtimeConfig));

    app.get('/health', (_req, res) => {
        res.json({
            ok: true,
            profile: runtimeConfig.profile || 'default',
            hijackMode: runtimeConfig.hijackMode,
            hasSystemPrompt: Boolean(runtimeConfig.systemPrompt),
            upstreamType: runtimeConfig.upstreamType,
            upstreamUrl: sanitizeUrlForLog(runtimeConfig.upstreamUrl),
            modelMap: runtimeConfig.modelMap,
            clientAuth: runtimeConfig.clientKey ? 'enabled' : 'not_configured',
            denyBrowserOrigin: runtimeConfig.denyBrowserOrigin,
            rateLimitRpm: runtimeConfig.rateLimitRpm,
            maxBodyMb: runtimeConfig.maxBodyMb,
            upstreamTimeouts: {
                connectMs: runtimeConfig.connectTimeoutMs,
                totalMs: runtimeConfig.totalTimeoutMs,
                idleMs: runtimeConfig.idleTimeoutMs
            }
        });
    });

    app.get('/doctor', async (_req, res) => {
        res.json(await buildDoctorReport(runtimeConfig));
    });

    app.get('/doctor/codex-config', (_req, res) => {
        res.type('text/plain; charset=utf-8').send(buildCodexConfig(runtimeConfig));
    });

    app.post('/v1/chat/completions', async (req, res) => {
        const body = req.body || {};
        const messages = Array.isArray(body.messages) ? body.messages : [];
        await proxyRequest(req, res, { messages, model: body.model, body, downstreamFormat: 'chat' });
    });

    app.post('/v1/responses', async (req, res) => {
        const body = req.body || {};
        const messages = extractFromResponsesBody(body);
        const droppedFields = collectDroppedResponseFields(body);
        const stream = body.stream === true || String(req.headers.accept || '').includes('text/event-stream');
        await proxyRequest(req, res, { messages, model: body.model, body: { ...body, stream }, downstreamFormat: 'responses', droppedFields });
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
    rateLimitBuckets.clear();
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
        buildChatPayloadFromUpstream,
        buildResponsesPayloadFromUpstream,
        createRuntimeConfig,
        collectDroppedResponseFields,
        checkRateLimit,
        extractFromAnthropicBody,
        extractFromGeminiBody,
        extractFromResponsesBody,
        extractFromResponsesInput,
        transformChatSseToResponsesSse,
        transformUpstreamSseToChatSse,
        transformUpstreamJsonPayload,
        normalizeApiType,
        normalizeHostForCompare,
        normalizeHijackMode,
        normalizeOriginForCompare,
        normalizeProfile,
        normalizeTextContent,
        parseModelMap,
        resolveModel,
        resolveProfileDefaults,
        resolveSystemPrompt,
        resolveUpstreamEndpoint,
        sanitizeUrlForLog,
        isOriginAllowed,
        buildCodexConfig,
        buildDoctorReport,
        buildPromptDoctor,
        probeUpstreamForDoctor,
        readSseLines,
        validateNoSelfLoop,
        isRunning: () => Boolean(server)
    }
};
