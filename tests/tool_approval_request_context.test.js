const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');

const pluginManager = require('../Plugin');
const toolCallRecordStore = require('../modules/toolCallRecordStore');

test.after(() => {
  pluginManager.toolApprovalManager?.shutdown?.();
  toolCallRecordStore.shutdown();
});
const TOOL_NAME = 'HostIntegrationApprovalFixture';

function installApprovalFixture(t) {
  const previousPlugin = pluginManager.plugins.get(TOOL_NAME);
  const previousService = pluginManager.serviceModules.get(TOOL_NAME);
  const previousApprovalManager = pluginManager.toolApprovalManager;
  const previousWebSocketServer = pluginManager.webSocketServer;

  pluginManager.plugins.set(TOOL_NAME, {
    name: TOOL_NAME,
    pluginType: 'hybridservice',
    communication: { protocol: 'direct', timeout: 1000 },
    isDistributed: false
  });
  pluginManager.serviceModules.set(TOOL_NAME, {
    module: {
      async processToolCall() {
        return { status: 'success', result: { accepted: true } };
      }
    }
  });
  pluginManager.toolApprovalManager = {
    getApprovalDecision() {
      return { requiresApproval: true, notifyAiOnReject: true };
    },
    getTimeoutMs() {
      return 5000;
    },
    getPrivacyProtectionConfig() {
      return { enabled: false };
    }
  };
  pluginManager.webSocketServer = {
    broadcast() {},
    cancelVcpLogApprovalCache() {}
  };

  t.after(() => {
    for (const [requestId, pending] of pluginManager.pendingApprovals) {
      clearTimeout(pending.timeoutId);
      pluginManager.pendingApprovals.delete(requestId);
      pending.reject(new Error('test cleanup'));
    }
    if (previousPlugin === undefined) pluginManager.plugins.delete(TOOL_NAME);
    else pluginManager.plugins.set(TOOL_NAME, previousPlugin);
    if (previousService === undefined) pluginManager.serviceModules.delete(TOOL_NAME);
    else pluginManager.serviceModules.set(TOOL_NAME, previousService);
    pluginManager.toolApprovalManager = previousApprovalManager;
    pluginManager.webSocketServer = previousWebSocketServer;
    pluginManager.removeAllListeners('tool_approval_request');
  });
}

async function startApproval(requestContext, toolArgs = { command: 'safe-fixture' }) {
  const eventPromise = once(pluginManager, 'tool_approval_request');
  const callPromise = pluginManager.processToolCall(
    TOOL_NAME,
    toolArgs,
    '127.0.0.1',
    'post',
    { requestContext }
  );
  callPromise.catch(() => {});
  let timeoutId;
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error('tool_approval_request event was not emitted')), 250);
  });
  const [event] = await Promise.race([eventPromise, timeoutPromise]);
  clearTimeout(timeoutId);
  return { event, callPromise };
}

test('approval event carries only normalized parent request context', async (t) => {
  t.mock.method(console, 'log', () => {});
  installApprovalFixture(t);

  const { event, callPromise } = await startApproval(
    {
      parentRequestId: 'tg-request-123',
      parentMessageId: 'tg-message-456',
      telegramUserId: 'telegram-user-marker',
      telegramChatId: 'telegram-chat-marker',
      authorization: 'Bearer approval-marker'
    },
    {
      command: 'model-command-marker',
      maid: 'model-maid-marker',
      prompt: 'model-argument-marker'
    }
  );

  assert.equal(event.type, 'tool_approval_request');
  assert.equal(event.data.parentRequestId, 'tg-request-123');
  assert.equal(event.data.parentMessageId, 'tg-message-456');
  assert.equal(event.data.correlationVersion, 1);

  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes('telegram-user-marker'), false);
  assert.equal(serialized.includes('telegram-chat-marker'), false);
  assert.equal(serialized.includes('Bearer approval-marker'), false);
  assert.equal(serialized.includes('model-command-marker'), false);
  assert.equal(serialized.includes('model-maid-marker'), false);
  assert.equal(serialized.includes('model-argument-marker'), false);
  assert.equal(Object.hasOwn(event.data, 'telegramUserId'), false);
  assert.equal(Object.hasOwn(event.data, 'telegramChatId'), false);
  assert.equal(Object.hasOwn(event.data, 'authorization'), false);
  assert.equal(Object.hasOwn(event.data, 'maid'), false);
  assert.equal(Object.hasOwn(event.data, 'args'), false);

  assert.equal(pluginManager.handleApprovalResponse(event.data.requestId, true, 'approved in test'), true);
  await callPromise;
});

test('approval dispatch continues after one listener throws', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  installApprovalFixture(t);

  let firstEvent;
  let resolveFirstEvent;
  const firstEventSeen = new Promise(resolve => {
    resolveFirstEvent = resolve;
  });
  const secondListenerEvents = [];

  pluginManager.on('tool_approval_request', event => {
    firstEvent = event;
    resolveFirstEvent();
    throw new TypeError('approval listener failure');
  });
  pluginManager.on('tool_approval_request', event => {
    secondListenerEvents.push(event);
  });

  const callPromise = pluginManager.processToolCall(
    TOOL_NAME,
    { command: 'listener-isolation-fixture' },
    '127.0.0.1',
    'post',
    {
      requestContext: {
        parentRequestId: 'tg-request-isolation',
        parentMessageId: 'tg-message-isolation'
      }
    }
  );
  callPromise.catch(() => {});

  await firstEventSeen;
  assert.equal(pluginManager.handleApprovalResponse(firstEvent.data.requestId, true), true);
  const result = await callPromise;

  assert.equal(result.accepted, true);
  assert.deepEqual(secondListenerEvents, [firstEvent]);
});

test('missing oversized and unsafe parent IDs normalize to null', async (t) => {
  installApprovalFixture(t);

  const invalidContexts = [
    {},
    {
      parentRequestId: 'x'.repeat(129),
      parentMessageId: 'unsafe id\r\nwith-control'
    }
  ];

  for (const requestContext of invalidContexts) {
    const { event, callPromise } = await startApproval(requestContext);
    assert.equal(event.data.parentRequestId, null);
    assert.equal(event.data.parentMessageId, null);
    pluginManager.handleApprovalResponse(event.data.requestId, true, 'approved in test');
    await callPromise;
  }
});

test('handleApprovalResponse resolves only the pending approval named by the in-process event', async (t) => {
  installApprovalFixture(t);

  const first = await startApproval({
    parentRequestId: 'tg-request-first',
    parentMessageId: 'tg-message-first'
  });
  const second = await startApproval({
    parentRequestId: 'tg-request-second',
    parentMessageId: 'tg-message-second'
  });

  assert.notEqual(first.event.data.requestId, second.event.data.requestId);

  let secondSettled = false;
  second.callPromise.finally(() => {
    secondSettled = true;
  });

  assert.equal(
    pluginManager.handleApprovalResponse(first.event.data.requestId, true, 'approve first only'),
    true
  );
  const firstResult = await first.callPromise;
  assert.equal(firstResult.accepted, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondSettled, false);

  assert.equal(
    pluginManager.handleApprovalResponse(second.event.data.requestId, true, 'approve second'),
    true
  );
  const secondResult = await second.callPromise;
  assert.equal(secondResult.accepted, true);
  assert.equal(pluginManager.handleApprovalResponse('approve-not-pending', true), false);
});

test('legacy approval change preview is preserved and excluded from the bridge event', async t => {
  t.mock.method(console, 'log', () => {});
  installApprovalFixture(t);
  let legacy;
  pluginManager.webSocketServer.broadcast = event => { legacy=event; };
  const {event,callPromise}=await startApproval(
    {parentRequestId:'preview-request',parentMessageId:'preview-message'},
    {command:'edit',target:'old-fixture',replace:'new-fixture'},
  );
  assert.deepEqual(legacy.data.changePreview,{target:'old-fixture',replace:'new-fixture'});
  assert.equal(Object.hasOwn(event.data,'changePreview'),false);
  assert.equal(Object.hasOwn(event.data,'args'),false);
  pluginManager.handleApprovalResponse(event.data.requestId,true,'fixture approval');
  await callPromise;
});
