'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHandoffGate } = require('../modules/vcpLoop/handoffGate');
const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const start = source.indexOf("app.post('/v1/interrupt',");
const end = source.indexOf('\n});', start) + '\n});'.length;
function fixture() {
    let handler;
    const activeRequests = new Map();
    const delayed = [];
    vm.runInNewContext(source.slice(start, end), {
        app: { post(_path, fn) { handler = fn; } }, activeRequests,
        console: { log() {}, error() {} }, setImmediate: fn => fn(),
        setTimeout: fn => delayed.push(fn),
    });
    const controller = new AbortController();
    const gate = createHandoffGate(controller.signal);
    const context = {
        req: { body: { stream: true } }, aborted: false, abortController: controller, handoffGate: gate,
        res: { headersSent: true, writableEnded: false, destroyed: false,
            getHeader: () => 'text/event-stream', write() {}, end() { this.writableEnded = true; } },
    };
    activeRequests.set('r', context);
    const invoke = body => {
        const result = { statusCode: 200 };
        const res = { status(code) { result.statusCode = code; return this; }, json(value) { result.body = value; return this; } };
        handler({ body }, res);
        return result;
    };
    return { invoke, context, gate, activeRequests, delayed };
}
test('actual route distinguishes reservation, cancellation, unknown action and hard Stop', () => {
    const f = fixture();
    assert.equal(f.invoke({ requestId: 'r', action: 'prepare_handoff', handoffId: 'h', revision: 1 }).body.success, true);
    assert.equal(f.context.abortController.signal.aborted, false);
    assert.equal(f.context.res.writableEnded, false);
    assert.equal(f.invoke({ requestId: 'r', action: 'cancel_handoff', handoffId: 'h', revision: 2 }).body.success, true);
    assert.equal(f.invoke({ requestId: 'r', action: 'typo' }).statusCode, 400);
    assert.equal(f.context.aborted, false);
    assert.equal(f.invoke({ messageId: 'r' }).statusCode, 200);
    assert.equal(f.context.abortController.signal.aborted, true);
    assert.equal(f.context.res.writableEnded, true);
    assert.equal(f.invoke({ requestId: 'r', action: 'prepare_handoff', handoffId: 'new', revision: 3 }).body.success, false);
    const replacement = {};
    f.activeRequests.set('r', replacement);
    f.delayed.forEach(fn => fn());
    assert.equal(f.activeRequests.get('r'), replacement);
    f.gate.dispose();
});
test('actual route rejects invalid, completed and unknown reservation targets without aborting', () => {
    const f = fixture();
    assert.equal(f.invoke({ action: 'prepare_handoff' }).statusCode, 400);
    assert.equal(f.invoke({ requestId: 'missing', action: 'prepare_handoff' }).statusCode, 404);
    assert.equal(f.invoke({ requestId: 'r', action: 'prepare_handoff', handoffId: 'h', revision: -1 }).statusCode, 409);
    assert.equal(f.context.aborted, false);
    f.context.res.writableEnded = true;
    assert.equal(f.invoke({ requestId: 'r', action: 'prepare_handoff', handoffId: 'h', revision: 1 }).statusCode, 404);
    f.gate.dispose();
});