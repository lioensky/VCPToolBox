// VCPBridgeServer - System Prompt 劫持代理
// 独立端口运行，拦截 CLI 工具请求，注入/替换 system prompt 后转发到上游 API。
// 支持 OpenAI Chat、Responses API、Anthropic Messages、Gemini 四种协议。

const express = require('express');
const path = require('path');
const fs = require('fs');

let server = null;
let runtimeConfig = {};

// ============================================================
// 初始化与生命周期
// ============================================================

function initialize(config) {
    runtimeConfig = {
        port: config.BRIDGE_PORT || 3100,
        upstreamUrl: (config.BRIDGE_UPSTREAM_URL || 'https://api.openai.com').replace(/\/+$/, ''),
        upstreamKey: config.BRIDGE_UPSTREAM_KEY || '',
        upstreamType: normalizeApiType(config.BRIDGE_UPSTREAM_TYPE),
        defaultModel: config.BRIDGE_MODEL || 'gpt-4.1-mini',
        systemPrompt: resolveSystemPrompt(config.BRIDGE_SYSTEM_PROMPT || ''),
        hijackMode: (config.BRIDGE_HIJACK_MODE || 'off').toLowerCase(),
        modelMap: parseModelMap(config.BRIDGE_MODEL_MAP || ''),
        debugMode: config.DebugMode || false,
        basePath: config.PROJECT_BASE_PATH || __dirname
    };

    startServer();
    console.log(`[VCPBridgeServer] Initialized. Hijack mode: ${runtimeConfig.hijackMode}, Port: ${runtimeConfig.port}`);
}

function shutdown() {
    if (server) {
        server.close();
        server = null;
        console.log('[VCPBridgeServer] Server stopped.');
    }
}

// ============================================================
// 工具函数
// ============================================================

function normalizeApiType(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'anthropic' || v === 'claude') return 'anthropic';
    if (v === 'gemini' || v === 'google') return 'gemini';
    return 'chat';
}

function resolveSystemPrompt(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return '';

    // 如果是 .txt 文件名，从插件目录加载
    if (/^[^\\\/:*?"<>|\r\n]+\.txt$/i.test(trimmed)) {
        const filePath = path.join(__dirname, trimmed);
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf8').trim();
        }
    }
    return trimmed;
}

function parseModelMap(raw) {
    if (!raw) return {};
    return raw.split(',').reduce((acc, pair) => {
        const idx = pair.indexOf(':');
        if (idx > 0) {
            const alias = pair.slice(0, idx).trim();
            const target = pair.slice(idx + 1).trim();
            if (alias && target) acc[alias] = target;
        }
        return acc;
    }, {});
}

function resolveModel(model) {
    const candidate = model || runtimeConfig.defaultModel;
    return runtimeConfig.modelMap[candidate] || candidate;
}

function extractBearerToken(authHeader) {
    if (!authHeader) return '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

// ============================================================
// System Prompt 劫持逻辑
// ============================================================

function applySystemPromptHijack(messages) {
    if (!runtimeConfig.systemPrompt || runtimeConfig.hijackMode === 'off') {
        return messages;
    }

    const result = [...messages];
    const injected = { role: 'system', content: runtimeConfig.systemPrompt };

    switch (runtimeConfig.hijackMode) {
        case 'replace':
            // 移除所有 system 消息，替换为我们的
            const nonSystem = result.filter(m => m.role !== 'system');
            return [injected, ...nonSystem];

        case 'prepend':
            // 在第一条 system 消息之前插入
            return [injected, ...result];

        case 'append': {
            // 在最后一条 system 消息之后插入
            const lastSystemIdx = result.reduce((acc, m, i) => m.role === 'system' ? i : acc, -1);
            if (lastSystemIdx >= 0) {
                result.splice(lastSystemIdx + 1, 0, injected);
            } else {
                result.unshift(injected);
            }
            return result;
        }

        default:
            return result;
    }
}

// ============================================================
// 消息提取（各协议 → 统一 messages 数组）
// ============================================================

function normalizeTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(item => {
            if (typeof item === 'string') return item;
            if (item?.type === 'text' && typeof item.text === 'string') return item.text;
            if (item?.type === 'input_text' && typeof item.text === 'string') return item.text;
            return '';
        }).filter(Boolean).join('\n');
    }
    return '';
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

function extractFromAnthropicBody(body) {
    const messages = [];
    // system
    if (body.system) {
        const sys = typeof body.system === 'string' ? body.system
            : Array.isArray(body.system) ? body.system.map(i => i?.text || '').filter(Boolean).join('\n')
            : '';
        if (sys) messages.push({ role: 'system', content: sys });
    }
    // messages
    if (Array.isArray(body.messages)) {
        for (const m of body.messages) {
            const content = normalizeTextContent(m.content);
            if (m.role && content) messages.push({ role: m.role, content });
        }
    }
    return messages;
}

function extractFromGeminiBody(body) {
    const messages = [];
    // systemInstruction
    if (body.systemInstruction?.parts) {
        const sys = body.systemInstruction.parts.map(p => p?.text || '').filter(Boolean).join('\n');
        if (sys) messages.push({ role: 'system', content: sys });
    }
    // contents
    if (Array.isArray(body.contents)) {
        for (const c of body.contents) {
            const role = c.role === 'model' ? 'assistant' : 'user';
            const text = normalizeTextContent(c.parts);
            if (text) messages.push({ role, content: text });
        }
    }
    return messages;
}

// ============================================================
// 上游请求构建（统一 messages → 目标协议格式）
// ============================================================

function buildUpstreamChatBody(messages, model, body) {
    return {
        model: resolveModel(model),
        messages,
        stream: body.stream === true,
        ...(body.temperature !== undefined && { temperature: body.temperature }),
        ...(body.top_p !== undefined && { top_p: body.top_p }),
        ...(body.max_tokens !== undefined && { max_tokens: body.max_tokens })
    };
}

function buildUpstreamAnthropicBody(messages, model, body) {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const nonSystem = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
    }));
    const result = {
        model: resolveModel(model),
        messages: nonSystem,
        max_tokens: body.max_tokens || body.max_output_tokens || 4096,
        stream: body.stream === true
    };
    if (system) result.system = system;
    if (body.temperature !== undefined) result.temperature = body.temperature;
    return result;
}

function buildUpstreamGeminiBody(messages, model, body) {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const contents = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
    }));
    const result = { contents };
    if (system) result.systemInstruction = { parts: [{ text: system }] };
    const genConfig = {};
    if (body.temperature !== undefined) genConfig.temperature = body.temperature;
    if (body.top_p !== undefined) genConfig.topP = body.top_p;
    if (body.max_tokens !== undefined || body.max_output_tokens !== undefined) {
        genConfig.maxOutputTokens = body.max_output_tokens || body.max_tokens;
    }
    if (Object.keys(genConfig).length > 0) result.generationConfig = genConfig;
    return result;
}

// ============================================================
// 上游路由解析
// ============================================================

function resolveUpstreamEndpoint(model, stream) {
    const type = runtimeConfig.upstreamType;
    const base = runtimeConfig.upstreamUrl;

    if (type === 'anthropic') {
        return { url: `${base}/v1/messages`, type: 'anthropic' };
    }
    if (type === 'gemini') {
        const m = encodeURIComponent(resolveModel(model));
        const action = stream ? 'streamGenerateContent' : 'generateContent';
        return { url: `${base}/v1beta/models/${m}:${action}`, type: 'gemini' };
    }
    return { url: `${base}/v1/chat/completions`, type: 'chat' };
}

// ============================================================
// 核心代理逻辑
// ============================================================

async function proxyRequest(req, res, { messages, model, body, downstreamFormat }) {
    // 1. 应用 system prompt 劫持
    const hijackedMessages = applySystemPromptHijack(messages);

    // 2. 解析上游端点
    const stream = body.stream === true;
    const endpoint = resolveUpstreamEndpoint(model, stream);

    // 3. 构建上游请求体
    let upstreamBody;
    switch (endpoint.type) {
        case 'anthropic':
            upstreamBody = buildUpstreamAnthropicBody(hijackedMessages, model, body);
            break;
        case 'gemini':
            upstreamBody = buildUpstreamGeminiBody(hijackedMessages, model, body);
            break;
        default:
            upstreamBody = buildUpstreamChatBody(hijackedMessages, model, body);
    }

    // 4. 构建请求头
    const requestToken = extractBearerToken(req.headers.authorization);
    const upstreamKey = runtimeConfig.upstreamKey || requestToken;
    const headers = { 'Content-Type': 'application/json' };

    if (upstreamKey) headers.Authorization = `Bearer ${upstreamKey}`;
    if (endpoint.type === 'anthropic') {
        headers['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01';
        if (req.headers['x-api-key']) headers['x-api-key'] = req.headers['x-api-key'];
    }
    if (req.headers['x-goog-api-key']) headers['x-goog-api-key'] = req.headers['x-goog-api-key'];

    if (runtimeConfig.debugMode) {
        console.log(`[VCPBridgeServer] ${downstreamFormat} → ${endpoint.type} | ${endpoint.url} | hijack=${runtimeConfig.hijackMode}`);
    }

    // 5. 发送请求
    let upstreamResponse;
    try {
        upstreamResponse = await fetch(endpoint.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(upstreamBody)
        });
    } catch (err) {
        return res.status(502).json({ error: { message: `Upstream fetch failed: ${err.message}`, type: 'upstream_error' } });
    }

    // 6. 透传响应（保持原始格式，不做响应转换）
    res.status(upstreamResponse.status);
    upstreamResponse.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower !== 'content-encoding' && lower !== 'transfer-encoding' && lower !== 'content-length') {
            res.setHeader(key, value);
        }
    });

    if (!upstreamResponse.body) {
        const text = await upstreamResponse.text();
        return res.send(text);
    }

    for await (const chunk of upstreamResponse.body) {
        res.write(chunk);
    }
    res.end();
}

// ============================================================
// Express 路由
// ============================================================

function startServer() {
    const app = express();
    app.use(express.json({ limit: '10mb' }));

    // 健康检查
    app.get('/health', (req, res) => {
        res.json({
            ok: true,
            hijackMode: runtimeConfig.hijackMode,
            hasSystemPrompt: Boolean(runtimeConfig.systemPrompt),
            upstreamType: runtimeConfig.upstreamType,
            upstreamUrl: runtimeConfig.upstreamUrl,
            modelMap: runtimeConfig.modelMap
        });
    });

    // OpenAI Chat Completions
    app.post('/v1/chat/completions', async (req, res) => {
        const body = req.body || {};
        const messages = Array.isArray(body.messages) ? body.messages : [];
        await proxyRequest(req, res, { messages, model: body.model, body, downstreamFormat: 'chat' });
    });

    // OpenAI Responses API
    app.post('/v1/responses', async (req, res) => {
        const body = req.body || {};
        const messages = extractFromResponsesInput(body.input);
        const stream = body.stream === true || String(req.headers.accept || '').includes('text/event-stream');
        await proxyRequest(req, res, { messages, model: body.model, body: { ...body, stream }, downstreamFormat: 'responses' });
    });

    // Anthropic Messages
    app.post('/v1/messages', async (req, res) => {
        const body = req.body || {};
        const messages = extractFromAnthropicBody(body);
        await proxyRequest(req, res, { messages, model: body.model, body, downstreamFormat: 'anthropic' });
    });

    // Gemini GenerateContent
    app.post(/^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/, async (req, res) => {
        const body = req.body || {};
        const messages = extractFromGeminiBody(body);
        const model = req.params[0] || runtimeConfig.defaultModel;
        const stream = req.params[1] === 'streamGenerateContent';
        await proxyRequest(req, res, { messages, model, body: { ...body, stream }, downstreamFormat: 'gemini' });
    });

    // 启动监听
    server = app.listen(runtimeConfig.port, () => {
        console.log(`[VCPBridgeServer] Prompt hijack proxy listening on http://127.0.0.1:${runtimeConfig.port}`);
        console.log(`[VCPBridgeServer] Upstream: ${runtimeConfig.upstreamUrl} (${runtimeConfig.upstreamType})`);
        if (runtimeConfig.systemPrompt) {
            console.log(`[VCPBridgeServer] System prompt loaded (${runtimeConfig.systemPrompt.length} chars), mode: ${runtimeConfig.hijackMode}`);
        }
    });
}

// ============================================================
// 导出
// ============================================================

module.exports = { initialize, shutdown };