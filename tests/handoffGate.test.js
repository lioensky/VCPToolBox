'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandoffGate } = require('../modules/vcpLoop/handoffGate');
const prepare = (revision = 1, handoffId = 'h') => ({ action: 'prepare_handoff', revision, handoffId });
const cancel = (revision = 2, handoffId = 'h') => ({ action: 'cancel_handoff', revision, handoffId });

test('unarmed gate proceeds; cancellation wakes waiting gate', async () => {
    const gate = createHandoffGate(new AbortController().signal);
    await gate.wait();
    assert.equal(gate.control(prepare()).success, true);
    let passed = false;
    const pending = gate.wait().then(() => { passed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(passed, false);
    assert.equal(gate.control(cancel()).success, true);
    await pending;
    assert.equal(passed, true);
    gate.dispose();
});
test('abort wakes gate and cannot be undone by late controls', async () => {
    const controller = new AbortController();
    const gate = createHandoffGate(controller.signal);
    gate.control(prepare());
    const pending = gate.wait();
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(gate.control(prepare(3)).code, 'REQUEST_STOPPED');
    gate.dispose();
});
test('revisions and handoff generations reject stale or conflicting controls', () => {
    const gate = createHandoffGate(new AbortController().signal);
    assert.equal(gate.control(prepare()).success, true);
    assert.equal(gate.control(prepare()).duplicate, true);
    assert.equal(gate.control(cancel(1)).code, 'REVISION_CONFLICT');
    gate.control(cancel());
    gate.control(prepare(3, 'new'));
    assert.equal(gate.control(cancel(4)).code, 'STALE_HANDOFF');
    assert.equal(gate.control(cancel(2)).code, 'STALE_REVISION');
    assert.equal(gate.isReady(), true);
    gate.dispose();
});
test('timeout opens the gate once, and disposal wakes all waiters', async () => {
    const gate = createHandoffGate(new AbortController().signal, { timeoutMs: 15 });
    gate.control(prepare());
    await gate.wait();
    assert.equal(gate.isReady(), false);
    gate.control(prepare(2, 'new'));
    const pending = gate.wait();
    gate.dispose();
    await assert.rejects(pending, { name: 'AbortError' });
});
test('invalid actions and malformed control never arm a gate', () => {
    const gate = createHandoffGate(new AbortController().signal);
    assert.equal(gate.control({ ...prepare(), action: 'wat' }).code, 'INVALID_ACTION');
    assert.equal(gate.control(prepare(NaN)).code, 'INVALID_HANDOFF');
    assert.equal(gate.isReady(), false);
    gate.dispose();
});