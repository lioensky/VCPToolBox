// VCPBridgeServer - System Prompt 劫持代理
// 独立端口运行，拦截 CLI 工具请求，注入/替换 system prompt 后转发到上游 API。
// 支持 OpenAI Chat、Responses API、Anthropic Messages、Gemini 四种协议。

const express = require('express');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const { CONFIG_PATH, migrateBridgeConfig, normalizeBridgeConfig, parseModelMap } = require('./bridgeConfig');

let server = null;
let configWatcher = null;
let runtimeConfig = {};

// ============================================================
// 初始化与生命周期
// ============================================================

function initialize(config) {
    const bridgeConfig = migrateBridgeConfig();
    applyBridgeRuntimeConfig(bridgeConfig, config, true);
    startConfigWatcher(config);
    startServer();
    console.log(`[VCPBridgeServer] Initialized. Hijack mode: ${runtimeConfig.hijackMode}, Port: ${runtimeConfig.port}, Upstream: ${runtimeConfig.upstreamUrl}`);
}

function applyBridgeRuntimeConfig(bridgeConfig, hostConfig = {}, isInitial = false) {
    // 默认上游自动指向本地 VCP 主服务器，无需用户手动配置
    const mainServerPort = hostConfig.PORT || process.env.PORT || 6005;
    const mainServerKey = hostConfig.Key || process.env.Key || '';
    const defaultUpstream = `http://127.0.0.1:${mainServerPort}`;

    const normalized = normalizeBridgeConfig({
        ...bridgeConfig,
        mainServerPort,
        upstreamUrl: bridgeConfig.upstreamUrl || defaultUpstream,
        upstreamKey: bridgeConfig.upstreamKey || mainServerKey
    });

    const previousPort = runtimeConfig.port;
    runtimeConfig = {
        port: normalized.port,
        upstreamUrl: normalized.upstreamUrl,
        upstreamKey: normalized.upstreamKey,
        upstreamType: normalized.upstreamType,
        defaultModel: normalized.defaultModel,
        systemPrompt: resolveSystemPrompt(normalized.systemPrompt),
        hijackMode: normalized.hijackMode,
        modelMap: parseModelMap(normalized.modelMap),
        debugMode: normalized.debugMode,
        basePath: hostConfig.PROJECT_BASE_PATH || __dirname,
        configPath: CONFIG_PATH
    };

    if (!isInitial && previousPort && previousPort !== runtimeConfig.port) {
        console.warn(`[VCPBridgeServer] bridge-config.json port changed from ${previousPort} to ${runtimeConfig.port}. Port changes require plugin/server restart.`);
    }

    if (!isInitial) {
        console.log(`[VCPBridgeServer] Hot config reloaded. Hijack mode: ${runtimeConfig.hijackMode}, Upstream: ${runtimeConfig.upstreamUrl}`);
    }
}

function startConfigWatcher(hostConfig = {}) {
    if (configWatcher) return;

    configWatcher = chokidar.watch(CONFIG_PATH, {
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 250,
            pollInterval: 50
        }
    });

    const reload = () => {
        try {
            const bridgeConfig = migrateBridgeConfig();
            applyBridgeRuntimeConfig(bridgeConfig, hostConfig, false);
        } catch (error) {
            console.error('[VCPBridgeServer] Failed to hot reload bridge-config.json:', error);
        }
    };

    configWatcher.on('add', reload);
    configWatcher.on('change', reload);
    configWatcher.on('error', error => {
        console.error('[VCPBridgeServer] bridge-config.json watcher error:', error);
    });
}

function shutdown() {
    if (configWatcher) {
        configWatcher.close();
        configWatcher = null;
    }
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
// 原生工具字段保护/转换（不进入 messages，只在构建上游 body 时加回）
// ============================================================

function normalizeToolParameters(parameters) {
    if (parameters && typeof parameters === 'object') return parameters;
    return { type: 'object', properties: {} };
}

function toOpenAiChatTool(tool) {
    if (!tool || typeof tool !== 'object') return null;

    if (tool.type === 'function' && tool.function?.name) {
        return {
            type: 'function',
            function: {
                name: tool.function.name,
                ...(tool.function.description && { description: tool.function.description }),
                parameters: normalizeToolParameters(tool.function.parameters || tool.function.input_schema)
            }
        };
    }

    if ((tool.type === 'function' || !tool.type) && tool.name) {
        return {
            type: 'function',
            function: {
                name: tool.name,
                ...(tool.description && { description: tool.description }),
                parameters: normalizeToolParameters(tool.parameters || tool.input_schema || tool.schema)
            }
        };
    }

    return null;
}

function extractProtectedTools(body) {
    const tools = [];

    if (Array.isArray(body?.tools)) {
        for (const tool of body.tools) {
            const functionDeclarations = tool?.functionDeclarations || tool?.function_declarations;
            if (Array.isArray(functionDeclarations)) {
                for (const declaration of functionDeclarations) {
                    const converted = toOpenAiChatTool(declaration);
                    if (converted) tools.push(converted);
                }
                continue;
            }

            const converted = toOpenAiChatTool(tool);
            if (converted) tools.push(converted);
        }
    }

    if (Array.isArray(body?.functions)) {
        for (const fn of body.functions) {
            const converted = toOpenAiChatTool({ type: 'function', ...fn });
            if (converted) tools.push(converted);
        }
    }

    return tools;
}

function normalizeToolChoice(toolChoice, body) {
    if (!toolChoice && body?.toolConfig?.functionCallingConfig) {
        const config = body.toolConfig.functionCallingConfig;
        const mode = String(config.mode || '').toUpperCase();
        if (mode === 'NONE') return 'none';
        if (mode === 'ANY') {
            const allowed = Array.isArray(config.allowedFunctionNames) ? config.allowedFunctionNames.filter(Boolean) : [];
            if (allowed.length === 1) {
                return { type: 'function', function: { name: allowed[0] } };
            }
            return 'required';
        }
        if (mode === 'AUTO') return 'auto';
    }

    if (!toolChoice) return undefined;
    if (typeof toolChoice === 'string') return toolChoice;
    if (typeof toolChoice !== 'object') return undefined;

    if (toolChoice.type === 'function' && toolChoice.function?.name) {
        return { type: 'function', function: { name: toolChoice.function.name } };
    }

    if (toolChoice.type === 'function' && toolChoice.name) {
        return { type: 'function', function: { name: toolChoice.name } };
    }

    if (toolChoice.type === 'tool' && toolChoice.name) {
        return { type: 'function', function: { name: toolChoice.name } };
    }

    if (toolChoice.type === 'auto') return 'auto';
    if (toolChoice.type === 'any') return 'required';
    if (toolChoice.type === 'none') return 'none';

    return undefined;
}

function attachProtectedChatToolFields(targetBody, sourceBody) {
    const tools = extractProtectedTools(sourceBody);
    if (tools.length > 0) targetBody.tools = tools;

    const toolChoice = normalizeToolChoice(sourceBody?.tool_choice, sourceBody);
    if (toolChoice !== undefined) targetBody.tool_choice = toolChoice;

    if (typeof sourceBody?.parallel_tool_calls === 'boolean') {
        targetBody.parallel_tool_calls = sourceBody.parallel_tool_calls;
    }

    return targetBody;
}

function attachProtectedAnthropicToolFields(targetBody, sourceBody) {
    const tools = extractProtectedTools(sourceBody).map(tool => ({
        name: tool.function.name,
        ...(tool.function.description && { description: tool.function.description }),
        input_schema: normalizeToolParameters(tool.function.parameters)
    }));

    if (tools.length > 0) targetBody.tools = tools;
    if (sourceBody?.tool_choice) targetBody.tool_choice = sourceBody.tool_choice;

    return targetBody;
}

function attachProtectedGeminiToolFields(targetBody, sourceBody) {
    const functionDeclarations = extractProtectedTools(sourceBody).map(tool => ({
        name: tool.function.name,
        ...(tool.function.description && { description: tool.function.description }),
        parameters: normalizeToolParameters(tool.function.parameters)
    }));

    if (functionDeclarations.length > 0) {
        targetBody.tools = [{ functionDeclarations }];
    }

    if (sourceBody?.toolConfig) {
        targetBody.toolConfig = sourceBody.toolConfig;
    }

    return targetBody;
}

// ============================================================
// Responses API 响应转换工具
// ============================================================

function buildResponsesUsage(usage) {
    return {
        input_tokens: usage?.prompt_tokens || usage?.input_tokens || 0,
        output_tokens: usage?.completion_tokens || usage?.output_tokens || 0,
        total_tokens: usage?.total_tokens || ((usage?.input_tokens || 0) + (usage?.output_tokens || 0)),
        input_tokens_details: usage?.prompt_tokens_details || usage?.input_tokens_details || {},
        output_tokens_details: usage?.completion_tokens_details || usage?.output_tokens_details || {}
    };
}

function buildBaseResponsesEnvelope(model) {
    return {
        id: `resp_${Date.now()}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'in_progress',
        model,
        output: [{
            id: `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '', annotations: [] }]
        }],
        output_text: '',
        usage: buildResponsesUsage(null)
    };
}

function writeResponsesSseEvent(res, eventName, data) {
    if (res.destroyed || res.writableEnded) return false;
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
}

function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function extractTextFromProtocolResponse(raw, apiType) {
    if (apiType === 'anthropic') {
        const content = raw?.content;
        return Array.isArray(content) ? content.map(item => item?.text || '').join('') : '';
    }
    if (apiType === 'gemini') {
        const parts = raw?.candidates?.[0]?.content?.parts;
        return Array.isArray(parts) ? parts.map(part => part?.text || '').join('') : '';
    }
    return raw?.choices?.[0]?.message?.content || '';
}

function extractUsageFromProtocolResponse(raw, apiType) {
    if (apiType === 'anthropic') {
        return {
            input_tokens: raw?.usage?.input_tokens || 0,
            output_tokens: raw?.usage?.output_tokens || 0,
            total_tokens: (raw?.usage?.input_tokens || 0) + (raw?.usage?.output_tokens || 0)
        };
    }
    if (apiType === 'gemini') {
        return {
            prompt_tokens: raw?.usageMetadata?.promptTokenCount || 0,
            completion_tokens: raw?.usageMetadata?.candidatesTokenCount || 0,
            total_tokens: raw?.usageMetadata?.totalTokenCount || 0
        };
    }
    return raw?.usage || null;
}

function extractStreamDeltaByProtocol(eventJson, apiType) {
    if (apiType === 'anthropic') {
        return eventJson?.delta?.text || eventJson?.content_block?.text || '';
    }
    if (apiType === 'gemini') {
        const parts = eventJson?.candidates?.[0]?.content?.parts;
        return Array.isArray(parts) ? parts.map(part => part?.text || '').join('') : '';
    }
    return eventJson?.choices?.[0]?.delta?.content || eventJson?.choices?.[0]?.message?.content || '';
}

function extractStreamUsageByProtocol(eventJson, apiType) {
    if (apiType === 'gemini' && eventJson?.usageMetadata) {
        return {
            prompt_tokens: eventJson.usageMetadata.promptTokenCount || 0,
            completion_tokens: eventJson.usageMetadata.candidatesTokenCount || 0,
            total_tokens: eventJson.usageMetadata.totalTokenCount || 0
        };
    }
    return eventJson?.usage || null;
}

async function* iterateUpstreamSseJson(readableStream) {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    for await (const chunk of readableStream) {
        buffer += decoder.decode(chunk, { stream: true });

        while (true) {
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex === -1) break;

            const line = buffer.slice(0, newlineIndex).trimEnd();
            buffer = buffer.slice(newlineIndex + 1);

            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;

            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') return;

            const json = safeJsonParse(data);
            if (json) yield json;
        }
    }
}

function buildResponsesOutput(raw, apiType, fallbackModel) {
    const text = extractTextFromProtocolResponse(raw, apiType);
    const responsePayload = buildBaseResponsesEnvelope(raw?.model || fallbackModel);
    responsePayload.status = 'completed';
    responsePayload.output[0].content[0].text = text;
    responsePayload.output_text = text;
    responsePayload.usage = buildResponsesUsage(extractUsageFromProtocolResponse(raw, apiType));
    return responsePayload;
}

async function sendResponsesStreamFromProtocol(res, upstreamResponse, { model, apiType }) {
    res.status(upstreamResponse.status);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const responsePayload = buildBaseResponsesEnvelope(model);
    const itemId = responsePayload.output[0].id;
    let finalUsage = null;

    writeResponsesSseEvent(res, 'response.created', {
        type: 'response.created',
        response: {
            id: responsePayload.id,
            object: responsePayload.object,
            created_at: responsePayload.created_at,
            status: 'in_progress',
            model: responsePayload.model,
            usage: buildResponsesUsage(null)
        }
    });

    writeResponsesSseEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: itemId, type: 'message', role: 'assistant', content: [] }
    });

    writeResponsesSseEvent(res, 'response.content_part.added', {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' }
    });

    try {
        for await (const eventJson of iterateUpstreamSseJson(upstreamResponse.body)) {
            const delta = extractStreamDeltaByProtocol(eventJson, apiType);
            if (typeof delta === 'string' && delta.length > 0) {
                responsePayload.output_text += delta;
                writeResponsesSseEvent(res, 'response.output_text.delta', {
                    type: 'response.output_text.delta',
                    item_id: itemId,
                    output_index: 0,
                    content_index: 0,
                    delta
                });
            }

            const usage = extractStreamUsageByProtocol(eventJson, apiType);
            if (usage) finalUsage = usage;
            if (eventJson?.model) responsePayload.model = eventJson.model;
        }

        responsePayload.status = 'completed';
        responsePayload.output[0].content[0].text = responsePayload.output_text;
        if (finalUsage) responsePayload.usage = buildResponsesUsage(finalUsage);

        writeResponsesSseEvent(res, 'response.output_text.done', {
            type: 'response.output_text.done',
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            text: responsePayload.output_text
        });

        writeResponsesSseEvent(res, 'response.content_part.done', {
            type: 'response.content_part.done',
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: responsePayload.output_text }
        });

        writeResponsesSseEvent(res, 'response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: responsePayload.output[0]
        });

        writeResponsesSseEvent(res, 'response.completed', {
            type: 'response.completed',
            response: responsePayload
        });
    } catch (error) {
        responsePayload.status = 'failed';
        responsePayload.output[0].content[0].text = responsePayload.output_text;
        responsePayload.error = {
            code: 'vcp_bridge_stream_error',
            message: error.message || 'VCP bridge stream failed before completion.'
        };
        writeResponsesSseEvent(res, 'response.failed', {
            type: 'response.failed',
            response: responsePayload
        });
    }

    if (!res.destroyed && !res.writableEnded) res.end();
}

async function sendResponsesJsonFromProtocol(res, upstreamResponse, { model, apiType }) {
    const rawText = await upstreamResponse.text();
    const rawJson = safeJsonParse(rawText);

    if (!upstreamResponse.ok) {
        return res.status(upstreamResponse.status).type('application/json').send(rawJson || rawText);
    }

    return res.status(upstreamResponse.status).json(buildResponsesOutput(rawJson || {}, apiType, model));
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

        case 'merge': {
            // 合并所有 system 消息为一条置顶 system；注入提示词优先，然后按原消息顺序拼接已有 system。
            const systemContents = [
                injected.content,
                ...result
                    .filter(m => m.role === 'system')
                    .map(m => m.content)
                    .filter(content => typeof content === 'string' && content.trim())
            ];
            const mergedSystem = { role: 'system', content: systemContents.join('\n\n') };
            const nonSystem = result.filter(m => m.role !== 'system');
            return [mergedSystem, ...nonSystem];
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
            if (item?.type === 'output_text' && typeof item.text === 'string') return item.text;
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
        const content = normalizeTextContent(item.content || item.output);
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
    const result = {
        model: resolveModel(model),
        messages,
        stream: body.stream === true,
        ...(body.temperature !== undefined && { temperature: body.temperature }),
        ...(body.top_p !== undefined && { top_p: body.top_p }),
        ...(body.max_tokens !== undefined && { max_tokens: body.max_tokens })
    };
    return attachProtectedChatToolFields(result, body);
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
    return attachProtectedAnthropicToolFields(result, body);
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
    return attachProtectedGeminiToolFields(result, body);
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

    // 6. Responses API 下游必须返回 Responses 格式，不能裸透传 chat/anthropic/gemini SSE。
    if (downstreamFormat === 'responses') {
        const fallbackModel = resolveModel(model);
        if (stream && upstreamResponse.body) {
            return sendResponsesStreamFromProtocol(res, upstreamResponse, {
                model: fallbackModel,
                apiType: endpoint.type
            });
        }
        return sendResponsesJsonFromProtocol(res, upstreamResponse, {
            model: fallbackModel,
            apiType: endpoint.type
        });
    }

    // 7. 其他协议暂时透传响应（保持原始格式，不做响应转换）
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
            modelMap: runtimeConfig.modelMap,
            configPath: runtimeConfig.configPath
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
        const stream = body.stream === true || String(req.headers.accept || '').includes('text/event-stream');
        await proxyRequest(req, res, { messages, model: body.model, body: { ...body, stream }, downstreamFormat: 'anthropic' });
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