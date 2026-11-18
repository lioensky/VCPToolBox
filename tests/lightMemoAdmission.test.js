'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LightMemoAdmission } = require('../modules/knowledgeBase/lightMemoAdmission');

test('bounded FIFO transfers a permit without exceeding concurrency', async () => {
    const gate = new LightMemoAdmission({ concurrency: 1, maxQueue: 1 });
    const release = await gate.acquire();
    const waiting = gate.acquire();
    await assert.rejects(gate.acquire(), /QUEUE_FULL/);
    release();
    release();
    const releaseNext = await waiting;
    assert.equal(gate.active, 1);
    releaseNext();
    assert.equal(gate.active, 0);
});

test('queued cancellation removes only that waiter', async () => {
    const gate = new LightMemoAdmission({ concurrency: 1 });
    const release = await gate.acquire();
    const controller = new AbortController();
    const waiting = gate.acquire(controller.signal);
    controller.abort(new Error('cancelled'));
    await assert.rejects(waiting, /cancelled/);
    assert.equal(gate.queue.length, 0);
    assert.equal(gate.active, 1);
    release();
    assert.equal(gate.active, 0);
});

test('queue deadline does not release running work', async () => {
    const gate = new LightMemoAdmission({ concurrency: 1, timeoutMs: 10 });
    const release = await gate.acquire();
    await assert.rejects(gate.acquire(), /QUEUE_TIMEOUT/);
    assert.equal(gate.active, 1);
    assert.equal(gate.queue.length, 0);
    release();
});

test('already cancelled request consumes no permit', async () => {
    const gate = new LightMemoAdmission();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await assert.rejects(gate.acquire(controller.signal), /cancelled/);
    assert.equal(gate.active, 0);
});