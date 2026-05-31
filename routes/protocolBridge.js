// routes/protocolBridge.js
// 协议桥接路由：将 OpenAI Responses API、Anthropic Messages、Gemini GenerateContent
// 格式的请求转换为标准 v1/chat/completions messages 数组，内部转发到主服务器处理链路。
// 这样所有 VCP 能力（插件、RAG、角色分割等）对所有协议客户端透明可用。

const express = require('express');
const router = express.Router();

const DEBUG_MODE = (process.env.DebugMode || 'False').toLowerCase() === 'true';

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
        const content = normalizeTextContent(item.content);

        if (role && content) {
            messages.push({ role, content });
            continue;
        }

        if (item.type === 'message' && Array.isArray(item.content)) {
            const nestedContent = normalizeTextContent(item.content);
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

/**
 * 将 chat completion SSE 流转换为 Responses API SSE 流
 */
function createResponsesStreamTransformer(res, model) {
    const responseId = `resp_${Date.now()}`;
    const itemId = `msg_${Date.now()}`;
    let accumulatedText = '';
    let headersSent = false;

    function writeSseEvent(eventName, data) {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
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
                    id: responseId,
                    object: 'response',
                    created_at: Math.floor(Date.now() / 1000),
                    status: 'in_progress',
                    model,
                    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
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
            if (!headersSent) this.onStart();
            accumulatedText += delta;
            writeSseEvent('response.output_text.delta', {
                type: 'response.output_text.delta',
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                delta
            });
        },

        onEnd(usage) {
            if (!headersSent) this.onStart();

            writeSseEvent('response.output_text.done', {
                type: 'response.output_text.done',
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                text: accumulatedText
            });

            writeSseEvent('response.content_part.done', {
                type: 'response.content_part.done',
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: accumulatedText }
            });

            writeSseEvent('response.output_item.done', {
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                    id: itemId,
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: accumulatedText, annotations: [] }]
                }
            });

            writeSseEvent('response.completed', {
                type: 'response.completed',
                response: {
                    id: responseId,
                    object: 'response',
                    created_at: Math.floor(Date.now() / 1000),
                    status: 'completed',
                    model,
                    output: [{
                        id: itemId,
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: accumulatedText, annotations: [] }]
                    }],
                    output_text: accumulatedText,
                    usage: {
                        input_tokens: usage?.prompt_tokens || 0,
                        output_tokens: usage?.completion_tokens || 0,
                        total_tokens: usage?.total_tokens || 0
                    }
                }
            });

            res.end();
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

    // 保留原始请求中可能有用的字段（如 requestId、messageId 等 VCP 特有字段）
    if (originalBody?.requestId) chatBody.requestId = originalBody.requestId;
    if (originalBody?.messageId) chatBody.messageId = originalBody.messageId;

    if (DEBUG_MODE) {
        console.log(`[ProtocolBridge] Forwarding ${outputFormat} request to local /v1/chat/completions (model: ${chatBody.model}, stream: ${chatBody.stream}, messages: ${messages.length})`);
    }

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
                    const delta = json?.choices?.[0]?.delta?.content;
                    if (typeof delta === 'string' && delta.length > 0) {
                        transformer.onDelta(delta);
                    }
                    if (json?.usage) {
                        lastUsage = json.usage;
                    }
                } catch (e) {
                    // 忽略解析错误
                }
            }
        }

        transformer.onEnd(lastUsage);

    } catch (error) {
        console.error(`[ProtocolBridge] Error forwarding to local chat completions:`, error.message);
        if (!res.headersSent) {
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

    await forwardToChatCompletions(req, res, {
        messages,
        model: body.model,
        temperature: body.temperature,
        topP: body.top_p,
        maxTokens: body.max_tokens,
        stream: body.stream === true,
        outputFormat: 'anthropic',
        originalBody: body
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