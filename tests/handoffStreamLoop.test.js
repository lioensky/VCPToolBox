'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const StreamHandler = require('../modules/handlers/streamHandler');
const { createHandoffGate } = require('../modules/vcpLoop/handoffGate');
const response = text => ({ ok: true, body: Readable.from([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
]) });
for (const [native, archery] of [[false, false], [false, true], [true, false], [true, true]]) {
    for (const abort of [false, true]) {
        test(`actual loop holds after receipts: native=${native} archery=${archery} abort=${abort}`, { timeout: 4000 }, async () => {
            const controller = new AbortController();
            const gate = createHandoffGate(controller.signal);
            gate.control({ action: 'prepare_handoff', handoffId: 'h', revision: 1 });
            let fetches = 0, waiting, outbound;
            const reached = new Promise(resolve => { waiting = resolve; });
            const writes = [];
            const result = { success: !archery, raw: 'result', recordId: 'tcr-test', content: [{ type: 'text', text: 'result' }] };
            const nativeCall = {
                index: 0, id: 'call_demo', type: 'function',
                function: { name: 'vcptools', arguments: JSON.stringify({ tool_name: 'Demo', ...(archery ? { archery: 'no_reply' } : {}) }) }
            };
            const nativeBatch = archery ? [nativeCall] : [nativeCall, {
                index: 1, id: 'call_other', type: 'function',
                function: { name: 'vcptools', arguments: '{"tool_name":"Other"}' }
            }];
            const executed = [];
            const nativeResponse = () => ({ ok: true, body: Readable.from([
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: nativeBatch }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
            ]) });
            const ctx = {
                originalBody: { model: 'test', messages: [], requestId: 'r' },
                pluginManager: { messagePreprocessors: new Map() },
                abortController: controller,
                ownsNativeVcpTools: native,
                handoffGate: { isReady: () => gate.isReady(), wait() { waiting(); return gate.wait(); } },
                ToolCallParser: {
                    parse: text => text === 'CALL' ? [{ name: 'Demo' }] : [],
                    separate: calls => ({ normal: archery ? [] : calls, archery: archery ? calls : [] }),
                },
                toolExecutor: {
                    execute: async call => { executed.push(call.name); return result; },
                    executeAll: async calls => calls.map(call => {
                        executed.push(call.name);
                        return { ...result, content: [{ type: 'text', text: `result ${call.name}` }] };
                    })
                },
                isToolResultError: () => false,
                fetchWithRetry: async (_url, options) => {
                    fetches++;
                    outbound = JSON.parse(options.body);
                    return response('done');
                },
            };
            const res = {
                writableEnded: false, destroyed: false,
                write(value, callback) { writes.push(value); callback?.(); },
                end() { this.writableEnded = true; },
            };
            const pending = new StreamHandler(ctx).handle({}, res, native ? nativeResponse() : response('CALL'));
            await Promise.race([reached, pending.then(() => assert.fail('stream finished before handoff'))]);
            assert.equal(fetches, 0);
            assert.equal(res.writableEnded, false);
            assert.deepEqual(executed, native && !archery ? ['Demo', 'Other'] : ['Demo']);
            assert.ok(writes.some(text => text.includes('VCP_TOOL_BATCH_END') && text.includes('tcr-test')));
            assert.doesNotMatch(writes.join(''), /\[DONE\]|"finish_reason":"tool_calls"|"tool_calls":/);
            if (abort) {
                controller.abort();
                await assert.rejects(pending, { name: 'AbortError' });
                assert.equal(fetches, 0);
            } else {
                gate.control({ action: 'cancel_handoff', handoffId: 'h', revision: 2 });
                await pending;
                assert.equal(fetches, 1);
                assert.equal(res.writableEnded, true);
                assert.match(writes.join(''), /"content":"done"/);
                assert.equal((writes.join('').match(/data: \[DONE\]/g) || []).length, 1);
                assert.equal(outbound.messages.at(-1).role, native ? 'tool' : 'user');
                if (native) {
                    const expectedIds = nativeBatch.map(call => call.id);
                    const round = outbound.messages.slice(-(1 + expectedIds.length));
                    assert.deepEqual(round[0].tool_calls.map(call => call.id), expectedIds);
                    assert.deepEqual(round.slice(1).map(message => message.tool_call_id), expectedIds);
                    if (!archery) assert.deepEqual(round.slice(1).map(message => message.content), ['result Demo', 'result Other']);
                }
            }
            gate.dispose();
        });
    }
}