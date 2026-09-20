const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const ToolExecutor = require('../modules/vcpLoop/toolExecutor');
const pluginManager = require('../Plugin');
const toolCallRecordStore = require('../modules/toolCallRecordStore');

test.after(() => {
  pluginManager.toolApprovalManager?.shutdown?.();
});
function makeAsyncPluginManager() {
  const manager = new EventEmitter();
  manager.getPlugin = () => ({
    name: 'AsyncFixture',
    pluginType: 'asynchronous',
    communication: { protocol: 'stdio' }
  });
  manager.processToolCall = async (name, args, clientIp, sourceNode, executionOptions) => {
    manager.lastExecution = { name, args, clientIp, sourceNode, executionOptions };
    return { taskId: 'async-task-789', status: 'queued' };
  };
  return manager;
}

function installActualAsyncFixture(t, pluginResults) {
  const toolName = 'ActualAsyncFixture';
  const previousPlugin = pluginManager.plugins.get(toolName);
  const results = [...pluginResults];

  pluginManager.plugins.set(toolName, {
    name: toolName,
    pluginType: 'asynchronous',
    communication: { protocol: 'stdio', timeout: 1000 },
    entryPoint: { command: 'fixture-command' },
    basePath: __dirname,
    isDistributed: false
  });
  t.mock.method(pluginManager.toolApprovalManager, 'getApprovalDecision', () => ({
    requiresApproval: false,
    notifyAiOnReject: true
  }));
  t.mock.method(pluginManager, 'executePlugin', async () => ({
    status: 'success',
    result: results.shift()
  }));
  t.mock.method(toolCallRecordStore, 'beginRecord', () => ({ id: 'actual-record' }));
  t.mock.method(toolCallRecordStore, 'finishRecord', () => {});

  t.after(() => {
    if (previousPlugin === undefined) pluginManager.plugins.delete(toolName);
    else pluginManager.plugins.set(toolName, previousPlugin);
    pluginManager.removeAllListeners('async_task_receipt');
  });

  return {
    toolName,
    executor: new ToolExecutor({
      pluginManager,
      webSocketServer: { broadcast() {} },
      debugMode: false,
      vcpToolCode: false,
      getRealAuthCode: async () => null
    })
  };
}

test('trusted asynchronous result emits a receipt before result rewriting', async (t) => {
  t.mock.method(toolCallRecordStore, 'beginRecord', () => ({ id: 'record-1' }));
  t.mock.method(toolCallRecordStore, 'finishRecord', () => {});

  const manager = makeAsyncPluginManager();
  const order = [];
  let receipt = null;
  manager.on('async_task_receipt', event => {
    receipt = event;
    order.push('receipt');
  });

  const executor = new ToolExecutor({
    pluginManager: manager,
    webSocketServer: { broadcast() {} },
    debugMode: false,
    vcpToolCode: false,
    getRealAuthCode: async () => null
  });
  t.mock.method(executor, '_processResult', (name, result) => {
    order.push('rewrite');
    return { success: true, content: [], raw: result };
  });

  await executor.execute(
    { name: 'AsyncFixture', args: {} },
    '127.0.0.1',
    [],
    { parentRequestId: 'tg-request-123', parentMessageId: 'tg-message-456' }
  );

  assert.deepEqual(order, ['receipt', 'rewrite']);
  assert.equal(receipt.type, 'async_task_receipt');
  assert.deepEqual(receipt.data, {
    correlationVersion: 1,
    pluginName: 'AsyncFixture',
    taskId: 'async-task-789',
    parentRequestId: 'tg-request-123',
    parentMessageId: 'tg-message-456'
  });
  assert.deepEqual(manager.lastExecution.executionOptions.requestContext, {
    parentRequestId: 'tg-request-123',
    parentMessageId: 'tg-message-456'
  });
});

test('async receipt dispatch continues to later listeners before result rewriting', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(toolCallRecordStore, 'beginRecord', () => ({ id: 'record-isolation' }));
  t.mock.method(toolCallRecordStore, 'finishRecord', () => {});

  const manager = makeAsyncPluginManager();
  const order = [];
  manager.on('async_task_receipt', () => {
    order.push('first-listener');
    throw new TypeError('async listener failure');
  });
  manager.on('async_task_receipt', () => {
    order.push('second-listener');
  });

  const executor = new ToolExecutor({
    pluginManager: manager,
    webSocketServer: { broadcast() {} },
    debugMode: false,
    vcpToolCode: false,
    getRealAuthCode: async () => null
  });
  t.mock.method(executor, '_processResult', (name, result) => {
    order.push('rewrite');
    return { success: true, content: [], raw: result };
  });

  const result = await executor.execute(
    { name: 'AsyncFixture', args: {} },
    '127.0.0.1',
    [],
    { parentRequestId: 'tg-request-isolation', parentMessageId: 'tg-message-isolation' }
  );

  assert.equal(result.success, true);
  assert.deepEqual(order, ['first-listener', 'second-listener', 'rewrite']);
});

test('model tool arguments cannot forge an async task receipt', async (t) => {
  t.mock.method(toolCallRecordStore, 'beginRecord', () => ({ id: 'record-2' }));
  t.mock.method(toolCallRecordStore, 'finishRecord', () => {});

  const manager = makeAsyncPluginManager();
  manager.processToolCall = async () => ({ status: 'queued' });
  let receiptCount = 0;
  manager.on('async_task_receipt', () => {
    receiptCount += 1;
  });

  const executor = new ToolExecutor({
    pluginManager: manager,
    webSocketServer: { broadcast() {} },
    debugMode: false,
    vcpToolCode: false,
    getRealAuthCode: async () => null
  });

  await executor.execute(
    { name: 'AsyncFixture', args: { taskId: 'model-forged-task' } },
    '127.0.0.1',
    [],
    { parentRequestId: 'tg-request-123', parentMessageId: 'tg-message-456' }
  );

  assert.equal(receiptCount, 0);
});

test('actual PluginManager path emits receipts for supported async result envelopes', async (t) => {
  const fixture = installActualAsyncFixture(t, [
    { taskId: 'canonical-task-123', status: 'queued' },
    [
      'Video generation queued.',
      '{{VCP_ASYNC_RESULT::ActualAsyncFixture::placeholder-task-456}}'
    ].join('\n')
  ]);
  const receipts = [];
  pluginManager.on('async_task_receipt', event => receipts.push(event));

  const canonicalResult = await fixture.executor.execute(
    { name: fixture.toolName, args: { command: 'submit' } },
    '127.0.0.1',
    [],
    { parentRequestId: 'tg-request-canonical', parentMessageId: 'tg-message-canonical' }
  );
  const placeholderResult = await fixture.executor.execute(
    { name: fixture.toolName, args: { command: 'submit' } },
    '127.0.0.1',
    [],
    { parentRequestId: 'tg-request-placeholder', parentMessageId: 'tg-message-placeholder' }
  );

  assert.equal(canonicalResult.raw.taskId, 'canonical-task-123');
  assert.match(
    placeholderResult.raw.original_plugin_output,
    /VCP_ASYNC_RESULT::ActualAsyncFixture::placeholder-task-456/
  );
  assert.deepEqual(receipts.map(event => event.data.taskId), [
    'canonical-task-123',
    'placeholder-task-456'
  ]);
});

test('actual PluginManager path rejects unsupported async identifier aliases', async (t) => {
  const fixture = installActualAsyncFixture(t, [
    { requestId: 'unsupported-request-id' },
    { request_id: 'unsupported-request-snake' },
    { task_id: 'unsupported-task-snake' }
  ]);
  const receipts = [];
  pluginManager.on('async_task_receipt', event => receipts.push(event));

  for (let index = 0; index < 3; index += 1) {
    await fixture.executor.execute(
      { name: fixture.toolName, args: { command: 'submit' } },
      '127.0.0.1',
      [],
      { parentRequestId: `tg-request-alias-${index}`, parentMessageId: `tg-message-alias-${index}` }
    );
  }

  assert.deepEqual(receipts, []);
});

test('async completion event accepts validated route IDs and ignores callback-body IDs', () => {
  const events = [];
  const listener = event => events.push(event);
  pluginManager.on('async_task_completed', listener);

  try {
    assert.equal(
      pluginManager.emitAsyncTaskCompleted('RoutePlugin', 'route-task-123'),
      true
    );
    assert.deepEqual(events, [{
      type: 'async_task_completed',
      data: {
        correlationVersion: 1,
        pluginName: 'RoutePlugin',
        taskId: 'route-task-123'
      }
    }]);

    assert.equal(pluginManager.emitAsyncTaskCompleted('../unsafe', 'route-task-123'), false);
    assert.equal(pluginManager.emitAsyncTaskCompleted('RoutePlugin', 'x'.repeat(129)), false);
    assert.equal(events.length, 1);
  } finally {
    pluginManager.off('async_task_completed', listener);
  }
});
