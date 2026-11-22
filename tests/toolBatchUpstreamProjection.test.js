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

test('upstream projection strips display names only and never mutates history', () => {
    const roles = ['system', 'developer', 'user', 'assistant', 'function', 'tool'];
    const messages = roles.map(role => Object.freeze({ role, name: `名称-${role}`, content: 'text' }));
    const body = Object.freeze({ messages: Object.freeze(messages) });
    const projected = projectToolBatchForUpstream(body);
    assert.deepEqual(projected.messages.map(message => message.name),
        [undefined, undefined, undefined, undefined, '名称-function', '名称-tool']);
    assert.deepEqual(body.messages.map(message => message.name), roles.map(role => `名称-${role}`));
    assert.equal(projected.messages[4], messages[4]);
    assert.equal(projected.messages[5], messages[5]);
    assert.deepEqual(projectToolBatchForUpstream(projected), projected);
});

function response(stream, text) {
    const choices = [{ [stream ? 'delta' : 'message']: { content: text }, finish_reason: 'stop' }];
    return stream
        ? { ok: true, body: Readable.from([`data: ${JSON.stringify({ choices })}\n\ndata: [DONE]\n\n`]) }
        : { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify({ choices })) };
}

for (const stream of [false, true]) {
    for (const scenario of ['text', 'json-file', 'scalar', 'multimodal', 'translated', 'audio-only', 'archery', 'batch-text', 'batch-media', 'batch-archery']) {
        test(`actual upstream request stream=${stream} receipt=${scenario}`, async () => {
            const archery = scenario === 'archery' || scenario === 'batch-archery';
            const batch = scenario.startsWith('batch-');
            const history = roleDivider.process([{ role: 'assistant', content: wrapper }]);
            history[0].name = 'Nova';
            let upstream;
            let executorHistory;
            let translatedInput;
            let ragText;
            const header = { type: 'text', text: '<!-- VCP_TOOL_PAYLOAD -->\nResults:' };
            const footer = { type: 'text', text: '<!-- VCP_TOOL_PAYLOAD_END -->' };
            const first = { type: 'text', text: payload };
            const last = { type: 'text', text: '# 读取内容\n第一行\n第二行' };
            const jsonFile = { type: 'text', text: '{\n  "enabled": true,\n  "value": "原文"\n}\n' };
            const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } };
            const audio = { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } };
            const description = { type: 'text', text: '图片转写' };
            const scalar = { type: 'text', text: '###计算结果：0.3333333333###，请将结果转告用户' };
            const legacy = { type: 'text', text: JSON.stringify({ original_plugin_output: scalar.text, timestamp: 'test-time' }) };
            const content = {
                text: [first, last], 'json-file': [first, jsonFile], scalar: [legacy], multimodal: [first, image, audio, last],
                translated: [first, image, audio, last], 'audio-only': [audio], archery: [first],
                'batch-text': [first, last], 'batch-media': [first, image, audio, last], 'batch-archery': [first]
            }[scenario];
            const before = JSON.stringify(content);
            const result = { success: !archery, raw: payload, content };
            if (scenario === 'scalar') result.contentForAI = [scalar];
            const second = { success: !archery, content: [scalar] };
            let finishSecond;
            const secondFinished = new Promise(resolve => { finishSecond = resolve; });
            const ctx = {
                originalBody: { model: 'test', messages: history },
                shouldProcessMedia: scenario === 'translated',
                pluginManager: {
                    messagePreprocessors: new Map([['MultiModalProcessor', {}]]),
                    executeMessagePreprocessor: async (_name, messages) => {
                        translatedInput = messages[0];
                        return [{ ...translatedInput, content: [header, first, description, audio, last] }];
                    }
                },
                RAGMemoRefresh: true,
                _refreshRagBlocksIfNeeded: async (messages, data) => {
                    ragText = data.toolResultsText;
                    return messages;
                },
                abortController: new AbortController(), apiRetries: 1,
                ToolCallParser: {
                    parse: text => text !== 'CALL' ? [] : batch
                        ? [{ name: 'Demo' }, { name: 'Calculator' }] : [{ name: 'Demo' }],
                    separate: calls => ({ normal: archery ? [] : calls, archery: archery ? calls : [] })
                },
                toolExecutor: {
                    execute: async (call, _ip, messages) => {
                        executorHistory = messages;
                        if (call.name === 'Calculator') {
                            finishSecond();
                            return second;
                        }
                        if (batch) await secondFinished;
                        return result;
                    },
                    executeAll: async (_calls, _ip, messages) => {
                        executorHistory = messages;
                        return batch ? [result, second] : [result];
                    }
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
            assert.equal(executorHistory[0].name, 'Nova');
            assert.equal(Object.hasOwn(upstream.messages[0], 'name'), false);
            assert.equal(ctx.originalBody.messages, history);
            assert.equal(history[0].name, 'Nova');
            const expected = {
                text: [first, last], 'json-file': [first, jsonFile], scalar: [scalar], multimodal: [first, image, audio, last],
                translated: [first, description, audio, last], 'audio-only': [audio],
                archery: [{ type: 'text', text: `[异步工具 "Demo" 返回了错误，请注意]:\n${payload}` }]
            }[scenario];
            let expectedContent;
            if (scenario === 'batch-media') {
                expectedContent = [header, { type: 'text', text: '[1] Demo' }, ...content,
                    { type: 'text', text: '[2] Calculator' }, scalar, footer];
            } else if (scenario === 'batch-text') {
                expectedContent = `${header.text}\n[1] Demo\n${first.text}\n\n${last.text}\n\n[2] Calculator\n${scalar.text}\n${footer.text}`;
            } else if (scenario === 'batch-archery') {
                expectedContent = `${header.text}\n[1] Demo\n[异步工具 "Demo" 返回了错误，请注意]:\n${first.text}\n\n[2] Calculator\n[异步工具 "Calculator" 返回了错误，请注意]:\n${scalar.text}\n${footer.text}`;
            } else {
                expectedContent = ['multimodal', 'translated', 'audio-only'].includes(scenario)
                    ? [header, ...expected, footer]
                    : `${header.text} ${expected.map(part => part.text).join('\n\n')}\n${footer.text}`;
            }
            assert.deepEqual(upstream.messages.at(-1), { role: 'user', content: expectedContent });
            assert.equal(JSON.stringify(content), before, 'does not mutate original tool result');
            if (scenario === 'translated') {
                assert.deepEqual(translatedInput, { role: 'user', content: [header, ...content] });
            } else {
                assert.equal(translatedInput, undefined);
            }
            if (!archery) {
                assert.deepEqual(JSON.parse(ragText), [...content, ...(batch ? [scalar] : [])].map(part =>
                    part === image ? { ...part, image_url: { ...part.image_url, url: '[Omitted]' } } : part));
            }
        });
    }
}