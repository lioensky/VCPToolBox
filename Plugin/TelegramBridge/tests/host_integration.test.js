'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  HostIntegrationError,
  createHostIntegration,
} = require('../src/hostIntegration');

function manager(overrides = {}) {
  const emitter = new EventEmitter();
  emitter.getIntegrationCapabilities = () => ({
    hostIntegrationVersion: 1,
    approvalCorrelationVersion: 1,
    asyncCorrelationVersion: 1,
    approvalResponseMethod: 'handleApprovalResponse',
  });
  emitter.handleApprovalResponse = () => true;
  return Object.assign(emitter, overrides);
}

function assertHostError(error, code) {
  assert.equal(error instanceof HostIntegrationError, true);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error), ['code']);
  return true;
}

test('probe requires the exact frozen vcp-host-integration-v1 capability contract', () => {
  const integration = createHostIntegration({ pluginManager: manager(), onApproval() {} });
  assert.deepEqual(integration.probe(), {
    hostIntegrationVersion: 1,
    approvalCorrelationVersion: 1,
    asyncCorrelationVersion: 1,
    approvalResponseMethod: 'handleApprovalResponse',
  });

  for (const capabilities of [
    null,
    { hostIntegrationVersion: 0 },
    {
      hostIntegrationVersion: 1, approvalCorrelationVersion: 2,
      asyncCorrelationVersion: 1, approvalResponseMethod: 'handleApprovalResponse',
    },
    {
      hostIntegrationVersion: 1, approvalCorrelationVersion: 1,
      asyncCorrelationVersion: 1, approvalResponseMethod: 'otherMethod',
    },
  ]) {
    const broken = createHostIntegration({
      pluginManager: manager({ getIntegrationCapabilities: () => capabilities }),
      onApproval() {},
    });
    assert.throws(() => broken.probe(), (error) => assertHostError(error, 'HOST_INTEGRATION_UNAVAILABLE'));
  }
});

test('start is idempotent, stop removes only its exact listener and probe mode does not subscribe', () => {
  const pluginManager = manager();
  const unrelated = () => {};
  pluginManager.on('tool_approval_request', unrelated);
  const integration = createHostIntegration({
    pluginManager, onApproval() {}, onAsyncReceipt() {}, onAsyncCompleted() {},
  });

  integration.probe();
  assert.deepEqual(pluginManager.listeners('tool_approval_request'), [unrelated]);
  assert.equal(pluginManager.listenerCount('async_task_receipt'), 0);
  assert.equal(pluginManager.listenerCount('async_task_completed'), 0);
  integration.start();
  const afterStart = pluginManager.listeners('tool_approval_request');
  assert.equal(afterStart.length, 2);
  assert.equal(pluginManager.listenerCount('async_task_receipt'), 1);
  assert.equal(pluginManager.listenerCount('async_task_completed'), 1);
  integration.start();
  assert.equal(pluginManager.listenerCount('tool_approval_request'), 2);
  integration.stop();
  assert.deepEqual(pluginManager.listeners('tool_approval_request'), [unrelated]);
  assert.equal(pluginManager.listenerCount('async_task_receipt'), 0);
  assert.equal(pluginManager.listenerCount('async_task_completed'), 0);
  integration.stop();
});

test('async receipt and completion events are snapshotted and dispatched only to their handlers', async () => {
  const pluginManager = manager();
  const receipts = [];
  const completions = [];
  const integration = createHostIntegration({
    pluginManager,
    onApproval() {},
    onAsyncReceipt(event) { receipts.push(event); },
    onAsyncCompleted(event) { completions.push(event); },
  });
  integration.start();
  pluginManager.emit('async_task_receipt', {
    type: 'async_task_receipt',
    data: {
      correlationVersion: 1, pluginName: 'AsyncTool', taskId: 'task-1',
      parentRequestId: 'request-1', parentMessageId: 'message-1',
    },
  });
  pluginManager.emit('async_task_completed', {
    type: 'async_task_completed',
    data: { correlationVersion: 1, pluginName: 'AsyncTool', taskId: 'task-1' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(receipts.length, 1);
  assert.equal(completions.length, 1);
  assert.equal(receipts[0].data.parentRequestId, 'request-1');
  assert.equal(completions[0].data.taskId, 'task-1');
});

test('approval event fields are snapshotted synchronously once before asynchronous handling', async () => {
  const pluginManager = manager();
  const reads = new Map();
  const data = {};
  const values = {
    requestId: 'approval-1', parentRequestId: 'request-1', parentMessageId: 'message-1',
    correlationVersion: 1, toolName: 'SafeTool', timestamp: 'fixture-time', approvalTtlMs: 5000,
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(data, key, {
      enumerable: true,
      get() { reads.set(key, (reads.get(key) ?? 0) + 1); return value; },
    });
  }
  let received;
  let release;
  const handled = new Promise((resolve) => { release = resolve; });
  const integration = createHostIntegration({
    pluginManager,
    async onApproval(event) { await handled; received = event; },
  });
  integration.start();
  pluginManager.emit('tool_approval_request', { type: 'tool_approval_request', data });
  values.toolName = 'MutatedTool';
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.data.toolName, 'SafeTool');
  assert.equal(Object.isFrozen(received), true);
  assert.equal(Object.isFrozen(received.data), true);
  assert.equal([...reads.values()].every((count) => count === 1), true);
});

test('respondApproval calls only the injected real response method with the fixed reason', () => {
  const calls = [];
  const pluginManager = manager({
    handleApprovalResponse(...args) { calls.push(args); return true; },
  });
  const integration = createHostIntegration({ pluginManager, onApproval() {} });
  assert.equal(integration.respondApproval('approval-1', true), true);
  assert.deepEqual(calls, [[
    'approval-1', true, 'Handled by authorized Telegram owner',
  ]]);
});

test('invalid event getters and rejected handlers are contained without leaking or unhandled rejection', async () => {
  const pluginManager = manager();
  const integration = createHostIntegration({
    pluginManager,
    onApproval() { return Promise.reject(new Error('handler-secret')); },
  });
  integration.start();
  const hostile = { type: 'tool_approval_request' };
  Object.defineProperty(hostile, 'data', {
    enumerable: true,
    get() { throw new Error('event-secret'); },
  });
  assert.doesNotThrow(() => pluginManager.emit('tool_approval_request', hostile));
  assert.doesNotThrow(() => pluginManager.emit('tool_approval_request', {
    type: 'tool_approval_request',
    data: {
      requestId: 'approval-1', parentRequestId: 'request-1', parentMessageId: 'message-1',
      correlationVersion: 1, toolName: 'SafeTool', timestamp: 'time', approvalTtlMs: 5000,
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));
});
