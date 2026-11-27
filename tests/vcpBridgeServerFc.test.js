'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const express = require('express');

const { _test: bridgeTest, createBridgeApp } = require('../Plugin/VCPBridgeServer/bridgeserver');
const {
    normalizeProfile,
    normalizeBridgeConfig,
    buildConfigFromEnv,
    toEnvCompatConfig,
    resolveTriState
} = require('../Plugin/VCPBridgeServer/bridgeConfig');
const { withNativeToolDebug } = require('../modules/nativeToolDebug');

function listen(target) {
    return new Promise((resolve, reject) => {
        const server = target.listen(0, '127.0.0.1');
        server.once('error', reject);
        server.once('listening', () => resolve({ server, port: server.address().port }));
    });
}

async function close(server) {
    if (!server) return;
    await new Promise(resolve => server.close(resolve));
}

function parseResponsesSse(text) {
    return text
        .split(/\n\n+/)
        .map(b => b.trim())
        .filter(Boolean)
        .map(b => ({
            event: b.match(/^event:\s*([^\n]+)$/m)?.[1]?.trim(),
            data: (() => {
                const line = b.match(/^data:\s*([^\n]+)$/m)?.[1];
                return line ? JSON.parse(line) : null;
            })()
        }));
}

test('bridgeConfig normalizeProfile preserves stripClientTools tri-state', () => {
    assert.equal(normalizeProfile('ask', { stripClientTools: true }).stripClientTools, 'true');
    assert.equal(normalizeProfile('default', {}).stripClientTools, 'inherit');
});

test('attachProtectedChatToolFields drops orphan tool_choice/parallel_tool_calls so 6005 withNativeToolDebug can inject vcptools', () => {
    const emptyToolsSource = { model: 'test', tools: [], tool_choice: 'auto', parallel_tool_calls: true };
    const outbound = bridgeTest.attachProtectedChatToolFields({ model: 'test', messages: [] }, emptyToolsSource);
    assert.equal(Object.hasOwn(outbound, 'tools'), false);
    assert.equal(Object.hasOwn(outbound, 'tool_choice'), false);
    assert.equal(Object.hasOwn(outbound, 'parallel_tool_calls'), false);

    // Arriving at 6005 with VCP_FC_DEBUG=true, vcptools is injected cleanly
    const injected = withNativeToolDebug(outbound, 'true');
    assert.equal(injected.tools[0].function.name, 'vcptools');
    assert.equal(injected.tool_choice, 'auto');

    // Explicit opt-out tool_choice: 'none' is preserved and respected by 6005
    const explicitNone = bridgeTest.attachProtectedChatToolFields(
        { model: 'test', messages: [] },
        { tools: [], tool_choice: 'none', parallel_tool_calls: true }
    );
    assert.equal(explicitNone.tool_choice, 'none');
    assert.equal(Object.hasOwn(explicitNone, 'parallel_tool_calls'), false);
    assert.equal(withNativeToolDebug(explicitNone, 'true'), explicitNone);

    // Strip client tools option removes non-empty client tools too
    const stripped = bridgeTest.attachProtectedChatToolFields(
        { model: 'test', messages: [] },
        { tools: [{ type: 'function', function: { name: 'ide_edit', parameters: {} } }], tool_choice: 'auto', parallel_tool_calls: true },
        { stripClientTools: true }
    );
    assert.equal(Object.hasOwn(stripped, 'tools'), false);
    assert.equal(Object.hasOwn(stripped, 'tool_choice'), false);
    assert.equal(withNativeToolDebug(stripped, 'true').tools[0].function.name, 'vcptools');
});

test('protocolBridge /v1/responses does not leak orphan tool_choice on empty tools', async t => {
    const received = [];
    const upstream = express();
    upstream.use(express.json());
    upstream.post('/v1/chat/completions', (req, res) => {
        received.push(req.body);
        res.json({
            id: 'chatcmpl-1',
            model: req.body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
        });
    });
    const upstreamInfo = await listen(upstream);
    const previousPort = process.env.PORT;
    process.env.PORT = String(upstreamInfo.port);
    delete require.cache[require.resolve('../routes/protocolBridge')];
    const app = express();
    app.use(express.json());
    app.use(require('../routes/protocolBridge'));
    const bridgeInfo = await listen(http.createServer(app));
    t.after(async () => {
        if (previousPort === undefined) delete process.env.PORT;
        else process.env.PORT = previousPort;
        await close(bridgeInfo.server);
        await close(upstreamInfo.server);
    });

    const resp = await fetch(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'test-model',
            input: 'hello',
            tools: [],
            tool_choice: 'auto',
            parallel_tool_calls: true
        })
    });
    assert.equal(resp.status, 200);
    assert.equal(Object.hasOwn(received[0], 'tools'), false);
    assert.equal(Object.hasOwn(received[0], 'tool_choice'), false);
    assert.equal(Object.hasOwn(received[0], 'parallel_tool_calls'), false);
});

test('pipeChatStreamFilteringHostedVcptools drops hosted vcptools display chunk while preserving prose, receipts and normal tools', async () => {
    const hostedFrame = `data: ${JSON.stringify({
        object: 'chat.completion.chunk',
        model: 'test',
        choices: [{
            index: 0,
            delta: {
                tool_calls: [{
                    index: 0,
                    id: 'call_vcp_1',
                    type: 'function',
                    function: { name: 'vcptools', arguments: '{"tool_name":"SciCalculator"}' }
                }]
            },
            finish_reason: null
        }]
    })}\n\n`;
    const otherToolFrame = `data: ${JSON.stringify({
        object: 'chat.completion.chunk',
        model: 'test',
        choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'call_ide_1', type: 'function', function: { name: 'pf_read_code', arguments: '{}' } }] },
            finish_reason: 'tool_calls'
        }]
    })}\n\n`;
    const proseFrame = `data: ${JSON.stringify({
        object: 'chat.completion.chunk',
        model: 'test',
        choices: [{ index: 0, delta: { content: 'Result is 42.' }, finish_reason: 'stop' }]
    })}\n\n`;
    const doneFrame = 'data: [DONE]\n\n';

    const chunks = [];
    const fakeRes = {
        destroyed: false,
        writableEnded: false,
        write(str) { chunks.push(str); }
    };
    const stream = Readable.from([
        Buffer.from(hostedFrame.slice(0, 45)),
        Buffer.from(hostedFrame.slice(45) + proseFrame + otherToolFrame + doneFrame)
    ]);
    await bridgeTest.pipeChatStreamFilteringHostedVcptools(fakeRes, stream);
    const joined = chunks.join('');
    assert.doesNotMatch(joined, /"name":"vcptools"/);
    assert.match(joined, /Result is 42\./);
    assert.match(joined, /pf_read_code/);
    assert.match(joined, /data: \[DONE\]/);
});

test('bridgeserver Responses helpers support instructions, function_call, function_call_output(image) and streaming FC', async () => {
    const messages = bridgeTest.extractFromResponsesInput([
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking step' }] },
        { type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{"city":"Jinan"}' },
        {
            type: 'function_call_output',
            call_id: 'c1',
            output: [
                { type: 'input_text', text: 'Sunny' },
                { type: 'input_image', image_url: 'https://example.com/sun.png', detail: 'low' }
            ]
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Thanks' }] }
    ], 'System instruction');

    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, 'System instruction');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].reasoning_content, 'thinking step');
    assert.equal(messages[1].tool_calls[0].id, 'c1');
    assert.equal(messages[2].role, 'tool');
    assert.equal(messages[2].tool_call_id, 'c1');
    assert.equal(messages[2].content[1].type, 'image_url');
    assert.equal(messages[3].role, 'user');

    // Non-stream output conversion
    const respOut = bridgeTest.buildResponsesOutput({
        id: 'chat-1',
        model: 'gpt-test',
        choices: [{
            message: {
                role: 'assistant',
                reasoning_content: 'r1',
                content: 'Calling tool',
                tool_calls: [{ id: 'c2', type: 'function', function: { name: 'pf_outline', arguments: '{"path":"a.js"}' } }]
            }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }, 'chat', 'gpt-test');
    assert.deepEqual(respOut.output.map(i => i.type), ['reasoning', 'message', 'function_call']);
    assert.equal(respOut.output[2].call_id, 'c2');
    assert.equal(respOut.output[2].name, 'pf_outline');

    // Streaming conversion with hosted vcptools filter enabled
    const sseChunks = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c_host', function: { name: 'vcptools', arguments: '{}' } }] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'step' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Done' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c_ide', type: 'function', function: { name: 'pf_read_code', arguments: '{"path":"x"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
        'data: [DONE]\n\n'
    ];
    let sseOut = '';
    const fakeRes = {
        statusCode: 200,
        headers: {},
        destroyed: false,
        writableEnded: false,
        status(code) { this.statusCode = code; return this; },
        setHeader(k, v) { this.headers[k] = v; },
        write(str) { sseOut += str; return true; },
        end() { this.writableEnded = true; }
    };
    await bridgeTest.sendResponsesStreamFromProtocol(fakeRes, {
        status: 200,
        body: Readable.from(sseChunks.map(s => Buffer.from(s)))
    }, { model: 'gpt-test', apiType: 'chat', filterHostedVcptools: true });

    const events = parseResponsesSse(sseOut);
    const completed = events.find(e => e.event === 'response.completed')?.data?.response;
    assert.ok(completed);
    assert.deepEqual(completed.output.map(i => i.type), ['reasoning', 'message', 'function_call']);
    assert.equal(completed.output[2].name, 'pf_read_code');
    assert.doesNotMatch(sseOut, /vcptools/);
});

test('bridgeConfig exposes BRIDGE_STRIP_CLIENT_TOOLS and BRIDGE_FILTER_HOSTED_VCPTOOLS with tri-state profile inheritance', () => {
    const cfg = normalizeBridgeConfig({
        BRIDGE_STRIP_CLIENT_TOOLS: 'true',
        BRIDGE_FILTER_HOSTED_VCPTOOLS: 'false',
        defaultProfile: 'ask'
    });
    assert.equal(cfg.stripClientTools, true);
    assert.equal(cfg.filterHostedVcptools, false);
    assert.equal(cfg.defaultProfile, 'ask');

    const envBuilt = buildConfigFromEnv({
        BRIDGE_STRIP_CLIENT_TOOLS: 'true',
        BRIDGE_FILTER_HOSTED_VCPTOOLS: 'false'
    });
    assert.equal(envBuilt.stripClientTools, true);
    assert.equal(envBuilt.filterHostedVcptools, false);

    const envBack = toEnvCompatConfig(cfg);
    assert.equal(envBack.BRIDGE_STRIP_CLIENT_TOOLS, true);
    assert.equal(envBack.BRIDGE_FILTER_HOSTED_VCPTOOLS, false);

    const pInherit = normalizeProfile('default', {});
    assert.equal(pInherit.stripClientTools, 'inherit');
    assert.equal(pInherit.filterHostedVcptools, 'inherit');
    assert.equal(resolveTriState(pInherit.stripClientTools, true), true);
    assert.equal(resolveTriState(normalizeProfile('x', { stripClientTools: 'false' }).stripClientTools, true), false);
    assert.equal(resolveTriState(normalizeProfile('y', { stripClientTools: true }).stripClientTools, false), true);
});

test('sanitizeMessagesForUpstream flattens tool history when stripClientTools=true and repairs aborted/orphan tool messages', () => {
    const history = [
        { role: 'user', content: 'run two tools' },
        {
            role: 'assistant',
            content: null,
            tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'pf_read_code', arguments: '{"path":"a.js"}' } },
                { id: 'c2', type: 'function', function: { name: 'pf_outline', arguments: '{"path":"b.js"}' } }
            ]
        },
        { role: 'tool', tool_call_id: 'c1', content: 'file a content' },
        { role: 'tool', tool_call_id: 'orphan_99', content: 'stray output' },
        { role: 'user', content: 'continue' }
    ];

    const stripped = bridgeTest.sanitizeMessagesForUpstream(history, { stripClientTools: true });
    assert.equal(stripped.some(m => m.tool_calls || m.role === 'tool'), false);
    assert.equal(stripped[1].role, 'assistant');
    assert.match(stripped[1].content, /pf_read_code/);
    assert.equal(stripped[2].role, 'user');
    assert.match(stripped[2].content, /file a content/);

    const repaired = bridgeTest.sanitizeMessagesForUpstream(history, { stripClientTools: false });
    assert.deepEqual(repaired.map(m => m.role), ['user', 'assistant', 'tool', 'tool', 'user', 'user']);
    assert.equal(repaired[2].tool_call_id, 'c1');
    assert.equal(repaired[3].tool_call_id, 'c2');
    assert.match(repaired[3].content, /未返回结果/);
    assert.match(repaired[4].content, /孤立工具输出/);
});

test('live createBridgeApp honors defaultProfile, header filter override, Responses 429 passthrough, encrypted_content & abort cascade', async t => {
    let upstreamAborted = false;
    let lastUpstreamBody = null;
    let upstreamMode = 'chat_hosted_vcptools';

    const upstream = express();
    upstream.use(express.json());
    upstream.post('/v1/chat/completions', (req, res) => {
        lastUpstreamBody = req.body;
        if (upstreamMode === '429') {
            return res.status(429).json({ error: { message: 'rate limit', type: 'rate_limit' } });
        }
        if (upstreamMode === 'abort_wait') {
            req.on('close', () => {
                if (!res.writableEnded) upstreamAborted = true;
            });
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n`);
            return;
        }
        if (upstreamMode === 'responses_encrypted') {
            return res.json({
                id: 'chat-enc',
                model: req.body.model,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        reasoning_content: 'think',
                        reasoning_details: [{ type: 'reasoning.encrypted_content', data: 'ENC_BLOB_XYZ' }],
                        content: 'ok'
                    },
                    finish_reason: 'stop'
                }]
            });
        }
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.write(`data: ${JSON.stringify({
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c_host', type: 'function', function: { name: 'vcptools', arguments: '{}' } }] }, finish_reason: null }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    });

    const upstreamInfo = await listen(upstream);
    bridgeTest.applyBridgeRuntimeConfig({
        port: 0,
        upstreamUrl: `http://127.0.0.1:${upstreamInfo.port}`,
        upstreamType: 'chat',
        hijackMode: 'off',
        defaultProfile: 'nonexistent_profile_safe',
        stripClientTools: false,
        filterHostedVcptools: true
    }, {}, true);

    const bridgeInfo = await listen(http.createServer(createBridgeApp()));
    t.after(async () => {
        await close(bridgeInfo.server);
        await close(upstreamInfo.server);
    });

    const health = await (await fetch(`http://127.0.0.1:${bridgeInfo.port}/health`)).json();
    assert.equal(health.defaultProfile, 'nonexistent_profile_safe');
    assert.equal(health.stripClientTools, false);
    assert.equal(health.filterHostedVcptools, true);

    upstreamMode = 'chat_hosted_vcptools';
    const filteredSse = await (await fetch(`http://127.0.0.1:${bridgeInfo.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    })).text();
    assert.doesNotMatch(filteredSse, /"name":"vcptools"/);
    assert.match(filteredSse, /hello/);

    const unfilteredSse = await (await fetch(`http://127.0.0.1:${bridgeInfo.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vcp-filter-hosted-vcptools': 'false' },
        body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    })).text();
    assert.match(unfilteredSse, /"name":"vcptools"/);

    upstreamMode = '429';
    const errResp = await fetch(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'm', stream: true, input: 'hi' })
    });
    assert.equal(errResp.status, 429);
    const errJson = await errResp.json();
    assert.equal(errJson.error.type, 'rate_limit');

    upstreamMode = 'responses_encrypted';
    const encResp = await (await fetch(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'm',
            stream: false,
            input: [
                { type: 'reasoning', encrypted_content: 'PREV_ENC', summary: [{ type: 'summary_text', text: 'prev' }] },
                { type: 'message', role: 'user', content: 'next' }
            ]
        })
    })).json();
    assert.equal(lastUpstreamBody.messages[0].reasoning_details[0].data, 'PREV_ENC');
    assert.equal(encResp.output[0].encrypted_content, 'ENC_BLOB_XYZ');

    upstreamMode = 'abort_wait';
    const ac = new AbortController();
    const abortResp = await fetch(`http://127.0.0.1:${bridgeInfo.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        signal: ac.signal
    });
    setTimeout(() => ac.abort(), 80);
    await assert.rejects(abortResp.text(), /AbortError|aborted/i);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(upstreamAborted, true);
});

test('Pass-3 chaos: SSE event-block header stripping + usage preservation, duplicate tool_call_id, multimodal flatten, merge array system', async () => {
    // 1. SSE block with event/id lines + usage on hosted vcptools frame
    const blockNoUsage = [
        'id: evt_1',
        'event: message',
        `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'v1', function: { name: 'vcptools', arguments: '{}' } }] }, finish_reason: null }]
        })}`,
        '',
        ''
    ].join('\n');
    const blockWithUsage = [
        'id: evt_2',
        `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'v2', function: { name: 'vcptools', arguments: '{}' } }] }, finish_reason: null }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
        })}`,
        '',
        ''
    ].join('\n');
    const normalBlock = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

    const written = [];
    await bridgeTest.pipeChatStreamFilteringHostedVcptools(
        { destroyed: false, writableEnded: false, write(s) { written.push(s); } },
        Readable.from([Buffer.from(blockNoUsage + blockWithUsage + normalBlock)])
    );
    const outText = written.join('');
    assert.doesNotMatch(outText, /evt_1|vcptools/);
    assert.match(outText, /"total_tokens":30/);
    assert.match(outText, /"content":"OK"/);

    // 2. Duplicate tool_call_id & multimodal tool reply flattening
    const dupHistory = [
        {
            role: 'assistant',
            content: null,
            tool_calls: [
                { id: 'dup_1', type: 'function', function: { name: 'a', arguments: '{}' } },
                { id: 'dup_1', type: 'function', function: { name: 'b', arguments: '{}' } }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'dup_1',
            content: [
                { type: 'text', text: 'Chart ready' },
                { type: 'image_url', image_url: { url: 'https://example.com/chart.png' } }
            ]
        }
    ];
    const sanitizedDup = bridgeTest.sanitizeMessagesForUpstream(dupHistory, { stripClientTools: false });
    assert.equal(sanitizedDup[0].role, 'assistant');
    assert.equal(Object.hasOwn(sanitizedDup[0], 'tool_calls'), false);
    assert.equal(sanitizedDup[1].role, 'user');
    assert.equal(Array.isArray(sanitizedDup[1].content), true);
    assert.equal(sanitizedDup[1].content[1].type, 'image_url');

    // 3. System prompt hijack 'merge' mode with array-formatted system content
    const merged = bridgeTest.applySystemPromptHijackWithConfig([
        { role: 'system', content: [{ type: 'text', text: 'Client array system rule' }] },
        { role: 'user', content: 'hi' }
    ], 'Injected top rule', 'merge');
    assert.equal(merged[0].role, 'system');
    assert.match(merged[0].content, /Injected top rule/);
    assert.match(merged[0].content, /Client array system rule/);
    assert.doesNotMatch(merged[0].content, /\[object Object\]/);
});

test('Pass-3 chaos: live /v1/responses input_image, max_output_tokens, tool.strict, mid-stream error, indexless multi-tools, chaotic headers & malformed JSON', async t => {
    let capturedBody = null;
    let mode = 'inspect_chat';

    const upstream = express();
    upstream.use(express.json({ limit: '50mb' }));
    upstream.post('/v1/chat/completions', (req, res) => {
        capturedBody = req.body;
        if (mode === 'stream_mid_error') {
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'half' } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ error: { message: 'Mid-stream quota blown' } })}\n\n`);
            res.end();
            return;
        }
        if (mode === 'stream_indexless_tools_and_enc') {
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.write(`data: ${JSON.stringify({
                choices: [{
                    index: 0,
                    delta: {
                        reasoning_content: 'r',
                        reasoning_details: [{ type: 'reasoning.encrypted_content', data: 'STREAM_ENC_1' }]
                    }
                }]
            })}\n\n`);
            res.write(`data: ${JSON.stringify({
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        tool_calls: [
                            { id: 'c_no_idx_1', type: 'function', function: { name: 'fn_one', arguments: '{"a":1}' } },
                            { id: 'c_no_idx_2', type: 'function', function: { name: 'fn_two', arguments: '{"b":2}' } }
                        ]
                    },
                    finish_reason: 'tool_calls'
                }]
            })}`); // intentionally omit trailing newline to test trailing buffer flush!
            res.end();
            return;
        }
        res.json({
            id: 'chat-ok',
            model: req.body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
        });
    });

    const upstreamInfo = await listen(upstream);
    bridgeTest.applyBridgeRuntimeConfig({
        port: 0,
        upstreamUrl: `http://127.0.0.1:${upstreamInfo.port}`,
        upstreamType: 'chat',
        hijackMode: 'off',
        stripClientTools: true,
        filterHostedVcptools: true
    }, {}, true);

    const bridgeInfo = await listen(http.createServer(createBridgeApp()));
    t.after(async () => {
        await close(bridgeInfo.server);
        await close(upstreamInfo.server);
    });

    // 1. Malformed JSON returns 400 invalid_request_error JSON (never HTML)
    const badJsonResp = await fetch(`http://127.0.0.1:${bridgeInfo.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"broken_json": '
    });
    assert.equal(badJsonResp.status, 400);
    const badJsonBody = await badJsonResp.json();
    assert.equal(badJsonBody.error.type, 'invalid_request_error');

    // 2. Garbage/empty x-vcp-strip-tools header falls back to runtimeConfig (true), while '0' overrides to false!
    await fetch(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-vcp-strip-tools': '   ' // empty header -> inherits runtimeConfig.stripClientTools (true)
        },
        body: JSON.stringify({
            model: 'm',
            max_output_tokens: 4321,
            tools: [{ type: 'function', name: 'my_tool', strict: false, parameters: {} }],
            input: [{
                type: 'message',
                role: 'user',
                content: [
                    { type: 'input_text', text: 'See screenshot' },
                    { type: 'input_image', image_url: 'https://example.com/ui.png', detail: 'high' }
                ]
            }]
        })
    });
    assert.equal(capturedBody.max_tokens, 4321);
    assert.equal(Object.hasOwn(capturedBody, 'tools'), false); // inherited stripClientTools=true!
    assert.equal(Array.isArray(capturedBody.messages[0].content), true);
    assert.equal(capturedBody.messages[0].content[1].image_url.url, 'https://example.com/ui.png');
    assert.equal(capturedBody.messages[0].content[1].image_url.detail, 'high');

    // Now override with x-vcp-strip-tools: '0' -> tools + strict=false preserved!
    await fetch(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vcp-strip-tools': '0' },
        body: JSON.stringify({
            model: 'm',
            tools: [{ type: 'function', name: 'my_tool', strict: false, parameters: {} }],
            input: 'hi'
        })
    });
    assert.equal(capturedBody.tools[0].function.name, 'my_tool');
    assert.equal(capturedBody.tools[0].function.strict, false);

    // 3. Mid-stream error emits response.failed instead of response.completed
    mode = 'stream_mid_error';
    const midErrSse = await (await fetch(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'm', stream: true, input: 'go' })
    })).text();
    const midEvents = parseResponsesSse(midErrSse);
    assert.ok(midEvents.some(e => e.event === 'response.failed'));
    assert.ok(!midEvents.some(e => e.event === 'response.completed'));
    assert.match(midErrSse, /Mid-stream quota blown/);

    // 4. Indexless multi-tool message chunk without trailing newline + streaming encrypted_content
    mode = 'stream_indexless_tools_and_enc';
    const multiSse = await (await fetch(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vcp-strip-tools': 'false' },
        body: JSON.stringify({
            model: 'm',
            stream: true,
            tools: [{ type: 'function', name: 'fn_one', parameters: {} }],
            input: 'go'
        })
    })).text();
    const multiEvents = parseResponsesSse(multiSse);
    const completedResp = multiEvents.find(e => e.event === 'response.completed')?.data?.response;
    assert.ok(completedResp);
    assert.equal(completedResp.output[0].type, 'reasoning');
    assert.equal(completedResp.output[0].encrypted_content, 'STREAM_ENC_1');
    const fcItems = completedResp.output.filter(i => i.type === 'function_call');
    assert.equal(fcItems.length, 2);
    assert.deepEqual(fcItems.map(i => [i.name, i.arguments]), [
        ['fn_one', '{"a":1}'],
        ['fn_two', '{"b":2}']
    ]);
});
