'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { AsyncDeliveryError, createAsyncDelivery } = require('../src/asyncDelivery');
const { createSessionStore } = require('../src/sessionStore');

function assertAsyncError(error, code) {
  assert.equal(error instanceof AsyncDeliveryError, true);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error), ['code']);
  return true;
}

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-async-'));
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
  const db = new Database(path.join(stateDir, 'telegram.sqlite3'));
  db.pragma('foreign_keys = ON');
  let now = overrides.now ?? 1000;
  const sends = [];
  const telegramClient = overrides.telegramClient ?? {
    async sendMessage(params) { sends.push(params); return { message_id: '500' }; },
  };
  const delivery = createAsyncDelivery({
    database: db,
    ledger: overrides.ledger ?? ledger,
    telegramClient,
    asyncResultsDir: resultsDir,
    proactiveEnabled: overrides.proactiveEnabled ?? false,
    maxResultBytes: 1024 * 1024,
    clock: () => now,
    mediaBridge: overrides.mediaBridge,
  });
  t.after(() => {
    db.close(); session.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { db, delivery, ledger, resultsDir, scope, sends, setNow(value) { now = value; } };
}

function receipt(overrides = {}) {
  return {
    type: 'async_task_receipt',
    data: {
      correlationVersion: 1,
      pluginName: 'AsyncTool', taskId: 'task-1',
      parentRequestId: 'request-10', parentMessageId: 'message-10',
      ...overrides,
    },
  };
}

function completed(overrides = {}) {
  return {
    type: 'async_task_completed',
    data: { correlationVersion: 1, pluginName: 'AsyncTool', taskId: 'task-1', ...overrides },
  };
}

test('async text and resolved media are delivered in order and replay stays idempotent', async t => {
  const calls = [];
  const item = fixture(t, {
    telegramClient: { async sendMessage() { calls.push('text'); return { message_id: '501' }; } },
    mediaBridge: {
      async resolve() { return { mediaKind: 'photo', relativePath: 'ExampleAgent/a.png', mime: 'image/png', size: 10, sha256: 'a'.repeat(64), alt: 'image' }; },
      async send() { calls.push('media'); return { messageId: '502' }; },
    },
  });
  item.delivery.handleReceipt(receipt());
  fs.writeFileSync(path.join(item.resultsDir, 'AsyncTool-task-1.json'), JSON.stringify({ result: '完成 ![image](ExampleAgent/a.png)' }));
  item.delivery.handleCompleted(completed());
  await item.delivery.processDue(10);
  assert.deepEqual(calls, ['text', 'media']);
  assert.equal(item.db.prepare('SELECT status FROM async_tasks').get().status, 'delivered');
  await item.delivery.processDue(10);
  assert.deepEqual(calls, ['text', 'media']);
});

test('async backlog never completes a task before its media is prepared', async t=>{
  let textSends=0,mediaSends=0;
  const item=fixture(t,{telegramClient:{async sendMessage(){textSends++;return{message_id:500+textSends};}},
    mediaBridge:{async resolve(){return{mediaKind:'photo',relativePath:'ExampleAgent/a.png',mime:'image/png',size:10,sha256:'a'.repeat(64),alt:'image'};},
      async send(){mediaSends++;return{messageId:String(900+mediaSends)};}}});
  for(let i=0;i<21;i++){
    const taskId='backlog-'+i;
    item.delivery.handleReceipt(receipt({taskId}));
    fs.writeFileSync(path.join(item.resultsDir,`AsyncTool-${taskId}.json`),JSON.stringify({result:'完成 ![图](ExampleAgent/a.png)'}));
    item.delivery.handleCompleted(completed({taskId}));
  }
  await item.delivery.processDue(100);
  assert.equal(item.db.prepare("SELECT COUNT(*) n FROM async_tasks WHERE status='delivered' AND media_prepared=0").get().n,0);
  await item.delivery.processDue(100);
  assert.equal(textSends,21);assert.equal(mediaSends,21);
});

test('bounded recovery rotates past missing older results', t => {
  const item = fixture(t);
  for (let i = 0; i <= 100; i++) item.delivery.handleReceipt(receipt({ taskId: `task-${String(i).padStart(3, '0')}` }));
  fs.writeFileSync(path.join(item.resultsDir, 'AsyncTool-task-100.json'), JSON.stringify({ result: 'last task result' }));
  item.delivery.recoverResults(100);
  item.delivery.recoverResults(100);
  assert.equal(item.db.prepare('SELECT status FROM async_tasks WHERE task_id=?').get('task-100').status, 'completed');
});

test('receipt binds exact parent request; model text, unknown scope and malformed events do not', (t) => {
  const item = fixture(t);
  assert.deepEqual(item.delivery.handleReceipt(receipt()), { status: 'registered', taskKey: 'AsyncTool:task-1' });
  assert.equal(item.db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 1);
  assert.deepEqual(item.delivery.handleReceipt({ type: 'model_text', data: '{{taskId:task-2}}' }), { status: 'ignored' });
  assert.deepEqual(item.delivery.handleReceipt(receipt({ correlationVersion: 2, taskId: 'task-2' })), { status: 'ignored' });

  const missing = fixture(t, { ledger: { findOwnedRequestBinding: () => null } });
  assert.deepEqual(missing.delivery.handleReceipt(receipt()), { status: 'ignored' });
  assert.equal(missing.db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 0);
});

test('async visible results use the same HTML and private-image filtering as chat', (t) => {
  const item = fixture(t);
  item.delivery.handleReceipt(receipt());
  fs.writeFileSync(path.join(item.resultsDir, 'AsyncTool-task-1.json'), JSON.stringify({
    result: '<div style="secret">完成 <b>结果</b></div> ![图](http://localhost:6005/pw=fixture-secret/images/a.png)',
  }));
  item.delivery.handleCompleted(completed());
  const payload = JSON.parse(item.db.prepare('SELECT payload_json FROM deliveries').get().payload_json);
  assert.doesNotMatch(payload.text, /style=|&lt;div|fixture-secret|localhost/);
  assert.match(payload.text, /结果/);
});

test('completion requires the trusted receipt and exact plugin/task/correlation/optional parent', (t) => {
  const item = fixture(t);
  fs.writeFileSync(path.join(item.resultsDir, 'AsyncTool-task-1.json'), JSON.stringify({
    result: 'async answer',
    parentRequestId: 'callback-body-lie',
    telegramChatId: 'callback-body-lie',
  }));
  assert.deepEqual(item.delivery.handleCompleted(completed()), { status: 'ignored' });
  item.delivery.handleReceipt(receipt());
  assert.deepEqual(item.delivery.handleCompleted(completed({ parentRequestId: 'other-request' })), { status: 'ignored' });
  assert.deepEqual(item.delivery.handleCompleted(completed()), {
    status: 'queued', taskKey: 'AsyncTool:task-1',
  });
  const row = item.db.prepare('SELECT status FROM async_tasks WHERE task_key = ?').get('AsyncTool:task-1');
  assert.equal(row.status, 'completed');
  const payload = JSON.parse(item.db.prepare('SELECT payload_json FROM deliveries').get().payload_json);
  assert.equal(payload.text, 'async answer');
  assert.equal(JSON.stringify(payload).includes('callback-body-lie'), false);
});

test('result metadata path is scanned only after receipt and rejects symlink/out-of-root tricks', (t) => {
  const item = fixture(t);
  const outside = path.join(item.resultsDir, '..', 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ result: 'outside' }));
  const expected = path.join(item.resultsDir, 'AsyncTool-task-1.json');
  try {
    fs.symlinkSync(outside, expected, 'file');
  } catch (error) {
    t.skip(`file links unavailable: ${error.code}`);
    return;
  }
  assert.deepEqual(item.delivery.handleCompleted(completed()), { status: 'ignored' });
  item.delivery.handleReceipt(receipt());
  assert.throws(
    () => item.delivery.handleCompleted(completed()),
    (error) => assertAsyncError(error, 'ASYNC_RESULT_PATH_UNSAFE'),
  );
  assert.equal(item.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 0);
});

test('proactive messages remain disabled and cannot invent an owner destination', (t) => {
  const item = fixture(t, { proactiveEnabled: false });
  assert.deepEqual(item.delivery.enqueueProactive({ scopeKey: item.scope.key, text: 'unsolicited' }), {
    status: 'ignored',
  });
  assert.equal(item.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 0);
});

test('explicit proactive mode queues only an owner private scope', (t) => {
  const item = fixture(t, { proactiveEnabled: true });
  assert.equal(item.delivery.enqueueProactive({
    scopeKey: item.scope.key, ownerUserId: '42', text: 'proactive',
  }).status, 'queued');
  assert.equal(item.db.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE source_type='proactive'").get().count, 1);
  assert.deepEqual(item.delivery.enqueueProactive({
    scopeKey: item.scope.key, ownerUserId: '99', text: 'wrong owner',
  }), { status: 'ignored' });
});

test('long async result is segmented into bounded delivery rows', (t) => {
  const item = fixture(t);
  fs.writeFileSync(path.join(item.resultsDir, 'AsyncTool-task-1.json'), JSON.stringify({
    result: 'x'.repeat(9000),
  }));
  item.delivery.handleReceipt(receipt());
  item.delivery.handleCompleted(completed());
  const payloads = item.db.prepare(`
    SELECT payload_json FROM deliveries ORDER BY segment_index
  `).all().map((row) => JSON.parse(row.payload_json));
  assert.equal(payloads.length, 3);
  assert.equal(payloads.every((payload) => payload.plainText.length <= 4096), true);
  assert.equal(payloads.map((payload) => payload.plainText).join(''), 'x'.repeat(9000));
});

test('restart result scanning considers only registered trusted receipts', (t) => {
  const item = fixture(t);
  fs.writeFileSync(path.join(item.resultsDir, 'Unknown-task-x.json'), JSON.stringify({ result: 'ignore' }));
  fs.writeFileSync(path.join(item.resultsDir, 'AsyncTool-task-1.json'), JSON.stringify({ result: 'recover' }));
  assert.deepEqual(item.delivery.recoverResults(), { queued: 0 });
  item.delivery.handleReceipt(receipt());
  assert.deepEqual(item.delivery.recoverResults(), { queued: 1 });
  assert.equal(item.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1);
});

test('provider-specific artifact metadata never becomes a Telegram attachment', async t => {
  const item = fixture(t);
  item.delivery.handleReceipt(receipt());
  fs.writeFileSync(path.join(item.resultsDir, 'AsyncTool-task-1.json'), JSON.stringify({
    result: 'Completed fixture task',
    artifacts: [{type:'image', localPath:'/private/fixture.png', mime:'image/png'}],
  }));
  item.delivery.handleCompleted(completed());
  assert.equal(item.db.prepare("SELECT COUNT(*) n FROM deliveries WHERE kind='async_media'").get().n, 0);
  assert.equal((await item.delivery.processDue(10)).delivered, 1);
  assert.equal(item.sends.length, 1);
  assert.doesNotMatch(item.sends[0].text, /private|fixture.png/);
});

test('unsupported persisted media is rejected without transport effects', async t => {
  const item = fixture(t);
  item.delivery.handleReceipt(receipt());
  fs.writeFileSync(path.join(item.resultsDir, 'AsyncTool-task-1.json'), JSON.stringify({result:'done'}));
  item.delivery.handleCompleted(completed());
  item.db.prepare("UPDATE async_tasks SET media_prepared=1").run();
  item.db.prepare("UPDATE deliveries SET kind='async_media',payload_json=?").run(JSON.stringify({
    chatId:'42',threadId:'0',artifact:{relativePath:'legacy.png',type:'image'},
  }));
  const result = await item.delivery.processDue(10);
  assert.equal(result.deadLetters, 1);
  assert.equal(item.sends.length, 0);
});
