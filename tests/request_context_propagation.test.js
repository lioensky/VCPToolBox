const assert = require('node:assert/strict');
const test = require('node:test');

const {
  bindToolExecutorToOriginalBody,
  deriveRequestContextFromOriginalBody
} = require('../modules/hostIntegration');

test('request context derives only from original body IDs', () => {
  const originalBody = {
    requestId: 'trusted-request-123',
    messageId: 'trusted-message-456',
    authorization: 'Bearer ignored-marker',
    parentRequestId: 'untrusted-parent-request',
    parentMessageId: 'untrusted-parent-message',
    messages: [{
      role: 'assistant',
      content: 'model tool call with requestId=model-request-marker and messageId=model-message-marker'
    }]
  };
  const context = deriveRequestContextFromOriginalBody(originalBody);
  assert.deepEqual(context, {
    parentRequestId: 'trusted-request-123',
    parentMessageId: 'trusted-message-456'
  });
  assert.deepEqual(Object.keys(context).sort(), ['parentMessageId', 'parentRequestId']);
});
test('invalid original body IDs fail closed even when model args contain safe IDs', () => {
  const context = deriveRequestContextFromOriginalBody({
    requestId: 'unsafe request id',
    messageId: 'x'.repeat(129)
  });

  assert.deepEqual(context, {
    parentRequestId: null,
    parentMessageId: null
  });
});

test('bound execute and executeAll pass only trusted original-body context as fourth argument', async () => {
  const calls = [];
  const fakeToolExecutor = {
    async execute(...args) {
      calls.push({ method: 'execute', args });
      return { success: true };
    },
    async executeAll(...args) {
      calls.push({ method: 'executeAll', args });
      return [{ success: true }];
    }
  };
  const binding = bindToolExecutorToOriginalBody(fakeToolExecutor, {
    requestId: 'trusted-request-binding',
    messageId: 'trusted-message-binding',
    authorization: 'Bearer ignored-marker'
  });
  const conflictingToolCall = {
    name: 'FixtureTool',
    args: {
      requestId: 'model-request-conflict',
      messageId: 'model-message-conflict',
      parentRequestId: 'model-parent-conflict',
      parentMessageId: 'model-parent-message-conflict'
    }
  };
  const messages = [{ role: 'assistant', content: 'fixture' }];

  await binding.execute(conflictingToolCall, '127.0.0.1', messages);
  await binding.executeAll([conflictingToolCall], '127.0.0.1', messages);

  const expectedContext = {
    parentRequestId: 'trusted-request-binding',
    parentMessageId: 'trusted-message-binding'
  };
  assert.deepEqual(calls.map(call => call.method), ['execute', 'executeAll']);
  assert.deepEqual(calls[0].args, [conflictingToolCall, '127.0.0.1', messages, expectedContext]);
  assert.deepEqual(calls[1].args, [[conflictingToolCall], '127.0.0.1', messages, expectedContext]);
});
