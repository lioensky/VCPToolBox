const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

test('dispatch isolates listeners and reports delivery without logging payloads', () => {
  const { dispatchIntegrationEvent } = require('../modules/hostIntegration');
  const emitter = new EventEmitter();
  const received = [];
  const logLines = [];

  emitter.on('fixture_event', () => {
    throw new TypeError('fixture listener failure');
  });
  emitter.on('fixture_event', event => {
    received.push(event);
  });

  const event = {
    type: 'fixture_event',
    data: { payloadMarker: 'payload-must-not-be-logged' }
  };
  const status = dispatchIntegrationEvent(emitter, 'fixture_event', event, {
    logger: { error: line => logLines.push(String(line)) }
  });

  assert.deepEqual(received, [event]);
  assert.deepEqual(status, {
    eventName: 'fixture_event',
    total: 2,
    delivered: 1,
    failed: 1,
    ok: false
  });
  assert.equal(logLines.length, 1);
  assert.match(logLines[0], /fixture_event/);
  assert.match(logLines[0], /TypeError/);
  assert.match(logLines[0], /fixture listener failure/);
  assert.equal(logLines[0].includes('payload-must-not-be-logged'), false);
});
test('normalization accepts generated VCP IDs and rejects Windows-unsafe characters', () => {
  const { normalizeIntegrationId } = require('../modules/hostIntegration');

  for (const validId of [
    'approve-1787877000000-abc123',
    'task_1234-5678.example',
    'VCPRequest-ABC_123.456'
  ]) {
    assert.equal(normalizeIntegrationId(validId), validId);
  }

  for (const invalidId of [
    'plugin:task',
    'bad<id',
    'bad>id',
    'bad"id',
    'bad/id',
    'bad\\id',
    'bad|id',
    'bad?id',
    'bad*id'
  ]) {
    assert.equal(normalizeIntegrationId(invalidId), null, invalidId);
  }
});

test('dispatch contains rejected async listeners without delaying later listeners', async (t) => {
  const { dispatchIntegrationEvent } = require('../modules/hostIntegration');
  const emitter = new EventEmitter();
  const order = [];
  const logLines = [];
  const unhandledRejections = [];
  const onUnhandledRejection = reason => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);
  t.after(() => {
    process.off('unhandledRejection', onUnhandledRejection);
  });

  emitter.on('async_fixture_event', async () => {
    order.push('async-listener-invoked');
    throw new TypeError('async listener rejection');
  });
  emitter.on('async_fixture_event', () => {
    order.push('later-listener-invoked');
  });

  const status = dispatchIntegrationEvent(
    emitter,
    'async_fixture_event',
    { type: 'async_fixture_event', data: { payload: 'private-payload-marker' } },
    { logger: { error: line => logLines.push(String(line)) } }
  );

  assert.deepEqual(order, ['async-listener-invoked', 'later-listener-invoked']);
  assert.deepEqual(status, {
    eventName: 'async_fixture_event',
    total: 2,
    delivered: 2,
    failed: 0,
    ok: true
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandledRejections, []);
  assert.equal(logLines.length, 1);
  assert.match(logLines[0], /async_fixture_event/);
  assert.match(logLines[0], /TypeError/);
  assert.match(logLines[0], /async listener rejection/);
  assert.equal(logLines[0].includes('private-payload-marker'), false);
});
