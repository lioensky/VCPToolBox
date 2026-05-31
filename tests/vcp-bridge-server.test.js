const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const plugin = require('../Plugin/VCPBridgeServer/bridgeserver.js');
const {
    applySystemPromptHijack,
    buildUpstreamRequest,
    createRuntimeConfig,
    extractFromAnthropicBody,
    extractFromGeminiBody,
    extractFromResponsesInput,
    parseModelMap,
    resolveUpstreamEndpoint,
    transformChatSseToResponsesSse,
    transformUpstreamSseToChatSse,
    transformUpstreamJsonPayload
} = plugin._private;

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function createDelayedSseResponse(chunks, delayMs = 120) {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        async start(controller) {
            for (let index = 0; index < chunks.length; index += 1) {
                if (index > 0) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
                controller.enqueue(encoder.encode(chunks[index]));
            }
            controller.close();
        }
    }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
    });
}

async function readRemainingText(reader, decoder) {
    let text = '';
    while (true) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return text;
}

test('manifest declares disabled-by-default direct service', () => {
    const manifest = require('../Plugin/VCPBridgeServer/plugin-manifest.json');

    assert.equal(manifest.pluginType, 'service');
    assert.equal(manifest.communication.protocol, 'direct');
    assert.equal(manifest.entryPoint.script, 'bridgeserver.js');
    assert.equal(manifest.defaults.BRIDGE_ENABLED, false);
});

test('initialize does not start server when bridge is disabled', async () => {
    await plugin.shutdown();
    await plugin.initialize({ BRIDGE_ENABLED: false });

    assert.equal(plugin._private.isRunning(), false);
});

test('initialize stops existing listener before applying disabled config', async () => {
    const port = await getFreePort();
    const fakeFetch = async () => {
        throw new Error('test should not call upstream');
    };

    try {
        await plugin.initialize({
            BRIDGE_ENABLED: true,
            BRIDGE_BIND_HOST: '127.0.0.1',
            BRIDGE_PORT: port
        }, { fetchImpl: fakeFetch });
        assert.equal(plugin._private.isRunning(), true);

        await plugin.initialize({ BRIDGE_ENABLED: false });
        assert.equal(plugin._private.isRunning(), false);
    } finally {
        await plugin.shutdown();
    }
});

test('prompt hijack supports replace prepend append and off', () => {
    const messages = [
        { role: 'system', content: 'old' },
        { role: 'user', content: 'hello' }
    ];

    assert.deepEqual(
        applySystemPromptHijack(messages, { systemPrompt: 'new', hijackMode: 'replace' }),
        [{ role: 'system', content: 'new' }, { role: 'user', content: 'hello' }]
    );
    assert.deepEqual(
        applySystemPromptHijack(messages, { systemPrompt: 'new', hijackMode: 'prepend' }).map(item => item.content),
        ['new', 'old', 'hello']
    );
    assert.deepEqual(
        applySystemPromptHijack(messages, { systemPrompt: 'new', hijackMode: 'append' }).map(item => item.content),
        ['old', 'new', 'hello']
    );
    assert.deepEqual(
        applySystemPromptHijack(messages, { systemPrompt: 'new', hijackMode: 'off' }),
        messages
    );
});

test('extracts messages from responses anthropic and gemini bodies', () => {
    assert.deepEqual(
        extractFromResponsesInput([
            { role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
            { role: 'user', content: [{ type: 'input_text', text: 'question' }] }
        ]),
        [{ role: 'system', content: 'rules' }, { role: 'user', content: 'question' }]
    );

    assert.deepEqual(
        extractFromAnthropicBody({
            system: [{ type: 'text', text: 'anthropic rules' }],
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
        }),
        [{ role: 'system', content: 'anthropic rules' }, { role: 'user', content: 'hi' }]
    );

    assert.deepEqual(
        extractFromGeminiBody({
            systemInstruction: { parts: [{ text: 'gemini rules' }] },
            contents: [{ role: 'model', parts: [{ text: 'answer' }] }]
        }),
        [{ role: 'system', content: 'gemini rules' }, { role: 'assistant', content: 'answer' }]
    );
});

test('model map and endpoint builder resolve upstream URLs', () => {
    const config = createRuntimeConfig({
        BRIDGE_UPSTREAM_URL: 'https://example.test/api/',
        BRIDGE_UPSTREAM_TYPE: 'gemini',
        BRIDGE_MODEL_MAP: 'alias:gemini-2.5-flash'
    });

    assert.deepEqual(parseModelMap('a:b, c : d'), { a: 'b', c: 'd' });
    assert.deepEqual(
        resolveUpstreamEndpoint('alias', true, config),
        { url: 'https://example.test/api/v1beta/models/gemini-2.5-flash:streamGenerateContent', type: 'gemini' }
    );
});

test('buildUpstreamRequest does not expose keys and preserves caller token fallback', () => {
    const config = createRuntimeConfig({
        BRIDGE_UPSTREAM_URL: 'https://api.example.test',
        BRIDGE_UPSTREAM_TYPE: 'chat',
        BRIDGE_SYSTEM_PROMPT: 'stable rules',
        BRIDGE_HIJACK_MODE: 'prepend'
    });

    const request = buildUpstreamRequest({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'gpt-local',
        body: { stream: true },
        requestHeaders: { authorization: 'Bearer caller-token' }
    }, config);

    assert.equal(request.endpoint.url, 'https://api.example.test/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer caller-token');
    assert.deepEqual(request.upstreamBody.messages.map(item => item.content), ['stable rules', 'hello']);
    assert.equal(request.upstreamBody.stream, true);
});

test('buildUpstreamRequest selects auth header by upstream protocol', () => {
    const anthropicConfig = createRuntimeConfig({
        BRIDGE_UPSTREAM_URL: 'https://api.anthropic.test',
        BRIDGE_UPSTREAM_TYPE: 'anthropic',
        BRIDGE_UPSTREAM_KEY: 'configured-anthropic-key'
    });
    const anthropicRequest = buildUpstreamRequest({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'claude-local',
        body: {},
        requestHeaders: {
            authorization: 'Bearer wrong-header',
            'x-api-key': 'downstream-anthropic-key'
        }
    }, anthropicConfig);

    assert.equal(anthropicRequest.headers['x-api-key'], 'configured-anthropic-key');
    assert.equal(anthropicRequest.headers.Authorization, undefined);
    assert.equal(anthropicRequest.headers['anthropic-version'], '2023-06-01');

    const geminiConfig = createRuntimeConfig({
        BRIDGE_UPSTREAM_URL: 'https://api.gemini.test',
        BRIDGE_UPSTREAM_TYPE: 'gemini',
        BRIDGE_UPSTREAM_KEY: 'configured-gemini-key'
    });
    const geminiRequest = buildUpstreamRequest({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'gemini-local',
        body: {},
        requestHeaders: {
            authorization: 'Bearer wrong-header',
            'x-goog-api-key': 'downstream-gemini-key'
        }
    }, geminiConfig);

    assert.equal(geminiRequest.headers['x-goog-api-key'], 'configured-gemini-key');
    assert.equal(geminiRequest.headers.Authorization, undefined);
});

test('transforms chat completion JSON into responses schema', () => {
    const transformed = transformUpstreamJsonPayload({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1710000000,
        model: 'gpt-test',
        choices: [
            {
                message: {
                    role: 'assistant',
                    content: 'hello from chat'
                }
            }
        ],
        usage: {
            prompt_tokens: 2,
            completion_tokens: 3,
            total_tokens: 5
        }
    }, 'chat', 'responses');

    assert.equal(transformed.object, 'response');
    assert.equal(transformed.status, 'completed');
    assert.equal(transformed.output_text, 'hello from chat');
    assert.equal(transformed.output[0].content[0].type, 'output_text');
    assert.equal(transformed.output[0].content[0].text, 'hello from chat');
    assert.deepEqual(transformed.usage, {
        input_tokens: 2,
        output_tokens: 3,
        total_tokens: 5
    });
});

test('transforms anthropic and gemini JSON into chat completion schema', () => {
    const anthropicChat = transformUpstreamJsonPayload({
        id: 'msg-anthropic-test',
        type: 'message',
        model: 'claude-test',
        content: [{ type: 'text', text: 'anthropic answer' }],
        usage: {
            input_tokens: 7,
            output_tokens: 8
        }
    }, 'anthropic', 'chat');

    assert.equal(anthropicChat.object, 'chat.completion');
    assert.equal(anthropicChat.choices[0].message.role, 'assistant');
    assert.equal(anthropicChat.choices[0].message.content, 'anthropic answer');
    assert.deepEqual(anthropicChat.usage, {
        prompt_tokens: 7,
        completion_tokens: 8,
        total_tokens: 15
    });

    const geminiChat = transformUpstreamJsonPayload({
        model: 'gemini-test',
        candidates: [
            {
                content: {
                    parts: [{ text: 'gemini answer' }]
                }
            }
        ],
        usageMetadata: {
            promptTokenCount: 3,
            candidatesTokenCount: 4,
            totalTokenCount: 7
        }
    }, 'gemini', 'chat');

    assert.equal(geminiChat.object, 'chat.completion');
    assert.equal(geminiChat.choices[0].message.content, 'gemini answer');
    assert.deepEqual(geminiChat.usage, {
        prompt_tokens: 3,
        completion_tokens: 4,
        total_tokens: 7
    });
});

test('transforms chat completion SSE into responses stream events', () => {
    const transformed = transformChatSseToResponsesSse([
        'data: {"model":"gpt-test","choices":[{"delta":{"content":"hel"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        '',
        'data: [DONE]',
        ''
    ].join('\n'));

    assert.match(transformed, /event: response\.created/);
    assert.match(transformed, /event: response\.output_text\.delta/);
    assert.match(transformed, /"delta":"hel"/);
    assert.match(transformed, /"delta":"lo"/);
    assert.match(transformed, /event: response\.completed/);
    assert.match(transformed, /"output_text":"hello"/);
    assert.match(transformed, /data: \[DONE\]/);
});

test('transforms anthropic SSE into chat completion chunks', () => {
    const transformed = transformUpstreamSseToChatSse([
        'event: message_start',
        'data: {"type":"message_start","message":{"model":"claude-test"}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"anthropic "}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"stream"}}',
        ''
    ].join('\n'), 'anthropic');

    assert.match(transformed, /"object":"chat\.completion\.chunk"/);
    assert.match(transformed, /"model":"claude-test"/);
    assert.match(transformed, /"content":"anthropic "/);
    assert.match(transformed, /"content":"stream"/);
    assert.match(transformed, /"finish_reason":"stop"/);
    assert.match(transformed, /data: \[DONE\]/);
});

test('chat endpoint returns chat schema when upstream is anthropic', async () => {
    const port = await getFreePort();
    const fakeFetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.messages[0].content, 'chat request');
        return new Response(JSON.stringify({
            id: 'msg-route-test',
            type: 'message',
            model: 'claude-route',
            content: [{ type: 'text', text: 'chat answer' }],
            usage: {
                input_tokens: 11,
                output_tokens: 12
            }
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    };

    try {
        await plugin.initialize({
            BRIDGE_ENABLED: true,
            BRIDGE_BIND_HOST: '127.0.0.1',
            BRIDGE_PORT: port,
            BRIDGE_UPSTREAM_TYPE: 'anthropic'
        }, { fetchImpl: fakeFetch });

        const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-route',
                messages: [{ role: 'user', content: 'chat request' }]
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.object, 'chat.completion');
        assert.equal(payload.choices[0].message.role, 'assistant');
        assert.equal(payload.choices[0].message.content, 'chat answer');
        assert.deepEqual(payload.usage, {
            prompt_tokens: 11,
            completion_tokens: 12,
            total_tokens: 23
        });
    } finally {
        await plugin.shutdown();
    }
});

test('chat endpoint returns chat SSE when anthropic upstream streams', async () => {
    const port = await getFreePort();
    const fakeFetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.stream, true);
        assert.equal(body.messages[0].content, 'chat stream');
        return createDelayedSseResponse([
            [
                'event: content_block_delta',
                'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"chat "}}',
                ''
            ].join('\n'),
            [
                'event: content_block_delta',
                'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"stream"}}',
                ''
            ].join('\n')
        ]);
    };

    try {
        await plugin.initialize({
            BRIDGE_ENABLED: true,
            BRIDGE_BIND_HOST: '127.0.0.1',
            BRIDGE_PORT: port,
            BRIDGE_UPSTREAM_TYPE: 'anthropic'
        }, { fetchImpl: fakeFetch });

        const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-route',
                stream: true,
                messages: [{ role: 'user', content: 'chat stream' }]
            })
        });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const first = await reader.read();
        const firstPayload = decoder.decode(first.value, { stream: true });
        const payload = firstPayload + await readRemainingText(reader, decoder);

        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/event-stream/);
        assert.equal(first.done, false);
        assert.match(firstPayload, /"content":"chat "/);
        assert.doesNotMatch(firstPayload, /"content":"stream"/);
        assert.match(payload, /"object":"chat\.completion\.chunk"/);
        assert.match(payload, /"content":"chat "/);
        assert.match(payload, /"content":"stream"/);
        assert.match(payload, /data: \[DONE\]/);
    } finally {
        await plugin.shutdown();
    }
});

test('responses endpoint returns responses schema when upstream is chat', async () => {
    const port = await getFreePort();
    const fakeFetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.messages[0].content, 'hello');
        return new Response(JSON.stringify({
            id: 'chatcmpl-route-test',
            object: 'chat.completion',
            created: 1710000001,
            model: 'gpt-route',
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: 'route answer'
                    }
                }
            ],
            usage: {
                prompt_tokens: 4,
                completion_tokens: 5,
                total_tokens: 9
            }
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    };

    try {
        await plugin.initialize({
            BRIDGE_ENABLED: true,
            BRIDGE_BIND_HOST: '127.0.0.1',
            BRIDGE_PORT: port,
            BRIDGE_UPSTREAM_TYPE: 'chat'
        }, { fetchImpl: fakeFetch });

        const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'gpt-route',
                input: 'hello'
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.object, 'response');
        assert.equal(payload.output_text, 'route answer');
        assert.equal(payload.output[0].content[0].text, 'route answer');
        assert.deepEqual(payload.usage, {
            input_tokens: 4,
            output_tokens: 5,
            total_tokens: 9
        });
    } finally {
        await plugin.shutdown();
    }
});

test('responses endpoint returns responses SSE when upstream streams chat chunks', async () => {
    const port = await getFreePort();
    const fakeFetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.stream, true);
        assert.equal(body.messages[0].content, 'hello stream');
        return createDelayedSseResponse([
            [
                'data: {"model":"gpt-route","choices":[{"delta":{"content":"stream "}}]}',
                ''
            ].join('\n'),
            [
                'data: {"choices":[{"delta":{"content":"answer"}}]}',
                '',
                'data: [DONE]',
                ''
            ].join('\n')
        ]);
    };

    try {
        await plugin.initialize({
            BRIDGE_ENABLED: true,
            BRIDGE_BIND_HOST: '127.0.0.1',
            BRIDGE_PORT: port,
            BRIDGE_UPSTREAM_TYPE: 'chat'
        }, { fetchImpl: fakeFetch });

        const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
            method: 'POST',
            headers: {
                accept: 'text/event-stream',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-route',
                input: 'hello stream',
                stream: true
            })
        });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const first = await reader.read();
        const firstPayload = decoder.decode(first.value, { stream: true });
        const payload = firstPayload + await readRemainingText(reader, decoder);

        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/event-stream/);
        assert.equal(first.done, false);
        assert.doesNotMatch(firstPayload, /"delta":"answer"/);
        assert.match(payload, /event: response\.output_text\.delta/);
        assert.match(payload, /"delta":"stream "/);
        assert.match(payload, /"delta":"answer"/);
        assert.match(payload, /event: response\.completed/);
        assert.match(payload, /"output_text":"stream answer"/);
        assert.match(payload, /data: \[DONE\]/);
    } finally {
        await plugin.shutdown();
    }
});

test('runtime config rejects unsafe bind host and arbitrary upstream protocols', () => {
    assert.throws(
        () => createRuntimeConfig({ BRIDGE_BIND_HOST: '0.0.0.0' }),
        /loopback-only/
    );
    assert.throws(
        () => createRuntimeConfig({ BRIDGE_PORT: 0 }),
        /between 1 and 65535/
    );
    assert.throws(
        () => createRuntimeConfig({ BRIDGE_UPSTREAM_URL: 'file:///tmp/provider' }),
        /http or https/
    );
});

test.after(async () => {
    await plugin.shutdown();
});
