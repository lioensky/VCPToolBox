// VCPBridgeServer - System Prompt 劫持代理
// 独立端口运行，拦截 CLI 工具请求，注入/替换 system prompt 后转发到上游 API。
// 支持 OpenAI Chat、Responses API、Anthropic Messages、Gemini 四种协议。

const express = require('express');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const { CONFIG_PATH, PROFILES_DIR, migrateBridgeConfig, normalizeBridgeConfig, resolveTriState, parseModelMap, profileExists, readProfile, listProfiles } = require('./bridgeConfig');

let server = null;
let configWatcher = null;
let profilesWatcher = null;
let runtimeConfig = {};
let profilesCache = new Map();

// ============================================================
// 初始化与生命周期
// ============================================================

function initialize(config) {
    const bridgeConfig = migrateBridgeConfig();
    applyBridgeRuntimeConfig(bridgeConfig, config, true);
    startConfigWatcher(config);
    startProfilesWatcher();
    loadAllProfiles();
    startServer();
    console.log(`[VCPBridgeServer] Initialized. Hijack mode: ${runtimeConfig.hijackMode}, Port: ${runtimeConfig.port}, Upstream: ${runtimeConfig.upstreamUrl}, Profiles: ${profilesCache.size}`);
}

function startProfilesWatcher() {
    if (profilesWatcher) return;
    try {
        const fs_sync = require('fs');
        if (!fs_sync.existsSync(PROFILES_DIR)) {
            fs_sync.mkdirSync(PROFILES_DIR, { recursive: true });
        }
        profilesWatcher = chokidar.watch(PROFILES_DIR, {
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 250,
                pollInterval: 50
            }
        });
        const reload = () => loadAllProfiles();
        profilesWatcher.on('add', reload);
        profilesWatcher.on('change', reload);
        profilesWatcher.on('unlink', reload);
        profilesWatcher.on('error', error => {
            console.error('[VCPBridgeServer] Profiles watcher error:', error);
        });
    } catch (error) {
        console.error('[VCPBridgeServer] Failed to start profiles watcher:', error);
    }
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
        defaultProfile: normalized.defaultProfile,
        stripClientTools: normalized.stripClientTools,
        filterHostedVcptools: normalized.filterHostedVcptools,
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
    if (profilesWatcher) {
        profilesWatcher.close();
        profilesWatcher = null;
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

    // 如果是 .txt 文件名，按优先级搜索多个目录
    if (/^[^\\\/:*?"<>|\r\n]+\.txt$/i.test(trimmed)) {
        const searchDirs = [
            __dirname,                          // 插件根目录
            path.join(__dirname, 'presets')      // presets 子目录
        ];
        for (const dir of searchDirs) {
            const filePath = path.join(dir, trimmed);
            if (fs.existsSync(filePath)) {
                return fs.readFileSync(filePath, 'utf8').trim();
            }
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
                ...(typeof tool.function.strict === 'boolean' && { strict: tool.function.strict }),
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
                ...(typeof tool.strict === 'boolean' && { strict: tool.strict }),
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

function attachProtectedChatToolFields(targetBody, sourceBody, { stripClientTools = false } = {}) {
    if (stripClientTools) return targetBody;
    const tools = extractProtectedTools(sourceBody);
    if (tools.length > 0) targetBody.tools = tools;

    const toolChoice = normalizeToolChoice(sourceBody?.tool_choice, sourceBody);
    if (toolChoice !== undefined && (tools.length > 0 || toolChoice === 'none')) {
        targetBody.tool_choice = toolChoice;
    }

    if (typeof sourceBody?.parallel_tool_calls === 'boolean' && tools.length > 0) {
        targetBody.parallel_tool_calls = sourceBody.parallel_tool_calls;
    }

    return targetBody;
}

function attachProtectedAnthropicToolFields(targetBody, sourceBody, { stripClientTools = false } = {}) {
    if (stripClientTools) return targetBody;
    const tools = extractProtectedTools(sourceBody).map(tool => ({
        name: tool.function.name,
        ...(tool.function.description && { description: tool.function.description }),
        input_schema: normalizeToolParameters(tool.function.parameters)
    }));

    if (tools.length > 0) targetBody.tools = tools;
    const tcType = typeof sourceBody?.tool_choice === 'string'
        ? sourceBody.tool_choice
        : sourceBody?.tool_choice?.type;
    if (sourceBody?.tool_choice && (tools.length > 0 || tcType === 'none')) {
        targetBody.tool_choice = sourceBody.tool_choice;
    }

    return targetBody;
}

function attachProtectedGeminiToolFields(targetBody, sourceBody, { stripClientTools = false } = {}) {
    if (stripClientTools) return targetBody;
    const functionDeclarations = extractProtectedTools(sourceBody).map(tool => ({
        name: tool.function.name,
        ...(tool.function.description && { description: tool.function.description }),
        parameters: normalizeToolParameters(tool.function.parameters)
    }));

    if (functionDeclarations.length > 0) {
        targetBody.tools = [{ functionDeclarations }];
    }

    const mode = String(sourceBody?.toolConfig?.functionCallingConfig?.mode || '').toUpperCase();
    if (sourceBody?.toolConfig && (functionDeclarations.length > 0 || mode === 'NONE')) {
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

    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing.startsWith('data:')) {
        const data = trailing.slice(5).trim();
        if (data && data !== '[DONE]') {
            const json = safeJsonParse(data);
            if (json) yield json;
        }
    }
}

function isHostedVcptoolsChunk(eventJson) {
    const choices = eventJson?.choices;
    if (!Array.isArray(choices) || choices.length === 0) return false;
    let sawVcptools = false;
    for (const choice of choices) {
        if (!choice || choice.finish_reason != null) return false;
        const delta = choice.delta || choice.message;
        if (!delta || typeof delta !== 'object') return false;
        if (typeof delta.content === 'string' && delta.content.length > 0) return false;
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) return false;
        if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) return false;
        if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length === 0) return false;
        if (!delta.tool_calls.every(tc => tc?.function?.name === 'vcptools')) return false;
        sawVcptools = true;
    }
    return sawVcptools;
}

async function pipeChatStreamFilteringHostedVcptools(res, readableStream) {
    const decoder = new TextDecoder('utf-8');
    const MAX_EVENT_BUFFER_BYTES = 8 * 1024 * 1024;
    let buffer = '';
    let eventLines = [];

    const flushEventBlock = (includeTrailingBlank) => {
        if (res.destroyed || res.writableEnded) {
            eventLines = [];
            return;
        }
        if (eventLines.length === 0) {
            if (includeTrailingBlank) res.write('\n');
            return;
        }

        const dataParts = [];
        for (const l of eventLines) {
            const trimmed = l.trim();
            if (trimmed.startsWith('data:')) {
                dataParts.push(trimmed.slice(5).trimStart());
            }
        }
        const joinedData = dataParts.join('\n').trim();
        if (joinedData && joinedData !== '[DONE]') {
            const parsed = safeJsonParse(joinedData);
            if (parsed && isHostedVcptoolsChunk(parsed)) {
                eventLines = [];
                if (parsed.usage && typeof parsed.usage === 'object') {
                    const usageOnly = {
                        ...parsed,
                        choices: (parsed.choices || []).map(c => ({
                            ...c,
                            ...(c.delta ? { delta: {} } : {}),
                            ...(c.message ? { message: { role: 'assistant', content: '' } } : {})
                        }))
                    };
                    res.write(`data: ${JSON.stringify(usageOnly)}\n${includeTrailingBlank ? '\n' : ''}`);
                }
                return;
            }
        }

        const out = eventLines.join('\n') + '\n' + (includeTrailingBlank ? '\n' : '');
        eventLines = [];
        res.write(out);
    };

    for await (const chunk of readableStream) {
        if (res.destroyed || res.writableEnded) break;
        buffer += decoder.decode(chunk, { stream: true });

        if (buffer.length > MAX_EVENT_BUFFER_BYTES && buffer.indexOf('\n') === -1) {
            if (!res.destroyed && !res.writableEnded) res.write(buffer);
            buffer = '';
            continue;
        }

        while (true) {
            const idx = buffer.indexOf('\n');
            if (idx === -1) break;
            const line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            if (line === '') {
                flushEventBlock(true);
            } else {
                eventLines.push(line);
                if (eventLines.length > 4096) flushEventBlock(false);
            }
        }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
        const tailLine = buffer.replace(/\r$/, '');
        if (tailLine === '') {
            flushEventBlock(true);
        } else {
            eventLines.push(tailLine);
            flushEventBlock(false);
        }
    } else if (eventLines.length > 0) {
        flushEventBlock(false);
    }
}

function extractEncryptedReasoningFromMessage(message) {
    if (!message || typeof message !== 'object') return '';
    if (typeof message.encrypted_content === 'string' && message.encrypted_content) {
        return message.encrypted_content;
    }
    if (Array.isArray(message.reasoning_details)) {
        for (const entry of message.reasoning_details) {
            if (entry?.type === 'reasoning.encrypted_content' && typeof entry.data === 'string' && entry.data) {
                return entry.data;
            }
        }
    }
    return '';
}

function buildResponsesOutput(raw, apiType, fallbackModel) {
    const text = extractTextFromProtocolResponse(raw, apiType);
    const responsePayload = buildBaseResponsesEnvelope(raw?.model || fallbackModel);
    responsePayload.status = 'completed';
    responsePayload.usage = buildResponsesUsage(extractUsageFromProtocolResponse(raw, apiType));
    responsePayload.output_text = text;

    if (apiType !== 'chat') {
        responsePayload.output[0].content[0].text = text;
        return responsePayload;
    }

    const message = raw?.choices?.[0]?.message || {};
    const reasoningText = typeof message.reasoning_content === 'string'
        ? message.reasoning_content
        : (typeof message.reasoning === 'string' ? message.reasoning : '');
    const encryptedContent = extractEncryptedReasoningFromMessage(message);
    const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
        ? message.tool_calls
        : (message.function_call ? [{ id: message.function_call.id, function: message.function_call }] : []);
    const output = [];

    if (reasoningText || encryptedContent) {
        output.push({
            id: `rs_${Date.now()}_0`,
            type: 'reasoning',
            status: 'completed',
            summary: reasoningText ? [{ type: 'summary_text', text: reasoningText }] : [],
            ...(encryptedContent ? { encrypted_content: encryptedContent } : {})
        });
    }
    if (text) {
        output.push({
            id: `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }]
        });
    }
    toolCalls.forEach((tc, index) => {
        const fn = tc?.function || {};
        const callId = tc?.id || `call_${Date.now()}_${index}`;
        const rawArgs = fn.arguments ?? tc?.arguments ?? '';
        output.push({
            id: `fc_${callId}`,
            type: 'function_call',
            status: 'completed',
            call_id: callId,
            name: fn.name || tc?.name || '',
            arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)
        });
    });
    if (output.length === 0) {
        output.push({
            id: `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '', annotations: [] }]
        });
    }
    responsePayload.output = output;
    return responsePayload;
}

async function sendResponsesStreamFromProtocol(res, upstreamResponse, { model, apiType, filterHostedVcptools = false }) {
    res.status(upstreamResponse.status);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const responsePayload = buildBaseResponsesEnvelope(model);
    responsePayload.output = [];
    const responseId = responsePayload.id;
    let finalUsage = null;
    let textItem = null;
    let reasoningItem = null;
    let reasoningText = '';
    let reasoningEncrypted = '';
    const functionCalls = new Map();

    const ensureTextItem = () => {
        if (textItem) return textItem;
        textItem = {
            id: `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '', annotations: [] }]
        };
        responsePayload.output.push(textItem);
        const outputIndex = responsePayload.output.length - 1;
        writeResponsesSseEvent(res, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: outputIndex,
            item: { id: textItem.id, type: 'message', role: 'assistant', content: [] }
        });
        writeResponsesSseEvent(res, 'response.content_part.added', {
            type: 'response.content_part.added',
            item_id: textItem.id,
            output_index: outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '' }
        });
        return textItem;
    };

    const ensureReasoningItem = () => {
        if (reasoningItem) return reasoningItem;
        reasoningItem = {
            id: `rs_${Date.now()}_${responsePayload.output.length}`,
            type: 'reasoning',
            status: 'in_progress',
            summary: [{ type: 'summary_text', text: '' }]
        };
        responsePayload.output.push(reasoningItem);
        const outputIndex = responsePayload.output.length - 1;
        writeResponsesSseEvent(res, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: outputIndex,
            item: { ...reasoningItem, summary: [] }
        });
        writeResponsesSseEvent(res, 'response.reasoning_summary_part.added', {
            type: 'response.reasoning_summary_part.added',
            item_id: reasoningItem.id,
            output_index: outputIndex,
            summary_index: 0,
            part: { type: 'summary_text', text: '' }
        });
        return reasoningItem;
    };

    const ensureFunctionCall = (index, callDelta) => {
        let state = functionCalls.get(index);
        const fn = callDelta?.function || {};
        const callId = callDelta?.id || state?.callId || `call_${responseId}_${index}`;
        if (!state) {
            const item = {
                id: `fc_${callId}`,
                type: 'function_call',
                status: 'in_progress',
                call_id: callId,
                name: fn.name || callDelta?.name || '',
                arguments: ''
            };
            state = { index, item, callId, arguments: '' };
            functionCalls.set(index, state);
            responsePayload.output.push(item);
            writeResponsesSseEvent(res, 'response.output_item.added', {
                type: 'response.output_item.added',
                output_index: responsePayload.output.length - 1,
                item: { ...item }
            });
        }
        if (fn.name || callDelta?.name) {
            state.item.name = fn.name || callDelta.name;
        }
        return state;
    };

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

    try {
        for await (const eventJson of iterateUpstreamSseJson(upstreamResponse.body)) {
            if (eventJson?.error) {
                const errMsg = typeof eventJson.error === 'string'
                    ? eventJson.error
                    : (eventJson.error.message || JSON.stringify(eventJson.error));
                throw new Error(errMsg);
            }

            if (filterHostedVcptools && isHostedVcptoolsChunk(eventJson)) {
                const u = extractStreamUsageByProtocol(eventJson, apiType);
                if (u) finalUsage = u;
                continue;
            }

            if (apiType === 'chat') {
                const choice = eventJson?.choices?.[0];
                const encChunk = extractEncryptedReasoningFromMessage(choice?.delta)
                    || extractEncryptedReasoningFromMessage(choice?.message)
                    || extractEncryptedReasoningFromMessage(eventJson);
                if (encChunk && !reasoningEncrypted) {
                    reasoningEncrypted = encChunk;
                    ensureReasoningItem();
                }

                const rDelta = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
                if (typeof rDelta === 'string' && rDelta.length > 0) {
                    const item = ensureReasoningItem();
                    reasoningText += rDelta;
                    item.summary[0].text = reasoningText;
                    writeResponsesSseEvent(res, 'response.reasoning_summary_text.delta', {
                        type: 'response.reasoning_summary_text.delta',
                        item_id: item.id,
                        output_index: responsePayload.output.indexOf(item),
                        summary_index: 0,
                        delta: rDelta
                    });
                }

                const deltaTcList = choice?.delta?.tool_calls;
                const msgTcList = !deltaTcList && Array.isArray(choice?.message?.tool_calls)
                    ? choice.message.tool_calls
                    : null;
                const tcList = deltaTcList || msgTcList;
                if (Array.isArray(tcList) && tcList.length > 0) {
                    for (const [pos, tc] of tcList.entries()) {
                        const index = Number.isInteger(tc?.index) ? tc.index : pos;
                        const state = ensureFunctionCall(index, tc);
                        const fn = tc?.function || {};
                        const argDelta = typeof fn.arguments === 'string'
                            ? fn.arguments
                            : (typeof tc?.arguments === 'string' ? tc.arguments : '');
                        if (argDelta) {
                            if (msgTcList && state.arguments.length > 0) continue;
                            state.arguments += argDelta;
                            state.item.arguments = state.arguments;
                            writeResponsesSseEvent(res, 'response.function_call_arguments.delta', {
                                type: 'response.function_call_arguments.delta',
                                item_id: state.item.id,
                                output_index: responsePayload.output.indexOf(state.item),
                                delta: argDelta
                            });
                        }
                    }
                }
            }

            const delta = extractStreamDeltaByProtocol(eventJson, apiType);
            if (typeof delta === 'string' && delta.length > 0) {
                const item = ensureTextItem();
                responsePayload.output_text += delta;
                item.content[0].text = responsePayload.output_text;
                writeResponsesSseEvent(res, 'response.output_text.delta', {
                    type: 'response.output_text.delta',
                    item_id: item.id,
                    output_index: responsePayload.output.indexOf(item),
                    content_index: 0,
                    delta
                });
            }

            const usage = extractStreamUsageByProtocol(eventJson, apiType);
            if (usage) finalUsage = usage;
            if (eventJson?.model) responsePayload.model = eventJson.model;
        }

        if (responsePayload.output.length === 0) ensureTextItem();

        for (const item of responsePayload.output) {
            const outputIndex = responsePayload.output.indexOf(item);
            if (item === reasoningItem) {
                item.summary[0].text = reasoningText;
                if (reasoningEncrypted) item.encrypted_content = reasoningEncrypted;
                item.status = 'completed';
                writeResponsesSseEvent(res, 'response.reasoning_summary_text.done', {
                    type: 'response.reasoning_summary_text.done',
                    item_id: item.id,
                    output_index: outputIndex,
                    summary_index: 0,
                    text: reasoningText
                });
                writeResponsesSseEvent(res, 'response.reasoning_summary_part.done', {
                    type: 'response.reasoning_summary_part.done',
                    item_id: item.id,
                    output_index: outputIndex,
                    summary_index: 0,
                    part: { type: 'summary_text', text: reasoningText }
                });
            } else if (item === textItem) {
                item.content[0].text = responsePayload.output_text;
                writeResponsesSseEvent(res, 'response.output_text.done', {
                    type: 'response.output_text.done',
                    item_id: item.id,
                    output_index: outputIndex,
                    content_index: 0,
                    text: responsePayload.output_text
                });
                writeResponsesSseEvent(res, 'response.content_part.done', {
                    type: 'response.content_part.done',
                    item_id: item.id,
                    output_index: outputIndex,
                    content_index: 0,
                    part: { type: 'output_text', text: responsePayload.output_text }
                });
            } else {
                const state = Array.from(functionCalls.values()).find(c => c.item === item);
                if (state) {
                    state.item.arguments = state.arguments;
                    state.item.status = 'completed';
                    writeResponsesSseEvent(res, 'response.function_call_arguments.done', {
                        type: 'response.function_call_arguments.done',
                        item_id: state.item.id,
                        output_index: outputIndex,
                        arguments: state.arguments
                    });
                }
            }
            writeResponsesSseEvent(res, 'response.output_item.done', {
                type: 'response.output_item.done',
                output_index: outputIndex,
                item
            });
        }

        responsePayload.status = 'completed';
        if (finalUsage) responsePayload.usage = buildResponsesUsage(finalUsage);

        writeResponsesSseEvent(res, 'response.completed', {
            type: 'response.completed',
            response: responsePayload
        });
    } catch (error) {
        if (textItem) textItem.content[0].text = responsePayload.output_text;
        for (const state of functionCalls.values()) {
            state.item.arguments = state.arguments;
            state.item.status = 'incomplete';
        }
        responsePayload.status = 'failed';
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
// Profile 缓存管理
// ============================================================

function loadAllProfiles() {
    profilesCache.clear();
    try {
        const profiles = listProfiles();
        for (const p of profiles) {
            profilesCache.set(p.name, p);
        }
        if (runtimeConfig.debugMode) {
            console.log(`[VCPBridgeServer] Profiles cache reloaded: ${profilesCache.size} profiles.`);
        }
    } catch (error) {
        console.error('[VCPBridgeServer] Failed to load profiles:', error.message);
    }
}

function readProfileCached(name) {
    if (!name) return null;
    const cleaned = String(name).trim().toLowerCase();
    if (profilesCache.has(cleaned)) return profilesCache.get(cleaned);
    const profile = readProfile(cleaned);
    if (profile) profilesCache.set(cleaned, profile);
    return profile;
}

/**
 * 解析当前请求应该使用的 Profile 配置
 * 优先级：URL path > HTTP header > model name prefix > defaultProfile > null
 */
function resolveProfileForRequest(req, model) {
    if (req.bridgeProfile) {
        const profile = readProfileCached(req.bridgeProfile);
        if (profile) return profile;
    }

    const headerProfile = req.headers['x-bridge-profile'];
    if (headerProfile) {
        const profile = readProfileCached(headerProfile);
        if (profile) return profile;
    }

    if (model && model.includes('/')) {
        const slashIdx = model.indexOf('/');
        const maybeProfile = model.slice(0, slashIdx);
        const cachedProfile = readProfileCached(maybeProfile);
        if (cachedProfile) {
            return { ...cachedProfile, _extractedModel: model.slice(slashIdx + 1) };
        }
    }

    if (runtimeConfig.defaultProfile) {
        const profile = readProfileCached(runtimeConfig.defaultProfile);
        if (profile) return profile;
    }

    return null;
}

// ============================================================
// System Prompt 劫持逻辑（带参数版本）
// ============================================================

function applySystemPromptHijackWithConfig(messages, systemPrompt, hijackMode) {
    if (!systemPrompt || hijackMode === 'off') {
        return messages;
    }

    const result = [...messages];
    const injected = { role: 'system', content: systemPrompt };

    switch (hijackMode) {
        case 'replace':
            const nonSystem = result.filter(m => m.role !== 'system');
            return [injected, ...nonSystem];

        case 'prepend':
            return [injected, ...result];

        case 'append': {
            const lastSystemIdx = result.reduce((acc, m, i) => m.role === 'system' ? i : acc, -1);
            if (lastSystemIdx >= 0) {
                result.splice(lastSystemIdx + 1, 0, injected);
            } else {
                result.unshift(injected);
            }
            return result;
        }

        case 'merge': {
            const systemContents = [
                injected.content,
                ...result
                    .filter(m => m.role === 'system')
                    .map(m => normalizeTextContent(m.content))
                    .filter(content => typeof content === 'string' && content.trim())
            ];
            const mergedSystem = { role: 'system', content: systemContents.join('\n\n') };
            const nonSys = result.filter(m => m.role !== 'system');
            return [mergedSystem, ...nonSys];
        }

        default:
            return result;
    }
}

// ============================================================
// System Prompt 劫持逻辑
// ============================================================

function applySystemPromptHijack(messages) {
    return applySystemPromptHijackWithConfig(messages, runtimeConfig.systemPrompt, runtimeConfig.hijackMode);
}

// ============================================================
// 消息提取（各协议 → 统一 messages 数组）
// ============================================================

function normalizeTextContent(content, geminiParts = false) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(item => {
            if (typeof item === 'string') return item;
            if (geminiParts && item?.type === undefined && item?.thought !== true && typeof item?.text === 'string') return item.text;
            if (item?.type === 'text' && typeof item.text === 'string') return item.text;
            if (item?.type === 'input_text' && typeof item.text === 'string') return item.text;
            if (item?.type === 'output_text' && typeof item.text === 'string') return item.text;
            return '';
        }).filter(Boolean).join('\n');
    }
    return '';
}

function resolveImageUrlField(imageField, fallbackDetail) {
    if (typeof imageField === 'string' && imageField.trim()) {
        return { url: imageField.trim(), ...(fallbackDetail ? { detail: fallbackDetail } : {}) };
    }
    if (imageField && typeof imageField === 'object' && typeof imageField.url === 'string' && imageField.url.trim()) {
        const detail = imageField.detail || fallbackDetail;
        return { url: imageField.url.trim(), ...(detail ? { detail } : {}) };
    }
    return null;
}

function normalizeResponsesOutputValue(output) {
    if (typeof output === 'string') return output;
    if (!Array.isArray(output) || !output.some(part => part?.type === 'input_image' || part?.type === 'image_url')) {
        return output === undefined ? '' : JSON.stringify(output);
    }
    const parts = [];
    for (const part of output) {
        if (part?.type === 'input_image' || part?.type === 'image_url') {
            const img = resolveImageUrlField(part.image_url ?? part.url, part.detail);
            if (img) parts.push({ type: 'image_url', image_url: img });
            continue;
        }
        parts.push({
            type: 'text',
            text: (part?.type === 'input_text' || part?.type === 'text') && typeof part.text === 'string'
                ? part.text
                : JSON.stringify(part)
        });
    }
    return parts;
}

function normalizeResponsesMessageContent(rawContent) {
    if (typeof rawContent === 'string') return rawContent;
    if (!Array.isArray(rawContent)) return '';
    const hasImage = rawContent.some(part => part?.type === 'input_image' || part?.type === 'image_url');
    if (!hasImage) return normalizeTextContent(rawContent);

    const multimodal = [];
    for (const part of rawContent) {
        if (!part) continue;
        if (typeof part === 'string') {
            multimodal.push({ type: 'text', text: part });
            continue;
        }
        if (part.type === 'input_image' || part.type === 'image_url') {
            const img = resolveImageUrlField(part.image_url ?? part.url, part.detail);
            if (img) multimodal.push({ type: 'image_url', image_url: img });
            continue;
        }
        if ((part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
            multimodal.push({ type: 'text', text: part.text });
        }
    }
    return multimodal.length > 0 ? multimodal : '';
}

function extractFromResponsesInput(input, instructions) {
    const messages = [];
    if (typeof instructions === 'string' && instructions.trim().length > 0) {
        messages.push({ role: 'system', content: instructions });
    }
    if (typeof input === 'string') {
        messages.push({ role: 'user', content: input });
        return messages;
    }
    if (!Array.isArray(input)) return messages;

    let pendingCalls = [];
    let pendingReasoning = [];

    const flushReasoning = () => {
        if (!pendingReasoning.length) return;
        const text = pendingReasoning
            .map(item => (Array.isArray(item.summary) ? item.summary.map(s => s?.text || '').join('') : (item.text || '')))
            .filter(Boolean)
            .join('\n');
        const encrypted = pendingReasoning
            .map(item => item.encrypted_content)
            .filter(enc => typeof enc === 'string' && enc.length > 0);
        const msg = { role: 'assistant', content: null };
        if (text) msg.reasoning_content = text;
        if (encrypted.length > 0) {
            msg.reasoning_details = encrypted.map(data => ({ type: 'reasoning.encrypted_content', data }));
        }
        messages.push(msg);
        pendingReasoning = [];
    };

    const flushCalls = () => {
        if (!pendingCalls.length) return;
        const text = pendingReasoning
            .map(item => (Array.isArray(item.summary) ? item.summary.map(s => s?.text || '').join('') : (item.text || '')))
            .filter(Boolean)
            .join('\n');
        const encrypted = pendingReasoning
            .map(item => item.encrypted_content)
            .filter(enc => typeof enc === 'string' && enc.length > 0);
        messages.push({
            role: 'assistant',
            content: null,
            ...(text ? { reasoning_content: text } : {}),
            ...(encrypted.length > 0
                ? { reasoning_details: encrypted.map(data => ({ type: 'reasoning.encrypted_content', data })) }
                : {}),
            tool_calls: pendingCalls
        });
        pendingCalls = [];
        pendingReasoning = [];
    };

    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'reasoning') {
            pendingReasoning.push(item);
            continue;
        }
        if (item.type === 'function_call') {
            const callId = item.call_id || item.id || `call_${Date.now()}_${pendingCalls.length}`;
            const rawArgs = item.arguments;
            pendingCalls.push({
                id: callId,
                type: 'function',
                function: {
                    name: item.name || '',
                    arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? '')
                }
            });
            continue;
        }
        if (item.type === 'function_call_output') {
            flushCalls();
            flushReasoning();
            const callId = item.call_id || item.id;
            messages.push({
                role: 'tool',
                ...(callId ? { tool_call_id: callId } : {}),
                content: normalizeResponsesOutputValue(item.output)
            });
            continue;
        }
        flushCalls();
        flushReasoning();
        let role = item.role || (item.type === 'message' ? 'user' : null);
        if (role === 'developer') role = 'system';
        const content = role === 'system'
            ? normalizeTextContent(item.content || item.output)
            : normalizeResponsesMessageContent(item.content || item.output);
        const hasContent = typeof content === 'string' ? content.length > 0 : Array.isArray(content) && content.length > 0;
        if (role && hasContent) messages.push({ role, content });
    }

    flushCalls();
    flushReasoning();
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
            const text = normalizeTextContent(c.parts, true);
            if (text) messages.push({ role, content: text });
        }
    }
    return messages;
}

// ============================================================
// 上游请求构建（统一 messages → 目标协议格式）
// ============================================================

function formatFlattenedToolCalls(calls) {
    const labels = calls.map(tc => {
        const name = tc?.function?.name || tc?.name || 'tool';
        const args = tc?.function?.arguments ?? tc?.arguments ?? '';
        const preview = typeof args === 'string' ? args : JSON.stringify(args);
        return `${name}(${preview.slice(0, 200)})`;
    });
    return `[已执行工具调用: ${labels.join('; ')}]`;
}

function sanitizeMessagesForUpstream(messages, { stripClientTools = false, flattenToolMessages = false } = {}) {
    if (!Array.isArray(messages)) return [];
    const shouldFlatten = Boolean(stripClientTools || flattenToolMessages);
    const sanitized = [];

    const extractToolReplyUserContent = (rawContent, prefix) => {
        if (Array.isArray(rawContent) && rawContent.some(p => p?.type === 'image_url')) {
            const images = rawContent.filter(p => p?.type === 'image_url');
            const text = normalizeTextContent(rawContent);
            return [
                { type: 'text', text: `${prefix}: ${text || '[含图片回执]'}` },
                ...images
            ];
        }
        const text = typeof rawContent === 'string' ? rawContent : normalizeTextContent(rawContent);
        return `${prefix}: ${text || '[空输出]'}`;
    };

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || typeof msg !== 'object') continue;

        const hasToolCalls = msg.role === 'assistant' && (
            (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) || Boolean(msg.function_call)
        );

        if (shouldFlatten) {
            if (hasToolCalls) {
                const calls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
                    ? msg.tool_calls
                    : [{ function: msg.function_call }];
                const text = typeof msg.content === 'string' ? msg.content : normalizeTextContent(msg.content);
                const callNote = formatFlattenedToolCalls(calls);
                const clone = { ...msg };
                delete clone.tool_calls;
                delete clone.function_call;
                sanitized.push({
                    ...clone,
                    role: 'assistant',
                    content: text ? `${text}\n${callNote}` : callNote
                });
                continue;
            }
            if (msg.role === 'tool' || msg.role === 'function') {
                sanitized.push({
                    role: 'user',
                    content: extractToolReplyUserContent(msg.content, '[工具返回摘要]')
                });
                continue;
            }
            sanitized.push(msg);
            continue;
        }

        if (hasToolCalls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            const expectedIds = msg.tool_calls.map(tc => tc?.id).filter(id => typeof id === 'string' && id.length > 0);
            const expectedSet = new Set(expectedIds);
            if (expectedIds.length !== msg.tool_calls.length || expectedSet.size !== msg.tool_calls.length) {
                const text = typeof msg.content === 'string' ? msg.content : normalizeTextContent(msg.content);
                const callNote = formatFlattenedToolCalls(msg.tool_calls);
                const clone = { ...msg };
                delete clone.tool_calls;
                delete clone.function_call;
                sanitized.push({ ...clone, role: 'assistant', content: text ? `${text}\n${callNote}` : callNote });
                continue;
            }

            const matchedTools = new Map();
            const deferredOrphans = [];
            let j = i + 1;
            while (j < messages.length && messages[j]?.role === 'tool') {
                const reply = messages[j];
                if (reply.tool_call_id && expectedSet.has(reply.tool_call_id) && !matchedTools.has(reply.tool_call_id)) {
                    matchedTools.set(reply.tool_call_id, reply);
                } else {
                    deferredOrphans.push({
                        role: 'user',
                        content: extractToolReplyUserContent(reply.content, '[孤立工具输出]')
                    });
                }
                j++;
            }

            sanitized.push(msg);
            for (const id of expectedIds) {
                if (matchedTools.has(id)) {
                    sanitized.push(matchedTools.get(id));
                } else {
                    sanitized.push({
                        role: 'tool',
                        tool_call_id: id,
                        content: '[工具调用未返回结果（已被中断或省略）]'
                    });
                }
            }
            if (deferredOrphans.length > 0) sanitized.push(...deferredOrphans);
            i = j - 1;
            continue;
        }

        if (msg.role === 'tool' || msg.role === 'function') {
            sanitized.push({
                role: 'user',
                content: extractToolReplyUserContent(msg.content, '[孤立工具输出]')
            });
            continue;
        }

        sanitized.push(msg);
    }

    return sanitized;
}

function buildUpstreamChatBody(messages, model, body, toolOptions) {
    const resolvedMaxTokens = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
    const result = {
        model: resolveModel(model),
        messages,
        stream: body.stream === true,
        ...(body.temperature !== undefined && { temperature: body.temperature }),
        ...(body.top_p !== undefined && { top_p: body.top_p }),
        ...(resolvedMaxTokens !== undefined && { max_tokens: resolvedMaxTokens })
    };
    return attachProtectedChatToolFields(result, body, toolOptions);
}

function buildUpstreamAnthropicBody(messages, model, body, toolOptions) {
    const system = messages
        .filter(m => m.role === 'system')
        .map(m => normalizeTextContent(m.content))
        .filter(Boolean)
        .join('\n\n');
    const nonSystem = messages
        .filter(m => m.role !== 'system')
        .map(m => {
            const text = typeof m.content === 'string' ? m.content : normalizeTextContent(m.content);
            return text ? { role: m.role === 'assistant' ? 'assistant' : 'user', content: text } : null;
        })
        .filter(Boolean);
    const result = {
        model: resolveModel(model),
        messages: nonSystem,
        max_tokens: body.max_tokens || body.max_completion_tokens || body.max_output_tokens || 4096,
        stream: body.stream === true
    };
    if (system) result.system = system;
    if (body.temperature !== undefined) result.temperature = body.temperature;
    return attachProtectedAnthropicToolFields(result, body, toolOptions);
}

function buildUpstreamGeminiBody(messages, model, body, toolOptions) {
    const system = messages
        .filter(m => m.role === 'system')
        .map(m => normalizeTextContent(m.content))
        .filter(Boolean)
        .join('\n\n');
    const contents = messages
        .filter(m => m.role !== 'system')
        .map(m => {
            const text = typeof m.content === 'string' ? m.content : normalizeTextContent(m.content);
            return text ? { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] } : null;
        })
        .filter(Boolean);
    const result = { contents };
    if (system) result.systemInstruction = { parts: [{ text: system }] };
    const genConfig = {};
    if (body.temperature !== undefined) genConfig.temperature = body.temperature;
    if (body.top_p !== undefined) genConfig.topP = body.top_p;
    const resolvedMaxTokens = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
    if (resolvedMaxTokens !== undefined) {
        genConfig.maxOutputTokens = resolvedMaxTokens;
    }
    if (Object.keys(genConfig).length > 0) result.generationConfig = genConfig;
    return attachProtectedGeminiToolFields(result, body, toolOptions);
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
    // 0. 解析 Profile（请求级动态切换）
    if (runtimeConfig.debugMode) {
        console.log(`[VCPBridgeServer] Incoming: path=${req.path} | rawModel=${model} | headerProfile=${req.headers['x-bridge-profile']}`);
    }
    const profileConfig = resolveProfileForRequest(req, model);
    if (runtimeConfig.debugMode) {
        console.log(`[VCPBridgeServer] Matched profile: ${profileConfig ? profileConfig.name : 'NONE (fallback to global)'}`);
    }

    // 如果 profile 通过 model 前缀提取了真实 model，使用它
    const effectiveModel = profileConfig?._extractedModel || model;

    // 1. 应用 system prompt 劫持（使用 profile 配置或全局兜底）
    let hijackedMessages;
    if (profileConfig && profileConfig.systemPrompt) {
        const resolvedPrompt = resolveSystemPrompt(profileConfig.systemPrompt);
        const resolvedMode = profileConfig.hijackMode || runtimeConfig.hijackMode;
        hijackedMessages = applySystemPromptHijackWithConfig(messages, resolvedPrompt, resolvedMode);
        if (runtimeConfig.debugMode) {
            console.log(`[VCPBridgeServer] Using profile "${profileConfig.name}" | mode=${resolvedMode} | prompt=${profileConfig.systemPrompt.substring(0, 40)}...`);
        }
    } else {
        hijackedMessages = applySystemPromptHijack(messages);
    }

    // 如果 profile 有 modelOverride，优先使用
    const finalModel = profileConfig?.modelOverride || effectiveModel;

    // 2. 解析上游端点
    const stream = body.stream === true;
    const endpoint = resolveUpstreamEndpoint(finalModel, stream);

    // 3. 构建上游请求体（支持 Header > Profile > Global 三级正交三态解析）
    const profileStripResolved = resolveTriState(profileConfig?.stripClientTools, runtimeConfig.stripClientTools);
    const stripClientTools = resolveTriState(req.headers['x-vcp-strip-tools'], profileStripResolved);

    const profileFilterResolved = resolveTriState(profileConfig?.filterHostedVcptools, runtimeConfig.filterHostedVcptools);
    const allowFilterHosted = resolveTriState(req.headers['x-vcp-filter-hosted-vcptools'], profileFilterResolved);

    const sanitizedMessages = sanitizeMessagesForUpstream(hijackedMessages, {
        stripClientTools,
        flattenToolMessages: endpoint.type !== 'chat'
    });
    const toolOptions = { stripClientTools };
    let upstreamBody;
    switch (endpoint.type) {
        case 'anthropic':
            upstreamBody = buildUpstreamAnthropicBody(sanitizedMessages, finalModel, body, toolOptions);
            break;
        case 'gemini':
            upstreamBody = buildUpstreamGeminiBody(sanitizedMessages, finalModel, body, toolOptions);
            break;
        default:
            upstreamBody = buildUpstreamChatBody(sanitizedMessages, finalModel, body, toolOptions);
    }

    const filterHostedVcptools = allowFilterHosted
        && endpoint.type === 'chat'
        && (!Array.isArray(upstreamBody?.tools) || upstreamBody.tools.length === 0);

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
        console.log(`[VCPBridgeServer] ${downstreamFormat} → ${endpoint.type} | ${endpoint.url} | hijack=${runtimeConfig.hijackMode} | stripTools=${stripClientTools} | filterHosted=${filterHostedVcptools}`);
    }

    // 5. 发送请求（绑定客户端断连级联取消，防孤儿上游长流）
    const abortController = new AbortController();
    const onDownstreamAbort = () => {
        if (!res.writableEnded) abortController.abort();
    };
    req.once('aborted', onDownstreamAbort);
    res.once('close', onDownstreamAbort);

    let upstreamResponse;
    try {
        upstreamResponse = await fetch(endpoint.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(upstreamBody),
            signal: abortController.signal
        });
    } catch (err) {
        req.off('aborted', onDownstreamAbort);
        res.off('close', onDownstreamAbort);
        if (err?.name === 'AbortError' || res.destroyed || res.writableEnded) {
            if (!res.destroyed && !res.writableEnded) res.end();
            return;
        }
        return res.status(502).json({ error: { message: `Upstream fetch failed: ${err.message}`, type: 'upstream_error' } });
    }

    try {
        // 6. Responses API 下游必须返回 Responses 格式；非 2xx 错误直透 JSON 错误响应，防止伪装成空 200 completed。
        if (downstreamFormat === 'responses') {
            if (!upstreamResponse.ok) {
                const rawErr = await upstreamResponse.text();
                const parsedErr = safeJsonParse(rawErr);
                return res.status(upstreamResponse.status).type('application/json').send(parsedErr || rawErr);
            }
            const fallbackModel = resolveModel(finalModel);
            if (stream && upstreamResponse.body) {
                return await sendResponsesStreamFromProtocol(res, upstreamResponse, {
                    model: fallbackModel,
                    apiType: endpoint.type,
                    filterHostedVcptools
                });
            }
            return await sendResponsesJsonFromProtocol(res, upstreamResponse, {
                model: fallbackModel,
                apiType: endpoint.type
            });
        }

        // 7. 其他协议透传响应（若由 6005 托管 vcptools，则剥离仅给 VChat 展示用的 vcptools delta 帧防误伤外部 IDE）
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

        if (stream && filterHostedVcptools && downstreamFormat === 'chat') {
            await pipeChatStreamFilteringHostedVcptools(res, upstreamResponse.body);
        } else {
            for await (const chunk of upstreamResponse.body) {
                if (res.destroyed || res.writableEnded) break;
                res.write(chunk);
            }
        }
        if (!res.destroyed && !res.writableEnded) res.end();
    } catch (err) {
        if (err?.name !== 'AbortError' && !res.headersSent) {
            return res.status(502).json({ error: { message: `Bridge stream failed: ${err.message}`, type: 'upstream_error' } });
        }
        if (!res.destroyed && !res.writableEnded) res.end();
    } finally {
        req.off('aborted', onDownstreamAbort);
        res.off('close', onDownstreamAbort);
    }
}

// ============================================================
// Express 路由
// ============================================================

function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createBridgeApp() {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    // 健康检查
    app.get('/health', (req, res) => {
        res.json({
            ok: true,
            hijackMode: runtimeConfig.hijackMode,
            defaultProfile: runtimeConfig.defaultProfile || '',
            stripClientTools: Boolean(runtimeConfig.stripClientTools),
            filterHostedVcptools: runtimeConfig.filterHostedVcptools !== false,
            hasSystemPrompt: Boolean(runtimeConfig.systemPrompt),
            upstreamType: runtimeConfig.upstreamType,
            upstreamUrl: runtimeConfig.upstreamUrl,
            modelMap: runtimeConfig.modelMap,
            configPath: runtimeConfig.configPath
        });
    });

    // 模型列表动态透传与探活（支持 OpenAI 根端点与 Profile 前缀端点，上游不可达时平滑回退本地配置）
    app.get(['/v1/models', '/v1/:profile/models'], asyncRoute(async (req, res, next) => {
        const profile = req.params?.profile;
        if (profile && ['chat', 'responses', 'messages', 'beta'].includes(profile)) {
            return next();
        }
        const matchedProfile = profile ? readProfileCached(profile) : resolveProfileForRequest(req, '');
        const localModelIds = new Set([
            matchedProfile?.modelOverride,
            runtimeConfig.defaultModel,
            ...Object.keys(runtimeConfig.modelMap || {}),
            ...Object.values(runtimeConfig.modelMap || {})
        ].filter(Boolean));
        if (localModelIds.size === 0) localModelIds.add('gpt-5.6-sol');

        const buildFallbackList = () => Array.from(localModelIds).map(id => ({
            id,
            object: 'model',
            created: 1700000000,
            owned_by: 'vcp-bridge'
        }));

        const base = String(runtimeConfig.upstreamUrl || '').replace(/\/+$/, '');
        if (base) {
            try {
                const requestToken = extractBearerToken(req.headers.authorization);
                const upstreamKey = runtimeConfig.upstreamKey || requestToken;
                const headers = { Accept: 'application/json' };
                if (upstreamKey) headers.Authorization = `Bearer ${upstreamKey}`;
                const upstreamRes = await fetch(`${base}/v1/models`, {
                    method: 'GET',
                    headers,
                    signal: AbortSignal.timeout(5000)
                });
                if (upstreamRes.ok) {
                    const parsed = safeJsonParse(await upstreamRes.text());
                    if (parsed && Array.isArray(parsed.data)) {
                        const seen = new Set();
                        const merged = [];
                        for (const item of parsed.data) {
                            if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
                            seen.add(item.id);
                            merged.push(item);
                        }
                        for (const localId of localModelIds) {
                            if (!seen.has(localId)) {
                                seen.add(localId);
                                merged.push({ id: localId, object: 'model', created: 1700000000, owned_by: 'vcp-bridge' });
                            }
                        }
                        return res.json({ ...parsed, object: parsed.object || 'list', data: merged });
                    }
                }
            } catch (err) {
                if (runtimeConfig.debugMode) {
                    console.warn(`[VCPBridgeServer] Upstream /v1/models fetch fallback to local list: ${err.message}`);
                }
            }
        }

        res.json({ object: 'list', data: buildFallbackList() });
    }));

    // ─── Profile-prefixed routes ─────────────────────────────────────────
    // URL pattern: /v1/:profile/chat/completions, /v1/:profile/responses, etc.
    // These must be registered BEFORE the standard routes to take priority.

    app.post('/v1/:profile/chat/completions', asyncRoute(async (req, res, next) => {
        const profile = req.params.profile;
        if (['chat', 'responses', 'messages', 'beta'].includes(profile)) {
            return next();
        }
        req.bridgeProfile = profile;
        const body = req.body || {};
        const messages = Array.isArray(body.messages) ? body.messages : [];
        await proxyRequest(req, res, { messages, model: body.model, body, downstreamFormat: 'chat' });
    }));

    app.post('/v1/:profile/responses', asyncRoute(async (req, res, next) => {
        const profile = req.params.profile;
        if (['chat', 'responses', 'messages', 'beta'].includes(profile)) {
            return next();
        }
        req.bridgeProfile = profile;
        const body = req.body || {};
        const messages = extractFromResponsesInput(body.input, body.instructions);
        const stream = body.stream === true || String(req.headers.accept || '').includes('text/event-stream');
        await proxyRequest(req, res, { messages, model: body.model, body: { ...body, stream }, downstreamFormat: 'responses' });
    }));

    app.post('/v1/:profile/messages', asyncRoute(async (req, res, next) => {
        const profile = req.params.profile;
        if (['chat', 'responses', 'messages', 'beta'].includes(profile)) {
            return next();
        }
        req.bridgeProfile = profile;
        const body = req.body || {};
        const messages = extractFromAnthropicBody(body);
        const stream = body.stream === true || String(req.headers.accept || '').includes('text/event-stream');
        await proxyRequest(req, res, { messages, model: body.model, body: { ...body, stream }, downstreamFormat: 'anthropic' });
    }));

    // ─── Standard routes (no profile prefix) ─────────────────────────────

    // OpenAI Chat Completions
    app.post('/v1/chat/completions', asyncRoute(async (req, res) => {
        const body = req.body || {};
        const messages = Array.isArray(body.messages) ? body.messages : [];
        await proxyRequest(req, res, { messages, model: body.model, body, downstreamFormat: 'chat' });
    }));

    // OpenAI Responses API
    app.post('/v1/responses', asyncRoute(async (req, res) => {
        const body = req.body || {};
        const messages = extractFromResponsesInput(body.input, body.instructions);
        const stream = body.stream === true || String(req.headers.accept || '').includes('text/event-stream');
        await proxyRequest(req, res, { messages, model: body.model, body: { ...body, stream }, downstreamFormat: 'responses' });
    }));

    // Anthropic Messages
    app.post('/v1/messages', asyncRoute(async (req, res) => {
        const body = req.body || {};
        const messages = extractFromAnthropicBody(body);
        const stream = body.stream === true || String(req.headers.accept || '').includes('text/event-stream');
        await proxyRequest(req, res, { messages, model: body.model, body: { ...body, stream }, downstreamFormat: 'anthropic' });
    }));

    // Gemini GenerateContent
    app.post(/^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/, asyncRoute(async (req, res) => {
        const body = req.body || {};
        const messages = extractFromGeminiBody(body);
        const model = req.params[0] || runtimeConfig.defaultModel;
        const stream = req.params[1] === 'streamGenerateContent';
        await proxyRequest(req, res, { messages, model, body: { ...body, stream }, downstreamFormat: 'gemini' });
    }));

    app.use((err, req, res, next) => {
        void next;
        if (res.headersSent) {
            if (!res.destroyed && !res.writableEnded) res.end();
            return;
        }
        const isClientPayloadError = err?.type === 'entity.parse.failed' || err?.status === 400 || err?.status === 413;
        res.status(err?.status || 500).json({
            error: {
                message: err?.message || 'Bridge internal error',
                type: isClientPayloadError ? 'invalid_request_error' : 'bridge_error'
            }
        });
    });

    return app;
}

function startServer() {
    const app = createBridgeApp();
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

module.exports = {
    initialize,
    shutdown,
    createBridgeApp,
    _test: {
        applyBridgeRuntimeConfig,
        resolveProfileForRequest,
        attachProtectedChatToolFields,
        attachProtectedAnthropicToolFields,
        attachProtectedGeminiToolFields,
        sanitizeMessagesForUpstream,
        isHostedVcptoolsChunk,
        pipeChatStreamFilteringHostedVcptools,
        extractFromResponsesInput,
        buildResponsesOutput,
        sendResponsesStreamFromProtocol,
        applySystemPromptHijackWithConfig,
        applySystemPromptHijack
    }
};