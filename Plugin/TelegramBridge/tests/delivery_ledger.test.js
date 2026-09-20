'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { createAsyncDelivery } = require('../src/asyncDelivery');
const { createSessionStore } = require('../src/sessionStore');

function setup(t, telegramClient) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-delivery-ledger-'));
  const stateDir = path.join(root, 'state');
  const resultsDir = path.join(root, 'VCPAsyncResults');
  fs.mkdirSync(resultsDir, { recursive: true });
  const session = createSessionStore({
    pluginRoot: root, stateDir, defaultAgent: 'ExampleAgent',
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
  fs.writeFileSync(path.join(resultsDir, 'AsyncTool-task-1.json'), JSON.stringify({ result: 'done' }));
  const db = new Database(path.join(stateDir, 'telegram.sqlite3'));
  let now = 1000;
  const make = () => createAsyncDelivery({
    database: db, ledger, telegramClient, asyncResultsDir: resultsDir,
    proactiveEnabled: false, maxResultBytes: 1024 * 1024, clock: () => now,
  });
  const delivery = make();
  delivery.handleReceipt({
    type: 'async_task_receipt', data: {
      correlationVersion: 1, pluginName: 'AsyncTool', taskId: 'task-1',
      parentRequestId: 'request-10', parentMessageId: 'message-10',
    },
  });
  delivery.handleCompleted({
    type: 'async_task_completed',
    data: { correlationVersion: 1, pluginName: 'AsyncTool', taskId: 'task-1' },
  });
  t.after(() => { db.close(); session.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, delivery, make, setNow(value) { now = value; } };
}

function telegramError(code, fields = {}) {
  const error = new Error('telegram fixture');
  error.code = code;
  Object.assign(error, fields);
  return error;
}

test('abort during a send prevents plaintext fallback and further delivery claims', async t => {
  const controller = new AbortController();
  let sends = 0;
  const item = setup(t, { async sendMessage() {
    sends++;
    controller.abort();
    throw telegramError('TELEGRAM_BAD_REQUEST');
  } });
  await item.delivery.processDue(10, { signal: controller.signal });
  assert.equal(sends, 1);
  assert.notEqual(item.db.prepare('SELECT status FROM deliveries').get().status, 'delivered');
});

test('delivery ownership loss prevents claims before network calls', async t => {
  let sends = 0;
  const item = setup(t, { async sendMessage() { sends++; return { message_id: 500 }; } });
  await item.delivery.processDue(10, { canDeliver: () => false });
  assert.equal(sends, 0);
  assert.equal(item.db.prepare('SELECT status FROM deliveries').get().status, 'pending');
});

test('poll backoff during a send still records its retryable rejection', async t => {
  let allowed = true;
  const item = setup(t, { async sendMessage() {
    allowed = false;
    throw telegramError('TELEGRAM_RATE_LIMIT', { retryAfterSec: 1 });
  } });
  await item.delivery.processDue(10, { canDeliver: () => allowed });
  assert.equal(item.db.prepare('SELECT status FROM deliveries').get().status, 'retrying');
});

test('idempotent completion and delivery send exactly once', async (t) => {
  let sends = 0;
  const item = setup(t, {
    async sendMessage() { sends += 1; return { message_id: '500' }; },
  });
  assert.deepEqual(item.delivery.handleCompleted({
    type: 'async_task_completed', data: { correlationVersion: 1, pluginName: 'AsyncTool', taskId: 'task-1' },
  }), { status: 'queued', taskKey: 'AsyncTool:task-1' });
  assert.deepEqual(await item.delivery.processDue(10), { delivered: 1, retrying: 0, deadLetters: 0, needsReview: 0 });
  assert.deepEqual(await item.delivery.processDue(10), { delivered: 0, retrying: 0, deadLetters: 0, needsReview: 0 });
  assert.equal(sends, 1);
});

test('known rate limit retries after restart while permanent errors dead-letter', async (t) => {
  let attempts = 0;
  const item = setup(t, {
    async sendMessage() {
      attempts += 1;
      if (attempts === 1) throw telegramError('TELEGRAM_RATE_LIMIT', { retryAfterSec: 2 });
      return { message_id: '501' };
    },
  });
  assert.deepEqual(await item.delivery.processDue(10), { delivered: 0, retrying: 1, deadLetters: 0, needsReview: 0 });
  item.setNow(3000);
  const restarted = item.make();
  assert.deepEqual(await restarted.processDue(10), { delivered: 1, retrying: 0, deadLetters: 0, needsReview: 0 });

  let forbiddenAttempts = 0;
  const permanent = setup(t, {
    async sendMessage() { forbiddenAttempts += 1; throw telegramError('TELEGRAM_FORBIDDEN'); },
  });
  assert.deepEqual(await permanent.delivery.processDue(10), { delivered: 0, retrying: 0, deadLetters: 1, needsReview: 0 });
  assert.equal(permanent.db.prepare("SELECT COUNT(*) AS count FROM dead_letters WHERE source_type = 'async_delivery'").get().count, 1);
  await permanent.delivery.processDue(10);
  assert.equal(forbiddenAttempts, 1);
});

test('unknown network outcome becomes needs_review and sending rows are quarantined on restart', async (t) => {
  const item = setup(t, {
    async sendMessage() { throw telegramError('TELEGRAM_NETWORK'); },
  });
  assert.deepEqual(await item.delivery.processDue(10), { delivered: 0, retrying: 0, deadLetters: 0, needsReview: 1 });
  assert.equal(item.db.prepare('SELECT status FROM deliveries').get().status, 'needs_review');

  item.db.prepare("UPDATE deliveries SET status='sending', effect_state='started'").run();
  item.make();
  assert.equal(item.db.prepare('SELECT status FROM deliveries').get().status, 'needs_review');
});
