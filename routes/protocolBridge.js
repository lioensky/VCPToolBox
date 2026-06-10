// routes/protocolBridge.js
// 协议桥接路由：将 OpenAI Responses API、Anthropic Messages、Gemini GenerateContent
// 格式的请求转换为标准 v1/chat/completions messages 数组，内部转发到主服务器处理链路。
// 这样所有 VCP 能力（插件、RAG、角色分割等）对所有协议客户端透明可用。

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const DEBUG_MODE = (process.env.DebugMode || 'False').toLowerCase() === 'true';
const RESPONSE_RETRY_SUPPRESSION_WINDOW_MS = parseInt(process.env.PROTOCOL_BRIDGE_RETRY_SUPPRESSION_MS || '15000', 10);
const recentResponsesRequests = new Map();

// ============================================================
// 消息提取工具函数（从各协议格式提取为统一 messages 数组）
// ============================================================

/**
 * 将多模态 content 数组归一化为纯文本字符串
 */
function normalizeTextContent(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map(item => {
                if (typeof item === 'string') return item;
                if (item && typeof item === 'object') {
                    if (item.type === 'text' && typeof item.text === 'string') return item.text;
                    if (item.type === 'input_text' && typeof item.text === 'string') return item.text;
                    if (item.type === 'output_text' && typeof item.text === 'string') return item.text;
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }

    return '';
}

/**
 * 标准化消息角色
 */
function normalizeMessageRole(role) {
    if (!role) return null;
    if (role === 'developer') return 'system';
    if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') return role;
    return 'user';
}

// ============================================================
// 原生工具字段保护/转换（不进入 messages/RAG，只在转发前加回请求体）
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

function attachProtectedToolFields(chatBody, originalBody) {
    const tools = extractProtectedTools(originalBody);
    if (tools.length > 0) {
        chatBody.tools = tools;
    }

    const toolChoice = normalizeToolChoice(originalBody?.tool_choice, originalBody);
    if (toolChoice !== undefined) {
        chatBody.tool_choice = toolChoice;
    }

    if (typeof originalBody?.parallel_tool_calls === 'boolean') {
        chatBody.parallel_tool_calls = originalBody.parallel_tool_calls;
    }

    return chatBody;
}

// ============================================================
// 请求稳定标识（降低客户端重试导致的重复预处理）
// ============================================================

function buildStableRequestId(prefix, payload) {
    const hash = crypto
        .createHash('sha256')
        .update(JSON.stringify(payload || {}))
        .digest('hex')
        .slice(0, 24);
    return `${prefix}_${hash}`;
}

function isSuppressedDuplicateResponsesRequest(requestId) {
    if (!requestId || RESPONSE_RETRY_SUPPRESSION_WINDOW_MS <= 0) return false;

    const now = Date.now();
    for (const [key, value] of recentResponsesRequests.entries()) {
        if (now - value.lastSeenAt > RESPONSE_RETRY_SUPPRESSION_WINDOW_MS * 4) {
            recentResponsesRequests.delete(key);
        }
    }

    const entry = recentResponsesRequests.get(requestId);
    if (entry && now - entry.lastSeenAt <= RESPONSE_RETRY_SUPPRESSION_WINDOW_MS) {
        entry.lastSeenAt = now;
        entry.count += 1;
        return true;
    }

    recentResponsesRequests.set(requestId, { lastSeenAt: now, count: 1 });
    return false;
}

function buildImmediateResponsesPayload(model, text, status = 'completed') {
    const response = buildBaseResponsesEnvelope(model || 'unknown');
    response.status = status;
    response.output_text = text || '';
    response.output[0].content[0].text = response.output_text;
    return response;
}

function sendImmediateResponsesResult(res, { model, text, stream }) {
    const responsePayload = buildImmediateResponsesPayload(model, text, 'completed');
    const item = responsePayload.output[0];
    const part = item.content[0];

    if (!stream) {
        return res.status(200).json(responsePayload);
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const writeEvent = (eventName, data) => {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    writeEvent('response.created', {
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
    writeEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: item.id, type: item.type, role: item.role, content: [] }
    });
    writeEvent('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: part.type, text: '' }
    });
    if (responsePayload.output_text) {
        writeEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: responsePayload.output_text
        });
    }
    writeEvent('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: responsePayload.output_text
    });
    writeEvent('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part
    });
    writeEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item
    });
    writeEvent('response.completed', {
        type: 'response.completed',
        response: responsePayload
    });
    return res.end();
}

// ============================================================
// OpenAI Responses API (/v1/responses) 消息提取
// ============================================================

function extractMessagesFromResponsesInput(input) {
    if (typeof input === 'string') {
        return [{ role: 'user', content: input }];
    }

    if (!Array.isArray(input)) {
        return [];
    }

    const messages = [];

    for (const item of input) {
        if (!item || typeof item !== 'object') continue;

        const role = normalizeMessageRole(item.role || (item.type === 'message' ? 'user' : null));
        const content = normalizeTextContent(item.content || item.output);

        if (role && content) {
            messages.push({ role, content });
            continue;
        }

        if (item.type === 'message' && (Array.isArray(item.content) || Array.isArray(item.output))) {
            const nestedContent = normalizeTextContent(item.content || item.output);
            if (nestedContent) {
                messages.push({
                    role: normalizeMessageRole(item.role || 'user'),
                    content: nestedContent
                });
            }
        }
    }

    return messages;
}

// ============================================================
// Anthropic Messages API (/v1/messages) 消息提取
// ============================================================

function stringifyAnthropicSystem(systemValue) {
    if (!systemValue) return '';
    if (typeof systemValue === 'string') return systemValue;

    if (Array.isArray(systemValue)) {
        return systemValue
            .map(item => {
                if (typeof item === 'string') return item;
                if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
                    return item.text;
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }

    return '';
}

function extractMessagesFromAnthropicBody(body) {
    const messages = [];

    // 提取 system
    const system = stringifyAnthropicSystem(body.system);
    if (system) {
        messages.push({ role: 'system', content: system });
    }

    // 提取 messages
    if (Array.isArray(body.messages)) {
        for (const msg of body.messages) {
            const role = normalizeMessageRole(msg.role);
            const content = normalizeTextContent(msg.content);
            if (role && content) {
                messages.push({ role, content });
            }
        }
    }

    return messages;
}

// ============================================================
// Gemini GenerateContent API 消息提取
// ============================================================

function extractMessagesFromGeminiBody(body) {
    const messages = [];

    // 提取 systemInstruction
    if (body.systemInstruction && typeof body.systemInstruction === 'object') {
        const parts = Array.isArray(body.systemInstruction.parts) ? body.systemInstruction.parts : [];
        const systemText = parts
            .map(part => (part && typeof part.text === 'string' ? part.text : ''))
            .filter(Boolean)
            .join('\n');
        if (systemText) {
            messages.push({ role: 'system', content: systemText });
        }
    }

    // 提取 contents
    if (Array.isArray(body.contents)) {
        for (const content of body.contents) {
            const role = content.role === 'model' ? 'assistant' : normalizeMessageRole(content.role || 'user');
            const text = normalizeTextContent(content.parts);
            if (role && text) {
                messages.push({ role, content: text });
            }
        }
    }

    return messages;
}

// ============================================================
// 响应格式构建工具
// ============================================================

/**
 * 将标准 chat completion 响应转换为 OpenAI Responses API 格式
 */
function buildResponsesApiOutput(chatResponse) {
    const content = chatResponse?.choices?.[0]?.message?.content || '';
    return {
        id: chatResponse?.id || `resp_${Date.now()}`,
        object: 'response',
        created_at: chatResponse?.created || Math.floor(Date.now() / 1000),
        status: 'completed',
        model: chatResponse?.model,
        output: [
            {
                id: `msg_${Date.now()}`,
                type: 'message',
                role: 'assistant',
                content: [
                    {
                        type: 'output_text',
                        text: content,
                        annotations: []
                    }
                ]
            }
        ],
        output_text: content,
        usage: {
            input_tokens: chatResponse?.usage?.prompt_tokens || 0,
            output_tokens: chatResponse?.usage?.completion_tokens || 0,
            total_tokens: chatResponse?.usage?.total_tokens || 0
        }
    };
}

/**
 * 将标准 chat completion 响应转换为 Anthropic Messages API 格式
 */
function buildAnthropicApiOutput(chatResponse) {
    const content = chatResponse?.choices?.[0]?.message?.content || '';
    return {
        id: chatResponse?.id || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: chatResponse?.model,
        content: [
            {
                type: 'text',
                text: content
            }
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: chatResponse?.usage?.prompt_tokens || 0,
            output_tokens: chatResponse?.usage?.completion_tokens || 0
        }
    };
}

/**
 * 将标准 chat completion 响应转换为 Gemini GenerateContent 格式
 */
function buildGeminiApiOutput(chatResponse) {
    const content = chatResponse?.choices?.[0]?.message?.content || '';
    return {
        candidates: [
            {
                content: {
                    role: 'model',
                    parts: [{ text: content }]
                },
                finishReason: 'STOP',
                index: 0
            }
        ],
        usageMetadata: {
            promptTokenCount: chatResponse?.usage?.prompt_tokens || 0,
            candidatesTokenCount: chatResponse?.usage?.completion_tokens || 0,
            totalTokenCount: chatResponse?.usage?.total_tokens || 0
        }
    };
}

// ============================================================
// SSE 流式响应转换
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
        output: [
            {
                id: `msg_${Date.now()}`,
                type: 'message',
                role: 'assistant',
                content: [
                    {
                        type: 'output_text',
                        text: '',
                        annotations: []
                    }
                ]
            }
        ],
        output_text: '',
        usage: buildResponsesUsage(null)
    };
}

/**
 * 将 chat completion SSE 流转换为 Responses API SSE 流。
 * 结构对齐原始 hackserver.js 的 Responses envelope：同一个 responsePayload 持续更新，
 * 最终 response.completed/response.failed 都携带完整 payload，避免 Codex 判定“无终态断流”。
 */
function createResponsesStreamTransformer(res, model) {
    const responsePayload = buildBaseResponsesEnvelope(model);
    const itemId = responsePayload.output[0].id;
    let headersSent = false;
    let terminalEventSent = false;
    let finalUsage = null;

    function writeSseEvent(eventName, data) {
        if (res.destroyed || res.writableEnded) return false;
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        return true;
    }

    function finalizeCompletedPayload(usage) {
        responsePayload.status = 'completed';
        responsePayload.output[0].content[0].text = responsePayload.output_text;
        if (usage) responsePayload.usage = buildResponsesUsage(usage);
        return responsePayload;
    }

    function finalizeFailedPayload(errorMessage) {
        responsePayload.status = 'failed';
        responsePayload.output[0].content[0].text = responsePayload.output_text;
        responsePayload.error = {
            code: 'protocol_bridge_stream_error',
            message: errorMessage || 'Protocol bridge stream ended before completion.'
        };
        return responsePayload;
    }

    return {
        onStart() {
            if (headersSent) return;
            headersSent = true;
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');

            writeSseEvent('response.created', {
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

            writeSseEvent('response.output_item.added', {
                type: 'response.output_item.added',
                output_index: 0,
                item: { id: itemId, type: 'message', role: 'assistant', content: [] }
            });

            writeSseEvent('response.content_part.added', {
                type: 'response.content_part.added',
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: '' }
            });
        },

        onDelta(delta) {
            if (terminalEventSent || res.destroyed || res.writableEnded) return;
            if (!headersSent) this.onStart();
            responsePayload.output_text += delta;
            writeSseEvent('response.output_text.delta', {
                type: 'response.output_text.delta',
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                delta
            });
        },

        onUsage(usage) {
            if (usage) finalUsage = usage;
        },

        onModel(upstreamModel) {
            if (upstreamModel) responsePayload.model = upstreamModel;
        },

        onEnd(usage) {
            if (terminalEventSent || res.destroyed || res.writableEnded) return;
            if (!headersSent) this.onStart();

            const completedPayload = finalizeCompletedPayload(usage || finalUsage);

            writeSseEvent('response.output_text.done', {
                type: 'response.output_text.done',
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                text: responsePayload.output_text
            });

            writeSseEvent('response.content_part.done', {
                type: 'response.content_part.done',
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: responsePayload.output_text }
            });

            writeSseEvent('response.output_item.done', {
                type: 'response.output_item.done',
                output_index: 0,
                item: responsePayload.output[0]
            });

            terminalEventSent = true;
            writeSseEvent('response.completed', {
                type: 'response.completed',
                response: completedPayload
            });

            if (!res.destroyed && !res.writableEnded) res.end();
        },

        onError(errorMessage) {
            if (terminalEventSent || res.destroyed || res.writableEnded) return;
            if (!headersSent) this.onStart();

            terminalEventSent = true;
            writeSseEvent('response.failed', {
                type: 'response.failed',
                response: finalizeFailedPayload(errorMessage)
            });

            if (!res.destroyed && !res.writableEnded) res.end();
        }
    };
}

/**
 * 将 chat completion SSE 流转换为 Anthropic Messages SSE 流
 */
function createAnthropicStreamTransformer(res, model) {
    let headersSent = false;
    const messageId = `msg_${Date.now()}`;

    return {
        onStart() {
            if (headersSent) return;
            headersSent = true;
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');

            res.write(`event: message_start\ndata: ${JSON.stringify({
                type: 'message_start',
                message: {
                    id: messageId, type: 'message', role: 'assistant',
                    content: [], model, stop_reason: null, stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 }
                }
            })}\n\n`);

            res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start', index: 0,
                content_block: { type: 'text', text: '' }
            })}\n\n`);
        },

        onDelta(delta) {
            if (!headersSent) this.onStart();
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta', index: 0,
                delta: { type: 'text_delta', text: delta }
            })}\n\n`);
        },

        onEnd(usage) {
            if (!headersSent) this.onStart();
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
            res.write(`event: message_delta\ndata: ${JSON.stringify({
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: usage?.completion_tokens || 0 }
            })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            res.end();
        }
    };
}

/**
 * 将 chat completion SSE 流转换为 Gemini SSE 流
 */
function createGeminiStreamTransformer(res) {
    let headersSent = false;

    return {
        onStart() {
            if (headersSent) return;
            headersSent = true;
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
        },

        onDelta(delta) {
            if (!headersSent) this.onStart();
            const chunk = {
                candidates: [{
                    content: { role: 'model', parts: [{ text: delta }] },
                    finishReason: null,
                    index: 0
                }]
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        },

        onEnd(usage) {
            if (!headersSent) this.onStart();
            const finalChunk = {
                candidates: [{
                    content: { role: 'model', parts: [{ text: '' }] },
                    finishReason: 'STOP',
                    index: 0
                }],
                usageMetadata: {
                    promptTokenCount: usage?.prompt_tokens || 0,
                    candidatesTokenCount: usage?.completion_tokens || 0,
                    totalTokenCount: usage?.total_tokens || 0
                }
            };
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            res.end();
        }
    };
}

// ============================================================
// 内部转发核心函数
// ============================================================

/**
 * 将提取的 messages 数组构造为 chat completions 请求体，
 * 通过 HTTP 内部转发到本地 /v1/chat/completions 端点。
 * 
 * 这样可以完整走 VCP 的处理链路（认证、插件、RAG、角色分割等）。
 */
async function forwardToChatCompletions(req, res, {
    messages,
    model,
    temperature,
    topP,
    maxTokens,
    stream,
    outputFormat, // 'responses' | 'anthropic' | 'gemini'
    originalBody // 保留原始 body 中的其他字段（如 tools 等）
}) {
    const port = process.env.PORT || 3000;
    const serverKey = process.env.Key;
    const localBaseUrl = `http://127.0.0.1:${port}`;

    // 构造标准 chat completions 请求体
    const chatBody = {
        model: model || 'gpt-4.1-mini',
        messages,
        stream: stream === true
    };

    if (typeof temperature !== 'undefined') chatBody.temperature = temperature;
    if (typeof topP !== 'undefined') chatBody.top_p = topP;
    if (typeof maxTokens !== 'undefined') chatBody.max_tokens = maxTokens;

    // 原生 function tools 字段不参与 messages/RAG/变量处理；在转发本地 chat 链路前作为受保护字段加回。
    attachProtectedToolFields(chatBody, originalBody);

    // 保留原始请求中可能有用的字段（如 requestId、messageId 等 VCP 特有字段）。
    // Codex Responses API 通常不会带 VCP 自定义 ID；为同构重试生成稳定 ID，便于主链路识别/缓存/中断追踪。
    if (originalBody?.requestId) chatBody.requestId = originalBody.requestId;
    if (originalBody?.messageId) {
        chatBody.messageId = originalBody.messageId;
    } else if (outputFormat === 'responses') {
        chatBody.messageId = buildStableRequestId('responses', {
            model: chatBody.model,
            messages: chatBody.messages,
            temperature: chatBody.temperature,
            top_p: chatBody.top_p,
            max_tokens: chatBody.max_tokens,
            stream: chatBody.stream
        });
    }

    if (DEBUG_MODE) {
        console.log(`[ProtocolBridge] Forwarding ${outputFormat} request to local /v1/chat/completions (model: ${chatBody.model}, stream: ${chatBody.stream}, messages: ${messages.length})`);
    }

    let activeTransformer = null;

    try {
        const { default: fetch } = await import('node-fetch');

        const upstreamResponse = await fetch(`${localBaseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${serverKey}`,
                // 透传原始请求的 user-agent
                ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] })
            },
            body: JSON.stringify(chatBody)
        });

        if (!upstreamResponse.ok && !stream) {
            const errorText = await upstreamResponse.text();
            if (DEBUG_MODE) console.error(`[ProtocolBridge] Local forward failed: ${upstreamResponse.status} ${errorText.substring(0, 200)}`);
            return res.status(upstreamResponse.status).type('application/json').send(errorText);
        }

        // --- 非流式响应 ---
        if (!stream) {
            const rawJson = await upstreamResponse.json();

            let outputPayload;
            switch (outputFormat) {
                case 'responses':
                    outputPayload = buildResponsesApiOutput(rawJson);
                    break;
                case 'anthropic':
                    outputPayload = buildAnthropicApiOutput(rawJson);
                    break;
                case 'gemini':
                    outputPayload = buildGeminiApiOutput(rawJson);
                    break;
                default:
                    outputPayload = rawJson;
            }

            return res.status(200).json(outputPayload);
        }

        // --- 流式响应 ---
        if (!upstreamResponse.ok) {
            const errorText = await upstreamResponse.text();
            return res.status(upstreamResponse.status).type('application/json').send(errorText);
        }

        let transformer;
        switch (outputFormat) {
            case 'responses':
                transformer = createResponsesStreamTransformer(res, chatBody.model);
                activeTransformer = transformer;
                break;
            case 'anthropic':
                transformer = createAnthropicStreamTransformer(res, chatBody.model);
                break;
            case 'gemini':
                transformer = createGeminiStreamTransformer(res);
                break;
            default:
                // 直接透传 SSE 流
                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache, no-transform');
                res.setHeader('Connection', 'keep-alive');
                for await (const chunk of upstreamResponse.body) {
                    res.write(chunk);
                }
                return res.end();
        }

        // 解析上游 SSE 流并通过 transformer 转换格式
        transformer.onStart();
        let lastUsage = null;

        const decoder = new (require('util').TextDecoder)('utf-8');
        let buffer = '';

        for await (const chunk of upstreamResponse.body) {
            buffer += decoder.decode(chunk, { stream: true });

            while (true) {
                const newlineIndex = buffer.indexOf('\n');
                if (newlineIndex === -1) break;

                const line = buffer.slice(0, newlineIndex).trimEnd();
                buffer = buffer.slice(newlineIndex + 1);

                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (data === '[DONE]') continue;

                try {
                    const json = JSON.parse(data);
                    const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content;
                    if (typeof delta === 'string' && delta.length > 0) {
                        transformer.onDelta(delta);
                    }
                    if (json?.usage) {
                        lastUsage = json.usage;
                        if (typeof transformer.onUsage === 'function') transformer.onUsage(json.usage);
                    }
                    if (json?.model && typeof transformer.onModel === 'function') {
                        transformer.onModel(json.model);
                    }
                } catch (e) {
                    // 忽略解析错误
                }
            }
        }

        transformer.onEnd(lastUsage);

    } catch (error) {
        console.error(`[ProtocolBridge] Error forwarding to local chat completions:`, error.message);
        if (activeTransformer && typeof activeTransformer.onError === 'function') {
            activeTransformer.onError(error.message);
        } else if (!res.headersSent) {
            res.status(502).json({
                error: {
                    message: `Protocol bridge internal forward failed: ${error.message}`,
                    type: 'protocol_bridge_error'
                }
            });
        } else if (!res.writableEnded) {
            res.end();
        }
    }
}

// ============================================================
// 路由端点
// ============================================================

/**
 * OpenAI Responses API 兼容端点
 * POST /v1/responses
 */
router.post('/v1/responses', async (req, res) => {
    const body = req.body || {};
    const messages = extractMessagesFromResponsesInput(body.input);

    if (messages.length === 0) {
        return res.status(400).json({
            error: {
                message: 'No valid messages could be extracted from the input field.',
                type: 'invalid_request_error'
            }
        });
    }

    const wantsStream = body.stream === true || String(req.headers.accept || '').includes('text/event-stream');
    if (!body.messageId && !body.requestId) {
        body.messageId = buildStableRequestId('responses', {
            model: body.model || 'gpt-4.1-mini',
            messages,
            temperature: body.temperature,
            top_p: body.top_p,
            max_tokens: body.max_output_tokens || body.max_tokens,
            stream: wantsStream
        });
    }

    const stableRequestId = body.messageId || body.requestId;
    if (isSuppressedDuplicateResponsesRequest(stableRequestId)) {
        if (DEBUG_MODE) {
            console.warn(`[ProtocolBridge] Suppressed duplicate /v1/responses retry: ${stableRequestId}`);
        }
        return sendImmediateResponsesResult(res, {
            model: body.model || 'gpt-4.1-mini',
            stream: wantsStream,
            text: '[VCP_PROTOCOL_BRIDGE] 检测到客户端短时间内重复提交同一 Responses 请求；已抑制重复转发以避免重复触发 RAG 与上游重试。请稍后重试或检查上游 API 可用性。'
        });
    }

    await forwardToChatCompletions(req, res, {
        messages,
        model: body.model,
        temperature: body.temperature,
        topP: body.top_p,
        maxTokens: body.max_output_tokens || body.max_tokens,
        stream: wantsStream,
        outputFormat: 'responses',
        originalBody: body
    });
});

/**
 * Anthropic Messages API 兼容端点
 * POST /v1/messages
 */
router.post('/v1/messages', async (req, res) => {
    const body = req.body || {};
    const messages = extractMessagesFromAnthropicBody(body);

    if (messages.length === 0) {
        return res.status(400).json({
            error: {
                message: 'No valid messages could be extracted from the request body.',
                type: 'invalid_request_error'
            }
        });
    }

    const wantsStream = body.stream === true || String(req.headers.accept || '').includes('text/event-stream');

    await forwardToChatCompletions(req, res, {
        messages,
        model: body.model,
        temperature: body.temperature,
        topP: body.top_p,
        maxTokens: body.max_tokens,
        stream: wantsStream,
        outputFormat: 'anthropic',
        originalBody: { ...body, stream: wantsStream }
    });
});

/**
 * Gemini GenerateContent API 兼容端点
 * POST /v1beta/models/:model:generateContent
 * POST /v1beta/models/:model:streamGenerateContent
 */
router.post(/^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/, async (req, res) => {
    const body = req.body || {};
    const messages = extractMessagesFromGeminiBody(body);
    const modelFromPath = req.params[0];
    const isStreamRoute = req.params[1] === 'streamGenerateContent';

    if (messages.length === 0) {
        return res.status(400).json({
            error: {
                message: 'No valid messages could be extracted from the contents field.',
                type: 'invalid_request_error'
            }
        });
    }

    await forwardToChatCompletions(req, res, {
        messages,
        model: modelFromPath || body.model,
        temperature: body.generationConfig?.temperature,
        topP: body.generationConfig?.topP,
        maxTokens: body.generationConfig?.maxOutputTokens,
        stream: isStreamRoute,
        outputFormat: 'gemini',
        originalBody: body
    });
});

module.exports = router;