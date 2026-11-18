'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
    matchesNativeToolIsolation,
    isolateNativeToolsForUpstream,
    isolateNativeToolRequestOptions
} = require('../modules/nativeToolIsolation');

const text = '正文\n<<<[TOOL_REQUEST]>>>\nvalet:「始」Kerr「末」\n<<<[END_TOOL_REQUEST]>>>';
function fixture(model = 'gemini-4-hydrogen') {
    return {
        model, stream: true, tools: [{ type: 'function' }], tool_choice: 'auto',
        functions: [{}], function_call: 'auto', parallel_tool_calls: true,
        toolChoice: 'auto', toolConfig: {}, tool_config: {}, temperature: 0.5,
        messages: [
            { role: 'assistant', content: text, tool_calls: [{ id: 'call1' }],
                function_call: { name: 'demo' }, functionCall: {}, toolCalls: [], reasoning_content: 'keep' },
            { role: 'user', content: [{ type: 'text', text: '{"tool_calls": "literal"}' },
                { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }
        ]
    };
}

test('case-insensitive substring keywords, commas, whitespace and explicit disable', () => {
    assert.equal(matchesNativeToolIsolation('GOOGLE/GEMINI-HYDROGEN', ' hydrogen, ,future '), true);
    assert.equal(matchesNativeToolIsolation('gemini-future', 'hydrogen，Future'), true);
    assert.equal(matchesNativeToolIsolation('claude', 'hydrogen'), false);
    assert.equal(matchesNativeToolIsolation('hydrogen', ' , '), false);
    assert.equal(matchesNativeToolIsolation(null, 'hydrogen'), false);
});

test('both layers remove only structural fields, preserving VCP text, media and original history', () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const output = isolateNativeToolsForUpstream(input, 'hydrogen');
    for (const field of ['tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls',
        'toolChoice', 'toolConfig', 'tool_config']) assert.equal(Object.hasOwn(output, field), false);
    for (const field of ['tool_calls', 'function_call', 'functionCall', 'toolCalls']) {
        assert.equal(Object.hasOwn(output.messages[0], field), false);
    }
    assert.equal(output.messages[0].content, text);
    assert.equal(output.messages[0].reasoning_content, 'keep');
    assert.equal(output.messages[1], input.messages[1]);
    assert.equal(output.temperature, 0.5);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(isolateNativeToolsForUpstream(output, 'hydrogen'), output);
});

test('unmatched/disabled models and malformed request bodies pass through', () => {
    const input = fixture('claude');
    assert.equal(isolateNativeToolsForUpstream(input, 'hydrogen'), input);
    assert.equal(isolateNativeToolsForUpstream(fixture(), '' ).tools.length, 1);
    for (const body of ['not-json', 'null', '[]']) {
        const options = { body };
        assert.equal(isolateNativeToolRequestOptions(options, 'hydrogen'), options);
    }
    assert.deepEqual(isolateNativeToolsForUpstream({ model: 'hydrogen', tools: [] }, 'hydrogen'),
        { model: 'hydrogen' });
});

test('environment defaults to hydrogen, supports multiple keywords and explicit empty', () => {
    const previous = process.env.NativeToolIsolationModels;
    try {
        delete process.env.NativeToolIsolationModels;
        assert.equal(isolateNativeToolsForUpstream(fixture()).tools, undefined);
        process.env.NativeToolIsolationModels = '';
        assert.equal(isolateNativeToolsForUpstream(fixture()).tools.length, 1);
        process.env.NativeToolIsolationModels = 'future,hydrogen';
        assert.equal(isolateNativeToolsForUpstream(fixture('gemini-future')).tools, undefined);
    } finally {
        if (previous === undefined) delete process.env.NativeToolIsolationModels;
        else process.env.NativeToolIsolationModels = previous;
    }
});

test('field-only isolation does not silently rewrite native result message roles', () => {
    const messages = [{ role: 'tool', tool_call_id: 'call1', content: 'result' }];
    const output = isolateNativeToolsForUpstream({ model: 'hydrogen', messages }, 'hydrogen');
    assert.equal(output.messages[0], messages[0]);
});

// Execute the production retry functions with only the network import replaced.
// No handler dependencies, live credentials or real network are involved.
function loadRetry(fetch) {
    const source = fs.readFileSync(path.join(__dirname, '../modules/chatCompletionHandler.js'), 'utf8');
    const start = source.indexOf('function applyModelFallbackForAttempt(');
    const end = source.indexOf('// 剥离 Markdown 代码块', start);
    assert.ok(start >= 0 && end > start);
    const code = source.slice(start, end).replace("await import('node-fetch')", '({ default: mockFetch })');
    assert.notEqual(code, source.slice(start, end));
    return vm.runInNewContext(`${code}\nfetchWithRetry`, {
        mockFetch: fetch,
        isolateNativeToolRequestOptions: options => isolateNativeToolRequestOptions(options, 'hydrogen'),
        AbortController, setTimeout, clearTimeout, console, getFetchAgent: () => undefined
    });
}

for (const stream of [false, true]) {
    test(`actual retry boundary stream=${stream}: unmatched -> hydrogen -> unmatched`, async () => {
        const sent = [];
        const retry = loadRetry(async (_url, options) => {
            sent.push(JSON.parse(options.body));
            return { status: sent.length < 3 ? 503 : 200, statusText: 'test' };
        });
        const options = { method: 'POST', body: JSON.stringify({ ...fixture('normal'), stream }) };
        const before = options.body;
        const response = await retry('https://invalid.test', options, {
            retries: 3, delay: 0, connectionTimeout: 0,
            modelFallbackCandidates: ['normal', 'gemini-HYDROGEN', 'normal-backup']
        });
        assert.equal(response.status, 200);
        assert.equal(sent.length, 3);
        assert.ok(sent[0].tools);
        assert.equal(sent[1].tools, undefined);
        assert.equal(sent[1].messages[0].tool_calls, undefined);
        assert.equal(sent[1].messages[0].content, text);
        assert.ok(sent[2].tools);
        assert.ok(sent[2].messages[0].tool_calls);
        assert.equal(options.body, before);
    });
}

const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const StreamHandler = require('../modules/handlers/streamHandler');
const NonStreamHandler = require('../modules/handlers/nonStreamHandler');

test('StreamHandler strips outbound tool_calls ONLY for NativeToolIsolationModels and preserves them for normal models', async () => {
    const ssePayload = [
        `data: ${JSON.stringify({ model: undefined, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_pf_1', type: 'function', function: { name: 'pf_list_workspaces', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
        'data: [DONE]\n\n'
    ].join('');

    const runStreamForModel = async (model) => {
        const res = {
            writableEnded: false,
            destroyed: false,
            output: '',
            write(chunk, cb) { this.output += chunk; if (cb) cb(); return true; },
            end() { this.writableEnded = true; }
        };
        const handler = new StreamHandler({
            originalBody: { model, messages: [{ role: 'user', content: 'list' }] },
            abortController: new AbortController(),
            ToolCallParser: { parse: () => [] },
            maxVCPLoopStream: 3
        });
        const outcome = await handler.handle({}, res, { ok: true, status: 200, body: Readable.from([Buffer.from(ssePayload)]) });
        return { outcome, output: res.output };
    };

    const isolated = await runStreamForModel('gemini-4-hydrogen');
    assert.doesNotMatch(isolated.output, /call_pf_1|pf_list_workspaces|"finish_reason":"tool_calls"/);
    assert.equal(isolated.outcome.completed, false);

    const normal = await runStreamForModel('gemini-3.8-flash-high');
    assert.match(normal.output, /"id":"call_pf_1"/);
    assert.match(normal.output, /"name":"pf_list_workspaces"/);
    assert.match(normal.output, /"finish_reason":"tool_calls"/);
    assert.doesNotMatch(normal.output, /"finish_reason":"stop"/);
    assert.equal((normal.output.match(/data: \[DONE\]/g) || []).length, 1);
    assert.equal(normal.outcome.completed, true);
});

test('NonStreamHandler strips outbound tool_calls for isolated models and preserves tool_calls + finish_reason for normal models', async () => {
    const makeUpstreamJson = (model) => JSON.stringify({
        id: 'chatcmpl-nonstream-tool',
        model,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_ns_1', type: 'function', function: { name: 'pf_list_workspaces', arguments: '{}' } }]
            },
            finish_reason: 'tool_calls'
        }]
    });

    const runNonStreamForModel = async (model) => {
        const res = new EventEmitter();
        res.writableEnded = false;
        res.destroyed = false;
        res.bodyText = '';
        res.send = (buf) => { res.bodyText = Buffer.from(buf).toString('utf8'); res.writableEnded = true; };
        const handler = new NonStreamHandler({
            originalBody: { model, messages: [{ role: 'user', content: 'list' }] },
            pluginManager: { messagePreprocessors: new Map() },
            abortController: new AbortController(),
            ToolCallParser: { parse: () => [] },
            apiRetries: 1,
            apiRetryDelay: 0,
            maxVCPLoopNonStream: 3
        });
        const raw = makeUpstreamJson(model);
        const outcome = await handler.handle({}, res, { ok: true, arrayBuffer: async () => Buffer.from(raw) });
        return { outcome, json: JSON.parse(res.bodyText) };
    };

    const isolated = await runNonStreamForModel('gemini-4-hydrogen');
    assert.equal(isolated.json.choices[0].message.tool_calls, undefined);
    assert.equal(isolated.json.choices[0].finish_reason, 'stop');
    assert.equal(isolated.outcome.completed, false);

    const normal = await runNonStreamForModel('gemini-3.8-flash-high');
    assert.equal(normal.json.choices[0].message.content, null);
    assert.equal(normal.json.choices[0].message.tool_calls[0].id, 'call_ns_1');
    assert.equal(normal.json.choices[0].finish_reason, 'tool_calls');
    assert.equal(normal.outcome.completed, true);
});