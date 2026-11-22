'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const StreamHandler = require('../modules/handlers/streamHandler');
const NonStreamHandler = require('../modules/handlers/nonStreamHandler');
const ToolCallParser = require('../modules/vcpLoop/toolCallParser');
const ToolExecutor = require('../modules/vcpLoop/toolExecutor');
const recordStore = require('../modules/toolCallRecordStore');
const roleDivider = require('../modules/roleDivider');

const expression = '请使用 {联网搜索} 中的 `VSearch` 与 `UrlFetch`，检索【Lean Mathlib community Levent Alpöge Riemann Hypothesis verification con-leche con-ron 2026】，并读取[https://math.mit.edu/~drew/grh/]确认是否存在官方验证通稿与细节。';
const request = fields => `<<<[TOOL_REQUEST]>>>\n${fields}\n<<<[END_TOOL_REQUEST]>>>`;
const direct = (ink = '') => ['VSearch', 'UrlFetch']
    .map(name => request(`tool_name:「始」${name}「末」${ink}`)).join('\n');
const jev = (ink = '') => request(`JEV:「始」${expression}「末」${ink}`);

function response(stream, text) {
    const choices = [{ [stream ? 'delta' : 'message']: { content: text }, finish_reason: 'stop' }];
    const payload = JSON.stringify({ choices });
    return stream
        ? { ok: true, body: Readable.from([`data: ${payload}\n\ndata: [DONE]\n\n`]) }
        : { ok: true, arrayBuffer: async () => Buffer.from(payload) };
}

for (const stream of [false, true]) {
    test(`JevCall 和直接调用走相同回执链路：stream=${stream}`, async t => {
        const records = [];
        t.mock.method(recordStore, 'beginRecord', ({ toolName }) => {
            const handle = { id: `record-${toolName}`, toolName };
            records.push(handle);
            return handle;
        });
        t.mock.method(recordStore, 'finishRecord', (handle, outcome) => {
            handle.success = outcome.success;
        });

        async function run(firstTurn, markHistory = false) {
            records.length = 0;
            const calls = [];
            let receipt;
            const chunks = [];
            let sent;
            const pluginManager = {
                messagePreprocessors: new Map(),
                getPlugin: () => ({}),
                async processToolCall(name, _args, _ip, source, options) {
                    calls.push(name);
                    assert.equal(source, 'post');
                    assert.equal(options.toolCallRecordHandle.id, `record-${name}`);
                    if (name === 'UrlFetch') throw new Error('模拟网页读取失败');
                    return { content: [{ type: 'text', text: '模拟搜索结果' }] };
                }
            };
            const context = {
                originalBody: { model: 'test', messages: [] },
                pluginManager,
                abortController: new AbortController(),
                enableRoleDivider: true,
                SHOW_VCP_OUTPUT: !markHistory,
                apiRetries: 1,
                ToolCallParser,
                toolExecutor: new ToolExecutor({ pluginManager, webSocketServer: { broadcast() {} } }),
                isToolResultError: () => false,
                async fetchWithRetry(_url, options) {
                    receipt = JSON.parse(options.body).messages.at(-1);
                    return response(stream, 'done');
                }
            };
            const res = {
                writableEnded: false,
                destroyed: false,
                write(value, callback) { chunks.push(value); callback?.(); return true; },
                end() { this.writableEnded = true; },
                send(value) { sent = JSON.parse(value.toString()); this.writableEnded = true; }
            };
            const Handler = stream ? StreamHandler : NonStreamHandler;
            await new Handler(context).handle({}, res, response(stream, firstTurn));
            const text = stream
                ? chunks.join('').split('\n').filter(line => line.startsWith('data: {'))
                    .map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || '').join('')
                : sent.choices[0].message.content;
            const persisted = roleDivider.process([{ role: 'assistant', content: text }])
                .filter(message => message.role === 'user')
                .map(message => message.content.replace(/(<<<\[VCP_TOOL_BATCH_(?:START|END):)[^\]]+/g, '$1TIME'));
            return { receipt, persisted, calls, records: records.map(record => ({ ...record })) };
        }

        const directResult = await run(direct());
        const jevResult = await run(jev());
        assert.deepEqual(jevResult, directResult);
        assert.deepEqual(jevResult.calls, ['VSearch', 'UrlFetch']);
        assert.deepEqual(jevResult.records, [
            { id: 'record-VSearch', toolName: 'VSearch', success: true },
            { id: 'record-UrlFetch', toolName: 'UrlFetch', success: false }
        ]);
        assert.equal(jevResult.receipt.role, 'user');
        assert.match(jevResult.receipt.content, /\[1\] VSearch\n模拟搜索结果[\s\S]*\[2\] UrlFetch\n\[错误\] 执行错误: 模拟网页读取失败/);
        assert.equal(jevResult.persisted.length, 1, '主管线仍按轮持久化一个批次');
        const persisted = jevResult.persisted[0];
        assert.equal(persisted.split('[[VCP调用结果信息汇总:').length - 1, 2);
        assert.match(persisted, /工具名称: VSearch[\s\S]*工具名称: UrlFetch/);
        assert.match(persisted, /VSearch 调用成功 \(记录ID: record-VSearch\)；UrlFetch 调用失败 \(记录ID: record-UrlFetch\)/);

        const ink = '\nink:「始」mark_history「末」';
        const marked = await run(jev(ink), true);
        assert.deepEqual(marked, await run(direct(ink), true));
        assert.deepEqual(marked, jevResult, 'ink 保留两项详情，即使全局详情关闭');
        const unmarked = await run(jev(), true);
        assert.deepEqual(unmarked, await run(direct(), true));
        assert.doesNotMatch(unmarked.persisted[0], /VCP调用结果信息汇总/);
        assert.match(unmarked.persisted[0], /VSearch 调用成功[\s\S]*UrlFetch 调用失败/);

        const invalid = await run(request('JEV:「始」无效表达式「末」'));
        assert.deepEqual(invalid.calls, []);
        assert.deepEqual(invalid.records, []);
        assert.match(invalid.receipt.content, /JEV 规划错误/);
    });
}