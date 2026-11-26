'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
        assert.deepEqual(sent.map(body => body.model), ['normal', 'gemini-HYDROGEN', 'normal-backup']);
        for (const actual of sent) {
            assert.deepEqual(actual, { ...JSON.parse(before), model: actual.model });
        }
        assert.equal(options.body, before);
    });
}

const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const StreamHandler = require('../modules/handlers/streamHandler');
const NonStreamHandler = require('../modules/handlers/nonStreamHandler');

test('StreamHandler preserves native FC for Hydrogen and ordinary models', async () => {
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

    const hydrogen = await runStreamForModel('gemini-4-hydrogen');
    assert.match(hydrogen.output, /"id":"call_pf_1"/);
    assert.match(hydrogen.output, /"finish_reason":"tool_calls"/);
    assert.equal(hydrogen.outcome.completed, true);

    const normal = await runStreamForModel('gemini-3.8-flash-high');
    assert.match(normal.output, /"id":"call_pf_1"/);
    assert.match(normal.output, /"name":"pf_list_workspaces"/);
    assert.match(normal.output, /"finish_reason":"tool_calls"/);
    assert.doesNotMatch(normal.output, /"finish_reason":"stop"/);
    assert.equal((normal.output.match(/data: \[DONE\]/g) || []).length, 1);
    assert.equal(normal.outcome.completed, true);
});

test('NonStreamHandler preserves native FC for Hydrogen and ordinary models', async () => {
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

    const hydrogen = await runNonStreamForModel('gemini-4-hydrogen');
    assert.equal(hydrogen.json.choices[0].message.content, null);
    assert.equal(hydrogen.json.choices[0].message.tool_calls[0].id, 'call_ns_1');
    assert.equal(hydrogen.json.choices[0].finish_reason, 'tool_calls');
    assert.equal(hydrogen.outcome.completed, true);

    const normal = await runNonStreamForModel('gemini-3.8-flash-high');
    assert.equal(normal.json.choices[0].message.content, null);
    assert.equal(normal.json.choices[0].message.tool_calls[0].id, 'call_ns_1');
    assert.equal(normal.json.choices[0].finish_reason, 'tool_calls');
    assert.equal(normal.outcome.completed, true);
});

const nativeCalls = [
    { id: 'call_a', type: 'function', function: { name: 'lookup_a', arguments: '{"key":"a"}' } },
    { id: 'call_b', type: 'function', function: { name: 'lookup_b', arguments: '{"key":"b"}' } }
];

test('stream keeps two interleaved FC argument sequences ahead of one native terminal', async () => {
    const frame = (delta, finish_reason = null) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const upstream = frame({ role: 'assistant', content: '' })
        + frame({ tool_calls: [{ ...nativeCalls[0], index: 0, function: { name: 'lookup_a', arguments: '{"key":' } }] })
        + frame({ tool_calls: [{ ...nativeCalls[1], index: 1 }] })
        + frame({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] })
        + frame({}, 'tool_calls') + 'data: [DONE]\n\n';
    const res = {
        output: '', writableEnded: false, destroyed: false,
        write(text, cb) { this.output += text; cb?.(); return true; },
        end() { this.writableEnded = true; }
    };
    const handler = new StreamHandler({
        originalBody: { model: 'hydrogen', messages: [] },
        abortController: new AbortController(),
        ToolCallParser: { parse: () => assert.fail('committed native turns must not execute text') }
    });
    const result = await handler.handle({}, res, {
        ok: true, status: 200, body: Readable.from([Buffer.from(upstream)])
    });
    const choices = res.output.split('\n')
        .filter(line => line.startsWith('data: {'))
        .flatMap(line => JSON.parse(line.slice(6)).choices ?? []);
    const calls = choices.flatMap(choice => choice.delta?.tool_calls || []);
    assert.deepEqual(calls.map(call => call.index), [0, 1, 0]);
    assert.deepEqual(calls.filter(call => call.id).map(call => call.id), ['call_a', 'call_b']);
    assert.equal(calls.filter(call => call.index === 0).map(call => call.function.arguments).join(''), nativeCalls[0].function.arguments);
    assert.deepEqual(choices.filter(choice => choice.finish_reason).map(choice => choice.finish_reason), ['tool_calls']);
    assert.equal((res.output.match(/data: \[DONE\]/g) || []).length, 1);
    assert.equal(result.completed, true);
});

for (const viaTextTool of [false, true]) {
    test(`non-stream keeps the terminal native FC batch; text continuation=${viaTextTool}`, async () => {
        const textTool = 'text request';
        const raw = (id, message, finish_reason) => ({
            ok: true, status: 200,
            arrayBuffer: async () => Buffer.from(JSON.stringify({
                id, choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }]
            }))
        });
        const terminal = raw('native-turn', { content: textTool, tool_calls: nativeCalls }, 'tool_calls');
        const res = new EventEmitter();
        res.writableEnded = false;
        res.destroyed = false;
        res.send = (buf) => { res.json = JSON.parse(buf.toString()); res.writableEnded = true; };
        let executions = 0;
        let continuations = 0;
        const handler = new NonStreamHandler({
            originalBody: { model: 'hydrogen', messages: [{ role: 'user', content: 'test' }] },
            pluginManager: { messagePreprocessors: new Map() },
            abortController: new AbortController(),
            ToolCallParser: {
                parse: () => [{ name: 'demo' }],
                separate: normal => ({ normal, archery: [] })
            },
            toolExecutor: {
                executeAll: async () => {
                    executions++;
                    return [{ success: true, content: [{ type: 'text', text: 'ok' }] }];
                }
            },
            isToolResultError: () => false,
            fetchWithRetry: async () => { continuations++; return terminal; },
            apiRetries: 1,
            apiRetryDelay: 0
        });
        const result = await handler.handle({}, res,
            viaTextTool ? raw('text-turn', { content: textTool }, 'stop') : terminal);
        assert.equal(res.json.id, 'native-turn');
        assert.deepEqual(res.json.choices[0].message.tool_calls, nativeCalls);
        assert.equal(res.json.choices[0].finish_reason, 'tool_calls');
        assert.equal(executions, Number(viaTextTool));
        assert.equal(continuations, Number(viaTextTool));
        assert.equal(result.completed, true);
    });
}