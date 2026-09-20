'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { createSessionStore } = require('../src/sessionStore');
const { UpdateLedgerError } = require('../src/updateLedger');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-ledger-'));
  const pluginRoot = path.join(root, 'TelegramBridge');
  const stateDir = path.join(pluginRoot, 'state');
  fs.mkdirSync(pluginRoot);
  let tick = 1000;
  const options = {
    pluginRoot,
    stateDir,
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
    clock: () => tick++,
  };
  const stores = [];
  function openStore() {
    const store = createSessionStore(options);
    store.open();
    stores.push(store);
    return store;
  }
  t.after(() => {
    for (const store of stores.reverse()) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = openStore();
  return { store, openStore, stateDir };
}

function sampleUpdate(updateId, payload = { message: { text: 'hello' } }) {
  return { updateId, updateType: 'message', payload };
}

function createQueuedRequest(store, ledger, updateId, requestId, overrides = {}) {
  ledger.acceptBatch([sampleUpdate(updateId)]);
  const scope = store.getOrCreateScope({ chatId: updateId, threadId: '0' });
  return ledger.authorizeAndQueue(updateId, {
    requestId,
    messageId: `msg-${requestId}`,
    ownerUserId: '900719925474099312345',
    scopeKey: scope.key,
    orderingKey: `telegram:${updateId}:0`,
    replayPolicy: 'manual',
    ...overrides,
  });
}

function assertLedgerError(error, code, fixtures = []) {
  assert.equal(error instanceof UpdateLedgerError, true);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error), ['code']);
  const serialized = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  for (const fixture of fixtures) assert.equal(serialized.includes(fixture), false);
  return true;
}

test('acceptBatch atomically persists normalized updates and exact max+1 cursor', (t) => {
  const { store } = createFixture(t);
  const ledger = store.createUpdateLedger();
  const result = ledger.acceptBatch([
    sampleUpdate('900719925474099312345', { z: 1, nested: { b: 2, a: '中' } }),
    sampleUpdate('7', { callback_query: { id: 'q1' } }),
    sampleUpdate('900719925474099312343', { message: { text: 'gap' } }),
  ]);

  assert.deepEqual(result, {
    inserted: 3,
    duplicates: 0,
    nextOffset: '900719925474099312346',
  });
  assert.equal(ledger.getNextOffset(), '900719925474099312346');
  const saved = ledger.getUpdate('900719925474099312345');
  assert.equal(saved.updateId, '900719925474099312345');
  assert.equal(saved.payloadJson, '{"nested":{"a":"中","b":2},"z":1}');
  assert.match(saved.payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(saved.status, 'received');
});

test('unsupported updates are rejected in the same durable cursor transaction', (t) => {
  const { store } = createFixture(t);
  const ledger = store.createUpdateLedger();
  assert.deepEqual(ledger.acceptBatch([{
    updateId: '55',
    updateType: 'edited_message',
    payload: { update_id: 55, edited_message: { message_id: 1 } },
    rejectErrorCode: 'UNSUPPORTED_UPDATE_TYPE',
  }]), { inserted: 1, duplicates: 0, nextOffset: '56' });
  const saved = ledger.getUpdate('55');
  assert.equal(saved.status, 'rejected');
  assert.equal(saved.errorCode, 'UNSUPPORTED_UPDATE_TYPE');
  assert.equal(saved.finishedAt >= saved.receivedAt, true);
  assert.equal(ledger.getNextOffset(), '56');
});

test('poller success and duplicate-poller incident survive a store restart', (t) => {
  const { store, openStore } = createFixture(t);
  const ledger = store.createUpdateLedger();
  ledger.recordPollerSuccess(10_000);
  ledger.recordDuplicatePoller(11_000);
  assert.deepEqual(openStore().createUpdateLedger().getPollerState(), {
    lastSuccessAt: 10_000,
    duplicatePollerAt: 11_000,
  });
});

test('owned request binding requires exact parent IDs and returns trusted scope identity', (t) => {
  const { store } = createFixture(t);
  const ledger = store.createUpdateLedger();
  const ownerUserId = '900719925474099312345678901234567890';
  ledger.acceptBatch([sampleUpdate('700')]);
  const scope = store.getOrCreateScope({ chatId: '-100700', threadId: '77', agent: 'ExampleAgent' });
  ledger.authorizeAndQueue('700', {
    requestId: 'req-owner',
    messageId: 'msg-owner',
    ownerUserId,
    scopeKey: scope.key,
    orderingKey: 'telegram:-100700:77',
  });

  assert.equal(
    ledger.findOwnedRequestBinding({
      parentRequestId: 'req-owner',
      parentMessageId: 'msg-owner',
    }),
    null,
    'queued requests are not active approval parents',
  );
  ledger.claimRequest('req-owner', 'worker-owner');
  assert.deepEqual(ledger.findOwnedRequestBinding({
    parentRequestId: 'req-owner',
    parentMessageId: 'msg-owner',
  }), {
    requestId: 'req-owner',
    messageId: 'msg-owner',
    scopeKey: scope.key,
    ownerUserId,
    chatId: '-100700',
    threadId: '77',
    agent: 'ExampleAgent',
    status: 'processing',
  });

  for (const input of [
    { parentRequestId: 'req-owner', parentMessageId: 'msg-wrong' },
    { parentRequestId: 'req-wrong', parentMessageId: 'msg-owner' },
    { parentRequestId: 'req-owner' },
    { parentMessageId: 'msg-owner' },
  ]) {
    assert.equal(ledger.findOwnedRequestBinding(input), null);
  }
  assert.equal(ledger.getRequest('req-owner').ownerUserId, ownerUserId);
});

test('same canonical payload is a no-op while a collision rolls back the whole batch', (t) => {
  const { store } = createFixture(t);
  const ledger = store.createUpdateLedger();
  ledger.acceptBatch([sampleUpdate('10', { a: 1, b: 2 })]);

  assert.deepEqual(ledger.acceptBatch([sampleUpdate('10', { b: 2, a: 1 })]), {
    inserted: 0,
    duplicates: 1,
    nextOffset: '11',
  });

  const secret = 'fixture-collision-secret';
  assert.throws(
    () => ledger.acceptBatch([
      sampleUpdate('11', { safe: true }),
      sampleUpdate('10', { changed: secret }),
    ]),
    (error) => assertLedgerError(error, 'UPDATE_ID_COLLISION', [secret]),
  );
  assert.equal(ledger.getUpdate('11'), null);
  assert.equal(ledger.getNextOffset(), '11');
});

test('acceptBatch rejects negative, noncanonical, numeric, and invalid payload inputs', (t) => {
  const { store } = createFixture(t);
  const ledger = store.createUpdateLedger();
  for (const updateId of ['-1', '0', '01', '+1', '1.0', '', 1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => ledger.acceptBatch([sampleUpdate(updateId)]),
      (error) => assertLedgerError(error, 'UPDATE_ID_INVALID'),
    );
  }
  assert.throws(
    () => ledger.acceptBatch(Promise.resolve([])),
    (error) => assertLedgerError(error, 'LEDGER_INPUT_INVALID'),
  );
  assert.equal(ledger.getNextOffset(), null);
});

test('a noncanonical persisted poll offset fails closed instead of being reused', (t) => {
  const { store, stateDir } = createFixture(t);
  const ledger = store.createUpdateLedger();
  const rogue = new Database(path.join(stateDir, 'telegram.sqlite3'));
  rogue.prepare(`
    INSERT INTO updates (
      update_id, next_offset, update_type, status, attempt, received_at, updated_at
    ) VALUES ('1', '-1', 'message', 'received', 0, 1, 1)
  `).run();
  rogue.close();

  assert.throws(
    () => ledger.getNextOffset(),
    (error) => assertLedgerError(error, 'OFFSET_INVALID'),
  );
});

test('one initial request is bound per update and normal VCP work defaults to manual replay', (t) => {
  const { store } = createFixture(t);
  const ledger = store.createUpdateLedger();
  const first = createQueuedRequest(store, ledger, '100', 'req-100');
  assert.equal(first.changed, true);
  assert.equal(first.request.status, 'queued');
  assert.equal(first.request.effectState, 'not_started');
  assert.equal(first.request.replayPolicy, 'manual');
  assert.equal(first.request.orderingKey, 'telegram:100:0');

  const scope = store.getOrCreateScope({ chatId: '100', threadId: '0' });
  const second = ledger.authorizeAndQueue('100', {
    requestId: 'req-other',
    messageId: 'msg-other',
    ownerUserId: '900719925474099312345',
    scopeKey: scope.key,
    orderingKey: 'telegram:100:0',
  });
  assert.deepEqual(second, { changed: false, currentStatus: 'queued' });
  assert.equal(ledger.getRequest('req-other'), null);
});

test('authorization rejects a valid-looking ordering key that does not match the trusted scope', (t) => {
  const { store } = createFixture(t);
  const ledger = store.createUpdateLedger();
  ledger.acceptBatch([sampleUpdate('710')]);
  const scope = store.getOrCreateScope({ chatId: '-100710', threadId: '77', agent: 'ExampleAgent' });

  for (const [requestId, orderingKey] of [
    ['req-wrong-chat', 'telegram:-100711:77'],
    ['req-wrong-thread', 'telegram:-100710:78'],
  ]) {
    assert.throws(
      () => ledger.authorizeAndQueue('710', {
        requestId,
        messageId: `msg-${requestId}`,
        ownerUserId: '900719925474099312345',
        scopeKey: scope.key,
        orderingKey,
      }),
      (error) => assertLedgerError(error, 'SCOPE_ORDERING_MISMATCH'),
    );
    assert.equal(ledger.getRequest(requestId), null);
    assert.equal(ledger.getUpdate('710').status, 'received');
    assert.equal(ledger.getUpdate('710').initialRequestId, null);
  }
});

test('two independent connections produce exactly one request claim winner', (t) => {
  const { store, openStore } = createFixture(t);
  const firstLedger = store.createUpdateLedger();
  createQueuedRequest(store, firstLedger, '200', 'req-race');
  const secondLedger = openStore().createUpdateLedger();

  const claims = [
    firstLedger.claimRequest('req-race', 'worker-a'),
    secondLedger.claimRequest('req-race', 'worker-b'),
  ];
  assert.equal(claims.filter((claim) => claim.changed).length, 1);
  assert.equal(claims.filter((claim) => !claim.changed).length, 1);
  assert.equal(claims.find((claim) => !claim.changed).currentStatus, 'processing');
});

test('restart recovery requeues not-started work and quarantines ambiguous effects', (t) => {
  const { store, openStore } = createFixture(t);
  const ledger = store.createUpdateLedger();
  for (const [updateId, requestId] of [['301', 'req-safe'], ['302', 'req-started'], ['303', 'req-unknown']]) {
    createQueuedRequest(store, ledger, updateId, requestId);
    assert.equal(ledger.claimRequest(requestId, 'worker-a').changed, true);
  }
  ledger.markEffectStarted('req-started');
  ledger.markEffectStarted('req-unknown');
  ledger.markEffectUnknown('req-unknown');

  const restarted = openStore().createUpdateLedger();
  assert.deepEqual(restarted.recoverInterruptedRequests(), {
    requeued: 1,
    needsReview: 2,
  });
  assert.equal(restarted.getRequest('req-safe').status, 'queued');
  assert.equal(restarted.getRequest('req-started').status, 'needs_review');
  assert.equal(restarted.getRequest('req-unknown').status, 'needs_review');
  assert.deepEqual(restarted.listReadyRequests(10).map((row) => row.requestId), ['req-safe']);
});

test('manual retry links a new request and never mutates the quarantined original', (t) => {
  const { store } = createFixture(t);
  const ledger = store.createUpdateLedger();
  createQueuedRequest(store, ledger, '400', 'req-original');
  ledger.claimRequest('req-original', 'worker-a');
  ledger.markEffectStarted('req-original');
  ledger.markNeedsReview('req-original', 'VCP_RESULT_UNKNOWN');
  const before = ledger.getRequest('req-original');

  const retry = ledger.createManualRetry('req-original', {
    requestId: 'req-retry',
    messageId: 'msg-retry',
  });
  assert.equal(retry.changed, true);
  assert.equal(retry.request.retryOfRequestId, 'req-original');
  assert.equal(retry.request.status, 'queued');
  assert.equal(retry.request.effectState, 'not_started');
  assert.deepEqual(ledger.getRequest('req-original'), before);
  assert.equal(ledger.getUpdate('400').initialRequestId, 'req-original');

  assert.deepEqual(ledger.createManualRetry('req-original', {
    requestId: 'req-retry',
    messageId: 'msg-retry',
  }), { changed: false, currentStatus: 'queued' });
  assert.throws(
    () => ledger.createManualRetry('req-original', {
      requestId: 'req-retry',
      messageId: 'msg-different',
    }),
    (error) => assertLedgerError(error, 'REQUEST_ID_COLLISION'),
  );
});

test('manual retry rejects request IDs owned by another update or no longer in initial queued state', (t) => {
  const { store } = createFixture(t);
  const ledger = store.createUpdateLedger();
  createQueuedRequest(store, ledger, '410', 'req-original-a', {
    ownerUserId: '10001',
  });
  createQueuedRequest(store, ledger, '411', 'req-original-b', {
    ownerUserId: '20002',
  });
  for (const requestId of ['req-original-a', 'req-original-b']) {
    ledger.claimRequest(requestId, `worker-${requestId}`);
    ledger.markEffectStarted(requestId);
    ledger.markNeedsReview(requestId, 'VCP_RESULT_UNKNOWN');
  }

  ledger.createManualRetry('req-original-b', {
    requestId: 'req-shared-retry-id',
    messageId: 'msg-shared-retry-id',
  });
  assert.throws(
    () => ledger.createManualRetry('req-original-a', {
      requestId: 'req-shared-retry-id',
      messageId: 'msg-shared-retry-id',
    }),
    (error) => assertLedgerError(error, 'REQUEST_ID_COLLISION'),
  );

  const ownRetry = ledger.createManualRetry('req-original-a', {
    requestId: 'req-own-retry',
    messageId: 'msg-own-retry',
  });
  assert.equal(ownRetry.changed, true);
  ledger.claimRequest('req-own-retry', 'worker-own-retry');
  assert.throws(
    () => ledger.createManualRetry('req-original-a', {
      requestId: 'req-own-retry',
      messageId: 'msg-own-retry',
    }),
    (error) => assertLedgerError(error, 'REQUEST_ID_COLLISION'),
  );
});

test('CAS transitions expose races without leaking errors and terminal records stay immutable', (t) => {
  const { store } = createFixture(t);
  const ledger = store.createUpdateLedger();
  createQueuedRequest(store, ledger, '500', 'req-cas');
  assert.deepEqual(ledger.markEffectStarted('req-cas'), {
    changed: false,
    currentStatus: 'queued',
  });
  ledger.claimRequest('req-cas', 'worker-a');
  assert.deepEqual(ledger.completeRequest('req-cas'), {
    changed: false,
    currentStatus: 'processing',
  });
  ledger.markEffectStarted('req-cas');
  assert.equal(ledger.completeRequest('req-cas').changed, true);
  assert.equal(ledger.getRequest('req-cas').effectState, 'confirmed');
  assert.deepEqual(ledger.completeRequest('req-cas'), {
    changed: false,
    currentStatus: 'completed',
  });
});

test('ledger rejects async input before a transaction and leaves a second connection writable', (t) => {
  const { store, openStore } = createFixture(t);
  const first = store.createUpdateLedger();
  const second = openStore().createUpdateLedger();
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });

  assert.throws(
    () => first.acceptBatch(delayed),
    (error) => assertLedgerError(error, 'LEDGER_INPUT_INVALID'),
  );
  assert.doesNotThrow(() => second.acceptBatch([sampleUpdate('600')]));
  release();
});

test('hostile input accessors cannot leak raw exceptions or create inferred owner bindings', (t) => {
  const { store } = createFixture(t);
  const ledger = store.createUpdateLedger();
  const secret = 'LEDGER-GETTER-SECRET-778899';
  const hostileUpdate = {};
  Object.defineProperty(hostileUpdate, 'updateId', {
    enumerable: true,
    get() { throw new Error(secret); },
  });
  assert.throws(
    () => ledger.acceptBatch([hostileUpdate]),
    (error) => assertLedgerError(error, 'LEDGER_INPUT_INVALID', [secret]),
  );

  const hostileBinding = {};
  Object.defineProperty(hostileBinding, 'parentRequestId', {
    enumerable: true,
    get() { throw new Error(secret); },
  });
  assert.equal(ledger.findOwnedRequestBinding(hostileBinding), null);
});
