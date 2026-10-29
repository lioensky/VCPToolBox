'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { formatToolResultBatch, projectToolBatchForUpstream } = require('../modules/toolResultBatch');
const roleDivider = require('../modules/roleDivider');
const StreamHandler = require('../modules/handlers/streamHandler');
const NonStreamHandler = require('../modules/handlers/nonStreamHandler');

const quoted = formatToolResultBatch(['code/document literal'], false);
const payload = `原文\n${quoted}\n<<<[TOOL_REQUEST]>>>literal<<<[END_TOOL_REQUEST]>>>`;
const wrapper = formatToolResultBatch([payload]);
const project = (content, role = 'assistant') =>
    projectToolBatchForUpstream({ messages: [{ role, content }] }).messages[0].content;

test('only the two outer wrapper markers change before and after role splitting', () => {
    for (const messages of [
        [{ role: 'assistant', content: `before${wrapper}after` }],
        roleDivider.process([{ role: 'assistant', content: `before${wrapper}after` }])
    ]) {
        const body = { model: 'test', messages };
        const snapshot = JSON.stringify(body);
        const output = projectToolBatchForUpstream(body);
        const text = output.messages.map(m => m.content).join('');
        assert.ok(text.includes(payload), 'nested protocol and source text remain byte-for-byte');
        assert.equal((text.match(/【工具返回批次开始｜时间：/g) || []).length, 1);
        assert.equal((text.match(/【工具返回批次结束｜时间：/g) || []).length, 1);
        assert.equal(JSON.stringify(body), snapshot);
        assert.deepEqual(projectToolBatchForUpstream(output), output, 'idempotent');
    }
});

test('tool payloads, tool arguments, ordinary quotations and incomplete wrappers stay unchanged', () => {
    const body = { messages: [
        { role: 'user', content: `<!-- VCP_TOOL_PAYLOAD -->\n${wrapper}` },
        { role: 'tool', content: quoted },
        { role: 'assistant', content: `文档引用：${quoted}引用结束`,
            tool_calls: [{ function: { arguments: JSON.stringify({ code: wrapper }) } }] },
        { role: 'user', content: `源码示例\n${quoted}\n不要修改` },
        { role: 'user', content: quoted.slice(0, quoted.indexOf('<<<[VCP_TOOL_BATCH_END:')) }
    ] };
    assert.deepEqual(projectToolBatchForUpstream(body), body);
});

test('single text multimodal wrapper projects without touching media or attributes', () => {
    const image = { type: 'image_url', image_url: { url: 'https://example.com/a.png' } };
    const content = [{ type: 'text', text: wrapper, custom: 'keep' }, image];
    const output = project(content);
    assert.ok(output[0].text.includes(payload));
    assert.ok(output[0].text.includes('【工具返回批次开始｜时间：'));
    assert.equal(output[0].custom, 'keep');
    assert.equal(output[1], image);
    assert.equal(content[0].text, wrapper);
    const fragments = [{ type: 'text', text: wrapper.slice(0, 50) }, { type: 'text', text: wrapper.slice(50) }];
    assert.equal(project(fragments), fragments, 'ambiguous fragments are untouched');
});

function response(stream, text) {
    const choices = [{ [stream ? 'delta' : 'message']: { content: text }, finish_reason: 'stop' }];
    return stream
        ? { ok: true, body: Readable.from([`data: ${JSON.stringify({ choices })}\n\ndata: [DONE]\n\n`]) }
        : { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify({ choices })) };
}

for (const stream of [false, true]) {
    for (const archery of [false, true]) {
        test(`actual upstream request stream=${stream} archery=${archery}`, async () => {
            const history = roleDivider.process([{ role: 'assistant', content: wrapper }]);
            let upstream;
            let executorHistory;
            const result = { success: !archery, raw: payload, content: [{ type: 'text', text: payload }] };
            const ctx = {
                originalBody: { model: 'test', messages: history },
                pluginManager: { messagePreprocessors: new Map() },
                abortController: new AbortController(), apiRetries: 1,
                ToolCallParser: {
                    parse: text => text === 'CALL' ? [{ name: 'Demo' }] : [],
                    separate: calls => ({ normal: archery ? [] : calls, archery: archery ? calls : [] })
                },
                toolExecutor: {
                    execute: async (_call, _ip, messages) => { executorHistory = messages; return result; },
                    executeAll: async (_calls, _ip, messages) => { executorHistory = messages; return [result]; }
                },
                isToolResultError: () => false,
                fetchWithRetry: async (_url, options) => {
                    upstream = JSON.parse(options.body);
                    return response(stream, 'done');
                }
            };
            const res = {
                writableEnded: false, destroyed: false,
                write: (_value, callback) => { if (callback) callback(); },
                end: () => { res.writableEnded = true; },
                send: () => { res.writableEnded = true; }
            };
            await new (stream ? StreamHandler : NonStreamHandler)(ctx).handle({}, res, response(stream, 'CALL'));
            assert.ok(upstream.messages[0].content.includes('【工具返回批次开始｜时间：'));
            assert.ok(upstream.messages[0].content.includes(payload));
            assert.ok(executorHistory[0].content.includes('<<<[VCP_TOOL_BATCH_START:'));
            assert.equal(ctx.originalBody.messages, history);
            const toolPayload = upstream.messages.at(-1).content;
            assert.ok(toolPayload.startsWith('<!-- VCP_TOOL_PAYLOAD -->'));
            assert.ok(toolPayload.includes('<<<[VCP_TOOL_BATCH_START:'));
            assert.equal(toolPayload.includes('【工具返回批次开始｜时间：'), false);
        });
    }
}