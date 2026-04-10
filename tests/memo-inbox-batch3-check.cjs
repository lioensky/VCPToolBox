const assert = require('node:assert/strict');

async function main() {
  const { createTaskRegistry } = require('../Plugin/MemoInboxAPI/taskRegistry.js');
  const { registerMemoInboxWebSocket } = require('../Plugin/MemoInboxAPI/index.js');
  const errorCodes = require('../Plugin/MemoInboxAPI/errorCodes.js');

  assert.equal(typeof createTaskRegistry, 'function');
  assert.equal(typeof registerMemoInboxWebSocket, 'function');
  assert.equal(typeof errorCodes.memoError, 'function');

  const pushedEvents = [];
  const sentMessages = [];
  const wsHandlers = {};

  const wss = {
    registerPluginClientType(regex, clientType, handlers) {
      this.regex = regex;
      this.clientType = clientType;
      wsHandlers.onConnect = handlers.onConnect;
      wsHandlers.onMessage = handlers.onMessage;
      wsHandlers.onClose = handlers.onClose;
    },
    unregisterPluginClientType(clientType) {
      this.unregisteredClientType = clientType;
    },
    sendMessageToClient(clientId, data) {
      sentMessages.push({ clientId, data });
      return true;
    },
    broadcastToPluginClients(clientType, data) {
      pushedEvents.push({ clientType, data });
    },
  };

  const registry = createTaskRegistry({
    ttlMs: 50,
    onTaskEvent(event) {
      pushedEvents.push(event);
    },
  });

  const cleanup = registerMemoInboxWebSocket({ wss, taskRegistry: registry });
  assert.equal(wss.clientType, 'MemoInboxClient');
  assert.match('/vcp-memo-inbox/VCP_Key=abc', wss.regex);

  const fakeClient = { clientId: 'client-1' };
  wsHandlers.onConnect(fakeClient);
  wsHandlers.onMessage(fakeClient, {
    type: 'memo_subscribe_task',
    data: { taskId: 'task-1' },
  });

  const task = registry.createTask({ taskId: 'task-1', type: 'import' });
  assert.equal(task.status, 'accepted');

  registry.updateTask('task-1', { status: 'running', progress: 40, message: 'doing' });
  registry.updateTask('task-1', { status: 'completed', progress: 100, result: { ok: true } });

  assert.equal(registry.getTask('task-1').status, 'completed');
  assert.equal(sentMessages.length >= 2, true);
  assert.equal(
    sentMessages.some((entry) => entry.data.type === 'memo_task_completed'),
    true,
  );

  wsHandlers.onMessage(fakeClient, {
    type: 'memo_unsubscribe_task',
    data: { taskId: 'task-1' },
  });
  wsHandlers.onClose(fakeClient);

  await new Promise((resolve) => setTimeout(resolve, 80));
  registry.cleanupExpiredTasks();
  assert.equal(registry.getTask('task-1'), null);

  cleanup();
  assert.equal(wss.unregisteredClientType, 'MemoInboxClient');

  console.log('memo-inbox-batch3-check:ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
