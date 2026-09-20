'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  ApprovalBrokerError,
  createApprovalBroker,
} = require('../src/approvalBroker');
const { createSessionStore } = require('../src/sessionStore');

function assertBrokerError(error, code) {
  assert.equal(error instanceof ApprovalBrokerError, true);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error), ['code']);
  return true;
}

function fixture(t, overrides = {}) {
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-approval-'));
  const stateDir = path.join(pluginRoot, 'state');
  const session = createSessionStore({
    pluginRoot, stateDir, defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40, historyMaxBytes: 262144,
  });
  session.open();
  const scope = session.getOrCreateScope({ chatId: '42', threadId: '0' });
  const ledger = session.createUpdateLedger();
  ledger.acceptBatch([{ updateId: '10', updateType: 'message', payload: { update_id: 10 } }]);
  ledger.authorizeAndQueue('10', {
    requestId: 'request-10', messageId: 'message-10', scopeKey: scope.key,
    orderingKey: 'telegram:42:0', ownerUserId: '42', replayPolicy: 'manual',
  });
  ledger.claimRequest('request-10', 'worker-1');
  const db = new Database(path.join(stateDir, 'telegram.sqlite3'));
  db.pragma('foreign_keys = ON');
  const calls = [];
  const telegramClient = {
    async sendMessage(params) {
      calls.push({ type: 'send', params });
      return { message_id: '55' };
    },
    async answerCallbackQuery(params) {
      calls.push({ type: 'answer', params });
      return true;
    },
    async editMessageText(params) {
      calls.push({ type: 'edit', params });
      return true;
    },
  };
  const hostCalls = [];
  const hostIntegration = {
    respondApproval(approvalId, approved) {
      calls.push({ type: 'host', approvalId, approved });
      hostCalls.push({ approvalId, approved });
      return overrides.hostResult ?? true;
    },
  };
  let now = overrides.now ?? 10_000;
  let randomCall = 0;
  const broker = createApprovalBroker({
    database: db,
    ledger: overrides.ledger ?? ledger,
    telegramClient,
    hostIntegration,
    clock: () => now,
    randomBytes(size) { randomCall += 1; return Buffer.alloc(size, randomCall); },
  });
  t.after(() => {
    db.close();
    session.close();
    fs.rmSync(pluginRoot, { recursive: true, force: true });
  });
  return {
    broker, calls, db, hostCalls, ledger, scope,
    setNow(value) { now = value; },
    telegramClient, hostIntegration,
  };
}

function approvalEvent(overrides = {}) {
  return {
    type: 'tool_approval_request',
    data: {
      requestId: 'approval-1',
      parentRequestId: 'request-10',
      parentMessageId: 'message-10',
      correlationVersion: 1,
      toolName: 'SafeTool',
      timestamp: 'fixture-time',
      approvalTtlMs: 5000,
      ...overrides,
    },
  };
}

test('stopping the parent request rejects its pending Host approval and disables later callbacks', async t => {
  const f = fixture(t);
  await f.broker.handleApprovalEvent(approvalEvent());
  const callback = callbackFrom(f.calls.find(c => c.type === 'send'));
  assert.equal(f.broker.cancelRequest('request-10'), 1);
  assert.deepEqual(f.hostCalls, [{ approvalId: 'approval-1', approved: false }]);
  assert.equal((await f.broker.handleCallback(callback)).status, 'refused');
  assert.equal(f.hostCalls.length, 1);
});

function callbackFrom(sendCall, overrides = {}) {
  const keyboard = sendCall.params.reply_markup.inline_keyboard;
  return {
    id: 'callback-1',
    from: { id: 42 },
    data: keyboard[0][0].callback_data,
    message: {
      message_id: 55,
      chat: { id: 42, type: 'private' },
      ...overrides.message,
    },
    ...overrides,
  };
}

test('valid correlated event persists owner binding and sends privacy-protected signed buttons', async (t) => {
  const item = fixture(t);
  const result = await item.broker.handleApprovalEvent(approvalEvent({
    args: 'must-not-appear', maid: 'must-not-appear', authorization: 'Bearer secret',
  }));
  assert.deepEqual(result, { status: 'sent', approvalId: 'approval-1' });
  assert.equal(item.calls.length, 1);
  const send = item.calls[0];
  assert.equal(send.type, 'send');
  assert.equal(send.params.chat_id, '42');
  assert.equal(send.params.message_thread_id, '0');
  const serialized = JSON.stringify(send.params);
  for (const forbidden of ['request-10', 'message-10', 'must-not-appear', 'Bearer secret']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(serialized.includes('SafeTool'), true);
  const buttons = send.params.reply_markup.inline_keyboard[0];
  assert.equal(buttons.length, 2);
  for (const button of buttons) {
    assert.match(button.callback_data, /^a1\.[ad]\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(button.callback_data.length <= 64, true);
    assert.equal(button.callback_data.includes('approval-1'), false);
  }

  const row = item.db.prepare('SELECT * FROM approvals WHERE approval_id = ?').get('approval-1');
  assert.equal(row.request_id, 'request-10');
  assert.equal(row.parent_message_id, 'message-10');
  assert.equal(row.owner_user_id, '42');
  assert.equal(row.chat_id, '42');
  assert.equal(row.thread_id, '0');
  assert.equal(row.telegram_message_id, '55');
  assert.equal(row.status, 'pending');
  assert.match(row.nonce_hash, /^[a-f0-9]{64}$/);
  assert.equal(serialized.includes(row.nonce_hash), false);
});

test('uncorrelated, QQ-style, wrong-version and unknown-scope events stay invisible and unpersisted', async (t) => {
  const item = fixture(t, {
    ledger: { findOwnedRequestBinding() { return null; } },
  });
  for (const event of [
    approvalEvent({ parentRequestId: null }),
    approvalEvent({ parentRequestId: 'qq-request-1', parentMessageId: 'qq-message-1' }),
    approvalEvent({ correlationVersion: 2 }),
  ]) {
    assert.deepEqual(await item.broker.handleApprovalEvent(event), { status: 'ignored' });
  }
  assert.equal(item.calls.length, 0);
  assert.equal(item.db.prepare('SELECT COUNT(*) AS count FROM approvals').get().count, 0);
});

test('callback is acknowledged before validation and only exact owner/chat/thread/message may act', async (t) => {
  const item = fixture(t);
  await item.broker.handleApprovalEvent(approvalEvent());
  const send = item.calls[0];
  item.calls.length = 0;
  const unauthorized = callbackFrom(send, { from: { id: 99 } });
  assert.deepEqual(await item.broker.handleCallback(unauthorized), { status: 'refused' });
  assert.equal(item.calls[0].type, 'answer');
  assert.equal(item.hostCalls.length, 0);
  assert.equal(item.db.prepare('SELECT status FROM approvals WHERE approval_id = ?').get('approval-1').status, 'pending');

  item.calls.length = 0;
  const wrongMessage = callbackFrom(send, { message: { message_id: 56, chat: { id: 42, type: 'private' } } });
  assert.deepEqual(await item.broker.handleCallback(wrongMessage), { status: 'refused' });
  assert.equal(item.calls[0].type, 'answer');
  assert.equal(item.hostCalls.length, 0);

  item.calls.length = 0;
  const hostile = { id: 'callback-hostile', data: unauthorized.data, from: {}, message: {} };
  Object.defineProperty(hostile.from, 'id', {
    enumerable: true,
    get() { throw new Error('callback-secret'); },
  });
  assert.deepEqual(await item.broker.handleCallback(hostile), { status: 'refused' });
  assert.equal(item.calls[0].type, 'answer');
});

test('valid callback uses pending-to-acting CAS, calls Host once and rejects replay', async (t) => {
  const item = fixture(t);
  await item.broker.handleApprovalEvent(approvalEvent());
  const callback = callbackFrom(item.calls[0]);
  item.calls.length = 0;
  assert.deepEqual(await item.broker.handleCallback(callback), {
    status: 'approved', approvalId: 'approval-1',
  });
  assert.deepEqual(item.calls.slice(0, 2).map((entry) => entry.type), ['answer', 'host']);
  assert.deepEqual(item.hostCalls, [{ approvalId: 'approval-1', approved: true }]);
  assert.equal(item.db.prepare('SELECT status FROM approvals WHERE approval_id = ?').get('approval-1').status, 'approved');

  item.calls.length = 0;
  assert.deepEqual(await item.broker.handleCallback(callback), { status: 'refused' });
  assert.equal(item.calls[0].type, 'answer');
  assert.equal(item.hostCalls.length, 1);
});

test('deny button passes approved=false and a missing host pending approval becomes failed without replay', async (t) => {
  const denied = fixture(t);
  await denied.broker.handleApprovalEvent(approvalEvent());
  const send = denied.calls[0];
  const denyCallback = callbackFrom(send, {
    data: send.params.reply_markup.inline_keyboard[0][1].callback_data,
  });
  assert.equal((await denied.broker.handleCallback(denyCallback)).status, 'rejected');
  assert.deepEqual(denied.hostCalls, [{ approvalId: 'approval-1', approved: false }]);

  const missing = fixture(t, { hostResult: false });
  await missing.broker.handleApprovalEvent(approvalEvent());
  const failed = await missing.broker.handleCallback(callbackFrom(missing.calls[0]));
  assert.deepEqual(failed, { status: 'failed', approvalId: 'approval-1' });
  assert.equal(missing.db.prepare('SELECT status FROM approvals WHERE approval_id = ?')
    .get('approval-1').status, 'failed');
  assert.equal((await missing.broker.handleCallback(callbackFrom(missing.calls[0]))).status, 'refused');
  assert.equal(missing.hostCalls.length, 1);
});

test('expiry and restart invalidate callbacks; acting rows are never replayed', async (t) => {
  const item = fixture(t);
  await item.broker.handleApprovalEvent(approvalEvent({ approvalTtlMs: 1000 }));
  const callback = callbackFrom(item.calls[0]);
  item.setNow(11_001);
  assert.deepEqual(await item.broker.handleCallback(callback), { status: 'expired' });
  assert.equal(item.hostCalls.length, 0);

  item.db.prepare("UPDATE approvals SET status = 'acting' WHERE approval_id = ?").run('approval-1');
  const restarted = createApprovalBroker({
    database: item.db,
    ledger: item.ledger,
    telegramClient: item.telegramClient,
    hostIntegration: item.hostIntegration,
    clock: () => 12_000,
    randomBytes: (size) => Buffer.alloc(size, 9),
  });
  assert.equal(item.db.prepare('SELECT status FROM approvals WHERE approval_id = ?').get('approval-1').status, 'invalidated_restart');
  assert.deepEqual(await restarted.handleCallback(callback), { status: 'refused' });
  assert.equal(item.hostCalls.length, 0);
});

test('admin-like tool approval never stores Auth codes or claims to bypass requiresAdmin', async (t) => {
  const item = fixture(t);
  await item.broker.handleApprovalEvent(approvalEvent({ toolName: 'AdminPlugin' }));
  const serialized = JSON.stringify(item.calls[0].params);
  assert.equal(/\b\d{6}\b/.test(serialized), false);
  assert.equal(serialized.includes('bypass'), false);
  const row = item.db.prepare('SELECT * FROM approvals WHERE approval_id = ?').get('approval-1');
  assert.equal(Object.values(row).some((value) => typeof value === 'string' && /\b\d{6}\b/.test(value)), false);
});
