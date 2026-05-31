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
    resolveUpstreamEndpoint
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
