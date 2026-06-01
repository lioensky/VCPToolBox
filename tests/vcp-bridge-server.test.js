const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { Readable } = require('node:stream');

const plugin = require('../Plugin/VCPBridgeServer/bridgeserver.js');
const {
    applySystemPromptHijack,
    buildCodexConfig,
    buildDoctorReport,
    buildPromptDoctor,
    buildUpstreamRequest,
    checkRateLimit,
    collectDroppedResponseFields,
    createRuntimeConfig,
    extractFromAnthropicBody,
    extractFromGeminiBody,
    extractFromResponsesBody,
    extractFromResponsesInput,
    normalizeHijackMode,
    parseModelMap,
    readSseLines,
    resolveProfileDefaults,
    resolveSystemPrompt,
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
    assert.equal(normalizeHijackMode('replace'), 'replace');
    assert.equal(normalizeHijackMode('bogus'), 'off');
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
        extractFromResponsesBody({
            instructions: [{ type: 'input_text', text: 'top rules' }],
            input: [
                { role: 'developer', content: [{ type: 'input_text', text: 'developer rules' }] },
                { role: 'user', content: [{ type: 'input_text', text: 'question' }] }
            ]
        }),
        [
            { role: 'system', content: 'top rules' },
            { role: 'system', content: 'developer rules' },
            { role: 'user', content: 'question' }
        ]
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

test('runtime config defaults upstream to local VCP server and inherited key', () => {
    const config = createRuntimeConfig({
        PORT: 6105,
        Key: 'main-server-key',
        BRIDGE_UPSTREAM_URL: '',
        BRIDGE_UPSTREAM_TYPE: 'chat'
    });

    const request = buildUpstreamRequest({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'gpt-local',
        body: {},
        requestHeaders: {}
    }, config);

    assert.equal(config.upstreamUrl, 'http://127.0.0.1:6105');
    assert.equal(request.endpoint.url, 'http://127.0.0.1:6105/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer main-server-key');
});

test('runtime config applies local safety defaults and explicit overrides', () => {
    const defaults = createRuntimeConfig({});

    assert.equal(defaults.clientKey, '');
    assert.equal(defaults.connectTimeoutMs, 15000);
    assert.equal(defaults.totalTimeoutMs, 0);
    assert.equal(defaults.idleTimeoutMs, 180000);
    assert.equal(defaults.denyBrowserOrigin, true);
    assert.equal(defaults.rateLimitRpm, 60);
    assert.equal(defaults.maxBodyMb, 20);
    assert.equal(defaults.expressJsonLimit, '20mb');

    const config = createRuntimeConfig({
        BRIDGE_CLIENT_KEY: 'client-key',
        BRIDGE_UPSTREAM_CONNECT_TIMEOUT_MS: 11,
        BRIDGE_UPSTREAM_TOTAL_TIMEOUT_MS: 22,
        BRIDGE_UPSTREAM_IDLE_TIMEOUT_MS: 33,
        BRIDGE_DENY_BROWSER_ORIGIN: false,
        BRIDGE_RATE_LIMIT_RPM: 2,
        BRIDGE_MAX_BODY_MB: 3
    });

    assert.equal(config.clientKey, 'client-key');
    assert.equal(config.connectTimeoutMs, 11);
    assert.equal(config.totalTimeoutMs, 22);
    assert.equal(config.idleTimeoutMs, 33);
    assert.equal(config.denyBrowserOrigin, false);
    assert.equal(config.rateLimitRpm, 2);
    assert.equal(config.maxBodyMb, 3);
    assert.equal(config.expressJsonLimit, '3mb');
});

test('codex-vcp-memory profile applies safe memory gateway defaults', () => {
    const config = createRuntimeConfig({
        PORT: 6105,
        Key: 'main-server-key',
        BRIDGE_PROFILE: 'codex-vcp-memory',
        BRIDGE_UPSTREAM_URL: ''
    });

    assert.deepEqual(resolveProfileDefaults('codex-vcp-memory'), {
        upstreamType: 'chat',
        hijackMode: 'append',
        systemPrompt: 'prompts/codex_vcp_memory.strict.txt',
        requireVcpUpstream: true
    });
    assert.equal(config.profile, 'codex-vcp-memory');
    assert.equal(config.upstreamUrl, 'http://127.0.0.1:6105');
    assert.equal(config.upstreamType, 'chat');
    assert.equal(config.hijackMode, 'append');
    assert.equal(config.requireVcpUpstream, true);
    assert.match(config.systemPrompt, /Memory Gateway strict profile/);

    const request = buildUpstreamRequest({
        messages: [{ role: 'system', content: 'codex rules' }, { role: 'user', content: 'hello' }],
        model: 'gpt-local',
        body: {},
        requestHeaders: {}
    }, config);

    assert.deepEqual(
        request.upstreamBody.messages.map(message => message.role),
        ['system', 'system', 'user']
    );
    assert.equal(request.upstreamBody.messages[0].content, 'codex rules');
    assert.match(request.upstreamBody.messages[1].content, /Preserve Codex/);
});

test('explicit bridge settings override codex-vcp-memory profile defaults', () => {
    const config = createRuntimeConfig({
        BRIDGE_PROFILE: 'codex-vcp-memory',
        BRIDGE_UPSTREAM_URL: 'https://api.example.test',
        BRIDGE_UPSTREAM_TYPE: 'anthropic',
        BRIDGE_HIJACK_MODE: 'prepend',
        BRIDGE_SYSTEM_PROMPT: 'custom rules',
        BRIDGE_REQUIRE_VCP_UPSTREAM: false
    });

    assert.equal(config.upstreamUrl, 'https://api.example.test');
    assert.equal(config.upstreamType, 'anthropic');
    assert.equal(config.hijackMode, 'prepend');
    assert.equal(config.systemPrompt, 'custom rules');
    assert.equal(config.requireVcpUpstream, false);
});

test('system prompt file loading stays inside the plugin directory', () => {
    const pluginDir = path.join(__dirname, '..', 'Plugin', 'VCPBridgeServer');

    assert.match(
        resolveSystemPrompt('prompts/codex_vcp_memory.strict.txt', pluginDir),
        /strict profile/
    );
    assert.match(
        resolveSystemPrompt('prompts/codex_vcp_memory.balanced.txt', pluginDir),
        /Memory contamination firewall/
    );
    assert.match(
        resolveSystemPrompt('prompts/codex_vcp_memory.aggressive.txt', pluginDir),
        /High-risk mode/
    );
    assert.equal(
        resolveSystemPrompt('prompts/missing-memory-policy.txt', pluginDir),
        ''
    );
    assert.equal(
        resolveSystemPrompt('../README.md', pluginDir),
        '../README.md'
    );
});

test('responses dropped field collection is explicit and limited', () => {
    assert.deepEqual(
        collectDroppedResponseFields({
            tools: [],
            reasoning: {},
            metadata: { keptForClient: true },
            previous_response_id: 'resp_1'
        }),
        ['tools', 'previous_response_id', 'reasoning']
    );
});

test('buildUpstreamRequest does not expose keys and preserves caller token fallback', () => {
    const config = createRuntimeConfig({
        BRIDGE_UPSTREAM_URL: 'https://api.example.test',
        BRIDGE_UPSTREAM_TYPE: 'chat',
        BRIDGE_SYSTEM_PROMPT: 'stable rules',
        BRIDGE_HIJACK_MODE: 'prepend',
        Key: 'main-server-key'
    });

    const request = buildUpstreamRequest({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'gpt-local',
        body: { stream: true },
        requestHeaders: { authorization: 'Bearer caller-token' }
    }, config);

    assert.equal(request.endpoint.url, 'https://api.example.test/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer caller-token');
    assert.notEqual(request.headers.Authorization, 'Bearer main-server-key');
    assert.deepEqual(request.upstreamBody.messages.map(item => item.content), ['stable rules', 'hello']);
    assert.equal(request.upstreamBody.stream, true);
});

test('chat upstream body maps responses token and stream options fields', () => {
    const config = createRuntimeConfig({
        BRIDGE_UPSTREAM_URL: 'https://api.example.test',
        BRIDGE_UPSTREAM_TYPE: 'chat'
    });

    const request = buildUpstreamRequest({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'gpt-local',
        body: {
            max_output_tokens: 123,
            stream_options: { include_usage: true }
        },
        requestHeaders: {}
    }, config);

    assert.equal(request.upstreamBody.max_tokens, 123);
    assert.deepEqual(request.upstreamBody.stream_options, { include_usage: true });
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

test('responses endpoint forwards instructions and reports dropped fields', async () => {
    const port = await getFreePort();
    const fakeFetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.deepEqual(
            body.messages.map(message => [message.role, message.content]),
            [
                ['system', 'top instructions'],
                ['system', 'developer instructions'],
                ['user', 'hello']
            ]
        );
        assert.equal(body.max_tokens, 42);
        assert.deepEqual(body.stream_options, { include_usage: true });
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
            ]
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
                instructions: 'top instructions',
                input: [
                    { role: 'developer', content: 'developer instructions' },
                    { role: 'user', content: 'hello' }
                ],
                max_output_tokens: 42,
                stream_options: { include_usage: true },
                tools: [],
                reasoning: {}
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-vcp-bridge-dropped-fields'), 'tools,reasoning');
        assert.equal(payload.output_text, 'route answer');
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

test('runtime config rejects upstream self-loop aliases', () => {
    for (const upstreamUrl of [
        'http://127.0.0.1:3100',
        'http://localhost:3100',
        'http://[::1]:3100'
    ]) {
        assert.throws(
            () => createRuntimeConfig({
                BRIDGE_BIND_HOST: '127.0.0.1',
                BRIDGE_PORT: 3100,
                BRIDGE_UPSTREAM_URL: upstreamUrl
            }),
            /Refusing self-loop/
        );
    }

    assert.doesNotThrow(() => createRuntimeConfig({
        BRIDGE_BIND_HOST: '127.0.0.1',
        BRIDGE_PORT: 3100,
        BRIDGE_UPSTREAM_URL: 'http://127.0.0.1:5890'
    }));
});

test('doctor report is sanitized and can probe VCP-like upstream', async () => {
    const seen = {};
    const config = createRuntimeConfig({
        BRIDGE_PROFILE: 'codex-vcp-memory',
        BRIDGE_BIND_HOST: '127.0.0.1',
        BRIDGE_PORT: 3100,
        BRIDGE_UPSTREAM_URL: 'http://127.0.0.1:5890',
        BRIDGE_UPSTREAM_KEY: 'secret-upstream-key'
    }, {
        fetchImpl: async (url, options) => {
            seen.url = url;
            seen.authorization = options.headers.Authorization;
            return new Response(JSON.stringify({ object: 'list', data: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
    });

    const report = await buildDoctorReport(config);

    assert.equal(seen.url, 'http://127.0.0.1:5890/v1/models');
    assert.equal(seen.authorization, 'Bearer secret-upstream-key');
    assert.equal(report.ok, true);
    assert.equal(report.profile, 'codex-vcp-memory');
    assert.equal(report.bridge.bind, '127.0.0.1:3100');
    assert.equal(report.upstream.reachable, true);
    assert.equal(report.upstream.looksLikeVCPToolBox, true);
    assert.equal(report.upstream.probe, '/v1/models');
    assert.equal(report.prompt.source, 'prompts/codex_vcp_memory.strict.txt');
    assert.match(report.prompt.sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(report).includes('secret-upstream-key'), false);
});

test('doctor report warns instead of probing without an upstream key', async () => {
    const config = createRuntimeConfig({
        BRIDGE_UPSTREAM_URL: 'http://127.0.0.1:5890',
        BRIDGE_UPSTREAM_KEY: ''
    }, {
        fetchImpl: async () => {
            throw new Error('probe should not run');
        }
    });

    const report = await buildDoctorReport(config);

    assert.equal(report.ok, false);
    assert.equal(report.upstream.reachable, null);
    assert.match(report.warnings.join('\n'), /no upstream key/);
});

test('doctor codex config and prompt hash are deterministic', () => {
    const config = createRuntimeConfig({
        BRIDGE_BIND_HOST: '127.0.0.1',
        BRIDGE_PORT: 3100,
        BRIDGE_MODEL: 'VCPModelAuto',
        BRIDGE_SYSTEM_PROMPT: 'stable rules'
    });

    assert.match(buildCodexConfig(config), /base_url = "http:\/\/127\.0\.0\.1:3100\/v1"/);
    assert.match(buildCodexConfig(config), /model = "VCPModelAuto"/);
    assert.equal(buildPromptDoctor(config).chars, 'stable rules'.length);
    assert.match(buildPromptDoctor(config).sha256, /^[a-f0-9]{64}$/);
});

test('doctor endpoints return sanitized diagnostics and codex config', async () => {
    const port = await getFreePort();
    const fakeFetch = async () => new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });

    try {
        await plugin.initialize({
            BRIDGE_ENABLED: true,
            BRIDGE_PROFILE: 'codex-vcp-memory',
            BRIDGE_BIND_HOST: '127.0.0.1',
            BRIDGE_PORT: port,
            BRIDGE_UPSTREAM_URL: 'http://127.0.0.1:5890',
            BRIDGE_UPSTREAM_KEY: 'secret-upstream-key',
            BRIDGE_MODEL: 'VCPModelAuto'
        }, { fetchImpl: fakeFetch });

        const doctorResponse = await fetch(`http://127.0.0.1:${port}/doctor`);
        const doctor = await doctorResponse.json();
        const configResponse = await fetch(`http://127.0.0.1:${port}/doctor/codex-config`);
        const codexConfig = await configResponse.text();

        assert.equal(doctorResponse.status, 200);
        assert.equal(doctor.profile, 'codex-vcp-memory');
        assert.equal(doctor.codex.recommendedBaseUrl, `http://127.0.0.1:${port}/v1`);
        assert.equal(JSON.stringify(doctor).includes('secret-upstream-key'), false);
        assert.equal(configResponse.status, 200);
        assert.match(configResponse.headers.get('content-type'), /text\/plain/);
        assert.match(codexConfig, new RegExp(`base_url = "http://127\\.0\\.0\\.1:${port}/v1"`));
        assert.match(codexConfig, /model = "VCPModelAuto"/);
    } finally {
        await plugin.shutdown();
    }
});

test('client key protects local bridge endpoints without leaking the key', async () => {
    const port = await getFreePort();
    const fakeFetch = async () => {
        throw new Error('test should not call upstream');
    };

    try {
        await plugin.initialize({
            BRIDGE_ENABLED: true,
            BRIDGE_BIND_HOST: '127.0.0.1',
            BRIDGE_PORT: port,
            BRIDGE_CLIENT_KEY: 'client-key'
        }, { fetchImpl: fakeFetch });

        const rejected = await fetch(`http://127.0.0.1:${port}/health`);
        const rejectedBody = await rejected.json();
        const accepted = await fetch(`http://127.0.0.1:${port}/health`, {
            headers: { Authorization: 'Bearer client-key' }
        });
        const acceptedBody = await accepted.json();

        assert.equal(rejected.status, 401);
        assert.equal(rejectedBody.error.type, 'unauthorized');
        assert.equal(JSON.stringify(rejectedBody).includes('client-key'), false);
        assert.equal(accepted.status, 200);
        assert.equal(acceptedBody.clientAuth, 'enabled');
    } finally {
        await plugin.shutdown();
    }
});

test('browser origin guard rejects unknown origins and allows same loopback origin', async () => {
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

        const rejected = await fetch(`http://127.0.0.1:${port}/health`, {
            headers: { Origin: 'http://evil.example.test' }
        });
        const accepted = await fetch(`http://127.0.0.1:${port}/health`, {
            headers: { Origin: `http://127.0.0.1:${port}` }
        });

        assert.equal(rejected.status, 403);
        assert.equal(accepted.status, 200);
    } finally {
        await plugin.shutdown();
    }
});

test('rate limit rejects excess local requests per minute', async () => {
    const port = await getFreePort();
    const fakeFetch = async () => {
        throw new Error('test should not call upstream');
    };

    try {
        await plugin.initialize({
            BRIDGE_ENABLED: true,
            BRIDGE_BIND_HOST: '127.0.0.1',
            BRIDGE_PORT: port,
            BRIDGE_RATE_LIMIT_RPM: 1
        }, { fetchImpl: fakeFetch });

        const first = await fetch(`http://127.0.0.1:${port}/health`);
        const second = await fetch(`http://127.0.0.1:${port}/health`);
        const secondBody = await second.json();

        assert.equal(first.status, 200);
        assert.equal(second.status, 429);
        assert.equal(second.headers.get('retry-after'), '60');
        assert.equal(secondBody.error.type, 'rate_limit_exceeded');
    } finally {
        await plugin.shutdown();
    }
});

test('rate limit helper resets after its window', () => {
    const config = createRuntimeConfig({ BRIDGE_RATE_LIMIT_RPM: 1 });
    const req = { ip: 'unit-rate-limit-helper', socket: { remoteAddress: '127.0.0.1' } };

    assert.equal(checkRateLimit(req, config, 1000).allowed, true);
    assert.equal(checkRateLimit(req, config, 2000).allowed, false);
    assert.equal(checkRateLimit(req, config, 62000).allowed, true);
});

test('connect timeout returns sanitized upstream timeout error', async () => {
    const port = await getFreePort();
    const fakeFetch = async (_url, options = {}) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
        });
    });

    try {
        await plugin.initialize({
            BRIDGE_ENABLED: true,
            BRIDGE_BIND_HOST: '127.0.0.1',
            BRIDGE_PORT: port,
            BRIDGE_UPSTREAM_CONNECT_TIMEOUT_MS: 10,
            BRIDGE_UPSTREAM_TOTAL_TIMEOUT_MS: 0
        }, { fetchImpl: fakeFetch });

        const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'gpt-test',
                messages: [{ role: 'user', content: 'hello' }]
            })
        });
        const body = await response.json();

        assert.equal(response.status, 502);
        assert.equal(body.error.type, 'connect_timeout');
        assert.equal(JSON.stringify(body).includes('aborted'), false);
    } finally {
        await plugin.shutdown();
    }
});

test('upstream HTTP errors pass through without response transformation', async () => {
    const port = await getFreePort();
    const fakeFetch = async () => new Response(JSON.stringify({
        error: { message: 'upstream unavailable', type: 'provider_error' }
    }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
    });

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
            body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
        });
        const body = await response.json();

        assert.equal(response.status, 503);
        assert.deepEqual(body.error, { message: 'upstream unavailable', type: 'provider_error' });
    } finally {
        await plugin.shutdown();
    }
});

test('malformed upstream SSE lines are ignored while valid chunks continue', async () => {
    const port = await getFreePort();
    const fakeFetch = async () => createDelayedSseResponse([
        [
            'data: {not-json',
            '',
            'data: {"model":"gpt-route","choices":[{"delta":{"content":"valid"}}]}',
            '',
            'data: [DONE]',
            ''
        ].join('\n')
    ], 1);

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
            body: JSON.stringify({ model: 'gpt-route', input: 'hello', stream: true })
        });
        const payload = await response.text();

        assert.equal(response.status, 200);
        assert.match(payload, /"delta":"valid"/);
        assert.match(payload, /data: \[DONE\]/);
    } finally {
        await plugin.shutdown();
    }
});

test('idle timeout interrupts a stalled SSE reader', async () => {
    const body = new Readable({ read() {} });
    const lines = [];
    body.push('data: {"ok":true}\n\n');

    await assert.rejects(
        readSseLines(body, line => {
            lines.push(line);
        }, { idleTimeoutMs: 20 }),
        error => error.name === 'BridgeTimeoutError' && error.timeoutType === 'idle'
    );
    assert.deepEqual(lines, ['data: {"ok":true}', '']);
});

test.after(async () => {
    await plugin.shutdown();
});
