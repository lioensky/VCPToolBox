'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { createApprovalBroker } = require('../src/approvalBroker');
const { createHostIntegration } = require('../src/hostIntegration');
const { createSessionStore } = require('../src/sessionStore');

const hostRoot = process.env.VCP_TEST_HOST_ROOT;

test('real parent PluginManager pending approval is resolved exactly once by an authorized Telegram callback', {
  skip: !hostRoot,
}, async (t) => {
  const pluginManager = require(path.join(hostRoot, 'Plugin.js'));
  const toolCallRecordStore = require(path.join(hostRoot, 'modules', 'toolCallRecordStore.js'));
  const toolName = 'TelegramBridgeRealApprovalFixture';
  const previousPlugin = pluginManager.plugins.get(toolName);
  const previousService = pluginManager.serviceModules.get(toolName);
  const previousApprovalManager = pluginManager.toolApprovalManager;
  const previousWebSocketServer = pluginManager.webSocketServer;
  let serviceCalls = 0;
  pluginManager.plugins.set(toolName, {
    name: toolName,
    pluginType: 'hybridservice',
    communication: { protocol: 'direct', timeout: 1000 },
    isDistributed: false,
    requiresAdmin: false,
  });
  pluginManager.serviceModules.set(toolName, {
    module: { async processToolCall() { serviceCalls += 1; return { status: 'success', result: true }; } },
  });
  pluginManager.toolApprovalManager = {
    getApprovalDecision: () => ({ requiresApproval: true, notifyAiOnReject: true }),
    getTimeoutMs: () => 5000,
    getPrivacyProtectionConfig: () => ({ enabled: false }),
  };
  pluginManager.webSocketServer = { broadcast() {}, cancelVcpLogApprovalCache() {} };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-real-host-'));
  const stateDir = path.join(root, 'state');
  const session = createSessionStore({
    pluginRoot: root, stateDir, defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40, historyMaxBytes: 262144,
  });
  session.open();
  const scope = session.getOrCreateScope({ chatId: '42', threadId: '0' });
  const ledger = session.createUpdateLedger();
  ledger.acceptBatch([{ updateId: '10', updateType: 'message', payload: { update_id: 10 } }]);
  ledger.authorizeAndQueue('10', {
    requestId: 'request-real', messageId: 'message-real', scopeKey: scope.key,
    orderingKey: 'telegram:42:0', ownerUserId: '42', replayPolicy: 'manual',
  });
  ledger.claimRequest('request-real', 'worker-real');
  const db = new Database(path.join(stateDir, 'telegram.sqlite3'));
  const telegramCalls = [];
  const telegramClient = {
    async sendMessage(params) { telegramCalls.push(params); return { message_id: '55' }; },
    async answerCallbackQuery() { return true; },
    async editMessageText() { return true; },
  };
  let broker;
  const host = createHostIntegration({
    pluginManager,
    onApproval(event) { return broker.handleApprovalEvent(event); },
  });
  broker = createApprovalBroker({
    database: db, ledger, telegramClient, hostIntegration: host,
    clock: () => Date.now(), randomBytes: cryptoRandomBytes,
  });
  host.start();

  t.after(() => {
    host.stop();
    for (const [requestId, pending] of pluginManager.pendingApprovals) {
      clearTimeout(pending.timeoutId);
      pluginManager.pendingApprovals.delete(requestId);
      pending.reject(new Error('test cleanup'));
    }
    if (previousPlugin === undefined) pluginManager.plugins.delete(toolName);
    else pluginManager.plugins.set(toolName, previousPlugin);
    if (previousService === undefined) pluginManager.serviceModules.delete(toolName);
    else pluginManager.serviceModules.set(toolName, previousService);
    pluginManager.toolApprovalManager = previousApprovalManager;
    pluginManager.webSocketServer = previousWebSocketServer;
    db.close();
    session.close();
    fs.rmSync(root, { recursive: true, force: true });
    toolCallRecordStore.shutdown();
    previousApprovalManager?.shutdown?.();
  });

  const callPromise = pluginManager.processToolCall(
    toolName,
    { command: 'safe' },
    '127.0.0.1',
    'telegram',
    { requestContext: { parentRequestId: 'request-real', parentMessageId: 'message-real' } },
  );
  callPromise.catch(() => {});
  const deadline = Date.now() + 1000;
  while (telegramCalls.length === 0) {
    if (Date.now() > deadline) throw new Error('approval event was not delivered');
    await new Promise((resolve) => setImmediate(resolve));
  }
  const data = telegramCalls[0].reply_markup.inline_keyboard[0][0].callback_data;
  const callback = {
    id: 'callback-real', from: { id: 42 }, data,
    message: { message_id: 55, chat: { id: 42, type: 'private' } },
  };
  assert.equal((await broker.handleCallback(callback)).status, 'approved');
  await callPromise;
  assert.equal(serviceCalls, 1);
  assert.equal((await broker.handleCallback(callback)).status, 'refused');
  assert.equal(serviceCalls, 1);
});

test('real parent requiresAdmin still denies execution after Telegram approval without normal Auth', {
  skip: !hostRoot,
}, async (t) => {
  const pluginManager = require(path.join(hostRoot, 'Plugin.js'));
  const toolCallRecordStore = require(path.join(hostRoot, 'modules', 'toolCallRecordStore.js'));
  const toolName = 'TelegramBridgeAdminApprovalFixture';
  const previousPlugin = pluginManager.plugins.get(toolName);
  const previousService = pluginManager.serviceModules.get(toolName);
  const previousApprovalManager = pluginManager.toolApprovalManager;
  const previousWebSocketServer = pluginManager.webSocketServer;
  const previousGetCode = pluginManager._getDecryptedAuthCode;
  let serviceCalls = 0;
  pluginManager.plugins.set(toolName, {
    name: toolName, pluginType: 'hybridservice',
    communication: { protocol: 'direct', timeout: 1000 },
    isDistributed: false, requiresAdmin: true,
  });
  pluginManager.serviceModules.set(toolName, {
    module: { async processToolCall() { serviceCalls += 1; return { status: 'success' }; } },
  });
  pluginManager.toolApprovalManager = {
    getApprovalDecision: () => ({ requiresApproval: true, notifyAiOnReject: true }),
    getTimeoutMs: () => 5000,
    getPrivacyProtectionConfig: () => ({ enabled: false }),
  };
  pluginManager.webSocketServer = { broadcast() {}, cancelVcpLogApprovalCache() {} };
  pluginManager._getDecryptedAuthCode = async () => null;
  t.after(() => {
    for (const [requestId, pending] of pluginManager.pendingApprovals) {
      clearTimeout(pending.timeoutId);
      pluginManager.pendingApprovals.delete(requestId);
      pending.reject(new Error('test cleanup'));
    }
    if (previousPlugin === undefined) pluginManager.plugins.delete(toolName);
    else pluginManager.plugins.set(toolName, previousPlugin);
    if (previousService === undefined) pluginManager.serviceModules.delete(toolName);
    else pluginManager.serviceModules.set(toolName, previousService);
    pluginManager.toolApprovalManager = previousApprovalManager;
    pluginManager.webSocketServer = previousWebSocketServer;
    pluginManager._getDecryptedAuthCode = previousGetCode;
    previousApprovalManager?.shutdown?.();
    toolCallRecordStore.shutdown();
  });
  let approvalId;
  const listener = (event) => { approvalId = event.data.requestId; };
  pluginManager.on('tool_approval_request', listener);
  t.after(() => pluginManager.removeListener('tool_approval_request', listener));
  const callPromise = pluginManager.processToolCall(
    toolName, { command: 'admin' }, '127.0.0.1', 'telegram',
    { requestContext: { parentRequestId: 'request-admin', parentMessageId: 'message-admin' } },
  );
  callPromise.catch(() => {});
  const deadline = Date.now() + 1000;
  while (!approvalId) {
    if (Date.now() > deadline) throw new Error('admin approval event missing');
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pluginManager.handleApprovalResponse(
    approvalId, true, 'Handled by authorized Telegram owner',
  ), true);
  await assert.rejects(callPromise, /requires admin authentication/);
  assert.equal(serviceCalls, 0);
});

function cryptoRandomBytes(size) {
  return require('node:crypto').randomBytes(size);
}
