'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const StreamHandler = require('../modules/handlers/streamHandler');
const { createHandoffGate } = require('../modules/vcpLoop/handoffGate');
const response = text => ({ ok: true, body: Readable.from([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
]) });
for (const archery of [false, true]) {
    for (const abort of [false, true]) {
        test(`actual loop holds after receipts: archery=${archery} abort=${abort}`, async () => {
            const controller = new AbortController();
            const gate = createHandoffGate(controller.signal);
            gate.control({ action: 'prepare_handoff', handoffId: 'h', revision: 1 });
            let fetches = 0, waiting;
            const reached = new Promise(resolve => { waiting = resolve; });
            const writes = [];
            const result = { success: !archery, raw: 'result', content: [{ type: 'text', text: 'result' }] };
            const ctx = {
                originalBody: { model: 'test', messages: [], requestId: 'r' },
                pluginManager: { messagePreprocessors: new Map() },
                abortController: controller,
                handoffGate: { isReady: () => gate.isReady(), wait() { waiting(); return gate.wait(); } },
                ToolCallParser: {
                    parse: text => text === 'CALL' ? [{ name: 'Demo' }] : [],
                    separate: calls => ({ normal: archery ? [] : calls, archery: archery ? calls : [] }),
                },
                toolExecutor: { execute: async () => result, executeAll: async () => [result] },
                isToolResultError: () => false,
                fetchWithRetry: async () => { fetches++; return response('done'); },
            };
            const res = {
                writableEnded: false, destroyed: false,
                write(value, callback) { writes.push(value); callback?.(); },
                end() { this.writableEnded = true; },
            };
            const pending = new StreamHandler(ctx).handle({}, res, response('CALL'));
            await reached;
            assert.equal(fetches, 0);
            assert.ok(writes.some(text => text.includes('VCP_TOOL_BATCH_END')));
            if (abort) {
                controller.abort();
                await assert.rejects(pending, { name: 'AbortError' });
                assert.equal(fetches, 0);
            } else {
                gate.control({ action: 'cancel_handoff', handoffId: 'h', revision: 2 });
                await pending;
                assert.equal(fetches, 1);
            }
            gate.dispose();
        });
    }
}